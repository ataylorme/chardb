import { CdbError } from "../errors.ts";
import type { SyncSql } from "../oplog/wrapper.ts";

const MAX_CAPTURE_SEQUENCE = Number.MAX_SAFE_INTEGER;

export const CDB_EXTERNAL_RESHARD_CAPTURE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_split_capture_tx (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_id INTEGER NOT NULL CHECK (next_id >= 0 AND next_id <= ${MAX_CAPTURE_SEQUENCE}),
  active_id INTEGER CHECK (active_id IS NULL OR (active_id < 0 AND active_id >= -${MAX_CAPTURE_SEQUENCE})),
  active_vshard INTEGER CHECK (active_vshard IS NULL OR (active_vshard >= 0 AND active_vshard < 16384)),
  CHECK ((active_id IS NULL) = (active_vshard IS NULL))
);
INSERT OR IGNORE INTO _chardb_split_capture_tx (singleton, next_id, active_id, active_vshard)
VALUES (1, 0, NULL, NULL);
` as const;

interface CaptureState {
    readonly next_id: number;
    readonly active_id: number | null;
}

function placementVshard(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 16_384) {
        throw new Error("external reshard capture placement is invalid");
    }
    return value;
}

export function initializeExternalReshardCapture(sql: SyncSql): void {
    for (const statement of CDB_EXTERNAL_RESHARD_CAPTURE_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
}

/** Start one external side-state change. Call inside the owning SQLite transaction. */
export function beginExternalReshardCapture(sql: SyncSql, placement: number): number {
    const canonicalPlacement = placementVshard(placement);
    const routingFencesPresent = sql.one<{ present: number }>(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_chardb_routing_fences'"
    );
    const frozen = routingFencesPresent
        ? sql.one<{ present: number }>(
              `SELECT 1 AS present FROM _chardb_routing_fences
               WHERE ? BETWEEN range_lo AND range_hi AND status IN ('active', 'cleaned')
               LIMIT 1`,
              canonicalPlacement
          )
        : null;
    if (frozen) {
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: "external state delivery is frozen on the moved source range",
        });
    }
    const pending = sql.one<{ present: number }>(
        "SELECT 1 AS present FROM _chardb_op_log WHERE byte_size = 0 AND length(payload_enc) = 0 LIMIT 1"
    );
    if (pending) throw new Error("external reshard capture cannot overlap a registered mutation transaction");
    sql.exec(
        `UPDATE _chardb_split_capture_tx
         SET next_id = next_id + 1, active_id = -(next_id + 1), active_vshard = ?
         WHERE singleton = 1 AND active_id IS NULL AND next_id < ?`,
        canonicalPlacement,
        MAX_CAPTURE_SEQUENCE
    );
    if (sql.changes() !== 1) {
        const state = sql.one<CaptureState>(
            "SELECT next_id, active_id FROM _chardb_split_capture_tx WHERE singleton = 1"
        );
        if (state?.active_id != null) throw new Error("external reshard capture transaction is already active");
        if (state && state.next_id >= MAX_CAPTURE_SEQUENCE) {
            throw new Error("external reshard capture transaction identity is exhausted");
        }
        throw new Error("external reshard capture transaction state is invalid");
    }
    const row = sql.one<{ active_id: number }>("SELECT active_id FROM _chardb_split_capture_tx WHERE singleton = 1");
    if (!row || !Number.isSafeInteger(row.active_id) || row.active_id >= 0) {
        throw new Error("external reshard capture transaction identity is invalid");
    }
    return row.active_id;
}

export function endExternalReshardCapture(sql: SyncSql, transactionId: number): void {
    if (!Number.isSafeInteger(transactionId) || transactionId >= 0) {
        throw new Error("external reshard capture transaction identity is invalid");
    }
    sql.exec(
        `UPDATE _chardb_split_capture_tx SET active_id = NULL, active_vshard = NULL
         WHERE singleton = 1 AND active_id = ?`,
        transactionId
    );
    if (sql.changes() !== 1) throw new Error("external reshard capture transaction identity changed");
}

/** Run one external side-state change inside the caller's SQLite transaction. */
export function withExternalReshardCapture<T>(
    sql: SyncSql,
    placement: number,
    callback: (transactionId: number) => T
): T {
    const transactionId = beginExternalReshardCapture(sql, placement);
    const result = callback(transactionId);
    endExternalReshardCapture(sql, transactionId);
    return result;
}
