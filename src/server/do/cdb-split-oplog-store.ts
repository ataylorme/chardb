import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { bytesEq } from "../../util/canonical.ts";
import { VSHARD_COUNT } from "../../vshard.ts";

export const CDB_SPLIT_OPLOG_MAX_ROWS = 4_096;
export const CDB_SPLIT_OPLOG_MAX_BYTES = 64 * 1_024 * 1_024;
export const CDB_SPLIT_OPLOG_MAX_ROW_BYTES = 1 * 1_024 * 1_024;
export const CDB_SPLIT_OPLOG_MAX_BATCH_ROWS = 64;
export const CDB_SPLIT_OPLOG_MAX_BATCH_BYTES = 4 * 1_024 * 1_024;

export const CDB_SPLIT_OPLOG_STORE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_split_oplog_key (
  mig_id       TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mut_id       TEXT NOT NULL,
  lsn          INTEGER NOT NULL UNIQUE CHECK (lsn > 0),
  PRIMARY KEY (mig_id, principal_id, mut_id)
);
CREATE INDEX IF NOT EXISTS _chardb_split_oplog_migration_lsn
ON _chardb_split_oplog (mig_id, lsn);
CREATE TABLE IF NOT EXISTS _chardb_split_oplog_cursor (
  mig_id       TEXT PRIMARY KEY,
  range_lo     INTEGER NOT NULL CHECK (range_lo >= 0 AND range_lo < 16384),
  range_hi     INTEGER NOT NULL CHECK (range_hi >= range_lo AND range_hi < 16384),
  applied_lsn  INTEGER NOT NULL DEFAULT 0 CHECK (applied_lsn >= 0),
  applied_rows INTEGER NOT NULL DEFAULT 0 CHECK (applied_rows >= 0),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= 0)
);
CREATE TABLE IF NOT EXISTS _chardb_split_oplog_applied (
  mig_id       TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mut_id       TEXT NOT NULL,
  inserted     INTEGER NOT NULL CHECK (inserted IN (0, 1)),
  PRIMARY KEY (mig_id, principal_id, mut_id)
);
CREATE TABLE IF NOT EXISTS _chardb_split_oplog_accounting (
  mig_id         TEXT PRIMARY KEY,
  acked_lsn      INTEGER NOT NULL DEFAULT 0 CHECK (acked_lsn >= 0),
  retained_rows  INTEGER NOT NULL DEFAULT 0 CHECK (retained_rows >= 0),
  retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retained_bytes >= 0),
  seed_after_event_id INTEGER NOT NULL DEFAULT 0 CHECK (seed_after_event_id >= 0),
  seed_max_event_id INTEGER NOT NULL DEFAULT 0 CHECK (seed_max_event_id >= 0),
  seed_done       INTEGER NOT NULL DEFAULT 1 CHECK (seed_done IN (0, 1)),
  updated_at     INTEGER NOT NULL CHECK (updated_at >= 0)
);
` as const;

interface StoredOpLogRow {
    readonly principal_id: string;
    readonly mut_id: string;
    readonly payload_hash: Uint8Array | ArrayBuffer;
    readonly payload_enc: Uint8Array | ArrayBuffer;
    readonly committed_at: number;
    readonly schema_epoch: number;
    readonly touched_keys: string;
    readonly byte_size: number;
    readonly placement_vshard: number | null;
}

interface CapturedOpLogV1 {
    readonly v: 1;
    readonly vshard: number;
    readonly principalId: string;
    readonly mutId: string;
    readonly payloadHash: string;
    readonly payloadEnc: string;
    readonly committedAt: number;
    readonly schemaEpoch: number;
    readonly touchedKeys: string;
    readonly byteSize: number;
}

export interface SplitOpLogEntry {
    readonly lsn: number;
    readonly oplogRow: Uint8Array;
}

export interface SplitOpLogBatch {
    readonly entries: readonly SplitOpLogEntry[];
    readonly lastLsn: number;
    readonly done: boolean;
}

export interface SplitOpLogApplyResult {
    readonly applied: number;
    readonly replayed: number;
    readonly lastLsn: number;
}

export interface SplitOpLogAckResult {
    readonly pruned: number;
    readonly prunedBytes: number;
    readonly ackedLsn: number;
}

/** Rebuild bounded source accounting after an upgrade or isolate restart. */
export function initializeSplitOpLogAccounting(sql: SyncSql, nowMs = Date.now()): void {
    const columns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_split_oplog_accounting)").map(column => column.name)
    );
    if (!columns.has("seed_after_event_id")) {
        sql.exec(
            "ALTER TABLE _chardb_split_oplog_accounting ADD COLUMN seed_after_event_id INTEGER NOT NULL DEFAULT 0 CHECK (seed_after_event_id >= 0)"
        );
    }
    if (!columns.has("seed_max_event_id")) {
        sql.exec(
            "ALTER TABLE _chardb_split_oplog_accounting ADD COLUMN seed_max_event_id INTEGER NOT NULL DEFAULT 0 CHECK (seed_max_event_id >= 0)"
        );
    }
    if (!columns.has("seed_done")) {
        sql.exec(
            "ALTER TABLE _chardb_split_oplog_accounting ADD COLUMN seed_done INTEGER NOT NULL DEFAULT 1 CHECK (seed_done IN (0, 1))"
        );
    }
    const active = sql.all<{ mig_id: string }>(
        `SELECT mig_id FROM _chardb_split_state
         WHERE role = 'source' AND drained = 0 ORDER BY mig_id LIMIT 2`
    );
    if (active.length > 1) throw splitPhase("source shard contains more than one active split-oplog capture");
    for (const state of active) {
        const prior = sql.one<{ acked_lsn: number }>(
            "SELECT acked_lsn FROM _chardb_split_oplog_accounting WHERE mig_id = ?",
            state.mig_id
        );
        const ackedLsn = prior?.acked_lsn ?? 0;
        assertCursor(ackedLsn);
        const rows = sql.all<{ lsn: number; bytes: number }>(
            `SELECT lsn, length(oplog_row) AS bytes FROM _chardb_split_oplog
             WHERE mig_id = ? ORDER BY lsn LIMIT ?`,
            state.mig_id,
            CDB_SPLIT_OPLOG_MAX_ROWS + 1
        );
        if (rows.length > CDB_SPLIT_OPLOG_MAX_ROWS) {
            throw splitPhase("retained split-oplog exceeds its row recovery limit");
        }
        let bytes = 0;
        for (const row of rows) {
            assertCursor(row.lsn);
            if (row.lsn <= ackedLsn) throw invariant("acknowledged split-oplog row was not pruned");
            if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > CDB_SPLIT_OPLOG_MAX_ROW_BYTES) {
                throw invariant("stored split-oplog row has invalid byte accounting");
            }
            bytes += row.bytes;
            if (!Number.isSafeInteger(bytes) || bytes > CDB_SPLIT_OPLOG_MAX_BYTES) {
                throw splitPhase("retained split-oplog exceeds its byte recovery limit");
            }
        }
        sql.exec(
            `INSERT INTO _chardb_split_oplog_accounting
             (mig_id, acked_lsn, retained_rows, retained_bytes, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(mig_id) DO UPDATE SET
               retained_rows = excluded.retained_rows,
               retained_bytes = excluded.retained_bytes,
               updated_at = excluded.updated_at`,
            state.mig_id,
            ackedLsn,
            rows.length,
            bytes,
            nowMs
        );
    }
}

/** Capture the final replay envelope for every active source split containing this placed mutation. */
export function captureSplitOpLogOutcome(input: {
    readonly sql: SyncSql;
    readonly principalId: string;
    readonly mutId: string;
    readonly vshard: number;
    readonly nowMs?: number;
}): number {
    assertVshard(input.vshard);
    const splits = input.sql.all<{ mig_id: string }>(
        `SELECT mig_id FROM _chardb_split_state
         WHERE role = 'source' AND capture = 1 AND drained = 0 AND range_lo <= ? AND range_hi >= ?
         ORDER BY mig_id LIMIT 2`,
        input.vshard,
        input.vshard
    );
    if (splits.length > 1) throw invariant("overlapping active split-oplog capture ranges");
    const split = splits[0];
    if (!split) return 0;

    const row = input.sql.one<StoredOpLogRow>(
        `SELECT principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
                touched_keys, byte_size, placement_vshard
         FROM _chardb_op_log WHERE principal_id = ? AND mut_id = ?`,
        input.principalId,
        input.mutId
    );
    if (!row) throw invariant("committed mutation op-log row disappeared before split capture");
    const encoded = encodeCapturedRow(row, input.vshard);
    if (encoded.byteLength > CDB_SPLIT_OPLOG_MAX_ROW_BYTES) {
        throw splitBacklog("one replay outcome exceeds the split-oplog row limit");
    }

    ensureSourceAccounting(input.sql, split.mig_id, input.nowMs ?? Date.now());

    return captureEncodedForMigration(input.sql, {
        migId: split.mig_id,
        principalId: input.principalId,
        mutId: input.mutId,
        encoded,
        nowMs: input.nowMs ?? Date.now(),
    });
}

/** Seed retained placed outcomes before source capture begins serving writes. */
export function seedSplitOpLogRange(
    sql: SyncSql,
    input: { readonly migId: string; readonly rangeLo: number; readonly rangeHi: number },
    nowMs = Date.now()
): number {
    assertRange(input.rangeLo, input.rangeHi);
    const existing = sql.one<{ found: number }>(
        "SELECT 1 AS found FROM _chardb_split_oplog_accounting WHERE mig_id = ?",
        input.migId
    );
    if (existing) return 0;
    const maxEventId =
        sql.one<{ max_event_id: number | null }>(
            `SELECT MAX(event_id) AS max_event_id FROM _chardb_op_log
             WHERE placement_vshard >= ? AND placement_vshard <= ?`,
            input.rangeLo,
            input.rangeHi
        )?.max_event_id ?? 0;
    if (!Number.isSafeInteger(maxEventId) || maxEventId < 0) throw invariant("split-oplog seed watermark is invalid");
    sql.exec(
        `INSERT OR IGNORE INTO _chardb_split_oplog_accounting
         (mig_id, acked_lsn, retained_rows, retained_bytes,
          seed_after_event_id, seed_max_event_id, seed_done, updated_at)
         VALUES (?, 0, 0, 0, 0, ?, ?, ?)`,
        input.migId,
        maxEventId,
        maxEventId === 0 ? 1 : 0,
        nowMs
    );
    return 0;
}

/** Materialize one bounded page of the begin-time retained-history snapshot. */
function seedSplitOpLogPage(sql: SyncSql, migId: string, nowMs: number): number {
    const accounting = requiredSourceAccounting(sql, migId);
    if (accounting.seed_done === 1) return 0;
    const state = sql.one<{ range_lo: number; range_hi: number }>(
        "SELECT range_lo, range_hi FROM _chardb_split_state WHERE mig_id = ? AND role = 'source' AND drained = 0",
        migId
    );
    if (!state) throw invariant("active split-oplog seed has no source split state");
    assertRange(state.range_lo, state.range_hi);
    const availableRows = CDB_SPLIT_OPLOG_MAX_ROWS - accounting.retained_rows;
    if (availableRows < 1) return 0;
    const rows = sql.all<StoredOpLogRow & { placement_vshard: number; event_id: number }>(
        `SELECT event_id, principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
                touched_keys, byte_size, placement_vshard
         FROM _chardb_op_log
         WHERE placement_vshard >= ? AND placement_vshard <= ?
           AND event_id > ? AND event_id <= ?
         ORDER BY event_id LIMIT ?`,
        state.range_lo,
        state.range_hi,
        accounting.seed_after_event_id,
        accounting.seed_max_event_id,
        Math.min(CDB_SPLIT_OPLOG_MAX_BATCH_ROWS, availableRows)
    );
    let captured = 0;
    let afterEventId = accounting.seed_after_event_id;
    let retainedBytes = accounting.retained_bytes;
    for (const row of rows) {
        assertVshard(row.placement_vshard);
        if (!Number.isSafeInteger(row.event_id) || row.event_id <= afterEventId) {
            throw invariant("split-oplog seed event cursor is invalid");
        }
        const encoded = encodeCapturedRow(row, row.placement_vshard);
        if (encoded.byteLength > CDB_SPLIT_OPLOG_MAX_ROW_BYTES) {
            throw splitBacklog("one retained replay outcome exceeds the split-oplog row limit");
        }
        if (retainedBytes + encoded.byteLength > CDB_SPLIT_OPLOG_MAX_BYTES) break;
        captured += captureEncodedForMigration(sql, {
            migId,
            principalId: row.principal_id,
            mutId: row.mut_id,
            encoded,
            nowMs,
        });
        retainedBytes += encoded.byteLength;
        afterEventId = row.event_id;
    }
    const done = afterEventId >= accounting.seed_max_event_id || rows.length === 0;
    sql.exec(
        `UPDATE _chardb_split_oplog_accounting
         SET seed_after_event_id = ?, seed_done = ?, updated_at = ?
         WHERE mig_id = ? AND seed_after_event_id = ? AND seed_done = 0`,
        afterEventId,
        done ? 1 : 0,
        nowMs,
        migId,
        accounting.seed_after_event_id
    );
    if (sql.changes() !== 1) throw invariant("split-oplog seed cursor changed concurrently");
    return captured;
}

/** Prune only outcomes accepted by the destination and durably cursor-recorded by the Resharder. */
export function ackSplitOpLog(
    sql: SyncSql,
    migId: string,
    throughLsn: number,
    nowMs = Date.now()
): SplitOpLogAckResult {
    assertCursor(throughLsn);
    const accounting = requiredSourceAccounting(sql, migId);
    if (throughLsn < accounting.acked_lsn) throw invalid("split-oplog acknowledgement regressed");
    if (throughLsn === accounting.acked_lsn) return { pruned: 0, prunedBytes: 0, ackedLsn: throughLsn };
    const endpoint = sql.one<{ found: number }>(
        "SELECT 1 AS found FROM _chardb_split_oplog WHERE mig_id = ? AND lsn = ?",
        migId,
        throughLsn
    );
    if (!endpoint) throw invalid("split-oplog acknowledgement must end at a retained row");
    const rows = sql.all<{ bytes: number }>(
        `SELECT length(oplog_row) AS bytes FROM _chardb_split_oplog
         WHERE mig_id = ? AND lsn > ? AND lsn <= ? ORDER BY lsn LIMIT ?`,
        migId,
        accounting.acked_lsn,
        throughLsn,
        CDB_SPLIT_OPLOG_MAX_ROWS + 1
    );
    if (rows.length < 1 || rows.length > CDB_SPLIT_OPLOG_MAX_ROWS) {
        throw invariant("split-oplog acknowledgement span is invalid");
    }
    let bytes = 0;
    for (const row of rows) {
        if (!Number.isSafeInteger(row.bytes) || row.bytes < 1) throw invariant("split-oplog prune size is invalid");
        bytes += row.bytes;
    }
    if (!Number.isSafeInteger(bytes) || rows.length > accounting.retained_rows || bytes > accounting.retained_bytes) {
        throw invariant("split-oplog acknowledgement exceeds durable accounting");
    }
    sql.exec("DELETE FROM _chardb_split_oplog_key WHERE mig_id = ? AND lsn <= ?", migId, throughLsn);
    sql.exec("DELETE FROM _chardb_split_oplog WHERE mig_id = ? AND lsn <= ?", migId, throughLsn);
    if (sql.changes() !== rows.length) throw invariant("split-oplog prune count differs from its acknowledged span");
    sql.exec(
        `UPDATE _chardb_split_oplog_accounting
         SET acked_lsn = ?, retained_rows = retained_rows - ?, retained_bytes = retained_bytes - ?, updated_at = ?
         WHERE mig_id = ? AND acked_lsn = ?
           AND retained_rows >= ? AND retained_bytes >= ?`,
        throughLsn,
        rows.length,
        bytes,
        nowMs,
        migId,
        accounting.acked_lsn,
        rows.length,
        bytes
    );
    if (sql.changes() !== 1) throw invariant("split-oplog acknowledgement cursor changed concurrently");
    return { pruned: rows.length, prunedBytes: bytes, ackedLsn: throughLsn };
}

export function beginSplitOpLogDestination(
    sql: SyncSql,
    input: { readonly migId: string; readonly rangeLo: number; readonly rangeHi: number },
    nowMs = Date.now()
): void {
    assertRange(input.rangeLo, input.rangeHi);
    sql.exec(
        `INSERT OR IGNORE INTO _chardb_split_oplog_cursor
         (mig_id, range_lo, range_hi, applied_lsn, applied_rows, updated_at)
         VALUES (?, ?, ?, 0, 0, ?)`,
        input.migId,
        input.rangeLo,
        input.rangeHi,
        nowMs
    );
    const cursor = requiredCursor(sql, input.migId);
    if (cursor.range_lo !== input.rangeLo || cursor.range_hi !== input.rangeHi) {
        throw invariant("split-oplog destination migration id belongs to a different range");
    }
}

export function readSplitOpLogBatch(
    sql: SyncSql,
    input: { readonly migId: string; readonly afterLsn: number; readonly limit: number }
): SplitOpLogBatch {
    assertCursor(input.afterLsn);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CDB_SPLIT_OPLOG_MAX_BATCH_ROWS) {
        throw invalid(`split-oplog batch limit must be from 1 through ${CDB_SPLIT_OPLOG_MAX_BATCH_ROWS}`);
    }
    seedSplitOpLogPage(sql, input.migId, Date.now());
    const rows = sql.all<{ lsn: number; oplog_row: Uint8Array | ArrayBuffer }>(
        `SELECT lsn, oplog_row FROM _chardb_split_oplog
         WHERE mig_id = ? AND lsn > ? ORDER BY lsn LIMIT ?`,
        input.migId,
        input.afterLsn,
        input.limit + 1
    );
    const entries: SplitOpLogEntry[] = [];
    let bytes = 0;
    for (const row of rows) {
        if (entries.length >= input.limit) break;
        assertCursor(row.lsn);
        const oplogRow = asBytes(row.oplog_row).slice();
        if (oplogRow.byteLength < 1 || oplogRow.byteLength > CDB_SPLIT_OPLOG_MAX_ROW_BYTES) {
            throw invariant("stored split-oplog row exceeds its encoded byte limit");
        }
        if (entries.length > 0 && bytes + oplogRow.byteLength > CDB_SPLIT_OPLOG_MAX_BATCH_BYTES) break;
        entries.push({ lsn: row.lsn, oplogRow });
        bytes += oplogRow.byteLength;
    }
    const lastLsn = entries.at(-1)?.lsn ?? input.afterLsn;
    const remains = sql.one<{ found: number }>(
        "SELECT 1 AS found FROM _chardb_split_oplog WHERE mig_id = ? AND lsn > ? LIMIT 1",
        input.migId,
        lastLsn
    );
    const accounting = requiredSourceAccounting(sql, input.migId);
    return { entries, lastLsn, done: remains === null && accounting.seed_done === 1 };
}

/** Apply one source batch and advance the destination cursor in the same transaction. */
export function applySplitOpLogBatch(
    sql: SyncSql,
    input: {
        readonly migId: string;
        readonly rangeLo: number;
        readonly rangeHi: number;
        readonly entries: readonly SplitOpLogEntry[];
        readonly nowMs?: number;
    }
): SplitOpLogApplyResult {
    assertRange(input.rangeLo, input.rangeHi);
    if (!Array.isArray(input.entries) || input.entries.length > CDB_SPLIT_OPLOG_MAX_BATCH_ROWS) {
        throw invalid(`split-oplog batch contains more than ${CDB_SPLIT_OPLOG_MAX_BATCH_ROWS} rows`);
    }
    const cursor = requiredCursor(sql, input.migId);
    if (cursor.range_lo !== input.rangeLo || cursor.range_hi !== input.rangeHi) {
        throw invariant("split-oplog apply range differs from its durable destination identity");
    }
    let previousLsn = 0;
    let encodedBytes = 0;
    const decoded = input.entries.map(entry => {
        assertCursor(entry.lsn);
        if (entry.lsn <= previousLsn) throw invalid("split-oplog batch LSNs must be strictly increasing");
        previousLsn = entry.lsn;
        if (!(entry.oplogRow instanceof Uint8Array)) throw invalid("split-oplog row must be a byte array");
        encodedBytes += entry.oplogRow.byteLength;
        if (
            entry.oplogRow.byteLength < 1 ||
            entry.oplogRow.byteLength > CDB_SPLIT_OPLOG_MAX_ROW_BYTES ||
            encodedBytes > CDB_SPLIT_OPLOG_MAX_BATCH_BYTES
        ) {
            throw invalid("split-oplog batch exceeds its encoded byte limit");
        }
        const row = decodeCapturedRow(entry.oplogRow);
        if (row.vshard < input.rangeLo || row.vshard > input.rangeHi) {
            throw invariant("split-oplog row falls outside its destination range");
        }
        return { lsn: entry.lsn, row };
    });
    if (decoded.length > 0) {
        const first = decoded[0];
        const last = decoded.at(-1);
        if (!first || !last) throw invariant("non-empty split-oplog batch lost its boundary rows");
        const allReplayed = last.lsn <= cursor.applied_lsn;
        const allNew = first.lsn > cursor.applied_lsn;
        if (!allReplayed && !allNew) throw invariant("split-oplog batch crosses its durable apply cursor");
    }

    let applied = 0;
    let replayed = 0;
    for (const entry of decoded) {
        const row = entry.row;
        const priorApply = sql.one<{ inserted: number }>(
            `SELECT inserted FROM _chardb_split_oplog_applied
             WHERE mig_id = ? AND principal_id = ? AND mut_id = ?`,
            input.migId,
            row.principalId,
            row.mutId
        );
        sql.exec(
            `INSERT OR IGNORE INTO _chardb_op_log
             (principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
              touched_keys, byte_size, placement_vshard)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            row.principalId,
            row.mutId,
            row.payloadHash,
            row.payloadEnc,
            row.committedAt,
            row.schemaEpoch,
            row.touchedKeys,
            row.byteSize,
            row.vshard
        );
        const inserted = sql.changes() === 1;
        if (priorApply && inserted) {
            throw invariant("destination split-oplog ledger exists without its reconstructed op-log row");
        }
        if (inserted) {
            applied++;
        } else {
            const existing = sql.one<StoredOpLogRow>(
                `SELECT principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
                        touched_keys, byte_size, placement_vshard
                 FROM _chardb_op_log WHERE principal_id = ? AND mut_id = ?`,
                row.principalId,
                row.mutId
            );
            if (!existing || !sameOpLogRow(existing, row)) {
                throw collision(row.mutId, "destination has a different replay outcome for this mutation id");
            }
            replayed++;
        }
        if (!priorApply) {
            sql.exec(
                `INSERT INTO _chardb_split_oplog_applied (mig_id, principal_id, mut_id, inserted)
                 VALUES (?, ?, ?, ?)`,
                input.migId,
                row.principalId,
                row.mutId,
                inserted ? 1 : 0
            );
        } else if (priorApply.inserted !== 0 && priorApply.inserted !== 1) {
            throw invariant("destination split-oplog ledger is malformed");
        }
    }
    const lastLsn = decoded.at(-1)?.lsn ?? cursor.applied_lsn;
    if (lastLsn > cursor.applied_lsn) {
        sql.exec(
            `UPDATE _chardb_split_oplog_cursor
             SET applied_lsn = ?, applied_rows = applied_rows + ?, updated_at = ?
             WHERE mig_id = ? AND applied_lsn = ?`,
            lastLsn,
            applied,
            input.nowMs ?? Date.now(),
            input.migId,
            cursor.applied_lsn
        );
        if (sql.changes() !== 1) throw invariant("split-oplog destination cursor changed during apply");
    }
    return { applied, replayed, lastLsn };
}

/** Remove transfer-only state, and on abort remove only op-log rows this migration inserted. */
export function finalizeSplitOpLogDestination(sql: SyncSql, migId: string, abort: boolean): void {
    if (abort) {
        sql.exec(
            `DELETE FROM _chardb_op_log
             WHERE EXISTS (
               SELECT 1 FROM _chardb_split_oplog_applied applied
               WHERE applied.mig_id = ?
                 AND applied.inserted = 1
                 AND applied.principal_id = _chardb_op_log.principal_id
                 AND applied.mut_id = _chardb_op_log.mut_id
             )`,
            migId
        );
    }
    sql.exec("DELETE FROM _chardb_split_oplog_applied WHERE mig_id = ?", migId);
    sql.exec("DELETE FROM _chardb_split_oplog_cursor WHERE mig_id = ?", migId);
}

/** Remove source capture artifacts after success or a pre-fence abort. */
export function finalizeSplitOpLogSource(sql: SyncSql, migId: string): void {
    sql.exec("DELETE FROM _chardb_split_oplog_key WHERE mig_id = ?", migId);
    sql.exec("DELETE FROM _chardb_split_oplog WHERE mig_id = ?", migId);
    sql.exec("DELETE FROM _chardb_split_oplog_accounting WHERE mig_id = ?", migId);
}

function captureEncodedForMigration(
    sql: SyncSql,
    input: {
        readonly migId: string;
        readonly principalId: string;
        readonly mutId: string;
        readonly encoded: Uint8Array;
        readonly nowMs: number;
    }
): number {
    const prior = sql.one<{ lsn: number }>(
        `SELECT lsn FROM _chardb_split_oplog_key
         WHERE mig_id = ? AND principal_id = ? AND mut_id = ?`,
        input.migId,
        input.principalId,
        input.mutId
    );
    if (prior) {
        const captured = sql.one<{ oplog_row: Uint8Array | ArrayBuffer }>(
            "SELECT oplog_row FROM _chardb_split_oplog WHERE mig_id = ? AND lsn = ?",
            input.migId,
            prior.lsn
        );
        if (!captured || !bytesEq(asBytes(captured.oplog_row), input.encoded)) {
            throw collision(input.mutId, "captured split outcome differs from the committed op-log row");
        }
        return 0;
    }

    requiredSourceAccounting(sql, input.migId);
    sql.exec(
        `UPDATE _chardb_split_oplog_accounting
         SET retained_rows = retained_rows + 1, retained_bytes = retained_bytes + ?, updated_at = ?
         WHERE mig_id = ? AND retained_rows < ? AND retained_bytes <= ? - ?`,
        input.encoded.byteLength,
        input.nowMs,
        input.migId,
        CDB_SPLIT_OPLOG_MAX_ROWS,
        CDB_SPLIT_OPLOG_MAX_BYTES,
        input.encoded.byteLength
    );
    if (sql.changes() !== 1) {
        throw splitBacklog("split-oplog backlog reached its durable capture limit");
    }
    sql.exec(
        "INSERT INTO _chardb_split_oplog (mig_id, oplog_row, ts) VALUES (?, ?, ?)",
        input.migId,
        input.encoded,
        input.nowMs
    );
    const inserted = sql.one<{ lsn: number }>("SELECT last_insert_rowid() AS lsn");
    if (!inserted || !Number.isSafeInteger(inserted.lsn) || inserted.lsn < 1) {
        throw invariant("split-oplog insert did not return a valid LSN");
    }
    sql.exec(
        `INSERT INTO _chardb_split_oplog_key (mig_id, principal_id, mut_id, lsn)
         VALUES (?, ?, ?, ?)`,
        input.migId,
        input.principalId,
        input.mutId,
        inserted.lsn
    );
    return 1;
}

function ensureSourceAccounting(sql: SyncSql, migId: string, nowMs: number): void {
    sql.exec(
        `INSERT OR IGNORE INTO _chardb_split_oplog_accounting
         (mig_id, acked_lsn, retained_rows, retained_bytes, updated_at) VALUES (?, 0, 0, 0, ?)`,
        migId,
        nowMs
    );
}

function requiredSourceAccounting(
    sql: SyncSql,
    migId: string
): {
    readonly acked_lsn: number;
    readonly retained_rows: number;
    readonly retained_bytes: number;
    readonly seed_after_event_id: number;
    readonly seed_max_event_id: number;
    readonly seed_done: number;
} {
    const row = sql.one<{
        acked_lsn: number;
        retained_rows: number;
        retained_bytes: number;
        seed_after_event_id: number;
        seed_max_event_id: number;
        seed_done: number;
    }>(
        `SELECT acked_lsn, retained_rows, retained_bytes, seed_after_event_id, seed_max_event_id, seed_done
         FROM _chardb_split_oplog_accounting
         WHERE mig_id = ?`,
        migId
    );
    if (
        !row ||
        !Number.isSafeInteger(row.acked_lsn) ||
        !Number.isSafeInteger(row.retained_rows) ||
        !Number.isSafeInteger(row.retained_bytes) ||
        !Number.isSafeInteger(row.seed_after_event_id) ||
        !Number.isSafeInteger(row.seed_max_event_id) ||
        row.acked_lsn < 0 ||
        row.retained_rows < 0 ||
        row.retained_bytes < 0 ||
        row.seed_after_event_id < 0 ||
        row.seed_max_event_id < row.seed_after_event_id ||
        (row.seed_done !== 0 && row.seed_done !== 1) ||
        row.retained_rows > CDB_SPLIT_OPLOG_MAX_ROWS ||
        row.retained_bytes > CDB_SPLIT_OPLOG_MAX_BYTES
    ) {
        throw invariant("split-oplog durable accounting is missing or malformed");
    }
    return row;
}

function encodeCapturedRow(row: StoredOpLogRow, vshard: number): Uint8Array {
    const payloadHash = asBytes(row.payload_hash);
    const payloadEnc = asBytes(row.payload_enc);
    if (
        typeof row.principal_id !== "string" ||
        typeof row.mut_id !== "string" ||
        payloadHash.byteLength !== 32 ||
        payloadEnc.byteLength < 1 ||
        !Number.isSafeInteger(row.committed_at) ||
        row.committed_at < 0 ||
        !Number.isSafeInteger(row.schema_epoch) ||
        row.schema_epoch < 1 ||
        typeof row.touched_keys !== "string" ||
        !Number.isSafeInteger(row.byte_size) ||
        row.byte_size !== payloadEnc.byteLength ||
        row.placement_vshard !== vshard
    ) {
        throw invariant("committed mutation op-log row is malformed");
    }
    const captured: CapturedOpLogV1 = {
        v: 1,
        vshard,
        principalId: row.principal_id,
        mutId: row.mut_id,
        payloadHash: bytesToBase64(payloadHash),
        payloadEnc: bytesToBase64(payloadEnc),
        committedAt: row.committed_at,
        schemaEpoch: row.schema_epoch,
        touchedKeys: row.touched_keys,
        byteSize: row.byte_size,
    };
    return new TextEncoder().encode(JSON.stringify(captured));
}

function decodeCapturedRow(bytes: Uint8Array): {
    readonly vshard: number;
    readonly principalId: string;
    readonly mutId: string;
    readonly payloadHash: Uint8Array;
    readonly payloadEnc: Uint8Array;
    readonly committedAt: number;
    readonly schemaEpoch: number;
    readonly touchedKeys: string;
    readonly byteSize: number;
} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (cause) {
        throw invariant("split-oplog row is not valid JSON", cause);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invariant("split-oplog row is malformed");
    const row = parsed as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    const expected = [
        "byteSize",
        "committedAt",
        "mutId",
        "payloadEnc",
        "payloadHash",
        "principalId",
        "schemaEpoch",
        "touchedKeys",
        "v",
        "vshard",
    ].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw invariant("split-oplog row has an unexpected shape");
    }
    if (
        row.v !== 1 ||
        typeof row.principalId !== "string" ||
        typeof row.mutId !== "string" ||
        typeof row.payloadHash !== "string" ||
        typeof row.payloadEnc !== "string" ||
        !Number.isSafeInteger(row.committedAt) ||
        (row.committedAt as number) < 0 ||
        !Number.isSafeInteger(row.schemaEpoch) ||
        (row.schemaEpoch as number) < 1 ||
        typeof row.touchedKeys !== "string" ||
        !Number.isSafeInteger(row.byteSize) ||
        (row.byteSize as number) < 1 ||
        !Number.isSafeInteger(row.vshard)
    ) {
        throw invariant("split-oplog row contains invalid fields");
    }
    assertVshard(row.vshard as number);
    const payloadHash = base64ToBytes(row.payloadHash);
    const payloadEnc = base64ToBytes(row.payloadEnc);
    if (payloadHash.byteLength !== 32 || payloadEnc.byteLength !== row.byteSize) {
        throw invariant("split-oplog row contains invalid payload bytes");
    }
    return {
        vshard: row.vshard as number,
        principalId: row.principalId,
        mutId: row.mutId,
        payloadHash,
        payloadEnc,
        committedAt: row.committedAt as number,
        schemaEpoch: row.schemaEpoch as number,
        touchedKeys: row.touchedKeys,
        byteSize: row.byteSize as number,
    };
}

function sameOpLogRow(stored: StoredOpLogRow, incoming: ReturnType<typeof decodeCapturedRow>): boolean {
    return (
        stored.principal_id === incoming.principalId &&
        stored.mut_id === incoming.mutId &&
        bytesEq(asBytes(stored.payload_hash), incoming.payloadHash) &&
        bytesEq(asBytes(stored.payload_enc), incoming.payloadEnc) &&
        stored.committed_at === incoming.committedAt &&
        stored.schema_epoch === incoming.schemaEpoch &&
        stored.touched_keys === incoming.touchedKeys &&
        stored.byte_size === incoming.byteSize &&
        stored.placement_vshard === incoming.vshard
    );
}

function requiredCursor(
    sql: SyncSql,
    migId: string
): {
    readonly range_lo: number;
    readonly range_hi: number;
    readonly applied_lsn: number;
} {
    const row = sql.one<{ range_lo: number; range_hi: number; applied_lsn: number }>(
        "SELECT range_lo, range_hi, applied_lsn FROM _chardb_split_oplog_cursor WHERE mig_id = ?",
        migId
    );
    if (!row) throw invariant("split-oplog destination cursor is missing");
    assertRange(row.range_lo, row.range_hi);
    assertCursor(row.applied_lsn);
    return row;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 32_768;
    for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    let binary: string;
    try {
        binary = atob(value);
    } catch (cause) {
        throw invariant("split-oplog row contains invalid base64", cause);
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function assertRange(lo: number, hi: number): void {
    assertVshard(lo);
    assertVshard(hi);
    if (lo > hi) throw invalid("split-oplog range is invalid");
}

function assertVshard(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= VSHARD_COUNT) {
        throw invalid("split-oplog vshard is invalid");
    }
}

function assertCursor(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid("split-oplog cursor is invalid");
}

function invalid(message: string): CdbError {
    return new CdbError({ code: "CDB_INVALID_ARGS", message });
}

function invariant(message: string, cause?: unknown): CdbError {
    return new CdbError({ code: "CDB_INVARIANT", message, ...(cause === undefined ? {} : { cause }) });
}

function collision(mutId: string, message: string): CdbError {
    return new CdbError({
        code: "CDB_MUT_ID_COLLISION",
        message: `mutId=${mutId} ${message}`,
        hint: "stop the split and inspect both op-log rows before retrying",
    });
}

function splitBacklog(message: string): CdbError {
    return new CdbError({
        code: "CDB_RATE_LIMITED",
        message,
        hint: "retry after the active split copies its captured mutation outcomes",
    });
}

function splitPhase(message: string): CdbError {
    return new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message });
}
