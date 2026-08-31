import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SPLIT_LOG_ACCOUNTED_BYTES_SQL, SPLIT_LOG_DDL, initializeSplitLogAccounting } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";

function syncSql(db: Database): SyncSql {
    return {
        exec(statement, ...params) {
            db.run(statement, params as never[]);
        },
        one<T>(statement: string, ...params: never[]): T | null {
            return (db.query(statement).get(...params) as T | null) ?? null;
        },
        all<T>(statement: string, ...params: never[]): T[] {
            return db.query(statement).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS n").get() as { n: number }).n);
        },
    };
}

let db: Database;
afterEach(() => db?.close());

describe("split-log accounting upgrade", () => {
    test("rebuilds an idle positive-only inbox and then accepts negative file transaction ids", () => {
        db = new Database(":memory:");
        db.exec(
            SPLIT_LOG_DDL.replace(
                "source_tx_id INTEGER NOT NULL CHECK (source_tx_id != 0)",
                "source_tx_id INTEGER NOT NULL CHECK (source_tx_id > 0)"
            )
        );
        initializeSplitLogAccounting(syncSql(db));
        db.run(
            `INSERT INTO _chardb_split_tail_inbox
               (mig_id, source_tx_id, first_lsn, last_lsn, row_count, byte_size, transaction_json)
             VALUES ('file-move', -1, 1, 1, 1, 1, '{}')`
        );
        expect(db.query("SELECT source_tx_id FROM _chardb_split_tail_inbox").get()).toEqual({ source_tx_id: -1 });
    });

    test("refuses to rebuild a positive-only inbox with staged rows or active split state", () => {
        for (const occupied of ["inbox", "active"] as const) {
            db = new Database(":memory:");
            db.exec(
                SPLIT_LOG_DDL.replace(
                    "source_tx_id INTEGER NOT NULL CHECK (source_tx_id != 0)",
                    "source_tx_id INTEGER NOT NULL CHECK (source_tx_id > 0)"
                )
            );
            if (occupied === "inbox") {
                db.run(
                    `INSERT INTO _chardb_split_tail_inbox
                       (mig_id, source_tx_id, first_lsn, last_lsn, row_count, byte_size, transaction_json)
                     VALUES ('staged', 1, 1, 1, 1, 1, '{}')`
                );
            } else {
                db.run(
                    `INSERT INTO _chardb_split_state
                       (mig_id, range_lo, range_hi, role, capture, drained, updated_at)
                     VALUES ('active', 0, 0, 'dest', 0, 0, 1)`
                );
            }
            expect(() => initializeSplitLogAccounting(syncSql(db))).toThrow(
                /cannot upgrade while split state or staged rows exist/
            );
            db.close();
        }
        db = undefined as never;
    });

    test("reconstructs active counters from numeric sizes and survives restart and cleanup", () => {
        db = new Database(":memory:");
        db.exec(`
          CREATE TABLE _chardb_split_log (
            lsn INTEGER PRIMARY KEY AUTOINCREMENT, source_tx_id INTEGER, mig_id TEXT NOT NULL, op TEXT NOT NULL,
            table_name TEXT NOT NULL, pk TEXT NOT NULL, before BLOB, after BLOB, ts INTEGER NOT NULL
          );
          CREATE TABLE _chardb_split_state (
            mig_id TEXT PRIMARY KEY, range_lo INTEGER NOT NULL, range_hi INTEGER NOT NULL,
            role TEXT NOT NULL, capture INTEGER NOT NULL, bulk_done INTEGER NOT NULL DEFAULT 0,
            applied_lsn INTEGER NOT NULL DEFAULT 0, drained INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
          );
        `);
        db.run("INSERT INTO _chardb_split_state VALUES ('active', 0, 1, 'source', 1, 0, 0, 0, 1)");
        db.run("INSERT INTO _chardb_split_state VALUES ('drained', 0, 1, 'source', 0, 0, 0, 1, 1)");
        db.run(
            `INSERT INTO _chardb_split_log (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (10, 'active', 'ins', 'records', 'org-a', NULL, '{"id":"one"}', 1),
                    (11, 'active', 'upd', 'records', 'org-a', '{"id":"one"}', '{"id":"two"}', 2),
                    (12, 'drained', 'del', 'records', 'org-b', '{"id":"old"}', NULL, 3)`
        );
        const expected = (
            db
                .query(
                    `SELECT SUM(${SPLIT_LOG_ACCOUNTED_BYTES_SQL}) AS bytes FROM _chardb_split_log WHERE mig_id = 'active'`
                )
                .get() as {
                bytes: number;
            }
        ).bytes;

        initializeSplitLogAccounting(syncSql(db));
        expect(
            db.query("SELECT mig_id, split_log_rows, split_log_bytes FROM _chardb_split_state ORDER BY mig_id").all()
        ).toEqual([
            { mig_id: "active", split_log_rows: 2, split_log_bytes: expected },
            { mig_id: "drained", split_log_rows: 0, split_log_bytes: 0 },
        ]);

        initializeSplitLogAccounting(syncSql(db));
        expect(
            db.query("SELECT split_log_rows, split_log_bytes FROM _chardb_split_state WHERE mig_id = 'active'").get()
        ).toEqual({ split_log_rows: 2, split_log_bytes: expected });
        db.run(
            `INSERT INTO _chardb_split_log (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (13, 'active', 'ins', 'records', 'org-a', NULL, '{"id":"stale-trigger-write"}', 4)`
        );
        initializeSplitLogAccounting(syncSql(db));
        const recovered = db
            .query(
                `SELECT COUNT(*) AS rows, SUM(${SPLIT_LOG_ACCOUNTED_BYTES_SQL}) AS bytes
                 FROM _chardb_split_log WHERE mig_id = 'active'`
            )
            .get() as { rows: number; bytes: number };
        expect(
            db.query("SELECT split_log_rows, split_log_bytes FROM _chardb_split_state WHERE mig_id = 'active'").get()
        ).toEqual({ split_log_rows: recovered.rows, split_log_bytes: recovered.bytes });
        db.run("DELETE FROM _chardb_split_log WHERE mig_id = 'active'");
        db.run("DELETE FROM _chardb_split_state WHERE mig_id = 'active'");
        initializeSplitLogAccounting(syncSql(db));
        expect(db.query("SELECT 1 FROM _chardb_split_state WHERE mig_id = 'active'").get()).toBeNull();
    });

    test("fails closed when an active legacy split contains rows without source transaction identity", () => {
        db = new Database(":memory:");
        db.exec(`
          CREATE TABLE _chardb_split_log (
            lsn INTEGER PRIMARY KEY AUTOINCREMENT, mig_id TEXT NOT NULL, op TEXT NOT NULL,
            table_name TEXT NOT NULL, pk TEXT NOT NULL, before BLOB, after BLOB, ts INTEGER NOT NULL
          );
          CREATE TABLE _chardb_split_state (
            mig_id TEXT PRIMARY KEY, range_lo INTEGER NOT NULL, range_hi INTEGER NOT NULL,
            role TEXT NOT NULL, capture INTEGER NOT NULL, bulk_done INTEGER NOT NULL DEFAULT 0,
            applied_lsn INTEGER NOT NULL DEFAULT 0, drained INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
          );
          INSERT INTO _chardb_split_state VALUES ('legacy', 0, 1, 'source', 1, 0, 0, 0, 1);
          INSERT INTO _chardb_split_log (mig_id, op, table_name, pk, before, after, ts)
          VALUES ('legacy', 'ins', 'records', 'org-a', NULL, '{"id":"one"}', 1);
        `);

        expect(() => initializeSplitLogAccounting(syncSql(db))).toThrow(
            "active source split legacy contains tail rows without source transaction identity"
        );
    });
});
