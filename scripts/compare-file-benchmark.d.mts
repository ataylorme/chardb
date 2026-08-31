import type { FileBenchmarkReport } from "./file-benchmark-report.mjs";

export declare const FILE_BENCHMARK_COMPARISON_SCHEMA: "chardb.file-benchmark.comparison.v1";

export interface FileBenchmarkComparisonOptions {
    readonly help: boolean;
    readonly localPath?: string;
    readonly cloudflarePath?: string;
    readonly outputPath?: string;
}

export interface FileBenchmarkOperationRatios {
    readonly latencyP50: number;
    readonly latencyP95: number;
    readonly operationsPerSecond: number;
    readonly bytesPerSecond?: number;
}

export interface FileBenchmarkComparison {
    readonly schema: "chardb.file-benchmark.comparison.v1";
    readonly ratioDirection: "cloudflare/local";
    readonly measurementBoundary: {
        readonly measures: readonly ["client-observed-latency", "throughput"];
        readonly billingCountersCollected: false;
        readonly costClaimed: false;
    };
    readonly candidate: FileBenchmarkReport["candidate"];
    readonly workload: FileBenchmarkReport["workload"];
    readonly profile: FileBenchmarkReport["profile"];
    readonly runner: FileBenchmarkReport["runner"];
    readonly local: {
        readonly target: FileBenchmarkReport["target"];
        readonly execution: FileBenchmarkReport["execution"];
    };
    readonly cloudflare: {
        readonly target: FileBenchmarkReport["target"];
        readonly execution: FileBenchmarkReport["execution"];
    };
    readonly ratios: readonly {
        readonly payloadBytes: number;
        readonly upload: FileBenchmarkOperationRatios;
        readonly attach: FileBenchmarkOperationRatios;
        readonly download: FileBenchmarkOperationRatios;
    }[];
}

export declare function compareFileBenchmarkReports(local: unknown, cloudflare: unknown): FileBenchmarkComparison;
export declare function parseFileBenchmarkComparisonArgs(argv: readonly string[]): FileBenchmarkComparisonOptions;
export declare function compareFileBenchmarkReportFiles(options: {
    readonly localPath: string;
    readonly cloudflarePath: string;
    readonly outputPath: string;
}): Promise<FileBenchmarkComparison>;
