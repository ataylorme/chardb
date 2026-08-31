/**
 * Per-shard system tables.
 *
 * `_chardb_op_log` is the at-most-once dedup ledger for mutations: every
 * server-side mutation `INSERT OR IGNORE`s a row keyed
 * `UNIQUE(principal_id, mut_id)` inside the same `transactionSync` as the
 * base write. The dedup horizon (the minimum guaranteed retention) is part
 * of the locked surface; the schema version is part of it too.
 */

import { CdbError } from "../errors.ts";

export const OP_LOG_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_op_log (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT NOT NULL,
  mut_id        TEXT NOT NULL,
  payload_hash  BLOB NOT NULL,
  payload_enc   BLOB NOT NULL,
  committed_at  INTEGER NOT NULL,
  schema_epoch  INTEGER NOT NULL,
  touched_keys  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  placement_vshard INTEGER CHECK (placement_vshard IS NULL OR (placement_vshard >= 0 AND placement_vshard < 16384)),
  UNIQUE(principal_id, mut_id)
);
CREATE INDEX IF NOT EXISTS idx_oplog_principal_time ON _chardb_op_log (principal_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplog_committed_at  ON _chardb_op_log (committed_at);
` as const;

/** Add placement tracking to shards bootstrapped by releases before split-oplog transfer existed. */
export function initializeOpLogPlacement(sql: import("./wrapper.ts").SyncSql): void {
    const columns = sql.all<{ name: string }>("PRAGMA table_info(_chardb_op_log)");
    if (!columns.some(column => column.name === "placement_vshard")) {
        sql.exec(
            `ALTER TABLE _chardb_op_log ADD COLUMN placement_vshard INTEGER
             CHECK (placement_vshard IS NULL OR (placement_vshard >= 0 AND placement_vshard < 16384))`
        );
    }
    sql.exec("CREATE INDEX IF NOT EXISTS idx_oplog_placement_event ON _chardb_op_log (placement_vshard, event_id)");
}

export const SPLIT_LOG_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_split_log (
  lsn        INTEGER PRIMARY KEY AUTOINCREMENT,
  source_tx_id INTEGER NOT NULL,
  mig_id     TEXT NOT NULL,
  op         TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk         TEXT NOT NULL,
  before     BLOB,
  after      BLOB,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS _chardb_split_log_by_migration ON _chardb_split_log (mig_id, lsn);
CREATE TABLE IF NOT EXISTS _chardb_split_oplog (
  lsn        INTEGER PRIMARY KEY AUTOINCREMENT,
  mig_id     TEXT NOT NULL,
  oplog_row  BLOB NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS _chardb_split_state (
  mig_id     TEXT PRIMARY KEY,
  range_lo   INTEGER NOT NULL,
  range_hi   INTEGER NOT NULL,
  role       TEXT NOT NULL,
  capture    INTEGER NOT NULL DEFAULT 0,
  bulk_done  INTEGER NOT NULL DEFAULT 0,
  applied_lsn INTEGER NOT NULL DEFAULT 0,
  acked_lsn INTEGER NOT NULL DEFAULT 0 CHECK (acked_lsn >= 0),
  split_log_rows INTEGER NOT NULL DEFAULT 0 CHECK (split_log_rows >= 0),
  split_log_bytes INTEGER NOT NULL DEFAULT 0 CHECK (split_log_bytes >= 0),
  capture_tx_id INTEGER,
  capture_tx_rows INTEGER NOT NULL DEFAULT 0 CHECK (capture_tx_rows >= 0),
  capture_tx_bytes INTEGER NOT NULL DEFAULT 0 CHECK (capture_tx_bytes >= 0),
  drain_started INTEGER NOT NULL DEFAULT 0 CHECK (drain_started IN (0, 1)),
  abort_started INTEGER NOT NULL DEFAULT 0 CHECK (abort_started IN (0, 1)),
  staged_lsn INTEGER NOT NULL DEFAULT 0 CHECK (staged_lsn >= 0),
  inbox_rows INTEGER NOT NULL DEFAULT 0 CHECK (inbox_rows >= 0),
  inbox_bytes INTEGER NOT NULL DEFAULT 0 CHECK (inbox_bytes >= 0),
  inbox_closed INTEGER NOT NULL DEFAULT 0 CHECK (inbox_closed IN (0, 1)),
  destination_generation INTEGER CHECK (destination_generation IS NULL OR destination_generation > 0),
  destination_serving INTEGER NOT NULL DEFAULT 0 CHECK (destination_serving IN (0, 1)),
  drained    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS _chardb_split_drop_cursor (
  mig_id       TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  after_rowid  INTEGER NOT NULL DEFAULT 0 CHECK (after_rowid >= 0),
  max_rowid    INTEGER CHECK (max_rowid IS NULL OR max_rowid >= 0),
  done         INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (mig_id, table_name)
);
CREATE TABLE IF NOT EXISTS _chardb_split_bulk_watermark (
  mig_id       TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  max_rowid    INTEGER NOT NULL CHECK (max_rowid >= 0),
  PRIMARY KEY (mig_id, table_name)
);
CREATE TABLE IF NOT EXISTS _chardb_split_tail_inbox (
  mig_id TEXT NOT NULL,
  source_tx_id INTEGER NOT NULL CHECK (source_tx_id != 0),
  first_lsn INTEGER NOT NULL CHECK (first_lsn > 0),
  last_lsn INTEGER NOT NULL CHECK (last_lsn >= first_lsn),
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  transaction_json TEXT NOT NULL,
  PRIMARY KEY (mig_id, source_tx_id),
  UNIQUE (mig_id, first_lsn),
  UNIQUE (mig_id, last_lsn)
);
` as const;

export const CDB_SPLIT_LOG_MAX_ROWS = 65_536;
export const CDB_SPLIT_LOG_MAX_BYTES = 64 * 1_024 * 1_024;
/** One source transaction must fit one destination tail-apply RPC. */
export const CDB_SPLIT_TX_MAX_ROWS = 500;
export const CDB_SPLIT_TX_MAX_BYTES = 1 * 1_024 * 1_024;
export const CDB_SPLIT_TX_MAX_ROW_BYTES = 256 * 1_024;

export const SPLIT_LOG_ACCOUNTED_BYTES_SQL = `32 +
  length(CAST(mig_id AS BLOB)) + length(CAST(op AS BLOB)) +
  length(CAST(table_name AS BLOB)) + length(CAST(json_quote(pk) AS BLOB)) +
  length(CAST(COALESCE(before, '') AS BLOB)) +
  length(CAST(COALESCE(after, '') AS BLOB))` as const;

/** Add or reconstruct durable split-log accounting before capture can resume. */
export function initializeSplitLogAccounting(sql: import("./wrapper.ts").SyncSql): void {
    const logColumns = new Set(sql.all<{ name: string }>("PRAGMA table_info(_chardb_split_log)").map(row => row.name));
    const columns = new Set(sql.all<{ name: string }>("PRAGMA table_info(_chardb_split_state)").map(row => row.name));
    if (!logColumns.has("source_tx_id")) {
        sql.exec("ALTER TABLE _chardb_split_log ADD COLUMN source_tx_id INTEGER");
    }
    if (!columns.has("split_log_rows")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN split_log_rows INTEGER NOT NULL DEFAULT 0 CHECK (split_log_rows >= 0)"
        );
    }
    if (!columns.has("acked_lsn")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN acked_lsn INTEGER NOT NULL DEFAULT 0 CHECK (acked_lsn >= 0)"
        );
    }
    if (!columns.has("split_log_bytes")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN split_log_bytes INTEGER NOT NULL DEFAULT 0 CHECK (split_log_bytes >= 0)"
        );
    }
    if (!columns.has("capture_tx_id")) {
        sql.exec("ALTER TABLE _chardb_split_state ADD COLUMN capture_tx_id INTEGER");
    }
    if (!columns.has("destination_generation")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN destination_generation INTEGER CHECK (destination_generation IS NULL OR destination_generation > 0)"
        );
    }
    if (!columns.has("destination_serving")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN destination_serving INTEGER NOT NULL DEFAULT 0 CHECK (destination_serving IN (0, 1))"
        );
    }
    sql.exec(
        "CREATE INDEX IF NOT EXISTS _chardb_split_destination_admission ON _chardb_split_state (role, destination_generation DESC, range_lo, range_hi)"
    );
    if (!columns.has("capture_tx_rows")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN capture_tx_rows INTEGER NOT NULL DEFAULT 0 CHECK (capture_tx_rows >= 0)"
        );
    }
    if (!columns.has("capture_tx_bytes")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN capture_tx_bytes INTEGER NOT NULL DEFAULT 0 CHECK (capture_tx_bytes >= 0)"
        );
    }
    if (!columns.has("drain_started")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN drain_started INTEGER NOT NULL DEFAULT 0 CHECK (drain_started IN (0, 1))"
        );
    }
    if (!columns.has("abort_started")) {
        sql.exec(
            "ALTER TABLE _chardb_split_state ADD COLUMN abort_started INTEGER NOT NULL DEFAULT 0 CHECK (abort_started IN (0, 1))"
        );
    }
    for (const [name, ddl] of [
        ["staged_lsn", "INTEGER NOT NULL DEFAULT 0 CHECK (staged_lsn >= 0)"],
        ["inbox_rows", "INTEGER NOT NULL DEFAULT 0 CHECK (inbox_rows >= 0)"],
        ["inbox_bytes", "INTEGER NOT NULL DEFAULT 0 CHECK (inbox_bytes >= 0)"],
        ["inbox_closed", "INTEGER NOT NULL DEFAULT 0 CHECK (inbox_closed IN (0, 1))"],
    ] as const) {
        if (!columns.has(name)) sql.exec(`ALTER TABLE _chardb_split_state ADD COLUMN ${name} ${ddl}`);
    }
    const inboxSchema = sql.one<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_chardb_split_tail_inbox'"
    )?.sql;
    if (inboxSchema) {
        const normalized = inboxSchema.toLowerCase().replaceAll(/\s+/g, " ");
        const allowsNegative = /check\s*\(\s*source_tx_id\s*(?:!=|<>)\s*0\s*\)/.test(normalized);
        const positiveOnly = /check\s*\(\s*source_tx_id\s*>\s*0\s*\)/.test(normalized);
        if (!allowsNegative) {
            if (!positiveOnly) {
                throw new CdbError({
                    code: "CDB_RESHARD_PHASE_MISMATCH",
                    message: "split tail inbox has an unknown source transaction constraint",
                });
            }
            const inboxRow = sql.one<{ present: number }>("SELECT 1 AS present FROM _chardb_split_tail_inbox LIMIT 1");
            const activeState = sql.one<{ mig_id: string }>(
                "SELECT mig_id FROM _chardb_split_state WHERE drained = 0 ORDER BY mig_id LIMIT 1"
            );
            if (inboxRow || activeState) {
                throw new CdbError({
                    code: "CDB_RESHARD_PHASE_MISMATCH",
                    message: "positive-only split tail inbox cannot upgrade while split state or staged rows exist",
                    hint: "abort or finish the in-progress split before restarting this upgraded Cdb",
                });
            }
            sql.exec("ALTER TABLE _chardb_split_tail_inbox RENAME TO _chardb_split_tail_inbox_positive_only");
            sql.exec(`CREATE TABLE _chardb_split_tail_inbox (
              mig_id TEXT NOT NULL,
              source_tx_id INTEGER NOT NULL CHECK (source_tx_id != 0),
              first_lsn INTEGER NOT NULL CHECK (first_lsn > 0),
              last_lsn INTEGER NOT NULL CHECK (last_lsn >= first_lsn),
              row_count INTEGER NOT NULL CHECK (row_count > 0),
              byte_size INTEGER NOT NULL CHECK (byte_size > 0),
              transaction_json TEXT NOT NULL,
              PRIMARY KEY (mig_id, source_tx_id),
              UNIQUE (mig_id, first_lsn),
              UNIQUE (mig_id, last_lsn)
            )`);
            sql.exec("DROP TABLE _chardb_split_tail_inbox_positive_only");
        }
    }
    const dropColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_split_drop_cursor)").map(row => row.name)
    );
    if (dropColumns.size > 0 && !dropColumns.has("max_rowid")) {
        sql.exec(
            "ALTER TABLE _chardb_split_drop_cursor ADD COLUMN max_rowid INTEGER CHECK (max_rowid IS NULL OR max_rowid >= 0)"
        );
    }
    sql.exec(
        "CREATE INDEX IF NOT EXISTS _chardb_split_log_by_source_tx ON _chardb_split_log (mig_id, source_tx_id, lsn)"
    );
    const legacy = sql.one<{ mig_id: string }>(
        `SELECT l.mig_id
         FROM _chardb_split_log AS l
         JOIN _chardb_split_state AS s ON s.mig_id = l.mig_id
         WHERE s.drained = 0 AND l.source_tx_id IS NULL LIMIT 1`
    );
    if (legacy) {
        throw new CdbError({
            code: "CDB_RESHARD_PHASE_MISMATCH",
            message: `active source split ${legacy.mig_id} contains tail rows without source transaction identity`,
            hint: "abort the in-progress split and start a new migration",
        });
    }
    sql.exec("UPDATE _chardb_split_state SET split_log_rows = 0, split_log_bytes = 0 WHERE drained = 1");
    const active = sql.all<{ mig_id: string }>(
        "SELECT mig_id FROM _chardb_split_state WHERE drained = 0 ORDER BY mig_id LIMIT 2"
    );
    if (active.length > 1) {
        throw new CdbError({
            code: "CDB_RESHARD_PHASE_MISMATCH",
            message: "source shard contains more than one active split during accounting recovery",
        });
    }
    for (const state of active) {
        const sizes = sql.all<{ accounted_bytes: number }>(
            `SELECT ${SPLIT_LOG_ACCOUNTED_BYTES_SQL} AS accounted_bytes
             FROM _chardb_split_log WHERE mig_id = ? ORDER BY lsn LIMIT ?`,
            state.mig_id,
            CDB_SPLIT_LOG_MAX_ROWS + 1
        );
        if (sizes.length > CDB_SPLIT_LOG_MAX_ROWS) {
            throw new CdbError({
                code: "CDB_RESHARD_PHASE_MISMATCH",
                message: `source split log ${state.mig_id} exceeds its ${CDB_SPLIT_LOG_MAX_ROWS}-row recovery limit`,
            });
        }
        let bytes = 0;
        for (const row of sizes) {
            if (!Number.isSafeInteger(row.accounted_bytes) || row.accounted_bytes < 0) {
                throw new CdbError({ code: "CDB_INVARIANT", message: "source split log byte accounting is invalid" });
            }
            bytes += row.accounted_bytes;
            if (!Number.isSafeInteger(bytes) || bytes > CDB_SPLIT_LOG_MAX_BYTES) {
                throw new CdbError({
                    code: "CDB_RESHARD_PHASE_MISMATCH",
                    message: `source split log ${state.mig_id} exceeds its ${CDB_SPLIT_LOG_MAX_BYTES}-byte recovery limit`,
                });
            }
        }
        sql.exec(
            "UPDATE _chardb_split_state SET split_log_rows = ?, split_log_bytes = ? WHERE mig_id = ? AND drained = 0",
            sizes.length,
            bytes,
            state.mig_id
        );
    }
}

export const BARRIER_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_barrier (
  barrier_id     TEXT PRIMARY KEY,
  started_at_local INTEGER NOT NULL,
  bookmark       TEXT
);
` as const;

export const PENDING_MUTATION_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_pending_mutation (
  mut_id        TEXT PRIMARY KEY,
  run_after_ts  INTEGER NOT NULL,
  principal_id  TEXT NOT NULL,
  mutation_ref  TEXT NOT NULL,
  args          TEXT NOT NULL,
  partition_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_mut_due ON _chardb_pending_mutation (run_after_ts);
` as const;

export const SHARD_BOOTSTRAP_DDL = [OP_LOG_DDL, SPLIT_LOG_DDL, BARRIER_DDL, PENDING_MUTATION_DDL].join("\n");
