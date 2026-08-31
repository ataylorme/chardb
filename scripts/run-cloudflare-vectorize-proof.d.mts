export const CLOUDFLARE_VECTORIZE_PROOF_OWNERSHIP_SCHEMA: "chardb.cloudflare-vectorize-proof.ownership.v1";
export const CLOUDFLARE_VECTORIZE_PROOF_PLAN_SCHEMA: "chardb.cloudflare-vectorize-proof.plan.v1";

export function isIndexAbsent(result: { exitCode: number; stdout: string; stderr: string }): boolean;
export function assertMetadataIndex(
    value: unknown,
    label: string
):
    | Readonly<{
          propertyName: "cdb_resource";
          type: "string";
      }>
    | undefined;
export function exactIndexNames(value: unknown, label: string): string[];
export function assertIndexDescriptor(
    value: unknown,
    expectedName: string,
    label: string,
    expected?: { dimensions: number; metric: string }
): Record<string, unknown>;

export interface DisposableVectorizeResourceNames {
    readonly worker: string;
    readonly index: string;
}

export interface PlannedWranglerCommand {
    readonly executable: "wrangler";
    readonly args: readonly string[];
    readonly phase: string;
    readonly destructive: boolean;
}

export interface VectorizeOwnershipLedger extends DisposableVectorizeResourceNames {
    readonly schema: "chardb.cloudflare-vectorize-proof.ownership.v1";
    readonly candidateSha256: string;
    readonly nonce: string;
    readonly runId: string;
    readonly workerAbsentConfirmed: boolean;
    readonly indexAbsentConfirmed: boolean;
    readonly indexCreateIntent: boolean;
    readonly indexCreated: boolean;
    readonly metadataIndexCreateIntent: boolean;
    readonly metadataIndexCreated: boolean;
    readonly workerCreateIntent: boolean;
    readonly workerCreated: boolean;
    readonly workerDeleted: boolean;
    readonly indexDeleted: boolean;
    readonly knownPhysicalIds: readonly string[];
}

export interface WranglerCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface WranglerProfileAccountVerification {
    readonly method: "profile-oauth-token-whoami";
    readonly profile: string;
    readonly accountIdSha256: string;
    readonly matched: true;
}

export interface WranglerInvocation {
    readonly command: PlannedWranglerCommand;
    readonly executable: string;
    readonly cwd: string;
    readonly config: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface VectorizeExecutionDependencies {
    readonly run: (invocation: WranglerInvocation) => Promise<WranglerCommandResult> | WranglerCommandResult;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface VectorizeExecutionInput {
    readonly ledgerPath: string;
    readonly candidateSha256: string;
    readonly accountId: string;
    readonly apiToken?: string;
    readonly profile?: string;
    readonly logPath: string;
    readonly cwd: string;
    readonly config: string;
    readonly secretsFile?: string;
    readonly wranglerExecutable: string;
    readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly pollTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    /** Operational wait for eventually consistent remote vector deletion; it is not a hard service bound. */
    readonly settlementTimeoutMs?: number;
}

export function parseCloudflareVectorizeProofArgs(argv: readonly string[]): {
    readonly help: boolean;
    readonly mode: "proof-plan" | "cleanup-plan";
    readonly tarball: string | undefined;
    readonly output: string | undefined;
    readonly privateDir: string | undefined;
    readonly workersDevSubdomain: string | undefined;
    readonly accountId: string | undefined;
    readonly cleanupLedger: string | undefined;
    readonly confirmed: boolean;
    readonly execute: boolean;
    readonly config: string | undefined;
    readonly cwd: string | undefined;
    readonly secretsFile: string | undefined;
    readonly wranglerExecutable: string;
    readonly profile: string | undefined;
};
export function deriveDisposableVectorizeResourceNames(
    candidateDigest: string,
    nonce: string
): DisposableVectorizeResourceNames;
export function assertVectorizeCleanupOwnership(
    ledger: unknown,
    expectedCandidateDigest: string
): VectorizeOwnershipLedger;
export function planCloudflareVectorizeCommands(input: {
    readonly candidateSha256: string;
    readonly nonce: string;
    readonly secretsFile?: string;
    readonly profile?: string;
}): {
    readonly schema: "chardb.cloudflare-vectorize-proof.plan.v1";
    readonly mutatingCommandsExecuted: false;
    readonly preflight: readonly PlannedWranglerCommand[];
    readonly creation: readonly PlannedWranglerCommand[];
};
export function planVectorizeListCommand(
    index: string,
    cursor?: string,
    phase?: string,
    profile?: string
): PlannedWranglerCommand;
export function planCloudflareVectorizeCleanupCommands(
    ledger: unknown,
    expectedCandidateDigest: string,
    options?: { readonly profile?: string }
): readonly PlannedWranglerCommand[];
export function planCloudflareVectorizeRedeployCommands(input: {
    readonly candidateSha256: string;
    readonly nonce: string;
    readonly secretsFile: string;
    readonly profile?: string;
}): readonly PlannedWranglerCommand[];
export function withWranglerAuthEnvironment<T>(
    baseEnvironment: Readonly<Record<string, string | undefined>>,
    input: {
        readonly accountId: string;
        readonly apiToken?: string;
        readonly profile?: string;
        readonly logPath: string;
    },
    run: (environment: Record<string, string | undefined>) => Promise<T> | T
): Promise<T>;
export function fingerprintVectorizeProofCandidate(file: string): Promise<{
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}>;
export function writeVectorizeOwnershipLedgerBeforeCreation(input: {
    readonly file: string;
    readonly candidateSha256: string;
    readonly nonce: string;
    readonly runId: string;
}): Promise<Record<string, unknown>>;
export function prepareCloudflareVectorizeProofPlan(input: {
    readonly tarball: string;
    readonly output: string;
    readonly privateDir: string;
    readonly nonce?: string;
    readonly runId?: string;
}): Promise<{ readonly publicPlan: Record<string, unknown>; readonly ledgerPath: string }>;
export function prepareCloudflareVectorizeCleanupPlan(input: {
    readonly tarball: string;
    readonly cleanupLedger: string;
}): Promise<Record<string, unknown>>;
export function executeCloudflareVectorizeProvisioning(
    input: VectorizeExecutionInput & { readonly secretsFile: string },
    dependencies: VectorizeExecutionDependencies
): Promise<{
    readonly ledger: VectorizeOwnershipLedger;
    readonly deployment: {
        readonly deploymentId: string;
        readonly versionId: string;
        readonly number: number;
        readonly percentage: 100;
    };
    readonly accountVerification: WranglerProfileAccountVerification | undefined;
}>;
export function executeCloudflareVectorizeCleanup(
    input: VectorizeExecutionInput,
    dependencies: VectorizeExecutionDependencies
): Promise<{
    readonly ledger: VectorizeOwnershipLedger;
    readonly discoveredPhysicalIds: readonly string[];
    readonly finalVectorCount: 0;
    readonly workerAbsent: true;
    readonly indexAbsent: true;
}>;
export function executeCloudflareVectorizeRedeploy(
    input: VectorizeExecutionInput & { readonly secretsFile: string; readonly initialVersionId: string },
    dependencies: VectorizeExecutionDependencies
): Promise<{
    readonly deployment: {
        readonly deploymentId: string;
        readonly versionId: string;
        readonly number: number;
        readonly percentage: 100;
    };
    readonly accountVerification: WranglerProfileAccountVerification | undefined;
    readonly reconciliation: {
        readonly initialVersionId: string;
        readonly redeployVersionId: string;
        readonly redeployTag: string;
        readonly deployExitCode: number;
        readonly acceptedAfterNonzeroExit: boolean;
    };
}>;
export function appendVectorizeOwnedPhysicalIds(
    ledgerPath: string,
    candidateSha256: string,
    ids: readonly string[]
): Promise<VectorizeOwnershipLedger>;
