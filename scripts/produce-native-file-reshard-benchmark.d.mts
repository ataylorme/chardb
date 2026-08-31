import type { FileReshardBenchmarkProfile, FileReshardBenchmarkSample } from "./file-reshard-benchmark-report.mjs";

export function parseNativeFileReshardProducerArgs(argv: readonly string[]): {
    profile: FileReshardBenchmarkProfile;
    sequence: number;
    excluded: boolean;
};
export function produceNativeFileReshardBenchmarkSample(options: {
    profile: FileReshardBenchmarkProfile;
    sequence: number;
    excluded: boolean;
}): Promise<FileReshardBenchmarkSample>;
