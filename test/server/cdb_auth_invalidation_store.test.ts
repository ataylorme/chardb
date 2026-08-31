import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    CDB_AUTH_INVALIDATION_SCOPE_LIMIT,
    CdbAuthInvalidationStore,
    initializeCdbAuthInvalidationStore,
} from "../../src/server/do/cdb-auth-invalidation-store.ts";
import { CDB_LIVE_STORE_DDL } from "../../src/server/do/cdb-live-store.ts";
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

function addSubscription(
    db: Database,
    registrationId: string,
    principalId: string,
    organizationId: string,
    gatewayId = "gateway-a"
): void {
    db.prepare(
        `INSERT INTO _chardb_live_subscriptions
          (gateway_id, registration_id, connection_id, client_id, sub_id, state,
           payload_hash, principal_id, organization_id, authority, schema_epoch, vshard,
           domain_schema_epoch, ref, args_json, policy_digest, query_hash, tables_json, intervals_json)
         VALUES (?, ?, ?, ?, 1, 'active', 'payload', ?, ?, 'organization', 1, 0, 1,
                 'messages.list', '{}', 'policy', 'query', '[]', '{}')`
    ).run(
        gatewayId,
        registrationId,
        `connection-${registrationId}`,
        `client-${registrationId}`,
        principalId,
        organizationId
    );
}

describe("Cdb auth invalidation store", () => {
    let db: Database;
    let store: CdbAuthInvalidationStore;

    beforeEach(() => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        executeDdl(db, CDB_LIVE_STORE_DDL);
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCdbAuthInvalidationStore(sql);
        store = new CdbAuthInvalidationStore(sql);
        addSubscription(db, "org-a-user-a", "user-a", "org-a");
        addSubscription(db, "org-a-user-b", "user-b", "org-a");
        addSubscription(db, "org-b-user-a", "user-a", "org-b", "gateway-b");
        addSubscription(db, "org-b-user-c", "user-c", "org-b", "gateway-b");
    });

    afterEach(() => db.close());

    test("dirties only active registrations matching an exact tenant or principal scope", () => {
        const tenant = store.apply({ scope: "tenant", scopeId: "org-a", epoch: 2 }, 100);
        expect(tenant).toMatchObject({ registrations: 2, changeSeq: 1 });
        expect(
            db.query("SELECT registration_id FROM _chardb_invalidation_outbox ORDER BY registration_id").all()
        ).toEqual([{ registration_id: "org-a-user-a" }, { registration_id: "org-a-user-b" }]);

        db.run("DELETE FROM _chardb_invalidation_outbox");
        const principal = store.apply({ scope: "principal", scopeId: "user-a", epoch: 3 }, 200);
        expect(principal).toMatchObject({ registrations: 2, changeSeq: 2 });
        expect(
            db.query("SELECT registration_id FROM _chardb_invalidation_outbox ORDER BY registration_id").all()
        ).toEqual([{ registration_id: "org-a-user-a" }, { registration_id: "org-b-user-a" }]);
    });

    test("global scope reaches every active registration without broadening scoped work", () => {
        expect(store.apply({ scope: "global", scopeId: "global", epoch: 4 }, 100)).toMatchObject({
            registrations: 4,
            changeSeq: 1,
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_invalidation_outbox").get()).toEqual({ count: 4 });
    });

    test("a fresh destination records a zero-impact epoch without advancing its change clock", () => {
        db.run("DELETE FROM _chardb_live_subscriptions");
        expect(store.apply({ scope: "principal", scopeId: "user-before-provision", epoch: 2 }, 100)).toMatchObject({
            registrations: 0,
            changeSeq: 0,
        });
        expect(db.query("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1").get()).toEqual({
            change_seq: 0,
        });
    });

    test("reconstructs exact results after eviction and rejects delayed older epochs", () => {
        const request = { scope: "tenant" as const, scopeId: "org-a", epoch: 5 };
        const first = store.apply(request, 100);
        const retry = new CdbAuthInvalidationStore(store.sql).apply(request, 200);
        const delayed = new CdbAuthInvalidationStore(store.sql).apply({ ...request, epoch: 4 }, 300);
        expect(retry).toEqual(first);
        expect(delayed).toMatchObject({ epoch: 5, registrations: 2, changeSeq: 1 });
        expect(db.query("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1").get()).toEqual({
            change_seq: 1,
        });
    });

    test("never reflects extra transport fields into its response contract", () => {
        const request = {
            scope: "tenant" as const,
            scopeId: "org-a",
            epoch: 2,
            shardId: "ShardDO_0",
            attempts: 7,
            lastError: "must not cross the RPC boundary",
        };
        const result = store.apply(request, 100);
        expect(Object.keys(result).sort()).toEqual([
            "accepted",
            "changeSeq",
            "epoch",
            "registrations",
            "scope",
            "scopeId",
        ]);
        expect(result).toEqual({
            scope: "tenant",
            scopeId: "org-a",
            epoch: 2,
            accepted: true,
            registrations: 2,
            changeSeq: 1,
        });
    });

    test("rolls the watermark and existing outbox back with the surrounding transaction", () => {
        expect(() =>
            db.transaction(() => {
                store.apply({ scope: "tenant", scopeId: "org-a", epoch: 2 }, 100);
                throw new Error("lost transaction");
            })()
        ).toThrow("lost transaction");
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_auth_invalidation_epochs").get()).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_invalidation_outbox").get()).toEqual({ count: 0 });
        expect(db.query("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1").get()).toEqual({
            change_seq: 0,
        });
    });

    test("compacts inactive scope history before admitting new active work at the limit", () => {
        db.run("DELETE FROM _chardb_live_subscriptions");
        const insert = db.prepare(
            `INSERT INTO _chardb_auth_invalidation_epochs
              (scope, scope_id, epoch, change_seq, registrations, updated_at)
             VALUES ('tenant', ?, 1, 0, 0, 0)`
        );
        db.transaction(() => {
            for (let index = 0; index < CDB_AUTH_INVALIDATION_SCOPE_LIMIT; index++) insert.run(`full-${index}`);
        })();
        addSubscription(db, "overflow", "user-overflow", "org-overflow");
        expect(() => store.apply({ scope: "tenant", scopeId: "org-overflow", epoch: 2 }, 100)).not.toThrow();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_auth_invalidation_epochs").get()).toEqual({ count: 1 });

        db.run("UPDATE _chardb_live_subscriptions SET organization_id = 'org-second'");
        db.run("DELETE FROM _chardb_auth_invalidation_epochs");
        db.transaction(() => {
            for (let index = 0; index < CDB_AUTH_INVALIDATION_SCOPE_LIMIT; index++) insert.run(`full-${index}`);
        })();
        db.run("UPDATE _chardb_live_subscriptions SET organization_id = 'full-0'");
        expect(() => store.apply({ scope: "tenant", scopeId: "full-0", epoch: 2 }, 200)).not.toThrow();
    });
});
