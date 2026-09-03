import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
    CdbAuthInvalidationStore,
    initializeCdbAuthInvalidationStore,
} from "../../src/server/do/cdb-auth-invalidation-store.ts";
import {
    assertFreshReshardDestination,
    assertUnusedVersionZeroReshardDestination,
} from "../../src/server/do/cdb-fresh-reshard-destination.ts";
import { CDB_LIVE_STORE_DDL } from "../../src/server/do/cdb-live-store.ts";
import { initializeCdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import { initializeRecoveryAdmissionStore } from "../../src/server/do/recovery-admission.ts";
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

function executeDdl(db: Database, ddl: string): void {
    for (const statement of ddl
        .split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        db.run(statement);
    }
}

describe("fresh reshard destination proof", () => {
    const databases: Database[] = [];
    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("accepts only empty internal state, including unknown future tables", () => {
        for (const evidence of [
            "domain",
            "oplog",
            "live",
            "file",
            "file-tombstone",
            "split",
            "split-applied",
            "barrier",
            "distributed-transaction",
            "subscription-mapping",
            "domain-registry",
            "future-internal",
        ] as const) {
            const db = new Database(":memory:");
            databases.push(db);
            db.exec(`
                CREATE TABLE _chardb_domain_schema (table_name TEXT, signature TEXT);
                CREATE TABLE _chardb_op_log (event_id INTEGER);
                CREATE TABLE _chardb_live_subscriptions (registration_id TEXT);
                CREATE TABLE _chardb_live_subscription_tables (registration_id TEXT);
                CREATE TABLE _chardb_split_state (mig_id TEXT);
                CREATE TABLE _chardb_split_oplog_applied (mig_id TEXT);
                CREATE TABLE _chardb_files (file_id TEXT);
                CREATE TABLE _chardb_deleted_organizations (organization_id TEXT);
                CREATE TABLE _chardb_barrier (barrier_id TEXT);
                CREATE TABLE _chardb_dt_state (dt_id TEXT);
                CREATE TABLE _chardb_auth_invalidation_epochs (
                  scope TEXT,
                  scope_id TEXT,
                  epoch INTEGER,
                  change_seq INTEGER,
                  registrations INTEGER,
                  updated_at INTEGER
                );
                CREATE TABLE _chardb_future_evidence (id TEXT);
            `);
            const sql = adaptSqlStorage(sqlStorage(db));
            db.run("INSERT INTO _chardb_auth_invalidation_epochs VALUES ('tenant', 'org-a', 2, 0, 0, 1)");
            expect(() => assertFreshReshardDestination(sql)).not.toThrow();
            if (evidence === "domain") db.exec("CREATE TABLE app_rows (id TEXT)");
            if (evidence === "oplog") db.run("INSERT INTO _chardb_op_log VALUES (1)");
            if (evidence === "live") db.run("INSERT INTO _chardb_live_subscriptions VALUES ('r')");
            if (evidence === "file") db.run("INSERT INTO _chardb_files VALUES ('f')");
            if (evidence === "file-tombstone") db.run("INSERT INTO _chardb_deleted_organizations VALUES ('o')");
            if (evidence === "split") db.run("INSERT INTO _chardb_split_state VALUES ('s')");
            if (evidence === "split-applied") db.run("INSERT INTO _chardb_split_oplog_applied VALUES ('s')");
            if (evidence === "barrier") db.run("INSERT INTO _chardb_barrier VALUES ('b')");
            if (evidence === "distributed-transaction") db.run("INSERT INTO _chardb_dt_state VALUES ('d')");
            if (evidence === "subscription-mapping") {
                db.run("INSERT INTO _chardb_live_subscription_tables VALUES ('r')");
            }
            if (evidence === "domain-registry") {
                db.run("INSERT INTO _chardb_domain_schema VALUES ('ghost', 'sig')");
            }
            if (evidence === "future-internal") db.run("INSERT INTO _chardb_future_evidence VALUES ('x')");
            expect(() => assertFreshReshardDestination(sql)).toThrow("reshard destination is not fresh");
        }
    });

    test("rejects auth invalidation state that has affected live delivery", () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(`
            CREATE TABLE _chardb_auth_invalidation_epochs (
              scope TEXT,
              scope_id TEXT,
              epoch INTEGER,
              change_seq INTEGER,
              registrations INTEGER,
              updated_at INTEGER
            );
            INSERT INTO _chardb_auth_invalidation_epochs VALUES ('global', 'global', 2, 1, 1, 1);
        `);
        expect(() => assertFreshReshardDestination(adaptSqlStorage(sqlStorage(db)))).toThrow(
            "_chardb_auth_invalidation_epochs"
        );
    });

    test("accepts only an open recovery admission clock", () => {
        const create = () => {
            const db = new Database(":memory:");
            databases.push(db);
            const sql = adaptSqlStorage(sqlStorage(db));
            initializeRecoveryAdmissionStore(sql);
            return { db, sql };
        };

        const initial = create();
        expect(() => assertFreshReshardDestination(initial.sql)).not.toThrow();

        const advanced = create();
        advanced.db.run("UPDATE _chardb_recovery_admission SET generation = 7");
        expect(() => assertFreshReshardDestination(advanced.sql)).not.toThrow();

        for (const statement of [
            "UPDATE _chardb_recovery_admission SET state = 'blocked', operation_id = '00000000-0000-4000-8000-000000000000'",
            "UPDATE _chardb_recovery_admission SET state = 'released', operation_id = '00000000-0000-4000-8000-000000000000'",
            "INSERT INTO _chardb_recovery_admission VALUES (2, 0, NULL, 'open')",
        ]) {
            const unsafe = create();
            if (statement.startsWith("INSERT")) {
                unsafe.db.exec(`
                    DROP TABLE _chardb_recovery_admission;
                    CREATE TABLE _chardb_recovery_admission (
                      singleton INTEGER, generation INTEGER, operation_id TEXT, state TEXT
                    );
                    INSERT INTO _chardb_recovery_admission VALUES (1, 0, NULL, 'open');
                `);
            }
            unsafe.db.run(statement);
            expect(() => assertFreshReshardDestination(unsafe.sql)).toThrow("_chardb_recovery_admission");
        }

        const drifted = create();
        drifted.db.exec(`
            DROP TABLE _chardb_recovery_admission;
            CREATE TABLE _chardb_recovery_admission (
              singleton INTEGER, generation INTEGER, operation_id TEXT, state TEXT, unexpected INTEGER
            );
            INSERT INTO _chardb_recovery_admission VALUES (1, 0, NULL, 'open', 0);
        `);
        expect(() => assertFreshReshardDestination(drifted.sql)).toThrow("_chardb_recovery_admission");
    });

    test("accepts only the exact pristine external file-capture singleton", () => {
        const create = (ddl: string) => {
            const db = new Database(":memory:");
            databases.push(db);
            db.exec(ddl);
            return { db, sql: adaptSqlStorage(sqlStorage(db)) };
        };
        const ddl = `
            CREATE TABLE _chardb_split_capture_tx (
              singleton INTEGER PRIMARY KEY,
              next_id INTEGER NOT NULL,
              active_id INTEGER,
              active_vshard INTEGER
            );
            INSERT INTO _chardb_split_capture_tx VALUES (1, 0, NULL, NULL);
        `;
        const pristine = create(ddl);
        expect(() => assertFreshReshardDestination(pristine.sql)).not.toThrow();

        const advanced = create(ddl);
        advanced.db.run("UPDATE _chardb_split_capture_tx SET next_id = 1");
        expect(() => assertFreshReshardDestination(advanced.sql)).toThrow("_chardb_split_capture_tx");

        const active = create(ddl);
        active.db.run("UPDATE _chardb_split_capture_tx SET active_id = -1, active_vshard = 7");
        expect(() => assertFreshReshardDestination(active.sql)).toThrow("_chardb_split_capture_tx");

        const extra = create(ddl);
        extra.db.run("INSERT INTO _chardb_split_capture_tx VALUES (2, 0, NULL, NULL)");
        expect(() => assertFreshReshardDestination(extra.sql)).toThrow("_chardb_split_capture_tx");

        const drifted = create(`
            CREATE TABLE _chardb_split_capture_tx (
              singleton INTEGER PRIMARY KEY,
              next_id INTEGER NOT NULL,
              active_id INTEGER,
              active_vshard INTEGER,
              unexpected INTEGER
            );
            INSERT INTO _chardb_split_capture_tx VALUES (1, 0, NULL, NULL, 0);
        `);
        expect(() => assertFreshReshardDestination(drifted.sql)).toThrow("_chardb_split_capture_tx");
    });

    test("accepts only exact zero-impact vector runtime singletons", () => {
        const create = () => {
            const db = new Database(":memory:");
            databases.push(db);
            const sql = adaptSqlStorage(sqlStorage(db));
            initializeCdbVectorOutboxStore(sql);
            return { db, sql };
        };

        const pristine = create();
        expect(() => assertFreshReshardDestination(pristine.sql)).not.toThrow();

        for (const statement of [
            "UPDATE _chardb_vector_capacity SET reconciled = 0",
            "UPDATE _chardb_vector_capacity SET head_count = 1",
            "UPDATE _chardb_vector_capacity SET stored_bytes = 1",
            "UPDATE _chardb_vector_capacity SET outbox_rows = 1",
            "UPDATE _chardb_vector_capacity SET attempt_rows = 1",
            "UPDATE _chardb_vector_scheduler SET next_vshard = 1",
            "UPDATE _chardb_vector_head_sequence SET last_seq = 1",
        ]) {
            const changed = create();
            changed.db.run(statement);
            expect(() => assertFreshReshardDestination(changed.sql)).toThrow("reshard destination is not fresh");
        }

        const missing = create();
        missing.db.run("DELETE FROM _chardb_vector_scheduler");
        expect(() => assertFreshReshardDestination(missing.sql)).toThrow("_chardb_vector_scheduler");

        const drifted = create();
        drifted.db.exec(`
            DROP TABLE _chardb_vector_head_sequence;
            CREATE TABLE _chardb_vector_head_sequence (
              singleton INTEGER PRIMARY KEY,
              last_seq INTEGER NOT NULL,
              unexpected INTEGER NOT NULL
            );
            INSERT INTO _chardb_vector_head_sequence VALUES (1, 0, 0);
        `);
        expect(() => assertFreshReshardDestination(drifted.sql)).toThrow("_chardb_vector_head_sequence");

        const extra = create();
        extra.db.exec(`
            DROP TABLE _chardb_vector_scheduler;
            CREATE TABLE _chardb_vector_scheduler (singleton INTEGER, next_vshard INTEGER);
            INSERT INTO _chardb_vector_scheduler VALUES (1, 0), (1, 0);
        `);
        expect(() => assertFreshReshardDestination(extra.sql)).toThrow("_chardb_vector_scheduler");
    });

    test("preserves zero-impact destination auth epochs and invalidates only post-cutover live state", () => {
        const db = new Database(":memory:");
        databases.push(db);
        executeDdl(db, CDB_LIVE_STORE_DDL);
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCdbAuthInvalidationStore(sql);
        const request = { recoveryGeneration: 0, scope: "tenant" as const, scopeId: "org-moving", epoch: 5 };
        expect(new CdbAuthInvalidationStore(sql).apply(request, 100)).toMatchObject({
            recoveryGeneration: 0,
            epoch: 5,
            registrations: 0,
            changeSeq: 0,
        });
        expect(() => assertFreshReshardDestination(sql)).not.toThrow();
        expect(new CdbAuthInvalidationStore(sql).apply({ ...request, epoch: 4 }, 101)).toMatchObject({
            epoch: 5,
            registrations: 0,
            changeSeq: 0,
        });

        db.prepare(
            `INSERT INTO _chardb_live_subscriptions
              (gateway_id, registration_id, connection_id, client_id, sub_id, state,
               payload_hash, principal_id, organization_id, authority, schema_epoch, recovery_generation, vshard,
               domain_schema_epoch, ref, args_json, policy_digest, query_hash, tables_json, intervals_json)
             VALUES ('gateway-dest', 'registration-dest', 'connection-dest', 'client-dest', 1, 'active',
                     'payload', 'user-dest', 'org-moving', 'organization', 2, 0, 0, 1,
                     'messages.list', '{}', 'policy', 'query', '[]', '[]')`
        ).run();
        expect(new CdbAuthInvalidationStore(sql).apply({ ...request, epoch: 6 }, 102)).toMatchObject({
            epoch: 6,
            registrations: 1,
            changeSeq: 1,
        });
        expect(
            db.query("SELECT gateway_id, registration_id, change_seq FROM _chardb_invalidation_outbox").all()
        ).toEqual([{ gateway_id: "gateway-dest", registration_id: "registration-dest", change_seq: 1 }]);
    });

    test("accepts only an unused exact packaged version-zero domain layout", () => {
        const create = () => {
            const db = new Database(":memory:");
            databases.push(db);
            db.exec(`
                CREATE TABLE app_rows (id TEXT PRIMARY KEY);
                CREATE TABLE _chardb_domain_schema (table_name TEXT PRIMARY KEY, signature TEXT NOT NULL);
                INSERT INTO _chardb_domain_schema VALUES ('app_rows', 'sig-1');
                CREATE TABLE _chardb_change_clock (singleton INTEGER PRIMARY KEY, change_seq INTEGER NOT NULL);
                INSERT INTO _chardb_change_clock VALUES (1, 0);
                CREATE TABLE _chardb_op_log (event_id INTEGER);
            `);
            return { db, sql: adaptSqlStorage(sqlStorage(db)) };
        };
        const expected = [{ tableName: "app_rows", signature: "sig-1" }] as const;
        const fresh = create();
        expect(() => assertUnusedVersionZeroReshardDestination(fresh.sql, expected)).not.toThrow();

        const used = create();
        used.db.run("INSERT INTO app_rows VALUES ('used')");
        expect(() => assertUnusedVersionZeroReshardDestination(used.sql, expected)).toThrow("domain table app_rows");

        const deleted = create();
        deleted.db.run("UPDATE _chardb_change_clock SET change_seq = 1");
        expect(() => assertUnusedVersionZeroReshardDestination(deleted.sql, expected)).toThrow("change clock");

        const extra = create();
        extra.db.run("CREATE TABLE unexpected_rows (id TEXT)");
        expect(() => assertUnusedVersionZeroReshardDestination(extra.sql, expected)).toThrow(
            "physical domain registry differs"
        );
    });
});
