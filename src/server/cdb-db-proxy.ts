/**
 * `wrapDb(rawDb, auth)` — proxies a Drizzle SQLiteDatabase so any
 * `db.insert(table).values(row)` call against a `cdbTable` instance
 * fills in the table's tenant / self columns from `auth` whenever the
 * caller omits them.
 *
 * This is the runtime half of chardb's INSERT auto-fill. The type-
 * level half lives in `cdb-table.ts`: every column chardb knows about
 * at construction time (`selfBy:`, `tenantBy:`, the conventional
 * `organizationId` / `userId`) gets a synthetic `$defaultFn`, which
 * Drizzle reflects into `$inferInsert` as an optional field — so the
 * caller can simply omit it.
 *
 * Anything that isn't an insert against a `cdbTable` passes through
 * unchanged. The proxy is intentionally a thin wrapper over the raw
 * `db` value the user's mutation context ships with: it does not
 * synthesize new query semantics, only intercepts `.values(...)` to
 * splice known auth-derived columns onto rows that omit them.
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
 * If an auth field is absent (`auth.tenantId == null` for an org-
 * tenanted table) and the row doesn't supply the column either, the
 * proxy leaves the column missing so Drizzle's NOT NULL guard surfaces
 * the missing-context as a clear DB error rather than silently writing
 * a wrong tenant. Callers needing a permissive policy should branch on
 * `ctx.auth.tenantId` themselves before the insert.
 */

import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getCdbMeta } from "./cdb-table-registry.ts";
import type { CdbTableMeta } from "./cdb-table-types.ts";
import { resolveCdbMeta } from "./cdb-table.ts";
import type { AuthCtx } from "./define.ts";

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
    readonly fills: ReadonlyArray<readonly [jsKey: string, value: unknown]>;
}

function buildPlan(table: SQLiteTable, meta: CdbTableMeta, auth: AuthCtx): AutoFillPlan {
    const fills: Array<readonly [string, unknown]> = [];
    const sqlToJs = sqlToJsMap(table);

    // selfBy → user id. Only resolves when the row actually has a user.
    if (meta.selfBy && auth.userId) {
        const jsKey = sqlToJs.get(meta.selfBy);
        if (jsKey !== undefined) fills.push([jsKey, auth.userId]);
    }

    // tenantBy: trust the resolved view (auto-discovered FK or explicit).
    // Skip the resolve call entirely when the file scope is `none` — we
    // know nothing to fill and `resolveCdbMeta` would still succeed but
    // do nothing useful.
    if (meta.tenantKind !== "none") {
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
            const value = meta.tenantKind === "org" ? auth.tenantId : auth.userId;
            if (jsKey !== undefined && value) fills.push([jsKey, value]);
        }
    }

    return { fills };
}

function applyPlan<T extends Record<string, unknown>>(plan: AutoFillPlan, row: T): T {
    if (plan.fills.length === 0) return row;
    let next: Record<string, unknown> | null = null;
    for (const [jsKey, value] of plan.fills) {
        const present = Object.prototype.hasOwnProperty.call(row, jsKey) && row[jsKey] !== undefined;
        if (present) continue;
        if (next === null) next = { ...row };
        next[jsKey] = value;
    }
    return (next ?? row) as T;
}

/**
 * Wrap a Drizzle insert builder so its `.values(row | rows)` call
 * splices auto-fill columns onto each row before forwarding to the
 * real builder. Other builder methods (`returning`, `onConflictDoNothing`,
 * `prepare`, …) pass through; the auto-fill happens exactly once at
 * `.values()` time so chained methods downstream see a complete row.
 */
function wrapInsertBuilder(builder: unknown, plan: AutoFillPlan): unknown {
    if (plan.fills.length === 0) return builder;
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

/**
 * The exported wrapper. Drop-in replacement for the raw db value
 * mutation/query handlers receive — accepts any Drizzle SQLite db
 * (BaseSQLiteDatabase, transaction handle, etc.) and proxies through.
 *
 * Implementation note: a Proxy on the db forwards every property
 * (`.select`, `.update`, `.delete`, `.transaction`, `.run`, …) by
 * default; only `insert` is intercepted. The wrap is recursive on the
 * transaction callback so `db.transaction(tx => …)` hands the user a
 * wrapped `tx` too.
 */
export function wrapDb<TDb extends object>(db: TDb, auth: AuthCtx): TDb {
    return new Proxy(db, {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== "function") return v;
            if (prop === "insert") {
                return (table: SQLiteTable) => {
                    const builder = (v as (t: SQLiteTable) => unknown).call(target, table);
                    const meta = getCdbMeta(table);
                    if (!meta) return builder;
                    return wrapInsertBuilder(builder, buildPlan(table, meta, auth));
                };
            }
            if (prop === "transaction") {
                return (callback: (tx: TDb) => Promise<unknown>, ...rest: readonly unknown[]) => {
                    const wrapped = (tx: TDb) => callback(wrapDb(tx, auth));
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
