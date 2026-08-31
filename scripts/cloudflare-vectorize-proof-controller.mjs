import {
    CloudflareVectorizeProofHttpError,
    assertCloudflareVectorizeProofState,
    assertSecretFreeVectorEvidence,
    collectResponseLossRetryEvidence,
    isCloudflareVectorizeProofRetryableStateRead,
    vectorProofMutationIds,
} from "./cloudflare-vectorize-proof-lifecycle.mjs";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAMESPACE_ID = /^o1_[A-Za-z0-9_-]{43}$/;
const BENCHMARK_WORKLOAD_ID = "ready-vector-filtered-search-v2";
const QUERY_STABILITY_WINDOW_MS = 10_000;
const QUERY_STABILITY_INTERVAL_MS = 1_000;
const BENCHMARK_WORKLOAD = Object.freeze({
    id: BENCHMARK_WORKLOAD_ID,
    dimensions: 32,
    metric: "cosine",
    topK: 1,
    requestsPerSample: 1,
});

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export const CLOUDFLARE_VECTORIZE_PROOF_CONTROLLER_CHECKPOINTS = Object.freeze([
    "health",
    "migration",
    "organization-setup",
    "descriptor",
    "create-intent",
    "create-mutation",
    "create-readiness",
    "create-isolation",
    "replace-intent",
    "replace-fault-arm",
    "replace-mutation",
    "replace-held-claim",
    "redeploy",
    "fault-release",
    "replace-response-loss",
    "replace-readiness",
    "replace-isolation",
    "adversary-settlement",
    "adversary-apply",
    "adversary-filter",
    "adversary-restore",
    "adversary-policy",
    "live-create-intent",
    "live-create-mutation",
    "live-create-readiness",
    "live-subscribe",
    "live-reconnect",
    "live-replace-intent",
    "live-replace-fault-arm",
    "live-replace-mutation",
    "live-replace-pending",
    "live-replace-release",
    "live-replace-readiness",
    "live-replace-current",
    "live-cleanup-settlement",
    "live-delete-intent",
    "live-delete-mutation",
    "live-delete-readiness",
    "deployed-benchmark",
    "delete-intent",
    "delete-fault-arm",
    "delete-mutation",
    "delete-alarm-wait",
    "delete-response-loss",
    "delete-readiness",
    "deployed-lifecycle",
    "complete",
]);
const CONTROLLER_CHECKPOINTS = new Set(CLOUDFLARE_VECTORIZE_PROOF_CONTROLLER_CHECKPOINTS);

export class CloudflareVectorizeProofObservationTimeoutError extends Error {
    constructor(label, timeoutMs, elapsedMs, latestState) {
        super(`${label} timed out after ${timeoutMs}ms`);
        this.name = "CloudflareVectorizeProofObservationTimeoutError";
        this.evidence = assertCloudflareVectorizeProofObservationTimeoutEvidence({
            label,
            timeoutMs,
            elapsedMs,
            latestState,
        });
    }
}

export class CloudflareVectorizeProofCandidateClassificationError extends Error {
    constructor(message, classification) {
        super(message);
        this.name = "CloudflareVectorizeProofCandidateClassificationError";
        this.evidence = assertCloudflareVectorizeProofCandidateClassificationEvidence(classification);
    }
}

export function assertCloudflareVectorizeProofCandidateClassificationEvidence(value) {
    const evidence = object(value, "proof candidate classification evidence");
    check(
        JSON.stringify(Object.keys(evidence).sort()) ===
            JSON.stringify([
                "candidateCount",
                "currentPresent",
                "otherCandidateCount",
                "queryIdentityMatch",
                "stalePresent",
            ]),
        "proof candidate classification evidence fields are invalid",
        TypeError
    );
    check(
        Number.isSafeInteger(evidence.candidateCount) && evidence.candidateCount >= 0 && evidence.candidateCount <= 17,
        "proof candidate count is invalid",
        TypeError
    );
    check(
        Number.isSafeInteger(evidence.otherCandidateCount) &&
            evidence.otherCandidateCount >= 0 &&
            evidence.otherCandidateCount <= evidence.candidateCount,
        "proof other candidate count is invalid",
        TypeError
    );
    check(typeof evidence.stalePresent === "boolean", "proof stale candidate flag is invalid", TypeError);
    check(typeof evidence.currentPresent === "boolean", "proof current candidate flag is invalid", TypeError);
    check(typeof evidence.queryIdentityMatch === "boolean", "proof query identity match flag is invalid", TypeError);
    check(
        evidence.candidateCount ===
            Number(evidence.stalePresent) + Number(evidence.currentPresent) + evidence.otherCandidateCount,
        "proof candidate classification accounting drifted",
        TypeError
    );
    return Object.freeze({
        candidateCount: evidence.candidateCount,
        stalePresent: evidence.stalePresent,
        currentPresent: evidence.currentPresent,
        otherCandidateCount: evidence.otherCandidateCount,
        queryIdentityMatch: evidence.queryIdentityMatch,
    });
}

export function assertCloudflareVectorizeProofObservationTimeoutEvidence(value) {
    const evidence = object(value, "proof observation timeout evidence");
    check(
        JSON.stringify(Object.keys(evidence).sort()) ===
            JSON.stringify(["elapsedMs", "label", "latestState", "timeoutMs"]),
        "proof observation timeout evidence fields are invalid",
        TypeError
    );
    const label = text(evidence.label, "proof observation timeout label", 128);
    const timeoutMs = positiveInteger(evidence.timeoutMs, "proof observation timeout duration", 30 * 60_000);
    check(
        Number.isSafeInteger(evidence.elapsedMs) && evidence.elapsedMs >= 0,
        "proof observation elapsed time is invalid",
        TypeError
    );
    const latestState =
        evidence.latestState === null ? null : assertCloudflareVectorizeProofState(evidence.latestState);
    return Object.freeze({ label, timeoutMs, elapsedMs: evidence.elapsedMs, latestState });
}

function check(condition, message, ErrorType = Error) {
    if (!condition) throw new ErrorType(message);
}

function object(value, label) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    return value;
}

function exactPublicSearchResult(value, expectedRowPk) {
    if (!Array.isArray(value) || value.length !== 1) return false;
    const match = value[0];
    if (match === null || typeof match !== "object" || Array.isArray(match)) return false;
    return (
        JSON.stringify(Object.keys(match).sort()) === JSON.stringify(["rowPk", "score"]) &&
        match.rowPk === expectedRowPk &&
        typeof match.score === "number" &&
        Number.isFinite(match.score)
    );
}

function text(value, label, maximum = 256) {
    check(
        typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maximum,
        `${label} is invalid`,
        TypeError
    );
    return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
    check(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} is invalid`, TypeError);
    return value;
}

function retryableVectorStateRead(error) {
    return isCloudflareVectorizeProofRetryableStateRead(error);
}

function retryableHealthRead(error) {
    return (
        retryableVectorStateRead(error) ||
        (error instanceof CloudflareVectorizeProofHttpError && error.kind === "http" && error.status === 404)
    );
}

function retryableProofRead(error) {
    return (
        error instanceof CloudflareVectorizeProofHttpError &&
        (error.kind === "timeout" || error.kind === "network" || (error.kind === "http" && error.status >= 500))
    );
}

function version(value, label) {
    const item = object(value, label);
    check(item.percentage === 100, `${label} must receive 100 percent traffic`, TypeError);
    const deploymentId = text(item.deploymentId, `${label} deployment id`, 128);
    const versionId = text(item.versionId, `${label} version id`, 128);
    check(UUID.test(deploymentId) && UUID.test(versionId), `${label} requires immutable deployment and version ids`);
    return Object.freeze({
        deploymentId,
        versionId,
        number: positiveInteger(item.number, `${label} version number`),
        percentage: 100,
    });
}

function initialDelivery(state, physicalId) {
    check(Array.isArray(state.acceptances), "initial vector acceptance audit is missing");
    const accepted = state.acceptances.find(item => item.operation === "upsert" && item.physicalId === physicalId);
    check(accepted, "initial vector acceptance audit did not record the exact physical id");
    check(SHA256.test(accepted.payloadSha256), "initial vector payload hash is invalid");
    check(SHA256.test(accepted.mutationIdSha256), "initial vector mutation hash is invalid");
    return Object.freeze({
        physicalId,
        payloadSha256: accepted.payloadSha256,
        mutationIdSha256: accepted.mutationIdSha256,
    });
}

function replacementCleanupSettled(state, currentVersion) {
    if (state.attempts.length !== 1) return false;
    const currentAttempt = state.attempts[0];
    return (
        currentAttempt?.physicalVersion === currentVersion &&
        currentAttempt.visibilityConfirmed === true &&
        currentAttempt.deleteConfirmed === false
    );
}

function settlement(configuredMs, samplesMs, readinessEvidence) {
    positiveInteger(configuredMs, "configured settlement duration");
    check(Array.isArray(samplesMs) && samplesMs.length > 0, "settlement samples are missing");
    const samples = samplesMs.map((sample, index) => {
        check(
            typeof sample === "number" && Number.isFinite(sample) && sample >= 0,
            `settlement sample ${index} is invalid`
        );
        return sample;
    });
    const sorted = [...samples].sort((left, right) => left - right);
    const percentile = probability => sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
    const transientHttpFailureCounts = [];
    let transientHttpFailureCount = 0;
    let transientHttpFailureOverflowCount = 0;
    for (const [index, evidence] of readinessEvidence.entries()) {
        const observed = object(evidence, `readiness settlement ${index}`);
        check(
            Number.isSafeInteger(observed.transientHttpFailureCount) && observed.transientHttpFailureCount >= 0,
            `readiness settlement ${index} transient failure count is invalid`
        );
        check(
            Array.isArray(observed.transientHttpFailureCounts) && observed.transientHttpFailureCounts.length <= 16,
            `readiness settlement ${index} transient failure details are invalid`
        );
        check(
            Number.isSafeInteger(observed.transientHttpFailureOverflowCount) &&
                observed.transientHttpFailureOverflowCount >= 0,
            `readiness settlement ${index} transient failure overflow is invalid`
        );
        transientHttpFailureCount += observed.transientHttpFailureCount;
        transientHttpFailureOverflowCount += observed.transientHttpFailureOverflowCount;
        let recorded = 0;
        for (const failure of observed.transientHttpFailureCounts) {
            const item = object(failure, `readiness settlement ${index} transient failure`);
            check(
                item.status === null || (Number.isSafeInteger(item.status) && item.status >= 500 && item.status <= 599),
                `readiness settlement ${index} transient status is invalid`
            );
            check(
                item.status === null
                    ? item.code === null
                    : item.code === null ||
                          (typeof item.code === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.code)),
                `readiness settlement ${index} transient code is invalid`
            );
            check(
                Number.isSafeInteger(item.count) && item.count > 0,
                `readiness settlement ${index} transient count is invalid`
            );
            recorded += item.count;
            const existing = transientHttpFailureCounts.find(
                current => current.status === item.status && current.code === item.code
            );
            if (existing) {
                existing.count += item.count;
            } else if (transientHttpFailureCounts.length < 16) {
                transientHttpFailureCounts.push({ status: item.status, code: item.code, count: item.count });
            } else {
                transientHttpFailureOverflowCount += item.count;
            }
        }
        check(
            recorded + observed.transientHttpFailureOverflowCount === observed.transientHttpFailureCount,
            `readiness settlement ${index} transient failure accounting drifted`
        );
    }
    return Object.freeze({
        configuredMs,
        samplesMs: Object.freeze(samples),
        minMs: sorted[0],
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: sorted.at(-1),
        transientHttpFailureCount,
        transientHttpFailureCounts: Object.freeze(transientHttpFailureCounts.map(item => Object.freeze(item))),
        transientHttpFailureOverflowCount,
        hardBoundClaimed: false,
    });
}

function precomputedBenchmarkTrack(value, label) {
    const track = object(value, `${label} benchmark evidence`);
    check(track.workloadId === BENCHMARK_WORKLOAD_ID, `${label} benchmark workload drifted`);
    check(track.warmupExcluded === true && track.warmupCount === 1, `${label} benchmark warmup plan drifted`);
    const rawWarmup = track.warmup ?? { sequence: -1, excluded: true, elapsedMs: 0 };
    const warmup =
        rawWarmup.classification === undefined
            ? Object.freeze({
                  requestOrdinal: 0,
                  sequence: -1,
                  excluded: true,
                  classification: "exact",
                  status: null,
                  code: null,
                  elapsedMs: rawWarmup.elapsedMs,
              })
            : rawWarmup;
    check(
        warmup.requestOrdinal === 0 &&
            warmup.sequence === -1 &&
            warmup.excluded === true &&
            ["exact", "empty", "http-5xx", "timeout"].includes(warmup.classification) &&
            typeof warmup.elapsedMs === "number" &&
            Number.isFinite(warmup.elapsedMs) &&
            warmup.elapsedMs >= 0,
        `${label} benchmark warmup is invalid`
    );
    const sourceSamples = Array.isArray(track.samples)
        ? track.samples
        : Array.isArray(track.samplesMs)
          ? track.samplesMs.map((elapsedMs, index) => ({
                requestOrdinal: index + 1,
                sequence: index,
                excluded: false,
                classification: "exact",
                status: null,
                code: null,
                elapsedMs,
            }))
          : null;
    check(Array.isArray(sourceSamples) && sourceSamples.length === 5, `${label} benchmark requires five samples`);
    const samples = sourceSamples.map((sample, index) => {
        const raw = object(sample, `${label} benchmark sample ${index}`);
        const observation =
            raw.classification === undefined
                ? {
                      requestOrdinal: index + 1,
                      sequence: raw.sequence,
                      excluded: raw.excluded,
                      classification: "exact",
                      status: null,
                      code: null,
                      elapsedMs: raw.elapsedMs,
                  }
                : raw;
        check(
            observation.requestOrdinal === index + 1 &&
                observation.sequence === index &&
                observation.excluded === false &&
                (observation.classification === "exact" ||
                    observation.classification === "empty" ||
                    observation.classification === "http-5xx" ||
                    observation.classification === "timeout") &&
                typeof observation.elapsedMs === "number" &&
                Number.isFinite(observation.elapsedMs) &&
                observation.elapsedMs >= 0,
            `${label} benchmark sample ${index} is invalid`
        );
        return Object.freeze({ ...observation });
    });
    check(
        (track.exactMatchLatenciesMs === undefined || Array.isArray(track.exactMatchLatenciesMs)) &&
            JSON.stringify(track.exactMatchLatenciesMs ?? samples.map(sample => sample.elapsedMs)) ===
                JSON.stringify(
                    samples.filter(sample => sample.classification === "exact").map(sample => sample.elapsedMs)
                ),
        `${label} exact-match latency population drifted`
    );
    return Object.freeze({
        warmup: Object.freeze({ ...warmup }),
        samples: Object.freeze(samples),
        exactMatchLatenciesMs: Object.freeze([
            ...(track.exactMatchLatenciesMs ?? samples.map(sample => sample.elapsedMs)),
        ]),
    });
}

function queryStability(value, label) {
    const evidence = object(value, `${label} query stability evidence`);
    check(evidence.queryStabilityWindowMs === QUERY_STABILITY_WINDOW_MS, `${label} query stability window drifted`);
    check(
        evidence.queryStabilityIntervalMs === QUERY_STABILITY_INTERVAL_MS,
        `${label} query stability cadence drifted`
    );
    check(
        typeof evidence.queryStabilityObservedMs === "number" &&
            Number.isFinite(evidence.queryStabilityObservedMs) &&
            evidence.queryStabilityObservedMs >= QUERY_STABILITY_WINDOW_MS,
        `${label} query stability observation is incomplete`
    );
    for (const field of ["queryStabilityExactMatchCount", "queryStabilityResetCount", "queryStabilityNonExactCount"]) {
        check(Number.isSafeInteger(evidence[field]) && evidence[field] >= 0, `${label} ${field} is invalid`);
    }
    check(evidence.queryStabilityExactMatchCount > 0, `${label} query stability has no exact matches`);
    check(evidence.hardBoundClaimed === false, `${label} query stability cannot claim a platform bound`);
    return Object.freeze({
        queryStabilityWindowMs: QUERY_STABILITY_WINDOW_MS,
        queryStabilityIntervalMs: QUERY_STABILITY_INTERVAL_MS,
        queryStabilityObservedMs: evidence.queryStabilityObservedMs,
        queryStabilityExactMatchCount: evidence.queryStabilityExactMatchCount,
        queryStabilityResetCount: evidence.queryStabilityResetCount,
        queryStabilityNonExactCount: evidence.queryStabilityNonExactCount,
        hardBoundClaimed: false,
    });
}

function descriptorProof(value) {
    const body = object(value, "vector descriptor evidence");
    const descriptor = object(body.descriptor, "vector descriptor");
    const search = object(body.search, "vector search contract");
    check(descriptor.binding === "CDB_PROOF_VECTORS", "vector descriptor binding drifted");
    check(
        typeof descriptor.resourceDigest === "string" && SHA256.test(descriptor.resourceDigest),
        "vector resource digest is invalid"
    );
    check(descriptor.resourceId === `vr1_${descriptor.resourceDigest}`, "vector resource identity drifted");
    const expectedFilter = `r1_${Buffer.from(descriptor.resourceDigest, "hex").toString("base64url")}`;
    check(descriptor.resourceFilter === expectedFilter, "vector resource filter drifted from its descriptor digest");
    check(descriptor.dimensions === 32 && descriptor.metric === "cosine", "vector shape contract drifted");
    check(
        Array.isArray(descriptor.namespaceIds) && descriptor.namespaceIds.length === 2,
        "vector namespace evidence is incomplete"
    );
    check(new Set(descriptor.namespaceIds).size === 2, "vector namespaces did not differ");
    for (const namespaceId of descriptor.namespaceIds) {
        check(typeof namespaceId === "string" && NAMESPACE_ID.test(namespaceId), "vector namespace id is invalid");
        const encoded = namespaceId.slice("o1_".length);
        check(
            Buffer.from(encoded, "base64url").byteLength === 32 &&
                Buffer.from(encoded, "base64url").toString("base64url") === encoded,
            "vector namespace id is not canonical"
        );
    }
    for (const field of ["resourceFilter", "currentHeadOnly", "noRemoteValues", "noRemoteMetadata"]) {
        check(search[field] === true, `vector search contract ${field} is not proven`);
    }
    positiveInteger(body.settlementConfiguredMs, "configured settlement duration");
    return Object.freeze({
        descriptor: Object.freeze({
            binding: descriptor.binding,
            resourceDigest: descriptor.resourceDigest,
            resourceId: descriptor.resourceId,
            resourceFilter: descriptor.resourceFilter,
            dimensions: descriptor.dimensions,
            metric: descriptor.metric,
            namespaceIds: Object.freeze([...descriptor.namespaceIds]),
        }),
        search: Object.freeze({
            resourceFilter: true,
            currentHeadOnly: true,
            noRemoteValues: true,
            noRemoteMetadata: true,
        }),
        settlementConfiguredMs: body.settlementConfiguredMs,
    });
}

function exactIds(value, label) {
    check(Array.isArray(value) && value.length > 0 && value.length <= 512, `${label} is invalid`);
    const ids = value.map((id, index) => text(id, `${label} ${index}`, 64));
    check(new Set(ids).size === ids.length, `${label} contains duplicates`);
    return Object.freeze(ids);
}

function sameIds(left, right) {
    return left.length === right.length && left.every((id, index) => id === right[index]);
}

function assertReplacementNotAccepted(state, physicalIds, label) {
    const expected = new Set(physicalIds);
    check(
        !state.acceptances.some(acceptance => expected.has(acceptance.physicalId)),
        `${label} replacement was already accepted`
    );
}

function assertPreAcceptanceFault(fault, label) {
    check(
        fault.acceptedBeforeThrow === false &&
            fault.returnedMutationIdSha256 === null &&
            fault.retryCount === 0 &&
            fault.retryIdsMatched === null &&
            fault.retryPayloadMatched === null &&
            fault.retryComplete === false,
        `${label} fault is not in its pre-acceptance state`
    );
}

function heldClaim(state, intent, nowMs) {
    const head = object(state.head, "held vector head");
    const fault = object(state.fault, "held upsert fault");
    const outbox = object(state.outbox, "held vector outbox");
    check(
        head.state === "pending" &&
            head.version === intent.nextVersion &&
            head.deliveredVersion === intent.nextVersion - 1,
        "held vector head is not the pending replacement target"
    );
    check(fault.mode === "upsert_accept_then_throw", "held fault mode drifted");
    check(
        fault.armed === true && fault.inFlight === true && fault.fired === false,
        "upsert fault is not held in flight"
    );
    check(fault.gateOpen === false, "upsert fault gate opened before redeploy");
    check(Number.isSafeInteger(fault.gateDeadline) && fault.gateDeadline > nowMs, "upsert fault gate expired");
    check(outbox.operation === "upsert" && outbox.phase === "submit", "held vector claim is not an upsert submit");
    check(outbox.targetVersion === intent.nextVersion, "held vector claim target drifted");
    check(outbox.mutationIdSha256 === null && outbox.acceptedAt === null, "held vector claim was already accepted");
    check(outbox.leased === true, "held vector claim is not actively leased");
    check(SHA256.test(outbox.claimTokenSha256), "held vector claim hash is invalid");
    check(Number.isSafeInteger(outbox.leasedUntil) && outbox.leasedUntil > nowMs, "held vector claim lease expired");
    check(
        sameIds(exactIds(fault.firstPhysicalIds, "held physical ids"), intent.physicalIds),
        "held vector claim sent different physical ids"
    );
    check(SHA256.test(fault.firstPayloadSha256), "held vector payload hash is invalid");
    assertPreAcceptanceFault(fault, "held upsert");
    assertReplacementNotAccepted(state, intent.physicalIds, "held upsert");
    return Object.freeze({
        vectorId: state.vectorId,
        organizationId: head.organizationId,
        resourceId: head.resourceId,
        rowPk: head.rowPk,
        deliveredVersion: head.deliveredVersion,
        claimTokenSha256: outbox.claimTokenSha256,
        targetVersion: outbox.targetVersion,
        operation: outbox.operation,
        phase: outbox.phase,
        attempts: outbox.attempts,
        leasedUntil: outbox.leasedUntil,
        gateDeadline: fault.gateDeadline,
        physicalIds: Object.freeze([...intent.physicalIds]),
        payloadSha256: fault.firstPayloadSha256,
    });
}

function sameHeldIntent(state, held, nowMs) {
    const head = object(state.head, "post-redeploy vector head");
    const outbox = object(state.outbox, "post-redeploy vector outbox");
    const fault = object(state.fault, "post-redeploy upsert fault");
    check(
        state.vectorId === held.vectorId &&
            head.organizationId === held.organizationId &&
            head.resourceId === held.resourceId &&
            head.rowPk === held.rowPk &&
            head.state === "pending" &&
            head.version === held.targetVersion &&
            head.deliveredVersion === held.deliveredVersion,
        "vector head identity changed across redeploy"
    );
    check(outbox.targetVersion === held.targetVersion, "vector claim target changed across redeploy");
    check(
        outbox.operation === held.operation && outbox.phase === held.phase,
        "vector claim operation changed across redeploy"
    );
    check(
        outbox.mutationIdSha256 === null && outbox.acceptedAt === null,
        "vector claim was accepted before redeploy continuity was checked"
    );
    check(outbox.attempts >= held.attempts, "vector delivery attempts moved backward across redeploy");
    check(fault.mode === "upsert_accept_then_throw", "held fault mode changed across redeploy");
    check(
        fault.armed === true &&
            fault.inFlight === true &&
            fault.fired === false &&
            fault.gateOpen === false &&
            fault.gateDeadline === held.gateDeadline &&
            fault.gateDeadline > nowMs,
        "held fault changed across redeploy"
    );
    check(
        sameIds(exactIds(fault.firstPhysicalIds, "post-redeploy physical ids"), held.physicalIds),
        "vector physical ids changed across redeploy"
    );
    check(fault.firstPayloadSha256 === held.payloadSha256, "vector payload changed across redeploy");
    assertPreAcceptanceFault(fault, "post-redeploy upsert");
    assertReplacementNotAccepted(state, held.physicalIds, "post-redeploy upsert");
    const hasLeaseIdentity = outbox.claimTokenSha256 !== null && outbox.leasedUntil !== null;
    check(
        hasLeaseIdentity === (outbox.claimTokenSha256 !== null || outbox.leasedUntil !== null),
        "post-redeploy lease identity is incomplete"
    );
    check(outbox.leased !== true || hasLeaseIdentity, "post-redeploy active lease has no identity");
    if (hasLeaseIdentity && outbox.leased === false) {
        check(outbox.leasedUntil <= nowMs, "post-redeploy inactive lease has a future deadline");
    }
    const originalIdentity =
        outbox.claimTokenSha256 === held.claimTokenSha256 && outbox.leasedUntil === held.leasedUntil;
    const active = outbox.leased === true && outbox.leasedUntil > nowMs;
    const leaseState = active
        ? originalIdentity
            ? "active-original"
            : "active-reclaimed"
        : originalIdentity
          ? "expired-original"
          : "unleased";
    return Object.freeze({
        leaseState,
    });
}

export function createCloudflareVectorizeProofController(dependencies) {
    const deps = object(dependencies, "proof controller dependencies");
    const lifecycle = object(deps.lifecycle, "proof lifecycle");
    check(typeof deps.appendOwnedIds === "function", "appendOwnedIds callback is required", TypeError);
    check(typeof deps.redeploy === "function", "redeploy callback is required", TypeError);
    check(typeof deps.releaseFault === "function", "releaseFault callback is required", TypeError);
    check(
        deps.recordDeployedLifecycle === undefined || typeof deps.recordDeployedLifecycle === "function",
        "deployed lifecycle recorder is invalid",
        TypeError
    );
    check(
        deps.loadComparisonBenchmark === undefined || typeof deps.loadComparisonBenchmark === "function",
        "comparison benchmark loader is invalid",
        TypeError
    );
    check(
        deps.checkpoint === undefined || typeof deps.checkpoint === "function",
        "checkpoint callback is invalid",
        TypeError
    );
    const now = deps.now ?? (() => Date.now());
    const sleep = deps.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const publicFilterStabilityWindowMs = deps.publicFilterStabilityWindowMs ?? QUERY_STABILITY_WINDOW_MS;
    check(
        Number.isSafeInteger(publicFilterStabilityWindowMs) &&
            publicFilterStabilityWindowMs >= 0 &&
            publicFilterStabilityWindowMs <= QUERY_STABILITY_WINDOW_MS,
        "public filter stability window is invalid",
        TypeError
    );
    const publicFilterRequiredCorrelatedObservations =
        Math.ceil(publicFilterStabilityWindowMs / QUERY_STABILITY_INTERVAL_MS) + 1;
    const checkpoint = async value => {
        check(CONTROLLER_CHECKPOINTS.has(value), "proof controller checkpoint is invalid");
        await deps.checkpoint?.(value);
    };

    const boundedRead = async (read, accept, retryable, label, timeoutMs, intervalMs, timeoutError) => {
        const started = Number(now());
        const deadline = started + timeoutMs;
        const maximumTurns = Math.ceil(timeoutMs / intervalMs) + 2;
        let lastTransientError;
        let lastReadWasTransient = false;
        let lastValue;
        for (let turn = 0; turn < maximumTurns; turn++) {
            let value;
            try {
                value = await read();
                lastValue = value;
                lastReadWasTransient = false;
            } catch (error) {
                if (!retryable(error)) throw error;
                lastTransientError = error;
                lastReadWasTransient = true;
                if (Number(now()) >= deadline) break;
                await sleep(Math.min(intervalMs, Math.max(0, deadline - Number(now()))));
                continue;
            }
            const result = accept(value);
            if (result) return Object.freeze({ value, result, elapsedMs: Math.max(0, Number(now()) - started) });
            if (Number(now()) >= deadline) break;
            await sleep(Math.min(intervalMs, Math.max(0, deadline - Number(now()))));
        }
        const elapsedMs = Math.max(0, Number(now()) - started);
        if (lastReadWasTransient && lastTransientError && lastValue === undefined) throw lastTransientError;
        if (timeoutError) throw timeoutError(lastValue ?? null, elapsedMs);
        if (lastReadWasTransient && lastTransientError) throw lastTransientError;
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
    };

    const readHealth = async (input, timeoutMs, intervalMs) =>
        (
            await boundedRead(
                () => lifecycle.health(input),
                () => true,
                retryableHealthRead,
                "proof health readiness",
                timeoutMs,
                intervalMs
            )
        ).value;

    const poll = async (input, predicate, label) => {
        const timeoutMs = positiveInteger(input.timeoutMs, `${label} timeout`, 30 * 60_000);
        const intervalMs = positiveInteger(input.intervalMs, `${label} interval`, timeoutMs);
        const result = await boundedRead(
            () => lifecycle.vectorState(input),
            predicate,
            retryableVectorStateRead,
            label,
            timeoutMs,
            intervalMs,
            (latestState, elapsedMs) =>
                new CloudflareVectorizeProofObservationTimeoutError(label, timeoutMs, elapsedMs, latestState)
        );
        return Object.freeze({ state: result.value, result: result.result, elapsedMs: result.elapsedMs });
    };

    const readVectorState = async (input, label) => (await poll(input, () => true, label)).state;

    const appendIntent = async (intent, action) => {
        const ids = exactIds(intent.physicalIds, `${action} intent physical ids`);
        await deps.appendOwnedIds(
            Object.freeze({ vectorId: intent.vectorId, action, nextVersion: intent.nextVersion, physicalIds: ids })
        );
        return ids;
    };

    const run = async input => {
        const origin = input.origin;
        const admin = object(input.admin, "proof admin");
        const timeoutMs = positiveInteger(input.timeoutMs ?? 120_000, "controller timeout", 30 * 60_000);
        const intervalMs = positiveInteger(input.intervalMs ?? 1_000, "controller interval", timeoutMs);
        await checkpoint("health");
        const health = await readHealth({ origin, releaseSha256: input.releaseSha256 }, timeoutMs, intervalMs);
        await checkpoint("migration");
        const migrationFirst = await lifecycle.migrateV0ToV1({
            origin,
            adminToken: admin.token,
            migrationId: input.migrationId,
            timeoutMs,
            intervalMs,
        });
        const migrationRetry = await lifecycle.migrateV0ToV1({
            origin,
            adminToken: admin.token,
            migrationId: input.migrationId,
            timeoutMs,
            intervalMs,
        });
        check(
            migrationFirst.beforeVersion === 0 &&
                migrationFirst.beforeEpoch === 1 &&
                migrationFirst.targetVersion === 1 &&
                migrationFirst.afterVersion === 1 &&
                migrationFirst.afterEpoch === 2 &&
                migrationFirst.idempotentRetry === false,
            "migration did not activate version 1 epoch 2 from version 0 epoch 1"
        );
        check(
            migrationRetry.beforeVersion === 1 &&
                migrationRetry.beforeEpoch === 2 &&
                migrationRetry.targetVersion === 1 &&
                migrationRetry.afterVersion === 1 &&
                migrationRetry.afterEpoch === 2 &&
                migrationRetry.idempotentRetry === true,
            "migration retry did not prove unchanged version 1 epoch 2 state"
        );
        const migration = Object.freeze({
            beforeVersion: migrationFirst.beforeVersion,
            targetVersion: migrationFirst.targetVersion,
            afterVersion: migrationFirst.afterVersion,
            beforeEpoch: migrationFirst.beforeEpoch,
            afterEpoch: migrationFirst.afterEpoch,
            idempotentRetry: true,
        });
        await checkpoint("organization-setup");
        const setup = await lifecycle.setupOrganizations({
            origin,
            admin,
            owningName: input.owningName,
            owningSlug: input.owningSlug,
            isolatedName: input.isolatedName,
            isolatedSlug: input.isolatedSlug,
        });
        const mutationIds = vectorProofMutationIds(input.mutationRunId);
        await checkpoint("descriptor");
        const descriptorResult = await lifecycle.requestJson({
            origin,
            path: "/proof/vector-descriptor",
            method: "POST",
            headers: {
                authorization: `Bearer ${admin.token}`,
                "x-chardb-proof-run-id": admin.runId,
            },
            body: {
                organizationIds: [setup.owningOrganizationId, setup.isolatedOrganizationId],
            },
            label: "vector descriptor evidence",
        });
        const descriptor = descriptorProof(descriptorResult.body);
        const proofInput = {
            origin,
            admin,
            organizationId: setup.owningOrganizationId,
            timeoutMs,
            intervalMs,
        };
        const documentId = text(input.documentId, "proof document id", 128);

        await checkpoint("create-intent");
        const createIntent = await lifecycle.vectorIntent({ ...proofInput, id: documentId, action: "create" });
        const createIds = await appendIntent(createIntent, "create");
        await checkpoint("create-mutation");
        const created = object(
            await lifecycle.mutateVector({
                origin,
                principal: setup.owner,
                action: "create",
                id: documentId,
                organizationId: setup.owningOrganizationId,
                mutId: mutationIds.create,
                text: input.initialText,
                values: input.initialValues,
            }),
            "initial vector mutation result"
        );
        check(created.vectorId === createIntent.vectorId, "initial vector mutation identity drifted from its intent");
        await checkpoint("create-readiness");
        const initialReady = await lifecycle.pollReady({
            ...proofInput,
            vectorId: createIntent.vectorId,
            version: createIntent.nextVersion,
            requiredPhases: ["verify"],
        });
        const initial = initialDelivery(initialReady.state, createIds[0]);
        await checkpoint("create-isolation");
        const isolation = await lifecycle.proveNamespaceIsolation({
            origin,
            owner: setup.owner,
            member: setup.member,
            owningOrganizationId: setup.owningOrganizationId,
            isolatedOrganizationId: setup.isolatedOrganizationId,
            vectorId: createIntent.vectorId,
            expectedRowPk: documentId,
            values: input.initialValues,
            timeoutMs,
            intervalMs,
        });

        await checkpoint("replace-intent");
        const replaceIntent = await lifecycle.vectorIntent({ ...proofInput, id: documentId, action: "replace" });
        check(replaceIntent.vectorId === createIntent.vectorId, "replace intent changed logical vector identity");
        const replaceIds = await appendIntent(replaceIntent, "replace");
        await checkpoint("replace-fault-arm");
        await lifecycle.armFault({
            ...proofInput,
            vectorId: replaceIntent.vectorId,
            mode: "upsert_accept_then_throw",
        });
        await checkpoint("replace-mutation");
        const replaced = object(
            await lifecycle.mutateVector({
                origin,
                principal: setup.owner,
                action: "replace",
                id: documentId,
                organizationId: setup.owningOrganizationId,
                mutId: mutationIds.replace,
                text: input.replacementText,
                values: input.replacementValues,
            }),
            "replacement vector mutation result"
        );
        check(
            replaced.vectorId === replaceIntent.vectorId,
            "replacement vector mutation identity drifted from its intent"
        );

        await checkpoint("replace-held-claim");
        const held = await poll(
            { ...proofInput, vectorId: replaceIntent.vectorId },
            state => {
                if (!state.fault?.inFlight || !state.outbox?.leased) return false;
                return heldClaim(state, replaceIntent, Number(now()));
            },
            "held vector claim"
        );
        await checkpoint("redeploy");
        const initialVersion = version(input.initialVersion, "initial Worker version");
        const redeployedVersion = version(
            await deps.redeploy(Object.freeze({ state: held.state, claim: held.result, initialVersion })),
            "redeployed Worker version"
        );
        check(redeployedVersion.deploymentId !== initialVersion.deploymentId, "redeploy did not change deployment id");
        check(redeployedVersion.versionId !== initialVersion.versionId, "redeploy did not change version id");
        check(redeployedVersion.number > initialVersion.number, "redeploy version number did not advance");
        const afterRedeploy = await readVectorState(
            { ...proofInput, vectorId: replaceIntent.vectorId },
            "post-redeploy vector state"
        );
        const redeployContinuity = sameHeldIntent(afterRedeploy, held.result, Number(now()));
        await checkpoint("fault-release");
        const released = object(
            await deps.releaseFault(Object.freeze({ state: afterRedeploy, claim: held.result })),
            "fault release result"
        );
        check(
            released.released === true && released.gateDeadline === held.result.gateDeadline,
            "fault release identity drifted"
        );

        await checkpoint("replace-response-loss");
        await poll(
            { ...proofInput, vectorId: replaceIntent.vectorId },
            state => {
                const fault = state.fault;
                if (fault?.fired === true && fault.acceptedBeforeThrow === true && !fault.inFlight) return state;
                if (fault && fault.armed === false && fault.inFlight === false) {
                    throw new Error("held upsert fault cleared without proving accepted response loss");
                }
                return false;
            },
            "accepted upsert response loss"
        );
        await checkpoint("replace-readiness");
        const replacementReady = await lifecycle.pollReady({
            ...proofInput,
            vectorId: replaceIntent.vectorId,
            version: replaceIntent.nextVersion,
            requiredPhases: ["submit", "verify"],
        });
        const upsertState = await readVectorState(
            { ...proofInput, vectorId: replaceIntent.vectorId },
            "upsert response-loss vector state"
        );
        check(upsertState.fault?.retryComplete === true, "upsert response-loss retry did not complete");
        await checkpoint("replace-isolation");
        const currentIsolation = await lifecycle.proveNamespaceIsolation({
            origin,
            owner: setup.owner,
            member: setup.member,
            owningOrganizationId: setup.owningOrganizationId,
            isolatedOrganizationId: setup.isolatedOrganizationId,
            vectorId: replaceIntent.vectorId,
            expectedRowPk: documentId,
            values: input.replacementValues,
            timeoutMs,
            intervalMs: QUERY_STABILITY_INTERVAL_MS,
            stabilityWindowMs: QUERY_STABILITY_WINDOW_MS,
        });

        await checkpoint("adversary-settlement");
        await poll(
            { ...proofInput, vectorId: replaceIntent.vectorId },
            state => {
                if (
                    state.head?.state !== "ready" ||
                    state.head.version !== replaceIntent.nextVersion ||
                    state.head.deliveredVersion !== replaceIntent.nextVersion ||
                    state.outbox !== null
                ) {
                    return false;
                }
                return replacementCleanupSettled(state, replaceIntent.nextVersion);
            },
            "superseded vector cleanup"
        );
        const adversaryInput = Object.freeze({
            origin,
            admin,
            organizationId: setup.owningOrganizationId,
            id: documentId,
            staleValues: input.initialValues,
            currentValues: input.replacementValues,
        });
        const pollProvider = async (values, accept, label) =>
            boundedRead(
                () => lifecycle.queryVectorAdversary({ ...adversaryInput, values }),
                accept,
                retryableProofRead,
                label,
                timeoutMs,
                intervalMs
            );
        await checkpoint("adversary-apply");
        let applied;
        let injectedProvider;
        let publicStaleObservation;
        let restored;
        let restoredProvider;
        let adversaryError;
        let restoreCheckpointError;
        let restoreError;
        try {
            applied = await lifecycle.mutateVectorAdversary({ ...adversaryInput, action: "apply" });
            check(applied.vectorId === replaceIntent.vectorId, "vector adversary apply changed logical identity");
            injectedProvider = await pollProvider(
                input.initialValues,
                value => {
                    const ids = new Set(value.matches.map(match => match.physicalId));
                    return ids.has(value.stalePhysicalId) && !ids.has(value.currentPhysicalId);
                },
                "injected stale Vectorize candidate"
            );
            await checkpoint("adversary-filter");
            const publicFilterStartedAt = Number(now());
            const publicFilterDeadline = publicFilterStartedAt + timeoutMs;
            const publicFilterMaximumTurns = Math.ceil(timeoutMs / QUERY_STABILITY_INTERVAL_MS) + 2;
            let publicFilterAttempts = 0;
            let publicFilterStaleEmptyObservationCount = 0;
            let publicFilterStableEmptyCount = 0;
            let publicFilterPreviousCurrentViewCount = 0;
            let publicFilterMixedCurrentResetCount = 0;
            let publicFilterProviderMissCount = 0;
            let publicFilterTransientFailureCount = 0;
            let publicFilterStabilityResetCount = 0;
            let publicFilterQuerySha256;
            let publicFilterFinalCandidateSetSha256;
            for (let turn = 0; turn < publicFilterMaximumTurns; turn++) {
                if (turn > 0 && Number(now()) >= publicFilterDeadline) break;
                let matches;
                let audit;
                try {
                    const cursor = await lifecycle.vectorSearchAudit({
                        ...adversaryInput,
                        action: "cursor",
                        values: input.initialValues,
                    });
                    matches = await lifecycle.search({
                        origin,
                        principal: setup.owner,
                        organizationId: setup.owningOrganizationId,
                        values: input.initialValues,
                        limit: 1,
                    });
                    audit = await lifecycle.vectorSearchAudit({
                        ...adversaryInput,
                        action: "observe",
                        afterSequence: cursor.sequence,
                        values: input.initialValues,
                    });
                } catch (error) {
                    if (!retryableProofRead(error)) throw error;
                    publicFilterTransientFailureCount++;
                    if (publicFilterStableEmptyCount > 0) publicFilterStabilityResetCount++;
                    publicFilterStableEmptyCount = 0;
                    if (Number(now()) >= publicFilterDeadline) break;
                    await sleep(
                        Math.min(QUERY_STABILITY_INTERVAL_MS, Math.max(0, publicFilterDeadline - Number(now())))
                    );
                    continue;
                }
                publicFilterAttempts++;
                check(audit.candidateSetSha256, "public stale-filter audit omitted its candidate-set digest");
                if (publicFilterQuerySha256 === undefined) publicFilterQuerySha256 = audit.querySha256;
                check(
                    audit.querySha256 === publicFilterQuerySha256,
                    "public stale-filter audit query identity changed across observations"
                );
                const exactPublic = exactPublicSearchResult(matches, documentId);
                check(matches.length === 0 || exactPublic, "public stale-filter search returned a non-exact result");
                check(audit.otherCandidateCount === 0, "public stale-filter audit returned an unrelated candidate");
                if (audit.stalePresent && audit.currentPresent) {
                    check(
                        audit.candidateCount === 2 && exactPublic,
                        "public stale-filter mixed provider view did not preserve the exact current row"
                    );
                    publicFilterMixedCurrentResetCount++;
                    publicFilterStabilityResetCount++;
                    publicFilterStableEmptyCount = 0;
                } else if (audit.stalePresent) {
                    check(
                        audit.candidateCount === 1,
                        "public stale-filter audit did not isolate the stale physical candidate"
                    );
                    check(!exactPublic, "public search returned the exact stale physical candidate batch");
                    publicFilterStaleEmptyObservationCount++;
                    publicFilterStableEmptyCount++;
                    publicFilterFinalCandidateSetSha256 = audit.candidateSetSha256;
                    if (publicFilterStableEmptyCount >= publicFilterRequiredCorrelatedObservations) break;
                } else if (audit.currentPresent) {
                    check(
                        audit.candidateCount === 1 && exactPublic,
                        "public search did not preserve an audited previous current view"
                    );
                    publicFilterPreviousCurrentViewCount++;
                    if (publicFilterStableEmptyCount > 0) publicFilterStabilityResetCount++;
                    publicFilterStableEmptyCount = 0;
                } else {
                    check(
                        audit.candidateCount === 0 && matches.length === 0,
                        "public stale-filter audit candidate accounting drifted"
                    );
                    publicFilterProviderMissCount++;
                    if (publicFilterStableEmptyCount > 0) publicFilterStabilityResetCount++;
                    publicFilterStableEmptyCount = 0;
                }
                if (Number(now()) >= publicFilterDeadline || turn === publicFilterMaximumTurns - 1) break;
                await sleep(Math.min(QUERY_STABILITY_INTERVAL_MS, Math.max(0, publicFilterDeadline - Number(now()))));
            }
            const publicFilterElapsedMs = Math.max(0, Number(now()) - publicFilterStartedAt);
            const publicFilterStabilityObservedMs = Math.max(
                0,
                (publicFilterStableEmptyCount - 1) * QUERY_STABILITY_INTERVAL_MS
            );
            check(
                publicFilterStabilityObservedMs >= publicFilterStabilityWindowMs &&
                    publicFilterStableEmptyCount >= publicFilterRequiredCorrelatedObservations &&
                    SHA256.test(publicFilterQuerySha256 ?? "") &&
                    SHA256.test(publicFilterFinalCandidateSetSha256 ?? ""),
                `public stale-candidate filtering stability timed out after ${timeoutMs}ms`
            );
            publicStaleObservation = Object.freeze({
                elapsedMs: publicFilterElapsedMs,
                attempts: publicFilterAttempts,
                staleEmptyObservationCount: publicFilterStaleEmptyObservationCount,
                stableEmptyCount: publicFilterStableEmptyCount,
                previousCurrentViewCount: publicFilterPreviousCurrentViewCount,
                mixedCurrentResetCount: publicFilterMixedCurrentResetCount,
                providerMissCount: publicFilterProviderMissCount,
                transientFailureCount: publicFilterTransientFailureCount,
                stabilityResetCount: publicFilterStabilityResetCount,
                stabilityWindowMs: publicFilterStabilityWindowMs,
                stabilityObservedMs: publicFilterStabilityObservedMs,
                observationIntervalMs: QUERY_STABILITY_INTERVAL_MS,
                querySha256: publicFilterQuerySha256,
                finalCandidateSetSha256: publicFilterFinalCandidateSetSha256,
                hardBoundClaimed: false,
            });
        } catch (error) {
            adversaryError = error;
        } finally {
            try {
                await checkpoint("adversary-restore");
            } catch (error) {
                restoreCheckpointError = error;
            }
            try {
                restored = await lifecycle.mutateVectorAdversary({ ...adversaryInput, action: "restore" });
                check(
                    restored.vectorId === replaceIntent.vectorId,
                    "vector adversary restore changed logical identity"
                );
                restoredProvider = await pollProvider(
                    input.replacementValues,
                    value => {
                        const ids = new Set(value.matches.map(match => match.physicalId));
                        return ids.has(value.currentPhysicalId) && !ids.has(value.stalePhysicalId);
                    },
                    "restored current Vectorize candidate"
                );
            } catch (error) {
                restoreError = error;
            }
        }
        const adversaryFailures = [adversaryError, restoreCheckpointError, restoreError].filter(
            error => error !== undefined
        );
        if (adversaryFailures.length > 1) {
            throw new AggregateError(adversaryFailures, "vector adversary execution and restoration failed");
        }
        if (adversaryFailures.length === 1) throw adversaryFailures[0];
        check(
            applied && injectedProvider && publicStaleObservation && restored && restoredProvider,
            "vector adversary evidence is incomplete"
        );
        await checkpoint("adversary-policy");
        let publicOwnerAttempts = 0;
        let publicOwnerEmptyReadCount = 0;
        let publicOwnerStaleFilteredReadCount = 0;
        let publicOwnerMixedCurrentReadCount = 0;
        let publicOwnerTransientFailureCount = 0;
        let publicOwnerQuerySha256;
        const publicOwnerObservation = await boundedRead(
            async () => {
                publicOwnerAttempts++;
                try {
                    const cursor = await lifecycle.vectorSearchAudit({
                        ...adversaryInput,
                        action: "cursor",
                        values: input.replacementValues,
                    });
                    const matches = await lifecycle.search({
                        origin,
                        principal: setup.owner,
                        organizationId: setup.owningOrganizationId,
                        values: input.replacementValues,
                        limit: 1,
                    });
                    const audit = await lifecycle.vectorSearchAudit({
                        ...adversaryInput,
                        action: "observe",
                        afterSequence: cursor.sequence,
                        values: input.replacementValues,
                    });
                    return Object.freeze({ matches, audit });
                } catch (error) {
                    if (retryableProofRead(error)) publicOwnerTransientFailureCount++;
                    throw error;
                }
            },
            observation => {
                const { matches, audit } = observation;
                const exact = exactPublicSearchResult(matches, documentId);
                check(matches.length === 0 || exact, "restored public owner search returned a non-exact result");
                const queryIdentityMatch =
                    publicOwnerQuerySha256 === undefined || audit.querySha256 === publicOwnerQuerySha256;
                const classification = {
                    candidateCount: audit.candidateCount,
                    stalePresent: audit.stalePresent,
                    currentPresent: audit.currentPresent,
                    otherCandidateCount: audit.otherCandidateCount,
                    queryIdentityMatch,
                };
                if (audit.otherCandidateCount !== 0) {
                    throw new CloudflareVectorizeProofCandidateClassificationError(
                        "restored public owner audit returned an unrelated candidate",
                        classification
                    );
                }
                if (publicOwnerQuerySha256 === undefined) publicOwnerQuerySha256 = audit.querySha256;
                if (!queryIdentityMatch) {
                    throw new CloudflareVectorizeProofCandidateClassificationError(
                        "restored public owner audit query identity changed across observations",
                        classification
                    );
                }
                if (audit.stalePresent) {
                    if (audit.currentPresent) {
                        if (audit.candidateCount !== 2 || !exact) {
                            throw new CloudflareVectorizeProofCandidateClassificationError(
                                "restored public owner mixed provider view did not preserve the exact current row",
                                classification
                            );
                        }
                        publicOwnerMixedCurrentReadCount++;
                        return false;
                    }
                    check(
                        audit.candidateCount === 1,
                        "restored public owner audit did not isolate the stale physical candidate"
                    );
                    check(matches.length === 0, "restored public owner search exposed the stale physical candidate");
                    publicOwnerStaleFilteredReadCount++;
                    return false;
                }
                if (audit.currentPresent) {
                    check(
                        audit.candidateCount === 1 && exact,
                        "restored public owner search did not preserve its exact current candidate batch"
                    );
                    return audit;
                }
                check(
                    audit.candidateCount === 0 && matches.length === 0,
                    "restored public owner audit candidate accounting drifted"
                );
                publicOwnerEmptyReadCount++;
                return false;
            },
            retryableProofRead,
            "restored public owner search",
            timeoutMs,
            intervalMs
        );
        const memberCursor = await lifecycle.vectorSearchAudit({
            ...adversaryInput,
            action: "cursor",
            values: input.replacementValues,
        });
        const memberCurrentMatches = await lifecycle.search({
            origin,
            principal: setup.owningMember,
            organizationId: setup.owningOrganizationId,
            values: input.replacementValues,
            limit: 1,
        });
        const memberAudit = await lifecycle.vectorSearchAudit({
            ...adversaryInput,
            action: "observe",
            afterSequence: memberCursor.sequence,
            values: input.replacementValues,
        });
        check(
            memberAudit.candidateCount === 1 &&
                memberAudit.currentPresent === true &&
                memberAudit.stalePresent === false &&
                memberAudit.otherCandidateCount === 0,
            "member policy search did not receive the exact current physical candidate batch"
        );
        check(memberCurrentMatches.length === 0, "member search returned a policy-hidden vector candidate");
        const adversarialFiltering = Object.freeze({
            provider: "cloudflare-vectorize",
            realVectorize: true,
            syntheticMatches: false,
            vectorIdSha256: sha256(applied.vectorId),
            stalePhysicalIdSha256: sha256(applied.stalePhysicalId),
            currentPhysicalIdSha256: sha256(applied.currentPhysicalId),
            apply: Object.freeze({
                staleUpsertMutationIdSha256: applied.upsertMutationIdSha256,
                currentDeleteMutationIdSha256: applied.deleteMutationIdSha256,
            }),
            injected: Object.freeze({
                providerQueryTopK: 17,
                rawStaleObserved: true,
                rawCurrentAbsent: true,
                rawObservationElapsedMs: injectedProvider.elapsedMs,
                publicTargetReturned: false,
                publicObservation: publicStaleObservation,
            }),
            restore: Object.freeze({
                currentUpsertMutationIdSha256: restored.upsertMutationIdSha256,
                staleDeleteMutationIdSha256: restored.deleteMutationIdSha256,
                rawCurrentObserved: true,
                rawStaleAbsent: true,
                rawObservationElapsedMs: restoredProvider.elapsedMs,
                publicOwnerTargetReturned: true,
                publicOwnerObservation: Object.freeze({
                    elapsedMs: publicOwnerObservation.elapsedMs,
                    attempts: publicOwnerAttempts,
                    emptyReadCount: publicOwnerEmptyReadCount,
                    staleFilteredReadCount: publicOwnerStaleFilteredReadCount,
                    mixedCurrentReadCount: publicOwnerMixedCurrentReadCount,
                    transientFailureCount: publicOwnerTransientFailureCount,
                    querySha256: publicOwnerObservation.result.querySha256,
                    candidateSetSha256: publicOwnerObservation.result.candidateSetSha256,
                    hardBoundClaimed: false,
                }),
            }),
            policy: Object.freeze({
                kind: "vector-column-read-denied",
                role: "member",
                rawCurrentObserved: true,
                publicOwnerTargetReturned: true,
                publicMemberTargetReturned: false,
                exactCurrentCandidateBatch: true,
                candidateSetSha256: memberAudit.candidateSetSha256,
            }),
        });

        const liveDocumentId = text(input.liveDocumentId, "live vector document id", 128);
        check(liveDocumentId !== documentId, "live vector document must differ from the lifecycle document");
        for (const [label, values] of [
            ["live initial", input.liveInitialValues],
            ["live replacement", input.liveReplacementValues],
            ["live query", input.liveQueryValues],
        ]) {
            check(
                Array.isArray(values) && values.length === 32 && values.every(Number.isFinite),
                `${label} values must contain 32 finite numbers`,
                TypeError
            );
        }
        await checkpoint("live-create-intent");
        const liveCreateIntent = await lifecycle.vectorIntent({
            ...proofInput,
            id: liveDocumentId,
            action: "create",
        });
        check(liveCreateIntent.vectorId !== createIntent.vectorId, "live vector reused the lifecycle vector identity");
        const liveCreateIds = await appendIntent(liveCreateIntent, "create");
        check(liveCreateIds.length === 1, "live vector create intent must own one physical id");
        await checkpoint("live-create-mutation");
        const liveCreated = object(
            await lifecycle.mutateVector({
                origin,
                principal: setup.owner,
                action: "create",
                id: liveDocumentId,
                organizationId: setup.owningOrganizationId,
                mutId: mutationIds.liveCreate,
                text: input.liveInitialText,
                values: input.liveInitialValues,
            }),
            "live vector create result"
        );
        check(liveCreated.vectorId === liveCreateIntent.vectorId, "live vector create identity drifted");
        await checkpoint("live-create-readiness");
        await lifecycle.pollReady({
            ...proofInput,
            vectorId: liveCreateIntent.vectorId,
            version: liveCreateIntent.nextVersion,
            requiredPhases: ["verify"],
        });

        await checkpoint("live-subscribe");
        let liveProbe = await lifecycle.openLiveVectorSubscription({
            origin,
            principal: setup.owner,
            organizationId: setup.owningOrganizationId,
            expectedRowPk: liveDocumentId,
            expectedPendingFallbackRowPk: documentId,
            values: input.liveQueryValues,
            clientId: text(input.liveClientId, "live vector client id", 128),
            timeoutMs,
        });
        let liveSdkEvidence;
        let liveReplaceIntent;
        let liveReplaceIds;
        let liveHeld;
        let livePending;
        let liveReady;
        let liveCurrent;
        try {
            await checkpoint("live-reconnect");
            await liveProbe.reconnect();
            await checkpoint("live-replace-intent");
            liveReplaceIntent = await lifecycle.vectorIntent({
                ...proofInput,
                id: liveDocumentId,
                action: "replace",
            });
            check(
                liveReplaceIntent.vectorId === liveCreateIntent.vectorId,
                "live replacement changed logical vector identity"
            );
            liveReplaceIds = await appendIntent(liveReplaceIntent, "replace");
            check(liveReplaceIds.length === 1, "live vector replacement intent must own one physical id");
            await checkpoint("live-replace-fault-arm");
            await lifecycle.armFault({
                ...proofInput,
                vectorId: liveReplaceIntent.vectorId,
                mode: "upsert_accept_then_throw",
            });
            liveProbe.beginReplacement();
            await checkpoint("live-replace-mutation");
            const liveReplaced = object(
                await lifecycle.mutateVector({
                    origin,
                    principal: setup.owner,
                    action: "replace",
                    id: liveDocumentId,
                    organizationId: setup.owningOrganizationId,
                    mutId: mutationIds.liveReplace,
                    text: input.liveReplacementText,
                    values: input.liveReplacementValues,
                }),
                "live vector replacement result"
            );
            check(liveReplaced.vectorId === liveReplaceIntent.vectorId, "live vector replacement identity drifted");
            await checkpoint("live-replace-pending");
            liveHeld = await poll(
                { ...proofInput, vectorId: liveReplaceIntent.vectorId },
                state => {
                    if (!state.fault?.inFlight || !state.outbox?.leased) return false;
                    return heldClaim(state, liveReplaceIntent, Number(now()));
                },
                "held live vector claim"
            );
            livePending = await liveProbe.waitForPending();
            liveProbe.assertPending();
            const livePendingState = await readVectorState(
                { ...proofInput, vectorId: liveReplaceIntent.vectorId },
                "pending live vector state"
            );
            sameHeldIntent(livePendingState, liveHeld.result, Number(now()));
            liveProbe.assertPending();
            await checkpoint("live-replace-release");
            liveProbe.allowCurrent();
            const liveReleased = object(
                await deps.releaseFault(Object.freeze({ state: livePendingState, claim: liveHeld.result })),
                "live vector fault release result"
            );
            check(
                liveReleased.released === true && liveReleased.gateDeadline === liveHeld.result.gateDeadline,
                "live vector fault release identity drifted"
            );
            await checkpoint("live-replace-readiness");
            liveReady = await lifecycle.pollReady({
                ...proofInput,
                vectorId: liveReplaceIntent.vectorId,
                version: liveReplaceIntent.nextVersion,
                requiredPhases: ["submit", "verify"],
            });
            await checkpoint("live-replace-current");
            liveCurrent = await liveProbe.waitForCurrent();
            liveSdkEvidence = liveProbe.finish();
            liveProbe = null;
        } finally {
            liveProbe?.abort();
        }
        check(
            liveSdkEvidence &&
                liveReplaceIntent &&
                liveReplaceIds &&
                liveHeld &&
                livePending &&
                liveReady &&
                liveCurrent,
            "live vector evidence is incomplete"
        );

        await checkpoint("live-cleanup-settlement");
        await poll(
            { ...proofInput, vectorId: liveReplaceIntent.vectorId },
            state => {
                if (
                    state.head?.state !== "ready" ||
                    state.head.version !== liveReplaceIntent.nextVersion ||
                    state.head.deliveredVersion !== liveReplaceIntent.nextVersion ||
                    state.outbox !== null
                ) {
                    return false;
                }
                return replacementCleanupSettled(state, liveReplaceIntent.nextVersion);
            },
            "live vector superseded cleanup"
        );
        await checkpoint("live-delete-intent");
        const liveDeleteIntent = await lifecycle.vectorIntent({
            ...proofInput,
            id: liveDocumentId,
            action: "delete",
        });
        check(liveDeleteIntent.vectorId === liveCreateIntent.vectorId, "live delete changed logical vector identity");
        const liveDeleteIds = exactIds(liveDeleteIntent.physicalIds, "delete intent physical ids");
        const liveOwnedIds = new Set([...liveCreateIds, ...liveReplaceIds]);
        check(
            liveDeleteIds.length > 0 && liveDeleteIds.every(id => liveOwnedIds.has(id)),
            "live delete intent contains an unowned physical id"
        );
        check(
            liveReplaceIds.every(id => liveDeleteIds.includes(id)),
            "live delete intent omitted the current physical id"
        );
        await deps.appendOwnedIds(
            Object.freeze({
                vectorId: liveDeleteIntent.vectorId,
                action: "delete",
                nextVersion: liveDeleteIntent.nextVersion,
                physicalIds: liveDeleteIds,
            })
        );
        await checkpoint("live-delete-mutation");
        await lifecycle.mutateVector({
            origin,
            principal: setup.owner,
            action: "delete",
            id: liveDocumentId,
            organizationId: setup.owningOrganizationId,
            mutId: mutationIds.liveDelete,
        });
        await checkpoint("live-delete-readiness");
        const liveDeleted = await lifecycle.pollDeleted({
            ...proofInput,
            vectorId: liveDeleteIntent.vectorId,
            requiredPhases: ["submit", "verify"],
        });
        const liveDelivery = Object.freeze({
            realWorkerWebSocket: true,
            syntheticFrames: false,
            vectorIdSha256: sha256(liveCreateIntent.vectorId),
            documentIdSha256: sha256(liveDocumentId),
            createPhysicalIdSha256: sha256(liveCreateIds[0]),
            replacementPhysicalIdSha256: sha256(liveReplaceIds[0]),
            pending: Object.freeze({
                gateHeldBeforeRelease: true,
                headVersion: liveReplaceIntent.nextVersion,
                deliveredVersion: liveReplaceIntent.nextVersion - 1,
                publicReplacementReturned: false,
                fallbackDocumentIdSha256: sha256(documentId),
                snapshotElapsedMs: livePending.elapsedMs,
            }),
            ready: Object.freeze({
                providerReadyBeforeAssertion: true,
                headVersion: liveReplaceIntent.nextVersion,
                deliveredVersion: liveReplaceIntent.nextVersion,
                publicReplacementUpdateCount: 1,
                snapshotElapsedMs: liveCurrent.elapsedMs,
                readinessElapsedMs: liveReady.elapsedMs,
            }),
            cleanup: Object.freeze({
                deleted: liveDeleted.result.absent === true,
                retainedTombstone: liveDeleted.result.retainedTombstone,
                elapsedMs: liveDeleted.elapsedMs,
            }),
            sdk: liveSdkEvidence,
        });

        const benchmarkInput = object(input.benchmark, "vector benchmark input");
        check(benchmarkInput.workloadId === BENCHMARK_WORKLOAD_ID, "vector benchmark workload drifted");
        const localFakeTrack = precomputedBenchmarkTrack(benchmarkInput.localFake, "local fake");
        const deployedQueryStability = queryStability(
            {
                queryStabilityWindowMs: currentIsolation.queryStabilityWindowMs,
                queryStabilityIntervalMs: QUERY_STABILITY_INTERVAL_MS,
                queryStabilityObservedMs: currentIsolation.queryStabilityObservedMs,
                queryStabilityExactMatchCount: currentIsolation.queryStabilityExactMatchCount,
                queryStabilityResetCount: currentIsolation.queryStabilityResetCount,
                queryStabilityNonExactCount: currentIsolation.queryStabilityNonExactCount,
                hardBoundClaimed: false,
            },
            "deployed"
        );
        await checkpoint("deployed-benchmark");
        const deployedMeasurement = await lifecycle.measure({
            origin,
            label: "deployed-cloudflare-vectorize",
            timeoutMs,
            intervalMs: QUERY_STABILITY_INTERVAL_MS,
            operation: async sample => {
                let matches;
                try {
                    matches = await lifecycle.search({
                        origin: sample.origin,
                        principal: setup.owner,
                        organizationId: setup.owningOrganizationId,
                        values: input.replacementValues,
                        limit: 1,
                    });
                } catch (error) {
                    if (error instanceof CloudflareVectorizeProofHttpError) {
                        if (
                            error.kind === "http" &&
                            Number.isInteger(error.status) &&
                            error.status >= 500 &&
                            error.status <= 599
                        ) {
                            return { classification: "http-5xx", status: error.status, code: error.code };
                        }
                        if (error.kind === "timeout") {
                            return { classification: "timeout" };
                        }
                    }
                    throw error;
                }
                const exact = exactPublicSearchResult(matches, documentId);
                check(
                    Array.isArray(matches) && (matches.length === 0 || exact),
                    "deployed benchmark search returned a non-exact public result"
                );
                return exact;
            },
            secrets: input.secrets ?? [],
        });
        const deployedTrack = precomputedBenchmarkTrack(
            {
                workloadId: BENCHMARK_WORKLOAD_ID,
                warmupExcluded: true,
                warmupCount: 1,
                warmup: deployedMeasurement.warmup,
                samples: deployedMeasurement.samples,
                exactMatchLatenciesMs: deployedMeasurement.exactMatchLatenciesMs,
            },
            "deployed"
        );
        const allExactPostStabilitySampling = Object.freeze({
            latencyPopulation: "exact-results-only",
            availabilityPassThreshold: null,
            scheduledRequestCount: 6,
            exactResponseCount: 6,
            exactResponseRatio: 1,
            availabilityMissCount: 0,
            emptyResponseCount: 0,
            http5xxResponseCount: 0,
            timeoutResponseCount: 0,
            reacquisitionCount: 0,
            reacquisitions: Object.freeze([]),
            reacquisitionObservations: Object.freeze([]),
            hardBoundClaimed: false,
        });
        const ownedIds = new Set([...createIds, ...replaceIds]);
        await checkpoint("delete-intent");
        const deleteIntent = await lifecycle.vectorIntent({ ...proofInput, id: documentId, action: "delete" });
        check(deleteIntent.vectorId === createIntent.vectorId, "delete intent changed logical vector identity");
        const deleteIds = exactIds(deleteIntent.physicalIds, "delete intent physical ids");
        check(
            deleteIds.every(id => ownedIds.has(id)),
            "delete intent contains an ID absent from the ownership ledger"
        );
        await checkpoint("delete-fault-arm");
        await lifecycle.armFault({
            ...proofInput,
            vectorId: deleteIntent.vectorId,
            mode: "delete_accept_then_throw",
        });
        await checkpoint("delete-mutation");
        await lifecycle.mutateVector({
            origin,
            principal: setup.owner,
            action: "delete",
            id: documentId,
            organizationId: setup.owningOrganizationId,
            mutId: mutationIds.delete,
        });
        await checkpoint("delete-alarm-wait");
        await checkpoint("delete-response-loss");
        await poll(
            { ...proofInput, vectorId: deleteIntent.vectorId },
            state => (state.fault?.fired === true && state.fault.acceptedBeforeThrow === true ? state : false),
            "accepted delete response loss"
        );
        await checkpoint("delete-readiness");
        const deleted = await lifecycle.pollDeleted({
            ...proofInput,
            vectorId: deleteIntent.vectorId,
            requiredPhases: ["submit", "verify"],
        });
        const deleteState = await readVectorState(
            { ...proofInput, vectorId: deleteIntent.vectorId },
            "delete response-loss vector state"
        );
        check(deleteState.fault?.retryComplete === true, "delete response-loss retry did not complete");
        const responseLoss = collectResponseLossRetryEvidence({
            upsertState,
            deleteState,
            secrets: [
                admin.token,
                setup.owner.cookie,
                setup.owner.token,
                setup.member.cookie,
                setup.member.token,
                setup.owningMember.cookie,
                setup.owningMember.token,
            ],
        });

        const settlementEvidence = settlement(
            descriptor.settlementConfiguredMs,
            [
                initialReady.elapsedMs,
                isolation.queryVisibilityElapsedMs,
                replacementReady.elapsedMs,
                currentIsolation.queryVisibilityElapsedMs,
                liveReady.elapsedMs,
                liveDeleted.elapsedMs,
                deleted.elapsedMs,
            ],
            [isolation, currentIsolation]
        );
        const delivery = Object.freeze({
            initial,
            upsertResponseLoss: {
                acceptedBeforeThrow: responseLoss.upsert.acceptedBeforeThrow,
                physicalId: responseLoss.upsert.physicalId,
                retryPhysicalId: responseLoss.upsert.retryPhysicalId,
                payloadSha256: responseLoss.upsert.payloadSha256,
                retryPayloadSha256: responseLoss.upsert.retryPayloadSha256,
                mutationIdSha256: responseLoss.upsert.mutationIdSha256,
            },
            deleteResponseLoss: {
                acceptedBeforeThrow: responseLoss.delete.acceptedBeforeThrow,
                physicalIds: responseLoss.delete.physicalIds,
                retryPhysicalIds: responseLoss.delete.retryPhysicalIds,
                mutationIdSha256: responseLoss.delete.mutationIdSha256,
            },
        });
        const lifecycleEvidence = Object.freeze({
            health,
            migration,
            descriptor: descriptor.descriptor,
            organizations: {
                owningOrganizationId: setup.owningOrganizationId,
                isolatedOrganizationId: setup.isolatedOrganizationId,
            },
            intent: {
                vectorId: createIntent.vectorId,
                createPhysicalIds: createIds,
                replacePhysicalIds: replaceIds,
                deletePhysicalIds: deleteIds,
            },
            search: {
                namespaceIsolation:
                    isolation.namespaceIsolation === true && currentIsolation.namespaceIsolation === true,
                resourceFilter: descriptor.search.resourceFilter,
                currentHeadOnly: descriptor.search.currentHeadOnly,
                noRemoteValues: descriptor.search.noRemoteValues,
                noRemoteMetadata: descriptor.search.noRemoteMetadata,
                adversarialFiltering,
                liveDelivery,
            },
            redeploy: {
                workerRedeployDuringLease: true,
                initial: initialVersion,
                redeploy: redeployedVersion,
                claimTokenSha256: held.result.claimTokenSha256,
                targetVersion: held.result.targetVersion,
                maintainPendingAcrossRedeploy: true,
                sameLogicalIntentAcrossRedeploy: true,
                leaseStateAfterRedeploy: redeployContinuity.leaseState,
                claimReclaimedAcrossRedeploy: redeployContinuity.leaseState === "active-reclaimed",
                releasedBeforeSettlement: true,
                eventualCompletion: upsertState.head?.state === "ready",
            },
            versions: { initial: initialVersion, redeploy: redeployedVersion },
            lifecycle: {
                migration,
                workerRedeployDuringLease: true,
                leaseStateAfterRedeploy: redeployContinuity.leaseState,
            },
            delivery,
            faults: {
                acceptedUpsertReceiptLost: true,
                acceptedDeleteReceiptLost: true,
                sameUpsertIdAndPayloadRetried: true,
                sameDeleteIdsRetried: true,
                durableObjectEvictionClaimed: false,
                inFlightNetworkLossClaimed: false,
            },
            settlement: settlementEvidence,
            deletion: deleted.result,
        });
        const deployedBenchmark = Object.freeze({
            workload: BENCHMARK_WORKLOAD,
            queryStability: deployedQueryStability,
            postStabilitySampling: deployedMeasurement.postStabilitySampling ?? allExactPostStabilitySampling,
            track: Object.freeze({
                label: "deployed-cloudflare-vectorize",
                runtime: "cloudflare-workers",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: deployedTrack.warmup,
                samples: deployedTrack.samples,
                exactMatchLatenciesMs: deployedTrack.exactMatchLatenciesMs,
            }),
        });
        const suppliedSecrets = [
            admin.token,
            setup.owner.cookie,
            setup.owner.token,
            setup.member.cookie,
            setup.member.token,
            setup.owningMember.cookie,
            setup.owningMember.token,
            ...(input.secrets ?? []),
        ];
        const deployedLifecycle = assertSecretFreeVectorEvidence(
            Object.freeze({ ...lifecycleEvidence, deployedBenchmark }),
            suppliedSecrets
        );
        await checkpoint("deployed-lifecycle");
        await deps.recordDeployedLifecycle?.(deployedLifecycle);

        const comparisonInput = object(
            deps.loadComparisonBenchmark ? await deps.loadComparisonBenchmark() : benchmarkInput,
            "vector comparison benchmark input"
        );
        const localRemoteTrack = precomputedBenchmarkTrack(comparisonInput.localRemoteBinding, "local remote-binding");
        const localRemoteQueryStability = queryStability(
            comparisonInput.localRemoteQueryStability,
            "local remote-binding"
        );
        const benchmark = Object.freeze({
            schema: "chardb.vectorize.deployment-benchmark.v2",
            workload: BENCHMARK_WORKLOAD,
            warmupExcluded: true,
            comparisonsDescriptiveOnly: true,
            queryStability: Object.freeze({
                localRemoteBinding: localRemoteQueryStability,
                deployed: deployedQueryStability,
            }),
            postStabilitySampling: Object.freeze({
                localRemoteBinding: comparisonInput.localRemotePostStabilitySampling ?? allExactPostStabilitySampling,
                deployed: deployedMeasurement.postStabilitySampling ?? allExactPostStabilitySampling,
            }),
            localFake: Object.freeze({
                label: "local-workerd-fake-vectorize",
                runtime: "miniflare/workerd",
                backend: "persistent-fake-index-do",
                realVectorize: false,
                warmup: localFakeTrack.warmup,
                samples: localFakeTrack.samples,
                exactMatchLatenciesMs: localFakeTrack.exactMatchLatenciesMs,
            }),
            localRemoteBinding: Object.freeze({
                label: "local-wrangler-remote-vectorize",
                runtime: "wrangler-dev/workerd",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: localRemoteTrack.warmup,
                samples: localRemoteTrack.samples,
                exactMatchLatenciesMs: localRemoteTrack.exactMatchLatenciesMs,
            }),
            deployed: deployedBenchmark.track,
        });
        const completeEvidence = assertSecretFreeVectorEvidence(
            Object.freeze({ ...lifecycleEvidence, benchmark }),
            suppliedSecrets
        );
        await checkpoint("complete");
        return completeEvidence;
    };

    return Object.freeze({ run });
}
