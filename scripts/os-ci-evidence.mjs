import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertMatchingGeneratedProjectReport } from "./generated-project-report.mjs";
import { CHARDB_PACKAGE_NAME } from "./package-identity.mjs";

export const OS_CI_WINDOWS_REPORT_SCHEMA = "chardb.os-ci-windows.report.v1";
export const OS_CI_REPEAT_REPORT_SCHEMA = "chardb.os-ci-repeat.report.v1";
export const OS_CI_REPEAT_MINIMUM_ATTEMPTS = 3;
export const OS_CI_CHECKSUM_FILE = "SHA256SUMS";
export const OS_CI_REPORT_FILES = Object.freeze([
    "generated-linux-report.json",
    "generated-macos-report.json",
    "generated-windows-report.json",
]);
export const OS_CI_PLATFORM_TUPLES = Object.freeze({
    linux: Object.freeze({ name: "ubuntu-latest", operatingSystem: "linux", architecture: "x64" }),
    macos: Object.freeze({ name: "macos-latest", operatingSystem: "darwin", architecture: "arm64" }),
    windows: Object.freeze({ name: "windows-latest", operatingSystem: "win32", architecture: "x64" }),
});
export const OS_CI_WINDOWS_CHECKS = Object.freeze([
    "packedCandidateInstalled",
    "packedReactCandidateInstalled",
    "generatedTypecheckPassed",
    "cloudflareVitestPassed",
    "generatedBuildPassed",
    "wranglerDoctorPassed",
    "workerPortCollisionCleanup",
    "webPortCollisionCleanup",
    "descendantCleanup",
    "portReuse",
    "betterAuthPersistence",
    "organizationDataPersistence",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_TEXT = /^[A-Za-z0-9._/-]+$/;
const EXPECTED_REPORT_FILES = new Set(OS_CI_REPORT_FILES);
const REPEAT_DIRECTORY = /^attempt-([1-9]\d*)$/;

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function object(value, label) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    return value;
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(object(value, label)).sort();
    check(isDeepStrictEqual(actual, [...expected].sort()), `${label} fields drifted`);
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function assertCandidate(value, label) {
    object(value, label);
    check(value.name === CHARDB_PACKAGE_NAME, `${label}.name must be ${CHARDB_PACKAGE_NAME}`);
    check(VERSION.test(value.version ?? ""), `${label}.version is invalid`);
    const tarball = object(value.tarball, `${label}.tarball`);
    exactKeys(tarball, ["algorithm", "digest", "bytes"], `${label}.tarball`);
    check(tarball.algorithm === "sha256", `${label}.tarball.algorithm must be sha256`);
    check(SHA256.test(tarball.digest ?? ""), `${label}.tarball.digest is invalid`);
    check(Number.isSafeInteger(tarball.bytes) && tarball.bytes > 0, `${label}.tarball.bytes is invalid`);
    return {
        name: value.name,
        version: value.version,
        algorithm: tarball.algorithm,
        digest: tarball.digest,
        bytes: tarball.bytes,
    };
}

function assertReactCandidate(value, label) {
    object(value, label);
    check(value.name === "@chardb/react", `${label}.name must be @chardb/react`);
    check(VERSION.test(value.version ?? ""), `${label}.version is invalid`);
    const tarball = object(value.tarball, `${label}.tarball`);
    exactKeys(tarball, ["algorithm", "digest", "bytes"], `${label}.tarball`);
    check(tarball.algorithm === "sha256", `${label}.tarball.algorithm must be sha256`);
    check(SHA256.test(tarball.digest ?? ""), `${label}.tarball.digest is invalid`);
    check(Number.isSafeInteger(tarball.bytes) && tarball.bytes > 0, `${label}.tarball.bytes is invalid`);
    return {
        name: value.name,
        version: value.version,
        algorithm: tarball.algorithm,
        digest: tarball.digest,
        bytes: tarball.bytes,
    };
}

function sameCandidate(actual, expected, label) {
    check(
        actual.name === expected.name &&
            actual.version === expected.version &&
            actual.algorithm === expected.algorithm &&
            actual.digest === expected.digest &&
            actual.bytes === expected.bytes,
        `${label} identifies a different packed candidate`
    );
}

function assertPlatform(value, expected, label) {
    exactKeys(value, ["name", "operatingSystem", "release", "architecture"], label);
    for (const field of ["name", "operatingSystem", "architecture"]) {
        check(value[field] === expected[field], `${label}.${field} must be ${expected[field]}`);
    }
    check(
        typeof value.release === "string" && value.release.length <= 128 && SAFE_TEXT.test(value.release),
        `${label}.release is invalid`
    );
}

function assertRuntime(value, fields, label) {
    exactKeys(value, fields, label);
    for (const field of fields) {
        check(VERSION.test(value[field] ?? ""), `${label}.${field} must be a semantic version`);
    }
}

function assertCi(value, expectedJob, label) {
    exactKeys(value, ["provider", "repository", "workflow", "runId", "runAttempt", "gitSha", "job"], label);
    check(value.provider === "github-actions", `${label}.provider must be github-actions`);
    check(
        typeof value.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository),
        `${label}.repository is invalid`
    );
    check(
        typeof value.workflow === "string" && value.workflow.length > 0 && value.workflow.length <= 128,
        `${label}.workflow is invalid`
    );
    check(typeof value.runId === "string" && /^\d+$/.test(value.runId), `${label}.runId is invalid`);
    check(Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0, `${label}.runAttempt is invalid`);
    check(GIT_SHA.test(value.gitSha ?? ""), `${label}.gitSha is invalid`);
    check(typeof value.job === "string" && /^[A-Za-z0-9_-]+$/.test(value.job), `${label}.job is invalid`);
    check(value.job === expectedJob, `${label}.job must be ${expectedJob}`);
    return value;
}

function assertRun(value, expectedJob, label) {
    exactKeys(value, ["id", "startedAt", "durationMs", "ci"], label);
    check(typeof value.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.id), `${label}.id is invalid`);
    check(
        typeof value.startedAt === "string" &&
            !Number.isNaN(Date.parse(value.startedAt)) &&
            new Date(value.startedAt).toISOString() === value.startedAt,
        `${label}.startedAt is invalid`
    );
    check(
        typeof value.durationMs === "number" &&
            Number.isFinite(value.durationMs) &&
            value.durationMs > 0 &&
            value.durationMs <= 4 * 60 * 60 * 1_000,
        `${label}.durationMs is invalid`
    );
    return { run: value, ci: assertCi(value.ci, expectedJob, `${label}.ci`) };
}

function assertGeneratedReport(report, expectedPlatform, expectedJob, expectedCandidate, label) {
    const candidate = assertCandidate(report.package, `${label}.package`);
    assertMatchingGeneratedProjectReport(report, {
        algorithm: candidate.algorithm,
        digest: candidate.digest,
        bytes: candidate.bytes,
    });
    const reactCandidate = assertReactCandidate(report.reactPackage, `${label}.reactPackage`);
    if (expectedCandidate) sameCandidate(candidate, expectedCandidate, label);
    assertPlatform(report.platform, expectedPlatform, `${label}.platform`);
    assertRuntime(report.runtime, ["bun", "nodeCompatibility", "wrangler", "miniflare"], `${label}.runtime`);
    const { run, ci } = assertRun(report.run, expectedJob, `${label}.run`);
    return { candidate, reactCandidate, ci, report, run };
}

export function githubActionsRunFromEnvironment(environment = process.env) {
    if (environment.GITHUB_ACTIONS !== "true") return undefined;
    const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
    const value = {
        provider: "github-actions",
        repository: environment.GITHUB_REPOSITORY,
        workflow: environment.GITHUB_WORKFLOW,
        runId: environment.GITHUB_RUN_ID,
        runAttempt,
        gitSha: environment.GITHUB_SHA,
        job: environment.GITHUB_JOB,
    };
    assertCi(value, value.job, "GitHub Actions environment");
    return value;
}

export function buildWindowsOsCiReport(input) {
    const candidate = assertCandidate(input.package, "Windows OS CI package");
    const reactCandidate = assertReactCandidate(input.reactPackage, "Windows OS CI React package");
    assertPlatform(input.platform, OS_CI_PLATFORM_TUPLES.windows, "Windows OS CI platform");
    assertRuntime(
        input.runtime,
        ["bun", "nodeCompatibility", "wrangler", "miniflare", "betterAuth"],
        "Windows OS CI runtime"
    );
    const { run } = assertRun(input.run, "generated-windows-dev-tree", "Windows OS CI run");
    exactKeys(input.checks, OS_CI_WINDOWS_CHECKS, "Windows OS CI checks");
    for (const name of OS_CI_WINDOWS_CHECKS) {
        check(input.checks[name] === true, `Windows OS CI check ${name} did not pass`);
    }
    check(
        input.forcedParentTerminationCycles === 3,
        "Windows OS CI must complete three forced parent termination cycles"
    );
    return {
        schema: OS_CI_WINDOWS_REPORT_SCHEMA,
        suite: "generated-windows-dev-tree",
        package: {
            name: candidate.name,
            version: candidate.version,
            tarball: { algorithm: candidate.algorithm, digest: candidate.digest, bytes: candidate.bytes },
        },
        reactPackage: {
            name: reactCandidate.name,
            version: reactCandidate.version,
            tarball: {
                algorithm: reactCandidate.algorithm,
                digest: reactCandidate.digest,
                bytes: reactCandidate.bytes,
            },
        },
        platform: { ...input.platform },
        runtime: { ...input.runtime },
        run: { ...run, ci: { ...run.ci } },
        forcedParentTerminationCycles: input.forcedParentTerminationCycles,
        checks: { ...input.checks },
    };
}

function assertWindowsReport(report, expectedCandidate) {
    object(report, "Windows OS CI report");
    check(report.schema === OS_CI_WINDOWS_REPORT_SCHEMA, "Windows OS CI report schema drifted");
    check(report.suite === "generated-windows-dev-tree", "Windows OS CI report suite drifted");
    const rebuilt = buildWindowsOsCiReport({
        package: report.package,
        reactPackage: report.reactPackage,
        platform: report.platform,
        runtime: report.runtime,
        run: report.run,
        forcedParentTerminationCycles: report.forcedParentTerminationCycles,
        checks: report.checks,
    });
    check(isDeepStrictEqual(report, rebuilt), "Windows OS CI report fields drifted");
    const candidate = assertCandidate(report.package, "Windows OS CI report.package");
    const reactCandidate = assertReactCandidate(report.reactPackage, "Windows OS CI report.reactPackage");
    if (expectedCandidate) sameCandidate(candidate, expectedCandidate, "Windows OS CI report");
    return { candidate, reactCandidate, ci: report.run.ci, report, run: report.run };
}

function sameRun(actual, expected, label) {
    for (const field of ["repository", "workflow", "runId", "runAttempt", "gitSha"]) {
        check(actual[field] === expected[field], `${label} came from a different GitHub Actions run`);
    }
}

async function secureDirectory(directory) {
    const root = path.resolve(directory);
    const metadata = await lstat(root).catch(error => {
        if (error?.code === "ENOENT") throw new Error("OS CI evidence directory is missing");
        throw error;
    });
    check(metadata.isDirectory() && !metadata.isSymbolicLink(), "OS CI evidence must be a directory, not a symlink");
    return realpath(root);
}

async function secureFile(root, name) {
    const file = path.join(root, name);
    const metadata = await lstat(file).catch(error => {
        if (error?.code === "ENOENT") throw new Error(`OS CI evidence is missing ${name}`);
        throw error;
    });
    check(metadata.isFile() && !metadata.isSymbolicLink(), `OS CI evidence ${name} must be a regular file`);
    check((await realpath(file)) === file, `OS CI evidence ${name} must not resolve through a symlink`);
    return readFile(file);
}

async function readReports(root, expectedCandidate) {
    const values = {};
    const bytes = {};
    for (const name of OS_CI_REPORT_FILES) {
        bytes[name] = await secureFile(root, name);
        try {
            values[name] = JSON.parse(bytes[name].toString("utf8"));
        } catch {
            throw new Error(`OS CI evidence ${name} is not valid JSON`);
        }
    }
    const linux = assertGeneratedReport(
        values["generated-linux-report.json"],
        OS_CI_PLATFORM_TUPLES.linux,
        "verify",
        expectedCandidate,
        "Linux OS CI report"
    );
    const candidate = expectedCandidate ?? linux.candidate;
    const macos = assertGeneratedReport(
        values["generated-macos-report.json"],
        OS_CI_PLATFORM_TUPLES.macos,
        "generated-macos",
        candidate,
        "macOS OS CI report"
    );
    const windows = assertWindowsReport(values["generated-windows-report.json"], candidate);
    sameCandidate(macos.reactCandidate, linux.reactCandidate, "macOS OS CI React package");
    sameCandidate(windows.reactCandidate, linux.reactCandidate, "Windows OS CI React package");
    sameRun(macos.ci, linux.ci, "macOS OS CI report");
    sameRun(windows.ci, linux.ci, "Windows OS CI report");
    return {
        candidate,
        reactCandidate: linux.reactCandidate,
        ci: linux.ci,
        bytes,
        observations: {
            linux: observation(linux),
            macos: observation(macos),
            windows: observation(windows),
        },
    };
}

function observation(validated) {
    return {
        platform: { ...validated.report.platform },
        runtime: { ...validated.report.runtime },
        durationMs: validated.run.durationMs,
    };
}

function checksumText(bytes) {
    return `${OS_CI_REPORT_FILES.map(name => `${sha256(bytes[name])}  ${name}`).join("\n")}\n`;
}

export async function writeOsCiChecksumManifest(directory) {
    const root = await secureDirectory(directory);
    const names = await readdir(root);
    check(
        names.every(name => EXPECTED_REPORT_FILES.has(name) || name === OS_CI_CHECKSUM_FILE),
        "OS CI evidence directory contains an unexpected file"
    );
    const result = await readReports(root);
    await writeFile(path.join(root, OS_CI_CHECKSUM_FILE), checksumText(result.bytes), "utf8");
    return path.join(root, OS_CI_CHECKSUM_FILE);
}

export async function validateOsCiEvidence(directory, expectedCandidate) {
    const root = await secureDirectory(directory);
    const names = (await readdir(root)).sort();
    const expectedNames = [...OS_CI_REPORT_FILES, OS_CI_CHECKSUM_FILE].sort();
    check(
        isDeepStrictEqual(names, expectedNames),
        "OS CI evidence directory must contain exactly three reports and SHA256SUMS"
    );
    const result = await readReports(root, expectedCandidate);
    const manifestBytes = await secureFile(root, OS_CI_CHECKSUM_FILE);
    check(
        manifestBytes.toString("utf8") === checksumText(result.bytes),
        "OS CI SHA256SUMS does not match the three platform reports"
    );
    return {
        root,
        candidate: result.candidate,
        ci: result.ci,
        observations: result.observations,
        report: { path: OS_CI_CHECKSUM_FILE, sha256: sha256(manifestBytes) },
        checksums: [{ path: OS_CI_CHECKSUM_FILE, sha256: sha256(manifestBytes) }],
    };
}

function repeatCandidate(candidate) {
    return {
        name: candidate.name,
        version: candidate.version,
        tarball: { algorithm: candidate.algorithm, digest: candidate.digest, bytes: candidate.bytes },
    };
}

function sameRepeatRun(actual, expected, label) {
    for (const field of ["provider", "repository", "workflow", "runId", "gitSha"]) {
        check(actual[field] === expected[field], `${label} came from a different GitHub Actions workflow run`);
    }
}

function durationSummary(samples) {
    const sorted = samples.map(sample => sample.durationMs).sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return {
        minimum: sorted[0],
        median,
        maximum: sorted.at(-1),
        range: sorted.at(-1) - sorted[0],
    };
}

function buildRunnerRepeatSummary(kind, attempts) {
    const expected = OS_CI_PLATFORM_TUPLES[kind];
    const samples = attempts.map(attempt => {
        const observed = attempt.observations[kind];
        return {
            runAttempt: attempt.ci.runAttempt,
            release: observed.platform.release,
            runtime: { ...observed.runtime },
            durationMs: observed.durationMs,
        };
    });
    return {
        identity: { ...expected },
        samples,
        durationMs: durationSummary(samples),
    };
}

export async function validateOsCiRepeatEvidence(directory, expectedCandidate) {
    const root = await secureDirectory(directory);
    const entries = await readdir(root, { withFileTypes: true });
    check(
        entries.length >= OS_CI_REPEAT_MINIMUM_ATTEMPTS,
        `OS CI repeat evidence requires at least ${OS_CI_REPEAT_MINIMUM_ATTEMPTS} attempt directories`
    );
    const attemptDirectories = entries.map(entry => {
        const matched = REPEAT_DIRECTORY.exec(entry.name);
        check(
            matched && entry.isDirectory() && !entry.isSymbolicLink(),
            "OS CI repeat evidence must contain only attempt-<runAttempt> directories"
        );
        return { name: entry.name, runAttempt: Number(matched[1]) };
    });
    attemptDirectories.sort((left, right) => left.runAttempt - right.runAttempt);

    const attempts = [];
    for (const entry of attemptDirectories) {
        const result = await validateOsCiEvidence(path.join(root, entry.name), expectedCandidate);
        attempts.push({ ...result, directoryAttempt: entry.runAttempt });
    }

    const first = attempts[0];
    const seenAttempts = new Set();
    for (const attempt of attempts) {
        sameCandidate(attempt.candidate, first.candidate, "OS CI repeat evidence");
        sameRepeatRun(attempt.ci, first.ci, "OS CI repeat evidence");
        check(!seenAttempts.has(attempt.ci.runAttempt), "OS CI repeat evidence contains a duplicate runAttempt");
        seenAttempts.add(attempt.ci.runAttempt);
        check(
            attempt.ci.runAttempt === attempt.directoryAttempt,
            `OS CI repeat directory attempt-${attempt.directoryAttempt} does not match report runAttempt ${attempt.ci.runAttempt}`
        );
    }

    const runAttempts = [...seenAttempts].sort((left, right) => left - right);
    return {
        schema: OS_CI_REPEAT_REPORT_SCHEMA,
        suite: "github-actions-os-repeat",
        candidate: repeatCandidate(first.candidate),
        ci: {
            provider: first.ci.provider,
            repository: first.ci.repository,
            workflow: first.ci.workflow,
            runId: first.ci.runId,
            gitSha: first.ci.gitSha,
            runAttempts,
        },
        sampleCount: attempts.length,
        runners: {
            linux: buildRunnerRepeatSummary("linux", attempts),
            macos: buildRunnerRepeatSummary("macos", attempts),
            windows: buildRunnerRepeatSummary("windows", attempts),
        },
    };
}

export async function writeOsCiRepeatReport(directory, output, expectedCandidate) {
    const report = await validateOsCiRepeatEvidence(directory, expectedCandidate);
    await writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
}

async function run(argv) {
    if (argv.length === 2 && argv[0] === "--directory" && argv[1]) {
        await writeOsCiChecksumManifest(argv[1]);
        const result = await validateOsCiEvidence(argv[1]);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    if (argv.length === 4 && argv[0] === "--repeat-directory" && argv[1] && argv[2] === "--output" && argv[3]) {
        const result = await writeOsCiRepeatReport(argv[1], argv[3]);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    throw new Error(
        "usage: bun scripts/os-ci-evidence.mjs --directory <merged-ci-artifact-directory> | " +
            "--repeat-directory <attempts-directory> --output <report.json>"
    );
}

if (import.meta.main) {
    try {
        await run(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`OS CI evidence failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
