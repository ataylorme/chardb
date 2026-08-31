import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { writeJsonAtomically } from "./browser-proof-report.mjs";
import { assertCloudflareFileProofReport } from "./cloudflare-file-proof-report.mjs";
import { assertCloudflareVectorizeProofReport } from "./cloudflare-vectorize-proof-report.mjs";
import { assertFileReshardDeploymentPair } from "./file-reshard-deployment-proof.mjs";
import { buildPreviewEvidenceManifest } from "./finalize-preview-evidence.mjs";
import { assertMatchingGeneratedProjectReport } from "./generated-project-report.mjs";
import { validateOsCiEvidence } from "./os-ci-evidence.mjs";
import { CHARDB_PACKAGE_NAME, CHARDB_REACT_PACKAGE_NAME, npmPackFilename } from "./package-identity.mjs";
import { assertMatchingPackedChatReport } from "./packed-chat-report.mjs";
import { assertMatchingPackedOrgUserReport } from "./packed-org-user-report.mjs";
import { assertMatchingPackedPublicVectorReport } from "./packed-public-vector-contract.mjs";
import { assertFileReshardProofPreparationEvidence } from "./prepare-file-reshard-deployment-proof.mjs";
import { assertMatchingBrowserReport, assertPassingPreviewGateReport } from "./preview-gate-report.mjs";
import { validateFileBenchmarkEvidence } from "./run-file-benchmark.mjs";

export const RELEASE_ADMISSION_SCHEMA = "chardb.release-admission.v1";
export const RELEASE_ADMISSION_PROFILE = "preview-v1";
export const RELEASE_EVIDENCE_KINDS = Object.freeze([
    "preview",
    "cloudflare-files",
    "cloudflare-file-reshard",
    "cloudflare-vectors",
    "os-ci",
]);
export const RELEASE_OPTIONAL_EVIDENCE_KINDS = Object.freeze([]);

export function releaseAdmissionUsage() {
    return [
        "Usage: bun run release:admit -- --profile preview-v1 \\",
        "  --evidence preview=<directory> \\",
        "  --evidence cloudflare-files=<directory> \\",
        "  --evidence cloudflare-file-reshard=<directory> \\",
        "  --evidence cloudflare-vectors=<directory> \\",
        "  --evidence os-ci=<downloaded-ci-artifact-directory> [--output <admission.json>]",
    ].join("\n");
}

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CLOUDFLARE_FILES_EVIDENCE_FILES = Object.freeze([
    "benchmarks/benchmark-evidence.sha256",
    "benchmarks/cloudflare.json",
    "benchmarks/comparison.json",
    "benchmarks/local.json",
    "benchmarks/paired.json",
    "evidence.sha256",
    "r2-proof-report.json",
    "r2-proof-validation.json",
]);
const CLOUDFLARE_VECTOR_EVIDENCE_FILES = Object.freeze([
    "evidence.sha256",
    "execution.sha256",
    "preparation.sha256",
    "vectorize-proof-execution.json",
    "vectorize-proof-plan.json",
    "vectorize-proof-preparation.json",
    "vectorize-proof-report.json",
]);

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function object(value, label) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    return value;
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function tarString(bytes, start, end) {
    const zero = bytes.indexOf(0, start);
    return bytes.subarray(start, zero >= start && zero < end ? zero : end).toString("utf8");
}

function tarOctal(bytes, start, end, label) {
    const value = tarString(bytes, start, end).trim();
    check(/^[0-7]+$/.test(value), `${label} is not canonical octal`);
    const parsed = Number.parseInt(value, 8);
    check(Number.isSafeInteger(parsed) && parsed >= 0, `${label} is out of range`);
    return parsed;
}

function packageIdentityFromTarball(tarball, expectedName = CHARDB_PACKAGE_NAME) {
    let archive;
    try {
        archive = gunzipSync(tarball);
    } catch {
        throw new Error("preview candidate tarball is not a valid gzip archive");
    }
    let packageJson;
    for (let offset = 0; offset + 512 <= archive.byteLength; ) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const expectedChecksum = tarOctal(header, 148, 156, "preview candidate tar header checksum");
        let actualChecksum = 0;
        for (let index = 0; index < header.byteLength; index++) {
            actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
        }
        check(actualChecksum === expectedChecksum, "preview candidate tar header checksum drifted");
        const name = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 500);
        const entry = prefix ? `${prefix}/${name}` : name;
        const size = tarOctal(header, 124, 136, `preview candidate tar entry ${entry} size`);
        const type = header[156];
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        check(dataEnd <= archive.byteLength, `preview candidate tar entry ${entry} is truncated`);
        if (entry === "package/package.json") {
            check(type === 0 || type === 48, "preview candidate package.json must be a regular tar entry");
            check(packageJson === undefined, "preview candidate tarball contains duplicate package.json entries");
            check(size > 0 && size <= 1_048_576, "preview candidate package.json size is invalid");
            try {
                packageJson = JSON.parse(archive.subarray(dataStart, dataEnd).toString("utf8"));
            } catch {
                throw new Error("preview candidate package.json is not valid JSON");
            }
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    object(packageJson, "preview candidate package.json");
    check(packageJson.name === expectedName, `preview candidate package name must be ${expectedName}`);
    check(VERSION.test(packageJson.version ?? ""), "preview candidate package version is invalid");
    return { name: packageJson.name, version: packageJson.version };
}

async function regularBytes(file, label, containmentRoot) {
    const root = path.resolve(containmentRoot);
    const target = path.resolve(file);
    const relative = path.relative(root, target);
    check(
        relative.length > 0 && !path.isAbsolute(relative) && !relative.split(path.sep).includes(".."),
        `${label} escapes its evidence directory`
    );

    let current = root;
    const components = relative.split(path.sep);
    for (const [index, component] of components.entries()) {
        current = path.join(current, component);
        let metadata;
        try {
            metadata = await lstat(current);
        } catch (error) {
            if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
            throw error;
        }
        check(
            !metadata.isSymbolicLink(),
            `${label} must not traverse symlink ${components.slice(0, index + 1).join("/")}`
        );
        if (index < components.length - 1) check(metadata.isDirectory(), `${label} parent must be a directory`);
        else check(metadata.isFile(), `${label} must be a regular file`);
    }

    const resolved = await realpath(target);
    check(resolved.startsWith(`${root}${path.sep}`), `${label} resolves outside its evidence directory`);
    return readFile(resolved);
}

async function evidenceDirectory(directory, kind) {
    const root = path.resolve(directory);
    let metadata;
    try {
        metadata = await lstat(root);
    } catch (error) {
        if (error?.code === "ENOENT") throw new Error(`${kind} evidence directory is missing`);
        throw error;
    }
    check(metadata.isDirectory() && !metadata.isSymbolicLink(), `${kind} evidence must be a directory, not a symlink`);
    const resolved = await realpath(root);
    const resolvedMetadata = await lstat(resolved);
    check(
        resolvedMetadata.isDirectory() && !resolvedMetadata.isSymbolicLink(),
        `${kind} evidence must resolve to a directory`
    );
    return resolved;
}

async function jsonFile(file, label, containmentRoot) {
    const bytes = await regularBytes(file, label, containmentRoot);
    try {
        return { bytes, value: JSON.parse(bytes.toString("utf8")) };
    } catch {
        throw new Error(`${label} is not valid JSON`);
    }
}

function safeManifestPath(value, label) {
    check(
        typeof value === "string" &&
            value.length > 0 &&
            !value.includes("\\") &&
            !path.posix.isAbsolute(value) &&
            path.posix.normalize(value) === value &&
            !value.split("/").includes(".."),
        `${label} contains an unsafe path`
    );
    return value;
}

async function validateChecksumManifest(root, relativeManifest, requiredFiles, exact = false) {
    const manifest = safeManifestPath(relativeManifest, "checksum manifest");
    const manifestPath = path.join(root, ...manifest.split("/"));
    const bytes = await regularBytes(manifestPath, `${manifest} checksum manifest`, root);
    const text = bytes.toString("utf8");
    check(text.endsWith("\n") && text.length > 1, `${manifest} must be a non-empty newline-terminated manifest`);
    const base = path.dirname(manifestPath);
    const entries = [];
    const seen = new Set();
    for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
        const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
        check(match !== null, `${manifest} line ${index + 1} is not a canonical SHA-256 entry`);
        const relative = safeManifestPath(match[2], `${manifest} line ${index + 1}`);
        check(!seen.has(relative), `${manifest} contains duplicate entry ${relative}`);
        seen.add(relative);
        const file = path.resolve(base, ...relative.split("/"));
        check(file.startsWith(`${base}${path.sep}`), `${manifest} entry ${relative} escapes its directory`);
        const fileBytes = await regularBytes(file, `${manifest} entry ${relative}`, root);
        check(sha256(fileBytes) === match[1], `${manifest} checksum does not match ${relative}`);
        entries.push({ path: relative, sha256: match[1], bytes: fileBytes });
    }
    for (const required of requiredFiles) {
        check(seen.has(required), `${manifest} does not checksum required file ${required}`);
    }
    if (exact) {
        check(
            isDeepStrictEqual([...seen].sort(), [...requiredFiles].sort()),
            `${manifest} must checksum exactly ${requiredFiles.join(", ")}`
        );
    }
    return {
        path: manifest,
        sha256: sha256(bytes),
        entries,
    };
}

function validateExactManifestEntries(manifest, expected) {
    check(
        isDeepStrictEqual(manifest.entries.map(entry => entry.path).sort(), [...expected].sort()),
        `${manifest.path} must checksum exactly ${expected.join(", ")}`
    );
}

async function evidenceFilesUnder(root, directory = root) {
    const files = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        check(!entry.isSymbolicLink(), `evidence must not traverse symlink ${relative}`);
        if (entry.isDirectory()) files.push(...(await evidenceFilesUnder(root, absolute)));
        else if (entry.isFile()) files.push(relative);
        else throw new Error(`evidence contains unsupported entry ${relative}`);
    }
    return files;
}

async function validateExactEvidenceFiles(root, expected, label) {
    const actual = await evidenceFilesUnder(root);
    check(isDeepStrictEqual(actual, [...expected].sort()), `${label} contains unrecognized or missing files`);
}

function exactCandidate(value, label) {
    object(value, label);
    check(value.algorithm === "sha256", `${label}.algorithm must be sha256`);
    check(SHA256.test(value.digest ?? ""), `${label}.digest must be lowercase SHA-256`);
    check(Number.isSafeInteger(value.bytes) && value.bytes > 0, `${label}.bytes must be a positive integer`);
    return { algorithm: "sha256", digest: value.digest, bytes: value.bytes };
}

function sameCandidate(actual, expected, label) {
    check(
        actual.algorithm === expected.algorithm && actual.digest === expected.digest && actual.bytes === expected.bytes,
        `${label} identifies a different packed candidate`
    );
}

function reportCandidate(report, expected, label, requireIdentity = true) {
    object(report, label);
    let found = false;
    if (report.package?.tarball !== undefined) {
        found = true;
        check(report.package.name === expected.name, `${label} package name drifted`);
        check(report.package.version === expected.version, `${label} package version drifted`);
        sameCandidate(exactCandidate(report.package.tarball, `${label}.package.tarball`), expected, label);
    }
    if (report.candidate !== undefined && report.candidate !== null) {
        found = true;
        if (report.candidate.algorithm !== undefined || report.candidate.digest !== undefined) {
            sameCandidate(exactCandidate(report.candidate, `${label}.candidate`), expected, label);
        } else {
            check(SHA256.test(report.candidate.sha256 ?? ""), `${label}.candidate.sha256 is invalid`);
            check(
                Number.isSafeInteger(report.candidate.bytes) && report.candidate.bytes > 0,
                `${label}.candidate.bytes is invalid`
            );
            check(
                report.candidate.sha256 === expected.digest && report.candidate.bytes === expected.bytes,
                `${label} identifies a different packed candidate`
            );
        }
    }
    if (report.candidateSha256 !== undefined) {
        found = true;
        check(SHA256.test(report.candidateSha256), `${label}.candidateSha256 is invalid`);
        check(report.candidateSha256 === expected.digest, `${label} identifies a different packed candidate`);
    }
    check(found || !requireIdentity, `${label} does not identify a packed candidate`);
}

async function validateChecksummedJson(manifest, expected) {
    for (const entry of manifest.entries) {
        if (!entry.path.endsWith(".json")) continue;
        let report;
        try {
            report = JSON.parse(entry.bytes.toString("utf8"));
        } catch {
            throw new Error(`${manifest.path} entry ${entry.path} is not valid JSON`);
        }
        reportCandidate(report, expected, `${manifest.path} entry ${entry.path}`, false);
    }
}

async function validatePreview(directory) {
    const root = await evidenceDirectory(directory, "preview");
    const manifestPath = path.join(root, "evidence-manifest.json");
    const sumsPath = path.join(root, "SHA256SUMS");
    const [{ bytes: storedManifestBytes, value: storedManifest }, sumsBytes, recomputedManifest] = await Promise.all([
        jsonFile(manifestPath, "preview evidence-manifest.json", root),
        regularBytes(sumsPath, "preview SHA256SUMS", root),
        buildPreviewEvidenceManifest(root),
    ]);
    check(
        storedManifest.schema === "chardb.preview-evidence-manifest.v1" &&
            isDeepStrictEqual(storedManifest, recomputedManifest),
        "preview evidence manifest does not match the exact directory contents"
    );
    const expectedSums = `${[
        ...storedManifest.files.map(file => `${file.sha256}  ${file.path}`),
        `${sha256(storedManifestBytes)}  evidence-manifest.json`,
    ].join("\n")}\n`;
    check(sumsBytes.toString("utf8") === expectedSums, "preview SHA256SUMS does not match the exact evidence bytes");

    const { value: report } = await jsonFile(path.join(root, "preview-gate.json"), "preview gate report", root);
    check(report.package?.name === CHARDB_PACKAGE_NAME, `preview gate package must be ${CHARDB_PACKAGE_NAME}`);
    check(VERSION.test(report.package?.version ?? ""), "preview gate package version is invalid");
    const fingerprint = exactCandidate(report.package?.tarball, "preview gate tarball");
    const tarballName = npmPackFilename(report.package.name, report.package.version);
    const tarballBytes = await regularBytes(path.join(root, tarballName), "preview candidate tarball", root);
    sameCandidate(
        { algorithm: "sha256", digest: sha256(tarballBytes), bytes: tarballBytes.byteLength },
        fingerprint,
        "preview candidate tarball"
    );
    const packedIdentity = packageIdentityFromTarball(tarballBytes);
    check(
        packedIdentity.name === report.package.name && packedIdentity.version === report.package.version,
        "preview candidate tarball package name or version differs from the gate report"
    );
    const candidate = { name: CHARDB_PACKAGE_NAME, version: report.package.version, ...fingerprint };
    check(
        report.reactPackage?.name === CHARDB_REACT_PACKAGE_NAME,
        `preview gate React package must be ${CHARDB_REACT_PACKAGE_NAME}`
    );
    check(VERSION.test(report.reactPackage?.version ?? ""), "preview gate React package version is invalid");
    const reactFingerprint = exactCandidate(report.reactPackage?.tarball, "preview gate React tarball");
    const reactTarballName = npmPackFilename(report.reactPackage.name, report.reactPackage.version);
    const reactTarballBytes = await regularBytes(
        path.join(root, reactTarballName),
        "preview React candidate tarball",
        root
    );
    sameCandidate(
        { algorithm: "sha256", digest: sha256(reactTarballBytes), bytes: reactTarballBytes.byteLength },
        reactFingerprint,
        "preview React candidate tarball"
    );
    const packedReactIdentity = packageIdentityFromTarball(reactTarballBytes, CHARDB_REACT_PACKAGE_NAME);
    check(
        packedReactIdentity.name === report.reactPackage.name &&
            packedReactIdentity.version === report.reactPackage.version,
        "preview React tarball package name or version differs from the gate report"
    );
    assertPassingPreviewGateReport(report, fingerprint, reactFingerprint);
    for (const [file, key] of [
        ["generated-project.json", "generatedProject"],
        ["packed-chat.json", "packedChat"],
        ["packed-public-vector.json", "packedPublicVector"],
        ["browser-proof.json", "browser"],
    ]) {
        const child = await jsonFile(path.join(root, file), `preview ${file}`, root);
        check(isDeepStrictEqual(child.value, report[key]), `preview ${file} differs from the gate report`);
        const validator = {
            generatedProject: assertMatchingGeneratedProjectReport,
            packedChat: assertMatchingPackedChatReport,
            packedPublicVector: assertMatchingPackedPublicVectorReport,
            browser: assertMatchingBrowserReport,
        }[key];
        validator(child.value, fingerprint, reactFingerprint);
        reportCandidate(child.value, candidate, `preview ${file}`);
    }
    const packedOrgUser = await jsonFile(path.join(root, "packed-org-user.json"), "preview packed-org-user.json", root);
    assertMatchingPackedOrgUserReport(packedOrgUser.value, fingerprint);
    reportCandidate(packedOrgUser.value, candidate, "preview packed-org-user.json");
    return {
        root,
        candidate,
        report: {
            path: "preview-gate.json",
            sha256: sha256(await regularBytes(path.join(root, "preview-gate.json"), "preview gate report", root)),
        },
        checksums: [{ path: "SHA256SUMS", sha256: sha256(sumsBytes) }],
    };
}

async function validateCloudflareFiles(directory, candidate) {
    const root = await evidenceDirectory(directory, "cloudflare-files");
    await validateExactEvidenceFiles(root, CLOUDFLARE_FILES_EVIDENCE_FILES, "Cloudflare file evidence");
    const evidence = await validateChecksumManifest(root, "evidence.sha256", ["r2-proof-report.json"], true);
    const benchmark = await validateChecksumManifest(
        root,
        "benchmarks/benchmark-evidence.sha256",
        ["paired.json"],
        true
    );
    await validateChecksummedJson(evidence, candidate);
    await validateChecksummedJson(benchmark, candidate);
    const reportEntry = evidence.entries.find(entry => entry.path === "r2-proof-report.json");
    const report = JSON.parse(reportEntry.bytes.toString("utf8"));
    assertCloudflareFileProofReport(report, {
        algorithm: "sha256",
        digest: candidate.digest,
        bytes: candidate.bytes,
    });
    check(
        report.schema === "chardb.cloudflare-r2-proof.report.v1" && report.ok === true,
        "Cloudflare file proof did not pass"
    );
    reportCandidate(report, candidate, "Cloudflare file proof report");
    check(
        report.cleanup?.workerDeleted === true &&
            report.cleanup?.bucketDeleted === true &&
            report.cleanup?.deleteCommandsSucceeded === true &&
            report.cleanup?.fallbackPurge === false,
        "Cloudflare file proof cleanup is incomplete"
    );
    check(
        report.evidence?.secretScanPassed === true &&
            report.evidence?.checksumFile === "evidence.sha256" &&
            report.evidence?.benchmark?.directory === "benchmarks" &&
            report.evidence?.benchmark?.manifestFile === "benchmark-evidence.sha256" &&
            report.evidence?.benchmark?.pairFile === "paired.json",
        "Cloudflare file proof evidence contract drifted"
    );
    const pairEntry = benchmark.entries.find(entry => entry.path === "paired.json");
    const pair = JSON.parse(pairEntry.bytes.toString("utf8"));
    check(
        pair.schema === "chardb.file-benchmark.pair.v1" && pair.ok === true,
        "Cloudflare file benchmark pair did not pass"
    );
    reportCandidate(pair, candidate, "Cloudflare file benchmark pair");
    check(
        report.evidence.benchmark.pairSha256 === pairEntry.sha256,
        "Cloudflare file proof benchmark pair digest drifted"
    );
    const validationFile = await jsonFile(
        path.join(root, "r2-proof-validation.json"),
        "Cloudflare file validation bundle",
        root
    );
    const validation = object(validationFile.value, "Cloudflare file validation bundle");
    check(
        validation.schema === "chardb.cloudflare-r2-proof.validation-bundle.v1" && validation.ok === true,
        "Cloudflare file validation bundle did not pass"
    );
    const correctness = object(validation.correctness, "Cloudflare file correctness validation");
    sameCandidate(
        exactCandidate(correctness.candidate, "Cloudflare file correctness validation candidate"),
        candidate,
        "Cloudflare file correctness validation"
    );
    check(
        correctness.schema === "chardb.cloudflare-r2-proof.validation.v1" &&
            correctness.ok === true &&
            correctness.reportSha256 === reportEntry.sha256,
        "Cloudflare file correctness validation drifted"
    );
    const benchmarkValidation = object(validation.benchmark, "Cloudflare file benchmark validation");
    check(
        benchmarkValidation.schema === "chardb.file-benchmark.pair.v1" &&
            benchmarkValidation.candidate?.sha256 === candidate.digest &&
            benchmarkValidation.candidate?.bytes === candidate.bytes &&
            benchmarkValidation.pairSha256 === pairEntry.sha256 &&
            benchmarkValidation.files === 4,
        "Cloudflare file benchmark validation drifted"
    );
    const pairRoot = path.join(root, "benchmarks");
    const validatedBenchmark = await validateFileBenchmarkEvidence(pairRoot, candidate.digest);
    check(
        validatedBenchmark.candidate.bytes === candidate.bytes,
        "Cloudflare file benchmark identifies a different packed candidate"
    );
    for (const name of ["local", "cloudflare", "comparison"]) {
        const reference = object(pair.reports?.[name], `Cloudflare file benchmark ${name} reference`);
        const relative = safeManifestPath(reference.path, `Cloudflare file benchmark ${name} reference`);
        check(SHA256.test(reference.sha256 ?? ""), `Cloudflare file benchmark ${name} digest is invalid`);
        const child = await jsonFile(
            path.join(pairRoot, ...relative.split("/")),
            `Cloudflare file benchmark ${name}`,
            root
        );
        check(sha256(child.bytes) === reference.sha256, `Cloudflare file benchmark ${name} digest drifted`);
        reportCandidate(child.value, candidate, `Cloudflare file benchmark ${name}`);
    }
    return {
        root,
        report: { path: "r2-proof-report.json", sha256: reportEntry.sha256 },
        checksums: [
            ...[evidence, benchmark].map(item => ({ path: item.path, sha256: item.sha256 })),
            { path: "r2-proof-validation.json", sha256: sha256(validationFile.bytes) },
        ],
    };
}

async function validateFileReshard(directory, candidate) {
    const root = await evidenceDirectory(directory, "cloudflare-file-reshard");
    const evidence = await validateChecksumManifest(root, "evidence.sha256", ["paired.json", "preparation.json"]);
    const supplemental = await validateChecksumManifest(
        root,
        "supplemental.sha256",
        ["browser-proof.json", "orchestration.json", "teardown.json"],
        true
    );
    const teardownChecksum = await validateChecksumManifest(root, "teardown.sha256", ["teardown.json"], true);
    for (const manifest of [evidence, supplemental, teardownChecksum]) {
        await validateChecksummedJson(manifest, candidate);
    }
    const pairEntry = evidence.entries.find(entry => entry.path === "paired.json");
    const pair = JSON.parse(pairEntry.bytes.toString("utf8"));
    assertFileReshardDeploymentPair(pair);
    check(
        pair.schema === "chardb.file-vector-reshard-deployment-pair.v2" && pair.ok === true,
        "file reshard proof did not pass"
    );
    reportCandidate(pair, candidate, "file reshard proof report");
    const workloadFiles = [
        "paired.json",
        "preparation.json",
        "deployment-inspection.json",
        "capabilities-local.json",
        "capabilities-deployed.json",
        ...pair.execution.order.flatMap(step =>
            step.targets.map(kind => `raw-v1/${kind}-${step.sequence < 0 ? "warmup" : step.sequence}.json`)
        ),
    ];
    validateExactManifestEntries(evidence, workloadFiles);
    await validateExactEvidenceFiles(
        root,
        [
            ...workloadFiles,
            "evidence.sha256",
            "browser-proof.json",
            "orchestration.json",
            "teardown.json",
            "supplemental.sha256",
            "teardown.sha256",
        ],
        "file reshard evidence"
    );
    const preparationEntry = evidence.entries.find(entry => entry.path === "preparation.json");
    const preparation = assertFileReshardProofPreparationEvidence(JSON.parse(preparationEntry.bytes.toString("utf8")), {
        algorithm: "sha256",
        digest: candidate.digest,
        bytes: candidate.bytes,
    });
    if (
        preparation.target.worker !== pair.deployment.worker ||
        preparation.target.bucket !== pair.deployment.bucket ||
        preparation.target.vectorizeIndex !== pair.deployment.vectorizeIndex
    ) {
        throw new Error("file reshard preparation target drifted from deployment evidence");
    }
    const pairedSamples = [
        pair.warmup.local,
        pair.warmup.deployed,
        ...pair.runs.flatMap(run => [run.local, run.deployed]),
    ];
    for (const sample of pairedSamples) {
        if (sample.target.configurationSha256 !== preparation.configurationSha256) {
            throw new Error("file reshard preparation configuration drifted from workload evidence");
        }
        const expectedRunKey = `${preparation.runId}_${sample.sequence < 0 ? "warmup" : sample.sequence}`;
        if (sample.runKey !== expectedRunKey) {
            throw new Error("file reshard preparation run ID drifted from workload evidence");
        }
    }
    const browserEntry = supplemental.entries.find(entry => entry.path === "browser-proof.json");
    const browser = JSON.parse(browserEntry.bytes.toString("utf8"));
    assertMatchingBrowserReport(browser, {
        algorithm: "sha256",
        digest: candidate.digest,
        bytes: candidate.bytes,
    });
    reportCandidate(browser, candidate, "file reshard browser proof");
    check(
        browser.invariants?.activeOrganizationReshardObserved === true,
        "file reshard browser proof did not observe movement"
    );
    const orchestrationEntry = supplemental.entries.find(entry => entry.path === "orchestration.json");
    const orchestration = JSON.parse(orchestrationEntry.bytes.toString("utf8"));
    check(
        orchestration.schema === "chardb.file-vector-reshard-proof.orchestration.v1" &&
            orchestration.ok === true &&
            orchestration.secretScanPassed === true &&
            orchestration.error === null &&
            orchestration.phases?.browser === true &&
            orchestration.phases?.localStopped === true &&
            orchestration.phases?.pair === true &&
            orchestration.phases?.workloadCleanup === true &&
            orchestration.phases?.remoteCleanup === true &&
            orchestration.target?.worker === pair.deployment.worker &&
            orchestration.target?.bucket === pair.deployment.bucket &&
            orchestration.target?.vectorizeIndex === pair.deployment.vectorizeIndex,
        "file reshard orchestration evidence is incomplete"
    );
    reportCandidate(orchestration, candidate, "file reshard orchestration evidence");
    const teardownEntry = supplemental.entries.find(entry => entry.path === "teardown.json");
    const teardown = JSON.parse(teardownEntry.bytes.toString("utf8"));
    check(
        teardown.schema === "chardb.file-vector-reshard-proof-teardown.v2" &&
            teardown.ok === true &&
            teardown.localStateStopped === true &&
            teardown.workerDeleted === true &&
            teardown.bucketDeleted === true &&
            teardown.vectorizeIndexDeleted === true &&
            teardown.workerAbsentVerified === true &&
            teardown.bucketAbsentVerified === true &&
            teardown.vectorizeIndexAbsentVerified === true &&
            teardown.worker === teardown.bucket &&
            teardown.worker === teardown.vectorizeIndex &&
            teardown.idempotentReplay?.done === true &&
            teardown.idempotentReplay?.remaining === 0,
        "file reshard proof teardown is incomplete"
    );
    reportCandidate(teardown, candidate, "file reshard teardown");
    return {
        root,
        report: { path: "paired.json", sha256: pairEntry.sha256 },
        checksums: [evidence, supplemental, teardownChecksum].map(item => ({ path: item.path, sha256: item.sha256 })),
    };
}

async function validateCloudflareVectors(directory, candidate) {
    const root = await evidenceDirectory(directory, "cloudflare-vectors");
    await validateExactEvidenceFiles(root, CLOUDFLARE_VECTOR_EVIDENCE_FILES, "Cloudflare Vectorize evidence");
    const evidence = await validateChecksumManifest(root, "evidence.sha256", ["vectorize-proof-report.json"], true);
    const preparation = await validateChecksumManifest(
        root,
        "preparation.sha256",
        ["vectorize-proof-preparation.json"],
        true
    );
    const execution = await validateChecksumManifest(
        root,
        "execution.sha256",
        ["vectorize-proof-execution.json"],
        true
    );
    const manifests = [evidence, preparation, execution];
    for (const manifest of manifests) await validateChecksummedJson(manifest, candidate);
    const planFile = await jsonFile(path.join(root, "vectorize-proof-plan.json"), "Cloudflare Vectorize plan", root);
    const plan = object(planFile.value, "Cloudflare Vectorize plan");
    check(
        plan.schema === "chardb.cloudflare-vectorize-proof.plan.v1" && plan.mutatingCommandsExecuted === false,
        "Cloudflare Vectorize plan drifted"
    );
    reportCandidate(plan, candidate, "Cloudflare Vectorize plan");
    const reportEntry = evidence.entries.find(entry => entry.path === "vectorize-proof-report.json");
    const report = JSON.parse(reportEntry.bytes.toString("utf8"));
    assertCloudflareVectorizeProofReport(report, {
        algorithm: "sha256",
        digest: candidate.digest,
        bytes: candidate.bytes,
    });
    check(
        report.schema === "chardb.cloudflare-vectorize-proof.report.v2" && report.ok === true && report.error === null,
        "Cloudflare Vectorize proof did not pass"
    );
    reportCandidate(report, candidate, "Cloudflare Vectorize proof report");
    check(
        report.cleanup?.exactIdsDeleted === true &&
            report.cleanup?.finalVectorCount === 0 &&
            report.cleanup?.workerDeleted === true &&
            report.cleanup?.indexDeleted === true &&
            report.cleanup?.workerAbsentVerified === true &&
            report.cleanup?.indexAbsentVerified === true,
        "Cloudflare Vectorize proof cleanup is incomplete"
    );
    check(
        report.evidence?.secretScanPassed === true && report.evidence?.checksumFile === "evidence.sha256",
        "Cloudflare Vectorize proof evidence contract drifted"
    );
    return {
        root,
        report: { path: "vectorize-proof-report.json", sha256: reportEntry.sha256 },
        checksums: [
            ...manifests.map(item => ({ path: item.path, sha256: item.sha256 })),
            { path: "vectorize-proof-plan.json", sha256: sha256(planFile.bytes) },
        ],
    };
}

export async function admitReleaseEvidence(input) {
    check(input?.profile === RELEASE_ADMISSION_PROFILE, `release profile must be ${RELEASE_ADMISSION_PROFILE}`);
    object(input.evidence, "release evidence");
    const actualKinds = Object.keys(input.evidence).sort();
    const missingKinds = RELEASE_EVIDENCE_KINDS.filter(kind => input.evidence[kind] === undefined);
    const unknownKinds = actualKinds.filter(
        kind => !RELEASE_EVIDENCE_KINDS.includes(kind) && !RELEASE_OPTIONAL_EVIDENCE_KINDS.includes(kind)
    );
    check(
        missingKinds.length === 0 && unknownKinds.length === 0,
        `release evidence must contain ${RELEASE_EVIDENCE_KINDS.join(", ")} and no unknown kinds`
    );

    const preview = await validatePreview(input.evidence.preview);
    const results = [
        ["preview", preview],
        ["cloudflare-files", await validateCloudflareFiles(input.evidence["cloudflare-files"], preview.candidate)],
        [
            "cloudflare-file-reshard",
            await validateFileReshard(input.evidence["cloudflare-file-reshard"], preview.candidate),
        ],
        [
            "cloudflare-vectors",
            await validateCloudflareVectors(input.evidence["cloudflare-vectors"], preview.candidate),
        ],
    ];
    results.push(["os-ci", await validateOsCiEvidence(input.evidence["os-ci"], preview.candidate)]);
    return {
        schema: RELEASE_ADMISSION_SCHEMA,
        profile: RELEASE_ADMISSION_PROFILE,
        ok: true,
        candidate: preview.candidate,
        evidence: results.map(([kind, result]) => ({
            kind,
            directory: result.root,
            report: result.report,
            checksums: result.checksums,
        })),
    };
}

export function parseReleaseAdmissionArgs(argv, cwd = process.cwd()) {
    let profile;
    let output;
    const evidence = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        check(
            argument === "--profile" || argument === "--evidence" || argument === "--output",
            `unknown release admission argument ${JSON.stringify(argument)}`
        );
        const value = argv[++index];
        check(typeof value === "string" && value.length > 0, `${argument} requires a value`);
        if (argument === "--profile") {
            check(profile === undefined, "--profile may be provided only once");
            profile = value;
        } else if (argument === "--output") {
            check(output === undefined, "--output may be provided only once");
            output = path.resolve(cwd, value);
        } else {
            const separator = value.indexOf("=");
            check(separator > 0 && separator < value.length - 1, "--evidence must be kind=directory");
            const kind = value.slice(0, separator);
            const directory = value.slice(separator + 1);
            check(
                RELEASE_EVIDENCE_KINDS.includes(kind) || RELEASE_OPTIONAL_EVIDENCE_KINDS.includes(kind),
                `unknown release evidence kind ${JSON.stringify(kind)}`
            );
            check(evidence[kind] === undefined, `duplicate release evidence kind ${kind}`);
            evidence[kind] = path.resolve(cwd, directory);
        }
    }
    check(profile !== undefined, "--profile is required");
    check(profile === RELEASE_ADMISSION_PROFILE, `unknown release admission profile ${JSON.stringify(profile)}`);
    const missing = RELEASE_EVIDENCE_KINDS.filter(kind => evidence[kind] === undefined);
    check(missing.length === 0, `missing release evidence kinds: ${missing.join(", ")}`);
    const directories = [...RELEASE_EVIDENCE_KINDS, ...RELEASE_OPTIONAL_EVIDENCE_KINDS]
        .map(kind => evidence[kind])
        .filter(Boolean);
    for (let left = 0; left < directories.length; left++) {
        for (let right = left + 1; right < directories.length; right++) {
            check(
                directories[left] !== directories[right] &&
                    !directories[left].startsWith(`${directories[right]}${path.sep}`) &&
                    !directories[right].startsWith(`${directories[left]}${path.sep}`),
                "release evidence directories must be distinct and non-overlapping"
            );
        }
    }
    if (output !== undefined) {
        check(
            directories.every(directory => output !== directory && !output.startsWith(`${directory}${path.sep}`)),
            "release admission output must be outside every evidence directory"
        );
    }
    return { profile, evidence, output };
}

export async function runReleaseAdmissionCli(argv, io = process, cwd = process.cwd()) {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
        io.stdout.write(`${releaseAdmissionUsage()}\n`);
        return 0;
    }
    let options;
    try {
        options = parseReleaseAdmissionArgs(argv, cwd);
        if (options.output) {
            await writeJsonAtomically(options.output, {
                schema: RELEASE_ADMISSION_SCHEMA,
                profile: RELEASE_ADMISSION_PROFILE,
                ok: false,
                error: "release admission did not complete",
            });
        }
        const result = await admitReleaseEvidence(options);
        if (options.output) await writeJsonAtomically(options.output, result);
        io.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result = {
            schema: RELEASE_ADMISSION_SCHEMA,
            profile: RELEASE_ADMISSION_PROFILE,
            ok: false,
            error: message,
        };
        if (options?.output) {
            try {
                await writeJsonAtomically(options.output, result);
            } catch (writeError) {
                const outputMessage = writeError instanceof Error ? writeError.message : String(writeError);
                io.stderr.write(`release admission could not invalidate its output: ${outputMessage}\n`);
            }
        }
        io.stdout.write(`${JSON.stringify(result)}\n`);
        io.stderr.write(`release admission failed: ${message}\n`);
        return 1;
    }
}

if (import.meta.main) process.exitCode = await runReleaseAdmissionCli(process.argv.slice(2));
