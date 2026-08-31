export const PUBLIC_VECTOR_BENCHMARK_SCHEMA = "chardb.public-vector-benchmark.report.v1";
export const PUBLIC_VECTOR_BENCHMARK_SAMPLE_SCHEMA = "chardb.public-vector-benchmark.raw-sample.v1";
export const PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID = "registered-vector-live-cycle";
export const PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION = 1;

export const PUBLIC_VECTOR_BENCHMARK_PROFILES = Object.freeze({
    ci: Object.freeze({
        name: "ci",
        logicalRuns: 3,
        ciDefault: true,
        scenarios: Object.freeze([
            Object.freeze({ name: "single", organizations: 1, shards: 1, vectorsPerOrganization: 2 }),
            Object.freeze({ name: "shared-shard", organizations: 4, shards: 1, vectorsPerOrganization: 2 }),
            Object.freeze({ name: "multi-shard", organizations: 8, shards: 4, vectorsPerOrganization: 2 }),
        ]),
    }),
    standard: Object.freeze({
        name: "standard",
        logicalRuns: 5,
        ciDefault: false,
        scenarios: Object.freeze([
            Object.freeze({ name: "single", organizations: 1, shards: 1, vectorsPerOrganization: 16 }),
            Object.freeze({ name: "shared-shard", organizations: 16, shards: 1, vectorsPerOrganization: 16 }),
            Object.freeze({ name: "multi-shard", organizations: 32, shards: 8, vectorsPerOrganization: 16 }),
        ]),
    }),
    large: Object.freeze({
        name: "large",
        logicalRuns: 5,
        ciDefault: false,
        scenarios: Object.freeze([
            Object.freeze({ name: "single", organizations: 1, shards: 1, vectorsPerOrganization: 64 }),
            Object.freeze({ name: "shared-shard", organizations: 64, shards: 4, vectorsPerOrganization: 64 }),
            Object.freeze({ name: "multi-shard", organizations: 256, shards: 64, vectorsPerOrganization: 64 }),
        ]),
    }),
});

const DIGEST = /^[a-f0-9]{64}$/;

function fail(message) {
    throw new TypeError(`public vector benchmark: ${message}`);
}

function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    return value;
}

function exact(value, label, keys) {
    const actual = Object.keys(object(value, label)).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} fields must be exactly ${expected.join(", ")}`);
    }
}

function integer(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
    return value;
}

function finite(value, label, minimum = 0) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
        fail(`${label} must be a finite number >= ${minimum}`);
    }
    return value;
}

function string(value, label) {
    if (typeof value !== "string" || value.length === 0 || value.length > 500) {
        fail(`${label} must be a bounded nonempty string`);
    }
    return value;
}

function digest(value, label) {
    if (!DIGEST.test(value ?? "")) fail(`${label} must be a lowercase SHA-256 digest`);
}

function iso(value, label) {
    string(value, label);
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        fail(`${label} must be a canonical ISO timestamp`);
    }
}

export function publicVectorBenchmarkProfile(name) {
    const profile = PUBLIC_VECTOR_BENCHMARK_PROFILES[name];
    if (!profile) fail(`unknown profile ${JSON.stringify(name)}`);
    return profile;
}

function scenarioVectors(scenario) {
    return scenario.organizations * scenario.vectorsPerOrganization;
}

function assertTarget(target, label) {
    exact(target, label, [
        "kind",
        "transport",
        "vectorBackend",
        "realVectorize",
        "configurationSha256",
        "artifactSha256",
        "runtime",
        "storage",
    ]);
    if (target.kind !== "local") fail(`${label}.kind must be local`);
    if (target.transport !== "miniflare-workerd-websocket") fail(`${label}.transport must identify Miniflare`);
    if (target.vectorBackend !== "durable-object-fake") fail(`${label}.vectorBackend must identify the fake index`);
    if (target.realVectorize !== false) fail(`${label}.realVectorize must be false`);
    digest(target.configurationSha256, `${label}.configurationSha256`);
    digest(target.artifactSha256, `${label}.artifactSha256`);
    exact(target.runtime, `${label}.runtime`, ["bun", "workerd", "miniflare", "wrangler", "compatibilityDate"]);
    for (const key of ["bun", "workerd", "compatibilityDate"]) string(target.runtime[key], `${label}.runtime.${key}`);
    string(target.runtime.miniflare, `${label}.runtime.miniflare`);
    if (target.runtime.wrangler !== null) fail(`${label}.runtime.wrangler must be null locally`);
    exact(target.storage, `${label}.storage`, ["durableObjects", "sqlite"]);
    if (target.storage.durableObjects !== true || target.storage.sqlite !== true) {
        fail(`${label}.storage must identify SQLite Durable Objects`);
    }
}

function assertDistribution(value, label, expectedCount) {
    exact(value, label, ["raw", "min", "p50", "p95", "p99", "max"]);
    if (!Array.isArray(value.raw) || value.raw.length !== expectedCount)
        fail(`${label}.raw has the wrong sample count`);
    value.raw.forEach((item, index) => finite(item, `${label}.raw[${index}]`));
    const derived = distribution(value.raw);
    for (const key of ["min", "p50", "p95", "p99", "max"]) {
        if (value[key] !== derived[key]) fail(`${label}.${key} is not derived from raw samples`);
    }
}

function assertScenario(result, expected, label) {
    exact(result, label, ["name", "dataset", "timing", "throughput", "correctness"]);
    if (result.name !== expected.name) fail(`${label}.name drifted`);
    exact(result.dataset, `${label}.dataset`, ["organizations", "shards", "vectorsPerOrganization", "vectors"]);
    for (const key of ["organizations", "shards", "vectorsPerOrganization"]) {
        if (result.dataset[key] !== expected[key]) fail(`${label}.dataset.${key} drifted`);
    }
    const vectors = scenarioVectors(expected);
    if (result.dataset.vectors !== vectors) fail(`${label}.dataset.vectors is not exact`);
    exact(result.timing, `${label}.timing`, [
        "totalMs",
        "mutationPhaseMs",
        "mutationAckMs",
        "controllerDrivenDeliveryMs",
        "refetchPhaseMs",
        "liveRefetchMs",
        "liveRefetchRowCounts",
    ]);
    for (const key of ["totalMs", "mutationPhaseMs", "controllerDrivenDeliveryMs", "refetchPhaseMs"]) {
        finite(result.timing[key], `${label}.timing.${key}`, Number.EPSILON);
    }
    for (const [key, count] of [
        ["mutationAckMs", vectors],
        ["liveRefetchMs", expected.organizations],
    ]) {
        if (!Array.isArray(result.timing[key]) || result.timing[key].length !== count) {
            fail(`${label}.timing.${key} has the wrong observation count`);
        }
        result.timing[key].forEach((item, index) => finite(item, `${label}.timing.${key}[${index}]`));
    }
    if (
        !Array.isArray(result.timing.liveRefetchRowCounts) ||
        result.timing.liveRefetchRowCounts.length !== expected.organizations
    ) {
        fail(`${label}.timing.liveRefetchRowCounts has the wrong organization count`);
    }
    result.timing.liveRefetchRowCounts.forEach((counts, index) => {
        const monotonic =
            Array.isArray(counts) &&
            counts.length > 0 &&
            counts.at(-1) === expected.vectorsPerOrganization &&
            counts.every(
                (count, countIndex) =>
                    Number.isSafeInteger(count) &&
                    count >= 1 &&
                    count <= expected.vectorsPerOrganization &&
                    (countIndex === 0 || count > counts[countIndex - 1])
            );
        const requiredSingleProgress =
            expected.name !== "single" ||
            expected.vectorsPerOrganization !== 2 ||
            JSON.stringify(counts) === JSON.stringify([1, 2]);
        if (!monotonic || !requiredSingleProgress) {
            fail(
                `${label}.timing.liveRefetchRowCounts[${index}] must prove serialized monotonic refetch, received ${JSON.stringify(counts)}`
            );
        }
    });
    const accounted =
        result.timing.mutationPhaseMs + result.timing.controllerDrivenDeliveryMs + result.timing.refetchPhaseMs;
    if (result.timing.totalMs < accounted) fail(`${label}.timing.totalMs is smaller than its phases`);
    exact(result.throughput, `${label}.throughput`, ["vectorsPerSecond", "organizationsPerSecond"]);
    finite(result.throughput.vectorsPerSecond, `${label}.throughput.vectorsPerSecond`, Number.EPSILON);
    finite(result.throughput.organizationsPerSecond, `${label}.throughput.organizationsPerSecond`, Number.EPSILON);
    exact(result.correctness, `${label}.correctness`, [
        "mutationCommits",
        "readyHeads",
        "returnedRows",
        "liveRefetches",
        "isolatedOrganizations",
        "observedShards",
        "duplicateRows",
        "leakedRows",
        "deliveryTurns",
        "monotonicRefetches",
        "registeredMutation",
        "registeredSearch",
        "liveProtocol",
    ]);
    for (const [key, expectedValue] of [
        ["mutationCommits", vectors],
        ["readyHeads", vectors],
        ["returnedRows", vectors],
        ["liveRefetches", expected.organizations],
        ["isolatedOrganizations", expected.organizations],
        ["observedShards", expected.shards],
        ["monotonicRefetches", expected.organizations],
        ["duplicateRows", 0],
        ["leakedRows", 0],
    ]) {
        if (result.correctness[key] !== expectedValue) fail(`${label}.correctness.${key} is not exact`);
    }
    integer(result.correctness.deliveryTurns, `${label}.correctness.deliveryTurns`, 1);
    for (const key of ["registeredMutation", "registeredSearch", "liveProtocol"]) {
        if (result.correctness[key] !== true) fail(`${label}.correctness.${key} did not pass`);
    }
}

export function assertPublicVectorBenchmarkSample(input, expected = {}) {
    const sample = object(input, "sample");
    exact(sample, "sample", ["schema", "sequence", "excluded", "workload", "target", "execution", "scenarios"]);
    if (sample.schema !== PUBLIC_VECTOR_BENCHMARK_SAMPLE_SCHEMA) fail("sample schema is invalid");
    integer(sample.sequence, "sample.sequence", -1);
    if (sample.excluded !== (sample.sequence === -1)) fail("sample.excluded must identify the warmup");
    exact(sample.workload, "sample.workload", ["id", "version", "profile"]);
    if (
        sample.workload.id !== PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID ||
        sample.workload.version !== PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION
    ) {
        fail("sample workload identity drifted");
    }
    const profile = publicVectorBenchmarkProfile(sample.workload.profile?.name);
    if (JSON.stringify(sample.workload.profile) !== JSON.stringify(profile)) fail("sample profile drifted");
    assertTarget(sample.target, "sample.target");
    exact(sample.execution, "sample.execution", ["startedAt", "completedAt", "processId"]);
    iso(sample.execution.startedAt, "sample.execution.startedAt");
    iso(sample.execution.completedAt, "sample.execution.completedAt");
    if (Date.parse(sample.execution.completedAt) < Date.parse(sample.execution.startedAt)) {
        fail("sample execution completed before it started");
    }
    integer(sample.execution.processId, "sample.execution.processId", 1);
    if (!Array.isArray(sample.scenarios) || sample.scenarios.length !== profile.scenarios.length) {
        fail("sample scenarios do not match the profile");
    }
    sample.scenarios.forEach((scenario, index) =>
        assertScenario(scenario, profile.scenarios[index], `scenarios[${index}]`)
    );
    if (expected.sequence !== undefined && sample.sequence !== expected.sequence) fail("sample sequence drifted");
    if (expected.profile !== undefined && profile.name !== expected.profile) fail("sample profile drifted");
    return sample;
}

export function distribution(values) {
    if (!Array.isArray(values) || values.length === 0) fail("distribution requires observations");
    values.forEach((value, index) => finite(value, `distribution[${index}]`));
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = quantile => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
    return {
        raw: [...values],
        min: sorted[0],
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: sorted.at(-1),
    };
}

export function summarizePublicVectorBenchmarkSamples(samples, profileName) {
    const profile = publicVectorBenchmarkProfile(profileName);
    if (!Array.isArray(samples) || samples.length !== profile.logicalRuns) {
        fail(`samples must contain ${profile.logicalRuns} measured runs`);
    }
    samples.forEach((sample, sequence) =>
        assertPublicVectorBenchmarkSample(sample, { sequence, profile: profileName })
    );
    return {
        scenarios: profile.scenarios.map((scenario, scenarioIndex) => {
            const results = samples.map(sample => sample.scenarios[scenarioIndex]);
            const vectors = scenarioVectors(scenario);
            return {
                name: scenario.name,
                dataset: {
                    organizations: scenario.organizations,
                    shards: scenario.shards,
                    vectorsPerOrganization: scenario.vectorsPerOrganization,
                    vectors,
                },
                latencyMs: {
                    total: distribution(results.map(result => result.timing.totalMs)),
                    mutationPhase: distribution(results.map(result => result.timing.mutationPhaseMs)),
                    mutationAck: distribution(results.flatMap(result => result.timing.mutationAckMs)),
                    controllerDrivenDelivery: distribution(
                        results.map(result => result.timing.controllerDrivenDeliveryMs)
                    ),
                    refetchPhase: distribution(results.map(result => result.timing.refetchPhaseMs)),
                    liveRefetch: distribution(results.flatMap(result => result.timing.liveRefetchMs)),
                },
                throughput: {
                    vectorsPerSecond: distribution(results.map(result => result.throughput.vectorsPerSecond)),
                    organizationsPerSecond: distribution(
                        results.map(result => result.throughput.organizationsPerSecond)
                    ),
                },
                correctness: {
                    measuredRuns: samples.length,
                    mutationCommits: samples.length * vectors,
                    readyHeads: samples.length * vectors,
                    returnedRows: samples.length * vectors,
                    liveRefetches: samples.length * scenario.organizations,
                    isolatedOrganizations: samples.length * scenario.organizations,
                    duplicateRows: 0,
                    leakedRows: 0,
                },
            };
        }),
    };
}

export function assertPublicVectorBenchmarkReport(input) {
    const report = object(input, "report");
    exact(report, "report", ["schema", "ok", "workload", "runner", "execution", "warmup", "samples", "aggregate"]);
    if (report.schema !== PUBLIC_VECTOR_BENCHMARK_SCHEMA || report.ok !== true) fail("report is not successful");
    exact(report.workload, "report.workload", ["id", "version", "profile"]);
    const profile = publicVectorBenchmarkProfile(report.workload.profile?.name);
    if (
        report.workload.id !== PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID ||
        report.workload.version !== PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION ||
        JSON.stringify(report.workload.profile) !== JSON.stringify(profile)
    ) {
        fail("report workload drifted");
    }
    assertPublicVectorBenchmarkSample(report.warmup, { sequence: -1, profile: profile.name });
    const aggregate = summarizePublicVectorBenchmarkSamples(report.samples, profile.name);
    exact(report.runner, "report.runner", ["runtime", "machine", "processIsolation"]);
    exact(report.execution, "report.execution", ["startedAt", "completedAt", "processId"]);
    iso(report.execution.startedAt, "report.execution.startedAt");
    iso(report.execution.completedAt, "report.execution.completedAt");
    integer(report.execution.processId, "report.execution.processId", 1);
    if (JSON.stringify(report.aggregate) !== JSON.stringify(aggregate)) fail("report aggregate drifted");
    return report;
}

export function createPublicVectorBenchmarkReport(input) {
    return assertPublicVectorBenchmarkReport({ schema: PUBLIC_VECTOR_BENCHMARK_SCHEMA, ...input });
}

export function assertPublicVectorBenchmarkAggregate(input, profileName) {
    const profile = publicVectorBenchmarkProfile(profileName);
    exact(input, "aggregate", ["scenarios"]);
    if (!Array.isArray(input.scenarios) || input.scenarios.length !== profile.scenarios.length) {
        fail("aggregate scenarios do not match the profile");
    }
    input.scenarios.forEach((scenario, index) => {
        const expected = profile.scenarios[index];
        const resultCount = profile.logicalRuns;
        exact(scenario, `aggregate.scenarios[${index}]`, ["name", "dataset", "latencyMs", "throughput", "correctness"]);
        if (scenario.name !== expected.name) fail(`aggregate.scenarios[${index}].name drifted`);
        exact(scenario.latencyMs, `aggregate.scenarios[${index}].latencyMs`, [
            "total",
            "mutationPhase",
            "mutationAck",
            "controllerDrivenDelivery",
            "refetchPhase",
            "liveRefetch",
        ]);
        for (const key of ["total", "mutationPhase", "controllerDrivenDelivery", "refetchPhase"]) {
            assertDistribution(scenario.latencyMs[key], `aggregate.scenarios[${index}].latencyMs.${key}`, resultCount);
        }
        assertDistribution(
            scenario.latencyMs.mutationAck,
            `aggregate.scenarios[${index}].latencyMs.mutationAck`,
            resultCount * scenarioVectors(expected)
        );
        assertDistribution(
            scenario.latencyMs.liveRefetch,
            `aggregate.scenarios[${index}].latencyMs.liveRefetch`,
            resultCount * expected.organizations
        );
    });
    return input;
}
