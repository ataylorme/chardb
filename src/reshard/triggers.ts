/**
 * Pure helpers for the per-table tail-capture triggers used during a vshard
 * split. Kept separate from the Cdb DO so the SQL generation is unit-testable
 * without workerd.
 *
 * The triggers fire `AFTER INSERT | UPDATE | DELETE` on each migrating table
 * and project the affected row into `_chardb_split_log` as a JSON blob keyed
 * by the table's partition column. The destination shard later replays those
 * rows in LSN order, filtered by `vshardOf(partition_key) ∈ [lo, hi]`.
 *
 * Why JSON? SQLite triggers can build a row's full payload via `json_object`
 * (JSON1 is enabled by default in workerd's SQLite build); the destination
 * decodes that JSON and issues parameterized inserts. This avoids shipping
 * binary BLOBs through trigger bodies.
 *
 * Why a vshard filter at replay time, not in the trigger? SQLite has no
 * built-in `xxhash64`, so we cannot evaluate `vshardOf` inside trigger SQL.
 * The destination receives every change for the migrating table and skips
 * the rows whose partition key falls outside its range — small overhead
 * relative to the bulk-copy phase that dominates migration cost.
 */

import {
    CDB_SPLIT_LOG_MAX_BYTES,
    CDB_SPLIT_LOG_MAX_ROWS,
    CDB_SPLIT_TX_MAX_BYTES,
    CDB_SPLIT_TX_MAX_ROWS,
    CDB_SPLIT_TX_MAX_ROW_BYTES,
} from "../oplog/schema.ts";
import type { SyncSql } from "../oplog/wrapper.ts";

export interface TableSpec {
    /** Concrete table name (matches the name in `sqlite_master`). */
    readonly name: string;
    /**
     * Column whose value is the partition key. Composite partition keys are
     * out of scope for the bulk-copy path; declare a stable single column
     * (typically the FK to the distribution root) when authoring schemas
     * intended for online resharding.
     */
    readonly partitionColumn: string;
    /** Names of every column in the table, in declaration order. */
    readonly columns: readonly string[];
}

export interface TriggerSet {
    readonly names: readonly string[];
    readonly install: readonly string[];
    readonly uninstall: readonly string[];
}

export interface SplitLogCapacity {
    readonly maxRows: number;
    readonly maxBytes: number;
}

const DEFAULT_SPLIT_LOG_CAPACITY: SplitLogCapacity = {
    maxRows: CDB_SPLIT_LOG_MAX_ROWS,
    maxBytes: CDB_SPLIT_LOG_MAX_BYTES,
};

const ALLOWED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(raw: string): string {
    if (!ALLOWED_IDENT.test(raw)) {
        throw new Error(`reshard: refusing to install trigger for non-identifier name: ${raw}`);
    }
    return `"${raw}"`;
}

export function reshardTriggerMigrationId(migId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(migId)) {
        throw new Error(`reshard: migId must be [A-Za-z0-9][A-Za-z0-9_-]{0,127}, got: ${migId}`);
    }
    let encoded = "m_";
    for (let index = 0; index < migId.length; index++) {
        encoded += migId.charCodeAt(index).toString(16).padStart(2, "0");
    }
    return encoded;
}

/** Trigger suffix used before migration IDs received an injective encoding. */
export function legacyReshardTriggerMigrationId(migId: string): string {
    reshardTriggerMigrationId(migId);
    return migId.replaceAll("-", "_");
}

function rawTriggerNames(migration: string, tableName: string): readonly string[] {
    return Object.freeze([
        `_chardb_capt_${migration}_${tableName}_ins`,
        `_chardb_capt_${migration}_${tableName}_upd`,
        `_chardb_capt_${migration}_${tableName}_del`,
    ]);
}

export function legacyTableTriggerNames(migId: string, table: TableSpec): readonly string[] {
    quoteIdent(table.name);
    return rawTriggerNames(legacyReshardTriggerMigrationId(migId), table.name);
}

/**
 * Remove only a legacy trigger whose stored body proves this exact migration
 * owns it. A colliding legacy name is left in place so admission fails closed.
 */
export function uninstallOwnedLegacyTableTriggers(sql: SyncSql, migId: string, table: TableSpec): number {
    let removed = 0;
    for (const name of legacyTableTriggerNames(migId, table)) {
        const stored = sql.one<{ name: string; tbl_name: string; sql: string | null }>(
            `SELECT name, tbl_name, sql FROM sqlite_master
             WHERE type = 'trigger' AND name = ? COLLATE NOCASE`,
            name
        );
        if (
            !stored ||
            stored.tbl_name !== table.name ||
            typeof stored.sql !== "string" ||
            !stored.sql.includes(`capture_state.mig_id = '${migId}'`) ||
            !stored.sql.includes(`WHERE mig_id = '${migId}'`)
        ) {
            continue;
        }
        sql.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(stored.name)}`);
        removed++;
    }
    return removed;
}

function jsonObjectExpr(prefix: "NEW" | "OLD", columns: readonly string[]): string {
    const parts = columns.map(c => `'${c}', ${prefix}.${quoteIdent(c)}`);
    return `json_object(${parts.join(", ")})`;
}

/**
 * Render the trigger DDL pair (install + uninstall) for a single table within
 * a single migration. Names are deterministic so re-running install is a
 * `CREATE TRIGGER IF NOT EXISTS` no-op and uninstall fully cleans up.
 */
export function renderTableTriggers(
    migId: string,
    table: TableSpec,
    capacity: SplitLogCapacity = DEFAULT_SPLIT_LOG_CAPACITY
): TriggerSet {
    if (
        !Number.isSafeInteger(capacity.maxRows) ||
        capacity.maxRows < 1 ||
        !Number.isSafeInteger(capacity.maxBytes) ||
        capacity.maxBytes < 1
    ) {
        throw new Error("reshard: split-log capacity must use positive safe integers");
    }
    const m = reshardTriggerMigrationId(migId);
    const t = quoteIdent(table.name);
    const pkCol = quoteIdent(table.partitionColumn);
    const rawNames = rawTriggerNames(m, table.name);
    const [insName, updName, delName] = rawNames.map(quoteIdent);
    const newJson = jsonObjectExpr("NEW", table.columns);
    const oldJson = jsonObjectExpr("OLD", table.columns);
    const pendingTxId =
        "(SELECT event_id FROM _chardb_op_log WHERE byte_size = 0 AND length(payload_enc) = 0 ORDER BY event_id LIMIT 1)";
    const pendingPlacement =
        "(SELECT placement_vshard FROM _chardb_op_log WHERE byte_size = 0 AND length(payload_enc) = 0 ORDER BY event_id LIMIT 1)";
    const assertPendingTransaction = [
        "SELECT CASE WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM _chardb_op_log ",
        "WHERE byte_size = 0 AND length(payload_enc) = 0 ORDER BY event_id LIMIT 2)) != 1 ",
        `OR ${pendingPlacement} IS NULL `,
        "THEN RAISE(ABORT, 'CDB_INVARIANT: active reshard capture requires exactly one pending mutation') END; ",
    ].join("");
    const shouldCapture = [
        "EXISTS (SELECT 1 FROM _chardb_split_state AS capture_state ",
        `WHERE capture_state.mig_id = '${migId}' AND ${pendingPlacement} `,
        "BETWEEN capture_state.range_lo AND capture_state.range_hi)",
    ].join("");
    const appendLog = (op: "ins" | "upd" | "del", prefix: "NEW" | "OLD", payloadExpr: string, when = "1") => {
        const before = op === "ins" ? "NULL" : oldJson;
        const after = op === "del" ? "NULL" : payloadExpr;
        const accountedBytes =
            `32 + length(CAST('${migId}' AS BLOB)) + length(CAST('${op}' AS BLOB)) + ` +
            `length(CAST('${table.name}' AS BLOB)) + length(CAST(json_quote(CAST(${prefix}.${pkCol} AS TEXT) || '') AS BLOB)) + ` +
            `length(CAST(COALESCE(${before}, '') AS BLOB)) + length(CAST(COALESCE(${after}, '') AS BLOB))`;
        // `before` and `after` are JSON strings inside the outer TailEntry JSON.
        // Doubling their encoded size covers quote/backslash escaping. The fixed
        // allowance covers field names, punctuation, and 64-bit numeric IDs.
        const transferBytes =
            `256 + 2 * (length(CAST('${op}' AS BLOB)) + length(CAST('${table.name}' AS BLOB)) + ` +
            `length(CAST(json_quote(CAST(${prefix}.${pkCol} AS TEXT) || '') AS BLOB)) + ` +
            `length(CAST(COALESCE(${before}, '') AS BLOB)) + length(CAST(COALESCE(${after}, '') AS BLOB)))`;
        return [
            assertPendingTransaction,
            "UPDATE _chardb_split_state SET split_log_rows = split_log_rows + 1, ",
            `split_log_bytes = split_log_bytes + (${accountedBytes}), `,
            `capture_tx_rows = CASE WHEN capture_tx_id IS ${pendingTxId} THEN capture_tx_rows + 1 ELSE 1 END, `,
            `capture_tx_bytes = CASE WHEN capture_tx_id IS ${pendingTxId} `,
            `THEN capture_tx_bytes + (${transferBytes}) ELSE (${transferBytes}) END, `,
            `capture_tx_id = ${pendingTxId} `,
            `WHERE mig_id = '${migId}' AND role = 'source' AND capture = 1 AND (${when}) `,
            `AND ${pendingPlacement} BETWEEN range_lo AND range_hi `,
            `AND split_log_rows < ${capacity.maxRows} `,
            `AND split_log_bytes <= ${capacity.maxBytes} - (${accountedBytes}) `,
            `AND (${transferBytes}) <= ${CDB_SPLIT_TX_MAX_ROW_BYTES} `,
            `AND (${transferBytes}) <= ${CDB_SPLIT_TX_MAX_BYTES} `,
            `AND (capture_tx_id IS NOT ${pendingTxId} OR capture_tx_rows < ${CDB_SPLIT_TX_MAX_ROWS}) `,
            `AND (capture_tx_id IS NOT ${pendingTxId} `,
            `OR capture_tx_bytes <= ${CDB_SPLIT_TX_MAX_BYTES} - (${transferBytes})); `,
            `SELECT CASE WHEN (${when}) AND ${shouldCapture} AND changes() != 1 `,
            "THEN RAISE(ABORT, 'CDB_RATE_LIMITED: source split log capacity reached') END; ",
            "INSERT INTO _chardb_split_log (source_tx_id, mig_id, op, table_name, pk, before, after, ts) ",
            `SELECT ${pendingTxId}, '${migId}', '${op}', '${table.name}', CAST(${prefix}.${pkCol} AS TEXT), ${before}, ${after}, `,
            `CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE (${when}) AND ${shouldCapture}`,
        ].join("");
    };
    const partitionMoveDelete = appendLog("del", "OLD", oldJson, `OLD.${pkCol} IS NOT NEW.${pkCol}`);

    return {
        names: rawNames,
        install: [
            `CREATE TRIGGER IF NOT EXISTS ${insName} AFTER INSERT ON ${t} BEGIN ${appendLog("ins", "NEW", newJson)}; END`,
            `CREATE TRIGGER IF NOT EXISTS ${updName} AFTER UPDATE ON ${t} BEGIN ${partitionMoveDelete}; ${appendLog("upd", "NEW", newJson)}; END`,
            `CREATE TRIGGER IF NOT EXISTS ${delName} AFTER DELETE ON ${t} BEGIN ${appendLog("del", "OLD", oldJson)}; END`,
        ],
        uninstall: [
            `DROP TRIGGER IF EXISTS ${insName}`,
            `DROP TRIGGER IF EXISTS ${updName}`,
            `DROP TRIGGER IF EXISTS ${delName}`,
        ],
    };
}
