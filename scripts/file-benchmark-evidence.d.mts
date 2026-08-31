export declare const FILE_BENCHMARK_EVIDENCE_FILENAME: "evidence.sha256";
export declare const FILE_BENCHMARK_EVIDENCE_FILES: readonly [
    "local.json",
    "cloudflare.json",
    "comparison.json",
    "paired.json",
];
export declare const FILE_BENCHMARK_PAIR_SCHEMA: "chardb.file-benchmark.pair.v1";

export interface FileBenchmarkEvidenceCandidate {
    readonly sha256: string;
    readonly bytes: number;
}

export interface FileBenchmarkEvidenceManifestInput {
    readonly directory: string;
    readonly candidate: FileBenchmarkEvidenceCandidate;
}

export interface FileBenchmarkEvidenceManifest {
    readonly directory: string;
    readonly path: string;
    readonly candidate: FileBenchmarkEvidenceCandidate;
    readonly entries: readonly {
        readonly filename: (typeof FILE_BENCHMARK_EVIDENCE_FILES)[number];
        readonly bytes: number;
        readonly sha256: string;
    }[];
}

export function validateFileBenchmarkEvidenceManifest(
    input: FileBenchmarkEvidenceManifestInput
): Promise<FileBenchmarkEvidenceManifest>;

export function writeFileBenchmarkEvidenceManifest(
    input: FileBenchmarkEvidenceManifestInput
): Promise<FileBenchmarkEvidenceManifest>;
