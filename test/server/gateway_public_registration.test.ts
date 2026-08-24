import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import {
    GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE,
    Gateway,
    type GatewayEnv,
    type VerifiedGwAttachment,
} from "../../src/server/do/gateway.ts";
import type { QueryRouteResponse } from "../../src/server/manifest.ts";
import type { CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, type RawJson, ShardId, SubId, TenantId } from "../../src/types.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

interface GatewaySchedulerInternals {
    scheduleGatewayWork: (nowMs: number) => Promise<void>;
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
    let transactionCommitFailures: number;
    let beforeTransactionCommit: (() => Promise<void>) | undefined;
    let socketConnected: boolean;
    let subscribeCalls: CdbSubscriptionRequest[];
    let unsubscribeCalls: LiveSubscriptionId[];
    let registeredQueryCalls: unknown[];
    let routeCalls: number;
    let routeBehavior: () => QueryRouteResponse | Promise<QueryRouteResponse>;
    let subscribeBehavior: (request: CdbSubscriptionRequest) => unknown | Promise<unknown>;

    const route: QueryRouteResponse = {
        ok: true,
        args: { organizationId: "org-1" },
        intent: {
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
        },
        policyDigest: "policy-digest-1",
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
        transactionCommitFailures = 0;
        beforeTransactionCommit = undefined;
        socketConnected = true;
        subscribeCalls = [];
        unsubscribeCalls = [];
        registeredQueryCalls = [];
        routeCalls = 0;
        routeBehavior = () => route;
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
        subscribeBehavior = request => ({ ok: true, subscription: request.subscription, changeSeq: 0 });
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
                transaction: async <T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) => {
                    const originalAlarm = currentAlarm;
                    let stagedAlarm = currentAlarm;
                    db.exec("BEGIN IMMEDIATE");
                    try {
                        const result = await callback({
                            getAlarm: async () => stagedAlarm,
                            setAlarm: async (value: number | Date) => {
                                if (alarmFailures > 0) {
                                    alarmFailures -= 1;
                                    throw new Error("alarm unavailable");
                                }
                                stagedAlarm = value instanceof Date ? value.getTime() : value;
                            },
                        } as DurableObjectTransaction);
                        const beforeCommit = beforeTransactionCommit;
                        beforeTransactionCommit = undefined;
                        if (beforeCommit) await beforeCommit();
                        if (transactionCommitFailures > 0) {
                            transactionCommitFailures -= 1;
                            throw new Error("transaction commit unavailable");
                        }
                        db.exec("COMMIT");
                        currentAlarm = stagedAlarm;
                        return result;
                    } catch (error) {
                        db.exec("ROLLBACK");
                        currentAlarm = originalAlarm;
                        throw error;
                    }
                },
            },
            getWebSockets: () => (socketConnected ? [socket] : []) as unknown as WebSocket[],
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
                routeCalls++;
                return Promise.resolve(routeBehavior());
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

    function subscribe(subId = SubId(1), args: RawJson = { organizationId: "org-1" }): Promise<void> {
        return gateway.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({
                t: "sub",
                subId,
                ref: ChardbRef("queries.ts#messages"),
                args,
            })
        );
    }

    function holdNextTransactionCommit(): { readonly entered: Promise<void>; readonly release: () => void } {
        let markEntered: () => void = () => {};
        const entered = new Promise<void>(resolve => {
            markEntered = resolve;
        });
        let release: () => void = () => {};
        const held = new Promise<void>(resolve => {
            release = resolve;
        });
        beforeTransactionCommit = () => {
            markEntered();
            return held;
        };
        return { entered, release };
    }

    test("rejects hostile query arguments before routing, capacity, RPC, or durable work and then recovers", async () => {
        for (const [subId, args] of [
            [SubId(101), { value: "é".repeat(262_139) }],
            [SubId(102), Array.from({ length: 2_048 }, (_, index) => (index === 0 ? [null, null] : [null]))],
        ] as const) {
            await subscribe(subId, args);
            expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
                t: "error",
                subId,
                code: "CDB_INVALID_ARGS",
                retryable: false,
            });
        }
        expect(routeCalls).toBe(0);
        expect(subscribeCalls).toEqual([]);
        expect(generation()).toBeNull();
        expect(head()).toBeNull();

        await subscribe(SubId(103), { organizationId: "org-1" });
        await waitFor(() => generation()?.lifecycle === "active", "valid subscription after argument rejection");
        expect(routeCalls).toBe(1);
        expect(subscribeCalls).toHaveLength(1);
    });

    test("rejects oversized args returned by an overridden route before Catalog, RPC, or durable work", async () => {
        routeBehavior = () => ({ ...route, args: { value: "é".repeat(262_139) } });

        await subscribe(SubId(104));

        expect(routeCalls).toBe(1);
        expect(subscribeCalls).toEqual([]);
        expect(generation()).toBeNull();
        expect(head()).toBeNull();
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "error",
            subId: 104,
            code: "CDB_INVALID_ARGS",
            retryable: false,
        });
    });

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
            return { ok: true, subscription: request.subscription, changeSeq: 0 };
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

    test("returns a retryable quota error without dispatching or persisting an excess registration", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        db.query("UPDATE _gw_registration_generations SET args_json = ?").run(
            `{"padding":"${"x".repeat(15 * 1024 * 1024)}"}`
        );
        const callsBefore = subscribeCalls.length;

        await subscribe(SubId(2));

        expect(subscribeCalls).toHaveLength(callsBefore);
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_registration_generations").get()).toEqual({ count: 1 });
        expect(db.query("SELECT registration_id FROM _gw_registration_heads WHERE sub_id = 2").get()).toBeNull();
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "error",
            subId: 2,
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });
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
            return { ok: true, subscription: request.subscription, changeSeq: 3 };
        };

        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");

        expect(generation()).toMatchObject({ dirty_version: 7, delivered_version: 0, initial_snapshot_pending: 1 });
    });

    test("unsubscribing during subscribe retires the exact install and schedules cleanup", async () => {
        let release: (value: unknown) => void = () => {};
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
        release({ ok: true, subscription, changeSeq: 0 });
        await subscriptionTask;
        expect(originSettled).toBe(true);
        await waitFor(() => head() === null, "retirement");

        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring" });
        expect(currentAlarm).toBe(101);
        expect(registeredQueryCalls).toEqual([]);
    });

    test("socket close during subscribe retires the exact install", async () => {
        let release: (value: unknown) => void = () => {};
        subscribeBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });
        const subscriptionTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "subscribe RPC");
        const subscription = subscribeCalls[0]?.subscription as LiveSubscriptionId;

        socketConnected = false;
        await gateway.webSocketClose(socket as unknown as WebSocket);
        release({ ok: true, subscription, changeSeq: 0 });
        await subscriptionTask;
        await waitFor(() => head() === null, "close retirement");

        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring" });
        expect(currentAlarm).toBe(101);
    });

    test("unsubscribe retires the head in the transaction that owns its cleanup alarm", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        currentAlarm = null;
        alarmFailures = 1;

        await expect(
            gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }))
        ).rejects.toThrow("alarm unavailable");

        expect(head()).not.toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "active", cdb_state: "active", retry_at: null });
        expect(socket.attachment.snapshotSubIds).toEqual([SubId(1)]);
        expect(currentAlarm).toBeNull();
        expect(unsubscribeCalls).toEqual([]);

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

    test("a close rejection wins over held unsubscribe attachment settlement", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const held = holdNextTransactionCommit();

        const unsubscribeTask = gateway.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({ t: "unsub", subId: 1 })
        );
        await held.entered;
        socketConnected = false;
        const closeTask = gateway.webSocketClose(socket as unknown as WebSocket);
        const rejectedAttachment = socket.attachment as unknown;
        expect(rejectedAttachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });

        held.release();
        await Promise.all([unsubscribeTask, closeTask]);

        expect(socket.attachment as unknown).toBe(rejectedAttachment);
        expect(head()).toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring", retry_at: 100 });
        expect(currentAlarm).toBe(101);
    });

    test("held unsubscribe preserves a newer attachment for the same identity", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const held = holdNextTransactionCommit();

        const unsubscribeTask = gateway.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({ t: "unsub", subId: 1 })
        );
        await held.entered;
        const newerAttachment = {
            ...socket.attachment,
            jwtExp: socket.attachment.jwtExp + 1_000,
            jwtNbf: 50,
            lastCookie: Cookie("cookie-newer"),
            presenceKeys: ["presence-newer"],
            snapshotSubIds: [SubId(1), SubId(2)],
        } satisfies VerifiedGwAttachment;
        socket.attachment = newerAttachment;

        held.release();
        await unsubscribeTask;

        expect(socket.attachment).toEqual({ ...newerAttachment, snapshotSubIds: [SubId(2)] });
        expect(head()).toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring", retry_at: 100 });
        expect(currentAlarm).toBe(101);
    });

    test("unsubscribe rolls back its alarm when the retirement transaction cannot commit", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        currentAlarm = null;
        transactionCommitFailures = 1;

        await expect(
            gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }))
        ).rejects.toThrow("transaction commit unavailable");

        expect(head()).not.toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "active", cdb_state: "active", retry_at: null });
        expect(socket.attachment.snapshotSubIds).toEqual([SubId(1)]);
        expect(currentAlarm).toBeNull();
    });

    test("socket close commit failure falls back to an alarm that reconciles the abandoned head", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        currentAlarm = null;
        transactionCommitFailures = 1;
        socketConnected = false;

        await expect(gateway.webSocketClose(socket as unknown as WebSocket)).rejects.toThrow(
            "transaction commit unavailable"
        );

        expect(head()).not.toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "active", cdb_state: "active", retry_at: null });
        expect(currentAlarm as number | null).toBe(101);
        expect(unsubscribeCalls).toEqual([]);

        clock = 101;
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([subscription]);
        expect(generation()).toBeNull();
    });

    test("socket close recovers a transient transactional alarm failure with its fallback alarm", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        currentAlarm = null;
        alarmFailures = 1;
        socketConnected = false;

        await expect(gateway.webSocketClose(socket as unknown as WebSocket)).rejects.toThrow("alarm unavailable");

        expect(head()).not.toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "active", cdb_state: "active", retry_at: null });
        expect(currentAlarm as number | null).toBe(101);

        clock = 101;
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([subscription]);
        expect(generation()).toBeNull();
    });

    test("abandoned-head reconciliation preserves an exact verified live socket", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        currentAlarm = null;
        clock = 101;

        await gateway.alarm();

        expect(head()).not.toBeNull();
        expect(generation()).toMatchObject({ lifecycle: "active", cdb_state: "active" });
        expect(unsubscribeCalls).toEqual([]);
    });

    test("a socket with the wrong connection identity does not protect an abandoned head", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        socket.attachment = { ...socket.attachment, connectionId: "connection-2" };
        currentAlarm = null;
        clock = 101;

        await gateway.alarm();

        expect(head()).toBeNull();
        expect(generation()).toBeNull();
        expect(unsubscribeCalls).toEqual([subscription]);
    });

    test("a stale verified attachment does not protect an abandoned head", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        socket.attachment = { ...socket.attachment, jwtExp: 0 };
        currentAlarm = null;
        clock = 101;

        await gateway.alarm();

        expect(head()).toBeNull();
        expect(generation()).toBeNull();
        expect(unsubscribeCalls).toEqual([subscription]);
    });

    test("abandoned-head reconciliation re-arms until it passes the batch cap", async () => {
        const total = GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE + 1;
        for (let subId = 1; subId <= total; subId++) await subscribe(SubId(subId));
        await waitFor(
            () =>
                (db.query("SELECT COUNT(*) AS count FROM _gw_registration_heads").get() as { count: number }).count ===
                total,
            "subscription batch activation"
        );
        socketConnected = false;
        currentAlarm = null;
        clock = 101;

        await gateway.alarm();

        expect(currentAlarm as number | null).toBe(102);
        expect(
            (
                db
                    .query("SELECT integer_value FROM _gw_maintenance_state WHERE key = ?")
                    .get("abandoned-registration-cursor") as { integer_value: number }
            ).integer_value
        ).toBeGreaterThan(0);

        clock = 102;
        currentAlarm = null;
        await gateway.alarm();
        expect(head()).toBeNull();
        expect(generation()).toBeNull();
        expect(unsubscribeCalls).toHaveLength(total);
        expect(
            (
                db
                    .query("SELECT integer_value FROM _gw_maintenance_state WHERE key = ?")
                    .get("abandoned-registration-cursor") as { integer_value: number }
            ).integer_value
        ).toBe(0);
    });

    test("another close fallback preserves an in-progress sweep cursor", async () => {
        const total = GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE + 1;
        for (let subId = 1; subId <= total; subId++) await subscribe(SubId(subId));
        await waitFor(
            () =>
                (db.query("SELECT COUNT(*) AS count FROM _gw_registration_heads").get() as { count: number }).count ===
                total,
            "subscription batch activation"
        );
        db.exec(
            "UPDATE _gw_registration_generations SET initial_snapshot_pending = 0, delivered_version = dirty_version"
        );
        socket.attachment = {
            ...socket.attachment,
            snapshotSubIds: (socket.attachment.snapshotSubIds ?? []).slice(
                0,
                GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE
            ),
        };
        currentAlarm = null;
        clock = 101;

        await gateway.alarm();
        const cursor = (
            db
                .query("SELECT integer_value FROM _gw_maintenance_state WHERE key = ?")
                .get("abandoned-registration-cursor") as { integer_value: number }
        ).integer_value;
        expect(cursor).toBeGreaterThan(0);

        await (
            gateway as unknown as { scheduleAbandonedGatewayReconciliation(nowMs: number): Promise<void> }
        ).scheduleAbandonedGatewayReconciliation(clock);
        expect(
            (
                db
                    .query("SELECT integer_value FROM _gw_maintenance_state WHERE key = ?")
                    .get("abandoned-registration-cursor") as { integer_value: number }
            ).integer_value
        ).toBe(cursor);

        clock = 102;
        currentAlarm = null;
        await gateway.alarm();
        const abandoned = subscribeCalls.at(-1)?.subscription;
        if (!abandoned) throw new Error("last subscribe call was not recorded");
        expect(unsubscribeCalls).toContainEqual(abandoned);
        expect(
            db
                .query("SELECT registration_id FROM _gw_registration_generations WHERE registration_id = ?")
                .get(abandoned.registrationId)
        ).toBeNull();
    });

    test("close fallback preserves an earlier alarm", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "subscription activation");
        const subscription = subscribeCalls[0]?.subscription;
        if (!subscription) throw new Error("subscribe call was not recorded");
        currentAlarm = 100;
        transactionCommitFailures = 1;
        socketConnected = false;

        await expect(gateway.webSocketClose(socket as unknown as WebSocket)).rejects.toThrow(
            "transaction commit unavailable"
        );

        expect(currentAlarm as number | null).toBe(100);
        expect(head()).not.toBeNull();
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([subscription]);
        expect(generation()).toBeNull();
    });

    test("latest duplicate wins after the earlier subscribe settles", async () => {
        let releaseFirst: (value: unknown) => void = () => {};
        subscribeBehavior = request => {
            if (subscribeCalls.length === 1) {
                return new Promise(resolve => {
                    releaseFirst = resolve;
                });
            }
            return { ok: true, subscription: request.subscription, changeSeq: 2 };
        };
        const firstTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "first subscribe RPC");
        const secondTask = subscribe();
        expect(subscribeCalls).toHaveLength(1);
        releaseFirst({
            ok: true,
            subscription: subscribeCalls[0]?.subscription as LiveSubscriptionId,
            changeSeq: 1,
        });
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

    test("a displaced subscription does not report a late final scheduler rejection", async () => {
        let schedulerCalls = 0;
        let rejectHeldSchedule: (error: Error) => void = () => {};
        (gateway as unknown as GatewaySchedulerInternals).scheduleGatewayWork = async () => {
            schedulerCalls += 1;
            if (schedulerCalls !== 2) return;
            await new Promise<void>((_, reject) => {
                rejectHeldSchedule = reject;
            });
        };

        const first = subscribe();
        await waitFor(() => schedulerCalls === 2, "held final scheduler call");
        const replacement = subscribe();
        rejectHeldSchedule(new Error("scheduler unavailable"));
        await Promise.all([first, replacement]);

        expect(subscribeCalls).toHaveLength(2);
        expect(socket.sent.map(message => JSON.parse(message))).not.toContainEqual(
            expect.objectContaining({ t: "error", code: "CDB_SHARD_UNAVAILABLE" })
        );
    });

    test("a closed subscription does not report a late final scheduler rejection", async () => {
        let schedulerCalls = 0;
        let rejectHeldSchedule: (error: Error) => void = () => {};
        (gateway as unknown as GatewaySchedulerInternals).scheduleGatewayWork = async () => {
            schedulerCalls += 1;
            if (schedulerCalls !== 2) return;
            await new Promise<void>((_, reject) => {
                rejectHeldSchedule = reject;
            });
        };

        const pending = subscribe();
        await waitFor(() => schedulerCalls === 2, "held final scheduler call");
        await gateway.webSocketClose(socket as unknown as WebSocket);
        rejectHeldSchedule(new Error("scheduler unavailable"));
        await pending;

        expect(socket.sent).toEqual([]);
        expect(socket.attachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });
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

    test("unsubscribe during ambiguous settlement suppresses the stale response-loss error", async () => {
        subscribeBehavior = () => {
            throw new Error("response lost");
        };
        let schedulerCalls = 0;
        let releaseAmbiguousSchedule: () => void = () => {};
        (gateway as unknown as GatewaySchedulerInternals).scheduleGatewayWork = async () => {
            schedulerCalls += 1;
            if (schedulerCalls !== 2) return;
            await new Promise<void>(resolve => {
                releaseAmbiguousSchedule = resolve;
            });
        };

        const pending = subscribe();
        await waitFor(() => schedulerCalls === 2, "held ambiguous scheduler call");
        await gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }));
        releaseAmbiguousSchedule();
        await pending;

        expect(socket.sent.map(message => JSON.parse(message))).not.toContainEqual(
            expect.objectContaining({ t: "error", code: "CDB_SHARD_UNAVAILABLE" })
        );
    });

    test("a definitive Cdb capacity failure removes the install without an unsubscribe tombstone", async () => {
        subscribeBehavior = request => ({
            ok: false,
            registrationState: "absent",
            subscription: request.subscription,
            error: new CdbError({ code: "CDB_RATE_LIMITED", retryAfterMs: 1_000 }).toJSON(),
        });

        await subscribe();

        expect(head()).toBeNull();
        expect(generation()).toBeNull();
        expect(unsubscribeCalls).toEqual([]);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "error",
            code: "CDB_RATE_LIMITED",
            subId: 1,
            retryable: true,
        });
    });

    test("a replacement capacity failure preserves cleanup only for the older active generation", async () => {
        await subscribe();
        await waitFor(() => generation()?.lifecycle === "active", "first subscription activation");
        const oldSubscription = subscribeCalls[0]?.subscription;
        if (!oldSubscription) throw new Error("first subscribe call was not recorded");
        subscribeBehavior = request => ({
            ok: false,
            registrationState: "absent",
            subscription: request.subscription,
            error: new CdbError({ code: "CDB_RATE_LIMITED", retryAfterMs: 1_000 }).toJSON(),
        });

        await subscribe();

        expect(head()).toBeNull();
        expect(
            db.query("SELECT registration_id, lifecycle, cdb_state FROM _gw_registration_generations").all()
        ).toEqual([{ registration_id: oldSubscription.registrationId, lifecycle: "retiring", cdb_state: "retiring" }]);
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([oldSubscription]);
        expect(generation()).toBeNull();
    });

    test("a held definitive failure raced with unsubscribe deletes headless pending state without cleanup", async () => {
        let release: (value: unknown) => void = () => {};
        subscribeBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });
        const subscriptionTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "held subscribe RPC");
        const held = subscribeCalls[0];
        if (!held) throw new Error("held subscribe call was not recorded");

        await gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }));
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "pending", retry_at: 30_100 });
        currentAlarm = null;
        await gateway.alarm();
        expect(unsubscribeCalls).toEqual([]);
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "pending" });

        release({
            ok: false,
            registrationState: "absent",
            subscription: held.subscription,
            error: new CdbError({ code: "CDB_RATE_LIMITED", retryAfterMs: 1_000 }).toJSON(),
        });
        await subscriptionTask;
        expect(generation()).toBeNull();
        expect(unsubscribeCalls).toEqual([]);
        expect(socket.sent).toEqual([]);
    });

    test("a held definitive failure raced with socket close also avoids cleanup", async () => {
        let release: (value: unknown) => void = () => {};
        subscribeBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });
        const subscriptionTask = subscribe();
        await waitFor(() => subscribeCalls.length === 1, "held close subscribe RPC");
        const held = subscribeCalls[0];
        if (!held) throw new Error("held subscribe call was not recorded");

        socketConnected = false;
        await gateway.webSocketClose(socket as unknown as WebSocket);
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "pending" });
        expect(unsubscribeCalls).toEqual([]);
        release({
            ok: false,
            registrationState: "absent",
            subscription: held.subscription,
            error: new CdbError({ code: "CDB_RATE_LIMITED", retryAfterMs: 1_000 }).toJSON(),
        });
        await subscriptionTask;

        expect(generation()).toBeNull();
        expect(unsubscribeCalls).toEqual([]);
        expect(socket.sent).toEqual([]);
    });

    test("a mismatched definitive failure is ambiguous and compensates by exact unsubscribe", async () => {
        subscribeBehavior = request => ({
            ok: false,
            registrationState: "absent",
            subscription: { ...request.subscription, registrationId: "mismatched-registration" },
            error: new CdbError({ code: "CDB_RATE_LIMITED", retryAfterMs: 1_000 }).toJSON(),
        });

        await subscribe();
        expect(generation()).toMatchObject({ lifecycle: "retiring", cdb_state: "retiring" });
        currentAlarm = null;
        await gateway.alarm();
        const attempted = subscribeCalls[0];
        if (!attempted) throw new Error("subscribe call was not recorded");
        expect(unsubscribeCalls).toEqual([attempted.subscription]);
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
        let release: (value: unknown) => void = () => {};
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
        release({ ok: true, subscription: abandonedSubscribe.subscription, changeSeq: 0 });
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
