import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
    activateCatalogSchemaShard,
    applyCatalogSchemaMigrationStep,
    beginCatalogSchemaChange,
    completeCatalogSchemaMigration,
    initializeCatalogStorage,
    readCatalogSchemaMigrationShards,
    readCatalogSchemaState,
    recordCatalogSchemaShardFailure,
} from "../../src/server/do/catalog-schema-store.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { defineMigrations } from "../../src/server/schema-migrations.ts";

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

describe("Catalog schema store", () => {
    test("owns the durable migration transition without Catalog RPC orchestration", () => {
        const db = new Database(":memory:");
        try {
            const sql = adaptSqlStorage(sqlStorage(db));
            const journal = defineMigrations([
                {
                    version: 1,
                    name: "create_probe",
                    statements: ["CREATE TABLE shard_probe (id TEXT PRIMARY KEY)"],
                    catalogStatements: ["CREATE TABLE catalog_probe (id TEXT PRIMARY KEY)"],
                },
            ]);

            expect(initializeCatalogStorage(sql, journal)).toMatchObject({
                activeVersion: 0,
                activeEpoch: 1,
                status: "active",
            });
            db.transaction(() =>
                beginCatalogSchemaChange(sql, journal, { migrationId: "migration-1", targetVersion: 1 }, false)
            )();
            expect(readCatalogSchemaState(sql)).toMatchObject({
                activeVersion: 0,
                activeEpoch: 1,
                status: "migrating",
                migrationId: "migration-1",
                targetVersion: 1,
                targetEpoch: 2,
            });

            db.transaction(() =>
                recordCatalogSchemaShardFailure(sql, { migrationId: "migration-1", shardId: "ShardDO_0" }, "retryable")
            )();
            expect(readCatalogSchemaMigrationShards(sql, { migrationId: "migration-1" })).toMatchObject([
                { shardId: "ShardDO_0", status: "pending", lastError: "retryable" },
            ]);

            db.transaction(() =>
                activateCatalogSchemaShard(sql, { migrationId: "migration-1", shardId: "ShardDO_0" })
            )();
            db.transaction(() =>
                applyCatalogSchemaMigrationStep(sql, journal, { migrationId: "migration-1", version: 1 })
            )();
            expect(
                sql.one<{ name: string }>(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalog_probe'"
                )
            ).toEqual({ name: "catalog_probe" });

            let authSchemaChecks = 0;
            db.transaction(() =>
                completeCatalogSchemaMigration(sql, journal, { migrationId: "migration-1" }, () => {
                    authSchemaChecks++;
                })
            )();
            expect(readCatalogSchemaState(sql)).toMatchObject({
                activeVersion: 1,
                activeEpoch: 2,
                status: "active",
                lastMigrationId: "migration-1",
            });
            expect(readCatalogSchemaMigrationShards(sql, { migrationId: "migration-1" })).toEqual([]);
            expect(authSchemaChecks).toBe(1);
        } finally {
            db.close();
        }
    });
});
