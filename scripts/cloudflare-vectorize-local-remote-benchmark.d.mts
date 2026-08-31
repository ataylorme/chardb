import type { CloudflareVectorizeProofLifecycle } from "./cloudflare-vectorize-proof-lifecycle.mjs";
import type { PreparedCloudflareVectorizeProof } from "./cloudflare-vectorize-proof-orchestrator.mjs";

export const VECTORIZE_LOCAL_REMOTE_BENCHMARK_SCHEMA: "chardb.vectorize.local-remote-benchmark.v2";
export const VECTORIZE_LOCAL_REMOTE_WORKLOAD_ID: "ready-vector-filtered-search-v2";
export const VECTORIZE_LOCAL_REMOTE_WORKLOAD: Readonly<{
    readonly id: "ready-vector-filtered-search-v2";
    readonly dimensions: 32;
    readonly metric: "cosine";
    readonly topK: 1;
    readonly requestsPerSample: 1;
    readonly warmupSamples: 1;
    readonly measuredSamples: 5;
}>;

export interface VectorizeLocalRemoteBenchmarkResult {
    readonly track: {
        readonly workloadId: "ready-vector-filtered-search-v2";
        readonly warmupExcluded: true;
        readonly warmupCount: 1;
        readonly warmup: import("./cloudflare-vectorize-proof-lifecycle.mjs").VectorProofBenchmarkEvidence["warmup"];
        readonly samples: import("./cloudflare-vectorize-proof-lifecycle.mjs").VectorProofBenchmarkEvidence["samples"];
        readonly exactMatchLatenciesMs: readonly number[];
        /** @deprecated v1 test-fixture compatibility only; v2 evidence never emits this field. */
        readonly samplesMs?: readonly number[];
    };
    readonly evidence: Readonly<Record<string, unknown>>;
}

export function renderVectorizeLocalRemoteWrangler(source: string, indexName: string): string;
export function assertVectorizeLocalRemoteBenchmark(
    value: unknown,
    expectedCandidateSha256?: string
): VectorizeLocalRemoteBenchmarkResult;
export function startVectorizeLocalRemoteRuntime(
    input: Record<string, unknown>,
    injected?: Record<string, unknown>
): Promise<{
    readonly origin: string;
    readonly port: number;
    readonly stop: () => Promise<void>;
}>;
export function runVectorizeLocalRemoteBenchmark(
    input: {
        readonly prepared: PreparedCloudflareVectorizeProof;
        readonly persistenceDir: string;
        readonly runtimeDir: string;
        readonly wrangler: string;
        readonly profile?: string;
        readonly apiToken?: string;
        readonly accountId?: string;
        readonly migrationId: string;
        readonly owningName: string;
        readonly owningSlug: string;
        readonly isolatedName: string;
        readonly isolatedSlug: string;
        readonly mutationRunId: string;
        readonly documentId: string;
        readonly text: string;
        readonly values: readonly number[];
        readonly timeoutMs?: number;
        readonly intervalMs?: number;
        readonly startupTimeoutMs?: number;
        readonly requestTimeoutMs?: number;
        readonly graceMs?: number;
        readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
    },
    injected?: {
        readonly lifecycle?: CloudflareVectorizeProofLifecycle;
        readonly fetch?: typeof fetch;
        readonly now?: () => number;
        readonly sleep?: (milliseconds: number) => Promise<void>;
        readonly checkpoint?: (
            value:
                | "health"
                | "migration"
                | "organization-setup"
                | "readiness-isolation"
                | "query-stability"
                | "timed-search-warmup"
                | `timed-search-${number}`
                | "post-timing-isolated-search"
                | "delete-and-absence"
        ) => Promise<void>;
        readonly readSecrets?: (file: string) => Promise<{
            readonly betterAuthSecret: string;
            readonly adminToken: string;
            readonly runId: string;
        }>;
        readonly appendOwnedIds: (input: {
            readonly vectorId: string;
            readonly action: "create" | "delete";
            readonly nextVersion: number;
            readonly physicalIds: readonly string[];
        }) => Promise<void>;
        readonly startRuntime?: (
            input: Record<string, unknown>,
            dependencies?: Record<string, unknown>
        ) => Promise<{
            readonly origin: string;
            readonly port: number;
            readonly stop: () => Promise<void>;
        }>;
        readonly runtimeDependencies?: Record<string, unknown>;
    }
): Promise<VectorizeLocalRemoteBenchmarkResult>;
