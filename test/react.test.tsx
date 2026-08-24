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
import { ChardbProvider, useChardb, useMutation, useQuery } from "../src/react/index.ts";
import type { RawJson } from "../src/wire.ts";

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

    constructor(readonly url: string) {
        ProviderWebSocket.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }

    send(_raw: string): void {}
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

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
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
        const query = Object.assign(async (_ctx: never, _args: { organizationId: string }) => [], {
            __chardbRef: { toString: () => "queries.ts#listMessages" },
        });

        function Probe() {
            useQuery(query, { organizationId: "org-1" });
            return null;
        }

        TestRenderer.act(() => {
            TestRenderer.create(React.createElement(ChardbProvider, { client }, React.createElement(Probe)));
        });
        const sub = subs[0];
        if (!sub) throw new Error("expected useQuery to create a subscription");

        TestRenderer.act(() => {
            sub.listener([{ id: "r1" }]);
        });

        expect(subs).toHaveLength(1);
        expect(sub.unsubscribed).toBe(false);
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
