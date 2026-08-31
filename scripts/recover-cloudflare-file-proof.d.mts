export interface CloudflareFileProofRecoveryOptions {
    readonly help: boolean;
    readonly tarball: string | undefined;
    readonly ledger: string | undefined;
    readonly workersDevSubdomain: string | undefined;
    readonly accountId: string | undefined;
    readonly cloudflareApiTokenFile: string | undefined;
    readonly confirmed: boolean;
}

export interface CloudflareFileProofRecoveryInput {
    readonly tarball: string;
    readonly ledger: string;
    readonly workersDevSubdomain: string;
    readonly accountId: string;
    readonly cloudflareApiTokenFile: string | undefined;
    readonly confirmed: boolean;
}

export interface CloudflareFileProofRecoveryResult {
    readonly schema: "chardb.cloudflare-r2-proof.recovery.v1";
    readonly ok: true;
    readonly candidate: { readonly algorithm: "sha256"; readonly digest: string; readonly bytes: number };
    readonly account: { readonly accountIdSha256: string; readonly matched: true };
    readonly target: { readonly worker: string; readonly bucket: string };
    readonly reconciliation: {
        readonly workerRecovered: boolean;
        readonly discoveredObjects: number;
        readonly purgedObjects: number;
    };
    readonly absence: { readonly worker: true; readonly bucket: true };
    readonly wranglerVersion: string;
}

interface CommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export declare function parseCloudflareFileProofRecoveryArgs(
    argv: readonly string[]
): CloudflareFileProofRecoveryOptions;
export declare function assertRecoveryAccount(
    value: unknown,
    expectedAccountId: string
): { readonly accountIdSha256: string; readonly matched: true };
export declare function parseRecoverySecrets(
    source: string,
    expectedRunId: string
): {
    readonly adminToken: string;
    readonly runId: string;
    readonly secretValues: readonly string[];
};
export declare function recoverCloudflareFileProof(
    input: CloudflareFileProofRecoveryInput,
    dependencies?: {
        readonly runWrangler?: (
            args: string[],
            options: {
                readonly cwd: string;
                readonly environment: Record<string, string | undefined>;
                readonly label: string;
                readonly secrets: readonly string[];
            }
        ) => Promise<CommandResult>;
        readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        readonly sleep?: (milliseconds: number) => Promise<unknown>;
    }
): Promise<CloudflareFileProofRecoveryResult>;
export declare function cloudflareFileProofRecoveryUsage(): string;
export declare function runCloudflareFileProofRecoveryCli(
    argv: readonly string[],
    io?: Pick<typeof process, "stdout" | "stderr">,
    dependencies?: Parameters<typeof recoverCloudflareFileProof>[1]
): Promise<0 | 1>;
