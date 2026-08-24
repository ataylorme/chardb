/**
 * Lifecycle tests for `chardb/react` hooks. We render through
 * `react-test-renderer` with a stub `ChardbClient` so we can observe the
 * subscribe → patch → unsubscribe contract without booting a real
 * WebSocket. Covers what the audit flagged: hooks were entirely unverified.
 */
import { describe, expect, test } from "bun:test";
import * as React from "react";
import * as TestRenderer from "react-test-renderer";
import type { ChardbClient } from "../src/client/index.ts";
import * as ChardbReact from "../src/react/index.ts";
import { ChardbProvider, useChardb, useMutation, useQuery, useSession } from "../src/react/index.ts";
import { PROTOCOL_V, type RawJson } from "../src/wire.ts";

interface SubInstance {
    readonly ref: string;
    readonly args: RawJson;
    readonly listener: (rows: RawJson[]) => void;
    unsubscribed: boolean;
}

class ProviderWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: ProviderWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = ProviderWebSocket.OPEN;
    closeCalls = 0;
    readonly sent: string[] = [];

    constructor(readonly url: string) {
        ProviderWebSocket.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
        this.sent.push(raw);
    }
    close(): void {
        this.closeCalls += 1;
        this.readyState = ProviderWebSocket.CLOSED;
        queueMicrotask(() => this.onclose?.());
    }
}

function stubClient() {
    const subs: SubInstance[] = [];
    const mutateCalls: { ref: string; args: RawJson }[] = [];
    const lifecycle = { closeCalls: 0 };
    const client: ChardbClient = {
        subscribe<TRow>(ref: string, args: RawJson, onChange: (rows: TRow[]) => void) {
            const inst: SubInstance = {
                ref,
                args,
                listener: onChange as (rows: RawJson[]) => void,
                unsubscribed: false,
            };
            subs.push(inst);
            return {
                unsubscribe() {
                    inst.unsubscribed = true;
                },
            };
        },
        async mutate<TResult>(ref: string, args: RawJson): Promise<TResult> {
            mutateCalls.push({ ref, args });
            return { ok: true } as unknown as TResult;
        },
        close() {
            lifecycle.closeCalls += 1;
        },
        state: "open" as const,
    };
    return { client, subs, mutateCalls, lifecycle };
}

function sessionAuth(userId: string, token: string) {
    const activity = { fetchCalls: 0 };
    const snapshot = {
        data: { user: { id: userId } },
        isPending: false,
    };
    const auth: ChardbReact.AuthClientLike = {
        async $fetch<T>() {
            activity.fetchCalls += 1;
            return { data: { token } as T, error: null };
        },
        useSession: {
            get: () => snapshot,
            subscribe: () => () => {},
        },
    };
    return { auth, activity };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function nestedEmptyJson(depth: number): RawJson {
    let value: RawJson = {};
    for (let level = 1; level < depth; level++) value = { value };
    return value;
}

describe("chardb/react — hook lifecycle", () => {
    test("exports only supported hooks", () => {
        for (const name of ["ChardbProvider", "useChardb", "useQuery", "useMutation", "useSession"]) {
            expect(name in ChardbReact).toBe(true);
        }
        for (const name of ["usePresence", "useUpload", "useStream", "useVectorSearch"]) {
            expect(name in ChardbReact).toBe(false);
        }
    });

    test("ChardbProvider forwards mutationTimeoutMs to its client", () => {
        expect(() =>
            TestRenderer.create(
                React.createElement(ChardbProvider, {
                    endpoint: "wss://example.com/ws",
                    getJwt: async () => "jwt-stub",
                    mutationTimeoutMs: 0,
                })
            )
        ).toThrow("mutationTimeoutMs must be an integer between 1 and 2147483647");
    });

    test("useQuery subscribes on mount, receives patches, unsubscribes on unmount", () => {
        const { client, subs, lifecycle } = stubClient();
        const query = Object.assign(async (_ctx: never, _args: { organizationId: string }) => [{ id: "unused" }], {
            __chardbRef: { toString: () => "queries.ts#listMessages" },
        });
        const args = { organizationId: "org-1" };

        let captured: RawJson[] | undefined;
        function Probe() {
            const r = useQuery(query, args);
            captured = r.data as RawJson[] | undefined;
            return null;
        }

        let tree!: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            tree = TestRenderer.create(React.createElement(ChardbProvider, { client }, React.createElement(Probe)));
        });

        expect(subs.length).toBe(1);
        const sub = subs[0];
        if (!sub) throw new Error("expected useQuery to create a subscription");
        expect(sub.ref).toBe("queries.ts#listMessages");
        expect(sub.args).toEqual(args);
        expect(captured).toBeUndefined();

        TestRenderer.act(() => {
            sub.listener([{ id: "r1" }]);
        });
        expect(captured).toEqual([{ id: "r1" }]);

        expect(sub.unsubscribed).toBe(false);
        TestRenderer.act(() => {
            tree.unmount();
        });
        expect(sub.unsubscribed).toBe(true);
        expect(lifecycle.closeCalls).toBe(0);
    });

    test("replacing borrowed clients unsubscribes local queries without closing either client", () => {
        const first = stubClient();
        const second = stubClient();
        const query = Object.assign(async (_ctx: never, _args: Record<string, never>) => [], {
            __chardbRef: { toString: () => "queries.ts#replacement" },
        });

        function Probe() {
            useQuery(query, {});
            return null;
        }

        let tree!: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            tree = TestRenderer.create(
                React.createElement(ChardbProvider, { client: first.client }, React.createElement(Probe))
            );
        });
        expect(first.subs).toHaveLength(1);

        TestRenderer.act(() => {
            tree.update(React.createElement(ChardbProvider, { client: second.client }, React.createElement(Probe)));
        });
        expect(first.subs[0]?.unsubscribed).toBe(true);
        expect(first.lifecycle.closeCalls).toBe(0);
        expect(second.subs).toHaveLength(1);
        expect(second.subs[0]?.unsubscribed).toBe(false);

        TestRenderer.act(() => tree.unmount());
        expect(second.subs[0]?.unsubscribed).toBe(true);
        expect(first.lifecycle.closeCalls).toBe(0);
        expect(second.lifecycle.closeCalls).toBe(0);
    });

    test("closes each provider-created client exactly once across replacement and unmount", async () => {
        const realWebSocket = globalThis.WebSocket;
        ProviderWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = ProviderWebSocket;
        let tree: TestRenderer.ReactTestRenderer | undefined;
        try {
            await TestRenderer.act(async () => {
                tree = TestRenderer.create(
                    React.createElement(ChardbProvider, {
                        endpoint: "wss://example.com/first",
                        getJwt: async () => "jwt-stub",
                        clientId: "provider-owned",
                        crossTab: false,
                    })
                );
                await flushMicrotasks();
            });
            expect(ProviderWebSocket.instances).toHaveLength(1);
            const first = ProviderWebSocket.instances[0];
            if (!first) throw new Error("expected the first provider-owned socket");

            await TestRenderer.act(async () => {
                tree?.update(
                    React.createElement(ChardbProvider, {
                        endpoint: "wss://example.com/second",
                        getJwt: async () => "jwt-stub",
                        clientId: "provider-owned",
                        crossTab: false,
                    })
                );
                await flushMicrotasks();
            });
            expect(ProviderWebSocket.instances).toHaveLength(2);
            const second = ProviderWebSocket.instances[1];
            if (!second) throw new Error("expected the replacement provider-owned socket");
            expect(first.closeCalls).toBe(1);
            expect(second.closeCalls).toBe(0);

            TestRenderer.act(() => tree?.unmount());
            await flushMicrotasks();
            expect(first.closeCalls).toBe(1);
            expect(second.closeCalls).toBe(1);
        } finally {
            tree?.unmount();
            (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
        }
    });

    test("an auth-only update preserves an owned client when getJwt is explicit", async () => {
        const realWebSocket = globalThis.WebSocket;
        ProviderWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = ProviderWebSocket;
        const firstAuth = sessionAuth("user-a", "unused-a");
        const secondAuth = sessionAuth("user-b", "unused-b");
        const query = Object.assign(async (_ctx: never, _args: Record<string, never>) => [], {
            __chardbRef: { toString: () => "queries.ts#auth-context" },
        });
        let getJwtCalls = 0;
        const getJwt = async () => {
            getJwtCalls += 1;
            return "explicit-jwt";
        };
        let capturedClient: ChardbClient | undefined;
        let capturedUserId: string | null | undefined;
        let tree: TestRenderer.ReactTestRenderer | undefined;
        let mutationOutcome:
            | Promise<{ readonly ok: true; readonly value: RawJson } | { readonly ok: false }>
            | undefined;

        function Probe() {
            capturedClient = useChardb();
            capturedUserId = useSession().userId;
            useQuery(query, {});
            return null;
        }

        const render = (auth: ChardbReact.AuthClientLike) =>
            React.createElement(
                ChardbProvider,
                {
                    endpoint: "wss://example.com/auth-context",
                    getJwt,
                    auth,
                    clientId: "provider-auth-context",
                    crossTab: false,
                },
                React.createElement(Probe)
            );

        try {
            await TestRenderer.act(async () => {
                tree = TestRenderer.create(render(firstAuth.auth));
                await flushMicrotasks();
            });
            const originalClient = capturedClient;
            if (!originalClient) throw new Error("expected the provider-owned client");
            const socket = ProviderWebSocket.instances[0];
            if (!socket) throw new Error("expected the provider-owned socket");
            let mutationSettled = false;
            mutationOutcome = originalClient.mutate("mutations.ts#auth-context", {}).then(
                value => {
                    mutationSettled = true;
                    return { ok: true as const, value };
                },
                () => {
                    mutationSettled = true;
                    return { ok: false as const };
                }
            );

            await TestRenderer.act(async () => {
                tree?.update(render(secondAuth.auth));
                await flushMicrotasks();
            });
            expect(capturedClient).toBe(originalClient);
            expect(capturedUserId).toBe("user-b");
            expect(getJwtCalls).toBe(1);
            expect(firstAuth.activity.fetchCalls).toBe(0);
            expect(secondAuth.activity.fetchCalls).toBe(0);
            expect(ProviderWebSocket.instances).toHaveLength(1);
            expect(socket.closeCalls).toBe(0);
            expect(mutationSettled).toBe(false);

            socket.onmessage?.({
                data: JSON.stringify({
                    t: "welcome",
                    protocolV: PROTOCOL_V,
                    baseCookie: "c-auth-context:1",
                    region: "test",
                }),
            });
            const sent = socket.sent.map(raw => JSON.parse(raw) as { readonly t: string; readonly mutId?: string });
            expect(sent.map(message => message.t)).toEqual(["hello", "sub", "mut"]);
            expect(sent.filter(message => message.t === "sub")).toHaveLength(1);
            const mutation = sent.find(message => message.t === "mut");
            if (!mutation?.mutId) throw new Error("expected a queued mutation");
            socket.onmessage?.({
                data: JSON.stringify({
                    t: "poke",
                    cookie: "c-auth-context:2",
                    patches: [],
                    mutResults: [
                        {
                            mutId: mutation.mutId,
                            ok: true,
                            result: { saved: true },
                            cookie: "c-auth-context:2",
                        },
                    ],
                }),
            });
            await expect(mutationOutcome).resolves.toEqual({ ok: true, value: { saved: true } });

            TestRenderer.act(() => tree?.unmount());
            await flushMicrotasks();
            expect(socket.closeCalls).toBe(1);
        } finally {
            tree?.unmount();
            await mutationOutcome?.catch(() => {});
            capturedClient?.close();
            (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
        }
    });

    test("an auth-derived JWT update replaces and closes the owned client once", async () => {
        const realWebSocket = globalThis.WebSocket;
        ProviderWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = ProviderWebSocket;
        const firstAuth = sessionAuth("user-a", "jwt-a");
        const secondAuth = sessionAuth("user-b", "jwt-b");
        let capturedClient: ChardbClient | undefined;
        let tree: TestRenderer.ReactTestRenderer | undefined;

        function CaptureClient() {
            capturedClient = useChardb();
            return null;
        }

        const render = (auth: ChardbReact.AuthClientLike) =>
            React.createElement(
                ChardbProvider,
                {
                    endpoint: "wss://example.com/auth-derived",
                    auth,
                    clientId: "provider-auth-derived",
                    crossTab: false,
                },
                React.createElement(CaptureClient)
            );

        try {
            await TestRenderer.act(async () => {
                tree = TestRenderer.create(render(firstAuth.auth));
                await flushMicrotasks();
            });
            const originalClient = capturedClient;
            if (!originalClient) throw new Error("expected the first provider-owned client");
            const firstSocket = ProviderWebSocket.instances[0];
            if (!firstSocket) throw new Error("expected the first provider-owned socket");

            await TestRenderer.act(async () => {
                tree?.update(render(secondAuth.auth));
                await flushMicrotasks();
            });
            expect(capturedClient).not.toBe(originalClient);
            expect(firstAuth.activity.fetchCalls).toBe(1);
            expect(secondAuth.activity.fetchCalls).toBe(1);
            expect(ProviderWebSocket.instances).toHaveLength(2);
            const secondSocket = ProviderWebSocket.instances[1];
            if (!secondSocket) throw new Error("expected the replacement provider-owned socket");
            expect(firstSocket.closeCalls).toBe(1);
            expect(secondSocket.closeCalls).toBe(0);

            TestRenderer.act(() => tree?.unmount());
            await flushMicrotasks();
            expect(firstSocket.closeCalls).toBe(1);
            expect(secondSocket.closeCalls).toBe(1);
        } finally {
            tree?.unmount();
            capturedClient?.close();
            (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
        }
    });

    test("does not start a provider client for a render that never commits", async () => {
        class DormantBroadcastChannel {
            static constructions = 0;
            onmessage: ((event: { data: unknown }) => void) | null = null;

            constructor(_name: string) {
                DormantBroadcastChannel.constructions += 1;
            }

            close(): void {}
        }

        const realWebSocket = globalThis.WebSocket;
        const realBroadcastChannel = globalThis.BroadcastChannel;
        ProviderWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = ProviderWebSocket;
        (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = DormantBroadcastChannel;
        let getJwtCalls = 0;
        function AbortRender(): React.ReactElement {
            throw new Error("abort render");
        }

        try {
            expect(() =>
                TestRenderer.create(
                    React.createElement(
                        ChardbProvider,
                        {
                            endpoint: "wss://example.com/aborted",
                            getJwt: async () => {
                                getJwtCalls += 1;
                                return "jwt-stub";
                            },
                            clientId: "provider-aborted",
                            logicalDb: "provider-aborted",
                        },
                        React.createElement(AbortRender)
                    )
                )
            ).toThrow("abort render");
            await flushMicrotasks();
            expect(getJwtCalls).toBe(0);
            expect(ProviderWebSocket.instances).toHaveLength(0);
            expect(DormantBroadcastChannel.constructions).toBe(0);
        } finally {
            (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
            (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = realBroadcastChannel;
        }
    });

    test("keeps the committed owned client alive through StrictMode rehearsal and closes it on unmount", async () => {
        const realWebSocket = globalThis.WebSocket;
        ProviderWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = ProviderWebSocket;
        let getJwtCalls = 0;
        let tree: TestRenderer.ReactTestRenderer | undefined;
        try {
            await TestRenderer.act(async () => {
                tree = TestRenderer.create(
                    React.createElement(
                        React.StrictMode,
                        null,
                        React.createElement(ChardbProvider, {
                            endpoint: "wss://example.com/strict",
                            getJwt: async () => {
                                getJwtCalls += 1;
                                return "jwt-stub";
                            },
                            clientId: "provider-strict",
                            crossTab: false,
                        })
                    )
                );
                await flushMicrotasks();
            });
            expect(getJwtCalls).toBe(1);
            expect(ProviderWebSocket.instances).toHaveLength(1);
            const socket = ProviderWebSocket.instances[0];
            if (!socket) throw new Error("expected the StrictMode provider socket");
            expect(socket.closeCalls).toBe(0);

            TestRenderer.act(() => tree?.unmount());
            await flushMicrotasks();
            expect(socket.closeCalls).toBe(1);
        } finally {
            tree?.unmount();
            (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
        }
    });

    test("hands an owned client to the caller without closing the same object", async () => {
        const realWebSocket = globalThis.WebSocket;
        ProviderWebSocket.instances.length = 0;
        (globalThis as { WebSocket: unknown }).WebSocket = ProviderWebSocket;
        const getJwt = async () => "jwt-stub";
        let captured: ChardbClient | undefined;
        let tree: TestRenderer.ReactTestRenderer | undefined;
        function CaptureClient() {
            captured = useChardb();
            return null;
        }

        try {
            await TestRenderer.act(async () => {
                tree = TestRenderer.create(
                    React.createElement(
                        ChardbProvider,
                        {
                            endpoint: "wss://example.com/handoff",
                            getJwt,
                            clientId: "provider-handoff",
                            crossTab: false,
                        },
                        React.createElement(CaptureClient)
                    )
                );
                await flushMicrotasks();
            });
            const ownedClient = captured;
            if (!ownedClient) throw new Error("expected the provider-owned client");
            const socket = ProviderWebSocket.instances[0];
            if (!socket) throw new Error("expected the provider-owned socket");

            await TestRenderer.act(async () => {
                tree?.update(
                    React.createElement(ChardbProvider, { client: ownedClient }, React.createElement(CaptureClient))
                );
                await flushMicrotasks();
            });
            expect(captured).toBe(ownedClient);
            expect(socket.closeCalls).toBe(0);

            TestRenderer.act(() => tree?.unmount());
            await flushMicrotasks();
            expect(socket.closeCalls).toBe(0);

            ownedClient.close();
            expect(socket.closeCalls).toBe(1);
        } finally {
            tree?.unmount();
            captured?.close();
            (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
        }
    });

    test("returns pending immediately and ignores old listeners when query identity changes", () => {
        const first = stubClient();
        const second = stubClient();
        type Query = ((ctx: never, args: { organizationId: string }) => Promise<never[]>) & {
            readonly __chardbRef: { toString(): string };
        };
        const firstQuery: Query = Object.assign(async (_ctx: never, _args: { organizationId: string }) => [], {
            __chardbRef: { toString: () => "queries.ts#first" },
        });
        const secondQuery: Query = Object.assign(async (_ctx: never, _args: { organizationId: string }) => [], {
            __chardbRef: { toString: () => "queries.ts#second" },
        });
        let captured: { readonly data: RawJson[] | undefined; readonly state: string } | undefined;
        function Probe(props: { readonly query: Query; readonly organizationId: string }) {
            captured = useQuery(props.query, { organizationId: props.organizationId }) as {
                readonly data: RawJson[] | undefined;
                readonly state: string;
            };
            return null;
        }
        const render = (client: ChardbClient, query: Query, organizationId: string) =>
            React.createElement(ChardbProvider, { client }, React.createElement(Probe, { query, organizationId }));

        let tree!: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            tree = TestRenderer.create(render(first.client, firstQuery, "org-1"));
        });
        const original = first.subs[0];
        if (!original) throw new Error("expected the original query subscription");
        TestRenderer.act(() => original.listener([{ id: "old-args" }]));
        expect(captured).toMatchObject({ data: [{ id: "old-args" }], state: "live" });

        TestRenderer.act(() => tree.update(render(first.client, firstQuery, "org-2")));
        const newArgs = first.subs[1];
        if (!newArgs) throw new Error("expected the replacement-arguments subscription");
        expect(original.unsubscribed).toBe(true);
        expect(captured).toMatchObject({ data: undefined, state: "pending" });
        TestRenderer.act(() => original.listener([{ id: "late-old-args" }]));
        expect(captured).toMatchObject({ data: undefined, state: "pending" });
        TestRenderer.act(() => newArgs.listener([{ id: "new-args" }]));
        expect(captured).toMatchObject({ data: [{ id: "new-args" }], state: "live" });

        TestRenderer.act(() => tree.update(render(first.client, secondQuery, "org-2")));
        const newRef = first.subs[2];
        if (!newRef) throw new Error("expected the replacement-reference subscription");
        expect(newArgs.unsubscribed).toBe(true);
        expect(newRef.ref).toBe("queries.ts#second");
        expect(captured).toMatchObject({ data: undefined, state: "pending" });
        TestRenderer.act(() => newArgs.listener([{ id: "late-old-ref" }]));
        expect(captured).toMatchObject({ data: undefined, state: "pending" });
        TestRenderer.act(() => newRef.listener([{ id: "new-ref" }]));

        TestRenderer.act(() => tree.update(render(second.client, secondQuery, "org-2")));
        const newClient = second.subs[0];
        if (!newClient) throw new Error("expected the replacement-client subscription");
        expect(newRef.unsubscribed).toBe(true);
        expect(captured).toMatchObject({ data: undefined, state: "pending" });
        TestRenderer.act(() => newRef.listener([{ id: "late-old-client" }]));
        expect(captured).toMatchObject({ data: undefined, state: "pending" });
        TestRenderer.act(() => newClient.listener([{ id: "new-client" }]));
        expect(captured).toMatchObject({ data: [{ id: "new-client" }], state: "live" });

        TestRenderer.act(() => tree.unmount());
    });

    test("useQuery keeps one subscription when inline args are recreated by a result render", () => {
        const { client, subs } = stubClient();
        const query = Object.assign(async (_ctx: never, _args: { a: number; b: number }) => [], {
            __chardbRef: { toString: () => "queries.ts#listMessages" },
        });

        function Probe(props: { readonly reverse: boolean }) {
            useQuery(query, props.reverse ? { b: 2, a: 1 } : { a: 1, b: 2 });
            return null;
        }

        let tree!: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            tree = TestRenderer.create(
                React.createElement(ChardbProvider, { client }, React.createElement(Probe, { reverse: false }))
            );
        });
        const sub = subs[0];
        if (!sub) throw new Error("expected useQuery to create a subscription");

        TestRenderer.act(() => {
            sub.listener([{ id: "r1" }]);
            tree.update(React.createElement(ChardbProvider, { client }, React.createElement(Probe, { reverse: true })));
        });

        expect(subs).toHaveLength(1);
        expect(sub.unsubscribed).toBe(false);
    });

    test("useQuery rejects non-JSON argument shapes without invoking getters", () => {
        const query = Object.assign(async (_ctx: never, _args: RawJson) => [], {
            __chardbRef: { toString: () => "queries.ts#strictArguments" },
        });
        let getterRuns = 0;
        const accessor: Record<string, unknown> = {};
        Object.defineProperty(accessor, "value", {
            enumerable: true,
            get() {
                getterRuns++;
                return "unsafe";
            },
        });
        const nonEnumerable = { visible: true };
        Object.defineProperty(nonEnumerable, "hidden", { value: true });
        const objectSymbol = { visible: true };
        Object.defineProperty(objectSymbol, Symbol("hidden"), { value: true, enumerable: true });
        const sparse = Array(1);
        const extraArray: unknown[] = [];
        Object.defineProperty(extraArray, "extra", { value: true, enumerable: true });
        const symbolArray: unknown[] = [];
        Object.defineProperty(symbolArray, Symbol("extra"), { value: true, enumerable: true });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        for (const args of [
            { value: -0 },
            { value: Number.NaN },
            sparse,
            extraArray,
            symbolArray,
            objectSymbol,
            nonEnumerable,
            accessor,
            new Date(0),
            cyclic,
        ]) {
            const { client, subs } = stubClient();
            let thrown: unknown;
            try {
                TestRenderer.create(
                    React.createElement(
                        ChardbProvider,
                        { client },
                        React.createElement(() => {
                            useQuery(query, args as RawJson);
                            return null;
                        })
                    )
                );
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toMatchObject({ code: "CDB_INVALID_ARGS", retryable: false });
            expect(subs).toHaveLength(0);
        }
        expect(getterRuns).toBe(0);
    });

    test("useQuery rejects a live argument change from zero to negative zero", () => {
        const { client, subs } = stubClient();
        const query = Object.assign(async (_ctx: never, _args: { value: number }) => [], {
            __chardbRef: { toString: () => "queries.ts#signedZero" },
        });
        let captured: RawJson[] | undefined;
        function Probe(props: { readonly value: number }) {
            captured = useQuery(query, { value: props.value }).data as RawJson[] | undefined;
            return null;
        }
        const render = (value: number) =>
            React.createElement(ChardbProvider, { client }, React.createElement(Probe, { value }));

        let tree!: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            tree = TestRenderer.create(render(0));
        });
        const sub = subs[0];
        if (!sub) throw new Error("expected the initial query subscription");
        TestRenderer.act(() => sub.listener([{ id: "zero" }]));
        expect(captured).toEqual([{ id: "zero" }]);

        let thrown: unknown;
        try {
            TestRenderer.act(() => tree.update(render(-0)));
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toMatchObject({ code: "CDB_INVALID_ARGS", retryable: false });
        expect(subs).toHaveLength(1);
    });

    test("useQuery accepts the exact argument byte limit and rejects one value over it", () => {
        const query = Object.assign(async (_ctx: never, _args: { value: string }) => [], {
            __chardbRef: { toString: () => "queries.ts#argumentBytes" },
        });
        const exact = stubClient();
        TestRenderer.act(() => {
            TestRenderer.create(
                React.createElement(
                    ChardbProvider,
                    { client: exact.client },
                    React.createElement(() => {
                        useQuery(query, { value: "é".repeat(262_138) });
                        return null;
                    })
                )
            );
        });
        expect(exact.subs).toHaveLength(1);

        const over = stubClient();
        let thrown: unknown;
        try {
            TestRenderer.create(
                React.createElement(
                    ChardbProvider,
                    { client: over.client },
                    React.createElement(() => {
                        useQuery(query, { value: "é".repeat(262_139) });
                        return null;
                    })
                )
            );
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toMatchObject({ code: "CDB_INVALID_ARGS", retryable: false });
        expect(over.subs).toHaveLength(0);
    });

    test("useQuery accepts 99 empty container levels and rejects the 100th before subscribing", () => {
        const query = Object.assign(async (_ctx: never, _args: RawJson) => [], {
            __chardbRef: { toString: () => "queries.ts#argumentDepth" },
        });
        const exact = stubClient();
        TestRenderer.act(() => {
            TestRenderer.create(
                React.createElement(
                    ChardbProvider,
                    { client: exact.client },
                    React.createElement(() => {
                        useQuery(query, nestedEmptyJson(99));
                        return null;
                    })
                )
            );
        });
        expect(exact.subs).toHaveLength(1);

        const over = stubClient();
        let thrown: unknown;
        try {
            TestRenderer.create(
                React.createElement(
                    ChardbProvider,
                    { client: over.client },
                    React.createElement(() => {
                        useQuery(query, nestedEmptyJson(100));
                        return null;
                    })
                )
            );
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toMatchObject({ code: "CDB_INVALID_ARGS", retryable: false });
        expect(over.subs).toHaveLength(0);
    });

    test("useMutation invokes client.mutate with the function's __chardbRef", async () => {
        const { client, mutateCalls } = stubClient();
        const fn = { __chardbRef: { toString: () => "mutation#postMessage" } };

        let invoke: ((args: RawJson) => Promise<RawJson>) | undefined;
        function Probe() {
            const m = useMutation(fn);
            invoke = m as (args: RawJson) => Promise<RawJson>;
            return null;
        }

        TestRenderer.create(React.createElement(ChardbProvider, { client }, React.createElement(Probe)));

        expect(typeof invoke).toBe("function");
        if (!invoke) throw new Error("expected useMutation to expose an invoke function");
        await invoke({ body: "hi" });
        expect(mutateCalls).toEqual([{ ref: "mutation#postMessage", args: { body: "hi" } }]);
    });

    test("useQuery without a Provider throws a clear error", () => {
        const query = Object.assign(async (_ctx: never, _args: Record<string, never>) => [], {
            __chardbRef: { toString: () => "queries.ts#list" },
        });
        function Bad() {
            useQuery(query, {});
            return null;
        }
        expect(() => TestRenderer.create(React.createElement(Bad))).toThrow(
            /useChardb must be used inside <ChardbProvider>/
        );
    });
});
