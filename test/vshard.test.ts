import { describe, expect, test } from "bun:test";
import { ShardId, type Vshard } from "../src/types.ts";
import { VSHARD_COUNT, VshardMap, canonicalConcat, vshardOf } from "../src/vshard.ts";

describe("vshard router", () => {
    test("vshardOf is deterministic and inside the namespace", () => {
        for (const k of ["org-1", "org-2", "0", "user:abc"]) {
            const v = vshardOf([k]);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(VSHARD_COUNT);
            expect(vshardOf([k])).toBe(v);
        }
    });

    test("composite key encoding differs from concatenated single-string key", () => {
        const a = vshardOf(["abc", "def"]);
        const b = vshardOf(["abcdef"]);
        expect(a).not.toBe(b);
    });

    test("canonicalConcat inserts a sep between cols", () => {
        const a = canonicalConcat(["a", "b"]);
        const b = canonicalConcat(["ab"]);
        expect(a.length).toBe(b.length + 1);
    });

    test("composite keys with unicode encode UTF-8 deterministically", () => {
        expect(vshardOf(["café", "🚀"])).toBe(vshardOf(["café", "🚀"]));
        // ASCII-only spelling differs from unicode spelling.
        expect(vshardOf(["cafe"])).not.toBe(vshardOf(["café"]));
    });

    test("composite keys with bigint and number coerce via String(...) so 1n and 1 hash equal", () => {
        expect(vshardOf([1n])).toBe(vshardOf([1]));
        expect(vshardOf([1n])).toBe(vshardOf(["1"]));
        expect(vshardOf([2n ** 53n + 7n])).toBe(vshardOf([String(2n ** 53n + 7n)]));
    });

    test("composite keys with Uint8Array travel through canonicalConcat untouched", () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        expect(vshardOf([bytes])).toBe(vshardOf([new Uint8Array([1, 2, 3, 4, 5])]));
        // Different bytes → different vshard (probabilistically; deterministic for these inputs).
        expect(vshardOf([new Uint8Array([1, 2, 3])])).not.toBe(vshardOf([new Uint8Array([3, 2, 1])]));
    });

    test("permuted composite keys produce different vshards (column order is part of the key)", () => {
        expect(vshardOf(["alpha", "beta"])).not.toBe(vshardOf(["beta", "alpha"]));
    });

    test("unsupported scalar types throw with a clear message", () => {
        // boolean / object / null are not in the supported scalar set.
        expect(() => vshardOf([true as unknown as string])).toThrow(/unsupported partition key scalar/);
        expect(() => vshardOf([null as unknown as string])).toThrow(/unsupported partition key scalar/);
        expect(() => vshardOf([{} as unknown as string])).toThrow(/unsupported partition key scalar/);
    });

    test("empty composite key produces a stable vshard (the empty-bytes hash)", () => {
        const v = vshardOf([]);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(VSHARD_COUNT);
        expect(vshardOf([])).toBe(v);
    });
});

describe("VshardMap", () => {
    test("default map covers full namespace, single shard", () => {
        const m = new VshardMap();
        expect(m.routeVshard(0 as Vshard)).toBe(ShardId("ShardDO_0"));
        expect(m.routeVshard((VSHARD_COUNT - 1) as Vshard)).toBe(ShardId("ShardDO_0"));
    });

    test("split carves out a sub-range to a new shard", () => {
        const m = new VshardMap().split(0, 8191, ShardId("ShardDO_1"));
        expect(m.routeVshard(0 as Vshard)).toBe(ShardId("ShardDO_1"));
        expect(m.routeVshard(8192 as Vshard)).toBe(ShardId("ShardDO_0"));
        expect(m.ranges_().length).toBe(2);
    });

    test("split into the middle of an existing range produces three pieces", () => {
        const m = new VshardMap().split(4096, 8191, ShardId("ShardDO_1"));
        expect(m.ranges_().length).toBe(3);
        expect(m.routeVshard(0 as Vshard)).toBe(ShardId("ShardDO_0"));
        expect(m.routeVshard(4096 as Vshard)).toBe(ShardId("ShardDO_1"));
        expect(m.routeVshard(8192 as Vshard)).toBe(ShardId("ShardDO_0"));
    });

    test("nested splits are monotonic", () => {
        const m = new VshardMap().split(0, 8191, ShardId("ShardDO_1")).split(4096, 6143, ShardId("ShardDO_2"));
        expect(m.routeVshard(0 as Vshard)).toBe(ShardId("ShardDO_1"));
        expect(m.routeVshard(4096 as Vshard)).toBe(ShardId("ShardDO_2"));
        expect(m.routeVshard(6143 as Vshard)).toBe(ShardId("ShardDO_2"));
        expect(m.routeVshard(6144 as Vshard)).toBe(ShardId("ShardDO_1"));
        expect(m.routeVshard(8192 as Vshard)).toBe(ShardId("ShardDO_0"));
    });

    test("split that crosses range boundaries throws", () => {
        const m = new VshardMap().split(0, 8191, ShardId("ShardDO_1"));
        expect(() => m.split(4096, 12000, ShardId("ShardDO_2"))).toThrow();
    });

    test("shardsInRange returns every shard owning ≥1 vshard inside [lo, hi]", () => {
        const m = new VshardMap().split(0, 8191, ShardId("ShardDO_1")).split(8192, 12287, ShardId("ShardDO_2"));
        const owners = m.shardsInRange(4000, 9000).sort();
        expect(owners).toEqual(["ShardDO_1", "ShardDO_2"].map(ShardId).sort());
    });

    test("vshard out of range throws", () => {
        const m = new VshardMap();
        expect(() => m.routeVshard(VSHARD_COUNT as Vshard)).toThrow();
    });
});
