import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { RESHARDER_PHASE, Resharder } from "../../src/server/do/resharder.ts";
import { stableJson } from "../../src/util/canonical.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

const table = {
    name: "messages",
    partitionColumn: "organization_id",
    columns: ["id", "organization_id", "body"],
} as const;

const auditTable = {
    name: "audit_log",
    partitionColumn: "organization_id",
    columns: ["id", "organization_id", "event"],
} as const;

const split = {
    migId: "split-1",
    srcShard: "source-a",
    dstShard: "destination-b",
    rangeLo: 100,
    rangeHi: 199,
    epochAtStart: 7,
    tables: [table, auditTable],
} as const;
const topologySchema = { schemaVersion: 3, schemaEpoch: 4, schemaDigest: "a".repeat(64) } as const;
const emptyStagingDestination = {
    async reshardSideStateProtocolCapabilitiesV2() {
        return { vectorSnapshot: "v2" as const, fileTombstones: "v2" as const };
    },
    async prepareReshardDestOwnership() {
        return { prepared: true, serving: true };
    },
    async activateReshardDestServing() {
        return { activated: true };
    },
    async stageTailBatch(args: { transactions: readonly { lastLsn: number }[] }) {
        return { staged: 0, lastLsn: args.transactions.at(-1)?.lastLsn ?? 0 };
    },
    async readStagedTailBatch() {
        return { transactions: [] };
    },
    async ackStagedTail() {
        return { removed: 0 };
    },
    async closeTailStaging() {
        return { closed: true };
    },
    async abortReshardVectorDest() {
        return { enabled: false, result: null };
    },
};
const emptyTailSource = {
    async reshardSideStateProtocolCapabilitiesV2() {
        return { vectorSnapshot: "v2" as const, fileTombstones: "v2" as const };
    },
    async readTailBatch(args: { afterLsn: number }) {
        return { transactions: [], lastLsn: args.afterLsn, done: true };
    },
    async ackTail(args: { throughLsn: number }) {
        return { pruned: 0, ackedLsn: args.throughLsn };
    },
    async abortReshardVectors() {
        return { enabled: false, done: true };
    },
};

async function driveToTerminal(resharder: Resharder, migId: string, maxSteps = 512) {
    for (let step = 0; step < maxSteps; step++) {
        const result = await resharder.runSplit(migId);
        if (result.phase === RESHARDER_PHASE.SOURCE_DRAINED || result.phase === RESHARDER_PHASE.ABORTED) return result;
    }
    throw new Error(`reshard ${migId} exceeded ${maxSteps} bounded steps`);
}

async function driveUntilFailure(resharder: Resharder, migId: string, maxSteps = 512): Promise<never> {
    for (let step = 0; step < maxSteps; step++) await resharder.runSplit(migId);
    throw new Error(`reshard ${migId} did not fail within ${maxSteps} bounded steps`);
}

describe("Resharder safety", () => {
    let db: Database;
    let ready: Promise<unknown>;

    beforeEach(() => {
        db = new Database(":memory:");
        ready = Promise.resolve();
    });

    afterEach(() => db.close());

    function state(): DurableObjectState {
        return {
            id: { toString: () => "resharder-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
    }

    test("startSplit accepts only an exact retry identity and never resets progress", async () => {
        let topologyBegins = 0;
        let topologyDigest = topologySchema.schemaDigest;
        const catalog = {
            async beginTopologyOperation() {
                topologyBegins++;
                return { status: "active" as const, ...topologySchema, schemaDigest: topologyDigest };
            },
        };
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_CATALOG: catalogNamespace });
        await ready;

        await resharder.startSplit(split);
        await resharder.advance(split.migId, RESHARDER_PHASE.INIT);
        await expect(
            resharder.startSplit({
                ...split,
                tables: [
                    {
                        columns: [...auditTable.columns],
                        name: auditTable.name,
                        partitionColumn: auditTable.partitionColumn,
                    },
                    {
                        partitionColumn: table.partitionColumn,
                        columns: [...table.columns],
                        name: table.name,
                    },
                ],
            })
        ).resolves.toBeUndefined();
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.TAIL_CAPTURE_ENABLED);

        for (const drifted of [
            { ...split, srcShard: "source-other" },
            { ...split, dstShard: "destination-other" },
            { ...split, rangeLo: split.rangeLo - 1 },
            { ...split, rangeHi: split.rangeHi + 1 },
            { ...split, epochAtStart: split.epochAtStart + 1 },
            { ...split, tables: [{ ...table, columns: [...table.columns, "created_at"] }, auditTable] },
        ]) {
            await expect(resharder.startSplit(drifted)).rejects.toMatchObject({
                code: "CDB_RESHARD_PHASE_MISMATCH",
            });
        }
        topologyDigest = "b".repeat(64);
        await expect(resharder.startSplit(split)).rejects.toMatchObject({
            code: "CDB_RESHARD_PHASE_MISMATCH",
            message: `migId=${split.migId} Catalog schema identity changed`,
        });
        expect(topologyBegins).toBe(3);

        expect(
            db
                .query(
                    `SELECT src_shard, dst_shard, range_lo, range_hi, epoch_at_start, tables_json
                     FROM migration_state WHERE mig_id = ?`
                )
                .get(split.migId)
        ).toEqual({
            src_shard: split.srcShard,
            dst_shard: split.dstShard,
            range_lo: split.rangeLo,
            range_hi: split.rangeHi,
            epoch_at_start: split.epochAtStart,
            tables_json: stableJson([auditTable, table]),
        });
    });

    test("startSplit rejects unbounded or ambiguous identities before Catalog", async () => {
        let topologyBegins = 0;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => ({
                async beginTopologyOperation() {
                    topologyBegins++;
                    return { status: "active" as const, ...topologySchema };
                },
            }),
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_CATALOG: catalogNamespace });
        await ready;

        for (const invalid of [
            { ...split, migId: "bad migration" },
            { ...split, srcShard: split.dstShard },
            { ...split, rangeLo: -1 },
            { ...split, rangeHi: 16_384 },
            { ...split, epochAtStart: -1 },
            { ...split, epochAtStart: 0 },
            { ...split, tables: [] },
            { ...split, tables: [{ ...table, columns: ["id", "body"] }] },
            { ...split, tables: [table, table] },
        ]) {
            await expect(resharder.startSplit(invalid)).rejects.toMatchObject({ code: "CDB_INVALID_ARGS" });
        }
        expect(topologyBegins).toBe(0);
        expect(db.query("SELECT COUNT(*) AS count FROM migration_state").get()).toEqual({ count: 0 });
    });

    test("rejects a mixed side-state protocol pair before either Cdb begins movement", async () => {
        let movementCalls = 0;
        const source = {
            ...emptyTailSource,
            reshardSideStateProtocolCapabilitiesV2: undefined,
            async beginReshardSource() {
                movementCalls++;
                return { enabled: true, triggersInstalled: 1 };
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async prepareReshardDestOwnership() {
                movementCalls++;
                return { prepared: true, serving: false };
            },
        };
        const cdbNamespace = {
            idFromName: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            get: () => ({
                async beginTopologyOperation() {
                    return { status: "active" as const, ...topologySchema };
                },
            }),
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_CATALOG: catalogNamespace, CDB_SHARD: cdbNamespace });
        await ready;
        await resharder.startSplit(split);

        await expect(resharder.runSplit(split.migId)).rejects.toMatchObject({ code: "CDB_UNSUPPORTED_FEATURE" });
        expect(movementCalls).toBe(0);
        expect(await resharder.getPhase(split.migId)).toBe(RESHARDER_PHASE.INIT);
    });

    test("holds one Catalog topology identity through cutover and source cleanup", async () => {
        const catalogCalls: { op: string; input: unknown }[] = [];
        const timeline: string[] = [];
        let parity: "missing" | "extra" | "match" = "missing";
        const fenceCalls: { op: string; input: unknown }[] = [];
        const splitBegins: { op: string; input: unknown }[] = [];
        const finishes: { op: string; input: unknown }[] = [];
        const source = {
            ...emptyTailSource,
            async prepareReshardFileSource() {
                timeline.push("file-preflight");
                return {
                    enabled: true,
                    backfill: { files: 0, tombstones: 0, done: true },
                    cursor: { kind: "organization_tombstone" as const, afterId: "", done: true },
                };
            },
            async beginReshardSource(input: unknown) {
                timeline.push("source-begin");
                splitBegins.push({ op: "source", input });
                return { enabled: true, triggersInstalled: 2 };
            },
            async beginReshardFileSource() {
                timeline.push("file-source-begin");
                return { enabled: true, triggersInstalled: 4 };
            },
            async readReshardFileTombstonesV2() {
                timeline.push("file-tombstones-read");
                return { rows: [], afterPlacement: -1, afterId: "", done: true };
            },
            async readReshardFileSnapshot() {
                timeline.push("file-snapshot-read");
                return { rows: [], afterPlacement: -1, afterId: "", done: true };
            },
            async bulkCopyBatch() {
                return { rows: [], lastRowid: 0, done: true };
            },
            async readTailBatch() {
                timeline.push("tail-read");
                return { transactions: [], lastLsn: 0, done: true };
            },
            async readSplitOpLogBatch() {
                timeline.push("oplog-read");
                return { entries: [], lastLsn: 0, done: true };
            },
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async stopReshardCapture() {
                return { stopped: true };
            },
            async dropMigratedRange() {
                timeline.push("drop-range");
                return { deleted: 0, done: true };
            },
            async prepareRoutingFence(input: unknown) {
                timeline.push("fence-prepare");
                fenceCalls.push({ op: "prepare", input });
            },
            async activateRoutingFence(input: unknown) {
                timeline.push("fence-activate");
                fenceCalls.push({ op: "activate", input });
            },
            async fenceReshardFileSource() {
                timeline.push("file-source-fence");
                return { fenced: true };
            },
            async readReshardFileParityPage() {
                timeline.push("file-source-validate");
                return {
                    kind: "organization_tombstone" as const,
                    rows: parity === "missing" ? [{ organizationId: "missing-source-row" }] : [],
                    cursor: { kind: "organization_tombstone" as const, afterPlacement: -1, afterId: "" },
                    done: true,
                };
            },
            async stopReshardFileSource() {
                timeline.push("file-source-stop");
                return { stopped: true, triggersUninstalled: 9 };
            },
            async drainReshardFiles() {
                timeline.push("file-source-drain");
                return {
                    cursor: { kind: "organization_tombstone" as const, afterPlacement: -1, afterId: "" },
                    deleted: 0,
                    done: true,
                };
            },
            async finishReshardFiles() {
                timeline.push("file-source-finish");
                return { cleaned: 0, done: true };
            },
            async finishReshardSource(input: unknown) {
                timeline.push("source-finish");
                finishes.push({ op: "source", input });
            },
            async completeRoutingFenceCleanup(input: unknown) {
                timeline.push("fence-cleanup");
                fenceCalls.push({ op: "cleanup", input });
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async provisionFreshReshardDestination(input: unknown) {
                splitBegins.push({ op: "provision", input });
            },
            async beginReshardDest(input: unknown) {
                timeline.push("dest-begin");
                splitBegins.push({ op: "dest", input });
                return { ready: true };
            },
            async beginReshardFileDest() {
                timeline.push("file-dest-begin");
                return { enabled: true, triggersUninstalled: 5 };
            },
            async activateReshardDestServing() {
                timeline.push("dest-activate");
                return { activated: true };
            },
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async applyBulkBatch() {
                return { applied: 0, skipped: 0 };
            },
            async closeReshardBulkDest() {
                return { closed: true };
            },
            async applyTailBatch() {
                return { applied: 0, lastLsn: 0 };
            },
            async applySplitOpLogBatch() {
                return { applied: 0, replayed: 0, lastLsn: 0 };
            },
            async readReshardFileParityPage() {
                timeline.push("file-dest-validate");
                return {
                    kind: "organization_tombstone" as const,
                    rows: parity === "extra" ? [{ organizationId: "extra-destination-row" }] : [],
                    cursor: { kind: "organization_tombstone" as const, afterPlacement: -1, afterId: "" },
                    done: true,
                };
            },
            async prepareReshardFileDestAttachments() {
                timeline.push("file-dest-attachments");
                return { prepared: true, triggersInstalled: 5 };
            },
            async activateReshardFileDest() {
                timeline.push("file-dest-activate");
                return { activated: true };
            },
            async finishReshardFiles() {
                timeline.push("file-dest-finish");
                return { cleaned: 0, done: true };
            },
            async finishReshardDest(input: unknown) {
                timeline.push("dest-finish");
                finishes.push({ op: "dest", input });
            },
        };
        const catalog = {
            async beginTopologyOperation(input: unknown) {
                catalogCalls.push({ op: "begin", input });
                return { status: "active" as const, ...topologySchema };
            },
            async cutover(input: unknown) {
                timeline.push("catalog-cutover");
                catalogCalls.push({ op: "cutover", input });
                return { applied: true, newEpoch: split.epochAtStart + 1 };
            },
            async beginOrganizationDeletionBarrier() {
                timeline.push("file-barrier-begin");
                return {
                    migrationId: split.migId,
                    rangeLo: split.rangeLo,
                    rangeHi: split.rangeHi,
                    deletionWatermark: 0,
                    status: "active" as const,
                    createdAt: 1,
                    finishedAt: null,
                };
            },
            async organizationDeletionBarrierStatus() {
                timeline.push("file-barrier-ready");
                return { barrier: {}, olderDeletionsComplete: true };
            },
            async completeTopologyOperation(input: unknown) {
                timeline.push("topology-complete");
                catalogCalls.push({ op: "complete", input });
                return { status: "completed" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;

        await resharder.startSplit(split);
        await expect(driveUntilFailure(resharder, split.migId)).rejects.toThrow(
            "source and destination file metadata do not match"
        );
        expect(timeline).not.toContain("file-dest-attachments");
        expect(timeline).not.toContain("catalog-cutover");
        parity = "extra";
        await expect(driveUntilFailure(resharder, split.migId)).rejects.toThrow(
            "source and destination file metadata do not match"
        );
        expect(timeline).not.toContain("file-dest-attachments");
        expect(timeline).not.toContain("catalog-cutover");
        parity = "match";
        await expect(driveToTerminal(resharder, split.migId)).resolves.toEqual({
            phase: RESHARDER_PHASE.SOURCE_DRAINED,
        });
        const boundIdentity = {
            migId: split.migId,
            recoveryGeneration: 0,
            rangeLo: split.rangeLo,
            rangeHi: split.rangeHi,
            ...topologySchema,
            tables: [auditTable, table],
        };
        expect(splitBegins.slice(0, 3)).toEqual([
            {
                op: "provision",
                input: {
                    migrationId: `reshard-dest:${split.migId}`,
                    recoveryGeneration: 0,
                    targetVersion: topologySchema.schemaVersion,
                    targetEpoch: topologySchema.schemaEpoch,
                    targetDigest: topologySchema.schemaDigest,
                },
            },
            { op: "dest", input: { ...boundIdentity, destinationGeneration: split.epochAtStart + 1 } },
            { op: "source", input: boundIdentity },
        ]);
        expect(timeline.indexOf("file-dest-begin")).toBeLessThan(timeline.indexOf("dest-begin"));
        expect(timeline.indexOf("dest-begin")).toBeLessThan(timeline.indexOf("source-begin"));
        expect(
            splitBegins
                .slice(3)
                .every(call => call.op === "source" && stableJson(call.input) === stableJson(boundIdentity))
        ).toBeTrue();
        expect(finishes).toEqual([
            { op: "source", input: boundIdentity },
            { op: "dest", input: boundIdentity },
        ]);
        expect(catalogCalls).toEqual([
            {
                op: "begin",
                input: {
                    migId: split.migId,
                    recoveryGeneration: 0,
                    sourceShard: split.srcShard,
                    destinationShard: split.dstShard,
                    rangeLo: split.rangeLo,
                    rangeHi: split.rangeHi,
                    startEpoch: split.epochAtStart,
                },
            },
            {
                op: "cutover",
                input: {
                    migId: split.migId,
                    recoveryGeneration: 0,
                    lo: split.rangeLo,
                    hi: split.rangeHi,
                    fromShard: split.srcShard,
                    toShard: split.dstShard,
                    startEpoch: split.epochAtStart,
                },
            },
            {
                op: "complete",
                input: {
                    migId: split.migId,
                    recoveryGeneration: 0,
                    sourceShard: split.srcShard,
                    destinationShard: split.dstShard,
                    rangeLo: split.rangeLo,
                    rangeHi: split.rangeHi,
                    startEpoch: split.epochAtStart,
                },
            },
        ]);
        const fenceIdentity = {
            migrationId: split.migId,
            recoveryGeneration: 0,
            rangeLo: split.rangeLo,
            rangeHi: split.rangeHi,
            sourceGeneration: split.epochAtStart,
            destinationGeneration: split.epochAtStart + 1,
        };
        expect(fenceCalls.at(-1)).toEqual({ op: "cleanup", input: fenceIdentity });
        expect(fenceCalls.slice(0, -1).length).toBe(6);
        expect(
            fenceCalls.slice(0, -1).every((call, index) => {
                const expectedOp = index % 2 === 0 ? "prepare" : "activate";
                return call.op === expectedOp && stableJson(call.input) === stableJson(fenceIdentity);
            })
        ).toBeTrue();
        const activatedAt = timeline.indexOf("fence-activate");
        const cutoverAt = timeline.indexOf("catalog-cutover");
        expect(activatedAt).toBeGreaterThan(-1);
        expect(
            timeline
                .slice(activatedAt + 1, cutoverAt)
                .filter(event => event === "tail-read" || event === "oplog-read")
                .slice(-4)
        ).toEqual(["tail-read", "tail-read", "oplog-read", "oplog-read"]);
        expect(timeline.indexOf("file-preflight")).toBeLessThan(timeline.indexOf("file-source-begin"));
        expect(timeline.indexOf("file-source-begin")).toBeLessThan(timeline.indexOf("file-tombstones-read"));
        expect(timeline.indexOf("file-tombstones-read")).toBeLessThan(timeline.indexOf("file-snapshot-read"));
        expect(timeline.indexOf("file-barrier-begin")).toBeLessThan(timeline.indexOf("file-barrier-ready"));
        expect(timeline.indexOf("file-barrier-ready")).toBeLessThan(timeline.indexOf("fence-activate"));
        expect(timeline.indexOf("fence-activate")).toBeLessThan(timeline.indexOf("file-source-fence"));
        expect(timeline.indexOf("file-source-fence")).toBeLessThan(timeline.indexOf("file-dest-validate"));
        expect(timeline.indexOf("file-dest-validate")).toBeLessThan(timeline.indexOf("file-dest-attachments"));
        expect(timeline.indexOf("file-dest-attachments")).toBeLessThan(cutoverAt);
        expect(cutoverAt).toBeLessThan(timeline.indexOf("file-dest-activate"));
        expect(timeline.indexOf("file-source-stop")).toBeLessThan(timeline.indexOf("file-source-drain"));
        expect(timeline.indexOf("file-source-drain")).toBeLessThan(timeline.indexOf("file-source-finish"));
        expect(cutoverAt).toBeLessThan(timeline.indexOf("dest-activate"));
        expect(timeline.indexOf("dest-activate")).toBeLessThan(timeline.indexOf("drop-range"));
        expect(timeline.indexOf("source-finish")).toBeLessThan(timeline.indexOf("fence-cleanup"));
        expect(timeline.indexOf("fence-cleanup")).toBeLessThan(timeline.indexOf("dest-finish"));
        expect(timeline.indexOf("dest-finish")).toBeLessThan(timeline.indexOf("topology-complete"));
        expect(timeline.indexOf("fence-cleanup")).toBeLessThan(timeline.indexOf("topology-complete"));
    });

    test("retries an exact activated fence after a crash before post-fence convergence", async () => {
        let activated = false;
        let failFirstPostFenceRead = true;
        let prepareCalls = 0;
        let activateCalls = 0;
        let postFenceEmptyReads = 0;
        let cutovers = 0;
        const fenceInputs: unknown[] = [];
        const source = {
            ...emptyTailSource,
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async beginReshardSource() {
                return { enabled: true, triggersInstalled: 2 };
            },
            async bulkCopyBatch() {
                return { rows: [], lastRowid: 0, done: true };
            },
            async readTailBatch() {
                if (activated && failFirstPostFenceRead) {
                    failFirstPostFenceRead = false;
                    throw new Error("injected crash after source fence activation");
                }
                if (activated) postFenceEmptyReads++;
                return { transactions: [], lastLsn: 0, done: true };
            },
            async readSplitOpLogBatch() {
                return { entries: [], lastLsn: 0, done: true };
            },
            async prepareRoutingFence(input: unknown) {
                prepareCalls++;
                fenceInputs.push(input);
            },
            async activateRoutingFence(input: unknown) {
                activateCalls++;
                fenceInputs.push(input);
                activated = true;
            },
            async stopReshardCapture() {
                return { stopped: true };
            },
            async dropMigratedRange() {
                return { deleted: 0, done: true };
            },
            async finishReshardSource() {},
            async completeRoutingFenceCleanup() {},
        };
        const destination = {
            ...emptyStagingDestination,
            async provisionFreshReshardDestination() {},
            async beginReshardDest() {
                return { ready: true };
            },
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async applyBulkBatch() {
                return { applied: 0, skipped: 0 };
            },
            async closeReshardBulkDest() {
                return { closed: true };
            },
            async applyTailBatch() {
                return { applied: 0, lastLsn: 0 };
            },
            async applySplitOpLogBatch() {
                return { applied: 0, replayed: 0, lastLsn: 0 };
            },
            async finishReshardDest() {},
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async cutover() {
                cutovers++;
                expect(postFenceEmptyReads).toBeGreaterThanOrEqual(2);
                return { applied: true, newEpoch: split.epochAtStart + 1 };
            },
            async completeTopologyOperation() {
                return { status: "completed" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);

        await expect(driveUntilFailure(resharder, split.migId)).rejects.toThrow("injected crash");
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.TAIL_CAUGHT_UP);
        expect(cutovers).toBe(0);
        await expect(driveToTerminal(resharder, split.migId)).resolves.toEqual({
            phase: RESHARDER_PHASE.SOURCE_DRAINED,
        });

        expect(prepareCalls).toBe(2);
        expect(activateCalls).toBe(2);
        expect(cutovers).toBe(1);
        expect(new Set(fenceInputs.map(stableJson))).toEqual(
            new Set([
                stableJson({
                    migrationId: split.migId,
                    recoveryGeneration: 0,
                    rangeLo: split.rangeLo,
                    rangeHi: split.rangeHi,
                    sourceGeneration: split.epochAtStart,
                    destinationGeneration: split.epochAtStart + 1,
                }),
            ])
        );
    });

    test("a phase-five retry after source finish does not reinstall drained capture triggers", async () => {
        let sourceBegins = 0;
        let sourceFinishes = 0;
        let fenceCleanups = 0;
        let destinationFinishes = 0;
        let topologyCompletions = 0;
        const source = {
            ...emptyTailSource,
            async beginReshardSource() {
                sourceBegins++;
                throw new Error("drained source capture must not be re-enabled");
            },
            async finishReshardSource() {
                sourceFinishes++;
            },
            async completeRoutingFenceCleanup() {
                fenceCleanups++;
                if (fenceCleanups === 1) throw new Error("injected crash after source finish");
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async finishReshardDest() {
                destinationFinishes++;
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async completeTopologyOperation() {
                topologyCompletions++;
                return { status: "completed" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);
        for (const phase of [
            RESHARDER_PHASE.INIT,
            RESHARDER_PHASE.TAIL_CAPTURE_ENABLED,
            RESHARDER_PHASE.BULK_COPY_DONE,
            RESHARDER_PHASE.TAIL_CAUGHT_UP,
            RESHARDER_PHASE.DUAL_WRITE_OPEN,
        ]) {
            await resharder.advance(split.migId, phase);
        }

        await expect(resharder.runSplit(split.migId)).rejects.toThrow("injected crash after source finish");
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.CATALOG_CUT_OVER);
        await expect(driveToTerminal(resharder, split.migId)).resolves.toEqual({
            phase: RESHARDER_PHASE.SOURCE_DRAINED,
        });

        expect(sourceBegins).toBe(0);
        expect(sourceFinishes).toBe(2);
        expect(fenceCleanups).toBe(2);
        expect(destinationFinishes).toBe(1);
        expect(topologyCompletions).toBe(1);
    });

    test("a legacy phase-four resume confirms Catalog and activates destination before source drain", async () => {
        const timeline: string[] = [];
        const source = {
            ...emptyTailSource,
            async beginReshardSource() {
                return { enabled: true, triggersInstalled: 0 };
            },
            async readSplitOpLogBatch() {
                return { entries: [], lastLsn: 0, done: true };
            },
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async stopReshardCapture() {
                timeline.push("stop-capture");
                return { stopped: true };
            },
            async dropMigratedRange() {
                timeline.push("drop-range");
                return { deleted: 0, done: true };
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async prepareReshardDestOwnership() {
                timeline.push("prepare-destination");
                return { prepared: true, serving: false };
            },
            async activateReshardDestServing() {
                timeline.push("activate-destination");
                return { activated: true };
            },
            async applyTailBatch() {
                return { applied: 0, lastLsn: 0 };
            },
            async applySplitOpLogBatch() {
                return { applied: 0, replayed: 0, lastLsn: 0 };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async cutover() {
                timeline.push("catalog-cutover");
                return { applied: false, newEpoch: split.epochAtStart + 1 };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_SHARD: shardNamespace, CDB_CATALOG: catalogNamespace });
        await ready;
        await resharder.startSplit(split);
        for (const phase of [
            RESHARDER_PHASE.INIT,
            RESHARDER_PHASE.TAIL_CAPTURE_ENABLED,
            RESHARDER_PHASE.BULK_COPY_DONE,
            RESHARDER_PHASE.TAIL_CAUGHT_UP,
        ]) {
            await resharder.advance(split.migId, phase);
        }

        await resharder.runSplit(split.migId);
        expect(timeline.slice(0, 3)).toEqual(["prepare-destination", "catalog-cutover", "activate-destination"]);
        expect(timeline.indexOf("activate-destination")).toBeLessThan(timeline.indexOf("stop-capture"));
        expect(timeline.indexOf("activate-destination")).toBeLessThan(timeline.indexOf("drop-range"));
    });

    test("operator recovery resumes a legacy phase-three move only after exact destination cutover", async () => {
        const timeline: string[] = [];
        const source = {
            ...emptyTailSource,
            async beginReshardSource() {
                return { enabled: true, triggersInstalled: 0 };
            },
            async beginReshardFileSource() {
                return { enabled: true, triggersInstalled: 0 };
            },
            async readTailBatch() {
                throw new Error("legacy recovery must not replay unknown tail");
            },
            async readSplitOpLogBatch() {
                throw new Error("legacy recovery must not replay unknown oplog");
            },
            async stopReshardCapture() {
                timeline.push("stop-capture");
                return { stopped: true };
            },
            async stopReshardFileSource() {
                timeline.push("stop-files");
                return { stopped: true, triggersUninstalled: 0 };
            },
            async reshardTableOrder() {
                return { tableNames: ["audit_log", "messages"] };
            },
            async dropMigratedRange() {
                timeline.push("drop-range");
                return { deleted: 0, done: true };
            },
            async drainReshardFiles() {
                timeline.push("drain-files");
                return {
                    cursor: { kind: "file" as const, afterPlacement: -1, afterId: "" },
                    deleted: 0,
                    done: true,
                };
            },
        };
        let destinationServing = false;
        let loseActivationResponse = true;
        let releaseProvenance!: () => void;
        let markProvenanceEntered!: () => void;
        const provenanceGate = new Promise<void>(resolve => {
            releaseProvenance = resolve;
        });
        const provenanceEntered = new Promise<void>(resolve => {
            markProvenanceEntered = resolve;
        });
        let provenanceCalls = 0;
        const destination = {
            ...emptyStagingDestination,
            async reshardFileAppliedProvenance() {
                timeline.push("provenance");
                provenanceCalls++;
                markProvenanceEntered();
                await provenanceGate;
                return { rows: 2, legacyRows: 2 };
            },
            async prepareReshardDestOwnership() {
                timeline.push("prepare-destination");
                return { prepared: true, serving: destinationServing };
            },
            async activateReshardFileDest() {
                timeline.push("activate-files");
                return { activated: true };
            },
            async activateReshardDestServing() {
                timeline.push("activate-destination");
                destinationServing = true;
                if (loseActivationResponse) {
                    loseActivationResponse = false;
                    throw new Error("lost activation response");
                }
                return { activated: true };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async topologyRoutingStatus() {
                timeline.push("routing-status");
                return { owner: "destination" as const, schemaEpoch: 8, operationStatus: "active" as const };
            },
            async cutover() {
                throw new Error("legacy recovery must not repeat Catalog cutover");
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_SHARD: shardNamespace, CDB_CATALOG: catalogNamespace });
        await ready;
        await resharder.startSplit(split);
        db.query("UPDATE migration_file_cursor SET enabled = 1, prepare_done = 1 WHERE mig_id = ?").run(split.migId);
        for (const phase of [
            RESHARDER_PHASE.INIT,
            RESHARDER_PHASE.TAIL_CAPTURE_ENABLED,
            RESHARDER_PHASE.BULK_COPY_DONE,
        ]) {
            await resharder.advance(split.migId, phase);
        }

        const firstRecovery = resharder.recoverLegacyFileMovement(split.migId);
        const duplicateRecovery = resharder.recoverLegacyFileMovement(split.migId);
        await provenanceEntered;
        await expect(resharder.runSplit(split.migId)).rejects.toMatchObject({ code: "CDB_RESHARD_PHASE_MISMATCH" });
        await expect(resharder.abort(split.migId)).rejects.toMatchObject({ code: "CDB_RESHARD_PHASE_MISMATCH" });
        releaseProvenance();
        await expect(Promise.all([firstRecovery, duplicateRecovery])).rejects.toThrow("lost activation response");
        expect(provenanceCalls).toBe(1);

        await expect(resharder.recoverLegacyFileMovement(split.migId)).resolves.toEqual({
            action: "resumed",
            phase: RESHARDER_PHASE.DUAL_WRITE_OPEN,
        });
        await expect(resharder.recoverLegacyFileMovement(split.migId)).resolves.toEqual({
            action: "resumed",
            phase: RESHARDER_PHASE.DUAL_WRITE_OPEN,
        });
        expect(provenanceCalls).toBe(2);
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.DUAL_WRITE_OPEN);
        expect(
            db.query("SELECT legacy_cutover_recovered FROM migration_state WHERE mig_id = ?").get(split.migId)
        ).toEqual({ legacy_cutover_recovered: 1 });
        for (let step = 0; step < 8 && (await resharder.getPhase(split.migId)) === 4; step++) {
            await resharder.runSplit(split.migId);
        }
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.CATALOG_CUT_OVER);
        expect(timeline).toContain("stop-capture");
        expect(timeline.filter(event => event === "drop-range")).toHaveLength(2);
    });

    test("operator recovery aborts Catalog before canceling a legacy phase-three source fence", async () => {
        const timeline: string[] = [];
        let loseDestinationAbortResponse = true;
        const source = {
            ...emptyTailSource,
            async cancelRoutingFenceBeforeCutover() {
                timeline.push("cancel-fence");
            },
            async abortReshardFiles() {
                timeline.push("abort-source-files");
                return { afterKind: "" as const, afterId: "", deleted: 0, done: true };
            },
            async abortReshardSource() {
                timeline.push("abort-source");
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async reshardFileAppliedProvenance() {
                timeline.push("provenance");
                return { rows: 1, legacyRows: 1 };
            },
            async beginReshardDestAbort() {
                timeline.push("dest-fence");
                return { started: true };
            },
            async abortReshardFiles() {
                timeline.push("abort-dest-files");
                return { afterKind: "file" as const, afterId: "legacy", deleted: 1, done: true };
            },
            async abortReshardDestBatch() {
                timeline.push("abort-dest");
                if (loseDestinationAbortResponse) {
                    loseDestinationAbortResponse = false;
                    throw new Error("lost destination abort response");
                }
                return { deleted: 0, done: true };
            },
        };
        let catalogStatus: "active" | "aborted" = "active";
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async topologyRoutingStatus() {
                timeline.push("routing-status");
                return { owner: "source" as const, schemaEpoch: 7, operationStatus: catalogStatus };
            },
            async abortTopologyOperation() {
                timeline.push("catalog-abort");
                catalogStatus = "aborted";
                return { status: "aborted" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_SHARD: shardNamespace, CDB_CATALOG: catalogNamespace });
        await ready;
        await resharder.startSplit(split);
        db.query("UPDATE migration_file_cursor SET enabled = 1, prepare_done = 1 WHERE mig_id = ?").run(split.migId);
        for (const phase of [
            RESHARDER_PHASE.INIT,
            RESHARDER_PHASE.TAIL_CAPTURE_ENABLED,
            RESHARDER_PHASE.BULK_COPY_DONE,
        ]) {
            await resharder.advance(split.migId, phase);
        }

        await expect(resharder.recoverLegacyFileMovement(split.migId)).rejects.toThrow(
            "lost destination abort response"
        );
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.ABORTING);
        await expect(resharder.recoverLegacyFileMovement(split.migId)).resolves.toEqual({
            action: "aborted",
            phase: RESHARDER_PHASE.ABORTED,
        });
        expect(timeline.filter(event => event === "provenance")).toHaveLength(1);
        expect(timeline.filter(event => event === "routing-status")).toHaveLength(2);
        expect(timeline.filter(event => event === "catalog-abort")).toHaveLength(2);
        expect(db.query("SELECT enabled FROM migration_vector_cursor WHERE mig_id = ?").get(split.migId)).toEqual({
            enabled: 0,
        });
        for (let offset = 0; offset < 2; offset++) {
            const routingIndex = timeline.indexOf(
                "routing-status",
                offset === 0 ? 0 : timeline.indexOf("routing-status") + 1
            );
            const abortIndex = timeline.indexOf("catalog-abort", routingIndex);
            const cancelIndex = timeline.indexOf("cancel-fence", abortIndex);
            expect(routingIndex).toBeLessThan(abortIndex);
            expect(abortIndex).toBeLessThan(cancelIndex);
        }
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.ABORTED);
    });

    test("refuses abort once the durable source-fence boundary is reachable", async () => {
        let abortCalls = 0;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => ({
                async beginTopologyOperation() {
                    return { status: "active" as const, ...topologySchema };
                },
                async abortTopologyOperation() {
                    abortCalls++;
                    return { status: "aborted" as const };
                },
            }),
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_CATALOG: catalogNamespace });
        await ready;
        await resharder.startSplit(split);
        await resharder.advance(split.migId, RESHARDER_PHASE.INIT);
        await resharder.advance(split.migId, RESHARDER_PHASE.TAIL_CAPTURE_ENABLED);
        await resharder.advance(split.migId, RESHARDER_PHASE.BULK_COPY_DONE);

        await expect(resharder.abort(split.migId)).rejects.toMatchObject({
            code: "CDB_RESHARD_PHASE_MISMATCH",
        });
        expect(abortCalls).toBe(0);
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.TAIL_CAUGHT_UP);
    });

    test("fails closed when an unknown vector abort capability cannot be probed", async () => {
        let destinationFences = 0;
        const source = {
            async abortReshardSource() {},
        };
        const destination = {
            ...emptyStagingDestination,
            async beginReshardDestAbort() {
                destinationFences++;
                return { started: true };
            },
            async abortReshardDestBatch() {
                return { deleted: 0, done: true };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async abortTopologyOperation() {
                return { status: "aborted" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);

        await expect(resharder.abort(split.migId)).rejects.toMatchObject({
            code: "CDB_UNSUPPORTED_FEATURE",
            message: "vector source abort probe RPC is unavailable",
        });
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.ABORTING);
        expect(destinationFences).toBe(0);
    });

    test("fails closed when the destination vector abort probe is unavailable", async () => {
        let destinationBatches = 0;
        const source = {
            ...emptyTailSource,
            async abortReshardSource() {},
        };
        const destination = {
            async beginReshardDestAbort() {
                return { started: true };
            },
            async abortReshardDestBatch() {
                destinationBatches++;
                return { deleted: 0, done: true };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async abortTopologyOperation() {
                return { status: "aborted" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);

        await expect(resharder.abort(split.migId)).rejects.toMatchObject({
            code: "CDB_UNSUPPORTED_FEATURE",
            message: "vector destination abort probe RPC is unavailable",
        });
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.ABORTING);
        expect(destinationBatches).toBe(1);
    });

    test("persists ABORTING before cleanup and resumes source-first bounded rollback after a crash", async () => {
        const timeline: string[] = [];
        const identities: unknown[] = [];
        let destinationCalls = 0;
        const source = {
            ...emptyTailSource,
            async abortReshardSource(input: unknown) {
                timeline.push("source-cleanup");
                identities.push(input);
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async beginReshardDestAbort(input: unknown) {
                timeline.push("dest-fence");
                identities.push(input);
                return { started: true };
            },
            async abortReshardDestBatch(input: unknown) {
                destinationCalls++;
                identities.push(input);
                if (destinationCalls === 1) {
                    timeline.push("dest-batch");
                    return { deleted: 500, done: false };
                }
                if (destinationCalls === 2) {
                    timeline.push("dest-crash");
                    throw new Error("injected destination cleanup crash");
                }
                timeline.push("dest-done");
                return { deleted: 12, done: true };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async abortTopologyOperation() {
                timeline.push("catalog-abort");
                return { status: "aborted" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);

        await expect(resharder.abort(split.migId)).resolves.toBeUndefined();
        await expect(resharder.runSplit(split.migId)).rejects.toThrow("injected destination cleanup crash");
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.ABORTING);
        expect(timeline).toEqual([
            "catalog-abort",
            "source-cleanup",
            "dest-fence",
            "dest-batch",
            "catalog-abort",
            "source-cleanup",
            "dest-fence",
            "dest-crash",
        ]);

        await expect(resharder.runSplit(split.migId)).resolves.toEqual({ phase: RESHARDER_PHASE.ABORTED });
        expect(timeline).toEqual([
            "catalog-abort",
            "source-cleanup",
            "dest-fence",
            "dest-batch",
            "catalog-abort",
            "source-cleanup",
            "dest-fence",
            "dest-crash",
            "catalog-abort",
            "source-cleanup",
            "dest-fence",
            "dest-done",
        ]);
        const expectedIdentity = stableJson({
            migId: split.migId,
            recoveryGeneration: 0,
            rangeLo: split.rangeLo,
            rangeHi: split.rangeHi,
            ...topologySchema,
            tables: [auditTable, table],
        });
        expect(stableJson(identities[0])).toBe(expectedIdentity);
        expect(
            identities.slice(1).every(input => {
                const {
                    batchSize: _,
                    destinationGeneration: _generation,
                    ...identity
                } = input as Record<string, unknown>;
                return stableJson(identity) === expectedIdentity;
            })
        ).toBe(true);
    });

    test("an in-flight INIT driver cannot resume movement after abort becomes durable", async () => {
        let releaseProvision!: () => void;
        let provisionStarted!: () => void;
        const provisionGate = new Promise<void>(resolve => {
            releaseProvision = resolve;
        });
        const started = new Promise<void>(resolve => {
            provisionStarted = resolve;
        });
        let destinationBegins = 0;
        let sourceBegins = 0;
        const source = {
            ...emptyTailSource,
            async beginReshardSource() {
                sourceBegins++;
                return { enabled: true, triggersInstalled: 0 };
            },
            async abortReshardSource() {},
        };
        const destination = {
            ...emptyStagingDestination,
            async provisionFreshReshardDestination() {
                provisionStarted();
                await provisionGate;
            },
            async beginReshardDest() {
                destinationBegins++;
                return { ready: true };
            },
            async beginReshardDestAbort() {
                return { started: true };
            },
            async abortReshardDestBatch() {
                return { deleted: 0, done: true };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async abortTopologyOperation() {
                return { status: "aborted" as const };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);

        const run = resharder.runSplit(split.migId);
        await started;
        await resharder.abort(split.migId);
        releaseProvision();
        await expect(run).rejects.toMatchObject({ code: "CDB_RESHARD_PHASE_MISMATCH" });
        expect(destinationBegins).toBe(0);
        expect(sourceBegins).toBe(0);
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.ABORTED);
    });

    test("split-oplog acknowledgement resumes from the durable cursor after response loss and eviction", async () => {
        const acknowledgements: number[] = [];
        let ackCalls = 0;
        const source = {
            ...emptyTailSource,
            async beginReshardSource() {
                return { enabled: true, triggersInstalled: 0 };
            },
            async readSplitOpLogBatch(args: { afterLsn: number }) {
                if (args.afterLsn > 0) return { entries: [], lastLsn: args.afterLsn, done: true };
                return { entries: [{ lsn: 7, oplogRow: new Uint8Array([1]) }], lastLsn: 7, done: true };
            },
            async ackSplitOpLog(args: { throughLsn: number }) {
                acknowledgements.push(args.throughLsn);
                ackCalls++;
                if (ackCalls === 1) throw new Error("lost split-oplog ack response");
                throw new Error("evicted driver resumed acknowledgement");
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async applySplitOpLogBatch(args: { entries: readonly { lsn: number }[] }) {
                return { applied: 1, replayed: 0, lastLsn: args.entries.at(-1)?.lsn ?? 0 };
            },
        };
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => ({
                async beginTopologyOperation() {
                    return { status: "active" as const, ...topologySchema };
                },
            }),
        } as unknown as DurableObjectNamespace;
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const env = { CDB_SHARD: shardNamespace, CDB_CATALOG: catalogNamespace };
        const first = new Resharder(state(), env);
        await ready;
        await first.startSplit(split);
        db.query("UPDATE migration_file_cursor SET enabled = 0, prepare_done = 1 WHERE mig_id = ?").run(split.migId);
        db.query("UPDATE migration_vector_cursor SET enabled = 0, copy_done = 1 WHERE mig_id = ?").run(split.migId);
        await first.advance(split.migId, RESHARDER_PHASE.INIT);

        await expect(driveUntilFailure(first, split.migId)).rejects.toThrow("lost split-oplog ack response");
        expect(db.query("SELECT source_lsn FROM migration_oplog_cursor WHERE mig_id = ?").get(split.migId)).toEqual({
            source_lsn: 7,
        });
        const reconstructed = new Resharder(state(), env);
        await ready;
        await expect(driveUntilFailure(reconstructed, split.migId)).rejects.toThrow(
            "evicted driver resumed acknowledgement"
        );
        expect(acknowledgements).toEqual([7, 7]);
    });

    test("long bulk copy drains mutation outcomes between pages without applying an unsafe child tail early", async () => {
        let bulkPages = 0;
        let nextOutcome = 1;
        let tailReads = 0;
        let childStaged = false;
        let childApplied = 0;
        let stageBackpressured = false;
        const acknowledged: number[] = [];
        const source = {
            ...emptyTailSource,
            async beginReshardSource() {
                return { enabled: true, triggersInstalled: 0 };
            },
            async readSplitOpLogBatch(args: { afterLsn: number }) {
                const available = bulkPages + 1;
                if (nextOutcome <= available) {
                    const lsn = nextOutcome++;
                    return { entries: [{ lsn, oplogRow: new Uint8Array([lsn]) }], lastLsn: lsn, done: true };
                }
                return { entries: [], lastLsn: args.afterLsn, done: true };
            },
            async ackSplitOpLog(args: { throughLsn: number }) {
                acknowledged.push(args.throughLsn);
                return { pruned: 1, prunedBytes: 1, ackedLsn: args.throughLsn };
            },
            async bulkCopyBatch(args: { afterRowid: number }) {
                bulkPages++;
                return { rows: [], lastRowid: args.afterRowid + 1, done: args.afterRowid >= 2 };
            },
            async readTailBatch(args: { afterLsn: number }) {
                tailReads++;
                if (args.afterLsn > 0) return { transactions: [], lastLsn: args.afterLsn, done: true };
                const entry = {
                    source_tx_id: 99,
                    lsn: 1,
                    op: "ins" as const,
                    table_name: table.name,
                    pk: "org-1",
                    before: null,
                    after: '{"id":"child","organization_id":"org-1","body":"parent-on-later-page"}',
                };
                return {
                    transactions: [{ sourceTxId: 99, firstLsn: 1, lastLsn: 1, entries: [entry] }],
                    lastLsn: 1,
                    done: true,
                };
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async stageTailBatch(args: { transactions: readonly { lastLsn: number }[] }) {
                if (!stageBackpressured) {
                    stageBackpressured = true;
                    throw new CdbError({ code: "CDB_RATE_LIMITED", message: "staged inbox is full" });
                }
                childStaged = true;
                return { staged: 1, lastLsn: args.transactions.at(-1)?.lastLsn ?? 0 };
            },
            async readStagedTailBatch() {
                if (!childStaged) return { transactions: [] };
                childStaged = false;
                return {
                    transactions: [
                        {
                            sourceTxId: 99,
                            firstLsn: 1,
                            lastLsn: 1,
                            entries: [
                                {
                                    source_tx_id: 99,
                                    lsn: 1,
                                    op: "ins" as const,
                                    table_name: table.name,
                                    pk: "org-1",
                                    before: null,
                                    after: '{"id":"child","organization_id":"org-1","body":"parent-on-later-page"}',
                                },
                            ],
                        },
                    ],
                };
            },
            async applyTailBatch() {
                expect(bulkPages).toBe(6);
                childApplied++;
                return { applied: 1, lastLsn: 1 };
            },
            async applySplitOpLogBatch(args: { entries: readonly { lsn: number }[] }) {
                return { applied: 1, replayed: 0, lastLsn: args.entries.at(-1)?.lsn ?? 0 };
            },
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async closeReshardBulkDest() {
                return { closed: true };
            },
            async closeTailStaging() {
                throw new Error("staged child applied after bulk close");
            },
        };
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => ({
                async beginTopologyOperation() {
                    return { status: "active" as const, ...topologySchema };
                },
            }),
        } as unknown as DurableObjectNamespace;
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), { CDB_SHARD: shardNamespace, CDB_CATALOG: catalogNamespace });
        await ready;
        await resharder.startSplit(split);
        db.query("UPDATE migration_file_cursor SET enabled = 0, prepare_done = 1 WHERE mig_id = ?").run(split.migId);
        db.query("UPDATE migration_vector_cursor SET enabled = 0, copy_done = 1 WHERE mig_id = ?").run(split.migId);
        await resharder.advance(split.migId, RESHARDER_PHASE.INIT);

        await expect(driveUntilFailure(resharder, split.migId)).rejects.toThrow(
            "staged child applied after bulk close"
        );
        expect({ bulkPages, childApplied, stageBackpressured }).toEqual({
            bulkPages: 6,
            childApplied: 1,
            stageBackpressured: true,
        });
        expect(tailReads).toBeGreaterThanOrEqual(bulkPages + 1);
        expect(new Set(acknowledged)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    });

    test("a capped tail backlog remains before cutover and fails retryably", async () => {
        let tailReads = 0;
        let loseAckResponse = true;
        const acknowledged: number[] = [];
        let cutovers = 0;
        let drops = 0;
        const source = {
            ...emptyTailSource,
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async beginReshardSource() {
                return { enabled: true, triggersInstalled: 3 };
            },
            async bulkCopyBatch() {
                return { rows: [], lastRowid: 0, done: true };
            },
            async readTailBatch(args: { afterLsn: number }) {
                tailReads++;
                const lastLsn = args.afterLsn + 500;
                const entries = Array.from({ length: 500 }, (_, index) => ({
                    source_tx_id: tailReads,
                    lsn: args.afterLsn + index + 1,
                    op: "ins" as const,
                    table_name: table.name,
                    pk: "org-1",
                    before: null,
                    after: '{"id":"row","organization_id":"org-1","body":"body"}',
                }));
                return {
                    transactions: [
                        {
                            sourceTxId: tailReads,
                            firstLsn: args.afterLsn + 1,
                            lastLsn,
                            entries,
                        },
                    ],
                    lastLsn,
                    done: false,
                };
            },
            async readSplitOpLogBatch() {
                return { entries: [], lastLsn: 0, done: true };
            },
            async ackTail(args: { throughLsn: number }) {
                acknowledged.push(args.throughLsn);
                if (loseAckResponse) {
                    loseAckResponse = false;
                    throw new Error("injected lost tail-ack response");
                }
                return { pruned: 500, ackedLsn: args.throughLsn };
            },
            async dropMigratedRange() {
                drops++;
                return { deleted: 0, done: true };
            },
            async finishReshardSource() {},
        };
        const destination = {
            ...emptyStagingDestination,
            async provisionFreshReshardDestination() {},
            async beginReshardDest() {
                return { ready: true };
            },
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async applyBulkBatch() {
                return { applied: 0, skipped: 0 };
            },
            async closeReshardBulkDest() {
                return { closed: true };
            },
            async applyTailBatch(args: { transactions: readonly { lastLsn: number; entries: readonly unknown[] }[] }) {
                return {
                    applied: args.transactions.reduce((count, transaction) => count + transaction.entries.length, 0),
                    lastLsn: args.transactions.at(-1)?.lastLsn ?? 0,
                };
            },
            async applySplitOpLogBatch() {
                return { applied: 0, replayed: 0, lastLsn: 0 };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
            async cutover() {
                cutovers++;
                return { applied: true, newEpoch: 8 };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);

        await expect(driveUntilFailure(resharder, split.migId)).rejects.toThrow("injected lost tail-ack response");
        expect(db.query("SELECT tail_cursor FROM migration_state WHERE mig_id = ?").get(split.migId)).toEqual({
            tail_cursor: 500,
        });

        for (let step = 0; step < 40; step++) await resharder.runSplit(split.migId);
        expect(tailReads).toBeGreaterThan(8);
        expect(acknowledged.slice(0, 2)).toEqual([500, 500]);
        expect(cutovers).toBe(0);
        expect(drops).toBe(0);
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.BULK_COPY_DONE);
        expect(
            (
                db.query("SELECT tail_cursor FROM migration_state WHERE mig_id = ?").get(split.migId) as {
                    tail_cursor: number;
                }
            ).tail_cursor
        ).toBeGreaterThan(4_000);
    });

    test("rejects an unbound source tail table before destination apply or cursor advance", async () => {
        let destinationApplies = 0;
        const source = {
            ...emptyTailSource,
            async reshardTableOrder(args: { tables: readonly { name: string }[] }) {
                return { tableNames: args.tables.map(item => item.name) };
            },
            async beginReshardSource() {
                return { enabled: true, triggersInstalled: 6 };
            },
            async bulkCopyBatch(args: { afterRowid: number }) {
                return { rows: [], lastRowid: args.afterRowid, done: true };
            },
            async readTailBatch() {
                const entry = {
                    source_tx_id: 1,
                    lsn: 1,
                    op: "ins" as const,
                    table_name: "unregistered_rows",
                    pk: "org-1",
                    before: null,
                    after: JSON.stringify({ id: "row-1", organization_id: "org-1" }),
                };
                return {
                    transactions: [
                        {
                            sourceTxId: 1,
                            firstLsn: 1,
                            lastLsn: 1,
                            entries: [entry],
                        },
                    ],
                    lastLsn: 1,
                    done: true,
                };
            },
            async readSplitOpLogBatch() {
                return { entries: [], lastLsn: 0, done: true };
            },
        };
        const destination = {
            ...emptyStagingDestination,
            async provisionFreshReshardDestination() {},
            async beginReshardDest() {
                return { ready: true };
            },
            async reshardTableOrder() {
                return { tableNames: [auditTable.name, table.name] };
            },
            async applyBulkBatch() {
                return { applied: 0, skipped: 0 };
            },
            async closeReshardBulkDest() {
                return { closed: true };
            },
            async applyTailBatch() {
                destinationApplies++;
                return { applied: 1, lastLsn: 1 };
            },
            async applySplitOpLogBatch() {
                return { applied: 0, replayed: 0, lastLsn: 0 };
            },
        };
        const catalog = {
            async beginTopologyOperation() {
                return { status: "active" as const, ...topologySchema };
            },
        };
        const shardNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: (id: { name: string }) => (id.name === split.srcShard ? source : destination),
        } as unknown as DurableObjectNamespace;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            idFromString: (name: string) => ({ name }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const resharder = new Resharder(state(), {
            CDB_SHARD: shardNamespace,
            CDB_CATALOG: catalogNamespace,
        });
        await ready;
        await resharder.startSplit(split);

        await expect(driveUntilFailure(resharder, split.migId)).rejects.toThrow(
            "reshard tail names unknown table unregistered_rows"
        );
        expect(destinationApplies).toBe(0);
        expect(db.query("SELECT tail_cursor FROM migration_state WHERE mig_id = ?").get(split.migId)).toEqual({
            tail_cursor: 0,
        });
        await expect(resharder.getPhase(split.migId)).resolves.toBe(RESHARDER_PHASE.TAIL_CAPTURE_ENABLED);
    });
});
