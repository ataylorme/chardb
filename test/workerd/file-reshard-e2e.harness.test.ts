import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import {
    CDB_SPLIT_LOG_MAX_BYTES,
    CDB_SPLIT_LOG_MAX_ROWS,
    CDB_SPLIT_TX_MAX_BYTES,
    CDB_SPLIT_TX_MAX_ROWS,
    CDB_SPLIT_TX_MAX_ROW_BYTES,
} from "../../src/oplog/schema.ts";
import { CDB_FILE_RESHARD_PAGE_SIZE } from "../../src/server/do/cdb-file-reshard-store.ts";
import { vshardOf } from "../../src/vshard.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "file-reshard-e2e.entry.ts");
const SOURCE = "ShardDO_0";
const PHASE = {
    ABORTED: -1,
    INIT: 0,
    TAIL_CAPTURE_ENABLED: 1,
    BULK_COPY_DONE: 2,
    TAIL_CAUGHT_UP: 3,
    DUAL_WRITE_OPEN: 4,
    CATALOG_CUT_OVER: 5,
    SOURCE_DRAINED: 6,
} as const;

interface SetupInput {
    readonly migId: string;
    readonly destination: string;
    readonly organizationIds: readonly [string, string, string];
}

interface SetupResult {
    readonly route: { readonly shardId: string; readonly schemaEpoch: number; readonly domainSchemaEpoch: number };
    readonly placement: number;
    readonly seeded: readonly {
        readonly fileId: string;
        readonly objectKey: string;
        readonly rowId: string;
        readonly status: string;
    }[];
}

interface FixtureState {
    readonly source: {
        readonly rows: readonly Record<string, unknown>[];
        readonly files: readonly Record<string, unknown>[];
        readonly tombstones: readonly Record<string, unknown>[];
        readonly split: Record<string, unknown> | null;
        readonly fileSplit: Record<string, unknown> | null;
        readonly splitLog: readonly Record<string, unknown>[];
    };
    readonly destination: {
        readonly rows: readonly Record<string, unknown>[];
        readonly files: readonly Record<string, unknown>[];
        readonly tombstones: readonly Record<string, unknown>[];
        readonly split: Record<string, unknown> | null;
        readonly fileSplit: Record<string, unknown> | null;
        readonly splitLog: readonly Record<string, unknown>[];
    };
    readonly resharder: Record<string, unknown>;
}

interface R2MutationStats {
    readonly putCalls: number;
    readonly deleteCalls: number;
    readonly operations: readonly {
        readonly sequence: number;
        readonly operation: "put" | "delete";
        readonly keys: readonly string[];
    }[];
}

interface SplitCapacityState {
    readonly splitLogRows: number;
    readonly splitLogBytes: number;
    readonly captureTxRows: number;
    readonly captureTxBytes: number;
    readonly storedLogRows: number;
    readonly storedTransactions: number;
    readonly metadataRows: number;
}

interface TailPage {
    readonly transactions: readonly {
        readonly sourceTxId: number;
        readonly firstLsn: number;
        readonly lastLsn: number;
        readonly entries: readonly Record<string, unknown>[];
    }[];
    readonly lastLsn: number;
    readonly done: boolean;
}

interface FileMetadataPage {
    readonly rows: readonly Record<string, unknown>[];
    readonly afterPlacement: number;
    readonly afterId: string;
    readonly done: boolean;
    readonly throughLsn: number;
}

type FileResponseLossOperation =
    | "apply_snapshot"
    | "apply_tombstones"
    | "prepare_attachments"
    | "before_activate_dest"
    | "activate_dest"
    | "drain_source"
    | "abort_source"
    | "abort_dest"
    | "finish_source"
    | "finish_dest";

interface FileResponseLossState {
    readonly operation: FileResponseLossOperation;
    readonly fired: number;
    readonly calls: number;
}

let mf: Miniflare | undefined;
let temporaryPath = "";
let workerSource = "";

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function colocatedOrganizations(prefix: string, excluded = new Set<number>()): readonly [string, string, string] {
    let first = "";
    let selectedPlacement = -1;
    for (let index = 0; index < 200_000; index++) {
        const candidate = `${prefix}-${index}`;
        const candidatePlacement = placement(candidate);
        if (excluded.has(candidatePlacement)) continue;
        first = candidate;
        selectedPlacement = candidatePlacement;
        break;
    }
    if (!first) throw new Error("could not find a fixture organization");
    const organizations = [first];
    for (let index = 200_000; organizations.length < 3 && index < 600_000; index++) {
        const candidate = `${prefix}-${index}`;
        if (placement(candidate) === selectedPlacement) organizations.push(candidate);
    }
    if (organizations.length !== 3) throw new Error("could not find three colocated fixture organizations");
    return organizations as unknown as readonly [string, string, string];
}

async function runtime(): Promise<Miniflare> {
    const instance = new Miniflare({
        name: "file-reshard-e2e",
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        r2Buckets: ["CDB_FILES"],
        r2Persist: path.join(temporaryPath, "r2"),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
    try {
        await instance.ready;
        return instance;
    } catch (error) {
        await disposeMiniflareBounded(instance, { label: "failed combined file reshard e2e startup" });
        throw error;
    }
}

async function startRuntimeBounded(label: string, limit = 4): Promise<Miniflare> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= limit; attempt++) {
        try {
            return await runtime();
        } catch (error) {
            lastError = error;
            if (attempt < limit) await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
    }
    throw new Error(`${label} failed after ${limit} attempts`, { cause: lastError });
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
        throw new Error(`${operation} returned ${response.status}: ${JSON.stringify(result)}`);
    }
    return result;
}

async function rejected(operation: string, body: Record<string, unknown>): Promise<string> {
    const result = await call<{ readonly error: string }>(operation, body, 500);
    return result.error;
}

async function phase(migId: string): Promise<number | null> {
    return (await call<{ readonly phase: number | null }>("phase", { migId })).phase;
}

async function r2MutationStats(): Promise<R2MutationStats> {
    return call<R2MutationStats>("r2Operations");
}

function expectR2MutationDelta(
    before: R2MutationStats,
    after: R2MutationStats,
    expected: readonly { readonly operation: "put" | "delete"; readonly keys: readonly string[] }[]
): void {
    const lastSequence = before.operations.at(-1)?.sequence ?? 0;
    const delta = after.operations
        .filter(operation => operation.sequence > lastSequence)
        .map(({ operation, keys }) => ({ operation, keys }));
    expect(delta).toEqual([...expected]);
    expect(after.putCalls - before.putCalls).toBe(expected.filter(operation => operation.operation === "put").length);
    expect(after.deleteCalls - before.deleteCalls).toBe(
        expected.filter(operation => operation.operation === "delete").length
    );
}

async function driveTo(migId: string, expected: number, limit = 128): Promise<void> {
    for (let turn = 0; turn < limit; turn++) {
        const current = await phase(migId);
        if (current === expected) return;
        if (current === null || current > expected) {
            throw new Error(`migration ${migId} reached phase ${String(current)} before ${expected}`);
        }
        await call("run", { migId });
    }
    throw new Error(`migration ${migId} did not reach phase ${expected} in ${limit} turns`);
}

async function armResponseLoss(shardId: string, migId: string, operation: FileResponseLossOperation): Promise<void> {
    await call("armResponseLoss", { shardId, migId, fault: operation });
}

async function responseLossState(shardId: string, migId: string): Promise<readonly FileResponseLossState[]> {
    return call<readonly FileResponseLossState[]>("responseLossState", { shardId, migId });
}

async function runUntilResponseLoss(migId: string, operation: FileResponseLossOperation, limit = 128): Promise<void> {
    const marker = `fixture response lost after ${operation} commit`;
    for (let turn = 0; turn < limit; turn++) {
        try {
            await call("run", { migId });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes(marker)) return;
            throw error;
        }
    }
    throw new Error(`migration ${migId} did not lose the ${operation} response in ${limit} turns`);
}

async function abortUntilResponseLoss(migId: string, operation: FileResponseLossOperation): Promise<void> {
    const error = await rejected("abort", { migId });
    expect(error).toContain(`fixture response lost after ${operation} commit`);
}

async function evict(className: "Catalog" | "Cdb" | "Resharder", name: string): Promise<void> {
    if (!mf) throw new Error("Miniflare is not initialized");
    try {
        await mf.unsafeEvictDurableObject("file-reshard-e2e", className, { name });
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("it is not currently running")) throw error;
    }
}

async function reconstructMovementActors(label: string, destination: string): Promise<void> {
    const targets: readonly (readonly ["Resharder" | "Cdb", string])[] = [
        ["Resharder", "global"],
        ["Cdb", SOURCE],
        ["Cdb", destination],
    ];
    for (const [className, name] of targets) {
        try {
            await evict(className, name);
        } catch (error) {
            throw new Error(`${label} ${className}:${name} reconstruction failed`, { cause: error });
        }
    }
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-file-reshard-e2e-"));
    const bundle = path.join(temporaryPath, "worker.mjs");
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
    workerSource = (await Bun.file(bundle).text())
        .replace(
            "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
            'await Promise.reject(new Error("file migrations are unavailable in workerd"))'
        )
        .replace(
            "await import(nodeSqlite)",
            'await Promise.reject(new Error("node:sqlite is unavailable in workerd"))'
        );
    if (workerSource.includes("import(")) throw new Error("fixture bundle contains a dynamic import");
    mf = await startRuntimeBounded("combined file reshard e2e startup");
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "combined file reshard e2e teardown" });
    mf = undefined;
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("combined native file-aware range movement", () => {
    const main = {
        migId: "native_file_move_main",
        destination: "ShardDO_file_destination_main",
        organizationIds: colocatedOrganizations("native-file-main"),
    } satisfies SetupInput;
    const aborted = {
        migId: "native_file_move_abort",
        destination: "ShardDO_file_destination_abort",
        organizationIds: colocatedOrganizations("native-file-abort", new Set([placement(main.organizationIds[0])])),
    } satisfies SetupInput;
    let setup: SetupResult;
    let beforeR2: readonly Record<string, unknown>[];
    let r2Checkpoint: R2MutationStats;

    test(
        "reconstructs every pre-cutover phase and closes the committed-cutover activation gap",
        coldReconstructionProof
    );

    test("starts from the real file migration journal and closes the destination", async () => {
        const beforeSetup = await r2MutationStats();
        setup = await call<SetupResult>("setup", main as unknown as Record<string, unknown>);
        expect(setup.route).toMatchObject({ shardId: SOURCE });
        expect(setup.seeded).toHaveLength(3);
        expect(new Set(setup.seeded.map(item => item.status))).toEqual(new Set(["ready"]));
        expect(
            await call<readonly Record<string, unknown>[]>("r2Prefix", {
                prefix: `v1/${main.organizationIds[0]}/`,
            })
        ).toHaveLength(1);
        const afterSetup = await r2MutationStats();
        expectR2MutationDelta(
            beforeSetup,
            afterSetup,
            setup.seeded.map(file => ({ operation: "put" as const, keys: [file.objectKey] }))
        );

        await driveTo(main.migId, PHASE.TAIL_CAPTURE_ENABLED);
        const afterMovement = await r2MutationStats();
        expectR2MutationDelta(afterSetup, afterMovement, []);
        r2Checkpoint = afterMovement;
        expect(
            await rejected("gate", {
                shardId: main.destination,
                organizationId: main.organizationIds[0],
                operation: "download",
                rowId: setup.seeded[0]?.rowId,
            })
        ).toContain("CDB_STALE_EPOCH");
        await expect(
            call("gate", {
                shardId: SOURCE,
                organizationId: main.organizationIds[0],
                operation: "download",
                rowId: setup.seeded[0]?.rowId,
            })
        ).resolves.toMatchObject({ fileId: setup.seeded[0]?.fileId, status: "attached" });
    });

    test("captures live file metadata and sends an older deletion only to the current source", async () => {
        const snapshotRaceFileId = `fil_${"9".repeat(64)}`;
        await call("seedFile", {
            shardId: SOURCE,
            organizationId: main.organizationIds[0],
            rowId: "row-snapshot-race",
            fileId: snapshotRaceFileId,
            fileBody: "race",
        });
        const afterSnapshotSeed = await r2MutationStats();
        expectR2MutationDelta(r2Checkpoint, afterSnapshotSeed, [
            {
                operation: "put",
                keys: [`v1/${main.organizationIds[0]}/${snapshotRaceFileId}`],
            },
        ]);
        const deletion = await call<{
            readonly deletion: Record<string, unknown>;
            readonly shards: readonly Record<string, unknown>[];
        }>("delete", { organizationId: main.organizationIds[1] });
        expect(deletion.deletion).toMatchObject({ status: "complete" });
        expect(deletion.shards).toEqual([expect.objectContaining({ shard_id: SOURCE, status: "complete" })]);
        const afterLogicalDeletion = await r2MutationStats();
        const deletedBeforeCutover = setup.seeded[1]?.objectKey;
        if (!deletedBeforeCutover) throw new Error("pre-cutover deletion fixture object is missing");
        expectR2MutationDelta(afterSnapshotSeed, afterLogicalDeletion, [
            { operation: "delete", keys: [deletedBeforeCutover] },
        ]);

        await armResponseLoss(main.destination, main.migId, "apply_tombstones");
        await armResponseLoss(main.destination, main.migId, "apply_snapshot");
        await runUntilResponseLoss(main.migId, "apply_tombstones");
        expect(await phase(main.migId)).toBe(PHASE.TAIL_CAPTURE_ENABLED);
        await runUntilResponseLoss(main.migId, "apply_snapshot");
        expect(await phase(main.migId)).toBe(PHASE.TAIL_CAPTURE_ENABLED);
        await driveTo(main.migId, PHASE.BULK_COPY_DONE);
        const afterBulkMovement = await r2MutationStats();
        expectR2MutationDelta(afterLogicalDeletion, afterBulkMovement, []);
        expect(await responseLossState(main.destination, main.migId)).toEqual([
            { operation: "apply_snapshot", fired: 1, calls: 2 },
            { operation: "apply_tombstones", fired: 1, calls: 2 },
        ]);
        const tailOnlyFileId = `fil_${"7".repeat(64)}`;
        await call("seedFile", {
            shardId: SOURCE,
            organizationId: main.organizationIds[0],
            rowId: "row-tail-only",
            fileId: tailOnlyFileId,
            fileBody: "tail",
        });
        const afterTailSeed = await r2MutationStats();
        expectR2MutationDelta(afterBulkMovement, afterTailSeed, [
            {
                operation: "put",
                keys: [`v1/${main.organizationIds[0]}/${tailOnlyFileId}`],
            },
        ]);
        r2Checkpoint = afterTailSeed;
        beforeR2 = await call<readonly Record<string, unknown>[]>("r2Prefix", {
            prefix: `v1/${main.organizationIds[0]}/`,
        });
        expect(beforeR2).toHaveLength(3);

        const state = await call<FixtureState>("state", main as unknown as Record<string, unknown>);
        expect(state.source.tombstones).toEqual([
            expect.objectContaining({ organization_id: main.organizationIds[1] }),
        ]);
        expect(state.destination.tombstones).toEqual([
            expect.objectContaining({ organization_id: main.organizationIds[1] }),
        ]);
        expect(state.source.splitLog.some(row => row.table_name === "_chardb_files")).toBe(true);
        expect(state.destination.files).toContainEqual(expect.objectContaining({ file_id: snapshotRaceFileId }));
        expect(state.destination.files).not.toContainEqual(expect.objectContaining({ file_id: tailOnlyFileId }));
    }, 30_000);

    test("rejects missing, changed, and extra destination metadata before cutover", async () => {
        const beforeMovement = r2Checkpoint;
        await driveTo(main.migId, PHASE.TAIL_CAUGHT_UP);
        const fileId = setup.seeded[0]?.fileId;
        if (!fileId) throw new Error("snapshot file id is missing");
        for (const mode of ["omitted", "mutated", "extra"] as const) {
            await call("corrupt", {
                destination: main.destination,
                organizationId: main.organizationIds[0],
                fileId,
                mode,
            });
            const failure = await rejected("run", { migId: main.migId });
            expect(failure).toContain("CDB_RESHARD_PHASE_MISMATCH");
            expect(failure).toContain("file metadata do not match");
            expect(await phase(main.migId)).toBe(PHASE.TAIL_CAUGHT_UP);
            await call("restore", main as unknown as Record<string, unknown>);
        }
        const afterMovement = await r2MutationStats();
        expectR2MutationDelta(beforeMovement, afterMovement, []);
        r2Checkpoint = afterMovement;
    });

    test("survives cold eviction, cuts over, and gates both owners", async () => {
        const beforeMovement = r2Checkpoint;
        await armResponseLoss(main.destination, main.migId, "prepare_attachments");
        await evict("Resharder", "global");
        await evict("Cdb", SOURCE);
        await evict("Cdb", main.destination);
        await runUntilResponseLoss(main.migId, "prepare_attachments");
        expect(await phase(main.migId)).toBe(PHASE.TAIL_CAUGHT_UP);
        await armResponseLoss(main.destination, main.migId, "activate_dest");
        await runUntilResponseLoss(main.migId, "activate_dest");
        expect(await phase(main.migId)).toBe(PHASE.TAIL_CAUGHT_UP);
        expect(await call("route", { vshard: setup.placement })).toMatchObject({ shardId: main.destination });
        await driveTo(main.migId, PHASE.DUAL_WRITE_OPEN);
        expect(await call("route", { vshard: setup.placement })).toMatchObject({ shardId: main.destination });
        expect(await responseLossState(main.destination, main.migId)).toEqual([
            { operation: "activate_dest", fired: 1, calls: 2 },
            { operation: "apply_snapshot", fired: 1, calls: 5 },
            { operation: "apply_tombstones", fired: 1, calls: 5 },
            { operation: "prepare_attachments", fired: 1, calls: 3 },
        ]);

        expect(
            await rejected("gate", {
                shardId: SOURCE,
                organizationId: main.organizationIds[0],
                operation: "reserve",
                fileId: `fil_${"8".repeat(64)}`,
            })
        ).toContain("CDB_STALE_EPOCH");
        await expect(
            call("gate", {
                shardId: main.destination,
                organizationId: main.organizationIds[0],
                operation: "download",
                rowId: setup.seeded[0]?.rowId,
            })
        ).resolves.toMatchObject({ fileId: setup.seeded[0]?.fileId, status: "attached" });
        const afterMovement = await r2MutationStats();
        expectR2MutationDelta(beforeMovement, afterMovement, []);
        r2Checkpoint = afterMovement;
    }, 30_000);

    test("routes a later organization deletion only to the destination, drains metadata, and never rewrites R2", async () => {
        const beforeLogicalDeletion = r2Checkpoint;
        const deletion = await call<{
            readonly deletion: Record<string, unknown>;
            readonly shards: readonly Record<string, unknown>[];
        }>("delete", { organizationId: main.organizationIds[2] });
        expect(deletion.deletion).toMatchObject({ status: "complete" });
        expect(deletion.shards).toEqual([expect.objectContaining({ shard_id: main.destination, status: "complete" })]);
        const afterLogicalDeletion = await r2MutationStats();
        const deletedAfterCutover = setup.seeded[2]?.objectKey;
        if (!deletedAfterCutover) throw new Error("post-cutover deletion fixture object is missing");
        expectR2MutationDelta(beforeLogicalDeletion, afterLogicalDeletion, [
            { operation: "delete", keys: [deletedAfterCutover] },
        ]);

        await armResponseLoss(SOURCE, main.migId, "drain_source");
        await armResponseLoss(SOURCE, main.migId, "finish_source");
        await armResponseLoss(main.destination, main.migId, "finish_dest");
        await runUntilResponseLoss(main.migId, "drain_source");
        expect(await phase(main.migId)).toBe(PHASE.DUAL_WRITE_OPEN);
        await runUntilResponseLoss(main.migId, "finish_source");
        expect(await phase(main.migId)).toBe(PHASE.CATALOG_CUT_OVER);
        await runUntilResponseLoss(main.migId, "finish_dest");
        expect(await phase(main.migId)).toBe(PHASE.CATALOG_CUT_OVER);
        await driveTo(main.migId, PHASE.SOURCE_DRAINED);
        const afterMovement = await r2MutationStats();
        expectR2MutationDelta(afterLogicalDeletion, afterMovement, []);
        r2Checkpoint = afterMovement;
        expect(await responseLossState(SOURCE, main.migId)).toEqual([
            { operation: "drain_source", fired: 1, calls: 3 },
            { operation: "finish_source", fired: 1, calls: 2 },
        ]);
        expect(await responseLossState(main.destination, main.migId)).toEqual([
            { operation: "activate_dest", fired: 1, calls: 2 },
            { operation: "apply_snapshot", fired: 1, calls: 5 },
            { operation: "apply_tombstones", fired: 1, calls: 5 },
            { operation: "finish_dest", fired: 1, calls: 2 },
            { operation: "prepare_attachments", fired: 1, calls: 3 },
        ]);
        const final = await call<FixtureState>("state", main as unknown as Record<string, unknown>);
        expect(final.source.rows).toEqual([]);
        expect(final.source.files).toEqual([]);
        expect(final.source.tombstones).toEqual([]);
        expect(final.destination.rows.some(row => row.organization_id === main.organizationIds[0])).toBe(true);
        expect(final.destination.files).toContainEqual(
            expect.objectContaining({ file_id: setup.seeded[0]?.fileId, status: "attached" })
        );
        expect(final.destination.tombstones).toContainEqual(
            expect.objectContaining({ organization_id: main.organizationIds[2] })
        );
        expect(final.destination.fileSplit).toMatchObject({
            role: "dest",
            outcome: "finished",
            maintenance_enabled: 1,
            attachments_enabled: 1,
        });
        const afterR2 = await call<readonly Record<string, unknown>[]>("r2Prefix", {
            prefix: `v1/${main.organizationIds[0]}/`,
        });
        expect(afterR2).toEqual(beforeR2);
    });

    test("aborts an initialized file move exactly after committed response loss without touching R2", async () => {
        const beforeSetup = r2Checkpoint;
        const abortSetup = await call<SetupResult>("setup", aborted as unknown as Record<string, unknown>);
        const afterSetup = await r2MutationStats();
        expectR2MutationDelta(
            beforeSetup,
            afterSetup,
            abortSetup.seeded.map(file => ({ operation: "put" as const, keys: [file.objectKey] }))
        );
        await driveTo(aborted.migId, PHASE.TAIL_CAPTURE_ENABLED);
        await driveTo(aborted.migId, PHASE.BULK_COPY_DONE);
        const afterInitialMovement = await r2MutationStats();
        expectR2MutationDelta(afterSetup, afterInitialMovement, []);
        const tailOnlyFileId = `fil_${"6".repeat(64)}`;
        await call("seedFile", {
            shardId: SOURCE,
            organizationId: aborted.organizationIds[0],
            rowId: "row-abort-tail-only",
            fileId: tailOnlyFileId,
            fileBody: "abort-tail",
        });
        const beforeAbortOperations = await r2MutationStats();
        expectR2MutationDelta(afterInitialMovement, beforeAbortOperations, [
            {
                operation: "put",
                keys: [`v1/${aborted.organizationIds[0]}/${tailOnlyFileId}`],
            },
        ]);
        let beforeAbortState: FixtureState | undefined;
        for (let turn = 0; turn < 16; turn++) {
            beforeAbortState = await call<FixtureState>("state", aborted as unknown as Record<string, unknown>);
            if (beforeAbortState.destination.files.some(row => row.file_id === tailOnlyFileId)) break;
            if ((await phase(aborted.migId)) !== PHASE.BULK_COPY_DONE) {
                throw new Error("abort fixture crossed its abortable tail phase before applying the tail-only file");
            }
            await call("run", { migId: aborted.migId });
        }
        if (!beforeAbortState) throw new Error("abort fixture state is missing");
        expect(beforeAbortState.destination.files).toContainEqual(expect.objectContaining({ file_id: tailOnlyFileId }));
        const objectBefore = await call<readonly Record<string, unknown>[]>("r2Prefix", {
            prefix: `v1/${aborted.organizationIds[0]}/`,
        });
        expect(objectBefore).toHaveLength(2);
        await armResponseLoss(SOURCE, aborted.migId, "abort_source");
        await armResponseLoss(aborted.destination, aborted.migId, "abort_dest");
        await abortUntilResponseLoss(aborted.migId, "abort_source");
        await abortUntilResponseLoss(aborted.migId, "abort_dest");
        for (let turn = 0; turn < 32 && (await phase(aborted.migId)) !== PHASE.ABORTED; turn++) {
            await call("abort", { migId: aborted.migId });
        }
        expect(await phase(aborted.migId)).toBe(PHASE.ABORTED);
        expect(await call("route", { vshard: placement(aborted.organizationIds[0]) })).toMatchObject({
            shardId: SOURCE,
        });
        const state = await call<FixtureState>("state", aborted as unknown as Record<string, unknown>);
        expect(state.source.files).toContainEqual(expect.objectContaining({ file_id: abortSetup.seeded[0]?.fileId }));
        expect(state.destination.files).toEqual([]);
        expect(state.destination.fileSplit).toMatchObject({
            role: "dest",
            outcome: "aborted",
            maintenance_enabled: 0,
            attachments_enabled: 0,
        });
        expect(await responseLossState(SOURCE, aborted.migId)).toEqual([
            { operation: "abort_source", fired: 1, calls: 4 },
        ]);
        expect(await responseLossState(aborted.destination, aborted.migId)).toEqual([
            { operation: "abort_dest", fired: 1, calls: 2 },
        ]);
        expect(
            await call<readonly Record<string, unknown>[]>("r2Prefix", {
                prefix: `v1/${aborted.organizationIds[0]}/`,
            })
        ).toEqual(objectBefore);
        await expect(call("abort", { migId: aborted.migId })).resolves.toMatchObject({ phase: PHASE.ABORTED });
        const afterAbort = await r2MutationStats();
        expectR2MutationDelta(beforeAbortOperations, afterAbort, []);
        r2Checkpoint = afterAbort;
    }, 30_000);

    test("retries a packaged HTTP upload on the new owner when the immutable put crosses cutover", async () => {
        const occupied = new Set([placement(main.organizationIds[0]), placement(aborted.organizationIds[0])]);
        const organizations = colocatedOrganizations("native-file-http-race", occupied);
        const movement = {
            migId: "native_file_move_http_race",
            destination: "ShardDO_file_destination_http_race",
            organizationIds: organizations,
        } satisfies SetupInput;
        const beforeSetup = r2Checkpoint;
        const httpSetup = await call<SetupResult>("setup", movement as unknown as Record<string, unknown>);
        const afterSetup = await r2MutationStats();
        expectR2MutationDelta(
            beforeSetup,
            afterSetup,
            httpSetup.seeded.map(file => ({ operation: "put" as const, keys: [file.objectKey] }))
        );
        await driveTo(movement.migId, PHASE.TAIL_CAUGHT_UP);
        const beforeHttpRace = await r2MutationStats();
        expectR2MutationDelta(afterSetup, beforeHttpRace, []);
        const fileBody = "immutable bytes across cutover";
        const result = await call<{
            readonly expectedFileId: string;
            readonly uploadStatus: number;
            readonly uploadBody: { readonly file: { readonly fileId: string } };
            readonly putCalls: number;
            readonly objectAfterFirstPut: readonly Record<string, unknown>[];
            readonly staleSourceReadyError: string;
            readonly route: { readonly shardId: string };
            readonly downloadStatus: number;
            readonly downloadBody: string;
            readonly downloadContentType: string;
            readonly secondMoveError: string;
        }>("httpUploadRace", {
            migId: movement.migId,
            destination: movement.destination,
            secondDestination: "ShardDO_file_destination_http_race_second",
            organizationId: organizations[0],
            rowId: "row-http-race",
            idempotencyKey: "http-race-retry-key",
            fileBody,
        });

        expect(result.uploadStatus).toBe(200);
        expect(result.uploadBody.file.fileId).toBe(result.expectedFileId);
        expect(result.putCalls).toBe(2);
        expect(result.objectAfterFirstPut).toEqual([
            expect.objectContaining({
                key: `v1/${organizations[0]}/${result.expectedFileId}`,
                present: true,
                size: fileBody.length,
                customMetadata: expect.objectContaining({ chardbFileId: result.expectedFileId }),
            }),
        ]);
        expect(result.staleSourceReadyError).toContain("CDB_STALE_EPOCH");
        expect(result.route).toMatchObject({ shardId: movement.destination });
        expect(result.downloadStatus).toBe(200);
        expect(result.downloadBody).toBe(fileBody);
        expect(result.downloadContentType).toBe("image/png");
        expect(result.secondMoveError).toContain("already active");
        expect(await phase(movement.migId)).toBe(PHASE.DUAL_WRITE_OPEN);
        const afterHttpRace = await r2MutationStats();
        expectR2MutationDelta(beforeHttpRace, afterHttpRace, []);

        const duringCutover = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(duringCutover.source.files).toContainEqual(
            expect.objectContaining({ file_id: result.expectedFileId, status: "pending" })
        );
        expect(duringCutover.destination.files).toContainEqual(
            expect.objectContaining({ file_id: result.expectedFileId, status: "attached", row_id: "row-http-race" })
        );
        await driveTo(movement.migId, PHASE.SOURCE_DRAINED);
        const afterMovement = await r2MutationStats();
        expectR2MutationDelta(afterHttpRace, afterMovement, []);
        const finished = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(finished.source.files).not.toContainEqual(expect.objectContaining({ file_id: result.expectedFileId }));
        expect(finished.destination.files).toContainEqual(
            expect.objectContaining({ file_id: result.expectedFileId, status: "attached", row_id: "row-http-race" })
        );
        expect(
            await call<readonly Record<string, unknown>[]>("r2Prefix", {
                prefix: `v1/${organizations[0]}/${result.expectedFileId}`,
            })
        ).toEqual(result.objectAfterFirstPut);
    }, 30_000);

    test("bounds current-owner cleanup above one delete batch across cold reconstruction", async () => {
        const occupied = new Set([
            placement(main.organizationIds[0]),
            placement(aborted.organizationIds[0]),
            placement(colocatedOrganizations("native-file-http-race")[0]),
        ]);
        const movement = {
            migId: "native_file_move_batched_delete",
            destination: "ShardDO_file_destination_batched_delete",
            organizationIds: colocatedOrganizations("native-file-batched-delete", occupied),
        } satisfies SetupInput;
        const targetOrganization = movement.organizationIds[0];
        const retainedOrganization = movement.organizationIds[1];
        const targetPrefix = `v1/${targetOrganization}/`;
        const retainedPrefix = `v1/${retainedOrganization}/`;

        const beforeSetup = await r2MutationStats();
        const batchSetup = await call<SetupResult>("setup", movement as unknown as Record<string, unknown>);
        await driveTo(movement.migId, PHASE.TAIL_CAPTURE_ENABLED);
        for (let index = 1; index < 40; index++) {
            await call("seedFile", {
                shardId: SOURCE,
                organizationId: targetOrganization,
                rowId: `row-batched-delete-${index}`,
                fileId: `fil_${(0xb000 + index).toString(16).padStart(64, "0")}`,
                fileBody: `batched-delete-${index}`,
            });
        }
        const beforeDelete = await r2MutationStats();
        expect(beforeDelete.putCalls - beforeSetup.putCalls).toBe(42);
        expect(beforeDelete.deleteCalls - beforeSetup.deleteCalls).toBe(0);
        const targetBefore = await call<readonly Record<string, unknown>[]>("r2Prefix", { prefix: targetPrefix });
        const retainedBefore = await call<readonly Record<string, unknown>[]>("r2Prefix", {
            prefix: retainedPrefix,
        });
        expect(targetBefore).toHaveLength(40);
        expect(retainedBefore).toHaveLength(1);

        const deletion = await call<{
            readonly deletion: Record<string, unknown>;
            readonly shards: readonly Record<string, unknown>[];
        }>("delete", { organizationId: targetOrganization });
        expect(deletion.deletion).toMatchObject({ status: "complete" });
        expect(deletion.shards).toEqual([expect.objectContaining({ shard_id: SOURCE, status: "complete" })]);

        const afterFirstAlarm = await r2MutationStats();
        const firstDeleteOperations = afterFirstAlarm.operations.filter(
            operation => operation.sequence > (beforeDelete.operations.at(-1)?.sequence ?? 0)
        );
        expect(firstDeleteOperations).toHaveLength(32);
        expect(firstDeleteOperations.every(operation => operation.operation === "delete")).toBe(true);
        expect(firstDeleteOperations.flatMap(operation => operation.keys)).toHaveLength(32);
        expect(
            firstDeleteOperations.flatMap(operation => operation.keys).every(key => key.startsWith(targetPrefix))
        ).toBe(true);
        expect(afterFirstAlarm.putCalls - beforeDelete.putCalls).toBe(0);
        expect(afterFirstAlarm.deleteCalls - beforeDelete.deleteCalls).toBe(32);
        expect(await call<readonly Record<string, unknown>[]>("r2Prefix", { prefix: targetPrefix })).toHaveLength(8);
        expect(await call<readonly Record<string, unknown>[]>("r2Prefix", { prefix: retainedPrefix })).toEqual(
            retainedBefore
        );
        const afterFirstState = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(afterFirstState.source.files.filter(row => row.organization_id === targetOrganization)).toHaveLength(8);

        await evict("Cdb", SOURCE);
        await evict("Resharder", "global");
        await call("fileAlarm", { shardId: SOURCE });
        const afterSecondAlarm = await r2MutationStats();
        const secondDeleteOperations = afterSecondAlarm.operations.filter(
            operation => operation.sequence > (afterFirstAlarm.operations.at(-1)?.sequence ?? 0)
        );
        expect(secondDeleteOperations).toHaveLength(8);
        expect(secondDeleteOperations.every(operation => operation.operation === "delete")).toBe(true);
        expect(
            secondDeleteOperations.flatMap(operation => operation.keys).every(key => key.startsWith(targetPrefix))
        ).toBe(true);
        expect(afterSecondAlarm.putCalls - afterFirstAlarm.putCalls).toBe(0);
        expect(afterSecondAlarm.deleteCalls - afterFirstAlarm.deleteCalls).toBe(8);
        expect(await call<readonly Record<string, unknown>[]>("r2Prefix", { prefix: targetPrefix })).toEqual([]);
        const afterSecondState = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(afterSecondState.source.files.filter(row => row.organization_id === targetOrganization)).toEqual([]);

        await call("fileAlarm", { shardId: SOURCE });
        const afterIdempotentAlarm = await r2MutationStats();
        expectR2MutationDelta(afterSecondAlarm, afterIdempotentAlarm, []);

        await driveTo(movement.migId, PHASE.SOURCE_DRAINED, 256);
        expect(await call("route", { vshard: batchSetup.placement })).toMatchObject({ shardId: movement.destination });
        const finished = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(finished.source.files).toEqual([]);
        expect(finished.source.tombstones).toEqual([]);
        expect(finished.destination.files.filter(row => row.organization_id === targetOrganization)).toEqual([]);
        expect(finished.destination.tombstones).toContainEqual(
            expect.objectContaining({ organization_id: targetOrganization })
        );
        expect(await call<readonly Record<string, unknown>[]>("r2Prefix", { prefix: targetPrefix })).toEqual([]);
        expect(await call<readonly Record<string, unknown>[]>("r2Prefix", { prefix: retainedPrefix })).toEqual(
            retainedBefore
        );
        const afterMovement = await r2MutationStats();
        expectR2MutationDelta(afterIdempotentAlarm, afterMovement, []);
        const movementDeleteKeys = afterMovement.operations
            .filter(operation => operation.sequence > (beforeDelete.operations.at(-1)?.sequence ?? 0))
            .filter(operation => operation.operation === "delete")
            .flatMap(operation => operation.keys);
        expect(movementDeleteKeys).toHaveLength(40);
        expect(new Set(movementDeleteKeys)).toEqual(new Set(targetBefore.map(row => String(row.key))));
        expect(movementDeleteKeys.some(key => key.startsWith(retainedPrefix))).toBe(false);
    }, 60_000);

    async function coldReconstructionProof(): Promise<void> {
        const mainPlacement = placement(main.organizationIds[0]);
        const abortPlacement = placement(aborted.organizationIds[0]);
        const httpOrganizations = colocatedOrganizations(
            "native-file-http-race",
            new Set([mainPlacement, abortPlacement])
        );
        const batchOrganizations = colocatedOrganizations(
            "native-file-batched-delete",
            new Set([mainPlacement, abortPlacement, placement(colocatedOrganizations("native-file-http-race")[0])])
        );
        const movement = {
            migId: "native_file_move_cold_phase_matrix",
            destination: "ShardDO_file_destination_cold_phase_matrix",
            organizationIds: colocatedOrganizations(
                "native-file-cold-phase-matrix",
                new Set([
                    mainPlacement,
                    abortPlacement,
                    placement(httpOrganizations[0]),
                    placement(batchOrganizations[0]),
                ])
            ),
        } satisfies SetupInput;

        const beforeSetup = await r2MutationStats();
        const matrixSetup = await call<SetupResult>("setup", movement as unknown as Record<string, unknown>);
        const afterSetup = await r2MutationStats();
        expectR2MutationDelta(
            beforeSetup,
            afterSetup,
            matrixSetup.seeded.map(file => ({ operation: "put" as const, keys: [file.objectKey] }))
        );
        const objectIdentity = await call<readonly Record<string, unknown>[]>("r2", {
            keys: matrixSetup.seeded.map(file => file.objectKey),
        });
        const reconstructedPhases: number[] = [];

        for (const [current, next] of [
            [PHASE.INIT, PHASE.TAIL_CAPTURE_ENABLED],
            [PHASE.TAIL_CAPTURE_ENABLED, PHASE.BULK_COPY_DONE],
            [PHASE.BULK_COPY_DONE, PHASE.TAIL_CAUGHT_UP],
        ] as const) {
            expect(await phase(movement.migId)).toBe(current);
            await reconstructMovementActors(`file phase ${current}`, movement.destination);
            expect(await phase(movement.migId)).toBe(current);
            reconstructedPhases.push(current);
            await driveTo(movement.migId, next);
            expect(await call("route", { vshard: matrixSetup.placement })).toMatchObject({ shardId: SOURCE });
        }

        await reconstructMovementActors("file pre-cutover", movement.destination);
        expect(await phase(movement.migId)).toBe(PHASE.TAIL_CAUGHT_UP);
        reconstructedPhases.push(PHASE.TAIL_CAUGHT_UP);
        await armResponseLoss(movement.destination, movement.migId, "before_activate_dest");
        await runUntilResponseLoss(movement.migId, "before_activate_dest");
        expect(await phase(movement.migId)).toBe(PHASE.TAIL_CAUGHT_UP);
        expect(await call("route", { vshard: matrixSetup.placement })).toMatchObject({
            shardId: movement.destination,
        });
        const cutoverGap = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(cutoverGap.source.fileSplit).toMatchObject({
            role: "source",
            source_fenced: 1,
            maintenance_enabled: 0,
            attachments_enabled: 1,
        });
        expect(cutoverGap.destination.fileSplit).toMatchObject({
            role: "dest",
            maintenance_enabled: 0,
            attachments_enabled: 1,
        });
        expect(cutoverGap.destination.split).toMatchObject({ destination_serving: 0 });
        expect(
            await rejected("gate", {
                shardId: SOURCE,
                organizationId: movement.organizationIds[0],
                operation: "reserve",
                fileId: `fil_${"c".repeat(64)}`,
            })
        ).toContain("CDB_STALE_EPOCH");
        expect(
            await rejected("gate", {
                shardId: movement.destination,
                organizationId: movement.organizationIds[0],
                operation: "download",
                rowId: matrixSetup.seeded[0]?.rowId,
            })
        ).toContain("CDB_STALE_EPOCH");
        expectR2MutationDelta(afterSetup, await r2MutationStats(), []);

        expect(await phase(movement.migId)).toBe(PHASE.TAIL_CAUGHT_UP);
        await driveTo(movement.migId, PHASE.DUAL_WRITE_OPEN);
        expect(await responseLossState(movement.destination, movement.migId)).toEqual([
            { operation: "before_activate_dest", fired: 1, calls: 2 },
        ]);
        const activated = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(activated.destination.fileSplit).toMatchObject({
            role: "dest",
            maintenance_enabled: 1,
            attachments_enabled: 1,
        });
        expect(activated.destination.split).toMatchObject({ destination_serving: 1 });
        await expect(
            call("gate", {
                shardId: movement.destination,
                organizationId: movement.organizationIds[0],
                operation: "download",
                rowId: matrixSetup.seeded[0]?.rowId,
            })
        ).resolves.toMatchObject({ fileId: matrixSetup.seeded[0]?.fileId, status: "attached" });

        for (const [current, next] of [
            [PHASE.DUAL_WRITE_OPEN, PHASE.CATALOG_CUT_OVER],
            [PHASE.CATALOG_CUT_OVER, PHASE.SOURCE_DRAINED],
        ] as const) {
            expect(await phase(movement.migId)).toBe(current);
            await driveTo(movement.migId, next, 256);
        }

        expect(reconstructedPhases).toEqual([
            PHASE.INIT,
            PHASE.TAIL_CAPTURE_ENABLED,
            PHASE.BULK_COPY_DONE,
            PHASE.TAIL_CAUGHT_UP,
        ]);
        expect(await phase(movement.migId)).toBe(PHASE.SOURCE_DRAINED);
        const finished = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
        expect(finished.source.files).toEqual([]);
        expect(finished.source.tombstones).toEqual([]);
        expect(finished.destination.files).toHaveLength(3);
        expect(
            await call<readonly Record<string, unknown>[]>("r2", {
                keys: matrixSetup.seeded.map(file => file.objectKey),
            })
        ).toEqual(objectIdentity);
        expectR2MutationDelta(afterSetup, await r2MutationStats(), []);
    }

    test("enforces every split-log and file metadata boundary at its production value", async () => {
        const mainPlacement = placement(main.organizationIds[0]);
        const abortPlacement = placement(aborted.organizationIds[0]);
        const httpOrganizations = colocatedOrganizations(
            "native-file-http-race",
            new Set([mainPlacement, abortPlacement])
        );
        const batchOrganizations = colocatedOrganizations(
            "native-file-batched-delete",
            new Set([mainPlacement, abortPlacement, placement(httpOrganizations[0])])
        );
        const coldOrganizations = colocatedOrganizations(
            "native-file-cold-phase-matrix",
            new Set([mainPlacement, abortPlacement, placement(httpOrganizations[0]), placement(batchOrganizations[0])])
        );
        const movement = {
            migId: "native_file_move_capacity_boundaries",
            destination: "ShardDO_file_destination_capacity_boundaries",
            organizationIds: colocatedOrganizations(
                "native-file-capacity-boundaries",
                new Set([
                    mainPlacement,
                    abortPlacement,
                    placement(httpOrganizations[0]),
                    placement(batchOrganizations[0]),
                    placement(coldOrganizations[0]),
                ])
            ),
        } satisfies SetupInput;
        const organizationId = movement.organizationIds[0];
        const beforeSetup = await r2MutationStats();
        const capacitySetup = await call<SetupResult>("setup", movement as unknown as Record<string, unknown>);
        const afterSetup = await r2MutationStats();
        expectR2MutationDelta(
            beforeSetup,
            afterSetup,
            capacitySetup.seeded.map(file => ({ operation: "put" as const, keys: [file.objectKey] }))
        );
        await driveTo(movement.migId, PHASE.TAIL_CAPTURE_ENABLED);
        const beforeCapacityProof = await r2MutationStats();
        expectR2MutationDelta(afterSetup, beforeCapacityProof, []);

        const reset = () => call("capacityReset", { migId: movement.migId });
        const state = () => call<SplitCapacityState>("capacityState", { migId: movement.migId });
        const capture = (input: {
            count: number;
            startIndex: number;
            paddingBytes?: number;
            transactions?: "single" | "separate";
        }) =>
            call<SplitCapacityState>("capacityCapture", {
                migId: movement.migId,
                organizationId,
                count: input.count,
                startIndex: input.startIndex,
                paddingBytes: input.paddingBytes ?? 0,
                transactions: input.transactions ?? "single",
            });

        await reset();
        const probe = await capture({ count: 1, startIndex: 1 });
        expect(probe).toMatchObject({
            splitLogRows: 1,
            captureTxRows: 1,
            storedLogRows: 1,
            storedTransactions: 1,
            metadataRows: 1,
        });
        expect(probe.splitLogBytes).toBeGreaterThan(0);
        expect(probe.captureTxBytes).toBeGreaterThan(0);
        expect(probe.captureTxBytes).toBeLessThan(CDB_SPLIT_TX_MAX_ROW_BYTES);
        const accountedRowBytes = probe.splitLogBytes;
        const transferRowBytes = probe.captureTxBytes;

        await reset();
        await call("capacitySet", {
            migId: movement.migId,
            rows: CDB_SPLIT_LOG_MAX_ROWS - 1,
            bytes: 0,
        });
        expect(await capture({ count: 1, startIndex: 10 })).toMatchObject({
            splitLogRows: CDB_SPLIT_LOG_MAX_ROWS,
            storedLogRows: 1,
            metadataRows: 1,
        });
        expect(
            await rejected("capacityCapture", {
                migId: movement.migId,
                organizationId,
                count: 1,
                startIndex: 11,
                paddingBytes: 0,
                transactions: "single",
            })
        ).toContain("CDB_RATE_LIMITED: source split log capacity reached");
        expect(await state()).toMatchObject({
            splitLogRows: CDB_SPLIT_LOG_MAX_ROWS,
            storedLogRows: 1,
            metadataRows: 1,
        });

        await reset();
        await call("capacitySet", {
            migId: movement.migId,
            rows: 0,
            bytes: CDB_SPLIT_LOG_MAX_BYTES - accountedRowBytes,
        });
        expect(await capture({ count: 1, startIndex: 20 })).toMatchObject({
            splitLogBytes: CDB_SPLIT_LOG_MAX_BYTES,
            storedLogRows: 1,
            metadataRows: 1,
        });
        expect(
            await rejected("capacityCapture", {
                migId: movement.migId,
                organizationId,
                count: 1,
                startIndex: 21,
                paddingBytes: 0,
                transactions: "single",
            })
        ).toContain("CDB_RATE_LIMITED: source split log capacity reached");
        expect(await state()).toMatchObject({
            splitLogBytes: CDB_SPLIT_LOG_MAX_BYTES,
            storedLogRows: 1,
            metadataRows: 1,
        });

        await reset();
        expect(await capture({ count: CDB_SPLIT_TX_MAX_ROWS, startIndex: 100 })).toMatchObject({
            splitLogRows: CDB_SPLIT_TX_MAX_ROWS,
            captureTxRows: CDB_SPLIT_TX_MAX_ROWS,
            storedLogRows: CDB_SPLIT_TX_MAX_ROWS,
            storedTransactions: 1,
            metadataRows: CDB_SPLIT_TX_MAX_ROWS,
        });
        expect((await state()).captureTxBytes).toBe(transferRowBytes * CDB_SPLIT_TX_MAX_ROWS);
        await reset();
        expect(
            await rejected("capacityCapture", {
                migId: movement.migId,
                organizationId,
                count: CDB_SPLIT_TX_MAX_ROWS + 1,
                startIndex: 1_000,
                paddingBytes: 0,
                transactions: "single",
            })
        ).toContain("CDB_RATE_LIMITED: source split log capacity reached");
        expect(await state()).toEqual({
            splitLogRows: 0,
            splitLogBytes: 0,
            captureTxRows: 0,
            captureTxBytes: 0,
            storedLogRows: 0,
            storedTransactions: 0,
            metadataRows: 0,
        });

        const exactRowPadding = (CDB_SPLIT_TX_MAX_ROW_BYTES - transferRowBytes) / 2;
        expect(Number.isSafeInteger(exactRowPadding)).toBe(true);
        expect(exactRowPadding).toBeGreaterThan(0);
        await reset();
        expect(await capture({ count: 1, startIndex: 2_000, paddingBytes: exactRowPadding })).toMatchObject({
            captureTxRows: 1,
            captureTxBytes: CDB_SPLIT_TX_MAX_ROW_BYTES,
            storedLogRows: 1,
            metadataRows: 1,
        });
        await reset();
        expect(
            await rejected("capacityCapture", {
                migId: movement.migId,
                organizationId,
                count: 1,
                startIndex: 2_100,
                paddingBytes: exactRowPadding + 1,
                transactions: "single",
            })
        ).toContain("CDB_RATE_LIMITED: source split log capacity reached");
        expect(await state()).toMatchObject({ storedLogRows: 0, metadataRows: 0 });

        expect(CDB_SPLIT_TX_MAX_BYTES).toBe(CDB_SPLIT_TX_MAX_ROW_BYTES * 4);
        await reset();
        expect(await capture({ count: 4, startIndex: 3_000, paddingBytes: exactRowPadding })).toMatchObject({
            captureTxRows: 4,
            captureTxBytes: CDB_SPLIT_TX_MAX_BYTES,
            storedLogRows: 4,
            storedTransactions: 1,
            metadataRows: 4,
        });
        await reset();
        expect(
            await rejected("capacityCapture", {
                migId: movement.migId,
                organizationId,
                count: 5,
                startIndex: 3_100,
                paddingBytes: exactRowPadding,
                transactions: "single",
            })
        ).toContain("CDB_RATE_LIMITED: source split log capacity reached");
        expect(await state()).toMatchObject({ storedLogRows: 0, metadataRows: 0 });

        await reset();
        expect(
            await capture({
                count: CDB_FILE_RESHARD_PAGE_SIZE + 1,
                startIndex: 10_000,
                transactions: "separate",
            })
        ).toMatchObject({
            splitLogRows: CDB_FILE_RESHARD_PAGE_SIZE + 1,
            storedLogRows: CDB_FILE_RESHARD_PAGE_SIZE + 1,
            storedTransactions: CDB_FILE_RESHARD_PAGE_SIZE + 1,
            metadataRows: CDB_FILE_RESHARD_PAGE_SIZE + 1,
        });
        expect(
            await rejected("capacityTailPage", {
                migId: movement.migId,
                afterLsn: 0,
                limit: CDB_FILE_RESHARD_PAGE_SIZE - 1,
            })
        ).toContain("reshard tail protocol limit must be exactly 500");
        const firstTail = await call<TailPage>("capacityTailPage", {
            migId: movement.migId,
            afterLsn: 0,
            limit: CDB_FILE_RESHARD_PAGE_SIZE,
        });
        expect(firstTail.transactions).toHaveLength(CDB_FILE_RESHARD_PAGE_SIZE);
        expect(firstTail.transactions.flatMap(transaction => transaction.entries)).toHaveLength(
            CDB_FILE_RESHARD_PAGE_SIZE
        );
        expect(firstTail.done).toBe(false);
        const secondTail = await call<TailPage>("capacityTailPage", {
            migId: movement.migId,
            afterLsn: firstTail.lastLsn,
            limit: CDB_FILE_RESHARD_PAGE_SIZE,
        });
        expect(secondTail.transactions).toHaveLength(1);
        expect(secondTail.transactions[0]?.entries).toHaveLength(1);
        expect(secondTail.done).toBe(true);

        expect(
            await rejected("capacityFilePage", {
                ...movement,
                afterPlacement: -1,
                afterFileId: "",
                limit: CDB_FILE_RESHARD_PAGE_SIZE - 1,
            })
        ).toContain("limit is not exactly 500");
        const firstFiles = await call<FileMetadataPage>("capacityFilePage", {
            ...movement,
            afterPlacement: -1,
            afterFileId: "",
            limit: CDB_FILE_RESHARD_PAGE_SIZE,
        });
        expect(firstFiles.rows).toHaveLength(CDB_FILE_RESHARD_PAGE_SIZE);
        expect(firstFiles.done).toBe(false);
        const secondFiles = await call<FileMetadataPage>("capacityFilePage", {
            ...movement,
            afterPlacement: firstFiles.afterPlacement,
            afterFileId: firstFiles.afterId,
            limit: CDB_FILE_RESHARD_PAGE_SIZE,
        });
        expect(secondFiles.rows).toHaveLength(4);
        expect(secondFiles.done).toBe(true);
        expect(
            [...firstFiles.rows, ...secondFiles.rows].filter(row =>
                String(row.contentType).startsWith("application/x-chardb-capacity-")
            )
        ).toHaveLength(CDB_FILE_RESHARD_PAGE_SIZE + 1);
        expectR2MutationDelta(beforeCapacityProof, await r2MutationStats(), []);
    }, 60_000);
});
