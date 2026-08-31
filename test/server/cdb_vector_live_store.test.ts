import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    CDB_LIVE_STORE_DDL,
    assertLiveVectorDependencies,
    assertLiveVectorSubscriptionDependency,
    enqueueVectorResourceInvalidations,
    finalizeRetiredLiveSubscription,
    initializeLiveStore,
    persistLiveSubscription,
    persistLiveSubscriptionWithVectorDependency,
    retireLiveSubscription,
} from "../../src/server/do/cdb-live-store.ts";
import type { CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";

function syncSql(db: Database): SyncSql {
    return {
        exec(query, ...params) {
            db.run(query, params as never[]);
        },
        one<T>(query: string, ...params: never[]): T | null {
            return (db.query(query).get(...params) as T | null) ?? null;
        },
        all<T>(query: string, ...params: never[]): T[] {
            return db.query(query).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS count").get() as { count: number }).count);
        },
    };
}

function initialize(sql: SyncSql): void {
    for (const statement of CDB_LIVE_STORE_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
    initializeLiveStore(sql);
}

function persistVector(
    db: Database,
    sql: SyncSql,
    args: CdbSubscriptionRequest,
    policyDigest: string,
    resourceId: string
) {
    return db.transaction(() => persistLiveSubscriptionWithVectorDependency(sql, args, policyDigest, resourceId))();
}

function identity(registrationId: string, subId: number): LiveSubscriptionId {
    return {
        gatewayId: "gateway-1",
        registrationId,
        connectionId: `connection-${registrationId}`,
        clientId: ClientId("client-1"),
        subId: SubId(subId),
    };
}

function subscription(registrationId: string, subId: number): CdbSubscriptionRequest {
    return {
        subscription: identity(registrationId, subId),
        principalId: PrincipalId("user-1"),
        organizationId: TenantId("org-1"),
        placement: { authority: "organization", partitionKey: "org-1" },
        schemaEpoch: 1,
        vshard: 1,
        domainSchemaEpoch: 1,
        ref: ChardbRef("queries.ts#vectorSearch"),
        args: {},
        queryHash: "vector-query-hash",
        tables: ["messages"],
        intervals: [],
    };
}

const RESOURCE_A = `vr1_${"a".repeat(64)}`;
const RESOURCE_B = `vr1_${"b".repeat(64)}`;

describe("Cdb live vector dependencies", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("persists one exact dependency and reconstructs it without broadening SQL registrations", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initialize(sql);
        const vector = subscription("vector-a", 1);
        const ordinary = subscription("ordinary", 2);
        expect(persistVector(db, sql, vector, "policy-1", RESOURCE_A)).toMatchObject({ ok: true });
        expect(persistVector(db, sql, vector, "policy-1", RESOURCE_A)).toMatchObject({ ok: true });
        expect(persistLiveSubscription(sql, ordinary, "policy-1")).toMatchObject({ ok: true });
        expect(
            db
                .query(
                    `SELECT gateway_id, registration_id, resource_id
                 FROM _chardb_live_subscription_vectors ORDER BY registration_id`
                )
                .all()
        ).toEqual([{ gateway_id: "gateway-1", registration_id: "vector-a", resource_id: RESOURCE_A }]);

        initializeLiveStore(sql);
        expect(() => assertLiveVectorDependencies(sql, [RESOURCE_A, RESOURCE_B])).not.toThrow();
        expect(() => assertLiveVectorDependencies(sql, [RESOURCE_B])).toThrow(
            expect.objectContaining({ code: "CDB_PARTITION_CONTRACT_CHANGED" })
        );
        expect(() => assertLiveVectorSubscriptionDependency(sql, vector.subscription, RESOURCE_A)).not.toThrow();
        expect(() => assertLiveVectorSubscriptionDependency(sql, vector.subscription, null)).toThrow(
            /ordinary registered query retained a vector dependency/
        );
        expect(() => assertLiveVectorSubscriptionDependency(sql, ordinary.subscription, null)).not.toThrow();
        expect(() => assertLiveVectorSubscriptionDependency(sql, ordinary.subscription, RESOURCE_A)).toThrow(
            /dependency does not match its compiled plan/
        );
        expect(() => persistVector(db, sql, vector, "policy-1", RESOURCE_B)).toThrow(/changed across an RPC replay/);
        expect(() => persistVector(db, sql, subscription("bad", 3), "policy-1", "resource-a")).toThrow(
            /resource id is invalid/
        );
        expect(
            db.query("SELECT 1 AS present FROM _chardb_live_subscriptions WHERE registration_id = 'bad'").get()
        ).toBeNull();
    });

    test("rolls back the ordinary registration and table mappings when vector persistence fails", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initialize(sql);
        const vector = subscription("atomic-failure", 1);
        const failingSql: SyncSql = {
            ...sql,
            exec(query, ...params) {
                if (query.includes("INSERT INTO _chardb_live_subscription_vectors")) {
                    throw new Error("injected vector mapping failure");
                }
                sql.exec(query, ...params);
            },
        };

        expect(() =>
            db.transaction(() =>
                persistLiveSubscriptionWithVectorDependency(failingSql, vector, "policy-1", RESOURCE_A)
            )()
        ).toThrow("injected vector mapping failure");
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_live_subscriptions").get()).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_live_subscription_tables").get()).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_live_subscription_vectors").get()).toEqual({ count: 0 });
    });

    test("keeps the exact persisted registration unchanged after replay mismatches", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initialize(sql);
        const vector = subscription("atomic-replay", 1);
        persistVector(db, sql, vector, "policy-1", RESOURCE_A);
        const snapshot = () => ({
            subscription: db
                .query(
                    `SELECT payload_hash, args_json, policy_digest, query_hash, tables_json, intervals_json
                     FROM _chardb_live_subscriptions WHERE registration_id = 'atomic-replay'`
                )
                .get(),
            tables: db
                .query(
                    `SELECT table_name FROM _chardb_live_subscription_tables
                     WHERE registration_id = 'atomic-replay' ORDER BY table_name`
                )
                .all(),
            vector: db
                .query(
                    `SELECT resource_id FROM _chardb_live_subscription_vectors
                     WHERE registration_id = 'atomic-replay'`
                )
                .get(),
        });
        const before = snapshot();

        expect(() => persistVector(db, sql, { ...vector, args: { changed: true } }, "policy-1", RESOURCE_A)).toThrow(
            /payload changed across an RPC replay/
        );
        expect(snapshot()).toEqual(before);
        expect(() => persistVector(db, sql, vector, "policy-1", RESOURCE_B)).toThrow(
            /dependency changed across an RPC replay/
        );
        expect(snapshot()).toEqual(before);
    });

    test("returns an absent capacity result without persisting either half", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initialize(sql);
        const retired = db.prepare(
            `INSERT INTO _chardb_live_subscriptions
               (gateway_id, registration_id, connection_id, client_id, sub_id, state)
             VALUES ('capacity-gateway', ?, ?, 'capacity-client', ?, 'retired')`
        );
        db.transaction(() => {
            for (let index = 0; index < 8_192; index++) {
                retired.run(`retired-${index}`, `connection-${index}`, index);
            }
        })();

        expect(persistVector(db, sql, subscription("over-capacity", 9_000), "policy-1", RESOURCE_A)).toMatchObject({
            ok: false,
            registrationState: "absent",
            error: { code: "CDB_RATE_LIMITED" },
        });
        expect(
            db
                .query(
                    `SELECT 1 AS present FROM _chardb_live_subscriptions
                     WHERE gateway_id = 'gateway-1' AND registration_id = 'over-capacity'`
                )
                .get()
        ).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_live_subscription_vectors").get()).toEqual({ count: 0 });
    });

    test("enqueues only exact vector subscribers and deduplicates their durable outbox row", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initialize(sql);
        const vectorA = subscription("vector-a", 1);
        const vectorB = subscription("vector-b", 2);
        persistVector(db, sql, vectorA, "policy-1", RESOURCE_A);
        persistVector(db, sql, vectorB, "policy-1", RESOURCE_B);
        persistLiveSubscription(sql, subscription("ordinary", 3), "policy-1");

        expect(enqueueVectorResourceInvalidations(sql, RESOURCE_A)).toEqual({ registrations: 1, changeSeq: 1 });
        expect(enqueueVectorResourceInvalidations(sql, RESOURCE_A)).toEqual({ registrations: 1, changeSeq: 2 });
        expect(enqueueVectorResourceInvalidations(sql, RESOURCE_B)).toEqual({ registrations: 1, changeSeq: 3 });
        expect(
            db
                .query(
                    `SELECT registration_id, change_seq FROM _chardb_invalidation_outbox
                 ORDER BY registration_id`
                )
                .all()
        ).toEqual([
            { registration_id: "vector-a", change_seq: 2 },
            { registration_id: "vector-b", change_seq: 3 },
        ]);
        expect(enqueueVectorResourceInvalidations(sql, `vr1_${"c".repeat(64)}`)).toEqual({
            registrations: 0,
            changeSeq: 3,
        });

        retireLiveSubscription(sql, vectorA.subscription);
        expect(
            db.query("SELECT resource_id FROM _chardb_live_subscription_vectors ORDER BY resource_id").all()
        ).toEqual([{ resource_id: RESOURCE_B }]);
        expect(
            db.query("SELECT registration_id FROM _chardb_invalidation_outbox ORDER BY registration_id").all()
        ).toEqual([{ registration_id: "vector-b" }]);
    });

    test("finalizes a retired subscription tombstone with its exact identity", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initialize(sql);
        const vector = subscription("vector-finalized", 1);
        persistVector(db, sql, vector, "policy-1", RESOURCE_A);

        retireLiveSubscription(sql, vector.subscription);
        expect(
            db
                .query("SELECT state FROM _chardb_live_subscriptions WHERE registration_id = ?")
                .get(vector.subscription.registrationId)
        ).toEqual({ state: "retired" });

        expect(() => finalizeRetiredLiveSubscription(sql, vector.subscription)).not.toThrow();
        expect(
            db
                .query("SELECT state FROM _chardb_live_subscriptions WHERE registration_id = ?")
                .get(vector.subscription.registrationId)
        ).toBeNull();
        expect(() => finalizeRetiredLiveSubscription(sql, vector.subscription)).not.toThrow();
    });

    test("rejects exact vector fanout before advancing the clock when the invalidation outbox is full", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const sql = syncSql(db);
        initialize(sql);
        persistVector(db, sql, subscription("vector-target", 1), "policy-1", RESOURCE_A);
        const retired = db.prepare(
            `INSERT INTO _chardb_live_subscriptions
               (gateway_id, registration_id, connection_id, client_id, sub_id, state)
             VALUES ('capacity-gateway', ?, ?, 'capacity-client', ?, 'retired')`
        );
        const queued = db.prepare(
            `INSERT INTO _chardb_invalidation_outbox
               (gateway_id, registration_id, change_seq)
             VALUES ('capacity-gateway', ?, 1)`
        );
        db.transaction(() => {
            for (let index = 0; index < 4_096; index++) {
                const registrationId = `retired-${index}`;
                retired.run(registrationId, `connection-${index}`, index + 2);
                queued.run(registrationId);
            }
        })();

        expect(() => enqueueVectorResourceInvalidations(sql, RESOURCE_A)).toThrow(
            expect.objectContaining({ code: "CDB_RATE_LIMITED" })
        );
        expect(db.query("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1").get()).toEqual({
            change_seq: 0,
        });
        expect(
            db
                .query(
                    `SELECT 1 AS present FROM _chardb_invalidation_outbox
                     WHERE gateway_id = 'gateway-1' AND registration_id = 'vector-target'`
                )
                .get()
        ).toBeNull();
    });
});
