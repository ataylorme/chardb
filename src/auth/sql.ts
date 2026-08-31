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
 * Read predicates support Better Auth's full operator set as a flat AND.
 * Mutation predicates remain equality-only.
 */

import { type Column, getTableColumns, getTableName } from "drizzle-orm";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import type { SqlValue, SyncSql } from "../oplog/wrapper.ts";
import type { RawJson } from "../types.ts";

const ALLOWED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const AUTH_BULK_PRELOAD_MAX_ROWS = 4_096;
export const AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES = 512 * 1_024;
export const AUTH_BULK_REPLACEMENT_MAX_BYTES = 512 * 1_024;
export const AUTH_READ_IN_MAX_VALUES = 256;
const AUTH_BULK_PRELOAD_RETRY_MS = 1_000;

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

export type AuthIncrementWhereOperator = "eq" | "lt" | "lte" | "gt" | "gte";

export interface AuthIncrementWhere {
    readonly field: string;
    readonly operator: AuthIncrementWhereOperator;
    readonly value: RawJson;
}

export type AuthReadScalarOperator =
    | "eq"
    | "ne"
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "contains"
    | "starts_with"
    | "ends_with";

export type AuthReadWhere =
    | {
          readonly field: string;
          readonly operator: AuthReadScalarOperator;
          readonly value: RawJson;
          readonly mode?: "sensitive" | "insensitive";
      }
    | {
          readonly field: string;
          readonly operator: "in" | "not_in";
          readonly value: readonly RawJson[];
          readonly mode?: "sensitive" | "insensitive";
      };

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

function bindReadWhere(
    info: TableInfo,
    where: readonly AuthReadWhere[]
): { readonly sql: string; readonly params: SqlValue[] } {
    if (where.length === 0) return { sql: "1=1", params: [] };
    const parts: string[] = [];
    const params: SqlValue[] = [];
    for (const condition of where) {
        const sqlName = info.columns.get(condition.field);
        if (!sqlName) {
            throw new CdbError({
                code: "CDB_INVALID_ARGS",
                message: `auth/sql: where field "${condition.field}" is not a column on table ${info.name}`,
            });
        }
        const quoted = quoteIdent(sqlName);
        if (condition.operator === "in" || condition.operator === "not_in") {
            if (condition.value.length > AUTH_READ_IN_MAX_VALUES) {
                throw new CdbError({
                    code: "CDB_INVALID_ARGS",
                    message: `auth/sql: ${condition.operator} filter exceeds ${AUTH_READ_IN_MAX_VALUES} values`,
                });
            }
            if (condition.value.length === 0) {
                parts.push(condition.operator === "in" ? "0=1" : "1=1");
                continue;
            }
            parts.push(
                `${quoted} ${condition.operator === "in" ? "IN" : "NOT IN"} (${condition.value.map(() => "?").join(", ")})`
            );
            for (const value of condition.value) params.push(toSqlValue(value));
            continue;
        }

        const insensitive = condition.mode === "insensitive";
        const expression = insensitive ? `lower(${quoted})` : quoted;
        const value = toSqlValue(condition.value);
        const comparableValue = insensitive && typeof value === "string" ? value.toLowerCase() : value;
        if (condition.operator === "eq" || condition.operator === "ne") {
            if (condition.value === null) {
                parts.push(`${quoted} IS ${condition.operator === "eq" ? "" : "NOT "}NULL`);
            } else {
                parts.push(`${expression} ${condition.operator === "eq" ? "=" : "!="} ?`);
                params.push(comparableValue);
            }
            continue;
        }
        if (
            condition.operator === "lt" ||
            condition.operator === "lte" ||
            condition.operator === "gt" ||
            condition.operator === "gte"
        ) {
            const operator = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[condition.operator];
            parts.push(`${expression} ${operator} ?`);
            params.push(comparableValue);
            continue;
        }
        if (typeof comparableValue !== "string") {
            throw new CdbError({
                code: "CDB_INVALID_ARGS",
                message: `auth/sql: ${condition.operator} filter requires a string value`,
            });
        }
        if (condition.operator === "contains") {
            parts.push(`instr(${expression}, ?) > 0`);
            params.push(comparableValue);
        } else if (condition.operator === "starts_with") {
            parts.push(`instr(${expression}, ?) = 1`);
            params.push(comparableValue);
        } else {
            parts.push(`substr(${expression}, length(${expression}) - length(?) + 1) = ?`);
            params.push(comparableValue, comparableValue);
        }
    }
    return { sql: parts.join(" AND "), params };
}

function invalidIncrementInput(message: string): CdbError {
    return new CdbError({ code: "CDB_INVALID_ARGS", message: `auth/sql: ${message}` });
}

function bindIncrementWhere(
    info: TableInfo,
    where: readonly AuthIncrementWhere[]
): {
    readonly sql: string;
    readonly params: SqlValue[];
} {
    if (where.length === 0) return { sql: "1=1", params: [] };
    const operators: Record<AuthIncrementWhereOperator, string> = {
        eq: "=",
        lt: "<",
        lte: "<=",
        gt: ">",
        gte: ">=",
    };
    const parts: string[] = [];
    const params: SqlValue[] = [];
    for (const condition of where) {
        const sqlName = info.columns.get(condition.field);
        if (!sqlName) {
            throw invalidIncrementInput(
                `incrementOne where field "${condition.field}" is not a column on table ${info.name}`
            );
        }
        const operator = operators[condition.operator];
        if (!operator) {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: `auth/sql: incrementOne where operator ${JSON.stringify(condition.operator)} is not supported`,
            });
        }
        if (condition.value === null) {
            if (condition.operator !== "eq") {
                throw invalidIncrementInput("incrementOne only supports null with the eq operator");
            }
            parts.push(`${quoteIdent(sqlName)} IS NULL`);
            continue;
        }
        if (
            typeof condition.value !== "string" &&
            typeof condition.value !== "number" &&
            typeof condition.value !== "boolean"
        ) {
            throw invalidIncrementInput("incrementOne comparison values must be scalar JSON values");
        }
        if (
            typeof condition.value === "number" &&
            (!Number.isFinite(condition.value) || Object.is(condition.value, -0))
        ) {
            throw invalidIncrementInput("incrementOne comparison numbers must be finite and not negative zero");
        }
        parts.push(`${quoteIdent(sqlName)} ${operator} ?`);
        params.push(toSqlValue(condition.value));
    }
    return { sql: parts.join(" AND "), params };
}

export function assertAuthIncrementInput(
    table: AnySQLiteTable,
    where: readonly AuthIncrementWhere[],
    increment: { readonly [k: string]: number },
    set: { readonly [k: string]: RawJson } = {}
): void {
    const info = infoOf(table);
    bindIncrementWhere(info, where);
    const incrementKeys = Object.keys(increment);
    const setKeys = Object.keys(set);
    if (incrementKeys.length === 0 && setKeys.length === 0) {
        throw invalidIncrementInput("incrementOne requires a non-empty increment or set payload");
    }
    for (const key of incrementKeys) {
        if (!info.columns.has(key)) {
            throw invalidIncrementInput(`incrementOne field "${key}" is not a column on table ${info.name}`);
        }
        if (info.dataTypes.get(key) !== "number") {
            throw invalidIncrementInput(`incrementOne field "${key}" is not numeric on table ${info.name}`);
        }
        const delta = increment[key];
        if (typeof delta !== "number" || !Number.isFinite(delta) || Object.is(delta, -0)) {
            throw invalidIncrementInput(`incrementOne delta for "${key}" must be finite and not negative zero`);
        }
    }
    for (const key of setKeys) {
        if (!info.columns.has(key)) {
            throw invalidIncrementInput(`incrementOne set field "${key}" is not a column on table ${info.name}`);
        }
    }
}

export function authFindFirstIncrementId(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: readonly AuthIncrementWhere[]
): string | null {
    const info = infoOf(table);
    const idSqlName = info.columns.get("id");
    if (!idSqlName) {
        throw new CdbError({ code: "CDB_INVARIANT", message: `auth/sql: table ${info.name} has no id column` });
    }
    const quotedId = quoteIdent(idSqlName);
    const w = bindIncrementWhere(info, where);
    const row = sql.one<{ auth_target_id: unknown }>(
        `SELECT ${quotedId} AS auth_target_id
         FROM ${quoteIdent(info.name)}
         WHERE ${w.sql}
         ORDER BY ${quotedId} ASC
         LIMIT 1`,
        ...w.params
    );
    if (!row) return null;
    if (typeof row.auth_target_id !== "string") {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `auth/sql: selected id on table ${info.name} is not a string`,
        });
    }
    return row.auth_target_id;
}

export function authIncrementOne(
    sql: SyncSql,
    table: AnySQLiteTable,
    targetId: string,
    where: readonly AuthIncrementWhere[],
    increment: { readonly [k: string]: number },
    set: { readonly [k: string]: RawJson } = {}
): { readonly affected: number; readonly row: Record<string, RawJson> | null } {
    assertAuthIncrementInput(table, where, increment, set);
    const info = infoOf(table);
    const idSqlName = info.columns.get("id");
    if (!idSqlName) {
        throw new CdbError({ code: "CDB_INVARIANT", message: `auth/sql: table ${info.name} has no id column` });
    }
    const incrementKeys = new Set(Object.keys(increment));
    const setters: string[] = [];
    const params: SqlValue[] = [];
    for (const key of Object.keys(set)) {
        if (incrementKeys.has(key)) continue;
        setters.push(`${quoteIdent(info.columns.get(key) as string)} = ?`);
        params.push(toSqlValue(set[key] as RawJson));
    }
    for (const key of incrementKeys) {
        const quoted = quoteIdent(info.columns.get(key) as string);
        setters.push(`${quoted} = COALESCE(${quoted}, 0) + ?`);
        params.push(increment[key] as number);
    }
    const w = bindIncrementWhere(info, where);
    sql.exec(
        `UPDATE ${quoteIdent(info.name)}
         SET ${setters.join(", ")}
         WHERE ${quoteIdent(idSqlName)} = ? AND ${w.sql}`,
        ...params,
        targetId,
        ...w.params
    );
    const affected = sql.changes();
    if (affected > 1) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "auth/sql: incrementOne updated more than one row" });
    }
    if (affected === 0) return { affected, row: null };
    const nextId = Object.hasOwn(set, "id") ? set.id : targetId;
    if (typeof nextId !== "string") {
        throw invalidIncrementInput("incrementOne set id must be a string");
    }
    return { affected, row: authFindOne(sql, table, { id: nextId }) };
}

function checkedAggregate(value: unknown, subject: string): number {
    const numeric = typeof value === "bigint" ? Number(value) : value;
    if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `auth/sql: bulk preload ${subject} aggregate is missing or invalid`,
        });
    }
    return numeric;
}

function bulkPreloadCapacityExceeded(subject: string, limit: number): CdbError {
    return new CdbError({
        code: "CDB_RATE_LIMITED",
        message: `Catalog auth bulk mutation exceeds the ${limit}-${subject} preload limit`,
        retryAfterMs: AUTH_BULK_PRELOAD_RETRY_MS,
        hint: "narrow the auth mutation predicate and retry in smaller batches",
    });
}

function utf8ByteLength(value: string, stopAfter: number): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                index++;
            } else {
                bytes += 3;
            }
        } else bytes += 3;
        if (bytes > stopAfter) return bytes;
    }
    return bytes;
}

function sqlValueByteLength(value: SqlValue): bigint {
    if (value === null) return 0n;
    if (typeof value === "string") return BigInt(utf8ByteLength(value, AUTH_BULK_REPLACEMENT_MAX_BYTES));
    if (value instanceof Uint8Array) return BigInt(value.byteLength);
    return 8n;
}

function expandedReplacementBytes(
    info: TableInfo,
    payload: { readonly [k: string]: RawJson },
    matchedRows: number
): bigint {
    if (matchedRows === 0) return 0n;
    let bytesPerRow = 0n;
    for (const key of Object.keys(payload)) {
        if (!info.columns.has(key)) continue;
        bytesPerRow += sqlValueByteLength(toSqlValue(payload[key] as RawJson));
        if (bytesPerRow > BigInt(AUTH_BULK_REPLACEMENT_MAX_BYTES)) return bytesPerRow;
    }
    return bytesPerRow * BigInt(matchedRows);
}

export function authPreloadScopeRows(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: { readonly [k: string]: RawJson },
    projectionKeys: readonly string[],
    additionalScopeValues: readonly unknown[] = [],
    replacementPayload?: { readonly [k: string]: RawJson }
): {
    readonly matchedRows: number;
    readonly scopeBytes: number;
    readonly rows: readonly Record<string, RawJson>[];
} {
    const info = infoOf(table);
    const w = bindWhere(info, where);
    const projected = [...new Set(projectionKeys)].map(modelKey => {
        const sqlName = info.columns.get(modelKey);
        if (!sqlName) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: `auth/sql: scope projection key "${modelKey}" is not a column on table ${info.name}`,
            });
        }
        return { modelKey, sqlName, quoted: quoteIdent(sqlName) };
    });
    const storedByteExpression =
        projected.length === 0
            ? "0"
            : projected
                  .map(
                      column =>
                          `CASE WHEN typeof(${column.quoted}) = 'text' THEN length(CAST(${column.quoted} AS BLOB)) ELSE 0 END`
                  )
                  .join(" + ");
    const aggregate = sql.one<{ matched_rows: number | bigint; scope_bytes: number | bigint }>(
        `SELECT COUNT(*) AS matched_rows,
                COALESCE(SUM(${storedByteExpression}), 0) AS scope_bytes
         FROM ${quoteIdent(info.name)}
         WHERE ${w.sql}`,
        ...w.params
    );
    if (!aggregate) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "auth/sql: bulk preload aggregate returned no row" });
    }
    const matchedRows = checkedAggregate(aggregate.matched_rows, "row count");
    if (matchedRows > AUTH_BULK_PRELOAD_MAX_ROWS) {
        throw bulkPreloadCapacityExceeded("row", AUTH_BULK_PRELOAD_MAX_ROWS);
    }
    const replacementBytes = replacementPayload ? expandedReplacementBytes(info, replacementPayload, matchedRows) : 0n;
    if (replacementBytes > BigInt(AUTH_BULK_REPLACEMENT_MAX_BYTES)) {
        throw bulkPreloadCapacityExceeded("expanded-replacement-byte", AUTH_BULK_REPLACEMENT_MAX_BYTES);
    }
    let scopeBytes = checkedAggregate(aggregate.scope_bytes, "scope byte count");
    if (matchedRows > 0) {
        for (const value of additionalScopeValues) {
            if (typeof value !== "string") continue;
            scopeBytes += utf8ByteLength(value, AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES - scopeBytes);
            if (!Number.isSafeInteger(scopeBytes)) {
                throw new CdbError({
                    code: "CDB_INVARIANT",
                    message: "auth/sql: bulk preload scope byte total is invalid",
                });
            }
        }
    }
    if (scopeBytes > AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES) {
        throw bulkPreloadCapacityExceeded("scope-byte", AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES);
    }
    if (matchedRows === 0 || projected.length === 0) return { matchedRows, scopeBytes, rows: [] };

    const selected = projected
        .map(
            column =>
                `CASE WHEN typeof(${column.quoted}) = 'text' THEN ${column.quoted} ELSE NULL END AS ${column.quoted}`
        )
        .join(", ");
    const rawRows = sql.all<Record<string, unknown>>(
        `SELECT ${selected}
         FROM ${quoteIdent(info.name)}
         WHERE ${w.sql}
         LIMIT ?`,
        ...w.params,
        AUTH_BULK_PRELOAD_MAX_ROWS + 1
    );
    if (rawRows.length !== matchedRows) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: "auth/sql: bulk preload row count changed inside one transaction",
        });
    }
    return { matchedRows, scopeBytes, rows: rawRows.map(raw => projectRow(info, raw)) };
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
    set: { readonly [k: string]: RawJson },
    returnRow = true
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
        return { affected: 0, row: returnRow ? authFindOne(sql, table, where) : null };
    }
    const w = bindWhere(info, where);
    sql.exec(`UPDATE ${quoteIdent(info.name)} SET ${setCols.join(", ")} WHERE ${w.sql}`, ...params, ...w.params);
    const affected = sql.changes();
    const row = returnRow ? authFindOne(sql, table, where) : null;
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

export function authFindFirstId(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: { readonly [k: string]: RawJson }
): string | null {
    const info = infoOf(table);
    const idSqlName = info.columns.get("id");
    if (!idSqlName) {
        throw new CdbError({ code: "CDB_INVARIANT", message: `auth/sql: table ${info.name} has no id column` });
    }
    const quotedId = quoteIdent(idSqlName);
    const w = bindWhere(info, where);
    const row = sql.one<{ auth_target_id: unknown }>(
        `SELECT ${quotedId} AS auth_target_id
         FROM ${quoteIdent(info.name)}
         WHERE ${w.sql}
         ORDER BY ${quotedId} ASC
         LIMIT 1`,
        ...w.params
    );
    if (!row) return null;
    if (typeof row.auth_target_id !== "string") {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `auth/sql: selected id on table ${info.name} is not a string`,
        });
    }
    return row.auth_target_id;
}

export function authFindMany(
    sql: SyncSql,
    table: AnySQLiteTable,
    where: readonly AuthReadWhere[],
    limit?: number,
    offset?: number,
    sortBy?: { readonly field: string; readonly direction: "asc" | "desc" }
): Record<string, RawJson>[] {
    const info = infoOf(table);
    const w = bindReadWhere(info, where);
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

export function authCount(sql: SyncSql, table: AnySQLiteTable, where: readonly AuthReadWhere[]): number {
    const info = infoOf(table);
    const w = bindReadWhere(info, where);
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
