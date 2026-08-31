export interface ChatBenchmarkMetric {
    readonly operations: number;
    readonly concurrency: number;
    readonly elapsedMs: number;
    readonly operationsPerSecond: number;
    readonly rawLatencyMs: readonly number[];
    readonly latencyMs: { readonly min: number; readonly p50: number; readonly p95: number; readonly max: number };
}

export interface ChatBenchmarkReport {
    readonly schema: "chardb.target-benchmark.report.v2";
    readonly ok: true;
    readonly workload: { readonly id: "organization-chat-public-api-v1"; readonly driverVersion: 2 };
    readonly target: {
        readonly kind: "local" | "cloudflare";
        readonly origin: string;
        readonly label: string;
        readonly runtime: Record<string, unknown>;
    };
    readonly candidate: {
        readonly sha256: string;
        readonly verifiedByTarget: true;
        readonly deploymentVersion?: string;
    };
    readonly profile: {
        readonly name: string;
        readonly directQueries: number;
        readonly directConcurrency: number;
        readonly liveUpdates: number;
        readonly liveConcurrency: number;
        readonly seedRows: number;
        readonly replacementClients: number;
    };
    readonly run: { readonly startedAt: string; readonly completedAt: string; readonly processSamples: 1 };
    readonly runner: Record<string, unknown>;
    readonly metrics: {
        readonly directRead: ChatBenchmarkMetric;
        readonly liveMutation: ChatBenchmarkMetric;
        readonly liveMutationAck: ChatBenchmarkMetric;
        readonly liveOwnerSnapshot: ChatBenchmarkMetric;
        readonly liveObserverSnapshot: ChatBenchmarkMetric;
    };
    readonly invariants: Record<string, true>;
}

export declare const CHAT_BENCHMARK_SCHEMA: "chardb.target-benchmark.report.v2";
export declare const CHAT_BENCHMARK_COMPARISON_SCHEMA: "chardb.target-benchmark.comparison.v2";
export declare const CHAT_BENCHMARK_WORKLOAD_ID: "organization-chat-public-api-v1";
export declare const CHAT_BENCHMARK_DRIVER_VERSION: 2;
export declare function assertChatBenchmarkReport(report: unknown): ChatBenchmarkReport;
export declare function compareChatBenchmarkReports(
    local: unknown,
    deployed: unknown
): Record<string, unknown> & { readonly schema: "chardb.target-benchmark.comparison.v2" };
