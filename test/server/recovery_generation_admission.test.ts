import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import {
    CDB_LIVE_STORE_DDL,
    type StoredSubscriptionRow,
    enqueueRecoveryGenerationInvalidations,
    initializeLiveStore,
    parseStoredSubscription,
    persistLiveSubscription,
    promoteLiveSubscriptionRecoveryGeneration,
} from "../../src/server/do/cdb-live-store.ts";
import { RecoveryAdmissionStore, initializeRecoveryAdmissionStore } from "../../src/server/do/recovery-admission.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";

function sql(db: Database) {
    const storage = {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
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
    return adaptSqlStorage(storage as unknown as SqlStorage);
}

function liveRow(db: Database): StoredSubscriptionRow {
    return db
        .query(
            `SELECT gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                    principal_id, organization_id, authority, schema_epoch, recovery_generation, vshard,
                    domain_schema_epoch, ref, args_json, policy_digest, query_hash, tables_json, intervals_json
             FROM _chardb_live_subscriptions`
        )
        .get() as StoredSubscriptionRow;
}

describe("recovery generation admission", () => {
    test("rejects a held generation-zero side effect after release", () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE effects (id INTEGER PRIMARY KEY)");
        const storage = sql(db);
        initializeRecoveryAdmissionStore(storage);
        const store = new RecoveryAdmissionStore(storage);
        store.arm(OPERATION_ID, 1);
        store.release(OPERATION_ID, 1);

        expect(() =>
            db.transaction(() => {
                store.assertRequest(0);
                db.exec("INSERT INTO effects (id) VALUES (1)");
            })()
        ).toThrow(CdbError);
        expect(db.query("SELECT COUNT(*) AS count FROM effects").get()).toEqual({ count: 0 });
        expect(() => store.assertRequest(1)).not.toThrow();
        db.close();
    });

    test("backfills an exact prior active live row to generation zero", () => {
        const db = new Database(":memory:");
        const priorDdl = CDB_LIVE_STORE_DDL.replace(
            "  recovery_generation INTEGER CHECK (recovery_generation IS NULL OR recovery_generation >= 0),\n",
            ""
        )
            .replace("      AND recovery_generation IS NULL\n", "")
            .replace("      AND recovery_generation IS NOT NULL\n", "");
        db.exec(priorDdl);
        db.exec(`
            INSERT INTO _chardb_live_subscriptions (
              gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
              principal_id, organization_id, authority, schema_epoch, vshard, domain_schema_epoch,
              ref, args_json, policy_digest, query_hash, tables_json, intervals_json
            ) VALUES (
              'gateway-legacy', 'registration-legacy', 'connection-legacy', 'client-legacy', 1, 'active', 'legacy-hash',
              'user-legacy', 'org-legacy', 'organization', 1, 1, 1,
              'queries.ts#legacy', '{"organizationId":"org-legacy"}', 'policy-legacy', 'query-legacy', '[]', '[]'
            )
        `);
        const storage = sql(db);
        initializeLiveStore(storage);

        const restored = parseStoredSubscription(liveRow(db));
        expect(restored.recoveryGeneration).toBe(0);
        expect(restored.organizationId).toBe(TenantId("org-legacy"));
        expect(liveRow(db).payload_hash).not.toBe("legacy-hash");
        db.close();
    });

    test("invalidates a quiet live query and promotes it only after fresh refetch", () => {
        const db = new Database(":memory:");
        db.exec(CDB_LIVE_STORE_DDL);
        const storage = sql(db);
        initializeLiveStore(storage);
        const subscription = {
            subscription: {
                gatewayId: "gateway-1",
                registrationId: "registration-1",
                connectionId: "connection-1",
                clientId: ClientId("client-1"),
                subId: SubId(1),
            },
            principalId: PrincipalId("user-1"),
            organizationId: TenantId("org-1"),
            placement: { authority: "organization" as const, partitionKey: "org-1" },
            schemaEpoch: 1,
            recoveryGeneration: 0,
            vshard: 1,
            domainSchemaEpoch: 1,
            ref: ChardbRef("src/queries.ts#list"),
            args: { organizationId: "org-1" },
            queryHash: "query-hash",
            tables: ["messages"],
            intervals: [],
        };
        expect(persistLiveSubscription(storage, subscription, "policy-digest")).toMatchObject({ ok: true });

        expect(enqueueRecoveryGenerationInvalidations(storage, 1)).toBeGreaterThan(0);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_invalidation_outbox").get()).toEqual({ count: 1 });
        expect(parseStoredSubscription(liveRow(db)).recoveryGeneration).toBe(0);

        promoteLiveSubscriptionRecoveryGeneration(storage, liveRow(db), 1);
        expect(parseStoredSubscription(liveRow(db)).recoveryGeneration).toBe(1);
        expect(() => promoteLiveSubscriptionRecoveryGeneration(storage, liveRow(db), 0)).toThrow(
            "recovery generation regressed"
        );
        db.close();
    });
});
