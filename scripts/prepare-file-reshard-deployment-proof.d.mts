import type { VectorizeDeploymentInput } from "./cloudflare-vectorize-proof-orchestrator.mjs";

export const FILE_RESHARD_PROOF_PREPARATION_SCHEMA: "chardb.file-vector-reshard-proof.preparation.v1";
export const FILE_RESHARD_PROOF_PREPARATION_EVIDENCE_SCHEMA: "chardb.file-vector-reshard-proof.preparation-evidence.v1";
export const FILE_RESHARD_PROOF_DEPLOYMENT_FILES: readonly string[];

export interface FileReshardProofCandidate {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export interface FileReshardProofTarget {
    readonly worker: string;
    readonly bucket: string;
    readonly vectorizeIndex: string;
}

export interface FileReshardProofPreparationEvidence {
    readonly schema: "chardb.file-vector-reshard-proof.preparation-evidence.v1";
    readonly candidate: FileReshardProofCandidate;
    readonly target: FileReshardProofTarget;
    readonly nonce: string;
    readonly runId: string;
    readonly configurationSha256: string;
    readonly fixtureInput: VectorizeDeploymentInput;
    readonly validation: {
        readonly phases: readonly ("package-lock" | "install" | "typecheck" | "wrangler-doctor" | "worker-dry-run")[];
    };
    readonly deploymentInput: VectorizeDeploymentInput;
    readonly mutatingCommandsExecuted: false;
}

export interface FileReshardProofPreparationReceipt {
    readonly schema: "chardb.file-vector-reshard-proof.preparation.v1";
    readonly evidence: FileReshardProofPreparationEvidence;
    readonly privateDir: string;
    readonly app: string;
}

export interface FileReshardProofPreparationOptions {
    readonly package: string;
    readonly privateDir: string;
    readonly app?: string;
    readonly output?: string;
    readonly evidenceOutput?: string;
    readonly fixture?: string;
    readonly nonce?: string;
    readonly runId?: string;
    readonly worker?: string;
    readonly npmExecutable?: string;
    readonly commandTimeoutMs?: number;
}

export interface FileReshardProofPreparationCliOptions {
    readonly help: boolean;
    readonly package: string | undefined;
    readonly privateDir: string | undefined;
    readonly app: string | undefined;
    readonly output: string | undefined;
    readonly evidenceOutput: string | undefined;
    readonly fixture: string | undefined;
    readonly nonce: string | undefined;
    readonly runId: string | undefined;
    readonly npmExecutable: string;
}

export function deriveFileReshardProofTarget(candidateDigest: string, nonce: string): string;

export function renderFileReshardProofWrangler(
    template: string,
    input: {
        worker: string;
        bucket: string;
        index: string;
        releaseSha256: string;
        configurationSha256: string;
        runId: string;
    }
): string;

export function assertFileReshardProofWrangler(
    source: string,
    expected: {
        readonly target: string;
        readonly candidateSha256: string;
        readonly configurationSha256: string;
        readonly runId: string;
    }
): Record<string, unknown>;

export function assertFileReshardProofPreparationEvidence(
    value: unknown,
    expectedCandidate?: FileReshardProofCandidate
): FileReshardProofPreparationEvidence;

export function fingerprintFileReshardProofDeployment(app: string): Promise<VectorizeDeploymentInput>;

export function prepareFileReshardProofApp(
    input: FileReshardProofPreparationOptions,
    dependencies?: {
        readonly validate?: (input: {
            readonly app: string;
            readonly privateDir: string;
            readonly npmExecutable?: string;
            readonly commandTimeoutMs?: number;
        }) => Promise<FileReshardProofPreparationEvidence["validation"]>;
    }
): Promise<{
    readonly preparation: string;
    readonly evidencePath: string;
    readonly evidence: FileReshardProofPreparationEvidence;
    readonly receipt: FileReshardProofPreparationReceipt;
}>;

export function validatePreparedFileReshardProof(input: { package: string; preparation: string }): Promise<{
    readonly app: string;
    readonly candidate: FileReshardProofCandidate;
    readonly receipt: FileReshardProofPreparationEvidence;
    readonly evidence: FileReshardProofPreparationEvidence;
    readonly wrapper: FileReshardProofPreparationReceipt;
}>;

export function parseFileReshardProofPreparationArgs(argv: readonly string[]): FileReshardProofPreparationCliOptions;
