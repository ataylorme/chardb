import type { VectorSqliteBenchmarkReport } from "./vector-sqlite-benchmark-report.mjs";

export interface VectorSqliteBenchmarkOptions {
    readonly headCounts?: readonly number[];
    readonly registrationCounts?: readonly number[];
    readonly repetitions?: number;
    readonly coldReconcileRepetitions?: number;
}

export function produceVectorSqliteBenchmark(options?: VectorSqliteBenchmarkOptions): VectorSqliteBenchmarkReport;
