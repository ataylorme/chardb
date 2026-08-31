import { describe, expect, test } from "bun:test";
import { produceVectorSqliteBenchmark } from "../scripts/produce-vector-sqlite-benchmark.mjs";
import { assertVectorSqliteBenchmarkReport } from "../scripts/vector-sqlite-benchmark-report.mjs";

describe("vector SQLite benchmark evidence", () => {
    test("measures every bounded local transition and proves indexed steady-state paths", () => {
        const report = produceVectorSqliteBenchmark({
            headCounts: [8, 64],
            registrationCounts: [8, 64],
            repetitions: 5,
            coldReconcileRepetitions: 2,
        });
        expect(assertVectorSqliteBenchmarkReport(report)).toBe(report);
        expect(report.results).toHaveLength(2);
        for (const result of report.results) {
            expect(result.proof).toEqual({
                capacityCounterExact: true,
                claimUsesDueIndexWithoutTempSort: true,
                invalidationUsesResourceIndex: true,
                warmRestartSkippedAggregateReconciliation: true,
                candidateResultsBounded: true,
            });
            expect(Object.keys(result.timings).sort()).toEqual(
                [
                    "stageInsert",
                    "stageUpdate",
                    "claim",
                    "readyAck",
                    "validatedCandidateFiltering",
                    "exactInvalidationOneOfN",
                    "exactInvalidationFanout",
                    "warmRestart",
                    "coldReconcile",
                ].sort()
            );
        }
        expect(report.scope).toEqual({
            includesVectorizeLatency: false,
            includesPolicyPointReads: false,
            description:
                "Deterministic local SQLite state transitions only; Vectorize network and policy-protected row reads are excluded.",
        });
    });

    test("rejects reports that imply local SQLite timings include Vectorize latency", () => {
        const report = produceVectorSqliteBenchmark({
            headCounts: [8],
            registrationCounts: [8],
            repetitions: 3,
            coldReconcileRepetitions: 1,
        });
        expect(() =>
            assertVectorSqliteBenchmarkReport({
                ...report,
                scope: { ...report.scope, includesVectorizeLatency: true },
            })
        ).toThrow(/must not claim Vectorize latency/);
    });
});
