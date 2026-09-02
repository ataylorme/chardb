import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { OP_LOG_DDL, SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../../src/server/do/cdb-routing-fence-store.ts";
import {
    CdbVectorOrganizationDeletionStore,
    initializeCdbVectorOrganizationDeletionStore,
} from "../../src/server/do/cdb-vector-organization-deletion-store.ts";
import {
    CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
    CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS,
    CdbVectorOutboxStore,
    initializeCdbVectorOutboxStore,
} from "../../src/server/do/cdb-vector-outbox-store.ts";
import { CDB_VECTOR_DELIVERY_SETTLEMENT_MS, CdbVectorRuntime } from "../../src/server/do/cdb-vector-runtime.ts";
import {
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizeResourceFilter,
} from "../../src/server/do/cdb-vectorize-wire.ts";
import {
    initializeExternalReshardCapture,
    withExternalReshardCapture,
} from "../../src/server/external-reshard-capture.ts";
import type { VectorResourceV1 } from "../../src/server/resource-descriptors.ts";
import { cdbVectorResourceId } from "../../src/server/resource-descriptors.ts";
import { renderVectorReshardTriggers } from "../../src/server/vector-reshard-triggers.ts";
import { vshardOf } from "../../src/vshard.ts";

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

function syncSql(db: Database): SyncSql {
    return {
        exec(query, ...params) {
            db.run(query, params as never[]);
        },
        one<T>(query: string, ...params: never[]): T | null {
            return (db.query(query).get(...params) as T | null) ?? null;
        },
        all<T>(query: string, ...params: never[]): T[] {
            return db.query(query).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS count").get() as { count: number }).count);
        },
    };
}

function initializeVectorStore(db: Database, sql: SyncSql): void {
    db.exec(SPLIT_LOG_DDL);
    db.exec(CDB_ROUTING_FENCE_STORE_DDL);
    initializeCdbVectorOutboxStore(sql);
}

const RESOURCE: VectorResourceV1 = Object.freeze({
    kind: "vector",
    version: 1,
    table: "runtime_messages",
    column: "embedding",
    primaryKey: "id",
    organizationColumn: "organization_id",
    binding: "CDB_MESSAGES",
    dimensions: 3,
    metric: "cosine",
});

const VECTOR_RUNTIME = `vec1_${"a".repeat(64)}`;
const VECTOR_STALE = `vec1_${"b".repeat(64)}`;
const VECTOR_DELETE = `vec1_${"c".repeat(64)}`;

function captureWithoutTriggers<T>(_sql: SyncSql, _placementVshard: number, callback: () => T): T {
    return callback();
}

function enableVectorCapture(db: Database, organizationId: string, migId: string) {
    const placementVshard = Number(vshardOf([organizationId]));
    db.run(
        `INSERT INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
         VALUES (?, ?, ?, 'source', 1, 1)`,
        [migId, placementVshard, placementVshard]
    );
    for (const statement of renderVectorReshardTriggers(migId).install) db.run(statement);
    return <T>(captureSql: SyncSql, expectedPlacement: number, callback: () => T): T => {
        if (expectedPlacement !== placementVshard) throw new Error("runtime selected the wrong capture placement");
        return withExternalReshardCapture(captureSql, expectedPlacement, callback);
    };
}

function capturedTransactionIds(db: Database): number[] {
    return (
        db.query("SELECT DISTINCT source_tx_id FROM _chardb_split_log ORDER BY source_tx_id DESC").all() as Array<{
            source_tx_id: number;
        }>
    ).map(row => row.source_tx_id);
}

function acknowledgeStagedUpsert(store: CdbVectorOutboxStore, nowMs: number, token: string): void {
    const claim = store.claimNext({
        nowMs,
        leaseMs: 30_000,
        settlementMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
        claimToken: token,
    });
    if (!claim || claim.operation !== "upsert") throw new Error("test setup did not claim an upsert");
    store.acknowledgeUpsert(claim, nowMs);
}

describe("Cdb vector alarm delivery", () => {
    const databases: Database[] = [];
    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("persists V2 acceptance across reconstruction and waits for exact visibility before ready", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const head = new CdbVectorOutboxStore(sql).stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId: "org_runtime",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-1",
            dimensions: 3,
            values: [0.25, -0.5, 1],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        let nowMs = 0;
        let remote: unknown[] = [];
        const invalidations: string[] = [];
        const index = {
            upsert: () => ({ mutationId: "mutation-visible-1" }),
            deleteByIds: () => ({ mutationId: "unused" }),
            getByIds: () => remote,
        };
        const runtime = () =>
            new CdbVectorRuntime({
                storage,
                resources: () => [RESOURCE],
                resolveIndex: () => index,
                assertDeliveryAdmission: () => {},
                captureDeliveryTransaction: captureWithoutTriggers,
                onDeliverySettled: claim => {
                    invalidations.push(claim.vectorId);
                    return false;
                },
                nowMs: () => nowMs,
                scheduleAlarmNoLaterThan: async () => {},
            });

        await runtime().maintain();
        expect(new CdbVectorOutboxStore(sql).read(VECTOR_RUNTIME)).toMatchObject({
            state: "pending",
            deliveredVersion: 0,
        });
        expect(db.query("SELECT phase, mutation_id FROM _chardb_vector_outbox").get()).toEqual({
            phase: "verify",
            mutation_id: "mutation-visible-1",
        });
        expect(invalidations).toEqual([]);

        nowMs = 1_000;
        await runtime().maintain();
        expect(new CdbVectorOutboxStore(sql).read(VECTOR_RUNTIME)).toMatchObject({ state: "pending" });
        remote = [
            {
                id: cdbVectorizePhysicalId(VECTOR_RUNTIME, 1),
                namespace: cdbVectorizeOrganizationNamespace("org_runtime"),
                values: [0.25, -0.5, 1],
                metadata: { cdb_resource: cdbVectorizeResourceFilter(cdbVectorResourceId(RESOURCE)) },
            },
        ];
        nowMs = 2_000;
        await runtime().maintain();
        expect(new CdbVectorOutboxStore(sql).read(VECTOR_RUNTIME)).toMatchObject({
            state: "ready",
            deliveredVersion: 1,
        });
        expect(invalidations).toEqual([VECTOR_RUNTIME]);
    });

    test("captures submit, acceptance, verify retry, and acknowledgement as exact alarm transactions", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(OP_LOG_DDL);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeExternalReshardCapture(sql);
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_capture";
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-captured",
            dimensions: 3,
            values: [0.25, -0.5, 1],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const captureDeliveryTransaction = enableVectorCapture(db, organizationId, "runtime-capture");
        const storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        let nowMs = 0;
        let remote: unknown[] = [];
        const runtime = new CdbVectorRuntime({
            storage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => ({ mutationId: "mutation-captured" }),
                deleteByIds: () => ({ mutationId: "unused" }),
                getByIds: () => remote,
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction,
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async () => {},
        });

        await runtime.maintain();
        nowMs = 1_000;
        await runtime.maintain();
        remote = [
            {
                id: cdbVectorizePhysicalId(VECTOR_RUNTIME, 1),
                namespace: cdbVectorizeOrganizationNamespace(organizationId),
                values: [0.25, -0.5, 1],
                metadata: { cdb_resource: cdbVectorizeResourceFilter(cdbVectorResourceId(RESOURCE)) },
            },
        ];
        nowMs = 2_000;
        await runtime.maintain();

        expect(store.read(VECTOR_RUNTIME)).toMatchObject({ state: "ready", deliveredVersion: 1 });
        expect(capturedTransactionIds(db)).toEqual([-1, -2, -3, -4, -5, -6]);
        const rows = db
            .query("SELECT source_tx_id, table_name, op FROM _chardb_split_log ORDER BY lsn")
            .all() as Array<{ source_tx_id: number; table_name: string; op: string }>;
        expect(rows.filter(row => row.source_tx_id === -1).map(row => [row.table_name, row.op])).toEqual([
            ["_chardb_vector_outbox", "upd"],
            ["_chardb_vector_attempts", "ins"],
        ]);
        expect(rows.filter(row => row.source_tx_id === -4).map(row => [row.table_name, row.op])).toEqual([
            ["_chardb_vector_outbox", "upd"],
        ]);
        expect(rows.filter(row => row.source_tx_id === -6).map(row => [row.table_name, row.op])).toEqual([
            ["_chardb_vectors", "upd"],
            ["_chardb_vector_attempts", "upd"],
            ["_chardb_vector_outbox", "del"],
        ]);
        expect(db.query("SELECT active_id, active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
            active_id: null,
            active_vshard: null,
        });
    });

    test("captures an ambiguous submit failure and releases its claim in a second transaction", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(OP_LOG_DDL);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeExternalReshardCapture(sql);
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_failure";
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-failure",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const alarms: number[] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => {
                    throw new Error("response lost");
                },
                deleteByIds: () => ({ count: 0, ids: [] }),
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: enableVectorCapture(db, organizationId, "runtime-failure"),
            nowMs: () => 0,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });

        await runtime.maintain();

        expect(capturedTransactionIds(db)).toEqual([-1, -2]);
        expect(
            db.query("SELECT response_ambiguous FROM _chardb_vector_attempts WHERE vector_id = ?").get(head.vectorId)
        ).toEqual({ response_ambiguous: 1 });
        expect(
            db
                .query(
                    "SELECT attempts, leased_until, lease_token, next_attempt_at, last_error FROM _chardb_vector_outbox"
                )
                .get()
        ).toEqual({
            attempts: 1,
            leased_until: null,
            lease_token: null,
            next_attempt_at: 1_000,
            last_error: "response lost",
        });
        expect(alarms).toContain(30_000);
        expect(alarms).toContain(1_000);
    });

    test("rearms after a non-stale capture invariant before the claim writes", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(OP_LOG_DDL);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeExternalReshardCapture(sql);
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_invariant";
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-invariant",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        enableVectorCapture(db, organizationId, "runtime-invariant");
        const alarms: number[] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                deleteByIds: ids => ({ count: ids.length, ids }),
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: () => {
                throw new CdbError({ code: "CDB_INVARIANT", message: "capture identity unavailable" });
            },
            nowMs: () => 0,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });

        await expect(runtime.maintain()).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        expect(alarms).toEqual([1_000]);
        expect(db.query("SELECT attempts, leased_until, lease_token FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 0,
            leased_until: null,
            lease_token: null,
        });
        expect(db.query("SELECT * FROM _chardb_split_log").all()).toEqual([]);
    });

    test("rearms when both acknowledgement capture and failure settlement reject", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(OP_LOG_DDL);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeExternalReshardCapture(sql);
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_settlement_invariant";
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-settlement-invariant",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const capture = enableVectorCapture(db, organizationId, "runtime-settlement-invariant");
        let captureCalls = 0;
        const alarms: number[] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                deleteByIds: ids => ({ count: ids.length, ids }),
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: (captureSql, placement, callback) => {
                captureCalls++;
                if (captureCalls === 2) {
                    throw new CdbError({ code: "CDB_INVARIANT", message: "acknowledgement capture failed" });
                }
                if (captureCalls === 3) {
                    throw new CdbError({ code: "CDB_INVARIANT", message: "failure capture failed" });
                }
                return capture(captureSql, placement, callback);
            },
            nowMs: () => 0,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });

        await expect(runtime.maintain()).rejects.toThrow("failure capture failed");
        expect(captureCalls).toBe(3);
        expect(alarms).toContain(30_000);
        expect(alarms).toContain(1_000);
        expect(capturedTransactionIds(db)).toEqual([-1]);
        expect(db.query("SELECT attempts, leased_until FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 1,
            leased_until: 30_000,
        });
    });

    test("rejects a changed scheduled placement before the first claim write", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId: "org_expected_placement",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-expected-placement",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        const selected = store.nextClaimPlacement(0);
        expect(selected).toBe(head.placementVshard);
        const wrongPlacement = ((selected as number) + 1) % 16_384;

        expect(() =>
            store.claimNext({
                nowMs: 0,
                leaseMs: 30_000,
                settlementMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
                claimToken: "wrong_placement_01",
                expectedPlacementVshard: wrongPlacement,
            })
        ).toThrow("scheduled vshard changed before capture");
        expect(db.query("SELECT attempts, leased_until, lease_token FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 0,
            leased_until: null,
            lease_token: null,
        });
        expect(db.query("SELECT * FROM _chardb_vector_attempts").all()).toEqual([]);
    });

    test("captures accepted cleanup through verification and removes only the superseded attempt", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(OP_LOG_DDL);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeExternalReshardCapture(sql);
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_cleanup";
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-cleanup",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "setup_claim_v1_0001");
        store.stageUpsert({
            vectorId: head.vectorId,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: head.rowPk,
            dimensions: 3,
            values: [3, 2, 1],
            metadata: {},
            nowMs: 1,
        });
        acknowledgeStagedUpsert(store, 1, "setup_claim_v2_0002");
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                deleteByIds: () => ({ mutationId: "cleanup-accepted" }),
                getByIds: () => [],
                describe: () => ({ processedUpToMutation: "cleanup-accepted" }),
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: enableVectorCapture(db, organizationId, "runtime-cleanup"),
            nowMs: () => currentTime,
            scheduleAlarmNoLaterThan: async () => {},
        });
        let currentTime = CDB_VECTOR_DELIVERY_SETTLEMENT_MS;

        await runtime.maintain();
        currentTime += 1_000;
        await runtime.maintain();

        expect(store.read(head.vectorId)).toMatchObject({ version: 2, deliveredVersion: 2, state: "ready" });
        expect(
            db.query("SELECT physical_version FROM _chardb_vector_attempts ORDER BY physical_version").all()
        ).toEqual([{ physical_version: 2 }]);
        expect(db.query("SELECT * FROM _chardb_vector_outbox").all()).toEqual([]);
        expect(capturedTransactionIds(db)).toEqual([-1, -2, -3, -4, -5]);
        expect(
            db.query("SELECT table_name, op FROM _chardb_split_log WHERE source_tx_id = -4 ORDER BY lsn").all()
        ).toEqual([{ table_name: "_chardb_vector_attempts", op: "upd" }]);
        const finalRows = db
            .query("SELECT table_name, op FROM _chardb_split_log WHERE source_tx_id = -5 ORDER BY lsn")
            .all();
        expect(finalRows).toEqual([
            { table_name: "_chardb_vector_attempts", op: "del" },
            { table_name: "_chardb_vector_outbox", op: "del" },
        ]);
    });

    test("captures accepted logical deletion through the final head cascade", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(OP_LOG_DDL);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeExternalReshardCapture(sql);
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_final_delete";
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-final-delete",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "setup_delete_v1_01");
        store.stageDelete({ vectorId: head.vectorId, organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        let currentTime = CDB_VECTOR_DELIVERY_SETTLEMENT_MS;
        const settlements: string[] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                deleteByIds: () => ({ mutationId: "delete-accepted" }),
                getByIds: () => [],
                describe: () => ({ processedUpToMutation: "delete-accepted" }),
            }),
            assertDeliveryAdmission: () => {},
            onDeliverySettled: (claim, outcome) => {
                settlements.push(`${claim.vectorId}:${outcome}`);
                return false;
            },
            captureDeliveryTransaction: enableVectorCapture(db, organizationId, "runtime-final-delete"),
            nowMs: () => currentTime,
            scheduleAlarmNoLaterThan: async () => {},
        });

        await runtime.maintain();
        currentTime += 1_000;
        await runtime.maintain();

        expect(store.read(head.vectorId)).toBeNull();
        expect(db.query("SELECT * FROM _chardb_vector_attempts").all()).toEqual([]);
        expect(db.query("SELECT * FROM _chardb_vector_outbox").all()).toEqual([]);
        expect(settlements).toEqual([`${head.vectorId}:deleted`]);
        expect(capturedTransactionIds(db)).toEqual([-1, -2, -3, -4, -5]);
        expect(
            db.query("SELECT table_name, op FROM _chardb_split_log WHERE source_tx_id = -4 ORDER BY lsn").all()
        ).toEqual([{ table_name: "_chardb_vector_attempts", op: "upd" }]);
        const finalRows = db
            .query("SELECT table_name, op FROM _chardb_split_log WHERE source_tx_id = -5 ORDER BY lsn")
            .all() as Array<{ table_name: string; op: string }>;
        expect(finalRows.at(-1)).toEqual({ table_name: "_chardb_vectors", op: "del" });
        expect(finalRows.map(row => [row.table_name, row.op])).toContainEqual(["_chardb_vector_attempts", "del"]);
        expect(finalRows.map(row => [row.table_name, row.op])).toContainEqual(["_chardb_vector_outbox", "del"]);
    });

    test("settles a synchronously processed delete even when an older attempt was ambiguous", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId: "org_runtime_processed_delete",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-processed-delete",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "processed_delete_upsert_01");
        db.run("UPDATE _chardb_vector_attempts SET response_ambiguous = 1 WHERE vector_id = ?", [head.vectorId]);
        store.stageDelete({ vectorId: head.vectorId, organizationId: head.organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        let unprovenTurns = 0;
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                deleteByIds: ids => ({ count: ids.length, ids }),
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            recordOrganizationUnprovenDeleteTurn: () => ({ turns: ++unprovenTurns, terminal: true }),
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
            scheduleAlarmNoLaterThan: async () => {},
        });

        await runtime.maintain();

        expect(unprovenTurns).toBe(0);
        expect(store.read(head.vectorId)).toBeNull();
        expect(store.readDeliveryStatus(head.vectorId)).toBeNull();
    });

    test("persists exact delete proof before retrying failed local settlement", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId: "org_runtime_local_settlement",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-local-settlement",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "local_settlement_upsert_01");
        store.stageDelete({ vectorId: head.vectorId, organizationId: head.organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        let nowMs = CDB_VECTOR_DELIVERY_SETTLEMENT_MS;
        let settlementCalls = 0;
        let unprovenTurns = 0;
        let describeCalls = 0;
        let resolveCalls = 0;
        let processedWatermark = "local-settlement-delete";
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => {
                resolveCalls++;
                return {
                    upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                    deleteByIds: () => ({ mutationId: "local-settlement-delete" }),
                    describe: () => {
                        describeCalls++;
                        return { processedUpToMutation: processedWatermark };
                    },
                    getByIds: () => [],
                };
            },
            assertDeliveryAdmission: () => {},
            recordOrganizationUnprovenDeleteTurn: () => ({ turns: ++unprovenTurns, terminal: true }),
            onDeliverySettled: () => {
                settlementCalls++;
                if (settlementCalls === 1) throw new Error("local invalidation settlement failed");
                return false;
            },
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async () => {},
        });

        await runtime.maintain();
        nowMs += 1_000;
        await runtime.maintain();
        expect(unprovenTurns).toBe(0);
        expect(store.readDeliveryStatus(head.vectorId)).toEqual({
            state: "active",
            lastError: "local invalidation settlement failed",
        });
        expect(store.read(head.vectorId)).toMatchObject({ state: "deleting" });
        expect(db.query("SELECT delete_confirmed FROM _chardb_vector_attempts").all()).toEqual([
            { delete_confirmed: 1 },
        ]);
        expect(describeCalls).toBe(1);
        expect(resolveCalls).toBe(2);

        processedWatermark = "opaque-shared-index-mutation";
        nowMs = store.nextDueAt() ?? Number.NaN;
        await new CdbVectorRuntime(runtime.input).maintain();
        expect(unprovenTurns).toBe(0);
        expect(describeCalls).toBe(1);
        expect(resolveCalls).toBe(2);
        expect(settlementCalls).toBe(2);
        expect(store.read(head.vectorId)).toBeNull();
        expect(store.readDeliveryStatus(head.vectorId)).toBeNull();
    });

    test("terminates a clean accepted delete only after the poll bound and accepted settlement floor", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId: "org_runtime_poll_bound",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-poll-bound",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "poll_bound_upsert_01");
        store.stageDelete({ vectorId: head.vectorId, organizationId: head.organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        const submit = store.claimNext({
            nowMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
            leaseMs: 30_000,
            settlementMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
            claimToken: "poll_bound_delete_01",
        });
        if (!submit || submit.operation !== "delete") throw new Error("expected bounded delete submit");
        store.acceptSubmission(submit, "poll-bound-delete", CDB_VECTOR_DELIVERY_SETTLEMENT_MS, 121_000);
        db.run("UPDATE _chardb_vector_outbox SET attempts = ?", [CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS]);
        let nowMs = 240_000;
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => ({ mutationId: "unused" }),
                deleteByIds: () => ({ mutationId: "unused" }),
                getByIds: () => [],
                describe: () => ({ processedUpToMutation: "different-mutation" }),
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async () => {},
        });

        await runtime.maintain();

        expect(store.readDeliveryStatus(head.vectorId)).toEqual({
            state: "failed_unproven",
            lastError: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        expect(store.nextDueAt()).toBeNull();
        expect(store.read(head.vectorId)).toMatchObject({ state: "deleting" });
        nowMs = Number.MAX_SAFE_INTEGER - 100;
        await runtime.maintain();
        expect(store.readDeliveryStatus(head.vectorId)?.state).toBe("failed_unproven");
    });

    test("defers the verification poll bound until the accepted delete reaches its settlement deadline", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId: "org_runtime_settlement_floor",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-settlement-floor",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "settlement_floor_upsert_01");
        store.stageDelete({ vectorId: head.vectorId, organizationId: head.organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        const submit = store.claimNext({
            nowMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
            leaseMs: 30_000,
            settlementMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
            claimToken: "settlement_floor_delete_01",
        });
        if (!submit || submit.operation !== "delete") throw new Error("expected settlement-floor delete submit");
        store.acceptSubmission(submit, "settlement-floor-delete", CDB_VECTOR_DELIVERY_SETTLEMENT_MS, 121_000);
        const finalSettlementAt = 2 * CDB_VECTOR_DELIVERY_SETTLEMENT_MS;
        db.run("UPDATE _chardb_vector_outbox SET attempts = ?", [CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS]);
        let nowMs = 121_000;
        const alarms: number[] = [];
        let describeCalls = 0;
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => ({ mutationId: "unused" }),
                deleteByIds: () => ({ mutationId: "unused" }),
                getByIds: () => [],
                describe: () => {
                    describeCalls++;
                    return { processedUpToMutation: "different-mutation" };
                },
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });

        await runtime.maintain();

        expect(describeCalls).toBe(1);
        expect(store.readDeliveryStatus(head.vectorId)).toEqual({ state: "active", lastError: null });
        expect(store.nextDueAt()).toBe(finalSettlementAt);
        expect(db.query("SELECT attempts FROM _chardb_vector_outbox").get()).toEqual({ attempts: 33 });
        expect(alarms).toEqual([151_000, finalSettlementAt]);

        nowMs = finalSettlementAt;
        await runtime.maintain();

        expect(describeCalls).toBe(2);
        expect(store.readDeliveryStatus(head.vectorId)).toEqual({
            state: "failed_unproven",
            lastError: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        expect(store.nextDueAt()).toBeNull();
    });

    test("uses one tombstone-wide uncertainty budget for submit failures and verification waits", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeCdbVectorOrganizationDeletionStore(sql);
        const deletionStore = new CdbVectorOrganizationDeletionStore(sql, callback => db.transaction(callback)());
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_org_bound";
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-org-bound",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "org_bound_upsert_01");
        store.stageDelete({ vectorId: head.vectorId, organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        deletionStore.fenceOrganization({ organizationId, nowMs: 2 });
        db.run("UPDATE _chardb_deleted_organizations SET vector_unproven_turns = 31 WHERE organization_id = ?", [
            organizationId,
        ]);
        let nowMs = CDB_VECTOR_DELIVERY_SETTLEMENT_MS;
        const alarms: number[] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => ({ mutationId: "unused" }),
                deleteByIds: () => {
                    throw new Error("provider timeout");
                },
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            organizationDeleted: () => true,
            recordOrganizationUnprovenDeleteTurn: organization => deletionStore.recordUnprovenTurn(organization),
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });

        await runtime.maintain();

        expect(store.readDeliveryStatus(head.vectorId)).toEqual({
            state: "failed_unproven",
            lastError: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        expect(deletionStore.readPurgeStatus(organizationId)).toMatchObject({
            state: "failed_unproven",
            unprovenTurns: 32,
        });
        expect(alarms).toEqual([nowMs + 30_000]);
        nowMs += 1_000_000;
        await runtime.maintain();
        expect(alarms).toHaveLength(1);
    });

    test("does not confuse total outbox attempts with the organization uncertainty budget", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        initializeCdbVectorOrganizationDeletionStore(sql);
        const deletionStore = new CdbVectorOrganizationDeletionStore(sql, callback => db.transaction(callback)());
        const store = new CdbVectorOutboxStore(sql);
        const organizationId = "org_runtime_attempt_split";
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId,
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-attempt-split",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        acknowledgeStagedUpsert(store, 0, "attempt_split_upsert_01");
        store.stageDelete({ vectorId: head.vectorId, organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        deletionStore.fenceOrganization({ organizationId, nowMs: 2 });
        db.run("UPDATE _chardb_vector_outbox SET attempts = 100 WHERE vector_id = ?", [head.vectorId]);
        let nowMs = CDB_VECTOR_DELIVERY_SETTLEMENT_MS;
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => ({ mutationId: "unused" }),
                deleteByIds: () => ({ mutationId: "attempt-split-delete" }),
                describe: () => ({ processedUpToMutation: "earlier-mutation" }),
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            organizationDeleted: () => true,
            recordOrganizationUnprovenDeleteTurn: organization => deletionStore.recordUnprovenTurn(organization),
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async () => {},
        });

        await runtime.maintain();
        nowMs += 1_000;
        await runtime.maintain();

        expect(store.readDeliveryStatus(head.vectorId)).toEqual({ state: "active", lastError: null });
        expect(deletionStore.readPurgeStatus(organizationId)).toMatchObject({
            state: "pending",
            unprovenTurns: 0,
        });
        expect(db.query("SELECT attempts, next_attempt_at, terminal_failure FROM _chardb_vector_outbox").get()).toEqual(
            {
                attempts: 102,
                next_attempt_at: 2 * CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
                terminal_failure: 0,
            }
        );

        nowMs = 2 * CDB_VECTOR_DELIVERY_SETTLEMENT_MS;
        await runtime.maintain();

        expect(deletionStore.readPurgeStatus(organizationId)).toMatchObject({
            state: "pending",
            unprovenTurns: 1,
        });
        expect(db.query("SELECT attempts, terminal_failure FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 103,
            terminal_failure: 0,
        });
    });

    test("repeats one physical id after response loss and validates ownership and row head again before ack", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const resourceId = cdbVectorResourceId(RESOURCE);
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId: "org_runtime",
            resourceId,
            rowPk: "message-1",
            dimensions: 3,
            values: [0.25, -0.5, 1],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        let nowMs = 0;
        let calls = 0;
        let invalidateBeforeAck = false;
        const physicalIds: string[] = [];
        const admissions: string[] = [];
        const alarms: number[] = [];
        const settlements: string[] = [];
        const runtime = new CdbVectorRuntime({
            storage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert(records) {
                    calls++;
                    physicalIds.push(...records.map(record => record.id));
                    if (calls === 1) throw new Error(`response lost ${"💣".repeat(500)}`);
                    if (invalidateBeforeAck) db.run("UPDATE runtime_messages SET embedding = NULL");
                    return { count: records.length, ids: records.map(record => record.id) };
                },
                deleteByIds(ids) {
                    return { count: ids.length, ids };
                },
                getByIds: () => [],
            }),
            assertDeliveryAdmission: claim => {
                admissions.push(`${claim.vectorId}:${claim.targetVersion}`);
            },
            captureDeliveryTransaction: captureWithoutTriggers,
            onDeliverySettled: (claim, outcome) => {
                settlements.push(`${claim.vectorId}:${claim.targetVersion}:${outcome}`);
                return true;
            },
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });

        await runtime.maintain();
        expect(store.read(head.vectorId)).toMatchObject({ state: "pending", deliveredVersion: 0 });
        expect(settlements).toEqual([]);
        expect(db.query("SELECT attempts, next_attempt_at, leased_until FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 1,
            next_attempt_at: 1_000,
            leased_until: null,
        });
        expect(
            (
                db.query("SELECT length(CAST(last_error AS BLOB)) AS bytes FROM _chardb_vector_outbox").get() as {
                    bytes: number;
                }
            ).bytes
        ).toBeLessThanOrEqual(1_024);

        nowMs = 1_000;
        invalidateBeforeAck = true;
        await expect(runtime.maintain()).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        expect(store.read(head.vectorId)).toMatchObject({ state: "pending", deliveredVersion: 0 });
        expect(settlements).toEqual([]);
        expect(db.query("SELECT attempts, next_attempt_at, leased_until FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 2,
            next_attempt_at: 1_000,
            leased_until: 31_000,
        });

        db.run("UPDATE runtime_messages SET embedding = ?", [head.vectorId]);
        nowMs = 31_000;
        invalidateBeforeAck = false;
        await runtime.maintain();
        expect(store.read(head.vectorId)).toMatchObject({ state: "ready", deliveredVersion: 1 });
        expect(physicalIds).toEqual([
            cdbVectorizePhysicalId(VECTOR_RUNTIME, 1),
            cdbVectorizePhysicalId(VECTOR_RUNTIME, 1),
            cdbVectorizePhysicalId(VECTOR_RUNTIME, 1),
        ]);
        expect(admissions).toHaveLength(10);
        expect(settlements).toEqual([`${VECTOR_RUNTIME}:1:ready`]);
        expect(Math.min(...alarms)).toBe(1_000);
    });

    test("bounds a hung Vectorize request by the exact durable claim lease", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId: "org_runtime",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-timeout",
            dimensions: 3,
            values: [0.25, -0.5, 1],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        const timeouts: { callback: () => void; milliseconds: number }[] = [];
        const cancelled: unknown[] = [];
        const alarms: number[] = [];
        const runtime = new CdbVectorRuntime({
            storage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => new Promise<never>(() => {}),
                deleteByIds: () => new Promise<never>(() => {}),
                getByIds: () => new Promise<never>(() => {}),
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => 0,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
            setTimeout: (callback, milliseconds) => {
                timeouts.push({ callback, milliseconds });
                return "vector-timeout";
            },
            clearTimeout: handle => {
                cancelled.push(handle);
            },
        });

        const maintaining = runtime.maintain();
        await Promise.resolve();
        expect(timeouts).toEqual([{ callback: expect.any(Function), milliseconds: 30_000 }]);
        timeouts[0]?.callback();
        await maintaining;

        expect(cancelled).toEqual(["vector-timeout"]);
        expect(alarms).toContain(30_000);
        expect(alarms).toContain(1_000);
        expect(
            db
                .query(
                    "SELECT attempts, next_attempt_at, leased_until, lease_token, last_error FROM _chardb_vector_outbox"
                )
                .get()
        ).toEqual({
            attempts: 1,
            next_attempt_at: 1_000,
            leased_until: null,
            lease_token: null,
            last_error: "vector delivery: external request exceeded its claim lease",
        });
    });

    test("does not start a Vectorize request after alarm scheduling consumes the lease", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const head = store.stageUpsert({
            vectorId: VECTOR_RUNTIME,
            organizationId: "org_runtime",
            resourceId: cdbVectorResourceId(RESOURCE),
            rowPk: "message-expired-before-call",
            dimensions: 3,
            values: [0.25, -0.5, 1],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        let nowMs = 0;
        let remoteCalls = 0;
        const runtime = new CdbVectorRuntime({
            storage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: () => {
                    remoteCalls++;
                    return { count: 1, ids: [] };
                },
                deleteByIds: () => {
                    remoteCalls++;
                    return { count: 0, ids: [] };
                },
                getByIds: () => {
                    remoteCalls++;
                    return [];
                },
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async deadline => {
                if (deadline === 30_000) nowMs = deadline;
            },
        });

        await runtime.maintain();

        expect(remoteCalls).toBe(0);
        expect(store.read(head.vectorId)).toMatchObject({ state: "pending", deliveredVersion: 0 });
        expect(db.query("SELECT leased_until, lease_token, last_error FROM _chardb_vector_outbox").get()).toEqual({
            leased_until: null,
            lease_token: null,
            last_error: "vector delivery: external request exceeded its claim lease",
        });
    });

    test("takes only one durable claim per alarm turn", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const resourceId = cdbVectorResourceId(RESOURCE);
        for (const suffix of ["a", "b"]) {
            const head = store.stageUpsert({
                vectorId: `vec1_${suffix.repeat(64)}`,
                organizationId: `org_${suffix}`,
                resourceId,
                rowPk: `message-${suffix}`,
                dimensions: 3,
                values: [1, 2, 3],
                metadata: {},
                nowMs: 0,
            });
            db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        }
        const delivered: string[] = [];
        const alarms: number[] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert(records) {
                    delivered.push(...records.map(record => record.id));
                    return { count: records.length, ids: records.map(record => record.id) };
                },
                deleteByIds: ids => ({ count: ids.length, ids }),
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => 0,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });
        await runtime.maintain();
        expect(delivered).toHaveLength(1);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_outbox").get()).toEqual({ count: 1 });
        expect(alarms).toContain(1);
    });

    test("rearms a rolled-back claim while schema or routing admission is temporarily stale", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const resourceId = cdbVectorResourceId(RESOURCE);
        const head = store.stageUpsert({
            vectorId: VECTOR_STALE,
            organizationId: "org_stale_admission",
            resourceId,
            rowPk: "message-stale-admission",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        const alarms: number[] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                deleteByIds: ids => ({ count: ids.length, ids }),
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration owns the shard" });
            },
            captureDeliveryTransaction: captureWithoutTriggers,
            nowMs: () => 0,
            scheduleAlarmNoLaterThan: async deadline => {
                alarms.push(deadline);
            },
        });

        await expect(runtime.maintain()).rejects.toMatchObject({ code: "CDB_STALE_EPOCH" });
        expect(alarms).toEqual([1_000]);
        expect(db.query("SELECT attempts, leased_until, lease_token FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 0,
            leased_until: null,
            lease_token: null,
        });
    });

    test("emits deletion invalidation only after the final attempted physical version settles", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("CREATE TABLE runtime_messages (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = syncSql(db);
        initializeVectorStore(db, sql);
        const store = new CdbVectorOutboxStore(sql);
        const resourceId = cdbVectorResourceId(RESOURCE);
        const head = store.stageUpsert({
            vectorId: VECTOR_DELETE,
            organizationId: "org_delete",
            resourceId,
            rowPk: "message-delete",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 0,
        });
        db.run("INSERT INTO runtime_messages VALUES (?, ?, ?)", [head.rowPk, head.organizationId, head.vectorId]);
        let nowMs = 0;
        const settlements: string[] = [];
        const deletedIds: string[][] = [];
        const runtime = new CdbVectorRuntime({
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            } as unknown as DurableObjectStorage,
            resources: () => [RESOURCE],
            resolveIndex: () => ({
                upsert: records => ({ count: records.length, ids: records.map(record => record.id) }),
                deleteByIds(ids) {
                    deletedIds.push([...ids]);
                    return { count: ids.length, ids };
                },
                getByIds: () => [],
            }),
            assertDeliveryAdmission: () => {},
            captureDeliveryTransaction: captureWithoutTriggers,
            onDeliverySettled: (claim, outcome) => {
                settlements.push(`${claim.targetVersion}:${outcome}`);
                return false;
            },
            nowMs: () => nowMs,
            scheduleAlarmNoLaterThan: async () => {},
        });

        await runtime.maintain();
        expect(settlements).toEqual(["1:ready"]);
        store.stageDelete({ vectorId: head.vectorId, organizationId: head.organizationId, nowMs: 1 });
        db.run("UPDATE runtime_messages SET embedding = NULL WHERE id = ?", [head.rowPk]);
        nowMs = CDB_VECTOR_DELIVERY_SETTLEMENT_MS - 1;
        await runtime.maintain();
        expect(settlements).toEqual(["1:ready"]);
        expect(store.read(head.vectorId)).toMatchObject({ state: "deleting" });

        nowMs = CDB_VECTOR_DELIVERY_SETTLEMENT_MS;
        await runtime.maintain();
        expect(deletedIds).toEqual([[cdbVectorizePhysicalId(head.vectorId, 1)]]);
        expect(settlements).toEqual(["1:ready", "2:deleted"]);
        expect(store.read(head.vectorId)).toBeNull();
    });
});
