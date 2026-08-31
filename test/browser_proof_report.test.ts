import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BROWSER_PROOF_REPORT_SCHEMA,
    assertBrowserProofReport,
    buildBrowserProofReport,
    writeJsonAtomically,
} from "../scripts/browser-proof-report.mjs";

const temporaryDirectories: string[] = [];
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function proof(overrides: Record<string, unknown> = {}) {
    return {
        run: { id: "run-1", startedAt: "2026-08-26T00:00:00.000Z" },
        package: { name: "@chardb/core", version: "0.1.0" },
        platform: { operatingSystem: "test" },
        runtime: { name: "wrangler" },
        identity: { userId: "user-1" },
        organizations: {
            first: { id: "org-1", slug: "alpha" },
            second: { id: "org-2", slug: "beta" },
        },
        betterAuthRoutes: [
            { method: "POST", path: "/api/auth/organization/create", status: 200 },
            { method: "POST", path: "/api/auth/organization/create", status: 200 },
            { method: "POST", path: "/api/auth/organization/set-active", status: 200 },
            { method: "POST", path: "/api/auth/organization/set-active", status: 200 },
            { method: "POST", path: "/api/auth/organization/delete", status: 200 },
        ],
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
                before: { idSha256: HASH_A, userId: "user-1", activeOrganizationId: "org-1" },
                after: { idSha256: HASH_A, userId: "user-1", activeOrganizationId: "org-1" },
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
        invariants: {
            generatedAppUnchanged: true,
            nativeAnonymousSignIn: true,
            nativeOrganizationCreate: true,
            nativeOrganizationSwitch: true,
            organizationIsolation: true,
            liveReplacementObserved: true,
            reloadPersistenceObserved: true,
            wranglerRestartObserved: true,
            betterAuthSessionRestartObserved: true,
            noAnonymousResignInAfterRestart: true,
            freshBrowserAuthAfterRestartObserved: true,
            nativeR2UploadObserved: true,
            transactionalFileAttachObserved: true,
            authenticatedFileDownloadObserved: true,
            fileRestartPersistenceObserved: true,
            betterAuthDeletionFenceObserved: true,
            fileOrganizationIsolationObserved: true,
            fileReplacementObserved: true,
            activeOrganizationReshardObserved: true,
        },
        ...overrides,
    };
}

describe("packed generated browser proof reports", () => {
    test("records correctness evidence without benchmark timing summaries", () => {
        const report = buildBrowserProofReport(proof());
        expect(report.schema).toBe(BROWSER_PROOF_REPORT_SCHEMA);
        expect(report.suite).toBe("packed-generated-better-auth-browser");
        expect(assertBrowserProofReport(report)).toBe(report);
        expect(report).not.toHaveProperty("measurement");
    });

    test("rejects a wrong suite and producer-only Better Auth route tampering", () => {
        const report = buildBrowserProofReport(proof());
        expect(() => assertBrowserProofReport({ ...report, suite: "forged-browser-suite" })).toThrow("suite");
        expect(() => assertBrowserProofReport({ ...report, betterAuthRoutes: [] })).toThrow("create calls");
        expect(() =>
            assertBrowserProofReport({
                ...report,
                betterAuthRoutes: report.betterAuthRoutes.filter(
                    route => route.path !== "/api/auth/organization/delete"
                ),
            })
        ).toThrow("delete call");
    });

    test("rejects incomplete Better Auth and tenancy evidence", () => {
        expect(() => buildBrowserProofReport(proof({ identity: { userId: "" } }))).toThrow("user id");
        expect(() =>
            buildBrowserProofReport(
                proof({
                    organizations: {
                        first: { id: "org-1", slug: "alpha" },
                        second: { id: "org-1", slug: "beta" },
                    },
                })
            )
        ).toThrow("distinct");
        expect(() => buildBrowserProofReport(proof({ invariants: { generatedAppUnchanged: false } }))).toThrow(
            "generatedAppUnchanged"
        );
        expect(() => buildBrowserProofReport(proof({ betterAuthRoutes: [] }))).toThrow("create calls");
    });

    test("rejects restart evidence produced by a fresh or changed session", () => {
        const baseline = proof();
        expect(() =>
            buildBrowserProofReport({
                ...baseline,
                restart: {
                    ...baseline.restart,
                    session: {
                        ...baseline.restart.session,
                        after: { ...baseline.restart.session.after, idSha256: "d".repeat(64) },
                    },
                },
            })
        ).toThrow("exact Better Auth session");
        expect(() =>
            buildBrowserProofReport({
                ...baseline,
                restart: {
                    ...baseline.restart,
                    cookies: { ...baseline.restart.cookies, afterSha256: "d".repeat(64) },
                },
            })
        ).toThrow("exact browser cookie jar");
        expect(() =>
            buildBrowserProofReport({
                ...baseline,
                restart: {
                    ...baseline.restart,
                    freshContext: { ...baseline.restart.freshContext, userId: "user-1" },
                },
            })
        ).toThrow("fresh-context authentication");
    });

    test("rejects hidden sign-in, changed origin, reused process, and skipped checkpoint evidence", () => {
        const baseline = proof();
        expect(() =>
            buildBrowserProofReport({
                ...baseline,
                restart: {
                    ...baseline.restart,
                    anonymousSignIns: { ...baseline.restart.anonymousSignIns, afterAppNavigation: 2 },
                },
            })
        ).toThrow("unexpected anonymous sign-in");
        expect(() =>
            buildBrowserProofReport({
                ...baseline,
                restart: {
                    ...baseline.restart,
                    origins: {
                        ...baseline.restart.origins,
                        after: { ...baseline.restart.origins.after, web: "http://127.0.0.1:5174" },
                    },
                },
            })
        ).toThrow("changed the web origin");
        expect(() =>
            buildBrowserProofReport({
                ...baseline,
                restart: {
                    ...baseline.restart,
                    process: { beforePid: 101, afterPid: 101 },
                },
            })
        ).toThrow("distinct dev process ids");
        expect(() =>
            buildBrowserProofReport({
                ...baseline,
                restart: {
                    ...baseline.restart,
                    pages: { primary: "http://127.0.0.1:5173/", live: "about:blank" },
                },
            })
        ).toThrow("before its checkpoint");
    });

    test("writes the report atomically", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-browser-proof-report-"));
        temporaryDirectories.push(directory);
        const reportPath = path.join(directory, "nested", "proof.json");
        const report = buildBrowserProofReport(proof());
        await writeJsonAtomically(reportPath, report);
        expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
        expect(await readdir(path.dirname(reportPath))).toEqual(["proof.json"]);
    });

    test("keeps correlated restart evidence while independently cleaning browser and dev processes", async () => {
        const source = await readFile(path.join(import.meta.dir, "..", "scripts", "smoke-packed-browser.mjs"), "utf8");

        expect(source).toContain('schema: "chardb.browser-restart-evidence.v1"');
        expect(source).toContain('checkpoint: "session-read-before-app-navigation"');
        expect(source).toContain("sessionAfterRestart.sessionId === sessionBeforeRestart.sessionId");
        expect(source).toContain("cookiesAfterRestart");
        expect(source).toContain("freshAnonymousSignInRequests === 1");

        expect(source).toContain('label: "packed browser smoke"');
        expect(source).toContain('label: "generated bun run dev"');
        expect(source).toContain('label: "generated app startup output drain"');
        expect(source).toContain('label: "generated app output drain"');
        expect(source).toContain('label: "Chromium close"');
        expect(source).toContain("const cleanupFailures = []");
        expect(source).not.toContain("function processGroupExists");
        expect(source).not.toContain("async function terminate(");
    });
});
