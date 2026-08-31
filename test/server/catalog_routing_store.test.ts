import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CatalogRoutingStore } from "../../src/server/do/catalog-routing-store.ts";
import { initializeCatalogStorage } from "../../src/server/do/catalog-schema-store.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { defineMigrations } from "../../src/server/schema-migrations.ts";
import { ShardId } from "../../src/types.ts";

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

describe("Catalog routing store", () => {
    let db: Database;
    let store: CatalogRoutingStore;
    let failNextCommit: boolean;

    beforeEach(() => {
        db = new Database(":memory:");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCatalogStorage(sql, defineMigrations([]));
        failNextCommit = false;
        store = new CatalogRoutingStore({
            sql,
            transactionSync: callback => {
                db.exec("BEGIN IMMEDIATE");
                try {
                    const result = callback();
                    if (failNextCommit) {
                        failNextCommit = false;
                        throw new Error("injected transaction commit failure");
                    }
                    db.exec("COMMIT");
                    return result;
                } catch (error) {
                    db.exec("ROLLBACK");
                    throw error;
                }
            },
        });
    });

    afterEach(() => db.close());

    test("owns range reads, split persistence, and sorted shard inventory", () => {
        expect(store.route(0)).toEqual({ shardId: ShardId("ShardDO_0"), schemaEpoch: 1 });
        store.splitRange(1, 1, "ShardDO_z");
        store.splitRange(2, 2, "ShardDO_a");
        store.splitRange(3, 3, "ShardDO_z");

        expect(store.route(1)).toEqual({ shardId: ShardId("ShardDO_z"), schemaEpoch: 4 });
        expect(store.ownsRange(0, 0, "ShardDO_0")).toBe(true);
        expect(store.ownsRange(0, 4, "ShardDO_0")).toBe(false);
        expect(store.listShardIds()).toEqual([ShardId("ShardDO_0"), ShardId("ShardDO_a"), ShardId("ShardDO_z")]);
        expect(db.query("SELECT lo, hi, shard_id FROM catalog_ranges ORDER BY lo").all()).toEqual([
            { lo: 0, hi: 0, shard_id: "ShardDO_0" },
            { lo: 1, hi: 1, shard_id: "ShardDO_z" },
            { lo: 2, hi: 2, shard_id: "ShardDO_a" },
            { lo: 3, hi: 3, shard_id: "ShardDO_z" },
            { lo: 4, hi: 16383, shard_id: "ShardDO_0" },
        ]);
    });

    test("publishes a cutover cache only after its SQLite transaction commits", () => {
        const request = {
            migId: "cutover-commit-probe",
            lo: 0,
            hi: 0,
            fromShard: "ShardDO_0",
            toShard: "ShardDO_1",
        };
        expect(store.route(0)).toEqual({ shardId: ShardId("ShardDO_0"), schemaEpoch: 1 });

        failNextCommit = true;
        expect(() => store.cutover(request)).toThrow("injected transaction commit failure");
        expect(store.route(0)).toEqual({ shardId: ShardId("ShardDO_0"), schemaEpoch: 1 });
        expect(db.query("SELECT v FROM catalog_meta WHERE k = ?").get(`cutover:${request.migId}`)).toBeNull();

        expect(store.cutover(request)).toEqual({ applied: true, newEpoch: 2 });
        expect(store.route(0)).toEqual({ shardId: ShardId("ShardDO_1"), schemaEpoch: 2 });
        expect(store.cutover(request)).toEqual({ applied: false, newEpoch: 2 });
        expect(db.query("SELECT v FROM catalog_meta WHERE k = ?").get(`cutover:${request.migId}`)).toEqual({
            v: "ShardDO_0",
        });
    });

    test("rejects a stale cutover source without changing routing, epoch, or its idempotency guard", () => {
        store.splitRange(0, 3, "ShardDO_1");
        const request = {
            migId: "stale-cutover-source",
            lo: 0,
            hi: 3,
            fromShard: "ShardDO_0",
            toShard: "ShardDO_2",
        };

        expect(() => store.cutover(request)).toThrow(
            expect.objectContaining({
                code: "CDB_STALE_EPOCH",
                message: "cutover source shard does not own the requested range",
            })
        );
        expect(store.route(0)).toEqual({ shardId: ShardId("ShardDO_1"), schemaEpoch: 2 });
        expect(store.route(3)).toEqual({ shardId: ShardId("ShardDO_1"), schemaEpoch: 2 });
        expect(db.query("SELECT v FROM catalog_meta WHERE k = ?").get(`cutover:${request.migId}`)).toBeNull();
    });

    test("publishes a split cache only after its SQLite transaction commits", () => {
        expect(store.route(4)).toEqual({ shardId: ShardId("ShardDO_0"), schemaEpoch: 1 });

        failNextCommit = true;
        expect(() => store.splitRange(4, 4, "ShardDO_1")).toThrow("injected transaction commit failure");
        expect(store.route(4)).toEqual({ shardId: ShardId("ShardDO_0"), schemaEpoch: 1 });
        expect(db.query("SELECT lo, hi, shard_id FROM catalog_ranges ORDER BY lo").all()).toEqual([
            { lo: 0, hi: 16383, shard_id: "ShardDO_0" },
        ]);

        store.splitRange(4, 4, "ShardDO_1");
        expect(store.route(4)).toEqual({ shardId: ShardId("ShardDO_1"), schemaEpoch: 2 });
    });
});
