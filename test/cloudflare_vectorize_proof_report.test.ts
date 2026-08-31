import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    CLOUDFLARE_VECTORIZE_PROOF_REPORT_SCHEMA,
    assertCloudflareVectorizeProofReport,
    validateCloudflareVectorizeProofEvidence,
} from "../scripts/cloudflare-vectorize-proof-report.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function hash(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function wireDigest(label: string): string {
    return Buffer.from(hash(label), "hex").toString("base64url");
}

function physical(label: string, version = 1): string {
    return `p1_${wireDigest(label)}_${version.toString(36)}`;
}

function namespace(label: string): string {
    return `o1_${wireDigest(label)}`;
}

function candidate(bytes = new TextEncoder().encode("exact vector candidate")) {
    return { algorithm: "sha256" as const, digest: hash(bytes), bytes: bytes.byteLength };
}

function benchmarkSamples(values: number[]) {
    return values.map((elapsedMs, sequence) => ({
        requestOrdinal: sequence + 1,
        sequence,
        excluded: false,
        classification: "exact",
        status: null,
        code: null,
        elapsedMs,
    }));
}

function benchmarkWarmup() {
    return {
        requestOrdinal: 0,
        sequence: -1,
        excluded: true,
        classification: "exact",
        status: null,
        code: null,
        elapsedMs: 1,
    };
}

function exactPostStabilitySampling() {
    return {
        latencyPopulation: "exact-results-only",
        availabilityPassThreshold: null,
        scheduledRequestCount: 6,
        exactResponseCount: 6,
        exactResponseRatio: 1,
        availabilityMissCount: 0,
        emptyResponseCount: 0,
        http5xxResponseCount: 0,
        timeoutResponseCount: 0,
        reacquisitionCount: 0,
        reacquisitions: [],
        reacquisitionObservations: [],
        hardBoundClaimed: false,
    };
}

function reportFor(exactCandidate = candidate()) {
    const nonce = "0123456789abcdef";
    const name = `chardb-vx-proof-${exactCandidate.digest.slice(0, 10)}-${nonce}`;
    const resourceDigest = hash("exact descriptor");
    const first = physical("first");
    const localRemote = physical("local-remote");
    const liveCreate = physical("live-create");
    const liveReplacement = physical("live-replacement", 2);
    const deploymentFiles = [
        { path: "chardb-proof.tgz", bytes: exactCandidate.bytes, sha256: exactCandidate.digest },
        { path: "package-lock.json", bytes: 200, sha256: hash("package lock") },
        { path: "src/worker.ts", bytes: 300, sha256: hash("worker source") },
        { path: "wrangler.toml", bytes: 400, sha256: hash("wrangler config") },
    ];
    return {
        schema: CLOUDFLARE_VECTORIZE_PROOF_REPORT_SCHEMA,
        ok: true,
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:05:00.000Z",
        candidate: exactCandidate,
        target: {
            worker: name,
            index: name,
            origin: `https://${name}.zpg6.workers.dev`,
            accountIdSha256: hash("cloudflare account id"),
        },
        wranglerVersion: "4.125.0",
        deploymentInput: {
            algorithm: "sha256",
            digest: hash(JSON.stringify(deploymentFiles)),
            files: deploymentFiles,
        },
        versions: {
            initial: {
                deploymentId: "11111111-1111-4111-8111-111111111111",
                versionId: "22222222-2222-4222-8222-222222222222",
                number: 1,
                percentage: 100,
            },
            redeploy: {
                deploymentId: "33333333-3333-4333-8333-333333333333",
                versionId: "44444444-4444-4444-8444-444444444444",
                number: 2,
                percentage: 100,
            },
        },
        descriptor: {
            binding: "CDB_PROOF_VECTORS",
            resourceDigest,
            resourceId: `vr1_${resourceDigest}`,
            resourceFilter: `r1_${Buffer.from(resourceDigest, "hex").toString("base64url")}`,
            dimensions: 32,
            metric: "cosine",
            namespaceIds: [namespace("org-a"), namespace("org-b")],
        },
        index: {
            absentBefore: true,
            created: true,
            name,
            dimensions: 32,
            metric: "cosine",
            metadataIndexes: [{ propertyName: "cdb_resource", type: "string" }],
        },
        lifecycle: {
            migration: {
                beforeVersion: 0,
                targetVersion: 1,
                afterVersion: 1,
                beforeEpoch: 1,
                afterEpoch: 2,
                idempotentRetry: true,
            },
            workerRedeployDuringLease: true,
            leaseStateAfterRedeploy: "active-original",
        },
        delivery: {
            initial: {
                physicalId: first,
                payloadSha256: hash("first payload"),
                mutationIdSha256: hash("first mutation"),
            },
            upsertResponseLoss: {
                acceptedBeforeThrow: true,
                physicalId: physical("second", 2),
                retryPhysicalId: physical("second", 2),
                payloadSha256: hash("second payload"),
                retryPayloadSha256: hash("second payload"),
                mutationIdSha256: hash("second mutation"),
            },
            deleteResponseLoss: {
                acceptedBeforeThrow: true,
                physicalIds: [first, physical("second", 2)],
                retryPhysicalIds: [first, physical("second", 2)],
                mutationIdSha256: hash("delete mutation"),
            },
        },
        faults: {
            acceptedUpsertReceiptLost: true,
            acceptedDeleteReceiptLost: true,
            sameUpsertIdAndPayloadRetried: true,
            sameDeleteIdsRetried: true,
            durableObjectEvictionClaimed: false,
            inFlightNetworkLossClaimed: false,
        },
        search: {
            namespaceIsolation: true,
            resourceFilter: true,
            currentHeadOnly: true,
            noRemoteValues: true,
            noRemoteMetadata: true,
            adversarialFiltering: {
                provider: "cloudflare-vectorize",
                realVectorize: true,
                syntheticMatches: false,
                vectorIdSha256: hash("adversarial vector id"),
                stalePhysicalIdSha256: hash("adversarial stale physical id"),
                currentPhysicalIdSha256: hash("adversarial current physical id"),
                apply: {
                    staleUpsertMutationIdSha256: hash("adversarial stale upsert"),
                    currentDeleteMutationIdSha256: hash("adversarial current delete"),
                },
                injected: {
                    providerQueryTopK: 17,
                    rawStaleObserved: true,
                    rawCurrentAbsent: true,
                    rawObservationElapsedMs: 100,
                    publicTargetReturned: false,
                    publicObservation: {
                        elapsedMs: 12_000,
                        attempts: 13,
                        staleEmptyObservationCount: 11,
                        stableEmptyCount: 11,
                        previousCurrentViewCount: 1,
                        mixedCurrentResetCount: 0,
                        providerMissCount: 1,
                        transientFailureCount: 1,
                        stabilityResetCount: 2,
                        stabilityWindowMs: 10_000,
                        stabilityObservedMs: 10_000,
                        observationIntervalMs: 1_000,
                        querySha256: hash("stale public query"),
                        finalCandidateSetSha256: hash("stale candidate set"),
                        hardBoundClaimed: false,
                    },
                },
                restore: {
                    currentUpsertMutationIdSha256: hash("adversarial current restore"),
                    staleDeleteMutationIdSha256: hash("adversarial stale cleanup"),
                    rawCurrentObserved: true,
                    rawStaleAbsent: true,
                    rawObservationElapsedMs: 120,
                    publicOwnerTargetReturned: true,
                    publicOwnerObservation: {
                        elapsedMs: 15,
                        attempts: 3,
                        emptyReadCount: 1,
                        staleFilteredReadCount: 0,
                        mixedCurrentReadCount: 0,
                        transientFailureCount: 1,
                        querySha256: hash("restored owner query"),
                        candidateSetSha256: hash("restored current candidate set"),
                        hardBoundClaimed: false,
                    },
                },
                policy: {
                    kind: "vector-column-read-denied",
                    role: "member",
                    rawCurrentObserved: true,
                    publicOwnerTargetReturned: true,
                    publicMemberTargetReturned: false,
                    exactCurrentCandidateBatch: true,
                    candidateSetSha256: hash("restored current candidate set"),
                },
            },
            liveDelivery: {
                realWorkerWebSocket: true,
                syntheticFrames: false,
                vectorIdSha256: hash("live vector id"),
                documentIdSha256: hash("live document id"),
                createPhysicalIdSha256: hash(liveCreate),
                replacementPhysicalIdSha256: hash(liveReplacement),
                pending: {
                    gateHeldBeforeRelease: true,
                    headVersion: 2,
                    deliveredVersion: 1,
                    publicReplacementReturned: false,
                    fallbackDocumentIdSha256: hash("fallback document id"),
                    snapshotElapsedMs: 20,
                },
                ready: {
                    providerReadyBeforeAssertion: true,
                    headVersion: 2,
                    deliveredVersion: 2,
                    publicReplacementUpdateCount: 1,
                    snapshotElapsedMs: 30,
                    readinessElapsedMs: 40,
                },
                cleanup: { deleted: true, retainedTombstone: false, elapsedMs: 50 },
                sdk: {
                    sdk: "installed-candidate-createChardbClient",
                    transport: "worker-websocket",
                    auth: "better-auth-jwt",
                    queryRefSha256: hash("cloudflare-vectorize-proof/api.ts#searchVectorDocuments"),
                    clientIdSha256: hash("live client id"),
                    connectionCount: 2,
                    helloCount: 2,
                    welcomeCount: 2,
                    reconnectCount: 1,
                    authReadCount: 2,
                    snapshotCount: 4,
                    acknowledgementCount: 4,
                    acknowledgementEverySnapshot: true,
                    resume: {
                        attempted: true,
                        helloResumeMatchedInitialAck: true,
                        welcomeResumeMatchedInitialAck: true,
                        recovery: "lagged-refetch",
                        refetchReason: "lagged",
                        refetchStateCount: 1,
                        baselineRestoreCount: 1,
                        baselineRestoredExactly: true,
                        baselineRestoreAcknowledged: true,
                        initialCookieSha256: hash("initial live cookie"),
                        finalCookieSha256: hash("final live cookie"),
                    },
                    content: {
                        callbackCount: 4,
                        baselineUpdateCount: 1,
                        pendingFallbackUpdateCount: 1,
                        prematureCurrentUpdateCount: 0,
                        replacementUpdateCount: 1,
                        duplicateContentUpdateCount: 0,
                        baselineRowsSha256: hash("live baseline rows"),
                        pendingFallbackRowPkSha256: hash("fallback document id"),
                        pendingRowsSha256: hash("live pending fallback rows"),
                        replacementRowsSha256: hash("live replacement rows"),
                    },
                },
            },
        },
        settlement: {
            configuredMs: 120_000,
            samplesMs: [10, 20, 30, 40, 50],
            minMs: 10,
            medianMs: 30,
            p95Ms: 50,
            maxMs: 50,
            transientHttpFailureCount: 0,
            transientHttpFailureCounts: [],
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
            warmupExcluded: true,
            comparisonsDescriptiveOnly: true,
            queryStability: {
                localRemoteBinding: {
                    queryStabilityWindowMs: 10_000,
                    queryStabilityIntervalMs: 1_000,
                    queryStabilityObservedMs: 11_000,
                    queryStabilityExactMatchCount: 12,
                    queryStabilityResetCount: 1,
                    queryStabilityNonExactCount: 1,
                    hardBoundClaimed: false,
                },
                deployed: {
                    queryStabilityWindowMs: 10_000,
                    queryStabilityIntervalMs: 1_000,
                    queryStabilityObservedMs: 10_000,
                    queryStabilityExactMatchCount: 11,
                    queryStabilityResetCount: 0,
                    queryStabilityNonExactCount: 0,
                    hardBoundClaimed: false,
                },
            },
            postStabilitySampling: {
                localRemoteBinding: exactPostStabilitySampling(),
                deployed: exactPostStabilitySampling(),
            },
            localFake: {
                label: "local-workerd-fake-vectorize",
                runtime: "miniflare/workerd",
                backend: "persistent-fake-index-do",
                realVectorize: false,
                warmup: benchmarkWarmup(),
                samples: benchmarkSamples([1, 2, 3, 4, 5]),
                exactMatchLatenciesMs: [1, 2, 3, 4, 5],
            },
            localRemoteBinding: {
                label: "local-wrangler-remote-vectorize",
                runtime: "wrangler-dev/workerd",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: benchmarkWarmup(),
                samples: benchmarkSamples([8, 9, 10, 11, 12]),
                exactMatchLatenciesMs: [8, 9, 10, 11, 12],
            },
            deployed: {
                label: "deployed-cloudflare-vectorize",
                runtime: "cloudflare-workers",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: benchmarkWarmup(),
                samples: benchmarkSamples([10, 20, 30, 40, 50]),
                exactMatchLatenciesMs: [10, 20, 30, 40, 50],
            },
        },
        cleanup: {
            expectedPhysicalIds: [first, physical("second", 2), liveCreate, liveReplacement, localRemote],
            discoveredPhysicalIds: [first, physical("second", 2), liveCreate, liveReplacement, localRemote],
            localRemotePhysicalIds: [localRemote],
            exactIdsDeleted: true,
            finalVectorCount: 0,
            workerDeleted: true,
            indexDeleted: true,
            workerAbsentVerified: true,
            indexAbsentVerified: true,
        },
        evidence: { secretScanPassed: true, checksumFile: "evidence.sha256", filesScanned: 8 },
        error: null,
    };
}

function changed<T>(value: T, mutate: (copy: T) => void): T {
    const copy = structuredClone(value);
    mutate(copy);
    return copy;
}

describe("Cloudflare Vectorize proof report validator", () => {
    test("accepts only the exact successful report shape", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(assertCloudflareVectorizeProofReport(report, exactCandidate)).toBe(report);
        expect(() => assertCloudflareVectorizeProofReport({ ...report, trustMe: true }, exactCandidate)).toThrow(
            "fields must be exactly"
        );
    });

    test("requires real raw-provider, public-filtering, policy, and restoration evidence", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        for (const mutate of [
            value => {
                value.search.adversarialFiltering.syntheticMatches = true;
            },
            value => {
                value.search.adversarialFiltering.injected.rawStaleObserved = false;
            },
            value => {
                value.search.adversarialFiltering.injected.publicTargetReturned = true;
            },
            value => {
                value.search.adversarialFiltering.injected.publicObservation.stabilityObservedMs = 9_999;
            },
            value => {
                value.search.adversarialFiltering.injected.publicObservation.stableEmptyCount = 10;
            },
            value => {
                value.search.adversarialFiltering.injected.publicObservation.attempts = 12;
            },
            value => {
                value.search.adversarialFiltering.injected.publicObservation.mixedCurrentResetCount = 3;
            },
            value => {
                value.search.adversarialFiltering.restore.rawCurrentObserved = false;
            },
            value => {
                value.search.adversarialFiltering.restore.currentUpsertMutationIdSha256 =
                    value.search.adversarialFiltering.apply.currentDeleteMutationIdSha256;
            },
            value => {
                value.search.adversarialFiltering.policy.publicMemberTargetReturned = true;
            },
            value => {
                value.search.adversarialFiltering.policy.candidateSetSha256 = hash("different candidate set");
            },
            value => {
                value.search.adversarialFiltering.restore.publicOwnerObservation.attempts = 2;
            },
            value => {
                value.search.adversarialFiltering.restore.publicOwnerObservation.staleFilteredReadCount = 1;
            },
            value => {
                value.search.adversarialFiltering.restore.publicOwnerObservation.hardBoundClaimed = true;
            },
            value => {
                (value.search.adversarialFiltering.injected as Record<string, unknown>).rawValues = [1, 0];
            },
        ] as Array<(value: ReturnType<typeof reportFor>) => void>) {
            expect(() => assertCloudflareVectorizeProofReport(changed(report, mutate), exactCandidate)).toThrow();
        }
    });

    test("accepts bounded mixed-current resets and rejects reset accounting drift", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        const observation = report.search.adversarialFiltering.injected.publicObservation;
        observation.attempts++;
        observation.mixedCurrentResetCount = 1;
        observation.stabilityResetCount++;
        expect(assertCloudflareVectorizeProofReport(report, exactCandidate)).toBe(report);

        observation.stabilityResetCount = 0;
        expect(() => assertCloudflareVectorizeProofReport(report, exactCandidate)).toThrow(
            "stale public filtering observation is incomplete"
        );
    });

    test("requires exact SDK WebSocket, resume, acknowledgement, and live content evidence", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.search.liveDelivery.sdk.authReadCount = 3;
                }),
                exactCandidate
            )
        ).not.toThrow();
        for (const mutate of [
            value => {
                value.search.liveDelivery.syntheticFrames = true;
            },
            value => {
                value.search.liveDelivery.pending.publicReplacementReturned = true;
            },
            value => {
                value.search.liveDelivery.ready.publicReplacementUpdateCount = 2;
            },
            value => {
                value.search.liveDelivery.sdk.connectionCount = 1;
            },
            value => {
                value.search.liveDelivery.sdk.authReadCount = 1;
            },
            value => {
                value.search.liveDelivery.sdk.acknowledgementCount = 3;
            },
            value => {
                value.search.liveDelivery.sdk.resume.welcomeResumeMatchedInitialAck = false;
            },
            value => {
                value.search.liveDelivery.sdk.resume.refetchReason = "authChanged" as "lagged";
            },
            value => {
                value.search.liveDelivery.sdk.resume.refetchStateCount = 2 as 1;
            },
            value => {
                value.search.liveDelivery.sdk.resume.baselineRestoredExactly = false as true;
            },
            value => {
                value.search.liveDelivery.sdk.resume.baselineRestoreAcknowledged = false as true;
            },
            value => {
                value.search.liveDelivery.sdk.content.pendingFallbackRowPkSha256 = hash("wrong fallback");
            },
            value => {
                value.search.liveDelivery.sdk.content.duplicateContentUpdateCount = 1;
            },
            value => {
                value.search.liveDelivery.sdk.content.replacementRowsSha256 =
                    value.search.liveDelivery.sdk.content.baselineRowsSha256;
            },
            value => {
                (value.search.liveDelivery.sdk as Record<string, unknown>).cookie = "raw-cookie";
            },
        ] as Array<(value: ReturnType<typeof reportFor>) => void>) {
            expect(() => assertCloudflareVectorizeProofReport(changed(report, mutate), exactCandidate)).toThrow();
        }
    });

    test("rejects oversized wire ids and descriptor drift", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.delivery.initial.physicalId = `x${"a".repeat(64)}`;
                }),
                exactCandidate
            )
        ).toThrow("at most 64 bytes");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.delivery.initial.physicalId = `p1_${"A".repeat(42)}__1`;
                }),
                exactCandidate
            )
        ).toThrow("canonical 32-byte base64url digest");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.descriptor.resourceId = `vr1_${"f".repeat(64)}`;
                }),
                exactCandidate
            )
        ).toThrow("drifted from its full descriptor digest");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.descriptor.resourceFilter = `r1_${wireDigest("wrong")}`;
                }),
                exactCandidate
            )
        ).toThrow("resource filter drifted");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.descriptor.dimensions = 4;
                }),
                exactCandidate
            )
        ).toThrow("descriptor drifted");
    });

    test("binds the target and exact deployment tree to the candidate", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.target.accountIdSha256 = "not-a-digest";
                }),
                exactCandidate
            )
        ).toThrow("account-id digest");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.deploymentInput.algorithm = "sha1";
                }),
                exactCandidate
            )
        ).toThrow("algorithm must be sha256");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    const packageLock = value.deploymentInput.files[1];
                    if (!packageLock) throw new Error("test deployment fingerprint has no package lock");
                    packageLock.sha256 = hash("changed package lock");
                }),
                exactCandidate
            )
        ).toThrow("composite digest");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    const tarball = value.deploymentInput.files[0];
                    if (!tarball) throw new Error("test deployment fingerprint has no tarball");
                    tarball.bytes += 1;
                }),
                exactCandidate
            )
        ).toThrow("exact candidate tarball");
    });

    test("requires two distinct immutable versions and migration through an active lease", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.versions.initial.versionId = "not-a-version";
                }),
                exactCandidate
            )
        ).toThrow("immutable deployment and version ids");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.versions.initial.number = 0;
                }),
                exactCandidate
            )
        ).toThrow("positive safe integer");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.versions.initial.percentage = 99;
                }),
                exactCandidate
            )
        ).toThrow("100 percent traffic");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.versions.redeploy.versionId = value.versions.initial.versionId;
                }),
                exactCandidate
            )
        ).toThrow("distinct later immutable Worker version");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.lifecycle.migration.afterVersion = 0;
                }),
                exactCandidate
            )
        ).toThrow("version zero to one activation");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.lifecycle.workerRedeployDuringLease = false;
                }),
                exactCandidate
            )
        ).toThrow("redeploy during an active lease");
        for (const leaseState of ["active-original", "expired-original", "active-reclaimed", "unleased"] as const) {
            expect(() =>
                assertCloudflareVectorizeProofReport(
                    changed(report, value => {
                        value.lifecycle.leaseStateAfterRedeploy = leaseState;
                    }),
                    exactCandidate
                )
            ).not.toThrow();
        }
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.lifecycle.leaseStateAfterRedeploy = "expired-reclaimed";
                }),
                exactCandidate
            )
        ).toThrow("post-redeploy lease state is invalid");
    });

    test("binds every benchmark track to the exact 32-dimensional cosine workload", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.workload.dimensions = 3;
                }),
                exactCandidate
            )
        ).toThrow("workload dimensions drifted");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.workload.id = "ready-vector-filtered-search-v1";
                }),
                exactCandidate
            )
        ).toThrow("workload id drifted");
    });

    test("requires exact metadata-index and retry evidence", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.index.metadataIndexes = [];
                }),
                exactCandidate
            )
        ).toThrow("metadata-index evidence");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.delivery.upsertResponseLoss.retryPhysicalId = physical("wrong");
                }),
                exactCandidate
            )
        ).toThrow("retry physical id");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.delivery.upsertResponseLoss.retryPayloadSha256 = hash("wrong payload");
                }),
                exactCandidate
            )
        ).toThrow("retry payload hash");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.delivery.deleteResponseLoss.retryPhysicalIds.reverse();
                }),
                exactCandidate
            )
        ).toThrow("retry ids");
    });

    test("rejects a hard-bound claim and dishonest benchmark labels", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.settlement.hardBoundClaimed = true;
                }),
                exactCandidate
            )
        ).toThrow("cannot claim a hard Vectorize settlement bound");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.queryStability.deployed.hardBoundClaimed = true;
                }),
                exactCandidate
            )
        ).toThrow("cannot claim a platform bound");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.settlement.p95Ms = 40;
                }),
                exactCandidate
            )
        ).toThrow("summary does not match");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.settlement.transientHttpFailureCount = 1;
                }),
                exactCandidate
            )
        ).toThrow("transient HTTP failure accounting drifted");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.settlement.transientHttpFailureCount = 1;
                    value.settlement.transientHttpFailureCounts = [
                        { status: 503, code: "unsafe response detail", count: 1 },
                    ] as never;
                }),
                exactCandidate
            )
        ).toThrow("transient HTTP failure 0 code is invalid");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.localFake.realVectorize = true;
                }),
                exactCandidate
            )
        ).toThrow("dishonest runtime or backend label");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.deployed.backend = "miniflare-emulator";
                }),
                exactCandidate
            )
        ).toThrow("dishonest runtime or backend label");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.localRemoteBinding.runtime = "miniflare/workerd";
                }),
                exactCandidate
            )
        ).toThrow("dishonest runtime or backend label");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    const { localRemoteBinding, ...incomplete } = value.benchmark;
                    if (!localRemoteBinding) throw new Error("test benchmark has no remote-binding track");
                    value.benchmark = incomplete as typeof value.benchmark;
                }),
                exactCandidate
            )
        ).toThrow("fields must be exactly");
    });

    test("requires benchmark reacquisition observations to prove exact-result recovery", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        const withRecovery = changed(report, value => {
            value.benchmark.localRemoteBinding.warmup = {
                ...value.benchmark.localRemoteBinding.warmup,
                classification: "empty",
            } as never;
            value.benchmark.postStabilitySampling.localRemoteBinding = {
                latencyPopulation: "exact-results-only",
                availabilityPassThreshold: null,
                scheduledRequestCount: 6,
                exactResponseCount: 5,
                exactResponseRatio: 5 / 6,
                availabilityMissCount: 1,
                emptyResponseCount: 1,
                http5xxResponseCount: 0,
                timeoutResponseCount: 0,
                reacquisitionCount: 1,
                reacquisitions: [
                    {
                        afterSequence: -1,
                        excluded: true,
                        scheduledMissCount: 1,
                        outOfBandRequestCount: 2,
                        elapsedMs: 20,
                    },
                ],
                reacquisitionObservations: [
                    {
                        requestOrdinal: 0,
                        sequence: -1,
                        excluded: true,
                        classification: "empty",
                        status: null,
                        code: null,
                        elapsedMs: 5,
                    },
                    {
                        requestOrdinal: 1,
                        sequence: -1,
                        excluded: true,
                        classification: "exact",
                        status: null,
                        code: null,
                        elapsedMs: 5,
                    },
                ],
                hardBoundClaimed: false,
            } as never;
        });
        expect(assertCloudflareVectorizeProofReport(withRecovery, exactCandidate)).toBe(withRecovery);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(withRecovery, value => {
                    const observations = value.benchmark.postStabilitySampling.localRemoteBinding
                        .reacquisitionObservations as unknown as Array<{ classification: string }>;
                    const observation = observations[1];
                    if (!observation) throw new Error("test recovery observation is missing");
                    observation.classification = "empty";
                }),
                exactCandidate
            )
        ).toThrow("do not prove exact-result recovery");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(withRecovery, value => {
                    const observations = value.benchmark.postStabilitySampling.localRemoteBinding
                        .reacquisitionObservations as unknown as Array<{ sequence: number; excluded: boolean }>;
                    const observation = observations[0];
                    if (!observation) throw new Error("test recovery observation is missing");
                    observation.sequence = 0;
                    observation.excluded = false;
                }),
                exactCandidate
            )
        ).toThrow("do not prove exact-result recovery");
    });

    test("rejects malformed HTTP identity in benchmark warmup and samples", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.deployed.warmup.status = 503 as never;
                }),
                exactCandidate
            )
        ).toThrow("warmup carries unexpected HTTP identity");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.benchmark.deployed.samples[0] = {
                        ...value.benchmark.deployed.samples[0],
                        classification: "http-5xx",
                        status: 503,
                        code: "unsafe response detail",
                    } as never;
                    value.benchmark.deployed.exactMatchLatenciesMs = [2, 3, 4, 5] as never;
                    const sampling = value.benchmark.postStabilitySampling.deployed;
                    sampling.exactResponseCount = 5;
                    sampling.exactResponseRatio = 5 / 6;
                    sampling.availabilityMissCount = 1;
                    sampling.http5xxResponseCount = 1;
                    sampling.reacquisitionCount = 1;
                    sampling.reacquisitions = [
                        {
                            afterSequence: 0,
                            excluded: false,
                            scheduledMissCount: 1,
                            outOfBandRequestCount: 0,
                            elapsedMs: 1,
                        },
                    ] as never;
                }),
                exactCandidate
            )
        ).toThrow("sample 0 HTTP code is invalid");
    });

    test("requires every scoped fault claim and rejects stronger platform claims", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        for (const field of [
            "acceptedUpsertReceiptLost",
            "acceptedDeleteReceiptLost",
            "sameUpsertIdAndPayloadRetried",
            "sameDeleteIdsRetried",
        ] as const) {
            expect(() =>
                assertCloudflareVectorizeProofReport(
                    changed(report, value => {
                        value.faults[field] = false;
                    }),
                    exactCandidate
                )
            ).toThrow(field);
        }
        for (const field of ["durableObjectEvictionClaimed", "inFlightNetworkLossClaimed"] as const) {
            expect(() =>
                assertCloudflareVectorizeProofReport(
                    changed(report, value => {
                        value.faults[field] = true;
                    }),
                    exactCandidate
                )
            ).toThrow("may not claim real eviction or in-flight network loss");
        }
    });

    test("requires complete exact cleanup and a passing secret scan", () => {
        const exactCandidate = candidate();
        const report = reportFor(exactCandidate);
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.cleanup.indexAbsentVerified = false;
                }),
                exactCandidate
            )
        ).toThrow("cleanup is incomplete");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.cleanup.expectedPhysicalIds.splice(2, 1);
                }),
                exactCandidate
            )
        ).toThrow("identify both live physical ids");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    const liveCreate = value.cleanup.expectedPhysicalIds[2];
                    if (liveCreate === undefined) throw new Error("test fixture omitted live create id");
                    value.cleanup.expectedPhysicalIds[3] = liveCreate;
                }),
                exactCandidate
            )
        ).toThrow("must not contain duplicates");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    const liveCreate = value.cleanup.expectedPhysicalIds[2];
                    const liveReplacement = value.cleanup.expectedPhysicalIds[3];
                    if (liveCreate === undefined || liveReplacement === undefined) {
                        throw new Error("test fixture omitted live ids");
                    }
                    [value.cleanup.expectedPhysicalIds[2], value.cleanup.expectedPhysicalIds[3]] = [
                        liveReplacement,
                        liveCreate,
                    ];
                }),
                exactCandidate
            )
        ).not.toThrow();
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.search.liveDelivery.createPhysicalIdSha256 = hash("wrong live create id");
                }),
                exactCandidate
            )
        ).toThrow("identify both live physical ids");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    const unrelated = physical("unrelated-live-id");
                    value.cleanup.expectedPhysicalIds[2] = unrelated;
                    value.cleanup.discoveredPhysicalIds[2] = unrelated;
                }),
                exactCandidate
            )
        ).toThrow("identify both live physical ids");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.cleanup.localRemotePhysicalIds = [];
                }),
                exactCandidate
            )
        ).toThrow("must not be empty");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    const unrelated = physical("unaccounted");
                    value.cleanup.expectedPhysicalIds.push(unrelated);
                    value.cleanup.discoveredPhysicalIds.push(unrelated);
                }),
                exactCandidate
            )
        ).toThrow("identify both live physical ids");
        expect(() =>
            assertCloudflareVectorizeProofReport(
                changed(report, value => {
                    value.evidence.secretScanPassed = false;
                }),
                exactCandidate
            )
        ).toThrow("secret scan did not pass");
    });

    test("validates canonical report bytes and candidate checksum", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "chardb-vector-report-"));
        temporaryDirectories.push(directory);
        const candidatePath = path.join(directory, "candidate.tgz");
        const candidateBytes = new TextEncoder().encode("exact vector candidate");
        await writeFile(candidatePath, candidateBytes);
        const reportPath = path.join(directory, "vectorize-proof-report.json");
        const reportBytes = new TextEncoder().encode(`${JSON.stringify(reportFor(candidate(candidateBytes)))}\n`);
        await writeFile(reportPath, reportBytes);
        await writeFile(path.join(directory, "evidence.sha256"), `${hash(reportBytes)}  vectorize-proof-report.json\n`);
        const validation = await validateCloudflareVectorizeProofEvidence({
            report: reportPath,
            candidate: candidatePath,
        });
        expect(validation.ok).toBe(true);
        expect(validation.reportSha256).toBe(hash(await readFile(reportPath)));
    });
});
