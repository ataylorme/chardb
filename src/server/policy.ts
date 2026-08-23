/**
 * `chardbPolicy` — row-level security closures mirroring the `pgPolicy` shape.
 *
 * Two complementary surfaces:
 *
 *   - `using` / `withCheck` accept a per-row predicate; Drizzle evaluates it
 *     after the row is materialized. Convenient for one-off rules.
 *   - `usingSql` / `withCheckSql` accept a Drizzle `SQL` builder. Floors are
 *     AND-ed and alternative grants are OR-ed before the policy expression is
 *     AND-ed into the query, shrinking the planner's row scan. The rewritten
 *     AST — not the user's original — is what gets hashed for live-query
 *     fan-in, so two callers with different policies share zero subscriber
 *     state.
 *
 * A denied row remains indistinguishable from a missing row, which prevents
 * the timing / membership leaks an `IS_DENIED` distinction would otherwise
 * enable.
 *
 * Cache invalidation: every write the user's `authDependsOn` tables emit
 * bumps the matching `auth_epoch_*` counter; the gateway folds the current
 * epoch into the live-query hash via `policyDigest`, so a single epoch bump
 * invalidates every dependent subscription on the next `mustRefetch`.
 */

import { type SQL, and as drizzleAnd, or as drizzleOr, sql } from "drizzle-orm";
import { stableHashHex } from "../util/canonical.ts";
import type { AuthCtx } from "./define.ts";

export interface PolicyDefinition<TTable, TRow = unknown> {
    readonly name: string;
    readonly for: "select" | "insert" | "update" | "delete" | "all";
    /** A string array names alternative database roles, never principal IDs. */
    readonly to: "authenticated" | "anonymous" | readonly string[] | "*";
    /**
     * Floors are mandatory constraints. Grants are alternatives: at least one
     * applicable grant must accept the operation. Unmarked policies retain the
     * standalone-policy behavior and are treated as grants.
     */
    readonly effect?: "floor" | "grant";
    /** Per-row boolean predicate evaluated after materialization. */
    readonly using?: (auth: AuthCtx, row: TRow) => boolean;
    readonly withCheck?: (auth: AuthCtx, row: TRow) => boolean;
    /** Planner predicate surface used to compile the floor/grant expression. */
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
 * Compile applicable policies as:
 *
 *     user predicate AND every floor AND (grant A OR grant B ...)
 *
 * A private operation with no applicable grant compiles to `1 = 0`. Missing
 * SQL predicates also fail closed; a policy used by this helper must provide
 * its SQL surface explicitly.
 */
export function applyPoliciesToWhere<TTable, TRow>(args: {
    readonly op: PolicyOp;
    readonly auth: AuthCtx;
    readonly table: TTable;
    readonly userWhere?: SQL | undefined;
    readonly policies: readonly PolicyDefinition<TTable, TRow>[];
}): SQL | undefined {
    const floors: SQL[] = [];
    const grants: SQL[] = [];
    for (const p of args.policies) {
        if (!appliesTo(p, args.op, args.auth)) continue;
        const build = args.op === "select" || args.op === "delete" ? p.usingSql : (p.withCheckSql ?? p.usingSql);
        const fragment = build?.(args.auth, args.table) ?? SQL_FALSE;
        if ((p.effect ?? "grant") === "floor") floors.push(fragment);
        else grants.push(fragment);
    }

    const grantPredicate = grants.length === 0 ? SQL_FALSE : (drizzleOr(...grants) ?? SQL_FALSE);
    const fragments = [...(args.userWhere ? [args.userWhere] : []), ...floors, grantPredicate];
    return drizzleAnd(...fragments);
}

/**
 * Apply the same floor-AND-grant semantics to materialized rows. Missing row
 * predicates fail closed; callers using this surface must provide closures.
 */
export function applyRowPolicies<TTable, TRow>(args: {
    readonly op: PolicyOp;
    readonly auth: AuthCtx;
    readonly rows: readonly TRow[];
    readonly policies: readonly PolicyDefinition<TTable, TRow>[];
}): TRow[] {
    const applicable = args.policies.filter(p => appliesTo(p, args.op, args.auth));
    const floors = applicable.filter(p => p.effect === "floor");
    const grants = applicable.filter(p => p.effect !== "floor");

    return args.rows.filter(row => {
        const evaluate = (p: PolicyDefinition<TTable, TRow>): boolean => {
            const fn = args.op === "select" || args.op === "delete" ? p.using : (p.withCheck ?? p.using);
            return fn?.(args.auth, row) ?? false;
        };
        return floors.every(evaluate) && grants.some(evaluate);
    });
}

/**
 * Returns the digest mixed into `queryHash` so a write that bumps an
 * `auth_epoch` invalidates exactly the subscriptions that depend on it.
 *
 * The digest covers policy composition and audience, declared
 * `authDependsOn` tables, the canonical caller role sets, and the relevant
 * `auth_epoch_*` counters — never closure source, since that is unstable
 * across hot-reloads.
 */
export interface PolicyDigestEntry {
    readonly name: string;
    readonly for: PolicyDefinition<unknown, unknown>["for"];
    readonly to: PolicyDefinition<unknown, unknown>["to"];
    readonly effect?: PolicyDefinition<unknown, unknown>["effect"];
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
            e: p.effect ?? "grant",
            d: p.authDependsOn ? [...p.authDependsOn].sort() : [],
        })),
        e: args.authEpochs,
        s: {
            tenantId: args.auth.tenantId ?? null,
            userId: args.auth.userId ?? null,
            roles: audienceRoles(args.auth),
            userRoles: claimRoles(args.auth.claims.userRole),
        },
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
        const roles = audienceRoles(auth);
        return audience.some(role => roles.includes(role));
    }
    return false;
}

const SQL_FALSE: SQL = sql`1 = 0`;

function audienceRoles(auth: AuthCtx): readonly string[] {
    const source = auth.roles && auth.roles.length > 0 ? auth.roles : claimRoles(auth.role);
    return [...new Set(source)].sort();
}

function claimRoles(value: unknown): readonly string[] {
    if (typeof value !== "string") return [];
    return [
        ...new Set(
            value
                .split(",")
                .map(role => role.trim())
                .filter(Boolean)
        ),
    ].sort();
}
