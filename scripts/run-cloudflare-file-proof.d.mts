export interface CloudflareFileProofOptions {
    readonly help: boolean;
    readonly tarball: string | undefined;
    readonly output: string | undefined;
    readonly privateDir: string | undefined;
    readonly workersDevSubdomain: string | undefined;
    readonly accountId: string | undefined;
    readonly cloudflareApiTokenFile: string | undefined;
    readonly confirmed: boolean;
}

export interface DisposableResourceNames {
    readonly worker: string;
    readonly bucket: string;
}

export declare const CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION: "4.125.0";
export declare const CLOUDFLARE_FILE_PROOF_MINIFLARE_VERSION: "5.20260820.0-alpha";
export declare const CLOUDFLARE_FILE_PROOF_WORKERD_VERSION: "1.20260820.1";
export declare function resolveWranglerExecutable(packageJsonAnchor: string): Promise<string>;
export declare function runFileProofMigrationCommand(
    input: {
        readonly command: string;
        readonly args: readonly string[];
        readonly options?: Record<string, unknown>;
    },
    dependencies?: {
        readonly run?: (
            command: string,
            args: readonly string[],
            options?: Record<string, unknown>
        ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
        readonly wait?: (milliseconds: number) => Promise<unknown>;
        readonly now?: () => number;
    }
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

export declare function parseCloudflareFileProofArgs(argv: readonly string[]): CloudflareFileProofOptions;
export declare function prepareCloudflareFileProofDirectories(
    output: string,
    privateDir: string
): Promise<{ readonly output: string; readonly privateDir: string }>;
export declare function deriveDisposableResourceNames(candidateDigest: string, nonce: string): DisposableResourceNames;
export declare function renderFileProofWrangler(
    source: string,
    input: DisposableResourceNames & { readonly releaseSha256: string; readonly runId: string }
): string;
export declare function renderFileProofPackage(relativeTarball: string): Record<string, unknown>;
export declare function assertCleanupOwnership(
    ledger: unknown,
    expectedCandidateDigest: string,
    expectedAccountId: string
): DisposableResourceNames;
export declare function cleanupCommands(
    ledger: unknown,
    expectedCandidateDigest: string,
    expectedAccountId: string
): readonly (readonly string[])[];
export declare function exactObjectCleanupCommands(
    ledger: unknown,
    expectedCandidateDigest: string,
    expectedAccountId: string
): readonly (readonly string[])[];
export declare function scrubSensitive(value: unknown, secrets: readonly string[]): string;
export declare function assertNoSensitiveEvidence(
    output: string,
    secrets: readonly string[]
): Promise<{ readonly filesScanned: number; readonly valuesScanned: number }>;
export declare function finalizeFileProofEvidence(
    output: string,
    report: Record<string, unknown>,
    secrets: readonly string[],
    benchmarkEvidence?: { readonly pairSha256: string }
): Promise<{ readonly reportPath: string; readonly digest: string; readonly scan: Record<string, number> }>;
export declare function prepareCloudflareFileProofApp(input: {
    readonly app: string;
    readonly tarball: string;
    readonly worker: string;
    readonly bucket: string;
    readonly releaseSha256: string;
    readonly runId: string;
}): Promise<{
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}>;
export declare function remoteAbsenceConfirmed(
    kind: "bucket" | "worker",
    result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
): readonly unknown[];
export interface MigrationShardFailureDiagnostics {
    readonly phase: "migrate-schema-shard";
    readonly migrationId: string;
    readonly shardId: string;
    readonly inventoryHttpStatus: number | null;
    readonly shardStatus: string | null;
    readonly lastError: string | null;
    readonly inventoryError: string | null;
}
export declare function collectMigrationShardFailureDiagnostics(
    input: {
        readonly origin: string;
        readonly adminToken: string;
        readonly migrationId: string;
        readonly shardId: string;
    },
    requestImpl?: (
        origin: string,
        pathname: string,
        init?: RequestInit
    ) => Promise<{ readonly response: Response; readonly body: unknown }>
): Promise<MigrationShardFailureDiagnostics>;
export declare function migrationShardFailureMessage(
    error: unknown,
    diagnostic: MigrationShardFailureDiagnostics
): string;
export declare function activateMigrationShardWithRetry(
    input: {
        readonly origin: string;
        readonly adminToken: string;
        readonly migrationId: string;
        readonly shardId: string;
    },
    injected?: {
        readonly request?: (
            origin: string,
            pathname: string,
            init?: RequestInit
        ) => Promise<{ readonly response: Response; readonly body: unknown }>;
        readonly sleep?: (milliseconds: number) => Promise<unknown>;
    }
): Promise<{
    readonly shard: { readonly shardId: string; readonly status: "active"; readonly lastError?: string | null };
}>;
