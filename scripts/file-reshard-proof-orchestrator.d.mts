export const FILE_RESHARD_PROOF_ORCHESTRATOR_SCHEMA: "chardb.file-vector-reshard-proof.orchestration.v1";
export const FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA: "chardb.file-vector-reshard-proof.ownership.v1";
export function assertFileReshardProofOwnership(
    value: unknown,
    expected: Readonly<{
        candidateSha256: string;
        nonce: string;
        runId: string;
        worker: string;
        bucket: string;
        vectorizeIndex: string;
    }>
): Record<string, unknown>;
export function parseFileReshardProofOrchestratorArgs(argv: readonly string[]): Readonly<Record<string, unknown>>;
export function renderFileReshardLocalWrangler(input: {
    target: string;
    candidateSha256: string;
    configurationSha256: string;
    runId: string;
}): string;
export function provisionFileReshardProofResources(
    input: Record<string, unknown>,
    dependencies?: Record<string, unknown>
): Promise<Readonly<{ deploymentVersion: string }>>;
export function cleanupFileReshardProofResources(
    input: Record<string, unknown>,
    dependencies?: Record<string, unknown>
): Promise<Readonly<Record<string, boolean>>>;
export function runFileReshardBrowserProof(
    input: Record<string, unknown>,
    dependencies?: Record<string, unknown>
): Promise<unknown>;
export function cleanupFileReshardProofWorkloads(
    input: Record<string, unknown>,
    dependencies?: Record<string, unknown>
): Promise<Readonly<{ done: boolean; remaining: number }>>;
export function orchestrateFileReshardCloudflareProof(
    options: Record<string, unknown>,
    dependencies?: Record<string, unknown>
): Promise<Readonly<Record<string, unknown>>>;
