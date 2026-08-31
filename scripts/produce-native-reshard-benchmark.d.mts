import type { ReshardBenchmarkSample } from "./reshard-benchmark-report.mjs";

export interface NativeReshardProducerOptions {
    readonly profile: "standard-v1";
    readonly sequence: number;
    readonly excluded: boolean;
    readonly candidate: string;
    readonly candidateSha256: string;
}

export function parseNativeReshardProducerArgs(argv: readonly string[]): NativeReshardProducerOptions;
export function produceNativeReshardBenchmarkSample(
    options: NativeReshardProducerOptions
): Promise<ReshardBenchmarkSample>;
