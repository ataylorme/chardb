import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    CloudflareVectorizeProofCandidateClassificationError,
    CloudflareVectorizeProofObservationTimeoutError,
} from "../scripts/cloudflare-vectorize-proof-controller.mjs";
import {
    CloudflareVectorizeProofHttpError,
    CloudflareVectorizeProofSettlementError,
} from "../scripts/cloudflare-vectorize-proof-lifecycle.mjs";
import {
    CLOUDFLARE_VECTORIZE_PROOF_PREPARATION_SCHEMA,
    CLOUDFLARE_VECTORIZE_PROOF_WRANGLER_VERSION,
    type VectorizePreparationInvocation,
    assertCloudflareVectorizeProofBenchmark,
    assertCloudflareVectorizeProofCandidateBridge,
    assertCloudflareVectorizeProofPackageLock,
    assertNoCloudflareVectorizeProofSecrets,
    awaitCloudflareVectorizeWranglerChild,
    cloudflareVectorizeProofBenchmarkTrack,
    cloudflareVectorizeProofExecutionHttpFailureKind,
    cloudflareVectorizeProofExecutionHttpProtocolReason,
    executePreparedCloudflareVectorizeProof,
    fingerprintCloudflareVectorizeDeployment,
    parseCloudflareVectorizeOrchestratorArgs,
    planCloudflareVectorizePreparationCommands,
    prepareCloudflareVectorizeProof,
    readCloudflareVectorizeProofSecrets,
    renderCloudflareVectorizeProofPackage,
    renderCloudflareVectorizeProofSecrets,
    renderCloudflareVectorizeProofWrangler,
    validateCloudflareVectorizeProofApp,
} from "../scripts/cloudflare-vectorize-proof-orchestrator.mjs";

const temporaryDirectories: string[] = [];
const NONCE = "0123456789abcdef";
const RUN_ID = "proof-run-0123456789";
const AUTH_SECRET = "better_auth_secret_0123456789abcdef";
const ADMIN_TOKEN = "admin_token_0123456789abcdefghijkl";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const WIRE_DIGEST = Buffer.from("a".repeat(64), "hex").toString("base64url");
const PHYSICAL_ID = `p1_${WIRE_DIGEST}_1`;
const DEPLOYED_REPLACEMENT_ID = `p1_${WIRE_DIGEST}_2`;
const LIVE_CREATE_ID = `p1_${WIRE_DIGEST}_3`;
const LIVE_REPLACEMENT_ID = `p1_${WIRE_DIGEST}_4`;
const REMOTE_WIRE_DIGEST = Buffer.from("b".repeat(64), "hex").toString("base64url");
const REMOTE_PHYSICAL_ID = `p1_${REMOTE_WIRE_DIGEST}_1`;
const ACCOUNT_VERIFICATION = Object.freeze({
    method: "profile-oauth-token-whoami" as const,
    profile: "default",
    accountIdSha256: hash(ACCOUNT_ID),
    matched: true as const,
});
const acceptCandidateBridge = async () => undefined;

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function hash(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function terminalDeleteState() {
    return {
        vectorId: `vec1_${"a".repeat(64)}`,
        observedAt: 100,
        scheduledAlarmAt: null,
        head: {
            organizationId: "org-owning",
            resourceId: `vr1_${"c".repeat(64)}`,
            rowPk: "document-1",
            version: 3,
            deliveredVersion: 2,
            state: "deleting" as const,
        },
        outbox: {
            targetVersion: 3,
            operation: "delete" as const,
            phase: "verify" as const,
            mutationIdSha256: "d".repeat(64),
            acceptedAt: 10,
            attempts: 32,
            nextAttemptAt: 20,
            leased: false,
            claimTokenSha256: null,
            leasedUntil: null,
            terminalFailure: true,
            lastErrorClassification: "delete_absence_unproven" as const,
            lastErrorSha256: "e".repeat(64),
        },
        attempts: [
            {
                physicalVersion: 2,
                firstSentAt: 1,
                settleAfter: 2,
                visibilityConfirmed: false,
                responseAmbiguous: true,
                deleteConfirmed: false,
            },
        ],
        acceptances: [],
        fault: null,
    };
}

async function temporaryRoot(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chardb-vector-orchestrator-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function writeLedger(
    file: string,
    mutate: (value: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
    const ledger = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    mutate(ledger);
    await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return ledger;
}

async function preparedFixture(root: string) {
    const tarball = path.join(root, "candidate.tgz");
    await writeFile(tarball, "exact candidate archive bytes");
    const prepared = await prepareCloudflareVectorizeProof(
        {
            tarball,
            output: path.join(root, "public"),
            privateDir: path.join(root, "private"),
            workersDevSubdomain: "zpg6",
            nonce: NONCE,
            runId: RUN_ID,
            betterAuthSecret: AUTH_SECRET,
            adminToken: ADMIN_TOKEN,
        },
        {
            assertCandidateBridge: acceptCandidateBridge,
            run: async invocation => {
                if (invocation.phase === "package-lock") {
                    await writeFile(path.join(invocation.cwd, "package-lock.json"), JSON.stringify(packageLock()));
                }
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        }
    );
    const wranglerBin = path.join(prepared.app, "node_modules", "wrangler", "bin", "wrangler.js");
    await mkdir(path.dirname(wranglerBin), { recursive: true });
    await writeFile(wranglerBin, "#!/usr/bin/env node\n");
    await mkdir(path.join(prepared.app, "node_modules", ".bin"), { recursive: true });
    await symlink("../wrangler/bin/wrangler.js", path.join(prepared.app, "node_modules", ".bin", "wrangler"));
    return prepared;
}

async function cleanupFailureExecution(root: string, primaryError?: Error) {
    const prepared = await preparedFixture(root);
    const cleanupError = new Error("owned cleanup failed");
    const failure = executePreparedCloudflareVectorizeProof(
        { prepared, accountId: ACCOUNT_ID },
        {
            produceLocalFakeBenchmark: async () => benchmark().localFake,
            provision: async () => {
                const ledger = await writeLedger(prepared.ledgerPath, value => {
                    Object.assign(value, {
                        workerAbsentConfirmed: true,
                        indexAbsentConfirmed: true,
                        indexCreateIntent: true,
                        indexCreated: true,
                        workerCreateIntent: true,
                        workerCreated: true,
                    });
                });
                return {
                    ledger,
                    deployment: {
                        deploymentId: "11111111-1111-4111-8111-111111111111",
                        versionId: "22222222-2222-4222-8222-222222222222",
                        number: 1,
                        percentage: 100,
                    },
                    accountVerification: ACCOUNT_VERIFICATION,
                } as never;
            },
            produceLocalRemoteBenchmark: async (_input, dependencies) => {
                await dependencies.appendOwnedIds({
                    vectorId: `vec1_${"a".repeat(64)}`,
                    action: "create",
                    nextVersion: 1,
                    physicalIds: [REMOTE_PHYSICAL_ID],
                });
                return {
                    track: benchmark().localRemoteBinding,
                    evidence: {
                        localRemotePassed: true,
                        candidateSha256: prepared.candidate.digest,
                        physicalIds: [REMOTE_PHYSICAL_ID],
                        queryStability: queryStability(),
                        postStabilitySampling: benchmark().localRemotePostStabilitySampling,
                    },
                };
            },
            lifecycle: {} as never,
            createController: () => ({
                run: async () => {
                    if (primaryError) throw primaryError;
                    return { completed: true };
                },
            }),
            cleanup: async () => {
                await writeLedger(prepared.ledgerPath, value => {
                    value.workerDeleted = true;
                });
                throw cleanupError;
            },
        }
    );
    return { cleanupError, failure, prepared };
}

function packageLock(): Record<string, unknown> {
    const manifest = renderCloudflareVectorizeProofPackage() as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
    };
    return {
        name: "chardb-cloudflare-vectorize-proof",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
            "": {
                name: "chardb-cloudflare-vectorize-proof",
                version: "0.0.0",
                dependencies: manifest.dependencies,
                devDependencies: manifest.devDependencies,
            },
            "node_modules/@noble/hashes": { version: "1.8.0" },
            "node_modules/better-auth": { version: "1.6.30" },
            "node_modules/@cloudflare/workers-types": { version: "5.20260830.1" },
            "node_modules/@chardb/core": { version: "0.1.0", resolved: "file:chardb-proof.tgz" },
            "node_modules/drizzle-orm": { version: "0.45.2" },
            "node_modules/typescript": { version: "5.9.3" },
            "node_modules/wrangler": { version: "4.125.0" },
            "node_modules/zod": { version: "4.4.3" },
        },
    };
}

function benchmark() {
    const samples = (values: readonly number[]) =>
        values.map((elapsedMs, sequence) => ({
            requestOrdinal: sequence + 1,
            sequence,
            excluded: false as const,
            classification: "exact" as const,
            status: null,
            code: null,
            elapsedMs,
        }));
    const track = {
        workloadId: "ready-vector-filtered-search-v2" as const,
        warmupExcluded: true as const,
        warmupCount: 1 as const,
        warmup: {
            requestOrdinal: 0,
            sequence: -1 as const,
            excluded: true as const,
            classification: "exact" as const,
            status: null,
            code: null,
            elapsedMs: 0,
        },
        samples: samples([1, 2, 3, 4, 5]),
        exactMatchLatenciesMs: [1, 2, 3, 4, 5] as const,
    };
    return {
        workloadId: "ready-vector-filtered-search-v2" as const,
        localFake: track,
        localRemoteBinding: {
            ...track,
            samples: samples([2, 3, 4, 5, 6]),
            exactMatchLatenciesMs: [2, 3, 4, 5, 6] as const,
        },
        localRemoteQueryStability: queryStability(),
        localRemotePostStabilitySampling: {
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
}

function queryStability() {
    return {
        queryStabilityWindowMs: 10_000 as const,
        queryStabilityIntervalMs: 1_000 as const,
        queryStabilityObservedMs: 10_000,
        queryStabilityExactMatchCount: 11,
        queryStabilityResetCount: 1,
        queryStabilityNonExactCount: 1,
        hardBoundClaimed: false as const,
    };
}

function reportReadyLifecycle(initial: Record<string, unknown>, redeployed: Record<string, unknown>) {
    const resourceDigest = "c".repeat(64);
    return {
        versions: { initial, redeploy: redeployed },
        descriptor: {
            binding: "CDB_PROOF_VECTORS",
            resourceDigest,
            resourceId: `vr1_${resourceDigest}`,
            resourceFilter: `r1_${Buffer.from(resourceDigest, "hex").toString("base64url")}`,
            dimensions: 32,
            metric: "cosine",
            namespaceIds: [
                `o1_${Buffer.from("d".repeat(64), "hex").toString("base64url")}`,
                `o1_${Buffer.from("e".repeat(64), "hex").toString("base64url")}`,
            ],
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
            initial: { physicalId: PHYSICAL_ID, payloadSha256: "1".repeat(64), mutationIdSha256: "2".repeat(64) },
            upsertResponseLoss: {
                acceptedBeforeThrow: true,
                physicalId: DEPLOYED_REPLACEMENT_ID,
                retryPhysicalId: DEPLOYED_REPLACEMENT_ID,
                payloadSha256: "3".repeat(64),
                retryPayloadSha256: "3".repeat(64),
                mutationIdSha256: "4".repeat(64),
            },
            deleteResponseLoss: {
                acceptedBeforeThrow: true,
                physicalIds: [PHYSICAL_ID, DEPLOYED_REPLACEMENT_ID],
                retryPhysicalIds: [PHYSICAL_ID, DEPLOYED_REPLACEMENT_ID],
                mutationIdSha256: "5".repeat(64),
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
                        elapsedMs: 10_000,
                        attempts: 11,
                        staleEmptyObservationCount: 11,
                        stableEmptyCount: 11,
                        previousCurrentViewCount: 0,
                        mixedCurrentResetCount: 0,
                        providerMissCount: 0,
                        transientFailureCount: 0,
                        stabilityResetCount: 0,
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
                        elapsedMs: 0,
                        attempts: 1,
                        emptyReadCount: 0,
                        staleFilteredReadCount: 0,
                        mixedCurrentReadCount: 0,
                        transientFailureCount: 0,
                        querySha256: hash("restored owner query"),
                        candidateSetSha256: hash("restored current candidates"),
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
                    candidateSetSha256: hash("restored current candidates"),
                },
            },
            liveDelivery: {
                realWorkerWebSocket: true,
                syntheticFrames: false,
                vectorIdSha256: hash("live vector id"),
                documentIdSha256: hash("live document id"),
                createPhysicalIdSha256: hash(LIVE_CREATE_ID),
                replacementPhysicalIdSha256: hash(LIVE_REPLACEMENT_ID),
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
            samplesMs: [1, 2, 3],
            minMs: 1,
            medianMs: 2,
            p95Ms: 3,
            maxMs: 3,
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
                localRemoteBinding: queryStability(),
                deployed: { ...queryStability(), queryStabilityResetCount: 0, queryStabilityNonExactCount: 0 },
            },
            postStabilitySampling: {
                localRemoteBinding: benchmark().localRemotePostStabilitySampling,
                deployed: benchmark().localRemotePostStabilitySampling,
            },
            localFake: {
                label: "local-workerd-fake-vectorize",
                runtime: "miniflare/workerd",
                backend: "persistent-fake-index-do",
                realVectorize: false,
                warmup: benchmark().localFake.warmup,
                samples: benchmark().localFake.samples,
                exactMatchLatenciesMs: benchmark().localFake.exactMatchLatenciesMs,
            },
            localRemoteBinding: {
                label: "local-wrangler-remote-vectorize",
                runtime: "wrangler-dev/workerd",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: benchmark().localRemoteBinding.warmup,
                samples: benchmark().localRemoteBinding.samples,
                exactMatchLatenciesMs: benchmark().localRemoteBinding.exactMatchLatenciesMs,
            },
            deployed: {
                label: "deployed-cloudflare-vectorize",
                runtime: "cloudflare-workers",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: benchmark().localRemoteBinding.warmup,
                samples: benchmark().localRemoteBinding.samples.map((sample, index) => ({
                    ...sample,
                    elapsedMs: index + 3,
                })),
                exactMatchLatenciesMs: [3, 4, 5, 6, 7],
            },
        },
    };
}

describe("Cloudflare Vectorize proof preparation", () => {
    test("keeps only bounded typed HTTP failure kinds in execution evidence", () => {
        for (const kind of ["timeout", "network", "http", "protocol"] as const) {
            expect(cloudflareVectorizeProofExecutionHttpFailureKind(kind)).toBe(kind);
        }
        expect(cloudflareVectorizeProofExecutionHttpFailureKind("legacy")).toBe("unknown");
        expect(cloudflareVectorizeProofExecutionHttpFailureKind(null)).toBe("unknown");
    });

    test("keeps only bounded protocol reasons in execution evidence", () => {
        for (const reason of [
            "invalid_response",
            "unexpected_redirect",
            "invalid_content_length",
            "empty_body",
            "body_too_large",
            "invalid_utf8",
            "invalid_json",
        ] as const) {
            expect(cloudflareVectorizeProofExecutionHttpProtocolReason(reason)).toBe(reason);
        }
        expect(cloudflareVectorizeProofExecutionHttpProtocolReason(null)).toBeNull();
        expect(cloudflareVectorizeProofExecutionHttpProtocolReason("raw-details-must-not-pass")).toBe("unknown");
    });

    test("bounds Wrangler termination when exited never settles", async () => {
        const signals: string[] = [];
        const never = new Promise<number>(() => {});
        const body = () => new Response("").body;
        const child = {
            stdout: body(),
            stderr: body(),
            exited: never,
            kill(signal?: NodeJS.Signals) {
                signals.push(String(signal));
            },
        };
        const started = performance.now();
        await expect(
            awaitCloudflareVectorizeWranglerChild(child, {
                timeoutMs: 5,
                terminationGraceMs: 5,
                killGraceMs: 5,
            })
        ).rejects.toThrow("did not exit after SIGKILL");
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    test("gives SIGTERM a bounded grace before escalating", async () => {
        const signals: string[] = [];
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>(resolve => {
            resolveExit = resolve;
        });
        const body = () => new Response("").body;
        const child = {
            stdout: body(),
            stderr: body(),
            exited,
            kill(signal?: NodeJS.Signals) {
                signals.push(String(signal));
                if (signal === "SIGTERM") resolveExit(143);
            },
        };
        await expect(
            awaitCloudflareVectorizeWranglerChild(child, {
                timeoutMs: 5,
                terminationGraceMs: 50,
                killGraceMs: 5,
            })
        ).rejects.toThrow("timed out after 5ms");
        expect(signals).toEqual(["SIGTERM"]);
    });

    test("renders one exact wrangler target and pins every direct package dependency", () => {
        const digest = "a".repeat(64);
        const target = `chardb-vx-proof-${digest.slice(0, 10)}-${NONCE}`;
        const rendered = renderCloudflareVectorizeProofWrangler(
            ['name = "__WORKER_NAME__"', 'index_name = "__INDEX_NAME__"', 'release = "__RELEASE_SHA256__"'].join("\n"),
            { worker: target, index: target, releaseSha256: digest }
        );
        expect(rendered).toContain(`name = "${target}"`);
        expect(rendered).toContain(`index_name = "${target}"`);
        expect(rendered).toContain(`release = "${digest}"`);
        expect(rendered).not.toContain("__");
        expect(() =>
            renderCloudflareVectorizeProofWrangler(
                "__WORKER_NAME__ __WORKER_NAME__ __INDEX_NAME__ __RELEASE_SHA256__",
                {
                    worker: target,
                    index: target,
                    releaseSha256: digest,
                }
            )
        ).toThrow("exactly once");
        expect(() =>
            renderCloudflareVectorizeProofWrangler("__WORKER_NAME__ __INDEX_NAME__ __RELEASE_SHA256__", {
                worker: target,
                index: `${target}-other`,
                releaseSha256: digest,
            })
        ).toThrow("share the exact disposable name");

        expect(renderCloudflareVectorizeProofPackage()).toMatchObject({
            private: true,
            dependencies: {
                "@noble/hashes": "1.8.0",
                "better-auth": "1.6.30",
                "@chardb/core": "file:./chardb-proof.tgz",
                "drizzle-orm": "0.45.2",
                zod: "4.4.3",
            },
            devDependencies: {
                "@cloudflare/workers-types": "5.20260830.1",
                typescript: "5.9.3",
                wrangler: CLOUDFLARE_VECTORIZE_PROOF_WRANGLER_VERSION,
            },
        });
        expect(() => renderCloudflareVectorizeProofPackage("../candidate.tgz")).toThrow("parent traversal");
    });

    test("emits only newline-safe secrets and enforces the npm lock resolution", () => {
        const secrets = renderCloudflareVectorizeProofSecrets({
            betterAuthSecret: AUTH_SECRET,
            adminToken: ADMIN_TOKEN,
            runId: RUN_ID,
        });
        expect(secrets).toBe(
            `BETTER_AUTH_SECRET=${AUTH_SECRET}\nCDB_ADMIN_TOKEN=${ADMIN_TOKEN}\nCDB_PROOF_RUN_ID=${RUN_ID}\n`
        );
        expect(() =>
            renderCloudflareVectorizeProofSecrets({
                betterAuthSecret: `${AUTH_SECRET}\nLEAK=1`,
                adminToken: ADMIN_TOKEN,
                runId: RUN_ID,
            })
        ).toThrow("secret is invalid");
        expect(assertCloudflareVectorizeProofPackageLock(packageLock())).toBeTruthy();
        const drifted = structuredClone(packageLock()) as { packages: Record<string, { version?: string }> };
        const wrangler = drifted.packages["node_modules/wrangler"];
        if (!wrangler) throw new Error("test package lock has no Wrangler entry");
        wrangler.version = "4.126.0";
        expect(() => assertCloudflareVectorizeProofPackageLock(drifted)).toThrow("wrangler 4.125.0");
        const nobleDrifted = structuredClone(packageLock()) as { packages: Record<string, { version?: string }> };
        const noble = nobleDrifted.packages["node_modules/@noble/hashes"];
        if (!noble) throw new Error("test package lock has no Noble hashes entry");
        noble.version = "1.8.1";
        expect(() => assertCloudflareVectorizeProofPackageLock(nobleDrifted)).toThrow("@noble/hashes 1.8.0");
        expect(assertCloudflareVectorizeProofBenchmark(benchmark())).toEqual(benchmark());
        expect(() =>
            assertCloudflareVectorizeProofBenchmark({
                ...benchmark(),
                localRemoteBinding: {
                    ...benchmark().localRemoteBinding,
                    samples: benchmark().localRemoteBinding.samples.slice(1),
                },
            })
        ).toThrow("exactly five");
        expect(() =>
            assertCloudflareVectorizeProofBenchmark({
                ...benchmark(),
                localRemoteQueryStability: {
                    ...benchmark().localRemoteQueryStability,
                    queryStabilityIntervalMs: 250,
                },
            })
        ).toThrow("query stability contract drifted");
        const fullArtifact = {
            workload: {
                id: "ready-vector-filtered-search-v2",
                dimensions: 32,
                metric: "cosine",
                topK: 1,
                requestsPerSample: 1,
                warmupSamples: 1,
                measuredSamples: 5,
            },
            sampling: {
                warmup: { sequence: -1, excluded: true, elapsedMs: 9 },
                samples: [1, 2, 3, 4, 5].map((elapsedMs, sequence) => ({
                    sequence,
                    excluded: false,
                    elapsedMs,
                })),
            },
            track: { label: "local-workerd-fake-vectorize", samplesMs: [1, 2, 3, 4, 5] },
        };
        expect(cloudflareVectorizeProofBenchmarkTrack(fullArtifact, "local-workerd-fake-vectorize")).toEqual({
            ...benchmark().localFake,
            warmup: { ...benchmark().localFake.warmup, elapsedMs: 9 },
        });
        expect(() =>
            cloudflareVectorizeProofBenchmarkTrack(
                { ...fullArtifact, workload: { ...fullArtifact.workload, dimensions: 3 } },
                "local-workerd-fake-vectorize"
            )
        ).toThrow("workload dimensions drifted");
    });

    test("rejects a prepared candidate whose runtime or type bridge export contract drifted", async () => {
        const root = await temporaryRoot();
        const internal = path.join(root, "node_modules", "@chardb", "core", "dist", "internal");
        await mkdir(internal, { recursive: true });
        const runtimeExports = [
            "CDB_VECTOR_DELIVERY_SETTLEMENT_MS",
            "CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR",
            "cdbVectorLogicalId",
            "cdbVectorResourceId",
            "cdbVectorizeOrganizationNamespace",
            "cdbVectorizePhysicalId",
            "cdbVectorizeResourceFilter",
            "collectSchemaResourceDescriptors",
            "deleteCdbVector",
            "dispatchOrganizationVectorSearch",
            "isChardbVectorResourceDescriptor",
            "parseCdbVectorizePhysicalId",
            "stageCdbVector",
            "vector",
            "vshardOf",
        ].sort();
        const typeExports = [
            ...runtimeExports,
            "CdbValidatedVectorMatch",
            "CdbVectorizeMatch",
            "CdbVectorizeMutationIndex",
            "CdbVectorizeRecord",
            "CdbVectorizeSearchIndex",
            "OrganizationVectorSearchValidation",
        ].sort();
        const exportSource = (names: readonly string[]) => `export { ${names.join(", ")} };\n`;
        const runtimePath = path.join(internal, "vector-proof.mjs");
        const typesPath = path.join(internal, "vector-proof.d.mts");
        await writeFile(runtimePath, exportSource(runtimeExports));
        await writeFile(typesPath, exportSource(typeExports));

        expect(await assertCloudflareVectorizeProofCandidateBridge(root)).toEqual({
            runtimeExports,
            typeExports,
        });

        const withoutTerminalError = runtimeExports.filter(
            name => name !== "CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR"
        );
        await writeFile(runtimePath, exportSource(withoutTerminalError));
        await expect(assertCloudflareVectorizeProofCandidateBridge(root)).rejects.toThrow(
            "missing CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR"
        );

        await writeFile(runtimePath, exportSource(runtimeExports));
        await writeFile(typesPath, exportSource(typeExports.filter(name => name !== "CdbVectorizeRecord")));
        await expect(assertCloudflareVectorizeProofCandidateBridge(root)).rejects.toThrow("missing CdbVectorizeRecord");
    });

    test("plans install, typecheck, doctor, and dry run without a shell or remote deploy", async () => {
        const root = await temporaryRoot();
        const app = path.join(root, "private", "app");
        const privateDir = path.join(root, "private");
        const commands = planCloudflareVectorizePreparationCommands({ app, privateDir, npmExecutable: "npm-test" });
        expect(commands.map(command => command.phase)).toEqual([
            "package-lock",
            "install",
            "typecheck",
            "wrangler-doctor",
            "worker-dry-run",
        ]);
        expect(commands[0]).toEqual({
            phase: "package-lock",
            executable: "npm-test",
            args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
        });
        expect(commands[3]?.executable).toBe(path.join(app, "node_modules", ".bin", "chardb"));
        expect(commands[4]?.args).toContain("--dry-run");
        expect(commands[4]?.args).not.toContain("--remote");

        await mkdir(app, { recursive: true });
        const phases: string[] = [];
        await validateCloudflareVectorizeProofApp(
            { app, privateDir, baseEnvironment: { CLOUDFLARE_API_TOKEN: "must-not-pass", PATH: "/bin" } },
            {
                assertCandidateBridge: async value => {
                    expect(value).toBe(app);
                    phases.push("candidate-bridge");
                },
                run: async invocation => {
                    phases.push(invocation.phase);
                    expect(invocation.environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
                    expect(invocation.environment.PATH).toBe("/bin");
                    if (invocation.phase === "package-lock") {
                        await writeFile(path.join(app, "package-lock.json"), JSON.stringify(packageLock()));
                    }
                    return { exitCode: 0, stdout: "", stderr: "" };
                },
            }
        );
        expect(phases).toEqual([
            "package-lock",
            "install",
            "candidate-bridge",
            "typecheck",
            "wrangler-doctor",
            "worker-dry-run",
        ]);
    });

    test("redacts secrets from command failures and detects evidence leaks", async () => {
        const root = await temporaryRoot();
        const app = path.join(root, "private", "app");
        const preparationLog = path.join(root, "private", "wrangler-prepare.log");
        await mkdir(app, { recursive: true });
        const error = await validateCloudflareVectorizeProofApp(
            { app, privateDir: path.dirname(app), secrets: [ADMIN_TOKEN] },
            {
                run: async () => {
                    await writeFile(preparationLog, `profile token ${ADMIN_TOKEN}\n`, { mode: 0o600 });
                    return { exitCode: 1, stdout: `failed with ${ADMIN_TOKEN}`, stderr: "" };
                },
            }
        ).catch(cause => cause);
        expect(String(error)).toContain("[redacted]");
        expect(String(error)).not.toContain(ADMIN_TOKEN);
        expect(await Bun.file(preparationLog).exists()).toBe(false);
        const evidence = path.join(root, "evidence.json");
        await writeFile(evidence, `{"token":"${ADMIN_TOKEN}"}`);
        await expect(assertNoCloudflareVectorizeProofSecrets([evidence], [ADMIN_TOKEN])).rejects.toThrow(
            "secret leaked"
        );
    });

    test("persists bounded redacted AggregateError causes without recursive data", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        const nested = new AggregateError([], `nested ${RUN_ID}`);
        nested.errors.push(nested);
        const causes: unknown[] = [
            new Error(`first ${ADMIN_TOKEN}`),
            Object.assign(new Error(`second ${AUTH_SECRET}`), { name: `Named${RUN_ID}` }),
            new Error(`${"🙂".repeat(1_000)}${ADMIN_TOKEN}`),
            `plain ${AUTH_SECRET}`,
            nested,
            new Error("six"),
            new Error("seven"),
            new Error("eight"),
            new Error("nine"),
            new Error("ten"),
        ];
        const aggregate = new AggregateError(causes, `${"🙂".repeat(1_000)}${ADMIN_TOKEN}`);
        const failure = executePreparedCloudflareVectorizeProof(
            { prepared, accountId: ACCOUNT_ID },
            {
                produceLocalFakeBenchmark: async () => {
                    throw aggregate;
                },
                provision: async () => {
                    throw new Error("provision must not run");
                },
                lifecycle: {} as never,
            }
        );

        const thrown = await failure.catch(cause => cause);
        const evidencePath = path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json");
        const checksumPath = path.join(path.dirname(prepared.preparationPath), "execution.sha256");
        const evidenceBytes = await readFile(evidencePath);
        const evidence = JSON.parse(evidenceBytes.toString("utf8"));

        expect(thrown).toBeInstanceOf(Error);
        expect(Buffer.byteLength(evidence.error.name)).toBeLessThanOrEqual(128);
        expect(Buffer.byteLength(evidence.error.message)).toBeLessThanOrEqual(2_048);
        expect(evidence.error).toMatchObject({
            name: "AggregateError",
            causeOverflowCount: 2,
        });
        expect(evidence.error.causes).toHaveLength(8);
        expect(evidence.error.causes.map((cause: { name: string }) => cause.name)).toEqual([
            "Error",
            "Named[redacted]",
            "Error",
            "Error",
            "AggregateError",
            "Error",
            "Error",
            "Error",
        ]);
        for (const cause of evidence.error.causes) {
            expect(Object.keys(cause).sort()).toEqual(["message", "name"]);
            expect(Buffer.byteLength(cause.name)).toBeLessThanOrEqual(128);
            expect(Buffer.byteLength(cause.message)).toBeLessThanOrEqual(1_024);
        }
        expect(evidence.error.causes[4].message).toBe("nested [redacted]");
        expect(evidence.cleanup).toMatchObject({ required: false, attempted: false });
        expect(JSON.stringify(evidence)).not.toContain(ADMIN_TOKEN);
        expect(JSON.stringify(evidence)).not.toContain(AUTH_SECRET);
        expect(JSON.stringify(evidence)).not.toContain(RUN_ID);
        expect(JSON.stringify(evidence.error)).not.toContain("stack");
        const digest = createHash("sha256").update(evidenceBytes).digest("hex");
        expect(await readFile(checksumPath, "utf8")).toBe(`${digest}  vectorize-proof-execution.json\n`);
    });

    test("prepares a candidate-bound private app and public checksum without contacting Cloudflare", async () => {
        const root = await temporaryRoot();
        const tarball = path.join(root, "candidate.tgz");
        const output = path.join(root, "public");
        const privateDir = path.join(root, "private");
        await writeFile(tarball, "exact candidate archive bytes");
        const invocations: VectorizePreparationInvocation[] = [];
        const prepared = await prepareCloudflareVectorizeProof(
            {
                tarball,
                output,
                privateDir,
                workersDevSubdomain: "zpg6",
                nonce: NONCE,
                runId: RUN_ID,
                betterAuthSecret: AUTH_SECRET,
                adminToken: ADMIN_TOKEN,
                baseEnvironment: { CLOUDFLARE_API_TOKEN: "ambient-token", PATH: "/bin" },
            },
            {
                assertCandidateBridge: acceptCandidateBridge,
                run: async invocation => {
                    invocations.push(invocation);
                    if (invocation.phase === "package-lock") {
                        await writeFile(path.join(invocation.cwd, "package-lock.json"), JSON.stringify(packageLock()));
                    }
                    return { exitCode: 0, stdout: "ok", stderr: "" };
                },
            }
        );
        expect(invocations.map(invocation => invocation.phase)).toEqual([
            "package-lock",
            "install",
            "typecheck",
            "wrangler-doctor",
            "worker-dry-run",
        ]);
        expect(invocations.every(invocation => invocation.environment.CLOUDFLARE_API_TOKEN === undefined)).toBeTrue();
        expect(prepared.candidate).toEqual({
            algorithm: "sha256",
            digest: hash("exact candidate archive bytes"),
            bytes: 29,
        });
        expect(prepared.target.worker).toBe(`chardb-vx-proof-${prepared.candidate.digest.slice(0, 10)}-${NONCE}`);
        expect(prepared.target.index).toBe(prepared.target.worker);
        expect(prepared.origin).toBe(`https://${prepared.target.worker}.zpg6.workers.dev`);
        expect(Bun.TOML.parse(await readFile(prepared.config, "utf8"))).toHaveProperty("durable_objects.bindings", [
            { name: "CDB_CATALOG", class_name: "Catalog" },
            { name: "CDB_SHARD", class_name: "Cdb" },
            { name: "CDB_GATEWAY", class_name: "Gateway" },
            { name: "CDB_RESHARD", class_name: "Resharder" },
        ]);
        expect(prepared.deploymentInput.files.map(file => file.path)).toEqual(
            [...prepared.deploymentInput.files.map(file => file.path)].sort()
        );
        const candidateRecord = prepared.deploymentInput.files.find(file => file.path === "chardb-proof.tgz");
        expect(candidateRecord).toMatchObject({
            bytes: prepared.candidate.bytes,
            sha256: prepared.candidate.digest,
        });
        expect(prepared.deploymentInput.digest).toBe(hash(JSON.stringify(prepared.deploymentInput.files)));
        expect((await stat(prepared.secretsFile)).mode & 0o777).toBe(0o600);
        expect((await stat(privateDir)).mode & 0o777).toBe(0o700);
        expect(await readFile(prepared.secretsFile, "utf8")).toContain(`BETTER_AUTH_SECRET=${AUTH_SECRET}`);
        const evidence = JSON.parse(await readFile(prepared.preparationPath, "utf8"));
        expect(evidence).toMatchObject({
            schema: CLOUDFLARE_VECTORIZE_PROOF_PREPARATION_SCHEMA,
            candidate: prepared.candidate,
            target: prepared.target,
            wranglerVersion: "4.125.0",
            deploymentInput: prepared.deploymentInput,
            mutatingCommandsExecuted: false,
            secretScan: { passed: true, filesScanned: 14 },
        });
        const checksum = await readFile(prepared.checksumPath, "utf8");
        expect(checksum).toBe(`${hash(await readFile(prepared.preparationPath))}  vectorize-proof-preparation.json\n`);
        for (const file of [
            prepared.preparationPath,
            prepared.checksumPath,
            path.join(output, "vectorize-proof-plan.json"),
        ]) {
            const text = await readFile(file, "utf8");
            expect(text).not.toContain(AUTH_SECRET);
            expect(text).not.toContain(ADMIN_TOKEN);
            expect(text).not.toContain(RUN_ID);
        }
    });

    test("fingerprinting rejects symlinks and changing the candidate fails before validation", async () => {
        const root = await temporaryRoot();
        const app = path.join(root, "app");
        await mkdir(app);
        await writeFile(path.join(app, "real.txt"), "real");
        await symlink("real.txt", path.join(app, "link.txt"));
        await expect(fingerprintCloudflareVectorizeDeployment(app, ["link.txt"])).rejects.toThrow("regular file");

        const tarball = path.join(root, "candidate.tgz");
        const output = path.join(root, "output");
        const privateDir = path.join(root, "private");
        await writeFile(tarball, "candidate before");
        const result = prepareCloudflareVectorizeProof(
            {
                tarball,
                output,
                privateDir,
                workersDevSubdomain: "zpg6",
                nonce: NONCE,
                runId: RUN_ID,
                betterAuthSecret: AUTH_SECRET,
                adminToken: ADMIN_TOKEN,
            },
            {
                assertCandidateBridge: acceptCandidateBridge,
                run: async invocation => {
                    if (invocation.phase === "package-lock") {
                        await writeFile(path.join(invocation.cwd, "package-lock.json"), JSON.stringify(packageLock()));
                        await writeFile(tarball, "candidate after");
                    }
                    return { exitCode: 0, stdout: "", stderr: "" };
                },
            }
        );
        await expect(result).rejects.toThrow("candidate changed during preparation");
    });

    test("composes provisioning, owned IDs, redeploy, controller, and cleanup through the stored profile", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        const events: string[] = [];
        const initial = {
            deploymentId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
            number: 1,
            percentage: 100 as const,
        };
        const second = {
            deploymentId: "33333333-3333-4333-8333-333333333333",
            versionId: "44444444-4444-4444-8444-444444444444",
            number: 2,
            percentage: 100 as const,
        };
        const result = await executePreparedCloudflareVectorizeProof(
            {
                prepared,
                accountId: ACCOUNT_ID,
                baseEnvironment: {
                    PATH: "/bin",
                    BETTER_AUTH_SECRET: "ambient-better-auth",
                    CDB_ADMIN_TOKEN: "ambient-admin",
                    CDB_PROOF_RUN_ID: "ambient-run",
                },
            },
            {
                produceLocalFakeBenchmark: async () => {
                    events.push("local-fake");
                    return benchmark().localFake;
                },
                provision: async input => {
                    events.push("provision");
                    expect(input.profile).toBe("default");
                    expect(input.apiToken).toBeUndefined();
                    expect(input.baseEnvironment).toEqual({ PATH: "/bin" });
                    expect(input.pollTimeoutMs).toBe(120_000);
                    expect(input.settlementTimeoutMs).toBe(600_000);
                    expect(input.wranglerExecutable).toBe(path.join(prepared.app, "node_modules", ".bin", "wrangler"));
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        Object.assign(value, {
                            workerAbsentConfirmed: true,
                            indexAbsentConfirmed: true,
                            indexCreateIntent: true,
                            indexCreated: true,
                            metadataIndexCreateIntent: true,
                            metadataIndexCreated: true,
                            workerCreateIntent: true,
                            workerCreated: true,
                        });
                    });
                    return { ledger, deployment: initial, accountVerification: ACCOUNT_VERIFICATION } as never;
                },
                appendOwnedIds: async (ledgerPath, candidateSha256, ids) => {
                    events.push(`append:${ids.join(",")}`);
                    expect(ledgerPath).toBe(prepared.ledgerPath);
                    expect(candidateSha256).toBe(prepared.candidate.digest);
                    const ledger = await writeLedger(ledgerPath, value => {
                        value.knownPhysicalIds = [...new Set([...(value.knownPhysicalIds as string[]), ...ids])];
                    });
                    return ledger as never;
                },
                produceLocalRemoteBenchmark: async (input, dependencies) => {
                    events.push("local-remote");
                    expect(events).toContain("provision");
                    expect(input.prepared).toBe(prepared);
                    expect(input.wrangler).toBe(path.join(prepared.app, "node_modules", ".bin", "wrangler"));
                    expect(input.timeoutMs).toBe(600_000);
                    await dependencies.appendOwnedIds({
                        vectorId: `vec1_${"a".repeat(64)}`,
                        action: "create",
                        nextVersion: 2,
                        physicalIds: [REMOTE_PHYSICAL_ID],
                    });
                    return {
                        track: benchmark().localRemoteBinding,
                        evidence: {
                            localRemotePassed: true,
                            candidateSha256: prepared.candidate.digest,
                            physicalIds: [REMOTE_PHYSICAL_ID],
                            queryStability: queryStability(),
                            postStabilitySampling: benchmark().localRemotePostStabilitySampling,
                        },
                    };
                },
                redeploy: async input => {
                    events.push("redeploy");
                    expect(input.initialVersionId).toBe(initial.versionId);
                    expect(input.profile).toBe("default");
                    expect(input.pollTimeoutMs).toBe(120_000);
                    expect(input.settlementTimeoutMs).toBe(600_000);
                    return { deployment: second, accountVerification: ACCOUNT_VERIFICATION };
                },
                lifecycle: {
                    requestJson: async (input: { path: string; headers?: HeadersInit; body?: unknown }) => {
                        events.push("release");
                        expect(input.path).toBe("/proof/vector-fault/release");
                        expect(new Headers(input.headers).get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
                        expect(new Headers(input.headers).get("x-chardb-proof-run-id")).toBe(RUN_ID);
                        expect(input.body).toEqual({
                            organizationId: "org-owning",
                            vectorId: `vec1_${"a".repeat(64)}`,
                            gateDeadline: 10_000,
                            physicalIds: [PHYSICAL_ID],
                            payloadSha256: "b".repeat(64),
                        });
                        return {
                            status: 200,
                            headers: new Headers(),
                            body: { released: true, gateDeadline: 10_000 },
                        };
                    },
                } as never,
                createController: dependencies => ({
                    run: async input => {
                        events.push("controller");
                        expect(input.admin).toEqual({ token: ADMIN_TOKEN, runId: RUN_ID });
                        expect(input.releaseSha256).toBe(prepared.candidate.digest);
                        expect(input.initialVersion).toEqual(initial);
                        expect(input.benchmark).toEqual({
                            workloadId: benchmark().workloadId,
                            localFake: benchmark().localFake,
                        });
                        expect(input.timeoutMs).toBe(600_000);
                        await dependencies.appendOwnedIds({
                            vectorId: `vec1_${"a".repeat(64)}`,
                            action: "create",
                            nextVersion: 1,
                            physicalIds: [PHYSICAL_ID],
                        });
                        await dependencies.appendOwnedIds({
                            vectorId: `vec1_${"a".repeat(64)}`,
                            action: "replace",
                            nextVersion: 2,
                            physicalIds: [DEPLOYED_REPLACEMENT_ID],
                        });
                        await dependencies.appendOwnedIds({
                            vectorId: `vec1_${"b".repeat(64)}`,
                            action: "create",
                            nextVersion: 1,
                            physicalIds: [LIVE_CREATE_ID],
                        });
                        await dependencies.appendOwnedIds({
                            vectorId: `vec1_${"b".repeat(64)}`,
                            action: "replace",
                            nextVersion: 2,
                            physicalIds: [LIVE_REPLACEMENT_ID],
                        });
                        events.push("send");
                        const redeployed = await dependencies.redeploy({
                            state: {} as never,
                            claim: {
                                vectorId: `vec1_${"a".repeat(64)}`,
                                organizationId: "org-owning",
                                resourceId: `vr1_${"c".repeat(64)}`,
                                rowPk: "document-1",
                                deliveredVersion: 0,
                                claimTokenSha256: "a".repeat(64),
                                targetVersion: 1,
                                operation: "upsert",
                                phase: "submit",
                                attempts: 1,
                                leasedUntil: 20_000,
                                gateDeadline: 10_000,
                                physicalIds: [PHYSICAL_ID],
                                payloadSha256: "b".repeat(64),
                            },
                            initialVersion: initial,
                        });
                        expect(redeployed).toEqual(second);
                        await dependencies.releaseFault({
                            state: { head: { organizationId: "org-owning" } } as never,
                            claim: {
                                vectorId: `vec1_${"a".repeat(64)}`,
                                gateDeadline: 10_000,
                                physicalIds: [PHYSICAL_ID],
                                payloadSha256: "b".repeat(64),
                            },
                        });
                        events.push("deployed-lifecycle");
                        await dependencies.recordDeployedLifecycle?.({
                            lifecycle: { workerRedeployDuringLease: true },
                            deletion: { absent: true },
                            deployedBenchmark: { track: { realVectorize: true } },
                        });
                        const comparison = await dependencies.loadComparisonBenchmark?.();
                        expect(comparison).toEqual({
                            localRemoteBinding: benchmark().localRemoteBinding,
                            localRemoteQueryStability: benchmark().localRemoteQueryStability,
                            localRemotePostStabilitySampling: benchmark().localRemotePostStabilitySampling,
                        });
                        return reportReadyLifecycle(initial, second);
                    },
                }),
                cleanup: async input => {
                    events.push("cleanup");
                    expect(input.pollTimeoutMs).toBe(120_000);
                    expect(input.settlementTimeoutMs).toBe(600_000);
                    const beforeCleanup = JSON.parse(
                        await readFile(
                            path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"),
                            "utf8"
                        )
                    );
                    expect(beforeCleanup).toMatchObject({
                        ok: false,
                        phase: "cleanup",
                        cleanup: null,
                        reportGenerated: false,
                    });
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        value.workerDeleted = true;
                        value.indexDeleted = true;
                    });
                    return {
                        ledger,
                        discoveredPhysicalIds: [
                            PHYSICAL_ID,
                            DEPLOYED_REPLACEMENT_ID,
                            LIVE_CREATE_ID,
                            LIVE_REPLACEMENT_ID,
                        ],
                        finalVectorCount: 0,
                        workerAbsent: true,
                        indexAbsent: true,
                    } as never;
                },
            }
        );
        expect(events.indexOf(`append:${PHYSICAL_ID}`)).toBeLessThan(events.indexOf("send"));
        expect(events).toEqual([
            "local-fake",
            "provision",
            "controller",
            `append:${PHYSICAL_ID}`,
            `append:${DEPLOYED_REPLACEMENT_ID}`,
            `append:${LIVE_CREATE_ID}`,
            `append:${LIVE_REPLACEMENT_ID}`,
            "send",
            "redeploy",
            "release",
            "deployed-lifecycle",
            "local-remote",
            `append:${REMOTE_PHYSICAL_ID}`,
            "cleanup",
        ]);
        expect(result.evidence).toMatchObject({
            schema: "chardb.cloudflare-vectorize-proof.execution.v2",
            ok: true,
            phase: "complete",
            checkpoint: null,
            profile: "default",
            reportGenerated: true,
            redeploy: second,
            lifecycle: { delivery: { initial: { physicalId: PHYSICAL_ID } } },
            deployedLifecycle: {
                lifecycle: { workerRedeployDuringLease: true },
                deletion: { absent: true },
                deployedBenchmark: { track: { realVectorize: true } },
            },
            cleanup: {
                required: true,
                attempted: true,
                workerAbsent: true,
                indexAbsent: true,
                knownPhysicalIdCount: 5,
            },
        });
        expect((result.evidence.lifecycle as { settlement: Record<string, unknown> }).settlement).toEqual({
            configuredMs: 120_000,
            samplesMs: [1, 2, 3],
            minMs: 1,
            medianMs: 2,
            p95Ms: 3,
            maxMs: 3,
            transientHttpFailureCount: 0,
            transientHttpFailureCounts: [],
            transientHttpFailureOverflowCount: 0,
            hardBoundClaimed: false,
        });
        const serialized = await readFile(result.evidencePath, "utf8");
        expect(serialized).not.toContain(AUTH_SECRET);
        expect(serialized).not.toContain(ADMIN_TOKEN);
        expect(serialized).not.toContain(RUN_ID);
        expect(await readFile(result.checksumPath, "utf8")).toBe(
            `${hash(await readFile(result.evidencePath))}  vectorize-proof-execution.json\n`
        );
        expect(result.reportPath).toBe(
            path.join(path.dirname(prepared.preparationPath), "vectorize-proof-report.json")
        );
        expect(await readFile(result.reportChecksumPath, "utf8")).toBe(
            `${hash(await readFile(result.reportPath))}  vectorize-proof-report.json\n`
        );
    });

    test("refuses deployment-tree drift before any benchmark or Cloudflare mutation", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        await writeFile(path.join(prepared.app, "src", "worker.ts"), "export default { fetch() {} };\n");
        let benchmarkCalls = 0;
        let provisionCalls = 0;
        await expect(
            executePreparedCloudflareVectorizeProof(
                { prepared, accountId: ACCOUNT_ID },
                {
                    produceLocalFakeBenchmark: async () => {
                        benchmarkCalls++;
                        return benchmark().localFake;
                    },
                    provision: async () => {
                        provisionCalls++;
                        throw new Error("must not provision");
                    },
                }
            )
        ).rejects.toThrow("deployment input changed before execution");
        expect(benchmarkCalls).toBe(0);
        expect(provisionCalls).toBe(0);
    });

    test("rechecks the deployment tree after the local benchmark and before provisioning", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        let provisionCalls = 0;
        await expect(
            executePreparedCloudflareVectorizeProof(
                { prepared, accountId: ACCOUNT_ID },
                {
                    produceLocalFakeBenchmark: async () => {
                        await writeFile(
                            path.join(prepared.app, "src", "worker.ts"),
                            "export default { fetch() {} };\n"
                        );
                        return benchmark().localFake;
                    },
                    provision: async () => {
                        provisionCalls++;
                        throw new Error("must not provision");
                    },
                }
            )
        ).rejects.toThrow("deployment input changed before execution");
        expect(provisionCalls).toBe(0);
    });

    test("preserves failed lifecycle evidence, runs owned cleanup, and keeps report success false", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        let cleaned = 0;
        const failure = executePreparedCloudflareVectorizeProof(
            { prepared, accountId: ACCOUNT_ID },
            {
                produceLocalFakeBenchmark: async () => benchmark().localFake,
                provision: async () => {
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        Object.assign(value, {
                            workerAbsentConfirmed: true,
                            indexAbsentConfirmed: true,
                            indexCreateIntent: true,
                            indexCreated: true,
                            workerCreateIntent: true,
                            workerCreated: true,
                        });
                    });
                    return {
                        ledger,
                        deployment: {
                            deploymentId: "deployment-1",
                            versionId: "version-1",
                            number: 1,
                            percentage: 100,
                        },
                        accountVerification: ACCOUNT_VERIFICATION,
                    } as never;
                },
                lifecycle: { requestJson: async () => ({}) } as never,
                produceLocalRemoteBenchmark: async (_input, dependencies) => {
                    await dependencies.appendOwnedIds({
                        vectorId: `vec1_${"a".repeat(64)}`,
                        action: "create",
                        nextVersion: 2,
                        physicalIds: [REMOTE_PHYSICAL_ID],
                    });
                    return {
                        track: benchmark().localRemoteBinding,
                        evidence: {
                            localRemotePassed: true,
                            candidateSha256: prepared.candidate.digest,
                            physicalIds: [REMOTE_PHYSICAL_ID],
                            queryStability: queryStability(),
                            postStabilitySampling: benchmark().localRemotePostStabilitySampling,
                        },
                    };
                },
                createController: dependencies => ({
                    run: async () => {
                        await dependencies.checkpoint?.("replace-mutation");
                        throw new CloudflareVectorizeProofHttpError(
                            `upstream response body contained ${ADMIN_TOKEN}`,
                            503,
                            "CDB_ROUTE_UNAVAILABLE"
                        );
                    },
                }),
                cleanup: async () => {
                    cleaned++;
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        value.workerDeleted = true;
                        value.indexDeleted = true;
                    });
                    return { ledger, workerAbsent: true, indexAbsent: true } as never;
                },
            }
        );
        const error = await failure.catch(cause => cause);
        expect(cleaned).toBe(1);
        expect(String(error)).toContain("HTTP request failed");
        expect(String(error)).not.toContain(ADMIN_TOKEN);
        const evidence = JSON.parse(
            await readFile(path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"), "utf8")
        );
        expect(evidence).toMatchObject({
            ok: false,
            phase: "failed",
            lifecycle: null,
            checkpoint: "controller:replace-mutation",
            cleanup: { required: true, attempted: true, workerAbsent: true, indexAbsent: true },
            error: {
                name: "CloudflareVectorizeProofHttpError",
                message: "Cloudflare Vectorize proof HTTP request failed",
                failureKind: "http",
                protocolReason: null,
                http: { status: 503, code: "CDB_ROUTE_UNAVAILABLE" },
            },
            cleanupError: null,
            reportGenerated: false,
        });
        expect(JSON.stringify(evidence)).not.toContain("upstream response body");
        expect(JSON.stringify(evidence)).not.toContain(ADMIN_TOKEN);
    });

    test("persists cleanup-only failure and recoverable partial ledger state", async () => {
        const { cleanupError, failure, prepared } = await cleanupFailureExecution(await temporaryRoot());

        const thrown = await failure.catch(cause => cause);
        const evidence = JSON.parse(
            await readFile(path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"), "utf8")
        );

        expect(String(thrown)).toContain(cleanupError.message);
        expect(evidence.error).toBeNull();
        expect(evidence.cleanupError).toEqual({ name: "Error", message: cleanupError.message });
        expect(evidence.cleanup).toEqual({
            required: true,
            attempted: true,
            workerAbsent: null,
            indexAbsent: null,
            workerDeleted: true,
            indexDeleted: false,
            knownPhysicalIdCount: 0,
        });
        expect(evidence.ok).toBeFalse();
        expect(evidence.reportGenerated).toBeFalse();
    });

    test("preserves primary and cleanup failures without losing partial cleanup state", async () => {
        const primaryError = new Error("controller failed before cleanup");
        const { cleanupError, failure, prepared } = await cleanupFailureExecution(await temporaryRoot(), primaryError);

        const thrown = await failure.catch(cause => cause);
        const evidence = JSON.parse(
            await readFile(path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"), "utf8")
        );

        expect(String(thrown)).toContain(primaryError.message);
        expect(String(thrown)).toContain(cleanupError.message);
        expect(evidence.error).toEqual({ name: "Error", message: primaryError.message });
        expect(evidence.cleanupError).toEqual({ name: "Error", message: cleanupError.message });
        expect(evidence.cleanup).toMatchObject({
            required: true,
            attempted: true,
            workerDeleted: true,
            indexDeleted: false,
        });
        expect(evidence.ok).toBeFalse();
        expect(evidence.reportGenerated).toBeFalse();
    });

    test("persists secret-free observation timeout state before owned cleanup", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        const latestState = {
            vectorId: `vec1_${"a".repeat(64)}`,
            observedAt: 1_000,
            scheduledAlarmAt: 1_250,
            head: null,
            outbox: null,
            attempts: [],
            acceptances: [],
            fault: {
                mode: "delete_accept_then_throw" as const,
                armed: true,
                inFlight: false,
                fired: false,
                firstPhysicalIds: [],
                firstPayloadSha256: null,
                returnedMutationIdSha256: null,
                acceptedBeforeThrow: false,
                retryCount: 0,
                retryIdsMatched: null,
                retryPayloadMatched: null,
                retryComplete: false,
                gateOpen: false,
                gateDeadline: null,
                updatedAt: 1_000,
            },
        };
        const failure = executePreparedCloudflareVectorizeProof(
            { prepared, accountId: ACCOUNT_ID },
            {
                produceLocalFakeBenchmark: async () => benchmark().localFake,
                provision: async () => {
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        Object.assign(value, {
                            workerAbsentConfirmed: true,
                            indexAbsentConfirmed: true,
                            indexCreateIntent: true,
                            indexCreated: true,
                            workerCreateIntent: true,
                            workerCreated: true,
                        });
                    });
                    return {
                        ledger,
                        deployment: {
                            deploymentId: "deployment-1",
                            versionId: "version-1",
                            number: 1,
                            percentage: 100,
                        },
                        accountVerification: ACCOUNT_VERIFICATION,
                    } as never;
                },
                lifecycle: {} as never,
                createController: dependencies => ({
                    run: async () => {
                        await dependencies.checkpoint?.("delete-response-loss");
                        throw new CloudflareVectorizeProofObservationTimeoutError(
                            "accepted delete response loss",
                            600_000,
                            600_000,
                            latestState as never
                        );
                    },
                }),
                cleanup: async () => {
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        value.workerDeleted = true;
                        value.indexDeleted = true;
                    });
                    return { ledger, workerAbsent: true, indexAbsent: true } as never;
                },
            }
        );

        await expect(failure).rejects.toThrow("Cloudflare Vectorize proof observation timed out");
        const evidence = JSON.parse(
            await readFile(path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"), "utf8")
        );
        expect(evidence).toMatchObject({
            phase: "failed",
            checkpoint: "controller:delete-response-loss",
            error: {
                name: "CloudflareVectorizeProofObservationTimeoutError",
                message: "Cloudflare Vectorize proof observation timed out",
                observation: {
                    label: "accepted delete response loss",
                    timeoutMs: 600_000,
                    elapsedMs: 600_000,
                    latestState: {
                        vectorId: latestState.vectorId,
                        observedAt: 1_000,
                        scheduledAlarmAt: 1_250,
                        fault: { armed: true, fired: false, acceptedBeforeThrow: false },
                    },
                },
            },
            cleanup: { required: true, attempted: true, workerAbsent: true, indexAbsent: true },
        });
        expect(JSON.stringify(evidence)).not.toContain(ADMIN_TOKEN);
    });

    test("persists only bounded candidate classification without raw ids or secrets", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        const failure = executePreparedCloudflareVectorizeProof(
            { prepared, accountId: ACCOUNT_ID },
            {
                produceLocalFakeBenchmark: async () => benchmark().localFake,
                provision: async () => {
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        Object.assign(value, {
                            workerAbsentConfirmed: true,
                            indexAbsentConfirmed: true,
                            indexCreateIntent: true,
                            indexCreated: true,
                            workerCreateIntent: true,
                            workerCreated: true,
                        });
                    });
                    return {
                        ledger,
                        deployment: {
                            deploymentId: "deployment-1",
                            versionId: "version-1",
                            number: 1,
                            percentage: 100,
                        },
                        accountVerification: ACCOUNT_VERIFICATION,
                    } as never;
                },
                lifecycle: {} as never,
                createController: dependencies => ({
                    run: async () => {
                        await dependencies.checkpoint?.("adversary-policy");
                        throw new CloudflareVectorizeProofCandidateClassificationError(
                            `unrelated candidate ${ADMIN_TOKEN} ${PHYSICAL_ID}`,
                            {
                                candidateCount: 2,
                                stalePresent: false,
                                currentPresent: true,
                                otherCandidateCount: 1,
                                queryIdentityMatch: true,
                            }
                        );
                    },
                }),
                cleanup: async () => {
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        value.workerDeleted = true;
                        value.indexDeleted = true;
                    });
                    return { ledger, workerAbsent: true, indexAbsent: true } as never;
                },
            }
        );

        await expect(failure).rejects.toThrow("Cloudflare Vectorize proof candidate classification failed");
        const evidence = JSON.parse(
            await readFile(path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"), "utf8")
        );
        expect(evidence).toMatchObject({
            phase: "failed",
            checkpoint: "controller:adversary-policy",
            error: {
                name: "CloudflareVectorizeProofCandidateClassificationError",
                message: "Cloudflare Vectorize proof candidate classification failed",
                classification: {
                    candidateCount: 2,
                    stalePresent: false,
                    currentPresent: true,
                    otherCandidateCount: 1,
                    queryIdentityMatch: true,
                },
            },
            cleanup: { required: true, attempted: true, workerAbsent: true, indexAbsent: true },
        });
        expect(JSON.stringify(evidence)).not.toContain(ADMIN_TOKEN);
        expect(JSON.stringify(evidence)).not.toContain(PHYSICAL_ID);
    });

    test("persists the local-remote checkpoint and terminal deletion evidence before cleanup", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        const failure = executePreparedCloudflareVectorizeProof(
            { prepared, accountId: ACCOUNT_ID, lifecycleTimeoutMs: 25, lifecycleIntervalMs: 10 },
            {
                produceLocalFakeBenchmark: async () => benchmark().localFake,
                provision: async () => {
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        Object.assign(value, {
                            workerAbsentConfirmed: true,
                            indexAbsentConfirmed: true,
                            indexCreateIntent: true,
                            indexCreated: true,
                            workerCreateIntent: true,
                            workerCreated: true,
                        });
                    });
                    return {
                        ledger,
                        deployment: {
                            deploymentId: "deployment-1",
                            versionId: "version-1",
                            number: 1,
                            percentage: 100,
                        },
                        accountVerification: ACCOUNT_VERIFICATION,
                    } as never;
                },
                produceLocalRemoteBenchmark: async (_input, dependencies) => {
                    await dependencies.checkpoint?.("readiness-isolation");
                    throw new CloudflareVectorizeProofSettlementError(
                        "vector deletion failed because external absence could not be proven",
                        {
                            checkpoint: "vector-deleted",
                            outcome: "failed_unproven",
                            timeoutMs: 25,
                            elapsedMs: 20,
                            pollAttempts: 32,
                            phaseProgression: ["submit", "verify"],
                            phaseProgressionOverflowCount: 0,
                            latestState: terminalDeleteState(),
                            transientHttpFailureCount: 0,
                            transientHttpFailureCounts: [],
                            transientHttpFailureOverflowCount: 0,
                            hardBoundClaimed: false,
                        }
                    );
                },
                lifecycle: {} as never,
                createController: dependencies => ({
                    run: async () => {
                        await dependencies.recordDeployedLifecycle?.({
                            lifecycle: { workerRedeployDuringLease: true },
                            deletion: { absent: true },
                            deployedBenchmark: { track: { realVectorize: true } },
                        });
                        await dependencies.loadComparisonBenchmark?.();
                        throw new Error("comparison unexpectedly returned");
                    },
                }),
                cleanup: async () => {
                    const ledger = await writeLedger(prepared.ledgerPath, value => {
                        value.workerDeleted = true;
                        value.indexDeleted = true;
                    });
                    return { ledger, workerAbsent: true, indexAbsent: true } as never;
                },
            }
        );
        await expect(failure).rejects.toThrow("vector deletion failed because external absence could not be proven");
        const evidence = JSON.parse(
            await readFile(path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"), "utf8")
        );
        expect(evidence).toMatchObject({
            ok: false,
            phase: "failed",
            checkpoint: "local-remote:readiness-isolation",
            deployedLifecycle: {
                lifecycle: { workerRedeployDuringLease: true },
                deletion: { absent: true },
                deployedBenchmark: { track: { realVectorize: true } },
            },
            error: {
                name: "CloudflareVectorizeProofSettlementError",
                settlement: {
                    checkpoint: "vector-deleted",
                    outcome: "failed_unproven",
                    timeoutMs: 25,
                    elapsedMs: 20,
                    pollAttempts: 32,
                    phaseProgression: ["submit", "verify"],
                    phaseProgressionOverflowCount: 0,
                    latestState: {
                        vectorId: `vec1_${"a".repeat(64)}`,
                        outbox: {
                            operation: "delete",
                            terminalFailure: true,
                            lastErrorClassification: "delete_absence_unproven",
                            lastErrorSha256: "e".repeat(64),
                        },
                    },
                    hardBoundClaimed: false,
                },
            },
            cleanup: { required: true, attempted: true, workerAbsent: true, indexAbsent: true },
            reportGenerated: false,
        });
    });

    test("skips destructive cleanup before any create intent and does not invent remote absence", async () => {
        const root = await temporaryRoot();
        const prepared = await preparedFixture(root);
        let cleanupCalls = 0;
        const failure = executePreparedCloudflareVectorizeProof(
            { prepared, accountId: ACCOUNT_ID, profile: "default" },
            {
                produceLocalFakeBenchmark: async () => benchmark().localFake,
                provision: async () => {
                    throw new Error("stored profile preflight failed");
                },
                cleanup: async () => {
                    cleanupCalls++;
                    throw new Error("must not run");
                },
                lifecycle: {} as never,
            }
        );
        await expect(failure).rejects.toThrow("stored profile preflight failed");
        expect(cleanupCalls).toBe(0);
        const evidence = JSON.parse(
            await readFile(path.join(path.dirname(prepared.preparationPath), "vectorize-proof-execution.json"), "utf8")
        );
        expect(evidence.cleanup).toEqual({
            required: false,
            attempted: false,
            workerAbsent: null,
            indexAbsent: null,
            workerDeleted: false,
            indexDeleted: false,
            knownPhysicalIdCount: 0,
        });
        expect(evidence.cleanupError).toBeNull();
        expect(evidence.ok).toBe(false);
        expect(evidence.reportGenerated).toBe(false);
    });

    test("parses only exact private mode-0600 controller secrets", async () => {
        const root = await temporaryRoot();
        const secretsFile = path.join(root, "secrets.env");
        await writeFile(
            secretsFile,
            renderCloudflareVectorizeProofSecrets({
                betterAuthSecret: AUTH_SECRET,
                adminToken: ADMIN_TOKEN,
                runId: RUN_ID,
            }),
            { mode: 0o600 }
        );
        expect(await readCloudflareVectorizeProofSecrets(secretsFile)).toEqual({
            betterAuthSecret: AUTH_SECRET,
            adminToken: ADMIN_TOKEN,
            runId: RUN_ID,
        });
        await chmod(secretsFile, 0o644);
        await expect(readCloudflareVectorizeProofSecrets(secretsFile)).rejects.toThrow("mode 0600");
        await chmod(secretsFile, 0o600);
        await writeFile(
            secretsFile,
            `${renderCloudflareVectorizeProofSecrets({ betterAuthSecret: AUTH_SECRET, adminToken: ADMIN_TOKEN, runId: RUN_ID })}EXTRA=value\n`
        );
        await expect(readCloudflareVectorizeProofSecrets(secretsFile)).rejects.toThrow("fields must be exactly");
    });

    test("parses preparation-only CLI arguments and rejects accidental execution options", () => {
        expect(
            parseCloudflareVectorizeOrchestratorArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "evidence",
                "--private-dir",
                "private",
                "--workers-dev-subdomain",
                "zpg6",
                "--confirm-disposable-resources",
            ])
        ).toMatchObject({ workersDevSubdomain: "zpg6", npmExecutable: "npm", confirmed: true });
        expect(
            parseCloudflareVectorizeOrchestratorArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "evidence",
                "--private-dir",
                "private",
                "--workers-dev-subdomain",
                "zpg6",
                "--confirm-disposable-resources",
                "--execute",
                "--account-id",
                ACCOUNT_ID,
            ])
        ).toMatchObject({
            execute: true,
            accountId: ACCOUNT_ID,
            profile: "default",
        });
        expect(() =>
            parseCloudflareVectorizeOrchestratorArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "evidence",
                "--private-dir",
                "private",
                "--workers-dev-subdomain",
                "zpg6",
                "--confirm-disposable-resources",
                "--profile",
                "default",
            ])
        ).toThrow("requires --execute");
    });
});
