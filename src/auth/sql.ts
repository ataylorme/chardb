/**
 * SQL rendering for chardb's better-auth adapter.
 *
 * The chardb adapter never invokes Drizzle's runtime — Drizzle is used
 * only as a *schema* source (column names, table names) via
 * `getTableConfig`. We render parameterized SQL directly against the
 * `SyncSql` adapter so the work runs synchronously inside
 * `transactionSync` blocks on the Catalog DO.
 *
 * Op semantics mirror better-auth's `DbAdapterContract`:
 *   - create  → `INSERT INTO t (cols...) VALUES (?...)`. Returns the
 *               row that was written (better-auth expects the canonical
 *               post-insert form).
 *   - update  → `UPDATE t SET ... WHERE ...`. Returns the merged row
 *               (caller passes both `where` and `set` payload).
 *   - delete  → `DELETE FROM t WHERE ...`. Returns the affected row
 *               count.
 *   - findOne → `SELECT * FROM t WHERE ... LIMIT 1`.
 *   - findMany → `SELECT * FROM t WHERE ... ORDER BY ... LIMIT ? OFFSET ?`.
 *
 * Where-clauses are restricted to a flat AND of equalities. Better-auth's
 * own query surface only emits these for the model-store path; richer
 * filters land on hand-rolled queries against the synthesized schema
 * directly.
 */

import { type Column, getTableColumns, getTableName } from "drizzle-orm";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import type { SqlValue, SyncSql } from "../oplog/wrapper.ts";
import type { RawJson } from "../types.ts";

const ALLOWED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(raw: string): string {
    if (!ALLOWED_IDENT.test(raw)) {
        throw new Error(`auth/sql: refusing to quote identifier ${JSON.stringify(raw)}`);
    }
    return `"${raw}"`;
}

interface TableInfo {
    readonly name: string;
    /** Map model-key → SQL column name (handles renames via `column.name !== modelKey`). */
    readonly columns: ReadonlyMap<string, string>;
    readonly dataTypes: ReadonlyMap<string, Column["dataType"]>;
}

const tableInfoCache = new WeakMap<AnySQLiteTable, TableInfo>();

function infoOf(table: AnySQLiteTable): TableInfo {
    const cached = tableInfoCache.get(table);
    if (cached) return cached;
    const columns = new Map<string, string>();
    const dataTypes = new Map<string, Column["dataType"]>();
    for (const [key, col] of Object.entries(getTableColumns(table)) as [string, Column][]) {
        columns.set(key, col.name);
        dataTypes.set(key, col.dataType);
    }
    const info: TableInfo = { name: getTableName(table), columns, dataTypes };
    tableInfoCache.set(table, info);
    return info;
}

function toSqlValue(v: unknown): SqlValue {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "bigint") return v;
    if (v instanceof Uint8Array) return v;
    // Object / array: store as JSON. Better-auth's column contract maps
    // these via the synthesized table's `mode: "json"` columns; we
    // serialize at the boundary so the storage layer always sees a
    // primitive.
    return JSON.stringify(v);
}

function fromSqlValue(raw: unknown, dataType: Column["dataType"] | undefined): RawJson {
    if (raw === null || raw === undefined) return null;
    if (dataType === "date" && (typeof raw === "number" || typeof raw === "string")) {
        return new Date(Number(raw)) as unknown as RawJson;
    }
    if (dataType === "boolean" && (typeof raw === "number" || typeof raw === "bigint")) {
        return (Number(raw) === 1) as RawJson;
    }
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
    if (typeof raw === "bigint") return raw.toString();
    if (raw instanceof Uint8Array) return Array.from(raw) as unknown as RawJson;
    return raw as RawJson;
}

function projectRow(info: TableInfo, raw: Record<string, unknown>): Record<string, RawJson> {
    const out: Record<string, RawJson> = {};
    for (const [modelKey, sqlName] of info.columns) {
        if (sqlName in raw) out[modelKey] = fromSqlValue(raw[sqlName], info.dataTypes.get(modelKey));
    }
    return out;
}

function bindWhere(info: TableInfo, where: { readonly [k: string]: RawJson }): { sql: string; params: SqlValue[] } {
    const keys = Object.keys(where);
    if (keys.length === 0) return { sql: "1=1", params: [] };
    const parts: string[] = [];
    const params: SqlValue[] = [];
    for (const key of keys) {
        const sqlName = info.columns.get(key);
        if (!sqlName) {
            throw new Error(`auth/sql: where key "${key}" is not a column on table ${info.name}`);
        }
        parts.push(`${quoteIdent(sqlName)} = ?`);
        params.push(toSqlValue(where[key] as RawJson));
    }
    return { sql: parts.join(" AND "), params };
}

export function authCreate(
    sql: SyncSql,
    table: AnySQLiteTable,
    payload: { readonly [k: string]: RawJson }
): Record<string, RawJson> {
    const info = infoOf(table);
    const cols: string[] = [];
    const placeholders: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, sqlName] of info.columns) {
        if (key in payload) {
            cols.push(quoteIdent(sqlName));
            placeholders.push("?");
            params.push(toSqlValue(payload[key] as RawJson));
        }
    }
    sql.exec(
        `INSERT INTO ${quoteIdent(info.name)} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
        ...params
    );
    // Re-read the row so we return the canonical post-insert shape (e.g. defaults
    // populated by SQLite). Best-effort PK lookup: the better-auth adapter
    // always supplies an `id` field for create; if not, fall back to the input.
    const id = payload.id;
    if (id !== undefined) {
        const found = sql.one<Record<string, unknown>>(
            `SELECT * FROM ${quoteIdent(info.name)} WHERE ${quoteIdent(info.columns.get("id") ?? "id")} = ? LIMIT 1`,
            toSqlValue(id)
        );
        if (found) return projectRow(info, found);
    }
    return { ...payload };
}

export function authUpdate(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: { readonly [k: string]: RawJson },
    set: { readonly [k: string]: RawJson }
): { affected: number; row: Record<string, RawJson> | null } {
    const info = infoOf(table);
    const setCols: string[] = [];
    const params: SqlValue[] = [];
    for (const key of Object.keys(set)) {
        const sqlName = info.columns.get(key);
        if (!sqlName) continue;
        setCols.push(`${quoteIdent(sqlName)} = ?`);
        params.push(toSqlValue(set[key] as RawJson));
    }
    if (setCols.length === 0) {
        return { affected: 0, row: authFindOne(sql, table, where) };
    }
    const w = bindWhere(info, where);
    sql.exec(`UPDATE ${quoteIdent(info.name)} SET ${setCols.join(", ")} WHERE ${w.sql}`, ...params, ...w.params);
    const affected = sql.changes();
    const row = authFindOne(sql, table, where);
    return { affected, row };
}

export function authDelete(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: { readonly [k: string]: RawJson }
): { affected: number } {
    const info = infoOf(table);
    const w = bindWhere(info, where);
    sql.exec(`DELETE FROM ${quoteIdent(info.name)} WHERE ${w.sql}`, ...w.params);
    return { affected: sql.changes() };
}

export function authFindOne(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: { readonly [k: string]: RawJson }
): Record<string, RawJson> | null {
    const info = infoOf(table);
    const w = bindWhere(info, where);
    const row = sql.one<Record<string, unknown>>(
        `SELECT * FROM ${quoteIdent(info.name)} WHERE ${w.sql} LIMIT 1`,
        ...w.params
    );
    return row ? projectRow(info, row) : null;
}

export function authFindMany(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: { readonly [k: string]: RawJson },
    limit?: number,
    offset?: number,
    sortBy?: { readonly field: string; readonly direction: "asc" | "desc" }
): Record<string, RawJson>[] {
    const info = infoOf(table);
    const w = bindWhere(info, where);
    const params = [...w.params];

    let orderClause = "";
    const idSqlName = info.columns.get("id");
    if (sortBy !== undefined) {
        const sqlName = info.columns.get(sortBy.field);
        if (!sqlName) {
            throw new Error(`auth/sql: sort field "${sortBy.field}" is not a column on table ${info.name}`);
        }
        if (sortBy.direction !== "asc" && sortBy.direction !== "desc") {
            throw new Error(`auth/sql: invalid sort direction ${JSON.stringify(sortBy.direction)}`);
        }
        orderClause = ` ORDER BY ${quoteIdent(sqlName)} ${sortBy.direction === "asc" ? "ASC" : "DESC"}`;
        if (sortBy.field !== "id") {
            if (!idSqlName) throw new Error(`auth/sql: table ${info.name} has no id column for deterministic paging`);
            orderClause += `, ${quoteIdent(idSqlName)} ASC`;
        }
    } else if (limit !== undefined || offset !== undefined) {
        if (!idSqlName) throw new Error(`auth/sql: table ${info.name} has no id column for deterministic paging`);
        orderClause = ` ORDER BY ${quoteIdent(idSqlName)} ASC`;
    }

    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new Error("auth/sql: limit must be a non-negative safe integer");
    }
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
        throw new Error("auth/sql: offset must be a non-negative safe integer");
    }

    let pageClause = "";
    if (limit !== undefined) {
        pageClause = " LIMIT ?";
        params.push(limit);
        if (offset !== undefined) {
            pageClause += " OFFSET ?";
            params.push(offset);
        }
    } else if (offset !== undefined) {
        pageClause = " LIMIT ? OFFSET ?";
        params.push(-1, offset);
    }

    const rows = sql.all<Record<string, unknown>>(
        `SELECT * FROM ${quoteIdent(info.name)} WHERE ${w.sql}${orderClause}${pageClause}`,
        ...params
    );
    return rows.map(r => projectRow(info, r));
}

export function authCount(sql: SyncSql, table: AnySQLiteTable, where: { readonly [k: string]: RawJson }): number {
    const info = infoOf(table);
    const w = bindWhere(info, where);
    const row = sql.one<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ${quoteIdent(info.name)} WHERE ${w.sql}`,
        ...w.params
    );
    return Number(row?.c ?? 0);
}

/** Get the SQL table name for a Drizzle synthesized auth table. Used by callers building DDL. */
export function authTableName(table: AnySQLiteTable): string {
    return infoOf(table).name;
}

/** Get the column-name map (model key → SQL column name) for a synthesized auth table. */
export function authTableColumns(table: AnySQLiteTable): ReadonlyMap<string, string> {
    return infoOf(table).columns;
}
