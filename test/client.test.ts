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
import { ChardbRef, ClientId, Cookie, type RawJson, SubId } from "../src/types.ts";
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

function captureCdbError(run: () => unknown): CdbError {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(CdbError);
    return caught as CdbError;
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

    test("caps active subscriptions at 64 without sending or consuming an id for rejected work", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        expect(() => c.subscribe("invalid-ref", {}, () => {})).toThrow("invalid ChardbRef");
        const subscriptions = Array.from({ length: 64 }, (_, index) =>
            c.subscribe("queries.ts#bounded", { index }, () => {})
        );
        const admitted = ws.sent.map(raw => JSON.parse(raw) as Up).filter(message => message.t === "sub");
        expect(admitted).toHaveLength(64);
        expect(admitted.at(0)).toMatchObject({ t: "sub", subId: 1 });
        expect(admitted.at(-1)).toMatchObject({ t: "sub", subId: 64 });

        ws.emit({ t: "snapshot", subId: SubId(1), cookie: Cookie("c-test:1"), rows: [] });
        await flush();
        const sentBeforeRejection = ws.sent.length;
        expect(() => c.subscribe("still-invalid-at-cap", {}, () => {})).toThrow("invalid ChardbRef");
        expect(ws.sent).toHaveLength(sentBeforeRejection);
        const limited = captureCdbError(() => c.subscribe("queries.ts#over-limit", {}, () => {}));
        expect(limited).toMatchObject({ code: "CDB_RATE_LIMITED", retryable: true });
        expect(ws.sent).toHaveLength(sentBeforeRejection);

        subscriptions[0]?.unsubscribe();
        const replacement = c.subscribe("queries.ts#replacement", {}, () => {});
        expect(
            ws.sent
                .map(raw => JSON.parse(raw) as Up)
                .filter(message => message.t === "sub")
                .at(-1)
        ).toMatchObject({
            t: "sub",
            subId: 65,
        });
        replacement.unsubscribe();
        c.close();
        expect(captureCdbError(() => c.subscribe("queries.ts#after-close", {}, () => {}))).toMatchObject({
            code: "CDB_STREAM_ABORTED",
        });
    });

    test("rolls back a subscription whose synchronous send fails and never reconnects it", async () => {
        const timers = installManualTimers();
        const c = client();
        try {
            await flush();
            const first = fakeWebSocket();
            await welcome(first);
            first.failNextSend = true;
            expect(captureCdbError(() => c.subscribe("queries.ts#send-failure", {}, () => {}))).toMatchObject({
                code: "CDB_STREAM_ABORTED",
            });

            first.close();
            await flush();
            timers.runDelay(250);
            await flush();
            const reconnected = fakeWebSocket(1);
            await welcome(reconnected);
            expect(reconnected.sent.map(raw => (JSON.parse(raw) as Up).t)).toEqual(["hello"]);

            c.subscribe("queries.ts#replacement-after-send-failure", {}, () => {});
            expect(
                reconnected.sent.map(raw => JSON.parse(raw) as Up).find(message => message.t === "sub")
            ).toMatchObject({ t: "sub", subId: 2 });
        } finally {
            timers.restore();
            c.close();
        }
    });

    test("closes the session when unsubscribe cannot reach the server", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const first = c.subscribe("queries.ts#first", {}, () => {});
        let remainingNotifications = 0;
        c.subscribe("queries.ts#remaining", {}, () => remainingNotifications++);
        ws.failNextSend = true;

        expect(captureCdbError(() => first.unsubscribe())).toMatchObject({ code: "CDB_STREAM_ABORTED" });
        expect(c.state).toBe("closed");
        expect(ws.readyState).toBe(FakeWS.CLOSED);
        expect(remainingNotifications).toBe(1);
        expect(captureCdbError(() => c.subscribe("queries.ts#after-unsub-failure", {}, () => {}))).toMatchObject({
            code: "CDB_STREAM_ABORTED",
        });
    });

    test("finishes terminal cleanup when a subscription listener throws", async () => {
        class ClosingBroadcastChannel {
            static instance: ClosingBroadcastChannel | undefined;
            onmessage: ((event: { data: unknown }) => void) | null = null;
            closeCalls = 0;

            constructor(_name: string) {
                ClosingBroadcastChannel.instance = this;
            }

            close(): void {
                this.closeCalls += 1;
            }
        }

        (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = ClosingBroadcastChannel;
        const timeoutSpy = spyOnClearTimeout();
        try {
            const c = createChardbClient({
                endpoint: "wss://example.com/ws",
                getJwt: async () => "jwt-stub",
                clientId: "c-listener-cleanup",
                logicalDb: "listener-cleanup",
            });
            await flush();
            const ws = fakeWebSocket();
            await welcome(ws);
            c.subscribe("queries.ts#throwing", {}, () => {
                throw new Error("listener failed");
            });
            let remainingNotifications = 0;
            c.subscribe("queries.ts#remaining", {}, () => remainingNotifications++);
            const mutationError = c.mutate("mutations.ts#pending", {}).catch(error => error);

            expect(() => c.close()).not.toThrow();
            await expect(mutationError).resolves.toMatchObject({ code: "CDB_STREAM_ABORTED" });
            expect(remainingNotifications).toBe(1);
            expect(timeoutSpy.calls).toHaveLength(1);
            expect(ws.readyState).toBe(FakeWS.CLOSED);
            expect(ClosingBroadcastChannel.instance?.closeCalls).toBe(1);
        } finally {
            timeoutSpy.restore();
            if (realBC === undefined) Reflect.deleteProperty(globalThis, "BroadcastChannel");
            else (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = realBC;
        }
    });

    test("reconnect resends the same 64 subscriptions without consuming more capacity", async () => {
        const timers = installManualTimers();
        const c = client();
        try {
            await flush();
            const first = fakeWebSocket();
            await welcome(first);
            const subscriptions = Array.from({ length: 64 }, (_, index) =>
                c.subscribe("queries.ts#bounded-reconnect", { index }, () => {})
            );

            first.close();
            await flush();
            timers.runDelay(250);
            await flush();
            const reconnected = fakeWebSocket(1);
            await welcome(reconnected);
            expect(
                reconnected.sent.map(raw => JSON.parse(raw) as Up).filter(message => message.t === "sub")
            ).toHaveLength(64);

            const sentBeforeRejection = reconnected.sent.length;
            expect(captureCdbError(() => c.subscribe("queries.ts#reconnect-over-limit", {}, () => {}))).toMatchObject({
                code: "CDB_RATE_LIMITED",
            });
            expect(reconnected.sent).toHaveLength(sentBeforeRejection);

            subscriptions[0]?.unsubscribe();
            c.subscribe("queries.ts#reconnect-replacement", {}, () => {});
            expect(
                reconnected.sent
                    .map(raw => JSON.parse(raw) as Up)
                    .filter(message => message.t === "sub")
                    .at(-1)
            ).toMatchObject({ t: "sub", subId: 65 });
        } finally {
            timers.restore();
            c.close();
        }
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

    test("accepts 4096 snapshot rows and terminates before storing one over", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: RawJson[][] = [];
        c.subscribe("queries.ts#bounded-snapshot", {}, rows => seen.push([...rows]));
        const boundaryRows = Array.from({ length: 4_096 }, (_, index) => ({ id: index }));
        ws.emit({ t: "snapshot", subId: SubId(1), cookie: Cookie("c-test:rows-boundary"), rows: boundaryRows });
        await flush();
        expect(c.state).toBe("open");
        expect(seen.at(-1)).toHaveLength(4_096);

        const pendingMutation = c.mutate("mutations.ts#pending-at-row-overflow", {}).catch(error => error);
        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-test:rows-over"),
            rows: [...boundaryRows, { id: 4_096 }],
        });
        await flush();
        expect(c.state).toBe("closed");
        expect(ws.readyState).toBe(FakeWS.CLOSED);
        expect(seen.at(-1)).toHaveLength(4_096);
        expect(ws.sent.map(raw => JSON.parse(raw) as Up)).not.toContainEqual({
            t: "ack",
            cookie: Cookie("c-test:rows-over"),
        });
        await expect(pendingMutation).resolves.toMatchObject({ code: "CDB_INVARIANT" });
    });

    test("accepts an exact 512 KiB snapshot and terminates on one serialized byte over", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: RawJson[][] = [];
        c.subscribe("queries.ts#bounded-snapshot-bytes", {}, rows => seen.push([...rows]));
        const exact = "x".repeat(512 * 1_024 - 4);
        ws.emit({ t: "snapshot", subId: SubId(1), cookie: Cookie("c-test:bytes-boundary"), rows: [exact] });
        await flush();
        expect(c.state).toBe("open");
        expect(seen.at(-1)).toEqual([exact]);

        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-test:bytes-over"),
            rows: [`${exact}x`],
        });
        await flush();
        expect(c.state).toBe("closed");
        expect(seen.at(-1)).toEqual([exact]);
    });

    test("applies patch batches atomically and terminates before a 4097th cached row", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: RawJson[][] = [];
        c.subscribe("queries.ts#bounded-patches", {}, rows => seen.push([...rows]));
        ws.emit({
            t: "poke",
            cookie: Cookie("c-test:patch-boundary"),
            patches: Array.from({ length: 4_096 }, (_, index) => ({
                op: "put" as const,
                subId: SubId(1),
                rowKey: `row-${index}`,
                row: { value: index },
            })),
        });
        await flush();
        expect(c.state).toBe("open");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toHaveLength(4_096);

        const pendingMutation = c.mutate("mutations.ts#pending-at-patch-overflow", {}).catch(error => error);
        ws.emit({
            t: "poke",
            cookie: Cookie("c-test:patch-over"),
            patches: [
                { op: "put", subId: SubId(1), rowKey: "row-0", row: { value: "must-not-apply" } },
                { op: "put", subId: SubId(1), rowKey: "row-over", row: { value: "must-not-apply" } },
            ],
        });
        await flush();
        expect(c.state).toBe("closed");
        expect(seen.at(-1)).toHaveLength(4_096);
        expect((seen.at(-1)?.[0] as { value?: unknown }).value).toBe(0);
        expect(seen.at(-1)?.some(row => (row as { __key?: string }).__key === "row-over")).toBe(false);
        await expect(pendingMutation).resolves.toMatchObject({ code: "CDB_INVARIANT" });
    });

    test("rejects a whole canonical batch of 4097 repeated same-row updates", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        const seen: RawJson[][] = [];
        c.subscribe("queries.ts#bounded-batch", {}, rows => seen.push([...rows]));
        ws.emit({
            t: "poke",
            cookie: Cookie("c-test:batch-count-over"),
            patches: Array.from({ length: 4_097 }, (_, index) => ({
                op: "put" as const,
                subId: SubId(1),
                rowKey: "same-row",
                row: { value: index },
            })),
        });
        await flush();
        expect(c.state).toBe("closed");
        expect(seen.at(-1)).toEqual([]);
    });

    test("validates oversized and malformed patches even when their subscription is unknown", async () => {
        const oversized = client();
        await flush();
        const oversizedSocket = fakeWebSocket();
        await welcome(oversizedSocket);
        oversizedSocket.emit({
            t: "poke",
            cookie: Cookie("c-test:unknown-byte-over"),
            patches: [
                {
                    op: "put",
                    subId: SubId(999),
                    rowKey: "x".repeat(512 * 1_024),
                    row: { value: true },
                },
            ],
        });
        await flush();
        expect(oversized.state).toBe("closed");

        const malformed = client();
        await flush();
        const malformedSocket = fakeWebSocket(1);
        await welcome(malformedSocket);
        malformedSocket.emit({
            t: "poke",
            cookie: Cookie("c-test:unknown-malformed"),
            patches: [{ op: "put", subId: SubId(999), rowKey: "unknown", row: "not-an-object" }],
        });
        await flush();
        expect(malformed.state).toBe("closed");
    });

    test("commits every affected subscription before notifying a throwing listener", async () => {
        const c = client();
        await flush();
        const ws = fakeWebSocket();
        await welcome(ws);
        c.subscribe("queries.ts#first-patched", {}, rows => {
            if (rows.length > 0) throw new Error("first listener failed");
        });
        const secondSeen: RawJson[][] = [];
        c.subscribe("queries.ts#second-patched", {}, rows => secondSeen.push([...rows]));

        ws.emit({
            t: "poke",
            cookie: Cookie("c-test:multi-sub"),
            patches: [
                { op: "put", subId: SubId(1), rowKey: "first", row: { value: 1 } },
                { op: "put", subId: SubId(2), rowKey: "second", row: { value: 2 } },
            ],
        });
        await flush();
        expect(c.state).toBe("closed");
        expect(secondSeen).toEqual([[{ value: 2, __key: "second" }]]);
    });

    test("a duplicate snapshot is re-acknowledged before sizing and does not regress the connection cookie", async () => {
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
        ws.emit({
            t: "snapshot",
            subId: SubId(1),
            cookie: Cookie("c-1:1"),
            rows: Array.from({ length: 4_097 }, (_, index) => ({ id: `oversized-duplicate-${index}` })),
        });
        await flush();

        expect(seen).toEqual([[{ id: "first" }]]);
        expect(
            ws.sent
                .map(raw => JSON.parse(raw) as Up)
                .filter(message => message.t === "ack" && message.cookie === Cookie("c-1:1"))
        ).toHaveLength(3);
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

    test("bounds cross-tab optimistic patch history without partial row application", async () => {
        class BoundedBroadcastChannel {
            static instance: BoundedBroadcastChannel | undefined;
            onmessage: ((event: { data: unknown }) => void) | null = null;
            closeCalls = 0;

            constructor(_name: string) {
                BoundedBroadcastChannel.instance = this;
            }

            postMessage(): void {}
            close(): void {
                this.closeCalls += 1;
            }
            emit(data: unknown): void {
                this.onmessage?.({ data });
            }
        }

        (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = BoundedBroadcastChannel;
        try {
            const c = createChardbClient({
                endpoint: "wss://example.com/ws",
                getJwt: async () => "jwt-stub",
                clientId: "c-optimistic-bound",
                logicalDb: "optimistic-bound",
            });
            await flush();
            const ws = fakeWebSocket();
            await welcome(ws);
            const seen: RawJson[][] = [];
            c.subscribe("queries.ts#bounded-optimistic", {}, rows => seen.push([...rows]));
            BoundedBroadcastChannel.instance?.emit({
                kind: "optimistic",
                patches: Array.from({ length: 4_096 }, (_, index) => ({
                    op: "put",
                    subId: 1,
                    rowKey: "same-row",
                    row: { value: index },
                })),
            });
            expect(c.state).toBe("open");
            expect(seen).toHaveLength(1);
            expect(seen.at(-1)).toEqual([{ value: 4_095, __key: "same-row" }]);

            BoundedBroadcastChannel.instance?.emit({
                kind: "optimistic",
                patches: [{ op: "put", subId: 1, rowKey: "same-row", row: { value: "must-not-apply" } }],
            });
            expect(c.state).toBe("closed");
            expect(ws.readyState).toBe(FakeWS.CLOSED);
            expect(seen.at(-1)).toEqual([{ value: 4_095, __key: "same-row" }]);
            expect(BoundedBroadcastChannel.instance?.closeCalls).toBe(1);
        } finally {
            if (realBC === undefined) Reflect.deleteProperty(globalThis, "BroadcastChannel");
            else (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = realBC;
        }
    });

    test("preflights raw cross-tab patch batches before wire decoding or subscription lookup", async () => {
        class RawBroadcastChannel {
            static instance: RawBroadcastChannel | undefined;
            onmessage: ((event: { data: unknown }) => void) | null = null;
            closeCalls = 0;

            constructor(_name: string) {
                RawBroadcastChannel.instance = this;
            }

            close(): void {
                this.closeCalls += 1;
            }
            emit(data: unknown): void {
                this.onmessage?.({ data });
            }
        }

        (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = RawBroadcastChannel;
        try {
            const c = createChardbClient({
                endpoint: "wss://example.com/ws",
                getJwt: async () => "jwt-stub",
                clientId: "c-raw-cross-tab",
                logicalDb: "raw-cross-tab",
            });
            await flush();
            const ws = fakeWebSocket();
            await welcome(ws);
            RawBroadcastChannel.instance?.emit({
                kind: "optimistic",
                patches: Array.from({ length: 4_097 }, () => ({
                    op: "put",
                    subId: 999,
                    rowKey: "same-unknown-row",
                    row: { value: true },
                })),
            });
            expect(c.state).toBe("closed");
            expect(ws.readyState).toBe(FakeWS.CLOSED);
            expect(RawBroadcastChannel.instance?.closeCalls).toBe(1);
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
