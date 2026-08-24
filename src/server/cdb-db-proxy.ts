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
 * Only registered `cdbTable` instances may cross the application wrapper.
 * Plain Drizzle tables and raw/session/client APIs fail closed so handlers
 * cannot bypass the schema-declared policy boundary.
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

import {
    Column,
    Name,
    Param,
    Placeholder,
    SQL,
    StringChunk,
    Table,
    getTableColumns,
    is,
    isSQLWrapper,
} from "drizzle-orm";
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
    readonly tableName: string;
    readonly auth: AuthCtx;
    readonly policies: ReturnType<typeof compileCdbPolicies>;
    readonly onWrite: ((tableName: string) => void) | undefined;
    readonly bindings: ReadonlyArray<{
        readonly jsKey: string;
        readonly value: string;
        readonly authority: "tenant" | "self";
    }>;
}

interface SelectPlan {
    readonly table: SQLiteTable;
    readonly auth: AuthCtx;
    readonly policies: ReturnType<typeof compileCdbPolicies>;
    readonly onRead: ((tableName: string) => void) | undefined;
    readonly queryBoundary: boolean;
}

interface SelectRootPlan {
    readonly auth: AuthCtx;
    readonly fullRow: boolean;
    readonly queryBoundary: boolean;
    readonly onRead: ((tableName: string) => void) | undefined;
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

const SAFE_DB_METHODS = new Set<PropertyKey>(["select", "selectDistinct", "insert", "update", "delete", "transaction"]);

const SAFE_WRITE_EXECUTION_METHODS = new Set<PropertyKey>(["run", "toSQL", "getSQL"]);
const TRACKED_SELECT_BUILDERS = new WeakSet<object>();
const SAFE_SQL_SYNTAX = /\b(?:and|or|not|exists|between|in|is|null|like|ilike|true|false|escape|asc|desc)\b/gi;
const SAFE_SQL_PUNCTUATION = /^[\d\s(),=<>!+*/%|&.~-]*$/;

function buildPlan(
    table: SQLiteTable,
    meta: CdbTableMeta,
    auth: AuthCtx,
    operation: "insert" | "update" | "delete" = "insert",
    onWrite?: (tableName: string) => void
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

    return { table, tableName: meta.name, auth, policies: compileCdbPolicies(table), onWrite, bindings };
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
 * Wrap a Drizzle insert builder so its `.values(row | rows)` call splices
 * auto-fill columns onto each row before forwarding to the real builder.
 * Insert-select and every other pre-values shape fail closed. After values,
 * only execution and inspection are exposed. Returning rows requires read
 * masking, and conflict methods can become cross-tenant existence oracles.
 */
function wrapInsertBuilder(builder: unknown, plan: AutoFillPlan): unknown {
    return new Proxy(builder as object, {
        get(target, prop, receiver) {
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
            if (prop !== "values") throw unsupportedWrite("insert", prop);
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== "function") throw unsupportedWrite("insert", prop);
            return (rows: unknown) => {
                const filled = Array.isArray(rows)
                    ? rows.map(r => applyPlan(plan, r as Record<string, unknown>))
                    : applyPlan(plan, rows as Record<string, unknown>);
                return wrapInsertResult((v as (input: unknown) => unknown).call(target, filled), plan);
            };
        },
    });
}

function wrapInsertResult(builder: unknown, plan: AutoFillPlan): unknown {
    return new Proxy(builder as object, {
        get(target, prop, receiver) {
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
            if (SAFE_WRITE_EXECUTION_METHODS.has(prop))
                return writeExecutionMethod(target, prop, receiver, plan, "insert");
            throw unsupportedWrite("insert", prop);
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
    operation: "update" | "delete",
    onWrite?: (tableName: string) => void
): AutoFillPlan {
    const plan = buildPlan(table, meta, auth, operation, onWrite);
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
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
            if (prop !== "set") throw unsupportedWrite("update", prop);
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") throw unsupportedWrite("update", prop);
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
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
            if (prop !== "from")
                throw unsupportedSelect(`select property "${String(prop)}" is unavailable before FROM`);
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") throw unsupportedSelect("select builder does not expose a FROM stage");
            return (table: SQLiteTable) => {
                const meta = getCdbMeta(table);
                if (!meta) {
                    throw unsupportedSelect("application handlers may select only from cdbTable");
                }
                if (!root.fullRow) {
                    throw unsupportedSelect("cdbTable projections are unavailable until projected masks are compiled");
                }
                const selected = (value as (table: SQLiteTable) => unknown).call(target, table);
                // Observe at FROM construction, not execution. Drizzle can embed a
                // builder through exists(inner), in which case the inner proxy only
                // contributes SQL and never runs. This conservative point also means
                // an unused builder counts as a read.
                root.onRead?.(meta.name);
                const queryBoundary =
                    root.queryBoundary ||
                    (typeof selected === "object" && selected !== null && TRACKED_SELECT_BUILDERS.has(selected));
                return scopeSelectBuilder(selected, {
                    table,
                    auth: root.auth,
                    policies: compileCdbPolicies(table),
                    onRead: root.onRead,
                    queryBoundary,
                });
            };
        },
    });
}

function scopeSelectBuilder(builder: unknown, plan: SelectPlan): unknown {
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

function wrapScopedSelectBuilder(builder: unknown, plan: SelectPlan): unknown {
    const proxy = new Proxy(builder as object, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop === "where" && typeof value === "function") {
                return (userWhere: import("drizzle-orm").SQL) => {
                    if (plan.queryBoundary) assertTrackedSql(userWhere, plan.onRead);
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
                return (...args: readonly unknown[]) => {
                    if (plan.queryBoundary && prop === "orderBy") {
                        for (const arg of args) {
                            if (typeof arg === "function") {
                                throw unsupportedSelect("live query orderBy callbacks are unavailable");
                            }
                            assertTrackedSql(arg, plan.onRead);
                        }
                    }
                    return wrapScopedSelectBuilder(
                        (value as (...args: readonly unknown[]) => unknown).call(target, ...args),
                        plan
                    );
                };
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
    TRACKED_SELECT_BUILDERS.add(proxy);
    return proxy;
}

function mapMaybePromise<T>(value: unknown, map: (value: unknown) => T): T | Promise<T> {
    if (value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
        return Promise.resolve(value).then(map);
    }
    return map(value);
}

function assertTrackedSql(value: unknown, onRead: ((tableName: string) => void) | undefined): void {
    const seen = new WeakSet<object>();

    const scan = (chunk: unknown): boolean => {
        if (chunk === undefined || chunk === null || typeof chunk !== "object") return false;
        if (TRACKED_SELECT_BUILDERS.has(chunk)) {
            throw unsupportedSelect("live query subqueries are unavailable through the policy wrapper");
        }
        if (seen.has(chunk)) return false;
        seen.add(chunk);
        if (Array.isArray(chunk)) {
            let tracked = false;
            for (const item of chunk) tracked = scan(item) || tracked;
            return tracked;
        }
        if (is(chunk, StringChunk)) {
            const syntax = chunk.value.join("").replace(SAFE_SQL_SYNTAX, "");
            if (!SAFE_SQL_PUNCTUATION.test(syntax)) {
                throw unsupportedSelect("live query predicates cannot contain raw SQL identifiers or keywords");
            }
            return false;
        }
        if (is(chunk, Column)) {
            const meta = getCdbMeta(chunk.table as SQLiteTable);
            if (!meta) throw unsupportedSelect("live query predicates may reference only cdbTable columns");
            onRead?.(meta.name);
            return true;
        }
        if (is(chunk, Table)) {
            const meta = getCdbMeta(chunk as SQLiteTable);
            if (!meta) throw unsupportedSelect("live query predicates may reference only cdbTable values");
            onRead?.(meta.name);
            return true;
        }
        if (is(chunk, SQL)) {
            let tracked = false;
            for (const item of chunk.queryChunks) tracked = scan(item) || tracked;
            return tracked;
        }
        if (is(chunk, Name)) {
            throw unsupportedSelect("live query predicates cannot use untracked SQL identifiers");
        }
        if (is(chunk, Param) || is(chunk, Placeholder)) return false;
        if (isSQLWrapper(chunk)) {
            throw unsupportedSelect("live query predicates cannot use untracked SQL expressions");
        }
        throw unsupportedSelect("live query predicates contain an untracked object");
    };

    scan(value);
}

function maskSelectRows(plan: SelectPlan, value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) throw unsupportedSelect("full-row select did not return an array");
    return value.map(row => maskSelectRow(plan, row));
}

function maskSelectGet(plan: SelectPlan, value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    return maskSelectRow(plan, value);
}

function maskSelectRow(plan: SelectPlan, value: unknown): Record<string, unknown> {
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

function unsupportedWrite(operation: "insert" | "update" | "delete", property: PropertyKey): CdbError {
    return new CdbError({
        code: "CDB_UNSUPPORTED_FEATURE",
        message: `${operation} property "${String(property)}" is unavailable through the policy wrapper`,
    });
}

function scopePolicyBuilder(builder: unknown, plan: AutoFillPlan, operation: "update" | "delete"): unknown {
    const where = Reflect.get(builder as object, "where");
    if (typeof where !== "function") throw unsupportedWrite(operation, "where");
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
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
            if (prop === "where") {
                const value = Reflect.get(target, prop, receiver);
                if (typeof value !== "function") throw unsupportedWrite(operation, prop);
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
            }
            if (SAFE_WRITE_EXECUTION_METHODS.has(prop))
                return writeExecutionMethod(target, prop, receiver, plan, operation);
            throw unsupportedWrite(operation, prop);
        },
    });
}

function writeExecutionMethod(
    target: object,
    prop: PropertyKey,
    receiver: unknown,
    plan: AutoFillPlan,
    operation: "insert" | "update" | "delete"
): unknown {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") throw unsupportedWrite(operation, prop);
    const onWrite = plan.onWrite;
    if (prop !== "run" || !onWrite) return value.bind(target);
    return (...args: readonly unknown[]) => {
        const result = (value as (...args: readonly unknown[]) => unknown).call(target, ...args);
        if (result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
            return Promise.resolve(result).then(resolved => {
                onWrite(plan.tableName);
                return resolved;
            });
        }
        onWrite(plan.tableName);
        return result;
    };
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
 * The root proxy exposes only typed select/insert/update/delete builders and
 * transaction. Raw execution shortcuts and Drizzle's client/session objects
 * fail closed. Transactions receive the same wrapper recursively.
 */
export function wrapDb<TDb extends object>(db: TDb, auth: AuthCtx): TDb {
    return wrapDbInternal(db, auth, false, undefined, undefined);
}

export function wrapQueryDb<TDb extends object>(db: TDb, auth: AuthCtx, onRead?: (tableName: string) => void): TDb {
    return wrapDbInternal(db, auth, true, undefined, onRead);
}

/** Internal mutation wrapper used by the atomic executor to collect committed table names. */
export function wrapMutationDb<TDb extends object>(db: TDb, auth: AuthCtx, onWrite?: (tableName: string) => void): TDb {
    return wrapDbInternal(db, auth, false, onWrite, undefined);
}

function wrapDbInternal<TDb extends object>(
    db: TDb,
    auth: AuthCtx,
    queryBoundary: boolean,
    onWrite: ((tableName: string) => void) | undefined,
    onRead: ((tableName: string) => void) | undefined
): TDb {
    return new Proxy(db, {
        get(target, prop, receiver) {
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
            if (!SAFE_DB_METHODS.has(prop)) {
                throw new CdbError({
                    code: "CDB_UNSUPPORTED_FEATURE",
                    message: `database property "${String(prop)}" is unavailable; use typed chardb builders`,
                });
            }
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== "function") {
                throw new CdbError({
                    code: "CDB_UNSUPPORTED_FEATURE",
                    message: `database property "${String(prop)}" is not a callable typed builder`,
                });
            }
            if (prop === "select" || prop === "selectDistinct") {
                return (...args: readonly unknown[]) => {
                    const builder = (v as (...args: readonly unknown[]) => unknown).call(target, ...args);
                    return wrapSelectFromBuilder(builder, {
                        auth,
                        fullRow: prop === "select" && args.length === 0,
                        queryBoundary,
                        onRead,
                    });
                };
            }
            if (prop === "insert") {
                return (table: SQLiteTable) => {
                    const meta = getCdbMeta(table);
                    if (!meta) throw unsupportedWrite("insert", "plain table");
                    const plan = buildPlan(table, meta, auth, "insert", onWrite);
                    const builder = (v as (t: SQLiteTable) => unknown).call(target, table);
                    return wrapInsertBuilder(builder, plan);
                };
            }
            if (prop === "update") {
                return (table: SQLiteTable) => {
                    const meta = getCdbMeta(table);
                    if (!meta) throw unsupportedWrite("update", "plain table");
                    const plan = buildWritePlan(table, meta, auth, "update", onWrite);
                    const builder = (v as (t: SQLiteTable) => unknown).call(target, table);
                    return wrapUpdateBuilder(builder, plan);
                };
            }
            if (prop === "delete") {
                return (table: SQLiteTable) => {
                    const meta = getCdbMeta(table);
                    if (!meta) throw unsupportedWrite("delete", "plain table");
                    const plan = buildWritePlan(table, meta, auth, "delete", onWrite);
                    const builder = (v as (t: SQLiteTable) => unknown).call(target, table);
                    return scopePolicyBuilder(builder, plan, "delete");
                };
            }
            if (prop === "transaction") {
                return (callback: (tx: TDb) => Promise<unknown>, ...rest: readonly unknown[]) => {
                    const wrapped = (tx: TDb) => callback(wrapDbInternal(tx, auth, queryBoundary, onWrite, onRead));
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
