/**
 * `wrapDb(rawDb, auth)` — proxies a Drizzle SQLiteDatabase so any
 * `db.insert(table).values(row)` call against a `cdbTable` instance
 * binds the table's tenant / self columns to verified `auth` values.
 * Updates reject managed authority columns and enforce the caller's column
 * grants. Updates and deletes combine the caller's WHERE with the server row
 * policy.
 *
 * This is the runtime half of chardb's INSERT auto-fill. The type-
 * level half lives in `cdb-table.ts`: every column chardb knows about
 * at construction time (`selfBy:`, `tenantBy:`, the conventional
 * `organizationId` / `userId`) gets a synthetic `$defaultFn`, which
 * Drizzle reflects into `$inferInsert` as an optional field — so the
 * caller can simply omit it.
 *
 * Inserts, updates, and deletes against raw Drizzle tables pass through unchanged.
 * The proxy is intentionally a thin wrapper over the raw
 * `db` value the user's mutation context ships with: it does not
 * synthesize new query semantics, only intercepts `.values(...)` to fill
 * omitted identity columns and reject explicit values that disagree with the
 * verified context.
 *
 * Auto-fill rules:
 *
 *   - Explicit `selfBy: "x"` column → filled with `auth.userId`.
 *   - Explicit `tenantBy: "x"` column → filled with `auth.tenantId`
 *     (when `tenantKind` is `"org"`) or `auth.userId` (when
 *     `tenantKind` is `"user"`).
 *   - Auto-discovered tenant column (FK chain to `auth.organization` /
 *     `auth.user`) → same fill rule, resolved via `resolveCdbMeta`.
 *
 * Tenant-scoped inserts fail closed with `CDB_FORBIDDEN` when their required
 * org/user authority is absent, even if the row supplies an identity value.
 * A `selfBy` table likewise requires a verified user identity.
 * After identity binding, inserts must satisfy one schema-declared create
 * grant and the caller may supply only columns granted by that role/self row.
 */

import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import { applyColumnMask, assertColumnsWritable } from "./cdb-cls.ts";
import { compileCdbPolicies } from "./cdb-policy.ts";
import { getCdbMeta } from "./cdb-table-registry.ts";
import type { CdbTableMeta } from "./cdb-table-types.ts";
import { resolveCdbMeta } from "./cdb-table.ts";
import type { AuthCtx } from "./define.ts";
import { applyPoliciesToWhere, applyRowPolicies } from "./policy.ts";

/**
 * Cache of (sqlColumnName → jsColumnKey) for each cdbTable. The map is
 * derived from `getTableColumns(table)` once and reused; tables are
 * referentially stable so a `WeakMap` keyed by table is the natural fit
 * (no manual eviction, no leak when the schema is rebuilt in tests).
 */
const SQL_TO_JS_CACHE = new WeakMap<SQLiteTable, ReadonlyMap<string, string>>();

function sqlToJsMap(table: SQLiteTable): ReadonlyMap<string, string> {
    const cached = SQL_TO_JS_CACHE.get(table);
    if (cached) return cached;
    const cols = getTableColumns(table) as Record<string, { readonly name: string }>;
    const map = new Map<string, string>();
    for (const jsKey of Object.keys(cols)) {
        const sqlName = cols[jsKey]?.name ?? jsKey;
        map.set(sqlName, jsKey);
    }
    const frozen: ReadonlyMap<string, string> = map;
    SQL_TO_JS_CACHE.set(table, frozen);
    return frozen;
}

/**
 * Plan for a single cdbTable: which JS-keyed fields to fill, and what
 * value to use. Resolved once per (table, auth) pair. Passing `auth`
 * through here keeps the proxy stateless w.r.t. the request — every
 * `db.insert(...)` call recomputes the plan against the current
 * mutation's auth context.
 */
interface AutoFillPlan {
    readonly table: SQLiteTable;
    readonly auth: AuthCtx;
    readonly policies: ReturnType<typeof compileCdbPolicies>;
    readonly bindings: ReadonlyArray<{
        readonly jsKey: string;
        readonly value: string;
        readonly authority: "tenant" | "self";
    }>;
}

type PolicyPlan = Pick<AutoFillPlan, "table" | "auth" | "policies">;

interface SelectRootPlan {
    readonly auth: AuthCtx;
    readonly fullRow: boolean;
    readonly queryBoundary: boolean;
}

const UNSUPPORTED_SELECT_METHODS = new Set<PropertyKey>([
    "leftJoin",
    "rightJoin",
    "innerJoin",
    "fullJoin",
    "crossJoin",
    "having",
    "groupBy",
    "union",
    "unionAll",
    "intersect",
    "intersectAll",
    "except",
    "exceptAll",
    "values",
    "run",
    "prepare",
    "_prepare",
    "as",
    "getSelectedFields",
    "$dynamic",
    "$withCache",
]);

const SAFE_SELECT_CHAIN_METHODS = new Set<PropertyKey>(["orderBy", "limit", "offset"]);

function buildPlan(
    table: SQLiteTable,
    meta: CdbTableMeta,
    auth: AuthCtx,
    operation: "insert" | "update" | "delete" = "insert"
): AutoFillPlan {
    const bindings: Array<{ jsKey: string; value: string; authority: "tenant" | "self" }> = [];
    const sqlToJs = sqlToJsMap(table);

    // selfBy → verified user id. Caller-supplied ownership is never authority.
    if (meta.selfBy) {
        if (!auth.userId) throw missingAuthority("self", operation);
        const jsKey = sqlToJs.get(meta.selfBy);
        if (jsKey !== undefined) bindings.push({ jsKey, value: auth.userId, authority: "self" });
    }

    // tenantBy: trust the resolved view (auto-discovered FK or explicit).
    // Skip the resolve call entirely when the file scope is `none` — we
    // know nothing to fill and `resolveCdbMeta` would still succeed but
    // do nothing useful.
    if (meta.tenantKind !== "none") {
        const value = meta.tenantKind === "org" ? auth.tenantId : auth.userId;
        if (!value) throw missingAuthority("tenant", operation);
        let tenantSqlCol: string | undefined = meta.tenantBy;
        if (!tenantSqlCol) {
            try {
                tenantSqlCol = resolveCdbMeta(table).tenantBy;
            } catch {
                // FK auto-discovery throws when the schema is mid-build
                // (a test injects a cdbTable without an FK chain). Treat
                // that as "no fill possible" — the row either supplies
                // the value or Drizzle/SQLite errors at NOT NULL time.
                tenantSqlCol = undefined;
            }
        }
        if (tenantSqlCol) {
            const jsKey = sqlToJs.get(tenantSqlCol);
            if (jsKey !== undefined) bindings.push({ jsKey, value, authority: "tenant" });
        }
    }

    return { table, auth, policies: compileCdbPolicies(table), bindings };
}

function applyPlan<T extends Record<string, unknown>>(plan: AutoFillPlan, row: T): T {
    let next: Record<string, unknown> | null = null;
    for (const { jsKey, value, authority } of plan.bindings) {
        const present = Object.prototype.hasOwnProperty.call(row, jsKey) && row[jsKey] !== undefined;
        if (present) {
            if (row[jsKey] !== value) throw conflictingAuthority(authority, jsKey);
            continue;
        }
        if (next === null) next = { ...row };
        next[jsKey] = value;
    }
    const filled = (next ?? row) as T;
    assertCreateAuthorized(plan, filled);
    return filled;
}

/**
 * Wrap a Drizzle insert builder so its `.values(row | rows)` call
 * splices auto-fill columns onto each row before forwarding to the
 * real builder. Other builder methods (`returning`, `onConflictDoNothing`,
 * `prepare`, …) pass through; the auto-fill happens exactly once at
 * `.values()` time so chained methods downstream see a complete row.
 */
function wrapInsertBuilder(builder: unknown, plan: AutoFillPlan): unknown {
    return new Proxy(builder as object, {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (prop !== "values" || typeof v !== "function") return v;
            return (rows: unknown) => {
                const filled = Array.isArray(rows)
                    ? rows.map(r => applyPlan(plan, r as Record<string, unknown>))
                    : applyPlan(plan, rows as Record<string, unknown>);
                return (v as (input: unknown) => unknown).call(target, filled);
            };
        },
    });
}

function assertCreateAuthorized(plan: AutoFillPlan, row: Readonly<Record<string, unknown>>): void {
    const jsToSql = jsToSqlMap(plan.table);
    const policyRow = toSqlColumnNames(row, jsToSql);
    const authorized = applyRowPolicies({
        op: "insert",
        auth: plan.auth,
        rows: [policyRow],
        policies: plan.policies,
    });
    if (authorized.length === 0) {
        const meta = getCdbMeta(plan.table);
        throw new CdbError({
            code: "CDB_FORBIDDEN",
            message: `${meta?.name ?? "cdbTable"}: caller has no applicable create grant`,
        });
    }

    try {
        assertColumnsWritable({
            values: policyRow,
            table: plan.table,
            auth: plan.auth,
            verb: "create",
            autoFilled: new Set(plan.bindings.map(binding => jsToSql.get(binding.jsKey) ?? binding.jsKey)),
        });
    } catch (error) {
        rethrowForbiddenColumn(error);
    }
}

function buildWritePlan(
    table: SQLiteTable,
    meta: CdbTableMeta,
    auth: AuthCtx,
    operation: "update" | "delete"
): AutoFillPlan {
    const plan = buildPlan(table, meta, auth, operation);
    const authorityRow: Record<string, unknown> = {};
    const jsToSql = jsToSqlMap(table);
    for (const binding of plan.bindings) authorityRow[jsToSql.get(binding.jsKey) ?? binding.jsKey] = binding.value;
    const authorized = applyRowPolicies({
        op: operation,
        auth,
        rows: [authorityRow],
        policies: plan.policies,
    });
    if (authorized.length === 0) {
        throw new CdbError({
            code: "CDB_FORBIDDEN",
            message: `${meta.name}: caller has no applicable ${operation} grant`,
        });
    }
    return plan;
}

function assertUpdateAuthorized(plan: AutoFillPlan, values: Readonly<Record<string, unknown>>): void {
    for (const binding of plan.bindings) {
        if (Object.prototype.hasOwnProperty.call(values, binding.jsKey)) {
            throw new CdbError({
                code: "CDB_FORBIDDEN",
                message: `cannot update managed ${binding.authority} column "${binding.jsKey}"`,
            });
        }
    }

    const policyValues = toSqlColumnNames(values, jsToSqlMap(plan.table));
    const meta = getCdbMeta(plan.table);
    const valuesForCls = meta?.selfBy ? { ...policyValues, [meta.selfBy]: plan.auth.userId } : policyValues;
    try {
        assertColumnsWritable({
            values: valuesForCls,
            table: plan.table,
            auth: plan.auth,
            verb: "update",
        });
    } catch (error) {
        rethrowForbiddenColumn(error);
    }
}

function wrapUpdateBuilder(builder: unknown, plan: AutoFillPlan): unknown {
    return new Proxy(builder as object, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "set" || typeof value !== "function") return value;
            return (values: Readonly<Record<string, unknown>>) => {
                assertUpdateAuthorized(plan, values);
                const afterSet = (value as (input: unknown) => unknown).call(target, values);
                return scopePolicyBuilder(afterSet, plan, "update");
            };
        },
    });
}

function wrapSelectFromBuilder(builder: unknown, root: SelectRootPlan): unknown {
    return new Proxy(builder as object, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "from" || typeof value !== "function") return value;
            return (table: SQLiteTable) => {
                const meta = getCdbMeta(table);
                if (!meta) {
                    if (root.queryBoundary) throw unsupportedSelect("query handlers may select only from cdbTable");
                    return (value as (table: SQLiteTable) => unknown).call(target, table);
                }
                if (!root.fullRow) {
                    throw unsupportedSelect("cdbTable projections are unavailable until projected masks are compiled");
                }
                const selected = (value as (table: SQLiteTable) => unknown).call(target, table);
                return scopeSelectBuilder(selected, {
                    table,
                    auth: root.auth,
                    policies: compileCdbPolicies(table),
                });
            };
        },
    });
}

function scopeSelectBuilder(builder: unknown, plan: PolicyPlan): unknown {
    const where = Reflect.get(builder as object, "where");
    if (typeof where !== "function") throw unsupportedSelect("select builder does not expose a WHERE stage");
    const scoped = where.call(
        builder,
        applyPoliciesToWhere({
            op: "select",
            auth: plan.auth,
            table: plan.table,
            policies: plan.policies,
        })
    );
    return wrapScopedSelectBuilder(scoped, plan);
}

function wrapScopedSelectBuilder(builder: unknown, plan: PolicyPlan): unknown {
    const proxy = new Proxy(builder as object, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop === "where" && typeof value === "function") {
                return (userWhere: import("drizzle-orm").SQL) => {
                    const combined = applyPoliciesToWhere({
                        op: "select",
                        auth: plan.auth,
                        table: plan.table,
                        userWhere,
                        policies: plan.policies,
                    });
                    return wrapScopedSelectBuilder((value as (where: unknown) => unknown).call(target, combined), plan);
                };
            }
            if (UNSUPPORTED_SELECT_METHODS.has(prop)) {
                return (..._args: readonly unknown[]) => {
                    throw unsupportedSelect(`select method "${String(prop)}" cannot be masked safely`);
                };
            }
            if (SAFE_SELECT_CHAIN_METHODS.has(prop) && typeof value === "function") {
                return (...args: readonly unknown[]) =>
                    wrapScopedSelectBuilder(
                        (value as (...args: readonly unknown[]) => unknown).call(target, ...args),
                        plan
                    );
            }
            if ((prop === "all" || prop === "execute") && typeof value === "function") {
                return (...args: readonly unknown[]) =>
                    mapMaybePromise((value as (...args: readonly unknown[]) => unknown).call(target, ...args), rows =>
                        maskSelectRows(plan, rows)
                    );
            }
            if (prop === "get" && typeof value === "function") {
                return (...args: readonly unknown[]) =>
                    mapMaybePromise((value as (...args: readonly unknown[]) => unknown).call(target, ...args), row =>
                        maskSelectGet(plan, row)
                    );
            }
            if (prop === "then" && typeof value === "function") {
                return (onFulfilled?: (rows: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
                    (value as (...args: readonly unknown[]) => unknown).call(
                        target,
                        (rows: unknown) => {
                            const masked = maskSelectRows(plan, rows);
                            return onFulfilled ? onFulfilled(masked) : masked;
                        },
                        onRejected
                    );
            }
            if (prop === "catch" && typeof value === "function") {
                return (onRejected?: (error: unknown) => unknown) =>
                    (Reflect.get(target, "then") as (...args: readonly unknown[]) => unknown).call(
                        target,
                        (rows: unknown) => maskSelectRows(plan, rows),
                        onRejected
                    );
            }
            if (prop === "finally" && typeof value === "function") {
                return (onFinally?: () => void) => Promise.resolve(proxy as PromiseLike<unknown>).finally(onFinally);
            }
            if (prop === "toSQL" || prop === "getSQL" || prop === "getUsedTables") {
                return typeof value === "function" ? value.bind(target) : value;
            }
            if (typeof prop === "symbol") return value;
            throw unsupportedSelect(`select property "${String(prop)}" is unavailable on a masked query`);
        },
    });
    return proxy;
}

function mapMaybePromise<T>(value: unknown, map: (value: unknown) => T): T | Promise<T> {
    if (value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
        return Promise.resolve(value).then(map);
    }
    return map(value);
}

function maskSelectRows(plan: PolicyPlan, value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) throw unsupportedSelect("full-row select did not return an array");
    return value.map(row => maskSelectRow(plan, row));
}

function maskSelectGet(plan: PolicyPlan, value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    return maskSelectRow(plan, value);
}

function maskSelectRow(plan: PolicyPlan, value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw unsupportedSelect("full-row select returned a non-object row");
    }
    const row = value as Record<string, unknown>;
    const jsToSql = jsToSqlMap(plan.table);
    const masked = applyColumnMask({
        rows: [toSqlColumnNames(row, jsToSql)],
        table: plan.table,
        auth: plan.auth,
    })[0];
    if (!masked) throw unsupportedSelect("column mask did not return a row");
    const out: Record<string, unknown> = {};
    for (const [jsKey, sqlName] of jsToSql) out[jsKey] = masked[sqlName];
    return out;
}

function unsupportedSelect(message: string): CdbError {
    return new CdbError({ code: "CDB_UNSUPPORTED_FEATURE", message });
}

function scopePolicyBuilder(builder: unknown, plan: AutoFillPlan, operation: "update" | "delete"): unknown {
    const where = Reflect.get(builder as object, "where");
    if (typeof where !== "function") return builder;
    const scoped = where.call(
        builder,
        applyPoliciesToWhere({
            op: operation,
            auth: plan.auth,
            table: plan.table,
            policies: plan.policies,
        })
    );
    return wrapScopedPolicyBuilder(scoped, plan, operation);
}

function wrapScopedPolicyBuilder(builder: unknown, plan: AutoFillPlan, operation: "update" | "delete"): unknown {
    return new Proxy(builder as object, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "where" || typeof value !== "function") return value;
            return (userWhere: import("drizzle-orm").SQL) => {
                const combined = applyPoliciesToWhere({
                    op: operation,
                    auth: plan.auth,
                    table: plan.table,
                    userWhere,
                    policies: plan.policies,
                });
                return wrapScopedPolicyBuilder(
                    (value as (where: unknown) => unknown).call(target, combined),
                    plan,
                    operation
                );
            };
        },
    });
}

function jsToSqlMap(table: SQLiteTable): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const [sqlName, jsKey] of sqlToJsMap(table)) out.set(jsKey, sqlName);
    return out;
}

function toSqlColumnNames(
    values: Readonly<Record<string, unknown>>,
    jsToSql: ReadonlyMap<string, string>
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [jsKey, value] of Object.entries(values)) out[jsToSql.get(jsKey) ?? jsKey] = value;
    return out;
}

function rethrowForbiddenColumn(error: unknown): never {
    if (error instanceof CdbError && error.code === "CDB_FORBIDDEN_COLUMN") {
        throw new CdbError({
            code: "CDB_FORBIDDEN",
            message: error.message,
            ...(error.hint !== undefined ? { hint: error.hint } : {}),
        });
    }
    throw error;
}

function missingAuthority(authority: "tenant" | "self", operation: "insert" | "update" | "delete"): CdbError {
    return new CdbError({
        code: "CDB_FORBIDDEN",
        message: `${authority} authority is required for this ${operation}`,
    });
}

function conflictingAuthority(authority: "tenant" | "self", column: string): CdbError {
    return new CdbError({
        code: "CDB_FORBIDDEN",
        message: `explicit ${authority} column "${column}" conflicts with verified auth`,
    });
}

/**
 * The exported wrapper. Drop-in replacement for the raw db value
 * mutation/query handlers receive — accepts any Drizzle SQLite db
 * (BaseSQLiteDatabase, transaction handle, etc.) and proxies through.
 *
 * Implementation note: a Proxy on the db forwards every property
 * (`.select`, `.transaction`, `.run`, …) by default; `insert`, `update`,
 * and `delete` are intercepted. The wrap is recursive on the
 * transaction callback so `db.transaction(tx => …)` hands the user a
 * wrapped `tx` too.
 */
export function wrapDb<TDb extends object>(db: TDb, auth: AuthCtx): TDb {
    return wrapDbInternal(db, auth, false);
}

export function wrapQueryDb<TDb extends object>(db: TDb, auth: AuthCtx): TDb {
    return wrapDbInternal(db, auth, true);
}

function wrapDbInternal<TDb extends object>(db: TDb, auth: AuthCtx, queryBoundary: boolean): TDb {
    return new Proxy(db, {
        get(target, prop, receiver) {
            if (prop === "query" || prop === "$count") {
                throw new CdbError({
                    code: "CDB_UNSUPPORTED_FEATURE",
                    message: `database property "${String(prop)}" bypasses cdbTable select policy enforcement`,
                });
            }
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== "function") return v;
            if (prop === "select" || prop === "selectDistinct") {
                return (...args: readonly unknown[]) => {
                    const builder = (v as (...args: readonly unknown[]) => unknown).call(target, ...args);
                    return wrapSelectFromBuilder(builder, {
                        auth,
                        fullRow: prop === "select" && args.length === 0,
                        queryBoundary,
                    });
                };
            }
            if (prop === "insert") {
                return (table: SQLiteTable) => {
                    const meta = getCdbMeta(table);
                    const plan = meta ? buildPlan(table, meta, auth) : null;
                    const builder = (v as (t: SQLiteTable) => unknown).call(target, table);
                    return plan ? wrapInsertBuilder(builder, plan) : builder;
                };
            }
            if (prop === "update") {
                return (table: SQLiteTable) => {
                    const meta = getCdbMeta(table);
                    const plan = meta ? buildWritePlan(table, meta, auth, "update") : null;
                    const builder = (v as (t: SQLiteTable) => unknown).call(target, table);
                    return plan ? wrapUpdateBuilder(builder, plan) : builder;
                };
            }
            if (prop === "delete") {
                return (table: SQLiteTable) => {
                    const meta = getCdbMeta(table);
                    const plan = meta ? buildWritePlan(table, meta, auth, "delete") : null;
                    const builder = (v as (t: SQLiteTable) => unknown).call(target, table);
                    return plan ? scopePolicyBuilder(builder, plan, "delete") : builder;
                };
            }
            if (prop === "transaction") {
                return (callback: (tx: TDb) => Promise<unknown>, ...rest: readonly unknown[]) => {
                    const wrapped = (tx: TDb) => callback(wrapDbInternal(tx, auth, queryBoundary));
                    return (v as (cb: (tx: TDb) => Promise<unknown>, ...r: readonly unknown[]) => unknown).call(
                        target,
                        wrapped,
                        ...rest
                    );
                };
            }
            return v.bind(target);
        },
    });
}
