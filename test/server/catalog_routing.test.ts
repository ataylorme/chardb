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

    beforeEach(async () => {
        db = new Database(":memory:");
        bootstrap = Promise.resolve();
        const state = {
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
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
});
