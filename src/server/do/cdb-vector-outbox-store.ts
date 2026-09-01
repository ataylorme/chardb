import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { stableJson } from "../../util/canonical.ts";
import { VSHARD_COUNT, vshardOf } from "../../vshard.ts";
import {
    CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL,
    CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL,
} from "./cdb-background-delivery-ownership-sql.ts";

export const CDB_VECTOR_MAX_DIMENSIONS = 1_536;
export const CDB_VECTOR_MAX_VALUES_BYTES = CDB_VECTOR_MAX_DIMENSIONS * 4;
export const CDB_VECTOR_MAX_METADATA_BYTES = 16 * 1_024;
export const CDB_VECTOR_MAX_DELETE_IDS = 32;
export const CDB_VECTOR_MAX_DELETE_ID_BYTES = 8 * 1_024;
export const CDB_VECTOR_MAX_ERROR_BYTES = 1_024;
export const CDB_VECTOR_MAX_ATTEMPT_VERSIONS = 4_096;
export const CDB_VECTOR_MAX_HEADS = 65_536;
export const CDB_VECTOR_MAX_OUTBOX_ROWS = 65_536;
export const CDB_VECTOR_MAX_STORED_BYTES = 64 * 1_024 * 1_024;
export const CDB_VECTOR_MAX_ATTEMPT_ROWS = 262_144;
export const CDB_VECTOR_ACCEPTED_DELETE_SETTLEMENT_MS = 120_000;
export const CDB_VECTOR_UNCERTAIN_DELETE_RETRY_MS = 5 * 60_000;
export const CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS = 32;
export const CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR = "terminal: external vector absence could not be proven";

export const CDB_VECTOR_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_deleted_organizations (
  organization_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0),
  placement_vshard INTEGER NOT NULL CHECK (placement_vshard >= 0 AND placement_vshard < 16384),
  vector_unproven_turns INTEGER NOT NULL DEFAULT 0 CHECK (vector_unproven_turns BETWEEN 0 AND 32)
);
CREATE TABLE IF NOT EXISTS _chardb_vectors (
  vector_id          TEXT PRIMARY KEY,
  created_seq        INTEGER NOT NULL CHECK (created_seq > 0),
  organization_id    TEXT NOT NULL,
  placement_vshard   INTEGER NOT NULL CHECK (placement_vshard BETWEEN 0 AND 16383),
  resource_id        TEXT NOT NULL,
  row_pk             TEXT NOT NULL,
  dimensions         INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 1536),
  version            INTEGER NOT NULL CHECK (version > 0),
  delivered_version  INTEGER NOT NULL DEFAULT 0 CHECK (delivered_version >= 0 AND delivered_version <= version),
  values_enc         BLOB,
  metadata_json      TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting')),
  updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (resource_id, organization_id, row_pk),
  CHECK ((state = 'ready' AND delivered_version = version)
      OR (state IN ('pending', 'deleting') AND delivered_version < version)),
  CHECK ((state = 'deleting' AND values_enc IS NULL) OR (state IN ('pending', 'ready') AND values_enc IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS _chardb_vector_outbox (
  vector_id       TEXT PRIMARY KEY,
  target_version  INTEGER NOT NULL CHECK (target_version > 0),
  operation       TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  phase           TEXT NOT NULL DEFAULT 'submit' CHECK (phase IN ('submit', 'verify')),
  mutation_id     TEXT,
  accepted_at     INTEGER CHECK (accepted_at IS NULL OR accepted_at >= 0),
  verify_ids_json TEXT,
  attempts        INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  leased_until    INTEGER CHECK (leased_until IS NULL OR leased_until >= 0),
  lease_token     TEXT,
  terminal_failure INTEGER NOT NULL DEFAULT 0 CHECK (terminal_failure IN (0, 1)),
  last_error      TEXT,
  CHECK ((leased_until IS NULL AND lease_token IS NULL) OR (leased_until IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK ((phase = 'submit' AND mutation_id IS NULL AND accepted_at IS NULL)
      OR (phase = 'verify' AND mutation_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (operation = 'delete' OR verify_ids_json IS NULL),
  FOREIGN KEY (vector_id) REFERENCES _chardb_vectors(vector_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS _chardb_vectors_delivery_schedule
  ON _chardb_vectors (placement_vshard, vector_id);
CREATE INDEX IF NOT EXISTS _chardb_vectors_deleting_by_organization
  ON _chardb_vectors (organization_id, vector_id) WHERE state = 'deleting';
CREATE INDEX IF NOT EXISTS _chardb_vector_outbox_due
  ON _chardb_vector_outbox (next_attempt_at, vector_id);
CREATE INDEX IF NOT EXISTS _chardb_vector_outbox_effective_due
  ON _chardb_vector_outbox (
    (CASE WHEN leased_until IS NOT NULL AND leased_until > next_attempt_at THEN leased_until ELSE next_attempt_at END),
    vector_id
  );
CREATE TABLE IF NOT EXISTS _chardb_vector_attempts (
  vector_id         TEXT NOT NULL,
  physical_version  INTEGER NOT NULL CHECK (physical_version > 0),
  first_sent_at     INTEGER NOT NULL CHECK (first_sent_at >= 0),
  settle_after      INTEGER NOT NULL CHECK (settle_after >= first_sent_at),
  visibility_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (visibility_confirmed IN (0, 1)),
  response_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (response_ambiguous IN (0, 1)),
  delete_confirmed  INTEGER NOT NULL DEFAULT 0 CHECK (delete_confirmed IN (0, 1)),
  delete_claim_token TEXT,
  PRIMARY KEY (vector_id, physical_version),
  FOREIGN KEY (vector_id) REFERENCES _chardb_vectors(vector_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS _chardb_vector_capacity (
  singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
  reconciled    INTEGER NOT NULL CHECK (reconciled IN (0, 1)),
  head_count    INTEGER NOT NULL CHECK (head_count >= 0),
  stored_bytes  INTEGER NOT NULL CHECK (stored_bytes >= 0),
  outbox_rows   INTEGER NOT NULL CHECK (outbox_rows >= 0),
  attempt_rows  INTEGER NOT NULL CHECK (attempt_rows >= 0)
);
CREATE TABLE IF NOT EXISTS _chardb_vector_scheduler (
  singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_vshard  INTEGER NOT NULL CHECK (next_vshard BETWEEN 0 AND 16383)
);
CREATE TABLE IF NOT EXISTS _chardb_vector_head_sequence (
  singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_seq     INTEGER NOT NULL CHECK (last_seq >= 0 AND last_seq <= 9007199254740991)
);
` as const;

export interface CdbVectorHead {
    readonly vectorId: string;
    readonly organizationId: string;
    readonly placementVshard: number;
    readonly resourceId: string;
    readonly rowPk: string;
    readonly dimensions: number;
    readonly version: number;
    readonly deliveredVersion: number;
    readonly values: readonly number[] | null;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly state: "pending" | "ready" | "deleting";
    readonly updatedAt: number;
}

export interface CdbVectorUpsertClaim {
    readonly operation: "upsert";
    readonly phase: "submit" | "verify";
    readonly mutationId: string | null;
    readonly acceptedAt: number | null;
    readonly vectorId: string;
    readonly organizationId: string;
    readonly placementVshard: number;
    readonly resourceId: string;
    readonly rowPk: string;
    readonly dimensions: number;
    readonly targetVersion: number;
    readonly physicalId: string;
    readonly values: readonly number[];
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly claimToken: string;
    readonly leasedUntil: number;
    readonly attempt: number;
}

export interface CdbVectorDeleteClaim {
    readonly operation: "delete";
    readonly phase: "submit" | "verify";
    readonly mutationId: string | null;
    readonly acceptedAt: number | null;
    readonly deleteProofRecorded: boolean;
    readonly mode: "cleanup" | "delete";
    readonly vectorId: string;
    readonly organizationId: string;
    readonly placementVshard: number;
    readonly resourceId: string;
    readonly rowPk: string;
    readonly dimensions: number;
    readonly targetVersion: number;
    readonly physicalIds: readonly string[];
    readonly claimToken: string;
    readonly leasedUntil: number;
    readonly attempt: number;
}

export type CdbVectorClaim = CdbVectorUpsertClaim | CdbVectorDeleteClaim;

export interface CdbVectorDeliveryStatus {
    readonly state: "active" | "failed_unproven";
    readonly lastError: string | null;
}

export interface CdbVectorRecoveryPage {
    readonly processed: number;
    readonly afterCreatedSeq: number;
    readonly done: boolean;
}

interface StoredHead {
    readonly vector_id: string;
    readonly created_seq: number | bigint;
    readonly organization_id: string;
    readonly placement_vshard: number | bigint;
    readonly resource_id: string;
    readonly row_pk: string;
    readonly dimensions: number | bigint;
    readonly version: number | bigint;
    readonly delivered_version: number | bigint;
    readonly values_enc: Uint8Array | ArrayBuffer | null;
    readonly metadata_json: string;
    readonly state: CdbVectorHead["state"];
    readonly updated_at: number | bigint;
}

interface StoredOutbox {
    readonly vector_id: string;
    readonly target_version: number | bigint;
    readonly operation: "upsert" | "delete";
    readonly phase: "submit" | "verify";
    readonly mutation_id: string | null;
    readonly accepted_at: number | bigint | null;
    readonly verify_ids_json: string | null;
    readonly attempts: number | bigint;
    readonly next_attempt_at: number | bigint;
    readonly leased_until: number | bigint | null;
    readonly lease_token: string | null;
    readonly terminal_failure: number | bigint;
    readonly last_error: string | null;
}

interface StoredAttempt {
    readonly physical_version: number | bigint;
    readonly first_sent_at: number | bigint;
    readonly settle_after: number | bigint;
    readonly visibility_confirmed: number | bigint;
    readonly response_ambiguous: number | bigint;
    readonly delete_confirmed: number | bigint;
    readonly delete_claim_token: string | null;
}

interface StoredCapacity {
    readonly head_count: number | bigint;
    readonly stored_bytes: number | bigint;
    readonly outbox_rows: number | bigint;
    readonly attempt_rows: number | bigint;
}

interface StoredScheduler {
    readonly next_vshard: number | bigint;
}

interface StoredHeadSequence {
    readonly last_seq: number | bigint;
}

const TEXT = new TextEncoder();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const MAX_MUTATION_ID_BYTES = 128;

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `vector outbox: ${message}` });
}

function invariant(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message: `vector outbox: ${message}` });
}

function stale(message: string): never {
    throw new CdbError({ code: "CDB_STALE_EPOCH", message: `vector outbox: ${message}` });
}

function limited(message: string): never {
    throw new CdbError({ code: "CDB_RATE_LIMITED", message: `vector outbox: ${message}` });
}

function safeInteger(value: number | bigint, subject: string, minimum = 0): number {
    const projected = Number(value);
    if (!Number.isSafeInteger(projected) || projected < minimum) invariant(`${subject} is invalid`);
    return projected;
}

function inputInteger(value: number, subject: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || value < minimum) invalid(`${subject} is invalid`);
    return value;
}

function identity(value: string, subject: string): string {
    if (typeof value !== "string" || !ID.test(value)) invalid(`${subject} is invalid`);
    return value;
}

function rowPk(value: string): string {
    if (typeof value !== "string" || value.length === 0 || TEXT.encode(value).byteLength > 256) {
        invalid("row primary key is invalid");
    }
    return value;
}

function organization(value: string): string {
    if (typeof value !== "string" || value.length === 0 || TEXT.encode(value).byteLength > 256) {
        invalid("organization id is invalid");
    }
    return value;
}

function claimToken(value: string): string {
    if (typeof value !== "string" || !TOKEN.test(value)) invalid("claim token is invalid");
    return value;
}

function storedClaimToken(value: string): string {
    if (!TOKEN.test(value)) invariant("stored claim token is invalid");
    return value;
}

function mutationId(value: string): string {
    if (typeof value !== "string" || value.length === 0 || TEXT.encode(value).byteLength > MAX_MUTATION_ID_BYTES) {
        invalid("Vectorize mutation id is invalid");
    }
    return value;
}

function storedMutationId(value: string): string {
    try {
        return mutationId(value);
    } catch {
        invariant("stored Vectorize mutation id is invalid");
    }
}

function exactPlacement(organizationId: string, stored: number | bigint): number {
    const placement = safeInteger(stored, "stored placement");
    const expected = Number(vshardOf([organizationId]));
    if (placement >= VSHARD_COUNT || placement !== expected) invariant("stored organization placement is invalid");
    return placement;
}

function validateJson(value: unknown, depth: number, budget: { nodes: number }): unknown {
    budget.nodes++;
    if (budget.nodes > 2_048 || depth > 16) invalid("metadata structure exceeds its bound");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) invalid("metadata numbers must be finite");
        return value;
    }
    if (Array.isArray(value)) return value.map(item => validateJson(item, depth + 1, budget));
    if (typeof value !== "object") invalid("metadata must contain only JSON values");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("metadata objects must be plain data objects");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || TEXT.encode(key).byteLength > 256) {
            invalid("metadata keys and fields are invalid");
        }
        output[key] = validateJson(descriptor.value, depth + 1, budget);
    }
    return output;
}

function encodeMetadata(input: Readonly<Record<string, unknown>>): string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("metadata must be an object");
    const encoded = stableJson(validateJson(input, 0, { nodes: 0 }));
    if (TEXT.encode(encoded).byteLength > CDB_VECTOR_MAX_METADATA_BYTES) {
        invalid(`metadata exceeds ${CDB_VECTOR_MAX_METADATA_BYTES} UTF-8 bytes`);
    }
    return encoded;
}

function decodeMetadata(encoded: string): Readonly<Record<string, unknown>> {
    if (typeof encoded !== "string" || TEXT.encode(encoded).byteLength > CDB_VECTOR_MAX_METADATA_BYTES) {
        invariant("stored metadata exceeds its byte bound");
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch {
        invariant("stored metadata is not JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
        invariant("stored metadata is not an object");
    try {
        return validateJson(value, 0, { nodes: 0 }) as Readonly<Record<string, unknown>>;
    } catch {
        invariant("stored metadata is invalid");
    }
}

function encodeValues(values: readonly number[], dimensions: number): Uint8Array {
    inputInteger(dimensions, "dimensions", 1);
    if (dimensions > CDB_VECTOR_MAX_DIMENSIONS) invalid(`dimensions exceed ${CDB_VECTOR_MAX_DIMENSIONS}`);
    if (!Array.isArray(values) || values.length !== dimensions) invalid("embedding length does not match dimensions");
    const encoded = new Uint8Array(dimensions * 4);
    const view = new DataView(encoded.buffer);
    for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (typeof value !== "number" || !Number.isFinite(value)) invalid("embedding values must be finite numbers");
        view.setFloat32(index * 4, value, true);
        if (!Number.isFinite(view.getFloat32(index * 4, true))) invalid("embedding value exceeds float32 range");
    }
    if (encoded.byteLength > CDB_VECTOR_MAX_VALUES_BYTES) invalid("encoded embedding exceeds its byte bound");
    return encoded;
}

function bytes(value: Uint8Array | ArrayBuffer): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function decodeValues(value: Uint8Array | ArrayBuffer): readonly number[] {
    const encoded = bytes(value);
    if (encoded.byteLength < 4 || encoded.byteLength > CDB_VECTOR_MAX_VALUES_BYTES || encoded.byteLength % 4 !== 0) {
        invariant("stored embedding byte length is invalid");
    }
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const result: number[] = [];
    for (let offset = 0; offset < encoded.byteLength; offset += 4) {
        const item = view.getFloat32(offset, true);
        if (!Number.isFinite(item)) invariant("stored embedding contains a non-finite value");
        result.push(item);
    }
    return Object.freeze(result);
}

function physicalId(resourceId: string, vectorId: string, version: number): string {
    const result = `v1/${resourceId}/${vectorId}/${version}`;
    if (TEXT.encode(result).byteLength > 256) invariant("physical vector id exceeds 256 UTF-8 bytes");
    return result;
}

export function cdbVectorPhysicalId(resourceId: string, vectorId: string, version: number): string {
    return physicalId(
        identity(resourceId, "resource id"),
        identity(vectorId, "vector id"),
        inputInteger(version, "version", 1)
    );
}

/**
 * Validate the exact physical IDs retained while a delete is in its verify phase.
 * Callers choose how to classify a failure because stored-state drift and RPC
 * input use different Cdb error codes.
 */
export function validateCdbVectorDeletePhysicalIds(
    value: unknown,
    expected: {
        readonly resourceId: string;
        readonly vectorId: string;
        readonly targetVersion: number;
    }
): readonly number[] {
    if (!Array.isArray(value) || value.length > CDB_VECTOR_MAX_DELETE_IDS) {
        throw new TypeError("delete verification ids are invalid");
    }
    const prefix = `v1/${expected.resourceId}/${expected.vectorId}/`;
    const versions: number[] = [];
    for (const item of value) {
        if (typeof item !== "string" || !item.startsWith(prefix)) {
            throw new TypeError("delete verification id is invalid");
        }
        const version = Number(item.slice(prefix.length));
        if (
            !Number.isSafeInteger(version) ||
            version < 1 ||
            version >= expected.targetVersion ||
            versions.includes(version) ||
            item !== `${prefix}${version}`
        ) {
            throw new TypeError("delete verification id is invalid");
        }
        versions.push(version);
    }
    if (TEXT.encode(stableJson(value)).byteLength > CDB_VECTOR_MAX_DELETE_ID_BYTES) {
        throw new TypeError("delete verification ids exceed their byte bound");
    }
    return Object.freeze(versions);
}

function projectHead(row: StoredHead): CdbVectorHead {
    const vectorId = identity(row.vector_id, "stored vector id");
    const organizationId = organization(row.organization_id);
    const resourceId = identity(row.resource_id, "stored resource id");
    const version = safeInteger(row.version, "stored version", 1);
    const deliveredVersion = safeInteger(row.delivered_version, "stored delivered version");
    const dimensions = safeInteger(row.dimensions, "stored dimensions", 1);
    if (dimensions > CDB_VECTOR_MAX_DIMENSIONS) invariant("stored dimensions exceed their bound");
    if (deliveredVersion > version) invariant("delivered version exceeds the head version");
    if (row.state !== "pending" && row.state !== "ready" && row.state !== "deleting") {
        invariant("stored vector lifecycle state is invalid");
    }
    if (
        (row.state === "ready" && deliveredVersion !== version) ||
        (row.state !== "ready" && deliveredVersion >= version)
    ) {
        invariant("stored delivered version does not match the vector lifecycle state");
    }
    const values = row.values_enc === null ? null : decodeValues(row.values_enc);
    if (values !== null && values.length !== dimensions) invariant("stored embedding length does not match dimensions");
    if ((row.state === "deleting") !== (values === null)) invariant("stored vector lifecycle state is invalid");
    return Object.freeze({
        vectorId,
        organizationId,
        placementVshard: exactPlacement(organizationId, row.placement_vshard),
        resourceId,
        rowPk: rowPk(row.row_pk),
        dimensions,
        version,
        deliveredVersion,
        values,
        metadata: decodeMetadata(row.metadata_json),
        state: row.state,
        updatedAt: safeInteger(row.updated_at, "stored update time"),
    });
}

export function initializeCdbVectorOutboxStore(sql: SyncSql): void {
    sql.exec("PRAGMA foreign_keys = ON");
    for (const statement of CDB_VECTOR_OUTBOX_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
    const headColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_vectors)").map(column => column.name)
    );
    if (!headColumns.has("created_seq")) {
        sql.exec("ALTER TABLE _chardb_vectors ADD COLUMN created_seq INTEGER");
    }
    // Legacy stores had no durable insertion generation. Bootstrap runs behind
    // the Durable Object input gate, so this one statement either backfills all
    // legacy heads or none of them. Subsequent inserts never derive from rowid.
    sql.exec("UPDATE _chardb_vectors SET created_seq = rowid WHERE created_seq IS NULL");
    const invalidHeadSequence = sql.one<{ present: number }>(
        `SELECT 1 AS present FROM _chardb_vectors
         WHERE typeof(created_seq) <> 'integer' OR created_seq <= 0 OR created_seq > ?
         LIMIT 1`,
        Number.MAX_SAFE_INTEGER
    );
    if (invalidHeadSequence) invariant("stored vector head insertion generation is invalid");
    const duplicateHeadSequence = sql.one<{ present: number }>(
        `SELECT 1 AS present FROM _chardb_vectors
         GROUP BY created_seq HAVING COUNT(*) > 1 LIMIT 1`
    );
    if (duplicateHeadSequence) invariant("stored vector head insertion generation is duplicated");
    sql.exec("INSERT OR IGNORE INTO _chardb_vector_head_sequence (singleton, last_seq) VALUES (1, 0)");
    sql.exec(
        `UPDATE _chardb_vector_head_sequence
         SET last_seq = MAX(last_seq, (SELECT COALESCE(MAX(created_seq), 0) FROM _chardb_vectors))
         WHERE singleton = 1`
    );
    const sequence = sql.one<StoredHeadSequence>(
        "SELECT last_seq FROM _chardb_vector_head_sequence WHERE singleton = 1"
    );
    if (!sequence) invariant("vector head insertion sequence is unavailable");
    safeInteger(sequence.last_seq, "vector head insertion sequence");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS _chardb_vectors_created_seq ON _chardb_vectors (created_seq)");
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vectors_created_seq_required
         BEFORE INSERT ON _chardb_vectors
         WHEN NEW.created_seq IS NULL OR NEW.created_seq <= 0
         BEGIN
           SELECT RAISE(ABORT, 'vector head insertion sequence is required');
         END`
    );
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vectors_created_seq_immutable
         BEFORE UPDATE OF created_seq ON _chardb_vectors
         WHEN NEW.created_seq IS NOT OLD.created_seq
         BEGIN
           SELECT RAISE(ABORT, 'vector head insertion sequence is immutable');
         END`
    );
    const outboxColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_vector_outbox)").map(column => column.name)
    );
    for (const [name, definition] of [
        ["phase", "phase TEXT NOT NULL DEFAULT 'submit' CHECK (phase IN ('submit', 'verify'))"],
        ["mutation_id", "mutation_id TEXT"],
        ["accepted_at", "accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= 0)"],
        ["verify_ids_json", "verify_ids_json TEXT"],
        ["terminal_failure", "terminal_failure INTEGER NOT NULL DEFAULT 0 CHECK (terminal_failure IN (0, 1))"],
    ] as const) {
        if (!outboxColumns.has(name)) sql.exec(`ALTER TABLE _chardb_vector_outbox ADD COLUMN ${definition}`);
    }
    const attemptColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_vector_attempts)").map(column => column.name)
    );
    for (const [name, definition] of [
        ["visibility_confirmed", "visibility_confirmed INTEGER NOT NULL DEFAULT 0"],
        ["response_ambiguous", "response_ambiguous INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
        if (!attemptColumns.has(name)) sql.exec(`ALTER TABLE _chardb_vector_attempts ADD COLUMN ${definition}`);
    }
    sql.exec(
        `INSERT OR IGNORE INTO _chardb_vector_capacity
           (singleton, reconciled, head_count, stored_bytes, outbox_rows, attempt_rows)
         VALUES (1, 0, 0, 0, 0, 0)`
    );
    sql.exec("INSERT OR IGNORE INTO _chardb_vector_scheduler (singleton, next_vshard) VALUES (1, 0)");
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vector_capacity_head_insert
         AFTER INSERT ON _chardb_vectors BEGIN
           SELECT CASE WHEN NOT EXISTS (
             SELECT 1 FROM _chardb_vector_capacity WHERE singleton = 1 AND reconciled = 1
           ) THEN RAISE(ABORT, 'vector capacity accounting is unavailable') END;
           UPDATE _chardb_vector_capacity
           SET head_count = head_count + 1,
               stored_bytes = stored_bytes + COALESCE(length(NEW.values_enc), 0) + length(NEW.metadata_json)
           WHERE singleton = 1;
         END`
    );
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vector_capacity_head_update
         AFTER UPDATE OF values_enc, metadata_json ON _chardb_vectors BEGIN
           SELECT CASE WHEN NOT EXISTS (
             SELECT 1 FROM _chardb_vector_capacity WHERE singleton = 1 AND reconciled = 1
           ) THEN RAISE(ABORT, 'vector capacity accounting is unavailable') END;
           UPDATE _chardb_vector_capacity
           SET stored_bytes = stored_bytes
               - COALESCE(length(OLD.values_enc), 0) - length(OLD.metadata_json)
               + COALESCE(length(NEW.values_enc), 0) + length(NEW.metadata_json)
           WHERE singleton = 1;
         END`
    );
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vector_capacity_head_delete
         AFTER DELETE ON _chardb_vectors BEGIN
           SELECT CASE WHEN NOT EXISTS (
             SELECT 1 FROM _chardb_vector_capacity WHERE singleton = 1 AND reconciled = 1
           ) THEN RAISE(ABORT, 'vector capacity accounting is unavailable') END;
           UPDATE _chardb_vector_capacity
           SET head_count = head_count - 1,
               stored_bytes = stored_bytes - COALESCE(length(OLD.values_enc), 0) - length(OLD.metadata_json)
           WHERE singleton = 1;
         END`
    );
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vector_capacity_outbox_insert
         AFTER INSERT ON _chardb_vector_outbox BEGIN
           SELECT CASE WHEN NOT EXISTS (
             SELECT 1 FROM _chardb_vector_capacity WHERE singleton = 1 AND reconciled = 1
           ) THEN RAISE(ABORT, 'vector capacity accounting is unavailable') END;
           UPDATE _chardb_vector_capacity SET outbox_rows = outbox_rows + 1 WHERE singleton = 1;
         END`
    );
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vector_capacity_outbox_delete
         AFTER DELETE ON _chardb_vector_outbox BEGIN
           SELECT CASE WHEN NOT EXISTS (
             SELECT 1 FROM _chardb_vector_capacity WHERE singleton = 1 AND reconciled = 1
           ) THEN RAISE(ABORT, 'vector capacity accounting is unavailable') END;
           UPDATE _chardb_vector_capacity SET outbox_rows = outbox_rows - 1 WHERE singleton = 1;
         END`
    );
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vector_capacity_attempt_insert
         AFTER INSERT ON _chardb_vector_attempts BEGIN
           SELECT CASE WHEN NOT EXISTS (
             SELECT 1 FROM _chardb_vector_capacity WHERE singleton = 1 AND reconciled = 1
           ) THEN RAISE(ABORT, 'vector capacity accounting is unavailable') END;
           UPDATE _chardb_vector_capacity SET attempt_rows = attempt_rows + 1 WHERE singleton = 1;
         END`
    );
    sql.exec(
        `CREATE TRIGGER IF NOT EXISTS _chardb_vector_capacity_attempt_delete
         AFTER DELETE ON _chardb_vector_attempts BEGIN
           SELECT CASE WHEN NOT EXISTS (
             SELECT 1 FROM _chardb_vector_capacity WHERE singleton = 1 AND reconciled = 1
           ) THEN RAISE(ABORT, 'vector capacity accounting is unavailable') END;
           UPDATE _chardb_vector_capacity SET attempt_rows = attempt_rows - 1 WHERE singleton = 1;
         END`
    );
    const capacity = sql.one<{ reconciled: number | bigint }>(
        "SELECT reconciled FROM _chardb_vector_capacity WHERE singleton = 1"
    );
    if (!capacity) invariant("vector capacity accounting is unavailable");
    const reconciled = safeInteger(capacity.reconciled, "vector capacity reconciliation state");
    if (reconciled > 1) invariant("vector capacity reconciliation state is invalid");
    if (reconciled === 0) {
        // One atomic backfill covers legacy databases and interrupted first
        // initialization. A normal Durable Object restart reads only the
        // singleton and never rescans vector state.
        sql.exec(
            `UPDATE _chardb_vector_capacity
             SET reconciled = 1,
                 head_count = (SELECT COUNT(*) FROM _chardb_vectors),
                 stored_bytes = (SELECT COALESCE(SUM(COALESCE(length(values_enc), 0) + length(metadata_json)), 0)
                                 FROM _chardb_vectors),
                 outbox_rows = (SELECT COUNT(*) FROM _chardb_vector_outbox),
                 attempt_rows = (SELECT COUNT(*) FROM _chardb_vector_attempts)
             WHERE singleton = 1 AND reconciled = 0`
        );
        if (sql.changes() !== 1) invariant("vector capacity reconciliation was lost");
    }
}

export class CdbVectorOutboxStore {
    constructor(readonly sql: SyncSql) {}

    read(vectorId: string): CdbVectorHead | null {
        const row = this.readStoredHead(identity(vectorId, "vector id"));
        return row ? projectHead(row) : null;
    }

    readDeliveryStatus(vectorId: string): CdbVectorDeliveryStatus | null {
        const row = this.sql.one<{
            operation: "upsert" | "delete";
            leased_until: number | bigint | null;
            lease_token: string | null;
            terminal_failure: number | bigint;
            last_error: string | null;
        }>(
            `SELECT operation, leased_until, lease_token, terminal_failure, last_error
             FROM _chardb_vector_outbox WHERE vector_id = ?`,
            identity(vectorId, "vector id")
        );
        if (!row) return null;
        const terminal = safeInteger(row.terminal_failure, "outbox terminal failure state");
        if (terminal > 1) invariant("outbox terminal failure state is invalid");
        if (
            terminal === 1 &&
            (row.operation !== "delete" ||
                row.leased_until !== null ||
                row.lease_token !== null ||
                row.last_error !== CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR)
        ) {
            invariant("terminally failed outbox shape is invalid");
        }
        return Object.freeze({ state: terminal === 1 ? "failed_unproven" : "active", lastError: row.last_error });
    }

    nextDueAt(): number | null {
        const row = this.sql.one<{ due_at: number | bigint | null }>(
            `SELECT MIN(CASE
               WHEN outbox.leased_until IS NOT NULL AND outbox.leased_until > outbox.next_attempt_at
                 THEN outbox.leased_until
               ELSE outbox.next_attempt_at
             END) AS due_at
             FROM _chardb_vector_outbox AS outbox
             INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
             WHERE ${CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL}
               AND ${CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL}
               AND outbox.terminal_failure = 0`
        );
        return row?.due_at === null || row?.due_at === undefined ? null : safeInteger(row.due_at, "next delivery time");
    }

    nextClaimPlacement(nowMs: number): number | null {
        return this.selectDuePlacement(inputInteger(nowMs, "claim time")).placement;
    }

    stageUpsert(input: {
        readonly vectorId: string;
        readonly organizationId: string;
        readonly resourceId: string;
        readonly rowPk: string;
        readonly dimensions: number;
        readonly values: readonly number[];
        readonly metadata: Readonly<Record<string, unknown>>;
        readonly nowMs: number;
    }): CdbVectorHead {
        const vectorId = identity(input.vectorId, "vector id");
        const organizationId = organization(input.organizationId);
        const resourceId = identity(input.resourceId, "resource id");
        const primaryKey = rowPk(input.rowPk);
        const encodedValues = encodeValues(input.values, input.dimensions);
        const metadataJson = encodeMetadata(input.metadata);
        const nowMs = inputInteger(input.nowMs, "timestamp");
        physicalId(resourceId, vectorId, 1);
        const stored = this.readStoredHead(vectorId);
        this.assertStageCapacity(stored, encodedValues.byteLength + TEXT.encode(metadataJson).byteLength);
        const byRow = this.sql.one<{ vector_id: string }>(
            `SELECT vector_id FROM _chardb_vectors
             WHERE resource_id = ? AND organization_id = ? AND row_pk = ?`,
            resourceId,
            organizationId,
            primaryKey
        );
        if (byRow && byRow.vector_id !== vectorId) invalid("resource row already belongs to another vector id");
        let version = 1;
        let deliveredVersion = 0;
        if (stored) {
            const current = projectHead(stored);
            if (
                current.organizationId !== organizationId ||
                current.resourceId !== resourceId ||
                current.rowPk !== primaryKey
            ) {
                invalid("vector id already belongs to another owner or resource row");
            }
            if (current.dimensions !== input.dimensions) invalid("vector dimensions cannot change between versions");
            version = current.version + 1;
            if (!Number.isSafeInteger(version)) invariant("vector version overflowed");
            physicalId(resourceId, vectorId, version);
            deliveredVersion = current.deliveredVersion;
            this.sql.exec(
                `UPDATE _chardb_vectors
                 SET version = ?, values_enc = ?, metadata_json = ?, state = 'pending', updated_at = ?
                 WHERE vector_id = ? AND version = ?`,
                version,
                encodedValues,
                metadataJson,
                nowMs,
                vectorId,
                current.version
            );
            if (this.sql.changes() !== 1) stale("vector head changed before upsert staging");
        } else {
            const createdSeq = this.allocateHeadCreatedSeq();
            this.sql.exec(
                `INSERT INTO _chardb_vectors
                   (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions, version,
                    delivered_version, values_enc, metadata_json, state, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'pending', ?)`,
                vectorId,
                createdSeq,
                organizationId,
                Number(vshardOf([organizationId])),
                resourceId,
                primaryKey,
                input.dimensions,
                encodedValues,
                metadataJson,
                nowMs
            );
        }
        this.coalesce(vectorId, version, "upsert", nowMs);
        const result = this.read(vectorId);
        if (!result || result.version !== version || result.deliveredVersion !== deliveredVersion) {
            invariant("staged vector head is missing");
        }
        return result;
    }

    stageDelete(input: {
        readonly vectorId: string;
        readonly organizationId: string;
        readonly nowMs: number;
    }): CdbVectorHead | null {
        const vectorId = identity(input.vectorId, "vector id");
        const organizationId = organization(input.organizationId);
        const nowMs = inputInteger(input.nowMs, "timestamp");
        const stored = this.readStoredHead(vectorId);
        if (!stored) return null;
        const current = projectHead(stored);
        if (current.organizationId !== organizationId) invalid("vector delete organization does not own the head");
        if (current.state === "deleting") return current;
        const version = current.version + 1;
        if (!Number.isSafeInteger(version)) invariant("vector version overflowed");
        this.sql.exec(
            `UPDATE _chardb_vectors
             SET version = ?, values_enc = NULL, state = 'deleting', updated_at = ?
             WHERE vector_id = ? AND version = ?`,
            version,
            nowMs,
            vectorId,
            current.version
        );
        if (this.sql.changes() !== 1) stale("vector head changed before delete staging");
        this.coalesce(vectorId, version, "delete", nowMs);
        return this.read(vectorId);
    }

    /** Requeue one stable insertion-order page after SQLite point-in-time recovery. */
    requeueRecoveryPage(input: {
        readonly afterCreatedSeq: number;
        readonly limit: number;
        readonly nowMs: number;
    }): CdbVectorRecoveryPage {
        const afterCreatedSeq = inputInteger(input.afterCreatedSeq, "recovery cursor");
        const limit = inputInteger(input.limit, "recovery page size", 1);
        const nowMs = inputInteger(input.nowMs, "recovery timestamp");
        if (limit > 500) invalid("recovery page size exceeds 500");
        const rows = this.sql.all<StoredHead>(
            `SELECT * FROM _chardb_vectors
             WHERE created_seq > ?
             ORDER BY created_seq LIMIT ?`,
            afterCreatedSeq,
            limit
        );
        let cursor = afterCreatedSeq;
        for (const row of rows) {
            const createdSeq = safeInteger(row.created_seq, "vector head insertion generation", 1);
            if (createdSeq <= cursor) invariant("recovery page is not strictly ordered");
            cursor = createdSeq;
            const head = projectHead(row);
            if (head.state === "ready") {
                this.sql.exec(
                    `UPDATE _chardb_vectors
                     SET state = 'pending', delivered_version = version - 1, updated_at = MAX(updated_at, ?)
                     WHERE vector_id = ? AND version = ? AND state = 'ready'`,
                    nowMs,
                    head.vectorId,
                    head.version
                );
                if (this.sql.changes() !== 1) stale("vector head changed during recovery requeue");
            }
            this.sql.exec(
                `UPDATE _chardb_vector_attempts
                 SET visibility_confirmed = 0, response_ambiguous = 0,
                     delete_confirmed = 0, delete_claim_token = NULL
                 WHERE vector_id = ? AND physical_version = ?`,
                head.vectorId,
                head.version
            );
            this.coalesce(head.vectorId, head.version, head.state === "deleting" ? "delete" : "upsert", nowMs);
        }
        return Object.freeze({ processed: rows.length, afterCreatedSeq: cursor, done: rows.length < limit });
    }

    claimNext(input: {
        readonly nowMs: number;
        readonly leaseMs: number;
        readonly settlementMs: number;
        readonly claimToken: string;
        readonly expectedPlacementVshard?: number;
    }): CdbVectorClaim | null {
        const nowMs = inputInteger(input.nowMs, "claim time");
        const leaseMs = inputInteger(input.leaseMs, "lease duration", 1);
        const settlementMs = inputInteger(input.settlementMs, "settlement duration", 1);
        const token = claimToken(input.claimToken);
        const leasedUntil = nowMs + leaseMs;
        const settleAfter = nowMs + settlementMs;
        if (!Number.isSafeInteger(leasedUntil) || !Number.isSafeInteger(settleAfter))
            invalid("claim deadline overflowed");
        const { nextVshard, placement: selectedPlacement } = this.selectDuePlacement(nowMs);
        if (selectedPlacement === null) return null;
        if (input.expectedPlacementVshard !== undefined) {
            const expectedPlacement = inputInteger(input.expectedPlacementVshard, "expected placement");
            if (expectedPlacement >= VSHARD_COUNT) invalid("expected placement exceeds the vshard count");
            if (selectedPlacement !== expectedPlacement) stale("scheduled vshard changed before capture");
        }
        const row = this.sql.one<StoredOutbox & StoredHead>(
            `SELECT outbox.*, delivery_head.* FROM _chardb_vector_outbox AS outbox
               INDEXED BY _chardb_vector_outbox_effective_due
             INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
             WHERE ${CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL}
               AND ${CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL}
               AND outbox.terminal_failure = 0
               AND delivery_head.placement_vshard = ?
               AND (CASE
                      WHEN outbox.leased_until IS NOT NULL
                       AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                      ELSE outbox.next_attempt_at
                    END) <= ?
             ORDER BY (CASE
                         WHEN outbox.leased_until IS NOT NULL
                          AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                         ELSE outbox.next_attempt_at
                       END), outbox.vector_id LIMIT 1`,
            selectedPlacement,
            nowMs
        );
        if (!row) stale("scheduled vshard changed before claim selection");
        const head = projectHead(row);
        const targetVersion = safeInteger(row.target_version, "outbox target version", 1);
        const attempts = safeInteger(row.attempts, "outbox attempts");
        if (row.phase !== "submit" && row.phase !== "verify") invariant("stored outbox phase is invalid");
        if (safeInteger(row.terminal_failure, "outbox terminal failure state") !== 0) {
            invariant("terminally failed outbox was selected for delivery");
        }
        const acceptedAt = row.accepted_at === null ? null : safeInteger(row.accepted_at, "outbox acceptance time");
        const receiptMutationId = row.mutation_id === null ? null : storedMutationId(row.mutation_id);
        if (
            (row.phase === "submit" && (acceptedAt !== null || receiptMutationId !== null)) ||
            (row.phase === "verify" && (acceptedAt === null || receiptMutationId === null)) ||
            (row.operation === "upsert" && row.verify_ids_json !== null)
        ) {
            invariant("stored outbox receipt state is invalid");
        }
        safeInteger(row.next_attempt_at, "outbox next attempt time");
        if ((row.leased_until === null) !== (row.lease_token === null)) {
            invariant("stored outbox lease identity is invalid");
        }
        if (row.leased_until !== null) {
            safeInteger(row.leased_until, "outbox lease deadline");
            storedClaimToken(row.lease_token as string);
        }
        if (attempts === Number.MAX_SAFE_INTEGER) invariant("outbox attempt counter overflowed");
        if (targetVersion !== head.version) invariant("outbox target does not match the vector head");
        if (
            (row.operation === "upsert" && head.state !== "pending") ||
            (row.operation === "delete" && head.state !== "ready" && head.state !== "deleting")
        ) {
            invariant("outbox operation does not match the vector lifecycle state");
        }
        if (row.operation === "upsert" && row.phase === "submit") {
            const existingAttempt = this.sql.one<{ present: number }>(
                `SELECT 1 AS present FROM _chardb_vector_attempts
                 WHERE vector_id = ? AND physical_version = ?`,
                head.vectorId,
                targetVersion
            );
            const retained = this.sql.one<{ count: number | bigint }>(
                "SELECT COUNT(*) AS count FROM _chardb_vector_attempts WHERE vector_id = ?",
                head.vectorId
            );
            const retainedCount = safeInteger(retained?.count ?? 0, "attempt ledger count");
            if (retainedCount > CDB_VECTOR_MAX_ATTEMPT_VERSIONS) {
                invariant("attempt ledger exceeds its retained-version bound");
            }
            if (!existingAttempt && retainedCount === CDB_VECTOR_MAX_ATTEMPT_VERSIONS) {
                limited(`attempt ledger reached ${CDB_VECTOR_MAX_ATTEMPT_VERSIONS} versions for one vector`);
            }
            if (!existingAttempt) {
                if (this.readCapacity().attemptRows >= CDB_VECTOR_MAX_ATTEMPT_ROWS) {
                    limited(`attempt ledger reached ${CDB_VECTOR_MAX_ATTEMPT_ROWS} rows on this Cdb`);
                }
            }
        }
        const deleteVersions: number[] = [];
        let deleteProofRecorded = false;
        if (row.operation === "delete" && row.verify_ids_json !== null) {
            let encoded: unknown;
            try {
                encoded = JSON.parse(row.verify_ids_json ?? "null");
            } catch {
                invariant("stored delete verification ids are invalid");
            }
            try {
                const verifiedVersions = validateCdbVectorDeletePhysicalIds(encoded, {
                    resourceId: head.resourceId,
                    vectorId: head.vectorId,
                    targetVersion,
                });
                const proofStates = verifiedVersions.map(version => {
                    const attempt = this.sql.one<{ delete_confirmed: number | bigint }>(
                        `SELECT delete_confirmed FROM _chardb_vector_attempts
                         WHERE vector_id = ? AND physical_version = ?`,
                        head.vectorId,
                        version
                    );
                    if (!attempt) invariant("stored delete verification attempt is unavailable");
                    const confirmed = safeInteger(attempt.delete_confirmed, "attempt delete proof state");
                    if (confirmed > 1) invariant("attempt delete proof state is invalid");
                    return confirmed === 1;
                });
                deleteProofRecorded = proofStates.length > 0 && proofStates.every(Boolean);
                if (!deleteProofRecorded && proofStates.some(Boolean)) {
                    invariant("stored delete proof is only partially recorded");
                }
                if (!deleteProofRecorded) deleteVersions.push(...verifiedVersions);
            } catch {
                invariant("stored delete verification ids are invalid");
            }
        } else if (row.operation === "delete") {
            const cleanup = head.state === "ready";
            const impossibleAttempt = this.sql.one<{ present: number }>(
                cleanup
                    ? `SELECT 1 AS present FROM _chardb_vector_attempts
                       WHERE vector_id = ? AND physical_version > ? LIMIT 1`
                    : `SELECT 1 AS present FROM _chardb_vector_attempts
                       WHERE vector_id = ? AND physical_version >= ? LIMIT 1`,
                head.vectorId,
                targetVersion
            );
            if (impossibleAttempt) invariant("attempted physical version exceeds the vector head");
            const unsettled = cleanup
                ? this.sql.one<{ settle_after: number | bigint | null }>(
                      `SELECT MAX(settle_after) AS settle_after FROM _chardb_vector_attempts
                       WHERE vector_id = ? AND physical_version < ?
                         AND delete_confirmed = 0 AND settle_after > ?`,
                      head.vectorId,
                      targetVersion,
                      nowMs
                  )
                : this.sql.one<{ settle_after: number | bigint | null }>(
                      `SELECT MAX(settle_after) AS settle_after FROM _chardb_vector_attempts
                       WHERE vector_id = ? AND delete_confirmed = 0 AND settle_after > ?`,
                      head.vectorId,
                      nowMs
                  );
            const nextSettlement = unsettled?.settle_after;
            const eligible = cleanup
                ? this.sql.all<StoredAttempt>(
                      `SELECT physical_version, first_sent_at, settle_after, visibility_confirmed,
                              response_ambiguous, delete_confirmed, delete_claim_token
                       FROM _chardb_vector_attempts
                       WHERE vector_id = ? AND physical_version < ?
                         AND delete_confirmed = 0 AND settle_after <= ?
                       ORDER BY physical_version LIMIT ?`,
                      head.vectorId,
                      targetVersion,
                      nowMs,
                      CDB_VECTOR_MAX_DELETE_IDS
                  )
                : this.sql.all<StoredAttempt>(
                      `SELECT physical_version, first_sent_at, settle_after, visibility_confirmed,
                              response_ambiguous, delete_confirmed, delete_claim_token
                       FROM _chardb_vector_attempts
                       WHERE vector_id = ? AND delete_confirmed = 0 AND settle_after <= ?
                       ORDER BY physical_version LIMIT ?`,
                      head.vectorId,
                      nowMs,
                      CDB_VECTOR_MAX_DELETE_IDS
                  );
            const eligibleVersions = eligible.map(attempt =>
                safeInteger(attempt.physical_version, "attempted version", 1)
            );
            for (const version of eligibleVersions) {
                const candidate = [...deleteVersions, version];
                const candidateIds = candidate.map(item => physicalId(head.resourceId, head.vectorId, item));
                if (TEXT.encode(stableJson(candidateIds)).byteLength > CDB_VECTOR_MAX_DELETE_ID_BYTES) break;
                deleteVersions.push(version);
            }
            if (nextSettlement !== null && nextSettlement !== undefined) {
                const nextAttemptAt = safeInteger(nextSettlement, "attempt settlement time");
                this.sql.exec(
                    `UPDATE _chardb_vector_outbox SET next_attempt_at = ?, leased_until = NULL, lease_token = NULL
                     WHERE vector_id = ? AND target_version = ?`,
                    nextAttemptAt,
                    head.vectorId,
                    targetVersion
                );
                if (this.sql.changes() !== 1) stale("delete settlement schedule changed before claim");
                return null;
            }
            if (eligibleVersions.length > 0 && deleteVersions.length === 0) {
                invariant("one physical vector id exceeds the delete claim byte bound");
            }
        }
        this.sql.exec(
            `UPDATE _chardb_vector_outbox
             SET attempts = attempts + 1, leased_until = ?, lease_token = ?, last_error = NULL,
                 verify_ids_json = CASE WHEN operation = 'delete' THEN COALESCE(verify_ids_json, ?) ELSE NULL END
             WHERE vector_id = ? AND target_version = ? AND operation = ? AND phase = ?
               AND (leased_until IS NULL OR leased_until <= ?)`,
            leasedUntil,
            token,
            row.operation === "delete"
                ? stableJson(deleteVersions.map(version => physicalId(head.resourceId, head.vectorId, version)))
                : null,
            head.vectorId,
            targetVersion,
            row.operation,
            row.phase,
            nowMs
        );
        if (this.sql.changes() !== 1) stale("vector outbox claim was lost");
        this.sql.exec(
            `UPDATE _chardb_vector_scheduler SET next_vshard = ?
             WHERE singleton = 1 AND next_vshard = ?`,
            (head.placementVshard + 1) % VSHARD_COUNT,
            nextVshard
        );
        if (this.sql.changes() !== 1) stale("vector scheduler cursor changed before claim");
        if (row.operation === "upsert" && row.phase === "submit") {
            this.sql.exec(
                `INSERT INTO _chardb_vector_attempts
                   (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed,
                    response_ambiguous, delete_confirmed, delete_claim_token)
                 VALUES (?, ?, ?, ?, 0, 0, 0, NULL)
                 ON CONFLICT(vector_id, physical_version) DO UPDATE SET
                   settle_after = MAX(settle_after, excluded.settle_after), delete_confirmed = 0,
                   delete_claim_token = NULL`,
                head.vectorId,
                targetVersion,
                nowMs,
                settleAfter
            );
            if (!head.values) invariant("pending vector has no encoded values");
            return Object.freeze({
                operation: "upsert",
                phase: row.phase,
                mutationId: receiptMutationId,
                acceptedAt,
                vectorId: head.vectorId,
                organizationId: head.organizationId,
                placementVshard: head.placementVshard,
                resourceId: head.resourceId,
                rowPk: head.rowPk,
                dimensions: head.dimensions,
                targetVersion,
                physicalId: physicalId(head.resourceId, head.vectorId, targetVersion),
                values: head.values,
                metadata: head.metadata,
                claimToken: token,
                leasedUntil,
                attempt: attempts + 1,
            });
        }
        if (row.operation === "upsert") {
            if (!head.values) invariant("pending vector has no encoded values");
            return Object.freeze({
                operation: "upsert",
                phase: row.phase,
                mutationId: receiptMutationId,
                acceptedAt,
                vectorId: head.vectorId,
                organizationId: head.organizationId,
                placementVshard: head.placementVshard,
                resourceId: head.resourceId,
                rowPk: head.rowPk,
                dimensions: head.dimensions,
                targetVersion,
                physicalId: physicalId(head.resourceId, head.vectorId, targetVersion),
                values: head.values,
                metadata: head.metadata,
                claimToken: token,
                leasedUntil,
                attempt: attempts + 1,
            });
        }
        for (const version of deleteVersions) {
            this.sql.exec(
                `UPDATE _chardb_vector_attempts SET delete_claim_token = ?
                 WHERE vector_id = ? AND physical_version = ? AND delete_confirmed = 0`,
                token,
                head.vectorId,
                version
            );
            if (this.sql.changes() !== 1) stale("delete attempt changed before claim");
        }
        return Object.freeze({
            operation: "delete",
            phase: row.phase,
            mutationId: receiptMutationId,
            acceptedAt,
            deleteProofRecorded,
            mode: head.state === "ready" ? "cleanup" : "delete",
            vectorId: head.vectorId,
            organizationId: head.organizationId,
            placementVshard: head.placementVshard,
            resourceId: head.resourceId,
            rowPk: head.rowPk,
            dimensions: head.dimensions,
            targetVersion,
            physicalIds: deleteVersions.map(version => physicalId(head.resourceId, head.vectorId, version)),
            claimToken: token,
            leasedUntil,
            attempt: attempts + 1,
        });
    }

    private selectDuePlacement(nowMs: number): { readonly nextVshard: number; readonly placement: number | null } {
        const scheduler = this.sql.one<StoredScheduler>(
            "SELECT next_vshard FROM _chardb_vector_scheduler WHERE singleton = 1"
        );
        if (!scheduler) invariant("vector scheduler state is unavailable");
        const nextVshard = safeInteger(scheduler.next_vshard, "scheduler cursor");
        if (nextVshard >= VSHARD_COUNT) invariant("scheduler cursor exceeds the vshard count");
        const duePlacementAtOrAfter = this.sql.one<{ placement_vshard: number | bigint | null }>(
            `SELECT MIN(delivery_head.placement_vshard) AS placement_vshard
             FROM _chardb_vector_outbox AS outbox
             INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
             WHERE ${CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL}
               AND ${CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL}
               AND outbox.terminal_failure = 0
               AND delivery_head.placement_vshard >= ?
               AND (CASE
                      WHEN outbox.leased_until IS NOT NULL
                       AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                      ELSE outbox.next_attempt_at
                    END) <= ?`,
            nextVshard,
            nowMs
        );
        const duePlacement =
            duePlacementAtOrAfter?.placement_vshard ??
            this.sql.one<{ placement_vshard: number | bigint | null }>(
                `SELECT MIN(delivery_head.placement_vshard) AS placement_vshard
                 FROM _chardb_vector_outbox AS outbox
                 INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
                 WHERE ${CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL}
                   AND ${CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL}
                   AND outbox.terminal_failure = 0
                   AND (CASE
                          WHEN outbox.leased_until IS NOT NULL
                           AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                          ELSE outbox.next_attempt_at
                        END) <= ?`,
                nowMs
            )?.placement_vshard;
        if (duePlacement === null || duePlacement === undefined) {
            return Object.freeze({ nextVshard, placement: null });
        }
        const placement = safeInteger(duePlacement, "scheduled placement");
        if (placement >= VSHARD_COUNT) invariant("scheduled placement exceeds the vshard count");
        return Object.freeze({ nextVshard, placement });
    }

    acceptSubmission(claim: CdbVectorClaim, receiptId: string, acceptedAt: number, nextVerifyAt: number): void {
        if (claim.phase !== "submit") invalid("only a submitted vector claim can record acceptance");
        const receipt = mutationId(receiptId);
        const accepted = inputInteger(acceptedAt, "acceptance time");
        const next = inputInteger(nextVerifyAt, "verification time");
        this.assertCurrentClaim(
            claim.vectorId,
            claim.targetVersion,
            claim.operation,
            claim.phase,
            claim.claimToken,
            accepted
        );
        this.assertClaimHead(claim);
        const verifyIds = claim.operation === "delete" ? stableJson(claim.physicalIds) : null;
        this.sql.exec(
            "UPDATE _chardb_vector_attempts SET delete_claim_token = NULL WHERE vector_id = ? AND delete_claim_token = ?",
            claim.vectorId,
            claim.claimToken
        );
        this.sql.exec(
            `UPDATE _chardb_vector_outbox
             SET phase = 'verify', mutation_id = ?, accepted_at = ?, verify_ids_json = ?,
                 next_attempt_at = ?, leased_until = NULL, lease_token = NULL, last_error = NULL
             WHERE vector_id = ? AND target_version = ? AND operation = ? AND phase = 'submit'
               AND lease_token = ?`,
            receipt,
            accepted,
            verifyIds,
            next,
            claim.vectorId,
            claim.targetVersion,
            claim.operation,
            claim.claimToken
        );
        if (this.sql.changes() !== 1) stale("vector submission changed before acceptance was recorded");
    }

    recordDeleteProof(claim: CdbVectorDeleteClaim, nowMs: number): void {
        const provenAt = inputInteger(nowMs, "delete proof time");
        if (claim.phase !== "verify" || claim.mutationId === null || claim.physicalIds.length === 0) {
            invalid("only a nonempty accepted delete claim can record external proof");
        }
        this.assertCurrentClaim(claim.vectorId, claim.targetVersion, "delete", claim.phase, claim.claimToken, provenAt);
        const head = this.assertClaimHead(claim);
        if (claim.physicalIds.length > CDB_VECTOR_MAX_DELETE_IDS) invalid("delete proof has too many ids");
        if (TEXT.encode(stableJson(claim.physicalIds)).byteLength > CDB_VECTOR_MAX_DELETE_ID_BYTES) {
            invalid("delete proof exceeds its physical-id byte bound");
        }
        const versions = new Set<number>();
        for (const physical of claim.physicalIds) {
            const prefix = `v1/${head.resourceId}/${head.vectorId}/`;
            if (!physical.startsWith(prefix)) invalid("delete proof physical id is invalid");
            const version = Number(physical.slice(prefix.length));
            if (
                !Number.isSafeInteger(version) ||
                version < 1 ||
                version >= claim.targetVersion ||
                versions.has(version) ||
                physical !== physicalId(head.resourceId, head.vectorId, version)
            ) {
                invalid("delete proof physical id is invalid");
            }
            versions.add(version);
            this.sql.exec(
                `UPDATE _chardb_vector_attempts SET delete_confirmed = 1, delete_claim_token = NULL
                 WHERE vector_id = ? AND physical_version = ? AND delete_confirmed = 0
                   AND delete_claim_token = ?`,
                claim.vectorId,
                version,
                claim.claimToken
            );
            if (this.sql.changes() !== 1) stale("delete attempt changed before external proof was recorded");
        }
    }

    deleteClaimHasUncertainAttempts(claim: CdbVectorDeleteClaim, nowMs: number): boolean {
        inputInteger(nowMs, "uncertain delete check time");
        this.assertCurrentClaim(claim.vectorId, claim.targetVersion, "delete", claim.phase, claim.claimToken, nowMs);
        this.assertClaimHead(claim);
        return (
            this.sql.one<{ present: number }>(
                `SELECT 1 AS present FROM _chardb_vector_attempts
                 WHERE vector_id = ? AND delete_claim_token = ? AND delete_confirmed = 0
                   AND (visibility_confirmed = 0 OR response_ambiguous = 1)
                 LIMIT 1`,
                claim.vectorId,
                claim.claimToken
            ) !== null
        );
    }

    deleteClaimUnsettledUntil(claim: CdbVectorDeleteClaim, nowMs: number): number | null {
        const observedAt = inputInteger(nowMs, "delete settlement check time");
        this.assertCurrentClaim(
            claim.vectorId,
            claim.targetVersion,
            "delete",
            claim.phase,
            claim.claimToken,
            observedAt
        );
        this.assertClaimHead(claim);
        const attemptSettlement = this.sql.one<{ settle_after: number | bigint | null }>(
            `SELECT MAX(settle_after) AS settle_after FROM _chardb_vector_attempts
             WHERE vector_id = ? AND physical_version < ? AND delete_confirmed = 0 AND settle_after > ?`,
            claim.vectorId,
            claim.targetVersion,
            observedAt
        )?.settle_after;
        const attemptDeadline =
            attemptSettlement === null || attemptSettlement === undefined
                ? null
                : safeInteger(attemptSettlement, "delete attempt settlement deadline", observedAt + 1);
        const acceptedDeadline =
            claim.phase === "verify" && claim.acceptedAt !== null
                ? claim.acceptedAt + CDB_VECTOR_ACCEPTED_DELETE_SETTLEMENT_MS
                : null;
        if (acceptedDeadline !== null && !Number.isSafeInteger(acceptedDeadline)) {
            invariant("accepted delete settlement deadline overflowed");
        }
        const unsettledUntil = Math.max(attemptDeadline ?? 0, acceptedDeadline ?? 0);
        return unsettledUntil > observedAt ? unsettledUntil : null;
    }

    acknowledgeUpsert(claim: CdbVectorUpsertClaim, nowMs: number): CdbVectorHead {
        inputInteger(nowMs, "acknowledgement time");
        this.assertCurrentClaim(claim.vectorId, claim.targetVersion, "upsert", claim.phase, claim.claimToken, nowMs);
        this.assertClaimHead(claim);
        if (claim.physicalId !== physicalId(claim.resourceId, claim.vectorId, claim.targetVersion)) {
            invalid("upsert acknowledgement physical id is invalid");
        }
        this.sql.exec(
            `UPDATE _chardb_vectors SET delivered_version = ?, state = 'ready', updated_at = MAX(updated_at, ?)
             WHERE vector_id = ? AND version = ? AND state = 'pending'`,
            claim.targetVersion,
            nowMs,
            claim.vectorId,
            claim.targetVersion
        );
        if (this.sql.changes() !== 1) stale("upsert head changed before acknowledgement");
        this.sql.exec(
            `UPDATE _chardb_vector_attempts SET visibility_confirmed = 1
             WHERE vector_id = ? AND physical_version = ?`,
            claim.vectorId,
            claim.targetVersion
        );
        if (this.sql.changes() !== 1) stale("upsert attempt disappeared before visibility acknowledgement");
        const superseded = this.sql.one<{ present: number }>(
            `SELECT 1 AS present FROM _chardb_vector_attempts
             WHERE vector_id = ? AND physical_version < ? AND delete_confirmed = 0 LIMIT 1`,
            claim.vectorId,
            claim.targetVersion
        );
        if (superseded) {
            this.sql.exec(
                `UPDATE _chardb_vector_outbox
                 SET operation = 'delete', attempts = 0, next_attempt_at = ?,
                     phase = 'submit', mutation_id = NULL, accepted_at = NULL, verify_ids_json = NULL,
                     leased_until = NULL, lease_token = NULL, last_error = NULL
                 WHERE vector_id = ? AND target_version = ? AND operation = 'upsert' AND phase = ?
                   AND lease_token = ?`,
                nowMs,
                claim.vectorId,
                claim.targetVersion,
                claim.phase,
                claim.claimToken
            );
            if (this.sql.changes() !== 1) stale("upsert claim changed before superseded cleanup scheduling");
        } else {
            this.deleteClaimedOutbox(claim.vectorId, claim.targetVersion, "upsert", claim.phase, claim.claimToken);
        }
        const head = this.read(claim.vectorId);
        if (!head) invariant("acknowledged vector head disappeared");
        return head;
    }

    acknowledgeDelete(
        claim: CdbVectorDeleteClaim,
        nowMs: number,
        externalDeleteProven = false
    ): { readonly deleted: boolean } {
        inputInteger(nowMs, "acknowledgement time");
        this.assertCurrentClaim(claim.vectorId, claim.targetVersion, "delete", claim.phase, claim.claimToken, nowMs);
        const head = this.assertClaimHead(claim);
        if (
            (claim.mode === "cleanup" && head.state !== "ready") ||
            (claim.mode === "delete" && head.state !== "deleting")
        ) {
            stale("delete claim mode does not match the current vector head");
        }
        if (claim.physicalIds.length > CDB_VECTOR_MAX_DELETE_IDS) invalid("delete acknowledgement has too many ids");
        if (TEXT.encode(stableJson(claim.physicalIds)).byteLength > CDB_VECTOR_MAX_DELETE_ID_BYTES) {
            invalid("delete acknowledgement exceeds its physical-id byte bound");
        }
        const versions: number[] = [];
        for (const physical of claim.physicalIds) {
            const prefix = `v1/${head.resourceId}/${head.vectorId}/`;
            if (!physical.startsWith(prefix)) invalid("delete acknowledgement physical id is invalid");
            const version = Number(physical.slice(prefix.length));
            if (!Number.isSafeInteger(version) || version < 1) invalid("delete acknowledgement version is invalid");
            if (claim.mode === "cleanup" && version >= claim.targetVersion) {
                invalid("superseded cleanup cannot delete the current physical version");
            }
            if (physical !== physicalId(head.resourceId, head.vectorId, version)) {
                invalid("delete acknowledgement physical id is invalid");
            }
            if (versions.includes(version)) invalid("delete acknowledgement contains duplicate physical ids");
            const attempted = this.sql.one<{
                visibility_confirmed: number | bigint;
                response_ambiguous: number | bigint;
            }>(
                `SELECT visibility_confirmed, response_ambiguous FROM _chardb_vector_attempts
                 WHERE vector_id = ? AND physical_version = ? AND delete_confirmed = 0 AND delete_claim_token = ?`,
                claim.vectorId,
                version,
                claim.claimToken
            );
            if (!attempted) stale("delete acknowledgement does not own an attempted version");
            if (version >= claim.targetVersion) {
                invalid("delete acknowledgement cannot delete the current or a future physical version");
            }
            versions.push(version);
        }
        for (const version of versions) {
            const attempt = this.sql.one<{
                visibility_confirmed: number | bigint;
                response_ambiguous: number | bigint;
            }>(
                `SELECT visibility_confirmed, response_ambiguous FROM _chardb_vector_attempts
                 WHERE vector_id = ? AND physical_version = ? AND delete_confirmed = 0 AND delete_claim_token = ?`,
                claim.vectorId,
                version,
                claim.claimToken
            );
            if (!attempt) stale("delete attempted version changed before acknowledgement");
            const uncertain =
                !externalDeleteProven &&
                (safeInteger(attempt.visibility_confirmed, "attempt visibility state") === 0 ||
                    safeInteger(attempt.response_ambiguous, "attempt response state") === 1);
            const retryAt = nowMs + CDB_VECTOR_UNCERTAIN_DELETE_RETRY_MS;
            if (!Number.isSafeInteger(retryAt)) invariant("uncertain delete retry deadline overflowed");
            this.sql.exec(
                `UPDATE _chardb_vector_attempts
                 SET delete_confirmed = ?, delete_claim_token = NULL,
                     settle_after = CASE WHEN ? = 1 THEN ? ELSE settle_after END
                 WHERE vector_id = ? AND physical_version = ? AND delete_confirmed = 0 AND delete_claim_token = ?`,
                uncertain ? 0 : 1,
                uncertain ? 1 : 0,
                retryAt,
                claim.vectorId,
                version,
                claim.claimToken
            );
            if (this.sql.changes() !== 1) stale("delete attempted version changed before acknowledgement");
        }
        if (claim.mode === "cleanup") {
            this.sql.exec(
                `DELETE FROM _chardb_vector_attempts
                 WHERE vector_id = ? AND physical_version < ? AND delete_confirmed = 1`,
                claim.vectorId,
                claim.targetVersion
            );
        }
        const remaining = this.sql.one<{ count: number | bigint }>(
            claim.mode === "cleanup"
                ? `SELECT COUNT(*) AS count FROM _chardb_vector_attempts
                   WHERE vector_id = ? AND physical_version < ? AND delete_confirmed = 0`
                : "SELECT COUNT(*) AS count FROM _chardb_vector_attempts WHERE vector_id = ? AND delete_confirmed = 0",
            claim.vectorId,
            ...(claim.mode === "cleanup" ? [claim.targetVersion] : [])
        );
        const count = safeInteger(remaining?.count ?? 0, "remaining delete attempts");
        if (count === 0) {
            this.deleteClaimedOutbox(claim.vectorId, claim.targetVersion, "delete", claim.phase, claim.claimToken);
            if (claim.mode === "cleanup") return Object.freeze({ deleted: false });
            this.sql.exec(
                "DELETE FROM _chardb_vectors WHERE vector_id = ? AND version = ? AND state = 'deleting'",
                claim.vectorId,
                claim.targetVersion
            );
            if (this.sql.changes() !== 1) stale("deleting vector head changed before final settlement");
            return Object.freeze({ deleted: true });
        }
        this.sql.exec(
            `UPDATE _chardb_vector_outbox
             SET phase = 'submit', mutation_id = NULL, accepted_at = NULL, verify_ids_json = NULL,
                 leased_until = NULL, lease_token = NULL, next_attempt_at = ?
             WHERE vector_id = ? AND target_version = ? AND operation = 'delete' AND phase = ?
               AND lease_token = ?`,
            nowMs,
            claim.vectorId,
            claim.targetVersion,
            claim.phase,
            claim.claimToken
        );
        if (this.sql.changes() !== 1) stale("delete claim changed before partial acknowledgement");
        return Object.freeze({ deleted: false });
    }

    failClaim(input: {
        readonly vectorId: string;
        readonly targetVersion: number;
        readonly operation: "upsert" | "delete";
        readonly phase: "submit" | "verify";
        readonly claimToken: string;
        readonly nextAttemptAt: number;
        readonly error: string;
    }): void {
        const vectorId = identity(input.vectorId, "vector id");
        const version = inputInteger(input.targetVersion, "target version", 1);
        const token = claimToken(input.claimToken);
        const nextAttemptAt = inputInteger(input.nextAttemptAt, "next attempt time");
        if (typeof input.error !== "string" || TEXT.encode(input.error).byteLength > CDB_VECTOR_MAX_ERROR_BYTES) {
            invalid(`claim error exceeds ${CDB_VECTOR_MAX_ERROR_BYTES} UTF-8 bytes`);
        }
        this.assertCurrentClaim(vectorId, version, input.operation, input.phase, token);
        if (input.operation === "upsert" && input.phase === "submit") {
            this.sql.exec(
                `UPDATE _chardb_vector_attempts SET response_ambiguous = 1
                 WHERE vector_id = ? AND physical_version = ?`,
                vectorId,
                version
            );
            if (this.sql.changes() !== 1) stale("ambiguous upsert attempt disappeared before retry");
        }
        this.sql.exec(
            `UPDATE _chardb_vector_attempts SET delete_claim_token = NULL
             WHERE vector_id = ? AND delete_claim_token = ?`,
            vectorId,
            token
        );
        this.sql.exec(
            `UPDATE _chardb_vector_outbox
             SET leased_until = NULL, lease_token = NULL, next_attempt_at = ?, last_error = ?
             WHERE vector_id = ? AND target_version = ? AND operation = ? AND phase = ? AND lease_token = ?`,
            nextAttemptAt,
            input.error || null,
            vectorId,
            version,
            input.operation,
            input.phase,
            token
        );
        if (this.sql.changes() !== 1) stale("vector claim changed before failure release");
    }

    terminallyFailUnprovenDelete(claim: CdbVectorDeleteClaim, nowMs: number): void {
        const failedAt = inputInteger(nowMs, "terminal failure time");
        if (claim.phase !== "submit" && claim.phase !== "verify") {
            invalid("only a claimed delete can terminate without proof");
        }
        this.assertCurrentClaim(claim.vectorId, claim.targetVersion, "delete", claim.phase, claim.claimToken, failedAt);
        this.assertClaimHead(claim);
        if (this.deleteClaimUnsettledUntil(claim, failedAt) !== null) {
            invalid("vector delete cannot terminate before every attempted version reaches its settlement deadline");
        }
        this.sql.exec(
            "UPDATE _chardb_vector_attempts SET delete_claim_token = NULL WHERE vector_id = ? AND delete_claim_token = ?",
            claim.vectorId,
            claim.claimToken
        );
        this.sql.exec(
            `UPDATE _chardb_vector_outbox
             SET leased_until = NULL, lease_token = NULL, terminal_failure = 1, last_error = ?
             WHERE vector_id = ? AND target_version = ? AND operation = 'delete' AND phase = ?
               AND lease_token = ?`,
            CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
            claim.vectorId,
            claim.targetVersion,
            claim.phase,
            claim.claimToken
        );
        if (this.sql.changes() !== 1) stale("vector delete changed before its terminal failure");
    }

    private coalesce(vectorId: string, targetVersion: number, operation: "upsert" | "delete", nowMs: number): void {
        this.sql.exec(
            `INSERT INTO _chardb_vector_outbox
               (vector_id, target_version, operation, phase, mutation_id, accepted_at, verify_ids_json,
                attempts, next_attempt_at, leased_until, lease_token, terminal_failure, last_error)
             VALUES (?, ?, ?, 'submit', NULL, NULL, NULL, 0, ?, NULL, NULL, 0, NULL)
             ON CONFLICT(vector_id) DO UPDATE SET
               target_version = excluded.target_version, operation = excluded.operation, attempts = 0,
               phase = 'submit', mutation_id = NULL, accepted_at = NULL, verify_ids_json = NULL,
               next_attempt_at = excluded.next_attempt_at, leased_until = NULL, lease_token = NULL,
               terminal_failure = 0, last_error = NULL`,
            vectorId,
            targetVersion,
            operation,
            nowMs
        );
        this.sql.exec("UPDATE _chardb_vector_attempts SET delete_claim_token = NULL WHERE vector_id = ?", vectorId);
        if (this.readCapacity().outboxRows > CDB_VECTOR_MAX_OUTBOX_ROWS) {
            limited(`outbox exceeds ${CDB_VECTOR_MAX_OUTBOX_ROWS} rows`);
        }
    }

    private allocateHeadCreatedSeq(): number {
        const stored = this.sql.one<StoredHeadSequence>(
            "SELECT last_seq FROM _chardb_vector_head_sequence WHERE singleton = 1"
        );
        if (!stored) invariant("vector head insertion sequence is unavailable");
        const current = safeInteger(stored.last_seq, "vector head insertion sequence");
        if (current === Number.MAX_SAFE_INTEGER) invariant("vector head insertion sequence overflowed");
        const next = current + 1;
        this.sql.exec(
            `UPDATE _chardb_vector_head_sequence SET last_seq = ?
             WHERE singleton = 1 AND last_seq = ?`,
            next,
            current
        );
        if (this.sql.changes() !== 1) stale("vector head insertion sequence changed before allocation");
        return next;
    }

    private assertStageCapacity(stored: StoredHead | null, replacementBytes: number): void {
        const capacity = this.readCapacity();
        if (!stored && capacity.heads >= CDB_VECTOR_MAX_HEADS) {
            limited(`head store reached ${CDB_VECTOR_MAX_HEADS} rows`);
        }
        const previousBytes = stored
            ? bytes(stored.values_enc ?? new Uint8Array(0)).byteLength + TEXT.encode(stored.metadata_json).byteLength
            : 0;
        if (previousBytes > capacity.storedBytes) invariant("vector capacity accounting is inconsistent");
        const projected = capacity.storedBytes - previousBytes + replacementBytes;
        if (!Number.isSafeInteger(projected) || projected > CDB_VECTOR_MAX_STORED_BYTES) {
            limited(`stored vector data exceeds ${CDB_VECTOR_MAX_STORED_BYTES} bytes`);
        }
    }

    private readCapacity(): {
        readonly heads: number;
        readonly storedBytes: number;
        readonly outboxRows: number;
        readonly attemptRows: number;
    } {
        const row = this.sql.one<StoredCapacity>(
            `SELECT head_count, stored_bytes, outbox_rows, attempt_rows
             FROM _chardb_vector_capacity WHERE singleton = 1`
        );
        if (!row) invariant("vector capacity accounting is unavailable");
        return {
            heads: safeInteger(row.head_count, "vector head count"),
            storedBytes: safeInteger(row.stored_bytes, "stored vector bytes"),
            outboxRows: safeInteger(row.outbox_rows, "outbox row count"),
            attemptRows: safeInteger(row.attempt_rows, "attempt ledger row count"),
        };
    }

    private readStoredHead(vectorId: string): StoredHead | null {
        return this.sql.one<StoredHead>(
            `SELECT vector_id, organization_id, placement_vshard, resource_id, row_pk, dimensions, version,
                    delivered_version, values_enc, metadata_json, state, updated_at
             FROM _chardb_vectors WHERE vector_id = ?`,
            vectorId
        );
    }

    private assertCurrentClaim(
        vectorId: string,
        targetVersion: number,
        operation: "upsert" | "delete",
        phase: "submit" | "verify",
        token: string,
        activeAt?: number
    ): void {
        const outbox = this.sql.one<StoredOutbox>(
            "SELECT * FROM _chardb_vector_outbox WHERE vector_id = ?",
            identity(vectorId, "vector id")
        );
        if (
            !outbox ||
            safeInteger(outbox.target_version, "outbox target version", 1) !== targetVersion ||
            outbox.operation !== operation ||
            outbox.phase !== phase ||
            safeInteger(outbox.terminal_failure, "outbox terminal failure state") !== 0 ||
            outbox.lease_token !== claimToken(token) ||
            outbox.leased_until === null ||
            (activeAt !== undefined && safeInteger(outbox.leased_until, "outbox lease deadline") <= activeAt)
        ) {
            stale("claim no longer owns the current outbox generation");
        }
    }

    private assertClaimHead(claim: CdbVectorClaim): CdbVectorHead {
        const stored = this.readStoredHead(claim.vectorId);
        if (!stored) stale("claimed vector head no longer exists");
        const head = projectHead(stored);
        if (
            head.version !== claim.targetVersion ||
            head.organizationId !== claim.organizationId ||
            head.placementVshard !== claim.placementVshard ||
            head.resourceId !== claim.resourceId ||
            head.rowPk !== claim.rowPk ||
            head.dimensions !== claim.dimensions
        ) {
            stale("claim identity does not match the current vector head");
        }
        if (
            claim.operation === "upsert" &&
            (stableJson(claim.values) !== stableJson(head.values) ||
                stableJson(claim.metadata) !== stableJson(head.metadata))
        ) {
            stale("upsert claim payload does not match the current vector head");
        }
        if (claim.operation === "delete" && claim.mode !== "cleanup" && claim.mode !== "delete") {
            invalid("delete claim mode is invalid");
        }
        return head;
    }

    private deleteClaimedOutbox(
        vectorId: string,
        targetVersion: number,
        operation: "upsert" | "delete",
        phase: "submit" | "verify",
        token: string
    ): void {
        this.sql.exec(
            `DELETE FROM _chardb_vector_outbox
             WHERE vector_id = ? AND target_version = ? AND operation = ? AND phase = ? AND lease_token = ?`,
            vectorId,
            targetVersion,
            operation,
            phase,
            token
        );
        if (this.sql.changes() !== 1) stale("claim lost its outbox row before settlement");
    }
}
