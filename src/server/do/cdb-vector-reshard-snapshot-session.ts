import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { CDB_SPLIT_IDENTITY_LIMIT } from "./cdb-reshard-identity-store.ts";
import { CDB_RESHARD_MAX_BATCH_BYTES } from "./cdb-reshard-relational.ts";
import {
    type CdbVectorReshardCursor,
    type CdbVectorReshardIdentity,
    CdbVectorReshardSnapshotReader,
    decodeCdbVectorReshardPage,
    encodeCdbVectorReshardPage,
    normalizeCdbVectorReshardCursor,
} from "./cdb-vector-reshard-records.ts";

const TEXT = new TextEncoder();
export const CDB_VECTOR_RESHARD_SNAPSHOT_SESSION_LIMIT = CDB_SPLIT_IDENTITY_LIMIT;

export const CDB_VECTOR_RESHARD_SNAPSHOT_SESSION_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_vector_snapshot_sessions (
  mig_id                    TEXT PRIMARY KEY,
  range_lo                  INTEGER NOT NULL CHECK (range_lo >= 0 AND range_lo < 16384),
  range_hi                  INTEGER NOT NULL CHECK (range_hi >= range_lo AND range_hi < 16384),
  through_head_seq          INTEGER NOT NULL CHECK (through_head_seq >= 0 AND through_head_seq <= 9007199254740991),
  expected_cursor_json      TEXT NOT NULL,
  next_page_number          INTEGER NOT NULL CHECK (next_page_number >= 0 AND next_page_number <= 9007199254740991),
  cached_page_number        INTEGER,
  cached_input_cursor_json  TEXT,
  cached_page_enc           TEXT,
  cached_through_lsn        INTEGER CHECK (cached_through_lsn IS NULL OR cached_through_lsn >= 0),
  terminal                  INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  cleaned                   INTEGER NOT NULL DEFAULT 0 CHECK (cleaned IN (0, 1)),
  CHECK ((cached_page_number IS NULL AND cached_input_cursor_json IS NULL AND cached_page_enc IS NULL
          AND cached_through_lsn IS NULL)
      OR (cached_page_number IS NOT NULL AND cached_input_cursor_json IS NOT NULL AND cached_page_enc IS NOT NULL
          AND cached_through_lsn IS NOT NULL)),
  CHECK (cached_page_number IS NULL OR cached_page_number + 1 = next_page_number),
  CHECK (cleaned = 0 OR (cached_page_number IS NULL AND cached_input_cursor_json IS NULL
      AND cached_page_enc IS NULL AND cached_through_lsn IS NULL)),
  CHECK (cached_page_enc IS NULL OR length(CAST(cached_page_enc AS BLOB)) <= ${CDB_RESHARD_MAX_BATCH_BYTES})
);
` as const;

interface StoredSession {
    readonly mig_id: string;
    readonly range_lo: number | bigint;
    readonly range_hi: number | bigint;
    readonly through_head_seq: number | bigint;
    readonly expected_cursor_json: string;
    readonly next_page_number: number | bigint;
    readonly cached_page_number: number | bigint | null;
    readonly cached_input_cursor_json: string | null;
    readonly cached_page_enc: string | null;
    readonly cached_through_lsn: number | bigint | null;
    readonly terminal: number | bigint;
    readonly cleaned: number | bigint;
}

export interface CdbVectorReshardSnapshotRequest {
    readonly pageNumber: number;
    readonly cursor: CdbVectorReshardCursor;
}

export interface CdbVectorReshardSnapshotResponse {
    readonly pageNumber: number;
    /** Exact encoded page retained for response-loss replay. */
    readonly encodedPage: string;
    /** Source tail high watermark observed atomically with this page read. */
    readonly throughLsn: number;
}

export interface CdbVectorReshardSnapshotSessionState {
    readonly throughHeadSeq: number;
    readonly next: CdbVectorReshardSnapshotRequest;
    readonly cached: CdbVectorReshardSnapshotRequest | null;
    readonly terminal: boolean;
}

function mismatch(message: string): never {
    throw new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message: `vector reshard snapshot session: ${message}` });
}

function safeInteger(value: unknown, subject: string, minimum = 0): number {
    const number = typeof value === "number" || typeof value === "bigint" ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(number) || number < minimum) mismatch(`${subject} is invalid`);
    return number;
}

function storedFlag(value: unknown, subject: string): boolean {
    const number = safeInteger(value, subject);
    if (number !== 0 && number !== 1) mismatch(`${subject} is invalid`);
    return number === 1;
}

function cursorJson(value: unknown): string {
    return JSON.stringify(normalizeCdbVectorReshardCursor(value));
}

function parseCursor(value: string, subject: string): CdbVectorReshardCursor {
    if (typeof value !== "string" || TEXT.encode(value).byteLength > 1_024) mismatch(`${subject} is invalid`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        mismatch(`${subject} is invalid`);
    }
    return normalizeCdbVectorReshardCursor(parsed);
}

function exactIdentity(identity: CdbVectorReshardIdentity, row: StoredSession): void {
    if (
        safeInteger(row.range_lo, "stored range start") !== identity.rangeLo ||
        safeInteger(row.range_hi, "stored range end") !== identity.rangeHi
    ) {
        mismatch(`migration ${identity.migId} does not match its snapshot session`);
    }
}

function storedSession(sql: SyncSql, migId: string): StoredSession | null {
    return sql.one<StoredSession>("SELECT * FROM _chardb_vector_snapshot_sessions WHERE mig_id = ?", migId);
}

function sourceTailHighWatermark(sql: SyncSql, migId: string): number {
    const row = sql.one<{ high_lsn: number | bigint }>(
        `SELECT MAX(
            state.acked_lsn,
            COALESCE((SELECT MAX(tail.lsn) FROM _chardb_split_log AS tail WHERE tail.mig_id = state.mig_id), 0)
         ) AS high_lsn
         FROM _chardb_split_state AS state WHERE state.mig_id = ? AND state.role = 'source'`,
        migId
    );
    if (!row) mismatch(`migration ${migId} has no active source tail`);
    return safeInteger(row.high_lsn, "source tail high watermark");
}

function assertSessionCapacity(sql: SyncSql): void {
    if (
        sql.one<{ present: number }>(
            "SELECT 1 AS present FROM _chardb_vector_snapshot_sessions ORDER BY mig_id LIMIT 1 OFFSET ?",
            CDB_VECTOR_RESHARD_SNAPSHOT_SESSION_LIMIT - 1
        )
    ) {
        throw new CdbError({
            code: "CDB_RATE_LIMITED",
            message: "vector reshard snapshot session history reached its durable row limit",
        });
    }
}

function decodeCachedPage(row: StoredSession): ReturnType<typeof decodeCdbVectorReshardPage> {
    if (row.cached_page_enc === null || TEXT.encode(row.cached_page_enc).byteLength > CDB_RESHARD_MAX_BATCH_BYTES) {
        mismatch("cached page is invalid");
    }
    const page = decodeCdbVectorReshardPage(row.cached_page_enc);
    if (encodeCdbVectorReshardPage(page) !== row.cached_page_enc) mismatch("cached page encoding is not canonical");
    if (row.cached_through_lsn === null) mismatch("cached page tail watermark is missing");
    safeInteger(row.cached_through_lsn, "cached page tail watermark");
    if (cursorJson(page.next) !== row.expected_cursor_json) mismatch("cached page successor does not match session");
    if (page.done !== storedFlag(row.terminal, "terminal flag")) {
        mismatch("cached page completion does not match session");
    }
    return page;
}

export function initializeCdbVectorReshardSnapshotSessions(sql: SyncSql): void {
    for (const statement of CDB_VECTOR_RESHARD_SNAPSHOT_SESSION_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
    const columns = sql.all<{ name: string }>("PRAGMA table_info(_chardb_vector_snapshot_sessions)");
    if (!columns.some(column => column.name === "cached_through_lsn")) {
        sql.exec(
            `ALTER TABLE _chardb_vector_snapshot_sessions ADD COLUMN cached_through_lsn INTEGER
             CHECK (cached_through_lsn IS NULL OR cached_through_lsn >= 0)`
        );
    }
}

/**
 * Durable source paging for vector side-state.
 *
 * Mutating methods must run inside the source Cdb's `transactionSync`. The
 * session keeps one page for replay. Requesting its successor acknowledges it.
 */
export class CdbVectorReshardSnapshotSessionStore {
    private readonly reader: CdbVectorReshardSnapshotReader;

    constructor(private readonly sql: SyncSql) {
        this.reader = new CdbVectorReshardSnapshotReader(sql);
    }

    begin(identity: CdbVectorReshardIdentity): CdbVectorReshardSnapshotSessionState {
        const existing = storedSession(this.sql, identity.migId);
        if (existing) {
            exactIdentity(identity, existing);
            this.reader.assertSourceIdentity(identity);
            if (storedFlag(existing.cleaned, "cleanup flag")) mismatch("snapshot session was cleaned");
            return this.project(existing);
        }

        const cursor = this.reader.begin(identity);
        assertSessionCapacity(this.sql);
        const encodedCursor = cursorJson(cursor);
        this.sql.exec(
            `INSERT INTO _chardb_vector_snapshot_sessions
               (mig_id, range_lo, range_hi, through_head_seq, expected_cursor_json, next_page_number,
                cached_page_number, cached_input_cursor_json, cached_page_enc, terminal, cleaned)
             VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 0, 0)`,
            identity.migId,
            identity.rangeLo,
            identity.rangeHi,
            cursor.throughHeadSeq,
            encodedCursor
        );
        if (this.sql.changes() !== 1) mismatch("snapshot session begin lost its ownership row");
        const created = storedSession(this.sql, identity.migId);
        if (!created) mismatch("snapshot session disappeared after begin");
        return this.project(created);
    }

    read(
        identity: CdbVectorReshardIdentity,
        request: CdbVectorReshardSnapshotRequest
    ): CdbVectorReshardSnapshotResponse {
        const row = storedSession(this.sql, identity.migId);
        if (!row) mismatch(`migration ${identity.migId} has no vector snapshot session`);
        exactIdentity(identity, row);
        if (storedFlag(row.cleaned, "cleanup flag")) mismatch("snapshot session was cleaned");
        const pageNumber = safeInteger(request.pageNumber, "page number");
        const inputCursor = normalizeCdbVectorReshardCursor(request.cursor);
        const inputCursorJson = JSON.stringify(inputCursor);
        const throughHeadSeq = safeInteger(row.through_head_seq, "head watermark");
        if (inputCursor.throughHeadSeq !== throughHeadSeq) mismatch("page cursor changed the head watermark");

        if (
            row.cached_page_number !== null &&
            pageNumber === safeInteger(row.cached_page_number, "cached page number")
        ) {
            if (inputCursorJson !== row.cached_input_cursor_json) mismatch("cached page cursor does not match");
            decodeCachedPage(row);
            return Object.freeze({
                pageNumber,
                encodedPage: row.cached_page_enc as string,
                throughLsn: safeInteger(row.cached_through_lsn, "cached page tail watermark"),
            });
        }

        const nextPageNumber = safeInteger(row.next_page_number, "next page number");
        if (storedFlag(row.terminal, "terminal flag")) mismatch("snapshot session is already terminal");
        if (pageNumber !== nextPageNumber) mismatch("page number is not the next expected page");
        if (inputCursorJson !== row.expected_cursor_json) mismatch("page cursor is not the next expected cursor");
        if (pageNumber >= Number.MAX_SAFE_INTEGER) mismatch("page number cannot advance");

        const page = this.reader.read(identity, inputCursor);
        const throughLsn = sourceTailHighWatermark(this.sql, identity.migId);
        if (
            row.cached_through_lsn !== null &&
            throughLsn < safeInteger(row.cached_through_lsn, "cached page tail watermark")
        ) {
            mismatch("source tail high watermark regressed between pages");
        }
        const encodedPage = encodeCdbVectorReshardPage(page);
        if (TEXT.encode(encodedPage).byteLength > CDB_RESHARD_MAX_BATCH_BYTES)
            mismatch("encoded page exceeds its bound");
        const nextCursorJson = cursorJson(page.next);
        this.sql.exec(
            `UPDATE _chardb_vector_snapshot_sessions
             SET expected_cursor_json = ?, next_page_number = ?, cached_page_number = ?,
                 cached_input_cursor_json = ?, cached_page_enc = ?, cached_through_lsn = ?, terminal = ?
             WHERE mig_id = ? AND range_lo = ? AND range_hi = ?
               AND expected_cursor_json = ? AND next_page_number = ? AND terminal = 0`,
            nextCursorJson,
            pageNumber + 1,
            pageNumber,
            inputCursorJson,
            encodedPage,
            throughLsn,
            page.done ? 1 : 0,
            identity.migId,
            identity.rangeLo,
            identity.rangeHi,
            row.expected_cursor_json,
            pageNumber
        );
        if (this.sql.changes() !== 1) mismatch("snapshot page lost its expected cursor");
        return Object.freeze({ pageNumber, encodedPage, throughLsn });
    }

    inspect(identity: CdbVectorReshardIdentity): CdbVectorReshardSnapshotSessionState {
        const row = storedSession(this.sql, identity.migId);
        if (!row) mismatch(`migration ${identity.migId} has no vector snapshot session`);
        exactIdentity(identity, row);
        if (storedFlag(row.cleaned, "cleanup flag")) mismatch("snapshot session was cleaned");
        return this.project(row);
    }

    cleanup(identity: CdbVectorReshardIdentity): { readonly cleaned: boolean } {
        const row = storedSession(this.sql, identity.migId);
        if (!row) {
            // A never-started cleanup still has to match the permanent source binding.
            this.reader.begin(identity);
            return Object.freeze({ cleaned: false });
        }
        exactIdentity(identity, row);
        this.reader.assertSourceIdentity(identity);
        if (storedFlag(row.cleaned, "cleanup flag")) return Object.freeze({ cleaned: false });
        // Keep the small identity and watermark tombstone. Split-history capacity
        // bounds these rows, while cleanup releases the page body that can reach 1 MiB.
        this.sql.exec(
            `UPDATE _chardb_vector_snapshot_sessions
             SET cached_page_number = NULL, cached_input_cursor_json = NULL, cached_page_enc = NULL, cleaned = 1
                 , cached_through_lsn = NULL
             WHERE mig_id = ? AND range_lo = ? AND range_hi = ? AND cleaned = 0`,
            identity.migId,
            identity.rangeLo,
            identity.rangeHi
        );
        if (this.sql.changes() !== 1) mismatch("snapshot session cleanup lost its ownership row");
        return Object.freeze({ cleaned: true });
    }

    private project(row: StoredSession): CdbVectorReshardSnapshotSessionState {
        const throughHeadSeq = safeInteger(row.through_head_seq, "head watermark");
        if (storedFlag(row.cleaned, "cleanup flag")) mismatch("snapshot session was cleaned");
        const nextPageNumber = safeInteger(row.next_page_number, "next page number");
        const nextCursor = parseCursor(row.expected_cursor_json, "expected cursor");
        if (cursorJson(nextCursor) !== row.expected_cursor_json) mismatch("expected cursor encoding is not canonical");
        if (nextCursor.throughHeadSeq !== throughHeadSeq) mismatch("expected cursor changed the head watermark");
        let cached: CdbVectorReshardSnapshotRequest | null = null;
        if (row.cached_page_number !== null) {
            if (row.cached_input_cursor_json === null || row.cached_page_enc === null)
                mismatch("cached page is incomplete");
            const cachedCursor = parseCursor(row.cached_input_cursor_json, "cached input cursor");
            if (cursorJson(cachedCursor) !== row.cached_input_cursor_json)
                mismatch("cached input cursor encoding is not canonical");
            if (cachedCursor.throughHeadSeq !== throughHeadSeq) mismatch("cached cursor changed the head watermark");
            cached = Object.freeze({
                pageNumber: safeInteger(row.cached_page_number, "cached page number"),
                cursor: cachedCursor,
            });
            if (cached.pageNumber + 1 !== nextPageNumber) mismatch("cached page number is not the current predecessor");
            decodeCachedPage(row);
        }
        const terminal = storedFlag(row.terminal, "terminal flag");
        if (terminal && cached === null) mismatch("terminal session has no replay page");
        return Object.freeze({
            throughHeadSeq,
            next: Object.freeze({ pageNumber: nextPageNumber, cursor: nextCursor }),
            cached,
            terminal,
        });
    }
}
