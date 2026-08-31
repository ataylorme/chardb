import type {
    CloudflareVectorizeProofControllerDependencies,
    CloudflareVectorizeProofControllerInput,
    CloudflareVectorizeProofPrecomputedBenchmarkTrack,
} from "./cloudflare-vectorize-proof-controller.mjs";
import type {
    CloudflareVectorizeProofLifecycle,
    CloudflareVectorizeProofLifecycleDependencies,
} from "./cloudflare-vectorize-proof-lifecycle.mjs";
import type {
    VectorizeExecutionDependencies,
    VectorizeExecutionInput,
    VectorizeOwnershipLedger,
    WranglerProfileAccountVerification,
} from "./run-cloudflare-vectorize-proof.mjs";

export const CLOUDFLARE_VECTORIZE_PROOF_PREPARATION_SCHEMA: "chardb.cloudflare-vectorize-proof.preparation.v1";
export const CLOUDFLARE_VECTORIZE_PROOF_EXECUTION_SCHEMA: "chardb.cloudflare-vectorize-proof.execution.v2";
export const CLOUDFLARE_VECTORIZE_PROOF_WRANGLER_VERSION: "4.125.0";

export type CloudflareVectorizeProofExecutionHttpFailureKind =
    | import("./cloudflare-vectorize-proof-lifecycle.mjs").CloudflareVectorizeProofHttpFailureKind
    | "unknown";
export function cloudflareVectorizeProofExecutionHttpFailureKind(
    value: unknown
): CloudflareVectorizeProofExecutionHttpFailureKind;
export type CloudflareVectorizeProofExecutionHttpProtocolReason =
    | import("./cloudflare-vectorize-proof-lifecycle.mjs").CloudflareVectorizeProofHttpProtocolReason
    | "unknown"
    | null;
export function cloudflareVectorizeProofExecutionHttpProtocolReason(
    value: unknown
): CloudflareVectorizeProofExecutionHttpProtocolReason;

export interface VectorizePreparationCommand {
    readonly phase: "package-lock" | "install" | "typecheck" | "wrangler-doctor" | "worker-dry-run";
    readonly executable: string;
    readonly args: readonly string[];
}

export interface VectorizePreparationInvocation extends VectorizePreparationCommand {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
}

export interface VectorizePreparationCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export function awaitCloudflareVectorizeWranglerChild(
    child: {
        readonly stdout: BodyInit | null;
        readonly stderr: BodyInit | null;
        readonly exited: Promise<number>;
        kill(signal?: NodeJS.Signals): unknown;
    },
    options: {
        readonly timeoutMs: number;
        readonly terminationGraceMs?: number;
        readonly killGraceMs?: number;
    }
): Promise<VectorizePreparationCommandResult>;

export interface VectorizeDeploymentInput {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}

export function renderCloudflareVectorizeProofWrangler(
    source: string,
    input: { readonly worker: string; readonly index: string; readonly releaseSha256: string }
): string;
export function renderCloudflareVectorizeProofPackage(relativeTarball?: string): Readonly<Record<string, unknown>>;
export function renderCloudflareVectorizeProofSecrets(input: {
    readonly betterAuthSecret: string;
    readonly adminToken: string;
    readonly runId: string;
}): string;
export function readCloudflareVectorizeProofSecrets(file: string): Promise<{
    readonly betterAuthSecret: string;
    readonly adminToken: string;
    readonly runId: string;
}>;
export function cloudflareVectorizeProofBenchmarkTrack(
    value: unknown,
    expectedLabel: "local-workerd-fake-vectorize" | "local-wrangler-remote-vectorize"
): CloudflareVectorizeProofPrecomputedBenchmarkTrack;
export function assertCloudflareVectorizeProofBenchmark(value: unknown): {
    readonly workloadId: "ready-vector-filtered-search-v2";
    readonly localFake: CloudflareVectorizeProofPrecomputedBenchmarkTrack;
    readonly localRemoteBinding: CloudflareVectorizeProofPrecomputedBenchmarkTrack;
    readonly localRemoteQueryStability: import(
        "./cloudflare-vectorize-proof-controller.mjs"
    ).CloudflareVectorizeProofQueryStabilityEvidence;
    readonly localRemotePostStabilitySampling?: import(
        "./cloudflare-vectorize-proof-lifecycle.mjs"
    ).VectorProofPostStabilitySamplingEvidence;
};
export function planCloudflareVectorizePreparationCommands(input: {
    readonly app: string;
    readonly privateDir: string;
    readonly npmExecutable?: string;
}): readonly VectorizePreparationCommand[];
export function assertCloudflareVectorizeProofPackageLock(value: unknown): Record<string, unknown>;
export function fingerprintCloudflareVectorizeDeployment(
    app: string,
    files?: readonly string[]
): Promise<VectorizeDeploymentInput>;
export function assertNoCloudflareVectorizeProofSecrets(
    files: readonly string[],
    secrets: readonly string[]
): Promise<{ readonly filesScanned: number; readonly valuesScanned: number }>;
export function assertCloudflareVectorizeProofCandidateBridge(app: string): Promise<{
    readonly runtimeExports: readonly string[];
    readonly typeExports: readonly string[];
}>;
export function prepareCloudflareVectorizeProofApp(input: {
    readonly app: string;
    readonly privateDir: string;
    readonly fixture?: string;
    readonly tarball: string;
    readonly candidateSha256: string;
    readonly worker: string;
    readonly index: string;
}): Promise<{
    readonly app: string;
    readonly candidate: { readonly algorithm: "sha256"; readonly digest: string; readonly bytes: number };
}>;
export function validateCloudflareVectorizeProofApp(
    input: {
        readonly app: string;
        readonly privateDir: string;
        readonly npmExecutable?: string;
        readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
        readonly commandTimeoutMs?: number;
        readonly secrets?: readonly string[];
    },
    dependencies?: {
        readonly run?: (
            invocation: VectorizePreparationInvocation
        ) => Promise<VectorizePreparationCommandResult> | VectorizePreparationCommandResult;
        readonly assertCandidateBridge?: (app: string) => Promise<unknown> | unknown;
    }
): Promise<{ readonly phases: readonly VectorizePreparationCommand["phase"][] }>;
export function parseCloudflareVectorizeOrchestratorArgs(argv: readonly string[]): {
    readonly help: boolean;
    readonly tarball: string | undefined;
    readonly output: string | undefined;
    readonly privateDir: string | undefined;
    readonly workersDevSubdomain: string | undefined;
    readonly npmExecutable: string;
    readonly accountId: string | undefined;
    readonly profile: string;
    readonly execute: boolean;
    readonly confirmed: boolean;
};

export interface PreparedCloudflareVectorizeProof {
    readonly publicPlan: Record<string, unknown>;
    readonly candidate: { readonly algorithm: "sha256"; readonly digest: string; readonly bytes: number };
    readonly target: { readonly worker: string; readonly index: string };
    readonly deploymentInput: VectorizeDeploymentInput;
    readonly preparationPath: string;
    readonly preparationSha256: string;
    readonly checksumPath: string;
    readonly app: string;
    readonly config: string;
    readonly secretsFile: string;
    readonly ledgerPath: string;
    readonly origin: string;
}

export function prepareCloudflareVectorizeProof(
    input: {
        readonly tarball: string;
        readonly output: string;
        readonly privateDir: string;
        readonly workersDevSubdomain: string;
        readonly npmExecutable?: string;
        readonly fixture?: string;
        readonly nonce?: string;
        readonly runId?: string;
        readonly betterAuthSecret?: string;
        readonly adminToken?: string;
        readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
        readonly commandTimeoutMs?: number;
    },
    dependencies?: {
        readonly randomBytes?: (size: number) => Uint8Array;
        readonly run?: (
            invocation: VectorizePreparationInvocation
        ) => Promise<VectorizePreparationCommandResult> | VectorizePreparationCommandResult;
        readonly assertCandidateBridge?: (app: string) => Promise<unknown> | unknown;
    }
): Promise<PreparedCloudflareVectorizeProof>;

export function executePreparedCloudflareVectorizeProof(
    input: {
        readonly prepared: PreparedCloudflareVectorizeProof;
        readonly accountId: string;
        readonly profile?: string;
        readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
        readonly wranglerPollTimeoutMs?: number;
        readonly wranglerPollIntervalMs?: number;
        readonly lifecycleTimeoutMs?: number;
        readonly lifecycleIntervalMs?: number;
        readonly localRemoteStartupTimeoutMs?: number;
        readonly localRemoteRequestTimeoutMs?: number;
    },
    dependencies?: {
        readonly runWrangler?: VectorizeExecutionDependencies["run"];
        readonly now?: () => number;
        readonly sleep?: (milliseconds: number) => Promise<void>;
        readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        readonly lifecycle?: CloudflareVectorizeProofLifecycle;
        readonly openLiveVectorSubscription?: CloudflareVectorizeProofLifecycleDependencies["openLiveVectorSubscription"];
        readonly createController?: (dependencies: CloudflareVectorizeProofControllerDependencies) => {
            readonly run: (input: CloudflareVectorizeProofControllerInput) => Promise<Record<string, unknown>>;
        };
        readonly provision?: (
            input: VectorizeExecutionInput & { readonly secretsFile: string },
            dependencies: VectorizeExecutionDependencies
        ) => Promise<{
            readonly ledger: VectorizeOwnershipLedger;
            readonly deployment: {
                readonly deploymentId: string;
                readonly versionId: string;
                readonly number: number;
                readonly percentage: 100;
            };
            readonly accountVerification: WranglerProfileAccountVerification | undefined;
        }>;
        readonly cleanup?: (
            input: VectorizeExecutionInput,
            dependencies: VectorizeExecutionDependencies
        ) => Promise<{
            readonly ledger: VectorizeOwnershipLedger;
            readonly discoveredPhysicalIds: readonly string[];
            readonly finalVectorCount: 0;
            readonly workerAbsent: true;
            readonly indexAbsent: true;
        }>;
        readonly redeploy?: (
            input: VectorizeExecutionInput & { readonly secretsFile: string; readonly initialVersionId: string },
            dependencies: VectorizeExecutionDependencies
        ) => Promise<{
            readonly deployment: {
                readonly deploymentId: string;
                readonly versionId: string;
                readonly number: number;
                readonly percentage: 100;
            };
            readonly accountVerification: WranglerProfileAccountVerification | undefined;
        }>;
        readonly appendOwnedIds?: (
            ledgerPath: string,
            candidateSha256: string,
            ids: readonly string[]
        ) => Promise<VectorizeOwnershipLedger>;
        readonly produceLocalFakeBenchmark?: () => Promise<unknown>;
        readonly produceLocalRemoteBenchmark?: (
            input: {
                readonly prepared: PreparedCloudflareVectorizeProof;
                readonly persistenceDir: string;
                readonly runtimeDir: string;
                readonly wrangler: string;
                readonly profile: string;
                readonly accountId: string;
                readonly migrationId: string;
                readonly owningName: string;
                readonly owningSlug: string;
                readonly isolatedName: string;
                readonly isolatedSlug: string;
                readonly mutationRunId: string;
                readonly documentId: string;
                readonly text: string;
                readonly values: readonly number[];
                readonly timeoutMs?: number;
                readonly intervalMs?: number;
                readonly startupTimeoutMs?: number;
                readonly requestTimeoutMs?: number;
                readonly baseEnvironment: Readonly<Record<string, string | undefined>>;
            },
            dependencies: {
                readonly appendOwnedIds: (input: {
                    readonly vectorId: string;
                    readonly action: "create" | "delete";
                    readonly nextVersion: number;
                    readonly physicalIds: readonly string[];
                }) => Promise<void>;
                readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
                readonly now?: () => number;
                readonly sleep?: (milliseconds: number) => Promise<void>;
                readonly checkpoint?: (value: string) => Promise<void>;
            }
        ) => Promise<{
            readonly track: CloudflareVectorizeProofPrecomputedBenchmarkTrack;
            readonly evidence: Readonly<Record<string, unknown>>;
        }>;
    }
): Promise<{
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly evidencePath: string;
    readonly checksumPath: string;
    readonly reportPath: string;
    readonly reportChecksumPath: string;
    readonly reportSha256: string;
}>;
