import { describe, expect, test } from "bun:test";
import { isCdbError } from "../../src/errors.ts";
import {
    type AggregatePartial,
    DISTINCT_UNION_CAP,
    mergeDistinct,
    mergePartialAggregates,
    mergeTopK,
} from "../../src/server/merge.ts";

describe("mergeTopK", () => {
    test("global top-K under ascending comparator", () => {
        const cmp = (a: number, b: number) => a - b;
        const out = mergeTopK(
            [
                [1, 4, 9],
                [2, 3, 10],
                [5, 6, 7, 8],
            ],
            5,
            cmp
        );
        expect(out).toEqual([1, 2, 3, 4, 5]);
    });

    test("k=0 returns empty", () => {
        expect(mergeTopK([[1, 2]], 0, (a: number, b) => a - b)).toEqual([]);
    });

    test("k larger than total candidates is fine", () => {
        expect(mergeTopK([[3], [1], [2]], 100, (a: number, b) => a - b)).toEqual([1, 2, 3]);
    });

    test("ties break deterministically by (shardIndex, rowIndex)", () => {
        type Row = { v: number; tag: string };
        const cmp = (a: Row, b: Row) => a.v - b.v;
        const out = mergeTopK<Row>(
            [
                [
                    { v: 1, tag: "s0/0" },
                    { v: 1, tag: "s0/1" },
                ],
                [{ v: 1, tag: "s1/0" }],
            ],
            2,
            cmp
        );
        expect(out.map(r => r.tag)).toEqual(["s0/0", "s0/1"]);
    });

    test("descending comparator picks the largest K", () => {
        const cmp = (a: number, b: number) => b - a;
        expect(
            mergeTopK(
                [
                    [1, 4, 9],
                    [2, 3, 10],
                ],
                3,
                cmp
            )
        ).toEqual([10, 9, 4]);
    });
});

describe("mergePartialAggregates", () => {
    test("count sums per-shard counts", () => {
        const r = mergePartialAggregates([
            { op: "count", count: 3 },
            { op: "count", count: 7 },
            { op: "count", count: 0 },
        ]);
        expect(r).toEqual({ op: "count", value: 10 });
    });

    test("sum is null when every shard is empty", () => {
        const r = mergePartialAggregates([
            { op: "sum", count: 0 },
            { op: "sum", count: 0 },
        ]);
        expect(r.value).toBeNull();
    });

    test("avg accumulates (sum, count) across shards", () => {
        const r = mergePartialAggregates([
            { op: "avg", count: 2, sum: 10 },
            { op: "avg", count: 3, sum: 21 },
        ]);
        expect(r.value).toBeCloseTo((10 + 21) / 5);
    });

    test("min/max pick the cluster-wide extreme; empty shards are ignored", () => {
        const min = mergePartialAggregates([
            { op: "min", count: 5, min: 3 },
            { op: "min", count: 0 },
            { op: "min", count: 2, min: 1 },
        ]);
        expect(min.value).toBe(1);
        const max = mergePartialAggregates([
            { op: "max", count: 1, max: 99 },
            { op: "max", count: 1, max: 7 },
        ]);
        expect(max.value).toBe(99);
    });

    test("mismatched ops raise CDB_INVARIANT", () => {
        expect(() =>
            mergePartialAggregates([
                { op: "sum", count: 1, sum: 1 } as AggregatePartial,
                { op: "count", count: 1 } as AggregatePartial,
            ])
        ).toThrow(/CDB_INVARIANT|aggregate op mismatch/);
    });
});

describe("mergeDistinct", () => {
    test("unions per-shard sets and reports the count", () => {
        const r = mergeDistinct([
            ["a", "b"],
            ["b", "c"],
            ["c", "d"],
        ]);
        expect([...r.values].sort()).toEqual(["a", "b", "c", "d"]);
        expect(r.count).toBe(4);
    });

    test("respects a small cap by raising CDB_DISTINCT_CAP_EXCEEDED", () => {
        let err: unknown;
        try {
            mergeDistinct(
                [
                    ["a", "b", "c"],
                    ["d", "e"],
                ],
                3
            );
        } catch (e) {
            err = e;
        }
        expect(isCdbError(err)).toBe(true);
        if (isCdbError(err)) expect(err.code).toBe("CDB_DISTINCT_CAP_EXCEEDED");
    });

    test("default cap is 1M (sanity bound)", () => {
        expect(DISTINCT_UNION_CAP).toBe(1_000_000);
    });
});
