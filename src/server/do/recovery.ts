import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";

const RECOVERY_RESTORE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_recovery_restore (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  target_bookmark TEXT NOT NULL,
  undo_bookmark TEXT NOT NULL,
  armed_at INTEGER NOT NULL CHECK (armed_at >= 0)
);`;

const BOOKMARK = /^[A-Za-z0-9-]{1,512}$/;
const PITR_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const RECOVERY_ACTIVATION_DELAY_MS = 5_000;

export interface RecoveryBookmark {
    readonly bookmark: string;
    readonly atMs: number;
}

export interface ArmedRecoveryRestore {
    readonly targetBookmark: string;
    readonly undoBookmark: string;
    readonly armedAt: number;
}

interface StoredRecoveryRestore {
    readonly target_bookmark: string;
    readonly undo_bookmark: string;
    readonly armed_at: number;
}

export function initializeRecoveryStorage(sql: SyncSql): void {
    sql.exec(RECOVERY_RESTORE_DDL);
}

export function readArmedRecoveryRestore(sql: SyncSql): ArmedRecoveryRestore | null {
    const row = sql.one<StoredRecoveryRestore>(
        `SELECT target_bookmark, undo_bookmark, armed_at
         FROM _chardb_recovery_restore WHERE singleton = 1`
    );
    return row
        ? {
              targetBookmark: row.target_bookmark,
              undoBookmark: row.undo_bookmark,
              armedAt: row.armed_at,
          }
        : null;
}

export function assertRecoveryAvailable(sql: SyncSql): void {
    if (!readArmedRecoveryRestore(sql)) return;
    throw new CdbError({
        code: "CDB_STALE_EPOCH",
        message: "point-in-time restore is in progress",
        hint: "retry after the recovery point activates",
    });
}

export function abortForArmedRecoveryRestore(state: DurableObjectState, sql: SyncSql): void {
    if (readArmedRecoveryRestore(sql)) state.abort("applying Chardb point-in-time restore");
}

export class DurableObjectRecovery {
    constructor(
        private readonly storage: DurableObjectStorage,
        private readonly sql: () => SyncSql
    ) {}

    async bookmark(atMs?: number): Promise<RecoveryBookmark> {
        const nowMs = Date.now();
        if (atMs === undefined) {
            return { bookmark: assertBookmark(await this.storage.getCurrentBookmark()), atMs: nowMs };
        }
        if (!Number.isSafeInteger(atMs) || atMs < nowMs - PITR_RETENTION_MS || atMs > nowMs) {
            throw new CdbError({
                code: "CDB_INVALID_ARGS",
                message: "recovery timestamp must be within the previous 30 days",
            });
        }
        return {
            bookmark: assertBookmark(await this.storage.getBookmarkForTime(atMs)),
            atMs,
        };
    }

    async arm(targetBookmark: string, armedAt = Date.now()): Promise<ArmedRecoveryRestore> {
        const target = assertBookmark(targetBookmark);
        if (!Number.isSafeInteger(armedAt) || armedAt < 0) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "recovery arm time is invalid" });
        }
        const existing = readArmedRecoveryRestore(this.sql());
        if (existing) {
            if (existing.targetBookmark !== target) {
                throw new CdbError({
                    code: "CDB_STALE_EPOCH",
                    message: "a different point-in-time restore is already armed",
                });
            }
            return existing;
        }

        const current = assertBookmark(await this.storage.getCurrentBookmark());
        const undoBookmark = assertBookmark(await this.storage.onNextSessionRestoreBookmark(target));
        try {
            this.storage.transactionSync(() => {
                const sql = this.sql();
                if (readArmedRecoveryRestore(sql)) {
                    throw new CdbError({
                        code: "CDB_STALE_EPOCH",
                        message: "a point-in-time restore was armed concurrently",
                    });
                }
                sql.exec(
                    `INSERT INTO _chardb_recovery_restore
                     (singleton, target_bookmark, undo_bookmark, armed_at) VALUES (1, ?, ?, ?)`,
                    target,
                    undoBookmark,
                    armedAt
                );
            });
        } catch (error) {
            await this.storage.onNextSessionRestoreBookmark(current);
            throw error;
        }
        return { targetBookmark: target, undoBookmark, armedAt };
    }

    async cancel(targetBookmark: string): Promise<{ readonly cancelled: boolean }> {
        const target = assertBookmark(targetBookmark);
        const existing = readArmedRecoveryRestore(this.sql());
        if (!existing) return { cancelled: false };
        if (existing.targetBookmark !== target) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: "recovery cancellation target does not match the armed restore",
            });
        }
        this.storage.transactionSync(() => {
            this.sql().exec("DELETE FROM _chardb_recovery_restore WHERE singleton = 1 AND target_bookmark = ?", target);
        });
        const current = assertBookmark(await this.storage.getCurrentBookmark());
        await this.storage.onNextSessionRestoreBookmark(current);
        return { cancelled: true };
    }

    async commit(targetBookmark: string): Promise<{ readonly scheduled: true }> {
        const target = assertBookmark(targetBookmark);
        const existing = readArmedRecoveryRestore(this.sql());
        if (!existing || existing.targetBookmark !== target) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: "point-in-time restore is not armed for this bookmark",
            });
        }
        // Give the commit RPC response time to cross the Durable Object
        // boundary before the alarm aborts this session. Catalog remains
        // armed, so public traffic stays fenced while shards restart.
        await this.storage.setAlarm(Date.now() + RECOVERY_ACTIVATION_DELAY_MS);
        return { scheduled: true };
    }
}

function assertBookmark(value: string): string {
    if (!BOOKMARK.test(value)) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "point-in-time recovery bookmark is invalid" });
    }
    return value;
}
