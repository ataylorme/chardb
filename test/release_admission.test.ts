import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { writePreviewEvidenceManifest } from "../scripts/finalize-preview-evidence.mjs";
import {
    OS_CI_PLATFORM_TUPLES,
    OS_CI_WINDOWS_CHECKS,
    buildWindowsOsCiReport,
    writeOsCiChecksumManifest,
} from "../scripts/os-ci-evidence.mjs";
import { PACKED_ORG_USER_CHECKS, buildPackedOrgUserReport } from "../scripts/packed-org-user-report.mjs";
import { REQUIRED_PREVIEW_STEPS } from "../scripts/preview-gate-report.mjs";
import {
    RELEASE_ADMISSION_PROFILE,
    RELEASE_ADMISSION_SCHEMA,
    RELEASE_EVIDENCE_KINDS,
    admitReleaseEvidence,
    parseReleaseAdmissionArgs,
    releaseAdmissionUsage,
    runReleaseAdmissionCli,
} from "../scripts/release-admission.mjs";
import {
    buildBrowserEvidence,
    buildCloudflareFileProof,
    buildCloudflareVectorizeProof,
    buildFileBenchmarkComparison,
    buildFileBenchmarkPair,
    buildFileBenchmarkReport,
    buildFileReshardPair,
    buildFileReshardPreparation,
    buildGeneratedProjectEvidence,
    buildPackedChatEvidence,
    buildPackedPublicVectorEvidence,
} from "./fixtures/release-evidence-builders";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function tarballForPackage(name: string, version: string): Uint8Array {
    const body = Buffer.from(`${JSON.stringify({ name, version })}\n`);
    const header = Buffer.alloc(512);
    header.write("package/package.json", 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${body.byteLength.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const padding = Buffer.alloc(Math.ceil(body.byteLength / 512) * 512 - body.byteLength);
    return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1_024)]));
}

async function json(directory: string, relative: string, value: unknown) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const file = path.join(directory, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return { bytes, sha256: sha256(bytes) };
}

async function manifest(directory: string, relative: string, entries: readonly string[]) {
    const base = path.dirname(path.join(directory, ...relative.split("/")));
    const lines = [];
    for (const entry of entries) {
        lines.push(`${sha256(await readFile(path.join(base, ...entry.split("/"))))}  ${entry}`);
    }
    await writeFile(path.join(directory, ...relative.split("/")), `${lines.join("\n")}\n`);
}

async function refreshManifest(directory: string, relative: string) {
    const file = path.join(directory, ...relative.split("/"));
    const entries = (await readFile(file, "utf8"))
        .trimEnd()
        .split("\n")
        .map(line => line.slice(66));
    await manifest(directory, relative, entries);
}

async function writeOsCiFixture(
    directory: string,
    exact: { algorithm: "sha256"; digest: string; bytes: number },
    reactExact: { algorithm: "sha256"; digest: string; bytes: number }
): Promise<void> {
    const ci = (job: string) => ({
        provider: "github-actions",
        repository: "zpg6/chardb",
        workflow: "CI",
        runId: "123456789",
        runAttempt: 1,
        gitSha: "a".repeat(40),
        job,
    });
    const generated = (kind: "linux" | "macos", job: string) => {
        const platform = OS_CI_PLATFORM_TUPLES[kind];
        return {
            ...buildGeneratedProjectEvidence(exact, reactExact),
            run: {
                id: `${kind}-run`,
                startedAt: "2026-08-31T00:00:00.000Z",
                durationMs: 1_000,
                ci: ci(job),
            },
            platform: { ...platform, release: "1.2.3" },
            runtime: {
                bun: "1.2.22",
                nodeCompatibility: "22.14.0",
                wrangler: "4.125.0",
                miniflare: "4.1.0",
            },
        };
    };
    await json(directory, "generated-linux-report.json", generated("linux", "verify"));
    await json(directory, "generated-macos-report.json", generated("macos", "generated-macos"));
    await json(
        directory,
        "generated-windows-report.json",
        buildWindowsOsCiReport({
            package: { name: "@chardb/core", version: "0.1.0", tarball: exact },
            reactPackage: { name: "@chardb/react", version: "0.1.0", tarball: reactExact },
            platform: { ...OS_CI_PLATFORM_TUPLES.windows, release: "10.0.26100" },
            runtime: {
                bun: "1.2.22",
                nodeCompatibility: "22.14.0",
                wrangler: "4.125.0",
                miniflare: "4.1.0",
                betterAuth: "1.6.30",
            },
            run: {
                id: "windows-run",
                startedAt: "2026-08-31T00:00:00.000Z",
                durationMs: 1_000,
                ci: ci("generated-windows-dev-tree"),
            },
            forcedParentTerminationCycles: 3,
            checks: Object.fromEntries(OS_CI_WINDOWS_CHECKS.map(name => [name, true])),
        })
    );
    await writeOsCiChecksumManifest(directory);
}

async function releaseFixture() {
    const root = await mkdtemp(path.join(tmpdir(), "chardb-release-admission-"));
    temporaryDirectories.push(root);
    const directories = Object.fromEntries(RELEASE_EVIDENCE_KINDS.map(kind => [kind, path.join(root, kind)])) as Record<
        (typeof RELEASE_EVIDENCE_KINDS)[number],
        string
    >;
    await Promise.all(Object.values(directories).map(directory => mkdir(directory, { recursive: true })));

    const tarball = tarballForPackage("@chardb/core", "0.1.0");
    const exact = { algorithm: "sha256" as const, digest: sha256(tarball), bytes: tarball.byteLength };
    const reactTarball = tarballForPackage("@chardb/react", "0.1.0");
    const reactExact = {
        algorithm: "sha256" as const,
        digest: sha256(reactTarball),
        bytes: reactTarball.byteLength,
    };
    const packageIdentity = { name: "@chardb/core", version: "0.1.0", tarball: exact };
    const reactPackageIdentity = { name: "@chardb/react", version: "0.1.0", tarball: reactExact };
    await writeFile(path.join(directories.preview, "chardb-core-0.1.0.tgz"), tarball);
    await writeFile(path.join(directories.preview, "chardb-react-0.1.0.tgz"), reactTarball);
    const generatedProject = buildGeneratedProjectEvidence(exact, reactExact);
    const packedChat = buildPackedChatEvidence(exact, reactExact);
    const packedPublicVector = buildPackedPublicVectorEvidence(exact, reactExact);
    const browser = buildBrowserEvidence(exact, reactExact);
    await json(directories.preview, "generated-project.json", generatedProject);
    await json(directories.preview, "packed-chat.json", packedChat);
    await json(
        directories.preview,
        "packed-org-user.json",
        buildPackedOrgUserReport({
            package: { name: "@chardb/core", version: "0.1.0", tarball: exact },
            checks: Object.fromEntries(PACKED_ORG_USER_CHECKS.map(name => [name, true])),
        })
    );
    await json(directories.preview, "packed-public-vector.json", packedPublicVector);
    await json(directories.preview, "browser-proof.json", browser);
    await json(directories.preview, "preview-gate.json", {
        schema: "chardb.preview-gate.report.v1",
        suite: "organization-preview-release-gate",
        source: { gitSha: "abc123", dirty: false },
        package: packageIdentity,
        reactPackage: reactPackageIdentity,
        steps: REQUIRED_PREVIEW_STEPS.map(name => ({ name, status: "passed" })),
        generatedProject,
        packedChat,
        packedPublicVector,
        browser,
        summary: { passed: true, completedSteps: REQUIRED_PREVIEW_STEPS.length, failedStep: null },
    });
    await writePreviewEvidenceManifest(directories.preview);

    const benchmarkCandidate = { sha256: exact.digest, bytes: exact.bytes };
    const localBenchmark = buildFileBenchmarkReport("local", benchmarkCandidate);
    const cloudflareBenchmark = buildFileBenchmarkReport("cloudflare", benchmarkCandidate, 2);
    const fileBenchmarkReports = {
        local: localBenchmark,
        cloudflare: cloudflareBenchmark,
        comparison: buildFileBenchmarkComparison(localBenchmark, cloudflareBenchmark),
    };
    const benchmarkReferences = {} as Record<keyof typeof fileBenchmarkReports, { path: string; sha256: string }>;
    for (const name of Object.keys(fileBenchmarkReports) as Array<keyof typeof fileBenchmarkReports>) {
        const report = fileBenchmarkReports[name];
        const written = await json(directories["cloudflare-files"], `benchmarks/${name}.json`, report);
        benchmarkReferences[name] = { path: `${name}.json`, sha256: written.sha256 };
    }
    const benchmarkPair = await json(
        directories["cloudflare-files"],
        "benchmarks/paired.json",
        buildFileBenchmarkPair(benchmarkCandidate, {
            local: benchmarkReferences.local.sha256,
            cloudflare: benchmarkReferences.cloudflare.sha256,
            comparison: benchmarkReferences.comparison.sha256,
        })
    );
    await manifest(directories["cloudflare-files"], "benchmarks/benchmark-evidence.sha256", ["paired.json"]);
    const fileProof = await json(
        directories["cloudflare-files"],
        "r2-proof-report.json",
        buildCloudflareFileProof(exact, benchmarkPair.sha256)
    );
    await json(directories["cloudflare-files"], "r2-proof-validation.json", {
        schema: "chardb.cloudflare-r2-proof.validation-bundle.v1",
        ok: true,
        correctness: {
            schema: "chardb.cloudflare-r2-proof.validation.v1",
            ok: true,
            candidate: exact,
            reportSha256: fileProof.sha256,
        },
        benchmark: {
            schema: "chardb.file-benchmark.pair.v1",
            candidate: benchmarkCandidate,
            pairSha256: benchmarkPair.sha256,
            files: 4,
        },
    });
    await manifest(directories["cloudflare-files"], "evidence.sha256", ["r2-proof-report.json"]);

    const reshardPreparation = buildFileReshardPreparation(exact);
    await json(directories["cloudflare-file-reshard"], "preparation.json", reshardPreparation);
    const reshardPair = buildFileReshardPair(exact, reshardPreparation);
    await json(directories["cloudflare-file-reshard"], "paired.json", reshardPair);
    await json(directories["cloudflare-file-reshard"], "deployment-inspection.json", { candidate: exact });
    await json(directories["cloudflare-file-reshard"], "capabilities-local.json", { candidate: exact });
    await json(directories["cloudflare-file-reshard"], "capabilities-deployed.json", { candidate: exact });
    for (const step of reshardPair.execution.order) {
        for (const kind of step.targets) {
            await json(
                directories["cloudflare-file-reshard"],
                `raw-v1/${kind}-${step.sequence < 0 ? "warmup" : step.sequence}.json`,
                { candidate: exact }
            );
        }
    }
    await json(directories["cloudflare-file-reshard"], "browser-proof.json", browser);
    await json(directories["cloudflare-file-reshard"], "orchestration.json", {
        schema: "chardb.file-vector-reshard-proof.orchestration.v1",
        ok: true,
        candidate: exact,
        target: reshardPreparation.target,
        phases: {
            browser: true,
            localStopped: true,
            pair: true,
            workloadCleanup: true,
            remoteCleanup: true,
        },
        secretScanPassed: true,
        error: null,
    });
    await json(directories["cloudflare-file-reshard"], "teardown.json", {
        schema: "chardb.file-vector-reshard-proof-teardown.v2",
        ok: true,
        candidateSha256: exact.digest,
        worker: reshardPreparation.target.worker,
        bucket: reshardPreparation.target.bucket,
        vectorizeIndex: reshardPreparation.target.vectorizeIndex,
        localStateStopped: true,
        workerDeleted: true,
        bucketDeleted: true,
        vectorizeIndexDeleted: true,
        workerAbsentVerified: true,
        bucketAbsentVerified: true,
        vectorizeIndexAbsentVerified: true,
        idempotentReplay: { done: true, remaining: 0 },
    });
    await manifest(directories["cloudflare-file-reshard"], "evidence.sha256", [
        "paired.json",
        "preparation.json",
        "deployment-inspection.json",
        "capabilities-local.json",
        "capabilities-deployed.json",
        ...reshardPair.execution.order.flatMap(step =>
            step.targets.map(kind => `raw-v1/${kind}-${step.sequence < 0 ? "warmup" : step.sequence}.json`)
        ),
    ]);
    await manifest(directories["cloudflare-file-reshard"], "supplemental.sha256", [
        "browser-proof.json",
        "orchestration.json",
        "teardown.json",
    ]);
    await manifest(directories["cloudflare-file-reshard"], "teardown.sha256", ["teardown.json"]);

    await json(directories["cloudflare-vectors"], "vectorize-proof-report.json", buildCloudflareVectorizeProof(exact));
    await json(directories["cloudflare-vectors"], "vectorize-proof-plan.json", {
        schema: "chardb.cloudflare-vectorize-proof.plan.v1",
        candidate: exact,
        mutatingCommandsExecuted: false,
    });
    await json(directories["cloudflare-vectors"], "vectorize-proof-preparation.json", {
        schema: "chardb.cloudflare-vectorize-proof.preparation.v1",
        candidate: exact,
    });
    await json(directories["cloudflare-vectors"], "vectorize-proof-execution.json", {
        schema: "chardb.cloudflare-vectorize-proof.execution.v2",
        ok: true,
        candidate: exact,
    });
    await manifest(directories["cloudflare-vectors"], "evidence.sha256", ["vectorize-proof-report.json"]);
    await manifest(directories["cloudflare-vectors"], "preparation.sha256", ["vectorize-proof-preparation.json"]);
    await manifest(directories["cloudflare-vectors"], "execution.sha256", ["vectorize-proof-execution.json"]);
    await writeOsCiFixture(directories["os-ci"], exact, reactExact);

    return { root, directories, exact, packageIdentity };
}

function input(directories: Record<(typeof RELEASE_EVIDENCE_KINDS)[number], string>) {
    return { profile: RELEASE_ADMISSION_PROFILE, evidence: directories } as const;
}

describe("release admission", () => {
    test("admits one exact candidate across every explicit required proof", async () => {
        const fixture = await releaseFixture();
        const result = await admitReleaseEvidence(input(fixture.directories));

        expect(result).toMatchObject({
            schema: RELEASE_ADMISSION_SCHEMA,
            profile: RELEASE_ADMISSION_PROFILE,
            ok: true,
            candidate: { name: "@chardb/core", version: "0.1.0", ...fixture.exact },
        });
        expect(result.evidence.map(item => item.kind)).toEqual([...RELEASE_EVIDENCE_KINDS]);
        expect(result.evidence.flatMap(item => item.checksums)).toHaveLength(12);
    });

    test("requires cross-OS evidence from the exact candidate", async () => {
        const fixture = await releaseFixture();
        const result = await admitReleaseEvidence(input(fixture.directories));
        expect(result.evidence.map(item => item.kind)).toEqual([...RELEASE_EVIDENCE_KINDS]);

        const { "os-ci": omitted, ...withoutOsCi } = fixture.directories;
        void omitted;
        await expect(
            admitReleaseEvidence({ profile: RELEASE_ADMISSION_PROFILE, evidence: withoutOsCi as never })
        ).rejects.toThrow("release evidence must contain");
    });

    test("rejects checksummed cross-OS runner and architecture relabeling", async () => {
        const reports = ["generated-linux-report.json", "generated-macos-report.json", "generated-windows-report.json"];
        const relabeledRunner = await releaseFixture();
        const runnerDirectory = relabeledRunner.directories["os-ci"];
        const runnerPath = path.join(runnerDirectory, "generated-macos-report.json");
        const runnerReport = JSON.parse(await readFile(runnerPath, "utf8"));
        runnerReport.platform.name = "windows-latest";
        await json(runnerDirectory, "generated-macos-report.json", runnerReport);
        await manifest(runnerDirectory, "SHA256SUMS", reports);
        await expect(admitReleaseEvidence(input(relabeledRunner.directories))).rejects.toThrow(
            "platform.name must be macos-latest"
        );

        const relabeledArchitecture = await releaseFixture();
        const architectureDirectory = relabeledArchitecture.directories["os-ci"];
        const architecturePath = path.join(architectureDirectory, "generated-macos-report.json");
        const architectureReport = JSON.parse(await readFile(architecturePath, "utf8"));
        architectureReport.platform.architecture = "x64";
        await json(architectureDirectory, "generated-macos-report.json", architectureReport);
        await manifest(architectureDirectory, "SHA256SUMS", reports);
        await expect(admitReleaseEvidence(input(relabeledArchitecture.directories))).rejects.toThrow(
            "platform.architecture must be arm64"
        );
    });

    test("rejects a mixed candidate even when its report checksum was recomputed", async () => {
        const fixture = await releaseFixture();
        const directory = fixture.directories["cloudflare-vectors"];
        const report = JSON.parse(await readFile(path.join(directory, "vectorize-proof-report.json"), "utf8"));
        report.candidate.digest = "f".repeat(64);
        await json(directory, "vectorize-proof-report.json", report);
        await manifest(directory, "evidence.sha256", ["vectorize-proof-report.json"]);

        await expect(admitReleaseEvidence(input(fixture.directories))).rejects.toThrow("different packed candidate");
    });

    test("rejects stripped packed realtime provenance before finalization and after finalized-byte tampering", async () => {
        const fixture = await releaseFixture();
        const preview = fixture.directories.preview;
        const packedChat = JSON.parse(await readFile(path.join(preview, "packed-chat.json"), "utf8"));
        const { runtime: omittedRuntime, ...withoutRuntime } = packedChat;
        void omittedRuntime;
        await json(preview, "packed-chat.json", withoutRuntime);
        const gate = JSON.parse(await readFile(path.join(preview, "preview-gate.json"), "utf8"));
        gate.packedChat = withoutRuntime;
        await json(preview, "preview-gate.json", gate);
        await expect(writePreviewEvidenceManifest(preview)).rejects.toThrow("packed-chat runtime");
        await expect(admitReleaseEvidence(input(fixture.directories))).rejects.toThrow("packed-chat runtime");
    });

    test("rejects every weakened file and reshard browser invariant after the preview manifest is recomputed", async () => {
        const fixture = await releaseFixture();
        const preview = fixture.directories.preview;
        const reportPath = path.join(preview, "browser-proof.json");
        const gatePath = path.join(preview, "preview-gate.json");
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        const gate = JSON.parse(await readFile(gatePath, "utf8"));
        const formerlyOmitted = [
            "nativeR2UploadObserved",
            "transactionalFileAttachObserved",
            "authenticatedFileDownloadObserved",
            "fileRestartPersistenceObserved",
            "betterAuthDeletionFenceObserved",
            "fileOrganizationIsolationObserved",
            "fileReplacementObserved",
            "activeOrganizationReshardObserved",
        ];

        for (const name of formerlyOmitted) {
            report.invariants[name] = false;
            gate.browser.invariants[name] = false;
            await json(preview, "browser-proof.json", report);
            await json(preview, "preview-gate.json", gate);
            await expect(writePreviewEvidenceManifest(preview)).rejects.toThrow(name);
            await expect(admitReleaseEvidence(input(fixture.directories))).rejects.toThrow(name);
            report.invariants[name] = true;
            gate.browser.invariants[name] = true;
        }
    });

    test("rejects a wrong browser suite and stripped Better Auth route evidence after re-manifesting", async () => {
        const mutators: Array<(report: { suite: string; betterAuthRoutes: unknown[] }) => void> = [
            report => {
                report.suite = "forged-browser-suite";
            },
            report => {
                report.betterAuthRoutes = [];
            },
        ];
        for (const mutate of mutators) {
            const fixture = await releaseFixture();
            const preview = fixture.directories.preview;
            const report = JSON.parse(await readFile(path.join(preview, "browser-proof.json"), "utf8"));
            const gate = JSON.parse(await readFile(path.join(preview, "preview-gate.json"), "utf8"));
            mutate(report);
            mutate(gate.browser);
            await json(preview, "browser-proof.json", report);
            await json(preview, "preview-gate.json", gate);
            await expect(writePreviewEvidenceManifest(preview)).rejects.toThrow(/suite|create calls/);
            await expect(admitReleaseEvidence(input(fixture.directories))).rejects.toThrow(/suite|create calls/);
        }
    });

    test("rejects a mixed candidate reached through a symlinked evidence parent", async () => {
        const fixture = await releaseFixture();
        const foreign = await releaseFixture();
        const foreignBenchmarks = path.join(foreign.directories["cloudflare-files"], "benchmarks");
        const foreignPairPath = path.join(foreignBenchmarks, "paired.json");
        const foreignPair = JSON.parse(await readFile(foreignPairPath, "utf8"));
        foreignPair.candidate.sha256 = "f".repeat(64);
        await json(foreignBenchmarks, "paired.json", foreignPair);
        await manifest(foreignBenchmarks, "benchmark-evidence.sha256", ["paired.json"]);

        const localBenchmarks = path.join(fixture.directories["cloudflare-files"], "benchmarks");
        await rm(localBenchmarks, { recursive: true });
        await symlink(foreignBenchmarks, localBenchmarks, "dir");

        await expect(admitReleaseEvidence(input(fixture.directories))).rejects.toThrow("must not traverse symlink");
    });

    test("rejects candidate version drift in a secondary packed report", async () => {
        const fixture = await releaseFixture();
        const directory = fixture.directories["cloudflare-file-reshard"];
        const report = JSON.parse(await readFile(path.join(directory, "browser-proof.json"), "utf8"));
        report.package.version = "0.2.0";
        await json(directory, "browser-proof.json", report);
        await refreshManifest(directory, "supplemental.sha256");

        await expect(admitReleaseEvidence(input(fixture.directories))).rejects.toThrow("package version drifted");
    });

    test("rejects weakened live Vectorize and combined movement evidence after checksums are recomputed", async () => {
        const weakenedVector = await releaseFixture();
        const vectorDirectory = weakenedVector.directories["cloudflare-vectors"];
        const vectorReport = JSON.parse(
            await readFile(path.join(vectorDirectory, "vectorize-proof-report.json"), "utf8")
        );
        vectorReport.search.liveDelivery.sdk.acknowledgementEverySnapshot = false;
        await json(vectorDirectory, "vectorize-proof-report.json", vectorReport);
        await manifest(vectorDirectory, "evidence.sha256", ["vectorize-proof-report.json"]);
        await expect(admitReleaseEvidence(input(weakenedVector.directories))).rejects.toThrow(
            "live SDK transport evidence is invalid"
        );

        const weakenedMovement = await releaseFixture();
        const movementDirectory = weakenedMovement.directories["cloudflare-file-reshard"];
        const pair = JSON.parse(await readFile(path.join(movementDirectory, "paired.json"), "utf8"));
        pair.runs[0].local.movement.vectors.physicalIdsAfter[0] = "replacement-physical-id";
        await json(movementDirectory, "paired.json", pair);
        await refreshManifest(movementDirectory, "evidence.sha256");
        await expect(admitReleaseEvidence(input(weakenedMovement.directories))).rejects.toThrow(
            "vector physical IDs changed"
        );
    });

    test("rejects a tarball whose internal package version contradicts its checksummed gate identity", async () => {
        const fixture = await releaseFixture();
        const preview = fixture.directories.preview;
        const tarball = tarballForPackage("@chardb/core", "0.2.0");
        await writeFile(path.join(preview, "chardb-core-0.1.0.tgz"), tarball);
        const reportPath = path.join(preview, "preview-gate.json");
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        const fingerprint = { algorithm: "sha256", digest: sha256(tarball), bytes: tarball.byteLength };
        report.package.tarball = fingerprint;
        for (const key of ["generatedProject", "packedChat", "packedPublicVector", "browser"]) {
            report[key].package.tarball = fingerprint;
        }
        await json(preview, "generated-project.json", report.generatedProject);
        await json(preview, "packed-chat.json", report.packedChat);
        await json(preview, "packed-public-vector.json", report.packedPublicVector);
        await json(preview, "browser-proof.json", report.browser);
        const packedOrgUser = JSON.parse(await readFile(path.join(preview, "packed-org-user.json"), "utf8"));
        packedOrgUser.package.tarball = fingerprint;
        await json(preview, "packed-org-user.json", packedOrgUser);
        await json(preview, "preview-gate.json", report);
        await writePreviewEvidenceManifest(preview);

        await expect(admitReleaseEvidence(input(fixture.directories))).rejects.toThrow(
            "tarball package name or version differs"
        );
    });

    test("rejects checksum drift, duplicate entries, and symlinked evidence", async () => {
        const drift = await releaseFixture();
        await writeFile(path.join(drift.directories["cloudflare-vectors"], "vectorize-proof-execution.json"), "{}\n");
        await expect(admitReleaseEvidence(input(drift.directories))).rejects.toThrow("checksum does not match");

        const duplicate = await releaseFixture();
        const manifestPath = path.join(duplicate.directories["cloudflare-file-reshard"], "teardown.sha256");
        const line = await readFile(manifestPath, "utf8");
        await writeFile(manifestPath, `${line}${line}`);
        await expect(admitReleaseEvidence(input(duplicate.directories))).rejects.toThrow("duplicate entry");

        const linked = await releaseFixture();
        const vectorDirectory = linked.directories["cloudflare-vectors"];
        const execution = path.join(vectorDirectory, "vectorize-proof-execution.json");
        const target = path.join(linked.root, "outside.json");
        await writeFile(target, await readFile(execution));
        await rm(execution);
        await symlink(target, execution);
        await expect(admitReleaseEvidence(input(linked.directories))).rejects.toThrow("must not traverse symlink");

        const incompleteCleanup = await releaseFixture();
        const cleanupDirectory = incompleteCleanup.directories["cloudflare-file-reshard"];
        const teardownPath = path.join(cleanupDirectory, "teardown.json");
        const teardown = JSON.parse(await readFile(teardownPath, "utf8"));
        teardown.vectorizeIndexAbsentVerified = false;
        await json(cleanupDirectory, "teardown.json", teardown);
        await refreshManifest(cleanupDirectory, "supplemental.sha256");
        await manifest(cleanupDirectory, "teardown.sha256", ["teardown.json"]);
        await expect(admitReleaseEvidence(input(incompleteCleanup.directories))).rejects.toThrow(
            "file reshard proof teardown is incomplete"
        );
    });

    test("rejects stale checksummed entries and files added after the public secret scan", async () => {
        const stale = await releaseFixture();
        const vectorDirectory = stale.directories["cloudflare-vectors"];
        await json(vectorDirectory, "stale.json", { candidate: stale.exact, stale: true });
        await manifest(vectorDirectory, "evidence.sha256", ["vectorize-proof-report.json", "stale.json"]);
        await expect(admitReleaseEvidence(input(stale.directories))).rejects.toThrow(
            "contains unrecognized or missing files"
        );

        const polluted = await releaseFixture();
        await writeFile(
            path.join(polluted.directories["cloudflare-files"], "secrets.env"),
            "CLOUDFLARE_API_TOKEN=should-never-be-published\n"
        );
        await expect(admitReleaseEvidence(input(polluted.directories))).rejects.toThrow(
            "contains unrecognized or missing files"
        );

        const pollutedReshard = await releaseFixture();
        await writeFile(
            path.join(pollutedReshard.directories["cloudflare-file-reshard"], "secrets.env"),
            "CDB_ADMIN_TOKEN=should-never-be-published\n"
        );
        await expect(admitReleaseEvidence(input(pollutedReshard.directories))).rejects.toThrow(
            "contains unrecognized or missing files"
        );

        const substituted = await releaseFixture();
        const validationPath = path.join(substituted.directories["cloudflare-files"], "r2-proof-validation.json");
        const validation = JSON.parse(await readFile(validationPath, "utf8"));
        validation.correctness.candidate.digest = "f".repeat(64);
        await json(substituted.directories["cloudflare-files"], "r2-proof-validation.json", validation);
        await expect(admitReleaseEvidence(input(substituted.directories))).rejects.toThrow(
            "correctness validation identifies a different packed candidate"
        );
    });

    test("rejects missing, duplicate, unknown, and bypassed evidence kinds", async () => {
        expect(() => parseReleaseAdmissionArgs(["--profile", RELEASE_ADMISSION_PROFILE])).toThrow(
            "missing release evidence kinds"
        );
        expect(() =>
            parseReleaseAdmissionArgs([
                "--profile",
                RELEASE_ADMISSION_PROFILE,
                "--evidence",
                "preview=/one",
                "--evidence",
                "preview=/two",
            ])
        ).toThrow("duplicate release evidence kind preview");
        expect(() =>
            parseReleaseAdmissionArgs(["--profile", RELEASE_ADMISSION_PROFILE, "--evidence", "mystery=/tmp/evidence"])
        ).toThrow("unknown release evidence kind");
        await expect(
            admitReleaseEvidence({
                profile: RELEASE_ADMISSION_PROFILE,
                evidence: { preview: "/tmp/preview", mystery: "/tmp/mystery" } as never,
            })
        ).rejects.toThrow("release evidence must contain");

        const fixture = await releaseFixture();
        const args = ["--profile", RELEASE_ADMISSION_PROFILE];
        for (const kind of RELEASE_EVIDENCE_KINDS) args.push("--evidence", `${kind}=${fixture.directories[kind]}`);
        expect(parseReleaseAdmissionArgs(args).evidence["os-ci"]).toBe(fixture.directories["os-ci"]);
        const withoutOsCi = ["--profile", RELEASE_ADMISSION_PROFILE];
        for (const kind of RELEASE_EVIDENCE_KINDS.filter(kind => kind !== "os-ci")) {
            withoutOsCi.push("--evidence", `${kind}=${fixture.directories[kind]}`);
        }
        expect(() => parseReleaseAdmissionArgs(withoutOsCi)).toThrow("missing release evidence kinds: os-ci");
        expect(() =>
            parseReleaseAdmissionArgs([...args, "--output", path.join(fixture.directories.preview, "admission.json")])
        ).toThrow("output must be outside every evidence directory");
        const overlapping = ["--profile", RELEASE_ADMISSION_PROFILE];
        for (const kind of RELEASE_EVIDENCE_KINDS) {
            const directory =
                kind === "os-ci" ? path.join(fixture.directories.preview, "nested-os-ci") : fixture.directories[kind];
            overlapping.push("--evidence", `${kind}=${directory}`);
        }
        expect(() => parseReleaseAdmissionArgs(overlapping)).toThrow(
            "evidence directories must be distinct and non-overlapping"
        );
    });

    test("emits deterministic machine-readable success and useful failure diagnostics", async () => {
        const fixture = await releaseFixture();
        const args = ["--profile", RELEASE_ADMISSION_PROFILE];
        for (const kind of RELEASE_EVIDENCE_KINDS) args.push("--evidence", `${kind}=${fixture.directories[kind]}`);
        args.push("--output", path.join(fixture.root, "admission.json"));
        const stdout: string[] = [];
        const stderr: string[] = [];
        const code = await runReleaseAdmissionCli(
            args,
            { stdout: { write: value => stdout.push(value) }, stderr: { write: value => stderr.push(value) } },
            fixture.root
        );
        expect(code).toBe(0);
        expect(stderr).toEqual([]);
        expect(JSON.parse(stdout.join(""))).toEqual(
            JSON.parse(await readFile(path.join(fixture.root, "admission.json"), "utf8"))
        );

        await writeFile(path.join(fixture.directories["cloudflare-vectors"], "vectorize-proof-execution.json"), "{}\n");
        const staleOut: string[] = [];
        const staleErr: string[] = [];
        expect(
            await runReleaseAdmissionCli(
                args,
                {
                    stdout: { write: value => staleOut.push(value) },
                    stderr: { write: value => staleErr.push(value) },
                },
                fixture.root
            )
        ).toBe(1);
        const invalidated = JSON.parse(await readFile(path.join(fixture.root, "admission.json"), "utf8"));
        expect(invalidated).toMatchObject({ schema: RELEASE_ADMISSION_SCHEMA, ok: false });
        expect(invalidated.error).toContain("checksum does not match");
        expect(JSON.parse(staleOut.join(""))).toEqual(invalidated);
        expect(staleErr.join("")).toContain("release admission failed: execution.sha256 checksum does not match");

        const failedOut: string[] = [];
        const failedErr: string[] = [];
        const failed = await runReleaseAdmissionCli(
            ["--profile", RELEASE_ADMISSION_PROFILE],
            {
                stdout: { write: value => failedOut.push(value) },
                stderr: { write: value => failedErr.push(value) },
            },
            fixture.root
        );
        expect(failed).toBe(1);
        expect(JSON.parse(failedOut.join(""))).toMatchObject({ schema: RELEASE_ADMISSION_SCHEMA, ok: false });
        expect(failedErr.join("")).toContain("release admission failed: missing release evidence kinds");

        const helpOut: string[] = [];
        expect(
            await runReleaseAdmissionCli(["--help"], {
                stdout: { write: value => helpOut.push(value) },
                stderr: { write: () => undefined },
            })
        ).toBe(0);
        expect(helpOut.join("")).toBe(`${releaseAdmissionUsage()}\n`);
    });
});
