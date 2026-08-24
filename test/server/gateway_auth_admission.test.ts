import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Gateway, type GatewayEnv, type VerifiedGwAttachment } from "../../src/server/do/gateway.ts";
import { ClientId, Cookie, PrincipalId } from "../../src/types.ts";
import { PROTOCOL_V } from "../../src/wire.ts";

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

interface PendingAttachment {
    readonly kind: "pending";
    readonly connectionId: string;
    readonly authOrigin: string;
    readonly routedClientId: ClientId;
}

type TestAttachment = PendingAttachment | VerifiedGwAttachment | Record<string, unknown>;

class FakeSocket {
    readonly sent: string[] = [];
    readonly closed: Array<{ code: number; reason: string }> = [];

    constructor(public attachment: TestAttachment) {}

    deserializeAttachment(): TestAttachment {
        return this.attachment;
    }

    serializeAttachment(attachment: TestAttachment): void {
        this.attachment = attachment;
    }

    send(message: string): void {
        this.sent.push(message);
    }

    close(code: number, reason: string): void {
        this.closed.push({ code, reason });
    }
}

interface GatewayInternals {
    authOperationClaims: Map<string, object>;
    authRefreshBarriers: Map<string, Promise<boolean>>;
    verifyAttachment: () => Promise<VerifiedGwAttachment | null>;
    performUpdateAuth: () => Promise<boolean>;
}

function pendingAttachment(): PendingAttachment {
    return {
        kind: "pending",
        connectionId: "connection-1",
        authOrigin: "https://app.example",
        routedClientId: ClientId("client-1"),
    };
}

function verifiedAttachment(): VerifiedGwAttachment {
    return {
        kind: "verified",
        connectionId: "connection-1",
        authOrigin: "https://app.example",
        clientId: ClientId("client-1"),
        principalId: PrincipalId("principal-1"),
        jwtExp: Math.floor(Date.now() / 1_000) + 10_000,
        lastCookie: Cookie("cookie-base"),
        snapshotSubIds: [],
    };
}

function hello(gateway: Gateway, socket: FakeSocket, jwt: string): Promise<void> {
    return gateway.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ t: "hello", protocolV: PROTOCOL_V, clientId: "client-1", jwt })
    );
}

function updateAuth(gateway: Gateway, socket: FakeSocket, jwt: string): Promise<void> {
    return gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "updateAuth", jwt }));
}

describe("Gateway authentication single-flight admission", () => {
    let db: Database;
    let gateway: Gateway;
    let ready: Promise<unknown>;
    let currentAlarm: number | null;
    let transactionSyncCalls: number;

    beforeEach(async () => {
        db = new Database(":memory:");
        ready = Promise.resolve();
        currentAlarm = null;
        transactionSyncCalls = 0;
        const state = {
            id: { toString: () => "gateway-auth-admission" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => {
                    transactionSyncCalls += 1;
                    return db.transaction(callback)();
                },
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
    });

    afterEach(() => db.close());

    test("admits one held hello, rate-limits duplicates, and commits only the owner", async () => {
        const socket = new FakeSocket(pendingAttachment());
        const internals = gateway as unknown as GatewayInternals;
        let verifyCalls = 0;
        let finishVerification: (attachment: VerifiedGwAttachment) => void = () => {};
        internals.verifyAttachment = () => {
            verifyCalls += 1;
            return new Promise(resolve => {
                finishVerification = resolve;
            });
        };

        const owner = hello(gateway, socket, "owner-token");
        await hello(gateway, socket, "duplicate-token");
        expect(verifyCalls).toBe(1);
        expect(socket.attachment).toEqual(pendingAttachment());
        expect(socket.sent.map(message => JSON.parse(message))).toContainEqual(
            expect.objectContaining({ t: "error", code: "CDB_RATE_LIMITED", retryable: true })
        );

        finishVerification(verifiedAttachment());
        await owner;
        expect(socket.attachment).toMatchObject({ kind: "verified", principalId: "principal-1" });
        expect(socket.sent.map(message => JSON.parse(message))).toContainEqual(
            expect.objectContaining({ t: "welcome", protocolV: PROTOCOL_V })
        );
        expect(internals.authOperationClaims.size).toBe(0);
    });

    test("releases a thrown hello claim and admits a later verification", async () => {
        const socket = new FakeSocket(pendingAttachment());
        const internals = gateway as unknown as GatewayInternals;
        internals.verifyAttachment = async () => {
            throw new Error("verification crashed");
        };
        await expect(hello(gateway, socket, "crashing-token")).rejects.toThrow("verification crashed");
        expect(internals.authOperationClaims.size).toBe(0);

        internals.verifyAttachment = async () => verifiedAttachment();
        await hello(gateway, socket, "replacement-token");
        expect(socket.attachment).toMatchObject({ kind: "verified", principalId: "principal-1" });
    });

    test("a close event fences a held hello before attachment mutation or welcome", async () => {
        const socket = new FakeSocket(pendingAttachment());
        const internals = gateway as unknown as GatewayInternals;
        let finishVerification: (attachment: VerifiedGwAttachment) => void = () => {};
        internals.verifyAttachment = () =>
            new Promise(resolve => {
                finishVerification = resolve;
            });

        const owner = hello(gateway, socket, "held-token");
        await gateway.webSocketClose(socket as unknown as WebSocket);
        finishVerification(verifiedAttachment());
        await owner;

        expect(socket.attachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });
        expect(socket.sent.map(message => JSON.parse(message))).not.toContainEqual(
            expect.objectContaining({ t: "welcome" })
        );
        expect(internals.authOperationClaims.size).toBe(0);
    });

    test("admits one held updateAuth, rejects duplicates, then admits the next refresh", async () => {
        const socket = new FakeSocket(verifiedAttachment());
        const internals = gateway as unknown as GatewayInternals;
        let updateCalls = 0;
        let finishUpdate: (succeeded: boolean) => void = () => {};
        internals.performUpdateAuth = () => {
            updateCalls += 1;
            return new Promise(resolve => {
                finishUpdate = resolve;
            });
        };

        const owner = updateAuth(gateway, socket, "owner-token");
        await updateAuth(gateway, socket, "duplicate-token");
        expect(updateCalls).toBe(1);
        expect(socket.sent.map(message => JSON.parse(message))).toContainEqual(
            expect.objectContaining({ t: "error", code: "CDB_RATE_LIMITED", retryable: true })
        );

        finishUpdate(true);
        await owner;
        expect(internals.authOperationClaims.size).toBe(0);
        expect(internals.authRefreshBarriers.size).toBe(0);

        internals.performUpdateAuth = async () => {
            updateCalls += 1;
            return true;
        };
        await updateAuth(gateway, socket, "later-token");
        expect(updateCalls).toBe(2);
    });

    test("a thrown updateAuth closes through the existing failure path and releases ownership", async () => {
        const socket = new FakeSocket(verifiedAttachment());
        const internals = gateway as unknown as GatewayInternals;
        internals.performUpdateAuth = async () => {
            throw new Error("refresh crashed");
        };

        await updateAuth(gateway, socket, "crashing-token");
        expect(socket.attachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });
        expect(socket.closed).toEqual([{ code: 1008, reason: "CDB_CATALOG_UNAVAILABLE" }]);
        expect(internals.authOperationClaims.size).toBe(0);
        expect(internals.authRefreshBarriers.size).toBe(0);
    });

    test("a close event fences a held updateAuth before refresh state, retirement, or send", async () => {
        const socket = new FakeSocket(verifiedAttachment());
        const internals = gateway as unknown as GatewayInternals;
        let finishVerification: (attachment: VerifiedGwAttachment) => void = () => {};
        internals.verifyAttachment = () =>
            new Promise(resolve => {
                finishVerification = resolve;
            });
        transactionSyncCalls = 0;

        const owner = updateAuth(gateway, socket, "held-refresh-token");
        await gateway.webSocketClose(socket as unknown as WebSocket);
        const sentAfterClose = [...socket.sent];
        finishVerification({ ...verifiedAttachment(), principalId: PrincipalId("principal-refreshed") });
        await owner;

        expect(socket.attachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });
        expect(socket.sent).toEqual(sentAfterClose);
        expect(transactionSyncCalls).toBe(0);
        expect(internals.authOperationClaims.size).toBe(0);
        expect(internals.authRefreshBarriers.size).toBe(0);

        await updateAuth(gateway, socket, "post-close-token");
        expect(transactionSyncCalls).toBe(0);
        expect(internals.authOperationClaims.size).toBe(0);
        expect(internals.authRefreshBarriers.size).toBe(0);
        expect(socket.sent.map(message => JSON.parse(message))).not.toContainEqual(
            expect.objectContaining({ t: "mustRefetch" })
        );
    });
});
