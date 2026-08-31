import type { PublicVectorBenchmarkSample } from "./public-vector-benchmark-report.mjs";

export interface PublicVectorBenchmarkProducerOptions {
    readonly help?: boolean;
    readonly profileName: string;
    readonly sequence: number;
    readonly excluded: boolean;
    readonly compatibilityDate?: string;
}

export function parsePublicVectorBenchmarkProducerArgs(argv: readonly string[]): PublicVectorBenchmarkProducerOptions;
export function producePublicVectorBenchmarkSample(
    options: PublicVectorBenchmarkProducerOptions
): Promise<PublicVectorBenchmarkSample>;
