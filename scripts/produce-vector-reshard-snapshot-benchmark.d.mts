import type { VectorReshardSnapshotBenchmarkReport } from "./vector-reshard-snapshot-benchmark-report.mjs";

export interface VectorReshardSnapshotBenchmarkOptions {
    readonly scaleHeads?: number;
}

export function parseVectorReshardSnapshotBenchmarkArgs(argv: readonly string[]): Readonly<{ scaleHeads: number }>;

export function produceVectorReshardSnapshotBenchmark(
    options?: VectorReshardSnapshotBenchmarkOptions
): VectorReshardSnapshotBenchmarkReport;
