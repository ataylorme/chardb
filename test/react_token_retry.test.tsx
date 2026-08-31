import { describe, expect, test } from "bun:test";
import * as React from "react";
import * as TestRenderer from "react-test-renderer";
import type { ChardbClient } from "../src/client/index.ts";
import { type AuthClientLike, type AuthSessionAtom, ChardbProvider, useChardb } from "../src/react/index.ts";

type TokenResponse = Awaited<ReturnType<AuthClientLike["$fetch"]>>;

class TokenRetryWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: TokenRetryWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = TokenRetryWebSocket.OPEN;
    readonly sent: string[] = [];

    constructor(readonly url: string) {
        TokenRetryWebSocket.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
        this.sent.push(raw);
    }

    close(): void {
        this.readyState = TokenRetryWebSocket.CLOSED;
        queueMicrotask(() => this.onclose?.());
    }
}

function authHarness(response: (call: number) => TokenResponse | Promise<TokenResponse>) {
    const listeners = new Set<() => void>();
    let signedIn = true;
    let fetchCalls = 0;
    const session: AuthSessionAtom = {
        get: () => ({
            data: signedIn ? { user: { id: "user-retry" }, session: { id: "session-retry" } } : null,
            isPending: false,
        }),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const auth: AuthClientLike = {
        async $fetch<T>() {
            fetchCalls += 1;
            return (await response(fetchCalls)) as { data: T | null; error: TokenResponse["error"] };
        },
        $store: { atoms: { session } },
    };
    return {
        auth,
        fetchCalls: () => fetchCalls,
        signOut() {
            signedIn = false;
            for (const listener of listeners) listener();
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
        scheduledDelays: () => [...scheduled.values()].map(timer => timer.delayMs),
        restore() {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        },
    };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function CaptureClient({ onClient }: { readonly onClient: (client: ChardbClient) => void }) {
    onClient(useChardb());
    return null;
}

describe("@chardb/react — initial Better Auth token recovery", () => {
    test("recovers a transient token failure on the connection backoff", async () => {
        const originalWebSocket = globalThis.WebSocket;
        const timers = installManualTimers();
        TokenRetryWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = TokenRetryWebSocket;
        const session = authHarness(call =>
            call === 1
                ? { data: null, error: { message: "temporarily unavailable", status: 503 } }
                : { data: { token: "jwt-recovered" }, error: null }
        );
        let client: ChardbClient | undefined;
        let tree: TestRenderer.ReactTestRenderer | undefined;
        try {
            await TestRenderer.act(async () => {
                tree = TestRenderer.create(
                    React.createElement(
                        ChardbProvider,
                        { ownership: "user", endpoint: "wss://example.com/retry", auth: session.auth },
                        React.createElement(CaptureClient, {
                            onClient: value => {
                                client = value;
                            },
                        })
                    )
                );
                await flush();
            });
            expect(session.fetchCalls()).toBe(1);
            expect(client?.state).toBe("reconnecting");
            expect(TokenRetryWebSocket.instances).toHaveLength(0);
            expect(timers.scheduledDelays()).toEqual([250]);

            await TestRenderer.act(async () => {
                timers.runDelay(250);
                await flush();
            });
            expect(session.fetchCalls()).toBe(2);
            expect(TokenRetryWebSocket.instances).toHaveLength(1);
            expect(timers.scheduledDelays()).toEqual([]);
        } finally {
            TestRenderer.act(() => tree?.unmount());
            await flush();
            timers.restore();
            (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
        }
    });

    test("bounds persistent transient failures and rejects permanent auth failures without retrying", async () => {
        const originalWebSocket = globalThis.WebSocket;
        TokenRetryWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = TokenRetryWebSocket;

        async function mount(status: number) {
            const timers = installManualTimers();
            const session = authHarness(() => ({ data: null, error: { message: `token ${status}`, status } }));
            const diagnostics: unknown[] = [];
            let client: ChardbClient | undefined;
            let tree: TestRenderer.ReactTestRenderer | undefined;
            await TestRenderer.act(async () => {
                tree = TestRenderer.create(
                    React.createElement(
                        ChardbProvider,
                        {
                            ownership: "user",
                            endpoint: "wss://example.com/bounded",
                            auth: session.auth,
                            onSessionError: diagnostic => diagnostics.push(diagnostic),
                        },
                        React.createElement(CaptureClient, {
                            onClient: value => {
                                client = value;
                            },
                        })
                    )
                );
                await flush();
            });
            return { timers, session, diagnostics, client: () => client, unmount: () => tree?.unmount() };
        }

        try {
            const transient = await mount(503);
            for (const delay of [250, 500, 1_000]) {
                await TestRenderer.act(async () => {
                    transient.timers.runDelay(delay);
                    await flush();
                });
            }
            expect(transient.session.fetchCalls()).toBe(4);
            expect(transient.client()?.state).toBe("closed");
            expect(transient.timers.scheduledDelays()).toEqual([]);
            expect(transient.diagnostics).toEqual([{ code: "CDB_STREAM_ABORTED", reason: "connect" }]);
            TestRenderer.act(transient.unmount);
            transient.timers.restore();

            const permanent = await mount(401);
            expect(permanent.session.fetchCalls()).toBe(1);
            expect(permanent.client()?.state).toBe("closed");
            expect(permanent.timers.scheduledDelays()).toEqual([]);
            expect(permanent.diagnostics).toEqual([{ code: "CDB_FORBIDDEN", reason: "connect" }]);
            TestRenderer.act(permanent.unmount);
            permanent.timers.restore();
        } finally {
            (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
        }
    });

    test("sign-out and unmount cancel a pending token retry", async () => {
        const originalWebSocket = globalThis.WebSocket;
        TokenRetryWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = TokenRetryWebSocket;

        async function verify(cancel: "sign-out" | "unmount") {
            const timers = installManualTimers();
            const session = authHarness(() => ({
                data: null,
                error: { message: "temporarily unavailable", status: 503 },
            }));
            let tree: TestRenderer.ReactTestRenderer | undefined;
            try {
                await TestRenderer.act(async () => {
                    tree = TestRenderer.create(
                        React.createElement(ChardbProvider, {
                            ownership: "user",
                            endpoint: "wss://example.com/cancel",
                            auth: session.auth,
                        })
                    );
                    await flush();
                });
                expect(timers.scheduledDelays()).toEqual([250]);
                await TestRenderer.act(async () => {
                    if (cancel === "sign-out") session.signOut();
                    else tree?.unmount();
                    await flush();
                });
                expect(timers.scheduledDelays()).toEqual([]);
                expect(session.fetchCalls()).toBe(1);
            } finally {
                TestRenderer.act(() => tree?.unmount());
                await flush();
                timers.restore();
            }
        }

        try {
            await verify("sign-out");
            await verify("unmount");
            expect(TokenRetryWebSocket.instances).toHaveLength(0);
        } finally {
            (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
        }
    });
});
