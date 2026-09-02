import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const CLOUDFLARE_VECTORIZE_PROOF_REPORT_SCHEMA = "chardb.cloudflare-vectorize-proof.report.v3";
export const CLOUDFLARE_VECTORIZE_PROOF_VALIDATION_SCHEMA = "chardb.cloudflare-vectorize-proof.validation.v3";

const SHA256 = /^[a-f0-9]{64}$/;
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RESOURCE_ID = /^vr1_[a-f0-9]{64}$/;
const VECTOR_ID = /^vec1_[a-f0-9]{64}$/;
const RESOURCE_FILTER = /^r1_[A-Za-z0-9_-]{43}$/;
const PHYSICAL_ID = /^p1_([A-Za-z0-9_-]{43})_([1-9a-z][0-9a-z]*)$/;
const NAMESPACE_ID = /^o1_[A-Za-z0-9_-]{43}$/;
const RESOURCE_NAME = /^chardb-vx-proof-[a-f0-9]{10}-[a-f0-9]{16}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BENCHMARK_WORKLOAD = Object.freeze({
    id: "ready-vector-filtered-search-v2",
    dimensions: 32,
    metric: "cosine",
    topK: 1,
    requestsPerSample: 1,
});
const TEXT = new TextEncoder();

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function object(value, label, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (!isDeepStrictEqual(actual, expected)) {
        throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
    }
    return value;
}

function digest(value, label) {
    if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
    return value;
}

function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
    return value;
}

function nonnegativeNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite nonnegative number`);
    }
    return value;
}

function timestamp(value, label) {
    if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`${label} must be an exact ISO timestamp`);
    }
    return parsed.getTime();
}

function wireId(value, pattern, label) {
    if (
        typeof value !== "string" ||
        TEXT.encode(value).byteLength > 64 ||
        !WIRE_ID.test(value) ||
        (pattern && !pattern.test(value))
    ) {
        throw new Error(`${label} must be a valid Vectorize wire id of at most 64 bytes`);
    }
    return value;
}

function canonicalWireDigest(value, label) {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) {
        throw new Error(`${label} must contain one canonical 32-byte base64url digest`);
    }
}

function physicalId(value, label) {
    wireId(value, PHYSICAL_ID, label);
    const match = PHYSICAL_ID.exec(value);
    canonicalWireDigest(match?.[1] ?? "", label);
    const rawVersion = match?.[2];
    let version = 0;
    for (const character of rawVersion ?? "") {
        const digit = Number.parseInt(character, 36);
        if (version > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 36)) {
            throw new Error(`${label} contains an unsafe vector version`);
        }
        version = version * 36 + digit;
    }
    if (!Number.isSafeInteger(version) || version < 1 || version.toString(36) !== rawVersion) {
        throw new Error(`${label} contains an invalid vector version`);
    }
    return value;
}

function exactStringArray(value, label, validate, options = {}) {
    if (!Array.isArray(value) || value.length > (options.maximum ?? 512)) throw new Error(`${label} must be an array`);
    const projected = value.map((item, index) => validate(item, `${label} item ${index}`));
    if (new Set(projected).size !== projected.length) throw new Error(`${label} must not contain duplicates`);
    if (options.nonempty && projected.length === 0) throw new Error(`${label} must not be empty`);
    return projected;
}

function assertCandidate(value, label = "Cloudflare Vectorize proof candidate") {
    object(value, label, ["algorithm", "digest", "bytes"]);
    if (value.algorithm !== "sha256") throw new Error(`${label} algorithm must be sha256`);
    digest(value.digest, `${label} digest`);
    positiveInteger(value.bytes, `${label} byte count`);
    return value;
}

function assertTarget(value, candidate) {
    object(value, "Cloudflare Vectorize proof target", ["worker", "index", "origin", "accountIdSha256"]);
    digest(value.accountIdSha256, "Cloudflare account-id digest");
    if (value.worker !== value.index || !RESOURCE_NAME.test(value.worker ?? "")) {
        throw new Error("Cloudflare Vectorize proof Worker and index must share the exact derived name");
    }
    if (!value.worker.includes(candidate.digest.slice(0, 10))) {
        throw new Error("Cloudflare Vectorize proof target drifted from the candidate digest");
    }
    wireId(value.worker, RESOURCE_NAME, "Cloudflare Vectorize proof resource name");
    const escaped = value.worker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
        typeof value.origin !== "string" ||
        !new RegExp(`^https://${escaped}\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.workers\\.dev$`).test(value.origin)
    ) {
        throw new Error("Cloudflare Vectorize proof origin does not identify the disposable Worker");
    }
}

function assertDeploymentInput(value, candidate) {
    object(value, "Cloudflare Vectorize proof deployment input", ["algorithm", "digest", "files"]);
    if (value.algorithm !== "sha256") throw new Error("deployment input algorithm must be sha256");
    digest(value.digest, "deployment input digest");
    if (!Array.isArray(value.files) || value.files.length < 2 || value.files.length > 64) {
        throw new Error("deployment input must contain a bounded file fingerprint");
    }
    const files = value.files.map((file, index) => {
        object(file, `deployment input file ${index}`, ["path", "bytes", "sha256"]);
        if (
            typeof file.path !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(file.path) ||
            file.path.split("/").includes("..")
        ) {
            throw new Error(`deployment input file ${index} path is invalid`);
        }
        positiveInteger(file.bytes, `deployment input file ${file.path} byte count`);
        digest(file.sha256, `deployment input file ${file.path} digest`);
        return file;
    });
    const paths = files.map(file => file.path);
    if (!isDeepStrictEqual(paths, [...new Set(paths)].sort())) {
        throw new Error("deployment input files must have unique sorted paths");
    }
    const tarball = files.find(file => file.path === "chardb-proof.tgz");
    if (!tarball || tarball.bytes !== candidate.bytes || tarball.sha256 !== candidate.digest) {
        throw new Error("deployment input does not contain the exact candidate tarball");
    }
    if (value.digest !== sha256(JSON.stringify(files))) {
        throw new Error("deployment input composite digest is invalid");
    }
}

function assertVersion(value, label) {
    object(value, label, ["deploymentId", "versionId", "number", "percentage"]);
    if (!UUID.test(value.deploymentId ?? "") || !UUID.test(value.versionId ?? "")) {
        throw new Error(`${label} requires immutable deployment and version ids`);
    }
    positiveInteger(value.number, `${label} number`);
    if (value.percentage !== 100) throw new Error(`${label} must receive 100 percent traffic`);
}

function assertVersions(value) {
    object(value, "Cloudflare Vectorize proof versions", ["initial", "redeploy"]);
    assertVersion(value.initial, "initial Worker version");
    assertVersion(value.redeploy, "redeployed Worker version");
    if (
        value.redeploy.versionId === value.initial.versionId ||
        value.redeploy.deploymentId === value.initial.deploymentId ||
        value.redeploy.number <= value.initial.number
    ) {
        throw new Error("lease redeploy must activate a distinct later immutable Worker version");
    }
}

function assertLifecycle(value) {
    object(value, "Cloudflare Vectorize proof lifecycle", [
        "migration",
        "workerRedeployDuringLease",
        "leaseStateAfterRedeploy",
    ]);
    object(value.migration, "Cloudflare Vectorize proof migration", [
        "beforeVersion",
        "targetVersion",
        "afterVersion",
        "beforeEpoch",
        "afterEpoch",
        "idempotentRetry",
    ]);
    if (
        value.migration.beforeVersion !== 0 ||
        value.migration.targetVersion !== 1 ||
        value.migration.afterVersion !== 1 ||
        value.migration.beforeEpoch !== 1 ||
        value.migration.afterEpoch !== 2 ||
        value.migration.idempotentRetry !== true
    ) {
        throw new Error("Cloudflare Vectorize proof migration must prove version zero to one activation");
    }
    if (value.workerRedeployDuringLease !== true) {
        throw new Error("Cloudflare Vectorize proof did not prove a Worker redeploy during an active lease");
    }
    if (
        value.leaseStateAfterRedeploy !== "active-original" &&
        value.leaseStateAfterRedeploy !== "expired-original" &&
        value.leaseStateAfterRedeploy !== "active-reclaimed" &&
        value.leaseStateAfterRedeploy !== "unleased"
    ) {
        throw new Error("Cloudflare Vectorize proof post-redeploy lease state is invalid");
    }
}

function assertFaults(value) {
    object(value, "Cloudflare Vectorize proof faults", [
        "acceptedUpsertReceiptLost",
        "acceptedDeleteReceiptLost",
        "sameUpsertIdAndPayloadRetried",
        "sameDeleteIdsRetried",
        "durableObjectEvictionClaimed",
        "inFlightNetworkLossClaimed",
    ]);
    for (const field of [
        "acceptedUpsertReceiptLost",
        "acceptedDeleteReceiptLost",
        "sameUpsertIdAndPayloadRetried",
        "sameDeleteIdsRetried",
    ]) {
        if (value[field] !== true) throw new Error(`Cloudflare Vectorize fault claim ${field} did not pass`);
    }
    if (value.durableObjectEvictionClaimed !== false || value.inFlightNetworkLossClaimed !== false) {
        throw new Error("Cloudflare Vectorize proof may not claim real eviction or in-flight network loss");
    }
}

function assertDescriptor(value) {
    object(value, "Cloudflare Vectorize proof descriptor", [
        "binding",
        "resourceDigest",
        "resourceId",
        "resourceFilter",
        "dimensions",
        "metric",
        "namespaceIds",
    ]);
    const resourceDigest = digest(value.resourceDigest, "vector resource digest");
    if (value.resourceId !== `vr1_${resourceDigest}` || !RESOURCE_ID.test(value.resourceId)) {
        throw new Error("vector resource id drifted from its full descriptor digest");
    }
    const expectedFilter = `r1_${Buffer.from(resourceDigest, "hex").toString("base64url")}`;
    if (value.resourceFilter !== expectedFilter) {
        throw new Error("Vectorize resource filter drifted from the canonical resource digest");
    }
    wireId(value.resourceFilter, RESOURCE_FILTER, "Vectorize resource filter");
    canonicalWireDigest(value.resourceFilter.slice("r1_".length), "Vectorize resource filter");
    if (value.binding !== "CDB_PROOF_VECTORS" || value.dimensions !== 32 || value.metric !== "cosine") {
        throw new Error("Cloudflare Vectorize proof descriptor drifted from the fixed proof contract");
    }
    const namespaces = exactStringArray(
        value.namespaceIds,
        "vector namespace ids",
        (item, label) => {
            wireId(item, NAMESPACE_ID, label);
            canonicalWireDigest(item.slice("o1_".length), label);
            return item;
        },
        {
            maximum: 2,
            nonempty: true,
        }
    );
    if (namespaces.length !== 2) throw new Error("Cloudflare Vectorize proof requires exactly two namespaces");
}

function assertIndex(value, target) {
    object(value, "Cloudflare Vectorize proof index", [
        "absentBefore",
        "created",
        "name",
        "dimensions",
        "metric",
        "metadataIndexes",
    ]);
    if (
        value.absentBefore !== true ||
        value.created !== true ||
        value.name !== target.index ||
        value.dimensions !== 32 ||
        value.metric !== "cosine"
    ) {
        throw new Error("Cloudflare Vectorize proof index configuration or absence proof is incomplete");
    }
    if (
        !Array.isArray(value.metadataIndexes) ||
        value.metadataIndexes.length !== 1 ||
        !isDeepStrictEqual(value.metadataIndexes[0], { propertyName: "cdb_resource", type: "string" })
    ) {
        throw new Error("Cloudflare Vectorize proof requires exact cdb_resource metadata-index evidence");
    }
}

function assertInitialDelivery(value) {
    object(value, "initial vector delivery", ["physicalId", "payloadSha256", "mutationIdSha256"]);
    physicalId(value.physicalId, "initial physical id");
    digest(value.payloadSha256, "initial payload digest");
    digest(value.mutationIdSha256, "initial mutation-id digest");
}

function assertUpsertResponseLoss(value) {
    object(value, "upsert response-loss evidence", [
        "acceptedBeforeThrow",
        "physicalId",
        "retryPhysicalId",
        "payloadSha256",
        "retryPayloadSha256",
        "mutationIdSha256",
    ]);
    if (value.acceptedBeforeThrow !== true) throw new Error("upsert response loss did not prove remote acceptance");
    physicalId(value.physicalId, "response-loss physical id");
    physicalId(value.retryPhysicalId, "response-loss retry physical id");
    digest(value.payloadSha256, "response-loss payload digest");
    digest(value.retryPayloadSha256, "response-loss retry payload digest");
    digest(value.mutationIdSha256, "response-loss mutation-id digest");
    if (value.physicalId !== value.retryPhysicalId) {
        throw new Error("upsert response-loss retry physical id does not match the accepted id");
    }
    if (value.payloadSha256 !== value.retryPayloadSha256) {
        throw new Error("upsert response-loss retry payload hash does not match the accepted payload");
    }
}

function assertDeleteResponseLoss(value) {
    object(value, "delete response-loss evidence", [
        "acceptedBeforeThrow",
        "physicalIds",
        "retryPhysicalIds",
        "mutationIdSha256",
    ]);
    if (value.acceptedBeforeThrow !== true) throw new Error("delete response loss did not prove remote acceptance");
    const physicalIds = exactStringArray(value.physicalIds, "delete physical ids", physicalId, { nonempty: true });
    const retries = exactStringArray(value.retryPhysicalIds, "delete retry physical ids", physicalId, {
        nonempty: true,
    });
    digest(value.mutationIdSha256, "delete mutation-id digest");
    if (!isDeepStrictEqual(retries, physicalIds)) {
        throw new Error("delete response-loss retry ids do not exactly match the accepted ids");
    }
}

function assertDelivery(value) {
    object(value, "Cloudflare Vectorize proof delivery", ["initial", "upsertResponseLoss", "deleteResponseLoss"]);
    assertInitialDelivery(value.initial);
    assertUpsertResponseLoss(value.upsertResponseLoss);
    assertDeleteResponseLoss(value.deleteResponseLoss);
}

function assertSearch(value, adversarialOnly = false) {
    object(value, "Cloudflare Vectorize proof search", [
        "namespaceIsolation",
        "resourceFilter",
        "currentHeadOnly",
        "noRemoteValues",
        "noRemoteMetadata",
        "adversarialFiltering",
        "liveDelivery",
    ]);
    for (const field of [
        "namespaceIsolation",
        "resourceFilter",
        "currentHeadOnly",
        "noRemoteValues",
        "noRemoteMetadata",
    ]) {
        if (value[field] !== true) throw new Error(`Cloudflare Vectorize search ${field} proof is incomplete`);
    }
    const adversary = value.adversarialFiltering;
    object(adversary, "Cloudflare Vectorize adversarial filtering", [
        "provider",
        "realVectorize",
        "syntheticMatches",
        "vectorIdSha256",
        "stalePhysicalIdSha256",
        "currentPhysicalIdSha256",
        "apply",
        "injected",
        "restore",
        "policy",
    ]);
    if (
        adversary.provider !== "cloudflare-vectorize" ||
        adversary.realVectorize !== true ||
        adversary.syntheticMatches !== false
    ) {
        throw new Error("Cloudflare Vectorize adversarial provider evidence is invalid");
    }
    digest(adversary.vectorIdSha256, "adversarial vector-id digest");
    digest(adversary.stalePhysicalIdSha256, "adversarial stale physical-id digest");
    digest(adversary.currentPhysicalIdSha256, "adversarial current physical-id digest");
    if (
        adversary.stalePhysicalIdSha256 === adversary.currentPhysicalIdSha256 ||
        adversary.vectorIdSha256 === adversary.stalePhysicalIdSha256 ||
        adversary.vectorIdSha256 === adversary.currentPhysicalIdSha256
    ) {
        throw new Error("Cloudflare Vectorize adversarial identity digests must differ");
    }
    object(adversary.apply, "Cloudflare Vectorize adversarial apply evidence", [
        "staleUpsertMutationIdSha256",
        "currentDeleteMutationIdSha256",
    ]);
    digest(adversary.apply.staleUpsertMutationIdSha256, "adversarial stale upsert mutation-id digest");
    digest(adversary.apply.currentDeleteMutationIdSha256, "adversarial current delete mutation-id digest");
    object(adversary.injected, "Cloudflare Vectorize injected stale evidence", [
        "providerQueryTopK",
        "rawStaleObserved",
        "rawCurrentAbsent",
        "rawObservationElapsedMs",
        "publicTargetReturned",
        "publicObservation",
    ]);
    if (
        adversary.injected.providerQueryTopK !== 17 ||
        adversary.injected.rawStaleObserved !== true ||
        adversary.injected.rawCurrentAbsent !== true ||
        adversary.injected.publicTargetReturned !== false
    ) {
        throw new Error("Cloudflare Vectorize stale-candidate filtering evidence is incomplete");
    }
    nonnegativeNumber(adversary.injected.rawObservationElapsedMs, "stale raw observation duration");
    object(adversary.injected.publicObservation, "stale public filtering observation", [
        "elapsedMs",
        "attempts",
        "staleEmptyObservationCount",
        "stableEmptyCount",
        "previousCurrentViewCount",
        "mixedCurrentResetCount",
        "providerMissCount",
        "transientFailureCount",
        "stabilityResetCount",
        "stabilityWindowMs",
        "stabilityObservedMs",
        "observationIntervalMs",
        "querySha256",
        "finalCandidateSetSha256",
        "hardBoundClaimed",
    ]);
    const publicObservation = adversary.injected.publicObservation;
    nonnegativeNumber(publicObservation.elapsedMs, "stale public filtering duration");
    nonnegativeNumber(publicObservation.stabilityObservedMs, "stale public filtering stable duration");
    for (const field of [
        "attempts",
        "staleEmptyObservationCount",
        "stableEmptyCount",
        "previousCurrentViewCount",
        "mixedCurrentResetCount",
        "providerMissCount",
        "transientFailureCount",
        "stabilityResetCount",
        "stabilityWindowMs",
        "observationIntervalMs",
    ]) {
        if (!Number.isSafeInteger(publicObservation[field]) || publicObservation[field] < 0) {
            throw new Error(`stale public filtering observation ${field} is invalid`);
        }
    }
    digest(publicObservation.querySha256, "stale public filtering query digest");
    digest(publicObservation.finalCandidateSetSha256, "stale public filtering candidate-set digest");
    if (
        publicObservation.attempts !==
            publicObservation.staleEmptyObservationCount +
                publicObservation.previousCurrentViewCount +
                publicObservation.mixedCurrentResetCount +
                publicObservation.providerMissCount ||
        publicObservation.mixedCurrentResetCount > publicObservation.stabilityResetCount ||
        publicObservation.stabilityResetCount >
            publicObservation.previousCurrentViewCount +
                publicObservation.mixedCurrentResetCount +
                publicObservation.providerMissCount +
                publicObservation.transientFailureCount ||
        publicObservation.stabilityWindowMs !== 10_000 ||
        publicObservation.observationIntervalMs !== 1_000 ||
        publicObservation.stabilityObservedMs !==
            (publicObservation.stableEmptyCount - 1) * publicObservation.observationIntervalMs ||
        publicObservation.stabilityObservedMs < publicObservation.stabilityWindowMs ||
        publicObservation.elapsedMs < publicObservation.stabilityObservedMs ||
        publicObservation.stableEmptyCount < 2 ||
        publicObservation.stableEmptyCount > publicObservation.staleEmptyObservationCount ||
        publicObservation.hardBoundClaimed !== false
    ) {
        throw new Error("stale public filtering observation is incomplete");
    }
    object(adversary.restore, "Cloudflare Vectorize adversarial restore evidence", [
        "currentUpsertMutationIdSha256",
        "staleDeleteMutationIdSha256",
        "rawCurrentObserved",
        "rawStaleAbsent",
        "rawObservationElapsedMs",
        "publicOwnerTargetReturned",
        "publicOwnerObservation",
    ]);
    digest(adversary.restore.currentUpsertMutationIdSha256, "adversarial current upsert mutation-id digest");
    digest(adversary.restore.staleDeleteMutationIdSha256, "adversarial stale delete mutation-id digest");
    if (
        adversary.restore.rawCurrentObserved !== true ||
        adversary.restore.rawStaleAbsent !== true ||
        adversary.restore.publicOwnerTargetReturned !== true
    ) {
        throw new Error("Cloudflare Vectorize adversarial restoration evidence is incomplete");
    }
    nonnegativeNumber(adversary.restore.rawObservationElapsedMs, "restored raw observation duration");
    object(adversary.restore.publicOwnerObservation, "restored public owner observation", [
        "elapsedMs",
        "attempts",
        "emptyReadCount",
        "staleFilteredReadCount",
        "mixedCurrentReadCount",
        "transientFailureCount",
        "querySha256",
        "candidateSetSha256",
        "hardBoundClaimed",
    ]);
    const ownerObservation = adversary.restore.publicOwnerObservation;
    nonnegativeNumber(ownerObservation.elapsedMs, "restored public owner observation duration");
    for (const field of [
        "attempts",
        "emptyReadCount",
        "staleFilteredReadCount",
        "mixedCurrentReadCount",
        "transientFailureCount",
    ]) {
        if (!Number.isSafeInteger(ownerObservation[field]) || ownerObservation[field] < 0) {
            throw new Error(`restored public owner observation ${field} is invalid`);
        }
    }
    digest(ownerObservation.querySha256, "restored public owner query digest");
    digest(ownerObservation.candidateSetSha256, "restored public owner candidate-set digest");
    if (
        ownerObservation.attempts !==
            ownerObservation.emptyReadCount +
                ownerObservation.staleFilteredReadCount +
                ownerObservation.mixedCurrentReadCount +
                ownerObservation.transientFailureCount +
                1 ||
        ownerObservation.hardBoundClaimed !== false
    ) {
        throw new Error("restored public owner observation accounting is invalid");
    }
    object(adversary.policy, "Cloudflare Vectorize policy filtering evidence", [
        "kind",
        "role",
        "rawCurrentObserved",
        "publicOwnerTargetReturned",
        "publicMemberTargetReturned",
        "exactCurrentCandidateBatch",
        "candidateSetSha256",
    ]);
    if (
        adversary.policy.kind !== "vector-column-read-denied" ||
        adversary.policy.role !== "member" ||
        adversary.policy.rawCurrentObserved !== true ||
        adversary.policy.publicOwnerTargetReturned !== true ||
        adversary.policy.publicMemberTargetReturned !== false ||
        adversary.policy.exactCurrentCandidateBatch !== true
    ) {
        throw new Error("Cloudflare Vectorize policy filtering evidence is incomplete");
    }
    digest(adversary.policy.candidateSetSha256, "Cloudflare Vectorize member-policy candidate-set digest");
    if (ownerObservation.candidateSetSha256 !== adversary.policy.candidateSetSha256) {
        throw new Error("Cloudflare Vectorize restored-owner and member-policy candidate batches differ");
    }
    if (
        new Set([
            adversary.apply.staleUpsertMutationIdSha256,
            adversary.apply.currentDeleteMutationIdSha256,
            adversary.restore.currentUpsertMutationIdSha256,
            adversary.restore.staleDeleteMutationIdSha256,
        ]).size !== 4
    ) {
        throw new Error("Cloudflare Vectorize adversarial mutations do not identify four distinct receipts");
    }
    if (adversarialOnly) return;

    const live = value.liveDelivery;
    object(live, "Cloudflare Vectorize live delivery", [
        "realWorkerWebSocket",
        "syntheticFrames",
        "vectorIdSha256",
        "documentIdSha256",
        "createPhysicalIdSha256",
        "replacementPhysicalIdSha256",
        "pending",
        "ready",
        "cleanup",
        "sdk",
    ]);
    if (live.realWorkerWebSocket !== true || live.syntheticFrames !== false) {
        throw new Error("Cloudflare Vectorize live delivery did not use a real Worker WebSocket");
    }
    for (const [field, label] of [
        ["vectorIdSha256", "live vector-id digest"],
        ["documentIdSha256", "live document-id digest"],
        ["createPhysicalIdSha256", "live create physical-id digest"],
        ["replacementPhysicalIdSha256", "live replacement physical-id digest"],
    ]) {
        digest(live[field], label);
    }
    if (
        new Set([
            live.vectorIdSha256,
            live.documentIdSha256,
            live.createPhysicalIdSha256,
            live.replacementPhysicalIdSha256,
        ]).size !== 4
    ) {
        throw new Error("Cloudflare Vectorize live identities must be distinct");
    }
    object(live.pending, "Cloudflare Vectorize pending live delivery", [
        "gateHeldBeforeRelease",
        "headVersion",
        "deliveredVersion",
        "publicReplacementReturned",
        "fallbackDocumentIdSha256",
        "snapshotElapsedMs",
    ]);
    if (
        live.pending.gateHeldBeforeRelease !== true ||
        live.pending.headVersion !== 2 ||
        live.pending.deliveredVersion !== 1 ||
        live.pending.publicReplacementReturned !== false
    ) {
        throw new Error("Cloudflare Vectorize pending live delivery evidence is incomplete");
    }
    digest(live.pending.fallbackDocumentIdSha256, "pending fallback document-id digest");
    nonnegativeNumber(live.pending.snapshotElapsedMs, "pending live snapshot duration");
    object(live.ready, "Cloudflare Vectorize ready live delivery", [
        "providerReadyBeforeAssertion",
        "headVersion",
        "deliveredVersion",
        "publicReplacementUpdateCount",
        "snapshotElapsedMs",
        "readinessElapsedMs",
    ]);
    if (
        live.ready.providerReadyBeforeAssertion !== true ||
        live.ready.headVersion !== 2 ||
        live.ready.deliveredVersion !== 2 ||
        live.ready.publicReplacementUpdateCount !== 1
    ) {
        throw new Error("Cloudflare Vectorize ready live delivery evidence is incomplete");
    }
    nonnegativeNumber(live.ready.snapshotElapsedMs, "ready live snapshot duration");
    nonnegativeNumber(live.ready.readinessElapsedMs, "live provider readiness duration");
    object(live.cleanup, "Cloudflare Vectorize live proof cleanup", ["deleted", "retainedTombstone", "elapsedMs"]);
    if (live.cleanup.deleted !== true || live.cleanup.retainedTombstone !== false) {
        throw new Error("Cloudflare Vectorize live proof cleanup is incomplete");
    }
    nonnegativeNumber(live.cleanup.elapsedMs, "live cleanup duration");

    const sdk = live.sdk;
    object(sdk, "Cloudflare Vectorize live SDK evidence", [
        "sdk",
        "transport",
        "auth",
        "queryRefSha256",
        "clientIdSha256",
        "connectionCount",
        "helloCount",
        "welcomeCount",
        "reconnectCount",
        "authReadCount",
        "snapshotCount",
        "acknowledgementCount",
        "acknowledgementEverySnapshot",
        "resume",
        "content",
    ]);
    if (
        sdk.sdk !== "installed-candidate-createChardbClient" ||
        sdk.transport !== "worker-websocket" ||
        sdk.auth !== "better-auth-jwt" ||
        sdk.queryRefSha256 !== sha256("cloudflare-vectorize-proof/api.ts#searchVectorDocuments") ||
        sdk.connectionCount !== 2 ||
        sdk.helloCount !== 2 ||
        sdk.welcomeCount !== 2 ||
        sdk.reconnectCount !== 1 ||
        !Number.isSafeInteger(sdk.authReadCount) ||
        sdk.authReadCount < 2 ||
        !Number.isSafeInteger(sdk.snapshotCount) ||
        sdk.snapshotCount < 3 ||
        sdk.snapshotCount > 4 ||
        sdk.acknowledgementCount !== sdk.snapshotCount ||
        sdk.acknowledgementEverySnapshot !== true
    ) {
        throw new Error("Cloudflare Vectorize live SDK transport evidence is invalid");
    }
    digest(sdk.clientIdSha256, "live SDK client-id digest");
    object(sdk.resume, "Cloudflare Vectorize live SDK resume evidence", [
        "attempted",
        "helloResumeMatchedInitialAck",
        "welcomeResumeMatchedInitialAck",
        "recovery",
        "refetchReason",
        "refetchStateCount",
        "baselineRestoreCount",
        "baselineRestoredExactly",
        "baselineRestoreAcknowledged",
        "initialCookieSha256",
        "finalCookieSha256",
    ]);
    if (
        sdk.resume.attempted !== true ||
        sdk.resume.helloResumeMatchedInitialAck !== true ||
        sdk.resume.welcomeResumeMatchedInitialAck !== true ||
        sdk.resume.recovery !== "lagged-refetch" ||
        sdk.resume.refetchReason !== "lagged" ||
        sdk.resume.refetchStateCount !== 1 ||
        sdk.resume.baselineRestoreCount !== 1 ||
        sdk.resume.baselineRestoredExactly !== true ||
        sdk.resume.baselineRestoreAcknowledged !== true
    ) {
        throw new Error("Cloudflare Vectorize live SDK resume evidence is incomplete");
    }
    digest(sdk.resume.initialCookieSha256, "initial live cookie digest");
    digest(sdk.resume.finalCookieSha256, "final live cookie digest");
    if (sdk.resume.initialCookieSha256 === sdk.resume.finalCookieSha256) {
        throw new Error("Cloudflare Vectorize live SDK cookie did not advance");
    }
    object(sdk.content, "Cloudflare Vectorize live SDK content evidence", [
        "callbackCount",
        "baselineUpdateCount",
        "pendingFallbackUpdateCount",
        "prematureCurrentUpdateCount",
        "replacementUpdateCount",
        "duplicateContentUpdateCount",
        "baselineRowsSha256",
        "pendingFallbackRowPkSha256",
        "pendingRowsSha256",
        "replacementRowsSha256",
    ]);
    if (
        sdk.content.callbackCount !== 4 ||
        sdk.content.baselineUpdateCount !== 1 ||
        sdk.content.pendingFallbackUpdateCount !== 1 ||
        sdk.content.prematureCurrentUpdateCount !== 0 ||
        sdk.content.replacementUpdateCount !== 1 ||
        sdk.content.duplicateContentUpdateCount !== 0
    ) {
        throw new Error("Cloudflare Vectorize live SDK content evidence is incomplete");
    }
    digest(sdk.content.baselineRowsSha256, "live baseline rows digest");
    digest(sdk.content.pendingFallbackRowPkSha256, "live pending fallback row-id digest");
    digest(sdk.content.pendingRowsSha256, "live pending rows digest");
    digest(sdk.content.replacementRowsSha256, "live replacement rows digest");
    if (sdk.content.pendingFallbackRowPkSha256 !== live.pending.fallbackDocumentIdSha256) {
        throw new Error("Cloudflare Vectorize pending fallback identity drifted");
    }
    if (
        new Set([sdk.content.baselineRowsSha256, sdk.content.pendingRowsSha256, sdk.content.replacementRowsSha256])
            .size !== 3
    ) {
        throw new Error("Cloudflare Vectorize live SDK content did not change exactly twice");
    }
}

export function assertCloudflareVectorizeProofSearchEvidence(value) {
    assertSearch(value);
    return value;
}

export function assertCloudflareVectorizeAdversarialFilteringEvidence(value) {
    assertSearch(
        {
            namespaceIsolation: true,
            resourceFilter: true,
            currentHeadOnly: true,
            noRemoteValues: true,
            noRemoteMetadata: true,
            adversarialFiltering: value,
            liveDelivery: null,
        },
        true
    );
    return value;
}

function assertSettlement(value) {
    object(value, "Cloudflare Vectorize proof settlement", [
        "configuredMs",
        "samplesMs",
        "minMs",
        "medianMs",
        "p95Ms",
        "maxMs",
        "transientHttpFailureCount",
        "transientHttpFailureCounts",
        "transientHttpFailureOverflowCount",
        "hardBoundClaimed",
    ]);
    positiveInteger(value.configuredMs, "configured settlement time");
    if (!Array.isArray(value.samplesMs) || value.samplesMs.length < 1 || value.samplesMs.length > 1_000) {
        throw new Error("settlement samples must be a bounded nonempty array");
    }
    const samples = value.samplesMs.map((item, index) => nonnegativeNumber(item, `settlement sample ${index}`));
    for (const field of ["minMs", "medianMs", "p95Ms", "maxMs"]) nonnegativeNumber(value[field], field);
    const sorted = [...samples].sort((left, right) => left - right);
    const percentile = probability => sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
    if (
        value.minMs !== sorted[0] ||
        value.medianMs !== percentile(0.5) ||
        value.p95Ms !== percentile(0.95) ||
        value.maxMs !== sorted.at(-1)
    ) {
        throw new Error("settlement summary does not match its samples");
    }
    if (
        !Number.isSafeInteger(value.transientHttpFailureCount) ||
        value.transientHttpFailureCount < 0 ||
        !Number.isSafeInteger(value.transientHttpFailureOverflowCount) ||
        value.transientHttpFailureOverflowCount < 0 ||
        !Array.isArray(value.transientHttpFailureCounts) ||
        value.transientHttpFailureCounts.length > 16
    ) {
        throw new Error("settlement transient HTTP failure evidence is invalid");
    }
    let recordedTransientFailures = 0;
    const seenTransientFailures = new Set();
    for (const [index, failure] of value.transientHttpFailureCounts.entries()) {
        object(failure, `settlement transient HTTP failure ${index}`, ["status", "code", "count"]);
        if (!Number.isSafeInteger(failure.status) || failure.status < 500 || failure.status > 599) {
            throw new Error(`settlement transient HTTP failure ${index} status is invalid`);
        }
        if (
            failure.code !== null &&
            (typeof failure.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(failure.code))
        ) {
            throw new Error(`settlement transient HTTP failure ${index} code is invalid`);
        }
        if (!Number.isSafeInteger(failure.count) || failure.count < 1) {
            throw new Error(`settlement transient HTTP failure ${index} count is invalid`);
        }
        const identity = `${failure.status}:${failure.code ?? ""}`;
        if (seenTransientFailures.has(identity)) {
            throw new Error("settlement transient HTTP failure evidence contains duplicates");
        }
        seenTransientFailures.add(identity);
        recordedTransientFailures += failure.count;
    }
    if (recordedTransientFailures + value.transientHttpFailureOverflowCount !== value.transientHttpFailureCount) {
        throw new Error("settlement transient HTTP failure accounting drifted");
    }
    if (value.hardBoundClaimed !== false) {
        throw new Error("deployed observations cannot claim a hard Vectorize settlement bound");
    }
}

function assertBenchmarkTrack(value, expected) {
    object(value, `${expected.label} benchmark track`, [
        "label",
        "runtime",
        "backend",
        "realVectorize",
        "warmup",
        "samples",
        "exactMatchLatenciesMs",
    ]);
    if (
        value.label !== expected.label ||
        value.runtime !== expected.runtime ||
        value.backend !== expected.backend ||
        value.realVectorize !== expected.realVectorize
    ) {
        throw new Error(`benchmark track ${expected.label} has a dishonest runtime or backend label`);
    }
    if (!Array.isArray(value.samples) || value.samples.length !== 5) {
        throw new Error(`benchmark track ${expected.label} requires five one-shot samples`);
    }
    object(value.warmup, `${expected.label} warmup`, [
        "requestOrdinal",
        "sequence",
        "excluded",
        "classification",
        "status",
        "code",
        "elapsedMs",
    ]);
    if (
        value.warmup.requestOrdinal !== 0 ||
        value.warmup.sequence !== -1 ||
        value.warmup.excluded !== true ||
        !["exact", "empty", "http-5xx", "timeout"].includes(value.warmup.classification)
    ) {
        throw new Error(`${expected.label} warmup drifted from the fixed plan`);
    }
    nonnegativeNumber(value.warmup.elapsedMs, `${expected.label} warmup duration`);
    if (value.warmup.classification === "http-5xx") {
        if (!Number.isSafeInteger(value.warmup.status) || value.warmup.status < 500 || value.warmup.status > 599) {
            throw new Error(`${expected.label} warmup HTTP status is invalid`);
        }
        if (
            value.warmup.code !== null &&
            (typeof value.warmup.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.warmup.code))
        ) {
            throw new Error(`${expected.label} warmup HTTP code is invalid`);
        }
    } else if (value.warmup.status !== null || value.warmup.code !== null) {
        throw new Error(`${expected.label} warmup carries unexpected HTTP identity`);
    }
    value.samples.forEach((item, index) => {
        object(item, `${expected.label} sample ${index}`, [
            "requestOrdinal",
            "sequence",
            "excluded",
            "classification",
            "status",
            "code",
            "elapsedMs",
        ]);
        if (
            item.requestOrdinal !== index + 1 ||
            item.sequence !== index ||
            item.excluded !== false ||
            !["exact", "empty", "http-5xx", "timeout"].includes(item.classification)
        ) {
            throw new Error(`${expected.label} sample ${index} drifted from the fixed plan`);
        }
        nonnegativeNumber(item.elapsedMs, `${expected.label} sample ${index} duration`);
        if (item.classification === "http-5xx") {
            if (!Number.isSafeInteger(item.status) || item.status < 500 || item.status > 599) {
                throw new Error(`${expected.label} sample ${index} HTTP status is invalid`);
            }
            if (
                item.code !== null &&
                (typeof item.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.code))
            ) {
                throw new Error(`${expected.label} sample ${index} HTTP code is invalid`);
            }
        } else if (item.status !== null || item.code !== null) {
            throw new Error(`${expected.label} sample ${index} carries unexpected HTTP identity`);
        }
    });
    const exactMatchLatenciesMs = value.samples
        .filter(item => item.classification === "exact")
        .map(item => item.elapsedMs);
    if (JSON.stringify(value.exactMatchLatenciesMs) !== JSON.stringify(exactMatchLatenciesMs)) {
        throw new Error(`${expected.label} exact-match latency population drifted`);
    }
}

function assertPostStabilitySampling(value, track, label) {
    object(value, `${label} post-stability sampling`, [
        "latencyPopulation",
        "availabilityPassThreshold",
        "scheduledRequestCount",
        "exactResponseCount",
        "exactResponseRatio",
        "availabilityMissCount",
        "emptyResponseCount",
        "http5xxResponseCount",
        "timeoutResponseCount",
        "reacquisitionCount",
        "reacquisitions",
        "reacquisitionObservations",
        "hardBoundClaimed",
    ]);
    if (
        value.latencyPopulation !== "exact-results-only" ||
        value.availabilityPassThreshold !== null ||
        value.scheduledRequestCount !== 6 ||
        !Number.isSafeInteger(value.exactResponseCount) ||
        value.exactResponseCount < 0 ||
        value.exactResponseCount > 6 ||
        value.availabilityMissCount !== 6 - value.exactResponseCount ||
        value.exactResponseRatio !== value.exactResponseCount / 6
    ) {
        throw new Error(`${label} scheduled outcome accounting drifted`);
    }
    const scheduled = [track.warmup, ...track.samples];
    const exactResponses = scheduled.filter(item => item.classification === "exact").length;
    const misses = scheduled.filter(item => item.classification !== "exact");
    if (
        value.exactResponseCount !== exactResponses ||
        value.availabilityMissCount !== misses.length ||
        value.emptyResponseCount !== misses.filter(item => item.classification === "empty").length ||
        value.http5xxResponseCount !== misses.filter(item => item.classification === "http-5xx").length ||
        value.timeoutResponseCount !== misses.filter(item => item.classification === "timeout").length
    ) {
        throw new Error(`${label} outcomes do not match the scheduled requests`);
    }
    for (const field of ["emptyResponseCount", "http5xxResponseCount", "timeoutResponseCount"]) {
        if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error(`${label} ${field} is invalid`);
    }
    if (
        value.emptyResponseCount + value.http5xxResponseCount + value.timeoutResponseCount !==
        value.availabilityMissCount
    ) {
        throw new Error(`${label} availability miss accounting drifted`);
    }
    if (
        !Number.isSafeInteger(value.reacquisitionCount) ||
        value.reacquisitionCount < 0 ||
        !Array.isArray(value.reacquisitions) ||
        value.reacquisitions.length !== value.reacquisitionCount ||
        !Array.isArray(value.reacquisitionObservations)
    ) {
        throw new Error(`${label} reacquisition evidence is invalid`);
    }
    const observations = value.reacquisitionObservations.map((item, index) => {
        object(item, `${label} reacquisition observation ${index}`, [
            "requestOrdinal",
            "sequence",
            "excluded",
            "classification",
            "status",
            "code",
            "elapsedMs",
        ]);
        if (
            item.requestOrdinal !== index ||
            !Number.isSafeInteger(item.sequence) ||
            item.sequence < -1 ||
            item.sequence > 4 ||
            item.excluded !== (item.sequence === -1) ||
            !["exact", "empty", "http-5xx", "timeout"].includes(item.classification)
        ) {
            throw new Error(`${label} reacquisition observation ${index} is invalid`);
        }
        nonnegativeNumber(item.elapsedMs, `${label} reacquisition observation ${index} duration`);
        if (item.classification === "http-5xx") {
            if (!Number.isSafeInteger(item.status) || item.status < 500 || item.status > 599) {
                throw new Error(`${label} reacquisition observation ${index} HTTP status is invalid`);
            }
            if (
                item.code !== null &&
                (typeof item.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.code))
            ) {
                throw new Error(`${label} reacquisition observation ${index} HTTP code is invalid`);
            }
        } else if (item.status !== null || item.code !== null) {
            throw new Error(`${label} reacquisition observation ${index} carries unexpected HTTP identity`);
        }
        return item;
    });
    let scheduledMisses = 0;
    let outOfBandRequests = 0;
    let observationOffset = 0;
    for (const [index, item] of value.reacquisitions.entries()) {
        object(item, `${label} reacquisition ${index}`, [
            "afterSequence",
            "excluded",
            "scheduledMissCount",
            "outOfBandRequestCount",
            "elapsedMs",
        ]);
        if (
            !Number.isSafeInteger(item.afterSequence) ||
            item.afterSequence < -1 ||
            item.afterSequence > 4 ||
            item.excluded !== (item.afterSequence === -1) ||
            !Number.isSafeInteger(item.scheduledMissCount) ||
            item.scheduledMissCount < 1 ||
            !Number.isSafeInteger(item.outOfBandRequestCount) ||
            item.outOfBandRequestCount < 0
        ) {
            throw new Error(`${label} reacquisition ${index} is invalid`);
        }
        nonnegativeNumber(item.elapsedMs, `${label} reacquisition ${index} duration`);
        scheduledMisses += item.scheduledMissCount;
        outOfBandRequests += item.outOfBandRequestCount;
        const group = observations.slice(observationOffset, observationOffset + item.outOfBandRequestCount);
        if (
            group.some(
                observation => observation.sequence !== item.afterSequence || observation.excluded !== item.excluded
            ) ||
            (group.length > 0 &&
                (group.at(-1).classification !== "exact" ||
                    group.slice(0, -1).some(observation => observation.classification === "exact")))
        ) {
            throw new Error(`${label} reacquisition ${index} observations do not prove exact-result recovery`);
        }
        observationOffset += group.length;
    }
    if (
        scheduledMisses !== value.availabilityMissCount ||
        outOfBandRequests !== value.reacquisitionObservations.length
    ) {
        throw new Error(`${label} reacquisition accounting drifted`);
    }
    if (value.hardBoundClaimed !== false) throw new Error(`${label} cannot claim a platform bound`);
}

function assertQueryStability(value, label) {
    object(value, `${label} query stability`, [
        "queryStabilityWindowMs",
        "queryStabilityIntervalMs",
        "queryStabilityObservedMs",
        "queryStabilityExactMatchCount",
        "queryStabilityResetCount",
        "queryStabilityNonExactCount",
        "hardBoundClaimed",
    ]);
    if (value.queryStabilityWindowMs !== 10_000 || value.queryStabilityIntervalMs !== 1_000) {
        throw new Error(`${label} query stability contract drifted`);
    }
    if (
        typeof value.queryStabilityObservedMs !== "number" ||
        !Number.isFinite(value.queryStabilityObservedMs) ||
        value.queryStabilityObservedMs < value.queryStabilityWindowMs
    ) {
        throw new Error(`${label} query stability observation is incomplete`);
    }
    for (const field of ["queryStabilityExactMatchCount", "queryStabilityResetCount", "queryStabilityNonExactCount"]) {
        if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
            throw new Error(`${label} ${field} is invalid`);
        }
    }
    if (value.queryStabilityExactMatchCount < 1) throw new Error(`${label} query stability has no exact matches`);
    if (value.hardBoundClaimed !== false) throw new Error(`${label} query stability cannot claim a platform bound`);
}

function assertBenchmarkWorkload(value) {
    object(value, "Cloudflare Vectorize benchmark workload", Object.keys(BENCHMARK_WORKLOAD));
    for (const [field, expected] of Object.entries(BENCHMARK_WORKLOAD)) {
        if (value[field] !== expected) throw new Error(`Cloudflare Vectorize benchmark workload ${field} drifted`);
    }
}

function assertBenchmark(value) {
    object(value, "Cloudflare Vectorize proof benchmark", [
        "schema",
        "workload",
        "warmupExcluded",
        "comparisonsDescriptiveOnly",
        "queryStability",
        "postStabilitySampling",
        "localFake",
        "localRemoteBinding",
        "deployed",
    ]);
    if (
        value.schema !== "chardb.vectorize.deployment-benchmark.v2" ||
        value.warmupExcluded !== true ||
        value.comparisonsDescriptiveOnly !== true
    ) {
        throw new Error("Cloudflare Vectorize benchmark admission fields are invalid");
    }
    assertBenchmarkWorkload(value.workload);
    object(value.queryStability, "Cloudflare Vectorize benchmark query stability", ["localRemoteBinding", "deployed"]);
    assertQueryStability(value.queryStability.localRemoteBinding, "local remote-binding");
    assertQueryStability(value.queryStability.deployed, "deployed");
    object(value.postStabilitySampling, "Cloudflare Vectorize benchmark post-stability sampling", [
        "localRemoteBinding",
        "deployed",
    ]);
    assertPostStabilitySampling(
        value.postStabilitySampling.localRemoteBinding,
        value.localRemoteBinding,
        "local remote-binding"
    );
    assertPostStabilitySampling(value.postStabilitySampling.deployed, value.deployed, "deployed");
    assertBenchmarkTrack(value.localFake, {
        label: "local-workerd-fake-vectorize",
        runtime: "miniflare/workerd",
        backend: "persistent-fake-index-do",
        realVectorize: false,
    });
    assertBenchmarkTrack(value.deployed, {
        label: "deployed-cloudflare-vectorize",
        runtime: "cloudflare-workers",
        backend: "cloudflare-vectorize",
        realVectorize: true,
    });
    assertBenchmarkTrack(value.localRemoteBinding, {
        label: "local-wrangler-remote-vectorize",
        runtime: "wrangler-dev/workerd",
        backend: "cloudflare-vectorize",
        realVectorize: true,
    });
}

function assertRecovery(value) {
    object(value, "Cloudflare Vectorize recovery proof", [
        "recoveryPointDigest",
        "vectorId",
        "physicalIds",
        "authoritativeVersion",
        "providerReset",
        "reconciliation",
        "providerPresence",
        "restoredRow",
    ]);
    digest(value.recoveryPointDigest, "recovery point digest");
    if (typeof value.vectorId !== "string" || !VECTOR_ID.test(value.vectorId)) {
        throw new Error("recovery vector id is invalid");
    }
    const physicalIds = exactStringArray(value.physicalIds, "recovery physical ids", physicalId, {
        nonempty: true,
        maximum: 2,
    });
    const wireDigest = Buffer.from(value.vectorId.slice("vec1_".length), "hex").toString("base64url");
    if (
        physicalIds.length !== 2 ||
        physicalIds[0] !== `p1_${wireDigest}_1` ||
        physicalIds[1] !== `p1_${wireDigest}_2` ||
        value.authoritativeVersion !== 1
    ) {
        throw new Error("recovery physical identities do not prove restored version 1");
    }
    object(value.providerReset, "recovery provider reset", ["files", "vectors"]);
    if (
        !Number.isSafeInteger(value.providerReset.files) ||
        value.providerReset.files < 0 ||
        !Number.isSafeInteger(value.providerReset.vectors) ||
        value.providerReset.vectors < 1
    ) {
        throw new Error("recovery provider reset did not scrub a vector");
    }
    object(value.reconciliation, "recovery reconciliation", ["filesRehydrated", "vectorsRequeued"]);
    if (
        !Number.isSafeInteger(value.reconciliation.filesRehydrated) ||
        value.reconciliation.filesRehydrated < 0 ||
        !Number.isSafeInteger(value.reconciliation.vectorsRequeued) ||
        value.reconciliation.vectorsRequeued < 1
    ) {
        throw new Error("recovery reconciliation did not requeue a vector");
    }
    object(value.providerPresence, "recovery provider presence", [
        "atPoint",
        "postPoint",
        "afterScrub",
        "afterRequeue",
    ]);
    for (const [name, expected] of [
        ["atPoint", [true, false]],
        ["postPoint", [false, true]],
        ["afterScrub", [false, false]],
        ["afterRequeue", [true, false]],
    ]) {
        if (!isDeepStrictEqual(value.providerPresence[name], expected)) {
            throw new Error(`recovery provider presence ${name} is invalid`);
        }
    }
    object(value.restoredRow, "recovery restored row", ["id", "body"]);
    if (
        typeof value.restoredRow.id !== "string" ||
        !WIRE_ID.test(value.restoredRow.id) ||
        typeof value.restoredRow.body !== "string" ||
        value.restoredRow.body.length < 1 ||
        TEXT.encode(value.restoredRow.body).byteLength > 2_000
    ) {
        throw new Error("recovery restored row is invalid");
    }
    return value;
}

function assertCleanup(value, delivery, liveDelivery, recovery) {
    object(value, "Cloudflare Vectorize proof cleanup", [
        "expectedPhysicalIds",
        "discoveredPhysicalIds",
        "localRemotePhysicalIds",
        "exactIdsDeleted",
        "finalVectorCount",
        "workerDeleted",
        "indexDeleted",
        "workerAbsentVerified",
        "indexAbsentVerified",
    ]);
    const expected = exactStringArray(value.expectedPhysicalIds, "expected cleanup physical ids", physicalId, {
        nonempty: true,
    });
    const discovered = exactStringArray(value.discoveredPhysicalIds, "discovered cleanup physical ids", physicalId);
    const localRemote = exactStringArray(
        value.localRemotePhysicalIds,
        "local remote-binding cleanup physical ids",
        physicalId,
        { nonempty: true }
    );
    const nonLive = new Set([
        delivery.initial.physicalId,
        delivery.upsertResponseLoss.physicalId,
        ...delivery.deleteResponseLoss.physicalIds,
        ...localRemote,
        ...recovery.physicalIds,
    ]);
    const live = expected.filter(item => !nonLive.has(item));
    const liveHashes = new Set(live.map(item => sha256(item)));
    if (
        live.length !== 2 ||
        liveHashes.size !== 2 ||
        !liveHashes.has(liveDelivery.createPhysicalIdSha256) ||
        !liveHashes.has(liveDelivery.replacementPhysicalIdSha256)
    ) {
        throw new Error("cleanup expected ids do not identify both live physical ids");
    }
    const accounted = new Set([...nonLive, ...live]);
    if (expected.some(item => !accounted.has(item)) || accounted.size !== expected.length) {
        throw new Error("cleanup expected ids do not exactly cover every attempted physical id");
    }
    if (discovered.some(item => !accounted.has(item))) {
        throw new Error("cleanup discovered an unledgered physical id");
    }
    if (
        value.exactIdsDeleted !== true ||
        value.finalVectorCount !== 0 ||
        value.workerDeleted !== true ||
        value.indexDeleted !== true ||
        value.workerAbsentVerified !== true ||
        value.indexAbsentVerified !== true
    ) {
        throw new Error("Cloudflare Vectorize proof cleanup is incomplete");
    }
}

function assertEvidence(value) {
    object(value, "Cloudflare Vectorize proof evidence", ["secretScanPassed", "checksumFile", "filesScanned"]);
    if (value.secretScanPassed !== true) throw new Error("Cloudflare Vectorize proof secret scan did not pass");
    if (value.checksumFile !== "evidence.sha256") throw new Error("Cloudflare Vectorize proof checksum file drifted");
    positiveInteger(value.filesScanned, "evidence file count");
}

export function assertCloudflareVectorizeProofReport(report, expectedCandidate) {
    const candidate = assertCandidate(expectedCandidate, "expected Cloudflare Vectorize proof candidate");
    object(report, "Cloudflare Vectorize proof report", [
        "schema",
        "ok",
        "startedAt",
        "completedAt",
        "candidate",
        "target",
        "wranglerVersion",
        "deploymentInput",
        "versions",
        "descriptor",
        "index",
        "lifecycle",
        "delivery",
        "faults",
        "search",
        "settlement",
        "recovery",
        "benchmark",
        "cleanup",
        "evidence",
        "error",
    ]);
    if (report.schema !== CLOUDFLARE_VECTORIZE_PROOF_REPORT_SCHEMA) {
        throw new Error(`Cloudflare Vectorize proof schema must be ${CLOUDFLARE_VECTORIZE_PROOF_REPORT_SCHEMA}`);
    }
    if (report.ok !== true || report.error !== null) throw new Error("Cloudflare Vectorize proof did not succeed");
    if (!isDeepStrictEqual(assertCandidate(report.candidate), candidate)) {
        throw new Error("Cloudflare Vectorize proof does not identify the expected candidate");
    }
    const startedAt = timestamp(report.startedAt, "Cloudflare Vectorize proof start time");
    const completedAt = timestamp(report.completedAt, "Cloudflare Vectorize proof completion time");
    if (completedAt < startedAt) throw new Error("Cloudflare Vectorize proof completion precedes its start");
    assertTarget(report.target, candidate);
    if (report.wranglerVersion !== "4.125.0") throw new Error("Cloudflare Vectorize proof Wrangler version drifted");
    assertDeploymentInput(report.deploymentInput, candidate);
    assertVersions(report.versions);
    assertDescriptor(report.descriptor);
    assertIndex(report.index, report.target);
    assertLifecycle(report.lifecycle);
    assertDelivery(report.delivery);
    assertFaults(report.faults);
    assertSearch(report.search);
    assertSettlement(report.settlement);
    const recovery = assertRecovery(report.recovery);
    assertBenchmark(report.benchmark);
    assertCleanup(report.cleanup, report.delivery, report.search.liveDelivery, recovery);
    assertEvidence(report.evidence);
    return report;
}

export async function fingerprintCloudflareVectorizeProofCandidate(file) {
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
    if (!metadata.isFile()) throw new Error("Cloudflare Vectorize proof candidate must be a file");
    return { algorithm: "sha256", digest: sha256(bytes), bytes: metadata.size };
}

export async function validateCloudflareVectorizeProofEvidence(input) {
    const reportPath = path.resolve(input.report);
    const checksumPath = path.resolve(input.checksum ?? path.join(path.dirname(reportPath), "evidence.sha256"));
    if (
        path.basename(reportPath) !== "vectorize-proof-report.json" ||
        path.basename(checksumPath) !== "evidence.sha256"
    ) {
        throw new Error("Cloudflare Vectorize proof evidence must use the canonical report and checksum filenames");
    }
    const [reportBytes, checksum, candidate] = await Promise.all([
        readFile(reportPath),
        readFile(checksumPath, "utf8"),
        fingerprintCloudflareVectorizeProofCandidate(path.resolve(input.candidate)),
    ]);
    const reportDigest = sha256(reportBytes);
    if (checksum !== `${reportDigest}  vectorize-proof-report.json\n`) {
        throw new Error("Cloudflare Vectorize proof evidence checksum does not match the exact report bytes");
    }
    let report;
    try {
        report = JSON.parse(reportBytes.toString("utf8"));
    } catch {
        throw new Error("Cloudflare Vectorize proof report is not valid JSON");
    }
    assertCloudflareVectorizeProofReport(report, candidate);
    return Object.freeze({
        schema: CLOUDFLARE_VECTORIZE_PROOF_VALIDATION_SCHEMA,
        ok: true,
        candidate,
        reportSha256: reportDigest,
    });
}

export function parseCloudflareVectorizeProofReportArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!["--report", "--candidate", "--checksum"].includes(argument)) {
            throw new Error(`unknown Cloudflare Vectorize proof report argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (!value) throw new Error(`${argument} requires a path`);
        if (values[argument] !== undefined) throw new Error(`${argument} may be provided only once`);
        values[argument] = value;
    }
    if (!values["--report"] || !values["--candidate"]) {
        throw new Error(
            "usage: bun scripts/cloudflare-vectorize-proof-report.mjs --report <report.json> --candidate <package.tgz> [--checksum <evidence.sha256>]"
        );
    }
    return { report: values["--report"], candidate: values["--candidate"], checksum: values["--checksum"] };
}

if (import.meta.main) {
    const input = parseCloudflareVectorizeProofReportArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await validateCloudflareVectorizeProofEvidence(input))}\n`);
}
