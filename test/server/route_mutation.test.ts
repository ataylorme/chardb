import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { defineMutation } from "../../src/server/define.ts";
import { manifestFromExports, routeMutation } from "../../src/server/manifest.ts";
import type { RawJson } from "../../src/types.ts";
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
});
