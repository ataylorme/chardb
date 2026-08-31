import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { readCdbSourceTailHighWatermark } from "../../src/server/do/cdb-reshard-runtime.ts";

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
            return Number((db.query("SELECT changes() AS count").get() as { count: number }).count);
        },
    };
}

function initialize(db: Database): void {
    for (const statement of SPLIT_LOG_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        db.run(statement);
    }
    db.run(
        `INSERT INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
         VALUES ('move', 1, 1, 'source', 1, 1)`
    );
}

describe("Cdb source tail high-watermark", () => {
    let db: Database;

    afterEach(() => db?.close());

    test("survives prune-to-empty, advances after prune, and reconstructs cold", () => {
        db = new Database(":memory:");
        initialize(db);
        const insert = db.prepare(
            `INSERT INTO _chardb_split_log (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (?, 'move', 'ins', '_chardb_files', ?, NULL, '{}', 1)`
        );
        insert.run(-1, "first");
        insert.run(-2, "second");
        expect(readCdbSourceTailHighWatermark(syncSql(db), "move")).toBe(2);

        db.run("UPDATE _chardb_split_state SET acked_lsn = 2 WHERE mig_id = 'move'");
        db.run("DELETE FROM _chardb_split_log WHERE mig_id = 'move'");
        expect(readCdbSourceTailHighWatermark(syncSql(db), "move")).toBe(2);
        expect(readCdbSourceTailHighWatermark(syncSql(db), "move")).toBe(2);

        insert.run(-3, "third");
        expect(readCdbSourceTailHighWatermark(syncSql(db), "move")).toBe(3);
        expect(() => readCdbSourceTailHighWatermark(syncSql(db), "missing")).toThrow(/high-watermark is invalid/);
    });
});
