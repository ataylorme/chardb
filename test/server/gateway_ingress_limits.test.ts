import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { VerifiedGwAttachment } from "../../src/server/do/gateway-auth-dispatch.ts";
import { Gateway, type GatewayEnv } from "../../src/server/do/gateway.ts";
import { ClientId, Cookie, PrincipalId } from "../../src/types.ts";

const INBOUND_TEXT_LIMIT = 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();

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
    readonly closed: Array<{ code: number; reason: string }> = [];

    constructor(private readonly attachment: VerifiedGwAttachment) {}

    deserializeAttachment(): VerifiedGwAttachment {
        return this.attachment;
    }

    send(message: string): void {
        this.sent.push(message);
    }

    close(code: number, reason: string): void {
        this.closed.push({ code, reason });
    }
}

function mutationText(payload: string): string {
    return JSON.stringify({ t: "mut", mutId: "mutation-1", ref: "mutations.ts#write", args: { payload } });
}

describe("Gateway inbound WebSocket text limit", () => {
    let db: Database;
    let gateway: Gateway;
    let socket: FakeSocket;
    let dispatched: string[];
    let ready: Promise<unknown>;

    beforeEach(async () => {
        db = new Database(":memory:");
        ready = Promise.resolve();
        let alarm: number | null = null;
        const state = {
            id: { toString: () => "gateway-ingress-limit" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async () => alarm,
                setAlarm: async (value: number | Date) => {
                    alarm = value instanceof Date ? value.getTime() : value;
                },
            },
            getWebSockets: () => [socket] as unknown as WebSocket[],
            blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        const env = {
            CDB_CATALOG: {} as DurableObjectNamespace,
            CDB_SHARD: {} as DurableObjectNamespace,
        } satisfies GatewayEnv;
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
        gateway = new Gateway(state, env);
        await ready;
        dispatched = [];
        (gateway as unknown as { onMut: (_ws: WebSocket, msg: { mutId: string }) => Promise<void> }).onMut = async (
            _ws,
            msg
        ) => {
            dispatched.push(msg.mutId);
        };
    });

    afterEach(() => db.close());

    test("accepts the exact byte boundary and closes one byte over without dispatch or persistence", async () => {
        const empty = mutationText("");
        const payloadBytes = INBOUND_TEXT_LIMIT - TEXT_ENCODER.encode(empty).byteLength;
        const boundary = mutationText("a".repeat(payloadBytes));
        const overLimit = mutationText("a".repeat(payloadBytes + 1));
        expect(TEXT_ENCODER.encode(boundary).byteLength).toBe(INBOUND_TEXT_LIMIT);
        expect(TEXT_ENCODER.encode(overLimit).byteLength).toBe(INBOUND_TEXT_LIMIT + 1);

        await gateway.webSocketMessage(socket as unknown as WebSocket, boundary);
        expect(dispatched).toEqual(["mutation-1"]);

        dispatched = [];
        await gateway.webSocketMessage(socket as unknown as WebSocket, overLimit);
        expect(dispatched).toEqual([]);
        expect(socket.sent).toEqual([]);
        expect(socket.closed).toEqual([{ code: 1009, reason: "message too large" }]);
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_registration_generations").get()).toEqual({ count: 0 });
    });

    test("measures multibyte UTF-8 and leaves normal traffic to a separate connection", async () => {
        const multibyte = mutationText("é".repeat(Math.floor(INBOUND_TEXT_LIMIT / 2) + 1));
        expect(multibyte.length).toBeLessThan(INBOUND_TEXT_LIMIT);
        expect(TEXT_ENCODER.encode(multibyte).byteLength).toBeGreaterThan(INBOUND_TEXT_LIMIT);

        await gateway.webSocketMessage(socket as unknown as WebSocket, multibyte);
        expect(dispatched).toEqual([]);
        expect(socket.sent).toEqual([]);
        expect(socket.closed).toEqual([{ code: 1009, reason: "message too large" }]);

        const replacement = new FakeSocket({
            kind: "verified",
            connectionId: "connection-2",
            authOrigin: "https://app.example",
            clientId: ClientId("client-1"),
            principalId: PrincipalId("principal-1"),
            jwtExp: Math.floor(Date.now() / 1_000) + 10_000,
            lastCookie: Cookie("cookie-replacement"),
            snapshotSubIds: [],
        });
        await gateway.webSocketMessage(replacement as unknown as WebSocket, mutationText("small"));
        expect(dispatched).toEqual(["mutation-1"]);
        expect(replacement.closed).toEqual([]);
    });
});
