import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { emptyManifest } from "../../src/server/manifest.ts";
import type { CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";

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

        await reconstruct();

        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([
            first,
            second,
            third,
        ]);

        await cdb.unsubscribe({ ...second });

        await reconstruct();

        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([first, third]);
    });

    test("accepts an identical active replay and rejects a changed payload", async () => {
        const identity = subscription("gateway-do-1", "client-1");
        const original = request(identity, {
            args: { organizationId: "org-1", filter: { archived: false, channel: "general" } },
        });

        await expect(cdb.subscribe(original)).resolves.toEqual({ subscription: identity, changeSeq: 0 });
        await expect(
            cdb.subscribe(
                request(identity, {
                    args: { filter: { channel: "general", archived: false }, organizationId: "org-1" },
                })
            )
        ).resolves.toEqual({ subscription: identity, changeSeq: 0 });
        expect(
            db
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM _chardb_live_subscriptions
                     WHERE gateway_id = ? AND registration_id = ?`
                )
                .get(identity.gatewayId, identity.registrationId)
        ).toEqual({ count: 1 });
        expect(
            db
                .prepare(
                    `SELECT table_name
                     FROM _chardb_live_subscription_tables
                     WHERE gateway_id = ? AND registration_id = ?`
                )
                .all(identity.gatewayId, identity.registrationId)
        ).toEqual([{ table_name: "messages" }]);

        await expect(cdb.subscribe(request(identity, { args: { organizationId: "org-2" } }))).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        await expect(cdb.subscribe(request(identity, { organizationId: TenantId("org-2") }))).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        await expect(cdb.subscribe(request(identity, { queryHash: "query-hash-drifted" }))).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([identity]);
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
        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([]);
    });

    test("a retired active registration stays absent after reconstruction", async () => {
        const active = subscription("gateway-do-1", "client-1", "registration-active");
        const retired = subscription("gateway-do-1", "client-1", "registration-retired");
        await cdb.subscribe(request(active));
        await cdb.subscribe(request(retired));
        await cdb.unsubscribe(retired);

        await reconstruct();

        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([active]);
        expect(
            db
                .prepare("SELECT state FROM _chardb_live_subscriptions WHERE registration_id = ?")
                .get("registration-retired")
        ).toEqual({ state: "retired" });
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
