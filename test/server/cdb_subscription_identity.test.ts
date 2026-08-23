import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cdb } from "../../src/server/do/cdb.ts";
import type { CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId } from "../../src/types.ts";

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
        ref: ChardbRef("queries.ts#messages"),
        args: { organizationId: "org-1" },
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
        cdb = new Cdb(state, {});
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
                    `SELECT state, principal_id, ref, args_json, tables_json, intervals_json
                     FROM _chardb_live_subscriptions
                     WHERE gateway_id = ? AND registration_id = ?`
                )
                .get(second.gatewayId, second.registrationId)
        ).toEqual({
            state: "active",
            principal_id: "user-1",
            ref: "queries.ts#messages",
            args_json: '{"organizationId":"org-1"}',
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

        await expect(cdb.subscribe(original)).resolves.toEqual({ subscription: identity });
        await expect(
            cdb.subscribe(
                request(identity, {
                    args: { filter: { channel: "general", archived: false }, organizationId: "org-1" },
                })
            )
        ).resolves.toEqual({ subscription: identity });
        expect(
            db
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM _chardb_live_subscriptions
                     WHERE gateway_id = ? AND registration_id = ?`
                )
                .get(identity.gatewayId, identity.registrationId)
        ).toEqual({ count: 1 });

        await expect(cdb.subscribe(request(identity, { args: { organizationId: "org-2" } }))).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([identity]);
    });

    test("unsubscribe-before-subscribe leaves an irreversible tombstone", async () => {
        const identity = subscription("gateway-do-1", "client-1", "registration-retired");

        await cdb.unsubscribe(identity);
        expect(
            db
                .prepare(
                    `SELECT state, payload_hash, principal_id, ref, args_json, tables_json, intervals_json
                     FROM _chardb_live_subscriptions
                     WHERE gateway_id = ? AND registration_id = ?`
                )
                .get(identity.gatewayId, identity.registrationId)
        ).toEqual({
            state: "retired",
            payload_hash: null,
            principal_id: null,
            ref: null,
            args_json: null,
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
});
