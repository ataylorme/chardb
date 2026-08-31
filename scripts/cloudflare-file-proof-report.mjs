import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const CLOUDFLARE_FILE_PROOF_REPORT_SCHEMA = "chardb.cloudflare-r2-proof.report.v1";
export const CLOUDFLARE_FILE_PROOF_VALIDATION_SCHEMA = "chardb.cloudflare-r2-proof.validation.v1";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEPLOYMENT_FILES = Object.freeze([
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
]);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function assertObject(value, label, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (!isDeepStrictEqual(actual, expected)) {
        throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
    }
    return value;
}

function assertSha256(value, label) {
    if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
    return value;
}

function assertPositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
    return value;
}

function assertTimestamp(value, label) {
    if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`${label} must be an exact ISO timestamp`);
    }
    return parsed.getTime();
}

function assertCandidate(value, label = "Cloudflare file proof candidate") {
    assertObject(value, label, ["algorithm", "digest", "bytes"]);
    if (value.algorithm !== "sha256") throw new Error(`${label} algorithm must be sha256`);
    assertSha256(value.digest, `${label} digest`);
    assertPositiveInteger(value.bytes, `${label} byte count`);
    return value;
}

function assertTarget(value, candidate) {
    assertObject(value, "Cloudflare file proof target", ["worker", "bucket", "origin", "accountIdSha256"]);
    assertSha256(value.accountIdSha256, "Cloudflare file proof account-id digest");
    if (typeof value.worker !== "string" || value.worker !== value.bucket) {
        throw new Error("Cloudflare file proof Worker and bucket names must match");
    }
    const name = new RegExp(`^chardb-r2-proof-${candidate.digest.slice(0, 10)}-([a-f0-9]{16})$`).exec(value.worker);
    if (!name) throw new Error("Cloudflare file proof target is not derived from the candidate digest");
    const escapedWorker = value.worker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
        !new RegExp(`^https://${escapedWorker}\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.workers\\.dev$`).test(
            value.origin
        )
    ) {
        throw new Error("Cloudflare file proof origin does not identify the disposable Worker");
    }
    return name[1];
}

function assertDeploymentInput(value, candidate) {
    assertObject(value, "Cloudflare file proof deployment input", ["algorithm", "digest", "files", "secretSetSha256"]);
    if (value.algorithm !== "sha256") throw new Error("deployment input algorithm must be sha256");
    assertSha256(value.digest, "deployment input digest");
    assertSha256(value.secretSetSha256, "deployment secret-set digest");
    if (!Array.isArray(value.files)) throw new Error("deployment input files must be an array");
    const files = value.files.map((file, index) => {
        assertObject(file, `deployment input file ${index}`, ["path", "bytes", "sha256"]);
        if (typeof file.path !== "string") throw new Error(`deployment input file ${index} path must be a string`);
        assertPositiveInteger(file.bytes, `deployment input file ${file.path} byte count`);
        assertSha256(file.sha256, `deployment input file ${file.path} digest`);
        return file;
    });
    if (
        !isDeepStrictEqual(
            files.map(file => file.path),
            DEPLOYMENT_FILES
        )
    ) {
        throw new Error("deployment input must contain the exact sorted proof application files");
    }
    const tarball = files[0];
    if (tarball.sha256 !== candidate.digest || tarball.bytes !== candidate.bytes) {
        throw new Error("deployment input does not contain the exact candidate tarball");
    }
    const expectedDigest = sha256(JSON.stringify({ files, secretSetSha256: value.secretSetSha256 }));
    if (value.digest !== expectedDigest) throw new Error("deployment input composite digest is invalid");
}

function assertVersion(value, label, byteIdentical) {
    const keys = ["deploymentId", "versionId", "percentage", "number"];
    if (byteIdentical !== undefined) keys.push("byteIdentical");
    assertObject(value, label, keys);
    if (!UUID.test(value.deploymentId ?? "") || !UUID.test(value.versionId ?? "")) {
        throw new Error(`${label} requires valid deployment and version ids`);
    }
    if (value.percentage !== 100) throw new Error(`${label} must receive 100 percent traffic`);
    assertPositiveInteger(value.number, `${label} version number`);
    if (byteIdentical !== undefined && value.byteIdentical !== byteIdentical) {
        throw new Error(`${label} must record a byte-identical deployment`);
    }
}

function assertVersions(value) {
    assertObject(value, "Cloudflare file proof versions", ["initial", "redeploy"]);
    assertVersion(value.initial, "initial Worker version");
    assertVersion(value.redeploy, "redeployed Worker version", true);
    if (
        value.redeploy.number <= value.initial.number ||
        value.redeploy.versionId === value.initial.versionId ||
        value.redeploy.deploymentId === value.initial.deploymentId
    ) {
        throw new Error("redeploy must create and activate a later Worker version");
    }
}

function assertMigration(value, candidate, nonce) {
    assertObject(value, "Cloudflare file proof migration", [
        "id",
        "before",
        "interruptedShard",
        "interruptedState",
        "trafficFenceStatus",
        "sameIdResume",
        "after",
        "idempotentRetry",
    ]);
    if (value.id !== `r2-${candidate.digest.slice(0, 10)}-${nonce}`) {
        throw new Error("migration id is not bound to the candidate and proof run");
    }
    assertObject(value.before, "migration before state", ["activeVersion", "activeEpoch"]);
    if (typeof value.interruptedShard !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.interruptedShard)) {
        throw new Error("migration proof requires the interrupted shard id");
    }
    assertObject(value.interruptedState, "interrupted migration state", ["status", "activeVersion", "migrationId"]);
    assertObject(value.after, "migration after state", ["activeVersion", "activeEpoch"]);
    if (
        value.before.activeVersion !== 0 ||
        value.before.activeEpoch !== 1 ||
        value.interruptedState.status !== "migrating" ||
        value.interruptedState.activeVersion !== 0 ||
        value.interruptedState.migrationId !== value.id ||
        !Number.isSafeInteger(value.trafficFenceStatus) ||
        value.trafficFenceStatus < 400 ||
        value.trafficFenceStatus > 599 ||
        value.sameIdResume !== true ||
        value.after.activeVersion !== 1 ||
        value.after.activeEpoch !== 2 ||
        value.idempotentRetry !== true
    ) {
        throw new Error(
            "migration must prove interruption, traffic fencing, same-id resume, and idempotent activation"
        );
    }
}

function assertEmptyObjectState(value, label) {
    assertObject(value, label, ["count", "bytes", "digest"]);
    if (value.count !== 0 || value.bytes !== 0 || value.digest !== EMPTY_SHA256) {
        throw new Error(`${label} must prove an empty R2 prefix with its exact digest`);
    }
}

function assertLifecycle(value) {
    assertObject(value, "Cloudflare file proof lifecycle", [
        "uploadIdempotent",
        "boundaryRejections",
        "safeDownloadHeaders",
        "firstSha256",
        "independentR2Sha256",
        "replacementSha256",
        "replacementCleanup",
        "bulkObjects",
        "attachedBulkObjects",
        "isolationBatch",
        "deletedOrganizationState",
        "staleAccess",
        "survivorSha256",
        "finalState",
    ]);
    if (value.uploadIdempotent !== true) throw new Error("file upload idempotency did not pass");
    assertObject(value.boundaryRejections, "file request boundary rejections", [
        "crossOriginUploadStatus",
        "crossOriginDownloadStatus",
        "rangeDownloadStatus",
        "unsupportedTypeStatus",
        "oversizedUploadStatus",
        "rowPolicyDeniedStatus",
    ]);
    const expectedRejections = {
        crossOriginUploadStatus: 403,
        crossOriginDownloadStatus: 403,
        rangeDownloadStatus: 416,
        unsupportedTypeStatus: 400,
        oversizedUploadStatus: 400,
        rowPolicyDeniedStatus: 404,
    };
    if (!isDeepStrictEqual(value.boundaryRejections, expectedRejections)) {
        throw new Error("file request boundaries did not return the expected rejection statuses");
    }
    assertObject(value.safeDownloadHeaders, "safe file download headers", [
        "cache-control",
        "content-disposition",
        "content-length",
        "content-security-policy",
        "content-type",
        "cross-origin-resource-policy",
        "x-content-type-options",
    ]);
    const expectedHeaders = {
        "cache-control": "private, no-store",
        "content-disposition": "attachment",
        "content-length": "22",
        "content-security-policy": "sandbox",
        "content-type": "application/octet-stream",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
    };
    if (!isDeepStrictEqual(value.safeDownloadHeaders, expectedHeaders)) {
        throw new Error("file download headers do not match the safe attachment policy");
    }
    const first = assertSha256(value.firstSha256, "first upload digest");
    if (value.independentR2Sha256 !== first) {
        throw new Error("independent R2 download does not match the first upload");
    }
    const replacement = assertSha256(value.replacementSha256, "replacement upload digest");
    const survivor = assertSha256(value.survivorSha256, "surviving organization digest");
    if (new Set([first, replacement, survivor]).size !== 3) {
        throw new Error("first, replacement, and survivor objects must have distinct digests");
    }
    if (value.replacementCleanup !== true) throw new Error("replacement object cleanup did not pass");
    if (value.bulkObjects !== 34 || value.attachedBulkObjects !== 17) {
        throw new Error("bulk lifecycle must prove 34 uploads with 17 attached objects");
    }
    assertObject(value.isolationBatch, "organization isolation batch", [
        "organizations",
        "uploads",
        "attached",
        "exactDownloads",
        "crossOrganizationDenials",
        "deletedOrganizations",
    ]);
    const expectedIsolationBatch = {
        organizations: 8,
        uploads: 64,
        attached: 64,
        exactDownloads: 64,
        crossOrganizationDenials: 8,
        deletedOrganizations: 8,
    };
    if (!isDeepStrictEqual(value.isolationBatch, expectedIsolationBatch)) {
        throw new Error("organization isolation batch did not complete every upload, download, denial, and deletion");
    }
    assertEmptyObjectState(value.deletedOrganizationState, "deleted organization R2 state");
    assertObject(value.staleAccess, "deleted organization stale access", [
        "uploadStatus",
        "attachStatus",
        "downloadStatus",
    ]);
    for (const [operation, status] of Object.entries(value.staleAccess)) {
        if (![401, 403, 404].includes(status)) {
            throw new Error(`deleted organization ${operation} must fail with an authorization status`);
        }
    }
    assertEmptyObjectState(value.finalState, "final disposable bucket state");
}

function assertCleanup(value) {
    assertObject(value, "Cloudflare file proof cleanup", [
        "workerDeleted",
        "bucketDeleted",
        "fallbackPurge",
        "deleteCommandsSucceeded",
    ]);
    if (
        value.workerDeleted !== true ||
        value.bucketDeleted !== true ||
        value.fallbackPurge !== false ||
        value.deleteCommandsSucceeded !== true
    ) {
        throw new Error("Cloudflare file proof must verify direct deletion and absence of both disposable resources");
    }
}

function assertEvidence(value) {
    assertObject(value, "Cloudflare file proof evidence", ["secretScanPassed", "checksumFile", "benchmark"]);
    if (value.secretScanPassed !== true || value.checksumFile !== "evidence.sha256") {
        throw new Error("Cloudflare file proof evidence must record its secret scan and checksum file");
    }
    assertObject(value.benchmark, "Cloudflare file benchmark evidence", [
        "directory",
        "manifestFile",
        "pairFile",
        "pairSha256",
    ]);
    if (
        value.benchmark.directory !== "benchmarks" ||
        value.benchmark.manifestFile !== "benchmark-evidence.sha256" ||
        value.benchmark.pairFile !== "paired.json" ||
        !/^[a-f0-9]{64}$/.test(value.benchmark.pairSha256 ?? "")
    ) {
        throw new Error("Cloudflare file proof must anchor the canonical paired benchmark evidence");
    }
}

export function assertCloudflareFileProofReport(report, expectedCandidate) {
    const candidate = assertCandidate(expectedCandidate, "expected Cloudflare file proof candidate");
    assertObject(report, "Cloudflare file proof report", [
        "schema",
        "ok",
        "startedAt",
        "completedAt",
        "candidate",
        "target",
        "wranglerVersion",
        "deploymentInput",
        "versions",
        "migration",
        "lifecycle",
        "cleanup",
        "error",
        "evidence",
    ]);
    if (report.schema !== CLOUDFLARE_FILE_PROOF_REPORT_SCHEMA) {
        throw new Error(`Cloudflare file proof schema must be ${CLOUDFLARE_FILE_PROOF_REPORT_SCHEMA}`);
    }
    if (report.ok !== true || report.error !== null) throw new Error("Cloudflare file proof did not succeed");
    if (!isDeepStrictEqual(assertCandidate(report.candidate), candidate)) {
        throw new Error("Cloudflare file proof does not identify the expected candidate");
    }
    const startedAt = assertTimestamp(report.startedAt, "Cloudflare file proof start time");
    const completedAt = assertTimestamp(report.completedAt, "Cloudflare file proof completion time");
    if (completedAt < startedAt) throw new Error("Cloudflare file proof completion precedes its start");
    const nonce = assertTarget(report.target, candidate);
    if (report.wranglerVersion !== "4.125.0") throw new Error("Cloudflare file proof Wrangler version drifted");
    assertDeploymentInput(report.deploymentInput, candidate);
    assertVersions(report.versions);
    assertMigration(report.migration, candidate, nonce);
    assertLifecycle(report.lifecycle);
    assertCleanup(report.cleanup);
    assertEvidence(report.evidence);
    return report;
}

export async function fingerprintCloudflareFileProofCandidate(file) {
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
    if (!metadata.isFile()) throw new Error("Cloudflare file proof candidate must be a file");
    return { algorithm: "sha256", digest: sha256(bytes), bytes: metadata.size };
}

export async function validateCloudflareFileProofEvidence(input) {
    const reportPath = path.resolve(input.report);
    const checksumPath = path.resolve(input.checksum ?? path.join(path.dirname(reportPath), "evidence.sha256"));
    if (path.basename(reportPath) !== "r2-proof-report.json" || path.basename(checksumPath) !== "evidence.sha256") {
        throw new Error("Cloudflare file proof evidence must use the canonical report and checksum filenames");
    }
    const [reportBytes, checksum, candidate] = await Promise.all([
        readFile(reportPath),
        readFile(checksumPath, "utf8"),
        fingerprintCloudflareFileProofCandidate(path.resolve(input.candidate)),
    ]);
    const reportDigest = sha256(reportBytes);
    if (checksum !== `${reportDigest}  ${path.basename(reportPath)}\n`) {
        throw new Error("Cloudflare file proof evidence checksum does not match the exact report bytes");
    }
    let report;
    try {
        report = JSON.parse(reportBytes.toString("utf8"));
    } catch {
        throw new Error("Cloudflare file proof report is not valid JSON");
    }
    assertCloudflareFileProofReport(report, candidate);
    return Object.freeze({
        schema: CLOUDFLARE_FILE_PROOF_VALIDATION_SCHEMA,
        ok: true,
        candidate,
        reportSha256: reportDigest,
    });
}

export function parseCloudflareFileProofReportArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!["--report", "--candidate", "--checksum"].includes(argument)) {
            throw new Error(`unknown Cloudflare file proof report argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (!value) throw new Error(`${argument} requires a path`);
        if (values[argument] !== undefined) throw new Error(`${argument} may be provided only once`);
        values[argument] = value;
    }
    if (!values["--report"] || !values["--candidate"]) {
        throw new Error(
            "usage: bun scripts/cloudflare-file-proof-report.mjs --report <report.json> --candidate <package.tgz> [--checksum <evidence.sha256>]"
        );
    }
    return { report: values["--report"], candidate: values["--candidate"], checksum: values["--checksum"] };
}

if (import.meta.main) {
    const input = parseCloudflareFileProofReportArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await validateCloudflareFileProofEvidence(input))}\n`);
}
