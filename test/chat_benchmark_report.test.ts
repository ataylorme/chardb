import { describe, expect, test } from "bun:test";
import {
    CHAT_BENCHMARK_COMPARISON_SCHEMA,
    CHAT_BENCHMARK_DRIVER_VERSION,
    CHAT_BENCHMARK_SCHEMA,
    CHAT_BENCHMARK_WORKLOAD_ID,
    assertChatBenchmarkReport,
    compareChatBenchmarkReports,
} from "../scripts/chat-benchmark-report.mjs";

function liveMetric(multiplier: number, latencyMs: number) {
    return {
        operations: 4,
        concurrency: 1,
        elapsedMs: latencyMs * 4 * multiplier,
        operationsPerSecond: 1_000 / (latencyMs * multiplier),
        rawLatencyMs: Array.from({ length: 4 }, () => latencyMs * multiplier),
        latencyMs: {
            min: latencyMs * multiplier,
            p50: latencyMs * multiplier,
            p95: latencyMs * multiplier,
            max: latencyMs * multiplier,
        },
    };
}

function report(kind: "local" | "cloudflare", multiplier = 1) {
    return {
        schema: CHAT_BENCHMARK_SCHEMA,
        ok: true,
        workload: { id: CHAT_BENCHMARK_WORKLOAD_ID, driverVersion: CHAT_BENCHMARK_DRIVER_VERSION },
        target: {
            kind,
            origin: kind === "local" ? "http://127.0.0.1:8787" : "https://stage.example",
            label: kind,
            runtime: {},
        },
        candidate: { sha256: "a".repeat(64), verifiedByTarget: true },
        profile: {
            name: "ci-smoke",
            directQueries: 32,
            directConcurrency: 8,
            liveUpdates: 4,
            liveConcurrency: 1,
            seedRows: 2,
            replacementClients: 2,
        },
        run: { startedAt: "2026-08-27T00:00:00.000Z", completedAt: "2026-08-27T00:00:01.000Z", processSamples: 1 },
        runner: { bun: "1.2.22" },
        metrics: {
            directRead: {
                operations: 32,
                concurrency: 8,
                elapsedMs: 40 * multiplier,
                operationsPerSecond: 800 / multiplier,
                rawLatencyMs: Array.from({ length: 32 }, () => 8 * multiplier),
                latencyMs: { min: 2, p50: 8 * multiplier, p95: 10 * multiplier, max: 12 * multiplier },
            },
            liveMutation: liveMetric(multiplier, 20),
            liveMutationAck: liveMetric(multiplier, 10),
            liveOwnerSnapshot: liveMetric(multiplier, 18),
            liveObserverSnapshot: liveMetric(multiplier, 20),
        },
        invariants: {
            nativeBetterAuth: true,
            organizationIsolation: true,
            exactDirectRows: true,
            overLimitDenied: true,
            twoClientLiveDelivery: true,
            mutationReplayStable: true,
        },
    };
}

describe("local and deployed chat benchmark reports", () => {
    test("compares only the same candidate and workload", () => {
        const comparison = compareChatBenchmarkReports(report("local"), report("cloudflare", 2));
        expect(comparison.schema).toBe(CHAT_BENCHMARK_COMPARISON_SCHEMA);
        expect(comparison.ratios).toEqual({
            directRead: { throughput: 0.5, latencyP50: 2, latencyP95: 2 },
            liveMutation: { throughput: 0.5, latencyP50: 2, latencyP95: 2 },
            liveMutationAck: { throughput: 0.5, latencyP50: 2, latencyP95: 2 },
            liveOwnerSnapshot: { throughput: 0.5, latencyP50: 2, latencyP95: 2 },
            liveObserverSnapshot: { throughput: 0.5, latencyP50: 2, latencyP95: 2 },
        });
    });

    test("rejects invalid evidence and mismatched profiles", () => {
        const invalid = report("local") as ReturnType<typeof report> & { invariants: Record<string, boolean> };
        invalid.invariants.organizationIsolation = false;
        expect(() => assertChatBenchmarkReport(invalid)).toThrow("organizationIsolation");

        const deployed = report("cloudflare");
        deployed.profile.directQueries = 64;
        expect(() => compareChatBenchmarkReports(report("local"), deployed)).toThrow("not comparable");
    });
});
