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
import { type ChardbClientOptions, createChardbClient } from "../src/client/index.ts";
import { CdbError } from "../src/errors.ts";
import { ChardbRef, ClientId, Cookie, SubId } from "../src/types.ts";
import { type Down, PROTOCOL_V, type Up, encodeWire } from "../src/wire.ts";

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
    failNextSend = false;
    static instances: FakeWS[] = [];
    constructor(public readonly url: string) {
        FakeWS.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }
    send(raw: string): void {
        if (this.failNextSend) {
            this.failNextSend = false;
            throw new Error("forced send failure");
        }
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
    if (realBC === undefined) Reflect.deleteProperty(globalThis, "BroadcastChannel");
});

function client(overrides: Partial<ChardbClientOptions> = {}) {
    return createChardbClient({
        endpoint: "wss://example.com/ws",
        getJwt: async () => "jwt-stub",
        clientId: "c-test",
        crossTab: false,
        ...overrides,
    });
}

async function flush() {
    await new Promise<void>(r => queueMicrotask(r));
    await new Promise<void>(r => queueMicrotask(r));
}

function fakeWebSocket(index = 0): FakeWS {
    const ws = FakeWS.instances[index];
    if (!ws) throw new Error(`expected fake WebSocket instance ${index}`);
    return ws;
}

async function welcome(ws: FakeWS, cookie = "c-test:0"): Promise<void> {
    ws.emit({ t: "welcome", protocolV: PROTOCOL_V, baseCookie: Cookie(cookie), region: "test" });
    await flush();
}

function spyOnClearTimeout(): { readonly calls: unknown[]; restore: () => void } {
    const original = globalThis.clearTimeout;
    const calls: unknown[] = [];
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
        calls.push(handle);
        original(handle);
    }) as typeof clearTimeout;
    return {
        calls,
        restore() {
            globalThis.clearTimeout = original;
        },
    };
}

function installManualTimers(): {
    runDelay: (delayMs: number) => void;
    scheduledDelays: () => number[];
    restore: () => void;
} {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nextId = 1;
    const scheduled = new Map<number, { readonly delayMs: number; readonly run: () => void }>();
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delayMs = 0, ...args: unknown[]) => {
        const id = nextId++;
        scheduled.set(id, { delayMs, run: () => callback(...args) });
        return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
        scheduled.delete(handle as unknown as number);
    }) as typeof clearTimeout;
    return {
        runDelay(delayMs) {
            const entry = [...scheduled].find(([, timer]) => timer.delayMs === delayMs);
            if (!entry) throw new Error(`expected a scheduled ${delayMs}ms timer`);
            scheduled.delete(entry[0]);
            entry[1].run();
        },
        scheduledDelays() {
            return [...scheduled.values()].map(timer => timer.delayMs);
        },
        restore() {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        },
    };
}

describe("createChardbClient — wire round-trip", () => {
    test("rejects mutation timeout values that cannot produce a bounded timer", () => {
        for (const mutationTimeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
            expect(() => client({ mutationTimeoutMs })).toThrow(
                "mutationTimeoutMs must be an integer between 1 and 2147483647"
            );
        }
        expect(FakeWS.instances).toHaveLength(0);
    });

    test("hello is sent on open with clientId and jwt", async () => {
        client();
        await flush();
        const ws = fakeWebSocket();
        expect(ws.sent.length).toBe(1);
        const rawSent = ws.sent[0];
        if (!rawSent) throw new Error("expected the client to send a hello envelope");
        const sent = JSON.parse(rawSent) as Up;
        expect(sent.t).toBe("hello");
        if (sent.t !== "hello") throw new Error("unreachable");
        expect(sent.clientId).toBe(ClientId("c-test"));
        expect(sent.jwt).toBe("jwt-stub");
        expect(sent.protocolV).toBe(PROTOCOL_V);
    });

    test("a mismatched welcome protocol terminates every queued operation once", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        let subscriptionNotifications = 0;
        c.subscribe("queries.ts#listMessages", {}, () => subscriptionNotifications++);
        let rejectionCount = 0;
        const mutationErrors = [c.mutate("src/api.ts#one", {}), c.mutate("src/api.ts#two", {})].map(promise =>
            promise.catch(error => {
                rejectionCount++;
                return error;
            })
        );
        ws.onmessage?.({
            data: JSON.stringify({ t: "welcome", protocolV: 2, baseCookie: "c-1:42", region: "test" }),
        });
        await flush();
        expect(c.state).toBe("closed");
        expect(ws.readyState).toBe(FakeWS.CLOSED);
        expect(subscriptionNotifications).toBe(1);
        expect(rejectionCount).toBe(2);
        for (const error of await Promise.all(mutationErrors)) {
            expect(error).toMatchObject({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: "server selected an unsupported Chardb protocol version",
            });
        }
        c.close();
        await flush();
        expect(subscriptionNotifications).toBe(1);
        expect(rejectionCount).toBe(2);
    });

    test("queues protected operations until the verified welcome arrives", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        c.subscribe("queries.ts#listMessages", { organizationId: "org-1" }, () => {});
        const mutation = c.mutate("src/api.ts#post", { body: "hi" });
        await flush();
        expect(ws.sent.map(raw => (JSON.parse(raw) as Up).t)).toEqual(["hello"]);

        await welcome(ws);
        expect(ws.sent.map(raw => (JSON.parse(raw) as Up).t)).toEqual(["hello", "sub", "mut"]);
        const rejection = mutation.catch(error => error);
        c.close();
        await expect(rejection).resolves.toMatchObject({ code: "CDB_STREAM_ABORTED" });
    });

    test("getJwt rejection terminates queued work without opening a socket", async () => {
        let rejectJwt: ((reason: unknown) => void) | undefined;
        const jwt = new Promise<string>((_resolve, reject) => {
            rejectJwt = reject;
        });
        const c = createChardbClient({
            endpoint: "wss://example.com/ws",
            getJwt: () => jwt,
            clientId: "c-jwt-failure",
            crossTab: false,
        });
        let subscriptionNotifications = 0;
        c.subscribe("queries.ts#listMessages", {}, () => subscriptionNotifications++);
        const mutationError = c.mutate("src/api.ts#post", {}).catch(error => error);
        if (!rejectJwt) throw new Error("expected getJwt to start during client construction");
        rejectJwt(new Error("token endpoint unavailable"));
        await flush();

        expect(c.state).toBe("closed");
        expect(FakeWS.instances).toHaveLength(0);
        expect(subscriptionNotifications).toBe(1);
        await expect(mutationError).resolves.toMatchObject({
            code: "CDB_INVARIANT",
            message: "failed to establish Chardb client session",
        });
    });

    test("invalid connection setup terminates queued work without retrying", async () => {
        const c = createChardbClient({
            endpoint: "not a websocket URL",
            getJwt: async () => "jwt-stub",
            clientId: "c-setup-failure",
            crossTab: false,
        });
        const mutationError = c.mutate("src/api.ts#post", {}).catch(error => error);
        await flush();

        expect(c.state).toBe("closed");
        expect(FakeWS.instances).toHaveLength(0);
        await expect(mutationError).resolves.toMatchObject({
            code: "CDB_INVARIANT",
            message: "failed to establish Chardb client session",
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(FakeWS.instances).toHaveLength(0);
    });

    test("a malformed pre-welcome message terminates queued work", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        let subscriptionNotifications = 0;
        c.subscribe("queries.ts#listMessages", {}, () => subscriptionNotifications++);
        const mutationError = c.mutate("src/api.ts#post", {}).catch(error => error);
        ws.onmessage?.({ data: "{" });
        await flush();

        expect(c.state).toBe("closed");
        expect(subscriptionNotifications).toBe(1);
        await expect(mutationError).resolves.toMatchObject({
            code: "CDB_INVARIANT",
            message: "server sent an invalid Chardb handshake message",
        });
    });

    test("a malformed established-session message settles in-flight work instead of escaping the callback", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        let subscriptionNotifications = 0;
        c.subscribe("queries.ts#listMessages", {}, () => subscriptionNotifications++);
        const mutationError = c.mutate("src/api.ts#post", {}).catch(error => error);
        ws.onmessage?.({ data: "{" });
        await flush();

        expect(c.state).toBe("closed");
        expect(subscriptionNotifications).toBe(1);
        await expect(mutationError).resolves.toMatchObject({
            code: "CDB_INVARIANT",
            message: "server sent an invalid Chardb session message",
        });
    });

    test("a terminal auth error before welcome closes without entering a reconnect loop", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        let subscriptionNotifications = 0;
        c.subscribe("queries.ts#listMessages", {}, () => subscriptionNotifications++);
        const mutation = c.mutate("src/api.ts#post", {});
        ws.emit({
            t: "error",
            code: "CDB_FORBIDDEN",
            retryable: false,
            correlationId: "corr-auth" as never,
            docs: "https://chardb.dev/errors/cdb_forbidden",
        });
        await flush();
        expect(c.state).toBe("closed");
        expect(ws.readyState).toBe(FakeWS.CLOSED);
        expect(subscriptionNotifications).toBe(1);
        await expect(mutation).rejects.toMatchObject({ code: "CDB_FORBIDDEN" });
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(FakeWS.instances).toHaveLength(1);
    });

    test("a protocol mismatch before welcome terminates queued work", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        const mutation = c.mutate("src/api.ts#post", {});
        ws.emit({ t: "mustRefetch", subIds: [], reason: "protocolMismatch" });
        await flush();
        expect(c.state).toBe("closed");
        await expect(mutation).rejects.toMatchObject({ code: "CDB_UNSUPPORTED_FEATURE" });
    });

    test("subscribe → server poke delivers rows to the listener", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        c.subscribe<{ id: string }>("queries.ts#listMessages", { organizationId: "org-1" }, rows =>
            seen.push([...rows])
        );
        await flush();
        // The client should have sent an Up.sub envelope.
        const subSent = ws.sent.map(r => JSON.parse(r) as Up).find(m => m.t === "sub");
        expect(subSent).toBeDefined();
        if (!subSent || subSent.t !== "sub") throw new Error("unreachable");
        expect(subSent.ref).toBe(ChardbRef("queries.ts#listMessages"));
        expect(subSent.args).toEqual({ organizationId: "org-1" });
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

    test("snapshot replaces existing rows exactly", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        c.subscribe("queries.ts#listMessages", {}, rows => seen.push([...rows]));
        await flush();

        ws.emit({
            t: "poke",
            cookie: Cookie("c-1:1"),
            patches: [{ op: "put", subId: SubId(1), rowKey: "stale", row: { id: "stale" } }],
        });
        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:2"),
            rows: [{ id: "fresh-1" }, { id: "fresh-2", nested: { value: true } }],
        });
        await flush();

        expect(seen.at(-1)).toEqual([{ id: "fresh-1" }, { id: "fresh-2", nested: { value: true } }]);
        c.close();
    });

    test("empty snapshot replaces rows and notifies the subscription", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        c.subscribe("queries.ts#listMessages", {}, rows => seen.push([...rows]));
        await flush();

        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:1"),
            rows: [],
        });
        await flush();

        expect(seen).toEqual([[]]);
        expect(ws.sent.map(raw => JSON.parse(raw) as Up)).toContainEqual({ t: "ack", cookie: Cookie("c-1:1") });
        c.close();
    });

    test("a duplicate snapshot does not notify or regress the connection cookie", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        c.subscribe("queries.ts#listMessages", {}, rows => seen.push([...rows]));
        await flush();

        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:1"),
            rows: [{ id: "first" }],
        });
        ws.emit({ t: "poke", cookie: Cookie("c-1:2"), patches: [] });
        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:1"),
            rows: [{ id: "duplicate-must-not-apply" }],
        });
        await flush();

        expect(seen).toEqual([[{ id: "first" }]]);
        ws.close();
        await new Promise(resolve => setTimeout(resolve, 350));
        const reconnected = fakeWebSocket(1);
        await flush();
        const hello = reconnected.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "hello");
        if (!hello || hello.t !== "hello") throw new Error("expected hello on reconnect");
        expect(hello.resumeFromCookie).toBe(Cookie("c-1:2"));
        c.close();
    });

    test("a duplicate snapshot preserves an optimistic row until a newer snapshot replaces it", async () => {
        class TestBroadcastChannel {
            static instance: TestBroadcastChannel | undefined;
            onmessage: ((event: { data: unknown }) => void) | null = null;

            constructor(_name: string) {
                TestBroadcastChannel.instance = this;
            }

            postMessage(): void {}
            close(): void {}
            emit(data: unknown): void {
                this.onmessage?.({ data });
            }
        }

        (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = TestBroadcastChannel;
        try {
            const c = createChardbClient({
                endpoint: "wss://example.com/ws",
                getJwt: async () => "jwt-stub",
                clientId: "c-test",
                logicalDb: "snapshot-dedupe",
            });
            await flush();
            const ws = fakeWebSocket();
            await welcome(ws);
            const seen: unknown[][] = [];
            c.subscribe("queries.ts#listMessages", {}, rows => seen.push([...rows]));
            await flush();

            ws.emit({
                t: "snapshot",
                subId: SubId(1),
                cookie: Cookie("c-1:1"),
                rows: [{ id: "base" }],
            });
            ws.emit({
                t: "snapshot",
                subId: SubId(1),
                cookie: Cookie("c-1:1"),
                rows: [{ id: "duplicate-before-patch-must-not-apply" }],
            });
            await flush();
            expect(seen).toEqual([[{ id: "base" }]]);
            expect(ws.sent.filter(raw => (JSON.parse(raw) as Up).t === "ack")).toHaveLength(2);

            TestBroadcastChannel.instance?.emit({
                kind: "optimistic",
                patches: [{ op: "put", subId: SubId(1), rowKey: "local", row: { id: "optimistic" } }],
            });
            await flush();
            expect(seen.at(-1)).toEqual([{ id: "base" }, { id: "optimistic", __key: "local" }]);

            ws.emit({
                t: "snapshot",
                subId: SubId(1),
                cookie: Cookie("c-1:1"),
                rows: [{ id: "duplicate-must-not-apply" }],
            });
            await flush();
            expect(seen).toHaveLength(2);
            expect(seen.at(-1)).toEqual([{ id: "base" }, { id: "optimistic", __key: "local" }]);
            expect(ws.sent.filter(raw => (JSON.parse(raw) as Up).t === "ack")).toHaveLength(3);

            ws.emit({
                t: "snapshot",
                subId: SubId(1),
                cookie: Cookie("c-1:2"),
                rows: [{ id: "replacement" }],
            });
            await flush();
            expect(seen).toHaveLength(3);
            expect(seen.at(-1)).toEqual([{ id: "replacement" }]);
            expect(
                ws.sent
                    .map(raw => JSON.parse(raw) as Up)
                    .filter((message): message is Extract<Up, { t: "ack" }> => message.t === "ack")
                    .map(message => message.cookie)
            ).toEqual([Cookie("c-1:1"), Cookie("c-1:1"), Cookie("c-1:1"), Cookie("c-1:2")]);
            c.close();
        } finally {
            if (realBC === undefined) Reflect.deleteProperty(globalThis, "BroadcastChannel");
            else (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = realBC;
        }
    });

    test("snapshots for unknown or unsubscribed subscriptions are not acknowledged", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        const subscription = c.subscribe("queries.ts#listMessages", {}, rows => seen.push([...rows]));
        await flush();

        subscription.unsubscribe();
        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:98"),
            rows: [{ id: "for-unsubscribed-sub" }],
        });

        ws.emit({
            t: "snapshot",
            subId: SubId(999),
            cookie: Cookie("c-1:99"),
            rows: [{ id: "not-for-this-client" }],
        });
        await flush();

        expect(seen).toEqual([]);
        expect(ws.sent.some(raw => (JSON.parse(raw) as Up).t === "ack")).toBe(false);
        expect(c.state).toBe("open");
        ws.close();
        await new Promise(resolve => setTimeout(resolve, 350));
        const reconnected = fakeWebSocket(1);
        await flush();
        const hello = reconnected.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "hello");
        if (!hello || hello.t !== "hello") throw new Error("expected hello on reconnect");
        expect(hello.resumeFromCookie).toBe(Cookie("c-test:0"));
        c.close();
    });

    test("a failed snapshot acknowledgement is retried on duplicate delivery after reconnect", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        c.subscribe("queries.ts#listMessages", {}, rows => seen.push([...rows]));
        await flush();

        ws.failNextSend = true;
        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:1"),
            rows: [{ id: "applied-before-ack-failure" }],
        });
        await flush();
        expect(c.state).toBe("open");
        expect(seen).toEqual([[{ id: "applied-before-ack-failure" }]]);
        expect(ws.sent.some(raw => (JSON.parse(raw) as Up).t === "ack")).toBe(false);

        ws.close();
        await new Promise(resolve => setTimeout(resolve, 350));
        const reconnected = fakeWebSocket(1);
        await flush();
        await welcome(reconnected, "c-1:1");
        reconnected.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:1"),
            rows: [{ id: "duplicate-must-not-reapply" }],
        });
        await flush();

        expect(c.state).toBe("open");
        expect(seen).toEqual([[{ id: "applied-before-ack-failure" }]]);
        expect(reconnected.sent.map(raw => JSON.parse(raw) as Up)).toContainEqual({
            t: "ack",
            cookie: Cookie("c-1:1"),
        });
        c.close();
    });

    test("malformed snapshot terminates the established session", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        let subscriptionNotifications = 0;
        c.subscribe("queries.ts#listMessages", {}, () => subscriptionNotifications++);
        await flush();

        ws.onmessage?.({ data: JSON.stringify({ t: "snapshot", subId: 1, cookie: "c-1:1" }) });
        await flush();

        expect(c.state).toBe("closed");
        expect(subscriptionNotifications).toBe(1);
    });

    test("mutate → server poke.mutResults ok=true resolves the promise with the result", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
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

    test("a successful mutation clears its deadline timer", async () => {
        const c = client({ mutationTimeoutMs: 1_000 });
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const timeoutSpy = spyOnClearTimeout();
        try {
            const mutation = c.mutate("src/api.ts#post", {});
            await flush();
            const sent = ws.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "mut");
            if (!sent || sent.t !== "mut") throw new Error("expected Up.mut");
            ws.emit({
                t: "poke",
                cookie: Cookie("c-1:2"),
                patches: [],
                mutResults: [{ mutId: sent.mutId, ok: true, result: null, cookie: Cookie("c-1:2") }],
            });
            await mutation;
            expect(timeoutSpy.calls).toHaveLength(1);
        } finally {
            timeoutSpy.restore();
            c.close();
        }
    });

    test("mutate → mutResults ok=false rejects with a CdbError carrying the wire code", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
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

    test("a terminal server mutation failure clears its deadline timer", async () => {
        const c = client({ mutationTimeoutMs: 1_000 });
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const timeoutSpy = spyOnClearTimeout();
        try {
            const mutation = c.mutate("src/api.ts#post", {});
            await flush();
            const sent = ws.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "mut");
            if (!sent || sent.t !== "mut") throw new Error("expected Up.mut");
            ws.emit({
                t: "poke",
                cookie: Cookie("c-1:3"),
                patches: [],
                mutResults: [
                    {
                        mutId: sent.mutId,
                        ok: false,
                        error: {
                            code: "CDB_CROSS_PARTITION",
                            retryable: false,
                            docs: "https://chardb.dev/errors/cdb_cross_partition",
                        },
                    },
                ],
            });
            await expect(mutation).rejects.toMatchObject({ code: "CDB_CROSS_PARTITION", retryable: false });
            expect(timeoutSpy.calls).toHaveLength(1);
        } finally {
            timeoutSpy.restore();
            c.close();
        }
    });

    test("a synchronous mutation send failure settles once and cannot resend after reconnect", async () => {
        const c = client({ mutationTimeoutMs: 1_000 });
        await flush();
        const first = fakeWebSocket();
        await welcome(first);
        const timeoutSpy = spyOnClearTimeout();
        try {
            first.failNextSend = true;
            const mutation = c.mutate("src/api.ts#post", {});
            await expect(mutation).rejects.toMatchObject({ code: "CDB_STREAM_ABORTED", retryable: true });
            expect(timeoutSpy.calls).toHaveLength(1);

            first.close();
            await new Promise(resolve => setTimeout(resolve, 350));
            const reconnected = fakeWebSocket(1);
            await welcome(reconnected);
            expect(reconnected.sent.map(raw => (JSON.parse(raw) as Up).t)).toEqual(["hello"]);
        } finally {
            timeoutSpy.restore();
            c.close();
        }
    });

    test("a mutation timeout rejects once as outcome-unknown and ignores a late result", async () => {
        const c = client({ mutationTimeoutMs: 20 });
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        let rejectionCount = 0;
        const mutationError = c.mutate("src/api.ts#post", {}).catch(error => {
            rejectionCount++;
            return error;
        });
        await flush();
        const sent = ws.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "mut");
        if (!sent || sent.t !== "mut") throw new Error("expected Up.mut");

        await new Promise(resolve => setTimeout(resolve, 40));
        await expect(mutationError).resolves.toMatchObject({
            code: "CDB_MUTATION_OUTCOME_UNKNOWN",
            retryable: false,
            message: `mutation ${sent.mutId} timed out after 20ms`,
        });

        ws.emit({
            t: "poke",
            cookie: Cookie("c-1:4"),
            patches: [],
            mutResults: [{ mutId: sent.mutId, ok: true, result: { late: true }, cookie: Cookie("c-1:4") }],
        });
        await flush();
        expect(rejectionCount).toBe(1);
        expect(c.state).toBe("open");
        c.close();
    });

    test("reconnect resends the same mutId without resetting the original deadline", async () => {
        const timers = installManualTimers();
        const c = client({ mutationTimeoutMs: 500 });
        try {
            await flush();
            const first = fakeWebSocket();
            await welcome(first);
            const mutation = c.mutate("src/api.ts#post", { body: "once" });
            await flush();
            const firstSend = first.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "mut");
            if (!firstSend || firstSend.t !== "mut") throw new Error("expected first Up.mut");

            first.close();
            await flush();
            expect(timers.scheduledDelays().sort((a, b) => a - b)).toEqual([250, 500]);
            timers.runDelay(250);
            await flush();
            const reconnected = fakeWebSocket(1);
            await welcome(reconnected, "c-1:4");
            const retry = reconnected.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "mut");
            if (!retry || retry.t !== "mut") throw new Error("expected retried Up.mut");
            expect(retry).toEqual(firstSend);
            expect(timers.scheduledDelays()).toEqual([500]);

            timers.runDelay(500);
            await expect(mutation).rejects.toMatchObject({
                code: "CDB_MUTATION_OUTCOME_UNKNOWN",
                retryable: false,
                message: `mutation ${retry.mutId} timed out after 500ms`,
            });
        } finally {
            timers.restore();
            c.close();
        }
    });

    test("mustRefetch resets sub state and re-sends an Up.sub envelope", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        c.subscribe<{ id: string }>("queries.ts#listMessages", { organizationId: "org-1" }, rows =>
            seen.push([...rows])
        );
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
        const resent = newSubs[0];
        if (!resent || resent.t !== "sub") throw new Error("expected a re-sent query subscription");
        expect(resent.ref).toBe(ChardbRef("queries.ts#listMessages"));
        expect(resent.args).toEqual({ organizationId: "org-1" });
    });

    test("a subscription error clears rows instead of leaving stale live data", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: unknown[][] = [];
        c.subscribe<{ id: string }>("queries.ts#listMessages", { organizationId: "org-1" }, rows =>
            seen.push([...rows])
        );
        await flush();
        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:1"),
            rows: [{ id: "r1" }],
        });
        await flush();
        expect(seen[seen.length - 1]).toEqual([{ id: "r1" }]);

        ws.emit({
            t: "error",
            code: "CDB_FORBIDDEN",
            retryable: false,
            correlationId: "corr-revoked" as never,
            docs: "https://chardb.dev/errors/cdb_forbidden",
            subId: SubId(1),
        });
        await flush();

        expect(seen[seen.length - 1]).toEqual([]);
    });

    test("reconnect within RYW window resumes from lastCookie via Up.hello.resumeFromCookie", async () => {
        const c = client();
        await flush();
        const ws1 = fakeWebSocket();
        // Server welcome stamps the resume cookie.
        ws1.emit({ t: "welcome", protocolV: PROTOCOL_V, baseCookie: Cookie("c-1:42"), region: "test" });
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
        const ws1 = fakeWebSocket();
        ws1.emit({ t: "welcome", protocolV: PROTOCOL_V, baseCookie: Cookie("c-1:42"), region: "test" });
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

    test("close() settles queued work once and halts reconnect attempts", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        let subscriptionNotifications = 0;
        c.subscribe("queries.ts#listMessages", {}, () => subscriptionNotifications++);
        let rejectionCount = 0;
        const mutationError = c.mutate("src/api.ts#post", {}).catch(error => {
            rejectionCount++;
            return error;
        });
        c.close();
        c.close();
        await flush();
        expect(c.state).toBe("closed");
        expect(ws.readyState).toBe(FakeWS.CLOSED);
        expect(subscriptionNotifications).toBe(1);
        expect(rejectionCount).toBe(1);
        await expect(mutationError).resolves.toMatchObject({
            code: "CDB_STREAM_ABORTED",
            message: "Chardb client closed before pending work settled",
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(FakeWS.instances).toHaveLength(1);
    });

    test("close clears every pending mutation deadline", async () => {
        const c = client({ mutationTimeoutMs: 1_000 });
        await flush();
        const timeoutSpy = spyOnClearTimeout();
        try {
            const mutations = [c.mutate("src/api.ts#one", {}), c.mutate("src/api.ts#two", {})];
            c.close();
            await Promise.all(
                mutations.map(mutation => expect(mutation).rejects.toMatchObject({ code: "CDB_STREAM_ABORTED" }))
            );
            expect(timeoutSpy.calls).toHaveLength(2);
        } finally {
            timeoutSpy.restore();
            c.close();
        }
    });

    test("mutate after close rejects immediately without creating a deadline", async () => {
        const c = client({ mutationTimeoutMs: 1_000 });
        await flush();
        c.close();
        await flush();
        const timeoutSpy = spyOnClearTimeout();
        try {
            await expect(c.mutate("src/api.ts#after-close", {})).rejects.toMatchObject({
                code: "CDB_STREAM_ABORTED",
                retryable: true,
            });
            expect(timeoutSpy.calls).toHaveLength(0);
        } finally {
            timeoutSpy.restore();
        }
    });
});
