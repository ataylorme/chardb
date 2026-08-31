import type { FileReshardDeploymentPair, FileReshardDeploymentSample } from "./file-reshard-deployment-proof.mjs";

export const FILE_RESHARD_VECTOR_DIMENSIONS: 32;

export interface FileReshardDeploymentProofOptions extends Record<string, unknown> {
    help: boolean;
    confirmed: boolean;
    package?: string;
    preparation?: string;
    output?: string;
    wrangler?: string;
    localUrl?: string;
    deployedUrl?: string;
    localTokenFile?: string;
    deployedTokenFile?: string;
    /** Optional override. When omitted, Wrangler uses its stored OAuth configuration. */
    cloudflareApiTokenFile?: string;
    cloudflareAccountId?: string;
    worker?: string;
    bucket?: string;
    vectorizeIndex?: string;
    deploymentVersion?: string;
    configurationSha256?: string;
    runId?: string;
    profileName: string;
}

export function parseFileReshardDeploymentProofArgs(argv: readonly string[]): FileReshardDeploymentProofOptions;
export function wranglerDeploymentInspectionCommands(
    worker: string,
    bucket: string,
    index: string
): readonly (readonly string[])[];
export function wranglerDisposableDeploymentCommands(input: {
    worker: string;
    bucket: string;
    index: string;
    config: string;
    secretsFile: string;
    tag: string;
}): readonly (readonly string[])[];
export function wranglerDisposableCleanupCommands(
    worker: string,
    bucket: string,
    index: string
): readonly (readonly string[])[];
export interface WranglerDeploymentCommandOptions {
    cwd: string;
    env: Record<string, string | undefined>;
}
export interface DisposableDeploymentInspectionInput {
    wrangler: string;
    app: string;
    worker: string;
    bucket: string;
    index: string;
    version: string;
    accountId: string;
    /** Optional explicit token injected only into the Wrangler child environment. */
    apiToken?: string;
    runCommand?: (
        command: string,
        args: readonly string[],
        options: WranglerDeploymentCommandOptions
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
export function inspectDisposableDeployment(input: DisposableDeploymentInspectionInput): Promise<{
    version: string;
    percentage: 100;
    bucket: string;
    index: string;
}>;
export function fileReshardDeploymentRunKey(runId: string, sequence: number): string;
export function requestFileReshardDeploymentSample(
    input: Record<string, unknown>
): Promise<FileReshardDeploymentSample>;
export function runFileReshardDeploymentProof(input: Record<string, unknown>): Promise<FileReshardDeploymentPair>;
