import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { OP_LOG_DDL, SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import {
    CDB_SPLIT_OPLOG_MAX_ROW_BYTES,
    CDB_SPLIT_OPLOG_STORE_DDL,
    ackSplitOpLog,
    applySplitOpLogBatch,
    beginSplitOpLogDestination,
    captureSplitOpLogOutcome,
    finalizeSplitOpLogDestination,
    finalizeSplitOpLogSource,
    initializeSplitOpLogAccounting,
    readSplitOpLogBatch,
    seedSplitOpLogRange,
} from "../../src/server/do/cdb-split-oplog-store.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";

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

function initialize(db: Database) {
    const sql = adaptSqlStorage(sqlStorage(db) as never);
    for (const statement of `${OP_LOG_DDL}\n${SPLIT_LOG_DDL}\n${CDB_SPLIT_OPLOG_STORE_DDL}`
        .split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
    return sql;
}

function insertOutcome(
    db: Database,
    input: {
        principalId: string;
        mutId: string;
        payloadByte?: number;
        payloadSize?: number;
        placementVshard?: number;
    }
): void {
    const payload = new Uint8Array(input.payloadSize ?? 3).fill(input.payloadByte ?? 7);
    db.query(
        `INSERT INTO _chardb_op_log
         (principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
          touched_keys, byte_size, placement_vshard)
         VALUES (?, ?, ?, ?, 1234, 7, '[]', ?, ?)`
    ).run(
        input.principalId,
        input.mutId,
        new Uint8Array(32).fill(5),
        payload,
        payload.byteLength,
        input.placementVshard ?? 150
    );
}

const databases: Database[] = [];

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

describe("Cdb split mutation replay store", () => {
    test("captures by active vshard and reconstructs the exact outcome with idempotent cursors", () => {
        const source = new Database(":memory:");
        const destination = new Database(":memory:");
        databases.push(source, destination);
        const sourceSql = initialize(source);
        const destinationSql = initialize(destination);
        source
            .query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES ('move-1', 100, 199, 'source', 1, 1)`
            )
            .run();
        destination
            .query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES ('move-1', 100, 199, 'dest', 0, 1)`
            )
            .run();
        beginSplitOpLogDestination(destinationSql, { migId: "move-1", rangeLo: 100, rangeHi: 199 }, 1);

        insertOutcome(source, { principalId: "user-1", mutId: "mutation-1" });
        insertOutcome(source, { principalId: "user-2", mutId: "mutation-outside" });
        expect(
            captureSplitOpLogOutcome({
                sql: sourceSql,
                principalId: "user-2",
                mutId: "mutation-outside",
                vshard: 200,
                nowMs: 2,
            })
        ).toBe(0);
        expect(
            captureSplitOpLogOutcome({
                sql: sourceSql,
                principalId: "user-1",
                mutId: "mutation-1",
                vshard: 150,
                nowMs: 2,
            })
        ).toBe(1);
        expect(
            captureSplitOpLogOutcome({
                sql: sourceSql,
                principalId: "user-1",
                mutId: "mutation-1",
                vshard: 150,
                nowMs: 3,
            })
        ).toBe(0);

        const batch = readSplitOpLogBatch(sourceSql, { migId: "move-1", afterLsn: 0, limit: 64 });
        expect(batch.entries).toHaveLength(1);
        expect(batch.done).toBe(true);
        expect(
            destination.transaction(() =>
                applySplitOpLogBatch(destinationSql, {
                    migId: "move-1",
                    rangeLo: 100,
                    rangeHi: 199,
                    entries: batch.entries,
                    nowMs: 4,
                })
            )()
        ).toEqual({ applied: 1, replayed: 0, lastLsn: batch.lastLsn });
        expect(
            destination.transaction(() =>
                applySplitOpLogBatch(destinationSql, {
                    migId: "move-1",
                    rangeLo: 100,
                    rangeHi: 199,
                    entries: batch.entries,
                    nowMs: 5,
                })
            )()
        ).toEqual({ applied: 0, replayed: 1, lastLsn: batch.lastLsn });

        const sourceRow = source
            .query(
                `SELECT principal_id, mut_id, hex(payload_hash) AS payload_hash, hex(payload_enc) AS payload_enc,
                        committed_at, schema_epoch, touched_keys, byte_size, placement_vshard
                 FROM _chardb_op_log WHERE principal_id = 'user-1' AND mut_id = 'mutation-1'`
            )
            .get();
        const destinationRow = destination
            .query(
                `SELECT principal_id, mut_id, hex(payload_hash) AS payload_hash, hex(payload_enc) AS payload_enc,
                        committed_at, schema_epoch, touched_keys, byte_size, placement_vshard
                 FROM _chardb_op_log WHERE principal_id = 'user-1' AND mut_id = 'mutation-1'`
            )
            .get();
        expect(destinationRow).toEqual(sourceRow);
        expect(destination.query("SELECT applied_lsn, applied_rows FROM _chardb_split_oplog_cursor").get()).toEqual({
            applied_lsn: batch.lastLsn,
            applied_rows: 1,
        });
        destination.transaction(() => finalizeSplitOpLogDestination(destinationSql, "move-1", true))();
        expect(destination.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 0 });
        expect(destination.query("SELECT COUNT(*) AS count FROM _chardb_split_oplog_applied").get()).toEqual({
            count: 0,
        });
        expect(destination.query("SELECT COUNT(*) AS count FROM _chardb_split_oplog_cursor").get()).toEqual({
            count: 0,
        });
    });

    test("rejects a destination payload collision without advancing its cursor", () => {
        const source = new Database(":memory:");
        const destination = new Database(":memory:");
        databases.push(source, destination);
        const sourceSql = initialize(source);
        const destinationSql = initialize(destination);
        source
            .query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES ('move-collision', 9, 9, 'source', 1, 1)`
            )
            .run();
        beginSplitOpLogDestination(destinationSql, { migId: "move-collision", rangeLo: 9, rangeHi: 9 }, 1);
        insertOutcome(source, { principalId: "user-1", mutId: "same-id", payloadByte: 1, placementVshard: 9 });
        insertOutcome(destination, {
            principalId: "user-1",
            mutId: "same-id",
            payloadByte: 2,
            placementVshard: 9,
        });
        captureSplitOpLogOutcome({
            sql: sourceSql,
            principalId: "user-1",
            mutId: "same-id",
            vshard: 9,
        });
        const batch = readSplitOpLogBatch(sourceSql, { migId: "move-collision", afterLsn: 0, limit: 64 });

        expect(() =>
            destination.transaction(() =>
                applySplitOpLogBatch(destinationSql, {
                    migId: "move-collision",
                    rangeLo: 9,
                    rangeHi: 9,
                    entries: batch.entries,
                })
            )()
        ).toThrow(expect.objectContaining({ code: "CDB_MUT_ID_COLLISION" }));
        expect(destination.query("SELECT applied_lsn, applied_rows FROM _chardb_split_oplog_cursor").get()).toEqual({
            applied_lsn: 0,
            applied_rows: 0,
        });
    });

    test("acknowledges exact retained boundaries, survives restart, and preserves the main op-log", () => {
        const source = new Database(":memory:");
        databases.push(source);
        const sql = initialize(source);
        source
            .query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES ('move-ack', 150, 150, 'source', 1, 1)`
            )
            .run();
        for (let index = 0; index < 3; index++) {
            insertOutcome(source, { principalId: "user", mutId: `mutation-${index}` });
            captureSplitOpLogOutcome({
                sql,
                principalId: "user",
                mutId: `mutation-${index}`,
                vshard: 150,
                nowMs: index + 2,
            });
        }
        const batch = readSplitOpLogBatch(sql, { migId: "move-ack", afterLsn: 0, limit: 64 });
        const first = batch.entries[0];
        if (!first) throw new Error("expected first split-oplog row");

        expect(ackSplitOpLog(sql, "move-ack", first.lsn, 10)).toMatchObject({ pruned: 1, ackedLsn: first.lsn });
        initializeSplitOpLogAccounting(sql, 11);
        expect(source.query("SELECT retained_rows, acked_lsn FROM _chardb_split_oplog_accounting").get()).toEqual({
            retained_rows: 2,
            acked_lsn: first.lsn,
        });
        expect(() => ackSplitOpLog(sql, "move-ack", batch.lastLsn + 1, 12)).toThrow(
            "acknowledgement must end at a retained row"
        );
        expect(ackSplitOpLog(sql, "move-ack", batch.lastLsn, 13)).toMatchObject({
            pruned: 2,
            ackedLsn: batch.lastLsn,
        });
        expect(ackSplitOpLog(sql, "move-ack", batch.lastLsn, 14)).toEqual({
            pruned: 0,
            prunedBytes: 0,
            ackedLsn: batch.lastLsn,
        });
        expect(source.query("SELECT COUNT(*) AS count FROM _chardb_split_oplog").get()).toEqual({ count: 0 });
        expect(source.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 3 });

        finalizeSplitOpLogSource(sql, "move-ack");
        expect(source.query("SELECT COUNT(*) AS count FROM _chardb_split_oplog_accounting").get()).toEqual({
            count: 0,
        });
    });

    test("abort preserves an exact outcome that predated this destination transfer", () => {
        const source = new Database(":memory:");
        const destination = new Database(":memory:");
        databases.push(source, destination);
        const sourceSql = initialize(source);
        const destinationSql = initialize(destination);
        source
            .query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES ('move-owned', 150, 150, 'source', 1, 1)`
            )
            .run();
        beginSplitOpLogDestination(destinationSql, { migId: "move-owned", rangeLo: 150, rangeHi: 150 }, 1);
        insertOutcome(source, { principalId: "user-existing", mutId: "mutation-existing" });
        insertOutcome(destination, { principalId: "user-existing", mutId: "mutation-existing" });
        captureSplitOpLogOutcome({
            sql: sourceSql,
            principalId: "user-existing",
            mutId: "mutation-existing",
            vshard: 150,
        });
        const batch = readSplitOpLogBatch(sourceSql, { migId: "move-owned", afterLsn: 0, limit: 64 });
        expect(
            destination.transaction(() =>
                applySplitOpLogBatch(destinationSql, {
                    migId: "move-owned",
                    rangeLo: 150,
                    rangeHi: 150,
                    entries: batch.entries,
                })
            )()
        ).toMatchObject({ applied: 0, replayed: 1 });
        expect(destination.query("SELECT inserted FROM _chardb_split_oplog_applied").get()).toEqual({ inserted: 0 });

        destination.transaction(() => finalizeSplitOpLogDestination(destinationSql, "move-owned", true))();
        expect(destination.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 1 });
        expect(destination.query("SELECT COUNT(*) AS count FROM _chardb_split_oplog_applied").get()).toEqual({
            count: 0,
        });
    });

    test("fails the source mutation transaction when one captured outcome exceeds the fixed row cap", () => {
        const source = new Database(":memory:");
        databases.push(source);
        const sql = initialize(source);
        source
            .query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES ('move-large', 10, 10, 'source', 1, 1)`
            )
            .run();
        insertOutcome(source, {
            principalId: "user-large",
            mutId: "mutation-large",
            payloadSize: CDB_SPLIT_OPLOG_MAX_ROW_BYTES,
            placementVshard: 10,
        });

        expect(() =>
            captureSplitOpLogOutcome({
                sql,
                principalId: "user-large",
                mutId: "mutation-large",
                vshard: 10,
            })
        ).toThrow(expect.objectContaining({ code: "CDB_RATE_LIMITED" }));
        expect(source.query("SELECT COUNT(*) AS count FROM _chardb_split_oplog").get()).toEqual({ count: 0 });
    });

    test("pages more retained outcomes than the transfer queue can hold without pruning the main op-log", () => {
        const source = new Database(":memory:");
        databases.push(source);
        const sql = initialize(source);
        source
            .query(
                `INSERT INTO _chardb_split_state
                 (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES ('move-paged-seed', 150, 150, 'source', 1, 1)`
            )
            .run();
        source.transaction(() => {
            for (let index = 0; index < 4_100; index++) {
                insertOutcome(source, { principalId: "seed-user", mutId: `seed-${index}` });
            }
        })();
        seedSplitOpLogRange(sql, { migId: "move-paged-seed", rangeLo: 150, rangeHi: 150 }, 2);

        let cursor = 0;
        let transferred = 0;
        let maxRetained = 0;
        for (let iteration = 0; iteration < 100; iteration++) {
            const batch = readSplitOpLogBatch(sql, { migId: "move-paged-seed", afterLsn: cursor, limit: 64 });
            transferred += batch.entries.length;
            cursor = batch.lastLsn;
            const accounting = source
                .query("SELECT retained_rows FROM _chardb_split_oplog_accounting WHERE mig_id = 'move-paged-seed'")
                .get() as { retained_rows: number };
            maxRetained = Math.max(maxRetained, accounting.retained_rows);
            if (batch.entries.length > 0) ackSplitOpLog(sql, "move-paged-seed", cursor, iteration + 3);
            if (batch.done) break;
        }

        expect({ transferred, maxRetained }).toEqual({ transferred: 4_100, maxRetained: 64 });
        expect(source.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 4_100 });
        expect(source.query("SELECT COUNT(*) AS count FROM _chardb_split_oplog").get()).toEqual({ count: 0 });
    });
});
