import { FILE_RESHARD_BENCHMARK_PHASES, fileReshardBenchmarkProfile } from "./file-reshard-benchmark-report.mjs";

export const FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA = "chardb.file-vector-reshard-deployment-sample.v3";
export const FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA = "chardb.file-vector-reshard-deployment-pair.v3";
export const FILE_RESHARD_DEPLOYMENT_CAPABILITIES_SCHEMA = "chardb.file-vector-reshard-proof-capabilities.v3";
export const FILE_RESHARD_DEPLOYMENT_TEARDOWN_SCHEMA = "chardb.file-vector-reshard-proof-teardown.v2";
export const FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA = "chardb.file-reshard-proof-fault.v1";
export const FILE_RESHARD_DEPLOYMENT_BINDINGS = Object.freeze([
    "CDB_CATALOG",
    "CDB_FILES",
    "CDB_PROOF_VECTORS",
    "CDB_RESHARD",
    "CDB_SHARD",
]);
export const FILE_RESHARD_LOCAL_BINDINGS = Object.freeze([
    "CDB_CATALOG",
    "CDB_FILES",
    "CDB_RESHARD",
    "CDB_SHARD",
    "CDB_VECTOR_PROBE",
]);
export const FILE_RESHARD_DEPLOYMENT_CORRECTNESS = Object.freeze([
    "alarmConverged",
    "catalogCutover",
    "destinationServing",
    "fileParity",
    "r2Stable",
    "retainedContentStable",
    "responseLossRecovered",
    "sourceDrained",
    "sourceFenced",
    "destinationPublicSearch",
    "sourceVectorDrained",
    "vectorAttemptContinuity",
    "vectorHeadParity",
    "vectorOutboxContinuity",
    "vectorPhysicalIdentityStable",
    "vectorProviderNoMovementMutation",
]);

const DIGEST = /^[a-f0-9]{64}$/;
const TARGET_KINDS = new Set(["local", "deployed"]);

function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
}

function exact(value, label, keys) {
    object(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
    }
}

function string(value, label, pattern) {
    if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function integer(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
    return value;
}

function finite(value, label, minimum = 0) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
        throw new Error(`${label} must be a finite number >= ${minimum}`);
    }
    return value;
}

function canonicalIso(value, label) {
    string(value, label);
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error(`${label} must be a canonical ISO timestamp`);
    }
}

function digest(value, label) {
    string(value, label, DIGEST);
}

function assertTargetIdentity(target, expectedKind, label) {
    exact(target, label, [
        "kind",
        "runtime",
        "deploymentVersion",
        "configurationSha256",
        "bindings",
        "sourceShard",
        "destinationShard",
        "r2Bucket",
        "vectorizeIndex",
    ]);
    if (!TARGET_KINDS.has(target.kind) || (expectedKind && target.kind !== expectedKind)) {
        throw new Error(`${label}.kind is invalid`);
    }
    string(target.runtime, `${label}.runtime`);
    string(target.deploymentVersion, `${label}.deploymentVersion`);
    digest(target.configurationSha256, `${label}.configurationSha256`);
    const expectedBindings = target.kind === "local" ? FILE_RESHARD_LOCAL_BINDINGS : FILE_RESHARD_DEPLOYMENT_BINDINGS;
    if (JSON.stringify(target.bindings) !== JSON.stringify(expectedBindings)) {
        throw new Error(`${label}.bindings do not prove the required deployed architecture`);
    }
    string(target.sourceShard, `${label}.sourceShard`);
    string(target.destinationShard, `${label}.destinationShard`);
    if (target.sourceShard === target.destinationShard) throw new Error(`${label} must use two distinct Cdbs`);
    string(target.r2Bucket, `${label}.r2Bucket`);
    string(target.vectorizeIndex, `${label}.vectorizeIndex`);
}

export function assertFileReshardDeploymentCapabilities(input, expected) {
    const capabilities = object(input, "file reshard deployment capabilities");
    exact(capabilities, "file reshard deployment capabilities", [
        "schema",
        "releaseSha256",
        "runId",
        "target",
        "protocol",
        "features",
    ]);
    if (capabilities.schema !== FILE_RESHARD_DEPLOYMENT_CAPABILITIES_SCHEMA) {
        throw new Error("file reshard deployment capability schema drifted");
    }
    digest(capabilities.releaseSha256, "capabilities.releaseSha256");
    string(capabilities.runId, "capabilities.runId", /^[A-Za-z0-9_-]{16,128}$/);
    if (expected?.releaseSha256 && capabilities.releaseSha256 !== expected.releaseSha256) {
        throw new Error("capabilities release digest drifted");
    }
    if (expected?.runId && capabilities.runId !== expected.runId) throw new Error("capabilities run ID drifted");
    assertTargetIdentity(capabilities.target, expected?.kind, "capabilities.target");
    if (expected?.configurationSha256 && capabilities.target.configurationSha256 !== expected.configurationSha256) {
        throw new Error("capabilities configuration digest drifted");
    }
    if (capabilities.protocol !== "bounded-operator-v1") throw new Error("capabilities protocol is invalid");
    exact(capabilities.features, "capabilities.features", [
        "alarms",
        "commitThenResponseLoss",
        "directR2OperationTrace",
        "fileAwareReshard",
        "freshDisposableData",
        "providerVectorMutationTrace",
        "publicVectorSearch",
        "retainedFileRecovery",
        "vectorAwareReshard",
    ]);
    for (const [name, value] of Object.entries(capabilities.features)) {
        const expectedValue =
            name === "directR2OperationTrace" || name === "providerVectorMutationTrace"
                ? capabilities.target.kind === "local"
                : true;
        if (value !== expectedValue) throw new Error(`capabilities.features.${name} is invalid for this target`);
    }
    return capabilities;
}

export function assertFileReshardDeploymentFault(input, expected) {
    const fault = object(input, "file reshard deployment response-loss receipt");
    exact(fault, "file reshard deployment response-loss receipt", [
        "schema",
        "runKey",
        "operation",
        "committed",
        "retryable",
    ]);
    if (fault.schema !== FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA) throw new Error("response-loss schema drifted");
    if (fault.runKey !== expected.runKey) throw new Error("response-loss run key drifted");
    if (fault.operation !== expected.operation) throw new Error("response-loss operation drifted");
    if (fault.committed !== true || fault.retryable !== true) {
        throw new Error("response loss must occur after a committed retryable operation");
    }
    return fault;
}

export function assertFileReshardDeploymentTeardown(input, expected = {}) {
    const teardown = object(input, "file vector reshard teardown");
    exact(teardown, "file vector reshard teardown", [
        "schema",
        "ok",
        "candidateSha256",
        "worker",
        "bucket",
        "vectorizeIndex",
        "localStateStopped",
        "workerDeleted",
        "bucketDeleted",
        "vectorizeIndexDeleted",
        "workerAbsentVerified",
        "bucketAbsentVerified",
        "vectorizeIndexAbsentVerified",
        "idempotentReplay",
    ]);
    if (teardown.schema !== FILE_RESHARD_DEPLOYMENT_TEARDOWN_SCHEMA || teardown.ok !== true) {
        throw new Error("file vector reshard teardown did not pass");
    }
    digest(teardown.candidateSha256, "teardown.candidateSha256");
    if (expected.candidateSha256 && teardown.candidateSha256 !== expected.candidateSha256) {
        throw new Error("file vector reshard teardown candidate drifted");
    }
    for (const name of ["worker", "bucket", "vectorizeIndex"]) string(teardown[name], `teardown.${name}`);
    if (teardown.worker !== teardown.bucket || teardown.worker !== teardown.vectorizeIndex) {
        throw new Error("file vector reshard teardown target identity drifted");
    }
    for (const name of [
        "localStateStopped",
        "workerDeleted",
        "bucketDeleted",
        "vectorizeIndexDeleted",
        "workerAbsentVerified",
        "bucketAbsentVerified",
        "vectorizeIndexAbsentVerified",
    ]) {
        if (teardown[name] !== true) throw new Error(`file vector reshard teardown ${name} is incomplete`);
    }
    exact(teardown.idempotentReplay, "teardown.idempotentReplay", ["done", "remaining"]);
    if (teardown.idempotentReplay.done !== true || teardown.idempotentReplay.remaining !== 0) {
        throw new Error("file vector reshard teardown idempotent cleanup is incomplete");
    }
    return teardown;
}

export function assertFileReshardDeploymentSample(input, expected = {}) {
    const sample = object(input, "file reshard deployment sample");
    exact(sample, "file reshard deployment sample", [
        "schema",
        "sequence",
        "excluded",
        "candidateSha256",
        "runKey",
        "workload",
        "target",
        "execution",
        "dataset",
        "timing",
        "movement",
        "responseLoss",
        "alarm",
        "correctness",
    ]);
    if (sample.schema !== FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA) throw new Error("deployment sample schema drifted");
    integer(sample.sequence, "sample.sequence", -1);
    if (sample.excluded !== (sample.sequence === -1)) throw new Error("sample warmup identity drifted");
    digest(sample.candidateSha256, "sample.candidateSha256");
    string(sample.runKey, "sample.runKey", /^[A-Za-z0-9_-]{16,128}$/);
    if (expected.sequence !== undefined && sample.sequence !== expected.sequence)
        throw new Error("sample sequence drifted");
    if (expected.runKey && sample.runKey !== expected.runKey) throw new Error("sample run key drifted");
    if (expected.candidateSha256 && sample.candidateSha256 !== expected.candidateSha256) {
        throw new Error("sample candidate drifted");
    }
    exact(sample.workload, "sample.workload", ["id", "version", "profile"]);
    if (sample.workload.id !== "file-vector-aware-range-move" || sample.workload.version !== 3) {
        throw new Error("sample workload identity drifted");
    }
    const profile = fileReshardBenchmarkProfile(sample.workload.profile.name);
    if (JSON.stringify(sample.workload.profile) !== JSON.stringify(profile)) throw new Error("sample profile drifted");
    if (expected.profile && profile.name !== expected.profile) throw new Error("sample profile does not match request");
    assertTargetIdentity(sample.target, expected.kind, "sample.target");
    exact(sample.execution, "sample.execution", ["startedAt", "completedAt", "requestAttempts"]);
    canonicalIso(sample.execution.startedAt, "sample.execution.startedAt");
    canonicalIso(sample.execution.completedAt, "sample.execution.completedAt");
    if (sample.execution.requestAttempts !== 2) {
        throw new Error("sample must contain exactly one lost response and one retry");
    }
    if (Date.parse(sample.execution.completedAt) < Date.parse(sample.execution.startedAt)) {
        throw new Error("sample completion precedes its start");
    }
    exact(sample.dataset, "sample.dataset", ["organizations", "files", "metadataRows", "vectors", "objectBytes"]);
    if (
        sample.dataset.organizations !== profile.organizations ||
        sample.dataset.files !== profile.files ||
        sample.dataset.metadataRows !== profile.files ||
        sample.dataset.vectors !== profile.files
    ) {
        throw new Error("sample dataset drifted from its profile");
    }
    integer(sample.dataset.objectBytes, "sample.dataset.objectBytes", profile.files);
    exact(sample.timing, "sample.timing", ["totalMs", "phasesMs"]);
    finite(sample.timing.totalMs, "sample.timing.totalMs", Number.EPSILON);
    exact(sample.timing.phasesMs, "sample.timing.phasesMs", FILE_RESHARD_BENCHMARK_PHASES);
    for (const phase of FILE_RESHARD_BENCHMARK_PHASES) finite(sample.timing.phasesMs[phase], `phasesMs.${phase}`);
    exact(sample.movement, "sample.movement", ["runTurns", "routeEpochBefore", "routeEpochAfter", "r2", "vectors"]);
    integer(sample.movement.runTurns, "sample.movement.runTurns", 1);
    integer(sample.movement.routeEpochBefore, "sample.movement.routeEpochBefore", 1);
    if (sample.movement.routeEpochAfter !== sample.movement.routeEpochBefore + 1) {
        throw new Error("sample route epoch did not advance exactly once");
    }
    exact(sample.movement.r2, "sample.movement.r2", [
        "objectsBefore",
        "objectsAfter",
        "bytesBefore",
        "bytesAfter",
        "identityDigestBefore",
        "identityDigestAfter",
        "operationTrace",
    ]);
    if (
        sample.movement.r2.objectsBefore !== profile.files ||
        sample.movement.r2.objectsAfter !== profile.files ||
        sample.movement.r2.bytesAfter !== sample.movement.r2.bytesBefore ||
        sample.movement.r2.identityDigestAfter !== sample.movement.r2.identityDigestBefore
    ) {
        throw new Error("sample R2 identity changed during movement");
    }
    integer(sample.movement.r2.bytesBefore, "sample.movement.r2.bytesBefore", profile.files);
    digest(sample.movement.r2.identityDigestBefore, "sample.movement.r2.identityDigestBefore");
    digest(sample.movement.r2.identityDigestAfter, "sample.movement.r2.identityDigestAfter");
    exact(sample.movement.r2.operationTrace, "sample.movement.r2.operationTrace", [
        "available",
        "method",
        "putsDuringMove",
        "deletesDuringMove",
    ]);
    if (sample.target.kind === "local") {
        if (
            sample.movement.r2.operationTrace.available !== true ||
            sample.movement.r2.operationTrace.method !== "cdb-r2-proxy" ||
            sample.movement.r2.operationTrace.putsDuringMove !== 0 ||
            sample.movement.r2.operationTrace.deletesDuringMove !== 0
        ) {
            throw new Error("local sample did not prove zero Cdb R2 movement operations");
        }
    } else if (
        sample.movement.r2.operationTrace.available !== false ||
        sample.movement.r2.operationTrace.method !== "unavailable-native-binding" ||
        sample.movement.r2.operationTrace.putsDuringMove !== null ||
        sample.movement.r2.operationTrace.deletesDuringMove !== null
    ) {
        throw new Error("deployed sample must report Cdb R2 operation counts as unobservable");
    }
    exact(sample.movement.vectors, "sample.movement.vectors", [
        "headsBefore",
        "headsAfter",
        "readyHeadsBefore",
        "readyHeadsAfter",
        "outboxBefore",
        "outboxAfter",
        "attemptsBefore",
        "attemptsAfter",
        "headDigestBefore",
        "headDigestAfter",
        "outboxDigestBefore",
        "outboxDigestAfter",
        "attemptDigestBefore",
        "attemptDigestAfter",
        "physicalIdsBefore",
        "physicalIdsAfter",
        "physicalIdentityDigestBefore",
        "physicalIdentityDigestAfter",
        "providerRecordsBefore",
        "providerRecordsAfter",
        "providerMutationTrace",
        "search",
    ]);
    const vectors = sample.movement.vectors;
    for (const name of [
        "headsBefore",
        "headsAfter",
        "readyHeadsBefore",
        "readyHeadsAfter",
        "outboxBefore",
        "outboxAfter",
        "attemptsBefore",
        "attemptsAfter",
        "providerRecordsBefore",
        "providerRecordsAfter",
    ]) {
        integer(vectors[name], `sample.movement.vectors.${name}`);
    }
    if (
        vectors.headsBefore !== profile.files ||
        vectors.headsAfter !== profile.files ||
        vectors.readyHeadsBefore !== profile.files ||
        vectors.readyHeadsAfter !== profile.files ||
        vectors.providerRecordsBefore !== profile.files ||
        vectors.providerRecordsAfter !== profile.files ||
        vectors.outboxBefore !== vectors.outboxAfter ||
        vectors.attemptsBefore !== vectors.attemptsAfter
    ) {
        throw new Error("sample vector system-row cardinality changed during movement");
    }
    for (const name of [
        "headDigestBefore",
        "headDigestAfter",
        "outboxDigestBefore",
        "outboxDigestAfter",
        "attemptDigestBefore",
        "attemptDigestAfter",
        "physicalIdentityDigestBefore",
        "physicalIdentityDigestAfter",
    ]) {
        digest(vectors[name], `sample.movement.vectors.${name}`);
    }
    if (
        vectors.headDigestBefore !== vectors.headDigestAfter ||
        vectors.outboxDigestBefore !== vectors.outboxDigestAfter ||
        vectors.attemptDigestBefore !== vectors.attemptDigestAfter ||
        vectors.physicalIdentityDigestBefore !== vectors.physicalIdentityDigestAfter
    ) {
        throw new Error("sample vector head, outbox, attempt, or physical identity changed during movement");
    }
    for (const name of ["physicalIdsBefore", "physicalIdsAfter"]) {
        if (
            !Array.isArray(vectors[name]) ||
            vectors[name].length !== profile.files ||
            new Set(vectors[name]).size !== profile.files ||
            vectors[name].some(value => typeof value !== "string" || value.length === 0)
        ) {
            throw new Error(`sample.movement.vectors.${name} is invalid`);
        }
    }
    if (JSON.stringify(vectors.physicalIdsBefore) !== JSON.stringify(vectors.physicalIdsAfter)) {
        throw new Error("sample vector physical IDs changed during movement");
    }
    exact(vectors.providerMutationTrace, "sample.movement.vectors.providerMutationTrace", [
        "available",
        "method",
        "upsertsDuringMove",
        "deletesDuringMove",
    ]);
    if (sample.target.kind === "local") {
        if (
            vectors.providerMutationTrace.available !== true ||
            vectors.providerMutationTrace.method !== "durable-object-vector-probe" ||
            vectors.providerMutationTrace.upsertsDuringMove !== 0 ||
            vectors.providerMutationTrace.deletesDuringMove !== 0
        ) {
            throw new Error("local sample did not prove zero provider vector movement mutations");
        }
    } else if (
        vectors.providerMutationTrace.available !== false ||
        vectors.providerMutationTrace.method !== "stable-physical-identity" ||
        vectors.providerMutationTrace.upsertsDuringMove !== null ||
        vectors.providerMutationTrace.deletesDuringMove !== null
    ) {
        throw new Error("deployed sample must use stable physical identity instead of invented provider call counts");
    }
    exact(vectors.search, "sample.movement.vectors.search", ["rowPk", "score"]);
    string(vectors.search.rowPk, "sample.movement.vectors.search.rowPk");
    finite(vectors.search.score, "sample.movement.vectors.search.score");
    exact(sample.responseLoss, "sample.responseLoss", [
        "operation",
        "firstStatus",
        "committed",
        "sameRunKey",
        "retrySucceeded",
    ]);
    if (sample.responseLoss.operation !== "apply_snapshot") {
        throw new Error("sample response loss did not exercise snapshot application");
    }
    if (
        sample.responseLoss.firstStatus !== 503 ||
        sample.responseLoss.committed !== true ||
        sample.responseLoss.sameRunKey !== true ||
        sample.responseLoss.retrySucceeded !== true
    ) {
        throw new Error("sample did not prove network response-loss recovery");
    }
    exact(sample.alarm, "sample.alarm", [
        "invoked",
        "durable",
        "ownerShard",
        "deletedMetadataRows",
        "remainingMetadataRows",
        "retainedObjects",
    ]);
    if (sample.alarm.invoked !== true || sample.alarm.durable !== true) throw new Error("sample alarm proof failed");
    string(sample.alarm.ownerShard, "sample.alarm.ownerShard");
    integer(sample.alarm.deletedMetadataRows, "sample.alarm.deletedMetadataRows", 1);
    integer(sample.alarm.remainingMetadataRows, "sample.alarm.remainingMetadataRows");
    integer(sample.alarm.retainedObjects, "sample.alarm.retainedObjects", profile.files);
    if (
        sample.alarm.ownerShard !== sample.target.destinationShard ||
        sample.alarm.deletedMetadataRows + sample.alarm.remainingMetadataRows !== profile.files ||
        sample.alarm.retainedObjects !== profile.files
    ) {
        throw new Error(
            "sample alarm did not run on the destination owner, clean metadata, and retain the exact recovery dataset"
        );
    }
    exact(sample.correctness, "sample.correctness", FILE_RESHARD_DEPLOYMENT_CORRECTNESS);
    for (const name of FILE_RESHARD_DEPLOYMENT_CORRECTNESS) {
        if (sample.correctness[name] !== true) throw new Error(`sample.correctness.${name} did not pass`);
    }
    return sample;
}

function distribution(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    return Object.freeze({ min: sorted[0], p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) });
}

export function compareFileReshardDeploymentSamples(localSamples, deployedSamples, profileName) {
    const profile = fileReshardBenchmarkProfile(profileName);
    if (!Array.isArray(localSamples) || !Array.isArray(deployedSamples)) throw new Error("paired samples are required");
    if (localSamples.length !== profile.logicalRuns || deployedSamples.length !== profile.logicalRuns) {
        throw new Error(`paired samples must contain ${profile.logicalRuns} runs per target`);
    }
    const local = localSamples.map((sample, sequence) =>
        assertFileReshardDeploymentSample(sample, { sequence, profile: profile.name, kind: "local" })
    );
    const deployed = deployedSamples.map((sample, sequence) =>
        assertFileReshardDeploymentSample(sample, { sequence, profile: profile.name, kind: "deployed" })
    );
    for (let sequence = 0; sequence < profile.logicalRuns; sequence++) {
        if (local[sequence].runKey !== deployed[sequence].runKey) {
            throw new Error(`paired sample ${sequence} semantic run key drifted`);
        }
        if (local[sequence].candidateSha256 !== deployed[sequence].candidateSha256) {
            throw new Error(`paired sample ${sequence} candidate drifted`);
        }
        if (JSON.stringify(local[sequence].dataset) !== JSON.stringify(deployed[sequence].dataset)) {
            throw new Error(`paired sample ${sequence} dataset drifted`);
        }
        const localMovement = local[sequence].movement;
        const deployedMovement = deployed[sequence].movement;
        for (const field of ["configurationSha256", "sourceShard", "destinationShard", "r2Bucket", "vectorizeIndex"]) {
            if (local[sequence].target[field] !== deployed[sequence].target[field]) {
                throw new Error(`paired sample ${sequence} target ${field} drifted`);
            }
        }
        for (const field of ["runTurns", "routeEpochBefore", "routeEpochAfter"]) {
            if (localMovement[field] !== deployedMovement[field]) {
                throw new Error(`paired sample ${sequence} movement ${field} drifted`);
            }
        }
        for (const field of ["objectsBefore", "objectsAfter", "bytesBefore", "bytesAfter"]) {
            if (localMovement.r2[field] !== deployedMovement.r2[field]) {
                throw new Error(`paired sample ${sequence} R2 ${field} drifted`);
            }
        }
        for (const field of [
            "headsBefore",
            "headsAfter",
            "readyHeadsBefore",
            "readyHeadsAfter",
            "outboxBefore",
            "outboxAfter",
            "attemptsBefore",
            "attemptsAfter",
            "providerRecordsBefore",
            "providerRecordsAfter",
        ]) {
            if (localMovement.vectors[field] !== deployedMovement.vectors[field]) {
                throw new Error(`paired sample ${sequence} vector ${field} drifted`);
            }
        }
        if (localMovement.vectors.search.rowPk !== deployedMovement.vectors.search.rowPk) {
            throw new Error(`paired sample ${sequence} public search row drifted`);
        }
        if (JSON.stringify(local[sequence].alarm) !== JSON.stringify(deployed[sequence].alarm)) {
            throw new Error(`paired sample ${sequence} alarm semantics drifted`);
        }
    }
    const localTotals = local.map(sample => sample.timing.totalMs);
    const deployedTotals = deployed.map(sample => sample.timing.totalMs);
    return Object.freeze({
        localTotalMs: distribution(localTotals),
        deployedTotalMs: distribution(deployedTotals),
        deployedToLocalP50:
            deployedTotals.slice().sort((a, b) => a - b)[Math.floor(deployedTotals.length / 2)] /
            localTotals.slice().sort((a, b) => a - b)[Math.floor(localTotals.length / 2)],
        r2OperationObservability: { local: "exact-cdb-proxy", deployed: "unobservable-native-binding" },
        descriptiveOnly: true,
    });
}

export function assertFileReshardDeploymentPair(input) {
    const pair = object(input, "file reshard deployment pair");
    exact(pair, "file reshard deployment pair", [
        "schema",
        "ok",
        "candidate",
        "profile",
        "execution",
        "deployment",
        "warmup",
        "runs",
        "comparison",
    ]);
    if (pair.schema !== FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA || pair.ok !== true) {
        throw new Error("file reshard deployment pair is not successful");
    }
    exact(pair.candidate, "pair.candidate", ["sha256", "bytes"]);
    digest(pair.candidate.sha256, "pair.candidate.sha256");
    integer(pair.candidate.bytes, "pair.candidate.bytes", 1);
    const profile = fileReshardBenchmarkProfile(pair.profile.name);
    if (JSON.stringify(pair.profile) !== JSON.stringify(profile)) throw new Error("pair profile drifted");
    exact(pair.execution, "pair.execution", ["startedAt", "completedAt", "order"]);
    canonicalIso(pair.execution.startedAt, "pair.execution.startedAt");
    canonicalIso(pair.execution.completedAt, "pair.execution.completedAt");
    if (!Array.isArray(pair.execution.order) || pair.execution.order.length !== profile.logicalRuns + 1) {
        throw new Error("pair execution order is invalid");
    }
    for (let index = 0; index < pair.execution.order.length; index++) {
        const step = pair.execution.order[index];
        exact(step, `pair.execution.order.${index}`, ["sequence", "targets"]);
        const expectedSequence = index - 1;
        const expectedTargets = index % 2 === 0 ? ["local", "deployed"] : ["deployed", "local"];
        if (step.sequence !== expectedSequence || JSON.stringify(step.targets) !== JSON.stringify(expectedTargets)) {
            throw new Error(`pair execution order ${index} drifted`);
        }
    }
    exact(pair.deployment, "pair.deployment", ["worker", "bucket", "vectorizeIndex", "version", "accountIdSha256"]);
    string(pair.deployment.worker, "pair.deployment.worker");
    string(pair.deployment.bucket, "pair.deployment.bucket");
    string(pair.deployment.vectorizeIndex, "pair.deployment.vectorizeIndex");
    string(pair.deployment.version, "pair.deployment.version");
    digest(pair.deployment.accountIdSha256, "pair.deployment.accountIdSha256");
    if (
        pair.deployment.worker !== pair.deployment.bucket ||
        pair.deployment.worker !== pair.deployment.vectorizeIndex
    ) {
        throw new Error("pair deployment Worker, R2 bucket, and Vectorize index identity drifted");
    }
    exact(pair.warmup, "pair.warmup", ["local", "deployed"]);
    assertFileReshardDeploymentSample(pair.warmup.local, {
        sequence: -1,
        profile: profile.name,
        kind: "local",
        candidateSha256: pair.candidate.sha256,
    });
    assertFileReshardDeploymentSample(pair.warmup.deployed, {
        sequence: -1,
        profile: profile.name,
        kind: "deployed",
        candidateSha256: pair.candidate.sha256,
    });
    if (!Array.isArray(pair.runs) || pair.runs.length !== profile.logicalRuns)
        throw new Error("pair runs are incomplete");
    const local = [];
    const deployed = [];
    for (let sequence = 0; sequence < pair.runs.length; sequence++) {
        exact(pair.runs[sequence], `pair.runs.${sequence}`, ["sequence", "local", "deployed"]);
        if (pair.runs[sequence].sequence !== sequence) throw new Error(`pair run ${sequence} sequence drifted`);
        local.push(
            assertFileReshardDeploymentSample(pair.runs[sequence].local, {
                sequence,
                profile: profile.name,
                kind: "local",
                candidateSha256: pair.candidate.sha256,
            })
        );
        deployed.push(
            assertFileReshardDeploymentSample(pair.runs[sequence].deployed, {
                sequence,
                profile: profile.name,
                kind: "deployed",
                candidateSha256: pair.candidate.sha256,
            })
        );
    }
    for (const [label, sample] of [
        ["warmup", pair.warmup.deployed],
        ...deployed.map((sample, sequence) => [`run ${sequence}`, sample]),
    ]) {
        if (
            sample.target.deploymentVersion !== pair.deployment.version ||
            sample.target.r2Bucket !== pair.deployment.bucket ||
            sample.target.vectorizeIndex !== pair.deployment.vectorizeIndex
        ) {
            throw new Error(`pair deployed ${label} target identity drifted from deployment`);
        }
    }
    const comparison = compareFileReshardDeploymentSamples(local, deployed, profile.name);
    if (JSON.stringify(pair.comparison) !== JSON.stringify(comparison)) throw new Error("pair comparison drifted");
    return pair;
}
