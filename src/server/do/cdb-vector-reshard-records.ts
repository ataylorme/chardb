import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { VSHARD_COUNT, vshardOf } from "../../vshard.ts";
import { assertCdbReshardRangeIdentity } from "./cdb-reshard-identity-store.ts";
import {
    CDB_RESHARD_MAX_BATCH_BYTES,
    CDB_RESHARD_MAX_ROW_BYTES,
    assertReshardBatchBudget,
    assertReshardEnvelopeBudget,
    reshardJsonBytes,
} from "./cdb-reshard-relational.ts";
import {
    CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
    CDB_VECTOR_MAX_DELETE_ID_BYTES,
    CDB_VECTOR_MAX_DIMENSIONS,
    CDB_VECTOR_MAX_ERROR_BYTES,
    CDB_VECTOR_MAX_METADATA_BYTES,
    CDB_VECTOR_MAX_VALUES_BYTES,
    validateCdbVectorDeletePhysicalIds,
} from "./cdb-vector-outbox-store.ts";

export const CDB_VECTOR_RESHARD_PAGE_SIZE = 500;
export const CDB_VECTOR_RESHARD_PAGE_SCHEMA = "chardb.vector-reshard-page.v2" as const;

const TEXT = new TextEncoder();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const HEAD_RECORD_FIELDS = new Set([
    "kind",
    "vectorId",
    "organizationId",
    "placementVshard",
    "resourceId",
    "headVersion",
    "rowPk",
    "dimensions",
    "deliveredVersion",
    "valuesEncBase64",
    "metadataJson",
    "state",
    "updatedAt",
]);
const OUTBOX_RECORD_FIELDS = new Set([
    "kind",
    "vectorId",
    "organizationId",
    "placementVshard",
    "resourceId",
    "headVersion",
    "headState",
    "targetVersion",
    "operation",
    "phase",
    "mutationId",
    "acceptedAt",
    "verifyIdsJson",
    "attempts",
    "nextAttemptAt",
    "leasedUntil",
    "leaseToken",
    "terminalFailure",
    "lastError",
]);
const ATTEMPT_RECORD_FIELDS = new Set([
    "kind",
    "vectorId",
    "organizationId",
    "placementVshard",
    "resourceId",
    "headVersion",
    "physicalVersion",
    "firstSentAt",
    "settleAfter",
    "visibilityConfirmed",
    "responseAmbiguous",
    "deleteConfirmed",
    "deleteClaimToken",
]);
const CURSOR_FIELDS = new Set(["kind", "throughHeadSeq", "afterPlacement", "afterVectorId", "afterPhysicalVersion"]);
const PAGE_FIELDS = new Set(["schema", "records", "next", "done"]);

export type CdbVectorReshardRecordKind = "head" | "outbox" | "attempt";
export type CdbVectorReshardCursorKind = CdbVectorReshardRecordKind | "done";

interface CdbVectorReshardOwner {
    readonly vectorId: string;
    readonly organizationId: string;
    readonly placementVshard: number;
    readonly resourceId: string;
    readonly headVersion: number;
}

export interface CdbVectorReshardHeadRecord extends CdbVectorReshardOwner {
    readonly kind: "head";
    readonly rowPk: string;
    readonly dimensions: number;
    readonly deliveredVersion: number;
    /** Canonical base64 for the exact SQLite `values_enc` bytes. */
    readonly valuesEncBase64: string | null;
    /** The exact stored JSON text. It is validated but never reserialized. */
    readonly metadataJson: string;
    readonly state: "pending" | "ready" | "deleting";
    readonly updatedAt: number;
}

export interface CdbVectorReshardOutboxRecord extends CdbVectorReshardOwner {
    readonly kind: "outbox";
    readonly headState: CdbVectorReshardHeadRecord["state"];
    readonly targetVersion: number;
    readonly operation: "upsert" | "delete";
    readonly phase: "submit" | "verify";
    readonly mutationId: string | null;
    readonly acceptedAt: number | null;
    readonly verifyIdsJson: string | null;
    readonly attempts: number;
    readonly nextAttemptAt: number;
    readonly leasedUntil: number | null;
    readonly leaseToken: string | null;
    readonly terminalFailure: 0 | 1;
    readonly lastError: string | null;
}

export interface CdbVectorReshardAttemptRecord extends CdbVectorReshardOwner {
    readonly kind: "attempt";
    readonly physicalVersion: number;
    readonly firstSentAt: number;
    readonly settleAfter: number;
    readonly visibilityConfirmed: 0 | 1;
    readonly responseAmbiguous: 0 | 1;
    readonly deleteConfirmed: 0 | 1;
    readonly deleteClaimToken: string | null;
}

export type CdbVectorReshardRecord =
    | CdbVectorReshardHeadRecord
    | CdbVectorReshardOutboxRecord
    | CdbVectorReshardAttemptRecord;

export interface CdbVectorReshardCursor {
    readonly kind: CdbVectorReshardCursorKind;
    /** Fixed non-reusable source head insertion generation for this snapshot. */
    readonly throughHeadSeq: number;
    readonly afterPlacement: number;
    readonly afterVectorId: string;
    readonly afterPhysicalVersion: number;
}

export interface CdbVectorReshardPage {
    readonly schema: typeof CDB_VECTOR_RESHARD_PAGE_SCHEMA;
    readonly records: readonly CdbVectorReshardRecord[];
    readonly next: CdbVectorReshardCursor;
    readonly done: boolean;
}

export interface CdbVectorReshardIdentity {
    readonly migId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}

interface StoredHead {
    readonly vector_id: string;
    readonly organization_id: string;
    readonly placement_vshard: number | bigint;
    readonly resource_id: string;
    readonly row_pk: string;
    readonly dimensions: number | bigint;
    readonly version: number | bigint;
    readonly delivered_version: number | bigint;
    readonly values_enc: Uint8Array | ArrayBuffer | null;
    readonly metadata_json: string;
    readonly state: CdbVectorReshardHeadRecord["state"];
    readonly updated_at: number | bigint;
}

interface StoredOutbox {
    readonly vector_id: string;
    readonly organization_id: string;
    readonly placement_vshard: number | bigint;
    readonly resource_id: string;
    readonly head_version: number | bigint;
    readonly head_state: CdbVectorReshardHeadRecord["state"];
    readonly target_version: number | bigint;
    readonly operation: CdbVectorReshardOutboxRecord["operation"];
    readonly phase: CdbVectorReshardOutboxRecord["phase"];
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
    readonly vector_id: string;
    readonly organization_id: string;
    readonly placement_vshard: number | bigint;
    readonly resource_id: string;
    readonly head_version: number | bigint;
    readonly physical_version: number | bigint;
    readonly first_sent_at: number | bigint;
    readonly settle_after: number | bigint;
    readonly visibility_confirmed: number | bigint;
    readonly response_ambiguous: number | bigint;
    readonly delete_confirmed: number | bigint;
    readonly delete_claim_token: string | null;
}

interface StoredSplitIdentity {
    readonly range_lo: number | bigint;
    readonly range_hi: number | bigint;
    readonly role: "source" | "dest";
}

function mismatch(message: string): never {
    throw new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message: `vector reshard: ${message}` });
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `vector reshard: ${message}` });
}

function rejectUnknownKeys(
    raw: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    subject: string,
    reject: (message: string) => never
): void {
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) reject(`${subject} has an unknown field`);
    }
}

function safeInteger(value: unknown, subject: string, minimum = 0): number {
    const number = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(number) || number < minimum) mismatch(`${subject} is invalid`);
    return number;
}

function boundedText(value: unknown, subject: string, maxBytes = 256): string {
    if (typeof value !== "string" || value.length === 0 || TEXT.encode(value).byteLength > maxBytes) {
        mismatch(`${subject} is invalid`);
    }
    return value;
}

function identifier(value: unknown, subject: string): string {
    if (typeof value !== "string" || !ID.test(value)) mismatch(`${subject} is invalid`);
    return value;
}

function nullableText(value: unknown, subject: string, maxBytes: number): string | null {
    if (value === null) return null;
    return boundedText(value, subject, maxBytes);
}

function flag(value: unknown, subject: string): 0 | 1 {
    const number = safeInteger(value, subject);
    if (number !== 0 && number !== 1) mismatch(`${subject} is invalid`);
    return number;
}

function exactPlacement(organizationId: string, value: unknown): number {
    const placement = safeInteger(value, `organization ${organizationId} placement`);
    if (placement >= VSHARD_COUNT || placement !== Number(vshardOf([organizationId]))) {
        mismatch(`organization ${organizationId} placement is invalid`);
    }
    return placement;
}

function bytes(value: Uint8Array | ArrayBuffer): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function base64(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
    if (typeof value !== "string" || value.length === 0) mismatch("encoded embedding is invalid");
    let decoded: Uint8Array;
    try {
        decoded = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    } catch {
        mismatch("encoded embedding is invalid");
    }
    if (base64(decoded) !== value) mismatch("encoded embedding is not canonical base64");
    return decoded;
}

function validateValues(value: Uint8Array, dimensions: number): void {
    if (value.byteLength < 4 || value.byteLength > CDB_VECTOR_MAX_VALUES_BYTES || value.byteLength !== dimensions * 4) {
        mismatch("encoded embedding length does not match dimensions");
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    for (let offset = 0; offset < value.byteLength; offset += 4) {
        if (!Number.isFinite(view.getFloat32(offset, true))) mismatch("encoded embedding contains a non-finite value");
    }
}

function validateJsonValue(value: unknown, depth: number, budget: { nodes: number }): void {
    budget.nodes++;
    if (budget.nodes > 2_048 || depth > 16) mismatch("metadata structure exceeds its bound");
    if (value === null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
        for (const item of value) validateJsonValue(item, depth + 1, budget);
        return;
    }
    if (typeof value !== "object") mismatch("metadata contains a non-JSON value");
    for (const [key, item] of Object.entries(value)) {
        if (TEXT.encode(key).byteLength > 256) mismatch("metadata key exceeds 256 UTF-8 bytes");
        validateJsonValue(item, depth + 1, budget);
    }
}

function metadataJson(value: unknown): string {
    if (typeof value !== "string" || TEXT.encode(value).byteLength > CDB_VECTOR_MAX_METADATA_BYTES) {
        mismatch("metadata JSON exceeds its byte bound");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        mismatch("metadata JSON is malformed");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        mismatch("metadata JSON is not an object");
    validateJsonValue(parsed, 0, { nodes: 0 });
    return value;
}

function owner(raw: Record<string, unknown>): CdbVectorReshardOwner {
    const vectorId = identifier(raw.vectorId, "vector id");
    const organizationId = boundedText(raw.organizationId, "organization id");
    const resourceId = identifier(raw.resourceId, "resource id");
    const headVersion = safeInteger(raw.headVersion, "head version", 1);
    return Object.freeze({
        vectorId,
        organizationId,
        placementVshard: exactPlacement(organizationId, raw.placementVshard),
        resourceId,
        headVersion,
    });
}

function normalizeHead(raw: Record<string, unknown>): CdbVectorReshardHeadRecord {
    rejectUnknownKeys(raw, HEAD_RECORD_FIELDS, "head record", mismatch);
    const common = owner(raw);
    const dimensions = safeInteger(raw.dimensions, "dimensions", 1);
    if (dimensions > CDB_VECTOR_MAX_DIMENSIONS) mismatch("dimensions exceed their bound");
    const deliveredVersion = safeInteger(raw.deliveredVersion, "delivered version");
    if (deliveredVersion > common.headVersion) mismatch("delivered version exceeds head version");
    if (raw.state !== "pending" && raw.state !== "ready" && raw.state !== "deleting") {
        mismatch("head state is invalid");
    }
    if (
        (raw.state === "ready" && deliveredVersion !== common.headVersion) ||
        (raw.state !== "ready" && deliveredVersion >= common.headVersion)
    ) {
        mismatch("delivered version does not match head state");
    }
    let valuesEncBase64: string | null = null;
    if (raw.valuesEncBase64 !== null) {
        const encoded = decodeBase64(raw.valuesEncBase64);
        validateValues(encoded, dimensions);
        valuesEncBase64 = raw.valuesEncBase64 as string;
    }
    if ((raw.state === "deleting") !== (valuesEncBase64 === null)) mismatch("embedding does not match head state");
    return Object.freeze({
        kind: "head",
        ...common,
        rowPk: boundedText(raw.rowPk, "row primary key"),
        dimensions,
        deliveredVersion,
        valuesEncBase64,
        metadataJson: metadataJson(raw.metadataJson),
        state: raw.state,
        updatedAt: safeInteger(raw.updatedAt, "update time"),
    });
}

function normalizeOutbox(raw: Record<string, unknown>): CdbVectorReshardOutboxRecord {
    rejectUnknownKeys(raw, OUTBOX_RECORD_FIELDS, "outbox record", mismatch);
    const common = owner(raw);
    const targetVersion = safeInteger(raw.targetVersion, "outbox target version", 1);
    if (targetVersion !== common.headVersion) mismatch("outbox target does not match head version");
    if (raw.headState !== "pending" && raw.headState !== "ready" && raw.headState !== "deleting") {
        mismatch("outbox head state is invalid");
    }
    if (raw.operation !== "upsert" && raw.operation !== "delete") mismatch("outbox operation is invalid");
    if (
        (raw.operation === "upsert" && raw.headState !== "pending") ||
        (raw.operation === "delete" && raw.headState !== "ready" && raw.headState !== "deleting")
    ) {
        mismatch("outbox operation does not match head state");
    }
    if (raw.phase !== "submit" && raw.phase !== "verify") mismatch("outbox phase is invalid");
    const mutationId = nullableText(raw.mutationId, "mutation id", 128);
    const acceptedAt = raw.acceptedAt === null ? null : safeInteger(raw.acceptedAt, "acceptance time");
    if (
        (raw.phase === "submit" && (mutationId !== null || acceptedAt !== null)) ||
        (raw.phase === "verify" && (mutationId === null || acceptedAt === null))
    ) {
        mismatch("outbox receipt does not match phase");
    }
    const verifyIdsJson = nullableText(raw.verifyIdsJson, "verification ids", CDB_VECTOR_MAX_DELETE_ID_BYTES);
    if (raw.operation === "upsert" && verifyIdsJson !== null) mismatch("upsert outbox has delete verification ids");
    if (verifyIdsJson !== null) {
        let ids: unknown;
        try {
            ids = JSON.parse(verifyIdsJson);
        } catch {
            mismatch("verification ids are malformed");
        }
        try {
            validateCdbVectorDeletePhysicalIds(ids, {
                resourceId: common.resourceId,
                vectorId: common.vectorId,
                targetVersion,
            });
        } catch {
            mismatch("verification ids are invalid");
        }
    }
    const leasedUntil = raw.leasedUntil === null ? null : safeInteger(raw.leasedUntil, "lease deadline");
    const leaseToken = raw.leaseToken === null ? null : identifier(raw.leaseToken, "lease token");
    if ((leasedUntil === null) !== (leaseToken === null)) mismatch("outbox lease identity is incomplete");
    if (leaseToken !== null && !TOKEN.test(leaseToken)) mismatch("lease token is invalid");
    const terminalFailure = safeInteger(raw.terminalFailure, "outbox terminal failure state");
    if (terminalFailure > 1) mismatch("outbox terminal failure state is invalid");
    if (terminalFailure === 1 && leaseToken !== null) mismatch("terminally failed outbox cannot retain a lease");
    if (
        terminalFailure === 1 &&
        (raw.operation !== "delete" || raw.lastError !== CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR)
    ) {
        mismatch("terminally failed outbox shape is invalid");
    }
    return Object.freeze({
        kind: "outbox",
        ...common,
        headState: raw.headState,
        targetVersion,
        operation: raw.operation,
        phase: raw.phase,
        mutationId,
        acceptedAt,
        verifyIdsJson,
        attempts: safeInteger(raw.attempts, "outbox attempt count"),
        nextAttemptAt: safeInteger(raw.nextAttemptAt, "next attempt time"),
        leasedUntil,
        leaseToken,
        terminalFailure: terminalFailure as 0 | 1,
        lastError: nullableText(raw.lastError, "last error", CDB_VECTOR_MAX_ERROR_BYTES),
    });
}

function normalizeAttempt(raw: Record<string, unknown>): CdbVectorReshardAttemptRecord {
    rejectUnknownKeys(raw, ATTEMPT_RECORD_FIELDS, "attempt record", mismatch);
    const common = owner(raw);
    const physicalVersion = safeInteger(raw.physicalVersion, "physical version", 1);
    if (physicalVersion > common.headVersion) mismatch("physical version exceeds head version");
    const firstSentAt = safeInteger(raw.firstSentAt, "first sent time");
    const settleAfter = safeInteger(raw.settleAfter, "settlement time");
    if (settleAfter < firstSentAt) mismatch("settlement time predates first send");
    const deleteClaimToken =
        raw.deleteClaimToken === null ? null : identifier(raw.deleteClaimToken, "delete claim token");
    if (deleteClaimToken !== null && !TOKEN.test(deleteClaimToken)) mismatch("delete claim token is invalid");
    return Object.freeze({
        kind: "attempt",
        ...common,
        physicalVersion,
        firstSentAt,
        settleAfter,
        visibilityConfirmed: flag(raw.visibilityConfirmed, "visibility confirmation"),
        responseAmbiguous: flag(raw.responseAmbiguous, "response ambiguity"),
        deleteConfirmed: flag(raw.deleteConfirmed, "delete confirmation"),
        deleteClaimToken,
    });
}

export function normalizeCdbVectorReshardRecord(value: unknown): CdbVectorReshardRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) mismatch("record is malformed");
    const raw = value as Record<string, unknown>;
    if (raw.kind === "head") return normalizeHead(raw);
    if (raw.kind === "outbox") return normalizeOutbox(raw);
    if (raw.kind === "attempt") return normalizeAttempt(raw);
    mismatch("record kind is invalid");
}

export function encodeCdbVectorReshardRecord(record: CdbVectorReshardRecord): string {
    const normalized = normalizeCdbVectorReshardRecord(record);
    assertReshardBatchBudget([normalized], "vector reshard record");
    return JSON.stringify(normalized);
}

export function decodeCdbVectorReshardRecord(encoded: string): CdbVectorReshardRecord {
    if (typeof encoded !== "string" || TEXT.encode(encoded).byteLength > CDB_RESHARD_MAX_ROW_BYTES) {
        invalid("record encoding exceeds its byte limit");
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch {
        invalid("record encoding is not JSON");
    }
    const record = normalizeCdbVectorReshardRecord(value);
    assertReshardBatchBudget([record], "vector reshard record");
    return record;
}

export function normalizeCdbVectorReshardCursor(value: unknown): CdbVectorReshardCursor {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("page cursor is malformed");
    const raw = value as Record<string, unknown>;
    rejectUnknownKeys(raw, CURSOR_FIELDS, "page cursor", invalid);
    if (raw.kind !== "head" && raw.kind !== "outbox" && raw.kind !== "attempt" && raw.kind !== "done") {
        invalid("page cursor kind is invalid");
    }
    const throughHeadSeq = safeInteger(raw.throughHeadSeq, "page cursor head watermark");
    const afterPlacement = safeInteger(raw.afterPlacement, "page cursor placement", -1);
    const afterVectorId = raw.afterVectorId === "" ? "" : identifier(raw.afterVectorId, "page cursor vector id");
    const afterPhysicalVersion = safeInteger(raw.afterPhysicalVersion, "page cursor physical version");
    const atStart = afterPlacement === -1 && afterVectorId === "" && afterPhysicalVersion === 0;
    if (
        (!atStart && (afterPlacement < 0 || afterPlacement >= VSHARD_COUNT || afterVectorId === "")) ||
        (raw.kind !== "attempt" && afterPhysicalVersion !== 0) ||
        (raw.kind === "done" && !atStart)
    ) {
        invalid("page cursor is invalid");
    }
    return Object.freeze({ kind: raw.kind, throughHeadSeq, afterPlacement, afterVectorId, afterPhysicalVersion });
}

function normalizePage(value: unknown): CdbVectorReshardPage {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("page is malformed");
    const raw = value as Record<string, unknown>;
    rejectUnknownKeys(raw, PAGE_FIELDS, "page", invalid);
    if (raw.schema !== CDB_VECTOR_RESHARD_PAGE_SCHEMA || !Array.isArray(raw.records)) invalid("page is malformed");
    if (raw.records.length > CDB_VECTOR_RESHARD_PAGE_SIZE) invalid("page exceeds its record limit");
    const records = raw.records.map(normalizeCdbVectorReshardRecord);
    if (records.some(record => record.kind !== records[0]?.kind)) invalid("page mixes record kinds");
    const next = normalizeCdbVectorReshardCursor(raw.next);
    if (typeof raw.done !== "boolean" || raw.done !== (next.kind === "done")) invalid("page completion is invalid");
    assertReshardBatchBudget(records, "vector reshard page");
    return Object.freeze({
        schema: CDB_VECTOR_RESHARD_PAGE_SCHEMA,
        records: Object.freeze(records),
        next,
        done: raw.done,
    });
}

export function encodeCdbVectorReshardPage(page: CdbVectorReshardPage): string {
    const normalized = normalizePage(page);
    assertReshardEnvelopeBudget(normalized, "vector reshard page");
    return JSON.stringify(normalized);
}

export function decodeCdbVectorReshardPage(encoded: string): CdbVectorReshardPage {
    if (typeof encoded !== "string" || TEXT.encode(encoded).byteLength > CDB_RESHARD_MAX_BATCH_BYTES) {
        invalid("page encoding exceeds its byte limit");
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch {
        invalid("page encoding is not JSON");
    }
    const page = normalizePage(value);
    assertReshardEnvelopeBudget(page, "vector reshard page");
    return page;
}

export const CDB_VECTOR_RESHARD_START_CURSOR: CdbVectorReshardCursor = Object.freeze({
    kind: "head",
    throughHeadSeq: 0,
    afterPlacement: -1,
    afterVectorId: "",
    afterPhysicalVersion: 0,
});

/** Includes every valid local head generation. Used only after the tail converges. */
export const CDB_VECTOR_RESHARD_PARITY_START_CURSOR: CdbVectorReshardCursor = Object.freeze({
    ...CDB_VECTOR_RESHARD_START_CURSOR,
    throughHeadSeq: Number.MAX_SAFE_INTEGER,
});

function nextKind(kind: CdbVectorReshardRecordKind, throughHeadSeq: number): CdbVectorReshardCursor {
    const next = kind === "head" ? "outbox" : kind === "outbox" ? "attempt" : "done";
    return Object.freeze({
        kind: next,
        throughHeadSeq,
        afterPlacement: -1,
        afterVectorId: "",
        afterPhysicalVersion: 0,
    });
}

function cursorAfter(record: CdbVectorReshardRecord, throughHeadSeq: number): CdbVectorReshardCursor {
    return Object.freeze({
        kind: record.kind,
        throughHeadSeq,
        afterPlacement: record.placementVshard,
        afterVectorId: record.vectorId,
        afterPhysicalVersion: record.kind === "attempt" ? record.physicalVersion : 0,
    });
}

function projectStoredHead(row: StoredHead): CdbVectorReshardHeadRecord {
    return normalizeHead({
        kind: "head",
        vectorId: row.vector_id,
        organizationId: row.organization_id,
        placementVshard: row.placement_vshard,
        resourceId: row.resource_id,
        headVersion: row.version,
        rowPk: row.row_pk,
        dimensions: row.dimensions,
        deliveredVersion: row.delivered_version,
        valuesEncBase64: row.values_enc === null ? null : base64(bytes(row.values_enc)),
        metadataJson: row.metadata_json,
        state: row.state,
        updatedAt: row.updated_at,
    });
}

function projectStoredOutbox(row: StoredOutbox): CdbVectorReshardOutboxRecord {
    return normalizeOutbox({
        kind: "outbox",
        vectorId: row.vector_id,
        organizationId: row.organization_id,
        placementVshard: row.placement_vshard,
        resourceId: row.resource_id,
        headVersion: row.head_version,
        headState: row.head_state,
        targetVersion: row.target_version,
        operation: row.operation,
        phase: row.phase,
        mutationId: row.mutation_id,
        acceptedAt: row.accepted_at,
        verifyIdsJson: row.verify_ids_json,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        leasedUntil: row.leased_until,
        leaseToken: row.lease_token,
        terminalFailure: row.terminal_failure,
        lastError: row.last_error,
    });
}

function projectStoredAttempt(row: StoredAttempt): CdbVectorReshardAttemptRecord {
    return normalizeAttempt({
        kind: "attempt",
        vectorId: row.vector_id,
        organizationId: row.organization_id,
        placementVshard: row.placement_vshard,
        resourceId: row.resource_id,
        headVersion: row.head_version,
        physicalVersion: row.physical_version,
        firstSentAt: row.first_sent_at,
        settleAfter: row.settle_after,
        visibilityConfirmed: row.visibility_confirmed,
        responseAmbiguous: row.response_ambiguous,
        deleteConfirmed: row.delete_confirmed,
        deleteClaimToken: row.delete_claim_token,
    });
}

/** Reads exact vector side-state without invoking Vectorize or changing source state. */
export class CdbVectorReshardSnapshotReader {
    constructor(
        private readonly sql: SyncSql,
        private readonly role: "source" | "dest" = "source"
    ) {}

    /** Capture this only after relational tail capture has started. */
    begin(identity: CdbVectorReshardIdentity): CdbVectorReshardCursor {
        this.assertIdentity(identity);
        const throughHeadSeq = safeInteger(
            this.sql.one<{ created_seq: number | bigint }>(
                "SELECT COALESCE(MAX(created_seq), 0) AS created_seq FROM _chardb_vectors"
            )?.created_seq ?? 0,
            "source head watermark"
        );
        return Object.freeze({ ...CDB_VECTOR_RESHARD_START_CURSOR, throughHeadSeq });
    }

    read(
        identity: CdbVectorReshardIdentity,
        cursor: CdbVectorReshardCursor,
        limit = CDB_VECTOR_RESHARD_PAGE_SIZE
    ): CdbVectorReshardPage {
        this.assertIdentity(identity);
        if (limit !== CDB_VECTOR_RESHARD_PAGE_SIZE) {
            invalid(`page limit must be exactly ${CDB_VECTOR_RESHARD_PAGE_SIZE}`);
        }
        const current = normalizeCdbVectorReshardCursor(cursor);
        while (current.kind !== "done") {
            const kind: CdbVectorReshardRecordKind = current.kind;
            const activeCursor = Object.freeze({ ...current, kind });
            if (
                current.afterPlacement !== -1 &&
                (current.afterPlacement < identity.rangeLo || current.afterPlacement > identity.rangeHi)
            ) {
                invalid("page cursor placement is outside the split range");
            }
            const candidates = this.readKind(identity, activeCursor);
            if (candidates.length === 0) {
                const next = nextKind(kind, current.throughHeadSeq);
                return Object.freeze({
                    schema: CDB_VECTOR_RESHARD_PAGE_SCHEMA,
                    records: Object.freeze([]),
                    next,
                    done: next.kind === "done",
                });
            }
            const records: CdbVectorReshardRecord[] = [];
            let recordsJsonBytes = 2;
            for (const candidate of candidates.slice(0, CDB_VECTOR_RESHARD_PAGE_SIZE)) {
                const candidateBytes = assertReshardBatchBudget([candidate], "vector reshard page");
                const nextRecordsJsonBytes = recordsJsonBytes + candidateBytes + (records.length === 0 ? 0 : 1);
                const emptyTrial = Object.freeze({
                    schema: CDB_VECTOR_RESHARD_PAGE_SCHEMA,
                    records: Object.freeze([]),
                    next: cursorAfter(candidate, current.throughHeadSeq),
                    done: false,
                });
                // Replace the empty `[]` already counted in the envelope with
                // the incrementally sized records array.
                const trialBytes = reshardJsonBytes(emptyTrial) - 2 + nextRecordsJsonBytes;
                if (trialBytes > CDB_RESHARD_MAX_BATCH_BYTES) break;
                records.push(candidate);
                recordsJsonBytes = nextRecordsJsonBytes;
            }
            if (records.length === 0) mismatch("one vector side-state record exceeds the page byte limit");
            const exhausted = candidates.length <= CDB_VECTOR_RESHARD_PAGE_SIZE && records.length === candidates.length;
            const next = exhausted
                ? nextKind(kind, current.throughHeadSeq)
                : cursorAfter(records.at(-1) as CdbVectorReshardRecord, current.throughHeadSeq);
            const page = Object.freeze({
                schema: CDB_VECTOR_RESHARD_PAGE_SCHEMA,
                records: Object.freeze(records),
                next,
                done: next.kind === "done",
            });
            encodeCdbVectorReshardPage(page);
            return page;
        }
        return Object.freeze({
            schema: CDB_VECTOR_RESHARD_PAGE_SCHEMA,
            records: Object.freeze([]),
            next: current,
            done: true,
        });
    }

    private readKind(
        identity: CdbVectorReshardIdentity,
        cursor: CdbVectorReshardCursor & { readonly kind: CdbVectorReshardRecordKind }
    ): CdbVectorReshardRecord[] {
        if (cursor.kind === "head") {
            return this.sql
                .all<StoredHead>(
                    `SELECT * FROM _chardb_vectors
                     WHERE created_seq <= ? AND placement_vshard BETWEEN ? AND ?
                       AND (placement_vshard > ? OR (placement_vshard = ? AND vector_id > ?))
                     ORDER BY placement_vshard, vector_id LIMIT ?`,
                    cursor.throughHeadSeq,
                    identity.rangeLo,
                    identity.rangeHi,
                    cursor.afterPlacement,
                    cursor.afterPlacement,
                    cursor.afterVectorId,
                    CDB_VECTOR_RESHARD_PAGE_SIZE + 1
                )
                .map(projectStoredHead);
        }
        if (cursor.kind === "outbox") {
            return this.sql
                .all<StoredOutbox>(
                    `SELECT head.vector_id, head.organization_id, head.placement_vshard, head.resource_id,
                            head.version AS head_version, head.state AS head_state, outbox.*
                     FROM _chardb_vector_outbox AS outbox
                     INNER JOIN _chardb_vectors AS head ON head.vector_id = outbox.vector_id
                     WHERE head.created_seq <= ? AND head.placement_vshard BETWEEN ? AND ?
                       AND (head.placement_vshard > ? OR (head.placement_vshard = ? AND head.vector_id > ?))
                     ORDER BY head.placement_vshard, head.vector_id LIMIT ?`,
                    cursor.throughHeadSeq,
                    identity.rangeLo,
                    identity.rangeHi,
                    cursor.afterPlacement,
                    cursor.afterPlacement,
                    cursor.afterVectorId,
                    CDB_VECTOR_RESHARD_PAGE_SIZE + 1
                )
                .map(projectStoredOutbox);
        }
        return this.sql
            .all<StoredAttempt>(
                `SELECT head.vector_id, head.organization_id, head.placement_vshard, head.resource_id,
                        head.version AS head_version, attempt.*
                 FROM _chardb_vector_attempts AS attempt
                 INNER JOIN _chardb_vectors AS head ON head.vector_id = attempt.vector_id
                 WHERE head.created_seq <= ? AND head.placement_vshard BETWEEN ? AND ?
                   AND (head.placement_vshard > ? OR
                        (head.placement_vshard = ? AND
                         (head.vector_id > ? OR (head.vector_id = ? AND attempt.physical_version > ?))))
                 ORDER BY head.placement_vshard, head.vector_id, attempt.physical_version LIMIT ?`,
                cursor.throughHeadSeq,
                identity.rangeLo,
                identity.rangeHi,
                cursor.afterPlacement,
                cursor.afterPlacement,
                cursor.afterVectorId,
                cursor.afterVectorId,
                cursor.afterPhysicalVersion,
                CDB_VECTOR_RESHARD_PAGE_SIZE + 1
            )
            .map(projectStoredAttempt);
    }

    /** Internal binding check for durable paging wrappers. */
    assertSourceIdentity(identity: CdbVectorReshardIdentity): void {
        if (this.role !== "source") mismatch("snapshot reader is not bound to a source");
        this.assertIdentity(identity);
    }

    /** Internal binding check for destination parity readers. */
    assertIdentity(identity: CdbVectorReshardIdentity): void {
        assertCdbReshardRangeIdentity(identity);
        const stored = this.sql.one<StoredSplitIdentity>(
            "SELECT range_lo, range_hi, role FROM _chardb_split_identity WHERE mig_id = ?",
            identity.migId
        );
        if (!stored) mismatch(`migration ${identity.migId} has no bound split identity`);
        if (
            safeInteger(stored.range_lo, "bound range start") !== identity.rangeLo ||
            safeInteger(stored.range_hi, "bound range end") !== identity.rangeHi ||
            stored.role !== this.role
        ) {
            mismatch(`migration ${identity.migId} does not match its bound ${this.role} identity`);
        }
    }
}
