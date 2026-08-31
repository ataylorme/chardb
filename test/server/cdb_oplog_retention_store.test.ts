import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SHARD_BOOTSTRAP_DDL } from "../../src/oplog/schema.ts";
import {
    CDB_OPLOG_RETENTION_BATCH,
    CDB_OPLOG_RETENTION_MS,
    CdbOpLogRetentionStore,
} from "../../src/server/do/cdb-oplog-retention-store.ts";

let db: Database;

beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SHARD_BOOTSTRAP_DDL);
});

afterEach(() => db.close());

function storage(): DurableObjectStorage {
    return {
        sql: {
            exec<T>(query: string, ...bindings: unknown[]) {
                const statement = db.prepare(query);
                const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
                const columnNames = [...statement.columnNames];
                const rawRows = rows.map(row => columnNames.map(column => row[column]));
                const rowsWritten = Number(
                    (db.query("SELECT changes() AS changes").get() as { changes: number }).changes
                );
                return {
                    columnNames,
                    rowsRead: rows.length,
                    rowsWritten,
                    raw: () => rawRows.values(),
                    *[Symbol.iterator]() {
                        yield* rows as T[];
                    },
                };
            },
        },
        transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
    } as unknown as DurableObjectStorage;
}

function insertOutcome(committedAt: number, placementVshard: number | null = 1): void {
    const next = Number(
        (db.query("SELECT COALESCE(MAX(event_id), 0) + 1 AS next FROM _chardb_op_log").get() as { next: number }).next
    );
    db.query(
        `INSERT INTO _chardb_op_log
         (principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
          touched_keys, byte_size, placement_vshard)
         VALUES (?, ?, ?, ?, ?, 1, '[]', 1, ?)`
    ).run(
        `principal-${next}`,
        `mutation-${next}`,
        new Uint8Array(32),
        new Uint8Array([1]),
        committedAt,
        placementVshard
    );
}

describe("Cdb op-log retention", () => {
    test("expires the exact 24-hour boundary and schedules the oldest retained outcome", () => {
        const now = CDB_OPLOG_RETENTION_MS * 2;
        insertOutcome(now - CDB_OPLOG_RETENTION_MS - 1, null);
        insertOutcome(now - CDB_OPLOG_RETENTION_MS, 2);
        insertOutcome(now - CDB_OPLOG_RETENTION_MS + 1, 3);

        const result = new CdbOpLogRetentionStore(storage()).maintain(now);

        expect(result).toEqual({ deleted: 2, blockedBySplit: false, nextAt: now + 1 });
        expect(db.query("SELECT committed_at FROM _chardb_op_log").all()).toEqual([
            { committed_at: now - CDB_OPLOG_RETENTION_MS + 1 },
        ]);
    });

    test("deletes one fixed batch and resumes immediately without an unbounded scan", () => {
        const now = CDB_OPLOG_RETENTION_MS * 2;
        for (let index = 0; index < CDB_OPLOG_RETENTION_BATCH + 7; index++) insertOutcome(index);
        const store = new CdbOpLogRetentionStore(storage());

        expect(store.maintain(now)).toEqual({
            deleted: CDB_OPLOG_RETENTION_BATCH,
            blockedBySplit: false,
            nextAt: now + 1,
        });
        expect(store.maintain(now + 1)).toMatchObject({ deleted: 7, blockedBySplit: false });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 0 });
    });

    test("preserves every outcome while a source or destination split is active", () => {
        const now = CDB_OPLOG_RETENTION_MS * 2;
        insertOutcome(0, null);
        for (const role of ["source", "dest"] as const) {
            db.query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, drained, updated_at)
                 VALUES (?, 0, 10, ?, ?, 0, ?)`
            ).run(`split-${role}`, role, role === "source" ? 1 : 0, now);
            expect(new CdbOpLogRetentionStore(storage()).maintain(now)).toEqual({
                deleted: 0,
                blockedBySplit: true,
                nextAt: null,
            });
            db.query("UPDATE _chardb_split_state SET drained = 1 WHERE mig_id = ?").run(`split-${role}`);
        }
        expect(new CdbOpLogRetentionStore(storage()).maintain(now)).toMatchObject({ deleted: 1 });
    });

    test("rejects malformed clocks before touching retained outcomes", () => {
        insertOutcome(0);
        const store = new CdbOpLogRetentionStore(storage());
        for (const now of [-1, Number.NaN, 1.5]) expect(() => store.maintain(now)).toThrow();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 1 });
    });
});
