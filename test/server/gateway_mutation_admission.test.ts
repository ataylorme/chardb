import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import type { VerifiedGwAttachment } from "../../src/server/do/gateway-auth-dispatch.ts";
import { Gateway, type GatewayEnv } from "../../src/server/do/gateway.ts";
import {
    CDB_JSON_MAX_AGGREGATE_MEMBERS,
    CDB_MUTATION_ARGS_MAX_BYTES,
    CDB_MUTATION_ARGS_MAX_DEPTH,
} from "../../src/server/result_limits.ts";
import type { CdbMutationResponse } from "../../src/server/rpc.ts";
import { ClientId, Cookie, PrincipalId } from "../../src/types.ts";
import type { RawJson } from "../../src/types.ts";

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
    routeMut: (msg: { readonly mutId: string }) => Promise<CdbMutationResponse>;
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

function mutation(gateway: Gateway, socket: FakeSocket, mutId: string, args: RawJson = {}): Promise<void> {
    return gateway.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ t: "mut", mutId, ref: "mutations.ts#write", args })
    );
}

function nestedArray(depth: number): RawJson {
    let value: RawJson = null;
    for (let level = 0; level < depth; level++) value = [value];
    return value;
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
                transaction: async <T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) => {
                    const originalAlarm = alarm;
                    let stagedAlarm = alarm;
                    db.exec("BEGIN IMMEDIATE");
                    try {
                        const result = await callback({
                            getAlarm: async () => stagedAlarm,
                            setAlarm: async (value: number | Date) => {
                                stagedAlarm = value instanceof Date ? value.getTime() : value;
                            },
                        } as DurableObjectTransaction);
                        db.exec("COMMIT");
                        alarm = stagedAlarm;
                        return result;
                    } catch (error) {
                        db.exec("ROLLBACK");
                        alarm = originalAlarm;
                        throw error;
                    }
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

    test("releases admission after typed, thrown, and send-failed settlements", async () => {
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

        socket.attachment = attachment("connection-1", "cookie-send-failure");
        socket.failSend = true;
        internals.routeMut = async () => typedFailure;
        await mutation(gateway, socket, "send-failed");
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
    });

    test("does not deliver a held success after its socket closes", async () => {
        const internals = gateway as unknown as GatewayInternals;
        const socket = new FakeSocket(attachment("connection-1", "cookie-base"));
        let release!: () => void;
        internals.routeMut = () =>
            new Promise(resolve => {
                release = () =>
                    resolve({ ok: true, cookie: "cookie-success", ran: true, result: null, rowsAffected: 0 });
            });

        const pending = mutation(gateway, socket, "closed-success");
        await Promise.resolve();
        await gateway.webSocketClose(socket as unknown as WebSocket);
        const rejectedAttachment = socket.attachment;
        expect(rejectedAttachment).toMatchObject({ kind: "rejected", connectionId: "connection-1" });

        release();
        await pending;

        expect(socket.sent).toEqual([]);
        expect(socket.attachment).toBe(rejectedAttachment);
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
    });

    test("does not deliver a held failure to a different verified identity", async () => {
        const internals = gateway as unknown as GatewayInternals;
        const socket = new FakeSocket(attachment("connection-1", "cookie-base"));
        const typedFailure: CdbMutationResponse = {
            ok: false,
            error: new CdbError({ code: "CDB_SHARD_UNAVAILABLE", message: "typed failure" }).toJSON(),
        };
        let release!: () => void;
        internals.routeMut = () =>
            new Promise(resolve => {
                release = () => resolve(typedFailure);
            });

        const pending = mutation(gateway, socket, "replaced-failure");
        await Promise.resolve();
        const replacement = {
            ...attachment("replacement-connection", "cookie-replacement"),
            clientId: ClientId("client-2"),
            principalId: PrincipalId("principal-2"),
        };
        socket.attachment = replacement;

        release();
        await pending;

        expect(socket.sent).toEqual([]);
        expect(socket.attachment).toBe(replacement);
        expect(socket.attachment.lastCookie).toBe(Cookie("cookie-replacement"));
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
    });

    test("does not regress the delivered cookie when mutation completions arrive out of order", async () => {
        const internals = gateway as unknown as GatewayInternals;
        const socket = new FakeSocket(attachment("connection-1", "cookie-base"));
        const releases = new Map<string, (response: CdbMutationResponse) => void>();
        internals.routeMut = msg =>
            new Promise(resolve => {
                releases.set((msg as { readonly mutId: string }).mutId, resolve);
            });

        const first = mutation(gateway, socket, "first");
        const second = mutation(gateway, socket, "second");
        await Promise.resolve();
        releases.get("second")?.({
            ok: true,
            cookie: "cookie-second",
            ran: true,
            result: "second",
            rowsAffected: 1,
        });
        await second;
        releases.get("first")?.({
            ok: true,
            cookie: "cookie-first",
            ran: true,
            result: "first",
            rowsAffected: 1,
        });
        await first;

        expect(socket.attachment.lastCookie).toBe(Cookie("cookie-second"));
        expect(socket.sent.map(message => JSON.parse(message))).toEqual([
            expect.objectContaining({
                cookie: "cookie-second",
                mutResults: [expect.objectContaining({ mutId: "second" })],
            }),
            expect.objectContaining({
                cookie: "cookie-second",
                mutResults: [expect.objectContaining({ mutId: "first" })],
            }),
        ]);
    });

    test("caps exact serialized mutation argument bytes before auth waiting or reservation", async () => {
        expect(CDB_MUTATION_ARGS_MAX_BYTES).toBe(524_288);
        const internals = gateway as unknown as GatewayInternals;
        const socket = new FakeSocket(attachment("connection-1", "cookie-base"));
        let dispatches = 0;
        internals.settleMut = async () => {
            dispatches += 1;
        };

        const exactBoundary = "a".repeat(CDB_MUTATION_ARGS_MAX_BYTES - 2);
        await mutation(gateway, socket, "exact-boundary", exactBoundary);
        expect(dispatches).toBe(1);
        expect(internals.unsettledMutationCount).toBe(0);

        internals.authRefreshBarriers.set("connection-1", new Promise(() => {}));
        socket.attachment = { ...socket.attachment, lastCookie: Cookie("cookie-latest") };
        await mutation(gateway, socket, "one-over", `${exactBoundary}a`);
        expect(dispatches).toBe(1);
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "poke",
            cookie: "cookie-latest",
            mutResults: [{ mutId: "one-over", ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } }],
        });

        const multibyteBoundary = "é".repeat((CDB_MUTATION_ARGS_MAX_BYTES - 2) / 2);
        await mutation(gateway, socket, "multibyte-over", `${multibyteBoundary}a`);
        expect(dispatches).toBe(1);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "poke",
            cookie: "cookie-latest",
            mutResults: [{ mutId: "multibyte-over", ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } }],
        });

        internals.authRefreshBarriers.delete("connection-1");
        await mutation(gateway, socket, "after-overflow", { organizationId: "org-1" });
        expect(dispatches).toBe(2);
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
    });

    test("caps aggregate mutation argument members and nesting before auth waiting or reservation", async () => {
        const internals = gateway as unknown as GatewayInternals;
        const socket = new FakeSocket(attachment("connection-1", "cookie-structure"));
        let dispatches = 0;
        internals.settleMut = async () => {
            dispatches += 1;
        };

        await mutation(
            gateway,
            socket,
            "member-boundary",
            Array.from({ length: CDB_JSON_MAX_AGGREGATE_MEMBERS }, () => null)
        );
        await mutation(gateway, socket, "depth-boundary", nestedArray(CDB_MUTATION_ARGS_MAX_DEPTH));
        expect(dispatches).toBe(2);

        internals.authRefreshBarriers.set("connection-1", new Promise(() => {}));
        await mutation(
            gateway,
            socket,
            "member-over",
            Array.from({ length: CDB_JSON_MAX_AGGREGATE_MEMBERS + 1 }, () => null)
        );
        expect(dispatches).toBe(2);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "poke",
            cookie: "cookie-structure",
            mutResults: [{ mutId: "member-over", ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } }],
        });

        await mutation(gateway, socket, "depth-over", nestedArray(CDB_MUTATION_ARGS_MAX_DEPTH + 1));
        expect(dispatches).toBe(2);
        expect(internals.unsettledMutationCount).toBe(0);
        expect(internals.unsettledMutationsByConnection.size).toBe(0);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "error",
            code: "CDB_UNSUPPORTED_FEATURE",
            retryable: false,
        });
    });
});
