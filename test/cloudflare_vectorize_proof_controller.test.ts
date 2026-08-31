import { describe, expect, test } from "bun:test";
import {
    CLOUDFLARE_VECTORIZE_PROOF_CONTROLLER_CHECKPOINTS,
    CloudflareVectorizeProofObservationTimeoutError,
    assertCloudflareVectorizeProofCandidateClassificationEvidence,
    assertCloudflareVectorizeProofObservationTimeoutEvidence,
    createCloudflareVectorizeProofController as createProductionCloudflareVectorizeProofController,
} from "../scripts/cloudflare-vectorize-proof-controller.mjs";
import {
    CloudflareVectorizeProofHttpError,
    type VectorProofState,
    createCloudflareVectorizeProofLifecycle,
} from "../scripts/cloudflare-vectorize-proof-lifecycle.mjs";
import { assertCloudflareVectorizeAdversarialFilteringEvidence } from "../scripts/cloudflare-vectorize-proof-report.mjs";

const VECTOR_ID = `vec1_${"a".repeat(64)}`;
const WIRE = Buffer.from("a".repeat(64), "hex").toString("base64url");
const ID_1 = `p1_${WIRE}_1`;
const ID_2 = `p1_${WIRE}_2`;
const LIVE_VECTOR_ID = `vec1_${"b".repeat(64)}`;
const LIVE_WIRE = Buffer.from("b".repeat(64), "hex").toString("base64url");
const LIVE_ID_1 = `p1_${LIVE_WIRE}_1`;
const LIVE_ID_2 = `p1_${LIVE_WIRE}_2`;
const LIVE_ID_3 = `p1_${LIVE_WIRE}_3`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NAMESPACE_1 = `o1_${Buffer.from("1".repeat(64), "hex").toString("base64url")}`;
const NAMESPACE_2 = `o1_${Buffer.from("2".repeat(64), "hex").toString("base64url")}`;
const createCloudflareVectorizeProofController = (
    dependencies: Parameters<typeof createProductionCloudflareVectorizeProofController>[0]
) =>
    createProductionCloudflareVectorizeProofController({
        ...dependencies,
        publicFilterStabilityWindowMs: 0,
    });
const INITIAL_DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const INITIAL_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const REDEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const REDEPLOYED_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN = { token: "admin-controller-secret", runId: "controller-run" };
const OWNER = { cookie: "owner-cookie-secret", token: "owner-token-secret", userId: "owner-user" };
const MEMBER = { cookie: "member-cookie-secret", token: "member-token-secret", userId: "member-user" };
const OWNING_MEMBER = {
    cookie: "owning-member-cookie-secret",
    token: "owning-member-token-secret",
    userId: "member-user",
};
const VECTOR_VALUES = Object.freeze([1, ...Array(31).fill(0)]);
const REPLACEMENT_VALUES = Object.freeze([0, 1, ...Array(30).fill(0)]);
const LIVE_INITIAL_VALUES = Object.freeze([2, 1, ...Array(30).fill(0)]);
const LIVE_REPLACEMENT_VALUES = Object.freeze([1, ...Array(31).fill(0)]);

type GatedFault = NonNullable<VectorProofState["fault"]> & {
    readonly gateOpen: boolean;
    readonly gateDeadline: number | null;
};

function fault(
    mode: "upsert_accept_then_throw" | "delete_accept_then_throw",
    input: Partial<GatedFault> = {}
): GatedFault {
    return {
        mode,
        armed: false,
        inFlight: false,
        fired: true,
        firstPhysicalIds: mode === "upsert_accept_then_throw" ? [ID_2] : [ID_1, ID_2],
        firstPayloadSha256: mode === "upsert_accept_then_throw" ? HASH_A : null,
        returnedMutationIdSha256: HASH_B,
        acceptedBeforeThrow: true,
        retryCount: 1,
        retryIdsMatched: true,
        retryPayloadMatched: true,
        retryComplete: true,
        gateOpen: false,
        gateDeadline: null,
        updatedAt: 100,
        ...input,
    } as GatedFault;
}

function state(input: {
    vectorId?: string;
    rowPk?: string;
    head?: VectorProofState["head"];
    outbox?: VectorProofState["outbox"];
    fault?: GatedFault | null;
    acceptances?: VectorProofState["acceptances"];
    attempts?: VectorProofState["attempts"];
}): VectorProofState {
    return {
        vectorId: input.vectorId ?? VECTOR_ID,
        observedAt: 100,
        scheduledAlarmAt: null,
        head:
            input.head === undefined
                ? {
                      organizationId: "org-owning",
                      resourceId: `vr1_${"c".repeat(64)}`,
                      rowPk: input.rowPk ?? "document-1",
                      version: 2,
                      deliveredVersion: 1,
                      state: "pending",
                  }
                : input.head,
        outbox: input.outbox ?? null,
        attempts: input.attempts ?? [],
        acceptances: input.acceptances ?? [
            {
                operation: "upsert",
                physicalId: ID_1,
                payloadSha256: HASH_A,
                mutationIdSha256: HASH_B,
                acceptedAt: 50,
            },
        ],
        fault: (input.fault ?? null) as VectorProofState["fault"],
    };
}

function heldState(vectorId = VECTOR_ID, rowPk = "document-1", physicalId = ID_2): VectorProofState {
    return state({
        vectorId,
        rowPk,
        outbox: {
            targetVersion: 2,
            operation: "upsert",
            phase: "submit",
            mutationIdSha256: null,
            acceptedAt: null,
            attempts: 1,
            nextAttemptAt: 0,
            leased: true,
            claimTokenSha256: HASH_A,
            leasedUntil: 20_000,
            terminalFailure: false,
            lastErrorClassification: null,
            lastErrorSha256: null,
        },
        fault: fault("upsert_accept_then_throw", {
            firstPhysicalIds: [physicalId],
            armed: true,
            inFlight: true,
            fired: false,
            returnedMutationIdSha256: null,
            acceptedBeforeThrow: false,
            retryCount: 0,
            retryIdsMatched: null,
            retryPayloadMatched: null,
            retryComplete: false,
            gateDeadline: 600_000,
        }),
    });
}

function controllerInput() {
    return {
        origin: "https://proof.example.com",
        admin: ADMIN,
        releaseSha256: "d".repeat(64),
        migrationId: "controller-migration",
        owningName: "Owning",
        owningSlug: "owning",
        isolatedName: "Isolated",
        isolatedSlug: "isolated",
        mutationRunId: "controller-mutations",
        documentId: "document-1",
        initialText: "initial",
        initialValues: VECTOR_VALUES,
        replacementText: "replacement",
        replacementValues: REPLACEMENT_VALUES,
        liveDocumentId: "live-document-1",
        liveClientId: "live-client-1",
        liveInitialText: "live initial",
        liveInitialValues: LIVE_INITIAL_VALUES,
        liveReplacementText: "live replacement",
        liveReplacementValues: LIVE_REPLACEMENT_VALUES,
        liveQueryValues: LIVE_INITIAL_VALUES,
        initialVersion: {
            deploymentId: INITIAL_DEPLOYMENT_ID,
            versionId: INITIAL_VERSION_ID,
            number: 1,
            percentage: 100 as const,
        },
        timeoutMs: 20_000,
        intervalMs: 10,
        benchmark: {
            workloadId: "ready-vector-filtered-search-v2" as const,
            localFake: {
                workloadId: "ready-vector-filtered-search-v2" as const,
                warmupExcluded: true as const,
                warmupCount: 1 as const,
                samplesMs: [1, 2, 3, 4, 5] as const,
            },
            localRemoteBinding: {
                workloadId: "ready-vector-filtered-search-v2" as const,
                warmupExcluded: true as const,
                warmupCount: 1 as const,
                samplesMs: [2, 3, 4, 5, 6] as const,
            },
            localRemoteQueryStability: {
                queryStabilityWindowMs: 10_000 as const,
                queryStabilityIntervalMs: 1_000 as const,
                queryStabilityObservedMs: 10_000,
                queryStabilityExactMatchCount: 11,
                queryStabilityResetCount: 1,
                queryStabilityNonExactCount: 1,
                hardBoundClaimed: false as const,
            },
        },
    };
}

function successfulLifecycle(
    events: string[],
    options: { readonly controllerTimeoutMs?: number; readonly retainStaleCleanupAttempt?: boolean } = {}
) {
    let current = heldState();
    let liveCurrent = state({
        vectorId: LIVE_VECTOR_ID,
        rowPk: "live-document-1",
        head: {
            organizationId: "org-owning",
            resourceId: `vr1_${"c".repeat(64)}`,
            rowPk: "live-document-1",
            version: 1,
            deliveredVersion: 1,
            state: "ready",
        },
        attempts: [
            {
                physicalVersion: 1,
                firstSentAt: 1,
                settleAfter: 2,
                visibilityConfirmed: true,
                responseAmbiguous: false,
                deleteConfirmed: false,
            },
        ],
    });
    let automaticHeldAlarmPending = false;
    let liveAutomaticHeldAlarmPending = false;
    let automaticDeleteAlarmPending = false;
    let releaseCount = 0;
    let migrateCount = 0;
    let isolationCount = 0;
    let adversaryApplied = false;
    let upsertFaultArmCount = 0;
    let searchAuditSequence = 0;
    let lastSearchAudit = {
        candidateSetSha256: HASH_A,
        candidateCount: 1,
        stalePresent: false,
        currentPresent: true,
        otherCandidateCount: 0,
    };
    return {
        health: async () => ({
            ok: true,
            schemaVersion: 1,
            releaseSha256: "d".repeat(64),
            vectorResources: 1,
            proofConfigured: true,
        }),
        requestJson: async (input: { path: string }) => {
            if (input.path !== "/proof/vector-descriptor") throw new Error(`unexpected request ${input.path}`);
            return {
                status: 200,
                headers: new Headers(),
                body: {
                    descriptor: {
                        binding: "CDB_PROOF_VECTORS",
                        resourceDigest: HASH_C,
                        resourceId: `vr1_${HASH_C}`,
                        resourceFilter: `r1_${Buffer.from(HASH_C, "hex").toString("base64url")}`,
                        dimensions: 32,
                        metric: "cosine",
                        namespaceIds: [NAMESPACE_1, NAMESPACE_2],
                    },
                    search: {
                        resourceFilter: true,
                        currentHeadOnly: true,
                        noRemoteValues: true,
                        noRemoteMetadata: true,
                    },
                    settlementConfiguredMs: 120_000,
                },
            };
        },
        migrateV0ToV1: async () => ({
            beforeVersion: migrateCount++ === 0 ? 0 : 1,
            beforeEpoch: migrateCount === 1 ? 1 : 2,
            targetVersion: 1,
            afterVersion: 1,
            afterEpoch: 2,
            idempotentRetry: migrateCount > 1,
        }),
        setupOrganizations: async () => ({
            owner: OWNER,
            member: MEMBER,
            owningMember: OWNING_MEMBER,
            owningOrganizationId: "org-owning",
            isolatedOrganizationId: "org-isolated",
        }),
        vectorIntent: async (input: { action: string; id: string }) => {
            const live = input.id === "live-document-1";
            events.push(`intent:${live ? "live-" : ""}${input.action}`);
            if (live) {
                return input.action === "create"
                    ? { vectorId: LIVE_VECTOR_ID, action: "upsert", nextVersion: 1, physicalIds: [LIVE_ID_1] }
                    : input.action === "replace"
                      ? { vectorId: LIVE_VECTOR_ID, action: "upsert", nextVersion: 2, physicalIds: [LIVE_ID_2] }
                      : {
                            vectorId: LIVE_VECTOR_ID,
                            action: "delete",
                            nextVersion: 3,
                            physicalIds: [LIVE_ID_2],
                        };
            }
            return input.action === "create"
                ? { vectorId: VECTOR_ID, action: "upsert", nextVersion: 1, physicalIds: [ID_1] }
                : input.action === "replace"
                  ? { vectorId: VECTOR_ID, action: "upsert", nextVersion: 2, physicalIds: [ID_2] }
                  : { vectorId: VECTOR_ID, action: "delete", nextVersion: 3, physicalIds: [ID_1, ID_2] };
        },
        mutateVector: async (input: { action: string; id: string }) => {
            const live = input.id === "live-document-1";
            events.push(`mutate:${live ? "live-" : ""}${input.action}`);
            if (input.action === "replace") {
                if (live) liveAutomaticHeldAlarmPending = true;
                else automaticHeldAlarmPending = true;
            }
            if (input.action === "delete" && !live) automaticDeleteAlarmPending = true;
            return input.action === "delete"
                ? { id: input.id }
                : { id: input.id, vectorId: live ? LIVE_VECTOR_ID : VECTOR_ID };
        },
        pollReady: async (input: { version: number; vectorId: string }) => {
            if (input.vectorId === LIVE_VECTOR_ID) {
                liveCurrent = state({
                    vectorId: LIVE_VECTOR_ID,
                    rowPk: "live-document-1",
                    head: {
                        organizationId: "org-owning",
                        resourceId: `vr1_${"c".repeat(64)}`,
                        rowPk: "live-document-1",
                        version: input.version,
                        deliveredVersion: input.version,
                        state: "ready",
                    },
                    fault: input.version === 2 ? fault("upsert_accept_then_throw") : null,
                    attempts:
                        input.version === 1
                            ? [
                                  {
                                      physicalVersion: 1,
                                      firstSentAt: 1,
                                      settleAfter: 2,
                                      visibilityConfirmed: true,
                                      responseAmbiguous: false,
                                      deleteConfirmed: false,
                                  },
                              ]
                            : [
                                  ...(options.retainStaleCleanupAttempt
                                      ? [
                                            {
                                                physicalVersion: 1,
                                                firstSentAt: 1,
                                                settleAfter: 2,
                                                visibilityConfirmed: true,
                                                responseAmbiguous: false,
                                                deleteConfirmed: true,
                                            },
                                        ]
                                      : []),
                                  {
                                      physicalVersion: 2,
                                      firstSentAt: 3,
                                      settleAfter: 4,
                                      visibilityConfirmed: true,
                                      responseAmbiguous: true,
                                      deleteConfirmed: false,
                                  },
                              ],
                });
                return { state: liveCurrent, phases: ["submit", "verify"], elapsedMs: 12, result: { ready: true } };
            }
            if (input.version === 2) {
                current = state({
                    head: {
                        organizationId: "org-owning",
                        resourceId: `vr1_${"c".repeat(64)}`,
                        rowPk: "document-1",
                        version: 2,
                        deliveredVersion: 2,
                        state: "ready",
                    },
                    fault: fault("upsert_accept_then_throw"),
                    attempts: [
                        ...(options.retainStaleCleanupAttempt
                            ? [
                                  {
                                      physicalVersion: 1,
                                      firstSentAt: 1,
                                      settleAfter: 2,
                                      visibilityConfirmed: true,
                                      responseAmbiguous: false,
                                      deleteConfirmed: true,
                                  },
                              ]
                            : []),
                        {
                            physicalVersion: 2,
                            firstSentAt: 3,
                            settleAfter: 4,
                            visibilityConfirmed: true,
                            responseAmbiguous: true,
                            deleteConfirmed: false,
                        },
                    ],
                });
            }
            return { state: current, phases: ["submit", "verify"], elapsedMs: 10, result: { ready: true } };
        },
        proveNamespaceIsolation: async (input: {
            timeoutMs: number;
            intervalMs: number;
            expectedRowPk?: string;
            stabilityWindowMs?: number;
        }) => {
            expect(input.timeoutMs).toBe(options.controllerTimeoutMs ?? 20_000);
            expect(input.intervalMs).toBe(isolationCount === 0 ? 10 : 1_000);
            if (isolationCount === 1) {
                expect(input).toMatchObject({ expectedRowPk: "document-1", stabilityWindowMs: 10_000 });
            }
            isolationCount++;
            return {
                namespaceIsolation: true,
                owningMatches: 1,
                isolatedMatches: 0,
                queryVisibilityElapsedMs: isolationCount === 1 ? 4 : 6,
                queryVisibilityAttempts: 2,
                transientHttpFailureCount: isolationCount === 1 ? 1 : 2,
                transientHttpFailureCounts: [
                    {
                        status: isolationCount === 1 ? null : 503,
                        code: isolationCount === 1 ? null : "CDB_ROUTE_UNAVAILABLE",
                        count: isolationCount === 1 ? 1 : 2,
                    },
                ],
                transientHttpFailureOverflowCount: 0,
                hardBoundClaimed: false,
                queryStabilityWindowMs: 10_000,
                queryStabilityObservedMs: 10_000,
                queryStabilityExactMatchCount: 11,
                queryStabilityResetCount: 2,
                queryStabilityNonExactCount: 2,
            };
        },
        search: async (input: { limit?: number; principal?: typeof OWNER; values?: readonly number[] }) => {
            events.push(`search-limit:${String(input.limit)}`);
            searchAuditSequence++;
            lastSearchAudit = adversaryApplied
                ? {
                      candidateSetSha256: HASH_B,
                      candidateCount: 1,
                      stalePresent: true,
                      currentPresent: false,
                      otherCandidateCount: 0,
                  }
                : {
                      candidateSetSha256: HASH_A,
                      candidateCount: 1,
                      stalePresent: false,
                      currentPresent: true,
                      otherCandidateCount: 0,
                  };
            if (adversaryApplied || input.principal === OWNING_MEMBER) return [];
            return [{ rowPk: "document-1", score: 1 }];
        },
        vectorSearchAudit: async (input: {
            action: "cursor" | "observe";
            afterSequence?: number;
            values?: readonly number[];
        }) => {
            expect(input.values).toEqual(adversaryApplied ? VECTOR_VALUES : REPLACEMENT_VALUES);
            if (input.action === "cursor") {
                return {
                    sequence: searchAuditSequence,
                    querySha256: null,
                    candidateSetSha256: null,
                    candidateCount: 0,
                    stalePresent: false,
                    currentPresent: false,
                    otherCandidateCount: 0,
                };
            }
            expect(searchAuditSequence).toBe((input.afterSequence ?? -1) + 1);
            return {
                sequence: searchAuditSequence,
                querySha256: HASH_C,
                ...lastSearchAudit,
            };
        },
        mutateVectorAdversary: async (input: { action: "apply" | "restore" }) => {
            adversaryApplied = input.action === "apply";
            events.push(`adversary:${input.action}`);
            return {
                action: input.action,
                vectorId: VECTOR_ID,
                stalePhysicalId: ID_1,
                currentPhysicalId: ID_2,
                upsertMutationIdSha256: input.action === "apply" ? HASH_A : HASH_C,
                deleteMutationIdSha256: input.action === "apply" ? HASH_B : "d".repeat(64),
            };
        },
        queryVectorAdversary: async () => ({
            action: "inspect" as const,
            vectorId: VECTOR_ID,
            stalePhysicalId: ID_1,
            currentPhysicalId: ID_2,
            upsertMutationIdSha256: null,
            deleteMutationIdSha256: null,
            matches: [{ physicalId: adversaryApplied ? ID_1 : ID_2, score: 1 }],
        }),
        openLiveVectorSubscription: async (input: unknown) => {
            expect(input).toMatchObject({
                expectedRowPk: "live-document-1",
                expectedPendingFallbackRowPk: "document-1",
            });
            let phase = "baseline";
            return {
                reconnect: async () => {
                    events.push("live:reconnect");
                    return { recovery: "lagged-refetch" as const };
                },
                beginReplacement: () => {
                    phase = "pending";
                    events.push("live:begin-replacement");
                },
                waitForPending: async () => {
                    expect(phase).toBe("pending");
                    events.push("live:pending");
                    return { elapsedMs: 5 };
                },
                assertPending: () => expect(phase).toBe("pending"),
                allowCurrent: () => {
                    expect(phase).toBe("pending");
                    phase = "current";
                },
                waitForCurrent: async () => {
                    expect(phase).toBe("current");
                    events.push("live:current");
                    return { elapsedMs: 6 };
                },
                finish: () => ({
                    sdk: "installed-candidate-createChardbClient" as const,
                    transport: "worker-websocket" as const,
                    auth: "better-auth-jwt" as const,
                    queryRefSha256: HASH_A,
                    clientIdSha256: HASH_B,
                    connectionCount: 2 as const,
                    helloCount: 2 as const,
                    welcomeCount: 2 as const,
                    reconnectCount: 1 as const,
                    authReadCount: 2 as const,
                    snapshotCount: 4,
                    acknowledgementCount: 4,
                    acknowledgementEverySnapshot: true as const,
                    resume: {
                        attempted: true as const,
                        helloResumeMatchedInitialAck: true as const,
                        welcomeResumeMatchedInitialAck: true as const,
                        recovery: "lagged-refetch" as const,
                        refetchReason: "lagged" as const,
                        refetchStateCount: 1 as const,
                        baselineRestoreCount: 1 as const,
                        baselineRestoredExactly: true as const,
                        baselineRestoreAcknowledged: true as const,
                        initialCookieSha256: HASH_A,
                        finalCookieSha256: HASH_B,
                    },
                    content: {
                        callbackCount: 4 as const,
                        baselineUpdateCount: 1 as const,
                        pendingFallbackUpdateCount: 1 as const,
                        prematureCurrentUpdateCount: 0 as const,
                        replacementUpdateCount: 1 as const,
                        duplicateContentUpdateCount: 0 as const,
                        baselineRowsSha256: HASH_A,
                        pendingFallbackRowPkSha256: HASH_C,
                        pendingRowsSha256: HASH_B,
                        replacementRowsSha256: HASH_C,
                    },
                }),
                abort: () => {
                    events.push("live:abort");
                },
            };
        },
        armFault: async (input: { mode: string; vectorId: string }) => {
            const mode = input.mode.startsWith("delete") ? "delete" : "upsert";
            const expectedVectorId =
                mode === "delete" ? VECTOR_ID : upsertFaultArmCount++ === 0 ? VECTOR_ID : LIVE_VECTOR_ID;
            expect(input.vectorId).toBe(expectedVectorId);
            events.push(`arm:${mode}`);
            return { armed: true, mode: input.mode, vectorId: input.vectorId };
        },
        vectorState: async (input: { vectorId?: string }) => {
            if (input.vectorId === LIVE_VECTOR_ID) {
                if (liveAutomaticHeldAlarmPending) {
                    liveAutomaticHeldAlarmPending = false;
                    events.push("alarm:live-held");
                    liveCurrent = heldState(LIVE_VECTOR_ID, "live-document-1", LIVE_ID_2);
                }
                return liveCurrent;
            }
            expect(input.vectorId).toBe(VECTOR_ID);
            if (automaticDeleteAlarmPending) {
                automaticDeleteAlarmPending = false;
                events.push("alarm:delete-loss");
                current = state({
                    head: {
                        organizationId: "org-owning",
                        resourceId: `vr1_${"c".repeat(64)}`,
                        rowPk: "document-1",
                        version: 3,
                        deliveredVersion: 2,
                        state: "deleting",
                    },
                    fault: fault("delete_accept_then_throw", { retryComplete: false, retryCount: 0 }),
                });
            }
            if (automaticHeldAlarmPending) {
                automaticHeldAlarmPending = false;
                events.push("alarm:held");
                current = heldState();
            }
            return current;
        },
        releaseHeldFault: () => {
            releaseCount++;
            if (releaseCount === 2) {
                events.push("alarm:live-upsert-loss");
                liveCurrent = state({
                    vectorId: LIVE_VECTOR_ID,
                    rowPk: "live-document-1",
                    fault: fault("upsert_accept_then_throw", { retryComplete: false, retryCount: 0 }),
                    outbox: {
                        targetVersion: 2,
                        operation: "upsert",
                        phase: "submit",
                        mutationIdSha256: null,
                        acceptedAt: null,
                        attempts: 1,
                        nextAttemptAt: 1_000,
                        leased: false,
                        claimTokenSha256: null,
                        leasedUntil: null,
                        terminalFailure: false,
                        lastErrorClassification: null,
                        lastErrorSha256: null,
                    },
                });
                return;
            }
            events.push("alarm:upsert-loss");
            current = state({
                fault: fault("upsert_accept_then_throw", { retryComplete: false, retryCount: 0 }),
                outbox: {
                    targetVersion: 2,
                    operation: "upsert",
                    phase: "submit",
                    mutationIdSha256: null,
                    acceptedAt: null,
                    attempts: 1,
                    nextAttemptAt: 1_000,
                    leased: false,
                    claimTokenSha256: null,
                    leasedUntil: null,
                    terminalFailure: false,
                    lastErrorClassification: null,
                    lastErrorSha256: null,
                },
            });
        },
        pollDeleted: async (input: { vectorId: string }) => {
            if (input.vectorId === LIVE_VECTOR_ID) {
                liveCurrent = state({ vectorId: LIVE_VECTOR_ID, rowPk: "live-document-1", head: null });
                return {
                    state: liveCurrent,
                    phases: ["submit", "verify"],
                    elapsedMs: 11,
                    result: { absent: true as const, retainedTombstone: false },
                };
            }
            current = state({ head: null, fault: fault("delete_accept_then_throw") });
            return {
                state: current,
                phases: ["submit", "verify"],
                elapsedMs: 10,
                result: { absent: true as const, retainedTombstone: false },
            };
        },
        measure: async (input: {
            label: string;
            origin: string;
            operation: (sample: {
                origin: URL;
                label: string;
                sequence: number;
                excluded: boolean;
                phase: "scheduled" | "reacquisition";
            }) => Promise<boolean | undefined>;
        }) => {
            events.push(`measure:${input.label}`);
            await input.operation({
                origin: new URL(input.origin),
                label: input.label,
                sequence: -1,
                excluded: true,
                phase: "scheduled",
            });
            for (let sequence = 0; sequence < 5; sequence++) {
                await input.operation({
                    origin: new URL(input.origin),
                    label: input.label,
                    sequence,
                    excluded: false,
                    phase: "scheduled",
                });
            }
            const samples = [0, 1, 2, 3, 4].map((sequence, index) => ({
                requestOrdinal: index + 1,
                sequence,
                excluded: false as const,
                classification: "exact" as const,
                status: null,
                code: null,
                elapsedMs: 1,
            }));
            return {
                label: input.label,
                origin: input.origin,
                warmup: {
                    requestOrdinal: 0,
                    sequence: -1 as const,
                    excluded: true as const,
                    classification: "exact" as const,
                    status: null,
                    code: null,
                    elapsedMs: 1,
                },
                samples,
                exactMatchLatenciesMs: samples.map(sample => sample.elapsedMs),
                postStabilitySampling: {
                    latencyPopulation: "exact-results-only" as const,
                    availabilityPassThreshold: null,
                    scheduledRequestCount: 6 as const,
                    exactResponseCount: 6,
                    exactResponseRatio: 1,
                    availabilityMissCount: 0,
                    emptyResponseCount: 0,
                    http5xxResponseCount: 0,
                    timeoutResponseCount: 0,
                    reacquisitionCount: 0,
                    reacquisitions: [],
                    reacquisitionObservations: [],
                    hardBoundClaimed: false as const,
                },
            };
        },
    };
}

describe("Cloudflare Vectorize proof controller", () => {
    test("requires exact candidate classification accounting without recording ids", () => {
        expect(
            assertCloudflareVectorizeProofCandidateClassificationEvidence({
                candidateCount: 2,
                stalePresent: false,
                currentPresent: true,
                otherCandidateCount: 1,
                queryIdentityMatch: true,
            })
        ).toEqual({
            candidateCount: 2,
            stalePresent: false,
            currentPresent: true,
            otherCandidateCount: 1,
            queryIdentityMatch: true,
        });

        for (const classification of [
            {
                candidateCount: 3,
                stalePresent: false,
                currentPresent: true,
                otherCandidateCount: 1,
                queryIdentityMatch: true,
            },
            {
                candidateCount: 1,
                stalePresent: true,
                currentPresent: true,
                otherCandidateCount: 0,
                queryIdentityMatch: true,
            },
            {
                candidateCount: 0,
                stalePresent: true,
                currentPresent: false,
                otherCandidateCount: 0,
                queryIdentityMatch: true,
            },
            {
                candidateCount: 0,
                stalePresent: false,
                currentPresent: true,
                otherCandidateCount: 0,
                queryIdentityMatch: true,
            },
            {
                candidateCount: 1,
                stalePresent: false,
                currentPresent: false,
                otherCandidateCount: 0,
                queryIdentityMatch: true,
            },
        ]) {
            expect(() => assertCloudflareVectorizeProofCandidateClassificationEvidence(classification)).toThrow(
                "proof candidate classification accounting drifted"
            );
        }
    });

    test("waits for typed transient health failures before starting migrations or mutations", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const successfulHealth = lifecycle.health;
        let healthCalls = 0;
        let clock = 0;
        lifecycle.health = async () => {
            healthCalls++;
            if (healthCalls === 1) {
                throw new CloudflareVectorizeProofHttpError(
                    "proof Worker health returned HTTP 503",
                    503,
                    null,
                    "http",
                    "invalid_json"
                );
            }
            if (healthCalls === 2) {
                throw new CloudflareVectorizeProofHttpError("health deadline expired", null, null, "timeout");
            }
            return successfulHealth();
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                expect(events).toEqual([]);
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).resolves.toMatchObject({ health: { ok: true } });
        expect(healthCalls).toBe(3);
        expect(clock).toBe(20);
        expect(events.filter(event => event.startsWith("mutate:"))).toEqual([
            "mutate:create",
            "mutate:replace",
            "mutate:live-create",
            "mutate:live-replace",
            "mutate:live-delete",
            "mutate:delete",
        ]);
        expect(events).toContain("alarm:delete-loss");
    });

    test("keeps the completed lifecycle fault scoped while the live vector reaches readiness", async () => {
        const lifecycle = successfulLifecycle([]);
        const armFault = lifecycle.armFault.bind(lifecycle);
        const pollReady = lifecycle.pollReady.bind(lifecycle);
        const armed: Array<{ mode: string; vectorId: string }> = [];
        const readiness: Array<{ vectorId: string; version: number; fault: VectorProofState["fault"] }> = [];
        lifecycle.armFault = async input => {
            armed.push({ mode: input.mode, vectorId: input.vectorId });
            return armFault(input);
        };
        lifecycle.pollReady = async input => {
            const result = await pollReady(input);
            readiness.push({ vectorId: input.vectorId, version: input.version, fault: result.state.fault });
            return result;
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await controller.run(controllerInput());

        expect(armed).toEqual([
            { mode: "upsert_accept_then_throw", vectorId: VECTOR_ID },
            { mode: "upsert_accept_then_throw", vectorId: LIVE_VECTOR_ID },
            { mode: "delete_accept_then_throw", vectorId: VECTOR_ID },
        ]);
        expect(readiness.find(item => item.vectorId === VECTOR_ID && item.version === 2)?.fault).toMatchObject({
            firstPhysicalIds: [ID_2],
            retryComplete: true,
        });
        expect(readiness.find(item => item.vectorId === LIVE_VECTOR_ID && item.version === 1)?.fault).toBeNull();
    });

    test("requires superseded cleanup to prune the stale attempt before adversary checks", async () => {
        const events: string[] = [];
        const checkpoints: string[] = [];
        const lifecycle = successfulLifecycle(events, {
            controllerTimeoutMs: 25,
            retainStaleCleanupAttempt: true,
        });
        let clock = 0;
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            checkpoint: async value => {
                checkpoints.push(value);
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const error = await controller
            .run({ ...controllerInput(), timeoutMs: 25, intervalMs: 10 })
            .catch(cause => cause);

        expect(error).toBeInstanceOf(CloudflareVectorizeProofObservationTimeoutError);
        expect(error.evidence).toMatchObject({
            label: "superseded vector cleanup",
            timeoutMs: 25,
            latestState: {
                outbox: null,
                attempts: [{ physicalVersion: 1 }, { physicalVersion: 2 }],
            },
        });
        expect(checkpoints.at(-1)).toBe("adversary-settlement");
        expect(checkpoints).not.toContain("adversary-apply");
    });

    test("recovers a health 404 before starting migrations or mutations", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const successfulHealth = lifecycle.health;
        let healthCalls = 0;
        let clock = 0;
        lifecycle.health = async () => {
            healthCalls++;
            if (healthCalls === 1) {
                throw new CloudflareVectorizeProofHttpError(
                    "proof Worker health returned HTTP 404",
                    404,
                    "NOT_FOUND",
                    "http"
                );
            }
            return successfulHealth();
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                expect(events).toEqual([]);
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).resolves.toMatchObject({ health: { ok: true } });
        expect(healthCalls).toBe(2);
        expect(clock).toBe(10);
        expect(events.filter(event => event.startsWith("mutate:"))).toHaveLength(6);
    });

    test("bounds persistent health 404 and 5xx recovery by the controller deadline", async () => {
        for (const failure of [
            new CloudflareVectorizeProofHttpError("proof Worker health returned HTTP 404", 404, "NOT_FOUND", "http"),
            new CloudflareVectorizeProofHttpError(
                "proof Worker health returned HTTP 503",
                503,
                null,
                "http",
                "invalid_json"
            ),
        ]) {
            const events: string[] = [];
            const checkpoints: string[] = [];
            const lifecycle = successfulLifecycle(events);
            let healthCalls = 0;
            let clock = 0;
            lifecycle.health = async () => {
                healthCalls++;
                throw failure;
            };
            const controller = createCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => clock,
                sleep: async milliseconds => {
                    clock += milliseconds;
                },
                checkpoint: async value => {
                    checkpoints.push(value);
                },
                appendOwnedIds: async () => undefined,
                redeploy: async () => {
                    throw new Error("redeploy must not run before health succeeds");
                },
                releaseFault: async () => {
                    throw new Error("fault release must not run before health succeeds");
                },
            });
            const error = await controller
                .run({ ...controllerInput(), timeoutMs: 25, intervalMs: 10 })
                .catch(cause => cause);

            expect(error).toBe(failure);
            expect(healthCalls).toBe(4);
            expect(clock).toBe(25);
            expect(checkpoints).toEqual(["health"]);
            expect(events).toEqual([]);
        }
    });

    test("fails health immediately on 401, network, protocol, or malformed success", async () => {
        const failures = [
            new CloudflareVectorizeProofHttpError("proof Worker health returned HTTP 401", 401, "AUTH_DENIED", "http"),
            new CloudflareVectorizeProofHttpError("network timed out", null, null, "network"),
            new CloudflareVectorizeProofHttpError(
                "proof Worker health returned invalid JSON",
                null,
                null,
                "protocol",
                "invalid_json"
            ),
            new TypeError("proof Worker health response is malformed"),
        ];
        for (const failure of failures) {
            const events: string[] = [];
            const lifecycle = successfulLifecycle(events);
            let healthCalls = 0;
            let sleepCalls = 0;
            lifecycle.health = async () => {
                healthCalls++;
                throw failure;
            };
            const controller = createCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => 0,
                sleep: async () => {
                    sleepCalls++;
                },
                appendOwnedIds: async () => undefined,
                redeploy: async () => {
                    throw new Error("redeploy must not run before health succeeds");
                },
                releaseFault: async () => {
                    throw new Error("fault release must not run before health succeeds");
                },
            });

            expect(await controller.run(controllerInput()).catch(cause => cause)).toBe(failure);
            expect(healthCalls).toBe(1);
            expect(sleepCalls).toBe(0);
            expect(events).toEqual([]);
        }
    });

    test("orders ownership before mutation and holds one exact claim through redeploy and release", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            checkpoint: async value => {
                events.push(`checkpoint:${value}`);
            },
            appendOwnedIds: async input => {
                events.push(`append:${input.action}:${input.physicalIds.join(",")}`);
            },
            redeploy: async input => {
                expect(input.claim).toMatchObject({ claimTokenSha256: HASH_A, targetVersion: 2, operation: "upsert" });
                events.push("redeploy");
                return {
                    deploymentId: REDEPLOYMENT_ID,
                    versionId: REDEPLOYED_VERSION_ID,
                    number: 2,
                    percentage: 100,
                } as const;
            },
            releaseFault: async input => {
                expect(events.at(-1)).toBe(
                    events.includes("checkpoint:live-replace-release")
                        ? "checkpoint:live-replace-release"
                        : "checkpoint:fault-release"
                );
                expect(events).toContain("redeploy");
                events.push("release");
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });
        const report = await controller.run(controllerInput());

        expect(events.filter(event => event.startsWith("checkpoint:"))).toEqual(
            CLOUDFLARE_VECTORIZE_PROOF_CONTROLLER_CHECKPOINTS.map(value => `checkpoint:${value}`)
        );

        expect(events.indexOf(`append:create:${ID_1}`)).toBeLessThan(events.indexOf("mutate:create"));
        expect(events.indexOf(`append:replace:${ID_2}`)).toBeLessThan(events.indexOf("mutate:replace"));
        expect(events.indexOf("alarm:held")).toBeLessThan(events.indexOf("redeploy"));
        expect(events.indexOf("redeploy")).toBeLessThan(events.indexOf("release"));
        expect(events.indexOf("measure:deployed-cloudflare-vectorize")).toBeLessThan(events.indexOf("intent:delete"));
        expect(events.filter(event => event.startsWith("search-limit:"))).toEqual(Array(9).fill("search-limit:1"));
        expect(report).toMatchObject({
            redeploy: {
                workerRedeployDuringLease: true,
                maintainPendingAcrossRedeploy: true,
                leaseStateAfterRedeploy: "active-original",
                eventualCompletion: true,
            },
            delivery: {
                initial: { physicalId: ID_1, payloadSha256: HASH_A, mutationIdSha256: HASH_B },
                upsertResponseLoss: { physicalId: ID_2, retryPhysicalId: ID_2 },
                deleteResponseLoss: { physicalIds: [ID_1, ID_2], retryPhysicalIds: [ID_1, ID_2] },
            },
            lifecycle: {
                migration: { beforeVersion: 0, beforeEpoch: 1, afterVersion: 1, afterEpoch: 2, idempotentRetry: true },
            },
            descriptor: {
                resourceId: `vr1_${HASH_C}`,
                namespaceIds: [NAMESPACE_1, NAMESPACE_2],
            },
            search: {
                namespaceIsolation: true,
                resourceFilter: true,
                currentHeadOnly: true,
                adversarialFiltering: {
                    provider: "cloudflare-vectorize",
                    realVectorize: true,
                    syntheticMatches: false,
                    injected: { rawStaleObserved: true, rawCurrentAbsent: true, publicTargetReturned: false },
                    restore: { rawCurrentObserved: true, rawStaleAbsent: true, publicOwnerTargetReturned: true },
                    policy: { publicOwnerTargetReturned: true, publicMemberTargetReturned: false },
                },
                liveDelivery: {
                    realWorkerWebSocket: true,
                    syntheticFrames: false,
                    pending: { gateHeldBeforeRelease: true, publicReplacementReturned: false },
                    ready: { providerReadyBeforeAssertion: true, publicReplacementUpdateCount: 1 },
                    cleanup: { deleted: true, retainedTombstone: false },
                    sdk: {
                        sdk: "installed-candidate-createChardbClient",
                        transport: "worker-websocket",
                        auth: "better-auth-jwt",
                        connectionCount: 2,
                        reconnectCount: 1,
                        acknowledgementEverySnapshot: true,
                        content: { duplicateContentUpdateCount: 0, prematureCurrentUpdateCount: 0 },
                    },
                },
            },
            settlement: {
                configuredMs: 120_000,
                samplesMs: [10, 4, 10, 6, 12, 11, 10],
                transientHttpFailureCount: 3,
                transientHttpFailureCounts: [
                    { status: null, code: null, count: 1 },
                    { status: 503, code: "CDB_ROUTE_UNAVAILABLE", count: 2 },
                ],
                transientHttpFailureOverflowCount: 0,
                hardBoundClaimed: false,
            },
            benchmark: {
                schema: "chardb.vectorize.deployment-benchmark.v2",
                workload: {
                    id: "ready-vector-filtered-search-v2",
                    dimensions: 32,
                    metric: "cosine",
                    topK: 1,
                    requestsPerSample: 1,
                },
                queryStability: {
                    localRemoteBinding: {
                        queryStabilityWindowMs: 10_000,
                        queryStabilityIntervalMs: 1_000,
                        queryStabilityObservedMs: 10_000,
                        queryStabilityExactMatchCount: 11,
                        queryStabilityResetCount: 1,
                        queryStabilityNonExactCount: 1,
                        hardBoundClaimed: false,
                    },
                    deployed: {
                        queryStabilityWindowMs: 10_000,
                        queryStabilityIntervalMs: 1_000,
                        queryStabilityObservedMs: 10_000,
                        queryStabilityExactMatchCount: 11,
                        queryStabilityResetCount: 2,
                        queryStabilityNonExactCount: 2,
                        hardBoundClaimed: false,
                    },
                },
                postStabilitySampling: {
                    localRemoteBinding: { exactResponseRatio: 1, availabilityPassThreshold: null },
                    deployed: { exactResponseRatio: 1, availabilityPassThreshold: null },
                },
                localFake: { label: "local-workerd-fake-vectorize", exactMatchLatenciesMs: [1, 2, 3, 4, 5] },
                localRemoteBinding: {
                    label: "local-wrangler-remote-vectorize",
                    exactMatchLatenciesMs: [2, 3, 4, 5, 6],
                },
                deployed: { label: "deployed-cloudflare-vectorize", exactMatchLatenciesMs: [1, 1, 1, 1, 1] },
            },
            deletion: { absent: true },
        });
        const serialized = JSON.stringify(report);
        for (const secret of [
            ADMIN.token,
            OWNER.cookie,
            OWNER.token,
            MEMBER.cookie,
            MEMBER.token,
            OWNING_MEMBER.cookie,
            OWNING_MEMBER.token,
        ]) {
            expect(serialized).not.toContain(secret);
        }
    });

    test("uses the exact replacement query for restored-owner and member audit calls", async () => {
        const lifecycle = successfulLifecycle([]);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        const calls: Array<Record<string, unknown>> = [];
        lifecycle.vectorSearchAudit = async input => {
            calls.push(structuredClone(input) as Record<string, unknown>);
            return vectorSearchAudit(input);
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await controller.run(controllerInput());

        expect(calls.slice(-4)).toEqual([
            {
                origin: "https://proof.example.com",
                admin: ADMIN,
                organizationId: "org-owning",
                id: "document-1",
                staleValues: VECTOR_VALUES,
                currentValues: REPLACEMENT_VALUES,
                action: "cursor",
                values: REPLACEMENT_VALUES,
            },
            {
                origin: "https://proof.example.com",
                admin: ADMIN,
                organizationId: "org-owning",
                id: "document-1",
                staleValues: VECTOR_VALUES,
                currentValues: REPLACEMENT_VALUES,
                action: "observe",
                afterSequence: expect.any(Number),
                values: REPLACEMENT_VALUES,
            },
            {
                origin: "https://proof.example.com",
                admin: ADMIN,
                organizationId: "org-owning",
                id: "document-1",
                staleValues: VECTOR_VALUES,
                currentValues: REPLACEMENT_VALUES,
                action: "cursor",
                values: REPLACEMENT_VALUES,
            },
            {
                origin: "https://proof.example.com",
                admin: ADMIN,
                organizationId: "org-owning",
                id: "document-1",
                staleValues: VECTOR_VALUES,
                currentValues: REPLACEMENT_VALUES,
                action: "observe",
                afterSequence: expect.any(Number),
                values: REPLACEMENT_VALUES,
            },
        ]);
    });

    test("passes phase-specific audit values through the real lifecycle HTTP contract", async () => {
        const lifecycle = successfulLifecycle([]);
        const bodies: Array<Record<string, unknown>> = [];
        const realLifecycle = createCloudflareVectorizeProofLifecycle({
            requestTimeoutMs: 50,
            fetch: async (request, init) => {
                const url = request instanceof Request ? new URL(request.url) : new URL(request);
                expect(url.pathname).toBe("/proof/vector-search-audit");
                const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
                bodies.push(body);
                const action = body.action;
                const values = body.values;
                const replacement = Array.isArray(values) && values[0] === 0 && values[1] === 1;
                const sequence = action === "observe" ? Number(body.afterSequence) + 1 : bodies.length;
                return new Response(
                    JSON.stringify({
                        sequence,
                        querySha256: action === "cursor" ? null : HASH_C,
                        candidateSetSha256: action === "cursor" ? null : replacement ? HASH_A : HASH_B,
                        candidateCount: action === "cursor" ? 0 : 1,
                        stalePresent: action === "observe" && !replacement,
                        currentPresent: action === "observe" && replacement,
                        otherCandidateCount: 0,
                    }),
                    { headers: { "content-type": "application/json" } }
                );
            },
        });
        const controller = createCloudflareVectorizeProofController({
            lifecycle: { ...lifecycle, vectorSearchAudit: realLifecycle.vectorSearchAudit } as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await controller.run(controllerInput());

        expect(bodies.slice(-4).map(body => ({ action: body.action, values: body.values }))).toEqual([
            { action: "cursor", values: REPLACEMENT_VALUES },
            { action: "observe", values: REPLACEMENT_VALUES },
            { action: "cursor", values: REPLACEMENT_VALUES },
            { action: "observe", values: REPLACEMENT_VALUES },
        ]);
        expect(bodies.some(body => body.action === "cursor" && Bun.deepEquals(body.values, VECTOR_VALUES))).toBeTrue();
    });

    test("requires an exact-call stale-only public-empty window and resets after an audited current view", async () => {
        const lifecycle = successfulLifecycle([]);
        const search = lifecycle.search.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let firstInjectedPublicSearch = true;
        let classifyFirstObservationAsCurrent = false;
        let clock = 0;
        lifecycle.search = async input => {
            const result = await search(input);
            if (
                firstInjectedPublicSearch &&
                input.principal === OWNER &&
                input.values?.[0] === 1 &&
                input.values?.[1] === 0
            ) {
                firstInjectedPublicSearch = false;
                classifyFirstObservationAsCurrent = true;
                return [{ rowPk: "document-1", score: 0 }];
            }
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (input.action === "observe" && classifyFirstObservationAsCurrent) {
                classifyFirstObservationAsCurrent = false;
                if (input.afterSequence === undefined) throw new Error("test audit cursor is missing");
                return {
                    sequence: input.afterSequence + 1,
                    querySha256: HASH_C,
                    candidateSetSha256: HASH_A,
                    candidateCount: 1,
                    stalePresent: false,
                    currentPresent: true,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        const controller = createProductionCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const report = await controller.run(controllerInput());
        const searchEvidence = report.search as {
            adversarialFiltering: { injected: { publicObservation: Record<string, unknown> } };
        };

        expect(assertCloudflareVectorizeAdversarialFilteringEvidence(searchEvidence.adversarialFiltering)).toBe(
            searchEvidence.adversarialFiltering
        );
        expect(searchEvidence.adversarialFiltering.injected.publicObservation).toMatchObject({
            attempts: 12,
            staleEmptyObservationCount: 11,
            stableEmptyCount: 11,
            previousCurrentViewCount: 1,
            mixedCurrentResetCount: 0,
            providerMissCount: 0,
            transientFailureCount: 0,
            stabilityResetCount: 0,
            stabilityWindowMs: 10_000,
            stabilityObservedMs: 10_000,
            observationIntervalMs: 1_000,
            hardBoundClaimed: false,
        });
        expect(clock).toBe(11_000);
    });

    test("restarts the stale-only window after an exact-current mixed provider view", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutateVectorAdversary = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const search = lifecycle.search.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let adversaryApplied = false;
        let injectedSearchCount = 0;
        let mixedAuditPending = false;
        let clock = 0;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutateVectorAdversary(input);
            if (input.action === "apply") adversaryApplied = true;
            return result;
        };
        lifecycle.search = async input => {
            const result = await search(input);
            if (adversaryApplied && input.principal === OWNER && input.values?.[0] === 1 && input.values?.[1] === 0) {
                injectedSearchCount++;
                if (injectedSearchCount === 4) {
                    mixedAuditPending = true;
                    return [{ rowPk: "document-1", score: 0 }];
                }
            }
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (input.action === "observe" && mixedAuditPending) {
                mixedAuditPending = false;
                if (input.afterSequence === undefined) throw new Error("test audit cursor is missing");
                return {
                    sequence: input.afterSequence + 1,
                    querySha256: HASH_C,
                    candidateSetSha256: HASH_A,
                    candidateCount: 2,
                    stalePresent: true,
                    currentPresent: true,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        const controller = createProductionCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const report = await controller.run(controllerInput());
        const searchEvidence = report.search as {
            adversarialFiltering: { injected: { publicObservation: Record<string, unknown> } };
        };

        expect(searchEvidence.adversarialFiltering.injected.publicObservation).toMatchObject({
            attempts: 15,
            staleEmptyObservationCount: 14,
            stableEmptyCount: 11,
            previousCurrentViewCount: 0,
            mixedCurrentResetCount: 1,
            providerMissCount: 0,
            transientFailureCount: 0,
            stabilityResetCount: 1,
            stabilityObservedMs: 10_000,
        });
        expect(clock).toBe(14_000);
    });

    test("rejects mixed provider views that do not prove one exact current row", async () => {
        for (const scenario of [
            {
                matches: [{ rowPk: "document-1", score: 0 }],
                audit: { candidateCount: 3, stalePresent: true, currentPresent: true, otherCandidateCount: 1 },
                message: "public stale-filter audit returned an unrelated candidate",
            },
            {
                matches: [],
                audit: { candidateCount: 2, stalePresent: true, currentPresent: true, otherCandidateCount: 0 },
                message: "public stale-filter mixed provider view did not preserve the exact current row",
            },
            {
                matches: [{ rowPk: "document-1", score: 0 }],
                audit: { candidateCount: 3, stalePresent: true, currentPresent: true, otherCandidateCount: 0 },
                message: "public stale-filter mixed provider view did not preserve the exact current row",
            },
            {
                matches: [{ rowPk: "wrong-document", score: 0 }],
                audit: { candidateCount: 2, stalePresent: true, currentPresent: true, otherCandidateCount: 0 },
                message: "public stale-filter search returned a non-exact result",
            },
        ]) {
            const lifecycle = successfulLifecycle([]);
            const mutateVectorAdversary = lifecycle.mutateVectorAdversary.bind(lifecycle);
            const search = lifecycle.search.bind(lifecycle);
            const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
            let adversaryApplied = false;
            let auditPending = false;
            lifecycle.mutateVectorAdversary = async input => {
                const result = await mutateVectorAdversary(input);
                if (input.action === "apply") adversaryApplied = true;
                return result;
            };
            lifecycle.search = async input => {
                const result = await search(input);
                if (
                    adversaryApplied &&
                    input.principal === OWNER &&
                    input.values?.[0] === 1 &&
                    input.values?.[1] === 0
                ) {
                    auditPending = true;
                    return scenario.matches;
                }
                return result;
            };
            lifecycle.vectorSearchAudit = async input => {
                const result = await vectorSearchAudit(input);
                if (input.action === "observe" && auditPending) {
                    auditPending = false;
                    if (input.afterSequence === undefined) throw new Error("test audit cursor is missing");
                    return {
                        sequence: input.afterSequence + 1,
                        querySha256: HASH_C,
                        candidateSetSha256: HASH_A,
                        ...scenario.audit,
                    };
                }
                return result;
            };
            const controller = createProductionCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => 0,
                sleep: async () => undefined,
                appendOwnedIds: async () => undefined,
                redeploy: async () => ({
                    deploymentId: REDEPLOYMENT_ID,
                    versionId: REDEPLOYED_VERSION_ID,
                    number: 2,
                    percentage: 100,
                }),
                releaseFault: async input => {
                    lifecycle.releaseHeldFault();
                    return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
                },
            });

            await expect(controller.run(controllerInput())).rejects.toThrow(scenario.message);
        }
    });

    test("rejects a mixed provider reset when its exact query identity changed", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutateVectorAdversary = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const search = lifecycle.search.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let adversaryApplied = false;
        let injectedSearchCount = 0;
        let mixedAuditPending = false;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutateVectorAdversary(input);
            if (input.action === "apply") adversaryApplied = true;
            return result;
        };
        lifecycle.search = async input => {
            const result = await search(input);
            if (
                adversaryApplied &&
                input.principal === OWNER &&
                input.values?.[0] === 1 &&
                input.values?.[1] === 0 &&
                ++injectedSearchCount === 2
            ) {
                mixedAuditPending = true;
                return [{ rowPk: "document-1", score: 0 }];
            }
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (input.action === "observe" && mixedAuditPending) {
                mixedAuditPending = false;
                return {
                    ...result,
                    querySha256: HASH_B,
                    candidateSetSha256: HASH_A,
                    candidateCount: 2,
                    stalePresent: true,
                    currentPresent: true,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        const controller = createProductionCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 0,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "public stale-filter audit query identity changed across observations"
        );
    });

    test("fails closed when mixed provider resets exhaust the existing deadline", async () => {
        const lifecycle = successfulLifecycle([], { controllerTimeoutMs: 20 });
        const mutateVectorAdversary = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const search = lifecycle.search.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let adversaryApplied = false;
        let mixedAuditPending = false;
        let clock = 0;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutateVectorAdversary(input);
            if (input.action === "apply") adversaryApplied = true;
            return result;
        };
        lifecycle.search = async input => {
            const result = await search(input);
            if (adversaryApplied && input.principal === OWNER && input.values?.[0] === 1 && input.values?.[1] === 0) {
                mixedAuditPending = true;
                return [{ rowPk: "document-1", score: 0 }];
            }
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (input.action === "observe" && mixedAuditPending) {
                mixedAuditPending = false;
                return {
                    ...result,
                    candidateCount: 2,
                    stalePresent: true,
                    currentPresent: true,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        const controller = createProductionCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run({ ...controllerInput(), timeoutMs: 20 })).rejects.toThrow(
            "public stale-candidate filtering stability timed out after 20ms"
        );
        expect(clock).toBe(20);
    });

    test("restores the current provider record when stale-candidate filtering fails", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        lifecycle.search = async input => {
            events.push(`search-limit:${String(input.limit)}`);
            return [{ rowPk: "document-1", score: 1 }];
        };
        lifecycle.vectorSearchAudit = async input =>
            input.action === "cursor"
                ? {
                      sequence: 0,
                      querySha256: null,
                      candidateSetSha256: null,
                      candidateCount: 0,
                      stalePresent: false,
                      currentPresent: false,
                      otherCandidateCount: 0,
                  }
                : {
                      sequence: 1,
                      querySha256: HASH_C,
                      candidateSetSha256: HASH_B,
                      candidateCount: 1,
                      stalePresent: true,
                      currentPresent: false,
                      otherCandidateCount: 0,
                  };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "public search returned the exact stale physical candidate batch"
        );
        expect(events).toContain("adversary:apply");
        expect(events).toContain("adversary:restore");
        expect(events.indexOf("adversary:apply")).toBeLessThan(events.indexOf("adversary:restore"));
        expect(events).not.toContain("intent:delete");
    });

    test("preserves an apply failure after restoration succeeds", async () => {
        const actions: string[] = [];
        const checkpoints: string[] = [];
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const applyError = new Error("adversary apply failed");
        let restoreCompleted = false;
        lifecycle.mutateVectorAdversary = async input => {
            actions.push(input.action);
            if (input.action === "apply") throw applyError;
            const result = await mutate(input);
            restoreCompleted = true;
            return result;
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            checkpoint: async value => {
                checkpoints.push(value);
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const error = await controller.run(controllerInput()).catch(cause => cause);

        expect(error).toBe(applyError);
        expect(error).not.toBeInstanceOf(AggregateError);
        expect(actions).toEqual(["apply", "restore"]);
        expect(restoreCompleted).toBeTrue();
        expect(checkpoints.at(-1)).toBe("adversary-restore");
        expect(checkpoints).not.toContain("adversary-policy");
    });

    test("returns the restoration failure when adversary apply succeeds", async () => {
        const actions: string[] = [];
        const checkpoints: string[] = [];
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const restoreError = new Error("adversary restore failed");
        lifecycle.mutateVectorAdversary = async input => {
            actions.push(input.action);
            if (input.action === "restore") throw restoreError;
            return mutate(input);
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            checkpoint: async value => {
                checkpoints.push(value);
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const error = await controller.run(controllerInput()).catch(cause => cause);

        expect(error).toBe(restoreError);
        expect(error).not.toBeInstanceOf(AggregateError);
        expect(actions).toEqual(["apply", "restore"]);
        expect(checkpoints).not.toContain("adversary-policy");
    });

    test("restores and verifies the provider after the restoration checkpoint fails", async () => {
        const actions: string[] = [];
        const checkpoints: string[] = [];
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const query = lifecycle.queryVectorAdversary.bind(lifecycle);
        const checkpointError = new Error("adversary restore checkpoint failed");
        let restoreCompleted = false;
        let postRestoreQueries = 0;
        lifecycle.mutateVectorAdversary = async input => {
            actions.push(input.action);
            const result = await mutate(input);
            if (input.action === "restore") restoreCompleted = true;
            return result;
        };
        lifecycle.queryVectorAdversary = async () => {
            if (restoreCompleted) postRestoreQueries++;
            return query();
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            checkpoint: async value => {
                checkpoints.push(value);
                if (value === "adversary-restore") throw checkpointError;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const error = await controller.run(controllerInput()).catch(cause => cause);

        expect(error).toBe(checkpointError);
        expect(actions).toEqual(["apply", "restore"]);
        expect(restoreCompleted).toBeTrue();
        expect(postRestoreQueries).toBeGreaterThan(0);
        expect(checkpoints.at(-1)).toBe("adversary-restore");
        expect(checkpoints).not.toContain("adversary-policy");
    });

    test("waits for the restored current record to converge through the public owner search", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const search = lifecycle.search.bind(lifecycle);
        let restored = false;
        let restoredOwnerSearches = 0;
        let ownerAuditOverride: "stale" | "miss" | null = null;
        let clock = 0;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutate(input);
            if (input.action === "restore") restored = true;
            return result;
        };
        lifecycle.search = async input => {
            if (restored && input.principal === OWNER && input.values?.[1] === 1) {
                restoredOwnerSearches++;
                if (restoredOwnerSearches === 1) {
                    await search(input);
                    ownerAuditOverride = "stale";
                    return [];
                }
                if (restoredOwnerSearches === 2) {
                    await search(input);
                    ownerAuditOverride = "miss";
                    return [];
                }
                if (restoredOwnerSearches === 3) {
                    throw new CloudflareVectorizeProofHttpError(
                        "restored public owner search returned HTTP 503",
                        503,
                        "CDB_ROUTE_UNAVAILABLE"
                    );
                }
            }
            return search(input);
        };
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (input.action === "observe" && ownerAuditOverride !== null) {
                const override = ownerAuditOverride;
                ownerAuditOverride = null;
                if (input.afterSequence === undefined) throw new Error("test audit cursor is missing");
                return {
                    sequence: input.afterSequence + 1,
                    querySha256: HASH_C,
                    candidateSetSha256: override === "stale" ? HASH_A : HASH_B,
                    candidateCount: override === "stale" ? 1 : 0,
                    stalePresent: override === "stale",
                    currentPresent: false,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const report = await controller.run(controllerInput());

        expect(report).toMatchObject({
            health: { ok: true },
            search: {
                adversarialFiltering: {
                    restore: {
                        publicOwnerObservation: {
                            elapsedMs: 30,
                            attempts: 4,
                            emptyReadCount: 1,
                            staleFilteredReadCount: 1,
                            mixedCurrentReadCount: 0,
                            transientFailureCount: 1,
                            hardBoundClaimed: false,
                        },
                    },
                },
            },
        });
        expect(restoredOwnerSearches).toBeGreaterThan(2);
    });

    test("rejects a stale restored candidate when it escapes the public policy filter", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let restored = false;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutate(input);
            if (input.action === "restore") restored = true;
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (restored && input.action === "observe") {
                return {
                    sequence: result.sequence,
                    querySha256: HASH_C,
                    candidateSetSha256: HASH_B,
                    candidateCount: 1,
                    stalePresent: true,
                    currentPresent: false,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "restored public owner search exposed the stale physical candidate"
        );
    });

    test("retries a mixed restored view and requires exact current-only convergence", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let restored = false;
        let restoredObservationCount = 0;
        let clock = 0;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutate(input);
            if (input.action === "restore") restored = true;
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (restored && input.action === "observe" && restoredObservationCount++ === 0) {
                return {
                    sequence: result.sequence,
                    querySha256: HASH_C,
                    candidateSetSha256: HASH_B,
                    candidateCount: 2,
                    stalePresent: true,
                    currentPresent: true,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const report = await controller.run(controllerInput());
        const searchEvidence = report.search as {
            adversarialFiltering: { restore: { publicOwnerObservation: Record<string, unknown> } };
        };
        expect(searchEvidence.adversarialFiltering.restore.publicOwnerObservation).toMatchObject({
            attempts: 2,
            mixedCurrentReadCount: 1,
            staleFilteredReadCount: 0,
            emptyReadCount: 0,
            transientFailureCount: 0,
        });
        expect(restoredObservationCount).toBeGreaterThanOrEqual(2);
        expect(clock).toBe(10);
    });

    test("rejects an unrelated restored candidate without retrying", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let restored = false;
        let restoredObservationCount = 0;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutate(input);
            if (input.action === "restore") restored = true;
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (restored && input.action === "observe") {
                restoredObservationCount++;
                return {
                    sequence: result.sequence,
                    querySha256: HASH_C,
                    candidateSetSha256: HASH_B,
                    candidateCount: 2,
                    stalePresent: false,
                    currentPresent: true,
                    otherCandidateCount: 1,
                };
            }
            return result;
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "restored public owner audit returned an unrelated candidate"
        );
        expect(restoredObservationCount).toBe(1);
    });

    test("rejects a changed query identity while restored candidates converge", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const search = lifecycle.search.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let restored = false;
        let restoredOwnerSearches = 0;
        let staleAuditPending = false;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutate(input);
            if (input.action === "restore") restored = true;
            return result;
        };
        lifecycle.search = async input => {
            const result = await search(input);
            if (restored && input.principal === OWNER && input.values?.[1] === 1) {
                restoredOwnerSearches++;
                if (restoredOwnerSearches === 1) {
                    staleAuditPending = true;
                    return [];
                }
            }
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (input.action !== "observe") return result;
            if (staleAuditPending) {
                staleAuditPending = false;
                return {
                    sequence: result.sequence,
                    querySha256: HASH_C,
                    candidateSetSha256: HASH_A,
                    candidateCount: 1,
                    stalePresent: true,
                    currentPresent: false,
                    otherCandidateCount: 0,
                };
            }
            if (restored && restoredOwnerSearches > 1) {
                return {
                    sequence: result.sequence,
                    querySha256: HASH_B,
                    candidateSetSha256: HASH_A,
                    candidateCount: 1,
                    stalePresent: false,
                    currentPresent: true,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        let clock = 0;
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "restored public owner audit query identity changed across observations"
        );
        expect(restoredOwnerSearches).toBe(2);
    });

    test("fails closed when policy-filtered stale restoration exhausts the existing deadline", async () => {
        const lifecycle = successfulLifecycle([], { controllerTimeoutMs: 20 });
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const search = lifecycle.search.bind(lifecycle);
        const vectorSearchAudit = lifecycle.vectorSearchAudit.bind(lifecycle);
        let restored = false;
        let staleAuditPending = false;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutate(input);
            if (input.action === "restore") restored = true;
            return result;
        };
        lifecycle.search = async input => {
            const result = await search(input);
            if (restored && input.principal === OWNER && input.values?.[1] === 1) {
                staleAuditPending = true;
                return [];
            }
            return result;
        };
        lifecycle.vectorSearchAudit = async input => {
            const result = await vectorSearchAudit(input);
            if (input.action === "observe" && staleAuditPending) {
                staleAuditPending = false;
                return {
                    sequence: result.sequence,
                    querySha256: HASH_C,
                    candidateSetSha256: HASH_A,
                    candidateCount: 1,
                    stalePresent: true,
                    currentPresent: false,
                    otherCandidateCount: 0,
                };
            }
            return result;
        };
        let clock = 0;
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run({ ...controllerInput(), timeoutMs: 20 })).rejects.toThrow(
            "restored public owner search timed out after 20ms"
        );
        expect(clock).toBe(20);
    });

    test("rejects a non-exact restored public result instead of retrying it as convergence", async () => {
        const lifecycle = successfulLifecycle([]);
        const mutate = lifecycle.mutateVectorAdversary.bind(lifecycle);
        const search = lifecycle.search.bind(lifecycle);
        let restored = false;
        let wrongResultCount = 0;
        lifecycle.mutateVectorAdversary = async input => {
            const result = await mutate(input);
            if (input.action === "restore") restored = true;
            return result;
        };
        lifecycle.search = async input => {
            if (restored && input.principal === OWNER && input.values?.[1] === 1) {
                wrongResultCount++;
                await search(input);
                return [
                    { rowPk: "document-1", score: 1 },
                    { rowPk: "wrong-document", score: 0.5 },
                ];
            }
            return search(input);
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "restored public owner search returned a non-exact result"
        );
        expect(wrongResultCount).toBe(1);
    });

    test("preserves both failures when adversary apply and restore fail", async () => {
        const lifecycle = successfulLifecycle([]);
        const applyError = new Error("adversary apply failed");
        const restoreError = new Error("adversary restore failed");
        lifecycle.mutateVectorAdversary = async input => {
            throw input.action === "apply" ? applyError : restoreError;
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const error = await controller.run(controllerInput()).catch(cause => cause);

        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toBe("vector adversary execution and restoration failed");
        expect(error.errors).toHaveLength(2);
        expect(error.errors[0]).toBe(applyError);
        expect(error.errors[1]).toBe(restoreError);
    });

    test("aborts the SDK session and stops before release when live content appears during the gate", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const openLive = lifecycle.openLiveVectorSubscription;
        let aborted = false;
        lifecycle.openLiveVectorSubscription = async input => {
            const session = await openLive(input);
            return {
                ...session,
                assertPending() {
                    throw new Error("live replacement became visible while provider delivery was pending");
                },
                abort() {
                    aborted = true;
                    session.abort();
                },
            };
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "live replacement became visible while provider delivery was pending"
        );
        expect(aborted).toBeTrue();
        expect(events).not.toContain("alarm:live-upsert-loss");
        expect(events).not.toContain("mutate:live-delete");
        expect(events).not.toContain("measure:deployed-cloudflare-vectorize");
    });

    test("records the complete deployed lifecycle before lazily loading the comparison", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        let deployedEvidence: Record<string, unknown> | undefined;
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            checkpoint: async value => {
                events.push(`checkpoint:${value}`);
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
            recordDeployedLifecycle: async evidence => {
                events.push("record-deployed-lifecycle");
                deployedEvidence = evidence;
            },
            loadComparisonBenchmark: async () => {
                events.push("load-comparison");
                throw new Error("local remote comparison failed");
            },
        });
        const input = controllerInput();

        await expect(
            controller.run({
                ...input,
                benchmark: { workloadId: input.benchmark.workloadId, localFake: input.benchmark.localFake },
            })
        ).rejects.toThrow("local remote comparison failed");

        expect(events.indexOf("checkpoint:delete-readiness")).toBeLessThan(
            events.indexOf("checkpoint:deployed-lifecycle")
        );
        expect(events.indexOf("checkpoint:deployed-lifecycle")).toBeLessThan(
            events.indexOf("record-deployed-lifecycle")
        );
        expect(events.indexOf("record-deployed-lifecycle")).toBeLessThan(events.indexOf("load-comparison"));
        expect(events).not.toContain("checkpoint:complete");
        expect(deployedEvidence).toMatchObject({
            lifecycle: { workerRedeployDuringLease: true },
            deletion: { absent: true },
            deployedBenchmark: {
                track: {
                    label: "deployed-cloudflare-vectorize",
                    runtime: "cloudflare-workers",
                    backend: "cloudflare-vectorize",
                    realVectorize: true,
                },
            },
        });
    });

    test("uses only alarm-owned state transitions", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => {
                return {
                    deploymentId: REDEPLOYMENT_ID,
                    versionId: REDEPLOYED_VERSION_ID,
                    number: 2,
                    percentage: 100,
                } as const;
            },
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });
        await expect(controller.run(controllerInput())).resolves.toMatchObject({
            redeploy: { workerRedeployDuringLease: true, eventualCompletion: true },
        });
        expect("maintain" in lifecycle).toBe(false);
        expect(events).toContain("alarm:delete-loss");
    });

    test("preserves logical delivery evidence when the lease is reclaimed during redeploy", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const vectorState = lifecycle.vectorState;
        let now = 100;
        let redeployed = false;
        let released = false;
        let releaseCalls = 0;
        lifecycle.vectorState = async input => {
            if (!redeployed || released) return vectorState(input);
            const held = heldState();
            if (!held.outbox) throw new Error("held test state lost its vector outbox");
            return state({
                outbox: {
                    ...held.outbox,
                    attempts: 2,
                    leased: false,
                    claimTokenSha256: null,
                    leasedUntil: null,
                },
                fault: held.fault as GatedFault,
            });
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => now,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async input => {
                expect(input.claim).toMatchObject({
                    claimTokenSha256: HASH_A,
                    targetVersion: 2,
                    attempts: 1,
                    physicalIds: [ID_2],
                    payloadSha256: HASH_A,
                });
                redeployed = true;
                now = 40_000;
                return {
                    deploymentId: REDEPLOYMENT_ID,
                    versionId: REDEPLOYED_VERSION_ID,
                    number: 2,
                    percentage: 100,
                };
            },
            releaseFault: async input => {
                releaseCalls++;
                if (releaseCalls === 1) {
                    expect(input.state.outbox).toMatchObject({ leased: false, claimTokenSha256: null, attempts: 2 });
                    expect(now).toBeGreaterThan(30_000);
                    released = true;
                }
                lifecycle.releaseHeldFault();
                if (releaseCalls === 1) now = 100;
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).resolves.toMatchObject({
            redeploy: {
                workerRedeployDuringLease: true,
                maintainPendingAcrossRedeploy: true,
                sameLogicalIntentAcrossRedeploy: true,
                leaseStateAfterRedeploy: "unleased",
                claimReclaimedAcrossRedeploy: false,
                eventualCompletion: true,
            },
        });
    });

    test("rejects post-redeploy acceptance or replacement-state drift before gate release", async () => {
        const cases: readonly {
            readonly message: string;
            readonly project: (held: VectorProofState) => VectorProofState;
        }[] = [
            {
                message: "vector head identity changed across redeploy",
                project: held => {
                    if (!held.head) throw new Error("held test state lost its vector head");
                    return state({
                        head: { ...held.head, deliveredVersion: 2 },
                        outbox: held.outbox,
                        fault: held.fault as GatedFault,
                        acceptances: held.acceptances,
                    });
                },
            },
            {
                message: "vector claim was accepted before redeploy continuity was checked",
                project: held => {
                    if (!held.outbox) throw new Error("held test state lost its vector outbox");
                    return state({
                        head: held.head,
                        outbox: { ...held.outbox, mutationIdSha256: HASH_B, acceptedAt: 200 },
                        fault: held.fault as GatedFault,
                        acceptances: held.acceptances,
                    });
                },
            },
            {
                message: "post-redeploy upsert fault is not in its pre-acceptance state",
                project: held =>
                    state({
                        head: held.head,
                        outbox: held.outbox,
                        fault: fault("upsert_accept_then_throw", {
                            ...(held.fault as GatedFault),
                            retryCount: 1,
                            retryIdsMatched: true,
                            retryPayloadMatched: true,
                        }),
                        acceptances: held.acceptances,
                    }),
            },
            {
                message: "post-redeploy upsert replacement was already accepted",
                project: held =>
                    state({
                        head: held.head,
                        outbox: held.outbox,
                        fault: held.fault as GatedFault,
                        acceptances: [
                            ...held.acceptances,
                            {
                                operation: "upsert",
                                physicalId: ID_2,
                                payloadSha256: HASH_A,
                                mutationIdSha256: HASH_B,
                                acceptedAt: 200,
                            },
                        ],
                    }),
            },
        ];

        for (const item of cases) {
            const lifecycle = successfulLifecycle([]);
            const vectorState = lifecycle.vectorState;
            let redeployed = false;
            lifecycle.vectorState = async input => (redeployed ? item.project(heldState()) : await vectorState(input));
            const controller = createCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => 100,
                sleep: async () => undefined,
                appendOwnedIds: async () => undefined,
                redeploy: async () => {
                    redeployed = true;
                    return {
                        deploymentId: REDEPLOYMENT_ID,
                        versionId: REDEPLOYED_VERSION_ID,
                        number: 2,
                        percentage: 100,
                    };
                },
                releaseFault: async () => {
                    throw new Error("fault release must not run after continuity drift");
                },
            });
            await expect(controller.run(controllerInput())).rejects.toThrow(item.message);
        }
    });

    test("waits for an alarm to reclaim a released gate after the original holder is lost", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const vectorState = lifecycle.vectorState;
        let released = false;
        let recoveryPolls = 0;
        lifecycle.vectorState = async input => {
            if (!released) return vectorState(input);
            recoveryPolls++;
            if (recoveryPolls === 1) {
                const held = heldState();
                return state({
                    outbox: held.outbox,
                    fault: fault("upsert_accept_then_throw", {
                        armed: true,
                        inFlight: true,
                        fired: false,
                        acceptedBeforeThrow: false,
                        retryCount: 0,
                        retryIdsMatched: null,
                        retryPayloadMatched: null,
                        retryComplete: false,
                        gateOpen: true,
                        gateDeadline: 15_000,
                    }),
                });
            }
            if (recoveryPolls === 2) {
                return state({
                    fault: fault("upsert_accept_then_throw", { retryComplete: false, retryCount: 0 }),
                    outbox: {
                        targetVersion: 2,
                        operation: "upsert",
                        phase: "submit",
                        mutationIdSha256: null,
                        acceptedAt: null,
                        attempts: 2,
                        nextAttemptAt: 1_000,
                        leased: false,
                        claimTokenSha256: null,
                        leasedUntil: null,
                        terminalFailure: false,
                        lastErrorClassification: null,
                        lastErrorSha256: null,
                    },
                });
            }
            return vectorState(input);
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                released = true;
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).resolves.toMatchObject({
            redeploy: { workerRedeployDuringLease: true, eventualCompletion: true },
        });
        expect(recoveryPolls).toBeGreaterThanOrEqual(2);
    });

    test("fails each deterministic last-error hash diagnostic on the direct post-redeploy state read", async () => {
        for (const code of [
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_FAILED",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_INPUT_INVALID",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_DIGEST_FAILED",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_OUTPUT_INVALID",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_HEX_INVALID",
        ]) {
            const lifecycle = successfulLifecycle([]);
            const vectorState = lifecycle.vectorState;
            let redeployed = false;
            let released = false;
            let hashFailures = 0;
            let releaseCalls = 0;
            lifecycle.vectorState = async input => {
                if (redeployed && !released && hashFailures === 0) {
                    hashFailures++;
                    throw new CloudflareVectorizeProofHttpError("bounded read-only hash failure", 500, code, "http");
                }
                return vectorState(input);
            };
            const controller = createCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => 100,
                sleep: async () => undefined,
                appendOwnedIds: async () => undefined,
                redeploy: async () => {
                    redeployed = true;
                    return {
                        deploymentId: REDEPLOYMENT_ID,
                        versionId: REDEPLOYED_VERSION_ID,
                        number: 2,
                        percentage: 100,
                    };
                },
                releaseFault: async input => {
                    releaseCalls++;
                    released = true;
                    lifecycle.releaseHeldFault();
                    return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
                },
            });

            await expect(controller.run(controllerInput())).rejects.toMatchObject({ status: 500, code, kind: "http" });
            expect(hashFailures).toBe(1);
            expect(releaseCalls).toBe(0);
        }
    });

    test("recovers transient 5xx and timeout failures while polling read-only response-loss state", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const vectorState = lifecycle.vectorState;
        let clock = 0;
        let released = false;
        let transientFailures = 0;
        const transientHttpFailures = [
            { status: 500, code: "CDB_PROOF_VECTOR_STATE_RPC_FAILED" },
            { status: 503, code: null },
            { status: 502, code: "EDGE_UNAVAILABLE" },
        ];
        lifecycle.vectorState = async input => {
            if (released && transientFailures < 5) {
                transientFailures++;
                if (transientFailures === 1) {
                    throw new CloudflareVectorizeProofHttpError(
                        "vector proof state returned HTTP 503",
                        503,
                        "CDB_PROOF_VECTOR_STATE_ROUTE_FAILED",
                        "http"
                    );
                }
                if (transientFailures === 2) {
                    throw new CloudflareVectorizeProofHttpError("timeout wording is irrelevant", null, null, "timeout");
                }
                throw new CloudflareVectorizeProofHttpError(
                    "bounded read-only HTTP failure",
                    transientHttpFailures[transientFailures - 3]?.status ?? 500,
                    transientHttpFailures[transientFailures - 3]?.code ?? null,
                    "http"
                );
            }
            return vectorState(input);
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                released = true;
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).resolves.toMatchObject({
            redeploy: { workerRedeployDuringLease: true, eventualCompletion: true },
            delivery: { upsertResponseLoss: { acceptedBeforeThrow: true } },
        });
        expect(transientFailures).toBe(5);
        expect(clock).toBe(50);
        expect(events.filter(event => event === "mutate:replace")).toHaveLength(1);
    });

    test("bounds recovery at every direct vector-state observation without replaying writes", async () => {
        const cases = [
            {
                boundary: "post-redeploy",
                status: 500,
                code: "CDB_PROOF_VECTOR_STATE_ROUTE_FAILED",
                kind: "http",
            },
            {
                boundary: "upsert-evidence",
                status: 500,
                code: "CDB_PROOF_VECTOR_STATE_RPC_FAILED",
                kind: "http",
            },
            {
                boundary: "delete-evidence",
                status: null,
                code: null,
                kind: "timeout",
            },
        ] as const;

        for (const item of cases) {
            const events: string[] = [];
            const lifecycle = successfulLifecycle(events);
            const vectorState = lifecycle.vectorState;
            const pollReady = lifecycle.pollReady;
            const pollDeleted = lifecycle.pollDeleted;
            let clock = 0;
            let observeBoundary = false;
            let boundaryReadAttempts = 0;
            let redeployAttempts = 0;
            let releaseAttempts = 0;

            lifecycle.pollReady = async input => {
                const result = await pollReady(input);
                if (item.boundary === "upsert-evidence" && input.vectorId === VECTOR_ID && input.version === 2) {
                    observeBoundary = true;
                }
                return result;
            };
            lifecycle.pollDeleted = async input => {
                const result = await pollDeleted(input);
                if (item.boundary === "delete-evidence" && input.vectorId === VECTOR_ID) observeBoundary = true;
                return result;
            };
            lifecycle.vectorState = async input => {
                if (input.vectorId !== VECTOR_ID) return vectorState(input);
                if (!observeBoundary) return vectorState(input);
                boundaryReadAttempts++;
                if (boundaryReadAttempts === 1) {
                    throw new CloudflareVectorizeProofHttpError(
                        "bounded direct vector-state read failed",
                        item.status,
                        item.code,
                        item.kind
                    );
                }
                observeBoundary = false;
                return vectorState(input);
            };

            const controller = createCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => clock,
                sleep: async milliseconds => {
                    clock += milliseconds;
                },
                appendOwnedIds: async () => undefined,
                redeploy: async () => {
                    redeployAttempts++;
                    if (item.boundary === "post-redeploy") observeBoundary = true;
                    return {
                        deploymentId: REDEPLOYMENT_ID,
                        versionId: REDEPLOYED_VERSION_ID,
                        number: 2,
                        percentage: 100,
                    };
                },
                releaseFault: async input => {
                    releaseAttempts++;
                    lifecycle.releaseHeldFault();
                    return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
                },
            });

            await expect(controller.run(controllerInput())).resolves.toMatchObject({
                redeploy: { workerRedeployDuringLease: true, eventualCompletion: true },
                deletion: { absent: true },
            });
            expect(boundaryReadAttempts).toBe(2);
            expect(clock).toBe(10);
            expect(redeployAttempts).toBe(1);
            expect(releaseAttempts).toBe(2);
            expect(events.filter(event => event.startsWith("mutate:"))).toEqual([
                "mutate:create",
                "mutate:replace",
                "mutate:live-create",
                "mutate:live-replace",
                "mutate:live-delete",
                "mutate:delete",
            ]);
            expect(events.filter(event => event === "alarm:delete-loss")).toHaveLength(1);
        }
    });

    test("bounds persistent read-only state timeouts and preserves the final HTTP evidence", async () => {
        const events: string[] = [];
        const checkpoints: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const vectorState = lifecycle.vectorState;
        const proveNamespaceIsolation = lifecycle.proveNamespaceIsolation;
        lifecycle.proveNamespaceIsolation = input => proveNamespaceIsolation({ ...input, timeoutMs: 20_000 });
        let clock = 0;
        let released = false;
        let readAttempts = 0;
        lifecycle.vectorState = async input => {
            if (!released) return vectorState(input);
            readAttempts++;
            throw new CloudflareVectorizeProofHttpError("state deadline expired", null, null, "timeout");
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            checkpoint: async value => {
                checkpoints.push(value);
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                released = true;
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });
        const error = await controller
            .run({ ...controllerInput(), timeoutMs: 25, intervalMs: 10 })
            .catch(cause => cause);

        expect(error).toBeInstanceOf(CloudflareVectorizeProofHttpError);
        expect(error).toMatchObject({ message: "state deadline expired", status: null, code: null, kind: "timeout" });
        expect(readAttempts).toBe(4);
        expect(clock).toBe(25);
        expect(checkpoints.at(-1)).toBe("replace-response-loss");
        expect(events.filter(event => event === "mutate:replace")).toHaveLength(1);
        expect(events).not.toContain("mutate:delete");
    });

    test("preserves the last passive state when delete response-loss observation expires", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const readVectorState = lifecycle.vectorState;
        const proveNamespaceIsolation = lifecycle.proveNamespaceIsolation;
        lifecycle.proveNamespaceIsolation = input => proveNamespaceIsolation({ ...input, timeoutMs: 20_000 });
        let clock = 0;
        let observingDeleteLoss = false;
        const checkpoints: string[] = [];
        const stalled = {
            ...state({
                head: {
                    organizationId: "org-owning",
                    resourceId: `vr1_${"c".repeat(64)}`,
                    rowPk: "document-1",
                    version: 3,
                    deliveredVersion: 2,
                    state: "deleting",
                },
                fault: fault("delete_accept_then_throw", {
                    armed: true,
                    inFlight: false,
                    fired: false,
                    acceptedBeforeThrow: false,
                    retryCount: 0,
                    retryIdsMatched: null,
                    retryPayloadMatched: null,
                    retryComplete: false,
                }),
            }),
            observedAt: 1_000,
            scheduledAlarmAt: 1_250,
        } satisfies VectorProofState;
        lifecycle.vectorState = input => (observingDeleteLoss ? Promise.resolve(stalled) : readVectorState(input));
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            checkpoint: async checkpoint => {
                checkpoints.push(checkpoint);
                if (checkpoint === "delete-response-loss") observingDeleteLoss = true;
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                lifecycle.releaseHeldFault();
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        const error = await controller
            .run({ ...controllerInput(), timeoutMs: 25, intervalMs: 10 })
            .catch(cause => cause);
        expect(error).toBeInstanceOf(CloudflareVectorizeProofObservationTimeoutError);
        expect(error).toMatchObject({
            message: "accepted delete response loss timed out after 25ms",
            evidence: {
                label: "accepted delete response loss",
                timeoutMs: 25,
                elapsedMs: 25,
                latestState: {
                    vectorId: VECTOR_ID,
                    observedAt: 1_000,
                    scheduledAlarmAt: 1_250,
                    fault: { armed: true, fired: false, acceptedBeforeThrow: false },
                },
            },
        });
        expect(clock).toBe(25);
        expect(checkpoints.slice(-2)).toEqual(["delete-alarm-wait", "delete-response-loss"]);
        expect(events.filter(event => event === "alarm:delete-loss")).toHaveLength(0);
    });

    test("rejects malformed or extended observation timeout evidence", () => {
        const validState = state({});
        expect(() =>
            assertCloudflareVectorizeProofObservationTimeoutEvidence({
                label: "accepted delete response loss",
                timeoutMs: 25,
                elapsedMs: 25,
                latestState: { ...validState, scheduledAlarmAt: -1 },
            })
        ).toThrow("vector scheduled alarm time is invalid");
        expect(() =>
            assertCloudflareVectorizeProofObservationTimeoutEvidence({
                label: "accepted delete response loss",
                timeoutMs: 25,
                elapsedMs: 25,
                latestState: validState,
                detail: "must not pass",
            })
        ).toThrow("proof observation timeout evidence fields are invalid");
    });

    test("does not retry vector-state 404, deterministic diagnostics, malformed, or non-timeout failed reads", async () => {
        const failures = [
            new CloudflareVectorizeProofHttpError("vector proof state returned HTTP 404", 404, "NOT_FOUND", "http"),
            new CloudflareVectorizeProofHttpError("vector proof state returned HTTP 401", 401, "AUTH_DENIED", "http"),
            new CloudflareVectorizeProofHttpError(
                "vector proof state response JSON failed",
                500,
                "CDB_PROOF_VECTOR_STATE_RESPONSE_JSON_FAILED",
                "http"
            ),
            ...[
                "CDB_PROOF_VECTOR_STATE_HEAD_READ_FAILED",
                "CDB_PROOF_VECTOR_STATE_OUTBOX_READ_FAILED",
                "CDB_PROOF_VECTOR_STATE_ATTEMPTS_READ_FAILED",
                "CDB_PROOF_VECTOR_STATE_ACCEPTANCES_READ_FAILED",
                "CDB_PROOF_VECTOR_STATE_FAULT_READ_FAILED",
            ].map(code => new CloudflareVectorizeProofHttpError("bounded SQL scalar failure", 500, code, "http")),
            ...[
                "CDB_PROOF_VECTOR_STATE_OUTBOX_SCALARS_INVALID",
                "CDB_PROOF_VECTOR_STATE_OUTBOX_OPERATION_PHASE_INVALID",
                "CDB_PROOF_VECTOR_STATE_LEASE_IDENTITY_INVALID",
                "CDB_PROOF_VECTOR_STATE_OUTBOX_PHASE_IDENTITY_INVALID",
                "CDB_PROOF_VECTOR_STATE_OUTBOX_TERMINAL_SHAPE_INVALID",
            ].map(code => new CloudflareVectorizeProofHttpError("bounded v17 outbox failure", 500, code, "http")),
            ...[
                "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_NULLISH_INVALID",
                "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TEXT_INVALID",
                "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_BLOB_INVALID",
                "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_TYPE_INVALID",
                "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_INTEGER_INVALID",
                "CDB_PROOF_VECTOR_STATE_TERMINAL_FLAG_RANGE_INVALID",
            ].map(
                code => new CloudflareVectorizeProofHttpError("bounded v15 terminal flag failure", 500, code, "http")
            ),
            ...[
                "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_TYPE_INVALID",
                "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_ID_INVALID",
                "CDB_PROOF_VECTOR_STATE_ACCEPTANCE_VECTOR_ID_MISMATCH",
            ].map(
                code =>
                    new CloudflareVectorizeProofHttpError("bounded v14 acceptance identity failure", 500, code, "http")
            ),
            ...[
                "CDB_PROOF_VECTOR_STATE_FAULT_IDS_TYPE_INVALID",
                "CDB_PROOF_VECTOR_STATE_FAULT_IDS_JSON_INVALID",
                "CDB_PROOF_VECTOR_STATE_FAULT_IDS_SHAPE_INVALID",
                "CDB_PROOF_VECTOR_STATE_FAULT_ID_INVALID",
            ].map(
                code => new CloudflareVectorizeProofHttpError("bounded v13 fault evidence failure", 500, code, "http")
            ),
            ...[
                "CDB_PROOF_VECTOR_STATE_ALARM_READ_FAILED",
                "CDB_PROOF_VECTOR_STATE_ALARM_TIMESTAMP_INVALID",
                "CDB_PROOF_VECTOR_STATE_LAST_ERROR_CLASSIFICATION_FAILED",
                "CDB_PROOF_VECTOR_STATE_CLOCK_FAILED",
                "CDB_PROOF_VECTOR_STATE_STATE_ASSEMBLY_FAILED",
                "CDB_PROOF_VECTOR_STATE_RESULT_WRAP_FAILED",
            ].map(code => new CloudflareVectorizeProofHttpError("bounded state projection failure", 500, code, "http")),
            new CloudflareVectorizeProofHttpError("vector state payload is malformed", null, null, "protocol"),
            new CloudflareVectorizeProofHttpError("network timed out", null, null, "network"),
        ];
        for (const failure of failures) {
            const lifecycle = successfulLifecycle([]);
            const vectorState = lifecycle.vectorState;
            let released = false;
            let readAttempts = 0;
            lifecycle.vectorState = async input => {
                if (!released) return vectorState(input);
                readAttempts++;
                throw failure;
            };
            const controller = createCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => 100,
                sleep: async () => {
                    throw new Error("non-transient state failure must not sleep");
                },
                appendOwnedIds: async () => undefined,
                redeploy: async () => ({
                    deploymentId: REDEPLOYMENT_ID,
                    versionId: REDEPLOYED_VERSION_ID,
                    number: 2,
                    percentage: 100,
                }),
                releaseFault: async input => {
                    lifecycle.releaseHeldFault();
                    released = true;
                    return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
                },
            });

            expect(await controller.run(controllerInput()).catch(cause => cause)).toBe(failure);
            expect(readAttempts).toBe(1);
        }
    });

    test("never retries mutations, including the health-only 404", async () => {
        const dependencies = (lifecycle: ReturnType<typeof successfulLifecycle>, sleep: () => Promise<void>) => ({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100 as const,
            }),
            releaseFault: async (input: { claim: { gateDeadline: number } }) => {
                lifecycle.releaseHeldFault();
                return { released: true as const, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        for (const action of ["create", "replace", "delete"] as const) {
            const lifecycle = successfulLifecycle([]);
            const mutateVector = lifecycle.mutateVector;
            const status = action === "create" ? 404 : action === "replace" ? 500 : 503;
            const code =
                action === "create"
                    ? "NOT_FOUND"
                    : action === "replace"
                      ? "CDB_PROOF_VECTOR_STATE_ROUTE_FAILED"
                      : "EDGE_UNAVAILABLE";
            const failure = new CloudflareVectorizeProofHttpError(
                `${action} mutation returned HTTP ${status}`,
                status,
                code,
                "http"
            );
            let attempts = 0;
            let sleeps = 0;
            lifecycle.mutateVector = async input => {
                if (input.action !== action) return mutateVector(input);
                attempts++;
                throw failure;
            };
            const controller = createCloudflareVectorizeProofController(
                dependencies(lifecycle, async () => {
                    sleeps++;
                })
            );

            expect(await controller.run(controllerInput()).catch(cause => cause)).toBe(failure);
            expect(attempts).toBe(1);
            expect(sleeps).toBe(0);
        }

        const releaseLifecycle = successfulLifecycle([]);
        const releaseFailure = new CloudflareVectorizeProofHttpError(
            "fault release returned a transient-looking failure",
            500,
            "CDB_PROOF_VECTOR_STATE_ROUTE_FAILED",
            "http"
        );
        let releaseAttempts = 0;
        let releaseSleeps = 0;
        const releaseController = createCloudflareVectorizeProofController({
            ...dependencies(releaseLifecycle, async () => {
                releaseSleeps++;
            }),
            releaseFault: async () => {
                releaseAttempts++;
                throw releaseFailure;
            },
        });

        expect(await releaseController.run(controllerInput()).catch(cause => cause)).toBe(releaseFailure);
        expect(releaseAttempts).toBe(1);
        expect(releaseSleeps).toBe(0);
    });

    test("fails fast when a lost holder clears the released fault without recording acceptance", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const vectorState = lifecycle.vectorState;
        let released = false;
        lifecycle.vectorState = async input => {
            if (!released) return vectorState(input);
            return state({
                fault: fault("upsert_accept_then_throw", {
                    armed: false,
                    inFlight: false,
                    fired: false,
                    acceptedBeforeThrow: false,
                    retryCount: 0,
                    retryIdsMatched: null,
                    retryPayloadMatched: null,
                    retryComplete: false,
                }),
            });
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => ({
                deploymentId: REDEPLOYMENT_ID,
                versionId: REDEPLOYED_VERSION_ID,
                number: 2,
                percentage: 100,
            }),
            releaseFault: async input => {
                released = true;
                return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
            },
        });

        await expect(controller.run(controllerInput())).rejects.toThrow(
            "held upsert fault cleared without proving accepted response loss"
        );
    });

    test("rejects a committed mutation identity that differs from its prior intent", async () => {
        const events: string[] = [];
        const lifecycle = successfulLifecycle(events);
        lifecycle.mutateVector = async input =>
            input.action === "delete" ? { id: "document-1" } : { id: "document-1", vectorId: `vec1_${"e".repeat(64)}` };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            appendOwnedIds: async () => undefined,
            redeploy: async () => {
                throw new Error("redeploy must not run");
            },
            releaseFault: async () => {
                throw new Error("fault release must not run");
            },
        });
        await expect(controller.run(controllerInput())).rejects.toThrow(
            "initial vector mutation identity drifted from its intent"
        );
    });

    test("rejects foreign or incomplete live-delete ids before recording them as proof-owned", async () => {
        for (const [physicalIds, expected] of [
            [[LIVE_ID_2, LIVE_ID_3], "live delete intent contains an unowned physical id"],
            [[LIVE_ID_1], "live delete intent omitted the current physical id"],
        ] as const) {
            const events: string[] = [];
            const lifecycle = successfulLifecycle(events);
            const vectorIntent = lifecycle.vectorIntent;
            lifecycle.vectorIntent = async input => {
                const intent = await vectorIntent(input);
                if (input.id !== "live-document-1" || input.action !== "delete") return intent;
                return { ...intent, physicalIds: [...physicalIds] };
            };
            const recordedActions: string[] = [];
            const controller = createCloudflareVectorizeProofController({
                lifecycle: lifecycle as never,
                now: () => 100,
                sleep: async () => undefined,
                appendOwnedIds: async input => {
                    recordedActions.push(String(input.action));
                },
                redeploy: async () => ({
                    deploymentId: REDEPLOYMENT_ID,
                    versionId: REDEPLOYED_VERSION_ID,
                    number: 2,
                    percentage: 100,
                }),
                releaseFault: async input => {
                    lifecycle.releaseHeldFault();
                    return { released: true, gateDeadline: Number(input.claim.gateDeadline) };
                },
            });

            await expect(controller.run(controllerInput())).rejects.toThrow(expected);
            expect(recordedActions.at(-1)).toBe("replace");
            expect(recordedActions).not.toContain("delete");
        }
    });

    test("localizes a malformed replacement result without recording request data", async () => {
        const events: string[] = [];
        const checkpoints: string[] = [];
        const lifecycle = successfulLifecycle(events);
        const mutate = lifecycle.mutateVector;
        lifecycle.mutateVector = async input => {
            if (input.action === "replace") throw new TypeError("vector id is invalid");
            return mutate(input);
        };
        const controller = createCloudflareVectorizeProofController({
            lifecycle: lifecycle as never,
            now: () => 100,
            sleep: async () => undefined,
            checkpoint: async value => {
                checkpoints.push(value);
            },
            appendOwnedIds: async () => undefined,
            redeploy: async () => {
                throw new Error("redeploy must not run");
            },
            releaseFault: async () => {
                throw new Error("fault release must not run");
            },
        });
        await expect(controller.run(controllerInput())).rejects.toThrow("vector id is invalid");
        expect(checkpoints.at(-1)).toBe("replace-mutation");
        expect(checkpoints).not.toContain("replace-held-claim");
    });
});
