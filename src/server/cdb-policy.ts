/**
 * Compile a `cdbTable` config to the existing `PolicyDefinition[]`
 * surface (`policy.ts`). The framework's row-level pipeline
 * (`applyPoliciesToWhere`, `applyRowPolicies`, `policyDigest`) is
 * unchanged; this module is the bridge between schema-first authoring
 * and the runtime closure surface.
 *
 * Mapping rules (one cdbTable → ≤6 policies):
 *
 *   - tenant predicate (org or user) → `<table>_tenant` policy on
 *     `for: "all"` audience `authenticated`. Combinator with the rest is
 *     OR within the policy pipeline; this is the universal floor.
 *   - publicRead → `<table>_public_read` on `for: "select"` to `*`.
 *   - per-role ROW gate per verb (read/create/update/delete) →
 *     `<table>_role_<role>` policies. SQL form returns `undefined` when
 *     caller has the role (no extra filter) and `1=0` when not (zero
 *     rows). Mirrors the old `requireRole` helper exactly so the
 *     policyDigest is stable across the migration.
 *   - `self` role → `<table>_self_<verb>` policies bound to the
 *     `selfBy` column (`row[selfBy] === ctx.auth.userId`).
 *
 * All policies use `chardbPolicy(...)` so they inherit the existing
 * frozen-object discipline, name conventions, and digest hashing.
 *
 * Cache invalidation: `authDependsOn` defaults to better-auth's tenant-
 * keyed model set for org-tenanted tables and the principal-keyed set
 * for user-tenanted ones. Mirrors the old `TENANT_EPOCH_TABLES` /
 * `PRINCIPAL_EPOCH_TABLES` constants verbatim so cached subscriptions
 * invalidate the same way pre/post migration.
 */

import { eq, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AuthCtx } from "./define.ts";
import { chardbPolicy, type PolicyDefinition } from "./policy.ts";
import {
    type CdbTableMeta,
    type ColVerb,
    COL_VERBS,
    type Verb,
} from "./cdb-table-types.ts";
import { resolveCdbMeta } from "./cdb-table.ts";

/**
 * The four better-auth tables whose writes bump the tenant epoch.
 * Mirrors `TENANT_KEYED_MODELS` in `chardb/auth/adapter.ts`.
 */
export const TENANT_EPOCH_TABLES: readonly string[] = Object.freeze([
    "organization",
    "member",
    "invitation",
    "team",
    "teamMember",
    "organizationRole",
]);

/**
 * Tables whose writes bump the principal epoch (per-user invalidation).
 * Mirrors `PRINCIPAL_KEYED_MODELS` in `chardb/auth/adapter.ts`.
 */
export const PRINCIPAL_EPOCH_TABLES: readonly string[] = Object.freeze([
    "user",
    "session",
    "account",
    "verification",
    "passkey",
    "twoFactor",
    "ssoProvider",
    "apiKey",
]);

const SQL_FALSE: SQL = eq("1" as never, "0");

function epochTablesFor(meta: CdbTableMeta): readonly string[] {
    return meta.tenantKind === "org" ? TENANT_EPOCH_TABLES : PRINCIPAL_EPOCH_TABLES;
}

function tenantValueFromAuth(meta: CdbTableMeta, auth: AuthCtx): string | undefined {
    if (meta.tenantKind === "org") return auth.tenantId;
    if (meta.tenantKind === "user") return auth.userId;
    return undefined;
}

function sqlEqColumn(table: SQLiteTable, column: string, value: string | undefined): SQL | undefined {
    if (value === undefined) return undefined;
    const col = (table as unknown as Record<string, unknown>)[column];
    if (!col) return undefined;
    return eq(col as never, value);
}

/**
 * Compile every row-level policy for a single cdbTable. Returns the
 * frozen `PolicyDefinition[]` that drops directly into
 * `applyPoliciesToWhere` / `applyRowPolicies` / `policyDigest`.
 */
export function compileCdbPolicies(table: SQLiteTable): readonly PolicyDefinition<SQLiteTable, unknown>[] {
    const meta = resolveCdbMeta(table);
    const policies: PolicyDefinition<SQLiteTable, unknown>[] = [];
    const epochTables = epochTablesFor(meta);

    // 1) Tenant predicate (always present for org/user tables).
    if (meta.tenantKind !== "none" && meta.tenantBy) {
        const col = meta.tenantBy;
        policies.push(
            chardbPolicy<SQLiteTable, Record<string, unknown>>(`${meta.name}_tenant`, {
                for: "all",
                to: "authenticated",
                using: (auth, row) => {
                    const expected = tenantValueFromAuth(meta, auth);
                    if (expected === undefined) return false;
                    return row[col] === expected;
                },
                usingSql: (auth, t) => sqlEqColumn(t, col, tenantValueFromAuth(meta, auth)),
                authDependsOn: epochTables,
            }) as PolicyDefinition<SQLiteTable, unknown>
        );
    }

    // 2) publicRead — anonymous SELECT.
    if (meta.publicRead) {
        policies.push(
            chardbPolicy<SQLiteTable, unknown>(`${meta.name}_public_read`, {
                for: "select",
                to: "*",
                using: () => true,
                usingSql: () => undefined,
            }) as PolicyDefinition<SQLiteTable, unknown>
        );
    }

    // 3) Per-role row gates (one policy per role × verb that grants the verb).
    for (const [role, raw] of Object.entries(meta.rawRoles)) {
        if (role === "self") continue;
        for (const verb of ["read", "create", "update", "delete"] as readonly Verb[]) {
            if (!roleGrantsRowVerb(raw, verb)) continue;
            const policyName = `${meta.name}_role_${role}_${verb}`;
            const opFor = verbToPolicyOp(verb);
            policies.push(
                chardbPolicy<SQLiteTable, unknown>(policyName, {
                    for: opFor,
                    to: "authenticated",
                    using: auth => callerHasRole(auth, role),
                    usingSql: auth => (callerHasRole(auth, role) ? undefined : SQL_FALSE),
                    authDependsOn: epochTables,
                }) as PolicyDefinition<SQLiteTable, unknown>
            );
        }
    }

    // 4) `self` row gate per verb. Bound to the `selfBy` column for org-
    //    tenanted tables; on user-tenanted tables, the tenant predicate
    //    already enforces self-equality so we omit a second policy unless
    //    the user explicitly listed `self` (in which case it widens the
    //    column matrix without altering the row predicate).
    const selfRoles = meta.rawRoles["self"];
    if (selfRoles && meta.tenantKind === "org" && meta.selfBy) {
        const selfBy = meta.selfBy;
        for (const verb of ["read", "create", "update", "delete"] as readonly Verb[]) {
            if (!roleGrantsRowVerb(selfRoles, verb)) continue;
            const policyName = `${meta.name}_self_${verb}`;
            const opFor = verbToPolicyOp(verb);
            policies.push(
                chardbPolicy<SQLiteTable, Record<string, unknown>>(policyName, {
                    for: opFor,
                    to: "authenticated",
                    using: (auth, row) => row[selfBy] === auth.userId,
                    usingSql: (auth, t) => sqlEqColumn(t, selfBy, auth.userId),
                    authDependsOn: PRINCIPAL_EPOCH_TABLES,
                }) as PolicyDefinition<SQLiteTable, unknown>
            );
        }
    }

    return Object.freeze(policies);
}

function verbToPolicyOp(verb: Verb): PolicyDefinition<unknown, unknown>["for"] {
    switch (verb) {
        case "read":
            return "select";
        case "create":
            return "insert";
        case "update":
            return "update";
        case "delete":
            return "delete";
    }
}

function roleGrantsRowVerb(raw: unknown, verb: Verb): boolean {
    if (raw === "*" || raw === true) return true;
    if (raw === false || raw === undefined) return false;
    if (Array.isArray(raw)) return (raw as readonly Verb[]).includes(verb);
    if (typeof raw === "object" && raw !== null) {
        const v = (raw as { readonly [V in Verb]?: unknown })[verb];
        if (v === undefined || v === false) return false;
        if (v === true || v === "*") return true;
        if (Array.isArray(v)) return true; // any column listed is enough at row level
        if (typeof v === "object" && v !== null && "exclude" in v) return true;
    }
    return false;
}

function callerHasRole(auth: AuthCtx, role: string): boolean {
    const roles = splitCallerRoles(auth);
    if (role.startsWith("user:")) {
        // user:-prefixed names match against `user.role` regardless of
        // tenancy. The chardb runtime is responsible for surfacing the
        // user-level role in `auth.claims` (since `auth.role` is the
        // member.role for the active org); we look there as a fallback.
        const target = role.slice("user:".length);
        if (roles.includes(target)) return true;
        const userRole = (auth.claims as { readonly userRole?: unknown }).userRole;
        if (typeof userRole === "string") {
            return userRole.split(",").map(s => s.trim()).includes(target);
        }
        return false;
    }
    return roles.includes(role);
}

function splitCallerRoles(auth: AuthCtx): readonly string[] {
    if (auth.roles && auth.roles.length > 0) return auth.roles;
    if (auth.role) return auth.role.split(",").map(s => s.trim()).filter(Boolean);
    return [];
}

/** Used by the column-mask helper. */
export function isColumnAllowed(meta: CdbTableMeta, role: string, verb: ColVerb, colName: string): boolean {
    const byVerb = meta.matrix.allowed.get(role);
    if (!byVerb) return false;
    const cols = byVerb.get(verb);
    if (cols === undefined) return false;
    if (cols === null) return true;
    return cols.has(colName);
}

/**
 * Compute the columns the caller is allowed to touch for `verb` based
 * on their role(s) ALONE — `self` is intentionally excluded since it
 * gates row-by-row (whether the row IS the caller). The column-mask
 * helper unions self's grant in for matching rows; the writability
 * check unions it in iff the incoming values prove the row belongs to
 * the caller.
 */
export function callerColumns(meta: CdbTableMeta, auth: AuthCtx, verb: ColVerb): ReadonlySet<string> {
    const allowed = new Set<string>();
    const callerRoles = splitCallerRoles(auth);
    for (const role of callerRoles) {
        const byVerb = meta.matrix.allowed.get(role);
        if (!byVerb) continue;
        const cols = byVerb.get(verb);
        if (cols === undefined) continue;
        if (cols === null) {
            for (const c of meta.matrix.allColumns) allowed.add(c);
            return allowed;
        }
        for (const c of cols) allowed.add(c);
    }
    return allowed;
}

/**
 * The columns `self` grants for `verb`, or `null` if self has full
 * verb authority (`"*"`). Used by row-time consumers (column mask /
 * writability) to fold self in when the row IS the caller.
 */
export function selfColumns(meta: CdbTableMeta, verb: ColVerb): ReadonlySet<string> | null {
    const byVerb = meta.matrix.allowed.get("self");
    if (!byVerb) return new Set();
    const cols = byVerb.get(verb);
    if (cols === undefined) return new Set();
    return cols;
}

/** Re-exported for the column-mask + writability helpers. */
export { COL_VERBS };
