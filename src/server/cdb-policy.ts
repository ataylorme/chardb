/**
 * Compile a `cdbTable` config to the existing `PolicyDefinition[]`
 * surface (`policy.ts`). This module bridges schema-first authoring to the
 * runtime closure checks and registered-query policy identity.
 *
 * Mapping rules (one cdbTable → ≤6 policies):
 *
 *   - tenant predicate (org or user) → `<table>_tenant` policy on
 *     `for: "all"` audience `authenticated`. It is marked as a mandatory
 *     floor and is AND-ed with the selected grant.
 *   - publicRead → `<table>_public_read` on `for: "select"` to `*`.
 *   - per-role ROW gate per verb (read/create/update/delete) →
 *     `<table>_role_<role>` grant policies. Alternative role grants are
 *     OR-ed; a matching role contributes `1=1` and a non-match `1=0`.
 *   - `self` role → `<table>_self_<verb>` policies bound to the
 *     `selfBy` column (`row[selfBy] === ctx.auth.userId`).
 *
 * All policies use `chardbPolicy(...)` so they inherit the existing
 * frozen-object discipline, name conventions, and digest hashing.
 *
 * `authDependsOn` defaults to Better Auth's tenant-keyed model set for org
 * tables and the principal-keyed set for user tables.
 */

import { type SQL, eq, getTableColumns, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import { stableHashHex } from "../util/canonical.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import { COL_VERBS, type CdbTableMeta, type ColVerb, type Verb } from "./cdb-table-types.ts";
import { resolveCdbMeta } from "./cdb-table.ts";
import type { AuthCtx } from "./define.ts";
import { type PolicyDefinition, chardbPolicy } from "./policy.ts";

/**
 * The four better-auth tables whose writes bump the tenant epoch.
 * Mirrors `TENANT_KEYED_MODELS` in `src/auth/adapter.ts`.
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
 * Mirrors `PRINCIPAL_KEYED_MODELS` in `src/auth/adapter.ts`.
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

const SQL_FALSE: SQL = sql`1 = 0`;
const SQL_TRUE: SQL = sql`1 = 1`;

// Worker and Durable Object runtime schemas are stable after module
// initialization. Registered refs also declare a stable table set, so avoid
// rebuilding and hashing the same policy identity on every query refresh.
// The outer WeakMap lets an isolate release entries with its schema object.
const POLICY_DIGEST_CACHE = new WeakMap<Record<string, unknown>, Map<string, string>>();

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
    const columns = getTableColumns(table) as Record<string, { readonly name: string }>;
    const col = columns[column] ?? Object.values(columns).find(candidate => candidate.name === column);
    if (!col) return undefined;
    return eq(col as never, value);
}

/**
 * Compile every row-level policy for a single cdbTable. Returns the
 * frozen `PolicyDefinition[]` consumed by the row policy wrappers and static
 * policy identity builder.
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
                effect: "floor",
                using: (auth, row) => {
                    const expected = tenantValueFromAuth(meta, auth);
                    if (expected === undefined) return false;
                    return row[col] === expected;
                },
                usingSql: (auth, t) => sqlEqColumn(t, col, tenantValueFromAuth(meta, auth)) ?? SQL_FALSE,
                authDependsOn: epochTables,
            }) as PolicyDefinition<SQLiteTable, unknown>
        );
    }

    // 2) publicRead — public SELECT.
    if (meta.publicRead) {
        policies.push(
            chardbPolicy<SQLiteTable, unknown>(`${meta.name}_public_read`, {
                for: "select",
                to: "*",
                effect: "grant",
                using: () => true,
                usingSql: () => SQL_TRUE,
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
                    effect: "grant",
                    using: auth => callerHasRole(meta, auth, role),
                    usingSql: auth => (callerHasRole(meta, auth, role) ? SQL_TRUE : SQL_FALSE),
                    authDependsOn: epochTables,
                }) as PolicyDefinition<SQLiteTable, unknown>
            );
        }
    }

    // 4) `self` row gate per verb. Organization tables bind it to `selfBy`.
    //    User tables use a constant grant because the mandatory tenant floor
    //    already restricts every surviving row to auth.userId.
    const selfRoles = meta.rawRoles.self;
    if (selfRoles && ((meta.tenantKind === "org" && meta.selfBy) || meta.tenantKind === "user")) {
        const selfBy = meta.selfBy;
        for (const verb of ["read", "create", "update", "delete"] as readonly Verb[]) {
            if (!roleGrantsRowVerb(selfRoles, verb)) continue;
            const policyName = `${meta.name}_self_${verb}`;
            const opFor = verbToPolicyOp(verb);
            policies.push(
                chardbPolicy<SQLiteTable, Record<string, unknown>>(policyName, {
                    for: opFor,
                    to: "authenticated",
                    effect: "grant",
                    using: (auth, row) =>
                        meta.tenantKind === "user" || (selfBy !== undefined && row[selfBy] === auth.userId),
                    usingSql: (auth, t) =>
                        meta.tenantKind === "user"
                            ? SQL_TRUE
                            : selfBy === undefined
                              ? SQL_FALSE
                              : sqlEqColumn(t, selfBy, auth.userId),
                    authDependsOn: PRINCIPAL_EPOCH_TABLES,
                }) as PolicyDefinition<SQLiteTable, unknown>
            );
        }
    }

    return Object.freeze(policies);
}

/**
 * Hash the row and column policy semantics for the exact cdbTables declared by
 * one query intent. Function source is excluded because cdbTable policies are
 * compiled from this metadata and closure text is not stable across builds.
 */
export function cdbPolicyDigest(schema: Record<string, unknown>, tableNames: readonly string[]): string {
    const names = [...new Set(tableNames)].sort();
    const cacheKey = JSON.stringify(names);
    const schemaCache = POLICY_DIGEST_CACHE.get(schema);
    const cached = schemaCache?.get(cacheKey);
    if (cached !== undefined) return cached;

    const tablesByName = new Map<string, SQLiteTable>();
    for (const entry of collectCdbTables(schema)) {
        const name = resolveCdbMeta(entry.table).name;
        if (tablesByName.has(name)) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: `schema contains more than one cdbTable named ${name}`,
            });
        }
        tablesByName.set(name, entry.table);
    }

    const tables = names.map(name => {
        const table = tablesByName.get(name);
        if (!table) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: `query intent references unknown cdbTable ${name}`,
            });
        }
        const meta = resolveCdbMeta(table);
        const matrix = [...meta.matrix.allowed.entries()]
            .sort(([left], [right]) => compareCanonicalName(left, right))
            .map(([role, verbs]) => ({
                role,
                verbs: COL_VERBS.map(verb => {
                    const columns = verbs.get(verb);
                    return {
                        verb,
                        columns: columns === null ? "*" : columns === undefined ? [] : [...columns].sort(),
                    };
                }),
            }));
        const policies = compileCdbPolicies(table)
            .map(policy => ({
                name: policy.name,
                for: policy.for,
                to: Array.isArray(policy.to) ? [...policy.to].sort() : policy.to,
                effect: policy.effect ?? "grant",
                authDependsOn: policy.authDependsOn ? [...policy.authDependsOn].sort() : [],
            }))
            .sort((left, right) => compareCanonicalName(left.name, right.name));
        return {
            name,
            tenantKind: meta.tenantKind,
            tenantBy: meta.tenantBy ?? null,
            selfBy: meta.selfBy ?? null,
            publicRead: meta.publicRead,
            allColumns: [...meta.matrix.allColumns].sort(),
            matrix,
            policies,
        };
    });
    const digest = stableHashHex({ version: 2, tables });
    const digests = schemaCache ?? new Map<string, string>();
    digests.set(cacheKey, digest);
    if (!schemaCache) POLICY_DIGEST_CACHE.set(schema, digests);
    return digest;
}

function compareCanonicalName(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
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

function callerHasRole(meta: CdbTableMeta, auth: AuthCtx, role: string): boolean {
    return callerPolicyRoles(meta, auth).includes(role);
}

function splitCallerRoles(auth: AuthCtx): readonly string[] {
    if (auth.roles && auth.roles.length > 0) return auth.roles;
    if (auth.role)
        return auth.role
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
    return [];
}

function splitUserRoles(auth: AuthCtx): readonly string[] {
    const userRole = (auth.claims as { readonly userRole?: unknown }).userRole;
    if (typeof userRole !== "string") return [];
    return userRole
        .split(",")
        .map(role => role.trim())
        .filter(Boolean);
}

/**
 * Resolve the policy role names this caller may use.
 *
 * Organization tables treat auth.role/auth.roles as member roles. Only
 * claims.userRole can enter the reserved user: namespace. User and global
 * tables use auth.role/auth.roles as their user-role lattice, so those roles
 * also receive user: aliases. A role value that already starts with user:
 * never crosses the namespace boundary.
 */
export function callerPolicyRoles(meta: CdbTableMeta, auth: AuthCtx): readonly string[] {
    const latticeRoles = splitCallerRoles(auth).filter(role => !role.startsWith("user:"));
    const roles = new Set(latticeRoles);
    const userRoles = new Set(splitUserRoles(auth));
    if (meta.tenantKind !== "org") {
        for (const role of latticeRoles) userRoles.add(role);
    }
    for (const role of userRoles) roles.add(`user:${role}`);
    return [...roles];
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
    const callerRoles = callerPolicyRoles(meta, auth);
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

/**
 * Couple an update's column grants to its row predicate. Tenant-wide caller
 * roles may combine their column grants. If any updated column needs `self`,
 * the whole update receives the self row predicate so another user's row
 * cannot inherit that column permission from a broader role grant.
 */
export function policiesForColumnUpdate(args: {
    readonly table: SQLiteTable;
    readonly auth: AuthCtx;
    readonly columns: readonly string[];
    readonly policies: readonly PolicyDefinition<SQLiteTable, unknown>[];
}): readonly PolicyDefinition<SQLiteTable, unknown>[] {
    const meta = resolveCdbMeta(args.table);
    const roleGrantNames = new Set<string>();
    const roleColumns = new Set<string>();
    for (const role of callerPolicyRoles(meta, args.auth)) {
        if (!Object.prototype.hasOwnProperty.call(meta.rawRoles, role)) continue;
        const granted = args.columns.filter(column => isColumnAllowed(meta, role, "update", column));
        if (granted.length === 0 && args.columns.length > 0) continue;
        for (const column of granted) roleColumns.add(column);
        roleGrantNames.add(`${meta.name}_role_${role}_update`);
    }
    const requiresSelf = args.columns.some(column => !roleColumns.has(column));
    const permittedGrantNames = requiresSelf ? new Set([`${meta.name}_self_update`]) : roleGrantNames;
    return Object.freeze(
        args.policies.filter(policy => policy.effect === "floor" || permittedGrantNames.has(policy.name))
    );
}

/** Re-exported for the column-mask + writability helpers. */
export { COL_VERBS };
