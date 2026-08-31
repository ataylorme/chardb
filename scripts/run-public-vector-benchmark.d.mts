import type { PublicVectorBenchmarkReport } from "./public-vector-benchmark-report.mjs";

export interface PublicVectorBenchmarkRun {
    readonly sequence: number;
    readonly excluded: boolean;
    readonly filename: string;
}

export interface PublicVectorBenchmarkRunnerOptions {
    readonly profileName?: string;
    readonly producer: string;
    readonly outputDir: string;
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly spawnProducer?: (input: {
        readonly producer: string;
        readonly cwd: string;
        readonly run: PublicVectorBenchmarkRun;
        readonly profileName: string;
        readonly timeoutMs: number;
    }) => Promise<unknown>;
}

export function parsePublicVectorBenchmarkArgs(argv: readonly string[]): Record<string, unknown>;
export function publicVectorBenchmarkRunPlan(profileName: string): readonly PublicVectorBenchmarkRun[];
export function publicVectorBenchmarkProducerArgs(
    producer: string,
    run: PublicVectorBenchmarkRun,
    profileName: string
): string[];
export function runPublicVectorBenchmark(
    options: PublicVectorBenchmarkRunnerOptions
): Promise<PublicVectorBenchmarkReport>;
