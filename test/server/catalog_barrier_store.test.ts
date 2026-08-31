import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
    acknowledgeCatalogBarrier,
    initializeCatalogBarrierStorage,
    listOpenCatalogBarriers,
    recordCatalogBarrier,
} from "../../src/server/do/catalog-barrier-store.ts";
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

describe("Catalog barrier store", () => {
    test("owns record, idempotent acknowledgement, bookmark, and open projection", () => {
        const db = new Database(":memory:");
        try {
            const sql = adaptSqlStorage(sqlStorage(db));
            initializeCatalogBarrierStorage(sql);
            recordCatalogBarrier(sql, {
                barrierId: "barrier-1",
                ts: 100,
                expectedShards: ["ShardDO_1", "ShardDO_0"],
                tenantPrefix: "org-",
            });
            recordCatalogBarrier(sql, {
                barrierId: "barrier-2",
                ts: 200,
                expectedShards: ["ShardDO_2"],
            });

            expect(listOpenCatalogBarriers(sql)).toEqual([
                { barrierId: "barrier-1", ts: 100, missing: ["ShardDO_1", "ShardDO_0"] },
                { barrierId: "barrier-2", ts: 200, missing: ["ShardDO_2"] },
            ]);

            expect(
                db.transaction(() =>
                    acknowledgeCatalogBarrier(sql, {
                        barrierId: "barrier-1",
                        shardId: "ShardDO_0",
                        bookmark: 41,
                    })
                )()
            ).toEqual({ complete: false });
            expect(
                db.transaction(() =>
                    acknowledgeCatalogBarrier(sql, {
                        barrierId: "barrier-1",
                        shardId: "ShardDO_0",
                        bookmark: 42,
                    })
                )()
            ).toEqual({ complete: false });
            expect(
                db.transaction(() =>
                    acknowledgeCatalogBarrier(sql, {
                        barrierId: "barrier-1",
                        shardId: "ShardDO_1",
                        bookmark: 43,
                    })
                )()
            ).toEqual({ complete: true });

            expect(listOpenCatalogBarriers(sql)).toEqual([{ barrierId: "barrier-2", ts: 200, missing: ["ShardDO_2"] }]);
            expect(
                db
                    .query("SELECT ack_shards, bookmarks, tenant_prefix FROM catalog_barrier WHERE barrier_id = ?")
                    .get("barrier-1")
            ).toEqual({
                ack_shards: '["ShardDO_0","ShardDO_1"]',
                bookmarks: '{"ShardDO_0":42,"ShardDO_1":43}',
                tenant_prefix: "org-",
            });
        } finally {
            db.close();
        }
    });

    test("returns incomplete without writing for an unknown barrier", () => {
        const db = new Database(":memory:");
        try {
            const sql = adaptSqlStorage(sqlStorage(db));
            initializeCatalogBarrierStorage(sql);
            expect(
                db.transaction(() =>
                    acknowledgeCatalogBarrier(sql, {
                        barrierId: "missing",
                        shardId: "ShardDO_0",
                        bookmark: 0,
                    })
                )()
            ).toEqual({ complete: false });
            expect(db.query("SELECT COUNT(*) AS count FROM catalog_barrier").get()).toEqual({ count: 0 });
        } finally {
            db.close();
        }
    });
});
