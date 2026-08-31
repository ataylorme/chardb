export const VECTOR_SQLITE_BENCHMARK_SCHEMA = "chardb.vector-sqlite-benchmark.v1";
export const VECTOR_SQLITE_BENCHMARK_PROFILE = Object.freeze({
    name: "local-sqlite-standard-v1",
    headCounts: Object.freeze([10, 1_000, 10_000, 40_000]),
    registrationCounts: Object.freeze([10, 100, 1_000, 4_000]),
    repetitions: 31,
    coldReconcileRepetitions: 3,
    candidates: 32,
});

const TIMING_KEYS = Object.freeze([
    "stageInsert",
    "stageUpdate",
    "claim",
    "readyAck",
    "validatedCandidateFiltering",
    "exactInvalidationOneOfN",
    "exactInvalidationFanout",
    "warmRestart",
    "coldReconcile",
]);

function object(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function exactKeys(value, label, keys) {
    object(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
    }
}

function integer(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
}

function finite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite non-negative number`);
    }
}

function timing(value, label) {
    exactKeys(value, label, ["medianUs", "p95Us"]);
    finite(value.medianUs, `${label}.medianUs`);
    finite(value.p95Us, `${label}.p95Us`);
    if (value.p95Us < value.medianUs) throw new Error(`${label}.p95Us must be >= medianUs`);
}

export function assertVectorSqliteBenchmarkReport(value) {
    exactKeys(value, "vector SQLite benchmark report", ["schema", "profile", "environment", "results", "scope"]);
    if (value.schema !== VECTOR_SQLITE_BENCHMARK_SCHEMA) throw new Error("vector SQLite benchmark schema is invalid");
    exactKeys(value.profile, "profile", [
        "name",
        "headCounts",
        "registrationCounts",
        "repetitions",
        "coldReconcileRepetitions",
        "candidates",
    ]);
    if (typeof value.profile.name !== "string" || value.profile.name.length === 0) {
        throw new Error("profile.name must be nonempty");
    }
    for (const key of ["headCounts", "registrationCounts"]) {
        if (!Array.isArray(value.profile[key]) || value.profile[key].length === 0) {
            throw new Error(`profile.${key} must be nonempty`);
        }
        let previous = 0;
        for (const size of value.profile[key]) {
            integer(size, `profile.${key} size`, 1);
            if (size <= previous) throw new Error(`profile.${key} must be strictly increasing`);
            previous = size;
        }
    }
    if (value.profile.headCounts.length !== value.profile.registrationCounts.length) {
        throw new Error("profile scale arrays must have equal lengths");
    }
    integer(value.profile.repetitions, "profile.repetitions", 1);
    integer(value.profile.coldReconcileRepetitions, "profile.coldReconcileRepetitions", 1);
    integer(value.profile.candidates, "profile.candidates", 1);
    exactKeys(value.environment, "environment", ["bun", "sqlite", "storage"]);
    if (typeof value.environment.bun !== "string" || value.environment.bun.length === 0) {
        throw new Error("environment.bun must be nonempty");
    }
    if (typeof value.environment.sqlite !== "string" || value.environment.sqlite.length === 0) {
        throw new Error("environment.sqlite must be nonempty");
    }
    if (value.environment.storage !== "in-memory SQLite") throw new Error("environment.storage is invalid");
    exactKeys(value.scope, "scope", ["includesVectorizeLatency", "includesPolicyPointReads", "description"]);
    if (value.scope.includesVectorizeLatency !== false) {
        throw new Error("local SQLite report must not claim Vectorize latency");
    }
    if (value.scope.includesPolicyPointReads !== false) {
        throw new Error("candidate filtering scope must exclude policy point reads");
    }
    if (typeof value.scope.description !== "string" || value.scope.description.length === 0) {
        throw new Error("scope.description must be nonempty");
    }
    if (!Array.isArray(value.results) || value.results.length !== value.profile.headCounts.length) {
        throw new Error("results must match profile scales");
    }
    value.results.forEach((result, index) => {
        exactKeys(result, `results[${index}]`, ["storedHeads", "registrations", "timings", "proof"]);
        if (
            result.storedHeads !== value.profile.headCounts[index] ||
            result.registrations !== value.profile.registrationCounts[index]
        ) {
            throw new Error(`results[${index}] scale does not match profile`);
        }
        exactKeys(result.timings, `results[${index}].timings`, TIMING_KEYS);
        for (const key of TIMING_KEYS) timing(result.timings[key], `results[${index}].timings.${key}`);
        exactKeys(result.proof, `results[${index}].proof`, [
            "capacityCounterExact",
            "claimUsesDueIndexWithoutTempSort",
            "invalidationUsesResourceIndex",
            "warmRestartSkippedAggregateReconciliation",
            "candidateResultsBounded",
        ]);
        for (const [proof, flag] of Object.entries(result.proof)) {
            if (flag !== true) throw new Error(`results[${index}].proof.${proof} did not pass`);
        }
    });
    return value;
}
