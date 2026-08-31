import { describe, expect, test } from "bun:test";
import {
    VECTOR_RESHARD_MOVEMENT_BENCHMARK_SCHEMA,
    assertVectorReshardMovementBenchmarkReport,
    createVectorReshardMovementBenchmarkReport,
} from "../scripts/vector-reshard-movement-benchmark-report.mjs";

function report() {
    return createVectorReshardMovementBenchmarkReport({
        workload: {
            domainRows: 501,
            heads: 501,
            outboxRows: 501,
            attemptRows: 501,
            snapshotRecords: 1_503,
            pageLimit: 500,
        },
        timing: { bulkMs: 500, cutoverMs: 10, drainMs: 100, totalMs: 2_000 },
        pages: { copy: 7, parity: 7 },
        turns: { bulk: 12, cutover: 9, drain: 10, snapshotLoss: 1, finalizeLoss: 7, drainLoss: 2 },
        losses: [
            { operation: "apply_snapshot", committed: true, retried: true },
            { operation: "finalize_dest", committed: true, retried: true },
            { operation: "drain_source", committed: true, retried: true },
        ],
        restart: {
            afterVectorBegin: true,
            beforeRelationalBulkComplete: true,
            destinationGuardsStayedUninstalled: true,
        },
        externalVectorize: { movementCalls: 0 },
        abort: { completed: true, turns: 4, externalVectorizeCalls: 0 },
        correctness: {
            snapshotExact: true,
            tailConverged: true,
            parityExact: true,
            coldRestartResumed: true,
            destinationGuardsRestored: true,
            sourceDrained: true,
            destinationServing: true,
            staleSourceRejected: true,
            abortRestored: true,
        },
    });
}

describe("native vector movement benchmark report", () => {
    test("accepts complete native movement evidence", () => {
        const value = report();
        expect(value.schema).toBe(VECTOR_RESHARD_MOVEMENT_BENCHMARK_SCHEMA);
        expect(assertVectorReshardMovementBenchmarkReport(JSON.parse(JSON.stringify(value)))).toEqual(value);
        expect(value.scope.movementComplete).toBeTrue();
    });

    test("rejects overclaims, missing boundaries, external calls, and incomplete loss coverage", () => {
        const corruptions: Array<(value: ReturnType<typeof report>) => unknown> = [
            value => ({ ...value, correctness: { ...value.correctness, parityExact: false } }),
            value => ({ ...value, workload: { ...value.workload, domainRows: 500 } }),
            value => ({ ...value, externalVectorize: { movementCalls: 1 } }),
            value => ({
                ...value,
                losses: value.losses.map((loss, index) => (index === 1 ? { ...loss, retried: false } : loss)),
            }),
            value => ({ ...value, scope: { movementComplete: false } }),
        ];
        for (const corrupt of corruptions) {
            expect(() => assertVectorReshardMovementBenchmarkReport(corrupt(report()))).toThrow();
        }
    });

    test("rejects schema drift and reports that cannot match their workload", () => {
        const corruptions: Array<(value: ReturnType<typeof report>) => unknown> = [
            value => ({ ...value, extra: true }),
            value => ({ ...value, workload: { ...value.workload, extra: true } }),
            value => ({ ...value, target: { ...value.target, runtime: "node" } }),
            value => ({ ...value, timing: { ...value.timing, totalMs: 609 } }),
            value => ({ ...value, pages: { ...value.pages, copy: 5 } }),
            value => ({
                ...value,
                losses: value.losses.map((loss, index) => (index === 0 ? { ...loss, extra: true } : loss)),
            }),
            value => ({ ...value, correctness: { ...value.correctness, extra: true } }),
        ];
        for (const corrupt of corruptions) {
            expect(() => assertVectorReshardMovementBenchmarkReport(corrupt(report()))).toThrow();
        }
    });
});
