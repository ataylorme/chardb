export const VECTORIZE_LOCAL_FAKE_BENCHMARK_SCHEMA = "chardb.vectorize.local-fake-benchmark.v1";

export const VECTORIZE_READY_SEARCH_WORKLOAD = Object.freeze({
    id: "ready-vector-filtered-search-v2",
    description:
        "One HTTP request queries a ready 32-dimensional cosine vector with topK 1, then validates the candidate against the current SQLite head and row policy.",
    dimensions: 32,
    metric: "cosine",
    topK: 1,
    requestsPerSample: 1,
    warmupSamples: 1,
    measuredSamples: 5,
});

const SHA256 = /^[a-f0-9]{64}$/;

function exactObject(value, label, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
    }
    return value;
}

function nonemptyString(value, label) {
    if (typeof value !== "string" || value.length === 0 || value.length > 500) {
        throw new Error(`${label} must be a bounded nonempty string`);
    }
    return value;
}

function duration(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite nonnegative duration`);
    }
    return value;
}

function sample(value, expectedSequence, expectedExcluded, label) {
    exactObject(value, label, ["sequence", "excluded", "elapsedMs"]);
    if (value.sequence !== expectedSequence || value.excluded !== expectedExcluded) {
        throw new Error(`${label} does not match the fixed sample plan`);
    }
    duration(value.elapsedMs, `${label} elapsedMs`);
    return value;
}

export function assertVectorizeLocalFakeBenchmarkReport(value) {
    exactObject(value, "local fake Vectorize benchmark report", [
        "schema",
        "artifact",
        "environment",
        "workload",
        "sampling",
        "track",
        "correctness",
    ]);
    if (value.schema !== VECTORIZE_LOCAL_FAKE_BENCHMARK_SCHEMA) {
        throw new Error("local fake Vectorize benchmark schema is invalid");
    }

    exactObject(value.artifact, "benchmark artifact", ["kind", "sha256", "bytes"]);
    if (value.artifact.kind !== "workerd-worker-bundle") throw new Error("benchmark artifact kind is invalid");
    if (!SHA256.test(value.artifact.sha256 ?? "")) throw new Error("benchmark artifact digest is invalid");
    if (!Number.isSafeInteger(value.artifact.bytes) || value.artifact.bytes < 1) {
        throw new Error("benchmark artifact byte count is invalid");
    }

    exactObject(value.environment, "benchmark environment", [
        "bun",
        "miniflare",
        "workerd",
        "compatibilityDate",
        "durableObjectStorage",
    ]);
    for (const key of ["bun", "miniflare", "workerd"]) nonemptyString(value.environment[key], `environment.${key}`);
    if (
        value.environment.compatibilityDate !== "2026-08-06" ||
        value.environment.durableObjectStorage !== "persistent-sqlite"
    ) {
        throw new Error("benchmark environment does not identify the native persistent Workerd fixture");
    }

    exactObject(value.workload, "benchmark workload", Object.keys(VECTORIZE_READY_SEARCH_WORKLOAD));
    for (const [key, expected] of Object.entries(VECTORIZE_READY_SEARCH_WORKLOAD)) {
        if (value.workload[key] !== expected)
            throw new Error(`benchmark workload ${key} drifted from the fixed contract`);
    }

    exactObject(value.sampling, "benchmark sampling", ["warmup", "samples"]);
    sample(value.sampling.warmup, -1, true, "benchmark warmup");
    if (!Array.isArray(value.sampling.samples) || value.sampling.samples.length !== 5) {
        throw new Error("benchmark requires exactly five measured samples");
    }
    value.sampling.samples.forEach((item, index) => sample(item, index, false, `benchmark sample ${index}`));

    exactObject(value.track, "benchmark track", ["label", "runtime", "backend", "realVectorize", "samplesMs"]);
    if (
        value.track.label !== "local-workerd-fake-vectorize" ||
        value.track.runtime !== "miniflare/workerd" ||
        value.track.backend !== "persistent-fake-index-do" ||
        value.track.realVectorize !== false
    ) {
        throw new Error("benchmark track has a dishonest runtime or backend label");
    }
    if (!Array.isArray(value.track.samplesMs) || value.track.samplesMs.length !== 5) {
        throw new Error("benchmark track requires five measured samples");
    }
    const measured = value.sampling.samples.map(item => item.elapsedMs);
    if (JSON.stringify(value.track.samplesMs) !== JSON.stringify(measured)) {
        throw new Error("benchmark track samples do not match the raw measured samples");
    }

    exactObject(value.correctness, "benchmark correctness", [
        "readyBeforeTiming",
        "owningOrganizationExactMatch",
        "isolatedOrganizationEmpty",
        "productionCandidateValidation",
        "assertionsOutsideTiming",
    ]);
    for (const [key, passed] of Object.entries(value.correctness)) {
        if (passed !== true) throw new Error(`benchmark correctness ${key} did not pass`);
    }
    return value;
}
