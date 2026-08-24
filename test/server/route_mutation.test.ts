import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { defineMutation } from "../../src/server/define.ts";
import { manifestFromExports, routeMutation } from "../../src/server/manifest.ts";
import {
    CDB_JSON_MAX_AGGREGATE_MEMBERS,
    CDB_MUTATION_ARGS_MAX_BYTES,
    CDB_MUTATION_ARGS_MAX_DEPTH,
} from "../../src/server/result_limits.ts";
import type { RawJson } from "../../src/types.ts";
import { stableJson } from "../../src/util/canonical.ts";
import { vshardOf } from "../../src/vshard.ts";

type PostArgs = { readonly orgId: string; readonly body: string } & {
    readonly [k: string]: RawJson;
};
type BroadcastArgs = { readonly msg: string } & { readonly [k: string]: RawJson };

const postMessage = defineMutation<unknown, PostArgs, { id: string }>(
    function postMessage(_ctx, _args) {
        return { id: "x" };
    },
    { ref: "api/messages#post", authority: "organization", singlePartition: true, partitionKey: a => a.orgId }
);

const broadcast = defineMutation<unknown, BroadcastArgs, void>(function broadcast() {
    return undefined;
}, {});

const singlePartitionWithoutKey = defineMutation<unknown, BroadcastArgs, void>(
    function singlePartitionWithoutKey() {
        return undefined;
    },
    { singlePartition: true }
);

const manifest = manifestFromExports({ postMessage, broadcast, singlePartitionWithoutKey });

function nestedArray(depth: number): RawJson {
    let value: RawJson = null;
    for (let level = 0; level < depth; level++) value = [value];
    return value;
}

describe("routeMutation — pure routing decision", () => {
    test("singlePartition + partitionKey → vshard equals vshardOf([key])", () => {
        const r = routeMutation(
            manifest,
            { ref: postMessage.__chardbRef, args: { orgId: "org-42", body: "hi" } },
            vshardOf
        );
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error("unreachable");
        expect(r.vshard).toBe(Number(vshardOf(["org-42"])));
        expect(r.authority).toBe("organization");
        expect(r.partitionKey).toBe("org-42");
    });

    test("same orgId across calls routes to a single vshard (idempotent partitioning)", () => {
        const a = routeMutation(
            manifest,
            { ref: postMessage.__chardbRef, args: { orgId: "tenant-7", body: "1" } },
            vshardOf
        );
        const b = routeMutation(
            manifest,
            { ref: postMessage.__chardbRef, args: { orgId: "tenant-7", body: "2" } },
            vshardOf
        );
        expect(a).toMatchObject({
            ok: true,
            vshard: Number(vshardOf(["tenant-7"])),
            authority: "organization",
            partitionKey: "tenant-7",
        });
        expect(b).toMatchObject({
            ok: true,
            vshard: Number(vshardOf(["tenant-7"])),
            authority: "organization",
            partitionKey: "tenant-7",
        });
    });

    test("singlePartition without resolvable partitionKey → CDB_CROSS_PARTITION", () => {
        const r = routeMutation(manifest, { ref: singlePartitionWithoutKey.__chardbRef, args: { msg: "x" } }, vshardOf);
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error("unreachable");
        expect(r.error.code).toBe("CDB_CROSS_PARTITION");
        expect(r.error.docs).toBe("https://chardb.dev/errors/cdb_cross_partition");
    });

    test("unknown ref → CDB_REF_NOT_FOUND envelope, not a thrown exception", () => {
        const r = routeMutation(manifest, { ref: "nope", args: {} }, vshardOf);
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error("unreachable");
        expect(r.error.code).toBe("CDB_REF_NOT_FOUND");
    });

    test("non-singlePartition mutation without key falls back to canonical-args vshard", () => {
        const r = routeMutation(manifest, { ref: broadcast.__chardbRef, args: { msg: "ping" } }, vshardOf);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error("unreachable");
        expect(r).toMatchObject({ authority: null, partitionKey: null });
    });

    test("keyless routing is stable across nested object key order", () => {
        const first = routeMutation(
            manifest,
            { ref: broadcast.__chardbRef, args: { msg: "ping", nested: { a: 1, b: 2 } } as never },
            vshardOf
        );
        const second = routeMutation(
            manifest,
            { ref: broadcast.__chardbRef, args: { nested: { b: 2, a: 1 }, msg: "ping" } as never },
            vshardOf
        );
        expect(first).toMatchObject({ ok: true });
        expect(second).toMatchObject({ ok: true });
        if (!first.ok || !second.ok) throw new Error("unreachable");
        expect(second.vshard).toBe(first.vshard);
    });

    test("stableJson preserves an own __proto__ data property", () => {
        const value = { stable: true } as Record<string, RawJson>;
        Object.defineProperty(value, "__proto__", {
            value: { source: "owned" },
            enumerable: true,
            writable: true,
            configurable: true,
        });
        expect(stableJson(value)).toBe('{"__proto__":{"source":"owned"},"stable":true}');
    });

    test("organization authority rejects missing and non-string partition keys as invalid args", () => {
        for (const args of [{ body: "missing" }, { orgId: 42, body: "numeric" }]) {
            const result = routeMutation(manifest, { ref: postMessage.__chardbRef, args: args as never }, vshardOf);
            expect(result).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS" } });
        }
    });

    test("validates transforms, defaults, and refinements before extracting organization authority", () => {
        const normalized = defineMutation({
            ref: "api/normalized#post",
            args: z.object({
                orgId: z
                    .string()
                    .trim()
                    .transform(value => `org:${value}`),
                body: z.string().min(1).default("default body"),
            }),
            authority: "organization",
            partitionKey: "orgId",
            handler: () => null,
        });
        const normalizedManifest = manifestFromExports({ normalized });
        const routed = routeMutation(
            normalizedManifest,
            { ref: normalized.__chardbRef, args: { orgId: " 7 " } },
            vshardOf
        );
        expect(routed).toEqual({
            ok: true,
            vshard: Number(vshardOf(["org:7"])),
            authority: "organization",
            partitionKey: "org:7",
            args: { orgId: "org:7", body: "default body" },
        });

        const rejected = routeMutation(
            normalizedManifest,
            { ref: normalized.__chardbRef, args: { orgId: "7", body: "" } },
            vshardOf
        );
        expect(rejected).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS" } });
    });

    test("rejects every non-JSON validator output before routing", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const outputs = [
            { orgId: "org-1", value: new Date(0) },
            { orgId: "org-1", value: undefined },
            { orgId: "org-1", value: Number.NaN },
            { orgId: "org-1", value: cyclic },
        ];
        for (const output of outputs) {
            const schema = {
                "~standard": {
                    version: 1,
                    vendor: "test",
                    validate: () => ({ value: output }),
                },
            } as StandardSchemaV1<unknown, { orgId: string }>;
            const invalid = defineMutation({
                ref: `api/non-json#${outputs.indexOf(output)}`,
                args: schema,
                authority: "organization",
                partitionKey: "orgId",
                handler: () => null,
            });
            const result = routeMutation(
                manifestFromExports({ invalid }),
                { ref: invalid.__chardbRef, args: { orgId: "raw" } },
                vshardOf
            );
            expect(result).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS" } });
        }
    });

    test("owns raw and transformed Proxy arguments without invoking getters", () => {
        let ownKeysRuns = 0;
        let getterRuns = 0;
        const proxied = new Proxy(
            { orgId: "org-proxy", body: "safe" },
            {
                ownKeys(target) {
                    ownKeysRuns += 1;
                    return Reflect.ownKeys(target);
                },
                getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
                get() {
                    getterRuns += 1;
                    throw new Error("property getters must not run during mutation admission");
                },
            }
        ) as unknown as RawJson;
        const raw = routeMutation(manifest, { ref: postMessage.__chardbRef, args: proxied }, vshardOf);
        expect(raw).toMatchObject({
            ok: true,
            partitionKey: "org-proxy",
            args: { orgId: "org-proxy", body: "safe" },
        });

        const schema = {
            "~standard": {
                version: 1,
                vendor: "test",
                validate: () => ({ value: proxied }),
            },
        } as unknown as StandardSchemaV1<unknown, PostArgs>;
        const transformed = defineMutation({
            ref: "api/proxy#post",
            args: schema,
            authority: "organization",
            partitionKey: args => args.orgId,
            handler: () => null,
        });
        const routed = routeMutation(
            manifestFromExports({ transformed }),
            { ref: transformed.__chardbRef, args: {} },
            vshardOf
        );
        expect(routed).toMatchObject({
            ok: true,
            partitionKey: "org-proxy",
            args: { orgId: "org-proxy", body: "safe" },
        });
        expect(getterRuns).toBe(0);
        expect(ownKeysRuns).toBe(2);
    });

    test("caps transformed mutation arguments before partition extraction or canonical routing", () => {
        let partitionCalls = 0;
        const outputs: Record<string, RawJson>[] = [
            { value: "x".repeat(CDB_MUTATION_ARGS_MAX_BYTES) },
            { value: Array.from({ length: CDB_JSON_MAX_AGGREGATE_MEMBERS + 1 }, () => null) },
            { value: nestedArray(CDB_MUTATION_ARGS_MAX_DEPTH + 1) },
        ];
        for (const [index, output] of outputs.entries()) {
            const schema = {
                "~standard": {
                    version: 1,
                    vendor: "test",
                    validate: () => ({ value: output }),
                },
            } as StandardSchemaV1<unknown, Record<string, RawJson>>;
            const transformed = defineMutation({
                ref: `api/oversized#${index}`,
                args: schema,
                partitionKey: () => {
                    partitionCalls += 1;
                    return "must-not-route";
                },
                handler: () => null,
            });
            expect(
                routeMutation(
                    manifestFromExports({ transformed }),
                    { ref: transformed.__chardbRef, args: {} },
                    vshardOf
                )
            ).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } });
        }
        expect(partitionCalls).toBe(0);
    });

    test("does not forward the partition extractor's mutable argument copy", () => {
        const mutation = defineMutation<unknown, PostArgs, null>(
            function mutation() {
                return null;
            },
            {
                ref: "api/mutating-partition#post",
                authority: "organization",
                partitionKey: args => {
                    const key = args.orgId;
                    const mutable = args as { orgId: string; body: string; injected?: string };
                    mutable.orgId = "org-mutated";
                    mutable.body = "mutated";
                    mutable.injected = "mutated";
                    return key;
                },
            }
        );
        const routed = routeMutation(
            manifestFromExports({ mutation }),
            { ref: mutation.__chardbRef, args: { orgId: "org-original", body: "original" } },
            vshardOf
        );
        expect(routed).toEqual({
            ok: true,
            vshard: Number(vshardOf(["org-original"])),
            authority: "organization",
            partitionKey: "org-original",
            args: { orgId: "org-original", body: "original" },
        });
    });
});
