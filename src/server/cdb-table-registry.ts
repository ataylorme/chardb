/**
 * Runtime metadata registry for `cdbTable` instances.
 *
 * Every table built via a schema ownership factory
 * carries a frozen `CdbTableMeta` record that captures the user's RLS +
 * CLS configuration alongside resolved internals (the auto-discovered
 * tenant column, the tenancy axis, the auth target table reference).
 *
 * Two access paths cover the needs of the rest of the framework:
 *   - `Symbol.for("chardb.table")` defined as a non-enumerable property
 *     on the returned Drizzle table so foreign code (eslint rule, CLI
 *     reporter, debugger) can sniff cdbTable-ness without loading
 *     chardb's runtime.
 *   - `WeakMap<SQLiteTable, CdbTableMeta>` so chardb's own runtime can
 *     read the rich record without re-walking the Drizzle metadata.
 *
 * Tables NOT produced by `cdbTable` (e.g. better-auth synthesized
 * tables) carry no metadata; consumers must treat `getCdbMeta(t)` as
 * possibly `undefined` and fall through to defaults.
 */

import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { CdbTableMeta } from "./cdb-table-types.ts";

export const CDB_TABLE_SYMBOL = Symbol.for("chardb.table");

const REGISTRY = new WeakMap<SQLiteTable, CdbTableMeta>();

export function attachCdbMeta<T extends SQLiteTable>(table: T, meta: CdbTableMeta): T {
    REGISTRY.set(table, meta);
    Object.defineProperty(table, CDB_TABLE_SYMBOL, {
        value: meta,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return table;
}

export function getCdbMeta(table: SQLiteTable): CdbTableMeta | undefined {
    return REGISTRY.get(table);
}

export function isCdbTable(value: unknown): value is SQLiteTable {
    if (!value || typeof value !== "object") return false;
    return CDB_TABLE_SYMBOL in (value as Record<symbol, unknown>);
}

/**
 * Walk a schema namespace and return every `cdbTable` export with its
 * resolved metadata. Used by `chardb()` to materialize the access
 * control + colocation overrides at boot, and by the `chardb policies`
 * CLI to emit the audit report.
 */
export function collectCdbTables(schema: Record<string, unknown>): readonly {
    readonly key: string;
    readonly table: SQLiteTable;
    readonly meta: CdbTableMeta;
}[] {
    const out: { readonly key: string; readonly table: SQLiteTable; readonly meta: CdbTableMeta }[] = [];
    for (const [key, value] of Object.entries(schema)) {
        if (!value || typeof value !== "object") continue;
        const meta = REGISTRY.get(value as SQLiteTable);
        if (meta) out.push({ key, table: value as SQLiteTable, meta });
    }
    return out;
}
