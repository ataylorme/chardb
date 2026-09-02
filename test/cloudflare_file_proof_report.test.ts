import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    CLOUDFLARE_FILE_PROOF_REPORT_SCHEMA,
    CLOUDFLARE_FILE_PROOF_VALIDATION_SCHEMA,
    assertCloudflareFileProofReport,
    parseCloudflareFileProofReportArgs,
    validateCloudflareFileProofEvidence,
} from "../scripts/cloudflare-file-proof-report.mjs";

const temporaryDirectories: string[] = [];
const nonce = "0123456789abcdef";
const emptySha256 = createHash("sha256").update("").digest("hex");
const deploymentPaths = [
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
];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function candidate(bytes = new TextEncoder().encode("exact candidate bytes")) {
    return { algorithm: "sha256" as const, digest: sha256(bytes), bytes: bytes.byteLength };
}

function reportFor(exactCandidate = candidate()) {
    const files = deploymentPaths.map((file, index) => ({
        path: file,
        bytes: file === "chardb-proof.tgz" ? exactCandidate.bytes : index + 1,
        sha256: file === "chardb-proof.tgz" ? exactCandidate.digest : sha256(`file-${index}`),
    }));
    const secretSetSha256 = sha256("secret set");
    const deploymentDigest = sha256(JSON.stringify({ files, secretSetSha256 }));
    const firstSha256 = sha256("first");
    return {
        schema: CLOUDFLARE_FILE_PROOF_REPORT_SCHEMA,
        ok: true,
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: "2026-08-28T00:01:00.000Z",
        candidate: exactCandidate,
        target: {
            worker: `chardb-r2-proof-${exactCandidate.digest.slice(0, 10)}-${nonce}`,
            bucket: `chardb-r2-proof-${exactCandidate.digest.slice(0, 10)}-${nonce}`,
            origin: `https://chardb-r2-proof-${exactCandidate.digest.slice(0, 10)}-${nonce}.zpg6.workers.dev`,
            accountIdSha256: sha256("cloudflare account id"),
        },
        wranglerVersion: "4.125.0",
        deploymentInput: {
            algorithm: "sha256",
            digest: deploymentDigest,
            files,
            secretSetSha256,
        },
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
            id: `r2-${exactCandidate.digest.slice(0, 10)}-${nonce}`,
            before: { activeVersion: 0, activeEpoch: 1 },
            interruptedShard: "shard_a",
            interruptedState: {
                status: "migrating",
                activeVersion: 0,
                migrationId: `r2-${exactCandidate.digest.slice(0, 10)}-${nonce}`,
            },
            trafficFenceStatus: 503,
            sameIdResume: true,
            after: { activeVersion: 1, activeEpoch: 2 },
            idempotentRetry: true,
        },
        recovery: {
            format: "chardb-recovery-point/v1",
            digest: sha256("recovery point"),
            shardCount: 2,
            schemaVersion: 1,
            routingEpoch: 2,
            acceptedStatus: 202,
            filesReset: 2,
            filesRetained: 2,
            vectorsReset: 0,
            filesRehydrated: 1,
            vectorsRequeued: 0,
            postPointRowReadableBeforeRestore: true,
            pointRowReadableAfterRestore: true,
            postPointRowHiddenAfterRestore: true,
            postPointR2ObjectRemoved: true,
            pointFileRecoveredFromRetention: true,
            pointFileRetentionRefreshedBeforeScrub: true,
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
            replacementSha256: sha256("replacement"),
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
            deletedOrganizationState: { count: 0, bytes: 0, digest: emptySha256 },
            staleAccess: { uploadStatus: 403, attachStatus: 403, downloadStatus: 403 },
            survivorSha256: sha256("survivor"),
            finalState: { count: 0, bytes: 0, digest: emptySha256 },
        },
        cleanup: {
            workerDeleted: true,
            bucketDeleted: true,
            fallbackPurge: false,
            deleteCommandsSucceeded: true,
        },
        error: null,
        evidence: {
            secretScanPassed: true,
            checksumFile: "evidence.sha256",
            benchmark: {
                directory: "benchmarks",
                manifestFile: "benchmark-evidence.sha256",
                pairFile: "paired.json",
                pairSha256: sha256("paired benchmark"),
            },
        },
    };
}

function changed<T>(value: T, mutate: (copy: T) => void): T {
    const copy = structuredClone(value);
    mutate(copy);
    return copy;
}

describe("Cloudflare R2 proof report validator", () => {
    test("accepts the exact successful report and rejects unknown fields", () => {
        const expected = candidate();
        const report = reportFor(expected);
        expect(assertCloudflareFileProofReport(report, expected)).toBe(report);
        expect(() => assertCloudflareFileProofReport({ ...report, unverifiedClaim: true }, expected)).toThrow(
            "fields must be exactly"
        );
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    Object.assign(value.lifecycle.staleAccess, { reason: "trust me" });
                }),
                expected
            )
        ).toThrow("fields must be exactly");
    });

    test("binds the report and deployment tree to the exact candidate", () => {
        const expected = candidate();
        const report = reportFor(expected);
        expect(() => assertCloudflareFileProofReport(report, { ...expected, digest: "f".repeat(64) })).toThrow(
            "expected candidate"
        );
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    const tarball = value.deploymentInput.files.at(0);
                    if (!tarball) throw new Error("test report has no tarball");
                    tarball.bytes += 1;
                }),
                expected
            )
        ).toThrow("exact candidate tarball");
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    const packageLock = value.deploymentInput.files.at(1);
                    if (!packageLock) throw new Error("test report has no package lock");
                    packageLock.sha256 = "f".repeat(64);
                }),
                expected
            )
        ).toThrow("composite digest");
    });

    test("requires real version, migration, and byte-identical redeploy transitions", () => {
        const expected = candidate();
        const report = reportFor(expected);
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    value.versions.redeploy.number = 1;
                }),
                expected
            )
        ).toThrow("later Worker version");
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    value.versions.redeploy.byteIdentical = false;
                }),
                expected
            )
        ).toThrow("byte-identical");
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    value.migration.after.activeEpoch = 3;
                }),
                expected
            )
        ).toThrow("interruption");
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    value.migration.sameIdResume = false;
                }),
                expected
            )
        ).toThrow("same-id resume");
    });

    test("requires every file, security, scale, isolation, and deletion invariant", () => {
        const expected = candidate();
        const report = reportFor(expected);
        const cases: Array<[string, (value: ReturnType<typeof reportFor>) => void]> = [
            [
                "idempotency",
                value => {
                    value.lifecycle.uploadIdempotent = false;
                },
            ],
            [
                "request boundaries",
                value => {
                    value.lifecycle.boundaryRejections.rangeDownloadStatus = 200;
                },
            ],
            [
                "download headers",
                value => {
                    value.lifecycle.safeDownloadHeaders["cache-control"] = "public";
                },
            ],
            [
                "independent R2",
                value => {
                    value.lifecycle.independentR2Sha256 = "f".repeat(64);
                },
            ],
            [
                "replacement",
                value => {
                    value.lifecycle.replacementCleanup = false;
                },
            ],
            [
                "coordinated recovery",
                value => {
                    value.recovery.postPointRowHiddenAfterRestore = false;
                },
            ],
            [
                "bulk lifecycle",
                value => {
                    value.lifecycle.bulkObjects = 33;
                },
            ],
            [
                "isolation batch",
                value => {
                    value.lifecycle.isolationBatch.exactDownloads = 63;
                },
            ],
            [
                "empty R2 prefix",
                value => {
                    value.lifecycle.deletedOrganizationState.count = 1;
                },
            ],
            [
                "authorization status",
                value => {
                    value.lifecycle.staleAccess.uploadStatus = 500;
                },
            ],
            [
                "final disposable bucket",
                value => {
                    value.lifecycle.finalState.digest = "f".repeat(64);
                },
            ],
        ];
        for (const [message, mutate] of cases) {
            expect(() => assertCloudflareFileProofReport(changed(report, mutate), expected)).toThrow(message);
        }
    });

    test("requires direct cleanup and verified absence of both Cloudflare resources", () => {
        const expected = candidate();
        const report = reportFor(expected);
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    value.cleanup.workerDeleted = false;
                }),
                expected
            )
        ).toThrow("deletion and absence");
        expect(() =>
            assertCloudflareFileProofReport(
                changed(report, value => {
                    value.cleanup.fallbackPurge = true;
                }),
                expected
            )
        ).toThrow("deletion and absence");
    });

    test("validates exact report bytes, checksum, and candidate file together", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "chardb-r2-proof-report-"));
        temporaryDirectories.push(directory);
        const candidatePath = path.join(directory, "chardb-proof.tgz");
        const reportPath = path.join(directory, "r2-proof-report.json");
        const checksumPath = path.join(directory, "evidence.sha256");
        const candidateBytes = new TextEncoder().encode("exact deployed candidate");
        const exactCandidate = candidate(candidateBytes);
        const reportBytes = `${JSON.stringify(reportFor(exactCandidate), null, 2)}\n`;
        await writeFile(candidatePath, candidateBytes);
        await writeFile(reportPath, reportBytes);
        await writeFile(checksumPath, `${sha256(reportBytes)}  r2-proof-report.json\n`);
        const result = await validateCloudflareFileProofEvidence({
            report: reportPath,
            candidate: candidatePath,
        });
        expect(result).toEqual({
            schema: CLOUDFLARE_FILE_PROOF_VALIDATION_SCHEMA,
            ok: true,
            candidate: exactCandidate,
            reportSha256: sha256(reportBytes),
        });
        await expect(
            validateCloudflareFileProofEvidence({
                report: reportPath,
                candidate: candidatePath,
                checksum: path.join(directory, "renamed.sha256"),
            })
        ).rejects.toThrow("canonical");
        await writeFile(checksumPath, `${"0".repeat(64)}  r2-proof-report.json\n`);
        await expect(
            validateCloudflareFileProofEvidence({ report: reportPath, candidate: candidatePath })
        ).rejects.toThrow("checksum");
        expect(await readFile(reportPath, "utf8")).toBe(reportBytes);
    });

    test("parses only the bounded report validator arguments", () => {
        expect(
            parseCloudflareFileProofReportArgs([
                "--report",
                "/evidence/r2-proof-report.json",
                "--candidate",
                "/candidate/chardb.tgz",
            ])
        ).toEqual({
            report: "/evidence/r2-proof-report.json",
            candidate: "/candidate/chardb.tgz",
            checksum: undefined,
        });
        expect(() => parseCloudflareFileProofReportArgs(["--report", "report.json"])).toThrow("usage");
        expect(() =>
            parseCloudflareFileProofReportArgs(["--report", "report.json", "--candidate", "a.tgz", "--force"])
        ).toThrow("unknown");
    });
});
