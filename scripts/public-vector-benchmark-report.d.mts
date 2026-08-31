export interface PublicVectorBenchmarkScenarioProfile {
    readonly name: string;
    readonly organizations: number;
    readonly shards: number;
    readonly vectorsPerOrganization: number;
}

export interface PublicVectorBenchmarkProfile {
    readonly name: "ci" | "standard" | "large";
    readonly logicalRuns: number;
    readonly ciDefault: boolean;
    readonly scenarios: readonly PublicVectorBenchmarkScenarioProfile[];
}

export interface PublicVectorBenchmarkDistribution {
    readonly raw: readonly number[];
    readonly min: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
}

export interface PublicVectorBenchmarkAggregateScenario extends Record<string, unknown> {
    readonly name: string;
    readonly latencyMs: {
        readonly total: PublicVectorBenchmarkDistribution;
        readonly mutationPhase: PublicVectorBenchmarkDistribution;
        readonly mutationAck: PublicVectorBenchmarkDistribution;
        readonly controllerDrivenDelivery: PublicVectorBenchmarkDistribution;
        readonly refetchPhase: PublicVectorBenchmarkDistribution;
        readonly liveRefetch: PublicVectorBenchmarkDistribution;
    };
    readonly throughput: Readonly<Record<string, PublicVectorBenchmarkDistribution>>;
    readonly correctness: Readonly<Record<string, number>>;
}

export interface PublicVectorBenchmarkSample extends Record<string, unknown> {
    readonly sequence: number;
    readonly excluded: boolean;
    readonly workload: {
        readonly id: string;
        readonly version: number;
        readonly profile: PublicVectorBenchmarkProfile;
    };
    readonly target: Record<string, unknown>;
    readonly scenarios: readonly Record<string, unknown>[];
}

export interface PublicVectorBenchmarkReport extends Record<string, unknown> {
    readonly schema: string;
    readonly aggregate: { readonly scenarios: readonly PublicVectorBenchmarkAggregateScenario[] };
}

export const PUBLIC_VECTOR_BENCHMARK_SCHEMA: string;
export const PUBLIC_VECTOR_BENCHMARK_SAMPLE_SCHEMA: string;
export const PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID: string;
export const PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION: number;
export const PUBLIC_VECTOR_BENCHMARK_PROFILES: Readonly<Record<string, PublicVectorBenchmarkProfile>>;
export function publicVectorBenchmarkProfile(name: string): PublicVectorBenchmarkProfile;
export function distribution(values: readonly number[]): Record<string, number | readonly number[]>;
export function assertPublicVectorBenchmarkSample(
    input: unknown,
    expected?: { readonly sequence?: number; readonly profile?: string }
): PublicVectorBenchmarkSample;
export function summarizePublicVectorBenchmarkSamples(
    samples: readonly unknown[],
    profileName: string
): PublicVectorBenchmarkReport["aggregate"];
export function assertPublicVectorBenchmarkReport(input: unknown): PublicVectorBenchmarkReport;
export function createPublicVectorBenchmarkReport(input: Record<string, unknown>): PublicVectorBenchmarkReport;
export function assertPublicVectorBenchmarkAggregate(input: unknown, profileName: string): Record<string, unknown>;
