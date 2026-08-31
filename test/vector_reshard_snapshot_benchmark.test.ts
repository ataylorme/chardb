import { describe, expect, test } from "bun:test";
import {
    parseVectorReshardSnapshotBenchmarkArgs,
    produceVectorReshardSnapshotBenchmark,
} from "../scripts/produce-vector-reshard-snapshot-benchmark.mjs";
import {
    VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA,
    assertVectorReshardSnapshotBenchmarkReport,
} from "../scripts/vector-reshard-snapshot-benchmark-report.mjs";

describe("vector reshard snapshot benchmark", () => {
    test("records exact pagination, byte pressure, late cursors, attempt skew, timings, and query plans", () => {
        const report = produceVectorReshardSnapshotBenchmark({ scaleHeads: 2_048 });

        expect(assertVectorReshardSnapshotBenchmarkReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
        expect(report.schema).toBe(VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA);
        expect(report.scenarios.pagination.map(scenario => scenario.pages.recordPageSizes)).toEqual([
            [500],
            [500, 1],
            [500, 500, 1],
        ]);
        expect(report.scenarios.bytePressure.pages.nonemptyPages).toBeGreaterThan(1);
        expect(report.scenarios.bytePressure.pages.peakEncodedPageBytes).toBeLessThanOrEqual(report.limits.pageBytes);
        expect(report.scenarios.attemptSkew.observed).toEqual({ head: 1, outbox: 0, attempt: 4_096, total: 4_097 });
        expect(report.scenarios.lateCursors.head.observed.head).toBe(5);
        expect(report.scenarios.lateCursors.attempt.observed.attempt).toBe(5);
        expect(report.scenarios.scale.observed.head).toBe(2_048);
        for (const scenario of [
            ...report.scenarios.pagination,
            report.scenarios.bytePressure,
            report.scenarios.attemptSkew,
            report.scenarios.scale,
            report.scenarios.lateCursors.head,
            report.scenarios.lateCursors.attempt,
        ]) {
            expect(scenario.exactOnce).toMatchObject({ duplicateRecords: 0, countsMatch: true });
            expect(scenario.pages.encodedPageBytes.every(bytes => bytes <= report.limits.pageBytes)).toBe(true);
            expect(scenario.timings.pageMs).toHaveLength(scenario.pages.readCalls);
        }
        expect(report.queryPlans.anyTempSort).toBe(
            Object.values(report.queryPlans)
                .filter(value => typeof value === "object")
                .some(value => value.usesTempSort)
        );
        expect(report.scope.movementComplete).toBe(false);
    });

    test("supports the durable head cap but rejects larger scale profiles and scope overclaims", () => {
        expect(parseVectorReshardSnapshotBenchmarkArgs(["--scale-heads=65536"])).toEqual({ scaleHeads: 65_536 });
        expect(() => parseVectorReshardSnapshotBenchmarkArgs(["--scale-heads=65537"])).toThrow(
            /scaleHeads must be between 6 and 65536/
        );
        const report = produceVectorReshardSnapshotBenchmark({ scaleHeads: 16 });
        expect(() =>
            assertVectorReshardSnapshotBenchmarkReport({
                ...report,
                scope: { ...report.scope, movementComplete: true },
            })
        ).toThrow(/scope overclaims/);
    });
});
