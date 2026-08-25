/**
 * `chardb/miniflare-plugin` — dev-time helpers (DEV ONLY).
 *
 * Production binds via standard Cloudflare primitives in Wrangler config;
 * this module never ships to prod. It exposes three small dev-loop utilities:
 *
 *   - `InMemoryVectorize` — drop-in stub for `@cloudflare/workers-types`'s
 *     `VectorizeIndex.query`. Stores vectors in memory and ranks by cosine
 *     similarity. Bind under `CDB_VECTORIZE` for local tests.
 *   - `cronMatches(expr, date)` — evaluates a 5-field cron expression against
 *     a `Date`. Used by `runCronSimulator` to drive `defineCron` callbacks at
 *     the cadence the user wrote in Wrangler config, without waiting on the
 *     real Cloudflare cron tick.
 *   - `chardbMiniflarePlugin` — a Miniflare external-plugin shape; today it
 *     attaches the helpers above to the user's options object so dev wiring
 *     is `import + spread` rather than ad-hoc cross-references.
 *
 * Cron grammar reference:
 * https://developers.cloudflare.com/workers/configuration/cron-triggers/.
 */

import { cosineSimilarity } from "../vector.ts";

export interface ChardbMiniflarePluginOptions {
    readonly seed?: { readonly schema?: string };
}

export interface VectorizeMatch {
    readonly id: string;
    readonly score: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

/** In-memory `VectorizeIndex`-shaped stub for dev. */
export class InMemoryVectorize {
    private readonly entries = new Map<string, { vec: Float32Array; metadata?: Record<string, unknown> }>();

    constructor(public readonly dimension: number) {}

    upsert(
        records: readonly {
            id: string;
            values: readonly number[];
            metadata?: Record<string, unknown>;
        }[]
    ): void {
        for (const r of records) {
            if (r.values.length !== this.dimension) {
                throw new Error(`InMemoryVectorize: expected dim=${this.dimension}, got ${r.values.length}`);
            }
            this.entries.set(r.id, {
                vec: Float32Array.from(r.values),
                ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
            });
        }
    }

    query(values: readonly number[], opts: { topK?: number } = {}): { matches: VectorizeMatch[] } {
        const topK = opts.topK ?? 10;
        const q = Float32Array.from(values);
        const matches: VectorizeMatch[] = [];
        for (const [id, { vec, metadata }] of this.entries) {
            matches.push({
                id,
                score: cosineSimilarity(q, vec),
                ...(metadata !== undefined ? { metadata } : {}),
            });
        }
        matches.sort((a, b) => b.score - a.score);
        return { matches: matches.slice(0, topK) };
    }

    size(): number {
        return this.entries.size;
    }
}

/**
 * Match a 5-field cron expression against a `Date`. Supports `*`, exact
 * numbers, comma-lists, ranges (`a-b`), and step values written as
 * `<base>/<step>` (e.g. `*` slash `15` for every fifteen minutes). The
 * fields, in order, are: minute (0-59), hour (0-23), day-of-month (1-31),
 * month (1-12), day-of-week (0-6, 0=Sunday). Whitespace-separated; aliases
 * such as the `@hourly` shorthand are intentionally not supported because
 * Cloudflare Cron Triggers don't accept them either.
 */
export function cronMatches(expr: string, date: Date): boolean {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
    return (
        fieldMatches(m, date.getUTCMinutes(), 0, 59) &&
        fieldMatches(h, date.getUTCHours(), 0, 23) &&
        fieldMatches(dom, date.getUTCDate(), 1, 31) &&
        fieldMatches(mon, date.getUTCMonth() + 1, 1, 12) &&
        fieldMatches(dow, date.getUTCDay(), 0, 6)
    );
}

function fieldMatches(field: string, value: number, lo: number, hi: number): boolean {
    for (const term of field.split(",")) {
        const [base, stepRaw] = term.split("/");
        const step = stepRaw ? Number.parseInt(stepRaw, 10) : 1;
        if (!Number.isFinite(step) || step <= 0) return false;
        let rLo = lo;
        let rHi = hi;
        if (base !== undefined && base !== "*") {
            const r = base.split("-");
            const a = Number.parseInt(r[0] ?? "", 10);
            const b = r[1] !== undefined ? Number.parseInt(r[1], 10) : a;
            if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
            rLo = a;
            rHi = b;
        }
        if (value < rLo || value > rHi) continue;
        if ((value - rLo) % step === 0) return true;
    }
    return false;
}

/* -------------------------------------------------------------------------- */
/*                              Cron simulator                                */
/* -------------------------------------------------------------------------- */

/** Minimal shape we need from a `defineCron` export — a callable carrying the cron expression. */
export interface CronHandle {
    readonly __chardbCron: string;
    (): void | Promise<void>;
}

export interface CronSimulatorOptions {
    /** Inclusive UTC start; defaults to `new Date()`. */
    readonly start?: Date;
    /** Inclusive UTC end; defaults to `start + 1h`. */
    readonly end?: Date;
    /** Step in milliseconds; defaults to 60_000 (one minute, matching Cron Triggers). */
    readonly stepMs?: number;
    /**
     * Called once for every (handler, occurrence) match. Defaults to invoking
     * the handler inline. Override to record fires in tests, or to enforce
     * concurrency limits in long-running dev loops.
     */
    readonly invoke?: (handle: CronHandle, occurrence: Date) => void | Promise<void>;
}

export interface CronSimulatorReport {
    readonly fires: ReadonlyArray<{ readonly cronExpr: string; readonly occurrence: Date }>;
    readonly stepsEvaluated: number;
}

/**
 * Drive every registered `defineCron` handle through a synthetic time
 * range, firing handlers at every minute (or `stepMs`-aligned tick) where
 * `cronMatches(handle.__chardbCron, t)` is true. Returns a deterministic
 * report so tests can assert "this cron fires N times in this window."
 *
 * The simulator runs handlers sequentially; concurrent overlap requires
 * an explicit `invoke` override. Unhandled rejections inside `invoke`
 * propagate to the caller — wrap in a try/catch if the dev loop should
 * keep firing past a single failure.
 *
 * Pairs with `chardb/miniflare-plugin`'s `cronMatches`; the rest of the
 * cron path (op-log idempotency keyed by occurrence minute) lives in the
 * worker entrypoint and is exercised separately by the `defineCron` tests.
 */
export async function runCronSimulator(
    handles: readonly CronHandle[],
    opts: CronSimulatorOptions = {}
): Promise<CronSimulatorReport> {
    const start = opts.start ?? new Date();
    const end = opts.end ?? new Date(start.getTime() + 60 * 60 * 1000);
    const stepMs = opts.stepMs ?? 60_000;
    if (stepMs <= 0) throw new Error("runCronSimulator: stepMs must be > 0");
    if (end.getTime() < start.getTime()) {
        throw new Error("runCronSimulator: end must be >= start");
    }
    const invoke =
        opts.invoke ??
        (async (h: CronHandle) => {
            await h();
        });
    const fires: { cronExpr: string; occurrence: Date }[] = [];
    let stepsEvaluated = 0;
    for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
        stepsEvaluated++;
        const at = new Date(t);
        for (const h of handles) {
            if (!cronMatches(h.__chardbCron, at)) continue;
            fires.push({ cronExpr: h.__chardbCron, occurrence: at });
            await invoke(h, at);
        }
    }
    return { fires, stepsEvaluated };
}

export function chardbMiniflarePlugin(_options: ChardbMiniflarePluginOptions = {}): {
    name: "chardb";
    setup: (mf: unknown) => Promise<void>;
    helpers: {
        readonly InMemoryVectorize: typeof InMemoryVectorize;
        readonly cronMatches: typeof cronMatches;
        readonly runCronSimulator: typeof runCronSimulator;
    };
} {
    return {
        name: "chardb",
        async setup(_mf) {},
        helpers: { InMemoryVectorize, cronMatches, runCronSimulator },
    };
}

export default chardbMiniflarePlugin;
