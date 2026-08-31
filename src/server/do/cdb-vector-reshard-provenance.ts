import { CdbError } from "../../errors.ts";
import { CDB_SPLIT_LOG_MAX_ROWS } from "../../oplog/schema.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { stableHashHex } from "../../util/canonical.ts";
import { CDB_SPLIT_IDENTITY_LIMIT } from "./cdb-reshard-identity-store.ts";
import {
    CDB_VECTOR_MAX_ATTEMPT_ROWS,
    CDB_VECTOR_MAX_HEADS,
    CDB_VECTOR_MAX_OUTBOX_ROWS,
} from "./cdb-vector-outbox-store.ts";
import {
    type CdbVectorReshardCursor,
    type CdbVectorReshardRecord,
    normalizeCdbVectorReshardCursor,
} from "./cdb-vector-reshard-records.ts";

const TEXT = new TextEncoder();
const DIGEST = /^[a-f0-9]{64}$/;

export const CDB_VECTOR_RESHARD_PROVENANCE_LIMIT =
    CDB_VECTOR_MAX_HEADS + CDB_VECTOR_MAX_OUTBOX_ROWS + CDB_VECTOR_MAX_ATTEMPT_ROWS;
export const CDB_VECTOR_RESHARD_INTERVAL_LIMIT = CDB_VECTOR_RESHARD_PROVENANCE_LIMIT + 3;

export const CDB_VECTOR_RESHARD_PROVENANCE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_vector_reshard_provenance_identity (
  mig_id       TEXT PRIMARY KEY,
  range_lo     INTEGER NOT NULL CHECK (range_lo BETWEEN 0 AND 16383),
  range_hi     INTEGER NOT NULL CHECK (range_hi BETWEEN range_lo AND 16383),
  outcome      TEXT NOT NULL DEFAULT 'active' CHECK (outcome IN ('active', 'cleaned')),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count BETWEEN 0 AND ${CDB_VECTOR_RESHARD_PROVENANCE_LIMIT}),
  interval_count INTEGER NOT NULL DEFAULT 0 CHECK (interval_count BETWEEN 0 AND ${CDB_VECTOR_RESHARD_INTERVAL_LIMIT}),
  receipt_count INTEGER NOT NULL DEFAULT 0 CHECK (receipt_count BETWEEN 0 AND ${CDB_SPLIT_LOG_MAX_ROWS}),
  CHECK (outcome = 'active' OR (record_count = 0 AND interval_count = 0 AND receipt_count = 0))
);
CREATE TABLE IF NOT EXISTS _chardb_split_vector_applied (
  mig_id                TEXT NOT NULL,
  record_kind           TEXT NOT NULL CHECK (record_kind IN ('head', 'outbox', 'attempt')),
  vector_id             TEXT NOT NULL,
  physical_version      INTEGER NOT NULL DEFAULT 0 CHECK (physical_version >= 0),
  placement_vshard      INTEGER NOT NULL CHECK (placement_vshard BETWEEN 0 AND 16383),
  snapshot_through_lsn  INTEGER CHECK (snapshot_through_lsn IS NULL OR snapshot_through_lsn >= 0),
  latest_tail_lsn       INTEGER CHECK (latest_tail_lsn IS NULL OR latest_tail_lsn >= 1),
  present               INTEGER NOT NULL CHECK (present IN (0, 1)),
  inserted              INTEGER NOT NULL CHECK (inserted IN (0, 1)),
  image_fingerprint     TEXT CHECK (image_fingerprint IS NULL OR length(image_fingerprint) = 64),
  PRIMARY KEY (mig_id, record_kind, vector_id, physical_version),
  CHECK ((record_kind = 'attempt') = (physical_version > 0)),
  CHECK (snapshot_through_lsn IS NOT NULL OR latest_tail_lsn IS NOT NULL),
  CHECK (present = 1 OR image_fingerprint IS NULL),
  FOREIGN KEY (mig_id) REFERENCES _chardb_vector_reshard_provenance_identity(mig_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS _chardb_split_vector_tail_applied (
  mig_id       TEXT NOT NULL,
  lsn          INTEGER NOT NULL CHECK (lsn > 0),
  table_name   TEXT NOT NULL CHECK (table_name IN
    ('_chardb_vectors', '_chardb_vector_outbox', '_chardb_vector_attempts')),
  fingerprint  TEXT NOT NULL CHECK (length(fingerprint) = 64),
  PRIMARY KEY (mig_id, lsn),
  FOREIGN KEY (mig_id) REFERENCES _chardb_vector_reshard_provenance_identity(mig_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS _chardb_split_vector_snapshot_intervals (
  mig_id                       TEXT NOT NULL,
  page_number                 INTEGER NOT NULL CHECK (page_number >= 0),
  record_kind                 TEXT NOT NULL CHECK (record_kind IN ('head', 'outbox', 'attempt')),
  input_cursor_json           TEXT NOT NULL,
  next_cursor_json            TEXT NOT NULL,
  input_placement_vshard      INTEGER NOT NULL CHECK (input_placement_vshard BETWEEN -1 AND 16383),
  input_vector_id             TEXT NOT NULL,
  input_physical_version      INTEGER NOT NULL CHECK (input_physical_version >= 0),
  next_kind                   TEXT NOT NULL CHECK (next_kind IN ('head', 'outbox', 'attempt', 'done')),
  next_placement_vshard       INTEGER NOT NULL CHECK (next_placement_vshard BETWEEN -1 AND 16383),
  next_vector_id              TEXT NOT NULL,
  next_physical_version       INTEGER NOT NULL CHECK (next_physical_version >= 0),
  through_lsn                 INTEGER NOT NULL CHECK (through_lsn >= 0),
  page_digest                 TEXT NOT NULL CHECK (length(page_digest) = 64),
  PRIMARY KEY (mig_id, page_number),
  FOREIGN KEY (mig_id) REFERENCES _chardb_vector_reshard_provenance_identity(mig_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS _chardb_split_vector_snapshot_interval_lookup
ON _chardb_split_vector_snapshot_intervals
  (mig_id, record_kind, through_lsn, input_placement_vshard, input_vector_id, input_physical_version);
` as const;

export interface CdbVectorReshardProvenanceIdentity {
    readonly migId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}

export interface CdbVectorReshardRecordIdentity {
    readonly kind: "head" | "outbox" | "attempt";
    readonly vectorId: string;
    readonly physicalVersion: number;
}

export interface CdbVectorReshardProvenance extends CdbVectorReshardRecordIdentity {
    readonly placementVshard: number;
    readonly snapshotThroughLsn: number | null;
    readonly latestTailLsn: number | null;
    readonly present: boolean;
    readonly inserted: boolean;
    readonly imageFingerprint: string | null;
}

export type CdbVectorReshardAbortKind = "attempt" | "outbox" | "head";

export interface CdbVectorReshardAbortCursor {
    readonly kind: CdbVectorReshardAbortKind | "done";
    readonly afterVectorId: string;
    readonly afterPhysicalVersion: number;
}

export const CDB_VECTOR_RESHARD_ABORT_START_CURSOR: CdbVectorReshardAbortCursor = Object.freeze({
    kind: "attempt",
    afterVectorId: "",
    afterPhysicalVersion: 0,
});

interface StoredIdentity {
    readonly range_lo: number | bigint;
    readonly range_hi: number | bigint;
    readonly outcome: "active" | "cleaned";
    readonly record_count: number | bigint;
    readonly interval_count: number | bigint;
    readonly receipt_count: number | bigint;
}

interface StoredProvenance {
    readonly record_kind: CdbVectorReshardRecordIdentity["kind"];
    readonly vector_id: string;
    readonly physical_version: number | bigint;
    readonly placement_vshard: number | bigint;
    readonly snapshot_through_lsn: number | bigint | null;
    readonly latest_tail_lsn: number | bigint | null;
    readonly present: number | bigint;
    readonly inserted: number | bigint;
    readonly image_fingerprint: string | null;
}

interface StoredReceipt {
    readonly table_name: string;
    readonly fingerprint: string;
}

interface StoredInterval {
    readonly page_number: number | bigint;
    readonly record_kind: "head" | "outbox" | "attempt";
    readonly input_cursor_json: string;
    readonly next_cursor_json: string;
    readonly input_placement_vshard: number | bigint;
    readonly input_vector_id: string;
    readonly input_physical_version: number | bigint;
    readonly next_kind: CdbVectorReshardCursor["kind"];
    readonly next_placement_vshard: number | bigint;
    readonly next_vector_id: string;
    readonly next_physical_version: number | bigint;
    readonly through_lsn: number | bigint;
    readonly page_digest: string;
}

function mismatch(message: string): never {
    throw new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message: `vector provenance: ${message}` });
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `vector provenance: ${message}` });
}

function limited(message: string): never {
    throw new CdbError({ code: "CDB_RATE_LIMITED", message: `vector provenance: ${message}` });
}

function safeInteger(value: unknown, subject: string, minimum = 0): number {
    const projected = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(projected) || projected < minimum) mismatch(`${subject} is invalid`);
    return projected;
}

function inputInteger(value: unknown, subject: string, minimum = 0): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid(`${subject} is invalid`);
    return value;
}

function flag(value: unknown, subject: string): boolean {
    const projected = safeInteger(value, subject);
    if (projected !== 0 && projected !== 1) mismatch(`${subject} is invalid`);
    return projected === 1;
}

function digest(value: string | null, present: boolean, subject: string): string | null {
    if (!present) {
        if (value !== null) invalid(`${subject} has a deleted image fingerprint`);
        return null;
    }
    if (typeof value !== "string" || !DIGEST.test(value)) invalid(`${subject} image fingerprint is invalid`);
    return value;
}

function recordKey(key: CdbVectorReshardRecordIdentity): CdbVectorReshardRecordIdentity {
    if (key.kind !== "head" && key.kind !== "outbox" && key.kind !== "attempt") invalid("record kind is invalid");
    if (typeof key.vectorId !== "string" || key.vectorId.length === 0 || TEXT.encode(key.vectorId).byteLength > 256) {
        invalid("vector id is invalid");
    }
    const physicalVersion = inputInteger(key.physicalVersion, "physical version");
    if ((key.kind === "attempt") !== physicalVersion > 0) invalid("record identity is invalid");
    return Object.freeze({ kind: key.kind, vectorId: key.vectorId, physicalVersion });
}

function storedCursor(value: string, subject: string): CdbVectorReshardCursor {
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        mismatch(`${subject} is invalid`);
    }
    const cursor = normalizeCdbVectorReshardCursor(raw);
    if (JSON.stringify(cursor) !== value) mismatch(`${subject} is not canonical`);
    return cursor;
}

function project(row: StoredProvenance): CdbVectorReshardProvenance {
    const present = flag(row.present, "stored presence");
    const imageFingerprint = row.image_fingerprint;
    if (present !== (imageFingerprint !== null) || (imageFingerprint !== null && !DIGEST.test(imageFingerprint))) {
        mismatch("stored image fingerprint is invalid");
    }
    return Object.freeze({
        kind: row.record_kind,
        vectorId: row.vector_id,
        physicalVersion: safeInteger(row.physical_version, "stored physical version"),
        placementVshard: safeInteger(row.placement_vshard, "stored placement vshard"),
        snapshotThroughLsn:
            row.snapshot_through_lsn === null
                ? null
                : safeInteger(row.snapshot_through_lsn, "stored snapshot watermark"),
        latestTailLsn: row.latest_tail_lsn === null ? null : safeInteger(row.latest_tail_lsn, "stored tail LSN", 1),
        present,
        inserted: flag(row.inserted, "stored insertion flag"),
        imageFingerprint,
    });
}

/** Hash one validated physical vector-system row with stable key ordering. */
export function cdbVectorReshardImageFingerprint(value: Readonly<Record<string, unknown>>): string {
    return stableHashHex(value);
}

export type CdbVectorReshardPhysicalKind = "head" | "outbox" | "attempt";

/** Project only columns stored in the named table, then hash one canonical physical image. */
export function cdbVectorReshardPhysicalRowFingerprint(
    kind: CdbVectorReshardPhysicalKind,
    row: Readonly<Record<string, unknown>>
): string {
    if (kind === "head") {
        return cdbVectorReshardImageFingerprint({
            kind,
            vector_id: row.vector_id,
            organization_id: row.organization_id,
            placement_vshard: row.placement_vshard,
            resource_id: row.resource_id,
            row_pk: row.row_pk,
            dimensions: row.dimensions,
            version: row.version,
            delivered_version: row.delivered_version,
            values_hex: row.values_hex,
            metadata_json: row.metadata_json,
            state: row.state,
            updated_at: row.updated_at,
        });
    }
    if (kind === "outbox") {
        return cdbVectorReshardImageFingerprint({
            kind,
            vector_id: row.vector_id,
            target_version: row.target_version,
            operation: row.operation,
            phase: row.phase,
            mutation_id: row.mutation_id,
            accepted_at: row.accepted_at,
            verify_ids_json: row.verify_ids_json,
            attempts: row.attempts,
            next_attempt_at: row.next_attempt_at,
            leased_until: row.leased_until,
            lease_token: row.lease_token,
            terminal_failure: row.terminal_failure,
            last_error: row.last_error,
        });
    }
    return cdbVectorReshardImageFingerprint({
        kind,
        vector_id: row.vector_id,
        physical_version: row.physical_version,
        first_sent_at: row.first_sent_at,
        settle_after: row.settle_after,
        visibility_confirmed: row.visibility_confirmed,
        response_ambiguous: row.response_ambiguous,
        delete_confirmed: row.delete_confirmed,
        delete_claim_token: row.delete_claim_token,
    });
}

function base64ToLowerHex(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string") invalid("snapshot embedding is invalid");
    let bytes: Uint8Array;
    try {
        bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    } catch {
        invalid("snapshot embedding is invalid");
    }
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

/** Fingerprint a normalized logical snapshot record through the same physical projection used by tail replay. */
export function cdbVectorReshardSnapshotRecordFingerprint(record: CdbVectorReshardRecord): string {
    if (record.kind === "head") {
        return cdbVectorReshardPhysicalRowFingerprint("head", {
            vector_id: record.vectorId,
            organization_id: record.organizationId,
            placement_vshard: record.placementVshard,
            resource_id: record.resourceId,
            row_pk: record.rowPk,
            dimensions: record.dimensions,
            version: record.headVersion,
            delivered_version: record.deliveredVersion,
            values_hex: base64ToLowerHex(record.valuesEncBase64),
            metadata_json: record.metadataJson,
            state: record.state,
            updated_at: record.updatedAt,
        });
    }
    if (record.kind === "outbox") {
        return cdbVectorReshardPhysicalRowFingerprint("outbox", {
            vector_id: record.vectorId,
            target_version: record.targetVersion,
            operation: record.operation,
            phase: record.phase,
            mutation_id: record.mutationId,
            accepted_at: record.acceptedAt,
            verify_ids_json: record.verifyIdsJson,
            attempts: record.attempts,
            next_attempt_at: record.nextAttemptAt,
            leased_until: record.leasedUntil,
            lease_token: record.leaseToken,
            terminal_failure: record.terminalFailure,
            last_error: record.lastError,
        });
    }
    return cdbVectorReshardPhysicalRowFingerprint("attempt", {
        vector_id: record.vectorId,
        physical_version: record.physicalVersion,
        first_sent_at: record.firstSentAt,
        settle_after: record.settleAfter,
        visibility_confirmed: record.visibilityConfirmed,
        response_ambiguous: record.responseAmbiguous,
        delete_confirmed: record.deleteConfirmed,
        delete_claim_token: record.deleteClaimToken,
    });
}

export function initializeCdbVectorReshardProvenance(sql: SyncSql): void {
    const statements = CDB_VECTOR_RESHARD_PROVENANCE_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean);
    for (const statement of statements.filter(value => !value.startsWith("CREATE INDEX"))) {
        sql.exec(statement);
    }
    const schemas = [
        [
            "_chardb_vector_reshard_provenance_identity",
            ["mig_id", "range_lo", "range_hi", "outcome", "record_count", "interval_count", "receipt_count"],
        ],
        [
            "_chardb_split_vector_applied",
            [
                "mig_id",
                "record_kind",
                "vector_id",
                "physical_version",
                "placement_vshard",
                "snapshot_through_lsn",
                "latest_tail_lsn",
                "present",
                "inserted",
                "image_fingerprint",
            ],
        ],
        ["_chardb_split_vector_tail_applied", ["mig_id", "lsn", "table_name", "fingerprint"]],
        [
            "_chardb_split_vector_snapshot_intervals",
            [
                "mig_id",
                "page_number",
                "record_kind",
                "input_cursor_json",
                "next_cursor_json",
                "input_placement_vshard",
                "input_vector_id",
                "input_physical_version",
                "next_kind",
                "next_placement_vshard",
                "next_vector_id",
                "next_physical_version",
                "through_lsn",
                "page_digest",
            ],
        ],
    ] as const;
    const incompatible = schemas.filter(([table, expected]) => {
        const actual = sql.all<{ name: string }>(`PRAGMA table_info('${table}')`).map(column => column.name);
        return actual.join("\u0000") !== expected.join("\u0000");
    });
    if (incompatible.length > 0) {
        let rows = 0;
        for (const [table] of schemas) {
            rows += safeInteger(
                sql.one<{ count: number | bigint }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0,
                `legacy ${table} row count`
            );
        }
        if (rows > 0) mismatch(`${incompatible[0]?.[0]} schema is incompatible with an active movement`);
        for (const table of [
            "_chardb_split_vector_snapshot_intervals",
            "_chardb_split_vector_tail_applied",
            "_chardb_split_vector_applied",
            "_chardb_vector_reshard_provenance_identity",
        ]) {
            sql.exec(`DROP TABLE ${table}`);
        }
        for (const statement of statements.filter(value => !value.startsWith("CREATE INDEX"))) sql.exec(statement);
    }
    for (const [table, expected] of schemas) {
        const actual = sql.all<{ name: string }>(`PRAGMA table_info('${table}')`).map(column => column.name);
        if (actual.join("\u0000") !== expected.join("\u0000")) mismatch(`${table} schema is incompatible`);
    }
    for (const statement of statements.filter(value => value.startsWith("CREATE INDEX"))) sql.exec(statement);
}

export class CdbVectorReshardProvenanceStore {
    private boundIdentity: CdbVectorReshardProvenanceIdentity | null = null;

    constructor(private readonly sql: SyncSql) {}

    bind(identity: CdbVectorReshardProvenanceIdentity): void {
        if (
            typeof identity.migId !== "string" ||
            identity.migId.length === 0 ||
            TEXT.encode(identity.migId).byteLength > 256
        ) {
            invalid("migration identity is invalid");
        }
        const rangeLo = inputInteger(identity.rangeLo, "range start");
        const rangeHi = inputInteger(identity.rangeHi, "range end");
        if (rangeLo > rangeHi || rangeHi >= 16_384) invalid("migration range is invalid");
        if (
            this.boundIdentity?.migId === identity.migId &&
            this.boundIdentity.rangeLo === rangeLo &&
            this.boundIdentity.rangeHi === rangeHi
        ) {
            return;
        }
        const existing = this.sql.one<StoredIdentity>(
            `SELECT range_lo, range_hi, outcome, record_count, interval_count, receipt_count
             FROM _chardb_vector_reshard_provenance_identity WHERE mig_id = ?`,
            identity.migId
        );
        if (existing) {
            if (
                safeInteger(existing.range_lo, "stored range start") !== rangeLo ||
                safeInteger(existing.range_hi, "stored range end") !== rangeHi
            ) {
                mismatch(`migration ${identity.migId} changed its range`);
            }
            this.assertStoredCounts(existing);
            if (existing.outcome !== "active") mismatch(`migration ${identity.migId} provenance was cleaned`);
            this.boundIdentity = Object.freeze({ ...identity, rangeLo, rangeHi });
            return;
        }
        if (
            this.sql.one(
                "SELECT 1 AS present FROM _chardb_vector_reshard_provenance_identity LIMIT 1 OFFSET ?",
                CDB_SPLIT_IDENTITY_LIMIT - 1
            )
        ) {
            limited("migration history reached its row limit");
        }
        this.sql.exec(
            "INSERT INTO _chardb_vector_reshard_provenance_identity (mig_id, range_lo, range_hi) VALUES (?, ?, ?)",
            identity.migId,
            rangeLo,
            rangeHi
        );
        if (this.sql.changes() !== 1) mismatch("migration identity was not inserted");
        this.boundIdentity = Object.freeze({ ...identity, rangeLo, rangeHi });
    }

    read(
        identity: CdbVectorReshardProvenanceIdentity,
        input: CdbVectorReshardRecordIdentity
    ): CdbVectorReshardProvenance | null {
        this.bind(identity);
        const key = recordKey(input);
        const row = this.sql.one<StoredProvenance>(
            `SELECT record_kind, vector_id, physical_version, snapshot_through_lsn, latest_tail_lsn,
                    placement_vshard, present, inserted, image_fingerprint
             FROM _chardb_split_vector_applied
             WHERE mig_id = ? AND record_kind = ? AND vector_id = ? AND physical_version = ?`,
            identity.migId,
            key.kind,
            key.vectorId,
            key.physicalVersion
        );
        return row ? project(row) : null;
    }

    shouldSkipSnapshot(
        identity: CdbVectorReshardProvenanceIdentity,
        input: CdbVectorReshardRecordIdentity,
        throughLsn: number
    ): boolean {
        const watermark = inputInteger(throughLsn, "snapshot watermark");
        const row = this.read(identity, input);
        return row?.latestTailLsn !== null && row?.latestTailLsn !== undefined && row.latestTailLsn > watermark;
    }

    recordSnapshot(
        identity: CdbVectorReshardProvenanceIdentity,
        input: CdbVectorReshardRecordIdentity & {
            readonly throughLsn: number;
            readonly placementVshard: number;
            readonly inserted: boolean;
            readonly imageFingerprint: string;
        }
    ): void {
        this.recordSnapshotFromRead(identity, input, this.read(identity, input));
    }

    /** Complete a snapshot write from one prior `read`; SQL CAS still authenticates every prior field. */
    recordSnapshotFromRead(
        identity: CdbVectorReshardProvenanceIdentity,
        input: CdbVectorReshardRecordIdentity & {
            readonly throughLsn: number;
            readonly placementVshard: number;
            readonly inserted: boolean;
            readonly imageFingerprint: string;
        },
        prior: CdbVectorReshardProvenance | null
    ): void {
        this.bind(identity);
        const key = recordKey(input);
        const throughLsn = inputInteger(input.throughLsn, "snapshot watermark");
        const placementVshard = inputInteger(input.placementVshard, "snapshot placement vshard");
        if (placementVshard >= 16_384) invalid("snapshot placement vshard is invalid");
        const imageFingerprint = digest(input.imageFingerprint, true, "snapshot") as string;
        if (
            prior !== null &&
            (prior.kind !== key.kind ||
                prior.vectorId !== key.vectorId ||
                prior.physicalVersion !== key.physicalVersion)
        ) {
            invalid("snapshot prior belongs to another record");
        }
        if (prior?.snapshotThroughLsn !== null && prior?.snapshotThroughLsn !== undefined) {
            mismatch(`${key.kind} ${key.vectorId} appears in more than one snapshot page`);
        }
        if (prior && prior.placementVshard !== placementVshard) mismatch("snapshot placement changed");
        if (prior?.latestTailLsn !== null && prior?.latestTailLsn !== undefined && prior.latestTailLsn > throughLsn) {
            mismatch("snapshot attempted to overwrite newer tail provenance");
        }
        if (prior?.latestTailLsn !== null && prior?.latestTailLsn !== undefined) {
            if (!prior.present) mismatch("snapshot attempted to resurrect a tail delete tombstone");
            if (prior.imageFingerprint !== imageFingerprint) {
                mismatch("snapshot image differs from tail provenance covered by its watermark");
            }
        }
        if (prior) {
            this.sql.exec(
                `UPDATE _chardb_split_vector_applied
                 SET snapshot_through_lsn = ?, present = 1, inserted = MAX(inserted, ?), image_fingerprint = ?
                 WHERE mig_id = ? AND record_kind = ? AND vector_id = ? AND physical_version = ?
                   AND snapshot_through_lsn IS NULL AND latest_tail_lsn IS ? AND present = ? AND inserted = ?
                   AND placement_vshard = ? AND image_fingerprint IS ?
                   AND (latest_tail_lsn IS NULL OR latest_tail_lsn <= ?)`,
                throughLsn,
                input.inserted ? 1 : 0,
                imageFingerprint,
                identity.migId,
                key.kind,
                key.vectorId,
                key.physicalVersion,
                prior.latestTailLsn,
                prior.present ? 1 : 0,
                prior.inserted ? 1 : 0,
                prior.placementVshard,
                prior.imageFingerprint,
                throughLsn
            );
            if (this.sql.changes() !== 1) mismatch("snapshot provenance changed concurrently");
            return;
        }
        this.sql.exec(
            `INSERT INTO _chardb_split_vector_applied
               (mig_id, record_kind, vector_id, physical_version, placement_vshard, snapshot_through_lsn, latest_tail_lsn,
                present, inserted, image_fingerprint)
             SELECT ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?
             FROM _chardb_vector_reshard_provenance_identity
             WHERE mig_id = ? AND outcome = 'active' AND record_count < ?`,
            identity.migId,
            key.kind,
            key.vectorId,
            key.physicalVersion,
            placementVshard,
            throughLsn,
            input.inserted ? 1 : 0,
            imageFingerprint,
            identity.migId,
            CDB_VECTOR_RESHARD_PROVENANCE_LIMIT
        );
        if (this.sql.changes() !== 1) limited("record provenance reached its durable row limit");
        this.incrementCount(identity.migId, "record_count", CDB_VECTOR_RESHARD_PROVENANCE_LIMIT);
    }

    recordTail(
        identity: CdbVectorReshardProvenanceIdentity,
        input: CdbVectorReshardRecordIdentity & {
            readonly lsn: number;
            readonly placementVshard: number;
            readonly present: boolean;
            readonly inserted: boolean;
            readonly imageFingerprint: string | null;
        }
    ): void {
        const key = recordKey(input);
        const lsn = inputInteger(input.lsn, "tail LSN", 1);
        const placementVshard = inputInteger(input.placementVshard, "tail placement vshard");
        if (placementVshard >= 16_384) invalid("tail placement vshard is invalid");
        const imageFingerprint = digest(input.imageFingerprint, input.present, "tail");
        const prior = this.read(identity, key);
        if (prior?.latestTailLsn !== null && prior?.latestTailLsn !== undefined) {
            if (lsn < prior.latestTailLsn) mismatch("tail provenance LSN regressed");
            if (lsn === prior.latestTailLsn) {
                if (prior.present !== input.present || prior.imageFingerprint !== imageFingerprint) {
                    mismatch("tail provenance retry changed its record image");
                }
                return;
            }
        }
        if (prior && prior.placementVshard !== placementVshard) mismatch("tail placement changed");
        if (prior) {
            this.sql.exec(
                `UPDATE _chardb_split_vector_applied
                 SET latest_tail_lsn = ?, present = ?, inserted = MAX(inserted, ?), image_fingerprint = ?
                 WHERE mig_id = ? AND record_kind = ? AND vector_id = ? AND physical_version = ?
                   AND placement_vshard = ? AND (latest_tail_lsn IS NULL OR latest_tail_lsn < ?)`,
                lsn,
                input.present ? 1 : 0,
                input.inserted ? 1 : 0,
                imageFingerprint,
                identity.migId,
                key.kind,
                key.vectorId,
                key.physicalVersion,
                prior.placementVshard,
                lsn
            );
            if (this.sql.changes() !== 1) mismatch("tail provenance changed concurrently");
            return;
        }
        this.sql.exec(
            `INSERT INTO _chardb_split_vector_applied
               (mig_id, record_kind, vector_id, physical_version, placement_vshard, snapshot_through_lsn, latest_tail_lsn,
                present, inserted, image_fingerprint)
             SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?
             FROM _chardb_vector_reshard_provenance_identity
             WHERE mig_id = ? AND outcome = 'active' AND record_count < ?`,
            identity.migId,
            key.kind,
            key.vectorId,
            key.physicalVersion,
            placementVshard,
            lsn,
            input.present ? 1 : 0,
            input.inserted ? 1 : 0,
            imageFingerprint,
            identity.migId,
            CDB_VECTOR_RESHARD_PROVENANCE_LIMIT
        );
        if (this.sql.changes() !== 1) limited("record provenance reached its durable row limit");
        this.incrementCount(identity.migId, "record_count", CDB_VECTOR_RESHARD_PROVENANCE_LIMIT);
    }

    assertReceipt(
        identity: CdbVectorReshardProvenanceIdentity,
        input: { readonly lsn: number; readonly tableName: string; readonly fingerprint: string }
    ): void {
        if (!this.hasReceipt(identity, input)) mismatch(`applied LSN ${input.lsn} has no durable receipt`);
    }

    hasReceipt(
        identity: CdbVectorReshardProvenanceIdentity,
        input: { readonly lsn: number; readonly tableName: string; readonly fingerprint: string }
    ): boolean {
        this.bind(identity);
        const lsn = inputInteger(input.lsn, "tail receipt LSN", 1);
        const fingerprint = digest(input.fingerprint, true, "tail receipt") as string;
        const receipt = this.sql.one<StoredReceipt>(
            "SELECT table_name, fingerprint FROM _chardb_split_vector_tail_applied WHERE mig_id = ? AND lsn = ?",
            identity.migId,
            lsn
        );
        if (!receipt) return false;
        if (receipt.table_name !== input.tableName || receipt.fingerprint !== fingerprint) {
            mismatch(`applied LSN ${lsn} was retried with different bytes`);
        }
        return true;
    }

    recordReceipt(
        identity: CdbVectorReshardProvenanceIdentity,
        input: { readonly lsn: number; readonly tableName: string; readonly fingerprint: string }
    ): void {
        this.bind(identity);
        const lsn = inputInteger(input.lsn, "tail receipt LSN", 1);
        const fingerprint = digest(input.fingerprint, true, "tail receipt") as string;
        const existing = this.sql.one<StoredReceipt>(
            "SELECT table_name, fingerprint FROM _chardb_split_vector_tail_applied WHERE mig_id = ? AND lsn = ?",
            identity.migId,
            lsn
        );
        if (existing) {
            this.assertReceipt(identity, input);
            return;
        }
        this.sql.exec(
            `INSERT INTO _chardb_split_vector_tail_applied (mig_id, lsn, table_name, fingerprint)
             SELECT ?, ?, ?, ? FROM _chardb_vector_reshard_provenance_identity
             WHERE mig_id = ? AND outcome = 'active' AND receipt_count < ?`,
            identity.migId,
            lsn,
            input.tableName,
            fingerprint,
            identity.migId,
            CDB_SPLIT_LOG_MAX_ROWS
        );
        if (this.sql.changes() !== 1) limited("tail receipt history reached the split-log row limit");
        this.incrementCount(identity.migId, "receipt_count", CDB_SPLIT_LOG_MAX_ROWS);
    }

    /** Persist the exact key interval scanned by one committed snapshot page. */
    recordSnapshotInterval(
        identity: CdbVectorReshardProvenanceIdentity,
        input: {
            readonly pageNumber: number;
            readonly cursor: CdbVectorReshardCursor;
            readonly next: CdbVectorReshardCursor;
            readonly throughLsn: number;
            readonly pageDigest: string;
        }
    ): void {
        this.bind(identity);
        const pageNumber = inputInteger(input.pageNumber, "snapshot interval page number");
        const cursor = normalizeCdbVectorReshardCursor(input.cursor);
        const next = normalizeCdbVectorReshardCursor(input.next);
        if (cursor.kind === "done" || next.throughHeadSeq !== cursor.throughHeadSeq) {
            invalid("snapshot interval cursor is invalid");
        }
        const throughLsn = inputInteger(input.throughLsn, "snapshot interval watermark");
        if (typeof input.pageDigest !== "string" || !DIGEST.test(input.pageDigest)) {
            invalid("snapshot interval page digest is invalid");
        }
        const cursorJson = JSON.stringify(cursor);
        const nextJson = JSON.stringify(next);
        const existing = this.sql.one<StoredInterval>(
            `SELECT page_number, record_kind, input_cursor_json, next_cursor_json,
                    input_placement_vshard, input_vector_id, input_physical_version,
                    next_kind, next_placement_vshard, next_vector_id, next_physical_version,
                    through_lsn, page_digest
             FROM _chardb_split_vector_snapshot_intervals WHERE mig_id = ? AND page_number = ?`,
            identity.migId,
            pageNumber
        );
        if (existing) {
            if (
                existing.record_kind !== cursor.kind ||
                existing.input_cursor_json !== cursorJson ||
                existing.next_cursor_json !== nextJson ||
                safeInteger(existing.through_lsn, "stored snapshot interval watermark") !== throughLsn ||
                existing.page_digest !== input.pageDigest
            ) {
                mismatch("snapshot interval page retry changed its identity");
            }
            return;
        }
        this.sql.exec(
            `INSERT INTO _chardb_split_vector_snapshot_intervals
               (mig_id, page_number, record_kind, input_cursor_json, next_cursor_json,
                input_placement_vshard, input_vector_id, input_physical_version,
                next_kind, next_placement_vshard, next_vector_id, next_physical_version,
                through_lsn, page_digest)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM _chardb_vector_reshard_provenance_identity
             WHERE mig_id = ? AND outcome = 'active' AND interval_count = ? AND interval_count < ?`,
            identity.migId,
            pageNumber,
            cursor.kind,
            cursorJson,
            nextJson,
            cursor.afterPlacement,
            cursor.afterVectorId,
            cursor.afterPhysicalVersion,
            next.kind,
            next.afterPlacement,
            next.afterVectorId,
            next.afterPhysicalVersion,
            throughLsn,
            input.pageDigest,
            identity.migId,
            pageNumber,
            CDB_VECTOR_RESHARD_INTERVAL_LIMIT
        );
        if (this.sql.changes() !== 1) {
            const stored = this.requiredIdentity(identity, false);
            if (
                safeInteger(stored.interval_count, "stored snapshot interval count") >=
                CDB_VECTOR_RESHARD_INTERVAL_LIMIT
            ) {
                limited("snapshot interval history reached its durable row limit");
            }
            mismatch("snapshot interval page number is not the next expected page");
        }
        this.incrementCount(identity.migId, "interval_count", CDB_VECTOR_RESHARD_INTERVAL_LIMIT);
    }

    /** Authenticate that a missing preexisting update/delete was absent from a completed page scan. */
    coversSnapshotAbsence(
        identity: CdbVectorReshardProvenanceIdentity,
        input: CdbVectorReshardRecordIdentity & {
            readonly placementVshard: number;
            readonly lsn: number;
        }
    ): boolean {
        this.bind(identity);
        const key = recordKey(input);
        const placement = inputInteger(input.placementVshard, "absence placement vshard");
        if (placement >= 16_384) invalid("absence placement vshard is invalid");
        if (placement < identity.rangeLo || placement > identity.rangeHi) {
            invalid("absence placement vshard is outside the moving range");
        }
        const lsn = inputInteger(input.lsn, "absence LSN", 1);
        const interval = this.sql.one<StoredInterval>(
            `SELECT page_number, record_kind, input_cursor_json, next_cursor_json,
                        input_placement_vshard, input_vector_id, input_physical_version,
                        next_kind, next_placement_vshard, next_vector_id, next_physical_version,
                        through_lsn, page_digest
                 FROM _chardb_split_vector_snapshot_intervals
                 WHERE mig_id = ? AND record_kind = ? AND through_lsn >= ?
                   AND (input_placement_vshard < ? OR (input_placement_vshard = ? AND (
                     input_vector_id < ? OR (input_vector_id = ? AND input_physical_version < ?)
                   )))
                   AND (next_kind <> record_kind OR next_placement_vshard > ? OR
                     (next_placement_vshard = ? AND (next_vector_id > ? OR
                       (next_vector_id = ? AND next_physical_version >= ?))))
                 LIMIT 1`,
            identity.migId,
            key.kind,
            lsn,
            placement,
            placement,
            key.vectorId,
            key.vectorId,
            key.physicalVersion,
            placement,
            placement,
            key.vectorId,
            key.vectorId,
            key.physicalVersion
        );
        if (!interval) return false;
        const intervalInput = storedCursor(interval.input_cursor_json, "stored interval input cursor");
        const intervalNext = storedCursor(interval.next_cursor_json, "stored interval next cursor");
        if (
            interval.record_kind !== intervalInput.kind ||
            safeInteger(interval.input_placement_vshard, "stored interval input placement", -1) !==
                intervalInput.afterPlacement ||
            interval.input_vector_id !== intervalInput.afterVectorId ||
            safeInteger(interval.input_physical_version, "stored interval input version") !==
                intervalInput.afterPhysicalVersion ||
            interval.next_kind !== intervalNext.kind ||
            safeInteger(interval.next_placement_vshard, "stored interval next placement", -1) !==
                intervalNext.afterPlacement ||
            interval.next_vector_id !== intervalNext.afterVectorId ||
            safeInteger(interval.next_physical_version, "stored interval next version") !==
                intervalNext.afterPhysicalVersion ||
            intervalNext.throughHeadSeq !== intervalInput.throughHeadSeq ||
            !DIGEST.test(interval.page_digest)
        ) {
            mismatch("stored snapshot interval is inconsistent");
        }
        safeInteger(interval.page_number, "stored interval page number");
        safeInteger(interval.through_lsn, "stored interval watermark");
        return true;
    }

    /** Authenticate the monotonic one-interval-per-committed-page invariant. */
    assertSnapshotIntervalCount(identity: CdbVectorReshardProvenanceIdentity, expected: number): void {
        this.bind(identity);
        const exact = inputInteger(expected, "expected snapshot interval count");
        const stored = this.requiredIdentity(identity, false);
        if (safeInteger(stored.interval_count, "stored snapshot interval count") !== exact) {
            mismatch("snapshot interval count does not match committed pages");
        }
    }

    counts(identity: CdbVectorReshardProvenanceIdentity): { readonly records: number; readonly receipts: number } {
        this.bind(identity);
        const stored = this.requiredIdentity(identity, true);
        const row = this.sql.one<{ records: number | bigint; intervals: number | bigint; receipts: number | bigint }>(
            `SELECT (SELECT COUNT(*) FROM _chardb_split_vector_applied WHERE mig_id = ?) AS records,
                    (SELECT COUNT(*) FROM _chardb_split_vector_snapshot_intervals WHERE mig_id = ?) AS intervals,
                    (SELECT COUNT(*) FROM _chardb_split_vector_tail_applied WHERE mig_id = ?) AS receipts`,
            identity.migId,
            identity.migId,
            identity.migId
        );
        const records = safeInteger(row?.records ?? 0, "provenance record count");
        const intervals = safeInteger(row?.intervals ?? 0, "snapshot interval count");
        const receipts = safeInteger(row?.receipts ?? 0, "tail receipt count");
        if (
            records > CDB_VECTOR_RESHARD_PROVENANCE_LIMIT ||
            intervals > CDB_VECTOR_RESHARD_INTERVAL_LIMIT ||
            receipts > CDB_SPLIT_LOG_MAX_ROWS
        ) {
            mismatch("provenance history exceeds its durable bound");
        }
        if (
            records !== safeInteger(stored.record_count, "stored provenance record count") ||
            intervals !== safeInteger(stored.interval_count, "stored snapshot interval count") ||
            receipts !== safeInteger(stored.receipt_count, "stored tail receipt count")
        )
            mismatch("provenance counters do not match their durable rows");
        return Object.freeze({ records, receipts });
    }

    /** Read one bounded abort page in child-first foreign-key order. */
    readAbortPage(
        identity: CdbVectorReshardProvenanceIdentity,
        input: CdbVectorReshardAbortCursor,
        limit = 500
    ): { readonly records: readonly CdbVectorReshardProvenance[]; readonly next: CdbVectorReshardAbortCursor } {
        this.bind(identity);
        if (input.kind === "done") {
            if (input.afterVectorId !== "" || input.afterPhysicalVersion !== 0) invalid("abort cursor is invalid");
            return Object.freeze({ records: Object.freeze([]), next: input });
        }
        if (input.kind !== "attempt" && input.kind !== "outbox" && input.kind !== "head") {
            invalid("abort cursor kind is invalid");
        }
        if (typeof input.afterVectorId !== "string" || TEXT.encode(input.afterVectorId).byteLength > 256) {
            invalid("abort cursor vector id is invalid");
        }
        const afterPhysicalVersion = inputInteger(input.afterPhysicalVersion, "abort cursor physical version");
        if (input.kind !== "attempt" && afterPhysicalVersion !== 0) invalid("abort cursor physical version is invalid");
        const boundedLimit = inputInteger(limit, "abort page limit", 1);
        if (boundedLimit > 500) invalid("abort page limit exceeds 500");
        const rows = this.sql.all<StoredProvenance>(
            `SELECT record_kind, vector_id, physical_version, snapshot_through_lsn, latest_tail_lsn,
                    placement_vshard, present, inserted, image_fingerprint
             FROM _chardb_split_vector_applied
             WHERE mig_id = ? AND record_kind = ?
               AND (vector_id > ? OR (vector_id = ? AND physical_version > ?))
             ORDER BY vector_id, physical_version LIMIT ?`,
            identity.migId,
            input.kind,
            input.afterVectorId,
            input.afterVectorId,
            afterPhysicalVersion,
            boundedLimit
        );
        const records = Object.freeze(rows.map(project));
        const last = records.at(-1);
        if (last && records.length === boundedLimit) {
            return Object.freeze({
                records,
                next: Object.freeze({
                    kind: input.kind,
                    afterVectorId: last.vectorId,
                    afterPhysicalVersion: last.physicalVersion,
                }),
            });
        }
        const nextKind = input.kind === "attempt" ? "outbox" : input.kind === "outbox" ? "head" : "done";
        return Object.freeze({
            records,
            next: Object.freeze({ kind: nextKind, afterVectorId: "", afterPhysicalVersion: 0 }),
        });
    }

    /** Remove one provenance row only if its complete durable image is unchanged. */
    removeForAbort(identity: CdbVectorReshardProvenanceIdentity, prior: CdbVectorReshardProvenance): void {
        this.bind(identity);
        const key = recordKey(prior);
        this.sql.exec(
            `DELETE FROM _chardb_split_vector_applied
             WHERE mig_id = ? AND record_kind = ? AND vector_id = ? AND physical_version = ?
               AND snapshot_through_lsn IS ? AND latest_tail_lsn IS ? AND present = ? AND inserted = ?
               AND placement_vshard = ? AND image_fingerprint IS ?`,
            identity.migId,
            key.kind,
            key.vectorId,
            key.physicalVersion,
            prior.snapshotThroughLsn,
            prior.latestTailLsn,
            prior.present ? 1 : 0,
            prior.inserted ? 1 : 0,
            prior.placementVshard,
            prior.imageFingerprint
        );
        if (this.sql.changes() !== 1) mismatch("abort provenance changed concurrently");
        this.decrementCount(identity.migId, "record_count", 1);
    }

    /**
     * Compact absent record tombstones only after both independent frontiers
     * prove they can no longer meet a snapshot page or a replayed tail entry.
     */
    compactTombstones(
        identity: CdbVectorReshardProvenanceIdentity,
        input: {
            readonly snapshotCursor: CdbVectorReshardCursor;
            readonly acknowledgedThroughLsn: number;
            readonly limit?: number;
        }
    ): { readonly compacted: number } {
        this.bind(identity);
        const cursor = normalizeCdbVectorReshardCursor(input.snapshotCursor);
        const acknowledged = inputInteger(input.acknowledgedThroughLsn, "tombstone acknowledgement frontier");
        const limit = inputInteger(input.limit ?? 500, "tombstone compaction limit", 1);
        if (limit > 500) invalid("tombstone compaction limit exceeds 500");
        const kindRank = cursor.kind === "head" ? 0 : cursor.kind === "outbox" ? 1 : cursor.kind === "attempt" ? 2 : 3;
        this.sql.exec(
            `DELETE FROM _chardb_split_vector_applied WHERE rowid IN (
               SELECT rowid FROM _chardb_split_vector_applied
               WHERE mig_id = ? AND present = 0 AND latest_tail_lsn IS NOT NULL AND latest_tail_lsn <= ?
                 AND (
                   CASE record_kind WHEN 'head' THEN 0 WHEN 'outbox' THEN 1 ELSE 2 END < ?
                   OR (CASE record_kind WHEN 'head' THEN 0 WHEN 'outbox' THEN 1 ELSE 2 END = ? AND (
                     placement_vshard < ? OR (placement_vshard = ? AND (
                       vector_id < ? OR (vector_id = ? AND physical_version <= ?)
                     ))
                   ))
                 )
               ORDER BY CASE record_kind WHEN 'head' THEN 0 WHEN 'outbox' THEN 1 ELSE 2 END,
                        placement_vshard, vector_id, physical_version
               LIMIT ?
             )`,
            identity.migId,
            acknowledged,
            kindRank,
            kindRank,
            cursor.afterPlacement,
            cursor.afterPlacement,
            cursor.afterVectorId,
            cursor.afterVectorId,
            cursor.afterPhysicalVersion,
            limit
        );
        const compacted = this.sql.changes();
        if (compacted > 0) this.decrementCount(identity.migId, "record_count", compacted);
        return Object.freeze({ compacted });
    }

    /** Prune receipts only through a caller-authenticated durable source acknowledgement frontier. */
    pruneReceipts(
        identity: CdbVectorReshardProvenanceIdentity,
        acknowledgedThroughLsn: number,
        limit = 500
    ): { readonly pruned: number } {
        this.bind(identity);
        const frontier = inputInteger(acknowledgedThroughLsn, "receipt acknowledgement frontier");
        const boundedLimit = inputInteger(limit, "receipt prune limit", 1);
        if (boundedLimit > 500) invalid("receipt prune limit exceeds 500");
        this.sql.exec(
            `DELETE FROM _chardb_split_vector_tail_applied
             WHERE rowid IN (
               SELECT rowid FROM _chardb_split_vector_tail_applied
               WHERE mig_id = ? AND lsn <= ? ORDER BY lsn LIMIT ?
             )`,
            identity.migId,
            frontier,
            boundedLimit
        );
        const pruned = this.sql.changes();
        if (pruned > 0) this.decrementCount(identity.migId, "receipt_count", pruned);
        return Object.freeze({ pruned });
    }

    /** Delete at most one bounded page, retaining the exact migration tombstone. */
    cleanup(identity: CdbVectorReshardProvenanceIdentity, limit = 500): { readonly cleaned: boolean } {
        const row = this.requiredIdentity(identity, true);
        if (row.outcome === "cleaned") return Object.freeze({ cleaned: false });
        const boundedLimit = inputInteger(limit, "cleanup page limit", 1);
        if (boundedLimit > 500) invalid("cleanup page limit exceeds 500");
        this.sql.exec(
            `DELETE FROM _chardb_split_vector_applied WHERE rowid IN
               (SELECT rowid FROM _chardb_split_vector_applied WHERE mig_id = ? LIMIT ?)`,
            identity.migId,
            boundedLimit
        );
        const removedRecords = this.sql.changes();
        if (removedRecords > 0) this.decrementCount(identity.migId, "record_count", removedRecords);
        const intervalBudget = boundedLimit - removedRecords;
        let removedIntervals = 0;
        if (intervalBudget > 0) {
            this.sql.exec(
                `DELETE FROM _chardb_split_vector_snapshot_intervals WHERE rowid IN
                   (SELECT rowid FROM _chardb_split_vector_snapshot_intervals WHERE mig_id = ? LIMIT ?)`,
                identity.migId,
                intervalBudget
            );
            removedIntervals = this.sql.changes();
            if (removedIntervals > 0) this.decrementCount(identity.migId, "interval_count", removedIntervals);
        }
        const receiptBudget = intervalBudget - removedIntervals;
        let removedReceipts = 0;
        if (receiptBudget > 0) {
            this.sql.exec(
                `DELETE FROM _chardb_split_vector_tail_applied WHERE rowid IN
                   (SELECT rowid FROM _chardb_split_vector_tail_applied WHERE mig_id = ? LIMIT ?)`,
                identity.migId,
                receiptBudget
            );
            removedReceipts = this.sql.changes();
            if (removedReceipts > 0) this.decrementCount(identity.migId, "receipt_count", removedReceipts);
        }
        const remaining = this.requiredIdentity(identity, true);
        if (
            safeInteger(remaining.record_count, "stored provenance record count") !== 0 ||
            safeInteger(remaining.interval_count, "stored snapshot interval count") !== 0 ||
            safeInteger(remaining.receipt_count, "stored receipt count") !== 0
        ) {
            return Object.freeze({ cleaned: false });
        }
        this.sql.exec(
            `UPDATE _chardb_vector_reshard_provenance_identity
             SET outcome = 'cleaned', record_count = 0, interval_count = 0, receipt_count = 0
             WHERE mig_id = ? AND outcome = 'active'`,
            identity.migId
        );
        if (this.sql.changes() !== 1) mismatch("migration provenance identity was not cleaned");
        this.boundIdentity = null;
        return Object.freeze({ cleaned: true });
    }

    private requiredIdentity(identity: CdbVectorReshardProvenanceIdentity, allowCleaned: boolean): StoredIdentity {
        const row = this.sql.one<StoredIdentity>(
            `SELECT range_lo, range_hi, outcome, record_count, interval_count, receipt_count
             FROM _chardb_vector_reshard_provenance_identity WHERE mig_id = ?`,
            identity.migId
        );
        if (!row) mismatch(`migration ${identity.migId} has no provenance identity`);
        if (
            safeInteger(row.range_lo, "stored range start") !== identity.rangeLo ||
            safeInteger(row.range_hi, "stored range end") !== identity.rangeHi
        )
            mismatch(`migration ${identity.migId} changed its range`);
        this.assertStoredCounts(row);
        if (!allowCleaned && row.outcome !== "active") mismatch(`migration ${identity.migId} provenance was cleaned`);
        return row;
    }

    private assertStoredCounts(row: StoredIdentity): void {
        safeInteger(row.record_count, "stored provenance record count");
        safeInteger(row.interval_count, "stored snapshot interval count");
        safeInteger(row.receipt_count, "stored tail receipt count");
        if (row.outcome !== "active" && row.outcome !== "cleaned") mismatch("stored provenance outcome is invalid");
    }

    private incrementCount(
        migId: string,
        column: "record_count" | "interval_count" | "receipt_count",
        cap: number
    ): void {
        this.sql.exec(
            `UPDATE _chardb_vector_reshard_provenance_identity SET ${column} = ${column} + 1
             WHERE mig_id = ? AND outcome = 'active' AND ${column} < ?`,
            migId,
            cap
        );
        if (this.sql.changes() !== 1) mismatch(`provenance ${column} did not advance`);
    }

    private decrementCount(
        migId: string,
        column: "record_count" | "interval_count" | "receipt_count",
        amount: number
    ): void {
        this.sql.exec(
            `UPDATE _chardb_vector_reshard_provenance_identity SET ${column} = ${column} - ?
             WHERE mig_id = ? AND outcome = 'active' AND ${column} >= ?`,
            amount,
            migId,
            amount
        );
        if (this.sql.changes() !== 1) mismatch(`provenance ${column} did not decrease`);
    }
}
