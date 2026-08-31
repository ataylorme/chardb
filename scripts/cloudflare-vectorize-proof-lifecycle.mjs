export const CLOUDFLARE_VECTORIZE_PROOF_HTTP_MAX_BYTES = 1024 * 1024;
export const CLOUDFLARE_VECTORIZE_PROOF_HTTP_TIMEOUT_MS = 15_000;
export const CLOUDFLARE_VECTORIZE_PROOF_POLL_INTERVAL_MS = 250;

const CLOUDFLARE_VECTORIZE_PROOF_MIGRATION_RETRY_TIMEOUT_MS = 120_000;
const CLOUDFLARE_VECTORIZE_PROOF_MIGRATION_MAX_ATTEMPTS = 4;

const TEXT = new TextEncoder();
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VECTOR_ID = /^vec1_[a-f0-9]{64}$/;
const RESOURCE_ID = /^vr1_[a-f0-9]{64}$/;
const PHYSICAL_ID = /^p1_([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])_([1-9a-z][0-9a-z]*)$/;
const RESPONSE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VECTOR_STATE_DIAGNOSTIC_PREFIX = "CDB_PROOF_VECTOR_STATE_";
const TRANSIENT_VECTOR_STATE_DIAGNOSTIC_CODES = new Set([
    "CDB_PROOF_VECTOR_STATE_ROUTE_FAILED",
    "CDB_PROOF_VECTOR_STATE_RPC_FAILED",
]);
const VECTOR_PHASE_PROGRESSION_MAX = 64;
const HTTP_FAILURE_KINDS = new Set(["timeout", "network", "http", "protocol"]);
export const CLOUDFLARE_VECTORIZE_PROOF_HTTP_PROTOCOL_REASONS = Object.freeze([
    "invalid_response",
    "unexpected_redirect",
    "invalid_content_length",
    "empty_body",
    "body_too_large",
    "invalid_utf8",
    "invalid_json",
]);
const HTTP_PROTOCOL_REASONS = new Set(CLOUDFLARE_VECTORIZE_PROOF_HTTP_PROTOCOL_REASONS);
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX = "0123456789abcdef";

export class CloudflareVectorizeProofHttpError extends Error {
    constructor(
        message,
        status = null,
        code = null,
        kind = status === null ? "network" : "http",
        protocolReason = null
    ) {
        super(message);
        if (!HTTP_FAILURE_KINDS.has(kind))
            throw new TypeError("Cloudflare Vectorize proof HTTP failure kind is invalid");
        if (protocolReason !== null && !HTTP_PROTOCOL_REASONS.has(protocolReason))
            throw new TypeError("Cloudflare Vectorize proof HTTP protocol reason is invalid");
        if (protocolReason !== null && kind !== "http" && kind !== "protocol")
            throw new TypeError("Cloudflare Vectorize proof HTTP protocol reason is inconsistent");
        this.name = "CloudflareVectorizeProofHttpError";
        this.status = status;
        this.code = code;
        this.kind = kind;
        this.protocolReason = protocolReason;
    }
}

class CloudflareVectorizeProofProtocolError extends Error {
    constructor(message, reason) {
        super(message);
        if (!HTTP_PROTOCOL_REASONS.has(reason))
            throw new TypeError("Cloudflare Vectorize proof HTTP protocol reason is invalid");
        this.reason = reason;
    }
}

export class CloudflareVectorizeProofSettlementError extends Error {
    constructor(message, evidence) {
        super(message);
        this.name = "CloudflareVectorizeProofSettlementError";
        this.evidence = assertCloudflareVectorizeProofSettlementEvidence(evidence);
    }
}

export function isCloudflareVectorizeProofRetryableStateRead(error) {
    if (!(error instanceof CloudflareVectorizeProofHttpError)) return false;
    if (error.kind === "timeout") return true;
    if (error.kind !== "http" || !Number.isInteger(error.status) || error.status < 500 || error.status > 599) {
        return false;
    }
    if (typeof error.code !== "string" || !error.code.startsWith(VECTOR_STATE_DIAGNOSTIC_PREFIX)) return true;
    return TRANSIENT_VECTOR_STATE_DIAGNOSTIC_CODES.has(error.code);
}

function check(condition, message, ErrorType = Error) {
    if (!condition) throw new ErrorType(message);
}

function object(value, label) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    return value;
}

function text(value, label, maximum = 256) {
    check(
        typeof value === "string" && value.length > 0 && TEXT.encode(value).byteLength <= maximum,
        `${label} is invalid`
    );
    return value;
}

function identity(value, label) {
    check(typeof value === "string" && IDENTITY.test(value), `${label} is invalid`, TypeError);
    return value;
}

function organizationId(value, label = "organization id") {
    check(typeof value === "string" && ORGANIZATION_ID.test(value), `${label} is invalid`, TypeError);
    return value;
}

function vectorId(value) {
    check(typeof value === "string" && VECTOR_ID.test(value), "vector id is invalid", TypeError);
    return value;
}

function parseBase36SafeInteger(value) {
    let result = 0;
    for (const character of value) {
        const digit = Number.parseInt(character, 36);
        if (!Number.isSafeInteger(digit) || digit < 0 || digit >= 36) return null;
        if (result > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 36)) return null;
        result = result * 36 + digit;
    }
    return result >= 1 && result.toString(36) === value ? result : null;
}

function vectorIdFromWireDigest(value) {
    let accumulator = 0;
    let bits = 0;
    const bytes = [];
    for (const character of value) {
        const digit = BASE64URL.indexOf(character);
        if (digit < 0) return null;
        accumulator = (accumulator << 6) | digit;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((accumulator >>> bits) & 0xff);
            accumulator &= (1 << bits) - 1;
        }
    }
    if (bytes.length !== 32 || bits !== 2 || accumulator !== 0) return null;
    let digest = "";
    for (const byte of bytes) digest += `${HEX[byte >>> 4]}${HEX[byte & 0x0f]}`;
    return `vec1_${digest}`;
}

function physicalId(value, label = "Vectorize physical id") {
    check(typeof value === "string", `${label} is invalid`);
    const match = PHYSICAL_ID.exec(value);
    const version = match ? parseBase36SafeInteger(match[2]) : null;
    const logicalVectorId = match ? vectorIdFromWireDigest(match[1]) : null;
    check(match !== null && version !== null && logicalVectorId !== null, `${label} is invalid`);
    return Object.freeze({ id: value, vectorId: logicalVectorId, version });
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
    check(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} is invalid`, TypeError);
    return value;
}

function normalizeOrigin(value) {
    const origin = value instanceof URL ? new URL(value.href) : new URL(value);
    check(origin.username === "" && origin.password === "", "proof origin must not contain credentials", TypeError);
    check(
        origin.pathname === "/" && origin.search === "" && origin.hash === "",
        "proof origin must be an origin",
        TypeError
    );
    check(
        origin.protocol === "https:" ||
            (origin.protocol === "http:" && (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")),
        "proof origin must use HTTPS, except for localhost",
        TypeError
    );
    return origin;
}

function freeze(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(freeze));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        for (const item of Object.values(value)) freeze(item);
        return Object.freeze(value);
    }
    return value;
}

function exactFields(value, label, keys) {
    const input = object(value, label);
    check(
        JSON.stringify(Object.keys(input).sort()) === JSON.stringify([...keys].sort()),
        `${label} fields are invalid`
    );
    return input;
}

function nonnegativeFinite(value, label) {
    check(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} is invalid`);
    return value;
}

function responseCode(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const nested = value.error;
    const candidate =
        value.code ??
        (nested !== null && typeof nested === "object" && !Array.isArray(nested) ? nested.code : undefined);
    if (typeof candidate === "string" && RESPONSE_CODE.test(candidate)) return candidate;
    if (Number.isSafeInteger(candidate) && candidate >= 0) return String(candidate);
    return null;
}

async function boundedJson(response, maximum, label, signal) {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
        const bytes = Number(declared);
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new CloudflareVectorizeProofProtocolError(
                `${label} has an invalid content length`,
                "invalid_content_length"
            );
        }
        if (bytes > maximum) {
            throw new CloudflareVectorizeProofProtocolError(`${label} exceeded ${maximum} bytes`, "body_too_large");
        }
    }
    if (response.body === null)
        throw new CloudflareVectorizeProofProtocolError(`${label} returned an empty body`, "empty_body");
    const reader = response.body.getReader();
    const cancelReader = () => {
        void reader.cancel().catch(() => undefined);
    };
    if (signal?.aborted) cancelReader();
    signal?.addEventListener("abort", cancelReader, { once: true });
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > maximum) {
                await reader.cancel();
                throw new CloudflareVectorizeProofProtocolError(`${label} exceeded ${maximum} bytes`, "body_too_large");
            }
            chunks.push(next.value);
        }
    } finally {
        signal?.removeEventListener("abort", cancelReader);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let source;
    try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new CloudflareVectorizeProofProtocolError(`${label} returned invalid UTF-8`, "invalid_utf8");
    }
    try {
        return JSON.parse(source);
    } catch {
        throw new CloudflareVectorizeProofProtocolError(`${label} returned invalid JSON`, "invalid_json");
    }
}

function setCookies(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")];
    return values.filter(Boolean).map(value => value.split(";", 1)[0]);
}

function mergeCookies(current, headers) {
    const cookies = new Map();
    for (const value of [current, ...setCookies(headers)]) {
        for (const cookie of String(value ?? "").split(/;\s*/)) {
            const separator = cookie.indexOf("=");
            if (separator > 0) cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
        }
    }
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function principal(value, label = "principal") {
    const input = object(value, label);
    return Object.freeze({
        cookie: text(input.cookie, `${label} cookie`, 16_384),
        token: text(input.token, `${label} token`, 16_384),
        userId: identity(input.userId, `${label} user id`),
    });
}

function proofHeaders(admin) {
    const value = object(admin, "proof authorization");
    return {
        authorization: `Bearer ${text(value.token, "proof admin token", 512)}`,
        "x-chardb-proof-run-id": identity(value.runId, "proof run id"),
    };
}

function parseMigrationState(value) {
    const state = object(value, "migration state");
    check(Number.isSafeInteger(state.activeVersion) && state.activeVersion >= 0, "migration active version is invalid");
    positiveInteger(state.activeEpoch, "migration active epoch");
    check(state.status === "active" || state.status === "migrating", "migration status is invalid");
    check(
        state.migrationId === null || (typeof state.migrationId === "string" && IDENTITY.test(state.migrationId)),
        "migration id is invalid"
    );
    check(
        state.targetVersion === null ||
            (Number.isSafeInteger(state.targetVersion) && state.targetVersion > state.activeVersion),
        "migration target is invalid"
    );
    if (state.status === "active")
        check(state.migrationId === null && state.targetVersion === null, "active migration state is inconsistent");
    if (state.status === "migrating")
        check(state.migrationId !== null && state.targetVersion !== null, "pending migration state is inconsistent");
    return state;
}

function parseVectorState(value, expectedVectorId) {
    const state = object(value, "vector state");
    check(state.vectorId === expectedVectorId, "vector state identity drifted");
    check(Number.isSafeInteger(state.observedAt) && state.observedAt >= 0, "vector observation time is invalid");
    check(
        state.scheduledAlarmAt === null ||
            (Number.isSafeInteger(state.scheduledAlarmAt) && state.scheduledAlarmAt >= 0),
        "vector scheduled alarm time is invalid"
    );
    if (state.head !== null) {
        const head = object(state.head, "vector head");
        organizationId(head.organizationId, "vector head organization id");
        check(
            typeof head.resourceId === "string" && RESOURCE_ID.test(head.resourceId),
            "vector head resource id is invalid"
        );
        text(head.rowPk, "vector head row key", 512);
        positiveInteger(head.version, "vector head version");
        check(
            Number.isSafeInteger(head.deliveredVersion) && head.deliveredVersion >= 0,
            "delivered version is invalid"
        );
        check(
            head.state === "pending" || head.state === "ready" || head.state === "deleting",
            "vector head state is invalid"
        );
    }
    if (state.outbox !== null) {
        const outbox = object(state.outbox, "vector outbox");
        check(outbox.phase === "submit" || outbox.phase === "verify", "vector outbox phase is invalid");
        check(outbox.operation === "upsert" || outbox.operation === "delete", "vector outbox operation is invalid");
        positiveInteger(outbox.targetVersion, "vector outbox target version");
        check(Number.isSafeInteger(outbox.attempts) && outbox.attempts >= 0, "vector outbox attempts are invalid");
        check(
            Number.isSafeInteger(outbox.nextAttemptAt) && outbox.nextAttemptAt >= 0,
            "vector outbox retry time is invalid"
        );
        check(
            outbox.acceptedAt === null || (Number.isSafeInteger(outbox.acceptedAt) && outbox.acceptedAt >= 0),
            "vector acceptance time is invalid"
        );
        if (outbox.mutationIdSha256 !== null)
            check(SHA256.test(outbox.mutationIdSha256), "mutation receipt hash is invalid");
        if (outbox.claimTokenSha256 !== null)
            check(SHA256.test(outbox.claimTokenSha256), "vector claim hash is invalid");
        check(
            outbox.leasedUntil === null || (Number.isSafeInteger(outbox.leasedUntil) && outbox.leasedUntil > 0),
            "vector lease deadline is invalid"
        );
        const hasClaimIdentity = outbox.claimTokenSha256 !== null;
        const hasLeaseDeadline = outbox.leasedUntil !== null;
        check(
            hasClaimIdentity === hasLeaseDeadline && (outbox.leased !== true || hasClaimIdentity),
            "vector lease identity is inconsistent"
        );
        check(typeof outbox.terminalFailure === "boolean", "vector terminal failure state is invalid");
        check(
            outbox.lastErrorClassification === null ||
                outbox.lastErrorClassification === "delete_absence_unproven" ||
                outbox.lastErrorClassification === "other",
            "vector last error classification is invalid"
        );
        check(
            outbox.lastErrorSha256 === null || SHA256.test(outbox.lastErrorSha256),
            "vector last error hash is invalid"
        );
        check(
            (outbox.lastErrorClassification === null) === (outbox.lastErrorSha256 === null),
            "vector last error evidence is inconsistent"
        );
        if (outbox.terminalFailure) {
            check(
                outbox.operation === "delete" &&
                    outbox.leased === false &&
                    outbox.claimTokenSha256 === null &&
                    outbox.leasedUntil === null &&
                    outbox.lastErrorClassification === "delete_absence_unproven",
                "terminally failed vector outbox is inconsistent"
            );
        }
    }
    check(Array.isArray(state.attempts) && state.attempts.length <= 16, "vector attempts are invalid");
    for (const [index, value] of state.attempts.entries()) {
        const attempt = object(value, `vector attempt ${index}`);
        positiveInteger(attempt.physicalVersion, `vector attempt ${index} physical version`);
        for (const field of ["firstSentAt", "settleAfter"]) {
            check(
                Number.isSafeInteger(attempt[field]) && attempt[field] >= 0,
                `vector attempt ${index} ${field} is invalid`
            );
        }
        for (const field of ["visibilityConfirmed", "responseAmbiguous", "deleteConfirmed"]) {
            check(typeof attempt[field] === "boolean", `vector attempt ${index} ${field} is invalid`);
        }
    }
    check(Array.isArray(state.acceptances) && state.acceptances.length <= 32, "vector acceptance audit is invalid");
    const acceptanceKeys = new Set();
    for (const [index, value] of state.acceptances.entries()) {
        const acceptance = object(value, `vector acceptance ${index}`);
        check(
            acceptance.operation === "upsert" || acceptance.operation === "delete",
            `vector acceptance ${index} operation is invalid`
        );
        const parsed = physicalId(acceptance.physicalId, `vector acceptance ${index} physical id`);
        check(parsed.vectorId === expectedVectorId, `vector acceptance ${index} changed logical ownership`);
        check(SHA256.test(acceptance.payloadSha256), `vector acceptance ${index} payload hash is invalid`);
        check(SHA256.test(acceptance.mutationIdSha256), `vector acceptance ${index} mutation hash is invalid`);
        check(
            Number.isSafeInteger(acceptance.acceptedAt) && acceptance.acceptedAt >= 0,
            `vector acceptance ${index} time is invalid`
        );
        const key = `${acceptance.operation}:${acceptance.physicalId}`;
        check(!acceptanceKeys.has(key), "vector acceptance audit contains a duplicate");
        acceptanceKeys.add(key);
    }
    if (state.fault !== null) {
        const fault = object(state.fault, "vector fault");
        check(
            fault.mode === "upsert_accept_then_throw" || fault.mode === "delete_accept_then_throw",
            "vector fault mode is invalid"
        );
        for (const field of ["armed", "inFlight", "fired", "acceptedBeforeThrow", "retryComplete", "gateOpen"]) {
            check(typeof fault[field] === "boolean", `vector fault ${field} is invalid`);
        }
        check(
            fault.gateDeadline === null || (Number.isSafeInteger(fault.gateDeadline) && fault.gateDeadline > 0),
            "vector fault gate deadline is invalid"
        );
        check(Array.isArray(fault.firstPhysicalIds), "vector fault physical ids are invalid");
        for (const [index, value] of fault.firstPhysicalIds.entries()) {
            const parsed = physicalId(value, `vector fault physical id ${index}`);
            check(parsed.vectorId === expectedVectorId, `vector fault physical id ${index} changed logical ownership`);
        }
        for (const field of ["firstPayloadSha256", "returnedMutationIdSha256"]) {
            check(fault[field] === null || SHA256.test(fault[field]), `vector fault ${field} is invalid`);
        }
        check(Number.isSafeInteger(fault.retryCount) && fault.retryCount >= 0, "vector fault retry count is invalid");
        for (const field of ["retryIdsMatched", "retryPayloadMatched"]) {
            check(fault[field] === null || typeof fault[field] === "boolean", `vector fault ${field} is invalid`);
        }
        check(Number.isSafeInteger(fault.updatedAt) && fault.updatedAt >= 0, "vector fault update time is invalid");
    }
    return freeze({
        vectorId: expectedVectorId,
        observedAt: state.observedAt,
        scheduledAlarmAt: state.scheduledAlarmAt,
        head:
            state.head === null
                ? null
                : {
                      organizationId: state.head.organizationId,
                      resourceId: state.head.resourceId,
                      rowPk: state.head.rowPk,
                      version: state.head.version,
                      deliveredVersion: state.head.deliveredVersion,
                      state: state.head.state,
                  },
        outbox:
            state.outbox === null
                ? null
                : {
                      targetVersion: state.outbox.targetVersion,
                      operation: state.outbox.operation,
                      phase: state.outbox.phase,
                      mutationIdSha256: state.outbox.mutationIdSha256,
                      acceptedAt: state.outbox.acceptedAt,
                      attempts: state.outbox.attempts,
                      nextAttemptAt: state.outbox.nextAttemptAt,
                      leased: state.outbox.leased,
                      claimTokenSha256: state.outbox.claimTokenSha256,
                      leasedUntil: state.outbox.leasedUntil,
                      terminalFailure: state.outbox.terminalFailure,
                      lastErrorClassification: state.outbox.lastErrorClassification,
                      lastErrorSha256: state.outbox.lastErrorSha256,
                  },
        attempts: state.attempts.map(attempt => ({
            physicalVersion: attempt.physicalVersion,
            firstSentAt: attempt.firstSentAt,
            settleAfter: attempt.settleAfter,
            visibilityConfirmed: attempt.visibilityConfirmed,
            responseAmbiguous: attempt.responseAmbiguous,
            deleteConfirmed: attempt.deleteConfirmed,
        })),
        acceptances: state.acceptances.map(acceptance => ({
            operation: acceptance.operation,
            physicalId: acceptance.physicalId,
            payloadSha256: acceptance.payloadSha256,
            mutationIdSha256: acceptance.mutationIdSha256,
            acceptedAt: acceptance.acceptedAt,
        })),
        fault:
            state.fault === null
                ? null
                : {
                      mode: state.fault.mode,
                      armed: state.fault.armed,
                      inFlight: state.fault.inFlight,
                      fired: state.fault.fired,
                      firstPhysicalIds: [...state.fault.firstPhysicalIds],
                      firstPayloadSha256: state.fault.firstPayloadSha256,
                      returnedMutationIdSha256: state.fault.returnedMutationIdSha256,
                      acceptedBeforeThrow: state.fault.acceptedBeforeThrow,
                      retryCount: state.fault.retryCount,
                      retryIdsMatched: state.fault.retryIdsMatched,
                      retryPayloadMatched: state.fault.retryPayloadMatched,
                      retryComplete: state.fault.retryComplete,
                      gateOpen: state.fault.gateOpen,
                      gateDeadline: state.fault.gateDeadline,
                      updatedAt: state.fault.updatedAt,
                  },
    });
}

export function assertCloudflareVectorizeProofState(value) {
    const state = object(value, "vector state");
    return parseVectorState(state, vectorId(state.vectorId));
}

export function assertCloudflareVectorizeProofSettlementEvidence(value) {
    const input = object(value, "Vectorize settlement evidence");
    if (input.checkpoint === "owning-filtered-search" || input.checkpoint === "isolated-filtered-search") {
        exactFields(input, "Vectorize search settlement evidence", [
            "checkpoint",
            "timeoutMs",
            "elapsedMs",
            "queryVisibilityAttempts",
            "queryStabilityWindowMs",
            "queryStabilityObservedMs",
            "queryStabilityExactMatchCount",
            "queryStabilityResetCount",
            "queryStabilityNonExactCount",
            "transientHttpFailureCount",
            "transientHttpFailureCounts",
            "transientHttpFailureOverflowCount",
            "hardBoundClaimed",
        ]);
        positiveInteger(input.timeoutMs, "Vectorize search settlement timeout");
        nonnegativeFinite(input.elapsedMs, "Vectorize search settlement elapsed time");
        positiveInteger(input.queryVisibilityAttempts, "Vectorize search settlement attempt count");
        for (const field of [
            "queryStabilityWindowMs",
            "queryStabilityObservedMs",
            "queryStabilityExactMatchCount",
            "queryStabilityResetCount",
            "queryStabilityNonExactCount",
            "transientHttpFailureCount",
            "transientHttpFailureOverflowCount",
        ]) {
            check(Number.isSafeInteger(input[field]) && input[field] >= 0, `Vectorize settlement ${field} is invalid`);
        }
        check(
            Array.isArray(input.transientHttpFailureCounts) && input.transientHttpFailureCounts.length <= 16,
            "Vectorize settlement transient failures are invalid"
        );
        let accounted = input.transientHttpFailureOverflowCount;
        const seen = new Set();
        const transientHttpFailureCounts = input.transientHttpFailureCounts.map((value, index) => {
            const failure = exactFields(value, `Vectorize settlement transient failure ${index}`, [
                "status",
                "code",
                "count",
            ]);
            check(
                failure.status === null ||
                    (Number.isSafeInteger(failure.status) && failure.status >= 500 && failure.status <= 599),
                "Vectorize settlement transient status is invalid"
            );
            check(
                (failure.status === null && failure.code === null) ||
                    (failure.status !== null && (failure.code === null || RESPONSE_CODE.test(failure.code))),
                "Vectorize settlement transient code is invalid"
            );
            positiveInteger(failure.count, "Vectorize settlement transient count");
            const key = `${failure.status}:${String(failure.code)}`;
            check(!seen.has(key), "Vectorize settlement transient failures contain duplicates");
            seen.add(key);
            accounted += failure.count;
            return { status: failure.status, code: failure.code, count: failure.count };
        });
        check(
            accounted === input.transientHttpFailureCount,
            "Vectorize settlement transient failure accounting drifted"
        );
        check(input.hardBoundClaimed === false, "Vectorize settlement cannot claim a hard bound");
        return freeze({
            checkpoint: input.checkpoint,
            timeoutMs: input.timeoutMs,
            elapsedMs: input.elapsedMs,
            queryVisibilityAttempts: input.queryVisibilityAttempts,
            queryStabilityWindowMs: input.queryStabilityWindowMs,
            queryStabilityObservedMs: input.queryStabilityObservedMs,
            queryStabilityExactMatchCount: input.queryStabilityExactMatchCount,
            queryStabilityResetCount: input.queryStabilityResetCount,
            queryStabilityNonExactCount: input.queryStabilityNonExactCount,
            transientHttpFailureCount: input.transientHttpFailureCount,
            transientHttpFailureCounts,
            transientHttpFailureOverflowCount: input.transientHttpFailureOverflowCount,
            hardBoundClaimed: false,
        });
    }

    exactFields(input, "Vectorize lifecycle settlement evidence", [
        "checkpoint",
        "outcome",
        "timeoutMs",
        "elapsedMs",
        "pollAttempts",
        "phaseProgression",
        "phaseProgressionOverflowCount",
        "latestState",
        "transientHttpFailureCount",
        "transientHttpFailureCounts",
        "transientHttpFailureOverflowCount",
        "hardBoundClaimed",
    ]);
    check(
        input.checkpoint === "vector-ready" || input.checkpoint === "vector-deleted",
        "Vectorize lifecycle settlement checkpoint is invalid"
    );
    check(
        input.outcome === "timed_out" || input.outcome === "failed_unproven",
        "Vectorize lifecycle settlement outcome is invalid"
    );
    check(
        input.outcome !== "failed_unproven" || input.checkpoint === "vector-deleted",
        "only vector deletion can fail unproven"
    );
    positiveInteger(input.timeoutMs, "Vectorize lifecycle settlement timeout");
    nonnegativeFinite(input.elapsedMs, "Vectorize lifecycle settlement elapsed time");
    positiveInteger(input.pollAttempts, "Vectorize lifecycle settlement attempt count");
    check(
        Array.isArray(input.phaseProgression) && input.phaseProgression.length <= VECTOR_PHASE_PROGRESSION_MAX,
        "Vectorize lifecycle phase progression is invalid"
    );
    const phaseProgression = input.phaseProgression.map(phase => {
        check(phase === "submit" || phase === "verify", "Vectorize lifecycle phase is invalid");
        return phase;
    });
    check(
        Number.isSafeInteger(input.phaseProgressionOverflowCount) && input.phaseProgressionOverflowCount >= 0,
        "Vectorize lifecycle phase overflow count is invalid"
    );
    const latestInput =
        input.latestState === null ? null : object(input.latestState, "Vectorize lifecycle latest state");
    const latestState = latestInput === null ? null : parseVectorState(latestInput, vectorId(latestInput.vectorId));
    check(
        Number.isSafeInteger(input.transientHttpFailureCount) && input.transientHttpFailureCount >= 0,
        "Vectorize lifecycle transient failure count is invalid"
    );
    check(
        Number.isSafeInteger(input.transientHttpFailureOverflowCount) && input.transientHttpFailureOverflowCount >= 0,
        "Vectorize lifecycle transient failure overflow count is invalid"
    );
    check(
        Array.isArray(input.transientHttpFailureCounts) && input.transientHttpFailureCounts.length <= 16,
        "Vectorize lifecycle transient failures are invalid"
    );
    let transientAccounted = input.transientHttpFailureOverflowCount;
    const transientSeen = new Set();
    const transientHttpFailureCounts = input.transientHttpFailureCounts.map((value, index) => {
        const failure = exactFields(value, `Vectorize lifecycle transient failure ${index}`, [
            "status",
            "code",
            "count",
        ]);
        check(
            failure.status === null ||
                (Number.isSafeInteger(failure.status) && failure.status >= 500 && failure.status <= 599),
            "Vectorize lifecycle transient status is invalid"
        );
        check(
            (failure.status === null && failure.code === null) ||
                (failure.status !== null && (failure.code === null || RESPONSE_CODE.test(failure.code))),
            "Vectorize lifecycle transient code is invalid"
        );
        positiveInteger(failure.count, "Vectorize lifecycle transient count");
        const key = `${String(failure.status)}:${String(failure.code)}`;
        check(!transientSeen.has(key), "Vectorize lifecycle transient failures contain duplicates");
        transientSeen.add(key);
        transientAccounted += failure.count;
        return { status: failure.status, code: failure.code, count: failure.count };
    });
    check(
        transientAccounted === input.transientHttpFailureCount,
        "Vectorize lifecycle transient failure accounting drifted"
    );
    if (input.outcome === "failed_unproven") {
        check(
            latestState?.outbox?.terminalFailure === true &&
                latestState.outbox.lastErrorClassification === "delete_absence_unproven",
            "failed-unproven settlement lacks terminal deletion evidence"
        );
    }
    check(input.hardBoundClaimed === false, "Vectorize lifecycle settlement cannot claim a hard bound");
    return freeze({
        checkpoint: input.checkpoint,
        outcome: input.outcome,
        timeoutMs: input.timeoutMs,
        elapsedMs: input.elapsedMs,
        pollAttempts: input.pollAttempts,
        phaseProgression,
        phaseProgressionOverflowCount: input.phaseProgressionOverflowCount,
        latestState,
        transientHttpFailureCount: input.transientHttpFailureCount,
        transientHttpFailureCounts,
        transientHttpFailureOverflowCount: input.transientHttpFailureOverflowCount,
        hardBoundClaimed: false,
    });
}

function searchMatches(value, label) {
    check(Array.isArray(value), `${label} failed`);
    return value.map((match, index) => {
        const item = object(match, `${label} match ${index}`);
        check(
            JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["rowPk", "score"]),
            `${label} match fields are invalid`
        );
        const score = Number(item.score);
        check(Number.isFinite(score), `${label} match score is invalid`);
        return Object.freeze({
            rowPk: text(item.rowPk, `${label} row key`, 512),
            score,
        });
    });
}

export function vectorProofMutationIds(runId) {
    const base = identity(runId, "mutation run id");
    return Object.freeze({
        create: `vector-create:${base}`,
        replace: `vector-replace:${base}`,
        delete: `vector-delete:${base}`,
        liveCreate: `vector-live-create:${base}`,
        liveReplace: `vector-live-replace:${base}`,
        liveDelete: `vector-live-delete:${base}`,
    });
}

export function assertSecretFreeVectorEvidence(value, secrets = []) {
    const visit = (item, path = "evidence") => {
        if (Array.isArray(item)) return item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
        if (!item || typeof item !== "object") return;
        for (const [key, entry] of Object.entries(item)) {
            check(
                /sha256$/i.test(key) || !/(cookie|token|jwt|mutation.?id|authorization|secret|session)/i.test(key),
                `${path}.${key} contains a secret field`
            );
            visit(entry, `${path}.${key}`);
        }
    };
    visit(value);
    const serialized = JSON.stringify(value);
    for (const secret of secrets) {
        if (typeof secret === "string" && secret.length > 0)
            check(!serialized.includes(secret), "evidence contains a supplied secret");
    }
    check(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(serialized), "evidence contains a JWT-shaped value");
    return value;
}

function faultEvidence(state, operation) {
    const vectorState = object(state, `${operation} state`);
    const expectedVectorId = vectorId(vectorState.vectorId);
    const fault = object(vectorState.fault, `${operation} fault`);
    const expectedMode = operation === "upsert" ? "upsert_accept_then_throw" : "delete_accept_then_throw";
    check(fault.mode === expectedMode, `${operation} fault mode drifted`);
    check(fault.acceptedBeforeThrow === true, `${operation} was not accepted before response loss`);
    check(
        fault.retryComplete === true && Number.isSafeInteger(fault.retryCount) && fault.retryCount > 0,
        `${operation} retry did not complete`
    );
    check(fault.retryIdsMatched === true, `${operation} retry physical ids changed`);
    if (operation === "upsert") check(fault.retryPayloadMatched === true, "upsert retry payload changed");
    check(
        Array.isArray(fault.firstPhysicalIds) && fault.firstPhysicalIds.length > 0,
        `${operation} physical ids are missing`
    );
    const physicalIds = fault.firstPhysicalIds.map(id => {
        const parsed = physicalId(id, `${operation} physical id`);
        check(parsed.vectorId === expectedVectorId, `${operation} physical id changed logical vector ownership`);
        return parsed.id;
    });
    check(SHA256.test(fault.returnedMutationIdSha256), `${operation} mutation receipt hash is invalid`);
    if (operation === "upsert") check(SHA256.test(fault.firstPayloadSha256), "upsert payload hash is invalid");
    return { fault, physicalIds };
}

function durableDeleteResponseLossSettlement(state) {
    const fault = state.fault;
    return (
        fault?.mode === "delete_accept_then_throw" &&
        fault.armed === false &&
        fault.inFlight === false &&
        fault.fired === true &&
        fault.acceptedBeforeThrow === true &&
        fault.retryComplete === true &&
        fault.retryCount > 0 &&
        fault.retryIdsMatched === true &&
        fault.gateOpen === false &&
        fault.firstPhysicalIds.length > 0 &&
        fault.returnedMutationIdSha256 !== null
    );
}

export function collectResponseLossRetryEvidence(input) {
    const upsert = faultEvidence(input.upsertState, "upsert");
    const deletion = faultEvidence(input.deleteState, "delete");
    const evidence = freeze({
        upsert: {
            acceptedBeforeThrow: true,
            physicalId: upsert.physicalIds[0],
            retryPhysicalId: upsert.physicalIds[0],
            payloadSha256: upsert.fault.firstPayloadSha256,
            retryPayloadSha256: upsert.fault.firstPayloadSha256,
            mutationIdSha256: upsert.fault.returnedMutationIdSha256,
            retryCount: upsert.fault.retryCount,
        },
        delete: {
            acceptedBeforeThrow: true,
            physicalIds: deletion.physicalIds,
            retryPhysicalIds: [...deletion.physicalIds],
            mutationIdSha256: deletion.fault.returnedMutationIdSha256,
            retryCount: deletion.fault.retryCount,
        },
    });
    return assertSecretFreeVectorEvidence(evidence, input.secrets ?? []);
}

export function createCloudflareVectorizeProofLifecycle(dependencies = {}) {
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    check(typeof fetchImpl === "function", "proof fetch dependency is required", TypeError);
    const now = dependencies.now ?? (() => Date.now());
    const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const schedule = dependencies.setTimeout ?? globalThis.setTimeout;
    const cancel = dependencies.clearTimeout ?? globalThis.clearTimeout;
    const timeoutMs = positiveInteger(
        dependencies.requestTimeoutMs ?? CLOUDFLARE_VECTORIZE_PROOF_HTTP_TIMEOUT_MS,
        "request timeout",
        300_000
    );
    const maximumBytes = positiveInteger(
        dependencies.maxResponseBytes ?? CLOUDFLARE_VECTORIZE_PROOF_HTTP_MAX_BYTES,
        "response byte limit",
        4 * 1024 * 1024
    );
    const openLive = dependencies.openLiveVectorSubscription;

    const requestJson = async input => {
        const origin = normalizeOrigin(input.origin);
        const url = new URL(input.path, origin);
        check(url.origin === origin.origin, "proof request escaped its origin", TypeError);
        const method = input.method ?? "GET";
        const label = input.label ?? `${method} ${url.pathname}`;
        const controller = new AbortController();
        let timeout;
        try {
            const request = (async () => {
                const response = await fetchImpl(url, {
                    method,
                    headers: {
                        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
                        ...(input.headers ?? {}),
                    },
                    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
                    redirect: "error",
                    signal: controller.signal,
                });
                if (!(response instanceof Response)) {
                    throw new CloudflareVectorizeProofProtocolError(
                        `${label} fetch returned an invalid response`,
                        "invalid_response"
                    );
                }
                if (response.redirected) {
                    throw new CloudflareVectorizeProofHttpError(
                        `${label} redirected unexpectedly`,
                        response.status,
                        null,
                        "protocol",
                        "unexpected_redirect"
                    );
                }
                let body;
                try {
                    body = await boundedJson(response, maximumBytes, label, controller.signal);
                } catch (error) {
                    if (!response.ok && error instanceof CloudflareVectorizeProofProtocolError) {
                        throw new CloudflareVectorizeProofHttpError(
                            `${label} returned HTTP ${response.status}`,
                            response.status,
                            null,
                            "http",
                            error.reason
                        );
                    }
                    throw error;
                }
                if (!response.ok) {
                    throw new CloudflareVectorizeProofHttpError(
                        `${label} returned HTTP ${response.status}`,
                        response.status,
                        responseCode(body),
                        "http"
                    );
                }
                return Object.freeze({ status: response.status, headers: response.headers, body });
            })();
            return await Promise.race([
                request,
                new Promise((_, reject) => {
                    timeout = schedule(() => {
                        controller.abort();
                        reject(new CloudflareVectorizeProofHttpError(`${label} timed out`, null, null, "timeout"));
                    }, timeoutMs);
                }),
            ]);
        } catch (error) {
            if (error instanceof CloudflareVectorizeProofHttpError) throw error;
            if (controller.signal.aborted) {
                throw new CloudflareVectorizeProofHttpError(`${label} timed out`, null, null, "timeout");
            }
            if (error instanceof CloudflareVectorizeProofProtocolError) {
                throw new CloudflareVectorizeProofHttpError(error.message, null, null, "protocol", error.reason);
            }
            throw new CloudflareVectorizeProofHttpError(
                `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
                null,
                null,
                "network"
            );
        } finally {
            cancel(timeout);
        }
    };

    const health = async input => {
        const result = await requestJson({ origin: input.origin, path: "/health", label: "proof Worker health" });
        const body = object(result.body, "proof Worker health response");
        check(body.ok === true, "proof Worker health failed");
        check(body.schemaVersion === 1, "proof Worker package schema version is not 1");
        check(body.vectorResources === 1, "proof Worker vector resource count drifted");
        check(body.proofConfigured === true, "proof Worker is missing proof configuration");
        const releaseSha256 = text(body.releaseSha256, "proof Worker release hash", 64);
        check(SHA256.test(releaseSha256), "proof Worker release hash is invalid");
        if (input.releaseSha256 !== undefined) {
            check(releaseSha256 === input.releaseSha256, "proof Worker release hash drifted");
        }
        return freeze({ ok: true, schemaVersion: 1, releaseSha256, vectorResources: 1, proofConfigured: true });
    };

    const refreshPrincipal = async input => {
        const origin = normalizeOrigin(input.origin);
        let cookie = text(input.cookie, "session cookie", 16_384);
        const session = await requestJson({
            origin,
            path: "/api/auth/get-session",
            headers: { cookie },
            label: "Better Auth session refresh",
        });
        cookie = mergeCookies(cookie, session.headers);
        const userId = identity(
            object(object(session.body, "Better Auth session").user, "Better Auth user").id,
            "Better Auth user id"
        );
        const token = await requestJson({
            origin,
            path: "/api/auth/token",
            headers: { cookie },
            label: "Better Auth JWT refresh",
        });
        cookie = mergeCookies(cookie, token.headers);
        return Object.freeze({
            cookie,
            token: text(object(token.body, "Better Auth JWT").token, "Better Auth JWT", 16_384),
            userId,
        });
    };

    const signInAnonymous = async input => {
        const origin = normalizeOrigin(input.origin);
        const result = await requestJson({
            origin,
            path: "/api/auth/sign-in/anonymous",
            method: "POST",
            headers: { origin: origin.origin },
            body: {},
            label: "anonymous Better Auth sign-in",
        });
        const cookie = mergeCookies("", result.headers);
        check(cookie.length > 0, "anonymous Better Auth sign-in returned no session cookie");
        return refreshPrincipal({ origin, cookie });
    };

    const authPost = async (input, path, body, label) => {
        const origin = normalizeOrigin(input.origin);
        const current = principal(input.principal);
        const result = await requestJson({
            origin,
            path: `/api/auth${path}`,
            method: "POST",
            headers: { cookie: current.cookie, origin: origin.origin },
            body,
            label,
        });
        return Object.freeze({ body: result.body, cookie: mergeCookies(current.cookie, result.headers) });
    };

    const createOrganization = async input => {
        const name = text(input.name, "organization name", 128);
        const slug = text(input.slug, "organization slug", 128);
        check(/^[a-z0-9][a-z0-9-]*$/.test(slug), "organization slug is invalid", TypeError);
        const created = await authPost(
            input,
            "/organization/create",
            { name, slug, keepCurrentActiveOrganization: true },
            "Better Auth organization create"
        );
        return Object.freeze({
            organizationId: organizationId(object(created.body, "created organization").id),
            cookie: created.cookie,
        });
    };

    const setActiveOrganization = async input => {
        const active = await authPost(
            input,
            "/organization/set-active",
            { organizationId: organizationId(input.organizationId) },
            "Better Auth set active organization"
        );
        return refreshPrincipal({ origin: input.origin, cookie: active.cookie });
    };

    const setupOrganizations = async input => {
        const origin = normalizeOrigin(input.origin);
        let owner = await signInAnonymous({ origin });
        const member = await signInAnonymous({ origin });
        const owning = await createOrganization({
            origin,
            principal: owner,
            name: text(input.owningName, "owning organization name", 128),
            slug: text(input.owningSlug, "owning organization slug", 128),
        });
        owner = Object.freeze({ ...owner, cookie: owning.cookie });
        const isolated = await createOrganization({
            origin,
            principal: owner,
            name: text(input.isolatedName, "isolated organization name", 128),
            slug: text(input.isolatedSlug, "isolated organization slug", 128),
        });
        owner = Object.freeze({ ...owner, cookie: isolated.cookie });
        await requestJson({
            origin,
            path: "/proof/add-member",
            method: "POST",
            headers: proofHeaders(input.admin),
            body: { organizationId: owning.organizationId, userId: member.userId },
            label: "proof owning-organization member setup",
        });
        await requestJson({
            origin,
            path: "/proof/add-member",
            method: "POST",
            headers: proofHeaders(input.admin),
            body: { organizationId: isolated.organizationId, userId: member.userId },
            label: "proof isolated-organization member setup",
        });
        const activeOwner = await setActiveOrganization({
            origin,
            principal: owner,
            organizationId: owning.organizationId,
        });
        const owningMember = await setActiveOrganization({
            origin,
            principal: member,
            organizationId: owning.organizationId,
        });
        const activeMember = await setActiveOrganization({
            origin,
            principal: owningMember,
            organizationId: isolated.organizationId,
        });
        return Object.freeze({
            owner: activeOwner,
            member: activeMember,
            owningMember,
            owningOrganizationId: owning.organizationId,
            isolatedOrganizationId: isolated.organizationId,
        });
    };

    const adminMigrationRequest = async (input, route, body) => {
        const token = text(input.adminToken, "migration admin token", 512);
        return requestJson({
            origin: input.origin,
            path: `/_chardb/migrations/${route}`,
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: `Bearer ${token}` },
            ...(body === undefined ? {} : { body }),
            label: `migration ${route}`,
        });
    };

    const migrateV0ToV1 = async input => {
        const migrationId = identity(input.migrationId, "migration id");
        const retryTimeoutMs = positiveInteger(
            input.timeoutMs ?? CLOUDFLARE_VECTORIZE_PROOF_MIGRATION_RETRY_TIMEOUT_MS,
            "migration retry timeout",
            30 * 60_000
        );
        const retryIntervalMs = positiveInteger(
            input.intervalMs ?? CLOUDFLARE_VECTORIZE_PROOF_POLL_INTERVAL_MS,
            "migration retry interval",
            retryTimeoutMs
        );
        const retryDeadline = Number(now()) + retryTimeoutMs;
        const migrationRequest = async (route, body) => {
            for (let attempt = 1; attempt <= CLOUDFLARE_VECTORIZE_PROOF_MIGRATION_MAX_ATTEMPTS; attempt++) {
                try {
                    return await adminMigrationRequest(input, route, body);
                } catch (error) {
                    const retryable =
                        error instanceof CloudflareVectorizeProofHttpError &&
                        error.kind === "http" &&
                        error.status !== null &&
                        error.status >= 500 &&
                        error.status <= 599;
                    if (
                        !retryable ||
                        attempt === CLOUDFLARE_VECTORIZE_PROOF_MIGRATION_MAX_ATTEMPTS ||
                        Number(now()) >= retryDeadline
                    ) {
                        throw error;
                    }
                    await sleep(Math.min(retryIntervalMs, Math.max(0, retryDeadline - Number(now()))));
                    if (Number(now()) >= retryDeadline) throw error;
                }
            }
            throw new Error("migration request retry bound was exceeded");
        };
        const before = parseMigrationState(object((await migrationRequest("state")).body, "migration response").state);
        if (before.status === "active" && before.activeVersion === 1 && before.activeEpoch === 2) {
            return freeze({
                beforeVersion: 1,
                beforeEpoch: 2,
                targetVersion: 1,
                afterVersion: 1,
                afterEpoch: 2,
                idempotentRetry: true,
            });
        }
        check(
            before.status === "active" && before.activeVersion === 0 && before.activeEpoch === 1,
            "migration did not start at version 0 epoch 1"
        );
        const begun = parseMigrationState(
            object(
                (await migrationRequest("begin", { migrationId, targetVersion: 1 })).body,
                "migration begin response"
            ).state
        );
        check(
            begun.status === "migrating" && begun.migrationId === migrationId && begun.targetVersion === 1,
            "migration begin ownership drifted"
        );
        const listed = object(
            (await migrationRequest(`shards?migrationId=${encodeURIComponent(migrationId)}`)).body,
            "migration shards response"
        );
        check(
            Array.isArray(listed.shards) && listed.shards.length > 0 && listed.shards.length <= 4096,
            "migration shard list is invalid"
        );
        const seen = new Set();
        for (const value of listed.shards) {
            const shard = object(value, "migration shard");
            const shardId = identity(shard.shardId, "migration shard id");
            check(!seen.has(shardId), "migration shard list contains a duplicate");
            seen.add(shardId);
            check(shard.status === "pending" || shard.status === "active", "migration shard status is invalid");
            if (shard.status === "pending") {
                const activated = object(
                    (await migrationRequest("shard", { migrationId, shardId })).body,
                    "migration shard response"
                ).shard;
                check(
                    object(activated, "activated migration shard").shardId === shardId && activated.status === "active",
                    "migration shard activation drifted"
                );
            }
        }
        const catalog = parseMigrationState(
            object((await migrationRequest("catalog", { migrationId, version: 1 })).body, "migration catalog response")
                .state
        );
        check(
            catalog.status === "migrating" && catalog.migrationId === migrationId,
            "Catalog migration ownership drifted"
        );
        const after = parseMigrationState(
            object((await migrationRequest("complete", { migrationId })).body, "migration complete response").state
        );
        check(
            after.status === "active" && after.activeVersion === 1 && after.activeEpoch === 2,
            "migration did not activate version 1 epoch 2"
        );
        return freeze({
            beforeVersion: 0,
            beforeEpoch: 1,
            targetVersion: 1,
            afterVersion: 1,
            afterEpoch: 2,
            idempotentRetry: false,
        });
    };

    const mutateVector = async input => {
        const action = input.action;
        check(
            action === "create" || action === "replace" || action === "delete",
            "vector mutation action is invalid",
            TypeError
        );
        const body = {
            action,
            id: text(input.id, "vector document id", 128),
            organizationId: organizationId(input.organizationId),
            mutId: identity(input.mutId, "vector mutation id"),
        };
        if (action !== "delete") {
            body.text = text(input.text, "vector document text", 2_000);
            check(
                Array.isArray(input.values) && input.values.length === 32 && input.values.every(Number.isFinite),
                "vector values must contain 32 finite numbers",
                TypeError
            );
            body.values = [...input.values];
        }
        const result = await requestJson({
            origin: input.origin,
            path: "/api/vector-documents",
            method: "POST",
            headers: { authorization: `Bearer ${principal(input.principal).token}` },
            body,
            label: `vector ${action}`,
        });
        const value = object(result.body, `vector ${action} response`);
        const expectedKeys = action === "delete" ? ["id"] : ["id", "vectorId"];
        check(
            JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys),
            `vector ${action} response fields are invalid`
        );
        check(value.id === body.id, `vector ${action} response document identity drifted`);
        if (action === "delete") return Object.freeze({ id: body.id });
        const resultVectorId = vectorId(value.vectorId);
        return Object.freeze({ id: body.id, vectorId: resultVectorId });
    };

    const listVectorDocuments = async input => {
        const query = new URLSearchParams({
            organizationId: organizationId(input.organizationId),
            limit: String(positiveInteger(input.limit ?? 100, "vector document limit", 100)),
        });
        const result = await requestJson({
            origin: input.origin,
            path: `/api/vector-documents?${query}`,
            headers: { authorization: `Bearer ${principal(input.principal).token}` },
            label: "vector document list",
        });
        check(Array.isArray(result.body), "vector document list is invalid");
        return Object.freeze(
            result.body.map((entry, index) => {
                const row = object(entry, `vector document ${index}`);
                return Object.freeze({
                    id: text(row.id, `vector document ${index} id`, 128),
                    body: text(row.body, `vector document ${index} body`, 2_000),
                });
            })
        );
    };

    const search = async input => {
        check(
            Array.isArray(input.values) && input.values.length === 32 && input.values.every(Number.isFinite),
            "search values must contain 32 finite numbers",
            TypeError
        );
        const limit = positiveInteger(input.limit ?? 10, "search limit", 100);
        const result = await requestJson({
            origin: input.origin,
            path: "/api/vector-search",
            method: "POST",
            headers: { authorization: `Bearer ${principal(input.principal).token}` },
            body: { organizationId: organizationId(input.organizationId), values: [...input.values], limit },
            label: "vector search",
        });
        return Object.freeze(searchMatches(result.body, "vector search"));
    };

    const openLiveVectorSubscription = async input => {
        check(typeof openLive === "function", "live vector subscription dependency is required", TypeError);
        check(
            Array.isArray(input.values) && input.values.length === 32 && input.values.every(Number.isFinite),
            "live vector query values must contain 32 finite numbers",
            TypeError
        );
        const owner = principal(input.principal);
        const liveOrigin = normalizeOrigin(input.origin);
        let currentOwner = owner;
        let firstRead = true;
        const result = await openLive({
            origin: liveOrigin.href,
            organizationId: organizationId(input.organizationId),
            expectedRowPk: identity(input.expectedRowPk, "live vector row id"),
            expectedPendingFallbackRowPk: identity(input.expectedPendingFallbackRowPk, "live pending fallback row id"),
            values: Object.freeze([...input.values]),
            clientId: identity(input.clientId, "live vector client id"),
            jwt: owner.token,
            getJwt: async () => {
                if (firstRead) {
                    firstRead = false;
                    return currentOwner.token;
                }
                const refreshed = await refreshPrincipal({ origin: liveOrigin, cookie: currentOwner.cookie });
                check(refreshed.userId === owner.userId, "live Better Auth refresh changed principal");
                currentOwner = refreshed;
                return currentOwner.token;
            },
            timeoutMs: positiveInteger(input.timeoutMs, "live vector timeout", 10 * 60_000),
        });
        check(
            result !== null &&
                typeof result === "object" &&
                [
                    "reconnect",
                    "beginReplacement",
                    "waitForPending",
                    "assertPending",
                    "allowCurrent",
                    "waitForCurrent",
                    "finish",
                    "abort",
                ].every(method => typeof result[method] === "function"),
            "live vector subscription dependency returned an invalid session",
            TypeError
        );
        return result;
    };

    const parseAdversaryResult = (value, expectedAction) => {
        const result = exactFields(value, "vector adversary result", [
            "action",
            "vectorId",
            "stalePhysicalId",
            "currentPhysicalId",
            "upsertMutationIdSha256",
            "deleteMutationIdSha256",
        ]);
        check(result.action === expectedAction, "vector adversary action drifted");
        const logicalId = vectorId(result.vectorId);
        const stale = physicalId(result.stalePhysicalId, "stale vector physical id");
        const current = physicalId(result.currentPhysicalId, "current vector physical id");
        check(
            stale.vectorId === logicalId &&
                stale.version === 1 &&
                current.vectorId === logicalId &&
                current.version === 2,
            "vector adversary physical identity drifted"
        );
        if (expectedAction === "inspect") {
            check(
                result.upsertMutationIdSha256 === null && result.deleteMutationIdSha256 === null,
                "vector adversary inspection returned mutation evidence"
            );
        } else {
            check(
                typeof result.upsertMutationIdSha256 === "string" && SHA256.test(result.upsertMutationIdSha256),
                "vector adversary upsert mutation digest is invalid"
            );
            check(
                typeof result.deleteMutationIdSha256 === "string" && SHA256.test(result.deleteMutationIdSha256),
                "vector adversary delete mutation digest is invalid"
            );
        }
        return freeze({
            action: expectedAction,
            vectorId: logicalId,
            stalePhysicalId: stale.id,
            currentPhysicalId: current.id,
            upsertMutationIdSha256: result.upsertMutationIdSha256,
            deleteMutationIdSha256: result.deleteMutationIdSha256,
        });
    };

    const mutateVectorAdversary = async input => {
        check(input.action === "apply" || input.action === "restore", "vector adversary mutation action is invalid");
        for (const [label, values] of [
            ["stale", input.staleValues],
            ["current", input.currentValues],
        ]) {
            check(
                Array.isArray(values) && values.length === 32 && values.every(Number.isFinite),
                `${label} adversary values must contain 32 finite numbers`,
                TypeError
            );
        }
        const result = await requestJson({
            origin: input.origin,
            path: "/proof/vector-adversary",
            method: "POST",
            headers: proofHeaders(input.admin),
            body: {
                action: input.action,
                organizationId: organizationId(input.organizationId),
                id: identity(input.id, "vector adversary document id"),
                staleValues: [...input.staleValues],
                currentValues: [...input.currentValues],
            },
            label: `vector adversary ${input.action}`,
        });
        return parseAdversaryResult(result.body, input.action);
    };

    const queryVectorAdversary = async input => {
        check(
            Array.isArray(input.values) && input.values.length === 32 && input.values.every(Number.isFinite),
            "vector adversary query values must contain 32 finite numbers",
            TypeError
        );
        const result = await requestJson({
            origin: input.origin,
            path: "/proof/vector-adversary/query",
            method: "POST",
            headers: proofHeaders(input.admin),
            body: {
                organizationId: organizationId(input.organizationId),
                id: identity(input.id, "vector adversary document id"),
                values: [...input.values],
            },
            label: "vector adversary raw query",
        });
        const body = exactFields(result.body, "vector adversary query result", [
            "action",
            "vectorId",
            "stalePhysicalId",
            "currentPhysicalId",
            "upsertMutationIdSha256",
            "deleteMutationIdSha256",
            "matches",
        ]);
        const inspected = parseAdversaryResult(
            {
                action: body.action,
                vectorId: body.vectorId,
                stalePhysicalId: body.stalePhysicalId,
                currentPhysicalId: body.currentPhysicalId,
                upsertMutationIdSha256: body.upsertMutationIdSha256,
                deleteMutationIdSha256: body.deleteMutationIdSha256,
            },
            "inspect"
        );
        check(Array.isArray(body.matches) && body.matches.length <= 17, "vector adversary raw matches are invalid");
        const matches = body.matches.map((value, index) => {
            const match = exactFields(value, `vector adversary raw match ${index}`, ["physicalId", "score"]);
            const parsed = physicalId(match.physicalId, `vector adversary raw match ${index} physical id`);
            check(typeof match.score === "number" && Number.isFinite(match.score), "vector adversary score is invalid");
            return freeze({ physicalId: parsed.id, score: Object.is(match.score, -0) ? 0 : match.score });
        });
        check(
            new Set(matches.map(match => match.physicalId)).size === matches.length,
            "vector adversary matches repeat an id"
        );
        return freeze({ ...inspected, matches });
    };

    const vectorSearchAudit = async input => {
        check(input.action === "cursor" || input.action === "observe", "vector search audit action is invalid");
        check(
            Array.isArray(input.values) && input.values.length === 32 && input.values.every(Number.isFinite),
            "vector search audit values must contain 32 finite numbers",
            TypeError
        );
        if (input.action === "observe") {
            check(
                Number.isSafeInteger(input.afterSequence) && input.afterSequence >= 0,
                "vector search audit observation cursor is invalid",
                TypeError
            );
        }
        const result = await requestJson({
            origin: input.origin,
            path: "/proof/vector-search-audit",
            method: "POST",
            headers: proofHeaders(input.admin),
            body: {
                action: input.action,
                organizationId: organizationId(input.organizationId),
                id: identity(input.id, "vector search audit document id"),
                values: [...input.values],
                ...(input.action === "observe" ? { afterSequence: input.afterSequence } : {}),
            },
            label: `vector search audit ${input.action}`,
        });
        const body = exactFields(result.body, "vector search audit result", [
            "sequence",
            "querySha256",
            "candidateSetSha256",
            "candidateCount",
            "stalePresent",
            "currentPresent",
            "otherCandidateCount",
        ]);
        check(Number.isSafeInteger(body.sequence) && body.sequence >= 0, "vector search audit sequence is invalid");
        for (const field of ["candidateCount", "otherCandidateCount"]) {
            check(
                Number.isSafeInteger(body[field]) && body[field] >= 0 && body[field] <= 17,
                `vector search audit ${field} is invalid`
            );
        }
        check(
            typeof body.stalePresent === "boolean" && typeof body.currentPresent === "boolean",
            "vector search audit candidate classification is invalid"
        );
        if (input.action === "cursor") {
            check(
                body.querySha256 === null &&
                    body.candidateSetSha256 === null &&
                    body.candidateCount === 0 &&
                    body.otherCandidateCount === 0 &&
                    body.stalePresent === false &&
                    body.currentPresent === false,
                "vector search audit cursor contains observation evidence"
            );
        } else {
            check(
                typeof body.querySha256 === "string" && SHA256.test(body.querySha256),
                "vector search audit query digest is invalid"
            );
            check(
                typeof body.candidateSetSha256 === "string" && SHA256.test(body.candidateSetSha256),
                "vector search audit candidate-set digest is invalid"
            );
            check(
                body.sequence === input.afterSequence + 1,
                "vector search audit sequence did not advance exactly once"
            );
            check(
                Number(body.stalePresent) + Number(body.currentPresent) + body.otherCandidateCount ===
                    body.candidateCount,
                "vector search audit candidate accounting drifted"
            );
        }
        return freeze({
            sequence: body.sequence,
            querySha256: body.querySha256,
            candidateSetSha256: body.candidateSetSha256,
            candidateCount: body.candidateCount,
            stalePresent: body.stalePresent,
            currentPresent: body.currentPresent,
            otherCandidateCount: body.otherCandidateCount,
        });
    };

    const armFault = async input => {
        check(
            input.mode === "upsert_accept_then_throw" || input.mode === "delete_accept_then_throw",
            "vector fault mode is invalid",
            TypeError
        );
        const result = await requestJson({
            origin: input.origin,
            path: "/proof/vector-fault/arm",
            method: "POST",
            headers: proofHeaders(input.admin),
            body: {
                organizationId: organizationId(input.organizationId),
                vectorId: vectorId(input.vectorId),
                mode: input.mode,
            },
            label: "vector fault arm",
        });
        const body = object(result.body, "vector fault arm response");
        check(body.armed === true, "vector fault did not arm");
        check(body.vectorId === input.vectorId, "vector fault armed a different logical vector");
        return result.body;
    };

    const vectorState = async input => {
        const id = vectorId(input.vectorId);
        const query = new URLSearchParams({ organizationId: organizationId(input.organizationId), vectorId: id });
        const result = await requestJson({
            origin: input.origin,
            path: `/proof/vector-state?${query}`,
            headers: proofHeaders(input.admin),
            label: "vector proof state",
        });
        return parseVectorState(result.body, id);
    };

    const vectorIntent = async input => {
        const action = input.action;
        check(
            action === "create" || action === "replace" || action === "delete",
            "vector proof intent action is invalid",
            TypeError
        );
        const query = new URLSearchParams({
            organizationId: organizationId(input.organizationId),
            id: text(input.id, "vector document id", 128),
            action,
        });
        const result = await requestJson({
            origin: input.origin,
            path: `/proof/vector-intent?${query}`,
            headers: proofHeaders(input.admin),
            label: "vector proof intent",
        });
        const body = object(result.body, "vector proof intent response");
        const id = vectorId(body.vectorId);
        check(body.action === "upsert" || body.action === "delete", "vector proof intent action is invalid");
        const nextVersion = positiveInteger(body.nextVersion, "vector proof intent version");
        check(
            Array.isArray(body.physicalIds) && body.physicalIds.length <= 512,
            "vector proof intent physical ids are invalid"
        );
        const seen = new Set();
        const physicalIds = body.physicalIds.map((value, index) => {
            const parsed = physicalId(value, `vector proof intent physical id ${index}`);
            check(parsed.vectorId === id, "vector proof intent physical id changed logical vector ownership");
            check(!seen.has(parsed.id), "vector proof intent contains a duplicate physical id");
            seen.add(parsed.id);
            return parsed;
        });
        if (body.action === "upsert") {
            check(
                physicalIds.length === 1 && physicalIds[0].version === nextVersion,
                "upsert intent does not own its exact next physical version"
            );
        }
        return freeze({
            vectorId: id,
            action: body.action,
            nextVersion,
            physicalIds: physicalIds.map(item => item.id),
        });
    };

    const pollState = async (input, checkpoint, complete) => {
        const pollTimeoutMs = positiveInteger(input.timeoutMs, "poll timeout", 30 * 60_000);
        const intervalMs = positiveInteger(
            input.intervalMs ?? CLOUDFLARE_VECTORIZE_PROOF_POLL_INTERVAL_MS,
            "poll interval",
            pollTimeoutMs
        );
        const startedAt = Number(now());
        check(Number.isFinite(startedAt), "proof clock returned an invalid time");
        const deadline = startedAt + pollTimeoutMs;
        const phases = [];
        let phaseProgressionOverflowCount = 0;
        let lastObservedPhase;
        const maximumTurns = Math.ceil(pollTimeoutMs / intervalMs) + 2;
        let latest;
        let pollAttempts = 0;
        let transientHttpFailureCount = 0;
        const transientHttpFailureCounts = [];
        let transientHttpFailureOverflowCount = 0;
        const recordTransientFailure = error => {
            transientHttpFailureCount++;
            const existing = transientHttpFailureCounts.find(
                item => item.status === error.status && item.code === error.code
            );
            if (existing) existing.count++;
            else if (transientHttpFailureCounts.length < 16) {
                transientHttpFailureCounts.push({ status: error.status, code: error.code, count: 1 });
            } else transientHttpFailureOverflowCount++;
        };
        const settlementEvidence = outcome =>
            freeze({
                checkpoint,
                outcome,
                timeoutMs: pollTimeoutMs,
                elapsedMs: Math.max(0, Number(now()) - startedAt),
                pollAttempts,
                phaseProgression: phases,
                phaseProgressionOverflowCount,
                latestState: latest ?? null,
                transientHttpFailureCount,
                transientHttpFailureCounts,
                transientHttpFailureOverflowCount,
                hardBoundClaimed: false,
            });
        for (let turn = 0; turn < maximumTurns; turn++) {
            pollAttempts++;
            try {
                latest = await vectorState(input);
            } catch (error) {
                if (!isCloudflareVectorizeProofRetryableStateRead(error)) throw error;
                recordTransientFailure(error);
                if (Number(now()) >= deadline) break;
                await sleep(Math.min(intervalMs, Math.max(0, deadline - Number(now()))));
                continue;
            }
            const phase = latest.outbox?.phase;
            if (phase && lastObservedPhase !== phase) {
                lastObservedPhase = phase;
                if (phases.length < VECTOR_PHASE_PROGRESSION_MAX) phases.push(phase);
                else phaseProgressionOverflowCount++;
            }
            if (checkpoint === "vector-deleted" && latest.outbox?.terminalFailure === true) {
                throw new CloudflareVectorizeProofSettlementError(
                    "vector deletion failed because external absence could not be proven",
                    settlementEvidence("failed_unproven")
                );
            }
            const result = complete(latest, phases);
            if (result) {
                return freeze({
                    state: latest,
                    phases,
                    elapsedMs: Math.max(0, Number(now()) - startedAt),
                    pollAttempts,
                    transientHttpFailureCount,
                    transientHttpFailureCounts: freeze(transientHttpFailureCounts),
                    transientHttpFailureOverflowCount,
                    result,
                });
            }
            if (Number(now()) >= deadline) break;
            await sleep(Math.min(intervalMs, Math.max(0, deadline - Number(now()))));
        }
        throw new CloudflareVectorizeProofSettlementError(
            `${checkpoint === "vector-ready" ? "vector readiness" : "vector deletion"} timed out after ${pollTimeoutMs}ms`,
            settlementEvidence("timed_out")
        );
    };

    const pollReady = input =>
        pollState(input, "vector-ready", (state, phases) => {
            const ready =
                state.head?.state === "ready" &&
                state.head.version === input.version &&
                state.head.deliveredVersion === input.version;
            if (!ready) return false;
            const required = input.requiredPhases ?? ["submit", "verify"];
            check(
                required.every(phase => phases.includes(phase)),
                `ready vector did not pass through ${required.join(" then ")}`
            );
            return { ready: true };
        });

    const pollDeleted = input =>
        pollState(input, "vector-deleted", (state, phases) => {
            const required = input.requiredPhases ?? ["submit", "verify"];
            const observedRequiredPhases = required.every(phase => phases.includes(phase));
            if (state.head === null && state.outbox === null) {
                if (!observedRequiredPhases && !durableDeleteResponseLossSettlement(state)) return false;
                return { absent: true, retainedTombstone: false };
            }
            if (!observedRequiredPhases) return false;
            const lastVerify = phases.lastIndexOf("verify");
            const returnedToSubmit = phases.slice(lastVerify + 1).includes("submit");
            const retained =
                returnedToSubmit &&
                state.head?.state === "deleting" &&
                state.outbox?.operation === "delete" &&
                state.outbox.phase === "submit" &&
                state.attempts?.some(attempt => attempt.responseAmbiguous === true);
            return retained ? { absent: true, retainedTombstone: true } : false;
        });

    const proveNamespaceIsolation = async input => {
        const expected = vectorId(input.vectorId);
        const expectedRowPk = text(input.expectedRowPk, "expected vector row key", 512);
        const timeoutMs = positiveInteger(input.timeoutMs, "search visibility timeout", 30 * 60_000);
        const intervalMs = positiveInteger(
            input.intervalMs ?? CLOUDFLARE_VECTORIZE_PROOF_POLL_INTERVAL_MS,
            "search visibility interval",
            timeoutMs
        );
        const stabilityWindowMs = input.stabilityWindowMs ?? 0;
        check(
            Number.isSafeInteger(stabilityWindowMs) && stabilityWindowMs >= 0 && stabilityWindowMs <= timeoutMs,
            "search stability window is invalid",
            TypeError
        );
        const startedAt = Number(now());
        check(Number.isFinite(startedAt), "proof clock returned an invalid time");
        const deadline = startedAt + timeoutMs;
        const maximumTurns = Math.ceil(timeoutMs / intervalMs) + 2;
        const transientHttpFailureCounts = [];
        let transientHttpFailureCount = 0;
        let transientHttpFailureOverflowCount = 0;
        let stableSince = null;
        let stabilityExactMatchCount = 0;
        let stabilityResetCount = 0;
        let stabilityNonExactCount = 0;
        const recordTransientFailure = error => {
            transientHttpFailureCount++;
            const existing = transientHttpFailureCounts.find(
                item => item.status === error.status && item.code === error.code
            );
            if (existing) {
                existing.count++;
            } else if (transientHttpFailureCounts.length < 16) {
                transientHttpFailureCounts.push({ status: error.status, code: error.code, count: 1 });
            } else {
                transientHttpFailureOverflowCount++;
            }
        };
        const settlementEvidence = checkpoint =>
            freeze({
                checkpoint,
                timeoutMs,
                elapsedMs: Math.max(0, Number(now()) - startedAt),
                queryVisibilityAttempts: attempts,
                queryStabilityWindowMs: stabilityWindowMs,
                queryStabilityObservedMs: stableSince === null ? 0 : Math.max(0, Number(now()) - stableSince),
                queryStabilityExactMatchCount: stabilityExactMatchCount,
                queryStabilityResetCount: stabilityResetCount,
                queryStabilityNonExactCount: stabilityNonExactCount,
                transientHttpFailureCount,
                transientHttpFailureCounts,
                transientHttpFailureOverflowCount,
                hardBoundClaimed: false,
            });
        const timeout = (checkpoint = "owning-filtered-search") => {
            throw new CloudflareVectorizeProofSettlementError(
                `${checkpoint === "owning-filtered-search" ? "owning organization search visibility" : "isolated organization search"} timed out after ${timeoutMs}ms`,
                settlementEvidence(checkpoint)
            );
        };
        let own;
        let attempts = 0;
        for (let turn = 0; turn < maximumTurns; turn++) {
            if (turn > 0 && Number(now()) >= deadline) timeout();
            attempts++;
            try {
                own = await search({
                    origin: input.origin,
                    principal: input.owner,
                    organizationId: input.owningOrganizationId,
                    values: input.values,
                    limit: input.limit,
                });
            } catch (error) {
                if (
                    !(error instanceof CloudflareVectorizeProofHttpError) ||
                    error.kind !== "http" ||
                    !Number.isInteger(error.status) ||
                    error.status < 500 ||
                    error.status > 599
                ) {
                    throw error;
                }
                recordTransientFailure(error);
                if (stableSince !== null) stabilityResetCount++;
                stableSince = null;
                stabilityExactMatchCount = 0;
                if (Number(now()) >= deadline || turn === maximumTurns - 1) timeout();
                await sleep(Math.min(intervalMs, Math.max(0, deadline - Number(now()))));
                continue;
            }
            const exact = own.length === 1 && own[0]?.rowPk === expectedRowPk;
            check(own.length === 0 || exact, "owning organization search returned an unexpected vector");
            if (exact) {
                const observedAt = Number(now());
                check(Number.isFinite(observedAt), "proof clock returned an invalid time");
                if (stableSince === null) {
                    stableSince = observedAt;
                    stabilityExactMatchCount = 1;
                } else {
                    stabilityExactMatchCount++;
                }
                const observedWindowMs = Math.max(0, observedAt - stableSince);
                if (
                    observedWindowMs >= stabilityWindowMs &&
                    (stabilityWindowMs === 0 || stabilityExactMatchCount >= 2)
                ) {
                    break;
                }
            } else {
                stabilityNonExactCount++;
                if (stableSince !== null) stabilityResetCount++;
                stableSince = null;
                stabilityExactMatchCount = 0;
            }
            if (Number(now()) >= deadline || turn === maximumTurns - 1) {
                timeout();
            }
            await sleep(Math.min(intervalMs, Math.max(0, deadline - Number(now()))));
        }
        check(own?.length === 1 && own[0]?.rowPk === expectedRowPk, "owning organization search visibility is missing");
        const queryVisibilityElapsedMs = Math.max(0, Number(now()) - startedAt);
        const queryStabilityObservedMs = stableSince === null ? 0 : Math.max(0, Number(now()) - stableSince);
        if (Number(now()) >= deadline) timeout("isolated-filtered-search");
        const isolated = await search({
            origin: input.origin,
            principal: input.member,
            organizationId: input.isolatedOrganizationId,
            values: input.values,
            limit: input.limit,
        });
        check(isolated.length === 0, "isolated organization search returned another namespace");
        return assertSecretFreeVectorEvidence(
            freeze({
                namespaceIsolation: true,
                owningOrganizationId: input.owningOrganizationId,
                isolatedOrganizationId: input.isolatedOrganizationId,
                vectorId: expected,
                owningMatches: own.length,
                isolatedMatches: 0,
                queryVisibilityElapsedMs,
                queryVisibilityAttempts: attempts,
                queryStabilityWindowMs: stabilityWindowMs,
                queryStabilityObservedMs,
                queryStabilityExactMatchCount: stabilityExactMatchCount,
                queryStabilityResetCount: stabilityResetCount,
                queryStabilityNonExactCount: stabilityNonExactCount,
                transientHttpFailureCount,
                transientHttpFailureCounts,
                transientHttpFailureOverflowCount,
                hardBoundClaimed: false,
            }),
            [input.owner.cookie, input.owner.token, input.member.cookie, input.member.token]
        );
    };

    const measure = async input => {
        const origin = normalizeOrigin(input.origin);
        const label = text(input.label, "benchmark label", 128);
        check(typeof input.operation === "function", "benchmark operation is required", TypeError);
        const timeoutMs = positiveInteger(input.timeoutMs ?? 120_000, "benchmark timeout", 30 * 60_000);
        const intervalMs = positiveInteger(
            input.intervalMs ?? CLOUDFLARE_VECTORIZE_PROOF_POLL_INTERVAL_MS,
            "benchmark reacquisition interval",
            timeoutMs
        );
        const scheduled = [];
        const reacquisitionObservations = [];
        const reacquisitions = [];
        const measurementStartedAt = Number(now());
        check(Number.isFinite(measurementStartedAt), "benchmark clock returned an invalid time");
        const deadline = measurementStartedAt + timeoutMs;
        const observe = async (sequence, excluded, phase, requestOrdinal) => {
            const started = Number(now());
            check(Number.isFinite(started), "benchmark clock returned an invalid time");
            if (started >= deadline) throw new Error(`benchmark reacquisition timed out after ${timeoutMs}ms`);
            const result = await input.operation({ origin, label, sequence, excluded, phase });
            const completedAt = Number(now());
            const elapsedMs = completedAt - started;
            check(Number.isFinite(elapsedMs) && elapsedMs >= 0, "benchmark clock returned an invalid duration");
            let classification;
            let status = null;
            let code = null;
            if (result === undefined || result === true) {
                classification = "exact";
            } else if (result === false) {
                classification = "empty";
            } else {
                const outcome = object(result, "benchmark operation outcome");
                check(
                    outcome.classification === "empty" ||
                        outcome.classification === "http-5xx" ||
                        outcome.classification === "timeout",
                    "benchmark operation outcome classification is invalid",
                    TypeError
                );
                classification = outcome.classification;
                if (classification === "http-5xx") {
                    check(
                        Number.isSafeInteger(outcome.status) && outcome.status >= 500 && outcome.status <= 599,
                        "benchmark HTTP miss status is invalid",
                        TypeError
                    );
                    check(
                        outcome.code === null || (typeof outcome.code === "string" && RESPONSE_CODE.test(outcome.code)),
                        "benchmark HTTP miss code is invalid",
                        TypeError
                    );
                    status = outcome.status;
                    code = outcome.code;
                } else {
                    check(
                        (outcome.status === undefined || outcome.status === null) &&
                            (outcome.code === undefined || outcome.code === null),
                        "benchmark non-HTTP miss cannot carry HTTP identity",
                        TypeError
                    );
                }
            }
            return {
                public: Object.freeze({ requestOrdinal, sequence, excluded, classification, status, code, elapsedMs }),
                started,
                completedAt,
            };
        };
        for (let sequence = -1; sequence < 5; sequence++) {
            scheduled.push(await observe(sequence, sequence === -1, "scheduled", scheduled.length));
        }
        let openMiss = null;
        for (const observation of scheduled) {
            if (observation.public.classification !== "exact") {
                openMiss ??= {
                    sequence: observation.public.sequence,
                    excluded: observation.public.excluded,
                    started: observation.started,
                    scheduledMissCount: 0,
                };
                openMiss.scheduledMissCount++;
            } else if (openMiss !== null) {
                reacquisitions.push(
                    Object.freeze({
                        afterSequence: openMiss.sequence,
                        excluded: openMiss.excluded,
                        scheduledMissCount: openMiss.scheduledMissCount,
                        outOfBandRequestCount: 0,
                        elapsedMs: observation.completedAt - openMiss.started,
                    })
                );
                openMiss = null;
            }
        }
        if (openMiss !== null) {
            for (;;) {
                const beforeSleep = Number(now());
                if (beforeSleep >= deadline) throw new Error(`benchmark reacquisition timed out after ${timeoutMs}ms`);
                await sleep(Math.min(intervalMs, Math.max(0, deadline - beforeSleep)));
                const observation = await observe(
                    openMiss.sequence,
                    openMiss.excluded,
                    "reacquisition",
                    reacquisitionObservations.length
                );
                reacquisitionObservations.push(observation);
                if (observation.public.classification === "exact") {
                    reacquisitions.push(
                        Object.freeze({
                            afterSequence: openMiss.sequence,
                            excluded: openMiss.excluded,
                            scheduledMissCount: openMiss.scheduledMissCount,
                            outOfBandRequestCount: reacquisitionObservations.length,
                            elapsedMs: observation.completedAt - openMiss.started,
                        })
                    );
                    break;
                }
            }
        }
        const publicScheduled = scheduled.map(item => item.public);
        const publicReacquisitionObservations = reacquisitionObservations.map(item => item.public);
        const availabilityMisses = publicScheduled.filter(item => item.classification !== "exact");
        const exactMatchLatenciesMs = publicScheduled
            .slice(1)
            .filter(item => item.classification === "exact")
            .map(item => item.elapsedMs);
        const exactResponseCount = publicScheduled.length - availabilityMisses.length;
        return assertSecretFreeVectorEvidence(
            freeze({
                label,
                origin: origin.origin,
                warmup: publicScheduled[0],
                samples: publicScheduled.slice(1),
                exactMatchLatenciesMs,
                postStabilitySampling: {
                    latencyPopulation: "exact-results-only",
                    availabilityPassThreshold: null,
                    scheduledRequestCount: publicScheduled.length,
                    exactResponseCount,
                    exactResponseRatio: exactResponseCount / publicScheduled.length,
                    availabilityMissCount: availabilityMisses.length,
                    emptyResponseCount: availabilityMisses.filter(item => item.classification === "empty").length,
                    http5xxResponseCount: availabilityMisses.filter(item => item.classification === "http-5xx").length,
                    timeoutResponseCount: availabilityMisses.filter(item => item.classification === "timeout").length,
                    reacquisitionCount: reacquisitions.length,
                    reacquisitions,
                    reacquisitionObservations: publicReacquisitionObservations,
                    hardBoundClaimed: false,
                },
            }),
            input.secrets ?? []
        );
    };

    return Object.freeze({
        requestJson,
        health,
        signInAnonymous,
        refreshPrincipal,
        createOrganization,
        setActiveOrganization,
        setupOrganizations,
        migrateV0ToV1,
        mutateVector,
        listVectorDocuments,
        search,
        openLiveVectorSubscription,
        mutateVectorAdversary,
        queryVectorAdversary,
        vectorSearchAudit,
        armFault,
        vectorState,
        vectorIntent,
        pollReady,
        pollDeleted,
        proveNamespaceIsolation,
        measure,
    });
}
