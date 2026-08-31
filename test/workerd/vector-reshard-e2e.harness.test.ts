import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { createVectorReshardMovementBenchmarkReport } from "../../scripts/vector-reshard-movement-benchmark-report.mjs";
import { vshardOf } from "../../src/vshard.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "vector-reshard-e2e.entry.ts");
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
    readonly organizationId: string;
    readonly count: number;
}

interface StoredHead {
    readonly vector_id: string;
    readonly row_pk: string;
    readonly version: number;
    readonly delivered_version: number;
    readonly state: string;
}

interface CdbState {
    readonly rows: readonly {
        readonly id: string;
        readonly organization_id: string;
        readonly body: string;
        readonly embedding: string;
    }[];
    readonly heads: readonly StoredHead[];
    readonly outbox: readonly Record<string, unknown>[];
    readonly attempts: readonly Record<string, unknown>[];
    readonly capacity: {
        readonly head_count: number;
        readonly outbox_rows: number;
        readonly attempt_rows: number;
        readonly stored_bytes: number;
    };
    readonly tombstone: null | {
        readonly organization_id: string;
        readonly deleted_at: number;
        readonly placement_vshard: number;
    };
    readonly split: null | {
        readonly role: "source" | "dest";
        readonly capture: number;
        readonly bulk_done: number;
        readonly applied_lsn: number;
        readonly acked_lsn: number;
        readonly split_log_rows: number;
        readonly split_log_bytes: number;
        readonly drained: number;
        readonly destination_serving: number;
        readonly inbox_rows: number;
        readonly inbox_closed: number;
    };
    readonly vectorSession: null | {
        readonly terminal: number;
        readonly parity_complete: number;
        readonly outcome: string;
        readonly cleaned: number;
    };
    readonly provenance: null | {
        readonly outcome: string;
        readonly record_count: number;
        readonly receipt_count: number;
    };
    readonly vectorTail: readonly Record<string, unknown>[];
    readonly tailAccounting: { readonly rows: number; readonly bytes: number };
    readonly vectorCaptureTriggers: number;
    readonly vectorMutationTriggers: number;
}

interface FixtureState {
    readonly source: CdbState;
    readonly destination: CdbState;
    readonly resharder: {
        readonly migration: { readonly phase: number; readonly tail_cursor: number };
        readonly file: {
            readonly enabled: number;
            readonly copy_kind: "file" | "organization_tombstone";
            readonly copy_done: number;
        };
        readonly vector: {
            readonly enabled: number;
            readonly copy_page_number: number;
            readonly copy_done: number;
            readonly parity_page_number: number;
            readonly parity_done: number;
            readonly source_prepare_done: number;
            readonly source_delete_done: number;
            readonly source_frozen: number;
            readonly source_finish_done: number;
            readonly dest_finish_done: number;
        };
    };
}

interface VectorProbeState {
    readonly calls: readonly {
        readonly sequence: number;
        readonly operation: "upsert" | "delete" | "get";
        readonly ids_json: string;
    }[];
    readonly documents: readonly { readonly id: string }[];
}

interface MainMeasurement {
    readonly bulk: { readonly elapsedMs: number; readonly turns: number };
    readonly cutover: { readonly elapsedMs: number; readonly turns: number };
    readonly drain: { readonly elapsedMs: number; readonly turns: number };
    readonly totalMs: number;
    readonly snapshotLossTurns: number;
    readonly finalizeLossTurns: number;
    readonly drainLossTurns: number;
    readonly copyPages: number;
    readonly parityPages: number;
}

let mf: Miniflare | undefined;
let temporaryPath = "";
let workerSource = "";
let mutationTriggerCount = 0;
let mainMeasurement: MainMeasurement | undefined;

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function organizationAtDifferentPlacement(prefix: string, excluded: ReadonlySet<number>): string {
    for (let index = 0; index < 200_000; index++) {
        const candidate = `${prefix}-${index}`;
        if (!excluded.has(placement(candidate))) return candidate;
    }
    throw new Error("could not find a fixture organization at a different placement");
}

async function buildWorker(): Promise<string> {
    const bundle = path.join(temporaryPath, "vector-reshard-e2e.worker.mjs");
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
    if (source.includes("import(")) throw new Error("vector movement fixture contains a dynamic import");
    return source;
}

async function startRuntime(): Promise<Miniflare> {
    const instance = new Miniflare({
        name: "vector-reshard-e2e",
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
            VECTOR_INDEX: { className: "VectorIndexProbe", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
    try {
        await instance.ready;
        return instance;
    } catch (error) {
        await disposeMiniflareBounded(instance, { label: "failed vector movement E2E startup" });
        throw error;
    }
}

async function startRuntimeBounded(limit = 5): Promise<Miniflare> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= limit; attempt++) {
        try {
            return await startRuntime();
        } catch (error) {
            lastError = error;
            if (attempt < limit) await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
    }
    throw new Error(`vector movement runtime failed after ${limit} attempts`, { cause: lastError });
}

async function call<TResult>(
    operation: string,
    body: Record<string, unknown> = {},
    expectedStatus = 200
): Promise<TResult> {
    if (!mf) throw new Error("vector movement Miniflare is unavailable");
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

async function phase(migId: string): Promise<number | null> {
    return (await call<{ readonly phase: number | null }>("phase", { migId })).phase;
}

async function driveTo(
    migId: string,
    expected: number,
    limit = 512
): Promise<{ readonly elapsedMs: number; readonly turns: number }> {
    const started = performance.now();
    for (let turn = 0; turn < limit; turn++) {
        const current = await phase(migId);
        if (current === expected) return { elapsedMs: performance.now() - started, turns: turn };
        if (current === null || current > expected) {
            throw new Error(`migration ${migId} reached phase ${String(current)} before ${expected}`);
        }
        await call("run", { migId });
    }
    throw new Error(`migration ${migId} did not reach phase ${expected} in ${limit} turns`);
}

async function abortToCompletion(migId: string, limit = 32): Promise<number> {
    for (let turn = 0; turn < limit; turn++) {
        if ((await phase(migId)) === PHASE.ABORTED) return turn;
        await call("abort", { migId });
    }
    throw new Error(`migration ${migId} did not finish abort cleanup in ${limit} turns`);
}

async function runUntilResponseLoss(migId: string, operation: string, limit = 512): Promise<number> {
    const marker = `fixture response lost after ${operation} commit`;
    for (let turn = 0; turn < limit; turn++) {
        try {
            await call("run", { migId });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes(marker)) return turn + 1;
            throw error;
        }
    }
    throw new Error(`migration ${migId} did not lose the ${operation} response in ${limit} turns`);
}

async function state(input: SetupInput): Promise<FixtureState> {
    return call<FixtureState>("state", input as unknown as Record<string, unknown>);
}

async function vectorProbe(): Promise<VectorProbeState> {
    return call<VectorProbeState>("vectorCalls");
}

async function evict(className: "Cdb" | "Resharder", name: string): Promise<void> {
    if (!mf) throw new Error("vector movement Miniflare is unavailable");
    try {
        await mf.unsafeEvictDurableObject("vector-reshard-e2e", className, { name });
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("it is not currently running")) throw error;
    }
}

async function reconstructMovement(destination: string): Promise<void> {
    await evict("Resharder", "global");
    await evict("Cdb", "ShardDO_0");
    await evict("Cdb", destination);
}

async function stageTombstoneTailAfterVectorSnapshot(input: SetupInput): Promise<{
    readonly setupVshard: number;
    readonly rowId: string;
    readonly sourceBeforeAbort: CdbState;
}> {
    const setup = await call<{ readonly vshard: number }>("setup", input as unknown as Record<string, unknown>);
    await driveTo(input.migId, PHASE.TAIL_CAPTURE_ENABLED);
    await call("armResponseLoss", {
        shardId: "ShardDO_0",
        migId: input.migId,
        operation: "read_tombstones_v2",
    });
    await runUntilResponseLoss(input.migId, "read_tombstones_v2");

    let current = await state(input);
    expect(current.resharder.vector).toMatchObject({ copy_done: 1 });
    expect(current.resharder.file).toMatchObject({
        enabled: 1,
        copy_kind: "organization_tombstone",
        copy_done: 0,
    });
    expect(current.destination.tombstone).toBeNull();
    expect(current.destination.heads).toHaveLength(1);
    const rowId = current.source.rows[0]?.id;
    if (!rowId) throw new Error("tombstone ordering source row is missing");

    const mutation = await call<{ readonly ok: boolean }>("mutate", {
        shardId: "ShardDO_0",
        organizationId: input.organizationId,
        rowId,
        mutId: `${input.migId}-post-vector-snapshot`,
        body: "pending-after-vector-snapshot",
        values: [71, 72, 73],
    });
    expect(mutation.ok).toBeTrue();
    current = await state(input);
    expect(current.source.heads).toEqual([
        expect.objectContaining({ row_pk: rowId, version: 2, delivered_version: 0, state: "pending" }),
    ]);
    expect(current.destination.heads).toEqual([
        expect.objectContaining({ row_pk: rowId, version: 1, delivered_version: 0, state: "pending" }),
    ]);

    await call("deleteOrganization", {
        shardId: "ShardDO_0",
        organizationId: input.organizationId,
    });
    current = await state(input);
    expect(current.source.tombstone).toEqual({
        organization_id: input.organizationId,
        deleted_at: expect.any(Number),
        placement_vshard: setup.vshard,
    });
    expect(current.source.heads).toEqual([
        expect.objectContaining({ row_pk: rowId, version: 3, delivered_version: 0, state: "deleting" }),
    ]);
    expect(current.source.vectorTail.length).toBeGreaterThan(0);

    await call("run", { migId: input.migId });
    current = await state(input);
    expect(current.destination.tombstone).toEqual(current.source.tombstone);
    expect(current.destination.heads).toEqual([
        expect.objectContaining({ row_pk: rowId, version: 1, delivered_version: 0, state: "pending" }),
    ]);
    expect(current.destination.split).toMatchObject({ inbox_rows: expect.any(Number), applied_lsn: 0 });
    expect(current.resharder.migration.tail_cursor).toBeGreaterThan(0);
    expect(current.source.split).toMatchObject({
        split_log_rows: current.source.tailAccounting.rows,
        split_log_bytes: current.source.tailAccounting.bytes,
    });

    await call("armResponseLoss", {
        shardId: input.destination,
        migId: input.migId,
        operation: "apply_tail",
    });
    await runUntilResponseLoss(input.migId, "apply_tail");
    current = await state(input);
    expect(current.destination.tombstone).toEqual(current.source.tombstone);
    expect(current.destination.heads).toEqual([
        expect.objectContaining({ row_pk: rowId, version: 3, delivered_version: 0, state: "deleting" }),
    ]);
    expect(current.destination.split?.applied_lsn).toBeGreaterThan(0);
    expect(
        await call<readonly { readonly operation: string; readonly fired: number; readonly calls: number }[]>(
            "responseLossState",
            { shardId: input.destination, migId: input.migId }
        )
    ).toContainEqual({ operation: "apply_tail", fired: 1, calls: 1 });

    await call("run", { migId: input.migId });
    expect(
        await call<readonly { readonly operation: string; readonly fired: number; readonly calls: number }[]>(
            "responseLossState",
            { shardId: input.destination, migId: input.migId }
        )
    ).toContainEqual({ operation: "apply_tail", fired: 1, calls: 2 });
    return { setupVshard: setup.vshard, rowId, sourceBeforeAbort: current.source };
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-vector-reshard-e2e-"));
    workerSource = await buildWorker();
    mf = await startRuntimeBounded();
    mutationTriggerCount = (await call<{ readonly mutationTriggerCount: number }>("constants")).mutationTriggerCount;
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "vector movement E2E teardown", timeoutMs: 10_000 });
    mf = undefined;
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("native vector-aware range movement", () => {
    const main: SetupInput = {
        migId: "native_vector_move_501",
        destination: "ShardDO_vector_destination_501",
        organizationId: "native-vector-main",
        count: 501,
    };

    test("moves 501 live vectors through loss, reconstruction, parity, serving, and source drain", async () => {
        const totalStarted = performance.now();
        const setup = await call<{
            readonly vshard: number;
            readonly route: { readonly shardId: string };
            readonly seeded: { readonly count: number };
        }>("setup", main as unknown as Record<string, unknown>);
        expect(setup).toMatchObject({ route: { shardId: "ShardDO_0" }, seeded: { count: 501 } });
        let current = await state(main);
        expect(current.source.rows).toHaveLength(501);
        expect(current.source.heads).toHaveLength(501);
        expect(current.source.outbox).toHaveLength(501);
        expect(current.source.attempts).toHaveLength(501);
        expect(current.source.capacity).toMatchObject({ head_count: 501, outbox_rows: 501, attempt_rows: 501 });
        expect((await vectorProbe()).calls).toEqual([]);

        await driveTo(main.migId, PHASE.TAIL_CAPTURE_ENABLED);
        await call("armResponseLoss", {
            shardId: main.destination,
            migId: main.migId,
            operation: "apply_snapshot",
        });
        const snapshotLossTurns = await runUntilResponseLoss(main.migId, "apply_snapshot");
        expect(await phase(main.migId)).toBe(PHASE.TAIL_CAPTURE_ENABLED);
        current = await state(main);
        expect(current.destination.heads).toHaveLength(500);
        const raceRow = current.destination.heads[0]?.row_pk;
        if (!raceRow) throw new Error("first committed snapshot page did not contain a vector head");
        expect(current.source.vectorCaptureTriggers).toBe(9);
        expect(current.destination.vectorMutationTriggers).toBe(0);

        const raced = await call<{ readonly ok: boolean; readonly result?: { readonly vectorId: string } }>("mutate", {
            shardId: "ShardDO_0",
            organizationId: main.organizationId,
            rowId: raceRow,
            mutId: "snapshot-race-update",
            body: "updated-during-snapshot",
            values: [9001, 9002, 9003],
        });
        expect(raced.ok).toBeTrue();
        current = await state(main);
        expect(current.source.vectorTail.length).toBeGreaterThanOrEqual(2);
        expect(current.source.heads.find(head => head.row_pk === raceRow)).toMatchObject({ version: 2 });

        await reconstructMovement(main.destination);
        current = await state(main);
        expect(current.destination.vectorMutationTriggers).toBe(0);
        expect(current.source.vectorCaptureTriggers).toBe(9);
        const bulk = await driveTo(main.migId, PHASE.BULK_COPY_DONE);
        current = await state(main);
        expect(current.resharder.vector).toMatchObject({ enabled: 1, copy_done: 1 });
        expect(current.resharder.vector.copy_page_number).toBeGreaterThanOrEqual(6);
        expect(current.destination.heads).toHaveLength(501);
        expect(current.destination.outbox).toHaveLength(501);
        expect(current.destination.attempts).toHaveLength(501);
        const snapshotLoss = await call<
            readonly { readonly operation: string; readonly fired: number; readonly calls: number }[]
        >("responseLossState", { shardId: main.destination, migId: main.migId });
        expect(snapshotLoss).toEqual([
            {
                operation: "apply_snapshot",
                fired: 1,
                calls: current.resharder.vector.copy_page_number + 1,
            },
        ]);
        expect((await vectorProbe()).calls).toEqual([]);

        await driveTo(main.migId, PHASE.TAIL_CAUGHT_UP);
        await call("armResponseLoss", {
            shardId: main.destination,
            migId: main.migId,
            operation: "finalize_dest",
        });
        const finalizeLossTurns = await runUntilResponseLoss(main.migId, "finalize_dest");
        expect(await phase(main.migId)).toBe(PHASE.TAIL_CAUGHT_UP);
        expect(await call("route", { vshard: setup.vshard })).toMatchObject({ shardId: "ShardDO_0" });
        const cutover = await driveTo(main.migId, PHASE.DUAL_WRITE_OPEN);
        expect(await call("route", { vshard: setup.vshard })).toMatchObject({ shardId: main.destination });
        current = await state(main);
        expect(current.destination.split).toMatchObject({
            role: "dest",
            bulk_done: 1,
            inbox_rows: 0,
            inbox_closed: 1,
            destination_serving: 1,
        });
        expect(current.destination.vectorSession).toMatchObject({
            terminal: 1,
            parity_complete: 1,
            outcome: "finalized",
        });
        expect(current.destination.vectorMutationTriggers).toBe(mutationTriggerCount);
        expect(current.resharder.vector).toMatchObject({ source_frozen: 1, parity_done: 1 });
        expect(current.destination.heads.find(head => head.row_pk === raceRow)).toMatchObject({ version: 2 });
        expect(current.destination.rows.find(row => row.id === raceRow)).toMatchObject({
            body: "updated-during-snapshot",
        });
        expect((await vectorProbe()).calls).toEqual([]);

        const stale = await call<{ readonly ok: boolean; readonly error?: { readonly code: string } }>("mutate", {
            shardId: "ShardDO_0",
            organizationId: main.organizationId,
            rowId: raceRow,
            mutId: "stale-source-update",
            body: "must-not-commit",
            values: [1, 1, 1],
        });
        expect(stale).toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });

        await call("armResponseLoss", {
            shardId: "ShardDO_0",
            migId: main.migId,
            operation: "drain_source",
        });
        const drainLossTurns = await runUntilResponseLoss(main.migId, "drain_source");
        expect(await phase(main.migId)).toBe(PHASE.DUAL_WRITE_OPEN);
        const drain = await driveTo(main.migId, PHASE.SOURCE_DRAINED);
        current = await state(main);
        expect(current.source.rows).toEqual([]);
        expect(current.source.heads).toEqual([]);
        expect(current.source.outbox).toEqual([]);
        expect(current.source.attempts).toEqual([]);
        expect(current.source.capacity).toMatchObject({ head_count: 0, outbox_rows: 0, attempt_rows: 0 });
        expect(current.source.vectorCaptureTriggers).toBe(0);
        expect(current.destination.rows).toHaveLength(501);
        expect(current.destination.heads).toHaveLength(501);
        expect(current.destination.outbox).toHaveLength(501);
        expect(current.destination.attempts).toHaveLength(501);
        expect(current.resharder.vector).toMatchObject({
            source_prepare_done: 1,
            source_delete_done: 1,
            source_finish_done: 1,
            dest_finish_done: 1,
        });
        expect((await vectorProbe()).calls).toEqual([]);

        const destinationWrite = await call<{ readonly ok: boolean }>("mutate", {
            shardId: main.destination,
            organizationId: main.organizationId,
            rowId: raceRow,
            mutId: "destination-serving-update",
            body: "served-by-destination",
            values: [42, 43, 44],
        });
        expect(destinationWrite.ok).toBeTrue();
        current = await state(main);
        expect(current.destination.rows.find(row => row.id === raceRow)).toMatchObject({
            body: "served-by-destination",
        });
        expect(current.destination.heads.find(head => head.row_pk === raceRow)).toMatchObject({ version: 3 });
        expect((await vectorProbe()).calls).toEqual([]);

        mainMeasurement = {
            bulk,
            cutover,
            drain,
            totalMs: performance.now() - totalStarted,
            snapshotLossTurns,
            finalizeLossTurns,
            drainLossTurns,
            copyPages: current.resharder.vector.copy_page_number,
            parityPages: current.resharder.vector.parity_page_number,
        };
    }, 120_000);

    test("aborts a vector-aware destination and restores both owners without external calls", async () => {
        const aborted: SetupInput = {
            migId: "native_vector_abort",
            destination: "ShardDO_vector_destination_abort",
            organizationId: organizationAtDifferentPlacement(
                "native-vector-abort",
                new Set([placement(main.organizationId)])
            ),
            count: 1,
        };
        const before = (await vectorProbe()).calls.length;
        const setup = await call<{ readonly vshard: number }>("setup", aborted as unknown as Record<string, unknown>);
        await driveTo(aborted.migId, PHASE.TAIL_CAPTURE_ENABLED);
        let current = await state(aborted);
        expect(current.source.vectorCaptureTriggers).toBe(9);
        expect(current.destination.vectorMutationTriggers).toBe(0);
        expect(current.destination.vectorSession).not.toBeNull();

        const abortTurns = await abortToCompletion(aborted.migId);
        expect(await phase(aborted.migId)).toBe(PHASE.ABORTED);
        current = await state(aborted);
        expect(current.source.rows).toHaveLength(1);
        expect(current.source.heads).toHaveLength(1);
        expect(current.source.outbox).toHaveLength(1);
        expect(current.source.attempts).toHaveLength(1);
        expect(current.source.vectorCaptureTriggers).toBe(0);
        expect(current.source.vectorMutationTriggers).toBe(mutationTriggerCount);
        expect(current.destination.rows).toEqual([]);
        expect(current.destination.heads).toEqual([]);
        expect(current.destination.outbox).toEqual([]);
        expect(current.destination.attempts).toEqual([]);
        expect(current.destination.vectorMutationTriggers).toBe(mutationTriggerCount);
        expect(await call("route", { vshard: setup.vshard })).toMatchObject({ shardId: "ShardDO_0" });
        expect((await vectorProbe()).calls).toHaveLength(before);

        const restoredRow = current.source.rows[0]?.id;
        if (!restoredRow) throw new Error("aborted source row is missing");

        const write = await call<{ readonly ok: boolean }>("mutate", {
            shardId: "ShardDO_0",
            organizationId: aborted.organizationId,
            rowId: restoredRow,
            mutId: "post-abort-source-update",
            body: "source-restored",
            values: [7, 8, 9],
        });
        expect(write.ok).toBeTrue();
        expect((await vectorProbe()).calls).toHaveLength(before);

        if (!mainMeasurement) throw new Error("completed main movement measurement is missing");
        const report = createVectorReshardMovementBenchmarkReport({
            workload: {
                domainRows: 501,
                heads: 501,
                outboxRows: 501,
                attemptRows: 501,
                snapshotRecords: 1_503,
                pageLimit: 500,
            },
            timing: {
                bulkMs: mainMeasurement.bulk.elapsedMs,
                cutoverMs: mainMeasurement.cutover.elapsedMs,
                drainMs: mainMeasurement.drain.elapsedMs,
                totalMs: mainMeasurement.totalMs,
            },
            pages: { copy: mainMeasurement.copyPages, parity: mainMeasurement.parityPages },
            turns: {
                bulk: mainMeasurement.bulk.turns,
                cutover: mainMeasurement.cutover.turns,
                drain: mainMeasurement.drain.turns,
                snapshotLoss: mainMeasurement.snapshotLossTurns,
                finalizeLoss: mainMeasurement.finalizeLossTurns,
                drainLoss: mainMeasurement.drainLossTurns,
            },
            losses: [
                { operation: "apply_snapshot", committed: true, retried: true },
                { operation: "finalize_dest", committed: true, retried: true },
                { operation: "drain_source", committed: true, retried: true },
            ],
            restart: {
                afterVectorBegin: true,
                beforeRelationalBulkComplete: true,
                destinationGuardsStayedUninstalled: true,
            },
            externalVectorize: { movementCalls: 0 },
            abort: { completed: true, turns: abortTurns, externalVectorizeCalls: 0 },
            correctness: {
                snapshotExact: true,
                tailConverged: true,
                parityExact: true,
                coldRestartResumed: true,
                destinationGuardsRestored: true,
                sourceDrained: true,
                destinationServing: true,
                staleSourceRejected: true,
                abortRestored: true,
            },
        });
        console.info(JSON.stringify(report));
    }, 30_000);

    test("replays a post-snapshot vector deletion after its tombstone and finalizes through response loss", async () => {
        const input: SetupInput = {
            migId: "native_vector_tombstone_finalize",
            destination: "ShardDO_vector_tombstone_finalize",
            organizationId: organizationAtDifferentPlacement(
                "native-vector-tombstone-finalize",
                new Set([placement(main.organizationId)])
            ),
            count: 1,
        };
        const proof = await stageTombstoneTailAfterVectorSnapshot(input);
        await driveTo(input.migId, PHASE.SOURCE_DRAINED);
        const current = await state(input);
        expect(await call("route", { vshard: proof.setupVshard })).toMatchObject({
            shardId: input.destination,
        });
        expect(current.source.rows).toEqual([]);
        expect(current.source.heads).toEqual([]);
        expect(current.source.tombstone).toBeNull();
        expect(current.destination.rows).toEqual([
            expect.objectContaining({
                id: proof.rowId,
                organization_id: input.organizationId,
                body: "pending-after-vector-snapshot",
            }),
        ]);
        expect(current.destination.heads).toEqual([
            expect.objectContaining({ row_pk: proof.rowId, version: 3, delivered_version: 0, state: "deleting" }),
        ]);
        expect(current.destination.tombstone).toEqual({
            organization_id: input.organizationId,
            deleted_at: expect.any(Number),
            placement_vshard: proof.setupVshard,
        });
        expect(current.destination.vectorMutationTriggers).toBe(mutationTriggerCount);
        expect((await vectorProbe()).calls).toEqual([]);
    }, 60_000);

    test("replays a post-snapshot vector deletion after its tombstone and removes the destination on abort", async () => {
        const finalizePlacement = organizationAtDifferentPlacement(
            "native-vector-tombstone-finalize",
            new Set([placement(main.organizationId)])
        );
        const input: SetupInput = {
            migId: "native_vector_tombstone_abort",
            destination: "ShardDO_vector_tombstone_abort",
            organizationId: organizationAtDifferentPlacement(
                "native-vector-tombstone-abort",
                new Set([placement(main.organizationId), placement(finalizePlacement)])
            ),
            count: 1,
        };
        const proof = await stageTombstoneTailAfterVectorSnapshot(input);
        const turns = await abortToCompletion(input.migId);
        expect(turns).toBeGreaterThan(0);
        expect(await phase(input.migId)).toBe(PHASE.ABORTED);
        const current = await state(input);
        expect(await call("route", { vshard: proof.setupVshard })).toMatchObject({ shardId: "ShardDO_0" });
        expect(current.source.rows).toEqual([
            expect.objectContaining({
                id: proof.rowId,
                organization_id: input.organizationId,
                body: "pending-after-vector-snapshot",
            }),
        ]);
        expect(current.source.heads).toEqual([
            expect.objectContaining({ row_pk: proof.rowId, version: 3, delivered_version: 0, state: "deleting" }),
        ]);
        expect(current.source.tombstone).toEqual(proof.sourceBeforeAbort.tombstone);
        expect(current.source.vectorMutationTriggers).toBe(mutationTriggerCount);
        expect(current.destination.rows).toEqual([]);
        expect(current.destination.heads).toEqual([]);
        expect(current.destination.outbox).toEqual([]);
        expect(current.destination.attempts).toEqual([]);
        expect(current.destination.tombstone).toBeNull();
        expect(current.destination.vectorMutationTriggers).toBe(mutationTriggerCount);
        expect((await vectorProbe()).calls).toEqual([]);
    }, 60_000);
});
