export const FILE_BENCHMARK_SCHEMA = "chardb.file-benchmark.report.v1";
export const FILE_BENCHMARK_WORKLOAD_ID = "organization-file-lifecycle";
export const FILE_BENCHMARK_WORKLOAD_VERSION = 1;
export const FILE_BENCHMARK_PROFILE = Object.freeze({
    name: "standard-v1",
    logicalRuns: 5,
    payloads: Object.freeze([
        Object.freeze({
            name: "small",
            payloadBytes: 64 * 1_024,
            warmupObjectsPerRun: 1,
            operationsPerRun: Object.freeze({
                upload: Object.freeze({ count: 32, concurrency: 4 }),
                attach: Object.freeze({ count: 32, concurrency: 4 }),
                download: Object.freeze({ count: 64, concurrency: 8 }),
            }),
        }),
        Object.freeze({
            name: "large",
            payloadBytes: 5 * 1_024 * 1_024,
            warmupObjectsPerRun: 1,
            operationsPerRun: Object.freeze({
                upload: Object.freeze({ count: 4, concurrency: 1 }),
                attach: Object.freeze({ count: 4, concurrency: 1 }),
                download: Object.freeze({ count: 8, concurrency: 2 }),
            }),
        }),
    ]),
});

const OPERATIONS = ["upload", "attach", "download"];
const CORRECTNESS_FLAGS = [
    "authenticated",
    "organizationIsolated",
    "operationStatus",
    "exactBytes",
    "exactDigest",
    "cleanupComplete",
];

function record(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function nonemptyString(value, label) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
    return value;
}

function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
    return value;
}

function nonnegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
    return value;
}

function finitePositive(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive finite number`);
    }
    return value;
}

function finiteNonnegative(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite non-negative number`);
    }
    return value;
}

function assertIsoTimestamp(value, label) {
    nonemptyString(value, label);
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error(`${label} must be a canonical ISO timestamp`);
    }
}

function percentile(sorted, quantile) {
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function latencySummary(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return {
        min: sorted[0],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1),
    };
}

function approximatelyEqual(actual, expected) {
    return Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-9;
}

function assertCorrectness(correctness, label) {
    record(correctness, label);
    for (const flag of CORRECTNESS_FLAGS) {
        if (correctness[flag] !== true) throw new Error(`${label}.${flag} did not pass`);
    }
}

function assertOperationSample(sample, index, operation, payloadPlan, label) {
    record(sample, label);
    if (sample.sequence !== index) throw new Error(`${label}.sequence must equal its operation array index`);
    nonnegativeInteger(sample.objectSequence, `${label}.objectSequence`);
    if (sample.objectSequence >= payloadPlan.operationsPerRun.upload.count) {
        throw new Error(`${label}.objectSequence does not identify an uploaded object`);
    }
    finitePositive(sample.latencyMs, `${label}.latencyMs`);
    const expectedBytes = operation === "attach" ? 0 : payloadPlan.payloadBytes;
    if (sample.bytes !== expectedBytes) throw new Error(`${label}.bytes must equal ${expectedBytes}`);
    assertCorrectness(sample.correctness, `${label}.correctness`);
}

function assertObjectDistribution(samples, operation, payloadPlan, label) {
    const expectedPerObject = payloadPlan.operationsPerRun[operation].count / payloadPlan.operationsPerRun.upload.count;
    if (!Number.isSafeInteger(expectedPerObject)) throw new Error(`${label} does not divide evenly across objects`);
    const counts = new Array(payloadPlan.operationsPerRun.upload.count).fill(0);
    for (const sample of samples) counts[sample.objectSequence] += 1;
    if (counts.some(count => count !== expectedPerObject)) {
        throw new Error(`${label} must distribute operations evenly across uploaded objects`);
    }
}

function assertOperationSamples(samples, operation, payloadPlan, label, expectedCount) {
    if (!Array.isArray(samples) || samples.length !== expectedCount) {
        throw new Error(`${label} must contain ${expectedCount} samples`);
    }
    samples.forEach((sample, index) =>
        assertOperationSample(sample, index, operation, payloadPlan, `${label}[${index}]`)
    );
    assertObjectDistribution(samples, operation, payloadPlan, label);
}

function assertWarmup(warmup, payloadPlan, label) {
    record(warmup, label);
    if (warmup.excluded !== true) throw new Error(`${label} must be excluded from measured samples`);
    const operations = record(warmup.operations, `${label}.operations`);
    for (const operation of OPERATIONS) {
        assertOperationSample(operations[operation], 0, operation, payloadPlan, `${label}.operations.${operation}`);
        if (operations[operation].objectSequence !== 0) {
            throw new Error(`${label}.operations.${operation} must use the one warmup object`);
        }
    }
}

function assertRunPayload(measurement, index, payloadPlan, label) {
    record(measurement, label);
    if (measurement.name !== payloadPlan.name || measurement.payloadBytes !== payloadPlan.payloadBytes) {
        throw new Error(`${label} does not match payload plan ${index}`);
    }
    if (!/^[a-f0-9]{64}$/.test(measurement.payloadSha256 ?? "")) {
        throw new Error(`${label}.payloadSha256 must be lowercase SHA-256`);
    }
    assertWarmup(measurement.warmup, payloadPlan, `${label}.warmup`);
    const operations = record(measurement.operations, `${label}.operations`);
    for (const operation of OPERATIONS) {
        const operationMeasurement = record(operations[operation], `${label}.operations.${operation}`);
        finitePositive(operationMeasurement.elapsedMs, `${label}.operations.${operation}.elapsedMs`);
        assertOperationSamples(
            operationMeasurement.samples,
            operation,
            payloadPlan,
            `${label}.operations.${operation}.samples`,
            payloadPlan.operationsPerRun[operation].count
        );
    }
}

function assertLogicalRuns(runs) {
    if (!Array.isArray(runs) || runs.length !== FILE_BENCHMARK_PROFILE.logicalRuns) {
        throw new Error(`runs must contain ${FILE_BENCHMARK_PROFILE.logicalRuns} logical runs`);
    }
    for (const [runIndex, run] of runs.entries()) {
        const label = `runs[${runIndex}]`;
        record(run, label);
        if (run.sequence !== runIndex) throw new Error(`${label}.sequence must equal its array index`);
        assertIsoTimestamp(run.startedAt, `${label}.startedAt`);
        assertIsoTimestamp(run.completedAt, `${label}.completedAt`);
        if (Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
            throw new Error(`${label}.completedAt precedes startedAt`);
        }
        if (!Array.isArray(run.payloads) || run.payloads.length !== FILE_BENCHMARK_PROFILE.payloads.length) {
            throw new Error(`${label}.payloads must contain the fixed small and large plans`);
        }
        for (const [payloadIndex, payloadPlan] of FILE_BENCHMARK_PROFILE.payloads.entries()) {
            assertRunPayload(
                run.payloads[payloadIndex],
                payloadIndex,
                payloadPlan,
                `${label}.payloads[${payloadIndex}]`
            );
        }
    }
}

function aggregateOperation(runs, payloadIndex, operation, payloadPlan) {
    const samples = [];
    let elapsedMs = 0;
    for (const run of runs) {
        const operationMeasurement = run.payloads[payloadIndex].operations[operation];
        elapsedMs += operationMeasurement.elapsedMs;
        samples.push(...operationMeasurement.samples);
    }
    const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const rawLatencyMs = samples.map(sample => sample.latencyMs);
    return {
        operations: samples.length,
        concurrency: payloadPlan.operationsPerRun[operation].concurrency,
        elapsedMs,
        totalBytes,
        operationsPerSecond: (samples.length * 1_000) / elapsedMs,
        bytesPerSecond: (totalBytes * 1_000) / elapsedMs,
        rawLatencyMs,
        latencyMs: latencySummary(rawLatencyMs),
    };
}

export function summarizeFileBenchmarkRuns(runs) {
    assertLogicalRuns(runs);
    return {
        byPayload: FILE_BENCHMARK_PROFILE.payloads.map((payloadPlan, payloadIndex) => ({
            name: payloadPlan.name,
            payloadBytes: payloadPlan.payloadBytes,
            upload: aggregateOperation(runs, payloadIndex, "upload", payloadPlan),
            attach: aggregateOperation(runs, payloadIndex, "attach", payloadPlan),
            download: aggregateOperation(runs, payloadIndex, "download", payloadPlan),
        })),
    };
}

function assertMetric(metric, expected, label) {
    record(metric, label);
    for (const field of [
        "operations",
        "concurrency",
        "elapsedMs",
        "totalBytes",
        "operationsPerSecond",
        "bytesPerSecond",
    ]) {
        const validator = field === "bytesPerSecond" || field === "totalBytes" ? finiteNonnegative : finitePositive;
        validator(metric[field], `${label}.${field}`);
        if (!approximatelyEqual(metric[field], expected[field]))
            throw new Error(`${label}.${field} does not match runs`);
    }
    if (
        !Array.isArray(metric.rawLatencyMs) ||
        metric.rawLatencyMs.length !== expected.rawLatencyMs.length ||
        metric.rawLatencyMs.some((value, index) => value !== expected.rawLatencyMs[index])
    ) {
        throw new Error(`${label}.rawLatencyMs does not match the admitted runs`);
    }
    const latency = record(metric.latencyMs, `${label}.latencyMs`);
    for (const statistic of ["min", "p50", "p95", "max"]) {
        if (latency[statistic] !== expected.latencyMs[statistic]) {
            throw new Error(`${label}.latencyMs.${statistic} does not match rawLatencyMs`);
        }
    }
}

function assertAggregate(aggregate, runs) {
    record(aggregate, "aggregate");
    if (!Array.isArray(aggregate.byPayload) || aggregate.byPayload.length !== FILE_BENCHMARK_PROFILE.payloads.length) {
        throw new Error("aggregate.byPayload must contain the fixed small and large payloads");
    }
    const expected = summarizeFileBenchmarkRuns(runs);
    for (const [payloadIndex, payloadPlan] of FILE_BENCHMARK_PROFILE.payloads.entries()) {
        const actualPayload = record(aggregate.byPayload[payloadIndex], `aggregate.byPayload[${payloadIndex}]`);
        if (actualPayload.name !== payloadPlan.name || actualPayload.payloadBytes !== payloadPlan.payloadBytes) {
            throw new Error(`aggregate.byPayload[${payloadIndex}] does not match its payload plan`);
        }
        for (const operation of OPERATIONS) {
            assertMetric(
                actualPayload[operation],
                expected.byPayload[payloadIndex][operation],
                `aggregate.byPayload[${payloadIndex}].${operation}`
            );
        }
    }
}

function assertFixedProfile(profile) {
    record(profile, "profile");
    if (JSON.stringify(profile) !== JSON.stringify(FILE_BENCHMARK_PROFILE)) {
        throw new Error("profile does not match the standard-v1 file workload plan");
    }
}

export function assertFileBenchmarkReport(input) {
    const report = record(input, "file benchmark report");
    if (report.schema !== FILE_BENCHMARK_SCHEMA) throw new Error(`expected ${FILE_BENCHMARK_SCHEMA}`);
    if (report.ok !== true) throw new Error("file benchmark report did not complete successfully");
    const candidate = record(report.candidate, "candidate");
    if (!/^[a-f0-9]{64}$/.test(candidate.sha256 ?? "")) throw new Error("candidate.sha256 must be lowercase SHA-256");
    positiveInteger(candidate.bytes, "candidate.bytes");
    const workload = record(report.workload, "workload");
    if (workload.id !== FILE_BENCHMARK_WORKLOAD_ID || workload.version !== FILE_BENCHMARK_WORKLOAD_VERSION) {
        throw new Error("file benchmark workload identity is invalid");
    }
    assertFixedProfile(report.profile);

    const target = record(report.target, "target");
    if (target.kind !== "local" && target.kind !== "cloudflare") {
        throw new Error("target.kind must be local or cloudflare");
    }
    const origin = nonemptyString(target.origin, "target.origin");
    try {
        const url = new URL(origin);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) throw new Error();
    } catch {
        throw new Error("target.origin must be an HTTP origin");
    }
    if (target.deploymentVersion !== undefined) nonemptyString(target.deploymentVersion, "target.deploymentVersion");
    const targetRuntime = record(target.runtime, "target.runtime");
    nonemptyString(targetRuntime.name, "target.runtime.name");
    nonemptyString(targetRuntime.version, "target.runtime.version");
    nonemptyString(targetRuntime.compatibilityDate, "target.runtime.compatibilityDate");
    const r2 = record(target.r2, "target.r2");
    if (r2.provider !== "miniflare" && r2.provider !== "cloudflare") {
        throw new Error("target.r2.provider must be miniflare or cloudflare");
    }
    if (
        (target.kind === "local" && r2.provider !== "miniflare") ||
        (target.kind === "cloudflare" && r2.provider !== "cloudflare")
    ) {
        throw new Error("target.r2.provider does not match target.kind");
    }
    nonemptyString(r2.binding, "target.r2.binding");
    nonemptyString(r2.bucket, "target.r2.bucket");

    const execution = record(report.execution, "execution");
    assertIsoTimestamp(execution.startedAt, "execution.startedAt");
    assertIsoTimestamp(execution.completedAt, "execution.completedAt");
    if (Date.parse(execution.completedAt) < Date.parse(execution.startedAt)) {
        throw new Error("execution.completedAt precedes execution.startedAt");
    }
    const runner = record(report.runner, "runner");
    const runnerRuntime = record(runner.runtime, "runner.runtime");
    nonemptyString(runnerRuntime.name, "runner.runtime.name");
    nonemptyString(runnerRuntime.version, "runner.runtime.version");
    const machine = record(runner.machine, "runner.machine");
    for (const field of ["platform", "architecture", "osRelease", "cpuModel"]) {
        nonemptyString(machine[field], `runner.machine.${field}`);
    }
    positiveInteger(machine.logicalCpuCount, "runner.machine.logicalCpuCount");
    positiveInteger(machine.memoryBytes, "runner.machine.memoryBytes");

    assertLogicalRuns(report.runs);
    assertAggregate(report.aggregate, report.runs);
    return report;
}

export function createFileBenchmarkReport(input) {
    const report = { ...structuredClone(input), schema: FILE_BENCHMARK_SCHEMA };
    return assertFileBenchmarkReport(report);
}
