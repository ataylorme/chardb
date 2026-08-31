import { describe, expect, test } from "bun:test";
import { comparePublicVectorBenchmarkReports } from "../scripts/compare-public-vector-benchmark.mjs";
import {
    PUBLIC_VECTOR_BENCHMARK_PROFILES,
    PUBLIC_VECTOR_BENCHMARK_SAMPLE_SCHEMA,
    PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID,
    PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION,
    assertPublicVectorBenchmarkReport,
    assertPublicVectorBenchmarkSample,
    createPublicVectorBenchmarkReport,
    summarizePublicVectorBenchmarkSamples,
} from "../scripts/public-vector-benchmark-report.mjs";

function sample(sequence: number, multiplier = 1, profileName: "ci" | "standard" | "large" = "ci") {
    const profile = PUBLIC_VECTOR_BENCHMARK_PROFILES[profileName];
    if (!profile) throw new Error("missing benchmark profile");
    return {
        schema: PUBLIC_VECTOR_BENCHMARK_SAMPLE_SCHEMA,
        sequence,
        excluded: sequence === -1,
        workload: {
            id: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID,
            version: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION,
            profile,
        },
        target: {
            kind: "local",
            transport: "miniflare-workerd-websocket",
            vectorBackend: "durable-object-fake",
            realVectorize: false,
            configurationSha256: "a".repeat(64),
            artifactSha256: "b".repeat(64),
            runtime: {
                bun: "1.2.22",
                workerd: "1.20260828.0",
                miniflare: "4.20260828.0",
                wrangler: null,
                compatibilityDate: "2026-08-06",
            },
            storage: { durableObjects: true, sqlite: true },
        },
        execution: {
            startedAt: "2026-08-30T00:00:00.000Z",
            completedAt: "2026-08-30T00:00:01.000Z",
            processId: 42,
        },
        scenarios: profile.scenarios.map((scenario, scenarioIndex) => {
            const vectors = scenario.organizations * scenario.vectorsPerOrganization;
            const totalMs = (100 + scenarioIndex * 10) * multiplier;
            return {
                name: scenario.name,
                dataset: {
                    organizations: scenario.organizations,
                    shards: scenario.shards,
                    vectorsPerOrganization: scenario.vectorsPerOrganization,
                    vectors,
                },
                timing: {
                    totalMs,
                    mutationPhaseMs: 20 * multiplier,
                    mutationAckMs: Array.from({ length: vectors }, (_, index) => (index + 1) * multiplier),
                    controllerDrivenDeliveryMs: 30 * multiplier,
                    refetchPhaseMs: 10 * multiplier,
                    liveRefetchMs: Array.from(
                        { length: scenario.organizations },
                        (_, index) => (index + 2) * multiplier
                    ),
                    liveRefetchRowCounts: Array.from({ length: scenario.organizations }, () =>
                        Array.from({ length: scenario.vectorsPerOrganization }, (_, index) => index + 1)
                    ),
                },
                throughput: {
                    vectorsPerSecond: (vectors * 1_000) / totalMs,
                    organizationsPerSecond: (scenario.organizations * 1_000) / totalMs,
                },
                correctness: {
                    mutationCommits: vectors,
                    readyHeads: vectors,
                    returnedRows: vectors,
                    liveRefetches: scenario.organizations,
                    isolatedOrganizations: scenario.organizations,
                    observedShards: scenario.shards,
                    monotonicRefetches: scenario.organizations,
                    duplicateRows: 0,
                    leakedRows: 0,
                    deliveryTurns: 2,
                    registeredMutation: true,
                    registeredSearch: true,
                    liveProtocol: true,
                },
            };
        }),
    };
}

function report(multipliers = [1, 2, 3]) {
    const profile = PUBLIC_VECTOR_BENCHMARK_PROFILES.ci;
    const samples = multipliers.map((multiplier, sequence) => sample(sequence, multiplier));
    return createPublicVectorBenchmarkReport({
        ok: true,
        workload: {
            id: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID,
            version: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION,
            profile,
        },
        runner: { runtime: {}, machine: {}, processIsolation: "fresh-process-and-runtime-per-run" },
        execution: {
            startedAt: "2026-08-30T00:00:00.000Z",
            completedAt: "2026-08-30T00:01:00.000Z",
            processId: 42,
        },
        warmup: sample(-1),
        samples,
        aggregate: summarizePublicVectorBenchmarkSamples(samples, "ci"),
    });
}

describe("public vector benchmark evidence", () => {
    test("pins CI and opt-in organization/shard scale profiles", () => {
        expect(PUBLIC_VECTOR_BENCHMARK_PROFILES.ci?.scenarios).toEqual([
            { name: "single", organizations: 1, shards: 1, vectorsPerOrganization: 2 },
            { name: "shared-shard", organizations: 4, shards: 1, vectorsPerOrganization: 2 },
            { name: "multi-shard", organizations: 8, shards: 4, vectorsPerOrganization: 2 },
        ]);
        expect(PUBLIC_VECTOR_BENCHMARK_PROFILES.standard?.scenarios[2]).toEqual({
            name: "multi-shard",
            organizations: 32,
            shards: 8,
            vectorsPerOrganization: 16,
        });
        expect(PUBLIC_VECTOR_BENCHMARK_PROFILES.large?.scenarios[2]).toEqual({
            name: "multi-shard",
            organizations: 256,
            shards: 64,
            vectorsPerOrganization: 64,
        });
    });

    test("derives p50, p95, p99, throughput, and exact correctness totals", () => {
        const samples = [sample(0, 1), sample(1, 2), sample(2, 3)];
        const aggregate = summarizePublicVectorBenchmarkSamples(samples, "ci");
        expect(aggregate.scenarios[0]?.latencyMs.total).toMatchObject({
            raw: [100, 200, 300],
            p50: 200,
            p95: 300,
            p99: 300,
        });
        expect(aggregate.scenarios[0]?.latencyMs.mutationAck.raw).toEqual([1, 2, 2, 4, 3, 6]);
        expect(aggregate.scenarios[0]?.latencyMs.controllerDrivenDelivery.raw).toEqual([30, 60, 90]);
        expect(aggregate.scenarios[0]?.latencyMs).not.toHaveProperty("deliveryAlarm");
        expect(aggregate.scenarios[2]?.correctness).toEqual({
            measuredRuns: 3,
            mutationCommits: 48,
            readyHeads: 48,
            returnedRows: 48,
            liveRefetches: 24,
            isolatedOrganizations: 24,
            duplicateRows: 0,
            leakedRows: 0,
        });
        expect(assertPublicVectorBenchmarkReport(JSON.parse(JSON.stringify(report()))).aggregate).toEqual(aggregate);
    });

    test("rejects dishonest backend labels and every correctness-count drift", () => {
        const dishonest = sample(0);
        dishonest.target.kind = "cloudflare";
        expect(() => assertPublicVectorBenchmarkSample(dishonest)).toThrow(/kind must be local/);

        for (const mutate of [
            (value: ReturnType<typeof sample>) => {
                const scenario = value.scenarios[0];
                if (scenario) scenario.correctness.mutationCommits--;
            },
            (value: ReturnType<typeof sample>) => {
                const scenario = value.scenarios[1];
                if (scenario) scenario.correctness.leakedRows++;
            },
            (value: ReturnType<typeof sample>) => {
                const scenario = value.scenarios[2];
                if (scenario) scenario.correctness.observedShards--;
            },
            (value: ReturnType<typeof sample>) => {
                const scenario = value.scenarios[2];
                if (scenario) scenario.correctness.registeredSearch = false;
            },
        ]) {
            const value = sample(0);
            mutate(value);
            expect(() => assertPublicVectorBenchmarkSample(value)).toThrow();
        }
    });

    test("rejects the legacy alarm-latency label", () => {
        const legacy = sample(0);
        const scenario = legacy.scenarios[0] as unknown as { timing: Record<string, unknown> };
        const { controllerDrivenDeliveryMs, ...timing } = scenario.timing;
        scenario.timing = { ...timing, deliveryAlarmMs: controllerDrivenDeliveryMs };
        expect(() => assertPublicVectorBenchmarkSample(legacy)).toThrow(/controllerDrivenDeliveryMs/);
    });

    test("compares only identical workloads and applies optional CI budgets", () => {
        const baseline = report([1, 1, 1]);
        const candidate = report([1.1, 1.1, 1.1]);
        const descriptive = comparePublicVectorBenchmarkReports(baseline, candidate);
        expect(descriptive.passed).toBe(true);
        expect(descriptive.scenarios[0]?.latency.total.p95).toBeCloseTo(1.1);

        const withinBudget = comparePublicVectorBenchmarkReports(baseline, candidate, {
            maxLatencyRatio: 1.2,
            minThroughputRatio: 0.9,
        });
        expect(withinBudget).toMatchObject({ passed: true, violations: [] });

        const failed = comparePublicVectorBenchmarkReports(baseline, candidate, {
            maxLatencyRatio: 1.05,
            minThroughputRatio: 0.95,
        });
        expect(failed.passed).toBe(false);
        expect(failed.violations.length).toBeGreaterThan(0);
    });
});
