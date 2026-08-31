export interface FileReshardBenchmarkRun {
    readonly sequence: number;
    readonly excluded: boolean;
    readonly filename: string;
}

export function parseFileReshardBenchmarkArgs(argv: readonly string[]): {
    help: boolean;
    profileName: string;
    timeoutMs: number;
    producer: string | undefined;
    outputDir: string | undefined;
};
export function fileReshardBenchmarkRunPlan(profileName: string): readonly FileReshardBenchmarkRun[];
export function fileReshardBenchmarkProducerArgs(
    producer: string,
    run: FileReshardBenchmarkRun,
    profileName: string
): string[];
export function runFileReshardBenchmark(options: Record<string, unknown>): Promise<FileReshardBenchmarkReport>;
import type { FileReshardBenchmarkReport } from "./file-reshard-benchmark-report.mjs";
