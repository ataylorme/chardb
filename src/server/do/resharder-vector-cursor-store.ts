import { CdbError } from "../../errors.ts";
import type { SqlValue, SyncSql } from "../../oplog/wrapper.ts";
import {
    CDB_VECTOR_RESHARD_PARITY_START_CURSOR,
    type CdbVectorReshardCursor,
    normalizeCdbVectorReshardCursor,
} from "./cdb-vector-reshard-records.ts";

export const RESHARDER_VECTOR_CURSOR_DDL = `
CREATE TABLE IF NOT EXISTS migration_vector_cursor (
  mig_id TEXT PRIMARY KEY,
  enabled INTEGER CHECK (enabled IS NULL OR enabled IN (0, 1)),
  through_head_seq INTEGER CHECK (through_head_seq IS NULL OR through_head_seq BETWEEN 0 AND 9007199254740991),
  copy_page_number INTEGER NOT NULL DEFAULT 0 CHECK (copy_page_number BETWEEN 0 AND 9007199254740991),
  copy_cursor_json TEXT,
  copy_done INTEGER NOT NULL DEFAULT 0 CHECK (copy_done IN (0, 1)),
  parity_cursor_json TEXT NOT NULL,
  parity_page_number INTEGER NOT NULL DEFAULT 0 CHECK (parity_page_number BETWEEN 0 AND 9007199254740991),
  parity_done INTEGER NOT NULL DEFAULT 0 CHECK (parity_done IN (0, 1)),
  source_prepare_after_placement INTEGER NOT NULL DEFAULT -1
    CHECK (source_prepare_after_placement BETWEEN -1 AND 16383),
  source_prepare_after_vector_id TEXT NOT NULL DEFAULT '',
  source_prepare_done INTEGER NOT NULL DEFAULT 0 CHECK (source_prepare_done IN (0, 1)),
  source_delete_kind TEXT NOT NULL DEFAULT 'attempt' CHECK (source_delete_kind IN ('attempt', 'outbox', 'head', 'done')),
  source_delete_after_vector_id TEXT NOT NULL DEFAULT '',
  source_delete_after_physical_version INTEGER NOT NULL DEFAULT 0
    CHECK (source_delete_after_physical_version BETWEEN 0 AND 9007199254740991),
  source_delete_done INTEGER NOT NULL DEFAULT 0 CHECK (source_delete_done IN (0, 1)),
  source_frozen INTEGER NOT NULL DEFAULT 0 CHECK (source_frozen IN (0, 1)),
  abort_kind TEXT NOT NULL DEFAULT 'attempt' CHECK (abort_kind IN ('attempt', 'outbox', 'head', 'done')),
  abort_after_vector_id TEXT NOT NULL DEFAULT '',
  abort_after_physical_version INTEGER NOT NULL DEFAULT 0 CHECK (abort_after_physical_version >= 0),
  abort_done INTEGER NOT NULL DEFAULT 0 CHECK (abort_done IN (0, 1)),
  source_finish_done INTEGER NOT NULL DEFAULT 0 CHECK (source_finish_done IN (0, 1)),
  dest_finish_done INTEGER NOT NULL DEFAULT 0 CHECK (dest_finish_done IN (0, 1)),
  updated_at INTEGER NOT NULL,
  CHECK ((enabled = 1) = (through_head_seq IS NOT NULL AND copy_cursor_json IS NOT NULL)),
  CHECK (enabled IS NOT 0 OR copy_done = 1)
);
` as const;

export interface ResharderVectorAbortCursor {
    readonly kind: "attempt" | "outbox" | "head" | "done";
    readonly afterVectorId: string;
    readonly afterPhysicalVersion: number;
}

export interface ResharderVectorSourceDrainCursor {
    readonly afterPlacement: number;
    readonly afterVectorId: string;
}

export interface ResharderVectorSourceDeleteCursor {
    readonly kind: "attempt" | "outbox" | "head" | "done";
    readonly afterVectorId: string;
    readonly afterPhysicalVersion: number;
}

export interface ResharderVectorCursor {
    readonly enabled: boolean | null;
    readonly throughHeadSeq: number | null;
    readonly copyPageNumber: number;
    readonly copyCursor: CdbVectorReshardCursor | null;
    readonly copyDone: boolean;
    readonly parityCursor: CdbVectorReshardCursor;
    readonly parityPageNumber: number;
    readonly parityDone: boolean;
    readonly sourcePrepareCursor: ResharderVectorSourceDrainCursor;
    readonly sourcePrepareDone: boolean;
    readonly sourceDeleteCursor: ResharderVectorSourceDeleteCursor;
    readonly sourceDeleteDone: boolean;
    readonly sourceFrozen: boolean;
    readonly abortCursor: ResharderVectorAbortCursor;
    readonly abortDone: boolean;
    readonly sourceFinishDone: boolean;
    readonly destFinishDone: boolean;
}

interface StoredCursor {
    readonly enabled: number | null;
    readonly through_head_seq: number | bigint | null;
    readonly copy_page_number: number | bigint;
    readonly copy_cursor_json: string | null;
    readonly copy_done: number | bigint;
    readonly parity_cursor_json: string;
    readonly parity_page_number: number | bigint;
    readonly parity_done: number | bigint;
    readonly source_prepare_after_placement: number | bigint;
    readonly source_prepare_after_vector_id: string;
    readonly source_prepare_done: number | bigint;
    readonly source_delete_kind: ResharderVectorSourceDeleteCursor["kind"];
    readonly source_delete_after_vector_id: string;
    readonly source_delete_after_physical_version: number | bigint;
    readonly source_delete_done: number | bigint;
    readonly source_frozen: number | bigint;
    readonly abort_kind: ResharderVectorAbortCursor["kind"];
    readonly abort_after_vector_id: string;
    readonly abort_after_physical_version: number | bigint;
    readonly abort_done: number | bigint;
    readonly source_finish_done: number | bigint;
    readonly dest_finish_done: number | bigint;
}

const TEXT = new TextEncoder();

function invariant(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message });
}

function safeInteger(value: unknown, subject: string, minimum = 0): number {
    const projected = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(projected) || projected < minimum) invariant(`${subject} is invalid`);
    return projected;
}

function flag(value: unknown, subject: string): boolean {
    const projected = safeInteger(value, subject);
    if (projected !== 0 && projected !== 1) invariant(`${subject} is invalid`);
    return projected === 1;
}

function cursorJson(cursor: CdbVectorReshardCursor): string {
    return JSON.stringify(normalizeCdbVectorReshardCursor(cursor));
}

function parseCursor(value: string | null, subject: string): CdbVectorReshardCursor | null {
    if (value === null) return null;
    if (typeof value !== "string" || TEXT.encode(value).byteLength > 1_024) invariant(`${subject} is invalid`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        invariant(`${subject} is malformed`);
    }
    return normalizeCdbVectorReshardCursor(parsed);
}

/** Owns only the durable vector-movement cursors used by the Resharder phase machine. */
export class ResharderVectorCursorStore {
    constructor(
        private readonly sql: SyncSql,
        private readonly nowMs: () => number = Date.now
    ) {}

    ensureForMigrations(): void {
        this.ensureSchema();
        this.sql.exec(
            `INSERT OR IGNORE INTO migration_vector_cursor (mig_id, parity_cursor_json, updated_at)
             SELECT mig_id, ?, updated_at FROM migration_state`,
            cursorJson(CDB_VECTOR_RESHARD_PARITY_START_CURSOR)
        );
    }

    ensureSchema(): void {
        const columns = new Set(
            this.sql.all<{ name: string }>("PRAGMA table_info(migration_vector_cursor)").map(column => column.name)
        );
        const core = [
            "mig_id",
            "enabled",
            "through_head_seq",
            "copy_page_number",
            "copy_cursor_json",
            "copy_done",
            "parity_cursor_json",
            "parity_done",
            "updated_at",
        ] as const;
        const missingCore = core.filter(name => !columns.has(name));
        if (missingCore.length > 0) {
            throw new CdbError({
                code: "CDB_RESHARD_PHASE_MISMATCH",
                message: `vector migration cursor schema is incompatible; missing ${missingCore.join(", ")}`,
            });
        }
        const additions = [
            [
                "parity_page_number",
                "INTEGER NOT NULL DEFAULT 0 CHECK (parity_page_number BETWEEN 0 AND 9007199254740991)",
            ],
            [
                "source_prepare_after_placement",
                "INTEGER NOT NULL DEFAULT -1 CHECK (source_prepare_after_placement BETWEEN -1 AND 16383)",
            ],
            ["source_prepare_after_vector_id", "TEXT NOT NULL DEFAULT ''"],
            ["source_prepare_done", "INTEGER NOT NULL DEFAULT 0 CHECK (source_prepare_done IN (0, 1))"],
            [
                "source_delete_kind",
                "TEXT NOT NULL DEFAULT 'attempt' CHECK (source_delete_kind IN ('attempt', 'outbox', 'head', 'done'))",
            ],
            ["source_delete_after_vector_id", "TEXT NOT NULL DEFAULT ''"],
            [
                "source_delete_after_physical_version",
                "INTEGER NOT NULL DEFAULT 0 CHECK (source_delete_after_physical_version BETWEEN 0 AND 9007199254740991)",
            ],
            ["source_delete_done", "INTEGER NOT NULL DEFAULT 0 CHECK (source_delete_done IN (0, 1))"],
            ["source_frozen", "INTEGER NOT NULL DEFAULT 0 CHECK (source_frozen IN (0, 1))"],
            [
                "abort_kind",
                "TEXT NOT NULL DEFAULT 'attempt' CHECK (abort_kind IN ('attempt', 'outbox', 'head', 'done'))",
            ],
            ["abort_after_vector_id", "TEXT NOT NULL DEFAULT ''"],
            ["abort_after_physical_version", "INTEGER NOT NULL DEFAULT 0 CHECK (abort_after_physical_version >= 0)"],
            ["abort_done", "INTEGER NOT NULL DEFAULT 0 CHECK (abort_done IN (0, 1))"],
            ["source_finish_done", "INTEGER NOT NULL DEFAULT 0 CHECK (source_finish_done IN (0, 1))"],
            ["dest_finish_done", "INTEGER NOT NULL DEFAULT 0 CHECK (dest_finish_done IN (0, 1))"],
        ] as const;
        const missing = additions.filter(([name]) => !columns.has(name));
        if (missing.length === 0) return;
        const activeVector = this.sql.one<{ mig_id: string }>(
            `SELECT cursor.mig_id FROM migration_vector_cursor AS cursor
             JOIN migration_state AS state ON state.mig_id = cursor.mig_id
             WHERE cursor.enabled = 1 AND state.phase NOT IN (-1, 6)
             ORDER BY cursor.mig_id LIMIT 1`
        );
        if (activeVector) {
            throw new CdbError({
                code: "CDB_RESHARD_PHASE_MISMATCH",
                message: `active vector migration ${activeVector.mig_id} predates durable lifecycle cursors; abort it before upgrading`,
            });
        }
        for (const [name, definition] of missing) {
            this.sql.exec(`ALTER TABLE migration_vector_cursor ADD COLUMN ${name} ${definition}`);
            columns.add(name);
        }
        const required = [...core, ...additions.map(([name]) => name)];
        const incomplete = required.filter(name => !columns.has(name));
        if (incomplete.length > 0) {
            throw new CdbError({
                code: "CDB_RESHARD_PHASE_MISMATCH",
                message: `vector migration cursor schema remains incomplete; missing ${incomplete.join(", ")}`,
            });
        }
    }

    create(migId: string, nowMs: number): void {
        this.sql.exec(
            `INSERT OR IGNORE INTO migration_vector_cursor (mig_id, parity_cursor_json, updated_at)
             VALUES (?, ?, ?)`,
            migId,
            cursorJson(CDB_VECTOR_RESHARD_PARITY_START_CURSOR),
            nowMs
        );
    }

    read(migId: string): ResharderVectorCursor {
        const row = this.sql.one<StoredCursor>("SELECT * FROM migration_vector_cursor WHERE mig_id = ?", migId);
        if (!row || (row.enabled !== null && row.enabled !== 0 && row.enabled !== 1)) {
            invariant(`migId=${migId} vector cursor is missing`);
        }
        const throughHeadSeq =
            row.through_head_seq === null ? null : safeInteger(row.through_head_seq, "head watermark");
        const copyCursor = parseCursor(row.copy_cursor_json, "vector copy cursor");
        const enabled = row.enabled === null ? null : row.enabled === 1;
        if (enabled === true && (throughHeadSeq === null || copyCursor === null))
            invariant("vector copy identity is incomplete");
        if (enabled !== true && (throughHeadSeq !== null || copyCursor !== null))
            invariant("disabled vector copy has state");
        return Object.freeze({
            enabled,
            throughHeadSeq,
            copyPageNumber: safeInteger(row.copy_page_number, "vector copy page number"),
            copyCursor,
            copyDone: flag(row.copy_done, "vector copy completion"),
            parityCursor: parseCursor(row.parity_cursor_json, "vector parity cursor") as CdbVectorReshardCursor,
            parityPageNumber: safeInteger(row.parity_page_number, "vector parity page number"),
            parityDone: flag(row.parity_done, "vector parity completion"),
            sourcePrepareCursor: Object.freeze({
                afterPlacement: safeInteger(row.source_prepare_after_placement, "vector prepare placement", -1),
                afterVectorId: row.source_prepare_after_vector_id,
            }),
            sourcePrepareDone: flag(row.source_prepare_done, "vector prepare completion"),
            sourceDeleteCursor: Object.freeze({
                kind: row.source_delete_kind,
                afterVectorId: row.source_delete_after_vector_id,
                afterPhysicalVersion: safeInteger(
                    row.source_delete_after_physical_version,
                    "vector delete physical version"
                ),
            }),
            sourceDeleteDone: flag(row.source_delete_done, "vector delete completion"),
            sourceFrozen: flag(row.source_frozen, "vector source freeze"),
            abortCursor: Object.freeze({
                kind: row.abort_kind,
                afterVectorId: row.abort_after_vector_id,
                afterPhysicalVersion: safeInteger(row.abort_after_physical_version, "vector abort physical version"),
            }),
            abortDone: flag(row.abort_done, "vector abort completion"),
            sourceFinishDone: flag(row.source_finish_done, "vector source finish"),
            destFinishDone: flag(row.dest_finish_done, "vector destination finish"),
        });
    }

    persistBegin(
        migId: string,
        expectedPhase: number,
        enabled: boolean,
        throughHeadSeq: number | null,
        cursor: CdbVectorReshardCursor | null
    ): void {
        const current = this.read(migId);
        if (current.enabled !== null && current.enabled !== enabled)
            invariant(`migId=${migId} vector capability changed`);
        if (enabled !== (throughHeadSeq !== null && cursor !== null)) invariant("vector begin identity is incomplete");
        const normalized = cursor === null ? null : normalizeCdbVectorReshardCursor(cursor);
        if (enabled && normalized?.throughHeadSeq !== throughHeadSeq) invariant("vector begin watermark changed");
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_vector_cursor SET enabled = ?, through_head_seq = ?, copy_cursor_json = ?,
             copy_done = ?`,
            enabled ? 1 : 0,
            throughHeadSeq,
            normalized === null ? null : cursorJson(normalized),
            enabled ? 0 : 1
        );
    }

    persistCopy(
        migId: string,
        expectedPhase: number,
        pageNumber: number,
        input: CdbVectorReshardCursor,
        next: CdbVectorReshardCursor,
        done: boolean
    ): void {
        const current = this.read(migId);
        if (
            current.enabled !== true ||
            current.copyPageNumber !== pageNumber ||
            current.copyCursor === null ||
            cursorJson(current.copyCursor) !== cursorJson(input)
        ) {
            invariant(`migId=${migId} vector copy response does not match its durable request`);
        }
        this.update(
            migId,
            expectedPhase,
            "UPDATE migration_vector_cursor SET copy_page_number = ?, copy_cursor_json = ?, copy_done = ?",
            pageNumber + 1,
            cursorJson(next),
            done ? 1 : 0
        );
    }

    persistParity(
        migId: string,
        expectedPhase: number,
        pageNumber: number,
        input: CdbVectorReshardCursor,
        next: CdbVectorReshardCursor,
        done: boolean
    ): void {
        const current = this.read(migId);
        if (current.parityPageNumber !== pageNumber || cursorJson(current.parityCursor) !== cursorJson(input)) {
            invariant(`migId=${migId} vector parity response does not match its durable request`);
        }
        this.update(
            migId,
            expectedPhase,
            "UPDATE migration_vector_cursor SET parity_cursor_json = ?, parity_page_number = ?, parity_done = ?",
            cursorJson(next),
            pageNumber + 1,
            done ? 1 : 0
        );
    }

    persistSourcePrepare(
        migId: string,
        expectedPhase: number,
        cursor: ResharderVectorSourceDrainCursor,
        done: boolean
    ): void {
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_vector_cursor SET source_prepare_after_placement = ?,
             source_prepare_after_vector_id = ?, source_prepare_done = ?`,
            cursor.afterPlacement,
            cursor.afterVectorId,
            done ? 1 : 0
        );
    }

    persistSourceDelete(
        migId: string,
        expectedPhase: number,
        cursor: ResharderVectorSourceDeleteCursor,
        done: boolean
    ): void {
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_vector_cursor SET source_delete_kind = ?, source_delete_after_vector_id = ?,
             source_delete_after_physical_version = ?, source_delete_done = ?`,
            cursor.kind,
            cursor.afterVectorId,
            cursor.afterPhysicalVersion,
            done ? 1 : 0
        );
    }

    persistSourceFrozen(migId: string, expectedPhase: number): void {
        this.update(migId, expectedPhase, "UPDATE migration_vector_cursor SET source_frozen = 1");
    }

    persistAbort(migId: string, expectedPhase: number, cursor: ResharderVectorAbortCursor, done: boolean): void {
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_vector_cursor SET abort_kind = ?, abort_after_vector_id = ?,
             abort_after_physical_version = ?, abort_done = ?`,
            cursor.kind,
            cursor.afterVectorId,
            cursor.afterPhysicalVersion,
            done ? 1 : 0
        );
    }

    persistFinish(migId: string, expectedPhase: number, role: "source" | "dest"): void {
        this.update(
            migId,
            expectedPhase,
            `UPDATE migration_vector_cursor SET ${role === "source" ? "source_finish_done" : "dest_finish_done"} = 1`
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
