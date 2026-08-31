import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { VerifiedGwAttachment } from "../../src/server/do/gateway-auth-dispatch.ts";
import { Gateway, type GatewayEnv } from "../../src/server/do/gateway.ts";
import { ClientId, Cookie, PrincipalId } from "../../src/types.ts";
import type { RawJson } from "../../src/wire.ts";

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

type TestAttachment = VerifiedGwAttachment | Record<string, unknown>;

class FakeSocket {
    readonly sent: string[] = [];

    constructor(public attachment: TestAttachment = verifiedAttachment()) {}

    deserializeAttachment(): TestAttachment {
        return this.attachment;
    }

    serializeAttachment(attachment: TestAttachment): void {
        this.attachment = attachment;
    }

    send(message: string): void {
        this.sent.push(message);
    }

    close(): void {}
}

interface PendingTestSubscription {
    cancelled: boolean;
    queued: boolean;
}

interface GatewayInternals {
    authRefreshBarriers: Map<string, Promise<boolean>>;
    pendingSubscriptions: Map<string, PendingTestSubscription>;
    routeQuery: (input: { args: RawJson }) => Promise<unknown>;
}

function verifiedAttachment(connectionId = "connection-1"): VerifiedGwAttachment {
    return {
        kind: "verified",
        connectionId,
        authOrigin: "https://app.example",
        clientId: ClientId("client-1"),
        principalId: PrincipalId("principal-1"),
        jwtExp: Math.floor(Date.now() / 1_000) + 10_000,
        lastCookie: Cookie("cookie-base"),
        snapshotSubIds: [],
    };
}

function subscribe(gateway: Gateway, socket: FakeSocket, version: number): Promise<void> {
    return gateway.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({
            t: "sub",
            subId: 1,
            ref: "queries.ts#messages",
            args: { organizationId: "org-1", version },
        })
    );
}

function unsubscribe(gateway: Gateway, socket: FakeSocket): Promise<void> {
    return gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId: 1 }));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error(`timed out waiting for ${label}`);
}

describe("Gateway duplicate subscription admission", () => {
    let db: Database;
    let gateway: Gateway;
    let ready: Promise<unknown>;
    let currentAlarm: number | null;
    let internals: GatewayInternals;
    let routedArgs: RawJson[];
    let releaseRoutes: Array<() => void>;
    let rejectRoutes: Array<() => void>;

    beforeEach(async () => {
        db = new Database(":memory:");
        ready = Promise.resolve();
        currentAlarm = null;
        const state = {
            id: { toString: () => "gateway-subscription-duplicate-admission" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async () => currentAlarm,
                setAlarm: async (value: number | Date) => {
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
                                stagedAlarm = value instanceof Date ? value.getTime() : value;
                            },
                        } as DurableObjectTransaction);
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
            getWebSockets: () => [] as WebSocket[],
            blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        gateway = new Gateway(state, {
            CDB_CATALOG: {} as DurableObjectNamespace,
            CDB_SHARD: {} as DurableObjectNamespace,
        } satisfies GatewayEnv);
        await ready;
        internals = gateway as unknown as GatewayInternals;
        routedArgs = [];
        releaseRoutes = [];
        rejectRoutes = [];
        internals.routeQuery = input => {
            routedArgs.push(input.args);
            return new Promise((resolve, reject) => {
                releaseRoutes.push(() => resolve({ ok: false, error: { code: "CDB_INVALID_ARGS" } }));
                rejectRoutes.push(() => reject(new Error("route failed")));
            });
        };
    });

    afterEach(() => db.close());

    test("keeps one active route and one replacement while rate-limiting a duplicate flood", async () => {
        const socket = new FakeSocket();
        const first = subscribe(gateway, socket, 0);
        expect(routedArgs).toEqual([{ organizationId: "org-1", version: 0 }]);

        const replacement = subscribe(gateway, socket, 1);
        for (let version = 2; version < 42; version++) await subscribe(gateway, socket, version);

        expect(routedArgs).toHaveLength(1);
        expect(internals.pendingSubscriptions).toHaveLength(1);
        expect([...internals.pendingSubscriptions.values()][0]).toMatchObject({ queued: true, cancelled: false });
        const rateLimits = socket.sent
            .map(message => JSON.parse(message))
            .filter(message => message.t === "error" && message.code === "CDB_RATE_LIMITED");
        expect(rateLimits).toHaveLength(40);
        expect(rateLimits.every(message => message.retryable === true)).toBeTrue();

        releaseRoutes[0]?.();
        await waitFor(() => routedArgs.length === 2, "replacement route");
        expect(routedArgs[1]).toEqual({ organizationId: "org-1", version: 1 });

        const nextReplacement = subscribe(gateway, socket, 42);
        await subscribe(gateway, socket, 43);
        expect(routedArgs).toHaveLength(2);
        expect(socket.sent.map(message => JSON.parse(message)).at(-1)).toMatchObject({
            t: "error",
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });

        releaseRoutes[1]?.();
        await waitFor(() => routedArgs.length === 3, "next replacement route");
        expect(routedArgs[2]).toEqual({ organizationId: "org-1", version: 42 });
        releaseRoutes[2]?.();
        await Promise.all([first, replacement, nextReplacement]);
        expect(internals.pendingSubscriptions.size).toBe(0);

        const afterSettlement = subscribe(gateway, socket, 44);
        expect(routedArgs).toHaveLength(4);
        releaseRoutes[3]?.();
        await afterSettlement;
        expect(internals.pendingSubscriptions.size).toBe(0);
    });

    test("releases the replacement slot after unsubscribe and socket close", async () => {
        const socket = new FakeSocket();
        const first = subscribe(gateway, socket, 0);
        const replacement = subscribe(gateway, socket, 1);
        await unsubscribe(gateway, socket);
        releaseRoutes[0]?.();
        await Promise.all([first, replacement]);
        expect(internals.pendingSubscriptions.size).toBe(0);

        const admitted = subscribe(gateway, socket, 2);
        expect(routedArgs.at(-1)).toEqual({ organizationId: "org-1", version: 2 });
        const closeReplacement = subscribe(gateway, socket, 3);
        await gateway.webSocketClose(socket as unknown as WebSocket);
        releaseRoutes.at(-1)?.();
        await Promise.all([admitted, closeReplacement]);

        expect(internals.pendingSubscriptions.size).toBe(0);
        expect(socket.attachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });
    });

    test("does not report a rejected route after a replacement takes ownership", async () => {
        const socket = new FakeSocket();
        const first = subscribe(gateway, socket, 0);
        const replacement = subscribe(gateway, socket, 1);

        rejectRoutes[0]?.();
        await waitFor(() => routedArgs.length === 2, "replacement route after rejection");
        expect(socket.sent.map(message => JSON.parse(message))).not.toContainEqual(
            expect.objectContaining({ t: "error", code: "CDB_INVARIANT" })
        );

        releaseRoutes[1]?.();
        await Promise.all([first, replacement]);
        expect(internals.pendingSubscriptions.size).toBe(0);
    });

    test("does not report a rejected route after its socket closes", async () => {
        const socket = new FakeSocket();
        const pending = subscribe(gateway, socket, 0);
        await gateway.webSocketClose(socket as unknown as WebSocket);
        rejectRoutes[0]?.();
        await pending;

        expect(socket.sent).toEqual([]);
        expect(internals.pendingSubscriptions.size).toBe(0);
        expect(socket.attachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });
    });

    test("bounds duplicates queued behind auth refresh and releases admission after either result", async () => {
        const socket = new FakeSocket();
        let finishRefresh: (succeeded: boolean) => void = () => {};
        const refresh = new Promise<boolean>(resolve => {
            finishRefresh = resolve;
        });
        const barrier = refresh.finally(() => internals.authRefreshBarriers.delete("connection-1"));
        internals.authRefreshBarriers.set("connection-1", barrier);

        const waiting = subscribe(gateway, socket, 0);
        await subscribe(gateway, socket, 1);
        expect(routedArgs).toEqual([]);
        expect(internals.pendingSubscriptions).toHaveLength(1);
        expect(socket.sent.map(message => JSON.parse(message)).at(-1)).toMatchObject({
            t: "error",
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });

        finishRefresh(true);
        await waitFor(() => routedArgs.length === 1, "post-refresh route");
        releaseRoutes[0]?.();
        await waiting;
        expect(internals.pendingSubscriptions.size).toBe(0);

        let failRefresh: (succeeded: boolean) => void = () => {};
        const failedRefresh = new Promise<boolean>(resolve => {
            failRefresh = resolve;
        });
        const failedBarrier = failedRefresh.finally(() => internals.authRefreshBarriers.delete("connection-1"));
        internals.authRefreshBarriers.set("connection-1", failedBarrier);
        const rejectedByRefresh = subscribe(gateway, socket, 2);
        failRefresh(false);
        await rejectedByRefresh;
        expect(internals.pendingSubscriptions.size).toBe(0);

        const afterFailure = subscribe(gateway, socket, 3);
        expect(routedArgs.at(-1)).toEqual({ organizationId: "org-1", version: 3 });
        releaseRoutes.at(-1)?.();
        await afterFailure;
        expect(internals.pendingSubscriptions.size).toBe(0);
    });
});
