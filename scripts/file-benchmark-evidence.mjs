import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareFileBenchmarkReports } from "./compare-file-benchmark.mjs";
import { FILE_BENCHMARK_PROFILE, assertFileBenchmarkReport } from "./file-benchmark-report.mjs";

export const FILE_BENCHMARK_EVIDENCE_FILENAME = "evidence.sha256";
export const FILE_BENCHMARK_EVIDENCE_FILES = Object.freeze([
    "local.json",
    "cloudflare.json",
    "comparison.json",
    "paired.json",
]);
export const FILE_BENCHMARK_PAIR_SCHEMA = "chardb.file-benchmark.pair.v1";

const MAX_ARTIFACT_BYTES = 64 * 1_024 * 1_024;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_FLAGS = ["nativeBetterAuth", "organizationIsolation", "exactBytes", "exactDigest", "cleanupComplete"];

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function record(value, label) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    return value;
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(record(value, label)).sort();
    const wanted = [...expected].sort();
    check(isDeepStrictEqual(actual, wanted), `${label} has unexpected fields`);
}

function assertCandidate(input, label) {
    const candidate = record(input, label);
    exactKeys(candidate, ["sha256", "bytes"], label);
    check(SHA256.test(candidate.sha256 ?? ""), `${label}.sha256 must be lowercase SHA-256`);
    check(Number.isSafeInteger(candidate.bytes) && candidate.bytes > 0, `${label}.bytes must be a positive integer`);
    return candidate;
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(directory, filename) {
    check(
        path.basename(filename) === filename && FILE_BENCHMARK_EVIDENCE_FILES.includes(filename),
        "invalid evidence filename"
    );
    const file = path.join(directory, filename);
    const metadata = await lstat(file);
    check(metadata.isFile() && !metadata.isSymbolicLink(), `${filename} must be a regular file`);
    check(metadata.size > 0 && metadata.size <= MAX_ARTIFACT_BYTES, `${filename} has invalid bytes`);
    const bytes = await readFile(file);
    check(bytes.byteLength === metadata.size, `${filename} changed while it was read`);
    let json;
    try {
        json = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
        throw new Error(`${filename} is not valid JSON`, { cause: error });
    }
    return { filename, file, bytes, sha256: sha256(bytes), json };
}

function assertPairReport(pair, name, filename, digest) {
    const child = record(pair.reports[name], `paired.reports.${name}`);
    exactKeys(child, ["path", "sha256"], `paired.reports.${name}`);
    check(child.path === filename, `paired.reports.${name}.path must be ${filename}`);
    check(SHA256.test(child.sha256 ?? ""), `paired.reports.${name}.sha256 must be lowercase SHA-256`);
    check(child.sha256 === digest, `paired.reports.${name}.sha256 does not match exact file bytes`);
}

function assertPairRuns(runs) {
    check(Array.isArray(runs) && runs.length === FILE_BENCHMARK_PROFILE.logicalRuns, "paired.runs length is invalid");
    for (const [index, run] of runs.entries()) {
        exactKeys(run, ["sequence", "local", "cloudflare"], `paired.runs[${index}]`);
        check(run.sequence === index, `paired.runs[${index}].sequence is invalid`);
        for (const target of ["local", "cloudflare"]) {
            exactKeys(run[target], RUN_FLAGS, `paired.runs[${index}].${target}`);
            for (const flag of RUN_FLAGS) {
                check(run[target][flag] === true, `paired.runs[${index}].${target}.${flag} did not pass`);
            }
        }
    }
}

function assertExecutionOrder(executionOrder) {
    const payloads = FILE_BENCHMARK_PROFILE.payloads;
    check(
        Array.isArray(executionOrder) && executionOrder.length === FILE_BENCHMARK_PROFILE.logicalRuns * payloads.length,
        "paired.executionOrder length is invalid"
    );
    for (let index = 0; index < executionOrder.length; index++) {
        const entry = executionOrder[index];
        const run = Math.floor(index / payloads.length);
        const payloadIndex = index % payloads.length;
        exactKeys(entry, ["run", "payload", "targets"], `paired.executionOrder[${index}]`);
        check(entry.run === run && entry.payload === payloads[payloadIndex].name, "paired.executionOrder plan drifted");
        const expectedTargets = (run + payloadIndex) % 2 === 0 ? ["local", "cloudflare"] : ["cloudflare", "local"];
        check(isDeepStrictEqual(entry.targets, expectedTargets), "paired.executionOrder target order drifted");
    }
}

function assertPair(pairInput, artifacts, expectedCandidate, local, cloudflare) {
    const pair = record(pairInput, "paired benchmark report");
    exactKeys(
        pair,
        ["schema", "ok", "candidate", "profile", "execution", "executionOrder", "reports", "runs"],
        "paired benchmark report"
    );
    check(pair.schema === FILE_BENCHMARK_PAIR_SCHEMA, `expected ${FILE_BENCHMARK_PAIR_SCHEMA}`);
    check(pair.ok === true, "paired benchmark did not complete successfully");
    check(
        isDeepStrictEqual(assertCandidate(pair.candidate, "paired.candidate"), expectedCandidate),
        "paired candidate drifted"
    );
    check(isDeepStrictEqual(pair.profile, FILE_BENCHMARK_PROFILE), "paired profile drifted");
    check(
        isDeepStrictEqual(pair.execution, local.execution) && isDeepStrictEqual(pair.execution, cloudflare.execution),
        "paired execution identity drifted"
    );
    exactKeys(pair.reports, ["local", "cloudflare", "comparison"], "paired.reports");
    assertPairReport(pair, "local", "local.json", artifacts.local.sha256);
    assertPairReport(pair, "cloudflare", "cloudflare.json", artifacts.cloudflare.sha256);
    assertPairReport(pair, "comparison", "comparison.json", artifacts.comparison.sha256);
    assertExecutionOrder(pair.executionOrder);
    assertPairRuns(pair.runs);
    return pair;
}

function canonicalManifest(artifacts) {
    return `${FILE_BENCHMARK_EVIDENCE_FILES.map(filename => `${artifacts[filename].sha256}  ${filename}`).join("\n")}\n`;
}

async function loadAndValidate(directoryInput, expectedCandidateInput) {
    const directory = path.resolve(directoryInput);
    const expectedCandidate = assertCandidate(expectedCandidateInput, "expected candidate");
    const files = await Promise.all(
        FILE_BENCHMARK_EVIDENCE_FILES.map(filename => readRegularFile(directory, filename))
    );
    const artifacts = Object.fromEntries(files.map(artifact => [artifact.filename, artifact]));
    const local = assertFileBenchmarkReport(artifacts["local.json"].json);
    const cloudflare = assertFileBenchmarkReport(artifacts["cloudflare.json"].json);
    check(local.target.kind === "local", "local.json must contain the local benchmark target");
    check(cloudflare.target.kind === "cloudflare", "cloudflare.json must contain the Cloudflare benchmark target");
    check(isDeepStrictEqual(local.candidate, expectedCandidate), "local candidate drifted");
    check(isDeepStrictEqual(cloudflare.candidate, expectedCandidate), "Cloudflare candidate drifted");
    const expectedComparison = compareFileBenchmarkReports(local, cloudflare);
    check(
        isDeepStrictEqual(artifacts["comparison.json"].json, expectedComparison),
        "comparison.json does not match the validated benchmark reports"
    );
    check(isDeepStrictEqual(expectedComparison.candidate, expectedCandidate), "comparison candidate drifted");
    const pairArtifacts = {
        local: artifacts["local.json"],
        cloudflare: artifacts["cloudflare.json"],
        comparison: artifacts["comparison.json"],
    };
    const pair = assertPair(artifacts["paired.json"].json, pairArtifacts, expectedCandidate, local, cloudflare);
    return { directory, expectedCandidate, artifacts, local, cloudflare, comparison: expectedComparison, pair };
}

async function readManifest(directory) {
    const file = path.join(directory, FILE_BENCHMARK_EVIDENCE_FILENAME);
    const metadata = await lstat(file);
    check(
        metadata.isFile() && !metadata.isSymbolicLink(),
        `${FILE_BENCHMARK_EVIDENCE_FILENAME} must be a regular file`
    );
    check(metadata.size > 0 && metadata.size <= 1_024, `${FILE_BENCHMARK_EVIDENCE_FILENAME} has invalid bytes`);
    return readFile(file, "utf8");
}

export async function validateFileBenchmarkEvidenceManifest(input) {
    const validated = await loadAndValidate(input.directory, input.candidate);
    const expectedManifest = canonicalManifest(validated.artifacts);
    const actualManifest = await readManifest(validated.directory);
    check(
        actualManifest === expectedManifest,
        `${FILE_BENCHMARK_EVIDENCE_FILENAME} is not canonical or has stale hashes`
    );
    return Object.freeze({
        directory: validated.directory,
        path: path.join(validated.directory, FILE_BENCHMARK_EVIDENCE_FILENAME),
        candidate: Object.freeze({ ...validated.expectedCandidate }),
        entries: Object.freeze(
            FILE_BENCHMARK_EVIDENCE_FILES.map(filename =>
                Object.freeze({
                    filename,
                    bytes: validated.artifacts[filename].bytes.byteLength,
                    sha256: validated.artifacts[filename].sha256,
                })
            )
        ),
    });
}

export async function writeFileBenchmarkEvidenceManifest(input) {
    const validated = await loadAndValidate(input.directory, input.candidate);
    const manifest = canonicalManifest(validated.artifacts);
    const destination = path.join(validated.directory, FILE_BENCHMARK_EVIDENCE_FILENAME);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, manifest, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, destination);
    return validateFileBenchmarkEvidenceManifest(input);
}
