export interface FileReshardBenchmarkProfile {
    readonly name: "small" | "medium" | "large";
    readonly organizations: number;
    readonly files: number;
    readonly logicalRuns: number;
    readonly ciDefault: boolean;
}

export const FILE_RESHARD_BENCHMARK_SCHEMA: string;
export const FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA: string;
export const FILE_RESHARD_BENCHMARK_WORKLOAD_ID: string;
export const FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION: number;
export const FILE_RESHARD_BENCHMARK_PROFILES: Readonly<Record<string, FileReshardBenchmarkProfile>>;
export const FILE_RESHARD_BENCHMARK_PHASES: readonly string[];
export interface FileReshardBenchmarkSample extends Record<string, unknown> {
    sequence: number;
    excluded: boolean;
    workload: { id: string; version: number; profile: FileReshardBenchmarkProfile };
    dataset: { organizations: number; files: number; metadataRows: number; objectBytes: number };
    timing: { totalMs: number; phasesMs: Record<string, number> };
    throughput: { filesPerSecond: number; metadataRowsPerSecond: number };
    movement: {
        runTurns: number;
        files: number;
        metadataRows: number;
        r2: {
            objectsBefore: number;
            objectsAfter: number;
            bytesBefore: number;
            bytesAfter: number;
            identityDigestBefore: string;
            identityDigestAfter: string;
            writesDuringMove: number;
            deletesDuringMove: number;
        };
    };
    restart: Record<string, unknown>;
    correctness: Record<string, boolean>;
}
export interface FileReshardBenchmarkAggregate extends Record<string, unknown> {
    timing: {
        totalMs: Record<string, unknown>;
        phasesMs: Record<string, { raw: number[]; min: number; p50: number; p95: number; max: number }>;
        restartOverheadMs: { raw: number[]; min: number; p50: number; p95: number; max: number };
    };
    rates: Record<string, { raw: number[]; min: number; p50: number; p95: number; max: number }>;
    totals: Record<string, number>;
}
export interface FileReshardBenchmarkReport extends Record<string, unknown> {
    schema: string;
    aggregate: FileReshardBenchmarkAggregate;
}
export function fileReshardBenchmarkProfile(name: string): FileReshardBenchmarkProfile;
export function assertFileReshardBenchmarkSample(
    input: unknown,
    expected?: Record<string, unknown>
): FileReshardBenchmarkSample;
export function summarizeFileReshardBenchmarkSamples(
    samples: readonly unknown[],
    profileName: string
): FileReshardBenchmarkAggregate;
export function createFileReshardBenchmarkReport(input: Record<string, unknown>): FileReshardBenchmarkReport;
export function assertFileReshardBenchmarkReport(input: unknown): FileReshardBenchmarkReport;
