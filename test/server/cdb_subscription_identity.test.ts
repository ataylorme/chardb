import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { IntervalMap } from "../../src/intervals.ts";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { emptyManifest } from "../../src/server/manifest.ts";
import type { CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";
import { stableHashHex } from "../../src/util/canonical.ts";

const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const { cdbTable } = forOrg();
const messages = cdbTable(
    "messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
    },
    { roles: { member: { read: "*" } } }
);
const ConfiguredCdb = configureCdbRuntime({
    schema: () => ({ organization, messages }),
    manifest: () => emptyManifest(),
});

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

function durableLiveState(db: Database) {
    return {
        registrations: db
            .prepare(
                `SELECT gateway_id AS gatewayId, registration_id AS registrationId,
                        connection_id AS connectionId, client_id AS clientId, sub_id AS subId,
                        state, organization_id AS organizationId
                 FROM _chardb_live_subscriptions
                 ORDER BY gateway_id, registration_id`
            )
            .all(),
        tables: db
            .prepare(
                `SELECT gateway_id AS gatewayId, registration_id AS registrationId, table_name AS tableName
                 FROM _chardb_live_subscription_tables
                 ORDER BY gateway_id, registration_id, table_name`
            )
            .all(),
        invalidations: db
            .prepare(
                `SELECT gateway_id AS gatewayId, registration_id AS registrationId, change_seq AS changeSeq
                 FROM _chardb_invalidation_outbox
                 ORDER BY gateway_id, registration_id`
            )
            .all(),
    };
}

function durableRegistration(identity: LiveSubscriptionId, state: "active" | "retired") {
    return { ...identity, state, organizationId: state === "active" ? "org-1" : null };
}

function durableTable(identity: LiveSubscriptionId) {
    return { gatewayId: identity.gatewayId, registrationId: identity.registrationId, tableName: "messages" };
}

function subscription(
    gatewayId: string,
    clientId: string,
    registrationId = `registration-${clientId}`,
    connectionId = `connection-${clientId}`
): LiveSubscriptionId {
    return {
        gatewayId,
        registrationId,
        connectionId,
        clientId: ClientId(clientId),
        subId: SubId(1),
    };
}

function request(
    identity: LiveSubscriptionId,
    overrides: Partial<Omit<CdbSubscriptionRequest, "subscription">> = {}
): CdbSubscriptionRequest {
    return {
        subscription: identity,
        principalId: PrincipalId("user-1"),
        organizationId: TenantId("org-1"),
        ref: ChardbRef("queries.ts#messages"),
        args: { organizationId: "org-1" },
        queryHash: "query-hash-1",
        tables: ["messages"],
        intervals: [{ table: "messages", indexName: "by_org", intervals: [{ kind: "full" }] }],
        ...overrides,
    };
}

describe("Cdb live subscription identity", () => {
    let db: Database;
    let cdb: Cdb;
    let bootstrap: Promise<unknown>;
    let state: DurableObjectState;

    async function reconstruct(): Promise<void> {
        cdb = new ConfiguredCdb(state, {});
        await bootstrap;
    }

    beforeEach(async () => {
        db = new Database(":memory:");
        bootstrap = Promise.resolve();
        state = {
            id: { toString: () => "shard-do-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                bootstrap = callback();
            },
        } as unknown as DurableObjectState;
        await reconstruct();
    });

    afterEach(() => db.close());

    test("rebuilds active registrations with colliding client subIds", async () => {
        const first = subscription("gateway-do-1", "client-1");
        const second = subscription("gateway-do-1", "client-2");
        const third = subscription("gateway-do-2", "client-1");
        await cdb.subscribe(request(first));
        await cdb.subscribe(request(second));
        await cdb.subscribe(request(third));

        expect(
            db
                .prepare(
                    `SELECT state, principal_id, organization_id, ref, args_json, query_hash, tables_json, intervals_json
                     FROM _chardb_live_subscriptions
                     WHERE gateway_id = ? AND registration_id = ?`
                )
                .get(second.gatewayId, second.registrationId)
        ).toEqual({
            state: "active",
            principal_id: "user-1",
            organization_id: "org-1",
            ref: "queries.ts#messages",
            args_json: '{"organizationId":"org-1"}',
            query_hash: "query-hash-1",
            tables_json: '["messages"]',
            intervals_json: '[{"table":"messages","indexName":"by_org","intervals":[{"kind":"full"}]}]',
        });

        const firstRebuild = spyOn(IntervalMap.prototype, "register");
        await reconstruct();
        const firstRebuiltIntervals = firstRebuild.mock.calls.map(([key, table, indexName]) => [key, table, indexName]);
        firstRebuild.mockRestore();

        expect(firstRebuiltIntervals).toEqual([
            ['["gateway-do-1","registration-client-1"]', "messages", "by_org"],
            ['["gateway-do-1","registration-client-2"]', "messages", "by_org"],
            ['["gateway-do-2","registration-client-1"]', "messages", "by_org"],
        ]);

        expect(durableLiveState(db)).toEqual({
            registrations: [
                durableRegistration(first, "active"),
                durableRegistration(second, "active"),
                durableRegistration(third, "active"),
            ],
            tables: [durableTable(first), durableTable(second), durableTable(third)],
            invalidations: [],
        });

        await cdb.unsubscribe({ ...second });
        await reconstruct();

        expect(durableLiveState(db)).toEqual({
            registrations: [
                durableRegistration(first, "active"),
                durableRegistration(second, "retired"),
                durableRegistration(third, "active"),
            ],
            tables: [durableTable(first), durableTable(third)],
            invalidations: [],
        });
    });

    test("accepts an identical active replay and rejects a changed payload", async () => {
        const identity = subscription("gateway-do-1", "client-1");
        const original = request(identity, {
            args: { organizationId: "org-1", filter: { archived: false, channel: "general" } },
        });

        await expect(cdb.subscribe(original)).resolves.toEqual({ ok: true, subscription: identity, changeSeq: 0 });
        await expect(
            cdb.subscribe(
                request(identity, {
                    args: { filter: { channel: "general", archived: false }, organizationId: "org-1" },
                })
            )
        ).resolves.toEqual({ ok: true, subscription: identity, changeSeq: 0 });

        await expect(cdb.subscribe(request(identity, { args: { organizationId: "org-2" } }))).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        await expect(cdb.subscribe(request(identity, { organizationId: TenantId("org-2") }))).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        await expect(cdb.subscribe(request(identity, { queryHash: "query-hash-drifted" }))).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        expect(durableLiveState(db)).toEqual({
            registrations: [durableRegistration(identity, "active")],
            tables: [durableTable(identity)],
            invalidations: [],
        });
    });

    test("enforces the fixed active cap across reconstruction, replay, release, and legacy over-cap state", async () => {
        const active = Array.from({ length: 4_096 }, (_, index) =>
            subscription("gateway-do-capacity", `capacity-${index}`, `registration-capacity-${index}`)
        );
        for (const identity of active) {
            await cdb.subscribe(request(identity));
        }
        const excess = subscription("gateway-do-capacity", "capacity-excess", "registration-capacity-excess");
        const intervalInstall = spyOn(IntervalMap.prototype, "register");
        try {
            await expect(cdb.subscribe(request(excess))).resolves.toMatchObject({
                ok: false,
                registrationState: "absent",
                subscription: excess,
                error: { code: "CDB_RATE_LIMITED", retryable: true },
            });
            expect(intervalInstall).not.toHaveBeenCalled();
        } finally {
            intervalInstall.mockRestore();
        }
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM _chardb_live_subscriptions WHERE state = 'active'").get()
        ).toEqual({ count: 4_096 });
        expect(
            db
                .prepare("SELECT 1 AS present FROM _chardb_live_subscriptions WHERE registration_id = ?")
                .get(excess.registrationId)
        ).toBeNull();
        expect(
            db
                .prepare("SELECT 1 AS present FROM _chardb_live_subscription_tables WHERE registration_id = ?")
                .get(excess.registrationId)
        ).toBeNull();
        expect(db.prepare("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1").get()).toEqual({
            change_seq: 0,
        });

        await reconstruct();
        const first = active[0] as LiveSubscriptionId;
        await expect(cdb.subscribe(request(first))).resolves.toEqual({
            ok: true,
            subscription: first,
            changeSeq: 0,
        });

        const legacy = subscription("gateway-do-capacity", "capacity-legacy", "registration-capacity-legacy");
        const legacyRequest = request(legacy);
        const policy = db
            .prepare("SELECT policy_digest FROM _chardb_live_subscriptions WHERE registration_id = ?")
            .get(first.registrationId) as { policy_digest: string };
        const payloadHash = stableHashHex({
            connectionId: legacy.connectionId,
            clientId: legacy.clientId,
            subId: legacy.subId,
            principalId: legacyRequest.principalId,
            organizationId: legacyRequest.organizationId,
            ref: legacyRequest.ref,
            args: legacyRequest.args,
            policyDigest: policy.policy_digest,
            queryHash: legacyRequest.queryHash,
            tables: legacyRequest.tables,
            intervals: legacyRequest.intervals,
        });
        db.prepare(
            `INSERT INTO _chardb_live_subscriptions
             (gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
              principal_id, organization_id, ref, args_json, policy_digest, query_hash, tables_json, intervals_json)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            legacy.gatewayId,
            legacy.registrationId,
            legacy.connectionId,
            legacy.clientId,
            legacy.subId,
            payloadHash,
            legacyRequest.principalId,
            legacyRequest.organizationId,
            legacyRequest.ref,
            JSON.stringify(legacyRequest.args),
            policy.policy_digest,
            legacyRequest.queryHash,
            JSON.stringify(legacyRequest.tables),
            JSON.stringify(legacyRequest.intervals)
        );
        db.prepare(
            `INSERT INTO _chardb_live_subscription_tables (gateway_id, registration_id, table_name)
             VALUES (?, ?, 'messages')`
        ).run(legacy.gatewayId, legacy.registrationId);

        await reconstruct();
        await expect(cdb.subscribe(legacyRequest)).resolves.toEqual({ ok: true, subscription: legacy, changeSeq: 0 });
        await expect(cdb.subscribe(request(excess))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_RATE_LIMITED" },
        });
        await cdb.unsubscribe(first);
        await expect(cdb.subscribe(request(excess))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_RATE_LIMITED" },
        });
        await cdb.unsubscribe(active[1] as LiveSubscriptionId);
        await expect(cdb.subscribe(request(excess))).resolves.toEqual({
            ok: true,
            subscription: excess,
            changeSeq: 0,
        });
        await expect(cdb.subscribe(request(first))).rejects.toMatchObject({ code: "CDB_INVARIANT" });
    });

    test("fails closed when an active replay has lost its normalized table mapping", async () => {
        const identity = subscription("gateway-do-1", "client-1", "registration-mapping");
        const original = request(identity, { tables: ["messages", "messages"] });
        await cdb.subscribe(original);
        db.prepare(
            `DELETE FROM _chardb_live_subscription_tables
             WHERE gateway_id = ? AND registration_id = ? AND table_name = ?`
        ).run(identity.gatewayId, identity.registrationId, "messages");

        await expect(cdb.subscribe(original)).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        cdb = new ConfiguredCdb(state, {});
        await expect(bootstrap).rejects.toMatchObject({ code: "CDB_INVARIANT" });
    });

    test("unsubscribe-before-subscribe leaves an irreversible tombstone", async () => {
        const identity = subscription("gateway-do-1", "client-1", "registration-retired");

        await cdb.unsubscribe(identity);
        expect(
            db
                .prepare(
                    `SELECT state, payload_hash, principal_id, organization_id, ref, args_json, query_hash,
                            tables_json, intervals_json
                     FROM _chardb_live_subscriptions
                     WHERE gateway_id = ? AND registration_id = ?`
                )
                .get(identity.gatewayId, identity.registrationId)
        ).toEqual({
            state: "retired",
            payload_hash: null,
            principal_id: null,
            organization_id: null,
            ref: null,
            args_json: null,
            query_hash: null,
            tables_json: null,
            intervals_json: null,
        });

        await expect(cdb.subscribe(request(identity))).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        await reconstruct();
        expect(durableLiveState(db)).toEqual({
            registrations: [durableRegistration(identity, "retired")],
            tables: [],
            invalidations: [],
        });
    });

    test("a retired active registration stays absent after reconstruction", async () => {
        const active = subscription("gateway-do-1", "client-1", "registration-active");
        const retired = subscription("gateway-do-1", "client-1", "registration-retired");
        await cdb.subscribe(request(active));
        await cdb.subscribe(request(retired));
        await cdb.unsubscribe(retired);

        await reconstruct();

        expect(durableLiveState(db)).toEqual({
            registrations: [durableRegistration(active, "active"), durableRegistration(retired, "retired")],
            tables: [durableTable(active)],
            invalidations: [],
        });
    });

    test("rejects a conflicting unregister identity without retiring the active row", async () => {
        const identity = subscription("gateway-do-1", "client-1", "registration-1", "connection-1");
        await cdb.subscribe(request(identity));

        await expect(cdb.unsubscribe({ ...identity, connectionId: "connection-forged" })).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        expect(
            db.prepare("SELECT state FROM _chardb_live_subscriptions WHERE registration_id = ?").get("registration-1")
        ).toEqual({ state: "active" });
    });

    test("rejects a corrupted active payload during reconstruction", async () => {
        const identity = subscription("gateway-do-1", "client-1", "registration-corrupt");
        await cdb.subscribe(request(identity));
        db.prepare("UPDATE _chardb_live_subscriptions SET args_json = ? WHERE registration_id = ?").run(
            '{"organizationId":"org-forged"}',
            identity.registrationId
        );

        cdb = new Cdb(state, {});
        await expect(bootstrap).rejects.toMatchObject({ code: "CDB_INVARIANT" });
    });

    test("retires active rows created before authority and policy identity existed", async () => {
        const legacyDb = new Database(":memory:");
        try {
            legacyDb.exec(`
                CREATE TABLE _chardb_live_subscriptions (
                  gateway_id TEXT NOT NULL,
                  registration_id TEXT NOT NULL,
                  connection_id TEXT NOT NULL,
                  client_id TEXT NOT NULL,
                  sub_id INTEGER NOT NULL,
                  state TEXT NOT NULL,
                  payload_hash TEXT,
                  principal_id TEXT,
                  ref TEXT,
                  args_json TEXT,
                  tables_json TEXT,
                  intervals_json TEXT,
                  PRIMARY KEY (gateway_id, registration_id)
                );
                CREATE TABLE _chardb_live_subscription_tables (
                  gateway_id TEXT NOT NULL,
                  registration_id TEXT NOT NULL,
                  table_name TEXT NOT NULL,
                  PRIMARY KEY (gateway_id, registration_id, table_name)
                );
                INSERT INTO _chardb_live_subscriptions VALUES (
                  'gateway-legacy', 'registration-legacy', 'connection-legacy', 'client-legacy', 1,
                  'active', 'legacy-hash', 'user-1', 'queries.ts#messages', '{"organizationId":"org-1"}',
                  '["messages"]', '[]'
                );
                INSERT INTO _chardb_live_subscription_tables VALUES (
                  'gateway-legacy', 'registration-legacy', 'messages'
                );
            `);
            let legacyReady: Promise<unknown> = Promise.resolve();
            const legacyState = {
                id: { toString: () => "shard-legacy" },
                storage: {
                    sql: sqlStorage(legacyDb),
                    transactionSync: <T>(callback: () => T): T => legacyDb.transaction(callback)(),
                },
                blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                    legacyReady = callback();
                },
            } as unknown as DurableObjectState;
            const legacyCdb = new Cdb(legacyState, {});
            await legacyReady;

            expect(
                legacyDb
                    .prepare(
                        `SELECT state, payload_hash, principal_id, organization_id, ref, args_json, policy_digest,
                                query_hash,
                                tables_json, intervals_json
                         FROM _chardb_live_subscriptions
                         WHERE registration_id = 'registration-legacy'`
                    )
                    .get()
            ).toEqual({
                state: "retired",
                payload_hash: null,
                principal_id: null,
                organization_id: null,
                ref: null,
                args_json: null,
                policy_digest: null,
                query_hash: null,
                tables_json: null,
                intervals_json: null,
            });
            expect(legacyDb.query("SELECT * FROM _chardb_live_subscription_tables").all()).toEqual([]);
            await expect(
                legacyCdb.subscribe(
                    request({
                        gatewayId: "gateway-legacy",
                        registrationId: "registration-legacy",
                        connectionId: "connection-legacy",
                        clientId: ClientId("client-legacy"),
                        subId: SubId(1),
                    })
                )
            ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        } finally {
            legacyDb.close();
        }
    });
});
