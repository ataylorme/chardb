import { sha256 } from "@noble/hashes/sha2";

export type VectorProofFaultMode = "upsert_accept_then_throw" | "delete_accept_then_throw";
export type VectorProofOperation = "upsert" | "delete";
export const VECTOR_PROOF_STATE_DIAGNOSTIC_CODES = Object.freeze([
    "CDB_PROOF_VECTOR_STATE_ROUTE_FAILED",
    "CDB_PROOF_VECTOR_STATE_RPC_FAILED",
    "CDB_PROOF_VECTOR_STATE_RPC_RESULT_INVALID",
    "CDB_PROOF_VECTOR_STATE_RESPONSE_JSON_FAILED",
    "CDB_PROOF_VECTOR_STATE_INPUT_FAILED",
    "CDB_PROOF_VECTOR_STATE_FAULT_STORE_FAILED",
    "CDB_PROOF_VECTOR_STATE_HEAD_READ_FAILED",
    "CDB_PROOF_VECTOR_STATE_OUTBOX_READ_FAILED",
    "CDB_PROOF_VECTOR_STATE_OUTBOX_SCALARS_INVALID",
    "CDB_PROOF_VECTOR_STATE_OUTBOX_OPERATION_PHASE_INVALID",
    "CDB_PROOF_VECTOR_STATE_OUTBOX_PHASE_IDENTITY_INVALID",
    "CDB_PROOF_VECTOR_STATE_OUTBOX_TERMINAL_SHAPE_INVALID",
    "CDB_PROOF_VECTOR_STATE_ATTEMPTS_READ_FAILED",
    "CDB_PROOF_VECTOR_STATE_ACCEPTANCES_READ_FAILED",
    "CDB_PROOF_VECTOR_STATE_FAULT_READ_FAILED",
    "CDB_PROOF_VECTOR_STATE_MUTATION_ID_HASH_FAILED",
    "CDB_PROOF_VECTOR_STATE_CLAIM_TOKEN_HASH_FAILED",
    "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_FAILED",
    "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_INPUT_INVALID",
    "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_DIGEST_FAILED",
    "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_OUTPUT_INVALID",
    "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_HEX_INVALID",
    "CDB_PROOF_VECTOR_STATE_LEASE_IDENTITY_INVALID",
    "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_NULLISH_INVALID",
    "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TEXT_INVALID",
    "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_BLOB_INVALID",
    "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TYPE_INVALID",
    "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_INTEGER_INVALID",
    "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_RANGE_INVALID",
    "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_TYPE_INVALID",
    "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_INVALID",
    "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_VECTOR_ID_MISMATCH",
    "CDB_PROOF_VECTOR_STATE_FAULT_IDS_TYPE_INVALID",
    "CDB_PROOF_VECTOR_STATE_FAULT_IDS_JSON_INVALID",
    "CDB_PROOF_VECTOR_STATE_FAULT_IDS_SHAPE_INVALID",
    "CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID",
    "CDB_PROOF_VECTOR_STATE_LAST_ERROR_CLASSIFICATION_FAILED",
    "CDB_PROOF_VECTOR_STATE_ALARM_READ_FAILED",
    "CDB_PROOF_VECTOR_STATE_ALARM_TIMESTAMP_INVALID",
    "CDB_PROOF_VECTOR_STATE_CLOCK_FAILED",
    "CDB_PROOF_VECTOR_STATE_STATE_ASSEMBLY_FAILED",
    "CDB_PROOF_VECTOR_STATE_RESULT_WRAP_FAILED",
] as const);
export type VectorProofStateDiagnosticCode = (typeof VECTOR_PROOF_STATE_DIAGNOSTIC_CODES)[number];
export type VectorProofStateRpcResult =
    | { readonly ok: true; readonly state: unknown }
    | { readonly ok: false; readonly error: { readonly code: VectorProofStateDiagnosticCode } };

export interface VectorProofRecord {
    readonly id: string;
    readonly values: readonly number[];
    readonly namespace: string;
    readonly metadata: Readonly<Record<string, unknown>>;
}

export interface VectorProofMutationEvidence {
    readonly ids: readonly string[];
    readonly idsJson: string;
    readonly canonicalPayload: string;
}

export interface VectorProofFaultArmState {
    readonly vectorId: string;
    readonly mode: VectorProofFaultMode;
    readonly armed: boolean;
    readonly inFlight: boolean;
    readonly fired: boolean;
    readonly firstPhysicalIds: readonly string[] | null;
    readonly firstPayloadSha256: string | null;
    readonly returnedMutationIdSha256: string | null;
    readonly acceptedBeforeThrow: boolean;
    readonly retryCount: number;
    readonly retryIdsMatched: boolean | null;
    readonly retryPayloadMatched: boolean | null;
    readonly retryComplete: boolean;
    readonly gateOpen: boolean;
    readonly gateDeadline: number | null;
}

export type VectorProofFaultArmDecision = "insert" | "idempotent" | "replace";

export type VectorProofPhysicalIdParser = (value: string) => unknown | null;
export type VectorProofSqlIntegerResult =
    | { readonly ok: true; readonly value: number }
    | {
          readonly ok: false;
          readonly reason: "nullish" | "text" | "blob" | "type" | "integer" | "range";
      };
export type VectorProofTerminalFlagResult =
    | { readonly ok: true; readonly value: 0 | 1 }
    | {
          readonly ok: false;
          readonly error: {
              readonly code:
                  | "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_NULLISH_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TEXT_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_BLOB_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TYPE_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_INTEGER_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_RANGE_INVALID";
          };
      };
export type VectorProofAcceptanceIdentityResult =
    | { readonly ok: true }
    | {
          readonly ok: false;
          readonly error: {
              readonly code:
                  | "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_TYPE_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_VECTOR_ID_MISMATCH";
          };
      };
export type VectorProofPhysicalIdsResult =
    | { readonly ok: true; readonly ids: readonly string[] }
    | {
          readonly ok: false;
          readonly error: {
              readonly code:
                  | "CDB_PROOF_VECTOR_STATE_FAULT_IDS_TYPE_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_FAULT_IDS_JSON_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_FAULT_IDS_SHAPE_INVALID"
                  | "CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID";
          };
      };
export type VectorProofPhysicalIdsScopeResult =
    | {
          readonly ok: true;
          readonly ids: readonly string[];
          readonly appliesToExpectedVector: boolean;
      }
    | Extract<VectorProofPhysicalIdsResult, { readonly ok: false }>;
export type VectorProofPhysicalIdsOwnershipResult =
    | {
          readonly ok: true;
          readonly ids: readonly string[];
          readonly vectorId: string;
      }
    | Extract<VectorProofPhysicalIdsResult, { readonly ok: false }>;
export type VectorProofSha256Result =
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly reason: "input" | "digest" | "output" | "hex" };

const TEXT = new TextEncoder();
const PHYSICAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VECTOR_PROOF_STATE_DIAGNOSTIC_CODE_SET = new Set<string>(VECTOR_PROOF_STATE_DIAGNOSTIC_CODES);

function exactDataObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify([...keys].sort())) {
        throw new TypeError(`${label} fields are invalid`);
    }
    for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${label} fields are invalid`);
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

export function vectorProofStateFailure(code: VectorProofStateDiagnosticCode): VectorProofStateRpcResult {
    if (!VECTOR_PROOF_STATE_DIAGNOSTIC_CODE_SET.has(code)) {
        throw new TypeError("proof vector state diagnostic code is invalid");
    }
    return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

export function vectorProofStateSuccess(state: unknown): VectorProofStateRpcResult {
    return Object.freeze({ ok: true, state });
}

export function normalizeVectorProofSqlInteger(
    value: unknown,
    minimum: number,
    maximum: number
): VectorProofSqlIntegerResult {
    if (value === null || value === undefined) return Object.freeze({ ok: false, reason: "nullish" });
    if (typeof value === "string") return Object.freeze({ ok: false, reason: "text" });
    if (value instanceof ArrayBuffer) return Object.freeze({ ok: false, reason: "blob" });
    if (typeof value !== "number" && typeof value !== "bigint") {
        return Object.freeze({ ok: false, reason: "type" });
    }
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) return Object.freeze({ ok: false, reason: "integer" });
    if (normalized < minimum || normalized > maximum) return Object.freeze({ ok: false, reason: "range" });
    return Object.freeze({ ok: true, value: normalized });
}

export function requireVectorProofSqlInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    const result = normalizeVectorProofSqlInteger(value, minimum, maximum);
    if (!result.ok) throw new TypeError("proof SQL integer is invalid");
    return result.value;
}

export function requireNullableVectorProofSqlInteger(
    value: unknown,
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER
): number | null {
    return value === null ? null : requireVectorProofSqlInteger(value, minimum, maximum);
}

export function requireVectorProofSqlFlag(value: unknown): boolean {
    return requireVectorProofSqlInteger(value, 0, 1) === 1;
}

export function requireNullableVectorProofSqlFlag(value: unknown): boolean | null {
    return value === null ? null : requireVectorProofSqlFlag(value);
}

export function parseVectorProofTerminalFlag(value: unknown): VectorProofTerminalFlagResult {
    const result = normalizeVectorProofSqlInteger(value, 0, 1);
    if (result.ok) return Object.freeze({ ok: true, value: result.value as 0 | 1 });
    const code =
        result.reason === "nullish"
            ? "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_NULLISH_INVALID"
            : result.reason === "text"
              ? "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TEXT_INVALID"
              : result.reason === "blob"
                ? "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_BLOB_INVALID"
                : result.reason === "type"
                  ? "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TYPE_INVALID"
                  : result.reason === "integer"
                    ? "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_INTEGER_INVALID"
                    : "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_RANGE_INVALID";
    return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

export function normalizeVectorProofTerminalFlag(value: unknown): 0 | 1 {
    const result = parseVectorProofTerminalFlag(value);
    if (!result.ok) {
        throw new TypeError("proof vector terminal failure flag is invalid");
    }
    return result.value;
}

export function validateVectorProofAcceptanceIdentity(
    physicalId: unknown,
    storedVectorId: unknown,
    expectedVectorId: string,
    parsePhysicalId: VectorProofPhysicalIdParser
): VectorProofAcceptanceIdentityResult {
    if (typeof physicalId !== "string" || typeof storedVectorId !== "string") {
        return vectorProofAcceptanceIdentityFailure("CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_TYPE_INVALID");
    }
    let parsed: unknown;
    try {
        parsed = parsePhysicalId(physicalId);
    } catch {
        return vectorProofAcceptanceIdentityFailure("CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_INVALID");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return vectorProofAcceptanceIdentityFailure("CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_INVALID");
    }
    const vectorId = Object.getOwnPropertyDescriptor(parsed, "vectorId");
    if (!vectorId || !("value" in vectorId) || typeof vectorId.value !== "string") {
        return vectorProofAcceptanceIdentityFailure("CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_INVALID");
    }
    if (storedVectorId !== expectedVectorId || vectorId.value !== expectedVectorId) {
        return vectorProofAcceptanceIdentityFailure("CDB_PROOF_VECTOR_STATE_ACCEPTANCE_VECTOR_ID_MISMATCH");
    }
    return Object.freeze({ ok: true });
}

function vectorProofAcceptanceIdentityFailure(
    code: Extract<VectorProofAcceptanceIdentityResult, { readonly ok: false }>["error"]["code"]
): VectorProofAcceptanceIdentityResult {
    return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

export function parseVectorProofPhysicalIds(
    value: unknown,
    parsePhysicalId: VectorProofPhysicalIdParser
): VectorProofPhysicalIdsResult {
    if (value === null) return Object.freeze({ ok: true, ids: Object.freeze([]) });
    if (typeof value !== "string") {
        return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_IDS_TYPE_INVALID");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_IDS_JSON_INVALID");
    }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32 || new Set(parsed).size !== parsed.length) {
        return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_IDS_SHAPE_INVALID");
    }
    for (const item of parsed) {
        if (typeof item !== "string") {
            return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_IDS_SHAPE_INVALID");
        }
        try {
            if (parsePhysicalId(item) === null) {
                return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID");
            }
        } catch {
            return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID");
        }
    }
    return Object.freeze({ ok: true, ids: Object.freeze([...parsed]) });
}

export function scopeVectorProofFaultPhysicalIds(
    value: unknown,
    storedVectorId: string | null,
    requestedVectorId: string,
    parsePhysicalId: VectorProofPhysicalIdParser
): VectorProofPhysicalIdsScopeResult {
    const result = resolveVectorProofFaultPhysicalIds(value, storedVectorId, parsePhysicalId);
    if (!result.ok) return result;
    return Object.freeze({
        ok: true,
        ids: result.ids,
        appliesToExpectedVector: result.vectorId === requestedVectorId,
    });
}

export function resolveVectorProofFaultPhysicalIds(
    value: unknown,
    storedVectorId: string | null,
    parsePhysicalId: VectorProofPhysicalIdParser
): VectorProofPhysicalIdsOwnershipResult {
    const result = parseVectorProofPhysicalIds(value, parsePhysicalId);
    if (!result.ok) return result;
    let resolvedVectorId = storedVectorId;
    for (const id of result.ids) {
        let parsed: unknown;
        try {
            parsed = parsePhysicalId(id);
        } catch {
            return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID");
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID");
        }
        const descriptor = Object.getOwnPropertyDescriptor(parsed, "vectorId");
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
            return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID");
        }
        resolvedVectorId ??= descriptor.value;
        if (resolvedVectorId !== descriptor.value) {
            return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID");
        }
    }
    if (resolvedVectorId === null) {
        return vectorProofPhysicalIdsFailure("CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID");
    }
    return Object.freeze({
        ok: true,
        ids: result.ids,
        vectorId: resolvedVectorId,
    });
}

export function vectorProofFaultArmDecision(
    current: VectorProofFaultArmState | null,
    requestedVectorId: string,
    requestedMode: VectorProofFaultMode
): VectorProofFaultArmDecision {
    vectorProofFaultOperation(requestedMode);
    if (current === null) return "insert";
    vectorProofFaultOperation(current.mode);

    const pristine =
        current.vectorId === requestedVectorId &&
        current.mode === requestedMode &&
        current.armed === true &&
        current.inFlight === false &&
        current.fired === false &&
        current.firstPhysicalIds === null &&
        current.firstPayloadSha256 === null &&
        current.returnedMutationIdSha256 === null &&
        current.acceptedBeforeThrow === false &&
        current.retryCount === 0 &&
        current.retryIdsMatched === null &&
        current.retryPayloadMatched === null &&
        current.retryComplete === false &&
        current.gateOpen === false &&
        current.gateDeadline === null;
    if (pristine) return "idempotent";

    const complete =
        current.armed === false &&
        current.inFlight === false &&
        current.fired === true &&
        current.firstPhysicalIds !== null &&
        current.firstPhysicalIds.length > 0 &&
        current.firstPayloadSha256 !== null &&
        current.returnedMutationIdSha256 !== null &&
        current.acceptedBeforeThrow === true &&
        current.retryCount >= 1 &&
        current.retryCount <= 64 &&
        current.retryIdsMatched === true &&
        current.retryPayloadMatched === true &&
        current.retryComplete === true &&
        current.gateOpen === false &&
        current.gateDeadline === null;
    if (complete) return "replace";

    throw new TypeError("proof vector fault cannot be re-armed before its evidence is complete");
}

function vectorProofPhysicalIdsFailure(
    code: Extract<VectorProofPhysicalIdsResult, { readonly ok: false }>["error"]["code"]
): Extract<VectorProofPhysicalIdsResult, { readonly ok: false }> {
    return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

export function parseVectorProofStateRpcResult(value: unknown): VectorProofStateRpcResult {
    const result = exactDataObject(
        value,
        ["ok", value && typeof value === "object" && "state" in value ? "state" : "error"],
        "proof vector state RPC result"
    );
    if (result.ok === true) return vectorProofStateSuccess(result.state);
    if (result.ok !== false) throw new TypeError("proof vector state RPC result outcome is invalid");
    const error = exactDataObject(result.error, ["code"], "proof vector state RPC error");
    return vectorProofStateFailure(error.code as VectorProofStateDiagnosticCode);
}

function canonicalize(value: unknown, depth = 0): unknown {
    if (depth > 8) throw new TypeError("proof mutation payload nesting is too deep");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("proof mutation payload numbers must be finite");
        return value;
    }
    if (Array.isArray(value)) return value.map(item => canonicalize(item, depth + 1));
    if (typeof value !== "object") throw new TypeError("proof mutation payload is not canonical JSON");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError("proof mutation payload fields must be enumerable data properties");
        }
        output[key] = canonicalize(descriptor.value, depth + 1);
    }
    return output;
}

function exactIds(values: readonly string[], parsePhysicalId: VectorProofPhysicalIdParser): readonly string[] {
    if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length > 32 ||
        new Set(values).size !== values.length ||
        values.some(value => {
            if (typeof value !== "string" || !PHYSICAL_ID.test(value)) return true;
            try {
                return parsePhysicalId(value) === null;
            } catch {
                return true;
            }
        })
    ) {
        throw new TypeError("proof mutation physical ids are invalid");
    }
    return Object.freeze([...values]);
}

export function vectorProofMutationEvidence(
    operation: VectorProofOperation,
    input: readonly VectorProofRecord[] | readonly string[],
    parsePhysicalId: VectorProofPhysicalIdParser
): VectorProofMutationEvidence {
    let ids: readonly string[];
    let canonicalPayload: string;
    if (operation === "upsert") {
        if (!Array.isArray(input) || input.length < 1 || input.length > 32) {
            throw new TypeError("proof upsert records are invalid");
        }
        const records = input as readonly VectorProofRecord[];
        ids = exactIds(
            records.map(record => record.id),
            parsePhysicalId
        );
        canonicalPayload = JSON.stringify(
            canonicalize({
                operation,
                records: records.map(record => ({
                    id: record.id,
                    metadata: record.metadata,
                    namespace: record.namespace,
                    values: [...record.values],
                })),
            })
        );
    } else {
        ids = exactIds(input as readonly string[], parsePhysicalId);
        canonicalPayload = JSON.stringify(canonicalize({ ids, operation }));
    }
    if (TEXT.encode(canonicalPayload).byteLength > 64 * 1_024) {
        throw new TypeError("proof mutation canonical payload exceeds 65536 UTF-8 bytes");
    }
    return Object.freeze({ ids, idsJson: JSON.stringify(ids), canonicalPayload });
}

function vectorProofLowercaseHex(value: Uint8Array): string {
    return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function vectorProofSha256Result(
    value: unknown,
    digestFunction: (input: Uint8Array) => unknown = sha256,
    hexFunction: (input: Uint8Array) => unknown = vectorProofLowercaseHex
): VectorProofSha256Result {
    let encoded: Uint8Array;
    try {
        if (typeof value !== "string") return Object.freeze({ ok: false, reason: "input" });
        encoded = TEXT.encode(value);
        if (encoded.byteLength > 64 * 1_024) return Object.freeze({ ok: false, reason: "input" });
    } catch {
        return Object.freeze({ ok: false, reason: "input" });
    }
    let digest: unknown;
    try {
        digest = digestFunction(encoded);
    } catch {
        return Object.freeze({ ok: false, reason: "digest" });
    }
    if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
        return Object.freeze({ ok: false, reason: "output" });
    }
    try {
        const hex = hexFunction(digest);
        return typeof hex === "string" && /^[a-f0-9]{64}$/.test(hex)
            ? Object.freeze({ ok: true, value: hex })
            : Object.freeze({ ok: false, reason: "hex" });
    } catch {
        return Object.freeze({ ok: false, reason: "hex" });
    }
}

export async function vectorProofSha256(value: unknown): Promise<string> {
    const result = vectorProofSha256Result(value);
    if (!result.ok) {
        throw new TypeError(result.reason === "input" ? "proof hash input is invalid" : "proof hash output is invalid");
    }
    return result.value;
}

export async function vectorProofMutationIdHash(receipt: unknown): Promise<string | null> {
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(receipt, "mutationId");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
    if (descriptor.value.length === 0 || TEXT.encode(descriptor.value).byteLength > 128) return null;
    return vectorProofSha256(descriptor.value);
}

export function assertVectorProofSearchAuditSequence(
    afterSequence: number,
    latestSequence: number,
    observedSequence: number
): number {
    if (
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        !Number.isSafeInteger(latestSequence) ||
        !Number.isSafeInteger(observedSequence) ||
        latestSequence !== afterSequence + 1 ||
        observedSequence !== latestSequence
    ) {
        throw new TypeError("proof Vectorize search audit did not correlate one exact provider invocation");
    }
    return observedSequence;
}

export function vectorProofFaultOperation(mode: VectorProofFaultMode): VectorProofOperation {
    if (mode === "upsert_accept_then_throw") return "upsert";
    if (mode === "delete_accept_then_throw") return "delete";
    throw new TypeError("proof vector fault mode is invalid");
}
