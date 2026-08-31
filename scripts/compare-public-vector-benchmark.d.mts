export const PUBLIC_VECTOR_BENCHMARK_COMPARISON_SCHEMA: string;
export interface PublicVectorBenchmarkPercentileRatios {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
}
export interface PublicVectorBenchmarkRatioScenario {
    readonly name: string;
    readonly latency: Readonly<Record<string, PublicVectorBenchmarkPercentileRatios>> & {
        readonly total: PublicVectorBenchmarkPercentileRatios;
    };
    readonly throughput: Readonly<Record<string, PublicVectorBenchmarkPercentileRatios>>;
}
export interface PublicVectorBenchmarkViolation {
    readonly scenario: string;
    readonly metric: string;
    readonly observed: number;
    readonly budget: number;
}
export interface PublicVectorBenchmarkComparison extends Record<string, unknown> {
    readonly schema: string;
    readonly passed: boolean;
    readonly scenarios: readonly PublicVectorBenchmarkRatioScenario[];
    readonly violations: readonly PublicVectorBenchmarkViolation[];
}
export interface PublicVectorBenchmarkComparisonOptions {
    readonly baselinePath: string;
    readonly candidatePath: string;
    readonly outputPath: string;
    readonly maxLatencyRatio?: number;
    readonly minThroughputRatio?: number;
}
export function comparePublicVectorBenchmarkReports(
    baselineInput: unknown,
    candidateInput: unknown,
    budgets?: { readonly maxLatencyRatio?: number; readonly minThroughputRatio?: number }
): PublicVectorBenchmarkComparison;
export function parsePublicVectorBenchmarkComparisonArgs(argv: readonly string[]): Record<string, unknown>;
export function comparePublicVectorBenchmarkFiles(
    options: PublicVectorBenchmarkComparisonOptions
): Promise<PublicVectorBenchmarkComparison>;
