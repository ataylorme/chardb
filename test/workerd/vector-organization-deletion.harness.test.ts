import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded, restartMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { vshardOf } from "../../src/vshard.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "vector-organization-deletion.entry.ts");

interface Route {
    readonly shardId: string;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
}

interface SetupState {
    readonly vshard: number;
    readonly ownerShardId: string;
    readonly otherShardId: string;
    readonly mutationRef: string;
    readonly authority: Record<string, unknown>;
    readonly shardId: string;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
}

interface CatalogState {
    readonly instanceId: string;
    readonly organizationPresent: boolean;
    readonly memberPresent: boolean;
    readonly deletion: null | { readonly status: "pending" | "complete"; readonly completedAt: number | null };
    readonly shards: readonly {
        readonly shardId: string;
        readonly status: "pending" | "complete";
        readonly attempts: number;
    }[];
    readonly route: Route;
    readonly alarm: number | null;
}

interface CatalogDeletionStatus {
    readonly organizationId: string;
    readonly authDeleted: boolean;
    readonly handoffComplete: boolean;
    readonly handoff: {
        readonly state: "not_started" | "pending" | "complete";
        readonly attempts: number;
        readonly completedAt: number | null;
        readonly lastError: string | null;
    };
    readonly vectorPurge: VectorPurgeStatus | null;
}

interface DeletionBarrierState {
    readonly barrier: {
        readonly migrationId: string;
        readonly rangeLo: number;
        readonly rangeHi: number;
        readonly deletionWatermark: number;
        readonly status: "active" | "released" | "aborted";
    };
    readonly olderDeletionsComplete: boolean;
}

interface CdbState {
    readonly instanceId: string;
    readonly rows: readonly {
        readonly id: string;
        readonly attachment: string | null;
        readonly embedding: string;
    }[];
    readonly files: readonly {
        readonly file_id: string;
        readonly object_key: string;
        readonly status: "pending" | "ready" | "attached" | "deleting";
        readonly row_id: string | null;
    }[];
    readonly heads: readonly {
        readonly vector_id: string;
        readonly version: number;
        readonly delivered_version: number;
        readonly state: "pending" | "ready" | "deleting";
    }[];
    readonly outbox: readonly {
        readonly operation: "upsert" | "delete";
        readonly phase: "submit" | "verify";
        readonly attempts: number;
        readonly leased_until: number | null;
        readonly lease_token: string | null;
        readonly terminal_failure: 0 | 1;
        readonly last_error: string | null;
    }[];
    readonly attempts: readonly {
        readonly vector_id: string;
        readonly physical_version: number;
        readonly visibility_confirmed: number;
        readonly response_ambiguous: number;
        readonly delete_confirmed: number;
    }[];
    readonly tombstone: null | {
        readonly organization_id: string;
        readonly deleted_at: number;
        readonly placement_vshard: number;
    };
    readonly routingFences: readonly {
        readonly migration_id: string;
        readonly range_lo: number;
        readonly range_hi: number;
        readonly source_generation: number;
        readonly destination_generation: number;
        readonly status: "prepared" | "active" | "cleaned" | "superseded";
    }[];
    readonly alarm: number | null;
}

interface VectorState {
    readonly instanceId: string;
    readonly calls: readonly {
        readonly sequence: number;
        readonly operation: "upsert" | "delete" | "get";
        readonly ids_json: string;
    }[];
    readonly documents: readonly { readonly id: string }[];
    readonly hold: {
        readonly armed: boolean;
        readonly activeIds: readonly string[];
    };
}

interface VectorPurgeStatus {
    readonly organizationId: string;
    readonly state: "pending" | "complete" | "failed_unproven";
    readonly remainingHeads: number;
    readonly outboxRows: number;
    readonly attemptRows: number;
    readonly unprovenTurns: number;
    readonly lastError: string | null;
}

interface BucketState {
    readonly keys: readonly string[];
}

let mf: Miniflare | undefined;
let temporaryPath = "";
let runtimePersistencePath = "";
let runtimeSequence = 0;
let workerSource = "";

async function buildWorker(): Promise<string> {
    const bundle = path.join(temporaryPath, "vector-organization-deletion.worker.mjs");
    const child = Bun.spawn(
        [
            "bun",
            "build",
            ENTRY,
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            bundle,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
    const source = (await Bun.file(bundle).text())
        .replace(
            "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
            'await Promise.reject(new Error("file migrations are unavailable in workerd"))'
        )
        .replace(
            "await import(nodeSqlite)",
            'await Promise.reject(new Error("node:sqlite is unavailable in workerd"))'
        );
    if (source.includes("import(")) throw new Error("vector organization deletion fixture contains a dynamic import");
    return source;
}

function createRuntime(): Miniflare {
    return new Miniflare({
        name: "vector-organization-deletion-proof",
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
            VECTOR_INDEX: { className: "VectorIndexProbe", useSQLite: true },
        },
        durableObjectsPersist: path.join(runtimePersistencePath, "durable-objects"),
        bindings: { CDB_ADMIN_TOKEN: "native-deletion-secret" },
        r2Buckets: ["CDB_FILES"],
        r2Persist: path.join(runtimePersistencePath, "r2"),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
}

async function startRuntimeBounded(limit = 5): Promise<Miniflare> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= limit; attempt++) {
        try {
            return (
                await restartMiniflareBounded(undefined, createRuntime, {
                    label: `vector organization deletion startup ${attempt}/${limit}`,
                    disposeTimeoutMs: 5_000,
                    readyTimeoutMs: 15_000,
                    settleDelayMs: 100,
                })
            ).instance;
        } catch (error) {
            lastError = error;
            if (attempt < limit) await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
    }
    throw new Error(`vector organization deletion runtime failed after ${limit} attempts`, { cause: lastError });
}

async function restartRuntime(): Promise<void> {
    const current = mf;
    mf = undefined;
    if (!current) throw new Error("cold restart has no active runtime");
    try {
        const restarted = await restartMiniflareBounded(current, createRuntime, {
            label: "vector organization deletion cold restart",
            disposeTimeoutMs: 5_000,
            readyTimeoutMs: 15_000,
            settleDelayMs: 500,
        });
        if (restarted.disposal.status !== "disposed") {
            await disposeMiniflareBounded(restarted.instance, { label: "rejected cold runtime", timeoutMs: 5_000 });
            throw new Error(`cold restart failed: ${restarted.disposal.status}`);
        }
        mf = restarted.instance;
    } catch {
        mf = await startRuntimeBounded();
    }
}

async function call<TResult>(
    operation: string,
    input: Record<string, unknown> = {},
    expectedStatus = 200
): Promise<TResult> {
    if (!mf) throw new Error("vector organization deletion Miniflare is unavailable");
    const response = await mf.dispatchFetch(`http://example.com/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    const result = (await response.json()) as TResult;
    if (response.status !== expectedStatus) {
        throw new Error(`${operation} returned ${response.status}: ${JSON.stringify(result)}`);
    }
    return result;
}

async function reservedDeletionStatus(
    organizationId: string,
    input: { readonly authorization?: string; readonly query?: string } = {}
): Promise<{ readonly status: number; readonly body: unknown }> {
    if (!mf) throw new Error("vector organization deletion Miniflare is unavailable");
    const query = input.query ?? `organizationId=${encodeURIComponent(organizationId)}`;
    const response = await mf.dispatchFetch(
        `http://example.com/_chardb/organizations/deletion/status${query ? `?${query}` : ""}`,
        {
            method: "GET",
            ...(input.authorization ? { headers: { authorization: input.authorization } } : {}),
        }
    );
    const body = response.headers.get("content-type")?.includes("application/json")
        ? ((await response.json()) as unknown)
        : await response.text();
    return { status: response.status, body };
}

async function cdbState(organizationId: string, shardId: string): Promise<CdbState> {
    return call<CdbState>("cdb-state", { organizationId, shardId });
}

async function driveCdbUntil(
    organizationId: string,
    shardId: string,
    predicate: (cdb: CdbState, index: VectorState) => boolean,
    limit = 32
): Promise<{ readonly cdb: CdbState; readonly index: VectorState; readonly turns: number }> {
    for (let turns = 0; turns <= limit; turns++) {
        const cdb = await cdbState(organizationId, shardId);
        const index = await call<VectorState>("vector-state");
        if (predicate(cdb, index)) return { cdb, index, turns };
        if (turns < limit) await call("cdb-alarm", { shardId });
    }
    throw new Error(`Cdb did not settle after ${limit} explicit alarm turns`);
}

async function deleteOrganizationAndDriveCatalog(organizationId: string): Promise<CatalogState> {
    await call("delete-auth-organization", { organizationId });
    for (let turn = 0; turn < 8; turn++) {
        const state = await call<CatalogState>("catalog-state", { organizationId });
        if (state.deletion?.status === "complete") return state;
        await call("catalog-alarm");
    }
    throw new Error("Catalog did not hand off organization deletion after 8 explicit alarm turns");
}

async function waitForHeldUpsert(limit = 32): Promise<VectorState> {
    for (let turn = 0; turn <= limit; turn++) {
        const state = await call<VectorState>("vector-state");
        if (state.hold.activeIds.length > 0) return state;
        if (turn < limit) await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Vectorize upsert did not enter the hold after ${limit} polls`);
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-vector-organization-deletion-"));
    workerSource = await buildWorker();
});

beforeEach(async () => {
    runtimeSequence += 1;
    runtimePersistencePath = path.join(temporaryPath, `runtime-${runtimeSequence}`);
    mf = await startRuntimeBounded();
});

afterEach(async () => {
    const disposed = await disposeMiniflareBounded(mf, {
        label: "vector organization deletion final teardown",
        timeoutMs: 5_000,
    });
    mf = undefined;
    if (disposed.status !== "disposed" && disposed.status !== "absent") {
        throw new Error(`vector organization deletion teardown failed: ${disposed.status}`);
    }
});

afterAll(async () => {
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("vector-aware Better Auth organization deletion on native Durable Objects", () => {
    test("waits for an older accepted source deletion before vector-range cutover", async () => {
        const organizationId = "native-vector-delete-before-barrier";
        const migrationId = "native-vector-delete-before-barrier-move";
        const setup = await call<SetupState>("setup", { organizationId });
        expect(await reservedDeletionStatus(organizationId)).toEqual({ status: 403, body: "forbidden" });
        expect(
            await reservedDeletionStatus(organizationId, { authorization: "Bearer native-deletion-secret" })
        ).toEqual({
            status: 200,
            body: {
                ok: true,
                state: {
                    organizationId,
                    authDeleted: false,
                    handoffComplete: false,
                    handoff: { state: "not_started", attempts: 0, completedAt: null, lastError: null },
                    vectorPurge: null,
                },
            },
        });
        expect(
            await reservedDeletionStatus(organizationId, {
                authorization: "Bearer native-deletion-secret",
                query: `organizationId=${encodeURIComponent(organizationId)}&shardId=hostile`,
            })
        ).toEqual({
            status: 400,
            body: { ok: false, error: "organization deletion status requires exactly one organizationId" },
        });
        expect(
            await reservedDeletionStatus(organizationId, {
                authorization: "Bearer native-deletion-secret",
                query: `organizationId=${encodeURIComponent(organizationId)}&organizationId=duplicate`,
            })
        ).toEqual({
            status: 400,
            body: { ok: false, error: "organization deletion status requires exactly one organizationId" },
        });
        expect(await call<CatalogDeletionStatus>("catalog-deletion-status", { organizationId })).toEqual({
            organizationId,
            authDeleted: false,
            handoffComplete: false,
            handoff: { state: "not_started", attempts: 0, completedAt: null, lastError: null },
            vectorPurge: null,
        });
        const unknownOrganizationId = `${organizationId}-unknown`;
        expect(
            await call<CatalogDeletionStatus>("catalog-deletion-status", {
                organizationId: unknownOrganizationId,
            })
        ).toEqual({
            organizationId: unknownOrganizationId,
            authDeleted: false,
            handoffComplete: false,
            handoff: { state: "not_started", attempts: 0, completedAt: null, lastError: null },
            vectorPurge: null,
        });
        expect(
            await call<{ readonly organizationId: string; readonly count: number }>("seed-vector-heads", {
                organizationId,
                shardId: setup.ownerShardId,
                count: 501,
            })
        ).toEqual({ organizationId, count: 501 });
        await call("lose-next-deletion-response", { shardId: setup.ownerShardId });
        await call("delete-auth-organization", { organizationId });
        await call("catalog-alarm");

        const acceptedOnSource = await call<CatalogState>("catalog-state", { organizationId });
        expect(acceptedOnSource).toMatchObject({
            organizationPresent: false,
            deletion: { status: "pending" },
            shards: [{ shardId: setup.ownerShardId, status: "pending", attempts: 1 }],
            route: { shardId: setup.ownerShardId },
        });
        const firstPage = await cdbState(organizationId, setup.ownerShardId);
        expect(firstPage.tombstone).toMatchObject({ organization_id: organizationId });
        expect(firstPage.heads.filter(head => head.state === "deleting")).toHaveLength(500);
        expect(firstPage.heads.filter(head => head.state !== "deleting")).toHaveLength(1);
        expect(firstPage.routingFences).toEqual([]);

        await call("begin-topology", { organizationId, migrationId });
        const blocked = await call<DeletionBarrierState>("begin-deletion-barrier", {
            organizationId,
            migrationId,
        });
        expect(blocked).toMatchObject({
            barrier: { migrationId, status: "active", deletionWatermark: expect.any(Number) },
            olderDeletionsComplete: false,
        });
        await call("cutover", { organizationId, migrationId }, 500);
        expect(await call<CatalogState>("catalog-state", { organizationId })).toMatchObject({
            route: { shardId: setup.ownerShardId },
            deletion: { status: "pending" },
        });

        await call("make-deletion-due", { organizationId, shardId: setup.ownerShardId });
        await call("catalog-alarm");
        const ready = await call<DeletionBarrierState>("begin-deletion-barrier", { organizationId, migrationId });
        expect(ready).toMatchObject({ barrier: { status: "active" }, olderDeletionsComplete: true });
        const fullyAccepted = await cdbState(organizationId, setup.ownerShardId);
        expect(fullyAccepted.heads).toHaveLength(501);
        expect(fullyAccepted.heads.every(head => head.state === "deleting" && head.version === 2)).toBe(true);
        expect(fullyAccepted.outbox).toHaveLength(501);
        expect(fullyAccepted.routingFences).toEqual([]);
        expect(await call<CatalogState>("catalog-state", { organizationId })).toMatchObject({
            deletion: { status: "complete" },
            shards: [{ shardId: setup.ownerShardId, status: "complete", attempts: 1 }],
            route: { shardId: setup.ownerShardId },
        });
        const catalogStatus = await call<CatalogDeletionStatus>("catalog-deletion-status", { organizationId });
        expect(catalogStatus).toMatchObject({
            organizationId,
            authDeleted: true,
            handoffComplete: true,
            handoff: { state: "complete", attempts: 1, lastError: null },
            vectorPurge: {
                state: "pending",
                remainingHeads: 501,
                outboxRows: 501,
                unprovenTurns: 0,
                lastError: null,
            },
        });
        expect(
            await reservedDeletionStatus(organizationId, { authorization: "Bearer native-deletion-secret" })
        ).toEqual({
            status: 200,
            body: {
                ok: true,
                state: catalogStatus,
            },
        });
        expect(
            await call("activate-routing-fence", {
                organizationId,
                migrationId,
                shardId: setup.ownerShardId,
                sourceGeneration: setup.schemaEpoch,
            })
        ).toMatchObject({
            migrationId,
            sourceGeneration: setup.schemaEpoch,
            destinationGeneration: setup.schemaEpoch + 1,
            status: "active",
        });
        expect((await cdbState(organizationId, setup.ownerShardId)).routingFences).toEqual([
            expect.objectContaining({
                migration_id: migrationId,
                source_generation: setup.schemaEpoch,
                destination_generation: setup.schemaEpoch + 1,
                status: "active",
            }),
        ]);
        expect((await cdbState(organizationId, setup.otherShardId)).tombstone).toBeNull();

        expect(
            await reservedDeletionStatus(organizationId, { authorization: "Bearer native-deletion-secret" })
        ).toEqual({
            status: 409,
            body: {
                ok: false,
                error: `mutation routing generation ${setup.schemaEpoch} is no longer admitted by this source`,
            },
        });

        await call("poison-cdb-purge-status", { shardId: setup.ownerShardId });

        expect(await call("cutover", { organizationId, migrationId })).toMatchObject({
            cutover: { applied: true, newEpoch: setup.schemaEpoch + 1 },
            operation: { status: "completed" },
            route: { shardId: setup.otherShardId, recoveryGeneration: 0, schemaEpoch: setup.schemaEpoch + 1 },
        });
        expect(await call<CatalogState>("catalog-state", { organizationId })).toMatchObject({
            deletion: { status: "complete" },
            shards: [{ shardId: setup.ownerShardId, status: "complete", attempts: 1 }],
            route: { shardId: setup.otherShardId },
        });
        // This barrier fixture changes Catalog ownership without running the separate
        // vector snapshot fixture. Status must reject the missing destination tombstone,
        // and the retired source poison must remain unread.
        expect(await call<{ readonly error: string }>("catalog-deletion-status", { organizationId }, 500)).toEqual({
            error: "CDB_INVARIANT: completed vector deletion handoff has no current-owner purge tombstone",
        });
        expect(
            await reservedDeletionStatus(organizationId, { authorization: "Bearer native-deletion-secret" })
        ).toEqual({
            status: 500,
            body: { ok: false, error: "completed vector deletion handoff has no current-owner purge tombstone" },
        });
    }, 60_000);

    test("rolls back a vector-backed auth deletion while its range barrier is active", async () => {
        const organizationId = "native-vector-delete-inside-barrier";
        const migrationId = "native-vector-delete-inside-barrier-move";
        const setup = await call<SetupState>("setup", { organizationId });
        await call("seed-vector-heads", { organizationId, shardId: setup.ownerShardId, count: 1 });
        await call("delete-auth-members", { organizationId });
        await call("catalog-alarm");
        await call("catalog-alarm");
        await call("catalog-clear-alarm");
        expect(await call<CatalogState>("catalog-state", { organizationId })).toMatchObject({
            organizationPresent: true,
            memberPresent: false,
            deletion: null,
            shards: [],
            alarm: null,
        });

        await call("begin-topology", { organizationId, migrationId });
        expect(
            await call<DeletionBarrierState>("begin-deletion-barrier", { organizationId, migrationId })
        ).toMatchObject({ barrier: { status: "active" }, olderDeletionsComplete: true });
        const rejected = await call<{ readonly error: string }>(
            "delete-auth-organization-only",
            { organizationId },
            500
        );
        expect(rejected).toEqual({
            error: "organization deletion barrier: new organization deletion is fenced while its vshard moves",
        });

        expect(await call<CatalogState>("catalog-state", { organizationId })).toMatchObject({
            organizationPresent: true,
            memberPresent: false,
            deletion: null,
            shards: [],
            alarm: null,
            route: { shardId: setup.ownerShardId },
        });
        const source = await cdbState(organizationId, setup.ownerShardId);
        expect(source.tombstone).toBeNull();
        expect(source.heads).toEqual([expect.objectContaining({ state: "pending", version: 1 })]);
        expect(source.outbox).toEqual([expect.objectContaining({ operation: "upsert" })]);
        expect((await cdbState(organizationId, setup.otherShardId)).tombstone).toBeNull();
        expect(await call("abort-topology", { organizationId, migrationId })).toMatchObject({ status: "aborted" });
    }, 60_000);

    test("routes a post-cutover vector organization deletion only to the destination", async () => {
        const organizationId = "native-vector-delete-after-cutover";
        const migrationId = "native-vector-delete-after-cutover-move";
        const setup = await call<SetupState>("setup", { organizationId });
        await call("begin-topology", { organizationId, migrationId });
        expect(
            await call<DeletionBarrierState>("begin-deletion-barrier", { organizationId, migrationId })
        ).toMatchObject({ barrier: { status: "active" }, olderDeletionsComplete: true });
        expect(await call("cutover", { organizationId, migrationId })).toMatchObject({
            cutover: { applied: true, newEpoch: setup.schemaEpoch + 1 },
            operation: { status: "completed" },
            route: { shardId: setup.otherShardId },
        });

        const deleted = await deleteOrganizationAndDriveCatalog(organizationId);
        expect(deleted).toMatchObject({
            organizationPresent: false,
            deletion: { status: "complete" },
            shards: [{ shardId: setup.otherShardId, status: "complete", attempts: 0 }],
            route: { shardId: setup.otherShardId },
        });
        expect((await cdbState(organizationId, setup.ownerShardId)).tombstone).toBeNull();
        expect((await cdbState(organizationId, setup.otherShardId)).tombstone).toEqual({
            organization_id: organizationId,
            deleted_at: expect.any(Number),
            placement_vshard: setup.vshard,
        });
    }, 60_000);

    test("atomically admits file and vector cleanup and recovers both after restart", async () => {
        const organizationId = "native-vector-organization-delete";
        const rowId = "document-1";
        const setup = await call<SetupState>("setup", { organizationId });
        expect(setup.vshard).toBe(Number(vshardOf([organizationId])));
        expect(setup.ownerShardId).toBe("ShardDO_vector_owner");
        expect(setup.otherShardId).toBe("ShardDO_not_owner");
        expect(setup.shardId).toBe(setup.ownerShardId);
        expect(setup.authority).toMatchObject({
            principalId: "vector-delete-user",
            organizationId,
            role: "member",
            roles: ["member"],
        });

        const preparedFile = await call<{
            readonly fileId: string;
            readonly objectKey: string;
            readonly status: "ready";
        }>("prepare-file", { organizationId });
        expect(preparedFile).toEqual({
            fileId: "combined_delete_file",
            objectKey: `v1/${organizationId}/combined_delete_file`,
            status: "ready",
        });
        expect(await call<BucketState>("bucket-state")).toEqual({
            keys: [preparedFile.objectKey, "v1/safe-organization/survivor"],
        });

        const created = await call<{
            readonly ok: boolean;
            readonly ran: boolean;
            readonly result: { readonly id: string; readonly vectorId: string };
        }>("mutate", {
            organizationId,
            mutId: "put-vector-before-delete",
            id: rowId,
            body: "present before deletion",
            fileId: preparedFile.fileId,
            values: [0.25, 0.5, 0.75],
        });
        expect(created).toMatchObject({ ok: true, ran: true, result: { id: rowId, vectorId: expect.any(String) } });

        const delivered = await driveCdbUntil(
            organizationId,
            setup.ownerShardId,
            (cdb, index) => cdb.heads[0]?.state === "ready" && index.documents.length === 1
        );
        expect(delivered.turns).toBeGreaterThan(0);
        expect(delivered.cdb.rows).toEqual([
            expect.objectContaining({
                id: rowId,
                attachment: preparedFile.fileId,
                embedding: created.result.vectorId,
            }),
        ]);
        expect(delivered.cdb.files).toEqual([
            {
                file_id: preparedFile.fileId,
                object_key: preparedFile.objectKey,
                status: "attached",
                row_id: rowId,
            },
        ]);
        expect(delivered.cdb.heads).toEqual([
            expect.objectContaining({ state: "ready", version: 1, delivered_version: 1 }),
        ]);
        expect(delivered.index.documents).toHaveLength(1);
        const physicalId = delivered.index.documents[0]?.id;
        expect(physicalId).toEqual(expect.any(String));

        const otherBefore = await cdbState(organizationId, setup.otherShardId);
        expect(otherBefore.rows).toEqual([]);
        expect(otherBefore.heads).toEqual([]);
        expect(otherBefore.tombstone).toBeNull();

        const rolledBack = await call<{
            readonly rejection: { readonly code: string; readonly message: string };
            readonly state: CdbState;
        }>("deletion-rollback", { organizationId });
        expect(rolledBack.rejection).toEqual({
            code: "CDB_RATE_LIMITED",
            message: expect.stringContaining("outbox exceeds"),
        });
        expect(rolledBack.state.tombstone).toBeNull();
        expect(rolledBack.state.files).toEqual(delivered.cdb.files);
        expect(rolledBack.state.heads).toEqual(delivered.cdb.heads);
        expect(rolledBack.state.outbox).toEqual([]);
        expect(await call<BucketState>("bucket-state")).toEqual({
            keys: [preparedFile.objectKey, "v1/safe-organization/survivor"],
        });

        const handedOff = await deleteOrganizationAndDriveCatalog(organizationId);
        expect(handedOff.organizationPresent).toBe(false);
        expect(handedOff.route.shardId).toBe(setup.ownerShardId);
        expect(handedOff.deletion).toMatchObject({ status: "complete", completedAt: expect.any(Number) });
        expect(handedOff.shards).toEqual([
            expect.objectContaining({ shardId: setup.ownerShardId, status: "complete", attempts: 0 }),
        ]);

        const fenced = await cdbState(organizationId, setup.ownerShardId);
        expect(fenced.tombstone).toEqual({
            organization_id: organizationId,
            deleted_at: expect.any(Number),
            placement_vshard: setup.vshard,
        });
        expect(fenced.heads).toEqual([expect.objectContaining({ state: "deleting", version: 2 })]);
        expect(fenced.outbox).toEqual([expect.objectContaining({ operation: "delete" })]);
        expect(fenced.files).toEqual([
            expect.objectContaining({ file_id: preparedFile.fileId, status: "deleting", row_id: rowId }),
        ]);

        const warmCatalogInstance = handedOff.instanceId;
        const warmCdbInstance = fenced.instanceId;
        await restartRuntime();

        const coldCatalog = await call<CatalogState>("catalog-state", { organizationId });
        const coldCdb = await cdbState(organizationId, setup.ownerShardId);
        expect(coldCatalog.instanceId).not.toBe(warmCatalogInstance);
        expect(coldCdb.instanceId).not.toBe(warmCdbInstance);
        expect(coldCatalog.deletion).toMatchObject({ status: "complete" });
        expect(coldCdb.tombstone).toEqual(fenced.tombstone);
        expect(coldCdb.outbox).toEqual(fenced.outbox);
        expect(coldCdb.files).toEqual(fenced.files);

        expect(await call<{ readonly authority: null }>("resolve", { organizationId })).toEqual({ authority: null });
        const hiddenFile = await call<{ readonly error: string; readonly code: string }>(
            "resolve-file",
            { organizationId, rowId, authority: setup.authority },
            500
        );
        expect(hiddenFile).toEqual({
            error: "file organization authority is invalid",
            code: "CDB_FORBIDDEN",
        });
        const rejected = await call<{
            readonly ok: false;
            readonly error: { readonly code: string; readonly message: string };
        }>("mutate-stale", {
            organizationId,
            mutId: "late-vector-after-delete",
            id: "document-late",
            body: "must not survive",
            values: [1, 0, 0],
            authority: setup.authority,
        });
        expect(rejected).toEqual({
            ok: false,
            error: expect.objectContaining({
                code: "CDB_FORBIDDEN",
                message: "organization was permanently deleted",
            }),
        });

        const deleted = await driveCdbUntil(
            organizationId,
            setup.ownerShardId,
            (cdb, index) => cdb.heads.length === 0 && cdb.outbox.length === 0 && index.documents.length === 0
        );
        expect(deleted.turns).toBeGreaterThan(0);
        expect(deleted.cdb.rows).toEqual([
            expect.objectContaining({
                id: rowId,
                attachment: preparedFile.fileId,
                embedding: created.result.vectorId,
            }),
        ]);
        expect(deleted.cdb.files).toEqual([]);
        expect(deleted.cdb.tombstone).toEqual(fenced.tombstone);
        expect(deleted.index.documents).toEqual([]);
        const deleteCalls = deleted.index.calls.filter(call => call.operation === "delete");
        expect(deleteCalls.length).toBeGreaterThan(0);
        expect(deleteCalls.some(call => (JSON.parse(call.ids_json) as string[]).includes(String(physicalId)))).toBe(
            true
        );
        expect(await call<BucketState>("bucket-state")).toEqual({ keys: ["v1/safe-organization/survivor"] });

        const otherAfter = await cdbState(organizationId, setup.otherShardId);
        expect(otherAfter.rows).toEqual([]);
        expect(otherAfter.heads).toEqual([]);
        expect(otherAfter.outbox).toEqual([]);
        expect(otherAfter.tombstone).toBeNull();
    }, 60_000);

    test("uses exact delete proof after a held upsert without letting its stale response revive the head", async () => {
        const raceOrganizationId = "native-vector-delete-claimed-upsert";
        const raceSetup = await call<SetupState>("setup", { organizationId: raceOrganizationId });
        expect(raceSetup.vshard).toBe(Number(vshardOf([raceOrganizationId])));
        expect(raceSetup.shardId).toBe(raceSetup.ownerShardId);
        expect(raceSetup.authority).toMatchObject({ organizationId: raceOrganizationId, role: "member" });

        await call("vector-arm-upsert-hold");
        const raceCreated = await call<{
            readonly ok: boolean;
            readonly ran: boolean;
            readonly result: { readonly id: string; readonly vectorId: string };
        }>("mutate", {
            organizationId: raceOrganizationId,
            mutId: "claimed-upsert-before-delete",
            id: "document-claimed",
            body: "the external upsert response will be lost",
            values: [0.5, 0.25, 1],
        });
        expect(raceCreated).toMatchObject({ ok: true, ran: true, result: { vectorId: expect.any(String) } });

        const alarmOutcome = call("cdb-alarm", { shardId: raceSetup.ownerShardId }).then(
            value => ({ ok: true as const, value }),
            error => ({ ok: false as const, error })
        );
        const held = await waitForHeldUpsert();
        expect(held.hold).toEqual({ armed: false, activeIds: [expect.any(String)] });
        const attemptedPhysicalIds = [...held.hold.activeIds];
        expect(held.documents.map(document => document.id)).toEqual(attemptedPhysicalIds);

        const claimed = await cdbState(raceOrganizationId, raceSetup.ownerShardId);
        expect(claimed.heads).toEqual([
            expect.objectContaining({ state: "pending", version: 1, delivered_version: 0 }),
        ]);
        expect(claimed.outbox).toEqual([
            expect.objectContaining({
                operation: "upsert",
                phase: "submit",
                attempts: 1,
                leased_until: expect.any(Number),
                lease_token: expect.any(String),
            }),
        ]);
        expect(claimed.attempts).toEqual([
            expect.objectContaining({
                physical_version: 1,
                visibility_confirmed: 0,
                response_ambiguous: 0,
                delete_confirmed: 0,
            }),
        ]);

        const raceHandedOff = await deleteOrganizationAndDriveCatalog(raceOrganizationId);
        expect(raceHandedOff.organizationPresent).toBe(false);
        expect(raceHandedOff.deletion).toMatchObject({ status: "complete" });
        const deletedDuringClaim = await cdbState(raceOrganizationId, raceSetup.ownerShardId);
        expect(deletedDuringClaim.tombstone).toEqual({
            organization_id: raceOrganizationId,
            deleted_at: expect.any(Number),
            placement_vshard: raceSetup.vshard,
        });
        expect(deletedDuringClaim.heads).toEqual([
            expect.objectContaining({ state: "deleting", version: 2, delivered_version: 0 }),
        ]);
        expect(deletedDuringClaim.outbox).toEqual([
            expect.objectContaining({ operation: "delete", phase: "submit", leased_until: null, lease_token: null }),
        ]);

        await call("vector-release-upsert-hold", { loseResponse: true });
        const finishedAlarm = await alarmOutcome;
        if (!finishedAlarm.ok) throw finishedAlarm.error;
        const afterLostResponse = await cdbState(raceOrganizationId, raceSetup.ownerShardId);
        expect(afterLostResponse.heads.some(head => head.state === "ready")).toBe(false);
        expect(afterLostResponse.heads).toEqual([
            expect.objectContaining({ state: "deleting", version: 2, delivered_version: 0 }),
        ]);
        expect(afterLostResponse.outbox).toEqual([expect.objectContaining({ operation: "delete" })]);
        expect(afterLostResponse.attempts).toEqual(claimed.attempts);

        const warmRaceCdbInstance = afterLostResponse.instanceId;
        const warmVectorInstance = held.instanceId;
        await restartRuntime();
        const coldRaceCdb = await cdbState(raceOrganizationId, raceSetup.ownerShardId);
        const coldVector = await call<VectorState>("vector-state");
        expect(coldRaceCdb.instanceId).not.toBe(warmRaceCdbInstance);
        expect(coldVector.instanceId).not.toBe(warmVectorInstance);
        expect(coldRaceCdb.tombstone).toEqual(afterLostResponse.tombstone);
        expect(coldRaceCdb.heads).toEqual(afterLostResponse.heads);
        expect(coldRaceCdb.attempts).toEqual(afterLostResponse.attempts);
        expect(coldVector.documents.map(document => document.id)).toEqual(attemptedPhysicalIds);

        const physicallyDeleted = await driveCdbUntil(raceOrganizationId, raceSetup.ownerShardId, (_cdb, index) =>
            attemptedPhysicalIds.every(id => !index.documents.some(document => document.id === id))
        );
        expect(physicallyDeleted.turns).toBeGreaterThan(0);
        expect(physicallyDeleted.cdb.heads).toEqual([]);
        expect(physicallyDeleted.cdb.outbox).toEqual([]);
        expect(physicallyDeleted.cdb.attempts).toEqual([]);
        expect(
            await call<VectorPurgeStatus>("cdb-vector-purge-status", {
                organizationId: raceOrganizationId,
                shardId: raceSetup.ownerShardId,
            })
        ).toEqual({
            organizationId: raceOrganizationId,
            state: "complete",
            remainingHeads: 0,
            outboxRows: 0,
            attemptRows: 0,
            unprovenTurns: 0,
            lastError: null,
        });
        const deletedPhysicalIds = new Set(
            physicallyDeleted.index.calls
                .filter(item => item.operation === "delete")
                .flatMap(item => JSON.parse(item.ids_json) as string[])
        );
        expect(attemptedPhysicalIds.every(id => deletedPhysicalIds.has(id))).toBe(true);
        expect(physicallyDeleted.index.documents.some(document => attemptedPhysicalIds.includes(document.id))).toBe(
            false
        );
        const terminalCallCount = physicallyDeleted.index.calls.length;
        await call("cdb-alarm", { organizationId: raceOrganizationId, shardId: raceSetup.ownerShardId });
        const afterTerminalAlarm = await cdbState(raceOrganizationId, raceSetup.ownerShardId);
        const afterTerminalVector = await call<VectorState>("vector-state");
        expect(afterTerminalAlarm.outbox).toEqual([]);
        expect(afterTerminalVector.calls).toHaveLength(terminalCallCount);
    }, 60_000);
});
