import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OP_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    CDB_EXTERNAL_RESHARD_CAPTURE_DDL,
    beginExternalReshardCapture,
    endExternalReshardCapture,
    initializeExternalReshardCapture,
    withExternalReshardCapture,
} from "../../src/server/external-reshard-capture.ts";
import {
    CDB_FILE_CAPTURE_TRANSACTION_DDL,
    beginExternalFileCapture,
    endExternalFileCapture,
    initializeFileCaptureTransactions,
} from "../../src/server/file-reshard-triggers.ts";
import { vshardOf } from "../../src/vshard.ts";

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

function executeDdl(db: Database, ddl: string): void {
    for (const statement of ddl
        .split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        db.run(statement);
    }
}

describe("external reshard capture", () => {
    let db: Database;
    let sql: SyncSql;

    beforeEach(() => {
        db = new Database(":memory:");
        sql = syncSql(db);
        executeDdl(db, OP_LOG_DDL);
        initializeExternalReshardCapture(sql);
    });

    afterEach(() => db.close());

    test("keeps file exports compatible with the neutral allocator", () => {
        expect(CDB_FILE_CAPTURE_TRANSACTION_DDL).toBe(CDB_EXTERNAL_RESHARD_CAPTURE_DDL);
        initializeFileCaptureTransactions(sql);
        const organizationId = "org-compatible";
        const placement = Number(vshardOf([organizationId]));

        const fileId = beginExternalFileCapture(sql, organizationId);
        expect(fileId).toBe(-1);
        expect(db.query("SELECT active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
            active_vshard: placement,
        });
        endExternalReshardCapture(sql, fileId);

        const neutralId = beginExternalReshardCapture(sql, placement);
        expect(neutralId).toBe(-2);
        endExternalFileCapture(sql, neutralId);
    });

    test("rejects invalid placement, nesting, and registered mutation overlap", () => {
        for (const placement of [-1, 16_384, 1.5, Number.NaN]) {
            expect(() => beginExternalReshardCapture(sql, placement)).toThrow(/placement is invalid/);
        }

        const active = beginExternalReshardCapture(sql, 7);
        expect(() => beginExternalReshardCapture(sql, 7)).toThrow(/already active/);
        endExternalReshardCapture(sql, active);

        db.run(
            `INSERT INTO _chardb_op_log
               (principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
                touched_keys, byte_size, placement_vshard)
             VALUES ('principal', 'mutation', X'00', X'', 1, 1, '[]', 0, 7)`
        );
        expect(() => beginExternalReshardCapture(sql, 7)).toThrow(/cannot overlap a registered mutation/);
    });

    test("ends after callback success", () => {
        const result = withExternalReshardCapture(sql, 11, transactionId => {
            expect(transactionId).toBe(-1);
            expect(db.query("SELECT active_id, active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
                active_id: -1,
                active_vshard: 11,
            });
            return "done";
        });

        expect(result).toBe("done");
        expect(db.query("SELECT next_id, active_id, active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
            next_id: 1,
            active_id: null,
            active_vshard: null,
        });
    });

    test("lets the outer transaction roll back callback failure", () => {
        const executed: string[] = [];
        const trackingSql: SyncSql = {
            ...sql,
            exec(statement, ...params) {
                executed.push(statement);
                sql.exec(statement, ...params);
            },
        };
        expect(() =>
            db.transaction(() =>
                withExternalReshardCapture(trackingSql, 13, () => {
                    db.run("CREATE TABLE rollback_probe (id INTEGER)");
                    throw new Error("callback failed");
                })
            )()
        ).toThrow("callback failed");

        expect(db.query("SELECT next_id, active_id, active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
            next_id: 0,
            active_id: null,
            active_vshard: null,
        });
        expect(db.query("SELECT name FROM sqlite_master WHERE name = 'rollback_probe'").get()).toBeNull();
        expect(executed.some(statement => statement.includes("SET active_id = NULL"))).toBe(false);
    });

    test("fails before negating an exhausted unsafe sequence", () => {
        db.run("UPDATE _chardb_split_capture_tx SET next_id = ?", [Number.MAX_SAFE_INTEGER - 1]);

        const finalId = beginExternalReshardCapture(sql, 5);
        expect(finalId).toBe(-Number.MAX_SAFE_INTEGER);
        endExternalReshardCapture(sql, finalId);

        expect(() => beginExternalReshardCapture(sql, 5)).toThrow(/identity is exhausted/);
        expect(db.query("SELECT next_id, active_id, active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
            next_id: Number.MAX_SAFE_INTEGER,
            active_id: null,
            active_vshard: null,
        });
    });

    test("freezes every external state transaction behind an activated source fence", () => {
        db.exec(`
            CREATE TABLE _chardb_routing_fences (
              range_lo INTEGER NOT NULL,
              range_hi INTEGER NOT NULL,
              status TEXT NOT NULL
            );
            INSERT INTO _chardb_routing_fences VALUES (20, 30, 'prepared');
        `);
        const prepared = beginExternalReshardCapture(sql, 25);
        endExternalReshardCapture(sql, prepared);

        db.run("UPDATE _chardb_routing_fences SET status = 'active'");
        expect(() => beginExternalReshardCapture(sql, 25)).toThrow("external state delivery is frozen");
        expect(db.query("SELECT next_id, active_id, active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
            next_id: 1,
            active_id: null,
            active_vshard: null,
        });

        const outside = beginExternalReshardCapture(sql, 31);
        endExternalReshardCapture(sql, outside);
        db.run("UPDATE _chardb_routing_fences SET status = 'cleaned'");
        expect(() => beginExternalReshardCapture(sql, 25)).toThrow("external state delivery is frozen");
    });
});
