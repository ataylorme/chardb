export declare const FILE_BENCHMARK_SCHEMA: "chardb.file-benchmark.report.v1";
export declare const FILE_BENCHMARK_WORKLOAD_ID: "organization-file-lifecycle";
export declare const FILE_BENCHMARK_WORKLOAD_VERSION: 1;
export type FileBenchmarkOperation = "upload" | "attach" | "download";

export interface FileBenchmarkOperationPlan {
    readonly count: number;
    readonly concurrency: number;
}

export interface FileBenchmarkPayloadPlan {
    readonly name: "small" | "large";
    readonly payloadBytes: number;
    readonly warmupObjectsPerRun: 1;
    readonly operationsPerRun: Readonly<Record<FileBenchmarkOperation, FileBenchmarkOperationPlan>>;
}

export interface FileBenchmarkProfile {
    readonly name: "standard-v1";
    readonly logicalRuns: 5;
    readonly payloads: readonly FileBenchmarkPayloadPlan[];
}

export declare const FILE_BENCHMARK_PROFILE: FileBenchmarkProfile;

export interface FileBenchmarkOperationSample {
    readonly sequence: number;
    readonly objectSequence: number;
    readonly latencyMs: number;
    readonly bytes: number;
    readonly correctness: {
        readonly authenticated: true;
        readonly organizationIsolated: true;
        readonly operationStatus: true;
        readonly exactBytes: true;
        readonly exactDigest: true;
        readonly cleanupComplete: true;
    };
}

export interface FileBenchmarkRunPayload {
    readonly name: "small" | "large";
    readonly payloadBytes: number;
    readonly payloadSha256: string;
    readonly warmup: {
        readonly excluded: true;
        readonly operations: Readonly<Record<FileBenchmarkOperation, FileBenchmarkOperationSample>>;
    };
    readonly operations: Readonly<
        Record<
            FileBenchmarkOperation,
            { readonly elapsedMs: number; readonly samples: readonly FileBenchmarkOperationSample[] }
        >
    >;
}

export interface FileBenchmarkLogicalRun {
    readonly sequence: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly payloads: readonly FileBenchmarkRunPayload[];
}

export interface FileBenchmarkMetric {
    readonly operations: number;
    readonly concurrency: number;
    readonly elapsedMs: number;
    readonly totalBytes: number;
    readonly operationsPerSecond: number;
    readonly bytesPerSecond: number;
    readonly rawLatencyMs: readonly number[];
    readonly latencyMs: { readonly min: number; readonly p50: number; readonly p95: number; readonly max: number };
}

export interface FileBenchmarkPayloadAggregate {
    readonly name: "small" | "large";
    readonly payloadBytes: number;
    readonly upload: FileBenchmarkMetric;
    readonly attach: FileBenchmarkMetric;
    readonly download: FileBenchmarkMetric;
}

export interface FileBenchmarkReport {
    readonly schema: "chardb.file-benchmark.report.v1";
    readonly ok: true;
    readonly candidate: { readonly sha256: string; readonly bytes: number };
    readonly workload: { readonly id: "organization-file-lifecycle"; readonly version: 1 };
    readonly target: {
        readonly kind: "local" | "cloudflare";
        readonly origin: string;
        readonly deploymentVersion?: string;
        readonly runtime: { readonly name: string; readonly version: string; readonly compatibilityDate: string };
        readonly r2: {
            readonly provider: "miniflare" | "cloudflare";
            readonly binding: string;
            readonly bucket: string;
        };
    };
    readonly profile: FileBenchmarkProfile;
    readonly execution: { readonly startedAt: string; readonly completedAt: string };
    readonly runner: {
        readonly runtime: { readonly name: string; readonly version: string };
        readonly machine: {
            readonly platform: string;
            readonly architecture: string;
            readonly osRelease: string;
            readonly cpuModel: string;
            readonly logicalCpuCount: number;
            readonly memoryBytes: number;
        };
    };
    readonly runs: readonly FileBenchmarkLogicalRun[];
    readonly aggregate: { readonly byPayload: readonly FileBenchmarkPayloadAggregate[] };
}

export declare function summarizeFileBenchmarkRuns(
    runs: readonly FileBenchmarkLogicalRun[]
): FileBenchmarkReport["aggregate"];
export declare function assertFileBenchmarkReport(report: unknown): FileBenchmarkReport;
export declare function createFileBenchmarkReport(input: Omit<FileBenchmarkReport, "schema">): FileBenchmarkReport;
