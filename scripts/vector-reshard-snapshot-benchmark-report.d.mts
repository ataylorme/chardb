export const VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA: "chardb.vector-reshard-snapshot-benchmark.v1";

export interface VectorReshardSnapshotCounts {
    readonly head: number;
    readonly outbox: number;
    readonly attempt: number;
    readonly total: number;
}

export interface VectorReshardSnapshotMeasurement {
    readonly name: string;
    readonly expected: VectorReshardSnapshotCounts;
    readonly observed: VectorReshardSnapshotCounts;
    readonly exactOnce: {
        readonly expectedTotal: number;
        readonly observedTotal: number;
        readonly uniqueRecords: number;
        readonly duplicateRecords: number;
        readonly countsMatch: boolean;
    };
    readonly pages: {
        readonly readCalls: number;
        readonly nonemptyPages: number;
        readonly recordPageSizes: readonly number[];
        readonly encodedPageBytes: readonly number[];
        readonly peakEncodedPageBytes: number;
    };
    readonly timings: {
        readonly seedMs: number;
        readonly totalPageMs: number;
        readonly worstPageMs: number;
        readonly pageMs: readonly number[];
    };
}

export interface VectorReshardSnapshotQueryPlan {
    readonly details: readonly string[];
    readonly usesTempSort: boolean;
}

export interface VectorReshardSnapshotBenchmarkReport {
    readonly schema: typeof VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA;
    readonly environment: { readonly bun: string; readonly sqlite: string };
    readonly limits: {
        readonly pageRows: number;
        readonly pageBytes: number;
        readonly maxHeads: number;
        readonly maxAttemptVersionsPerHead: number;
        readonly maxAttemptRows: number;
    };
    readonly profile: {
        readonly paginationHeadCounts: readonly [500, 501, 1_001];
        readonly bytePressureHeads: number;
        readonly attemptVersions: number;
        readonly scaleHeads: number;
        readonly lateCursorRemaining: number;
    };
    readonly scenarios: {
        readonly pagination: readonly VectorReshardSnapshotMeasurement[];
        readonly bytePressure: VectorReshardSnapshotMeasurement;
        readonly attemptSkew: VectorReshardSnapshotMeasurement;
        readonly scale: VectorReshardSnapshotMeasurement;
        readonly lateCursors: {
            readonly head: VectorReshardSnapshotMeasurement;
            readonly attempt: VectorReshardSnapshotMeasurement;
        };
    };
    readonly queryPlans: {
        readonly headStart: VectorReshardSnapshotQueryPlan;
        readonly headLate: VectorReshardSnapshotQueryPlan;
        readonly outboxStart: VectorReshardSnapshotQueryPlan;
        readonly attemptStart: VectorReshardSnapshotQueryPlan;
        readonly attemptLate: VectorReshardSnapshotQueryPlan;
        readonly anyTempSort: boolean;
    };
    readonly scope: {
        readonly localSQLiteOnly: true;
        readonly includesSeedingInPageTimings: false;
        readonly includesTailCapture: false;
        readonly includesDestinationApply: false;
        readonly includesCutover: false;
        readonly movementComplete: false;
        readonly description: string;
    };
}

export function assertVectorReshardSnapshotBenchmarkReport(value: unknown): VectorReshardSnapshotBenchmarkReport;
