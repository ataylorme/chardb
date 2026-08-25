import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Catalog, configureCatalogRuntime } from "../../src/server/do/catalog.ts";
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

describe("Catalog routing inventory", () => {
    let db: Database;
    let catalog: Catalog;
    let bootstrap: Promise<unknown>;
    let failNextTransactionCommit: boolean;
    let state: DurableObjectState;

    beforeEach(async () => {
        db = new Database(":memory:");
        bootstrap = Promise.resolve();
        failNextTransactionCommit = false;
        state = {
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

    test("persists migration ownership, fences routes, and activates one exact journal version", async () => {
        const journal = defineMigrations([
            { version: 1, name: "baseline", statements: ["CREATE TABLE example (id TEXT PRIMARY KEY)"] },
            { version: 2, name: "add_name", statements: ["ALTER TABLE example ADD COLUMN name TEXT"] },
        ]);
        const ConfiguredCatalog = configureCatalogRuntime({ migrations: () => journal });
        db.close();
        db = new Database(":memory:");
        (state.storage as unknown as { sql: ReturnType<typeof sqlStorage> }).sql = sqlStorage(db);
        let configuredReady: Promise<unknown> = Promise.resolve();
        (
            state as unknown as { blockConcurrencyWhile: (callback: () => Promise<unknown>) => void }
        ).blockConcurrencyWhile = callback => {
            configuredReady = callback();
        };
        const configured = new ConfiguredCatalog(state, {});
        await configuredReady;

        expect(configured.schemaState()).toMatchObject({
            activeVersion: 2,
            activeEpoch: 1,
            activeDigest: journal.digest,
            status: "active",
        });

        const future = defineMigrations([
            ...journal.migrations.map(migration => ({
                version: migration.version,
                name: migration.name,
                statements: migration.statements,
            })),
            { version: 3, name: "add_slug", statements: ["ALTER TABLE example ADD COLUMN slug TEXT"] },
        ]);
        const FutureCatalog = configureCatalogRuntime({ migrations: () => future });
        let futureReady: Promise<unknown> = Promise.resolve();
        (
            state as unknown as { blockConcurrencyWhile: (callback: () => Promise<unknown>) => void }
        ).blockConcurrencyWhile = callback => {
            futureReady = callback();
        };
        const reconstructed = new FutureCatalog(state, {});
        await futureReady;
        failNextTransactionCommit = true;
        expect(() => reconstructed.beginSchemaMigration({ migrationId: "deploy-3", targetVersion: 3 })).toThrow(
            /injected transaction commit failure/
        );
        expect(reconstructed.schemaState()).toMatchObject({ activeVersion: 2, status: "active" });
        await expect(reconstructed.route(0)).resolves.toMatchObject({ shardId: "ShardDO_0" });
        expect(reconstructed.beginSchemaMigration({ migrationId: "deploy-3", targetVersion: 3 })).toMatchObject({
            activeVersion: 2,
            activeEpoch: 1,
            status: "migrating",
            migrationId: "deploy-3",
            targetVersion: 3,
            targetEpoch: 2,
        });
        expect(reconstructed.beginSchemaMigration({ migrationId: "deploy-3", targetVersion: 3 })).toMatchObject({
            status: "migrating",
        });
        await expect(reconstructed.route(0)).rejects.toMatchObject({ code: "CDB_STALE_EPOCH", retryable: true });
        failNextTransactionCommit = true;
        expect(() => reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toThrow(
            /injected transaction commit failure/
        );
        expect(reconstructed.schemaState()).toMatchObject({ activeVersion: 2, status: "migrating" });
        await expect(reconstructed.route(0)).rejects.toMatchObject({ code: "CDB_STALE_EPOCH", retryable: true });
        expect(reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toMatchObject({
            activeVersion: 3,
            activeEpoch: 2,
            activeDigest: future.digest,
            lastMigrationId: "deploy-3",
            status: "active",
        });
        expect(reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toMatchObject({
            activeVersion: 3,
            activeEpoch: 2,
        });
        expect(() => reconstructed.completeSchemaMigration({ migrationId: "another-deploy" })).toThrow(/not active/);
        await expect(reconstructed.route(0)).resolves.toMatchObject({ shardId: "ShardDO_0" });
    });
});
