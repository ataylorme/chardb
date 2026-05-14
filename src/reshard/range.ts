/**
 * Pure helpers for vshard-range filtering during a split. The Cdb DOs share
 * an identical schema, so a row is "in" a migration's range iff the vshard
 * computed from its partition column value falls in `[lo, hi]`.
 */

import { vshardOf } from "../vshard.ts";

export interface RangeFilter {
    readonly lo: number;
    readonly hi: number;
}

/**
 * Compute the vshard for a single row's partition value. `null`/`undefined`
 * are treated as the empty string; numeric and bigint values are coerced to
 * their canonical decimal form to match the bulk-copy phase's encoding.
 */
export function rowVshard(value: unknown): number {
    if (value === null || value === undefined) return Number(vshardOf([""]));
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
        return Number(vshardOf([typeof value === "string" ? value : String(value)]));
    }
    return Number(vshardOf([String(value)]));
}

export function inRange(value: unknown, range: RangeFilter): boolean {
    const v = rowVshard(value);
    return v >= range.lo && v <= range.hi;
}

export function filterRowsInRange<T extends Record<string, unknown>>(
    rows: readonly T[],
    partitionColumn: string,
    range: RangeFilter
): T[] {
    return rows.filter(r => inRange(r[partitionColumn], range));
}
