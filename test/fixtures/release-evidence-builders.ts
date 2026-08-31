import { createHash } from "node:crypto";
import { BROWSER_PROOF_REQUIRED_INVARIANTS, buildBrowserProofReport } from "../../scripts/browser-proof-report.mjs";
import { compareFileBenchmarkReports } from "../../scripts/compare-file-benchmark.mjs";
import {
    FILE_BENCHMARK_PROFILE,
    FILE_BENCHMARK_WORKLOAD_ID,
    FILE_BENCHMARK_WORKLOAD_VERSION,
    createFileBenchmarkReport,
    summarizeFileBenchmarkRuns,
} from "../../scripts/file-benchmark-report.mjs";
import {
    FILE_RESHARD_BENCHMARK_PHASES,
    FILE_RESHARD_BENCHMARK_PROFILES,
} from "../../scripts/file-reshard-benchmark-report.mjs";
import {
    FILE_RESHARD_DEPLOYMENT_BINDINGS,
    FILE_RESHARD_DEPLOYMENT_CORRECTNESS,
    FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA,
    FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA,
    FILE_RESHARD_LOCAL_BINDINGS,
    compareFileReshardDeploymentSamples,
} from "../../scripts/file-reshard-deployment-proof.mjs";
import { GENERATED_PROJECT_INVARIANTS, buildGeneratedProjectReport } from "../../scripts/generated-project-report.mjs";
import { PACKED_CHAT_INVARIANTS, buildPackedChatReport } from "../../scripts/packed-chat-report.mjs";
import {
    PACKED_LOCAL_VECTOR_CAPABILITY,
    PACKED_PUBLIC_VECTOR_SCHEMA,
    PUBLIC_VECTOR_QUERY_REF,
} from "../../scripts/packed-public-vector-contract.mjs";
import { alternatingTargetOrder } from "../../scripts/run-file-benchmark.mjs";

export interface ExactCandidate {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export function fixtureSha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function reactCandidateFor(candidate: ExactCandidate): ExactCandidate {
    return {
        algorithm: "sha256",
        digest: fixtureSha256(`react:${candidate.digest}:${candidate.bytes}`),
        bytes: candidate.bytes + 17,
    };
}

export function buildGeneratedProjectEvidence(
    candidate: ExactCandidate,
    reactCandidate = reactCandidateFor(candidate)
) {
    return buildGeneratedProjectReport({
        run: { id: "release-admission-generated" },
        packageEvidence: { name: "@chardb/core", version: "0.1.0", tarball: candidate },
        reactPackageEvidence: {
            name: "@chardb/react",
            version: "0.1.0",
            tarball: reactCandidate,
        },
        platform: { name: "test-linux-x64" },
        runtime: { bun: "1.2.22", wrangler: "4.125.0" },
        migrations: {
            initial: { id: "generated-initial-schema", targetVersion: 1, activatedShards: ["ShardDO_0"] },
            upgrade: {
                id: "generated-upgrade-v2",
                fromVersion: 1,
                targetVersion: 2,
                activatedShards: ["ShardDO_0"],
            },
        },
        invariants: Object.fromEntries(GENERATED_PROJECT_INVARIANTS.map(name => [name, true])),
    });
}

export function buildPackedChatEvidence(candidate: ExactCandidate, reactCandidate = reactCandidateFor(candidate)) {
    const route = (path: string) => ({ method: "POST", path, status: 200 });
    return buildPackedChatReport({
        run: { id: "release-admission-chat" },
        packageEvidence: { name: "@chardb/core", version: "0.1.0", tarball: candidate },
        reactPackageEvidence: {
            name: "@chardb/react",
            version: "0.1.0",
            tarball: reactCandidate,
        },
        platform: { operatingSystem: "linux", release: "6.11.0", architecture: "x64" },
        runtime: {
            name: "packed-chat-miniflare-process-restart",
            bun: "1.2.22",
            nodeCompatibility: "22.14.0",
            wrangler: "4.125.0",
            miniflare: "4.20260828.0",
            betterAuth: "1.6.30",
        },
        identity: { ownerUserId: "user-owner", memberUserId: "user-member" },
        organizations: { shared: { id: "org-shared" }, isolated: { id: "org-isolated" } },
        betterAuthRoutes: [
            route("/api/auth/sign-in/anonymous"),
            route("/api/auth/sign-in/anonymous"),
            route("/api/auth/organization/create"),
            route("/api/auth/organization/create"),
            route("/api/auth/organization/set-active"),
            route("/api/auth/organization/set-active"),
            route("/api/auth/organization/set-active"),
            route("/api/auth/organization/invite-member"),
            route("/api/auth/organization/accept-invitation"),
            route("/api/auth/organization/leave"),
        ],
        benchmark: {
            profile: "ci-smoke",
            direct: { type: "chardb-direct-select-benchmark", profile: "ci-smoke", queries: 32, concurrency: 8 },
            live: { type: "chardb-binding-benchmark", profile: "ci-smoke", queries: 4, concurrency: 8 },
        },
        invariants: Object.fromEntries(PACKED_CHAT_INVARIANTS.map(name => [name, true])),
    });
}

export function buildPackedPublicVectorEvidence(
    candidate: ExactCandidate,
    reactCandidate = reactCandidateFor(candidate)
) {
    const queryArgs = { organizationId: "org-browser-proof", values: [1, 0, 0], limit: 5 };
    return {
        schema: PACKED_PUBLIC_VECTOR_SCHEMA,
        ok: true,
        capability: PACKED_LOCAL_VECTOR_CAPABILITY,
        package: { name: "@chardb/core", version: "0.1.0", tarball: candidate },
        reactPackage: {
            name: "@chardb/react",
            version: "0.1.0",
            tarball: reactCandidate,
        },
        proof: {
            schema: PACKED_PUBLIC_VECTOR_SCHEMA,
            queryRef: PUBLIC_VECTOR_QUERY_REF,
            queryArgs,
            observations: [
                { state: "pending", rows: [] },
                { state: "live", rows: [{ rowPk: "message-a", score: 0.98 }] },
                { state: "refetching", rows: [] },
                { state: "live", rows: [{ rowPk: "message-b", score: 0.91 }] },
            ],
            sent: [
                { t: "hello", protocolV: 3, clientId: "browser-proof", jwt: "proof.jwt.value" },
                { t: "sub", subId: 1, ref: PUBLIC_VECTOR_QUERY_REF, args: queryArgs },
                { t: "ack", cookie: "browser-proof:1" },
                { t: "sub", subId: 1, ref: PUBLIC_VECTOR_QUERY_REF, args: queryArgs },
                { t: "ack", cookie: "browser-proof:2" },
            ],
        },
    };
}

export function buildBrowserEvidence(candidate: ExactCandidate, reactCandidate = reactCandidateFor(candidate)) {
    const route = (path: string) => ({ method: "POST", path, status: 200 });
    const sessionIdSha256 = fixtureSha256("release-admission-browser-session");
    const cookieJarSha256 = fixtureSha256("release-admission-browser-cookies");
    return buildBrowserProofReport({
        run: { id: "release-admission-browser", startedAt: "2026-08-30T00:00:00.000Z" },
        package: { name: "@chardb/core", version: "0.1.0", tarball: candidate },
        reactPackage: {
            name: "@chardb/react",
            version: "0.1.0",
            tarball: reactCandidate,
        },
        platform: { operatingSystem: "test" },
        runtime: { name: "wrangler" },
        identity: { userId: "user-1" },
        organizations: {
            first: { id: "org-1", slug: "alpha" },
            second: { id: "org-2", slug: "beta" },
        },
        restart: {
            schema: "chardb.browser-restart-evidence.v1",
            checkpoint: "session-read-before-app-navigation",
            pages: { primary: "about:blank", live: "about:blank" },
            process: { beforePid: 101, afterPid: 202 },
            origins: {
                before: { worker: "http://127.0.0.1:8787", web: "http://127.0.0.1:5173" },
                after: { worker: "http://127.0.0.1:8787", web: "http://127.0.0.1:5173" },
            },
            session: {
                before: {
                    idSha256: sessionIdSha256,
                    userId: "user-1",
                    activeOrganizationId: "org-1",
                },
                after: {
                    idSha256: sessionIdSha256,
                    userId: "user-1",
                    activeOrganizationId: "org-1",
                },
            },
            cookies: { count: 1, beforeSha256: cookieJarSha256, afterSha256: cookieJarSha256 },
            anonymousSignIns: { beforeRestart: 1, afterPreNavigation: 1, afterAppNavigation: 1, freshContext: 1 },
            freshContext: {
                userId: "user-fresh",
                sessionIdSha256: fixtureSha256("release-admission-fresh-browser-session"),
                activeOrganizationId: "org-fresh",
            },
        },
        betterAuthRoutes: [
            route("/api/auth/organization/create"),
            route("/api/auth/organization/create"),
            route("/api/auth/organization/set-active"),
            route("/api/auth/organization/set-active"),
            route("/api/auth/organization/delete"),
        ],
        invariants: Object.fromEntries(BROWSER_PROOF_REQUIRED_INVARIANTS.map(name => [name, true])),
    });
}

function first<Value>(values: readonly Value[]): Value {
    const value = values[0];
    if (value === undefined) throw new Error("release fixture is unexpectedly empty");
    return value;
}

function fileOperationSamples(
    count: number,
    uploadCount: number,
    payloadBytes: number,
    operation: "upload" | "attach" | "download",
    multiplier: number
) {
    const latency = { upload: 10, attach: 5, download: 8 }[operation] * multiplier;
    return Array.from({ length: count }, (_, sequence) => ({
        sequence,
        objectSequence: sequence % uploadCount,
        latencyMs: latency,
        bytes: operation === "attach" ? 0 : payloadBytes,
        correctness: {
            authenticated: true as const,
            organizationIsolated: true as const,
            operationStatus: true as const,
            exactBytes: true as const,
            exactDigest: true as const,
            cleanupComplete: true as const,
        },
    }));
}

function fileLogicalRun(sequence: number, multiplier: number) {
    return {
        sequence,
        startedAt: `2026-08-28T00:00:0${sequence}.000Z`,
        completedAt: `2026-08-28T00:00:0${sequence}.500Z`,
        payloads: FILE_BENCHMARK_PROFILE.payloads.map(payloadPlan => {
            const uploadCount = payloadPlan.operationsPerRun.upload.count;
            const measured = (operation: "upload" | "attach" | "download") => {
                const plan = payloadPlan.operationsPerRun[operation];
                return {
                    elapsedMs:
                        ((plan.count * { upload: 10, attach: 5, download: 8 }[operation]) / plan.concurrency) *
                        multiplier,
                    samples: fileOperationSamples(
                        plan.count,
                        uploadCount,
                        payloadPlan.payloadBytes,
                        operation,
                        multiplier
                    ),
                };
            };
            return {
                name: payloadPlan.name,
                payloadBytes: payloadPlan.payloadBytes,
                payloadSha256: (payloadPlan.name === "small" ? "b" : "c").repeat(64),
                warmup: {
                    excluded: true as const,
                    operations: {
                        upload: first(
                            fileOperationSamples(1, uploadCount, payloadPlan.payloadBytes, "upload", multiplier)
                        ),
                        attach: first(
                            fileOperationSamples(1, uploadCount, payloadPlan.payloadBytes, "attach", multiplier)
                        ),
                        download: first(
                            fileOperationSamples(1, uploadCount, payloadPlan.payloadBytes, "download", multiplier)
                        ),
                    },
                },
                operations: { upload: measured("upload"), attach: measured("attach"), download: measured("download") },
            };
        }),
    };
}

export function buildFileBenchmarkReport(
    kind: "local" | "cloudflare",
    candidate: { readonly sha256: string; readonly bytes: number },
    multiplier = 1
) {
    const runs = Array.from({ length: FILE_BENCHMARK_PROFILE.logicalRuns }, (_, index) =>
        fileLogicalRun(index, multiplier)
    );
    return createFileBenchmarkReport({
        ok: true,
        candidate,
        workload: { id: FILE_BENCHMARK_WORKLOAD_ID, version: FILE_BENCHMARK_WORKLOAD_VERSION },
        target: {
            kind,
            origin: kind === "local" ? "http://127.0.0.1:8787" : "https://file-benchmark.example.workers.dev",
            ...(kind === "cloudflare" ? { deploymentVersion: "version-1" } : {}),
            runtime: { name: "workerd", version: "2026.8.0", compatibilityDate: "2026-08-28" },
            r2: {
                provider: kind === "local" ? ("miniflare" as const) : ("cloudflare" as const),
                binding: "CDB_FILES",
                bucket: kind === "local" ? "local-files" : "deployed-files",
            },
        },
        profile: FILE_BENCHMARK_PROFILE,
        execution: { startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:00:10.000Z" },
        runner: {
            runtime: { name: "bun", version: "1.2.22" },
            machine: {
                platform: "darwin",
                architecture: "arm64",
                osRelease: "25.0.0",
                cpuModel: "Apple M4",
                logicalCpuCount: 10,
                memoryBytes: 16 * 1_024 ** 3,
            },
        },
        runs,
        aggregate: summarizeFileBenchmarkRuns(runs),
    });
}

export function buildFileBenchmarkPair(
    candidate: { readonly sha256: string; readonly bytes: number },
    reportDigests: { readonly local: string; readonly cloudflare: string; readonly comparison: string }
) {
    const passed = {
        nativeBetterAuth: true,
        organizationIsolation: true,
        exactBytes: true,
        exactDigest: true,
        cleanupComplete: true,
    };
    return {
        schema: "chardb.file-benchmark.pair.v1",
        ok: true,
        candidate,
        profile: FILE_BENCHMARK_PROFILE,
        execution: { startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:00:10.000Z" },
        executionOrder: Array.from({ length: FILE_BENCHMARK_PROFILE.logicalRuns }, (_, run) =>
            FILE_BENCHMARK_PROFILE.payloads.map((payload, payloadIndex) => ({
                run,
                payload: payload.name,
                targets: alternatingTargetOrder(run + payloadIndex),
            }))
        ).flat(),
        reports: {
            local: { path: "local.json", sha256: reportDigests.local },
            cloudflare: { path: "cloudflare.json", sha256: reportDigests.cloudflare },
            comparison: { path: "comparison.json", sha256: reportDigests.comparison },
        },
        runs: Array.from({ length: FILE_BENCHMARK_PROFILE.logicalRuns }, (_, sequence) => ({
            sequence,
            local: { ...passed },
            cloudflare: { ...passed },
        })),
    };
}

export function buildFileBenchmarkComparison(
    local: ReturnType<typeof buildFileBenchmarkReport>,
    cloudflare: ReturnType<typeof buildFileBenchmarkReport>
) {
    return compareFileBenchmarkReports(local, cloudflare);
}

const EMPTY_SHA256 = fixtureSha256("");
const FILE_DEPLOYMENT_PATHS = [
    "chardb-proof.tgz",
    "package-lock.json",
    "package.json",
    "src/api.ts",
    "src/auth.ts",
    "src/migrations.ts",
    "src/schema.ts",
    "src/worker.ts",
    "tsconfig.json",
    "wrangler.toml",
] as const;

export function buildCloudflareFileProof(candidate: ExactCandidate, pairSha256: string) {
    const nonce = "0123456789abcdef";
    const files = FILE_DEPLOYMENT_PATHS.map((file, index) => ({
        path: file,
        bytes: file === "chardb-proof.tgz" ? candidate.bytes : index + 1,
        sha256: file === "chardb-proof.tgz" ? candidate.digest : fixtureSha256(`file-${index}`),
    }));
    const secretSetSha256 = fixtureSha256("secret set");
    const deploymentDigest = fixtureSha256(JSON.stringify({ files, secretSetSha256 }));
    const firstSha256 = fixtureSha256("first");
    const name = `chardb-r2-proof-${candidate.digest.slice(0, 10)}-${nonce}`;
    return {
        schema: "chardb.cloudflare-r2-proof.report.v1",
        ok: true,
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: "2026-08-28T00:01:00.000Z",
        candidate,
        target: {
            worker: name,
            bucket: name,
            origin: `https://${name}.zpg6.workers.dev`,
            accountIdSha256: fixtureSha256("cloudflare account id"),
        },
        wranglerVersion: "4.125.0",
        deploymentInput: { algorithm: "sha256", digest: deploymentDigest, files, secretSetSha256 },
        versions: {
            initial: {
                deploymentId: "11111111-1111-4111-8111-111111111111",
                versionId: "22222222-2222-4222-8222-222222222222",
                percentage: 100,
                number: 1,
            },
            redeploy: {
                deploymentId: "33333333-3333-4333-8333-333333333333",
                versionId: "44444444-4444-4444-8444-444444444444",
                percentage: 100,
                number: 2,
                byteIdentical: true,
            },
        },
        migration: {
            id: `r2-${candidate.digest.slice(0, 10)}-${nonce}`,
            before: { activeVersion: 0, activeEpoch: 1 },
            interruptedShard: "shard_a",
            interruptedState: {
                status: "migrating",
                activeVersion: 0,
                migrationId: `r2-${candidate.digest.slice(0, 10)}-${nonce}`,
            },
            trafficFenceStatus: 503,
            sameIdResume: true,
            after: { activeVersion: 1, activeEpoch: 2 },
            idempotentRetry: true,
        },
        lifecycle: {
            uploadIdempotent: true,
            boundaryRejections: {
                crossOriginUploadStatus: 403,
                crossOriginDownloadStatus: 403,
                rangeDownloadStatus: 416,
                unsupportedTypeStatus: 400,
                oversizedUploadStatus: 400,
                rowPolicyDeniedStatus: 404,
            },
            safeDownloadHeaders: {
                "cache-control": "private, no-store",
                "content-disposition": "attachment",
                "content-length": "22",
                "content-security-policy": "sandbox",
                "content-type": "application/octet-stream",
                "cross-origin-resource-policy": "same-origin",
                "x-content-type-options": "nosniff",
            },
            firstSha256,
            independentR2Sha256: firstSha256,
            replacementSha256: fixtureSha256("replacement"),
            replacementCleanup: true,
            bulkObjects: 34,
            attachedBulkObjects: 17,
            isolationBatch: {
                organizations: 8,
                uploads: 64,
                attached: 64,
                exactDownloads: 64,
                crossOrganizationDenials: 8,
                deletedOrganizations: 8,
            },
            deletedOrganizationState: { count: 0, bytes: 0, digest: EMPTY_SHA256 },
            staleAccess: { uploadStatus: 403, attachStatus: 403, downloadStatus: 403 },
            survivorSha256: fixtureSha256("survivor"),
            finalState: { count: 0, bytes: 0, digest: EMPTY_SHA256 },
        },
        cleanup: { workerDeleted: true, bucketDeleted: true, fallbackPurge: false, deleteCommandsSucceeded: true },
        error: null,
        evidence: {
            secretScanPassed: true,
            checksumFile: "evidence.sha256",
            benchmark: {
                directory: "benchmarks",
                manifestFile: "benchmark-evidence.sha256",
                pairFile: "paired.json",
                pairSha256,
            },
        },
    };
}

const RESHARD_DIGEST = "b".repeat(64);
const RESHARD_DEPLOYMENT_FILES = [
    "chardb-proof.tgz",
    "package-lock.json",
    "package.json",
    "src/api.ts",
    "src/auth.ts",
    "src/migrations.ts",
    "src/proof-config.ts",
    "src/schema.ts",
    "src/vector-proof.ts",
    "src/worker.ts",
    "tsconfig.json",
    "wrangler.toml",
] as const;
const RESHARD_FIXTURE_FILES = [
    "src/api.ts",
    "src/auth.ts",
    "src/migrations.ts",
    "src/proof-config.ts",
    "src/schema.ts",
    "src/vector-proof.ts",
    "src/worker.ts",
    "tsconfig.json",
    "wrangler.deployed.template.toml",
] as const;

function fingerprintRecords(files: Array<{ path: string; bytes: number; sha256: string }>) {
    return { algorithm: "sha256", digest: fixtureSha256(JSON.stringify(files)), files };
}

export function buildFileReshardPreparation(candidate: ExactCandidate) {
    const nonce = "0123456789abcdef";
    const runId = "release_proof_run_1234";
    const resource = `chardb-file-reshard-proof-${candidate.digest.slice(0, 10)}-${nonce}`;
    const target = { worker: resource, bucket: resource, vectorizeIndex: resource };
    const fixtureInput = fingerprintRecords(
        RESHARD_FIXTURE_FILES.map((file, index) => ({
            path: file,
            bytes: index + 1,
            sha256: fixtureSha256(`fixture-${file}`),
        }))
    );
    const configurationSha256 = fixtureSha256(JSON.stringify({ candidate, target, nonce, runId, fixtureInput }));
    const deploymentInput = fingerprintRecords(
        RESHARD_DEPLOYMENT_FILES.map((file, index) => ({
            path: file,
            bytes: file === "chardb-proof.tgz" ? candidate.bytes : index + 1,
            sha256: file === "chardb-proof.tgz" ? candidate.digest : fixtureSha256(`deployment-${file}`),
        }))
    );
    return {
        schema: "chardb.file-vector-reshard-proof.preparation-evidence.v1",
        candidate,
        target,
        nonce,
        runId,
        configurationSha256,
        fixtureInput,
        validation: {
            phases: ["package-lock", "install", "typecheck", "wrangler-doctor", "worker-dry-run"],
        },
        deploymentInput,
        mutatingCommandsExecuted: false,
    };
}

function reshardTarget(kind: "local" | "deployed", preparation: ReturnType<typeof buildFileReshardPreparation>) {
    return {
        kind,
        runtime: kind === "local" ? "miniflare/workerd" : "cloudflare-workers",
        deploymentVersion: kind === "local" ? "local-dev" : "version-1",
        configurationSha256: preparation.configurationSha256,
        bindings: [...(kind === "local" ? FILE_RESHARD_LOCAL_BINDINGS : FILE_RESHARD_DEPLOYMENT_BINDINGS)],
        sourceShard: "cdb-source",
        destinationShard: "cdb-destination",
        r2Bucket: preparation.target.bucket,
        vectorizeIndex: preparation.target.vectorizeIndex,
    };
}

function reshardSample(
    candidateSha256: string,
    preparation: ReturnType<typeof buildFileReshardPreparation>,
    kind: "local" | "deployed",
    sequence: number,
    multiplier = 1
) {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES.small;
    if (!profile) throw new Error("small reshard profile is missing");
    return {
        schema: FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA,
        sequence,
        excluded: sequence === -1,
        candidateSha256,
        runKey: `${preparation.runId}_${sequence < 0 ? "warmup" : sequence}`,
        workload: { id: "file-vector-aware-range-move", version: 2, profile },
        target: reshardTarget(kind, preparation),
        execution: {
            startedAt: "2026-08-29T00:00:00.000Z",
            completedAt: "2026-08-29T00:00:01.000Z",
            requestAttempts: 2,
        },
        dataset: {
            organizations: profile.organizations,
            files: profile.files,
            metadataRows: profile.files,
            vectors: profile.files,
            objectBytes: 128,
        },
        timing: {
            totalMs: 100 * multiplier,
            phasesMs: Object.fromEntries(FILE_RESHARD_BENCHMARK_PHASES.map((phase, index) => [phase, index + 1])),
        },
        movement: {
            runTurns: 12,
            routeEpochBefore: 4,
            routeEpochAfter: 5,
            r2: {
                objectsBefore: profile.files,
                objectsAfter: profile.files,
                bytesBefore: 128,
                bytesAfter: 128,
                identityDigestBefore: RESHARD_DIGEST,
                identityDigestAfter: RESHARD_DIGEST,
                operationTrace: {
                    available: kind === "local",
                    method: kind === "local" ? "cdb-r2-proxy" : "unavailable-native-binding",
                    putsDuringMove: kind === "local" ? 0 : null,
                    deletesDuringMove: kind === "local" ? 0 : null,
                },
            },
            vectors: {
                headsBefore: profile.files,
                headsAfter: profile.files,
                readyHeadsBefore: profile.files,
                readyHeadsAfter: profile.files,
                outboxBefore: profile.files,
                outboxAfter: profile.files,
                attemptsBefore: profile.files,
                attemptsAfter: profile.files,
                headDigestBefore: RESHARD_DIGEST,
                headDigestAfter: RESHARD_DIGEST,
                outboxDigestBefore: candidateSha256,
                outboxDigestAfter: candidateSha256,
                attemptDigestBefore: "c".repeat(64),
                attemptDigestAfter: "c".repeat(64),
                physicalIdsBefore: Array.from({ length: profile.files }, (_, index) => `physical-${index}`),
                physicalIdsAfter: Array.from({ length: profile.files }, (_, index) => `physical-${index}`),
                physicalIdentityDigestBefore: "d".repeat(64),
                physicalIdentityDigestAfter: "d".repeat(64),
                providerRecordsBefore: profile.files,
                providerRecordsAfter: profile.files,
                providerMutationTrace: {
                    available: kind === "local",
                    method: kind === "local" ? "durable-object-vector-probe" : "stable-physical-identity",
                    upsertsDuringMove: kind === "local" ? 0 : null,
                    deletesDuringMove: kind === "local" ? 0 : null,
                },
                search: { rowPk: "row-0", score: 1 },
            },
        },
        responseLoss: {
            operation: "apply_snapshot",
            firstStatus: 503,
            committed: true,
            sameRunKey: true,
            retrySucceeded: true,
        },
        alarm: {
            invoked: true,
            durable: true,
            ownerShard: "cdb-destination",
            deletedObjects: 1,
            remainingObjects: profile.files - 1,
        },
        correctness: Object.fromEntries(FILE_RESHARD_DEPLOYMENT_CORRECTNESS.map(name => [name, true])),
    };
}

export function buildFileReshardPair(candidate: ExactCandidate, preparation = buildFileReshardPreparation(candidate)) {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES.small;
    if (!profile) throw new Error("small reshard profile is missing");
    const local = [0, 1, 2].map(sequence =>
        reshardSample(candidate.digest, preparation, "local", sequence, sequence + 1)
    );
    const deployed = [0, 1, 2].map(sequence =>
        reshardSample(candidate.digest, preparation, "deployed", sequence, sequence + 2)
    );
    return {
        schema: FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA,
        ok: true,
        candidate: { sha256: candidate.digest, bytes: candidate.bytes },
        profile,
        execution: {
            startedAt: "2026-08-29T00:00:00.000Z",
            completedAt: "2026-08-29T00:01:00.000Z",
            order: [-1, 0, 1, 2].map((sequence, index) => ({
                sequence,
                targets: index % 2 === 0 ? ["local", "deployed"] : ["deployed", "local"],
            })),
        },
        deployment: {
            worker: preparation.target.worker,
            bucket: preparation.target.bucket,
            vectorizeIndex: preparation.target.vectorizeIndex,
            version: "version-1",
            accountIdSha256: "d".repeat(64),
        },
        warmup: {
            local: reshardSample(candidate.digest, preparation, "local", -1),
            deployed: reshardSample(candidate.digest, preparation, "deployed", -1),
        },
        runs: local.map((localSample, sequence) => ({ sequence, local: localSample, deployed: deployed[sequence] })),
        comparison: compareFileReshardDeploymentSamples(local, deployed, "small"),
    };
}

function wireDigest(label: string): string {
    return Buffer.from(fixtureSha256(label), "hex").toString("base64url");
}

function physical(label: string, version = 1): string {
    return `p1_${wireDigest(label)}_${version.toString(36)}`;
}

function namespace(label: string): string {
    return `o1_${wireDigest(label)}`;
}

function vectorBenchmarkSamples(values: number[]) {
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

function vectorBenchmarkWarmup() {
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

export function buildCloudflareVectorizeProof(candidate: ExactCandidate) {
    const nonce = "0123456789abcdef";
    const name = `chardb-vx-proof-${candidate.digest.slice(0, 10)}-${nonce}`;
    const resourceDigest = fixtureSha256("exact descriptor");
    const first = physical("first");
    const localRemote = physical("local-remote");
    const liveCreate = physical("live-create");
    const liveReplacement = physical("live-replacement", 2);
    const deploymentFiles = [
        { path: "chardb-proof.tgz", bytes: candidate.bytes, sha256: candidate.digest },
        { path: "package-lock.json", bytes: 200, sha256: fixtureSha256("package lock") },
        { path: "src/worker.ts", bytes: 300, sha256: fixtureSha256("worker source") },
        { path: "wrangler.toml", bytes: 400, sha256: fixtureSha256("wrangler config") },
    ];
    return {
        schema: "chardb.cloudflare-vectorize-proof.report.v2",
        ok: true,
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:05:00.000Z",
        candidate,
        target: {
            worker: name,
            index: name,
            origin: `https://${name}.zpg6.workers.dev`,
            accountIdSha256: fixtureSha256("cloudflare account id"),
        },
        wranglerVersion: "4.125.0",
        deploymentInput: {
            algorithm: "sha256",
            digest: fixtureSha256(JSON.stringify(deploymentFiles)),
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
                payloadSha256: fixtureSha256("first payload"),
                mutationIdSha256: fixtureSha256("first mutation"),
            },
            upsertResponseLoss: {
                acceptedBeforeThrow: true,
                physicalId: physical("second", 2),
                retryPhysicalId: physical("second", 2),
                payloadSha256: fixtureSha256("second payload"),
                retryPayloadSha256: fixtureSha256("second payload"),
                mutationIdSha256: fixtureSha256("second mutation"),
            },
            deleteResponseLoss: {
                acceptedBeforeThrow: true,
                physicalIds: [first, physical("second", 2)],
                retryPhysicalIds: [first, physical("second", 2)],
                mutationIdSha256: fixtureSha256("delete mutation"),
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
                vectorIdSha256: fixtureSha256("adversarial vector id"),
                stalePhysicalIdSha256: fixtureSha256("adversarial stale physical id"),
                currentPhysicalIdSha256: fixtureSha256("adversarial current physical id"),
                apply: {
                    staleUpsertMutationIdSha256: fixtureSha256("adversarial stale upsert"),
                    currentDeleteMutationIdSha256: fixtureSha256("adversarial current delete"),
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
                        querySha256: fixtureSha256("stale public query"),
                        finalCandidateSetSha256: fixtureSha256("stale candidate set"),
                        hardBoundClaimed: false,
                    },
                },
                restore: {
                    currentUpsertMutationIdSha256: fixtureSha256("adversarial current restore"),
                    staleDeleteMutationIdSha256: fixtureSha256("adversarial stale cleanup"),
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
                        querySha256: fixtureSha256("restored owner query"),
                        candidateSetSha256: fixtureSha256("restored current candidate set"),
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
                    candidateSetSha256: fixtureSha256("restored current candidate set"),
                },
            },
            liveDelivery: {
                realWorkerWebSocket: true,
                syntheticFrames: false,
                vectorIdSha256: fixtureSha256("live vector id"),
                documentIdSha256: fixtureSha256("live document id"),
                createPhysicalIdSha256: fixtureSha256(liveCreate),
                replacementPhysicalIdSha256: fixtureSha256(liveReplacement),
                pending: {
                    gateHeldBeforeRelease: true,
                    headVersion: 2,
                    deliveredVersion: 1,
                    publicReplacementReturned: false,
                    fallbackDocumentIdSha256: fixtureSha256("fallback document id"),
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
                    queryRefSha256: fixtureSha256("cloudflare-vectorize-proof/api.ts#searchVectorDocuments"),
                    clientIdSha256: fixtureSha256("live client id"),
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
                        initialCookieSha256: fixtureSha256("initial live cookie"),
                        finalCookieSha256: fixtureSha256("final live cookie"),
                    },
                    content: {
                        callbackCount: 4,
                        baselineUpdateCount: 1,
                        pendingFallbackUpdateCount: 1,
                        prematureCurrentUpdateCount: 0,
                        replacementUpdateCount: 1,
                        duplicateContentUpdateCount: 0,
                        baselineRowsSha256: fixtureSha256("live baseline rows"),
                        pendingFallbackRowPkSha256: fixtureSha256("fallback document id"),
                        pendingRowsSha256: fixtureSha256("live pending fallback rows"),
                        replacementRowsSha256: fixtureSha256("live replacement rows"),
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
                warmup: vectorBenchmarkWarmup(),
                samples: vectorBenchmarkSamples([1, 2, 3, 4, 5]),
                exactMatchLatenciesMs: [1, 2, 3, 4, 5],
            },
            localRemoteBinding: {
                label: "local-wrangler-remote-vectorize",
                runtime: "wrangler-dev/workerd",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: vectorBenchmarkWarmup(),
                samples: vectorBenchmarkSamples([8, 9, 10, 11, 12]),
                exactMatchLatenciesMs: [8, 9, 10, 11, 12],
            },
            deployed: {
                label: "deployed-cloudflare-vectorize",
                runtime: "cloudflare-workers",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                warmup: vectorBenchmarkWarmup(),
                samples: vectorBenchmarkSamples([10, 20, 30, 40, 50]),
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
