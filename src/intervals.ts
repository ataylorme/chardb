/**
 * IntervalSet + IntervalMap for live-query invalidation.
 *
 * Built from CdbIntent.where + the schema's resolved index for the table.
 * Each shard projects every committed write's index keys against its
 * IntervalMap to determine which subscriptions are dirty (Convex-shape;
 * `convex-backend/crates/database/src/subscription.rs`).
 *
 * Keys are a tuple of comparable scalars (string | number | bigint | Uint8Array).
 * Endpoint inclusivity is encoded explicitly so half-open ranges (e.g. LIKE
 * 'prefix%') and point intervals compose correctly.
 */

export type IntervalScalar = string | number | bigint | Uint8Array;
export type IntervalKey = readonly IntervalScalar[];

export type Endpoint =
    | { kind: "neg_inf" }
    | { kind: "pos_inf" }
    | { kind: "value"; value: IntervalKey; inclusive: boolean };

export const NEG_INF: Endpoint = Object.freeze({ kind: "neg_inf" });
export const POS_INF: Endpoint = Object.freeze({ kind: "pos_inf" });

export interface Interval {
    readonly lo: Endpoint;
    readonly hi: Endpoint;
}

/** Lex-compare two scalars; throws on mixed types. */
function cmpScalar(a: IntervalScalar, b: IntervalScalar): number {
    if (typeof a !== typeof b && !(a instanceof Uint8Array && b instanceof Uint8Array)) {
        throw new TypeError(`mixed scalar types: ${typeof a} vs ${typeof b}`);
    }
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            const av = a[i] as number;
            const bv = b[i] as number;
            if (av !== bv) return av - bv;
        }
        return a.length - b.length;
    }
    return 0;
}

/** Lex-compare two interval keys. */
export function cmpKey(a: IntervalKey, b: IntervalKey): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const c = cmpScalar(a[i] as IntervalScalar, b[i] as IntervalScalar);
        if (c !== 0) return c;
    }
    return a.length - b.length;
}

/**
 * Compare two endpoints as if they live on the number line.
 * `side`: "lo" treats inclusive as "smaller" than exclusive at the same value;
 *         "hi" treats inclusive as "larger" than exclusive at the same value.
 * For neg_inf/pos_inf, side is irrelevant.
 */
export function cmpEndpoint(a: Endpoint, b: Endpoint, side: "lo" | "hi"): number {
    if (a.kind === "neg_inf") return b.kind === "neg_inf" ? 0 : -1;
    if (b.kind === "neg_inf") return 1;
    if (a.kind === "pos_inf") return b.kind === "pos_inf" ? 0 : 1;
    if (b.kind === "pos_inf") return -1;
    const c = cmpKey(a.value, b.value);
    if (c !== 0) return c;
    if (a.inclusive === b.inclusive) return 0;
    if (side === "lo") return a.inclusive ? -1 : 1;
    return a.inclusive ? 1 : -1;
}

/** Inclusive point interval `[v, v]`. */
export function point(value: IntervalKey): Interval {
    return {
        lo: { kind: "value", value, inclusive: true },
        hi: { kind: "value", value, inclusive: true },
    };
}

/** `[lo, hi]`. */
export function closedRange(lo: IntervalKey, hi: IntervalKey): Interval {
    return {
        lo: { kind: "value", value: lo, inclusive: true },
        hi: { kind: "value", value: hi, inclusive: true },
    };
}

/** `[prefix, prefix++)` — half-open right; matches LIKE 'prefix%'. */
export function prefixRange(prefix: IntervalKey, supremum: IntervalKey): Interval {
    return {
        lo: { kind: "value", value: prefix, inclusive: true },
        hi: { kind: "value", value: supremum, inclusive: false },
    };
}

export const FULL: Interval = Object.freeze({ lo: NEG_INF, hi: POS_INF });

/**
 * Compare a left-bound `loEp` against a right-bound `hiEp`. Returns true when
 * `loEp ≤ hiEp` on the number line, treating exclusive endpoints as the
 * appropriate ε-shift.
 */
function leLoHi(loEp: Endpoint, hiEp: Endpoint): boolean {
    if (loEp.kind === "neg_inf") return true;
    if (hiEp.kind === "pos_inf") return true;
    if (loEp.kind === "pos_inf" || hiEp.kind === "neg_inf") return false;
    const c = cmpKey(loEp.value, hiEp.value);
    if (c !== 0) return c < 0;
    // Equal values: only a closed-on-both pair touches.
    return loEp.inclusive && hiEp.inclusive;
}

/** Two intervals overlap iff `a.lo ≤ b.hi` AND `b.lo ≤ a.hi`. */
export function overlaps(a: Interval, b: Interval): boolean {
    return leLoHi(a.lo, b.hi) && leLoHi(b.lo, a.hi);
}

/** `key ∈ interval`. Treats `key` as inclusive at both endpoints. */
export function contains(interval: Interval, key: IntervalKey): boolean {
    const point: Endpoint = { kind: "value", value: key, inclusive: true };
    return cmpEndpoint(interval.lo, point, "lo") <= 0 && cmpEndpoint(point, interval.hi, "hi") <= 0;
}

/**
 * A union of intervals. We do NOT canonicalize/merge on every add (cheap to
 * keep, expensive to maintain a perfect interval tree at typical sub counts).
 * Intersections are linear in the number of intervals, which is fine for the
 * <1k-subs-per-shard regime; if a shard ever exceeds that, we replace this
 * with a segment tree without changing the public surface.
 */
export class IntervalSet {
    private readonly intervals: Interval[] = [];

    add(interval: Interval): this {
        this.intervals.push(interval);
        return this;
    }

    size(): number {
        return this.intervals.length;
    }

    /** True if any interval in the set contains the key. */
    contains(key: IntervalKey): boolean {
        for (const iv of this.intervals) if (contains(iv, key)) return true;
        return false;
    }

    intersects(other: IntervalSet): boolean {
        for (const a of this.intervals) {
            for (const b of other.intervals) if (overlaps(a, b)) return true;
        }
        return false;
    }

    static full(): IntervalSet {
        return new IntervalSet().add(FULL);
    }

    static of(...intervals: Interval[]): IntervalSet {
        const s = new IntervalSet();
        for (const iv of intervals) s.add(iv);
        return s;
    }

    toArray(): readonly Interval[] {
        return this.intervals;
    }
}

/**
 * Per-shard map keyed by `(table, indexName)` → list of `(subId, IntervalSet)`.
 * On every committed write the shard projects the row's index keys for each
 * registered index and asks the IntervalMap which subs to wake.
 */
export class IntervalMap<SubId extends string | number = number> {
    private readonly byKey = new Map<string, { subId: SubId; set: IntervalSet }[]>();

    private static k(table: string, indexName: string): string {
        return `${table}\u0000${indexName}`;
    }

    register(subId: SubId, table: string, indexName: string, set: IntervalSet): void {
        const k = IntervalMap.k(table, indexName);
        let arr = this.byKey.get(k);
        if (!arr) {
            arr = [];
            this.byKey.set(k, arr);
        }
        arr.push({ subId, set });
    }

    unregister(subId: SubId): void {
        for (const [k, arr] of this.byKey) {
            const next = arr.filter(e => e.subId !== subId);
            if (next.length === 0) this.byKey.delete(k);
            else this.byKey.set(k, next);
        }
    }

    /**
     * Return the set of subs whose IntervalSet contains any of the row's
     * (table, indexName) → key projections.
     */
    match(table: string, indexName: string, key: IntervalKey): SubId[] {
        const arr = this.byKey.get(IntervalMap.k(table, indexName));
        if (!arr) return [];
        const hits: SubId[] = [];
        for (const { subId, set } of arr) {
            if (set.contains(key)) hits.push(subId);
        }
        return hits;
    }

    size(): number {
        let n = 0;
        for (const arr of this.byKey.values()) n += arr.length;
        return n;
    }
}
