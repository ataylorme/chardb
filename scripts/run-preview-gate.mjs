import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { arch, availableParallelism, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { fingerprintFile, writeJsonAtomically } from "./browser-proof-report.mjs";
import { assertMatchingGeneratedProjectReport } from "./generated-project-report.mjs";
import { npmPackFilename } from "./package-identity.mjs";
import { assertMatchingPackedChatReport } from "./packed-chat-report.mjs";
import { assertMatchingPackedOrgUserReport } from "./packed-org-user-report.mjs";
import { assertMatchingPackedPublicVectorReport } from "./packed-public-vector-contract.mjs";
import {
    assertMatchingBrowserReport,
    assertPreviewOutputDirectory,
    buildPreviewGateReport,
    parsePreviewGateArgs,
} from "./preview-gate-report.mjs";
import { run } from "./test-correctness.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STEP_TIMEOUT_MS = 15 * 60_000;
const CORRECTNESS_TIMEOUT_MS = 35 * 60_000;

function usage() {
    return [
        "Usage: bun scripts/run-preview-gate.mjs [options]",
        "",
        "  --output-dir <path>    evidence and exact package tarball output",
        "  --platform-name <name> stable CI or staging runner name",
        "  --help                 show this help",
    ].join("\n");
}

function gitText(args, fallback) {
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() || fallback : fallback;
}

function cleanError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= 4_096 ? message : `${message.slice(0, 4_096)}…`;
}

const options = parsePreviewGateArgs(process.argv.slice(2), ROOT);
if (options.help) {
    console.log(usage());
    process.exit(0);
}

const outputDirectory = path.resolve(options.outputDirectory);
await assertPreviewOutputDirectory(outputDirectory);
const reportPath = path.join(outputDirectory, "preview-gate.json");
const browserPath = path.join(outputDirectory, "browser-proof.json");
const generatedProjectPath = path.join(outputDirectory, "generated-project.json");
const packedChatPath = path.join(outputDirectory, "packed-chat.json");
const packedOrgUserPath = path.join(outputDirectory, "packed-org-user.json");
const packedPublicVectorPath = path.join(outputDirectory, "packed-public-vector.json");
const stagingAppPath = path.join(outputDirectory, "staging-app");
const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const tarballPath = path.join(outputDirectory, npmPackFilename(packageJson.name, packageJson.version));
const scratch = await mkdtemp(path.join(tmpdir(), "chardb-preview-gate-"));
const npmCache = path.join(scratch, "npm-cache");
const startedAt = new Date().toISOString();
const startedAtMs = performance.now();
const steps = [];
let packageEvidence;
let browserEvidence;
let generatedProjectEvidence;
let packedChatEvidence;
let packedPublicVectorEvidence;

const environment = {
    ...process.env,
    npm_config_cache: npmCache,
    CHARDB_GENERATED_NPM_CACHE: npmCache,
    CHARDDB_PACKED_CHAT_NPM_CACHE: npmCache,
    CHARDB_BROWSER_NPM_CACHE: npmCache,
    CDB_GENERATED_E2E_PLATFORM_NAME: options.platformName ?? `${platform()}-${arch()}`,
    CDB_BROWSER_PROOF_REPORT: browserPath,
    CDB_PACKED_CHAT_REPORT: packedChatPath,
    WRANGLER_SEND_METRICS: "false",
};

const source = {
    gitSha: gitText(["rev-parse", "HEAD"], "unknown"),
    gitRef: process.env.GITHUB_REF ?? gitText(["branch", "--show-current"], "unknown"),
    dirty: gitText(["status", "--porcelain"], "").length > 0,
};

const platformEvidence = {
    name: options.platformName ?? `${platform()}-${arch()}`,
    operatingSystem: platform(),
    release: release(),
    architecture: arch(),
    availableParallelism: availableParallelism(),
    bun: Bun.version,
    nodeCompatibility: process.versions.node,
    ci: process.env.CI === "true",
};

async function writeReport() {
    const report = buildPreviewGateReport({
        run: {
            id: `${Date.now().toString(36)}-${process.pid}`,
            startedAt,
            durationMs: performance.now() - startedAtMs,
        },
        source,
        platform: platformEvidence,
        packageEvidence,
        steps,
        browserEvidence,
        generatedProjectEvidence,
        packedChatEvidence,
        packedPublicVectorEvidence,
    });
    await writeJsonAtomically(reportPath, report);
    return report;
}

async function step(name, command, timeoutMs = STEP_TIMEOUT_MS) {
    const stepStartedAt = new Date().toISOString();
    const stepStartedAtMs = performance.now();
    try {
        await run(name, command, timeoutMs, { cwd: ROOT, env: environment, captureOutput: true });
        steps.push({
            name,
            command,
            startedAt: stepStartedAt,
            durationMs: performance.now() - stepStartedAtMs,
            status: "passed",
        });
    } catch (error) {
        steps.push({
            name,
            command,
            startedAt: stepStartedAt,
            durationMs: performance.now() - stepStartedAtMs,
            status: "failed",
            error: cleanError(error),
        });
        await writeReport();
        throw error;
    }
}

async function internalStep(name, command, verify) {
    const stepStartedAt = new Date().toISOString();
    const stepStartedAtMs = performance.now();
    try {
        await verify();
        steps.push({
            name,
            command,
            startedAt: stepStartedAt,
            durationMs: performance.now() - stepStartedAtMs,
            status: "passed",
        });
    } catch (error) {
        steps.push({
            name,
            command,
            startedAt: stepStartedAt,
            durationMs: performance.now() - stepStartedAtMs,
            status: "failed",
            error: cleanError(error),
        });
        await writeReport();
        throw error;
    }
}

try {
    await mkdir(outputDirectory, { recursive: true });
    await internalStep("clean source", ["git", "status", "--porcelain"], async () => {
        if (source.dirty) {
            throw new Error("preview release evidence requires a clean Git worktree");
        }
    });
    await step("candidate secret scan", ["bun", "run", "security:history"]);
    await step("strict TypeScript", ["bunx", "tsc", "--noEmit"]);
    await step("strict Biome", ["bunx", "biome", "check", "."]);
    await step("diff whitespace", ["git", "diff", "--check"]);
    await step("serialized correctness", ["bun", "run", "test:correctness"], CORRECTNESS_TIMEOUT_MS);
    await step("exact npm tarball", ["npm", "pack", "--pack-destination", outputDirectory]);
    packageEvidence = {
        name: packageJson.name,
        version: packageJson.version,
        tarball: await fingerprintFile(tarballPath),
        path: tarballPath,
    };
    await step("prepare staging dogfood app", [
        "bun",
        "scripts/prepare-preview-chat.mjs",
        "--tarball",
        tarballPath,
        "--output",
        stagingAppPath,
        "--name",
        "chardb-preview",
    ]);
    await step("public package boundary", ["bun", "scripts/smoke-packed-package.mjs", tarballPath]);
    await step("packed organization user", [
        "bun",
        "scripts/smoke-packed-org-user.mjs",
        tarballPath,
        "--report",
        packedOrgUserPath,
    ]);
    await internalStep(
        "packed organization user evidence identity",
        ["internal", "verify-packed-org-user"],
        async () => {
            assertMatchingPackedOrgUserReport(
                JSON.parse(await readFile(packedOrgUserPath, "utf8")),
                packageEvidence.tarball
            );
        }
    );
    await step("generated organization app", [
        "bun",
        "scripts/smoke-generated-project.mjs",
        tarballPath,
        "--report",
        generatedProjectPath,
    ]);
    await internalStep("generated evidence identity", ["internal", "verify-generated-evidence"], async () => {
        generatedProjectEvidence = assertMatchingGeneratedProjectReport(
            JSON.parse(await readFile(generatedProjectPath, "utf8")),
            packageEvidence.tarball
        );
    });
    await step("packed organization chat", [
        "bun",
        "scripts/smoke-packed-chat.mjs",
        tarballPath,
        "--report",
        packedChatPath,
    ]);
    await internalStep("packed chat evidence identity", ["internal", "verify-packed-chat-evidence"], async () => {
        packedChatEvidence = assertMatchingPackedChatReport(
            JSON.parse(await readFile(packedChatPath, "utf8")),
            packageEvidence.tarball
        );
    });
    await step("packed public vector browser", [
        "bun",
        "scripts/smoke-packed-public-vector.mjs",
        tarballPath,
        "--report",
        packedPublicVectorPath,
    ]);
    await internalStep(
        "packed public vector evidence identity",
        ["internal", "verify-packed-public-vector-evidence"],
        async () => {
            packedPublicVectorEvidence = assertMatchingPackedPublicVectorReport(
                JSON.parse(await readFile(packedPublicVectorPath, "utf8")),
                packageEvidence.tarball
            );
        }
    );
    await step("packed browser", ["bun", "scripts/smoke-packed-browser.mjs", tarballPath]);
    await internalStep("browser evidence identity", ["internal", "verify-browser-evidence"], async () => {
        browserEvidence = assertMatchingBrowserReport(
            JSON.parse(await readFile(browserPath, "utf8")),
            packageEvidence.tarball
        );
    });
    const report = await writeReport();
    console.log(JSON.stringify({ report: reportPath, package: packageEvidence, summary: report.summary }));
} finally {
    await rm(scratch, { recursive: true, force: true });
}
