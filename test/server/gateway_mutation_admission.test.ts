import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { Gateway, type GatewayEnv, type VerifiedGwAttachment } from "../../src/server/do/gateway.ts";
import type { CdbMutationResponse } from "../../src/server/rpc.ts";
import { ClientId, Cookie, PrincipalId } from "../../src/types.ts";

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
    failSend = false;

    constructor(public attachment: VerifiedGwAttachment) {}

    deserializeAttachment(): VerifiedGwAttachment {
        return this.attachment;
    }

    serializeAttachment(attachment: VerifiedGwAttachment): void {
        this.attachment = attachment;
    }

    send(message: string): void {
        if (this.failSend) throw new Error("socket send failed");
        this.sent.push(message);
    }
}

interface GatewayInternals {
    unsettledMutationCount: number;
    unsettledMutationsByConnection: Map<string, number>;
    authRefreshBarriers: Map<string, Promise<boolean>>;
    settleMut: () => Promise<void>;
    routeMut: () => Promise<CdbMutationResponse>;
}

function attachment(connectionId: string, cookie = `cookie-${connectionId}`): VerifiedGwAttachment {
    return {
        kind: "verified",
        connectionId,
        authOrigin: "https://app.example",
        clientId: ClientId("client-1"),
        principalId: PrincipalId("principal-1"),
        jwtExp: Math.floor(Date.now() / 1_000) + 10_000,
        lastCookie: Cookie(cookie),
        snapshotSubIds: [],
    };
}

function mutation(gateway: Gateway, socket: FakeSocket, mutId: string): Promise<void> {
    return gateway.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ t: "mut", mutId, ref: "mutations.ts#write", args: {} })
    );
}

describe("Gateway unsettled mutation admission", () => {
    let db: Database;
    let gateway: Gateway;
    let ready: Promise<unknown>;

    beforeEach(async () => {
        db = new Database(":memory:");
        ready = Promise.resolve();
        let alarm: number | null = null;
        const state = {
            id: { toString: () => "gateway-admission" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async () => alarm,
                setAlarm: async (value: number | Date) => {
                    alarm = value instanceof Date ? value.getTime() : value;
                },
            },
            getWebSockets: () => [] as WebSocket[],
            blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        const env = {
            CDB_CATALOG: {} as DurableObjectNamespace,
            CDB_SHARD: {} as DurableObjectNamespace,
        } satisfies GatewayEnv;
        gateway = new Gateway(state, env);
        await ready;
    });

    afterEach(() => db.close());

    test("caps each connection at 32 and admits a replacement immediately after settlement", async () => {
        const socket = new FakeSocket(attachment("connection-1"));
        const internals = gateway as unknown as GatewayInternals;
        const releases: Array<() => void> = [];
        let dispatches = 0;
        internals.settleMut = () => {
            dispatches += 1;
            return new Promise(resolve => releases.push(resolve));
        };

        const admitted = Array.from({ length: 32 }, (_, index) => mutation(gateway, socket, `held-${index}`));
        expect(dispatches).toBe(32);
        socket.attachment = { ...socket.attachment, lastCookie: Cookie("cookie-latest") };

        await mutation(gateway, socket, "limited");
        expect(dispatches).toBe(32);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "poke",
            cookie: "cookie-latest",
            mutResults: [{ mutId: "limited", ok: false, error: { code: "CDB_RATE_LIMITED", retryable: true } }],
        });

        releases[0]?.();
        await admitted[0];
        const replacement = mutation(gateway, socket, "replacement");
        expect(dispatches).toBe(33);

        for (const release of releases) release();
        await Promise.all([...admitted, replacement]);
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
    });

    test("caps the Gateway at 256 while keeping admitted connections concurrent", async () => {
        const internals = gateway as unknown as GatewayInternals;
        const releases: Array<() => void> = [];
        let dispatches = 0;
        internals.settleMut = () => {
            dispatches += 1;
            return new Promise(resolve => releases.push(resolve));
        };
        const sockets = Array.from({ length: 9 }, (_, index) => new FakeSocket(attachment(`connection-${index}`)));
        const admitted: Promise<void>[] = [];
        for (let connection = 0; connection < 8; connection++) {
            const socket = sockets[connection];
            if (!socket) throw new Error("missing test socket");
            for (let index = 0; index < 32; index++) {
                admitted.push(mutation(gateway, socket, `held-${connection}-${index}`));
            }
        }
        expect(dispatches).toBe(256);

        const overflow = sockets[8];
        if (!overflow) throw new Error("missing overflow socket");
        await mutation(gateway, overflow, "gateway-limited");
        expect(dispatches).toBe(256);
        expect(JSON.parse(overflow.sent.at(-1) as string)).toMatchObject({
            t: "poke",
            mutResults: [{ mutId: "gateway-limited", ok: false, error: { code: "CDB_RATE_LIMITED" } }],
        });

        for (const release of releases) release();
        await Promise.all(admitted);
        expect(internals.unsettledMutationCount).toBe(0);
    });

    test("bounds mutations queued behind auth refresh and releases them when refresh fails", async () => {
        const internals = gateway as unknown as GatewayInternals;
        const socket = new FakeSocket(attachment("connection-1"));
        let finishRefresh: (succeeded: boolean) => void = () => {};
        internals.authRefreshBarriers.set(
            "connection-1",
            new Promise(resolve => {
                finishRefresh = resolve;
            })
        );
        let dispatches = 0;
        internals.settleMut = async () => {
            dispatches += 1;
        };

        const queued = Array.from({ length: 32 }, (_, index) => mutation(gateway, socket, `queued-${index}`));
        await mutation(gateway, socket, "refresh-limited");
        expect(dispatches).toBe(0);
        expect(internals.unsettledMutationCount).toBe(32);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "poke",
            mutResults: [{ mutId: "refresh-limited", ok: false, error: { code: "CDB_RATE_LIMITED" } }],
        });

        finishRefresh(false);
        await Promise.all(queued);
        expect(dispatches).toBe(0);
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
    });

    test("releases admission after typed, thrown, stale, and send-failed settlements", async () => {
        const internals = gateway as unknown as GatewayInternals;
        const socket = new FakeSocket(attachment("connection-1", "cookie-base"));
        const typedFailure: CdbMutationResponse = {
            ok: false,
            error: new CdbError({ code: "CDB_SHARD_UNAVAILABLE", message: "typed failure" }).toJSON(),
        };

        internals.routeMut = async () => typedFailure;
        await mutation(gateway, socket, "typed");
        expect(internals.unsettledMutationCount).toBe(0);

        internals.routeMut = async () => {
            throw new Error("unexpected dispatch failure");
        };
        await mutation(gateway, socket, "thrown");
        expect(internals.unsettledMutationCount).toBe(0);

        let releaseStale: () => void = () => {};
        internals.routeMut = () =>
            new Promise(resolve => {
                releaseStale = () => resolve(typedFailure);
            });
        const stale = mutation(gateway, socket, "stale");
        socket.attachment = attachment("replacement-connection", "cookie-replacement");
        releaseStale();
        await stale;
        expect(internals.unsettledMutationCount).toBe(0);

        socket.attachment = attachment("connection-1", "cookie-send-failure");
        socket.failSend = true;
        internals.routeMut = async () => typedFailure;
        await mutation(gateway, socket, "send-failed");
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
    });
});
