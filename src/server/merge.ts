/**
 * Scatter-gather merge primitives.
 *
 * When a query crosses partitions the gateway issues one sub-query per
 * owning shard, each producing a partial result. The merge functions here
 * combine those partials into one client-visible result with bounded memory:
 *
 *   - `mergeTopK` keeps the global top-K under a deterministic comparator.
 *   - `mergePartialAggregates` folds COUNT / SUM / AVG / MIN / MAX partials
 *     using their commutative algebraic combiners.
 *   - `mergeDistinct` unions the bounded hash-sets each shard returns,
 *     raising `CDB_DISTINCT_CAP_EXCEEDED` once the union crosses the cap.
 *
 * All three are pure functions over typed inputs — no I/O, no globals — so
 * they are exercised in isolation by `test/server/merge.test.ts`.
 */

import { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";

export type Comparator<T> = (a: T, b: T) => number;

/**
 * Merge K-sorted shard partials into the global top-K under `cmp`.
 *
 * Each shard returns at most `k` rows already ordered by `cmp`. We do an
 * O(N·log K) bounded heap merge: the output heap tracks the smallest element
 * seen so far and rejects any new candidate that compares "after" the heap
 * top once size == k.
 *
 * Stable across shards: ties break by `(shardIndex, rowIndex)` so the output
 * is deterministic for replays and tests.
 */
export function mergeTopK<T>(shardPartials: readonly (readonly T[])[], k: number, cmp: Comparator<T>): T[] {
    if (k <= 0) return [];
    type Tagged = { v: T; s: number; i: number };
    const tagCmp = (a: Tagged, b: Tagged): number => {
        const c = cmp(a.v, b.v);
        if (c !== 0) return c;
        if (a.s !== b.s) return a.s - b.s;
        return a.i - b.i;
    };
    const heap: Tagged[] = [];
    for (let s = 0; s < shardPartials.length; s++) {
        const part = shardPartials[s] ?? [];
        for (let i = 0; i < part.length; i++) {
            const candidate: Tagged = { v: part[i] as T, s, i };
            if (heap.length < k) {
                heap.push(candidate);
                siftUp(heap, heap.length - 1, tagCmp);
            } else if (tagCmp(candidate, heap[0] as Tagged) < 0) {
                heap[0] = candidate;
                siftDown(heap, 0, tagCmp);
            }
        }
    }
    return heap.sort(tagCmp).map(t => t.v);
}

// Max-heap helpers under `cmp`: the root is the element for which `cmp` is
// "greatest" (i.e. the current worst-of-best in a top-K bound).
function siftUp<T>(h: T[], i: number, cmp: Comparator<T>): void {
    let cur = i;
    while (cur > 0) {
        const parent = (cur - 1) >> 1;
        if (cmp(h[cur] as T, h[parent] as T) > 0) {
            [h[cur], h[parent]] = [h[parent] as T, h[cur] as T];
            cur = parent;
        } else break;
    }
}

function siftDown<T>(h: T[], i: number, cmp: Comparator<T>): void {
    const n = h.length;
    let cur = i;
    for (;;) {
        const l = cur * 2 + 1;
        const r = l + 1;
        let largest = cur;
        if (l < n && cmp(h[l] as T, h[largest] as T) > 0) largest = l;
        if (r < n && cmp(h[r] as T, h[largest] as T) > 0) largest = r;
        if (largest === cur) break;
        [h[cur], h[largest]] = [h[largest] as T, h[cur] as T];
        cur = largest;
    }
}

export type AggregateOp = "count" | "sum" | "avg" | "min" | "max";

export interface AggregatePartial {
    readonly op: AggregateOp;
    readonly count: number;
    readonly sum?: number;
    readonly min?: number;
    readonly max?: number;
}

export interface AggregateResult {
    readonly op: AggregateOp;
    readonly value: number | null;
}

/**
 * Combine per-shard aggregate partials into one final result. Each `op` has
 * its own algebraic combiner: `sum` adds, `min`/`max` pick the extreme,
 * `avg` accumulates `(sum, count)` and divides at the end. Empty partial
 * sets short-circuit to `null` (SQL semantics) — the caller decides whether
 * that means 0 (`COUNT`) or NULL (`AVG`/`MIN`/`MAX`).
 */
export function mergePartialAggregates(partials: readonly AggregatePartial[]): AggregateResult {
    if (partials.length === 0) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: "mergePartialAggregates requires at least one partial",
        });
    }
    const op = partials[0]?.op as AggregateOp;
    for (const p of partials) {
        if (p.op !== op) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: `aggregate op mismatch: ${op} vs ${p.op}`,
            });
        }
    }
    switch (op) {
        case "count": {
            let total = 0;
            for (const p of partials) total += p.count;
            return { op, value: total };
        }
        case "sum": {
            let total = 0;
            let saw = false;
            for (const p of partials) {
                if (p.count > 0 && p.sum !== undefined) {
                    total += p.sum;
                    saw = true;
                }
            }
            return { op, value: saw ? total : null };
        }
        case "avg": {
            let totalSum = 0;
            let totalCount = 0;
            for (const p of partials) {
                if (p.count > 0 && p.sum !== undefined) {
                    totalSum += p.sum;
                    totalCount += p.count;
                }
            }
            return { op, value: totalCount === 0 ? null : totalSum / totalCount };
        }
        case "min": {
            let acc: number | null = null;
            for (const p of partials) {
                if (p.min === undefined) continue;
                acc = acc === null || p.min < acc ? p.min : acc;
            }
            return { op, value: acc };
        }
        case "max": {
            let acc: number | null = null;
            for (const p of partials) {
                if (p.max === undefined) continue;
                acc = acc === null || p.max > acc ? p.max : acc;
            }
            return { op, value: acc };
        }
    }
}

/**
 * Default cap for the cross-partition DISTINCT union. Crossing this cap
 * surfaces a hard error: chardb does NOT silently sample or downgrade.
 */
export const DISTINCT_UNION_CAP = 1_000_000;

export interface DistinctMergeResult<T extends string> {
    readonly values: readonly T[];
    readonly count: number;
}

/**
 * Union per-shard distinct sets into the global distinct set, capped at
 * `cap`. The cap is a memory bound, not a sampling decision: the function
 * raises `CDB_DISTINCT_CAP_EXCEEDED` on overflow and the caller surfaces
 * that as the user-visible error.
 *
 * Values are typed as `string` so callers can canonicalize at the seam
 * (e.g. `String(x)` or `JSON.stringify(stableJson(x))`); this keeps the
 * comparator a `Set<string>` lookup with no ad-hoc deep-equality logic.
 */
export function mergeDistinct<T extends string>(
    shardSets: readonly (readonly T[])[],
    cap: number = DISTINCT_UNION_CAP
): DistinctMergeResult<T> {
    const out = new Set<T>();
    for (const set of shardSets) {
        for (const v of set) {
            if (!out.has(v)) {
                if (out.size >= cap) {
                    throw new CdbError({
                        code: "CDB_DISTINCT_CAP_EXCEEDED",
                        message: `distinct union exceeded cap ${cap}`,
                    });
                }
                out.add(v);
            }
        }
    }
    return { values: [...out], count: out.size };
}

/** Type guard: a JSON-shaped row pulled out of a `RawJson`. */
export function getJsonField(row: RawJson, key: string): RawJson | undefined {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
    return (row as { readonly [k: string]: RawJson })[key];
}
