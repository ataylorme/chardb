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
import { ChardbProvider, useMutation, useQuery } from "../src/react/index.ts";
import type { CdbIntent, RawJson } from "../src/wire.ts";

interface SubInstance {
    readonly intent: CdbIntent;
    readonly listener: (rows: RawJson[]) => void;
    unsubscribed: boolean;
}

function stubClient() {
    const subs: SubInstance[] = [];
    const mutateCalls: { ref: string; args: RawJson }[] = [];
    const client: ChardbClient = {
        subscribe<TRow>(intent: CdbIntent, onChange: (rows: TRow[]) => void) {
            const inst: SubInstance = {
                intent,
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
            /* noop for stub */
        },
        state: "open" as const,
    };
    return { client, subs, mutateCalls };
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

    test("useQuery subscribes on mount, receives patches, unsubscribes on unmount", () => {
        const { client, subs } = stubClient();
        const intent: CdbIntent = { kind: "select", tables: ["t"] };

        let captured: RawJson[] | undefined;
        function Probe() {
            const r = useQuery<{ id: string }>(intent);
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
        expect(sub.intent).toBe(intent);
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
        function Bad() {
            useQuery({ kind: "select", tables: ["t"] });
            return null;
        }
        expect(() => TestRenderer.create(React.createElement(Bad))).toThrow(
            /useChardb must be used inside <ChardbProvider>/
        );
    });
});
