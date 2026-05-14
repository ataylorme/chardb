import { describe, expect, test } from "bun:test";
import {
    FULL,
    IntervalMap,
    IntervalSet,
    closedRange,
    cmpEndpoint,
    cmpKey,
    contains,
    overlaps,
    point,
    prefixRange,
} from "../src/intervals.ts";

describe("interval comparisons", () => {
    test("cmpKey lex orders strings and numbers", () => {
        expect(cmpKey(["a"], ["b"])).toBeLessThan(0);
        expect(cmpKey([1, 2], [1, 3])).toBeLessThan(0);
        expect(cmpKey([1, 2], [1, 2])).toBe(0);
    });

    test("cmpEndpoint distinguishes inclusive/exclusive at same value", () => {
        const incl = { kind: "value" as const, value: ["x"], inclusive: true };
        const excl = { kind: "value" as const, value: ["x"], inclusive: false };
        expect(cmpEndpoint(incl, excl, "lo")).toBeLessThan(0);
        expect(cmpEndpoint(incl, excl, "hi")).toBeGreaterThan(0);
    });
});

describe("Interval primitives", () => {
    test("point interval contains exact key only", () => {
        const iv = point(["org-1"]);
        expect(contains(iv, ["org-1"])).toBe(true);
        expect(contains(iv, ["org-2"])).toBe(false);
    });

    test("closed range inclusive on both endpoints", () => {
        const iv = closedRange([1], [10]);
        expect(contains(iv, [1])).toBe(true);
        expect(contains(iv, [10])).toBe(true);
        expect(contains(iv, [11])).toBe(false);
    });

    test("prefix range exclusive on supremum", () => {
        const iv = prefixRange(["abc"], ["abd"]);
        expect(contains(iv, ["abc"])).toBe(true);
        expect(contains(iv, ["abcz"])).toBe(true);
        expect(contains(iv, ["abd"])).toBe(false);
    });

    test("overlaps respects inclusivity", () => {
        expect(overlaps(closedRange([1], [5]), closedRange([5], [10]))).toBe(true);
        expect(
            overlaps(
                {
                    lo: { kind: "value", value: [1], inclusive: true },
                    hi: { kind: "value", value: [5], inclusive: false },
                },
                {
                    lo: { kind: "value", value: [5], inclusive: true },
                    hi: { kind: "value", value: [10], inclusive: true },
                }
            )
        ).toBe(false);
    });

    test("FULL contains everything", () => {
        expect(contains(FULL, [Number.MIN_SAFE_INTEGER])).toBe(true);
        expect(contains(FULL, ["zzz"])).toBe(true);
    });
});

describe("IntervalSet", () => {
    test("contains hits any registered interval", () => {
        const s = IntervalSet.of(point(["a"]), closedRange(["m"], ["p"]));
        expect(s.contains(["a"])).toBe(true);
        expect(s.contains(["o"])).toBe(true);
        expect(s.contains(["z"])).toBe(false);
    });

    test("intersects detects overlap", () => {
        const a = IntervalSet.of(closedRange([1], [10]));
        const b = IntervalSet.of(closedRange([5], [15]));
        expect(a.intersects(b)).toBe(true);
        expect(a.intersects(IntervalSet.of(closedRange([20], [30])))).toBe(false);
    });
});

describe("IntervalMap", () => {
    test("match returns subs whose interval contains the key", () => {
        const m = new IntervalMap<number>();
        m.register(1, "messages", "by_org", IntervalSet.of(point(["org-1"])));
        m.register(2, "messages", "by_org", IntervalSet.of(closedRange(["org-0"], ["org-9"])));
        m.register(3, "messages", "by_user", IntervalSet.of(point(["org-1"])));

        const hits = m.match("messages", "by_org", ["org-1"]).sort();
        expect(hits).toEqual([1, 2]);
    });

    test("unregister removes all intervals for a sub", () => {
        const m = new IntervalMap<number>();
        m.register(1, "t", "i", IntervalSet.of(FULL));
        m.register(2, "t", "i", IntervalSet.of(FULL));
        m.unregister(1);
        expect(m.match("t", "i", ["k"])).toEqual([2]);
    });
});
