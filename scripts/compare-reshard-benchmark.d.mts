import type { ReshardBenchmarkReport } from "./reshard-benchmark-report.mjs";

export const RESHARD_BENCHMARK_COMPARISON_SCHEMA: "chardb.reshard-benchmark.comparison.v1";
export function compareReshardBenchmarkReports(
    local: unknown,
    candidate: unknown
): {
    readonly schema: "chardb.reshard-benchmark.comparison.v1";
    readonly ratioDirection: string;
    readonly ratios: {
        readonly totalLatency: { readonly p50: number; readonly p95: number };
        readonly phases: Record<string, { readonly p50: number; readonly p95: number }>;
        readonly rates: Record<string, number>;
    };
    readonly [key: string]: unknown;
};
export function parseReshardBenchmarkComparisonArgs(argv: readonly string[]): {
    readonly help: boolean;
    readonly localPath?: string;
    readonly candidatePath?: string;
    readonly outputPath?: string;
};
export function compareReshardBenchmarkReportFiles(options: {
    readonly localPath: string;
    readonly candidatePath: string;
    readonly outputPath: string;
}): Promise<Readonly<Record<string, unknown>>>;
export type { ReshardBenchmarkReport };
