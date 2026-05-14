/**
 * `chardbPolicy` — row-level security closures mirroring the `pgPolicy` shape.
 *
 * Two complementary surfaces:
 *
 *   - `using` / `withCheck` accept a per-row predicate; Drizzle evaluates it
 *     after the row is materialized. Convenient for one-off rules.
 *   - `usingSql` / `withCheckSql` accept a Drizzle `SQL` builder; the
 *     predicate is AND-ed into the query before execution so it shrinks the
 *     planner's row scan. The rewritten AST — not the user's original — is
 *     what gets hashed for live-query fan-in, so two callers with different
 *     policies share zero subscriber state.
 *
 * Rule evaluation never branches on grant vs. deny: a denied row is
 * indistinguishable from a missing row, which prevents the timing /
 * membership leaks an `IS_DENIED` distinction would otherwise enable.
 *
 * Cache invalidation: every write the user's `authDependsOn` tables emit
 * bumps the matching `auth_epoch_*` counter; the gateway folds the current
 * epoch into the live-query hash via `policyDigest`, so a single epoch bump
 * invalidates every dependent subscription on the next `mustRefetch`.
 */

import type { SQL } from "drizzle-orm";
import { and as drizzleAnd } from "drizzle-orm";
import { stableHashHex } from "../util/canonical.ts";
import type { AuthCtx } from "./define.ts";

export interface PolicyDefinition<TTable, TRow = unknown> {
    readonly name: string;
    readonly for: "select" | "insert" | "update" | "delete" | "all";
    readonly to: "authenticated" | "anonymous" | readonly string[] | "*";
    /** Per-row boolean predicate evaluated after materialization. */
    readonly using?: (auth: AuthCtx, row: TRow) => boolean;
    readonly withCheck?: (auth: AuthCtx, row: TRow) => boolean;
    /** SQL predicate AND-ed into the query before execution. */
    readonly usingSql?: (auth: AuthCtx, table: TTable) => SQL | undefined;
    readonly withCheckSql?: (auth: AuthCtx, table: TTable) => SQL | undefined;
    /** Tables whose writes invalidate cached policy decisions for this principal. */
    readonly authDependsOn?: readonly string[];
}

export type PolicyOp = "select" | "insert" | "update" | "delete";

/**
 * Default `TRow` to `TTable.$inferSelect` when the table carries Drizzle's
 * phantom inference property. Lets call sites write
 * `chardbPolicy<typeof messages>("name", { … })` and have `using` /
 * `usingSql` receive a fully typed `row` / `table` parameter without a
 * second generic.
 */
type RowFromTable<TTable> = TTable extends { readonly $inferSelect: infer R } ? R : unknown;

export function chardbPolicy<TTable, TRow = RowFromTable<TTable>>(
    name: string,
    def: Omit<PolicyDefinition<TTable, TRow>, "name">
): PolicyDefinition<TTable, TRow> {
    return Object.freeze({ name, ...def });
}

/**
 * Apply every applicable policy's `usingSql` to a query. Returns the
 * combined SQL predicate or `undefined` if no policy contributed one.
 */
export function applyPoliciesToWhere<TTable, TRow>(args: {
    readonly op: PolicyOp;
    readonly auth: AuthCtx;
    readonly table: TTable;
    readonly userWhere?: SQL | undefined;
    readonly policies: readonly PolicyDefinition<TTable, TRow>[];
}): SQL | undefined {
    const fragments: SQL[] = [];
    if (args.userWhere) fragments.push(args.userWhere);
    for (const p of args.policies) {
        if (!appliesTo(p, args.op, args.auth)) continue;
        const frag = p.usingSql?.(args.auth, args.table);
        if (frag) fragments.push(frag);
    }
    if (fragments.length === 0) return undefined;
    if (fragments.length === 1) return fragments[0];
    return drizzleAnd(...fragments);
}

/**
 * Per-row enforcement for policies that opted into the closure surface
 * instead of the SQL surface. Returns the filtered row set.
 */
export function applyRowPolicies<TTable, TRow>(args: {
    readonly op: PolicyOp;
    readonly auth: AuthCtx;
    readonly rows: readonly TRow[];
    readonly policies: readonly PolicyDefinition<TTable, TRow>[];
}): TRow[] {
    return args.rows.filter(row =>
        args.policies.every(p => {
            if (!appliesTo(p, args.op, args.auth)) return true;
            const fn = args.op === "select" || args.op === "delete" ? p.using : (p.withCheck ?? p.using);
            return fn ? fn(args.auth, row) : true;
        })
    );
}

/**
 * Returns the digest mixed into `queryHash` so a write that bumps an
 * `auth_epoch` invalidates exactly the subscriptions that depend on it.
 *
 * The digest covers the policy names, their `to` audience, their declared
 * `authDependsOn` tables, and the relevant `auth_epoch_*` counters — never
 * the closure source, since that is unstable across hot-reloads.
 */
export interface PolicyDigestEntry {
    readonly name: string;
    readonly for: PolicyDefinition<unknown, unknown>["for"];
    readonly to: PolicyDefinition<unknown, unknown>["to"];
    readonly authDependsOn?: readonly string[] | undefined;
}

export function policyDigest(args: {
    readonly policies: readonly PolicyDigestEntry[];
    readonly authEpochs: {
        readonly global: number;
        readonly tenant: number;
        readonly principal: number;
    };
    readonly auth: AuthCtx;
}): string {
    const sorted = [...args.policies].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const payload = {
        p: sorted.map(p => ({
            n: p.name,
            f: p.for,
            to: Array.isArray(p.to) ? [...p.to].sort() : p.to,
            d: p.authDependsOn ? [...p.authDependsOn].sort() : [],
        })),
        e: args.authEpochs,
        s: { tenantId: args.auth.tenantId ?? null, userId: args.auth.userId ?? null },
    };
    return stableHashHex(payload);
}

function appliesTo<TTable, TRow>(p: PolicyDefinition<TTable, TRow>, op: PolicyOp, auth: AuthCtx): boolean {
    if (p.for !== "all" && p.for !== op) return false;
    const audience = p.to;
    if (audience === "*") return true;
    if (audience === "anonymous") return !auth.userId;
    if (audience === "authenticated") return !!auth.userId;
    if (Array.isArray(audience)) {
        if (!auth.userId) return false;
        return audience.includes(auth.userId);
    }
    return false;
}
