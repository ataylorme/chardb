import type {
    CloudflareVectorizeProofLifecycle,
    VectorProofState,
    VectorProofWorkerVersion,
} from "./cloudflare-vectorize-proof-lifecycle.mjs";

export type CloudflareVectorizeProofControllerWorkerVersion = VectorProofWorkerVersion & {
    readonly percentage: 100;
};

export const CLOUDFLARE_VECTORIZE_PROOF_CONTROLLER_CHECKPOINTS: readonly [
    "health",
    "migration",
    "organization-setup",
    "descriptor",
    "create-intent",
    "create-mutation",
    "create-readiness",
    "create-isolation",
    "replace-intent",
    "replace-fault-arm",
    "replace-mutation",
    "replace-held-claim",
    "redeploy",
    "fault-release",
    "replace-response-loss",
    "replace-readiness",
    "replace-isolation",
    "adversary-settlement",
    "adversary-apply",
    "adversary-filter",
    "adversary-restore",
    "adversary-policy",
    "live-create-intent",
    "live-create-mutation",
    "live-create-readiness",
    "live-subscribe",
    "live-reconnect",
    "live-replace-intent",
    "live-replace-fault-arm",
    "live-replace-mutation",
    "live-replace-pending",
    "live-replace-release",
    "live-replace-readiness",
    "live-replace-current",
    "live-cleanup-settlement",
    "live-delete-intent",
    "live-delete-mutation",
    "live-delete-readiness",
    "deployed-benchmark",
    "delete-intent",
    "delete-fault-arm",
    "delete-mutation",
    "delete-alarm-wait",
    "delete-response-loss",
    "delete-readiness",
    "deployed-lifecycle",
    "complete",
];
export type CloudflareVectorizeProofControllerCheckpoint =
    (typeof CLOUDFLARE_VECTORIZE_PROOF_CONTROLLER_CHECKPOINTS)[number];

export interface CloudflareVectorizeProofObservationTimeoutEvidence {
    readonly label: string;
    readonly timeoutMs: number;
    readonly elapsedMs: number;
    readonly latestState: VectorProofState | null;
}

export function assertCloudflareVectorizeProofObservationTimeoutEvidence(
    value: unknown
): CloudflareVectorizeProofObservationTimeoutEvidence;

export class CloudflareVectorizeProofObservationTimeoutError extends Error {
    readonly evidence: CloudflareVectorizeProofObservationTimeoutEvidence;
    constructor(label: string, timeoutMs: number, elapsedMs: number, latestState: VectorProofState | null);
}

export interface CloudflareVectorizeProofCandidateClassificationEvidence {
    readonly candidateCount: number;
    readonly stalePresent: boolean;
    readonly currentPresent: boolean;
    readonly otherCandidateCount: number;
    readonly queryIdentityMatch: boolean;
}

export function assertCloudflareVectorizeProofCandidateClassificationEvidence(
    value: unknown
): CloudflareVectorizeProofCandidateClassificationEvidence;

export class CloudflareVectorizeProofCandidateClassificationError extends Error {
    readonly evidence: CloudflareVectorizeProofCandidateClassificationEvidence;
    constructor(message: string, classification: CloudflareVectorizeProofCandidateClassificationEvidence);
}

export interface CloudflareVectorizeProofControllerDependencies {
    readonly lifecycle: Pick<
        CloudflareVectorizeProofLifecycle,
        | "health"
        | "requestJson"
        | "migrateV0ToV1"
        | "setupOrganizations"
        | "vectorIntent"
        | "mutateVector"
        | "pollReady"
        | "proveNamespaceIsolation"
        | "mutateVectorAdversary"
        | "queryVectorAdversary"
        | "vectorSearchAudit"
        | "search"
        | "openLiveVectorSubscription"
        | "armFault"
        | "vectorState"
        | "pollDeleted"
        | "measure"
    >;
    readonly appendOwnedIds: (input: {
        readonly vectorId: string;
        readonly action: "create" | "replace" | "delete";
        readonly nextVersion: number;
        readonly physicalIds: readonly string[];
    }) => Promise<void>;
    readonly redeploy: (input: {
        readonly state: VectorProofState;
        readonly claim: {
            readonly vectorId: string;
            readonly organizationId: string;
            readonly resourceId: string;
            readonly rowPk: string;
            readonly deliveredVersion: number;
            readonly claimTokenSha256: string;
            readonly targetVersion: number;
            readonly operation: "upsert";
            readonly phase: "submit";
            readonly attempts: number;
            readonly leasedUntil: number;
            readonly gateDeadline: number;
            readonly physicalIds: readonly string[];
            readonly payloadSha256: string;
        };
        readonly initialVersion: CloudflareVectorizeProofControllerWorkerVersion;
    }) => Promise<CloudflareVectorizeProofControllerWorkerVersion>;
    readonly releaseFault: (input: {
        readonly state: VectorProofState;
        readonly claim: {
            readonly vectorId: string;
            readonly gateDeadline: number;
            readonly physicalIds: readonly string[];
            readonly payloadSha256: string;
        };
    }) => Promise<{ readonly released: true; readonly gateDeadline: number }>;
    readonly recordDeployedLifecycle?: (evidence: Readonly<Record<string, unknown>>) => Promise<void>;
    readonly loadComparisonBenchmark?: () => Promise<{
        readonly localRemoteBinding: CloudflareVectorizeProofPrecomputedBenchmarkTrack;
        readonly localRemoteQueryStability: CloudflareVectorizeProofQueryStabilityEvidence;
        readonly localRemotePostStabilitySampling?: import(
            "./cloudflare-vectorize-proof-lifecycle.mjs"
        ).VectorProofPostStabilitySamplingEvidence;
    }>;
    readonly checkpoint?: (value: CloudflareVectorizeProofControllerCheckpoint) => Promise<void>;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly publicFilterStabilityWindowMs?: number;
}

export interface CloudflareVectorizeProofControllerInput {
    readonly origin: string | URL;
    readonly admin: { readonly token: string; readonly runId: string };
    readonly releaseSha256: string;
    readonly migrationId: string;
    readonly owningName: string;
    readonly owningSlug: string;
    readonly isolatedName: string;
    readonly isolatedSlug: string;
    readonly mutationRunId: string;
    readonly documentId: string;
    readonly initialText: string;
    readonly initialValues: readonly number[];
    readonly replacementText: string;
    readonly replacementValues: readonly number[];
    readonly liveDocumentId: string;
    readonly liveClientId: string;
    readonly liveInitialText: string;
    readonly liveInitialValues: readonly number[];
    readonly liveReplacementText: string;
    readonly liveReplacementValues: readonly number[];
    readonly liveQueryValues: readonly number[];
    readonly initialVersion: CloudflareVectorizeProofControllerWorkerVersion;
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly secrets?: readonly string[];
    readonly benchmark: {
        readonly workloadId: "ready-vector-filtered-search-v2";
        readonly localFake: CloudflareVectorizeProofPrecomputedBenchmarkTrack;
        readonly localRemoteBinding?: CloudflareVectorizeProofPrecomputedBenchmarkTrack;
        readonly localRemoteQueryStability?: CloudflareVectorizeProofQueryStabilityEvidence;
        readonly localRemotePostStabilitySampling?: import(
            "./cloudflare-vectorize-proof-lifecycle.mjs"
        ).VectorProofPostStabilitySamplingEvidence;
    };
}

export interface CloudflareVectorizeProofQueryStabilityEvidence {
    readonly queryStabilityWindowMs: 10_000;
    readonly queryStabilityIntervalMs: 1_000;
    readonly queryStabilityObservedMs: number;
    readonly queryStabilityExactMatchCount: number;
    readonly queryStabilityResetCount: number;
    readonly queryStabilityNonExactCount: number;
    readonly hardBoundClaimed: false;
}

export interface CloudflareVectorizeProofPrecomputedBenchmarkTrack {
    readonly workloadId: "ready-vector-filtered-search-v2";
    readonly warmupExcluded: true;
    readonly warmupCount: 1;
    readonly warmup?: import("./cloudflare-vectorize-proof-lifecycle.mjs").VectorProofBenchmarkEvidence["warmup"];
    readonly samples?: import("./cloudflare-vectorize-proof-lifecycle.mjs").VectorProofBenchmarkEvidence["samples"];
    readonly exactMatchLatenciesMs?: readonly number[];
    /** @deprecated accepted only to normalize v1 in-memory fixtures. */
    readonly samplesMs?: readonly [number, number, number, number, number];
}

export interface CloudflareVectorizeProofController {
    readonly run: (input: CloudflareVectorizeProofControllerInput) => Promise<Record<string, unknown>>;
}

export function createCloudflareVectorizeProofController(
    dependencies: CloudflareVectorizeProofControllerDependencies
): CloudflareVectorizeProofController;
