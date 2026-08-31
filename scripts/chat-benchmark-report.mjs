const SCHEMA = "chardb.target-benchmark.report.v2";
const COMPARISON_SCHEMA = "chardb.target-benchmark.comparison.v2";
const WORKLOAD_ID = "organization-chat-public-api-v1";
const DRIVER_VERSION = 2;

function finitePositive(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive finite number`);
    }
    return value;
}

function assertRecord(record, label) {
    if (!record || typeof record !== "object") throw new Error(`${label} is missing`);
    if (!Number.isSafeInteger(record.operations) || record.operations < 1) {
        throw new Error(`${label}.operations must be a positive integer`);
    }
    if (!Number.isSafeInteger(record.concurrency) || record.concurrency < 1) {
        throw new Error(`${label}.concurrency must be a positive integer`);
    }
    finitePositive(record.elapsedMs, `${label}.elapsedMs`);
    finitePositive(record.operationsPerSecond, `${label}.operationsPerSecond`);
    if (!Array.isArray(record.rawLatencyMs) || record.rawLatencyMs.length !== record.operations) {
        throw new Error(`${label}.rawLatencyMs must contain one value per operation`);
    }
    for (const value of record.rawLatencyMs) finitePositive(value, `${label}.rawLatencyMs[]`);
    for (const key of ["min", "p50", "p95", "max"])
        finitePositive(record.latencyMs?.[key], `${label}.latencyMs.${key}`);
}

export function assertChatBenchmarkReport(report) {
    if (report?.schema !== SCHEMA) throw new Error(`expected ${SCHEMA}`);
    if (report.ok !== true) throw new Error("benchmark report did not complete successfully");
    if (report.workload?.id !== WORKLOAD_ID || report.workload?.driverVersion !== DRIVER_VERSION) {
        throw new Error("benchmark workload identity is invalid");
    }
    if (report.target?.kind !== "local" && report.target?.kind !== "cloudflare") {
        throw new Error("benchmark target kind must be local or cloudflare");
    }
    if (typeof report.target?.origin !== "string" || !/^https?:\/\//.test(report.target.origin)) {
        throw new Error("benchmark target origin is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(report.candidate?.sha256 ?? "")) {
        throw new Error("benchmark candidate sha256 is invalid");
    }
    if (typeof report.profile?.name !== "string" || report.profile.name.length === 0) {
        throw new Error("benchmark profile is missing");
    }
    for (const key of [
        "directQueries",
        "directConcurrency",
        "liveUpdates",
        "liveConcurrency",
        "seedRows",
        "replacementClients",
    ]) {
        if (!Number.isSafeInteger(report.profile[key]) || report.profile[key] < 1) {
            throw new Error(`benchmark profile ${key} must be a positive integer`);
        }
    }
    if (
        report.run?.processSamples !== 1 ||
        typeof report.run?.startedAt !== "string" ||
        typeof report.run?.completedAt !== "string"
    ) {
        throw new Error("benchmark run identity is invalid");
    }
    if (report.candidate?.verifiedByTarget !== true) throw new Error("target did not verify the candidate digest");
    assertRecord(report.metrics?.directRead, "metrics.directRead");
    assertRecord(report.metrics?.liveMutation, "metrics.liveMutation");
    assertRecord(report.metrics?.liveMutationAck, "metrics.liveMutationAck");
    assertRecord(report.metrics?.liveOwnerSnapshot, "metrics.liveOwnerSnapshot");
    assertRecord(report.metrics?.liveObserverSnapshot, "metrics.liveObserverSnapshot");
    const expected = report.invariants;
    for (const key of [
        "nativeBetterAuth",
        "organizationIsolation",
        "exactDirectRows",
        "overLimitDenied",
        "twoClientLiveDelivery",
        "mutationReplayStable",
    ]) {
        if (expected?.[key] !== true) throw new Error(`benchmark invariant ${key} did not pass`);
    }
    return report;
}

function comparableIdentity(report) {
    return JSON.stringify({
        candidate: report.candidate.sha256,
        workload: report.workload,
        profile: report.profile,
        processSamples: report.run.processSamples,
        direct: {
            operations: report.metrics.directRead.operations,
            concurrency: report.metrics.directRead.concurrency,
        },
        live: {
            operations: report.metrics.liveMutation.operations,
            concurrency: report.metrics.liveMutation.concurrency,
        },
    });
}

function ratio(deployed, local) {
    return deployed / local;
}

function metricRatios(deployed, local) {
    return {
        throughput: ratio(deployed.operationsPerSecond, local.operationsPerSecond),
        latencyP50: ratio(deployed.latencyMs.p50, local.latencyMs.p50),
        latencyP95: ratio(deployed.latencyMs.p95, local.latencyMs.p95),
    };
}

export function compareChatBenchmarkReports(localInput, deployedInput) {
    const local = assertChatBenchmarkReport(localInput);
    const deployed = assertChatBenchmarkReport(deployedInput);
    if (local.target.kind !== "local") throw new Error("comparison baseline must have target.kind=local");
    if (deployed.target.kind !== "cloudflare") {
        throw new Error("comparison candidate must have target.kind=cloudflare");
    }
    if (comparableIdentity(local) !== comparableIdentity(deployed)) {
        throw new Error("local and Cloudflare benchmark workloads are not comparable");
    }
    return {
        schema: COMPARISON_SCHEMA,
        candidate: structuredClone(local.candidate),
        profile: structuredClone(local.profile),
        local: {
            origin: local.target.origin,
            runner: structuredClone(local.runner),
            targetRuntime: structuredClone(local.target.runtime),
        },
        cloudflare: {
            origin: deployed.target.origin,
            runner: structuredClone(deployed.runner),
            targetRuntime: structuredClone(deployed.target.runtime),
        },
        ratios: {
            directRead: metricRatios(deployed.metrics.directRead, local.metrics.directRead),
            liveMutation: metricRatios(deployed.metrics.liveMutation, local.metrics.liveMutation),
            liveMutationAck: metricRatios(deployed.metrics.liveMutationAck, local.metrics.liveMutationAck),
            liveOwnerSnapshot: metricRatios(deployed.metrics.liveOwnerSnapshot, local.metrics.liveOwnerSnapshot),
            liveObserverSnapshot: metricRatios(
                deployed.metrics.liveObserverSnapshot,
                local.metrics.liveObserverSnapshot
            ),
        },
    };
}

export const CHAT_BENCHMARK_SCHEMA = SCHEMA;
export const CHAT_BENCHMARK_COMPARISON_SCHEMA = COMPARISON_SCHEMA;
export const CHAT_BENCHMARK_WORKLOAD_ID = WORKLOAD_ID;
export const CHAT_BENCHMARK_DRIVER_VERSION = DRIVER_VERSION;
