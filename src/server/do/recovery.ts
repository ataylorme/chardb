import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";

const RECOVERY_RESTORE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_recovery_restore (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  target_bookmark TEXT NOT NULL,
  undo_bookmark TEXT NOT NULL,
  armed_at INTEGER NOT NULL CHECK (armed_at >= 0),
  commit_at INTEGER CHECK (commit_at IS NULL OR commit_at >= 0),
  native_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (native_scheduled IN (0, 1))
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
    readonly commitAt: number | null;
    readonly nativeScheduled: boolean;
}

interface StoredRecoveryRestore {
    readonly target_bookmark: string;
    readonly undo_bookmark: string;
    readonly armed_at: number;
    readonly commit_at: number | null;
    readonly native_scheduled: number | bigint;
}

export function initializeRecoveryStorage(sql: SyncSql): void {
    sql.exec(RECOVERY_RESTORE_DDL);
    const columns = new Set(
        sql.all<{ readonly name: string }>("PRAGMA table_info(_chardb_recovery_restore)").map(column => column.name)
    );
    if (!columns.has("commit_at")) {
        sql.exec(
            "ALTER TABLE _chardb_recovery_restore ADD COLUMN commit_at INTEGER CHECK (commit_at IS NULL OR commit_at >= 0)"
        );
    }
    if (!columns.has("native_scheduled")) {
        sql.exec(
            `ALTER TABLE _chardb_recovery_restore
             ADD COLUMN native_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (native_scheduled IN (0, 1))`
        );
    }
}

export function readArmedRecoveryRestore(sql: SyncSql): ArmedRecoveryRestore | null {
    const row = sql.one<StoredRecoveryRestore>(
        `SELECT target_bookmark, undo_bookmark, armed_at, commit_at, native_scheduled
         FROM _chardb_recovery_restore WHERE singleton = 1`
    );
    return row
        ? {
              targetBookmark: row.target_bookmark,
              undoBookmark: row.undo_bookmark,
              armedAt: row.armed_at,
              commitAt: row.commit_at,
              nativeScheduled: Number(row.native_scheduled) === 1,
          }
        : null;
}

export function assertRecoveryAvailable(sql: SyncSql): void {
    assertRecoveryAvailableFor(sql);
}

export function assertRecoveryAvailableFor(sql: SyncSql, targetBookmark?: string): void {
    const armed = readArmedRecoveryRestore(sql);
    if (!armed || (targetBookmark !== undefined && armed.targetBookmark === targetBookmark)) return;
    throw new CdbError({
        code: "CDB_STALE_EPOCH",
        message:
            targetBookmark === undefined
                ? "point-in-time restore is in progress"
                : "point-in-time restore is already armed for a different recovery point",
        hint: "retry after the recovery point activates",
    });
}

export function abortForArmedRecoveryRestore(state: DurableObjectState, sql: SyncSql): boolean {
    const armed = readArmedRecoveryRestore(sql);
    if (!armed) return false;
    if (!armed.nativeScheduled) return true;
    state.abort("applying Chardb point-in-time restore");
    return true;
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
        // Arm only closes the traffic fence. Scheduling the native restore here
        // would let an ordinary runtime restart rewind the object before the
        // recovery coordinator finishes provider cleanup.
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
                current,
                armedAt
            );
        });
        return { targetBookmark: target, undoBookmark: current, armedAt, commitAt: null, nativeScheduled: false };
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
        if (existing.commitAt !== null) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: "point-in-time restore cannot be cancelled after commit begins",
            });
        }
        // A prepared restore has no native target. Delete only its local fence.
        this.storage.transactionSync(() => {
            this.sql().exec("DELETE FROM _chardb_recovery_restore WHERE singleton = 1 AND target_bookmark = ?", target);
        });
        return { cancelled: true };
    }

    status(targetBookmark: string): { readonly state: "armed" | "absent" } {
        const target = assertBookmark(targetBookmark);
        const armed = readArmedRecoveryRestore(this.sql());
        if (armed && armed.targetBookmark !== target) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: "a different point-in-time restore is armed",
            });
        }
        return { state: armed ? "armed" : "absent" };
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
        let deadline = existing.commitAt;
        if (deadline === null) {
            const proposed = Date.now() + RECOVERY_ACTIVATION_DELAY_MS;
            this.storage.transactionSync(() => {
                this.sql().exec(
                    `UPDATE _chardb_recovery_restore SET commit_at = COALESCE(commit_at, ?)
                     WHERE singleton = 1 AND target_bookmark = ?`,
                    proposed,
                    target
                );
            });
            deadline = readArmedRecoveryRestore(this.sql())?.commitAt ?? proposed;
        }
        const committed = readArmedRecoveryRestore(this.sql());
        if (!committed || committed.targetBookmark !== target) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: "point-in-time restore fence disappeared during commit",
            });
        }
        if (!committed.nativeScheduled) {
            // Provider cleanup is complete before the coordinator reaches this
            // call. Keep the fence in place while the runtime accepts the PITR
            // target. If the response is lost, a retry safely schedules the
            // same bookmark again.
            const undoBookmark = assertBookmark(await this.storage.onNextSessionRestoreBookmark(target));
            this.storage.transactionSync(() => {
                this.sql().exec(
                    `UPDATE _chardb_recovery_restore
                     SET undo_bookmark = ?, native_scheduled = 1
                     WHERE singleton = 1 AND target_bookmark = ?`,
                    undoBookmark,
                    target
                );
            });
        }
        // Every retry uses the first durable activation deadline. Fast polls
        // cannot slide the restore forward forever.
        await this.storage.setAlarm(Math.max(deadline, Date.now()));
        return { scheduled: true };
    }
}

function assertBookmark(value: string): string {
    if (!BOOKMARK.test(value)) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "point-in-time recovery bookmark is invalid" });
    }
    return value;
}
