import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Catalog } from "../../src/server/do/catalog.ts";
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

describe("Catalog routing inventory", () => {
    let db: Database;
    let catalog: Catalog;
    let bootstrap: Promise<unknown>;
    let failNextTransactionCommit: boolean;

    beforeEach(async () => {
        db = new Database(":memory:");
        bootstrap = Promise.resolve();
        failNextTransactionCommit = false;
        const state = {
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => {
                    db.exec("BEGIN IMMEDIATE");
                    try {
                        const result = callback();
                        if (failNextTransactionCommit) {
                            failNextTransactionCommit = false;
                            throw new Error("injected transaction commit failure");
                        }
                        db.exec("COMMIT");
                        return result;
                    } catch (error) {
                        db.exec("ROLLBACK");
                        throw error;
                    }
                },
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                bootstrap = callback();
            },
        } as unknown as DurableObjectState;
        catalog = new Catalog(state, {});
        await bootstrap;
    });

    afterEach(() => db.close());

    test("lists narrow ranges, removes duplicate shard ids, and sorts the result", async () => {
        await catalog.splitRange(1, 1, "ShardDO_z");
        await catalog.splitRange(2, 2, "ShardDO_a");
        await catalog.splitRange(3, 3, "ShardDO_z");

        expect(await catalog.route(1)).toMatchObject({ shardId: "ShardDO_z" });
        expect(await catalog.listShardIds()).toEqual([
            ShardId("ShardDO_0"),
            ShardId("ShardDO_a"),
            ShardId("ShardDO_z"),
        ]);
    });

    test("publishes a cutover map only after its durable transaction commits", async () => {
        const rangesBefore = db.query("SELECT lo, hi, shard_id FROM catalog_ranges ORDER BY lo").all();
        const epochBefore = db
            .query("SELECT epoch FROM catalog_epoch WHERE scope = 'schema' AND scope_id = 'global'")
            .get() as { epoch: number };
        expect(await catalog.route(0)).toEqual({ shardId: ShardId("ShardDO_0"), schemaEpoch: epochBefore.epoch });

        const request = {
            migId: "migration-commit-failure",
            lo: 0,
            hi: 0,
            fromShard: "ShardDO_0",
            toShard: "ShardDO_1",
        };
        failNextTransactionCommit = true;
        await expect(catalog.cutover(request)).rejects.toThrow("injected transaction commit failure");

        expect(db.query("SELECT lo, hi, shard_id FROM catalog_ranges ORDER BY lo").all()).toEqual(rangesBefore);
        expect(
            db.query("SELECT epoch FROM catalog_epoch WHERE scope = 'schema' AND scope_id = 'global'").get()
        ).toEqual(epochBefore);
        expect(db.query("SELECT v FROM catalog_meta WHERE k = ?").get(`cutover:${request.migId}`)).toBeNull();
        expect(await catalog.route(0)).toEqual({ shardId: ShardId("ShardDO_0"), schemaEpoch: epochBefore.epoch });

        await expect(catalog.cutover(request)).resolves.toEqual({ applied: true, newEpoch: epochBefore.epoch + 1 });
        expect(await catalog.route(0)).toEqual({
            shardId: ShardId("ShardDO_1"),
            schemaEpoch: epochBefore.epoch + 1,
        });
        await expect(catalog.cutover(request)).resolves.toEqual({ applied: false, newEpoch: epochBefore.epoch + 1 });
        expect(db.query("SELECT v FROM catalog_meta WHERE k = ?").get(`cutover:${request.migId}`)).toEqual({
            v: "ShardDO_0",
        });
    });
});
