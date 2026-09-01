import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GENERATED_PROJECT_INVARIANTS, buildGeneratedProjectReport } from "../scripts/generated-project-report.mjs";
import {
    OS_CI_CHECKSUM_FILE,
    OS_CI_PLATFORM_TUPLES,
    OS_CI_REPEAT_MINIMUM_ATTEMPTS,
    OS_CI_REPEAT_REPORT_SCHEMA,
    OS_CI_REPORT_FILES,
    OS_CI_WINDOWS_CHECKS,
    buildWindowsOsCiReport,
    validateOsCiEvidence,
    validateOsCiRepeatEvidence,
    writeOsCiChecksumManifest,
    writeOsCiRepeatReport,
} from "../scripts/os-ci-evidence.mjs";

const temporaryDirectories: string[] = [];
const candidate = {
    name: "@chardb/core" as const,
    version: "0.1.0",
    algorithm: "sha256" as const,
    digest: createHash("sha256").update("candidate").digest("hex"),
    bytes: 1024,
};
const reactCandidate = {
    name: "@chardb/react" as const,
    version: "0.1.0",
    algorithm: "sha256" as const,
    digest: createHash("sha256").update("react-candidate").digest("hex"),
    bytes: 512,
};

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function ci(job: string, overrides: Record<string, unknown> = {}) {
    return {
        provider: "github-actions",
        repository: "zpg6/chardb",
        workflow: "CI",
        runId: "123456789",
        runAttempt: 1,
        gitSha: "a".repeat(40),
        job,
        ...overrides,
    };
}

function generated(
    operatingSystem: "linux" | "darwin",
    job: string,
    options: {
        readonly candidate?: typeof candidate;
        readonly runAttempt?: number;
        readonly runId?: string;
        readonly durationMs?: number;
    } = {}
) {
    const evidenceCandidate = options.candidate ?? candidate;
    const platform = operatingSystem === "linux" ? OS_CI_PLATFORM_TUPLES.linux : OS_CI_PLATFORM_TUPLES.macos;
    return buildGeneratedProjectReport({
        run: {
            id: `${operatingSystem}-run-${options.runAttempt ?? 1}`,
            startedAt: "2026-08-31T00:00:00.000Z",
            durationMs: options.durationMs ?? 1_000,
            ci: ci(job, { runAttempt: options.runAttempt ?? 1, runId: options.runId ?? "123456789" }),
        },
        packageEvidence: {
            name: evidenceCandidate.name,
            version: evidenceCandidate.version,
            tarball: {
                algorithm: evidenceCandidate.algorithm,
                digest: evidenceCandidate.digest,
                bytes: evidenceCandidate.bytes,
            },
        },
        reactPackageEvidence: {
            name: reactCandidate.name,
            version: reactCandidate.version,
            tarball: {
                algorithm: reactCandidate.algorithm,
                digest: reactCandidate.digest,
                bytes: reactCandidate.bytes,
            },
        },
        platform: { ...platform, release: "1.2.3" },
        runtime: { bun: "1.2.22", nodeCompatibility: "22.14.0", wrangler: "4.125.0", miniflare: "4.1.0" },
        migrations: {
            initial: { id: "initial", targetVersion: 1, activatedShards: ["ShardDO_0"] },
            upgrade: { id: "upgrade", fromVersion: 1, targetVersion: 2, activatedShards: ["ShardDO_0"] },
        },
        invariants: Object.fromEntries(GENERATED_PROJECT_INVARIANTS.map(name => [name, true])),
    });
}

async function rewriteChecksumManifest(directory: string): Promise<void> {
    const lines = [];
    for (const name of OS_CI_REPORT_FILES) {
        const bytes = await readFile(path.join(directory, name));
        lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    }
    await writeFile(path.join(directory, OS_CI_CHECKSUM_FILE), `${lines.join("\n")}\n`);
}

function windows(
    options: {
        readonly candidate?: typeof candidate;
        readonly runAttempt?: number;
        readonly runId?: string;
        readonly durationMs?: number;
    } = {}
) {
    const evidenceCandidate = options.candidate ?? candidate;
    return buildWindowsOsCiReport({
        package: {
            name: evidenceCandidate.name,
            version: evidenceCandidate.version,
            tarball: {
                algorithm: evidenceCandidate.algorithm,
                digest: evidenceCandidate.digest,
                bytes: evidenceCandidate.bytes,
            },
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
        platform: { name: "windows-latest", operatingSystem: "win32", release: "10.0.26100", architecture: "x64" },
        runtime: {
            bun: "1.2.22",
            nodeCompatibility: "22.14.0",
            wrangler: "4.125.0",
            miniflare: "4.1.0",
            betterAuth: "1.6.30",
        },
        run: {
            id: `windows-run-${options.runAttempt ?? 1}`,
            startedAt: "2026-08-31T00:00:00.000Z",
            durationMs: options.durationMs ?? 3_000,
            ci: ci("generated-windows-dev-tree", {
                runAttempt: options.runAttempt ?? 1,
                runId: options.runId ?? "123456789",
            }),
        },
        forcedParentTerminationCycles: 3,
        checks: Object.fromEntries(OS_CI_WINDOWS_CHECKS.map(name => [name, true])),
    });
}

async function writeFixture(
    directory: string,
    options: {
        readonly candidate?: typeof candidate;
        readonly runAttempt?: number;
        readonly runId?: string;
    } = {}
) {
    await mkdir(directory, { recursive: true });
    const attempt = options.runAttempt ?? 1;
    await Promise.all([
        writeFile(
            path.join(directory, "generated-linux-report.json"),
            `${JSON.stringify(generated("linux", "verify", { ...options, durationMs: 1_000 + attempt * 100 }), null, 2)}\n`
        ),
        writeFile(
            path.join(directory, "generated-macos-report.json"),
            `${JSON.stringify(generated("darwin", "generated-macos", { ...options, durationMs: 2_000 + attempt * 100 }), null, 2)}\n`
        ),
        writeFile(
            path.join(directory, "generated-windows-report.json"),
            `${JSON.stringify(windows({ ...options, durationMs: 3_000 + attempt * 100 }), null, 2)}\n`
        ),
    ]);
    await writeOsCiChecksumManifest(directory);
}

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "chardb-os-ci-evidence-"));
    temporaryDirectories.push(directory);
    await writeFixture(directory);
    return directory;
}

async function repeatFixture(attempts = [1, 2, 3]) {
    const directory = await mkdtemp(path.join(tmpdir(), "chardb-os-ci-repeat-"));
    temporaryDirectories.push(directory);
    await Promise.all(
        attempts.map(runAttempt => writeFixture(path.join(directory, `attempt-${runAttempt}`), { runAttempt }))
    );
    return directory;
}

describe("cross-OS CI evidence", () => {
    test("keeps every runner report and the aggregation job wired into CI", async () => {
        const workflow = await readFile(path.resolve(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");

        expect(workflow).toContain("--report generated-linux-report.json");
        expect(workflow).toContain("--report generated-macos-report.json");
        expect(workflow).toContain("--report generated-windows-report.json");
        expect(workflow).toContain("needs: [generated-macos, generated-windows-dev-tree, verify]");
        expect(workflow).toContain("bun scripts/os-ci-evidence.mjs --directory os-ci");
        expect(workflow).toContain("pattern: generated-*-${{ github.sha }}-${{ github.run_attempt }}");
        expect(workflow).toContain("name: os-ci-${{ github.sha }}-${{ github.run_attempt }}");
    });

    test("bounds Windows command, HTTP, output, and temp-cleanup waits", async () => {
        const harness = await readFile(path.resolve(import.meta.dir, "windows-dev-tree.mjs"), "utf8");

        expect(harness).toContain("CHILD_PROCESS_TIMEOUT_MS");
        expect(harness).toContain("WINDOWS_UTILITY_TIMEOUT_MS");
        expect(harness).toContain("AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS)");
        expect(harness).toContain("readResponseText(response)");
        expect(harness).toContain("FILESYSTEM_CLEANUP_TIMEOUT_MS");
        expect(harness).toContain("[windows-dev-tree] ${label}: start");
        expect(harness).toContain("restart cycle ${cycle}: force-stop dev parent");
        expect(harness).not.toContain("const response = await fetch(url);");
        expect(harness).not.toContain("const exitCode = await child.exited;");
    });

    test("builds one candidate and hands the exact artifact to all three OS jobs", async () => {
        const workflow = await readFile(path.resolve(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");
        const occurrences = (needle: string): number => workflow.split(needle).length - 1;

        expect(occurrences("npm pack --ignore-scripts")).toBe(2);
        expect(occurrences("bun run build:react\n")).toBe(1);
        expect(occurrences("needs: candidate")).toBe(3);
        expect(occurrences("uses: actions/download-artifact@v4")).toBe(4);
        expect(occurrences("name: candidate-${{ github.sha }}-${{ github.run_attempt }}")).toBe(4);
        expect(occurrences("path: ci-candidate")).toBe(4);
        expect(occurrences("ci-candidate-artifact.mjs --verify --directory ci-candidate")).toBe(3);
        expect(workflow).toContain(
            'bun scripts/ci-candidate-artifact.mjs --stage ".ci-pack/${core_tarball}" --react ".ci-pack/${react_tarball}" --directory ci-candidate'
        );
        expect(workflow).toContain(
            'react_tarball="$(npm pack --ignore-scripts --pack-destination .ci-pack ./packages/react)"'
        );
        expect(workflow).toContain(
            "bun scripts/smoke-generated-project.mjs ci-candidate/core.tgz --react ci-candidate/react.tgz --report generated-linux-report.json"
        );
        expect(workflow).toContain(
            "bun scripts/smoke-generated-project.mjs ci-candidate/core.tgz --react ci-candidate/react.tgz --report generated-macos-report.json"
        );
        expect(workflow).toContain(
            "bun test/windows-dev-tree.mjs --tarball ci-candidate/core.tgz --react-tarball ci-candidate/react.tgz --report generated-windows-report.json"
        );
    });

    test("binds Linux, macOS, and Windows reports from one run to one package", async () => {
        const directory = await fixture();
        const result = await validateOsCiEvidence(directory, candidate);

        expect(result).toMatchObject({
            candidate,
            ci: { provider: "github-actions", runId: "123456789", gitSha: "a".repeat(40) },
            report: { path: "SHA256SUMS" },
        });
    });

    test("summarizes three exact workflow attempts without making an SLA or cost claim", async () => {
        const directory = await repeatFixture();
        const output = path.join(path.dirname(directory), `${path.basename(directory)}.json`);
        temporaryDirectories.push(output);
        const result = await writeOsCiRepeatReport(directory, output, candidate);

        expect(OS_CI_REPEAT_MINIMUM_ATTEMPTS).toBe(3);
        expect(result).toMatchObject({
            schema: OS_CI_REPEAT_REPORT_SCHEMA,
            suite: "github-actions-os-repeat",
            candidate: {
                name: candidate.name,
                version: candidate.version,
                tarball: { algorithm: candidate.algorithm, digest: candidate.digest, bytes: candidate.bytes },
            },
            ci: {
                provider: "github-actions",
                repository: "zpg6/chardb",
                workflow: "CI",
                runId: "123456789",
                gitSha: "a".repeat(40),
                runAttempts: [1, 2, 3],
            },
            sampleCount: 3,
            runners: {
                linux: {
                    identity: OS_CI_PLATFORM_TUPLES.linux,
                    durationMs: { minimum: 1_100, median: 1_200, maximum: 1_300, range: 200 },
                },
                macos: {
                    identity: OS_CI_PLATFORM_TUPLES.macos,
                    durationMs: { minimum: 2_100, median: 2_200, maximum: 2_300, range: 200 },
                },
                windows: {
                    identity: OS_CI_PLATFORM_TUPLES.windows,
                    durationMs: { minimum: 3_100, median: 3_200, maximum: 3_300, range: 200 },
                },
            },
        });
        expect(JSON.stringify(result)).not.toMatch(/sla|cost/i);
        expect(JSON.parse(await readFile(output, "utf8"))).toEqual(result);
    });

    test("rejects too few, duplicate, and mismatched workflow attempts", async () => {
        const tooFew = await repeatFixture([1, 2]);
        await expect(validateOsCiRepeatEvidence(tooFew, candidate)).rejects.toThrow("at least 3");

        const duplicate = await repeatFixture();
        for (const name of OS_CI_REPORT_FILES) {
            const file = path.join(duplicate, "attempt-3", name);
            const report = JSON.parse(await readFile(file, "utf8"));
            report.run.ci.runAttempt = 2;
            await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        }
        await rewriteChecksumManifest(path.join(duplicate, "attempt-3"));
        await expect(validateOsCiRepeatEvidence(duplicate, candidate)).rejects.toThrow("duplicate runAttempt");

        const differentRun = await repeatFixture();
        for (const name of OS_CI_REPORT_FILES) {
            const file = path.join(differentRun, "attempt-3", name);
            const report = JSON.parse(await readFile(file, "utf8"));
            report.run.ci.runId = "987654321";
            await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        }
        await rewriteChecksumManifest(path.join(differentRun, "attempt-3"));
        await expect(validateOsCiRepeatEvidence(differentRun, candidate)).rejects.toThrow(
            "different GitHub Actions workflow run"
        );
    });

    test("rejects mixed candidates and runner identities across repeat attempts", async () => {
        const mixedCandidate = await repeatFixture();
        const otherDigest = createHash("sha256").update("other-candidate").digest("hex");
        for (const name of OS_CI_REPORT_FILES) {
            const file = path.join(mixedCandidate, "attempt-3", name);
            const report = JSON.parse(await readFile(file, "utf8"));
            report.package.tarball.digest = otherDigest;
            await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        }
        await rewriteChecksumManifest(path.join(mixedCandidate, "attempt-3"));
        await expect(validateOsCiRepeatEvidence(mixedCandidate)).rejects.toThrow("different packed candidate");

        const mixedRunner = await repeatFixture();
        const file = path.join(mixedRunner, "attempt-3", "generated-macos-report.json");
        const report = JSON.parse(await readFile(file, "utf8"));
        report.platform.architecture = "x64";
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        await rewriteChecksumManifest(path.join(mixedRunner, "attempt-3"));
        await expect(validateOsCiRepeatEvidence(mixedRunner, candidate)).rejects.toThrow(
            "platform.architecture must be arm64"
        );
    });

    test("rejects report tampering when the checksum file is unchanged", async () => {
        const directory = await fixture();
        const file = path.join(directory, "generated-linux-report.json");
        const report = JSON.parse(await readFile(file, "utf8"));
        report.runtime.wrangler = "4.999.0";
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);

        await expect(validateOsCiEvidence(directory, candidate)).rejects.toThrow("SHA256SUMS does not match");
    });

    test("rejects a mislabeled platform even after checksums are recomputed", async () => {
        const directory = await fixture();
        const file = path.join(directory, "generated-macos-report.json");
        const report = JSON.parse(await readFile(file, "utf8"));
        report.platform.operatingSystem = "linux";
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);

        await rewriteChecksumManifest(directory);
        await expect(validateOsCiEvidence(directory, candidate)).rejects.toThrow("operatingSystem must be darwin");
    });

    test("rejects relabeled runners and architectures after checksums are recomputed", async () => {
        const relabeledRunner = await fixture();
        const runnerFile = path.join(relabeledRunner, "generated-macos-report.json");
        const runnerReport = JSON.parse(await readFile(runnerFile, "utf8"));
        runnerReport.platform.name = "windows-latest";
        await writeFile(runnerFile, `${JSON.stringify(runnerReport, null, 2)}\n`);
        await rewriteChecksumManifest(relabeledRunner);
        await expect(validateOsCiEvidence(relabeledRunner, candidate)).rejects.toThrow(
            "platform.name must be macos-latest"
        );

        const relabeledArchitecture = await fixture();
        const architectureFile = path.join(relabeledArchitecture, "generated-macos-report.json");
        const architectureReport = JSON.parse(await readFile(architectureFile, "utf8"));
        architectureReport.platform.architecture = "x64";
        await writeFile(architectureFile, `${JSON.stringify(architectureReport, null, 2)}\n`);
        await rewriteChecksumManifest(relabeledArchitecture);
        await expect(validateOsCiEvidence(relabeledArchitecture, candidate)).rejects.toThrow(
            "platform.architecture must be arm64"
        );
    });

    test("rejects reports from different workflow runs even after checksums are recomputed", async () => {
        const directory = await fixture();
        const file = path.join(directory, "generated-windows-report.json");
        const report = JSON.parse(await readFile(file, "utf8"));
        report.run.ci.runId = "987654321";
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);

        await expect(writeOsCiChecksumManifest(directory)).rejects.toThrow("different GitHub Actions run");
    });

    test("rejects a passing Windows report with one failed check", async () => {
        const directory = await fixture();
        const file = path.join(directory, "generated-windows-report.json");
        const report = JSON.parse(await readFile(file, "utf8"));
        report.checks.portReuse = false;
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);

        await expect(writeOsCiChecksumManifest(directory)).rejects.toThrow("check portReuse did not pass");
    });

    test("rejects incomplete and padded artifact directories", async () => {
        const incomplete = await fixture();
        await rm(path.join(incomplete, "generated-macos-report.json"));
        await expect(validateOsCiEvidence(incomplete, candidate)).rejects.toThrow("exactly three reports");

        const padded = await fixture();
        await writeFile(path.join(padded, "local-report.json"), "{}\n");
        await expect(validateOsCiEvidence(padded, candidate)).rejects.toThrow("exactly three reports");
    });
});
