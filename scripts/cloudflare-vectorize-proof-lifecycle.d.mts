import type { CloudflareVectorizeProofLiveSubscription } from "./cloudflare-vectorize-proof-live.mjs";

export const CLOUDFLARE_VECTORIZE_PROOF_HTTP_MAX_BYTES: number;
export const CLOUDFLARE_VECTORIZE_PROOF_HTTP_TIMEOUT_MS: number;
export const CLOUDFLARE_VECTORIZE_PROOF_POLL_INTERVAL_MS: number;
export const CLOUDFLARE_VECTORIZE_PROOF_HTTP_PROTOCOL_REASONS: readonly [
    "invalid_response",
    "unexpected_redirect",
    "invalid_content_length",
    "empty_body",
    "body_too_large",
    "invalid_utf8",
    "invalid_json",
];

export type CloudflareVectorizeProofHttpFailureKind = "timeout" | "network" | "http" | "protocol";
export type CloudflareVectorizeProofHttpProtocolReason =
    (typeof CLOUDFLARE_VECTORIZE_PROOF_HTTP_PROTOCOL_REASONS)[number];

export class CloudflareVectorizeProofHttpError extends Error {
    readonly status: number | null;
    readonly code: string | null;
    readonly kind: CloudflareVectorizeProofHttpFailureKind;
    readonly protocolReason: CloudflareVectorizeProofHttpProtocolReason | null;
    constructor(
        message: string,
        status?: number | null,
        code?: string | null,
        kind?: CloudflareVectorizeProofHttpFailureKind,
        protocolReason?: CloudflareVectorizeProofHttpProtocolReason | null
    );
}

export function isCloudflareVectorizeProofRetryableStateRead(error: unknown): boolean;

export interface CloudflareVectorizeProofSearchSettlementEvidence {
    readonly checkpoint: "owning-filtered-search" | "isolated-filtered-search";
    readonly timeoutMs: number;
    readonly elapsedMs: number;
    readonly queryVisibilityAttempts: number;
    readonly queryStabilityWindowMs: number;
    readonly queryStabilityObservedMs: number;
    readonly queryStabilityExactMatchCount: number;
    readonly queryStabilityResetCount: number;
    readonly queryStabilityNonExactCount: number;
    readonly transientHttpFailureCount: number;
    readonly transientHttpFailureCounts: readonly {
        readonly status: number | null;
        readonly code: string | null;
        readonly count: number;
    }[];
    readonly transientHttpFailureOverflowCount: number;
    readonly hardBoundClaimed: false;
}

export interface CloudflareVectorizeProofLifecycleSettlementEvidence {
    readonly checkpoint: "vector-ready" | "vector-deleted";
    readonly outcome: "timed_out" | "failed_unproven";
    readonly timeoutMs: number;
    readonly elapsedMs: number;
    readonly pollAttempts: number;
    readonly phaseProgression: readonly ("submit" | "verify")[];
    readonly phaseProgressionOverflowCount: number;
    readonly latestState: VectorProofState | null;
    readonly transientHttpFailureCount: number;
    readonly transientHttpFailureCounts: readonly {
        readonly status: number | null;
        readonly code: string | null;
        readonly count: number;
    }[];
    readonly transientHttpFailureOverflowCount: number;
    readonly hardBoundClaimed: false;
}

export type CloudflareVectorizeProofSettlementEvidence =
    | CloudflareVectorizeProofSearchSettlementEvidence
    | CloudflareVectorizeProofLifecycleSettlementEvidence;

export function assertCloudflareVectorizeProofSettlementEvidence(
    value: unknown
): CloudflareVectorizeProofSettlementEvidence;

export class CloudflareVectorizeProofSettlementError extends Error {
    readonly evidence: CloudflareVectorizeProofSettlementEvidence;
    constructor(message: string, evidence: CloudflareVectorizeProofSettlementEvidence);
}

export interface VectorProofPrincipal {
    readonly cookie: string;
    readonly token: string;
    readonly userId: string;
}

export interface VectorProofAdmin {
    readonly token: string;
    readonly runId: string;
}

export interface VectorProofWorkerVersion {
    readonly deploymentId: string;
    readonly versionId: string;
    readonly number: number;
    readonly percentage?: number;
}

export interface VectorProofState {
    readonly vectorId: string;
    readonly observedAt: number;
    readonly scheduledAlarmAt: number | null;
    readonly head: null | {
        readonly organizationId: string;
        readonly resourceId: string;
        readonly rowPk: string;
        readonly version: number;
        readonly deliveredVersion: number;
        readonly state: "pending" | "ready" | "deleting";
    };
    readonly outbox: null | {
        readonly targetVersion: number;
        readonly operation: "upsert" | "delete";
        readonly phase: "submit" | "verify";
        readonly mutationIdSha256: string | null;
        readonly acceptedAt: number | null;
        readonly attempts: number;
        readonly nextAttemptAt: number;
        readonly leased: boolean;
        readonly claimTokenSha256: string | null;
        readonly leasedUntil: number | null;
        readonly terminalFailure: boolean;
        readonly lastErrorClassification: "delete_absence_unproven" | "other" | null;
        readonly lastErrorSha256: string | null;
    };
    readonly attempts: readonly {
        readonly physicalVersion: number;
        readonly firstSentAt: number;
        readonly settleAfter: number;
        readonly visibilityConfirmed: boolean;
        readonly responseAmbiguous: boolean;
        readonly deleteConfirmed: boolean;
    }[];
    readonly acceptances: readonly {
        readonly operation: "upsert" | "delete";
        readonly physicalId: string;
        readonly payloadSha256: string;
        readonly mutationIdSha256: string;
        readonly acceptedAt: number;
    }[];
    readonly fault: null | {
        readonly mode: "upsert_accept_then_throw" | "delete_accept_then_throw";
        readonly armed: boolean;
        readonly inFlight: boolean;
        readonly fired: boolean;
        readonly firstPhysicalIds: readonly string[];
        readonly firstPayloadSha256: string | null;
        readonly returnedMutationIdSha256: string | null;
        readonly acceptedBeforeThrow: boolean;
        readonly retryCount: number;
        readonly retryIdsMatched: boolean | null;
        readonly retryPayloadMatched: boolean | null;
        readonly retryComplete: boolean;
        readonly gateOpen: boolean;
        readonly gateDeadline: number | null;
        readonly updatedAt: number;
    };
}

export function assertCloudflareVectorizeProofState(value: unknown): VectorProofState;

export interface CloudflareVectorizeProofLifecycleDependencies {
    readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
    readonly clearTimeout?: (handle: unknown) => void;
    readonly requestTimeoutMs?: number;
    readonly maxResponseBytes?: number;
    readonly openLiveVectorSubscription?: (
        input: Readonly<Record<string, unknown>>
    ) => Promise<CloudflareVectorizeProofLiveSubscription>;
}

interface OriginInput {
    readonly origin: string | URL;
}

interface ProofInput extends OriginInput {
    readonly admin: VectorProofAdmin;
}

interface VectorIdentityInput extends ProofInput {
    readonly organizationId: string;
    readonly vectorId: string;
}

export interface CloudflareVectorizeProofLifecycle {
    readonly requestJson: (
        input: OriginInput & {
            readonly path: string;
            readonly method?: string;
            readonly headers?: HeadersInit;
            readonly body?: unknown;
            readonly label?: string;
        }
    ) => Promise<{ readonly status: number; readonly headers: Headers; readonly body: unknown }>;
    readonly health: (input: OriginInput & { readonly releaseSha256?: string }) => Promise<{
        readonly ok: true;
        readonly schemaVersion: 1;
        readonly releaseSha256: string;
        readonly vectorResources: 1;
        readonly proofConfigured: true;
    }>;
    readonly signInAnonymous: (input: OriginInput) => Promise<VectorProofPrincipal>;
    readonly refreshPrincipal: (input: OriginInput & { readonly cookie: string }) => Promise<VectorProofPrincipal>;
    readonly createOrganization: (
        input: OriginInput & {
            readonly principal: VectorProofPrincipal;
            readonly name: string;
            readonly slug: string;
        }
    ) => Promise<{ readonly organizationId: string; readonly cookie: string }>;
    readonly setActiveOrganization: (
        input: OriginInput & {
            readonly principal: VectorProofPrincipal;
            readonly organizationId: string;
        }
    ) => Promise<VectorProofPrincipal>;
    readonly setupOrganizations: (
        input: ProofInput & {
            readonly owningName: string;
            readonly owningSlug: string;
            readonly isolatedName: string;
            readonly isolatedSlug: string;
        }
    ) => Promise<{
        readonly owner: VectorProofPrincipal;
        readonly member: VectorProofPrincipal;
        readonly owningMember: VectorProofPrincipal;
        readonly owningOrganizationId: string;
        readonly isolatedOrganizationId: string;
    }>;
    readonly migrateV0ToV1: (
        input: OriginInput & {
            readonly adminToken: string;
            readonly migrationId: string;
            readonly timeoutMs?: number;
            readonly intervalMs?: number;
        }
    ) => Promise<{
        readonly beforeVersion: number;
        readonly beforeEpoch: number;
        readonly targetVersion: 1;
        readonly afterVersion: 1;
        readonly afterEpoch: 2;
        readonly idempotentRetry: boolean;
    }>;
    readonly mutateVector: (
        input: OriginInput & {
            readonly principal: VectorProofPrincipal;
            readonly action: "create" | "replace" | "delete";
            readonly id: string;
            readonly organizationId: string;
            readonly mutId: string;
            readonly text?: string;
            readonly values?: readonly number[];
        }
    ) => Promise<{ readonly id: string; readonly vectorId: string } | { readonly id: string }>;
    readonly listVectorDocuments: (
        input: OriginInput & {
            readonly principal: VectorProofPrincipal;
            readonly organizationId: string;
            readonly limit?: number;
        }
    ) => Promise<readonly { readonly id: string; readonly body: string }[]>;
    readonly search: (
        input: OriginInput & {
            readonly principal: VectorProofPrincipal;
            readonly organizationId: string;
            readonly values: readonly number[];
            readonly limit?: number;
        }
    ) => Promise<readonly { readonly rowPk: string; readonly score: number }[]>;
    readonly openLiveVectorSubscription: (
        input: OriginInput & {
            readonly principal: VectorProofPrincipal;
            readonly organizationId: string;
            readonly expectedRowPk: string;
            readonly expectedPendingFallbackRowPk: string;
            readonly values: readonly number[];
            readonly clientId: string;
            readonly timeoutMs: number;
        }
    ) => Promise<CloudflareVectorizeProofLiveSubscription>;
    readonly mutateVectorAdversary: (
        input: ProofInput & {
            readonly action: "apply" | "restore";
            readonly organizationId: string;
            readonly id: string;
            readonly staleValues: readonly number[];
            readonly currentValues: readonly number[];
        }
    ) => Promise<{
        readonly action: "apply" | "restore";
        readonly vectorId: string;
        readonly stalePhysicalId: string;
        readonly currentPhysicalId: string;
        readonly upsertMutationIdSha256: string;
        readonly deleteMutationIdSha256: string;
    }>;
    readonly queryVectorAdversary: (
        input: ProofInput & {
            readonly organizationId: string;
            readonly id: string;
            readonly values: readonly number[];
        }
    ) => Promise<{
        readonly action: "inspect";
        readonly vectorId: string;
        readonly stalePhysicalId: string;
        readonly currentPhysicalId: string;
        readonly upsertMutationIdSha256: null;
        readonly deleteMutationIdSha256: null;
        readonly matches: readonly { readonly physicalId: string; readonly score: number }[];
    }>;
    readonly vectorPresence: (
        input: ProofInput & { readonly organizationId: string; readonly vectorId: string }
    ) => Promise<{
        readonly vectorId: string;
        readonly records: readonly { readonly physicalId: string; readonly present: boolean }[];
    }>;
    readonly proveRecovery: (
        input: ProofInput & {
            readonly organizationName: string;
            readonly organizationSlug: string;
            readonly mutationRunId: string;
            readonly documentId: string;
            readonly initialText: string;
            readonly initialValues: readonly number[];
            readonly replacementText: string;
            readonly replacementValues: readonly number[];
            readonly timeoutMs: number;
            readonly intervalMs?: number;
            readonly recordPhysicalIds: (ids: readonly string[]) => Promise<void> | void;
        }
    ) => Promise<{
        readonly recoveryPointDigest: string;
        readonly vectorId: string;
        readonly physicalIds: readonly [string, string];
        readonly authoritativeVersion: 1;
        readonly providerReset: { readonly files: number; readonly vectors: number };
        readonly reconciliation: { readonly filesRehydrated: number; readonly vectorsRequeued: number };
        readonly providerPresence: {
            readonly atPoint: readonly [true, false];
            readonly postPoint: readonly [false, true];
            readonly afterScrub: readonly [false, false];
            readonly afterRequeue: readonly [true, false];
        };
        readonly restoredRow: { readonly id: string; readonly body: string };
    }>;
    readonly vectorSearchAudit: (
        input: ProofInput & {
            readonly action: "cursor" | "observe";
            readonly organizationId: string;
            readonly id: string;
            readonly values: readonly number[];
            readonly afterSequence?: number;
        }
    ) => Promise<{
        readonly sequence: number;
        readonly querySha256: string | null;
        readonly candidateSetSha256: string | null;
        readonly candidateCount: number;
        readonly stalePresent: boolean;
        readonly currentPresent: boolean;
        readonly otherCandidateCount: number;
    }>;
    readonly armFault: (
        input: ProofInput & {
            readonly organizationId: string;
            readonly vectorId: string;
            readonly mode: "upsert_accept_then_throw" | "delete_accept_then_throw";
        }
    ) => Promise<unknown>;
    readonly vectorState: (input: VectorIdentityInput) => Promise<VectorProofState>;
    readonly vectorIntent: (
        input: ProofInput & {
            readonly organizationId: string;
            readonly id: string;
            readonly action: "create" | "replace" | "delete";
        }
    ) => Promise<{
        readonly vectorId: string;
        readonly action: "upsert" | "delete";
        readonly nextVersion: number;
        readonly physicalIds: readonly string[];
    }>;
    readonly pollReady: (
        input: VectorIdentityInput & {
            readonly version: number;
            readonly timeoutMs: number;
            readonly intervalMs?: number;
            readonly requiredPhases?: readonly ("submit" | "verify")[];
        }
    ) => Promise<VectorProofPollResult<{ readonly ready: true }>>;
    readonly pollDeleted: (
        input: VectorIdentityInput & {
            readonly timeoutMs: number;
            readonly intervalMs?: number;
            readonly requiredPhases?: readonly ("submit" | "verify")[];
        }
    ) => Promise<VectorProofPollResult<{ readonly absent: true; readonly retainedTombstone: boolean }>>;
    readonly proveNamespaceIsolation: (
        input: OriginInput & {
            readonly owner: VectorProofPrincipal;
            readonly member: VectorProofPrincipal;
            readonly owningOrganizationId: string;
            readonly isolatedOrganizationId: string;
            readonly vectorId: string;
            readonly expectedRowPk: string;
            readonly values: readonly number[];
            readonly limit?: number;
            readonly timeoutMs: number;
            readonly intervalMs?: number;
            readonly stabilityWindowMs?: number;
        }
    ) => Promise<{
        readonly namespaceIsolation: true;
        readonly owningOrganizationId: string;
        readonly isolatedOrganizationId: string;
        readonly vectorId: string;
        readonly owningMatches: number;
        readonly isolatedMatches: 0;
        readonly queryVisibilityElapsedMs: number;
        readonly queryVisibilityAttempts: number;
        readonly queryStabilityWindowMs: number;
        readonly queryStabilityObservedMs: number;
        readonly queryStabilityExactMatchCount: number;
        readonly queryStabilityResetCount: number;
        readonly queryStabilityNonExactCount: number;
        readonly transientHttpFailureCount: number;
        readonly transientHttpFailureCounts: readonly {
            readonly status: number;
            readonly code: string | null;
            readonly count: number;
        }[];
        readonly transientHttpFailureOverflowCount: number;
        readonly hardBoundClaimed: false;
    }>;
    readonly measure: (
        input: OriginInput & {
            readonly label: string;
            readonly operation: (sample: {
                readonly origin: URL;
                readonly label: string;
                readonly sequence: number;
                readonly excluded: boolean;
                readonly phase: "scheduled" | "reacquisition";
            }) => Promise<
                | boolean
                | undefined
                | {
                      readonly classification: "empty" | "http-5xx" | "timeout";
                      readonly status?: number | null;
                      readonly code?: string | null;
                  }
            >;
            readonly timeoutMs?: number;
            readonly intervalMs?: number;
            readonly secrets?: readonly string[];
        }
    ) => Promise<VectorProofBenchmarkEvidence>;
}

export interface VectorProofPollResult<T> {
    readonly state: VectorProofState;
    readonly phases: readonly ("submit" | "verify")[];
    readonly elapsedMs: number;
    readonly pollAttempts: number;
    readonly transientHttpFailureCount: number;
    readonly transientHttpFailureCounts: readonly {
        readonly status: number | null;
        readonly code: string | null;
        readonly count: number;
    }[];
    readonly transientHttpFailureOverflowCount: number;
    readonly result: T;
}

export interface VectorProofBenchmarkEvidence {
    readonly label: string;
    readonly origin: string;
    readonly warmup: VectorProofBenchmarkObservation & { readonly sequence: -1; readonly excluded: true };
    readonly samples: readonly (VectorProofBenchmarkObservation & { readonly excluded: false })[];
    readonly exactMatchLatenciesMs: readonly number[];
    readonly postStabilitySampling: VectorProofPostStabilitySamplingEvidence;
}

export interface VectorProofBenchmarkObservation {
    readonly requestOrdinal: number;
    readonly sequence: number;
    readonly excluded: boolean;
    readonly classification: "exact" | "empty" | "http-5xx" | "timeout";
    readonly status: number | null;
    readonly code: string | null;
    readonly elapsedMs: number;
}

export interface VectorProofPostStabilitySamplingEvidence {
    readonly latencyPopulation: "exact-results-only";
    readonly availabilityPassThreshold: null;
    readonly scheduledRequestCount: 6;
    readonly exactResponseCount: number;
    readonly exactResponseRatio: number;
    readonly availabilityMissCount: number;
    readonly emptyResponseCount: number;
    readonly http5xxResponseCount: number;
    readonly timeoutResponseCount: number;
    readonly reacquisitionCount: number;
    readonly reacquisitions: readonly {
        readonly afterSequence: number;
        readonly excluded: boolean;
        readonly scheduledMissCount: number;
        readonly outOfBandRequestCount: number;
        readonly elapsedMs: number;
    }[];
    readonly reacquisitionObservations: readonly VectorProofBenchmarkObservation[];
    readonly hardBoundClaimed: false;
}

export function vectorProofMutationIds(runId: string): {
    readonly create: string;
    readonly replace: string;
    readonly delete: string;
    readonly liveCreate: string;
    readonly liveReplace: string;
    readonly liveDelete: string;
};

export function assertSecretFreeVectorEvidence<T>(value: T, secrets?: readonly string[]): T;

export function collectResponseLossRetryEvidence(input: {
    readonly upsertState: VectorProofState;
    readonly deleteState: VectorProofState;
    readonly secrets?: readonly string[];
}): {
    readonly upsert: Record<string, unknown>;
    readonly delete: Record<string, unknown>;
};

export function createCloudflareVectorizeProofLifecycle(
    dependencies?: CloudflareVectorizeProofLifecycleDependencies
): CloudflareVectorizeProofLifecycle;
