import { describe, expect, test } from "bun:test";
import {
    VECTOR_SCHEDULER_BENCHMARK_SCHEMA,
    produceVectorSchedulerBenchmark,
} from "../scripts/produce-vector-scheduler-benchmark.mjs";

describe("vector scheduler benchmark", () => {
    test("keeps ownership-filtered deadline and claim selection index-backed", () => {
        const report = produceVectorSchedulerBenchmark({ rows: 2_048, samples: 3 });

        expect(report.schema).toBe(VECTOR_SCHEDULER_BENCHMARK_SCHEMA);
        expect(report.profile).toEqual({ rows: 2_048, samples: 3, outboxRowLimit: 65_536 });
        expect(report.placements.fenced).not.toBe(report.placements.owned);
        expect(report.proof).toEqual({
            exercisedExactOutboxLimit: false,
            hotVshardTurnsBeforeCold: 1,
            cursorSurvivedStoreReconstruction: true,
            claimUsesEffectiveDueIndex: true,
            dueUsesEffectiveDueIndex: true,
            placementSeekUsesScheduleIndex: true,
            placementWrapUsesEffectiveDueIndex: true,
            claimAvoidsTempSort: true,
            routingFenceUsesRangeIndex: true,
            destinationChecksUseAdmissionIndex: true,
        });
        expect(report.plans.claim.some(detail => detail.includes("TEMP B-TREE"))).toBe(false);
        expect(report.plans.due.some(detail => detail.includes("TEMP B-TREE"))).toBe(false);
        for (const timing of Object.values(report.timings)) {
            expect(timing.medianMs).toBeGreaterThanOrEqual(0);
            expect(timing.p95Ms).toBeGreaterThanOrEqual(timing.medianMs);
            expect(timing.maxMs).toBeGreaterThanOrEqual(timing.p95Ms);
        }
    });

    test("rejects profiles above the durable outbox limit", () => {
        expect(() => produceVectorSchedulerBenchmark({ rows: 65_537, samples: 1 })).toThrow(
            /rows must be between 2 and 65536/
        );
    });
});
