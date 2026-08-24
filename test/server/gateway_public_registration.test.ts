import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Gateway, type GatewayEnv, type VerifiedGwAttachment } from "../../src/server/do/gateway.ts";
import type { QueryRouteResponse } from "../../src/server/manifest.ts";
import type { CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, ShardId, SubId, TenantId } from "../../src/types.ts";

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

class FakeSocket {
    readonly sent: string[] = [];
    readonly closed: { code: number; reason: string }[] = [];

    constructor(public attachment: VerifiedGwAttachment) {}

    deserializeAttachment(): VerifiedGwAttachment {
        return this.attachment;
    }

    serializeAttachment(attachment: VerifiedGwAttachment): void {
        this.attachment = attachment;
    }

    send(message: string): void {
        this.sent.push(message);
    }

    close(code: number, reason: string): void {
        this.closed.push({ code, reason });
    }
}

describe("Gateway public durable registration", () => {
    let db: Database;
    let gateway: Gateway;
    let ready: Promise<unknown>;
    let state: DurableObjectState;
    let env: GatewayEnv;
    let socket: FakeSocket;
    let clock: number;
    let currentAlarm: number | null;
    let alarmFailures: number;
    let subscribeCalls: CdbSubscriptionRequest[];
    let unsubscribeCalls: LiveSubscriptionId[];
    let registeredQueryCalls: unknown[];
    let subscribeBehavior: (
        request: CdbSubscriptionRequest
    ) => unknown | Promise<{ subscription: LiveSubscriptionId; changeSeq: number }>;

    const route: QueryRouteResponse = {
        ok: true,
        args: { organizationId: "org-1" },
        intent: {
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
        },
        queryHash: "query-hash-1",
        authority: "organization",
        partitionKey: "org-1",
    };

    beforeEach(async () => {
        db = new Database(":memory:");
        ready = Promise.resolve();
        clock = 100;
        currentAlarm = null;
        alarmFailures = 0;
        subscribeCalls = [];
        unsubscribeCalls = [];
        registeredQueryCalls = [];
        socket = new FakeSocket({
            kind: "verified",
            connectionId: "connection-1",
            authOrigin: "https://app.example",
            clientId: ClientId("client-1"),
            principalId: PrincipalId("principal-1"),
            jwtExp: Math.floor(Date.now() / 1_000) + 10_000,
            lastCookie: Cookie("cookie-base"),
            snapshotSubIds: [],
        });
        subscribeBehavior = request => ({ subscription: request.subscription, changeSeq: 0 });
        const catalog = {
            async resolveOrganizationAuthority() {
                return {
                    principalId: PrincipalId("principal-1"),
                    organizationId: TenantId("org-1"),
                    role: "member",
                    roles: ["member"],
                    authEpochs: { global: 10, tenant: 11, principal: 12 },
                };
            },
            async route() {
                return { shardId: ShardId("logical-shard-1"), schemaEpoch: 4 };
            },
            async listShardIds() {
                return [ShardId("logical-shard-1")];
            },
        };
        const cdb = {
            async subscribe(request: CdbSubscriptionRequest) {
                subscribeCalls.push(request);
                return await subscribeBehavior(request);
            },
            async unsubscribe(subscription: LiveSubscriptionId) {
                unsubscribeCalls.push(subscription);
            },
            async queryRegistered(request: unknown) {
                registeredQueryCalls.push(request);
                return { ok: true, result: [] };
            },
        };
        env = {
            CDB_CATALOG: {
                idFromName: () => ({ toString: () => "catalog-global" }),
                get: () => catalog,
            } as unknown as DurableObjectNamespace,
            CDB_SHARD: {
                idFromName: () => ({ toString: () => "physical-cdb-1" }),
                idFromString: (id: string) => ({ toString: () => id }),
                get: () => cdb,
            } as unknown as DurableObjectNamespace,
        };
        state = {
            id: { toString: () => "gateway-do-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async () => currentAlarm,
                setAlarm: async (value: number | Date) => {
                    if (alarmFailures > 0) {
                        alarmFailures -= 1;
                        throw new Error("alarm unavailable");
                    }
                    currentAlarm = value instanceof Date ? value.getTime() : value;
                },
            },
            getWebSockets: () => [socket] as unknown as WebSocket[],
            blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        gateway = createGateway();
        await ready;
    });

    afterEach(() => db.close());

    function createGateway(): Gateway {
        class TestGateway extends Gateway {
            protected override gatewayNowMs(): number {
                return clock;
            }

            override routeQuery(): Promise<QueryRouteResponse> {
                return Promise.resolve(route);
            }
        }
        return new TestGateway(state, env);
    }

    function generation(): Record<string, unknown> | null {
        return db
            .query(
                `SELECT registration_id, lifecycle, cdb_state, dirty_version, delivered_version, run_token,
                        initial_snapshot_pending, retry_at, source_cdb_id
                 FROM _gw_registration_generations
                 ORDER BY created_at DESC, registration_id DESC LIMIT 1`
            )
            .get() as Record<string, unknown> | null;
    }

    function head(): Record<string, unknown> | null {
        return db.query("SELECT registration_id FROM _gw_registration_heads").get() as Record<string, unknown> | null;
    }

    async function waitFor(predicate: () => boolean, description: string): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error(
            `timed out waiting for ${description}: sent=${JSON.stringify(socket.sent)} generation=${JSON.stringify(generation())}`
        );
    }

    function subscribe(subId = SubId(1)): Promise<void> {
        return gateway.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({
                t: "sub",
                subId,
                ref: ChardbRef("queries.ts#messages"),
                args: { organizationId: "org-1" },
            })
        );
    }

    test("installs and pre-arms before subscribe, activates a zero clock, and does not query or send directly", async () => {
        subscribeBehavior = request => {
            expect(generation()).toMatchObject({
                registration_id: request.subscription.registrationId,
                lifecycle: "installing",
                cdb_state: "pending",
                retry_at: 30_100,
                source_cdb_id: "physical-cdb-1",
            });
            expect(currentAlarm).toBe(30_100);
            return { subscription: request.subscription, changeSeq: 0 };
        };

        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");

        expect(subscribeCalls).toHaveLength(1);
        expect(subscribeCalls[0]).toMatchObject({
            principalId: "principal-1",
            organizationId: "org-1",
            ref: "queries.ts#messages",
            args: { organizationId: "org-1" },
            queryHash: "query-hash-1",
            tables: ["messages"],
        });
        expect(generation()).toMatchObject({
            lifecycle: "active",
            cdb_state: "active",
            dirty_version: 0,
            delivered_version: 0,
            initial_snapshot_pending: 1,
            retry_at: null,
        });
        expect(currentAlarm).toBe(101);
        expect(registeredQueryCalls).toEqual([]);
        expect(socket.sent).toEqual([]);

        currentAlarm = null;
        await gateway.alarm();
        expect(registeredQueryCalls).toHaveLength(1);
        expect(socket.sent).toHaveLength(1);
        const snapshot = JSON.parse(socket.sent[0] as string) as { cookie: Cookie; rows: unknown[] };
        expect(snapshot.rows).toEqual([]);
        await gateway.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({ t: "ack", cookie: snapshot.cookie })
        );
        expect(generation()).toMatchObject({
            dirty_version: 0,
            delivered_version: 0,
            initial_snapshot_pending: 0,
        });
        expect(db.query("SELECT * FROM _gw_snapshot_outbox").get()).toBeNull();
    });

    test("restart schedules a zero-clock initial snapshot before any run claim", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        expect(generation()).toMatchObject({ initial_snapshot_pending: 1, run_token: null });

        currentAlarm = null;
        gateway = createGateway();
        await ready;
        expect(await state.storage.getAlarm()).toBe(101);
        currentAlarm = null;
        await gateway.alarm();

        expect(registeredQueryCalls).toHaveLength(1);
        expect(socket.sent).toHaveLength(1);
    });

    test("a staged zero-clock snapshot survives restart and can still be acknowledged", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        currentAlarm = null;
        await gateway.alarm();
        const snapshot = JSON.parse(socket.sent[0] as string) as { cookie: Cookie };
        expect(db.query("SELECT cookie, target_version FROM _gw_snapshot_outbox").get()).toEqual({
            cookie: snapshot.cookie,
            target_version: 0,
        });

        gateway = createGateway();
        await ready;
        await gateway.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({ t: "ack", cookie: snapshot.cookie })
        );

        expect(db.query("SELECT * FROM _gw_snapshot_outbox").get()).toBeNull();
        expect(generation()).toMatchObject({ initial_snapshot_pending: 0, delivered_version: 0 });
    });

    test("preserves invalidation received while subscribe is in flight", async () => {
        subscribeBehavior = async request => {
            await gateway.invalidateSubscriptions({
                gatewayId: "gateway-do-1",
                sourceCdbId: "physical-cdb-1",
                invalidations: [{ subscription: request.subscription, changeSeq: 7 }],
            });
            return { subscription: request.subscription, changeSeq: 3 };
        };

        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");

        expect(generation()).toMatchObject({ dirty_version: 7, delivered_version: 0, initial_snapshot_pending: 1 });
    });

    test("unsubscribing during subscribe retires the exact install and schedules cleanup", async () => {
        let release: (value: { subscription: LiveSubscriptionId; changeSeq: number }) => void = () => {};
        subscribeBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });
        const subscriptionTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "subscribe RPC");
        const subscription = subscribeCalls[0]?.subscription as LiveSubscriptionId;
        let originSettled = false;
        void subscriptionTask.then(() => {
            originSettled = true;
        });
        expect(originSettled).toBe(false);

        await gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }));
        release({ subscription, changeSeq: 0 });
        await subscriptionTask;
        expect(originSettled).toBe(true);
        await waitFor(() => head() === null, "retirement");

        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring" });
        expect(currentAlarm).toBe(101);
        expect(registeredQueryCalls).toEqual([]);
    });

    test("socket close during subscribe retires the exact install", async () => {
        let release: (value: { subscription: LiveSubscriptionId; changeSeq: number }) => void = () => {};
        subscribeBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });
        const subscriptionTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "subscribe RPC");
        const subscription = subscribeCalls[0]?.subscription as LiveSubscriptionId;

        await gateway.webSocketClose(socket as unknown as WebSocket);
        release({ subscription, changeSeq: 0 });
        await subscriptionTask;
        await waitFor(() => head() === null, "close retirement");

        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring" });
        expect(currentAlarm).toBe(101);
    });

    test("unsubscribe recovers a failed pre-arm without retaining the live head", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        currentAlarm = null;
        alarmFailures = 1;

        await gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }));

        expect(head()).toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring", retry_at: 100 });
        expect(currentAlarm as number | null).toBe(101);
        expect(socket.attachment.snapshotSubIds).toEqual([]);

        clock = 101;
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([subscription]);
        expect(generation()).toBeNull();
    });

    test("unsubscribe clears attachment state when both alarm writes fail", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        currentAlarm = null;
        alarmFailures = 2;

        await expect(
            gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }))
        ).rejects.toThrow("alarm unavailable");

        expect(head()).toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring", retry_at: 100 });
        expect(socket.attachment.snapshotSubIds).toEqual([]);
        expect(currentAlarm).toBeNull();

        alarmFailures = 0;
        gateway = createGateway();
        await ready;
        expect(currentAlarm as number | null).toBe(101);

        clock = 101;
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([subscription]);
        expect(generation()).toBeNull();
    });

    test("socket close leaves bootstrap-owned cleanup when both alarm writes fail", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        currentAlarm = null;
        alarmFailures = 2;

        await expect(gateway.webSocketClose(socket as unknown as WebSocket)).rejects.toThrow("alarm unavailable");

        expect(head()).toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring", retry_at: 100 });
        expect(currentAlarm).toBeNull();

        alarmFailures = 0;
        gateway = createGateway();
        await ready;
        expect(currentAlarm as number | null).toBe(101);

        clock = 101;
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([subscription]);
        expect(generation()).toBeNull();
    });

    test("latest duplicate wins after the earlier subscribe settles", async () => {
        let releaseFirst: (value: { subscription: LiveSubscriptionId; changeSeq: number }) => void = () => {};
        subscribeBehavior = request => {
            if (subscribeCalls.length === 1) {
                return new Promise(resolve => {
                    releaseFirst = resolve;
                });
            }
            return { subscription: request.subscription, changeSeq: 2 };
        };
        const firstTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "first subscribe RPC");
        const secondTask = subscribe();
        expect(subscribeCalls).toHaveLength(1);
        releaseFirst({ subscription: subscribeCalls[0]?.subscription as LiveSubscriptionId, changeSeq: 1 });
        await waitFor(() => subscribeCalls.length === 2, "replacement subscribe RPC");
        await Promise.all([firstTask, secondTask]);
        const replacementId = subscribeCalls[1]?.subscription.registrationId as string;
        await waitFor(
            () =>
                (
                    db
                        .query("SELECT lifecycle FROM _gw_registration_generations WHERE registration_id = ?")
                        .get(replacementId) as { lifecycle: string } | null
                )?.lifecycle === "active",
            "replacement activation"
        );

        const rows = db
            .query(
                "SELECT registration_id, lifecycle FROM _gw_registration_generations ORDER BY created_at, registration_id"
            )
            .all() as { registration_id: string; lifecycle: string }[];
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.lifecycle).sort()).toEqual(["active", "retiring"]);
        expect(head()).toEqual({ registration_id: replacementId });
    });

    test("subscribe response loss leaves an exact cleanup tombstone", async () => {
        subscribeBehavior = () => {
            throw new Error("response lost");
        };

        await subscribe();
        await waitFor(() => generation()?.lifecycle === "retiring", "failed subscribe retirement");
        expect(head()).toBeNull();
        expect(currentAlarm).toBe(101);

        currentAlarm = null;
        await gateway.alarm();
        const failedSubscribe = subscribeCalls[0];
        if (!failedSubscribe) throw new Error("subscribe call was not recorded");
        expect(unsubscribeCalls).toEqual([failedSubscribe.subscription]);
        expect(generation()).toBeNull();
    });

    test("a failed recovery alarm prevents install and subscribe", async () => {
        alarmFailures = 1;

        await subscribe();
        await waitFor(() => socket.sent.length > 0, "schedule failure response");

        expect(subscribeCalls).toEqual([]);
        expect(generation()).toBeNull();
        expect(head()).toBeNull();
    });

    test("restart reconciles an abandoned installing generation at its durable deadline", async () => {
        let release: (value: { subscription: LiveSubscriptionId; changeSeq: number }) => void = () => {};
        subscribeBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });
        const subscriptionTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "held subscribe RPC");
        expect(generation()).toMatchObject({ lifecycle: "installing", retry_at: 30_100 });

        clock = 30_100;
        currentAlarm = null;
        gateway = createGateway();
        await ready;
        currentAlarm = null;
        await gateway.alarm();
        const abandonedSubscribe = subscribeCalls[0];
        if (!abandonedSubscribe) throw new Error("subscribe call was not recorded");
        release({ subscription: abandonedSubscribe.subscription, changeSeq: 0 });
        await subscriptionTask;

        expect(head()).toBeNull();
        expect(generation()).toBeNull();
        expect(unsubscribeCalls).toEqual([abandonedSubscribe.subscription]);
        expect(currentAlarm).toBeNull();
    });

    test("auth refresh retires durable registrations and returns their subIds in mustRefetch", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const replacement: VerifiedGwAttachment = {
            ...socket.attachment,
            principalId: PrincipalId("principal-2"),
        };
        const internals = gateway as unknown as {
            verifyAttachment: () => Promise<VerifiedGwAttachment>;
            performUpdateAuth: (
                ws: WebSocket,
                connectionId: string,
                message: { t: "updateAuth"; jwt: string }
            ) => Promise<boolean>;
        };
        internals.verifyAttachment = async () => replacement;

        expect(
            await internals.performUpdateAuth(socket as unknown as WebSocket, "connection-1", {
                t: "updateAuth",
                jwt: "replacement",
            })
        ).toBe(true);

        expect(head()).toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring" });
        const mustRefetch = socket.sent.map(message => JSON.parse(message) as Record<string, unknown>).at(-1);
        expect(mustRefetch).toMatchObject({ t: "mustRefetch", subIds: [1], reason: "authChanged" });
    });

    test("the updateAuth WebSocket event owns its full refresh barrier", async () => {
        let release: (succeeded: boolean) => void = () => {};
        const internals = gateway as unknown as {
            performUpdateAuth: () => Promise<boolean>;
        };
        internals.performUpdateAuth = () =>
            new Promise(resolve => {
                release = resolve;
            });

        let settled = false;
        const event = gateway
            .webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "updateAuth", jwt: "replacement" }))
            .then(() => {
                settled = true;
            });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(false);

        release(true);
        await event;
        expect(settled).toBe(true);
    });

    test("hello and mutation WebSocket events own their asynchronous work", async () => {
        let releaseHello: () => void = () => {};
        let releaseMutation: () => void = () => {};
        const internals = gateway as unknown as {
            onHello: () => Promise<void>;
            settleMut: () => Promise<void>;
        };
        internals.onHello = () =>
            new Promise(resolve => {
                releaseHello = resolve;
            });
        internals.settleMut = () =>
            new Promise(resolve => {
                releaseMutation = resolve;
            });

        let helloSettled = false;
        const helloEvent = gateway
            .webSocketMessage(
                socket as unknown as WebSocket,
                JSON.stringify({ t: "hello", protocolV: 3, clientId: "client-1", jwt: "held" })
            )
            .then(() => {
                helloSettled = true;
            });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(helloSettled).toBe(false);
        releaseHello();
        await helloEvent;

        let mutationSettled = false;
        const mutationEvent = gateway
            .webSocketMessage(
                socket as unknown as WebSocket,
                JSON.stringify({ t: "mut", mutId: "mutation-held", ref: "mutations.ts#write", args: {} })
            )
            .then(() => {
                mutationSettled = true;
            });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mutationSettled).toBe(false);
        releaseMutation();
        await mutationEvent;
        expect(mutationSettled).toBe(true);
    });
});
