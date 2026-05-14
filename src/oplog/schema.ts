/**
 * Per-shard system tables.
 *
 * `_chardb_op_log` is the at-most-once dedup ledger for mutations: every
 * server-side mutation `INSERT OR IGNORE`s a row keyed
 * `UNIQUE(principal_id, mut_id)` inside the same `transactionSync` as the
 * base write. The dedup horizon (the minimum guaranteed retention) is part
 * of the locked surface; the schema version is part of it too.
 */

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
  UNIQUE(principal_id, mut_id)
);
CREATE INDEX IF NOT EXISTS idx_oplog_principal_time ON _chardb_op_log (principal_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplog_committed_at  ON _chardb_op_log (committed_at);
` as const;

export const SPLIT_LOG_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_split_log (
  lsn        INTEGER PRIMARY KEY AUTOINCREMENT,
  mig_id     TEXT NOT NULL,
  op         TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk         TEXT NOT NULL,
  before     BLOB,
  after      BLOB,
  ts         INTEGER NOT NULL
);
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
  drained    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
` as const;

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
