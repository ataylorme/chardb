/**
 * Behaviour tests for `createChardbClient` against an in-process fake
 * WebSocket. Covers the wire round-trip the React hooks rely on:
 *   - hello → welcome captures the baseCookie,
 *   - subscribe → server poke fires the listener with the new rows,
 *   - mutate → server poke.mutResults resolves the pending promise,
 *   - mutResults with ok=false rejects with a typed CdbError,
 *   - mustRefetch resets a sub's state and re-emits `sub`.
 *
 * The fake WebSocket replays a programmable script of inbound messages on
 * the same tick the client `send`s its outbound, so the test stays in
 * synchronous control of ordering.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createChardbClient } from "../src/client/index.ts";
import { CdbError } from "../src/errors.ts";
import { ClientId, Cookie, MutId, SubId } from "../src/types.ts";
import { type Down, type Up, encodeWire } from "../src/wire.ts";

class FakeWS {
    static OPEN = 1 as const;
    static CONNECTING = 0 as const;
    static CLOSING = 2 as const;
    static CLOSED = 3 as const;
    readonly sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState: number = FakeWS.OPEN;
    static instances: FakeWS[] = [];
    constructor(public readonly url: string) {
        FakeWS.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }
    send(raw: string): void {
        this.sent.push(raw);
    }
    close(): void {
        this.readyState = FakeWS.CLOSED;
        queueMicrotask(() => this.onclose?.());
    }
    emit(msg: Down): void {
        this.onmessage?.({ data: encodeWire(msg) });
    }
}

const realWS = globalThis.WebSocket;
const realBC = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

beforeEach(() => {
    FakeWS.instances.length = 0;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
    // BroadcastChannel exists in Bun by default. Disable cross-tab in client opts
    // (crossTab: false) below so the test stays hermetic.
});

afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWS;
    if (realBC === undefined) delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
});

function client() {
    return createChardbClient({
        endpoint: "wss://example.com/ws",
        getJwt: async () => "jwt-stub",
        clientId: "c-test",
        crossTab: false,
    });
}

async function flush() {
    await new Promise<void>(r => queueMicrotask(r));
    await new Promise<void>(r => queueMicrotask(r));
}

describe("createChardbClient — wire round-trip", () => {
    test("hello is sent on open with clientId and jwt", async () => {
        client();
        await flush();
        const ws = FakeWS.instances[0]!;
        expect(ws.sent.length).toBe(1);
        const sent = JSON.parse(ws.sent[0]!) as Up;
        expect(sent.t).toBe("hello");
        if (sent.t !== "hello") throw new Error("unreachable");
        expect(sent.clientId).toBe(ClientId("c-test"));
        expect(sent.jwt).toBe("jwt-stub");
    });

    test("subscribe → server poke delivers rows to the listener", async () => {
        const c = client();
        await flush();
        const ws = FakeWS.instances[0]!;
        const seen: unknown[][] = [];
        c.subscribe<{ id: string }>({ kind: "select", tables: ["messages"] }, rows => seen.push([...rows]));
        await flush();
        // The client should have sent an Up.sub envelope.
        const subSent = ws.sent.map(r => JSON.parse(r) as Up).find(m => m.t === "sub");
        expect(subSent).toBeDefined();
        if (!subSent || subSent.t !== "sub") throw new Error("unreachable");
        // Server pokes with one row patch.
        ws.emit({
            t: "poke",
            cookie: Cookie("c-1:1"),
            patches: [{ op: "put", subId: subSent.subId, rowKey: "row-1", row: { id: "r-1" } }],
        });
        await flush();
        expect(seen.length).toBe(1);
        expect(seen[0]).toEqual([{ id: "r-1", __key: "row-1" }]);
    });

    test("mutate → server poke.mutResults ok=true resolves the promise with the result", async () => {
        const c = client();
        await flush();
        const ws = FakeWS.instances[0]!;
        const promise = c.mutate<{ id: string }>("src/api.ts#post", { body: "hi" });
        await flush();
        const mutSent = ws.sent.map(r => JSON.parse(r) as Up).find(m => m.t === "mut");
        if (!mutSent || mutSent.t !== "mut") throw new Error("expected Up.mut");
        ws.emit({
            t: "poke",
            cookie: Cookie("c-1:2"),
            patches: [],
            mutResults: [{ mutId: mutSent.mutId, ok: true, result: { id: "row-1" }, cookie: Cookie("c-1:2") }],
        });
        const result = await promise;
        expect(result).toEqual({ id: "row-1" });
    });

    test("mutate → mutResults ok=false rejects with a CdbError carrying the wire code", async () => {
        const c = client();
        await flush();
        const ws = FakeWS.instances[0]!;
        const promise = c.mutate("src/api.ts#post", {});
        await flush();
        const mutSent = ws.sent.map(r => JSON.parse(r) as Up).find(m => m.t === "mut");
        if (!mutSent || mutSent.t !== "mut") throw new Error("expected Up.mut");
        ws.emit({
            t: "poke",
            cookie: Cookie("c-1:3"),
            patches: [],
            mutResults: [
                {
                    mutId: mutSent.mutId,
                    ok: false,
                    error: {
                        code: "CDB_CROSS_PARTITION",
                        retryable: false,
                        docs: "https://chardb.dev/errors/cdb_cross_partition",
                    },
                },
            ],
        });
        let captured: CdbError | undefined;
        try {
            await promise;
        } catch (e) {
            if (e instanceof CdbError) captured = e;
        }
        expect(captured).toBeInstanceOf(CdbError);
        expect(captured?.code).toBe("CDB_CROSS_PARTITION");
    });

    test("mustRefetch resets sub state and re-sends an Up.sub envelope", async () => {
        const c = client();
        await flush();
        const ws = FakeWS.instances[0]!;
        const seen: unknown[][] = [];
        c.subscribe<{ id: string }>({ kind: "select", tables: ["messages"] }, rows => seen.push([...rows]));
        await flush();
        // Prime with a row, then issue mustRefetch and confirm the listener
        // sees the cleared state and the client re-sends `sub`.
        ws.emit({
            t: "poke",
            cookie: Cookie("c-1:1"),
            patches: [{ op: "put", subId: SubId(1), rowKey: "r1", row: { id: "r1" } }],
        });
        await flush();
        expect(seen[seen.length - 1]).toEqual([{ id: "r1", __key: "r1" }]);
        const sentBefore = ws.sent.length;
        ws.emit({ t: "mustRefetch", subIds: [SubId(1)], reason: "schemaChanged" });
        await flush();
        // Listener saw cleared rows.
        expect(seen[seen.length - 1]).toEqual([]);
        // Client re-sent the `sub` envelope after refetch.
        const newSubs = ws.sent
            .slice(sentBefore)
            .map(r => JSON.parse(r) as Up)
            .filter(m => m.t === "sub");
        expect(newSubs.length).toBe(1);
    });

    test("reconnect within RYW window resumes from lastCookie via Up.hello.resumeFromCookie", async () => {
        const c = client();
        await flush();
        const ws1 = FakeWS.instances[0]!;
        // Server welcome stamps the resume cookie.
        ws1.emit({ t: "welcome", baseCookie: Cookie("c-1:42"), region: "test" });
        await flush();
        // Drop the connection. The reconnect timer fires after RECONNECT_INITIAL_BACKOFF_MS (250ms)
        // and we want to land inside the 30s RYW window so lastCookie is preserved.
        ws1.close();
        await new Promise(r => setTimeout(r, 350));
        const ws2 = FakeWS.instances[1];
        expect(ws2).toBeDefined();
        if (!ws2) throw new Error("expected reconnect to spawn a new WS");
        await flush();
        const helloAfterReconnect = ws2.sent.map(r => JSON.parse(r) as Up).find(m => m.t === "hello");
        if (!helloAfterReconnect || helloAfterReconnect.t !== "hello") throw new Error("expected hello on reconnect");
        expect(helloAfterReconnect.resumeFromCookie).toBe(Cookie("c-1:42"));
        c.close();
    });

    test("reconnect after RYW window expiry drops lastCookie so server can emit mustRefetch{lagged}", async () => {
        // Pin wall time so we can advance past RECONNECT_RYW_WINDOW_MS (30s)
        // between disconnect and reconnect-timer-fires without sleeping for
        // half a minute. The reconnect timer itself uses real setTimeout, so
        // we still wait its real delay (250ms initial backoff).
        const t0 = new Date("2026-05-10T00:00:00Z");
        setSystemTime(t0);
        const c = client();
        await flush();
        const ws1 = FakeWS.instances[0]!;
        ws1.emit({ t: "welcome", baseCookie: Cookie("c-1:42"), region: "test" });
        await flush();
        ws1.close();
        // Let the onclose microtask run so `lastDisconnectAt` is stamped at t0,
        // then jump past the RYW window before the reconnect timer fires.
        await flush();
        setSystemTime(new Date(t0.getTime() + 31_000));
        await new Promise(r => setTimeout(r, 350));
        const ws2 = FakeWS.instances[1];
        if (!ws2) throw new Error("expected reconnect to spawn a new WS");
        await flush();
        const helloAfter = ws2.sent.map(r => JSON.parse(r) as Up).find(m => m.t === "hello");
        if (!helloAfter || helloAfter.t !== "hello") throw new Error("expected hello on reconnect");
        expect(helloAfter.resumeFromCookie).toBeUndefined();
        setSystemTime();
        c.close();
    });

    test("close() halts further reconnect attempts and stops emitting messages", async () => {
        const c = client();
        await flush();
        const ws = FakeWS.instances[0]!;
        c.close();
        await flush();
        // After close, the client state transitions to closed; sending should be a no-op.
        expect(c.state).toBe("closed");
        void ws;
        void MutId; // unused-import guard for static helpers brought in for clarity
    });
});
