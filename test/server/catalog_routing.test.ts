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
        expect(await catalog.route(0)).toEqual({
            shardId: ShardId("ShardDO_0"),
            schemaEpoch: epochBefore.epoch,
            domainSchemaEpoch: 1,
        });

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
        expect(await catalog.route(0)).toEqual({
            shardId: ShardId("ShardDO_0"),
            schemaEpoch: epochBefore.epoch,
            domainSchemaEpoch: 1,
        });

        await expect(catalog.cutover(request)).resolves.toEqual({ applied: true, newEpoch: epochBefore.epoch + 1 });
        expect(await catalog.route(0)).toEqual({
            shardId: ShardId("ShardDO_1"),
            schemaEpoch: epochBefore.epoch + 1,
            domainSchemaEpoch: 1,
        });
        await expect(catalog.cutover(request)).resolves.toEqual({ applied: false, newEpoch: epochBefore.epoch + 1 });
        expect(db.query("SELECT v FROM catalog_meta WHERE k = ?").get(`cutover:${request.migId}`)).toEqual({
            v: "ShardDO_0",
        });
    });

    test("persists migration ownership, fences routes, and activates one exact journal version", async () => {
        const journal = defineMigrations([]);
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
            activeVersion: 0,
            activeEpoch: 1,
            activeDigest: journal.digest,
            status: "active",
        });

        const future = defineMigrations([
            {
                version: 1,
                name: "add_slug",
                statements: ["ALTER TABLE example ADD COLUMN slug TEXT"],
                catalogStatements: ["SELECT 3"],
            },
        ]);
        const FutureCatalog = configureCatalogRuntime({ migrations: () => future });
        const migrationCalls: string[] = [];
        const migrationCdb = {
            async prepareSchemaMigration() {
                migrationCalls.push("prepare");
            },
            async applySchemaMigration(input: { version: number }) {
                migrationCalls.push(`apply:${input.version}`);
            },
            async activateSchemaMigration() {
                migrationCalls.push("activate");
            },
        };
        let futureReady: Promise<unknown> = Promise.resolve();
        (
            state as unknown as { blockConcurrencyWhile: (callback: () => Promise<unknown>) => void }
        ).blockConcurrencyWhile = callback => {
            futureReady = callback();
        };
        const reconstructed = new FutureCatalog(state, {
            CDB_SHARD: {
                idFromName: (name: string) => ({ toString: () => name }),
                get: () => migrationCdb,
            } as unknown as DurableObjectNamespace,
        });
        await futureReady;
        failNextTransactionCommit = true;
        expect(() => reconstructed.beginSchemaMigration({ migrationId: "deploy-3", targetVersion: 1 })).toThrow(
            /injected transaction commit failure/
        );
        expect(reconstructed.schemaState()).toMatchObject({ activeVersion: 0, status: "active" });
        await expect(reconstructed.route(0)).rejects.toMatchObject({ code: "CDB_STALE_EPOCH", retryable: true });
        expect(reconstructed.beginSchemaMigration({ migrationId: "deploy-3", targetVersion: 1 })).toMatchObject({
            activeVersion: 0,
            activeEpoch: 1,
            status: "migrating",
            migrationId: "deploy-3",
            targetVersion: 1,
            targetEpoch: 2,
        });
        expect(reconstructed.beginSchemaMigration({ migrationId: "deploy-3", targetVersion: 1 })).toMatchObject({
            status: "migrating",
        });
        await expect(reconstructed.route(0)).rejects.toMatchObject({ code: "CDB_STALE_EPOCH", retryable: true });
        expect(() => reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toThrow(/incomplete/);
        failNextTransactionCommit = true;
        await expect(
            reconstructed.migrateSchemaShard({ migrationId: "deploy-3", shardId: "ShardDO_0" })
        ).rejects.toThrow(/injected transaction commit failure/);
        expect(reconstructed.schemaMigrationShards({ migrationId: "deploy-3" })).toEqual([
            expect.objectContaining({ shardId: "ShardDO_0", status: "pending" }),
        ]);
        expect(migrationCalls).toEqual(["prepare", "apply:1", "activate"]);
        await expect(
            reconstructed.migrateSchemaShard({ migrationId: "deploy-3", shardId: "ShardDO_0" })
        ).resolves.toMatchObject({ shardId: "ShardDO_0", status: "active" });
        expect(migrationCalls).toEqual(["prepare", "apply:1", "activate", "prepare", "apply:1", "activate"]);
        await expect(
            reconstructed.migrateSchemaShard({ migrationId: "deploy-3", shardId: "ShardDO_0" })
        ).resolves.toMatchObject({ shardId: "ShardDO_0", status: "active" });
        expect(migrationCalls).toEqual(["prepare", "apply:1", "activate", "prepare", "apply:1", "activate"]);
        expect(() => reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toThrow(
            /steps are incomplete/
        );
        expect(reconstructed.applyCatalogSchemaMigration({ migrationId: "deploy-3", version: 1 })).toMatchObject({
            activeVersion: 0,
            status: "migrating",
        });
        expect(reconstructed.applyCatalogSchemaMigration({ migrationId: "deploy-3", version: 1 })).toMatchObject({
            status: "migrating",
        });
        failNextTransactionCommit = true;
        expect(() => reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toThrow(
            /injected transaction commit failure/
        );
        expect(reconstructed.schemaState()).toMatchObject({ activeVersion: 0, status: "migrating" });
        await expect(reconstructed.route(0)).rejects.toMatchObject({ code: "CDB_STALE_EPOCH", retryable: true });
        expect(reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
            activeDigest: future.digest,
            lastMigrationId: "deploy-3",
            status: "active",
        });
        expect(reconstructed.completeSchemaMigration({ migrationId: "deploy-3" })).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
        });
        expect(() => reconstructed.completeSchemaMigration({ migrationId: "another-deploy" })).toThrow(/not active/);
        await expect(reconstructed.route(0)).resolves.toMatchObject({ shardId: "ShardDO_0" });
    });

    test("baselines every existing shard and skips packaged SQL after exact schema checks", async () => {
        const journal = defineMigrations([
            {
                version: 1,
                name: "adopt_existing_schema",
                statements: ["THIS CDB SQL MUST NOT EXECUTE"],
                catalogStatements: ["THIS CATALOG SQL MUST NOT EXECUTE"],
            },
        ]);
        const FutureCatalog = configureCatalogRuntime({ migrations: () => journal });
        const calls: unknown[] = [];
        const migrationCdb = {
            async baselineSchemaMigration(input: unknown) {
                calls.push(input);
            },
            async prepareSchemaMigration() {
                throw new Error("baseline must not prepare an applying migration");
            },
        };
        let ready: Promise<unknown> = Promise.resolve();
        (
            state as unknown as { blockConcurrencyWhile: (callback: () => Promise<unknown>) => void }
        ).blockConcurrencyWhile = callback => {
            ready = callback();
        };
        const adopting = new FutureCatalog(state, {
            CDB_SHARD: {
                idFromName: (name: string) => ({ toString: () => name }),
                get: () => migrationCdb,
            } as unknown as DurableObjectNamespace,
        });
        await ready;

        expect(adopting.beginSchemaBaseline({ migrationId: "baseline-v1", targetVersion: 1 })).toMatchObject({
            activeVersion: 0,
            status: "migrating",
            migrationId: "baseline-v1",
            targetVersion: 1,
            targetEpoch: 2,
        });
        await expect(
            adopting.migrateSchemaShard({ migrationId: "baseline-v1", shardId: "ShardDO_0" })
        ).resolves.toMatchObject({ status: "active" });
        expect(calls).toEqual([
            {
                migrationId: "baseline-v1",
                targetVersion: 1,
                targetEpoch: 2,
                targetDigest: journal.digest,
            },
        ]);
        expect(adopting.applyCatalogSchemaMigration({ migrationId: "baseline-v1", version: 1 })).toMatchObject({
            status: "migrating",
        });
        expect(adopting.completeSchemaMigration({ migrationId: "baseline-v1" })).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
            activeDigest: journal.digest,
            lastMigrationId: "baseline-v1",
            status: "active",
        });
        expect(db.query("SELECT COUNT(*) AS count FROM catalog_schema_steps").get()).toEqual({ count: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM catalog_schema_baselines").get()).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM catalog_schema_shards").get()).toEqual({ count: 0 });
    });
});
