import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BROWSER_PROOF_REQUIRED_INVARIANTS } from "../scripts/browser-proof-report.mjs";
import {
    REQUIRED_PREVIEW_STEPS,
    assertMatchingBrowserReport,
    assertPreviewOutputDirectory,
    buildPreviewGateReport,
    parsePreviewGateArgs,
} from "../scripts/preview-gate-report.mjs";

const fingerprint = { algorithm: "sha256", digest: "abc123", bytes: 42 };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function browserReport() {
    return {
        schema: "chardb.packed-browser-proof.report.v1",
        suite: "packed-generated-better-auth-browser",
        package: { tarball: fingerprint },
        identity: { userId: "user-1" },
        organizations: { first: { id: "org-a" }, second: { id: "org-b" } },
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
                before: { idSha256: HASH_A, userId: "user-1", activeOrganizationId: "org-a" },
                after: { idSha256: HASH_A, userId: "user-1", activeOrganizationId: "org-a" },
            },
            cookies: { count: 1, beforeSha256: HASH_B, afterSha256: HASH_B },
            anonymousSignIns: {
                beforeRestart: 1,
                afterPreNavigation: 1,
                afterAppNavigation: 1,
                freshContext: 1,
            },
            freshContext: {
                userId: "user-fresh",
                sessionIdSha256: "c".repeat(64),
                activeOrganizationId: "org-fresh",
            },
        },
        invariants: Object.fromEntries(BROWSER_PROOF_REQUIRED_INVARIANTS.map(name => [name, true])),
        betterAuthRoutes: [
            { method: "POST", path: "/api/auth/organization/create", status: 200 },
            { method: "POST", path: "/api/auth/organization/create", status: 200 },
            { method: "POST", path: "/api/auth/organization/set-active", status: 200 },
            { method: "POST", path: "/api/auth/organization/set-active", status: 200 },
            { method: "POST", path: "/api/auth/organization/delete", status: 200 },
        ],
    };
}

describe("preview release gate evidence", () => {
    test("excludes interrupted Workerd build products from a candidate snapshot", async () => {
        const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
        expect(gitignore).toContain("test/workerd/.test-*.bundle.mjs");
    });

    test("requires a candidate secret scan before compilation or packaging", () => {
        expect(REQUIRED_PREVIEW_STEPS.slice(0, 4)).toEqual([
            "clean source",
            "candidate secret scan",
            "strict TypeScript",
            "strict Biome",
        ]);
        expect(REQUIRED_PREVIEW_STEPS.indexOf("candidate secret scan")).toBeLessThan(
            REQUIRED_PREVIEW_STEPS.indexOf("exact npm tarball")
        );
    });

    test("parses a bounded output and platform identity", () => {
        expect(parsePreviewGateArgs([], "/workspace")).toEqual({
            help: false,
            outputDirectory: "/workspace/artifacts/preview",
            platformName: undefined,
        });
        expect(parsePreviewGateArgs(["--output-dir", "proof", "--platform-name", "github-ubuntu-arm64"])).toEqual({
            help: false,
            outputDirectory: "proof",
            platformName: "github-ubuntu-arm64",
        });
        expect(() => parsePreviewGateArgs(["--platform-name", "not a runner"])).toThrow("--platform-name");
        expect(() => parsePreviewGateArgs(["--unknown"])).toThrow("Unknown preview gate argument");
    });

    test("accepts only an absent or empty evidence directory", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-preview-output-"));
        await expect(assertPreviewOutputDirectory(path.join(directory, "absent"))).resolves.toBeUndefined();
        const empty = path.join(directory, "empty");
        await mkdir(empty);
        await expect(assertPreviewOutputDirectory(empty)).resolves.toBeUndefined();
        await writeFile(path.join(empty, "stale.json"), "{}\n");
        await expect(assertPreviewOutputDirectory(empty)).rejects.toThrow("must be empty");
    });

    test("requires native Better Auth browser evidence from the exact tarball", () => {
        expect(assertMatchingBrowserReport(browserReport(), fingerprint)).toEqual(browserReport());
        expect(() =>
            assertMatchingBrowserReport(
                { ...browserReport(), package: { tarball: { ...fingerprint, bytes: 43 } } },
                fingerprint
            )
        ).toThrow("does not identify");
        expect(() =>
            assertMatchingBrowserReport(
                { ...browserReport(), invariants: { ...browserReport().invariants, nativeOrganizationSwitch: false } },
                fingerprint
            )
        ).toThrow("nativeOrganizationSwitch");
        expect(() =>
            assertMatchingBrowserReport(
                {
                    ...browserReport(),
                    restart: {
                        ...browserReport().restart,
                        anonymousSignIns: {
                            ...browserReport().restart.anonymousSignIns,
                            afterAppNavigation: 2,
                        },
                    },
                },
                fingerprint
            )
        ).toThrow("unexpected anonymous sign-in");
    });

    test("rejects every file and reshard browser invariant omitted by the old preview validator", () => {
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
            const report = browserReport();
            expect(() =>
                assertMatchingBrowserReport(
                    { ...report, invariants: { ...report.invariants, [name]: false } },
                    fingerprint
                )
            ).toThrow(name);
        }
    });

    test("uses the full producer contract for suite and Better Auth route evidence", () => {
        const report = browserReport();
        expect(() => assertMatchingBrowserReport({ ...report, suite: "forged-browser-suite" }, fingerprint)).toThrow(
            "suite"
        );
        expect(() => assertMatchingBrowserReport({ ...report, betterAuthRoutes: [] }, fingerprint)).toThrow(
            "create calls"
        );
    });

    test("records an exact failed step without claiming the gate passed", () => {
        const report = buildPreviewGateReport({
            run: { id: "run-1" },
            source: { gitSha: "sha-1", dirty: false },
            platform: { name: "linux-x64" },
            packageEvidence: { tarball: fingerprint },
            generatedProjectEvidence: { schema: "chardb.generated-project.report.v1" },
            packedChatEvidence: { schema: "chardb.packed-chat-proof.report.v1" },
            packedPublicVectorEvidence: { schema: "chardb.packed-public-vector-browser.v1" },
            steps: [
                {
                    name: "typecheck",
                    command: ["bunx", "tsc", "--noEmit"],
                    startedAt: "2026-08-26T00:00:00.000Z",
                    durationMs: 10,
                    status: "passed",
                },
                {
                    name: "browser",
                    command: ["bun", "browser.mjs"],
                    startedAt: "2026-08-26T00:00:01.000Z",
                    durationMs: 20,
                    status: "failed",
                    error: "browser failed",
                },
            ],
        });
        expect(report).toMatchObject({
            schema: "chardb.preview-gate.report.v1",
            generatedProject: { schema: "chardb.generated-project.report.v1" },
            packedChat: { schema: "chardb.packed-chat-proof.report.v1" },
            summary: { passed: false, completedSteps: 1, failedStep: "browser" },
        });
    });

    test("never calls dirty-worktree evidence a passing release candidate", () => {
        const report = buildPreviewGateReport({
            run: { id: "run-dirty" },
            source: { gitSha: "sha-1", dirty: true },
            platform: { name: "linux-x64" },
            packageEvidence: { tarball: fingerprint },
            steps: [
                {
                    name: "typecheck",
                    command: ["bunx", "tsc", "--noEmit"],
                    startedAt: "2026-08-26T00:00:00.000Z",
                    durationMs: 10,
                    status: "passed",
                },
            ],
        });
        expect(report).toMatchObject({
            summary: { passed: false, completedSteps: 1, failedStep: "clean source" },
        });
    });

    test("passes only with the exact step set and every evidence object", () => {
        const completeInput = {
            run: { id: "run-complete" },
            source: { gitSha: "sha-1", dirty: false },
            platform: { name: "linux-x64" },
            packageEvidence: { tarball: fingerprint },
            generatedProjectEvidence: { schema: "chardb.generated-project.report.v1" },
            packedChatEvidence: { schema: "chardb.packed-chat-proof.report.v1" },
            packedPublicVectorEvidence: { schema: "chardb.packed-public-vector-browser.v1" },
            browserEvidence: browserReport(),
            steps: REQUIRED_PREVIEW_STEPS.map((name, index) => ({
                name,
                command: ["step", String(index)],
                startedAt: "2026-08-26T00:00:00.000Z",
                durationMs: 1,
                status: "passed" as const,
            })),
        };

        expect(buildPreviewGateReport(completeInput)).toMatchObject({
            summary: { passed: true, completedSteps: REQUIRED_PREVIEW_STEPS.length, failedStep: null },
        });
        expect(buildPreviewGateReport({ ...completeInput, steps: completeInput.steps.slice(0, -1) })).toMatchObject({
            summary: { passed: false, failedStep: "browser evidence identity" },
        });
        expect(buildPreviewGateReport({ ...completeInput, packedChatEvidence: undefined })).toMatchObject({
            summary: { passed: false, failedStep: "packed chat evidence" },
        });
        expect(buildPreviewGateReport({ ...completeInput, packedPublicVectorEvidence: undefined })).toMatchObject({
            summary: { passed: false, failedStep: "packed public vector evidence" },
        });
    });
});
