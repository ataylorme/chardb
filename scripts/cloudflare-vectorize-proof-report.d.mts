export interface CloudflareVectorizeProofCandidate {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export interface CloudflareVectorizeProofValidation {
    readonly schema: "chardb.cloudflare-vectorize-proof.validation.v3";
    readonly ok: true;
    readonly candidate: CloudflareVectorizeProofCandidate;
    readonly reportSha256: string;
}

export interface CloudflareVectorizeProofDescriptor {
    readonly binding: "CDB_PROOF_VECTORS";
    readonly resourceDigest: string;
    readonly resourceId: `vr1_${string}`;
    readonly resourceFilter: `r1_${string}`;
    readonly dimensions: 32;
    readonly metric: "cosine";
    readonly namespaceIds: readonly `o1_${string}`[];
}

export interface CloudflareVectorizeDeploymentFingerprint {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly files: readonly {
        readonly path: string;
        readonly bytes: number;
        readonly sha256: string;
    }[];
}

export interface CloudflareVectorizeWorkerVersion {
    readonly deploymentId: string;
    readonly versionId: string;
    readonly number: number;
    readonly percentage: 100;
}

export interface CloudflareVectorizeLifecycleEvidence {
    readonly migration: {
        readonly beforeVersion: 0;
        readonly targetVersion: 1;
        readonly afterVersion: 1;
        readonly beforeEpoch: 1;
        readonly afterEpoch: 2;
        readonly idempotentRetry: true;
    };
    readonly workerRedeployDuringLease: true;
    readonly leaseStateAfterRedeploy: "active-original" | "expired-original" | "active-reclaimed" | "unleased";
}

export interface CloudflareVectorizeFaultEvidence {
    readonly acceptedUpsertReceiptLost: true;
    readonly acceptedDeleteReceiptLost: true;
    readonly sameUpsertIdAndPayloadRetried: true;
    readonly sameDeleteIdsRetried: true;
    readonly durableObjectEvictionClaimed: false;
    readonly inFlightNetworkLossClaimed: false;
}

export interface CloudflareVectorizeBenchmarkTrack {
    readonly label:
        | "local-workerd-fake-vectorize"
        | "local-wrangler-remote-vectorize"
        | "deployed-cloudflare-vectorize";
    readonly runtime: "miniflare/workerd" | "wrangler-dev/workerd" | "cloudflare-workers";
    readonly backend: "persistent-fake-index-do" | "cloudflare-vectorize";
    readonly realVectorize: boolean;
    readonly warmup: import("./cloudflare-vectorize-proof-lifecycle.mjs").VectorProofBenchmarkEvidence["warmup"];
    readonly samples: import("./cloudflare-vectorize-proof-lifecycle.mjs").VectorProofBenchmarkEvidence["samples"];
    readonly exactMatchLatenciesMs: readonly number[];
}

export interface CloudflareVectorizeBenchmarkWorkload {
    readonly id: "ready-vector-filtered-search-v2";
    readonly dimensions: 32;
    readonly metric: "cosine";
    readonly topK: 1;
    readonly requestsPerSample: 1;
}

export const CLOUDFLARE_VECTORIZE_PROOF_REPORT_SCHEMA: "chardb.cloudflare-vectorize-proof.report.v3";
export const CLOUDFLARE_VECTORIZE_PROOF_VALIDATION_SCHEMA: "chardb.cloudflare-vectorize-proof.validation.v3";

export function assertCloudflareVectorizeProofReport<T>(
    report: T,
    expectedCandidate: CloudflareVectorizeProofCandidate
): T;
export function assertCloudflareVectorizeProofSearchEvidence<T>(value: T): T;
export function assertCloudflareVectorizeAdversarialFilteringEvidence<T>(value: T): T;
export function fingerprintCloudflareVectorizeProofCandidate(file: string): Promise<CloudflareVectorizeProofCandidate>;
export function validateCloudflareVectorizeProofEvidence(input: {
    readonly report: string;
    readonly candidate: string;
    readonly checksum?: string;
}): Promise<CloudflareVectorizeProofValidation>;
export function parseCloudflareVectorizeProofReportArgs(argv: readonly string[]): {
    readonly report: string;
    readonly candidate: string;
    readonly checksum: string | undefined;
};
