import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const BROWSER_PROOF_REPORT_SCHEMA = "chardb.packed-browser-proof.report.v1";
export const BROWSER_PROOF_REQUIRED_INVARIANTS = [
    "generatedAppUnchanged",
    "nativeAnonymousSignIn",
    "nativeOrganizationCreate",
    "nativeOrganizationSwitch",
    "organizationIsolation",
    "liveReplacementObserved",
    "reloadPersistenceObserved",
    "wranglerRestartObserved",
    "betterAuthSessionRestartObserved",
    "noAnonymousResignInAfterRestart",
    "freshBrowserAuthAfterRestartObserved",
    "nativeR2UploadObserved",
    "transactionalFileAttachObserved",
    "authenticatedFileDownloadObserved",
    "fileRestartPersistenceObserved",
    "betterAuthDeletionFenceObserved",
    "fileOrganizationIsolationObserved",
    "fileReplacementObserved",
    "activeOrganizationReshardObserved",
];

export function assertBrowserProofInvariants(invariants) {
    if (invariants === null || typeof invariants !== "object" || Array.isArray(invariants)) {
        throw new Error("browser proof invariants must be an object");
    }
    for (const name of BROWSER_PROOF_REQUIRED_INVARIANTS) {
        if (invariants[name] !== true) throw new Error(`browser proof invariant ${name} did not pass`);
    }
    return invariants;
}

const SHA256 = /^[a-f0-9]{64}$/;

export function assertBrowserRestartEvidence(value, identity, organizations) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("browser proof requires structured restart evidence");
    }
    if (value.schema !== "chardb.browser-restart-evidence.v1") {
        throw new Error("browser restart evidence schema drifted");
    }
    if (value.checkpoint !== "session-read-before-app-navigation") {
        throw new Error("browser restart evidence skipped the pre-navigation checkpoint");
    }
    if (value.pages?.primary !== "about:blank" || value.pages?.live !== "about:blank") {
        throw new Error("browser restart evidence navigated the app before its checkpoint");
    }
    const beforePid = value.process?.beforePid;
    const afterPid = value.process?.afterPid;
    if (
        !Number.isSafeInteger(beforePid) ||
        beforePid <= 0 ||
        !Number.isSafeInteger(afterPid) ||
        afterPid <= 0 ||
        beforePid === afterPid
    ) {
        throw new Error("browser restart evidence requires two distinct dev process ids");
    }
    for (const name of ["worker", "web"]) {
        const before = value.origins?.before?.[name];
        const after = value.origins?.after?.[name];
        let parsed;
        try {
            parsed = new URL(before);
        } catch {
            throw new Error(`browser restart evidence ${name} origin is invalid`);
        }
        if (parsed.origin !== before || after !== before) {
            throw new Error(`browser restart evidence changed the ${name} origin`);
        }
    }
    const beforeSession = value.session?.before;
    const afterSession = value.session?.after;
    if (
        !SHA256.test(beforeSession?.idSha256 ?? "") ||
        afterSession?.idSha256 !== beforeSession.idSha256 ||
        beforeSession?.userId !== identity.userId ||
        afterSession?.userId !== identity.userId ||
        beforeSession?.activeOrganizationId !== organizations.first.id ||
        afterSession?.activeOrganizationId !== organizations.first.id
    ) {
        throw new Error("browser restart evidence did not preserve the exact Better Auth session");
    }
    if (
        !Number.isSafeInteger(value.cookies?.count) ||
        value.cookies.count <= 0 ||
        !SHA256.test(value.cookies?.beforeSha256 ?? "") ||
        value.cookies?.afterSha256 !== value.cookies.beforeSha256
    ) {
        throw new Error("browser restart evidence did not preserve the exact browser cookie jar");
    }
    const signIns = value.anonymousSignIns;
    if (
        !Number.isSafeInteger(signIns?.beforeRestart) ||
        signIns.beforeRestart <= 0 ||
        signIns.afterPreNavigation !== signIns.beforeRestart ||
        signIns.afterAppNavigation !== signIns.beforeRestart ||
        signIns.freshContext !== 1
    ) {
        throw new Error("browser restart evidence detected an unexpected anonymous sign-in");
    }
    const fresh = value.freshContext;
    if (
        !fresh?.userId ||
        fresh.userId === identity.userId ||
        !SHA256.test(fresh?.sessionIdSha256 ?? "") ||
        fresh.sessionIdSha256 === beforeSession.idSha256 ||
        !fresh.activeOrganizationId ||
        fresh.activeOrganizationId === organizations.first.id ||
        fresh.activeOrganizationId === organizations.second.id
    ) {
        throw new Error("browser restart evidence did not prove fresh-context authentication");
    }
    return value;
}

export function buildBrowserProofReport(input) {
    const { first, second } = input.organizations;
    if (!input.identity.userId) throw new Error("browser proof requires a Better Auth user id");
    if (!first.id || !second.id || first.id === second.id) {
        throw new Error("browser proof requires two distinct Better Auth organization ids");
    }
    assertBrowserProofInvariants(input.invariants);
    assertBrowserRestartEvidence(input.restart, input.identity, input.organizations);
    const createCalls = input.betterAuthRoutes.filter(
        route => route.path === "/api/auth/organization/create" && route.method === "POST" && route.status < 400
    );
    const setActiveCalls = input.betterAuthRoutes.filter(
        route => route.path === "/api/auth/organization/set-active" && route.method === "POST" && route.status < 400
    );
    const deleteCalls = input.betterAuthRoutes.filter(
        route => route.path === "/api/auth/organization/delete" && route.method === "POST" && route.status < 400
    );
    if (createCalls.length < 2) throw new Error("browser proof requires two successful Better Auth create calls");
    if (setActiveCalls.length < 2)
        throw new Error("browser proof requires two successful Better Auth set-active calls");
    if (deleteCalls.length < 1) throw new Error("browser proof requires one successful Better Auth delete call");
    return { schema: BROWSER_PROOF_REPORT_SCHEMA, suite: "packed-generated-better-auth-browser", ...input };
}

export function assertBrowserProofReport(report) {
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
        throw new Error("browser proof report must be an object");
    }
    if (report.schema !== BROWSER_PROOF_REPORT_SCHEMA) {
        throw new Error(`browser proof report schema must be ${BROWSER_PROOF_REPORT_SCHEMA}`);
    }
    if (report.suite !== "packed-generated-better-auth-browser") {
        throw new Error("browser proof report suite drifted");
    }
    const { schema: _schema, suite: _suite, ...input } = report;
    const rebuilt = buildBrowserProofReport(input);
    if (!isDeepStrictEqual(report, rebuilt)) throw new Error("browser proof report fields drifted");
    return report;
}

export async function fingerprintFile(file) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const metadata = await stat(file);
    return { algorithm: "sha256", digest: hash.digest("hex"), bytes: metadata.size };
}

export async function writeJsonAtomically(file, value) {
    const absolute = path.resolve(file);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        await rename(temporary, absolute);
    } finally {
        await rm(temporary, { force: true });
    }
    return absolute;
}
