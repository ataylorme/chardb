export const VECTOR_RESHARD_MOVEMENT_BENCHMARK_SCHEMA: "chardb.vector-reshard-movement-benchmark.v1";

export interface VectorReshardMovementBenchmarkReport {
    schema: typeof VECTOR_RESHARD_MOVEMENT_BENCHMARK_SCHEMA;
    workload: {
        domainRows: number;
        heads: number;
        outboxRows: number;
        attemptRows: number;
        snapshotRecords: number;
        pageLimit: number;
    };
    target: { runtime: "workerd"; driver: "miniflare"; durableObjects: true; sqlite: true };
    timing: { bulkMs: number; cutoverMs: number; drainMs: number; totalMs: number };
    pages: { copy: number; parity: number };
    turns: {
        bulk: number;
        cutover: number;
        drain: number;
        snapshotLoss: number;
        finalizeLoss: number;
        drainLoss: number;
    };
    losses: [
        { operation: "apply_snapshot"; committed: boolean; retried: boolean },
        { operation: "finalize_dest"; committed: boolean; retried: boolean },
        { operation: "drain_source"; committed: boolean; retried: boolean },
    ];
    restart: {
        afterVectorBegin: boolean;
        beforeRelationalBulkComplete: boolean;
        destinationGuardsStayedUninstalled: boolean;
    };
    externalVectorize: { movementCalls: number };
    abort: { completed: boolean; turns: number; externalVectorizeCalls: number };
    correctness: {
        snapshotExact: boolean;
        tailConverged: boolean;
        parityExact: boolean;
        coldRestartResumed: boolean;
        destinationGuardsRestored: boolean;
        sourceDrained: boolean;
        destinationServing: boolean;
        staleSourceRejected: boolean;
        abortRestored: boolean;
    };
    scope: { movementComplete: boolean };
}

export type VectorReshardMovementBenchmarkInput = Omit<
    VectorReshardMovementBenchmarkReport,
    "schema" | "target" | "scope"
>;

export function assertVectorReshardMovementBenchmarkReport(value: unknown): VectorReshardMovementBenchmarkReport;
export function createVectorReshardMovementBenchmarkReport(
    input: VectorReshardMovementBenchmarkInput
): VectorReshardMovementBenchmarkReport;
