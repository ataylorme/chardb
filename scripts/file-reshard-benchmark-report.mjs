export const FILE_RESHARD_BENCHMARK_SCHEMA = "chardb.file-reshard-benchmark.report.v1";
export const FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA = "chardb.file-reshard-benchmark.raw-sample.v1";
export const FILE_RESHARD_BENCHMARK_WORKLOAD_ID = "native-file-aware-range-move";
export const FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION = 1;

export const FILE_RESHARD_BENCHMARK_PROFILES = Object.freeze({
    small: Object.freeze({ name: "small", organizations: 3, files: 16, logicalRuns: 3, ciDefault: true }),
    medium: Object.freeze({ name: "medium", organizations: 3, files: 256, logicalRuns: 3, ciDefault: false }),
    large: Object.freeze({ name: "large", organizations: 3, files: 2_048, logicalRuns: 3, ciDefault: false }),
});

export const FILE_RESHARD_BENCHMARK_PHASES = Object.freeze([
    "setup",
    "init",
    "snapshot",
    "bulk",
    "converge",
    "barrierValidateCutover",
    "drain",
    "finish",
    "verify",
]);

const DIGEST = /^[a-f0-9]{64}$/;
const SAMPLE_KEYS = [
    "schema",
    "sequence",
    "excluded",
    "workload",
    "target",
    "execution",
    "dataset",
    "timing",
    "throughput",
    "movement",
    "restart",
    "correctness",
];

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

function string(value, label) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
    return value;
}

function digest(value, label) {
    if (!DIGEST.test(value ?? "")) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function iso(value, label) {
    string(value, label);
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error(`${label} must be a canonical ISO timestamp`);
    }
}

export function fileReshardBenchmarkProfile(name) {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES[name];
    if (!profile) throw new Error(`unknown file reshard benchmark profile ${JSON.stringify(name)}`);
    return profile;
}

function assertTarget(target, label) {
    exact(target, label, ["kind", "transport", "runtime", "storage", "configurationSha256"]);
    if (target.kind !== "local") throw new Error(`${label}.kind must be local`);
    if (target.transport !== "miniflare-workerd-native") throw new Error(`${label}.transport is invalid`);
    digest(target.configurationSha256, `${label}.configurationSha256`);
    exact(target.runtime, `${label}.runtime`, ["workerd", "miniflare", "compatibilityDate"]);
    string(target.runtime.workerd, `${label}.runtime.workerd`);
    string(target.runtime.miniflare, `${label}.runtime.miniflare`);
    string(target.runtime.compatibilityDate, `${label}.runtime.compatibilityDate`);
    exact(target.storage, `${label}.storage`, ["durableObjects", "sqlite", "r2"]);
    if (target.storage.durableObjects !== true || target.storage.sqlite !== true || target.storage.r2 !== true) {
        throw new Error(`${label}.storage must prove SQLite Durable Objects and R2`);
    }
}

function assertR2(r2, label, files) {
    exact(r2, label, [
        "objectsBefore",
        "objectsAfter",
        "bytesBefore",
        "bytesAfter",
        "identityDigestBefore",
        "identityDigestAfter",
        "writesDuringMove",
        "deletesDuringMove",
    ]);
    if (r2.objectsBefore !== files || r2.objectsAfter !== files) throw new Error(`${label} object count drifted`);
    integer(r2.bytesBefore, `${label}.bytesBefore`, files);
    if (r2.bytesAfter !== r2.bytesBefore) throw new Error(`${label} bytes changed during movement`);
    digest(r2.identityDigestBefore, `${label}.identityDigestBefore`);
    if (r2.identityDigestAfter !== r2.identityDigestBefore) throw new Error(`${label} object identity changed`);
    if (r2.writesDuringMove !== 0 || r2.deletesDuringMove !== 0) {
        throw new Error(`${label} must prove zero R2 writes and deletes during movement`);
    }
}

export function assertFileReshardBenchmarkSample(input, expected = {}) {
    const sample = object(input, "file reshard benchmark sample");
    exact(sample, "file reshard benchmark sample", SAMPLE_KEYS);
    if (sample.schema !== FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA) {
        throw new Error(`expected ${FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA}`);
    }
    integer(sample.sequence, "sample.sequence", -1);
    if (sample.excluded !== (sample.sequence === -1)) throw new Error("sample.excluded must identify the warmup");
    exact(sample.workload, "sample.workload", ["id", "version", "profile"]);
    if (
        sample.workload.id !== FILE_RESHARD_BENCHMARK_WORKLOAD_ID ||
        sample.workload.version !== FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION
    ) {
        throw new Error("sample workload identity drifted");
    }
    const profile = fileReshardBenchmarkProfile(sample.workload.profile.name);
    if (JSON.stringify(sample.workload.profile) !== JSON.stringify(profile)) throw new Error("sample profile drifted");
    assertTarget(sample.target, "sample.target");
    exact(sample.execution, "sample.execution", ["startedAt", "completedAt", "processId"]);
    iso(sample.execution.startedAt, "sample.execution.startedAt");
    iso(sample.execution.completedAt, "sample.execution.completedAt");
    integer(sample.execution.processId, "sample.execution.processId", 1);
    exact(sample.dataset, "sample.dataset", ["organizations", "files", "metadataRows", "objectBytes"]);
    if (sample.dataset.organizations !== profile.organizations || sample.dataset.files !== profile.files) {
        throw new Error("sample dataset does not match its profile");
    }
    if (sample.dataset.metadataRows !== profile.files) throw new Error("sample metadata row count drifted");
    integer(sample.dataset.objectBytes, "sample.dataset.objectBytes", profile.files);
    exact(sample.timing, "sample.timing", ["totalMs", "phasesMs"]);
    finite(sample.timing.totalMs, "sample.timing.totalMs", Number.EPSILON);
    exact(sample.timing.phasesMs, "sample.timing.phasesMs", FILE_RESHARD_BENCHMARK_PHASES);
    for (const phase of FILE_RESHARD_BENCHMARK_PHASES) finite(sample.timing.phasesMs[phase], `phasesMs.${phase}`);
    exact(sample.throughput, "sample.throughput", ["filesPerSecond", "metadataRowsPerSecond"]);
    finite(sample.throughput.filesPerSecond, "sample.throughput.filesPerSecond", Number.EPSILON);
    finite(sample.throughput.metadataRowsPerSecond, "sample.throughput.metadataRowsPerSecond", Number.EPSILON);
    exact(sample.movement, "sample.movement", ["runTurns", "files", "metadataRows", "r2"]);
    integer(sample.movement.runTurns, "sample.movement.runTurns", 1);
    if (sample.movement.files !== profile.files || sample.movement.metadataRows !== profile.files) {
        throw new Error("sample movement counts drifted");
    }
    assertR2(sample.movement.r2, "sample.movement.r2", profile.files);
    exact(sample.restart, "sample.restart", [
        "phase",
        "disposeMs",
        "coldStartMs",
        "resumeMs",
        "cursorPersisted",
        "resumed",
    ]);
    string(sample.restart.phase, "sample.restart.phase");
    finite(sample.restart.disposeMs, "sample.restart.disposeMs");
    finite(sample.restart.coldStartMs, "sample.restart.coldStartMs");
    finite(sample.restart.resumeMs, "sample.restart.resumeMs");
    if (sample.restart.cursorPersisted !== true || sample.restart.resumed !== true) {
        throw new Error("sample restart did not resume durable progress");
    }
    exact(sample.correctness, "sample.correctness", [
        "phaseOrder",
        "parity",
        "destinationActivated",
        "sourceDrained",
        "r2Stable",
        "sharedBucketNoCopy",
    ]);
    for (const flag of Object.keys(sample.correctness)) {
        if (sample.correctness[flag] !== true) throw new Error(`sample.correctness.${flag} did not pass`);
    }
    if (expected.sequence !== undefined && sample.sequence !== expected.sequence)
        throw new Error("sample sequence drifted");
    if (expected.profile !== undefined && profile.name !== expected.profile) throw new Error("sample profile drifted");
    return sample;
}

function distribution(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = quantile => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
    return { raw: [...values], min: sorted[0], p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

export function summarizeFileReshardBenchmarkSamples(samples, profileName) {
    const profile = fileReshardBenchmarkProfile(profileName);
    if (!Array.isArray(samples) || samples.length !== profile.logicalRuns) {
        throw new Error(`samples must contain ${profile.logicalRuns} measured runs`);
    }
    samples.forEach((sample, sequence) => assertFileReshardBenchmarkSample(sample, { sequence, profile: profileName }));
    return {
        timing: {
            totalMs: distribution(samples.map(sample => sample.timing.totalMs)),
            phasesMs: Object.fromEntries(
                FILE_RESHARD_BENCHMARK_PHASES.map(phase => [
                    phase,
                    distribution(samples.map(sample => sample.timing.phasesMs[phase])),
                ])
            ),
            restartOverheadMs: distribution(
                samples.map(sample => sample.restart.disposeMs + sample.restart.coldStartMs + sample.restart.resumeMs)
            ),
        },
        rates: {
            filesPerSecond: distribution(samples.map(sample => sample.throughput.filesPerSecond)),
            metadataRowsPerSecond: distribution(samples.map(sample => sample.throughput.metadataRowsPerSecond)),
        },
        totals: {
            files: samples.reduce((sum, sample) => sum + sample.movement.files, 0),
            metadataRows: samples.reduce((sum, sample) => sum + sample.movement.metadataRows, 0),
            r2WritesDuringMove: 0,
            r2DeletesDuringMove: 0,
        },
    };
}

export function createFileReshardBenchmarkReport(input) {
    const report = { schema: FILE_RESHARD_BENCHMARK_SCHEMA, ...input };
    return assertFileReshardBenchmarkReport(report);
}

export function assertFileReshardBenchmarkReport(input) {
    const report = object(input, "file reshard benchmark report");
    exact(report, "file reshard benchmark report", [
        "schema",
        "ok",
        "workload",
        "runner",
        "execution",
        "warmup",
        "samples",
        "aggregate",
    ]);
    if (report.schema !== FILE_RESHARD_BENCHMARK_SCHEMA || report.ok !== true)
        throw new Error("report is not successful");
    const profile = fileReshardBenchmarkProfile(report.workload?.profile?.name);
    if (JSON.stringify(report.workload.profile) !== JSON.stringify(profile)) throw new Error("report profile drifted");
    assertFileReshardBenchmarkSample(report.warmup, { sequence: -1, profile: profile.name });
    const aggregate = summarizeFileReshardBenchmarkSamples(report.samples, profile.name);
    if (JSON.stringify(aggregate) !== JSON.stringify(report.aggregate)) throw new Error("report aggregate drifted");
    exact(report.runner, "report.runner", ["runtime", "machine", "processIsolation"]);
    exact(report.execution, "report.execution", ["startedAt", "completedAt", "processId"]);
    iso(report.execution.startedAt, "report.execution.startedAt");
    iso(report.execution.completedAt, "report.execution.completedAt");
    return report;
}
