export declare const FILE_BENCHMARK_VERIFICATION_SCHEMA: "chardb.file-benchmark.verification.v1";

export interface FileBenchmarkVerificationOptions {
    readonly tarball: string;
    readonly evidence: string;
    readonly output: string;
}

export interface FileBenchmarkVerificationReceipt {
    readonly schema: "chardb.file-benchmark.verification.v1";
    readonly ok: true;
    readonly candidate: { readonly sha256: string; readonly bytes: number };
    readonly evidence: {
        readonly schema: "chardb.file-benchmark.pair.v1";
        readonly pairSha256: string;
        readonly files: 4;
    };
    readonly workload: { readonly id: string; readonly version: number };
    readonly profile: Readonly<Record<string, unknown>>;
    readonly execution: Readonly<Record<string, unknown>>;
    readonly runner: Readonly<Record<string, unknown>>;
    readonly local: {
        readonly target: Readonly<Record<string, unknown>>;
        readonly aggregate: readonly {
            readonly upload: Readonly<Record<string, unknown>>;
            readonly attach: Readonly<Record<string, unknown>>;
            readonly download: Readonly<Record<string, unknown>>;
        }[];
    };
    readonly cloudflare: {
        readonly target: Readonly<Record<string, unknown>>;
        readonly aggregate: readonly Readonly<Record<string, unknown>>[];
    };
    readonly comparison: {
        readonly ratioDirection: "cloudflare/local";
        readonly measurementBoundary: {
            readonly measures: readonly ["client-observed-latency", "throughput"];
            readonly billingCountersCollected: false;
            readonly costClaimed: false;
        };
        readonly ratios: readonly Readonly<Record<string, unknown>>[];
    };
    readonly costEvidence: {
        readonly status: "not-collected";
        readonly pricingApplied: false;
        readonly monthlyCostClaimed: false;
        readonly requiredExternalInput: string;
    };
}

export declare function parseFileBenchmarkVerificationArgs(
    argv: readonly string[]
): (FileBenchmarkVerificationOptions & { readonly help: false }) | { readonly help: true };

export declare function verifyFileBenchmark(
    input: Pick<FileBenchmarkVerificationOptions, "tarball" | "evidence">
): Promise<FileBenchmarkVerificationReceipt>;

export declare function writeFileBenchmarkVerification(
    input: FileBenchmarkVerificationOptions
): Promise<FileBenchmarkVerificationReceipt>;
