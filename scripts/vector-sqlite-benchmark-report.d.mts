export interface VectorSqliteTiming {
    readonly medianUs: number;
    readonly p95Us: number;
}

export interface VectorSqliteBenchmarkResult {
    readonly storedHeads: number;
    readonly registrations: number;
    readonly timings: Readonly<Record<string, VectorSqliteTiming>>;
    readonly proof: Readonly<Record<string, true>>;
}

export interface VectorSqliteBenchmarkReport {
    readonly schema: "chardb.vector-sqlite-benchmark.v1";
    readonly profile: {
        readonly name: string;
        readonly headCounts: readonly number[];
        readonly registrationCounts: readonly number[];
        readonly repetitions: number;
        readonly coldReconcileRepetitions: number;
        readonly candidates: number;
    };
    readonly environment: { readonly bun: string; readonly sqlite: string; readonly storage: "in-memory SQLite" };
    readonly results: readonly VectorSqliteBenchmarkResult[];
    readonly scope: {
        readonly includesVectorizeLatency: false;
        readonly includesPolicyPointReads: false;
        readonly description: string;
    };
}

export const VECTOR_SQLITE_BENCHMARK_SCHEMA: "chardb.vector-sqlite-benchmark.v1";
export const VECTOR_SQLITE_BENCHMARK_PROFILE: Readonly<{
    name: "local-sqlite-standard-v1";
    headCounts: readonly [10, 1000, 10000, 40000];
    registrationCounts: readonly [10, 100, 1000, 4000];
    repetitions: 31;
    coldReconcileRepetitions: 3;
    candidates: 32;
}>;
export function assertVectorSqliteBenchmarkReport(value: unknown): VectorSqliteBenchmarkReport;
