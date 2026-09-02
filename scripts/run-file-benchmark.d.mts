export interface FileBenchmarkOptions {
    readonly help: false;
    readonly tarball: string;
    readonly output: string;
    readonly localUrl: URL;
    readonly cloudflareUrl: URL;
    readonly localBucket: string;
    readonly cloudflareBucket: string;
    readonly cloudflareDeploymentVersion: string;
    readonly wranglerVersion: string;
    readonly compatibilityDate: string;
    readonly adminToken: string;
    readonly runId: string;
    readonly onUpload?: (
        targetKind: "local" | "cloudflare",
        upload: { readonly organizationId: string; readonly fileId: string }
    ) => Promise<unknown> | unknown;
}

export declare const FILE_BENCHMARK_PAIR_SCHEMA: "chardb.file-benchmark.pair.v1";
export declare const FILE_BENCHMARK_DEFAULTS: {
    readonly smallBytes: number;
    readonly largeBytes: number;
    readonly compatibilityDate: string;
};

export declare function parseFileBenchmarkArgs(argv: readonly string[]): FileBenchmarkOptions | { readonly help: true };
export declare function alternatingTargetOrder(
    batchIndex: number
): readonly ["local", "cloudflare"] | readonly ["cloudflare", "local"];
export declare function deterministicFilePayload(size: number, seed: string): Uint8Array;
export declare function runFileBenchmarkUploadHook(
    onUpload: FileBenchmarkOptions["onUpload"],
    targetKind: "local" | "cloudflare",
    upload: { readonly organizationId: string; readonly fileId: string }
): Promise<void>;
export declare function runRetryableFileUpload<T extends { readonly response: Response }>(
    operation: () => Promise<T>,
    pause?: (milliseconds: number) => Promise<unknown>
): Promise<{ readonly value: T; readonly attempts: number }>;
export declare function validateFileBenchmarkEvidence(
    directory: string,
    expectedCandidateSha256?: string
): Promise<{
    readonly schema: "chardb.file-benchmark.pair.v1";
    readonly candidate: { readonly sha256: string; readonly bytes: number };
    readonly pairSha256: string;
    readonly files: 4;
}>;
export declare function runPairedFileBenchmark(options: FileBenchmarkOptions): Promise<{
    readonly pair: Record<string, unknown>;
    readonly reports: Record<"local" | "cloudflare", Record<string, unknown>>;
    readonly comparison: Record<string, unknown>;
    readonly validation: Record<string, unknown>;
}>;
