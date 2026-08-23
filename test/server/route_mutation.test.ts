import { describe, expect, test } from "bun:test";
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
    { singlePartition: true, partitionKey: a => a.orgId }
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
        expect(a).toEqual(b);
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
    });
});
