export interface ReshardBenchmarkSample {
    readonly schema: "chardb.reshard-benchmark.raw-sample.v1";
    readonly sequence: number;
    readonly excluded: boolean;
    readonly candidateSha256: string;
    readonly workload: Readonly<Record<string, unknown>>;
    readonly target: Readonly<Record<string, unknown>>;
    readonly execution: Readonly<Record<string, unknown>>;
    readonly timing: Readonly<Record<string, unknown>>;
    readonly movement: Readonly<Record<string, unknown>>;
    readonly correctness: Readonly<Record<string, unknown>>;
}

export interface ReshardBenchmarkReport {
    readonly schema: "chardb.reshard-benchmark.report.v1";
    readonly ok: true;
    readonly candidate: { readonly sha256: string; readonly bytes: number };
    readonly workload: Readonly<Record<string, unknown>>;
    readonly target: Readonly<Record<string, unknown>>;
    readonly runner: Readonly<Record<string, unknown>>;
    readonly execution: Readonly<Record<string, unknown>>;
    readonly warmup: ReshardBenchmarkSample;
    readonly samples: readonly ReshardBenchmarkSample[];
    readonly aggregate: Readonly<Record<string, unknown>>;
}

export const RESHARD_BENCHMARK_SCHEMA: "chardb.reshard-benchmark.report.v1";
export const RESHARD_BENCHMARK_SAMPLE_SCHEMA: "chardb.reshard-benchmark.raw-sample.v1";
export const RESHARD_BENCHMARK_WORKLOAD_ID: "organization-fresh-destination-range-move";
export const RESHARD_BENCHMARK_WORKLOAD_VERSION: 1;
export const RESHARD_BENCHMARK_PROFILE: {
    readonly name: "standard-v1";
    readonly warmupRuns: 1;
    readonly logicalRuns: 5;
    readonly seed: { readonly organizations: 1; readonly parentRows: 1024; readonly childRows: 4096 };
    readonly capture: { readonly transactionGroups: 256; readonly entriesPerGroup: 1 };
    readonly bulk: { readonly rowLimit: 500; readonly byteLimit: 1048576 };
    readonly tail: { readonly groupLimit: 500; readonly byteLimit: 1048576 };
    readonly drain: { readonly rowLimit: 128 };
    readonly restart: { readonly phase: "bulk"; readonly afterAppliedBatches: 3 };
    readonly routing: { readonly staleRouteRetries: 1; readonly liveReason: "shardsChanged" };
};
export const RESHARD_BENCHMARK_PHASES: readonly [
    "prepare",
    "bulk",
    "capture",
    "restart",
    "replay",
    "fence",
    "cutover",
    "staleRouteRetry",
    "liveRefetch",
    "drain",
    "verify",
];
export function assertReshardBenchmarkSample(
    input: unknown,
    expected?: Readonly<Record<string, unknown>>
): ReshardBenchmarkSample;
export function summarizeReshardBenchmarkSamples(samples: readonly unknown[]): {
    timing: {
        totalMs: { raw: number[]; min: number; p50: number; p95: number; max: number };
        phasesMs: Record<string, { raw: number[]; min: number; p50: number; p95: number; max: number }>;
    };
    totals: {
        elapsedMs: number;
        bulkRows: number;
        bulkBytes: number;
        capturedTransactionGroups: number;
        replayedEntries: number;
        drainedRows: number;
    };
    rates: {
        bulkRowsPerSecond: number;
        bulkBytesPerSecond: number;
        replayEntriesPerSecond: number;
        drainRowsPerSecond: number;
    };
};
export function assertReshardBenchmarkReport(input: unknown): ReshardBenchmarkReport;
export function createReshardBenchmarkReport<Input extends Record<string, unknown>>(
    input: Input
): Input & { schema: "chardb.reshard-benchmark.report.v1" };
