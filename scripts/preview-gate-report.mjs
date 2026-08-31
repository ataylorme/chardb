import { readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { assertBrowserProofReport } from "./browser-proof-report.mjs";
import { assertMatchingGeneratedProjectReport } from "./generated-project-report.mjs";
import { CHARDB_PACKAGE_NAME } from "./package-identity.mjs";
import { assertMatchingPackedChatReport } from "./packed-chat-report.mjs";
import { assertMatchingPackedPublicVectorReport } from "./packed-public-vector-contract.mjs";

export const PREVIEW_GATE_SCHEMA = "chardb.preview-gate.report.v1";
export const PREVIEW_GATE_BROWSER_SCHEMA = "chardb.packed-browser-proof.report.v1";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const REQUIRED_PREVIEW_STEPS = Object.freeze([
    "clean source",
    "candidate secret scan",
    "strict TypeScript",
    "strict Biome",
    "diff whitespace",
    "serialized correctness",
    "exact npm tarball",
    "prepare staging dogfood app",
    "public package boundary",
    "packed organization user",
    "packed organization user evidence identity",
    "generated organization app",
    "generated evidence identity",
    "packed organization chat",
    "packed chat evidence identity",
    "packed public vector browser",
    "packed public vector evidence identity",
    "packed browser",
    "browser evidence identity",
]);

export async function assertPreviewOutputDirectory(directory) {
    let entries;
    try {
        entries = await readdir(directory);
    } catch (error) {
        if (error?.code === "ENOENT") return;
        throw new Error("preview gate output must be an absent or empty directory", { cause: error });
    }
    if (entries.length > 0) throw new Error("preview gate output directory must be empty");
}

export function parsePreviewGateArgs(argv, cwd = process.cwd()) {
    let outputDirectory;
    let platformName;
    let help = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument !== "--output-dir" && argument !== "--platform-name") {
            throw new Error(`Unknown preview gate argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
        if (argument === "--output-dir") outputDirectory = value;
        else platformName = value;
    }
    const resolvedOutput = outputDirectory ?? `${cwd}/artifacts/preview`;
    if (platformName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(platformName)) {
        throw new Error("--platform-name must contain only letters, digits, dot, underscore, and hyphen");
    }
    return { help, outputDirectory: resolvedOutput, platformName };
}

export function assertMatchingBrowserReport(browser, fingerprint) {
    assertBrowserProofReport(browser);
    if (!isDeepStrictEqual(browser.package?.tarball, fingerprint)) {
        throw new Error("browser evidence does not identify the preview tarball");
    }
    return browser;
}

export function assertPassingPreviewGateReport(report, expectedFingerprint = report?.package?.tarball) {
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
        throw new Error("preview gate report must be an object");
    }
    if (report.schema !== PREVIEW_GATE_SCHEMA || report.suite !== "organization-preview-release-gate") {
        throw new Error("preview gate report schema or suite drifted");
    }
    if (report.summary?.passed !== true) throw new Error("preview gate did not pass");
    if (report.source?.dirty !== false) throw new Error("preview gate requires a clean source tree");
    if (report.package?.name !== CHARDB_PACKAGE_NAME || !VERSION.test(report.package?.version ?? "")) {
        throw new Error("preview gate package identity is invalid");
    }
    const fingerprint = report.package?.tarball;
    if (
        fingerprint?.algorithm !== "sha256" ||
        !SHA256.test(fingerprint?.digest ?? "") ||
        !Number.isSafeInteger(fingerprint?.bytes) ||
        fingerprint.bytes <= 0
    ) {
        throw new Error("preview gate report has no valid tarball fingerprint");
    }
    if (!isDeepStrictEqual(fingerprint, expectedFingerprint)) {
        throw new Error("preview gate report identifies a different candidate tarball");
    }
    if (
        !Array.isArray(report.steps) ||
        !isDeepStrictEqual(
            report.steps.map(step => step.name),
            REQUIRED_PREVIEW_STEPS
        ) ||
        report.steps.some(step => step.status !== "passed")
    ) {
        throw new Error("preview gate does not contain the exact passing release step set");
    }
    if (report.summary.completedSteps !== REQUIRED_PREVIEW_STEPS.length || report.summary.failedStep !== null) {
        throw new Error("preview gate passing summary is inconsistent with its steps");
    }
    assertMatchingGeneratedProjectReport(report.generatedProject, fingerprint);
    assertMatchingPackedChatReport(report.packedChat, fingerprint);
    assertMatchingPackedPublicVectorReport(report.packedPublicVector, fingerprint);
    assertMatchingBrowserReport(report.browser, fingerprint);
    return report;
}

export function buildPreviewGateReport(input) {
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
        throw new Error("preview gate report requires steps");
    }
    const failed = input.steps.find(step => step.status === "failed");
    const incomplete = input.steps.find(step => step.status !== "passed" && step.status !== "failed");
    if (incomplete) throw new Error(`preview gate step ${incomplete.name} has an invalid status`);
    const dirtySource = input.source?.dirty === true;
    const stepNames = input.steps.map(step => step.name);
    const exactSteps = isDeepStrictEqual(stepNames, REQUIRED_PREVIEW_STEPS);
    const missingStep = REQUIRED_PREVIEW_STEPS.find(name => !stepNames.includes(name));
    const missingEvidence = [
        ["package evidence", input.packageEvidence],
        ["generated evidence", input.generatedProjectEvidence],
        ["packed chat evidence", input.packedChatEvidence],
        ["packed public vector evidence", input.packedPublicVectorEvidence],
        ["browser evidence", input.browserEvidence],
    ].find(([, evidence]) => evidence === undefined || evidence === null)?.[0];
    return {
        schema: PREVIEW_GATE_SCHEMA,
        suite: "organization-preview-release-gate",
        run: { ...input.run },
        source: { ...input.source },
        platform: { ...input.platform },
        package: input.packageEvidence ?? null,
        steps: input.steps.map(step => ({ ...step, command: [...step.command] })),
        generatedProject: input.generatedProjectEvidence ?? null,
        packedChat: input.packedChatEvidence ?? null,
        packedPublicVector: input.packedPublicVectorEvidence ?? null,
        browser: input.browserEvidence ?? null,
        summary: {
            passed: failed === undefined && !dirtySource && exactSteps && missingEvidence === undefined,
            completedSteps: input.steps.filter(step => step.status === "passed").length,
            failedStep:
                failed?.name ??
                (dirtySource
                    ? "clean source"
                    : (missingStep ?? (!exactSteps ? "preview step set" : (missingEvidence ?? null)))),
        },
    };
}
