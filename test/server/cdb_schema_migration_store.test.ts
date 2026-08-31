import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import {
    CDB_SCHEMA_MIGRATION_STORE_DDL,
    CdbSchemaMigrationStore,
} from "../../src/server/do/cdb-schema-migration-store.ts";
import { defineMigrations, migrationDigestAt } from "../../src/server/schema-migrations.ts";

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

function createStore(db: Database): CdbSchemaMigrationStore {
    for (const statement of CDB_SCHEMA_MIGRATION_STORE_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        db.run(statement);
    }
    const storage = {
        sql: sqlStorage(db),
        transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
    } as unknown as DurableObjectStorage;
    return new CdbSchemaMigrationStore(storage);
}

const databases: Database[] = [];

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

describe("Cdb schema migration store", () => {
    test("records an exact version-zero fresh destination without inventing migration steps", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        const journal = defineMigrations([]);
        store.initialize(journal);
        let freshnessChecks = 0;
        let reconciliations = 0;

        const active = store.provisionFresh(
            {
                migrationId: "reshard-dest:empty-v0",
                targetVersion: 0,
                targetEpoch: 1,
                targetDigest: journal.digest,
            },
            journal,
            () => {
                freshnessChecks += 1;
            },
            () => {
                reconciliations += 1;
            }
        );

        expect(active).toMatchObject({
            activeVersion: 0,
            activeEpoch: 1,
            activeDigest: journal.digest,
            lastMigrationId: "reshard-dest:empty-v0",
            status: "active",
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 0 });
        expect(freshnessChecks).toBe(1);
        expect(reconciliations).toBe(1);
    });

    test("provisions an exact journal prefix on a transactionally verified fresh shard", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        const journal = defineMigrations([
            {
                version: 1,
                name: "fresh_base",
                statements: ['CREATE TABLE "fresh_items" ("id" TEXT PRIMARY KEY NOT NULL)'],
            },
            {
                version: 2,
                name: "fresh_value",
                statements: ['ALTER TABLE "fresh_items" ADD COLUMN "value" TEXT'],
            },
            {
                version: 3,
                name: "future_step",
                statements: ['ALTER TABLE "fresh_items" ADD COLUMN "future" TEXT'],
            },
        ]);
        store.initialize(journal);
        let freshnessChecks = 0;
        let reconciliations = 0;

        const active = store.provisionFresh(
            {
                migrationId: "reshard-dest-v2",
                targetVersion: 2,
                targetEpoch: 7,
                targetDigest: migrationDigestAt(journal, 2),
            },
            journal,
            sql => {
                freshnessChecks += 1;
                expect(
                    sql.one("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'fresh_items'")
                ).toBeNull();
            },
            () => {
                reconciliations += 1;
            }
        );

        expect(active).toMatchObject({
            activeVersion: 2,
            activeEpoch: 7,
            activeDigest: migrationDigestAt(journal, 2),
            lastMigrationId: "reshard-dest-v2",
            status: "active",
        });
        expect(db.query('PRAGMA table_info("fresh_items")').all()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "id" }),
                expect.objectContaining({ name: "value" }),
            ])
        );
        expect(db.query('PRAGMA table_info("fresh_items")').all()).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "future" })])
        );
        expect(db.query("SELECT version FROM _chardb_schema_steps ORDER BY version").all()).toEqual([
            { version: 1 },
            { version: 2 },
        ]);
        expect(freshnessChecks).toBe(1);
        expect(reconciliations).toBe(1);

        expect(
            store.provisionFresh(
                {
                    migrationId: "reshard-dest-v2",
                    targetVersion: 2,
                    targetEpoch: 7,
                    targetDigest: migrationDigestAt(journal, 2),
                },
                journal,
                () => {
                    throw new Error("idempotent replay must not rerun the freshness check");
                },
                () => {
                    throw new Error("idempotent replay must not reconcile twice");
                }
            )
        ).toEqual(active);
        expect(() =>
            store.provisionFresh(
                {
                    migrationId: "schema-migration-id-collision",
                    targetVersion: 2,
                    targetEpoch: 7,
                    targetDigest: migrationDigestAt(journal, 2),
                },
                journal,
                () => {
                    throw new Error("wrong-id replay must not reach freshness callback");
                },
                () => void 0
            )
        ).toThrow("Cdb is not an unprovisioned fresh shard");
    });

    test("rolls back fresh provisioning when freshness or reconciliation fails", () => {
        for (const failure of ["freshness", "reconciliation"] as const) {
            const db = new Database(":memory:");
            databases.push(db);
            const store = createStore(db);
            const journal = defineMigrations([
                {
                    version: 1,
                    name: `fresh_${failure}`,
                    statements: ['CREATE TABLE "fresh_rollback" ("id" TEXT PRIMARY KEY NOT NULL)'],
                },
            ]);
            store.initialize(journal);
            expect(() =>
                store.provisionFresh(
                    {
                        migrationId: `reshard-${failure}`,
                        targetVersion: 1,
                        targetEpoch: 9,
                        targetDigest: journal.digest,
                    },
                    journal,
                    () => {
                        if (failure === "freshness") throw new Error("not fresh");
                    },
                    () => {
                        if (failure === "reconciliation") throw new Error("schema mismatch");
                    }
                )
            ).toThrow();
            expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'fresh_rollback'").get()).toBeNull();
            expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 0 });
            expect(store.state()).toMatchObject({ activeVersion: 0, activeEpoch: 1, status: "active" });
        }
    });

    test("refuses to provision over existing migration evidence", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        const journal = defineMigrations([
            {
                version: 1,
                name: "fresh_reject",
                statements: ['CREATE TABLE "fresh_reject" ("id" TEXT PRIMARY KEY NOT NULL)'],
            },
        ]);
        store.initialize(journal);
        const migration = journal.migrations[0];
        if (!migration) throw new Error("expected packaged migration");
        db.query(
            "INSERT INTO _chardb_schema_steps (migration_id, version, digest, applied_at) VALUES (?, 1, ?, 0)"
        ).run("stale-attempt", migration.digest);

        expect(() =>
            store.provisionFresh(
                {
                    migrationId: "reshard-fresh-reject",
                    targetVersion: 1,
                    targetEpoch: 2,
                    targetDigest: journal.digest,
                },
                journal,
                () => void 0,
                () => void 0
            )
        ).toThrow(expect.objectContaining({ code: "CDB_PARTITION_CONTRACT_CHANGED" }));
        expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'fresh_reject'").get()).toBeNull();
    });

    test("coordinates prepare, ordered apply, activation, replay, and epoch fencing", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        const journal = defineMigrations([
            {
                version: 1,
                name: "store_probe",
                statements: [
                    'CREATE TABLE "store_probe" ("id" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)',
                    `INSERT INTO "store_probe" ("id", "value") VALUES ('probe', 'applied')`,
                ],
            },
        ]);
        expect(store.initialize(journal)).toEqual({ ensureDomainTables: false });
        expect(store.state()).toMatchObject({ activeVersion: 0, activeEpoch: 1, status: "active" });
        expect(() => store.assertActiveEpoch(1, () => journal)).toThrow(
            expect.objectContaining({ code: "CDB_STALE_EPOCH" })
        );

        const prepared = store.prepare(
            {
                migrationId: "store-v1",
                activeVersion: 0,
                activeDigest: migrationDigestAt(journal, 0),
                targetVersion: 1,
                targetEpoch: 2,
                targetDigest: journal.digest,
            },
            journal
        );
        expect(prepared).toMatchObject({ status: "migrating", migrationId: "store-v1", targetEpoch: 2 });
        expect(store.apply({ migrationId: "store-v1", version: 1 }, journal)).toMatchObject({
            status: "migrating",
        });
        expect(store.apply({ migrationId: "store-v1", version: 1 }, journal)).toMatchObject({
            status: "migrating",
        });
        expect(db.query('SELECT id, value FROM "store_probe"').all()).toEqual([{ id: "probe", value: "applied" }]);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 1 });

        let reconciliations = 0;
        const active = store.activate(
            { migrationId: "store-v1" },
            () => journal,
            () => {
                reconciliations += 1;
            }
        );
        expect(active).toMatchObject({ activeVersion: 1, activeEpoch: 2, status: "active" });
        expect(
            store.activate(
                { migrationId: "store-v1" },
                () => journal,
                () => void 0
            )
        ).toEqual(active);
        expect(reconciliations).toBe(1);
        expect(store.assertActiveEpoch(2, () => journal)).toEqual(active);
        expect(() => store.assertActiveEpoch(1, () => journal)).toThrow(
            expect.objectContaining({ code: "CDB_STALE_EPOCH" })
        );
    });

    test("rolls back migration SQL and its journal step together", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        const journal = defineMigrations([
            {
                version: 1,
                name: "broken_store_step",
                statements: [
                    'CREATE TABLE "rolled_back_probe" ("id" TEXT PRIMARY KEY NOT NULL)',
                    'INSERT INTO "missing_probe" ("id") VALUES (1)',
                ],
            },
        ]);
        store.initialize(journal);
        store.prepare(
            {
                migrationId: "broken-v1",
                activeVersion: 0,
                activeDigest: migrationDigestAt(journal, 0),
                targetVersion: 1,
                targetEpoch: 2,
                targetDigest: journal.digest,
            },
            journal
        );

        expect(() => store.apply({ migrationId: "broken-v1", version: 1 }, journal)).toThrow();
        expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'rolled_back_probe'").get()).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 0 });
        expect(store.state()).toMatchObject({ status: "migrating", migrationId: "broken-v1" });
    });

    test("rolls back domain reconciliation with a failed activation", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        db.run('CREATE TABLE "domain_reconciliation" ("id" TEXT PRIMARY KEY NOT NULL)');
        const journal = defineMigrations([
            {
                version: 1,
                name: "activation_probe",
                statements: ['CREATE TABLE "activation_probe" ("id" TEXT PRIMARY KEY NOT NULL)'],
            },
        ]);
        store.initialize(journal);
        store.prepare(
            {
                migrationId: "activation-v1",
                activeVersion: 0,
                activeDigest: migrationDigestAt(journal, 0),
                targetVersion: 1,
                targetEpoch: 2,
                targetDigest: journal.digest,
            },
            journal
        );
        store.apply({ migrationId: "activation-v1", version: 1 }, journal);

        expect(() =>
            store.activate(
                { migrationId: "activation-v1" },
                () => journal,
                sql => {
                    sql.exec('INSERT INTO "domain_reconciliation" ("id") VALUES (?)', "rolled-back");
                    throw new CdbError({ code: "CDB_PARTITION_CONTRACT_CHANGED", message: "domain schema mismatch" });
                }
            )
        ).toThrow(expect.objectContaining({ code: "CDB_PARTITION_CONTRACT_CHANGED" }));
        expect(db.query('SELECT * FROM "domain_reconciliation"').all()).toEqual([]);
        expect(store.state()).toMatchObject({ status: "migrating", migrationId: "activation-v1" });
    });
});
