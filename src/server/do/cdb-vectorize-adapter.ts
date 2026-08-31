import { CdbError, isCdbError } from "../../errors.ts";
import { stableJson } from "../../util/canonical.ts";
import { type VectorResourceV1, cdbVectorResourceId } from "../resource-descriptors.ts";
import {
    CDB_VECTOR_MAX_VALUES_BYTES,
    type CdbVectorClaim,
    type CdbVectorHead,
    type CdbVectorUpsertClaim,
    cdbVectorPhysicalId,
} from "./cdb-vector-outbox-store.ts";
import {
    CDB_VECTORIZE_MAX_ID_BYTES,
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizePhysicalIdFromCanonical,
    cdbVectorizeResourceFilter,
    parseCdbVectorizePhysicalId,
} from "./cdb-vectorize-wire.ts";

export const CDB_VECTORIZE_MAX_RETURNED_MATCHES = 100;
export const CDB_VECTORIZE_CANDIDATE_OVERFETCH = 16;
export const CDB_VECTORIZE_QUERY_TIMEOUT_MS = 5_000;

export interface CdbVectorizeQueryTimers {
    setTimeout(callback: () => void, milliseconds: number): unknown;
    clearTimeout(handle: unknown): void;
}

type VectorizeMetadataValue = string | number | boolean | readonly string[];

export interface CdbVectorizeRecord {
    readonly id: string;
    readonly values: readonly number[];
    readonly namespace: string;
    readonly metadata: Readonly<Record<string, VectorizeMetadataValue>>;
}

export interface CdbVectorizeMutationIndex {
    upsert(records: readonly CdbVectorizeRecord[]): Promise<unknown> | unknown;
    deleteByIds(ids: readonly string[]): Promise<unknown> | unknown;
    getByIds(ids: readonly string[]): Promise<unknown> | unknown;
    describe?(): Promise<unknown> | unknown;
}

export type CdbVectorizeMutationReceipt =
    | { readonly kind: "accepted"; readonly mutationId: string }
    | { readonly kind: "processed" };

export interface CdbVectorizeMatch {
    readonly id: string;
    readonly score: number;
}

export interface CdbVectorizeQueryOptions {
    readonly topK: number;
    readonly namespace: string;
    readonly returnValues: false;
    readonly returnMetadata: "none";
    readonly filter: {
        readonly cdb_resource: string;
    };
}

export interface CdbVectorizeSearchIndex {
    query(values: readonly number[], options: CdbVectorizeQueryOptions): Promise<unknown> | unknown;
}

export interface CdbValidatedVectorMatch {
    readonly vectorId: string;
    readonly rowPk: string;
    readonly score: number;
    readonly metadata: Readonly<Record<string, unknown>>;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `vectorize adapter: ${message}` });
}

function invariant(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message: `vectorize adapter: ${message}` });
}

function boundedOrganization(value: string): string {
    if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 256) {
        invalid("organization id is invalid");
    }
    return value;
}

function boundedQueryValues(values: readonly number[], dimensions: number): readonly number[] {
    if (!Array.isArray(values) || values.length !== dimensions) {
        throw new CdbError({
            code: "CDB_VECTORIZE_DIM_MISMATCH",
            message: "vectorize adapter: query embedding length does not match the configured resource",
        });
    }
    if (values.length * 4 > CDB_VECTOR_MAX_VALUES_BYTES) invalid("query embedding exceeds its byte bound");
    const projected = values.map(value => {
        if (typeof value !== "number" || !Number.isFinite(value)) invalid("query embedding values must be finite");
        const encoded = new Float32Array([value])[0];
        if (encoded === undefined || !Number.isFinite(encoded)) invalid("query embedding value exceeds float32 range");
        return encoded;
    });
    return Object.freeze(projected);
}

function normalizedScore(score: number): number {
    return Object.is(score, -0) ? 0 : score;
}

async function beforeVectorizeQueryDeadline<T>(
    operation: () => Promise<T> | T,
    timers: CdbVectorizeQueryTimers | undefined
): Promise<T> {
    const schedule = timers?.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    const cancel = timers?.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let timeoutHandle: unknown;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = schedule(() => {
            reject(
                new CdbError({
                    code: "CDB_SHARD_UNAVAILABLE",
                    message: `vectorize adapter: search request timed out after ${CDB_VECTORIZE_QUERY_TIMEOUT_MS}ms`,
                })
            );
        }, CDB_VECTORIZE_QUERY_TIMEOUT_MS);
    });
    try {
        return await Promise.race([Promise.resolve().then(operation), timeout]);
    } finally {
        if (timeoutHandle !== undefined) cancel(timeoutHandle);
    }
}

function queryReceipt(value: unknown, limit: number): readonly CdbVectorizeMatch[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        invariant("search returned an invalid receipt");
    }
    const receipt = value as { readonly matches?: unknown; readonly count?: unknown };
    if (
        !Array.isArray(receipt.matches) ||
        !Number.isSafeInteger(receipt.count) ||
        receipt.count !== receipt.matches.length
    ) {
        invariant("search returned an invalid receipt");
    }
    if (receipt.matches.length > limit || receipt.matches.length > CDB_VECTORIZE_MAX_RETURNED_MATCHES) {
        invariant("search returned more candidates than requested");
    }
    return Object.freeze(
        receipt.matches.map(value => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                invariant("search returned an invalid candidate");
            }
            const match = value as { readonly id?: unknown; readonly score?: unknown };
            if (typeof match.id !== "string" || typeof match.score !== "number" || !Number.isFinite(match.score)) {
                invariant("search returned an invalid candidate");
            }
            return Object.freeze({ id: match.id, score: normalizedScore(match.score) });
        })
    );
}

/**
 * Run one internal descriptor-bound Vectorize search. The caller selects the
 * binding from `resource.binding`; the adapter supplies the organization
 * namespace and canonical resource filter and asks Vectorize for no values or
 * metadata. This returns candidates, not a complete result page. SQLite head
 * and row-policy validation may discard candidates, and continuation is not
 * wired yet.
 */
export async function queryCdbVectorizeCandidates(input: {
    readonly index: CdbVectorizeSearchIndex;
    readonly resource: VectorResourceV1;
    readonly organizationId: string;
    readonly values: readonly number[];
    readonly limit: number;
    readonly timers?: CdbVectorizeQueryTimers;
}): Promise<readonly CdbVectorizeMatch[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CDB_VECTORIZE_MAX_RETURNED_MATCHES) {
        invalid(`search limit must be between 1 and ${CDB_VECTORIZE_MAX_RETURNED_MATCHES}`);
    }
    const resourceId = cdbVectorResourceId(input.resource);
    const organizationId = boundedOrganization(input.organizationId);
    const values = boundedQueryValues(input.values, input.resource.dimensions);
    const candidateLimit = Math.min(
        CDB_VECTORIZE_MAX_RETURNED_MATCHES,
        input.limit + CDB_VECTORIZE_CANDIDATE_OVERFETCH
    );
    try {
        const result = await beforeVectorizeQueryDeadline(
            () =>
                input.index.query(values, {
                    topK: candidateLimit,
                    namespace: cdbVectorizeOrganizationNamespace(organizationId),
                    returnValues: false,
                    returnMetadata: "none",
                    filter: { cdb_resource: cdbVectorizeResourceFilter(resourceId) },
                }),
            input.timers
        );
        return queryReceipt(result, candidateLimit);
    } catch (error) {
        if (isCdbError(error)) throw error;
        throw new CdbError({
            code: "CDB_SHARD_UNAVAILABLE",
            message: "vectorize adapter: search request failed",
            cause: error,
        });
    }
}

function mutationAccepted(result: unknown, expectedIds: readonly string[]): CdbVectorizeMutationReceipt {
    if (typeof result !== "object" || result === null) invariant("mutation returned an invalid receipt");
    const receipt = result as { readonly mutationId?: unknown; readonly ids?: unknown; readonly count?: unknown };
    if (
        typeof receipt.mutationId === "string" &&
        receipt.mutationId.length > 0 &&
        new TextEncoder().encode(receipt.mutationId).byteLength <= 128
    ) {
        return Object.freeze({ kind: "accepted", mutationId: receipt.mutationId });
    }
    if (
        !Array.isArray(receipt.ids) ||
        !Number.isSafeInteger(receipt.count) ||
        receipt.count !== expectedIds.length ||
        receipt.ids.length !== expectedIds.length
    ) {
        invariant("mutation returned an invalid receipt");
    }
    const accepted = new Set(receipt.ids);
    if (accepted.size !== expectedIds.length || expectedIds.some(id => !accepted.has(id))) {
        invariant("mutation receipt does not exactly match the claimed vector ids");
    }
    return Object.freeze({ kind: "processed" });
}

function upsertRecord(claim: CdbVectorUpsertClaim): CdbVectorizeRecord {
    const physical = cdbVectorizePhysicalIdFromCanonical(claim.physicalId);
    if (
        physical.identity.resourceId !== claim.resourceId ||
        physical.identity.vectorId !== claim.vectorId ||
        physical.identity.version !== claim.targetVersion ||
        cdbVectorPhysicalId(claim.resourceId, claim.vectorId, claim.targetVersion) !== claim.physicalId
    ) {
        invariant("upsert claim physical identity does not match its durable head");
    }
    return Object.freeze({
        id: physical.wireId,
        values: claim.values,
        namespace: cdbVectorizeOrganizationNamespace(claim.organizationId),
        metadata: Object.freeze({
            cdb_resource: cdbVectorizeResourceFilter(claim.resourceId),
        }),
    });
}

function deleteWireIds(claim: Extract<CdbVectorClaim, { readonly operation: "delete" }>): readonly string[] {
    return Object.freeze(
        claim.physicalIds.map(value => {
            const physical = cdbVectorizePhysicalIdFromCanonical(value);
            if (physical.identity.resourceId !== claim.resourceId || physical.identity.vectorId !== claim.vectorId) {
                invariant("delete claim physical identity does not match its durable head");
            }
            return physical.wireId;
        })
    );
}

/**
 * Send one durable outbox claim to Vectorize. The caller settles or retries the
 * SQLite claim in a separate transaction after this promise resolves or rejects.
 */
export async function deliverCdbVectorClaim(
    index: CdbVectorizeMutationIndex,
    claim: CdbVectorClaim
): Promise<CdbVectorizeMutationReceipt> {
    if (claim.operation === "upsert") {
        const record = upsertRecord(claim);
        const result = await index.upsert([record]);
        return mutationAccepted(result, [record.id]);
    }
    if (claim.physicalIds.length === 0) return Object.freeze({ kind: "processed" });
    const wireIds = deleteWireIds(claim);
    const result = await index.deleteByIds(wireIds);
    return mutationAccepted(result, wireIds);
}

function exactFloat32Values(value: unknown, expected: readonly number[]): boolean {
    if (!Array.isArray(value) && !(value instanceof Float32Array) && !(value instanceof Float64Array)) return false;
    const projected = Array.from(value as ArrayLike<number>, item => new Float32Array([item])[0]);
    return projected.length === expected.length && projected.every((item, index) => item === expected[index]);
}

function exactRecord(value: unknown, expected: CdbVectorizeRecord): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as {
        readonly id?: unknown;
        readonly namespace?: unknown;
        readonly values?: unknown;
        readonly metadata?: unknown;
    };
    return (
        record.id === expected.id &&
        record.namespace === expected.namespace &&
        exactFloat32Values(record.values, expected.values) &&
        stableJson(record.metadata) === stableJson(expected.metadata)
    );
}

/** Verify that an accepted V2 mutation has reached the exact-id read path. */
export async function verifyCdbVectorClaim(index: CdbVectorizeMutationIndex, claim: CdbVectorClaim): Promise<boolean> {
    const wireIds = claim.operation === "upsert" ? [upsertRecord(claim).id] : deleteWireIds(claim);
    let details: unknown;
    if (claim.operation === "delete") {
        details = await (index.describe?.() ??
            invariant("delete verification requires the Vectorize V2 describe capability"));
        if (typeof details !== "object" || details === null || Array.isArray(details)) {
            invariant("describe returned an invalid result");
        }
        const processedUpToMutation = (details as { readonly processedUpToMutation?: unknown }).processedUpToMutation;
        if (typeof processedUpToMutation !== "string" || processedUpToMutation.length === 0) {
            invariant("describe returned an invalid processed mutation watermark");
        }
        if (claim.phase !== "verify" || claim.mutationId === null) {
            invalid("delete verification requires an accepted mutation");
        }
        if (processedUpToMutation !== claim.mutationId) return false;
    }
    const result = await index.getByIds(wireIds);
    if (!Array.isArray(result)) invariant("getByIds returned an invalid result");
    if (result.length > wireIds.length) invariant("getByIds returned more vectors than requested");
    const seen = new Set<string>();
    for (const value of result) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            invariant("getByIds returned an invalid vector");
        }
        const id = (value as { readonly id?: unknown }).id;
        if (typeof id !== "string" || !wireIds.includes(id) || seen.has(id)) {
            invariant("getByIds returned an unexpected vector id");
        }
        seen.add(id);
    }
    if (claim.operation === "delete") {
        return result.length === 0;
    }
    if (result.length === 0) return false;
    if (result.length !== 1 || !exactRecord(result[0], upsertRecord(claim))) {
        invariant("getByIds returned a conflicting vector payload");
    }
    return true;
}

/**
 * Treat Vectorize search output as an untrusted candidate set. Only the current
 * ready SQLite head for the authorized organization and resource can escape.
 */
export function validateCdbVectorMatches(input: {
    readonly matches: readonly CdbVectorizeMatch[];
    readonly organizationId: string;
    readonly resourceId: string;
    readonly limit: number;
    readonly readHead: (vectorId: string) => CdbVectorHead | null;
}): readonly CdbValidatedVectorMatch[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CDB_VECTORIZE_MAX_RETURNED_MATCHES) {
        invalid(`search limit must be between 1 and ${CDB_VECTORIZE_MAX_RETURNED_MATCHES}`);
    }
    if (input.matches.length > CDB_VECTORIZE_MAX_RETURNED_MATCHES) {
        invalid(`candidate count exceeds ${CDB_VECTORIZE_MAX_RETURNED_MATCHES}`);
    }
    const accepted: CdbValidatedVectorMatch[] = [];
    const seen = new Set<string>();
    for (const match of input.matches) {
        if (accepted.length >= input.limit) break;
        if (typeof match.id !== "string" || typeof match.score !== "number" || !Number.isFinite(match.score)) continue;
        if (new TextEncoder().encode(match.id).byteLength > CDB_VECTORIZE_MAX_ID_BYTES) continue;
        const physical = parseCdbVectorizePhysicalId(match.id);
        if (!physical || seen.has(physical.vectorId)) continue;
        const head = input.readHead(physical.vectorId);
        if (
            !head ||
            head.organizationId !== input.organizationId ||
            head.resourceId !== input.resourceId ||
            head.vectorId !== physical.vectorId ||
            head.version !== physical.version ||
            head.deliveredVersion !== physical.version ||
            head.state !== "ready" ||
            cdbVectorizePhysicalId(head.vectorId, head.version) !== match.id
        ) {
            continue;
        }
        seen.add(head.vectorId);
        accepted.push(
            Object.freeze({
                vectorId: head.vectorId,
                rowPk: head.rowPk,
                score: normalizedScore(match.score),
                metadata: head.metadata,
            })
        );
    }
    return Object.freeze(accepted);
}
