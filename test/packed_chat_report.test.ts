import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    PACKED_CHAT_INVARIANTS,
    assertMatchingPackedChatReport,
    assertPackedChatRestartHandoff,
    assertPackedChatRestartResult,
    buildPackedChatReport,
    buildPackedChatRestartHandoff,
    buildPackedChatRestartResult,
    parsePackedChatArgs,
} from "../scripts/packed-chat-report.mjs";

const fingerprint = { algorithm: "sha256", digest: "abc123", bytes: 42 };
const reactFingerprint = { algorithm: "sha256", digest: "react123", bytes: 24 };
const exactFingerprint = { algorithm: "sha256", digest: "a".repeat(64), bytes: 42 };

function reportInput() {
    return {
        run: { id: "run-1" },
        packageEvidence: { name: "@chardb/core", version: "0.1.0", tarball: fingerprint },
        reactPackageEvidence: { name: "@chardb/react", version: "0.1.0", tarball: reactFingerprint },
        platform: { operatingSystem: "linux", release: "6.11.0", architecture: "x64" },
        runtime: {
            name: "packed-chat-miniflare-process-restart",
            bun: "1.2.22",
            nodeCompatibility: "22.14.0",
            wrangler: "4.125.0",
            miniflare: "4.20260828.0",
            betterAuth: "1.6.30",
        },
        identity: { ownerUserId: "user-owner", memberUserId: "user-member" },
        organizations: { shared: { id: "org-shared" }, isolated: { id: "org-isolated" } },
        betterAuthRoutes: [
            ...Array.from({ length: 2 }, () => "/api/auth/sign-in/anonymous"),
            ...Array.from({ length: 2 }, () => "/api/auth/organization/create"),
            ...Array.from({ length: 3 }, () => "/api/auth/organization/set-active"),
            "/api/auth/organization/invite-member",
            "/api/auth/organization/accept-invitation",
            "/api/auth/organization/leave",
        ].map(path => ({ method: "POST", path, status: 200 })),
        benchmark: {
            profile: "ci-smoke",
            direct: {
                type: "chardb-direct-select-benchmark" as const,
                profile: "ci-smoke",
                queries: 32,
                concurrency: 8,
            },
            live: {
                type: "chardb-binding-benchmark" as const,
                profile: "ci-smoke",
                queries: 4,
                concurrency: 8,
            },
        },
        invariants: Object.fromEntries(PACKED_CHAT_INVARIANTS.map(name => [name, true])),
    };
}

describe("packed-chat evidence", () => {
    test("parses one tarball and an optional report path", () => {
        expect(parsePackedChatArgs(["package.tgz", "--react", "react.tgz"])).toEqual({
            tarball: "package.tgz",
            reactTarball: "react.tgz",
            reportPath: undefined,
        });
        expect(parsePackedChatArgs(["package.tgz", "--react", "react.tgz", "--report", "proof.json"])).toEqual({
            tarball: "package.tgz",
            reactTarball: "react.tgz",
            reportPath: "proof.json",
        });
        expect(() => parsePackedChatArgs([])).toThrow("usage");
        expect(() => parsePackedChatArgs(["a.tgz", "b.tgz", "--react", "react.tgz"])).toThrow("one tarball");
        expect(() => parsePackedChatArgs(["a.tgz", "--unknown"])).toThrow("unknown");
    });

    test("builds and matches exact native organization evidence", () => {
        const report = buildPackedChatReport(reportInput());
        expect(report).toMatchObject({
            schema: "chardb.packed-chat-proof.report.v1",
            suite: "packed-better-auth-organization-chat",
            identity: reportInput().identity,
            organizations: reportInput().organizations,
        });
        expect(assertMatchingPackedChatReport(report, fingerprint, reactFingerprint)).toEqual(report);
    });

    test("rejects missing lifecycle proof and a different tarball", () => {
        expect(() =>
            buildPackedChatReport({
                ...reportInput(),
                invariants: { ...reportInput().invariants, ownerRetainedAccess: false },
            })
        ).toThrow("required invariant");
        expect(() =>
            buildPackedChatReport({
                ...reportInput(),
                betterAuthRoutes: reportInput().betterAuthRoutes.filter(
                    route => route.path !== "/api/auth/organization/accept-invitation"
                ),
            })
        ).toThrow("accept-invitation");
        expect(() =>
            buildPackedChatReport({
                ...reportInput(),
                benchmark: {
                    ...reportInput().benchmark,
                    direct: { ...reportInput().benchmark.direct, profile: "throughput" },
                },
            })
        ).toThrow("benchmark profiles");
        expect(() =>
            buildPackedChatReport({
                ...reportInput(),
                identity: { ownerUserId: "same-user", memberUserId: "same-user" },
            })
        ).toThrow("distinct principals");
        const report = buildPackedChatReport(reportInput());
        expect(() => assertMatchingPackedChatReport(report, { ...fingerprint, bytes: 43 }, reactFingerprint)).toThrow(
            "does not identify"
        );
        expect(() => assertMatchingPackedChatReport(report, fingerprint, { ...reactFingerprint, bytes: 25 })).toThrow(
            "React tarball"
        );
    });

    test("rejects missing or invented runtime provenance", () => {
        expect(() =>
            buildPackedChatReport({
                ...reportInput(),
                runtime: { ...reportInput().runtime, miniflare: undefined },
            })
        ).toThrow("runtime provenance");
        expect(() =>
            buildPackedChatReport({
                ...reportInput(),
                runtime: { ...reportInput().runtime, wrangler: "latest" },
            })
        ).toThrow("runtime provenance");
        expect(() =>
            buildPackedChatReport({
                ...reportInput(),
                platform: { ...reportInput().platform, operatingSystem: "test" },
            })
        ).toThrow("platform provenance");

        const reportWithoutRuntime = Object.fromEntries(
            Object.entries(buildPackedChatReport(reportInput())).filter(([key]) => key !== "runtime")
        );
        expect(() => assertMatchingPackedChatReport(reportWithoutRuntime, fingerprint, reactFingerprint)).toThrow(
            "runtime"
        );
    });

    test("hands private session state to another process and emits a secret-free restart result", () => {
        const handoff = buildPackedChatRestartHandoff({
            tarball: exactFingerprint,
            producerPid: 101,
            owner: { userId: "owner", cookie: "owner-session=private-owner" },
            member: { userId: "member", cookie: "member-session=private-member" },
            sharedOrganization: { id: "shared", slug: "shared" },
            expectedRows: 2,
            expectedRowIds: ["row-2", "row-1"],
            betterAuthRoutes: [],
            benchmark: reportInput().benchmark,
        });
        expect(assertPackedChatRestartHandoff(handoff, exactFingerprint)).toEqual(handoff);
        expect(() => assertPackedChatRestartHandoff(handoff, { ...exactFingerprint, bytes: 43 })).toThrow(
            "does not identify"
        );

        const result = buildPackedChatRestartResult({
            tarball: exactFingerprint,
            identity: { ownerUserId: "owner", memberUserId: "member" },
            organizations: { shared: { id: "shared" }, isolated: { id: "isolated" } },
            betterAuthRoutes: [{ method: "POST", path: "/api/auth/organization/leave", status: 200 }],
            invariants: { distinctProcessReconstruction: true, exactRowsObserved: true },
        });
        expect(assertPackedChatRestartResult(result, exactFingerprint)).toEqual(result);
        expect(JSON.stringify(result)).not.toContain("private-owner");
        expect(JSON.stringify(result)).not.toContain("private-member");
        expect(JSON.stringify(result)).not.toMatch(/"(?:cookie|token|jwt)"\s*:/i);
    });

    test("rejects incomplete exact-row handoff state and secret-shaped result fields", () => {
        expect(() =>
            buildPackedChatRestartHandoff({
                tarball: exactFingerprint,
                producerPid: 101,
                owner: { userId: "owner", cookie: "owner-session=private-owner" },
                member: { userId: "member", cookie: "member-session=private-member" },
                sharedOrganization: { id: "shared", slug: "shared" },
                expectedRows: 2,
                expectedRowIds: ["row-1"],
                betterAuthRoutes: [],
                benchmark: reportInput().benchmark,
            })
        ).toThrow("incomplete");
        expect(() =>
            buildPackedChatRestartResult({
                tarball: exactFingerprint,
                identity: { ownerUserId: "owner", memberUserId: "member" },
                organizations: { shared: { id: "shared" }, isolated: { id: "isolated" } },
                betterAuthRoutes: [],
                invariants: { cookie: true },
            })
        ).toThrow("authentication secrets");
    });

    test("runs restart reconstruction in two isolated child phases", async () => {
        const source = await readFile(join(import.meta.dir, "..", "scripts", "smoke-packed-chat.mjs"), "utf8");
        expect(source).toContain('runIsolatedPhase("before-restart"');
        expect(source).toContain('runIsolatedPhase("after-restart"');
        expect(source).toContain("runManagedCommand(process.execPath");
        expect(source).toContain("timeoutMs: PHASE_TIMEOUT_MS");
        expect(source).toContain('label: "packed migration"');
        expect(source).toContain("captureOutput: true");
        expect(source).not.toContain("terminateRemainingProcessGroup");
        expect(source).not.toContain("processGroupExists");
        expect(source).not.toContain("Bun.spawn(");
        expect(source).not.toContain("restartMiniflareBounded");
        expect(source).not.toContain(".setOptions(");
    });
});
