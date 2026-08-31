import { describe, expect, test } from "bun:test";
import {
    VECTORIZE_LOCAL_FAKE_BENCHMARK_SCHEMA,
    VECTORIZE_READY_SEARCH_WORKLOAD,
    assertVectorizeLocalFakeBenchmarkReport,
} from "../scripts/vectorize-local-fake-benchmark-report.mjs";

function report() {
    const samples = [1, 2, 3, 4, 5].map((elapsedMs, sequence) => ({ sequence, excluded: false, elapsedMs }));
    return {
        schema: VECTORIZE_LOCAL_FAKE_BENCHMARK_SCHEMA,
        artifact: { kind: "workerd-worker-bundle", sha256: "a".repeat(64), bytes: 1_024 },
        environment: {
            bun: "1.2.22",
            miniflare: "4.0.0",
            workerd: "1.0.0",
            compatibilityDate: "2026-08-06" as const,
            durableObjectStorage: "persistent-sqlite" as const,
        },
        workload: { ...VECTORIZE_READY_SEARCH_WORKLOAD },
        sampling: {
            warmup: { sequence: -1, excluded: true, elapsedMs: 9 },
            samples,
        },
        track: {
            label: "local-workerd-fake-vectorize",
            runtime: "miniflare/workerd",
            backend: "persistent-fake-index-do",
            realVectorize: false,
            samplesMs: samples.map(sample => sample.elapsedMs),
        },
        correctness: {
            readyBeforeTiming: true,
            owningOrganizationExactMatch: true,
            isolatedOrganizationEmpty: true,
            productionCandidateValidation: true,
            assertionsOutsideTiming: true,
        },
    };
}

function changed(mutate: (value: ReturnType<typeof report>) => void) {
    const value = structuredClone(report());
    mutate(value);
    return value;
}

describe("local fake Vectorize benchmark report", () => {
    test("accepts the exact honest five-sample report", () => {
        const value = report();
        expect<unknown>(assertVectorizeLocalFakeBenchmarkReport(value)).toBe(value);
        expect(value.workload.dimensions).toBe(32);
    });

    test("rejects shape, sample-plan, label, workload, and correctness drift", () => {
        expect(() => assertVectorizeLocalFakeBenchmarkReport({ ...report(), extra: true })).toThrow(
            "fields must be exactly"
        );
        expect(() =>
            assertVectorizeLocalFakeBenchmarkReport(
                changed(value => {
                    (value.artifact as { kind: string }).kind = "release-tarball";
                })
            )
        ).toThrow("artifact kind");
        expect(() =>
            assertVectorizeLocalFakeBenchmarkReport(
                changed(value => {
                    value.sampling.warmup.excluded = false;
                })
            )
        ).toThrow("fixed sample plan");
        expect(() =>
            assertVectorizeLocalFakeBenchmarkReport(
                changed(value => {
                    value.sampling.samples.pop();
                })
            )
        ).toThrow("exactly five measured samples");
        expect(() =>
            assertVectorizeLocalFakeBenchmarkReport(
                changed(value => {
                    value.track.realVectorize = true;
                })
            )
        ).toThrow("dishonest runtime or backend label");
        expect(() =>
            assertVectorizeLocalFakeBenchmarkReport(
                changed(value => {
                    value.track.samplesMs[0] = 99;
                })
            )
        ).toThrow("raw measured samples");
        expect(() =>
            assertVectorizeLocalFakeBenchmarkReport(
                changed(value => {
                    (value.workload as { topK: number }).topK = 2;
                })
            )
        ).toThrow("fixed contract");
        expect(() =>
            assertVectorizeLocalFakeBenchmarkReport(
                changed(value => {
                    value.correctness.productionCandidateValidation = false;
                })
            )
        ).toThrow("did not pass");
    });
});
