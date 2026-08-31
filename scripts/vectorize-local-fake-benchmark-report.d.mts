export interface VectorizeLocalFakeBenchmarkSample {
    readonly sequence: number;
    readonly excluded: boolean;
    readonly elapsedMs: number;
}

export interface VectorizeLocalFakeBenchmarkReport {
    readonly schema: "chardb.vectorize.local-fake-benchmark.v1";
    readonly artifact: {
        readonly kind: "workerd-worker-bundle";
        readonly sha256: string;
        readonly bytes: number;
    };
    readonly environment: {
        readonly bun: string;
        readonly miniflare: string;
        readonly workerd: string;
        readonly compatibilityDate: "2026-08-06";
        readonly durableObjectStorage: "persistent-sqlite";
    };
    readonly workload: {
        readonly id: "ready-vector-filtered-search-v2";
        readonly description: string;
        readonly dimensions: 32;
        readonly metric: "cosine";
        readonly topK: 1;
        readonly requestsPerSample: 1;
        readonly warmupSamples: 1;
        readonly measuredSamples: 5;
    };
    readonly sampling: {
        readonly warmup: VectorizeLocalFakeBenchmarkSample;
        readonly samples: readonly VectorizeLocalFakeBenchmarkSample[];
    };
    readonly track: {
        readonly label: "local-workerd-fake-vectorize";
        readonly runtime: "miniflare/workerd";
        readonly backend: "persistent-fake-index-do";
        readonly realVectorize: false;
        readonly samplesMs: readonly number[];
    };
    readonly correctness: {
        readonly readyBeforeTiming: true;
        readonly owningOrganizationExactMatch: true;
        readonly isolatedOrganizationEmpty: true;
        readonly productionCandidateValidation: true;
        readonly assertionsOutsideTiming: true;
    };
}

export const VECTORIZE_LOCAL_FAKE_BENCHMARK_SCHEMA: "chardb.vectorize.local-fake-benchmark.v1";
export const VECTORIZE_READY_SEARCH_WORKLOAD: Readonly<VectorizeLocalFakeBenchmarkReport["workload"]>;
export function assertVectorizeLocalFakeBenchmarkReport(value: unknown): VectorizeLocalFakeBenchmarkReport;
