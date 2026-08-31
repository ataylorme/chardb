import { CdbError } from "../../errors.ts";
import type { SqlValue, SyncSql } from "../../oplog/wrapper.ts";
import type { CdbFileReshardDrainCursor } from "./cdb-file-reshard-store.ts";

export const RESHARDER_FILE_CURSOR_DDL = `
CREATE TABLE IF NOT EXISTS migration_file_cursor (
  mig_id TEXT PRIMARY KEY,
  enabled INTEGER CHECK (enabled IS NULL OR enabled IN (0, 1)),
  prepare_kind TEXT NOT NULL DEFAULT 'file' CHECK (prepare_kind IN ('file', 'organization_tombstone')),
  prepare_after_id TEXT NOT NULL DEFAULT '',
  prepare_done INTEGER NOT NULL DEFAULT 0 CHECK (prepare_done IN (0, 1)),
  copy_kind TEXT NOT NULL DEFAULT 'organization_tombstone'
    CHECK (copy_kind IN ('file', 'organization_tombstone')),
  copy_after_placement INTEGER NOT NULL DEFAULT -1,
  copy_after_id TEXT NOT NULL DEFAULT '',
  copy_done INTEGER NOT NULL DEFAULT 0 CHECK (copy_done IN (0, 1)),
  validate_kind TEXT NOT NULL DEFAULT 'file' CHECK (validate_kind IN ('file', 'organization_tombstone')),
  validate_after_placement INTEGER NOT NULL DEFAULT -1,
  validate_after_id TEXT NOT NULL DEFAULT '',
  validate_done INTEGER NOT NULL DEFAULT 0 CHECK (validate_done IN (0, 1)),
  drain_kind TEXT NOT NULL DEFAULT 'file' CHECK (drain_kind IN ('file', 'organization_tombstone')),
  drain_after_placement INTEGER NOT NULL DEFAULT -1,
  drain_after_id TEXT NOT NULL DEFAULT '',
  drain_done INTEGER NOT NULL DEFAULT 0 CHECK (drain_done IN (0, 1)),
  abort_kind TEXT NOT NULL DEFAULT '' CHECK (abort_kind IN ('', 'file', 'organization_tombstone')),
  abort_after_id TEXT NOT NULL DEFAULT '',
  abort_done INTEGER NOT NULL DEFAULT 0 CHECK (abort_done IN (0, 1)),
  source_finish_done INTEGER NOT NULL DEFAULT 0 CHECK (source_finish_done IN (0, 1)),
  dest_finish_done INTEGER NOT NULL DEFAULT 0 CHECK (dest_finish_done IN (0, 1)),
  updated_at INTEGER NOT NULL
);
` as const;

export interface ResharderFileCursor {
    readonly enabled: boolean | null;
    readonly prepareKind: "file" | "organization_tombstone";
    readonly prepareAfterId: string;
    readonly prepareDone: boolean;
    readonly copyKind: "file" | "organization_tombstone";
    readonly copyAfterPlacement: number;
    readonly copyAfterId: string;
    readonly copyDone: boolean;
    readonly validateCursor: CdbFileReshardDrainCursor;
    readonly validateDone: boolean;
    readonly drainCursor: CdbFileReshardDrainCursor;
    readonly drainDone: boolean;
    readonly abortKind: "" | "file" | "organization_tombstone";
    readonly abortAfterId: string;
    readonly abortDone: boolean;
    readonly sourceFinishDone: boolean;
    readonly destFinishDone: boolean;
}

interface StoredFileCursor {
    readonly enabled: number | null;
    readonly prepare_kind: ResharderFileCursor["prepareKind"];
    readonly prepare_after_id: string;
    readonly prepare_done: number;
    readonly copy_kind: ResharderFileCursor["copyKind"];
    readonly copy_after_placement: number;
    readonly copy_after_id: string;
    readonly copy_done: number;
    readonly validate_kind: CdbFileReshardDrainCursor["kind"];
    readonly validate_after_placement: number;
    readonly validate_after_id: string;
    readonly validate_done: number;
    readonly drain_kind: CdbFileReshardDrainCursor["kind"];
    readonly drain_after_placement: number;
    readonly drain_after_id: string;
    readonly drain_done: number;
    readonly abort_kind: ResharderFileCursor["abortKind"];
    readonly abort_after_id: string;
    readonly abort_done: number;
    readonly source_finish_done: number;
    readonly dest_finish_done: number;
}

/** Owns only the durable file-movement cursors used by the Resharder phase machine. */
export class ResharderFileCursorStore {
    constructor(
        private readonly sql: SyncSql,
        private readonly nowMs: () => number = Date.now
    ) {}

    ensureForMigrations(): void {
        this.sql.exec(
            `INSERT OR IGNORE INTO migration_file_cursor (mig_id, updated_at)
             SELECT mig_id, updated_at FROM migration_state`
        );
    }

    create(migId: string, nowMs: number): void {
        this.sql.exec("INSERT OR IGNORE INTO migration_file_cursor (mig_id, updated_at) VALUES (?, ?)", migId, nowMs);
    }

    read(migId: string): ResharderFileCursor {
        const row = this.sql.one<StoredFileCursor>("SELECT * FROM migration_file_cursor WHERE mig_id = ?", migId);
        if (!row || (row.enabled !== null && row.enabled !== 0 && row.enabled !== 1)) {
            throw new CdbError({ code: "CDB_INVARIANT", message: `migId=${migId} file cursor is missing` });
        }
        return {
            enabled: row.enabled === null ? null : row.enabled === 1,
            prepareKind: row.prepare_kind,
            prepareAfterId: row.prepare_after_id,
            prepareDone: row.prepare_done === 1,
            copyKind: row.copy_kind,
            copyAfterPlacement: row.copy_after_placement,
            copyAfterId: row.copy_after_id,
            copyDone: row.copy_done === 1,
            validateCursor: {
                kind: row.validate_kind,
                afterPlacement: row.validate_after_placement,
                afterId: row.validate_after_id,
            },
            validateDone: row.validate_done === 1,
            drainCursor: {
                kind: row.drain_kind,
                afterPlacement: row.drain_after_placement,
                afterId: row.drain_after_id,
            },
            drainDone: row.drain_done === 1,
            abortKind: row.abort_kind,
            abortAfterId: row.abort_after_id,
            abortDone: row.abort_done === 1,
            sourceFinishDone: row.source_finish_done === 1,
            destFinishDone: row.dest_finish_done === 1,
        };
    }

    persistPreparation(
        migId: string,
        expectedPhase: number,
        enabled: boolean,
        cursor: { kind: "file" | "organization_tombstone"; afterId: string; done: boolean }
    ): void {
        const current = this.read(migId);
        if (current.enabled !== null && current.enabled !== enabled) {
            throw new CdbError({ code: "CDB_INVARIANT", message: `migId=${migId} file capability changed` });
        }
        this.update(
            migId,
            expectedPhase,
            "UPDATE migration_file_cursor SET enabled = ?, prepare_kind = ?, prepare_after_id = ?, prepare_done = ?",
            enabled ? 1 : 0,
            cursor.kind,
            cursor.afterId,
            cursor.done ? 1 : 0
        );
    }

    persistCopy(
        migId: string,
        expectedPhase: number,
        kind: ResharderFileCursor["copyKind"],
        afterPlacement: number,
        afterId: string,
        done: boolean
    ): void {
        this.update(
            migId,
            expectedPhase,
            "UPDATE migration_file_cursor SET copy_kind = ?, copy_after_placement = ?, copy_after_id = ?, copy_done = ?",
            kind,
            afterPlacement,
            afterId,
            done ? 1 : 0
        );
    }

    persistValidation(migId: string, expectedPhase: number, cursor: CdbFileReshardDrainCursor, done: boolean): void {
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_file_cursor SET validate_kind = ?, validate_after_placement = ?,
             validate_after_id = ?, validate_done = ?`,
            cursor.kind,
            cursor.afterPlacement,
            cursor.afterId,
            done ? 1 : 0
        );
    }

    persistDrain(migId: string, expectedPhase: number, cursor: CdbFileReshardDrainCursor, done: boolean): void {
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_file_cursor SET drain_kind = ?, drain_after_placement = ?, drain_after_id = ?,
             drain_done = ?`,
            cursor.kind,
            cursor.afterPlacement,
            cursor.afterId,
            done ? 1 : 0
        );
    }

    persistAbort(
        migId: string,
        expectedPhase: number,
        afterKind: ResharderFileCursor["abortKind"],
        afterId: string,
        done: boolean
    ): void {
        this.update(
            migId,
            expectedPhase,
            "UPDATE migration_file_cursor SET abort_kind = ?, abort_after_id = ?, abort_done = ?",
            afterKind,
            afterId,
            done ? 1 : 0
        );
    }

    persistFinish(migId: string, expectedPhase: number, role: "source" | "dest"): void {
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_file_cursor SET ${role === "source" ? "source_finish_done" : "dest_finish_done"} = 1`
        );
    }

    private update(migId: string, expectedPhase: number, sqlText: string, ...bindings: SqlValue[]): void {
        this.sql.exec(
            `${sqlText}, updated_at = ? WHERE mig_id = ? AND EXISTS (
               SELECT 1 FROM migration_state WHERE mig_id = ? AND phase = ?
             )`,
            ...bindings,
            this.nowMs(),
            migId,
            migId,
            expectedPhase
        );
        if (this.sql.changes() !== 1) this.phaseChanged(migId, expectedPhase);
    }

    private phaseChanged(migId: string, expectedPhase: number): never {
        const actual = this.sql.one<{ phase: number }>("SELECT phase FROM migration_state WHERE mig_id = ?", migId);
        throw new CdbError({
            code: "CDB_RESHARD_PHASE_MISMATCH",
            message: `migId=${migId} expected=${expectedPhase} actual=${actual?.phase ?? "missing"}`,
        });
    }
}
