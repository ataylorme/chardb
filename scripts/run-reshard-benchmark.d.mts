import type { ReshardBenchmarkReport, ReshardBenchmarkSample } from "./reshard-benchmark-report.mjs";

export interface ReshardBenchmarkRun {
    readonly sequence: number;
    readonly excluded: boolean;
    readonly filename: string;
}

export function parseReshardBenchmarkArgs(argv: readonly string[]): {
    readonly help: boolean;
    readonly producer?: string;
    readonly candidate?: string;
    readonly outputDir?: string;
    readonly timeoutMs: number;
};
export function reshardBenchmarkRunPlan(): readonly ReshardBenchmarkRun[];
export function reshardBenchmarkProducerArgs(
    producer: string,
    run: ReshardBenchmarkRun,
    candidate: string,
    candidateSha256: string
): string[];
export function runReshardBenchmark(options: {
    readonly producer: string;
    readonly candidate: string;
    readonly outputDir: string;
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly spawnProducer?: (input: {
        readonly producer: string;
        readonly cwd: string;
        readonly run: ReshardBenchmarkRun;
        readonly candidate: string;
        readonly candidateSha256: string;
        readonly timeoutMs: number;
    }) => Promise<ReshardBenchmarkSample>;
}): Promise<ReshardBenchmarkReport>;
