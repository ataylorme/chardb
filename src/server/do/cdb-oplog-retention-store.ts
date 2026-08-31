import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

export const CDB_OPLOG_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const CDB_OPLOG_RETENTION_BATCH = 128;

export interface CdbOpLogRetentionResult {
    readonly deleted: number;
    readonly blockedBySplit: boolean;
    readonly nextAt: number | null;
}

/** Bounded cleanup for the mutation replay ledger. */
export class CdbOpLogRetentionStore {
    constructor(private readonly storage: DurableObjectStorage) {}

    maintain(nowMs = Date.now()): CdbOpLogRetentionResult {
        assertTimestamp(nowMs);
        let result: CdbOpLogRetentionResult | undefined;
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            if (hasActiveSplit(sql)) {
                result = { deleted: 0, blockedBySplit: true, nextAt: null };
                return;
            }

            const cutoff = nowMs - CDB_OPLOG_RETENTION_MS;
            const expired = sql.all<{ event_id: number }>(
                `SELECT event_id FROM _chardb_op_log
                 WHERE committed_at <= ?
                 ORDER BY committed_at, event_id
                 LIMIT ?`,
                cutoff,
                CDB_OPLOG_RETENTION_BATCH + 1
            );
            for (const row of expired.slice(0, CDB_OPLOG_RETENTION_BATCH)) {
                assertEventId(row.event_id);
                sql.exec("DELETE FROM _chardb_op_log WHERE event_id = ? AND committed_at <= ?", row.event_id, cutoff);
                if (sql.changes() !== 1) {
                    throw new CdbError({
                        code: "CDB_INVARIANT",
                        message: "op-log retention row changed during cleanup",
                    });
                }
            }

            const deleted = Math.min(expired.length, CDB_OPLOG_RETENTION_BATCH);
            if (expired.length > CDB_OPLOG_RETENTION_BATCH) {
                result = { deleted, blockedBySplit: false, nextAt: nowMs + 1 };
                return;
            }
            const oldest = sql.one<{ committed_at: number }>(
                "SELECT committed_at FROM _chardb_op_log ORDER BY committed_at, event_id LIMIT 1"
            );
            if (!oldest) {
                result = { deleted, blockedBySplit: false, nextAt: null };
                return;
            }
            assertTimestamp(oldest.committed_at);
            result = {
                deleted,
                blockedBySplit: false,
                nextAt: Math.max(nowMs + 1, oldest.committed_at + CDB_OPLOG_RETENTION_MS),
            };
        });
        if (!result) throw new CdbError({ code: "CDB_INVARIANT", message: "op-log retention returned no result" });
        return result;
    }
}

function hasActiveSplit(sql: SyncSql): boolean {
    return (
        sql.one<{ present: number }>(
            `SELECT 1 AS present FROM _chardb_split_state
             WHERE drained = 0 AND role IN ('source', 'dest') LIMIT 1`
        ) !== null
    );
}

function assertTimestamp(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "op-log retention timestamp is invalid" });
    }
}

function assertEventId(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "op-log retention event id is invalid" });
    }
}
