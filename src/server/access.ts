/**
 * `chardb/server/access` — declarative row-level authorization sugar.
 *
 * Lifts better-auth's `createAccessControl` / `role.authorize` primitives
 * (https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/access/access.ts)
 * directly so chardb policies can reuse the *exact same* roles, statements,
 * and permission map the user already wrote for better-auth — there is no
 * parallel chardb authorization model to learn.
 *
 * The five primitives below compose to express every common rule pattern
 * (tenant isolation, ownership, role gate, permission gate, public read)
 * in 1-3 lines:
 *
 *   tenantScope        — "this row is visible to its org's session"
 *   ownerScope         — "this row is owned by the calling user"
 *   requireRole        — "the caller's `member.role` is in this set"
 *   requirePermission  — "the caller's role authorize()s this request"
 *   publicRead         — "anyone can read this table; writes still gated"
 *
 * Each returns a `PolicyDefinition` that drops straight into chardb's
 * existing policy pipeline (`applyPoliciesToWhere`, `applyRowPolicies`,
 * `policyDigest`) — no new wire format, no new runtime layer.
 *
 * Cache invalidation: every helper sets `authDependsOn` to the right
 * default — better-auth's tenant-keyed models for tenant/permission
 * scopes, principal-keyed models for owner scopes — so the user never
 * declares which tables bump which epoch.
 */

import type { SQL } from "drizzle-orm";
import { eq, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AuthCtx } from "./define.ts";
import { type PolicyDefinition, type PolicyOp, chardbPolicy } from "./policy.ts";

// Re-export better-auth's access DSL verbatim so users get the exact
// same types when they import from chardb. Drop-in compatible.
import { createAccessControl } from "better-auth/plugins/access";
import type { Role, Statements, Subset } from "better-auth/plugins/access";

export { createAccessControl, role } from "better-auth/plugins/access";
export type { AccessControl, Role, Statements, Subset } from "better-auth/plugins/access";

/**
 * Smart-default roles helper. The two-arg form matches the way
 * humans actually reason about RBAC: declare the resources × actions
 * the app cares about, then specify deltas from the conventional
 * `owner`/`admin`/`member` defaults that better-auth's `organization`
 * plugin already ships.
 *
 * Implicit defaults (override per-role to restrict or extend):
 *   - **`owner`**: every action on every declared resource (`ALL`).
 *     You'd never restrict the owner; you'd promote someone else.
 *   - **`admin`**: every action on every declared resource (`ALL`).
 *     Override to ban the destructive ones (e.g. `delete` on
 *     `channels`).
 *   - **`member`**: empty by default — members get **no** permissions
 *     on app-declared resources unless you opt them in. (Better-auth's
 *     built-in member role's read permissions on `member`/`invitation`
 *     are unaffected — those statements aren't this helper's domain.)
 *
 * Custom role names (`billing`, `viewer`, …) get no defaults; you
 * must list every permission explicitly.
 *
 * ```ts
 * export const chatRoles = defineRoles(
 *   {
 *     messages: ["create", "update", "delete"],
 *     channels: ["create", "rename", "delete"],
 *     members:  ["invite", "remove", "promote"],
 *   },
 *   {
 *     // owner: implicit ALL — no need to write it
 *     admin: { channels: ["create", "rename"], members: ["invite", "remove"] },
 *     member: { messages: ["create"] },
 *   },
 * );
 * ```
 *
 * The returned object is shape-compatible with better-auth's
 * `RolesMap` — the same value powers chardb's `requirePermission(...)`
 * AND better-auth's `hasPermission` endpoint check.
 */
type RolePermissionInput<S extends Statements> = Partial<{
    readonly [K in keyof S]: Subset<K, S>[K];
}>;

type DefaultRoles<S extends Statements> = {
    readonly owner: Role<S>;
    readonly admin: Role<S>;
    readonly member: Role<S>;
};

export function defineRoles<
    const S extends Statements,
    const R extends Record<string, RolePermissionInput<S>> = Record<string, never>,
>(resources: S, overrides?: R): DefaultRoles<S> & { readonly [K in keyof R]: Role<S> } {
    const ac = createAccessControl(resources);
    const allPermissions = Object.fromEntries(
        Object.entries(resources).map(([resource, actions]) => [resource, actions])
    ) as { [K in keyof S]: S[K] };
    const emptyPermissions = {} as RolePermissionInput<S>;
    const override = (overrides ?? {}) as Record<string, RolePermissionInput<S>>;

    const out: Record<string, Role<S>> = {
        owner: ac.newRole((override.owner ?? allPermissions) as never) as unknown as Role<S>,
        admin: ac.newRole((override.admin ?? allPermissions) as never) as unknown as Role<S>,
        member: ac.newRole((override.member ?? emptyPermissions) as never) as unknown as Role<S>,
    };
    for (const [roleName, perms] of Object.entries(override)) {
        if (roleName === "owner" || roleName === "admin" || roleName === "member") continue;
        out[roleName] = ac.newRole(perms as never) as unknown as Role<S>;
    }
    return out as DefaultRoles<S> & { readonly [K in keyof R]: Role<S> };
}

/**
 * The four tables better-auth's `organization` plugin's writes bump the
 * tenant epoch on. Used as the default `authDependsOn` for every
 * tenant- or role-scoped policy so a membership change invalidates
 * cached subscriptions automatically.
 */
const TENANT_EPOCH_TABLES: readonly string[] = Object.freeze([
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
const PRINCIPAL_EPOCH_TABLES: readonly string[] = Object.freeze([
    "user",
    "session",
    "account",
    "verification",
    "passkey",
    "twoFactor",
    "ssoProvider",
    "apiKey",
]);

export interface ScopeOptions {
    /** Override the audience selector — defaults to `"authenticated"`. */
    readonly to?: PolicyDefinition<never, never>["to"];
    /** Override the policy operation — defaults to `"all"`. */
    readonly for?: PolicyOp | "all";
    /**
     * Override the cache-invalidation table set. Defaults are
     * better-auth's tenant- or principal-keyed models depending on the
     * scope kind; pass `["myCustomTable"]` to add app-specific
     * dependencies.
     */
    readonly authDependsOn?: readonly string[];
    /**
     * Override the auto-generated policy name. Defaults to the Drizzle
     * table name (`messages` → `"messages_tenant"`, etc.); set this when
     * a table is gated by multiple policies of the same kind.
     */
    readonly name?: string;
}

type RowOf<T extends SQLiteTable> = T["$inferSelect"];

/**
 * Policy helpers accept either the Drizzle table directly or a
 * deferred thunk (`() => table`). Thunks are the same idiom Drizzle's
 * `.references(() => foreignTable.col)` uses; they let policy
 * declarations sit alongside mutations in `api.ts` without tripping
 * the api.ts ↔ schema.ts ESM cycle when the table value is in TDZ
 * during module initialization.
 */
export type TableOrThunk<T extends SQLiteTable> = T | (() => T);

function resolveTable<T extends SQLiteTable>(table: TableOrThunk<T>): () => T {
    return typeof table === "function" ? table : () => table;
}

/**
 * Wrap a `chardbPolicy(...)` return value with a lazy `name` getter.
 * `chardbPolicy` freezes the returned object, so we copy its
 * non-`name` fields onto a fresh descriptor map and define `name` as
 * a getter that resolves via `getTableName(table)` on first read.
 * Deferral is what makes `() => messages` thunks safe across the
 * api.ts ↔ schema.ts ESM cycle.
 */
function withLazyName<TTable, TRow>(
    policy: PolicyDefinition<TTable, TRow>,
    getName: () => string
): PolicyDefinition<TTable, TRow> {
    let cached: string | undefined;
    const resolveName = (): string => {
        if (cached === undefined) cached = getName();
        return cached;
    };
    const lazy: PolicyDefinition<TTable, TRow> = Object.defineProperties(Object.assign({}, policy, { name: "" }), {
        name: {
            get: resolveName,
            enumerable: true,
            configurable: false,
        },
    }) as PolicyDefinition<TTable, TRow>;
    return Object.freeze(lazy);
}

/**
 * **Tenant scope.** Every row of `table` must carry an `organizationId`
 * (or the column named in `options.column`) that equals the caller's
 * `auth.tenantId`. Emits both the SQL pre-filter
 * (`eq(table.organizationId, auth.tenantId)`) and the row-level safety
 * check, so the rule survives whether the query path push-down or the
 * post-materialization filter fires. `authDependsOn` defaults to every
 * better-auth tenant-keyed model.
 *
 * ```ts
 * export const orgIsolation = tenantScope(messages);
 * // — replaces 12 lines of manual `using` / `usingSql` ceremony.
 * ```
 *
 * Set `options.column` if your table FKs into the org via a non-default
 * column name (e.g. `tenant_id`, `workspaceId`).
 */
export function tenantScope<T extends SQLiteTable>(
    table: TableOrThunk<T>,
    options: ScopeOptions & { readonly column?: string } = {}
): PolicyDefinition<T, RowOf<T>> {
    const col = options.column ?? "organizationId";
    const getTable = resolveTable(table);
    const policy = chardbPolicy<T, RowOf<T>>("__pending__", {
        for: options.for ?? "select",
        to: options.to ?? "authenticated",
        using: (auth, row) => {
            const tenant = auth.tenantId;
            if (tenant === undefined) return false;
            return (row as Record<string, unknown>)[col] === tenant;
        },
        usingSql: (auth, tableArg) => sqlEqFromAuth(tableArg, col, auth.tenantId),
        authDependsOn: options.authDependsOn ?? TENANT_EPOCH_TABLES,
    });
    return withLazyName(policy, () => options.name ?? `${getTableName(getTable())}_tenant`);
}

/**
 * **Owner scope.** The row's `authorId` (or `options.column`) must equal
 * the caller's `auth.userId`. `authDependsOn` defaults to better-auth's
 * principal-keyed models.
 *
 * ```ts
 * export const authorOwns = ownerScope(messages, { for: "delete" });
 * ```
 */
export function ownerScope<T extends SQLiteTable>(
    table: TableOrThunk<T>,
    options: ScopeOptions & { readonly column?: string } = {}
): PolicyDefinition<T, RowOf<T>> {
    const col = options.column ?? "authorId";
    const getTable = resolveTable(table);
    const policy = chardbPolicy<T, RowOf<T>>("__pending__", {
        for: options.for ?? "all",
        to: options.to ?? "authenticated",
        using: (auth, row) => (row as Record<string, unknown>)[col] === auth.userId,
        usingSql: (auth, tableArg) => sqlEqFromAuth(tableArg, col, auth.userId),
        authDependsOn: options.authDependsOn ?? PRINCIPAL_EPOCH_TABLES,
    });
    return withLazyName(policy, () => options.name ?? `${getTableName(getTable())}_owner`);
}

/**
 * **Role gate.** The caller's `auth.role` (better-auth's
 * `member.role` for the active org) must intersect `roles`. Multi-role
 * memberships (`role: "admin,billing"`) are checked via the same
 * comma-split convention better-auth uses
 * (`plugins/organization/permission.ts::hasPermissionFn`).
 *
 * ```ts
 * export const adminWrites = requireRole(messages, ["admin", "owner"], {
 *   for: "update",
 * });
 * ```
 */
export function requireRole<T extends SQLiteTable>(
    table: TableOrThunk<T>,
    roles: string | readonly string[],
    options: ScopeOptions = {}
): PolicyDefinition<T, RowOf<T>> {
    const allowed = new Set(typeof roles === "string" ? [roles] : roles);
    const getTable = resolveTable(table);
    const policy = chardbPolicy<T, RowOf<T>>("__pending__", {
        for: options.for ?? "all",
        to: options.to ?? "authenticated",
        using: auth => callerHasAnyRole(auth, allowed),
        // SQL is the same predicate for every row, so we short-circuit:
        // - if the caller has the role, return undefined (no filter added)
        // - otherwise return `1=0` so the query yields zero rows.
        usingSql: auth => (callerHasAnyRole(auth, allowed) ? undefined : SQL_FALSE),
        authDependsOn: options.authDependsOn ?? TENANT_EPOCH_TABLES,
    });
    return withLazyName(policy, () => options.name ?? `${getTableName(getTable())}_role`);
}

/**
 * Minimal structural shape any better-auth `Role` satisfies — we only
 * need `authorize()` here. Typing this loosely keeps `requirePermission`
 * agnostic to whether the role came from `defaultRoles` (built-in) or
 * `ac.newRole(...)` (customised); the `success` flag is the contract.
 */
export interface AuthorizableRole {
    readonly authorize: (
        request: Record<string, readonly string[] | string[]>,
        connector?: "OR" | "AND"
    ) => { readonly success: boolean };
}

export interface RolesMap {
    readonly [roleName: string]: AuthorizableRole | undefined;
}

/**
 * **Permission gate.** Evaluates the caller's role(s) against a
 * better-auth `AccessControl` instance. The `request` shape is exactly
 * what better-auth's `role.authorize()` accepts (a `{ resource:
 * actions }` map, with optional `{ actions, connector }` per resource),
 * so users reuse the same statements/roles they already declared for
 * better-auth without re-modelling them in chardb.
 *
 * ```ts
 * import { defaultRoles } from "better-auth/plugins/organization/access";
 *
 * export const onlyAdminsDelete = requirePermission(messages, defaultRoles, {
 *   messages: ["delete"],
 * }, { for: "delete" });
 * ```
 *
 * The same `RolesMap` powers better-auth endpoint checks (via
 * `hasPermission`) and chardb live-query policies; there's no parallel
 * authorization model.
 */
export function requirePermission<T extends SQLiteTable>(
    table: TableOrThunk<T>,
    roles: RolesMap | (() => RolesMap),
    request: Record<string, readonly string[] | string[]>,
    options: ScopeOptions = {}
): PolicyDefinition<T, RowOf<T>> {
    const getTable = resolveTable(table);
    const resolveRoles: () => RolesMap = typeof roles === "function" ? roles : () => roles;
    const check = (auth: AuthCtx): boolean => {
        const callerRoles = splitRoles(auth);
        if (callerRoles.length === 0) return false;
        const map = resolveRoles();
        for (const r of callerRoles) {
            const role = map[r];
            if (!role) continue;
            if (role.authorize(request).success) return true;
        }
        return false;
    };
    const policy = chardbPolicy<T, RowOf<T>>("__pending__", {
        for: options.for ?? "all",
        to: options.to ?? "authenticated",
        using: auth => check(auth),
        usingSql: auth => (check(auth) ? undefined : SQL_FALSE),
        authDependsOn: options.authDependsOn ?? TENANT_EPOCH_TABLES,
    });
    return withLazyName(policy, () => options.name ?? `${getTableName(getTable())}_permission`);
}

/**
 * **Public read.** Anyone (including unauthenticated callers) can
 * select. Mutations are unaffected — combine with `ownerScope` or
 * `requireRole` to gate writes.
 *
 * ```ts
 * export const channelsPublic = publicRead(channels);
 * ```
 */
export function publicRead<T extends SQLiteTable>(
    table: TableOrThunk<T>,
    options: Pick<ScopeOptions, "name"> = {}
): PolicyDefinition<T, RowOf<T>> {
    const getTable = resolveTable(table);
    const policy = chardbPolicy<T, RowOf<T>>("__pending__", {
        for: "select",
        to: "*",
        using: () => true,
        usingSql: () => undefined,
    });
    return withLazyName(policy, () => options.name ?? `${getTableName(getTable())}_public_read`);
}

// --- internals ---------------------------------------------------------

// `eq(<column>, <falsy>)` so the optimiser folds the query to zero rows.
// `eq("1", "0")` produces `WHERE '1' = '0'` which every engine reduces
// statically. Cheaper than building a SQL false constant by hand and
// works in every Drizzle dialect.
const SQL_FALSE: SQL = eq(
    // Cast through `as never` — `eq` accepts a Drizzle column or a
    // literal; we want the literal form.
    "1" as never,
    "0"
);

function sqlEqFromAuth(table: unknown, column: string, value: string | undefined): SQL | undefined {
    if (value === undefined) return undefined;
    const col = (table as Record<string, unknown>)[column];
    if (!col) return undefined;
    return eq(col as never, value);
}

function splitRoles(auth: AuthCtx): readonly string[] {
    if (auth.roles && auth.roles.length > 0) return auth.roles;
    if (auth.role)
        return auth.role
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
    return [];
}

function callerHasAnyRole(auth: AuthCtx, allowed: ReadonlySet<string>): boolean {
    const callerRoles = splitRoles(auth);
    for (const r of callerRoles) {
        if (allowed.has(r)) return true;
    }
    return false;
}
