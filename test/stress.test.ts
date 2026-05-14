/**
 * Stress / property-style tests for the routing & merge primitives.
 *
 * Catches regressions the small-scale unit tests can't see: distribution
 * skew, range invariants under repeated splits, IntervalMap correctness vs
 * a brute-force reference, and scatter-gather merge correctness at realistic
 * fan-in widths.
 */
import { describe, expect, test } from "bun:test";
import { IntervalMap, IntervalSet } from "../src/intervals.ts";
import { mergePartialAggregates, mergeTopK } from "../src/server/merge.ts";
import { ShardId, type Vshard } from "../src/types.ts";
import { VSHARD_COUNT, VshardMap, vshardOf } from "../src/vshard.ts";

function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >> 17;
        s >>>= 0;
        s ^= s << 5;
        s >>>= 0;
        return s / 0xffffffff;
    };
}

describe("vshardOf — distribution under load", () => {
    test("10k random keys distribute without pathological skew", () => {
        const r = rng(0xa5a5a5);
        const N = 10_000;
        const buckets = new Uint32Array(VSHARD_COUNT);
        for (let i = 0; i < N; i++) {
            const key = `tenant-${Math.floor(r() * 1e9).toString(36)}-${i}`;
            buckets[Number(vshardOf([key]))]! += 1;
        }
        let nonempty = 0;
        let max = 0;
        for (const c of buckets) {
            if (c > 0) nonempty++;
            if (c > max) max = c;
        }
        expect(nonempty).toBeGreaterThan(N * 0.4);
        expect(max).toBeLessThan(40);
    });

    test("vshardOf is deterministic across 200 randomized inputs", () => {
        const r = rng(7);
        for (let i = 0; i < 200; i++) {
            const k = `k-${Math.floor(r() * 1e9).toString(36)}`;
            expect(vshardOf([k])).toBe(vshardOf([k]));
        }
    });
});

describe("VshardMap — split invariants under repeated random splits", () => {
    test("after 200 random splits the range table still tiles [0, VSHARD_COUNT-1] with no gaps or overlaps", () => {
        let map = new VshardMap();
        const r = rng(42);
        for (let i = 0; i < 200; i++) {
            const ranges = [...map.ranges_()];
            const target = ranges[Math.floor(r() * ranges.length)]!;
            if (target.hi <= target.lo) continue;
            const lo = target.lo + Math.floor(r() * (target.hi - target.lo));
            const hi = lo + 1 + Math.floor(r() * (target.hi - lo));
            const clampedHi = Math.min(hi, target.hi);
            if (clampedHi <= lo) continue;
            try {
                map = map.split(lo, clampedHi, ShardId(`s${i + 1}`));
            } catch {
                // split may reject specific overlap shapes; skip and continue.
            }
        }
        const ranges = [...map.ranges_()];
        expect(ranges[0]!.lo).toBe(0);
        expect(ranges[ranges.length - 1]!.hi).toBe(VSHARD_COUNT - 1);
        for (let i = 1; i < ranges.length; i++) {
            expect(ranges[i]!.lo).toBe(ranges[i - 1]!.hi + 1);
        }
        for (let v = 0; v < VSHARD_COUNT; v += 137) {
            const owner = map.routeVshard(v as Vshard);
            expect(typeof owner).toBe("string");
        }
    });
});

describe("IntervalMap — random property check vs brute-force", () => {
    test("1000 closed intervals match a naive scan for 200 random keys", () => {
        const map = new IntervalMap<number>();
        const refs: { id: number; lo: number; hi: number }[] = [];
        const r = rng(99);
        for (let id = 0; id < 1000; id++) {
            const a = Math.floor(r() * 1000);
            const b = Math.floor(r() * 1000);
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            refs.push({ id, lo, hi });
            const set = IntervalSet.of({
                lo: { kind: "value", value: [lo], inclusive: true },
                hi: { kind: "value", value: [hi], inclusive: true },
            });
            map.register(id, "messages", "by_score", set);
        }
        for (let i = 0; i < 200; i++) {
            const key = Math.floor(r() * 1000);
            const got = new Set(map.match("messages", "by_score", [key]));
            const want = new Set(refs.filter(x => x.lo <= key && key <= x.hi).map(x => x.id));
            expect(got.size).toBe(want.size);
            for (const id of want) expect(got.has(id)).toBe(true);
        }
    });
});

describe("mergeTopK — 100 shards × 1k rows matches a naive global sort", () => {
    test("k=50 across 100 partials is identical to flatten+sort+slice", () => {
        const r = rng(13);
        const partials: { id: string; rank: number }[][] = [];
        const flat: { id: string; rank: number }[] = [];
        for (let s = 0; s < 100; s++) {
            const rows: { id: string; rank: number }[] = [];
            for (let i = 0; i < 1000; i++) {
                const row = { id: `s${s}-r${i}`, rank: r() };
                rows.push(row);
                flat.push(row);
            }
            rows.sort((a, b) => b.rank - a.rank);
            partials.push(rows.slice(0, 50));
        }
        const merged = mergeTopK(partials, 50, (a, b) => b.rank - a.rank);
        flat.sort((a, b) => b.rank - a.rank);
        const ref = flat.slice(0, 50);
        expect(merged.map(m => m.id)).toEqual(ref.map(m => m.id));
    });
});

describe("mergePartialAggregates — count/sum over 100 shards is exact", () => {
    test("count aggregate matches a single-pass reference", () => {
        const r = rng(31);
        let totalCount = 0;
        const partials: { op: "count"; count: number }[] = [];
        for (let s = 0; s < 100; s++) {
            const c = 100 + Math.floor(r() * 200);
            totalCount += c;
            partials.push({ op: "count", count: c });
        }
        const merged = mergePartialAggregates(partials);
        expect(merged).toEqual({ op: "count", value: totalCount });
    });

    test("sum aggregate matches a single-pass reference", () => {
        const r = rng(31);
        let totalSum = 0;
        const partials: { op: "sum"; count: number; sum: number }[] = [];
        for (let s = 0; s < 100; s++) {
            let sum = 0;
            const n = 100 + Math.floor(r() * 200);
            for (let i = 0; i < n; i++) sum += Math.floor(r() * 1000);
            totalSum += sum;
            partials.push({ op: "sum", count: n, sum });
        }
        const merged = mergePartialAggregates(partials);
        expect(merged).toEqual({ op: "sum", value: totalSum });
    });
});
