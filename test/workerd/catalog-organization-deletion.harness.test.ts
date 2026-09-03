import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { vshardOf } from "../../src/vshard.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "catalog-organization-deletion.entry.ts");
const WORKER_NAME = "catalog-organization-deletion-worker";

let mf: Miniflare | undefined;
let temporaryPath: string | undefined;
let workerSource: string | undefined;

async function buildWorker(output: string): Promise<string> {
    const process = Bun.spawn(
        [
            "bun",
            "build",
            ENTRY,
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            output,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await process.exited;
    if (exitCode !== 0) throw new Error(`bundle failed: ${await new Response(process.stderr).text()}`);
    return Bun.file(output).text();
}

async function runtime(): Promise<Miniflare> {
    if (!temporaryPath || !workerSource) throw new Error("fixture paths are not initialized");
    const next = new Miniflare({
        name: WORKER_NAME,
        modules: true,
        script: workerSource,
        durableObjects: {
            CATALOG: { className: "Catalog", useSQLite: true },
            VECTOR_CATALOG: { className: "VectorCatalog", useSQLite: true },
            CDB_SHARD: { className: "CdbProbe", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
    await next.ready;
    return next;
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-catalog-deletion-"));
    workerSource = await buildWorker(path.join(temporaryPath, "worker.mjs"));
    mf = await runtime();
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "Catalog organization deletion fixture final teardown" });
    mf = undefined;
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

interface ShardState {
    readonly shardId: string;
    readonly status: "pending" | "complete";
    readonly attempts: number;
}

interface FixtureState {
    readonly instanceId: string;
    readonly organizationPresent: boolean;
    readonly deletion: null | { readonly status: "pending" | "complete"; readonly completedAt: number | null };
    readonly shards: readonly ShardState[];
    readonly alarm: number | null;
}

interface ProbeState {
    readonly failing: number;
    readonly calls: number;
    readonly failed_calls: number;
    readonly successful_calls: number;
    readonly auth_calls: number;
}

async function call<TResult = Record<string, unknown>>(
    operation: string,
    body: Record<string, unknown> = {},
    expectedStatus = 200
): Promise<TResult> {
    if (!mf) throw new Error("Miniflare is not initialized");
    const response = await mf.dispatchFetch(`http://example.com/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const result = (await response.json()) as TResult;
    if (response.status !== expectedStatus) {
        throw new Error(
            `${operation} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(result)}`
        );
    }
    return result;
}

async function waitForShardAttempts(
    organizationId: string,
    shardId: string,
    minimumAttempts: number
): Promise<FixtureState> {
    for (let attempt = 0; attempt < 200; attempt++) {
        const state = await call<FixtureState>("fixtureState", { organizationId });
        const shard = state.shards.find(candidate => candidate.shardId === shardId);
        if (shard && shard.attempts >= minimumAttempts) return state;
        await Bun.sleep(10);
    }
    throw new Error(`Catalog did not retry ${shardId} after reconstruction`);
}

describe("Catalog organization deletion on native Durable Object SQLite", () => {
    test("routes a vector-backed Better Auth organization deletion through the current shard owner", async () => {
        const organizationId = "native-vector-delete-org";
        await call("vector/fixtureActivate");
        await call("vector/mutateAuth", {
            model: "organization",
            op: "create",
            payload: {
                id: organizationId,
                name: "Native Vector Delete Org",
                slug: "native-vector-delete-org",
                createdAt: 100,
            },
        });

        await call("vector/mutateAuth", {
            model: "organization",
            op: "delete",
            where: { id: organizationId },
            limitOne: true,
        });
        await call("vector/fixtureRunAlarm");
        await call("vector/fixtureRunAlarm");
        expect(await call("vector/fixtureState", { organizationId })).toMatchObject({
            organizationPresent: false,
            deletion: { status: "complete", completedAt: expect.any(Number) },
            shards: [{ shardId: "ShardDO_0", status: "complete", attempts: 0 }],
        });
        const probe = await call<ProbeState>("probeState", { shardId: "ShardDO_0" });
        expect(probe.calls).toBeGreaterThanOrEqual(1);
        expect(probe.failed_calls).toBe(0);
        expect(probe.successful_calls).toBe(probe.calls);
    });

    test("rolls back auth, tombstone, shard outbox, and alarm together, then resumes after reconstruction", async () => {
        const organizationId = "native-delete-org";
        const migrationId = "native-delete-barrier";
        const ownerIndex = Math.min(Number(vshardOf([organizationId])), 34);
        const ownerShardId = `ShardDO_${String(ownerIndex).padStart(2, "0")}`;
        const nonOwnerShardId = ownerShardId === "ShardDO_00" ? "ShardDO_01" : "ShardDO_00";
        await call("fixtureConfigureShards", { count: 35 });
        await call("fixtureActivate");
        await call("mutateAuth", {
            model: "organization",
            op: "create",
            payload: {
                id: organizationId,
                name: "Native Delete Org",
                slug: "native-delete-org",
                createdAt: 100,
            },
        });
        await call("fixtureRunAlarm");
        await call("fixtureClearAlarm");
        const before = await call<FixtureState>("fixtureState", { organizationId });
        expect(before).toMatchObject({ organizationPresent: true, deletion: null, shards: [], alarm: null });

        await call("fixtureBeginDeletionBarrier", { migrationId, organizationId });
        await call(
            "mutateAuth",
            { model: "organization", op: "delete", where: { id: organizationId }, limitOne: true },
            500
        );
        const rolledBack = await call<FixtureState>("fixtureState", { organizationId });
        expect(rolledBack).toMatchObject({ organizationPresent: true, deletion: null, shards: [], alarm: null });

        await call("fixtureAbortDeletionBarrier", { migrationId, organizationId });
        await call("probeFailure", { shardId: ownerShardId, failing: true });
        await call("mutateAuth", {
            model: "organization",
            op: "delete",
            where: { id: organizationId },
            limitOne: true,
        });
        await call("fixtureRunAlarm");
        await call("fixtureRunAlarm");
        const handedOff = await call<FixtureState>("fixtureState", { organizationId });
        expect(handedOff.organizationPresent).toBe(false);
        expect(handedOff.deletion).toMatchObject({ status: "pending" });
        expect(handedOff.shards).toEqual([
            expect.objectContaining({ shardId: ownerShardId, status: "pending", attempts: expect.any(Number) }),
        ]);
        expect(await call("probeState", { shardId: ownerShardId })).toMatchObject({
            calls: 1,
            failed_calls: 1,
            successful_calls: 0,
            auth_calls: expect.any(Number),
        });
        expect(await call("probeState", { shardId: nonOwnerShardId })).toMatchObject({ calls: 0 });

        if (!mf) throw new Error("Miniflare is not initialized");
        await call("fixtureMakeShardDue", { organizationId, shardId: ownerShardId });
        await call("fixtureClearAlarm");
        const previousRuntime = mf;
        mf = undefined;
        await disposeMiniflareBounded(previousRuntime, { label: "Catalog organization deletion cold restart" });
        mf = await runtime();
        const reconstructed = await call<FixtureState>("fixtureState", { organizationId });
        expect(reconstructed.instanceId).not.toBe(handedOff.instanceId);
        expect(reconstructed.deletion).toMatchObject({ status: "pending" });
        expect(reconstructed.shards).toEqual([
            expect.objectContaining({
                shardId: ownerShardId,
                status: "pending",
                attempts: expect.any(Number),
            }),
        ]);
        expect(reconstructed.shards[0]?.attempts).toBeGreaterThanOrEqual(handedOff.shards[0]?.attempts ?? 0);

        const retried = await waitForShardAttempts(
            organizationId,
            ownerShardId,
            (handedOff.shards[0]?.attempts ?? 0) + 1
        );
        const retriedShard = retried.shards.find(shard => shard.shardId === ownerShardId);
        if (!retriedShard) throw new Error(`Reconstructed deletion lost ${ownerShardId}`);
        const retriedProbe = await call<ProbeState>("probeState", { shardId: ownerShardId });
        expect(retriedProbe.failed_calls).toBe(retriedShard.attempts);
        expect(retriedProbe.successful_calls).toBe(0);
        expect(retriedProbe.calls).toBe(retriedProbe.failed_calls);

        await call("probeFailure", { shardId: ownerShardId, failing: false });
        await call("fixtureMakeShardDue", { organizationId, shardId: ownerShardId });
        await call("fixtureRunAlarm");
        const completed = await call<FixtureState>("fixtureState", { organizationId });
        expect(completed).toMatchObject({
            organizationPresent: false,
            deletion: { status: "complete", completedAt: expect.any(Number) },
        });
        expect(completed.shards.every(item => item.status === "complete")).toBe(true);
        const completedOwner = completed.shards.find(shard => shard.shardId === ownerShardId);
        if (!completedOwner) throw new Error(`Completed deletion lost ${ownerShardId}`);
        const completedProbe = await call<ProbeState>("probeState", { shardId: ownerShardId });
        expect(completedProbe.failed_calls).toBe(completedOwner.attempts);
        expect(completedProbe.successful_calls).toBe(1);
        expect(completedProbe.calls).toBe(completedProbe.failed_calls + completedProbe.successful_calls);
        expect(await call("probeState", { shardId: nonOwnerShardId })).toMatchObject({ calls: 0 });
        await call(
            "mutateAuth",
            {
                model: "organization",
                op: "create",
                payload: {
                    id: organizationId,
                    name: "Reused Org",
                    slug: "reused-org",
                    createdAt: 200,
                },
            },
            500
        );
    });
});
