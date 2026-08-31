import { isDeepStrictEqual } from "node:util";

export const PACKED_CHAT_REPORT_SCHEMA = "chardb.packed-chat-proof.report.v1";
export const PACKED_CHAT_RESTART_HANDOFF_SCHEMA = "chardb.packed-chat-restart-handoff.v1";
export const PACKED_CHAT_RESTART_RESULT_SCHEMA = "chardb.packed-chat-restart-result.v1";

export const PACKED_CHAT_INVARIANTS = Object.freeze([
    "packedPackageInstalled",
    "packedReactPackageInstalled",
    "wranglerTomlConsumer",
    "tutorialTypecheckPassed",
    "tutorialBuildPassed",
    "stableRefsInBrowserBundle",
    "nativeAnonymousSignIn",
    "nativeOrganizationCreateAndActivate",
    "nativeInvitationAccepted",
    "twoPrincipalSharedMembership",
    "sameOrganizationLiveReplacement",
    "mutationReplayStable",
    "directReadParity",
    "directLimitRejected",
    "benchmarkProfileCompleted",
    "workerdRestartObserved",
    "sessionPersistenceObserved",
    "dataPersistenceObserved",
    "membershipLeaveRevokedAccess",
    "organizationIsolation",
    "ownerRetainedAccess",
]);

const REQUIRED_AUTH_ROUTES = Object.freeze({
    "/api/auth/sign-in/anonymous": 2,
    "/api/auth/organization/create": 2,
    "/api/auth/organization/set-active": 3,
    "/api/auth/organization/invite-member": 1,
    "/api/auth/organization/accept-invitation": 1,
    "/api/auth/organization/leave": 1,
});

const RUNTIME_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLATFORM_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

function exactKeys(value, label, expected) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    if (!isDeepStrictEqual(actual, [...expected].sort())) {
        throw new Error(`${label} fields drifted`);
    }
}

function assertPlatform(platform) {
    exactKeys(platform, "packed-chat platform", ["operatingSystem", "release", "architecture"]);
    if (
        !["darwin", "linux", "win32"].includes(platform.operatingSystem) ||
        !PLATFORM_VALUE.test(platform.release ?? "") ||
        !PLATFORM_VALUE.test(platform.architecture ?? "")
    ) {
        throw new Error("packed-chat platform provenance is invalid");
    }
}

function assertRuntime(runtime) {
    exactKeys(runtime, "packed-chat runtime", [
        "name",
        "bun",
        "nodeCompatibility",
        "wrangler",
        "miniflare",
        "betterAuth",
    ]);
    if (
        runtime.name !== "packed-chat-miniflare-process-restart" ||
        !RUNTIME_VERSION.test(runtime.bun ?? "") ||
        !RUNTIME_VERSION.test(runtime.nodeCompatibility ?? "") ||
        !RUNTIME_VERSION.test(runtime.wrangler ?? "") ||
        !RUNTIME_VERSION.test(runtime.miniflare ?? "") ||
        runtime.betterAuth !== "1.6.30"
    ) {
        throw new Error("packed-chat runtime provenance is invalid");
    }
}

export function parsePackedChatArgs(argv) {
    let tarball;
    let reactTarball;
    let reportPath;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--report") {
            const value = argv[++index];
            if (!value) throw new Error("--report requires a path");
            if (reportPath !== undefined) throw new Error("--report may be provided only once");
            reportPath = value;
            continue;
        }
        if (argument === "--react") {
            const value = argv[++index];
            if (!value) throw new Error("--react requires a path");
            if (reactTarball !== undefined) throw new Error("--react may be provided only once");
            reactTarball = value;
            continue;
        }
        if (argument.startsWith("-")) throw new Error(`unknown packed-chat smoke argument ${JSON.stringify(argument)}`);
        if (tarball !== undefined) throw new Error("packed-chat smoke accepts one tarball");
        tarball = argument;
    }
    if (tarball === undefined || reactTarball === undefined) {
        throw new Error("usage: bun scripts/smoke-packed-chat.mjs <core.tgz> --react <react.tgz> [--report <path>]");
    }
    return { tarball, reactTarball, reportPath };
}

function assertInvariants(invariants) {
    if (invariants === null || typeof invariants !== "object" || Array.isArray(invariants)) {
        throw new Error("packed-chat evidence invariants must be an object");
    }
    const actual = Object.keys(invariants).sort();
    const expected = [...PACKED_CHAT_INVARIANTS].sort();
    if (!isDeepStrictEqual(actual, expected) || expected.some(name => invariants[name] !== true)) {
        throw new Error("packed-chat evidence is missing a required invariant");
    }
}

function assertIdentity(identity, organizations) {
    if (
        !identity?.ownerUserId ||
        !identity?.memberUserId ||
        identity.ownerUserId === identity.memberUserId ||
        !organizations?.shared?.id ||
        !organizations?.isolated?.id ||
        organizations.shared.id === organizations.isolated.id
    ) {
        throw new Error("packed-chat evidence requires distinct principals and organizations");
    }
}

function assertRoutes(routes) {
    if (!Array.isArray(routes)) throw new Error("packed-chat evidence routes must be an array");
    for (const [path, expectedCalls] of Object.entries(REQUIRED_AUTH_ROUTES)) {
        const successful = routes.filter(
            route => route.method === "POST" && route.path === path && route.status < 400
        ).length;
        if (successful < expectedCalls) {
            throw new Error(`packed-chat evidence requires ${expectedCalls} successful ${path} call(s)`);
        }
    }
}

function assertBenchmark(benchmark) {
    if (
        !benchmark?.profile ||
        benchmark.direct?.type !== "chardb-direct-select-benchmark" ||
        benchmark.live?.type !== "chardb-binding-benchmark" ||
        benchmark.direct?.profile !== benchmark.profile ||
        benchmark.live?.profile !== benchmark.profile ||
        benchmark.direct?.queries < 1 ||
        benchmark.direct?.concurrency < 1 ||
        benchmark.live?.queries < 1 ||
        benchmark.live?.concurrency < 1
    ) {
        throw new Error("packed-chat evidence requires completed direct and live benchmark profiles");
    }
}

function assertFingerprint(fingerprint, label) {
    if (
        fingerprint?.algorithm !== "sha256" ||
        !/^[a-f0-9]{64}$/.test(fingerprint.digest) ||
        !Number.isSafeInteger(fingerprint.bytes) ||
        fingerprint.bytes < 1
    ) {
        throw new Error(`${label} requires an exact SHA-256 tarball fingerprint`);
    }
}

export function buildPackedChatRestartHandoff(input) {
    assertFingerprint(input.tarball, "packed-chat restart handoff");
    if (
        !input.owner?.userId ||
        !input.owner?.cookie ||
        !input.member?.userId ||
        !input.member?.cookie ||
        input.owner.userId === input.member.userId ||
        !input.sharedOrganization?.id ||
        !input.sharedOrganization?.slug ||
        !Number.isSafeInteger(input.producerPid) ||
        input.producerPid < 1 ||
        !Number.isSafeInteger(input.expectedRows) ||
        input.expectedRows < 1 ||
        !Array.isArray(input.expectedRowIds) ||
        input.expectedRowIds.length !== input.expectedRows ||
        new Set(input.expectedRowIds).size !== input.expectedRows ||
        input.expectedRowIds.some(id => typeof id !== "string" || id.length === 0)
    ) {
        throw new Error("packed-chat restart handoff is incomplete");
    }
    assertBenchmark(input.benchmark);
    return {
        schema: PACKED_CHAT_RESTART_HANDOFF_SCHEMA,
        tarball: { ...input.tarball },
        owner: { userId: input.owner.userId, cookie: input.owner.cookie },
        member: { userId: input.member.userId, cookie: input.member.cookie },
        sharedOrganization: { ...input.sharedOrganization },
        producerPid: input.producerPid,
        expectedRows: input.expectedRows,
        expectedRowIds: [...input.expectedRowIds],
        betterAuthRoutes: input.betterAuthRoutes.map(route => ({ ...route })),
        benchmark: structuredClone(input.benchmark),
    };
}

export function assertPackedChatRestartHandoff(value, fingerprint) {
    if (value?.schema !== PACKED_CHAT_RESTART_HANDOFF_SCHEMA) {
        throw new Error(`packed-chat restart handoff schema must be ${PACKED_CHAT_RESTART_HANDOFF_SCHEMA}`);
    }
    if (!isDeepStrictEqual(value.tarball, fingerprint)) {
        throw new Error("packed-chat restart handoff does not identify the preview tarball");
    }
    return buildPackedChatRestartHandoff(value);
}

export function buildPackedChatRestartResult(input) {
    assertFingerprint(input.tarball, "packed-chat restart result");
    assertIdentity(input.identity, input.organizations);
    if (!Array.isArray(input.betterAuthRoutes)) throw new Error("packed-chat restart result requires auth routes");
    for (const [name, passed] of Object.entries(input.invariants)) {
        if (passed !== true) throw new Error(`packed-chat restart invariant ${name} did not pass`);
    }
    const result = {
        schema: PACKED_CHAT_RESTART_RESULT_SCHEMA,
        tarball: { ...input.tarball },
        identity: { ...input.identity },
        organizations: {
            shared: { ...input.organizations.shared },
            isolated: { ...input.organizations.isolated },
        },
        betterAuthRoutes: input.betterAuthRoutes.map(route => ({ ...route })),
        invariants: { ...input.invariants },
    };
    const serialized = JSON.stringify(result);
    if (/"(?:cookie|token|jwt)"\s*:/i.test(serialized)) {
        throw new Error("packed-chat restart result contains authentication secrets");
    }
    return result;
}

export function assertPackedChatRestartResult(value, fingerprint) {
    if (value?.schema !== PACKED_CHAT_RESTART_RESULT_SCHEMA) {
        throw new Error(`packed-chat restart result schema must be ${PACKED_CHAT_RESTART_RESULT_SCHEMA}`);
    }
    if (!isDeepStrictEqual(value.tarball, fingerprint)) {
        throw new Error("packed-chat restart result does not identify the preview tarball");
    }
    return buildPackedChatRestartResult(value);
}

export function buildPackedChatReport(input) {
    assertPlatform(input.platform);
    assertRuntime(input.runtime);
    assertIdentity(input.identity, input.organizations);
    assertRoutes(input.betterAuthRoutes);
    assertBenchmark(input.benchmark);
    assertInvariants(input.invariants);
    return {
        schema: PACKED_CHAT_REPORT_SCHEMA,
        suite: "packed-better-auth-organization-chat",
        run: { ...input.run },
        package: {
            name: input.packageEvidence.name,
            version: input.packageEvidence.version,
            tarball: { ...input.packageEvidence.tarball },
        },
        reactPackage: {
            name: input.reactPackageEvidence.name,
            version: input.reactPackageEvidence.version,
            tarball: { ...input.reactPackageEvidence.tarball },
        },
        platform: { ...input.platform },
        runtime: { ...input.runtime },
        identity: { ...input.identity },
        organizations: {
            shared: { ...input.organizations.shared },
            isolated: { ...input.organizations.isolated },
        },
        betterAuthRoutes: input.betterAuthRoutes.map(route => ({ ...route })),
        benchmark: {
            profile: input.benchmark.profile,
            direct: structuredClone(input.benchmark.direct),
            live: structuredClone(input.benchmark.live),
        },
        invariants: { ...input.invariants },
    };
}

export function assertMatchingPackedChatReport(report, fingerprint, reactFingerprint) {
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
        throw new Error("packed-chat evidence must be an object");
    }
    if (report.schema !== PACKED_CHAT_REPORT_SCHEMA || report.suite !== "packed-better-auth-organization-chat") {
        throw new Error(`packed-chat evidence schema must be ${PACKED_CHAT_REPORT_SCHEMA}`);
    }
    if (!isDeepStrictEqual(report.package?.tarball, fingerprint)) {
        throw new Error("packed-chat evidence does not identify the preview tarball");
    }
    if (
        report.reactPackage?.name !== "@chardb/react" ||
        (reactFingerprint !== undefined && !isDeepStrictEqual(report.reactPackage?.tarball, reactFingerprint))
    ) {
        throw new Error("packed-chat evidence does not identify the preview React tarball");
    }
    assertPlatform(report.platform);
    assertRuntime(report.runtime);
    assertIdentity(report.identity, report.organizations);
    assertRoutes(report.betterAuthRoutes);
    assertBenchmark(report.benchmark);
    assertInvariants(report.invariants);
    return report;
}
