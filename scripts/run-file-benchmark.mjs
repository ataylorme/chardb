import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareFileBenchmarkReports } from "./compare-file-benchmark.mjs";
import {
    FILE_BENCHMARK_PROFILE,
    FILE_BENCHMARK_WORKLOAD_ID,
    FILE_BENCHMARK_WORKLOAD_VERSION,
    assertFileBenchmarkReport,
    createFileBenchmarkReport,
    summarizeFileBenchmarkRuns,
} from "./file-benchmark-report.mjs";

export const FILE_BENCHMARK_PAIR_SCHEMA = "chardb.file-benchmark.pair.v1";
export const FILE_BENCHMARK_DEFAULTS = Object.freeze({
    smallBytes: 64 * 1_024,
    largeBytes: 5 * 1_024 * 1_024,
    compatibilityDate: "2026-05-10",
});

const MAX_FILE_BYTES = 25 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 60_000;
const PAIR_INVARIANTS = ["nativeBetterAuth", "organizationIsolation", "exactBytes", "exactDigest", "cleanupComplete"];

function value(argv, flag) {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
}

function loopbackUrl(raw, flag) {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
        throw new Error(`${flag} must be an HTTP loopback URL`);
    }
    return url;
}

function cloudflareUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error("--cloudflare-url must use HTTPS");
    return url;
}

export function parseFileBenchmarkArgs(argv) {
    const valueFlags = new Set([
        "--tarball",
        "--output",
        "--local-url",
        "--cloudflare-url",
        "--local-bucket",
        "--cloudflare-bucket",
        "--cloudflare-deployment-version",
        "--wrangler-version",
        "--compatibility-date",
    ]);
    const allowed = new Set([...valueFlags, "--help", "-h"]);
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument)) throw new Error(`unknown file benchmark argument ${JSON.stringify(argument)}`);
        if (valueFlags.has(argument)) {
            if (seen.has(argument)) throw new Error(`${argument} may be provided only once`);
            seen.add(argument);
            const next = argv[++index];
            if (!next || allowed.has(next)) throw new Error(`${argument} requires a value`);
        }
    }
    const help = argv.includes("--help") || argv.includes("-h");
    if (help) return { help: true };
    const required = [
        "--tarball",
        "--output",
        "--local-url",
        "--cloudflare-url",
        "--local-bucket",
        "--cloudflare-bucket",
        "--cloudflare-deployment-version",
        "--wrangler-version",
    ];
    for (const flag of required) if (!value(argv, flag)) throw new Error(`${flag} is required`);
    const adminToken = process.env.CHARDB_FILE_BENCH_ADMIN_TOKEN;
    const runId = process.env.CHARDB_FILE_BENCH_RUN_ID;
    if (!adminToken || !runId) {
        throw new Error("CHARDB_FILE_BENCH_ADMIN_TOKEN and CHARDB_FILE_BENCH_RUN_ID are required");
    }
    const deploymentVersion = value(argv, "--cloudflare-deployment-version");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(deploymentVersion)) {
        throw new Error("--cloudflare-deployment-version is invalid");
    }
    const compatibilityDate = value(argv, "--compatibility-date") ?? FILE_BENCHMARK_DEFAULTS.compatibilityDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) throw new Error("--compatibility-date is invalid");
    for (const flag of ["--local-bucket", "--cloudflare-bucket", "--wrangler-version"]) {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(value(argv, flag))) throw new Error(`${flag} is invalid`);
    }
    return {
        help: false,
        tarball: path.resolve(value(argv, "--tarball")),
        output: path.resolve(value(argv, "--output")),
        localUrl: loopbackUrl(value(argv, "--local-url"), "--local-url"),
        cloudflareUrl: cloudflareUrl(value(argv, "--cloudflare-url")),
        localBucket: value(argv, "--local-bucket"),
        cloudflareBucket: value(argv, "--cloudflare-bucket"),
        cloudflareDeploymentVersion: deploymentVersion,
        wranglerVersion: value(argv, "--wrangler-version"),
        compatibilityDate,
        adminToken,
        runId,
    };
}

export function alternatingTargetOrder(batchIndex) {
    if (!Number.isSafeInteger(batchIndex) || batchIndex < 0) throw new TypeError("batch index must be non-negative");
    return batchIndex % 2 === 0 ? ["local", "cloudflare"] : ["cloudflare", "local"];
}

export function deterministicFilePayload(size, seed) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new TypeError("invalid payload size");
    if (typeof seed !== "string" || seed.length === 0) throw new TypeError("payload seed must not be empty");
    const prefix = new TextEncoder().encode(`${size}:${seed}`);
    const bytes = new Uint8Array(size);
    for (let index = 0; index < bytes.length; index++) bytes[index] = prefix[index % prefix.length] ^ (index & 255);
    return bytes;
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function exactObjectKeys(value, label, keys) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    check(
        isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()),
        `${label} contains unknown or missing fields`
    );
    return value;
}

export async function runFileBenchmarkUploadHook(onUpload, targetKind, upload) {
    if (targetKind !== "local" && targetKind !== "cloudflare") throw new TypeError("invalid benchmark target kind");
    if (!upload?.organizationId || !upload?.fileId) throw new TypeError("benchmark upload identity is incomplete");
    if (onUpload) await onUpload(targetKind, upload);
}

async function requestBytes(origin, pathname, init = {}) {
    const response = await fetch(new URL(pathname, origin), {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { response, bytes };
}

async function request(origin, pathname, init = {}) {
    const result = await requestBytes(origin, pathname, init);
    let body = null;
    try {
        body = result.bytes.length ? JSON.parse(new TextDecoder().decode(result.bytes)) : null;
    } catch {
        body = null;
    }
    return { ...result, body };
}

function sessionCookies(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")];
    return values
        .filter(Boolean)
        .map(item => item.split(";", 1)[0])
        .join("; ");
}

function mergeCookies(current, headers) {
    const cookies = new Map();
    for (const value of [current, sessionCookies(headers)]) {
        for (const cookie of value.split(/;\s*/)) {
            const separator = cookie.indexOf("=");
            if (separator > 0) cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
        }
    }
    return [...cookies].map(([name, item]) => `${name}=${item}`).join("; ");
}

async function refreshPrincipal(target) {
    const session = await request(target.origin, "/api/auth/get-session", { headers: { cookie: target.cookie } });
    check(session.response.ok && session.body?.user?.id, `${target.kind} Better Auth session refresh failed`);
    target.cookie = mergeCookies(target.cookie, session.response.headers);
    const token = await request(target.origin, "/api/auth/token", { headers: { cookie: target.cookie } });
    check(token.response.ok && typeof token.body?.token === "string", `${target.kind} Better Auth token failed`);
    target.cookie = mergeCookies(target.cookie, token.response.headers);
    target.token = token.body.token;
    target.userId = session.body.user.id;
}

async function authPost(target, route, body) {
    const result = await request(target.origin, `/api/auth${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: target.cookie, origin: target.origin.origin },
        body: JSON.stringify(body),
    });
    check(result.response.ok, `${target.kind} Better Auth ${route} failed with ${result.response.status}`);
    target.cookie = mergeCookies(target.cookie, result.response.headers);
    return result.body;
}

async function initializeTarget(target, candidateSha256, suffix) {
    const health = await request(target.origin, "/health");
    check(health.response.ok && health.body?.releaseSha256 === candidateSha256, `${target.kind} candidate drifted`);
    const signIn = await request(target.origin, "/api/auth/sign-in/anonymous", {
        method: "POST",
        headers: { "content-type": "application/json", origin: target.origin.origin },
        body: "{}",
    });
    check(signIn.response.ok, `${target.kind} anonymous sign-in failed`);
    target.cookie = sessionCookies(signIn.response.headers);
    await refreshPrincipal(target);
    const create = async label => {
        const organization = await authPost(target, "/organization/create", {
            name: `File benchmark ${label}`,
            slug: `file-bench-${target.kind}-${label}-${suffix}`,
            keepCurrentActiveOrganization: true,
        });
        check(typeof organization?.id === "string", `${target.kind} organization creation returned no id`);
        return organization.id;
    };
    target.primaryOrganizationId = await create("primary");
    target.isolatedOrganizationId = await create("isolated");
    await setActive(target, target.primaryOrganizationId);
}

async function setActive(target, organizationId) {
    await authPost(target, "/organization/set-active", { organizationId });
    await refreshPrincipal(target);
}

async function timed(operation) {
    const started = performance.now();
    const result = await operation();
    const elapsed = performance.now() - started;
    check(Number.isFinite(elapsed) && elapsed > 0, "benchmark clock returned an invalid duration");
    return { result, elapsed };
}

async function uploadFile(target, payload, payloadSha256, fileKey) {
    const uploadQuery = new URLSearchParams({
        organizationId: target.primaryOrganizationId,
        table: "documents",
        column: "attachment",
    });
    const upload = await timed(() =>
        request(target.origin, `/_chardb/files/upload?${uploadQuery}`, {
            method: "PUT",
            headers: {
                "content-type": "application/octet-stream",
                "idempotency-key": fileKey,
                cookie: target.cookie,
                origin: target.origin.origin,
            },
            body: payload,
        })
    );
    const file = upload.result.body?.file;
    check(upload.result.response.ok, `${target.kind} upload failed with ${upload.result.response.status}`);
    check(file?.size === payload.byteLength && file?.sha256 === payloadSha256, `${target.kind} upload digest drifted`);
    const completedAt = performance.now();
    await runFileBenchmarkUploadHook(target.onUpload, target.kind, {
        organizationId: target.primaryOrganizationId,
        fileId: file.fileId,
    });
    return { fileKey, file, latencyMs: upload.elapsed, status: upload.result.response.status, completedAt };
}

async function attachFile(target, uploaded) {
    const rowId = `row-${uploaded.fileKey}`;
    const attach = await timed(() =>
        request(target.origin, "/api/documents", {
            method: "POST",
            headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
            body: JSON.stringify({
                action: "create",
                id: rowId,
                organizationId: target.primaryOrganizationId,
                fileId: uploaded.file.fileId,
                mutId: `attach-${uploaded.fileKey}`,
            }),
        })
    );
    check(attach.result.response.ok, `${target.kind} attachment failed with ${attach.result.response.status}`);
    return { ...uploaded, rowId, attachLatencyMs: attach.elapsed, attachStatus: attach.result.response.status };
}

async function downloadFile(target, attached, payload, payloadSha256) {
    const downloadQuery = new URLSearchParams({
        organizationId: target.primaryOrganizationId,
        table: "documents",
        column: "attachment",
        rowId: attached.rowId,
    });
    const download = await timed(() =>
        requestBytes(target.origin, `/_chardb/files/download?${downloadQuery}`, {
            headers: { cookie: target.cookie, origin: target.origin.origin },
        })
    );
    const downloadedSha256 = sha256(download.result.bytes);
    check(
        download.result.response.ok &&
            download.result.bytes.byteLength === payload.byteLength &&
            downloadedSha256 === payloadSha256,
        `${target.kind} download bytes drifted`
    );
    return {
        ...attached,
        downloadLatencyMs: download.elapsed,
        downloadStatus: download.result.response.status,
        downloadSize: download.result.bytes.byteLength,
        downloadSha256: downloadedSha256,
    };
}

function operationCorrectness(operationStatus, exactBytes = true, exactDigest = true) {
    return {
        authenticated: true,
        organizationIsolated: true,
        operationStatus,
        exactBytes,
        exactDigest,
        cleanupComplete: false,
    };
}

function uploadSample(uploaded, sequence, objectSequence, payload, payloadSha256) {
    return {
        sequence,
        objectSequence,
        latencyMs: uploaded.latencyMs,
        bytes: payload.byteLength,
        correctness: operationCorrectness(
            uploaded.status >= 200 && uploaded.status < 300,
            uploaded.file.size === payload.byteLength,
            uploaded.file.sha256 === payloadSha256
        ),
    };
}

function attachSample(attached, sequence, objectSequence, payload, payloadSha256) {
    return {
        sequence,
        objectSequence,
        latencyMs: attached.attachLatencyMs,
        bytes: 0,
        correctness: operationCorrectness(
            attached.attachStatus >= 200 && attached.attachStatus < 300,
            attached.file.size === payload.byteLength,
            attached.file.sha256 === payloadSha256
        ),
    };
}

function downloadSample(downloaded, sequence, objectSequence, payload, payloadSha256) {
    return {
        sequence,
        objectSequence,
        latencyMs: downloaded.downloadLatencyMs,
        bytes: downloaded.downloadSize,
        correctness: operationCorrectness(
            downloaded.downloadStatus >= 200 && downloaded.downloadStatus < 300,
            downloaded.downloadSize === payload.byteLength,
            downloaded.downloadSha256 === payloadSha256
        ),
    };
}

async function runPayloadPlan(target, plan, candidateSha256, runSequence) {
    const payload = deterministicFilePayload(plan.payloadBytes, `${candidateSha256}:${runSequence}:${plan.name}`);
    const payloadSha256 = sha256(payload);
    const warmupUploaded = await uploadFile(
        target,
        payload,
        payloadSha256,
        `${target.kind}-${runSequence}-${plan.name}-warmup-${randomUUID()}`
    );
    const warmupAttached = await attachFile(target, warmupUploaded);
    const warmupDownloaded = await downloadFile(target, warmupAttached, payload, payloadSha256);
    await proveIsolation(target, warmupAttached.rowId);

    const inputs = Array.from({ length: plan.operationsPerRun.upload.count }, (_, objectSequence) => ({
        objectSequence,
        fileKey: `${target.kind}-${runSequence}-${plan.name}-${objectSequence}-${randomUUID()}`,
    }));
    const uploadStarted = performance.now();
    const uploaded = await runBounded(inputs, plan.operationsPerRun.upload.concurrency, input =>
        uploadFile(target, payload, payloadSha256, input.fileKey).then(result => ({
            ...result,
            objectSequence: input.objectSequence,
        }))
    );
    const uploadElapsedMs = Math.max(...uploaded.map(item => item.completedAt)) - uploadStarted;
    check(
        plan.operationsPerRun.attach.count === uploaded.length,
        `${plan.name} attach count must equal its measured upload count`
    );
    const attachStarted = performance.now();
    const attached = await runBounded(uploaded, plan.operationsPerRun.attach.concurrency, input =>
        attachFile(target, input)
    );
    const attachElapsedMs = performance.now() - attachStarted;
    const downloadInputs = Array.from({ length: plan.operationsPerRun.download.count }, (_, sequence) => ({
        sequence,
        attached: attached[sequence % attached.length],
    }));
    const downloadStarted = performance.now();
    const downloaded = await runBounded(downloadInputs, plan.operationsPerRun.download.concurrency, input =>
        downloadFile(target, input.attached, payload, payloadSha256).then(result => ({
            ...result,
            sequence: input.sequence,
        }))
    );
    const downloadElapsedMs = performance.now() - downloadStarted;
    return {
        name: plan.name,
        payloadBytes: plan.payloadBytes,
        payloadSha256,
        warmup: {
            excluded: true,
            operations: {
                upload: uploadSample(warmupUploaded, 0, 0, payload, payloadSha256),
                attach: attachSample(warmupAttached, 0, 0, payload, payloadSha256),
                download: downloadSample(warmupDownloaded, 0, 0, payload, payloadSha256),
            },
        },
        operations: {
            upload: {
                elapsedMs: uploadElapsedMs,
                samples: uploaded.map((item, sequence) =>
                    uploadSample(item, sequence, item.objectSequence, payload, payloadSha256)
                ),
            },
            attach: {
                elapsedMs: attachElapsedMs,
                samples: attached.map((item, sequence) =>
                    attachSample(item, sequence, item.objectSequence, payload, payloadSha256)
                ),
            },
            download: {
                elapsedMs: downloadElapsedMs,
                samples: downloaded.map(item =>
                    downloadSample(item, item.sequence, item.objectSequence, payload, payloadSha256)
                ),
            },
        },
    };
}

function markSampleCleanupComplete(sample) {
    return { ...sample, correctness: { ...sample.correctness, cleanupComplete: true } };
}

function markPayloadCleanupComplete(payload) {
    return {
        ...payload,
        warmup: {
            ...payload.warmup,
            operations: Object.fromEntries(
                Object.entries(payload.warmup.operations).map(([operation, sample]) => [
                    operation,
                    markSampleCleanupComplete(sample),
                ])
            ),
        },
        operations: Object.fromEntries(
            Object.entries(payload.operations).map(([operation, result]) => [
                operation,
                { ...result, samples: result.samples.map(markSampleCleanupComplete) },
            ])
        ),
    };
}

async function runBounded(items, concurrency, operation) {
    const output = new Array(items.length);
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            for (;;) {
                const index = cursor++;
                if (index >= items.length) return;
                output[index] = await operation(items[index], index);
            }
        })
    );
    return output;
}

async function proveIsolation(target, rowId) {
    await setActive(target, target.isolatedOrganizationId);
    const query = new URLSearchParams({
        organizationId: target.primaryOrganizationId,
        table: "documents",
        column: "attachment",
        rowId,
    });
    const denied = await request(target.origin, `/_chardb/files/download?${query}`, {
        headers: { cookie: target.cookie, origin: target.origin.origin },
    });
    check(!denied.response.ok, `${target.kind} cross-organization download was accepted`);
    await setActive(target, target.primaryOrganizationId);
}

async function r2State(target, organizationId) {
    const query = new URLSearchParams(organizationId ? { organizationId } : {});
    const result = await request(target.origin, `/proof/r2-state?${query}`, {
        headers: { authorization: `Bearer ${target.adminToken}`, "x-chardb-proof-run-id": target.runId },
    });
    check(result.response.ok && Number.isSafeInteger(result.body?.count), `${target.kind} R2 state failed`);
    return result.body;
}

async function retry(operation, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            await Bun.sleep(500);
        }
    }
    throw lastError ?? new Error("file benchmark cleanup timed out");
}

async function cleanupTarget(target) {
    for (const [label, organizationId] of [
        ["primary", target.primaryOrganizationId],
        ["isolated", target.isolatedOrganizationId],
    ]) {
        if (!organizationId) continue;
        await setActive(target, organizationId);
        await authPost(target, "/organization/delete", { organizationId });
        await retry(async () => {
            const state = await r2State(target, organizationId);
            check(state.count === 0, `${target.kind} ${label} organization still has ${state.count} objects`);
            return state;
        });
    }
    return true;
}

function runnerIdentity() {
    const processors = cpus();
    return {
        runtime: { name: "bun", version: Bun.version },
        machine: {
            platform: platform(),
            architecture: arch(),
            osRelease: release(),
            cpuModel: processors[0]?.model ?? "unknown",
            logicalCpuCount: processors.length,
            memoryBytes: totalmem(),
        },
    };
}

async function atomicJson(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
        await rename(temporary, file);
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function validateFileBenchmarkEvidence(directory, expectedCandidateSha256) {
    const root = path.resolve(directory);
    const pairPath = path.join(root, "paired.json");
    const pairBytes = await readFile(pairPath);
    const pair = JSON.parse(pairBytes.toString("utf8"));
    exactObjectKeys(pair, "paired benchmark report", [
        "schema",
        "ok",
        "candidate",
        "profile",
        "execution",
        "executionOrder",
        "reports",
        "runs",
    ]);
    check(pair?.schema === FILE_BENCHMARK_PAIR_SCHEMA && pair.ok === true, "paired benchmark report is invalid");
    exactObjectKeys(pair.candidate, "paired benchmark candidate", ["sha256", "bytes"]);
    check(/^[a-f0-9]{64}$/.test(pair.candidate.sha256 ?? ""), "paired benchmark candidate SHA-256 is invalid");
    check(
        Number.isSafeInteger(pair.candidate.bytes) && pair.candidate.bytes > 0,
        "paired benchmark candidate size is invalid"
    );
    exactObjectKeys(pair.execution, "paired benchmark execution", ["startedAt", "completedAt"]);
    if (expectedCandidateSha256 !== undefined) {
        check(pair.candidate?.sha256 === expectedCandidateSha256, "paired benchmark candidate drifted");
    }
    check(JSON.stringify(pair.profile) === JSON.stringify(FILE_BENCHMARK_PROFILE), "paired benchmark profile drifted");
    const expectedOrder = [];
    for (let run = 0; run < FILE_BENCHMARK_PROFILE.logicalRuns; run++) {
        for (const [payloadIndex, payload] of FILE_BENCHMARK_PROFILE.payloads.entries()) {
            expectedOrder.push({ run, payload: payload.name, targets: alternatingTargetOrder(run + payloadIndex) });
        }
    }
    check(Array.isArray(pair.executionOrder), "paired benchmark execution order must be an array");
    for (const [index, entry] of pair.executionOrder.entries()) {
        exactObjectKeys(entry, `paired benchmark execution order ${index}`, ["run", "payload", "targets"]);
    }
    check(isDeepStrictEqual(pair.executionOrder, expectedOrder), "paired benchmark execution order drifted");
    check(
        Array.isArray(pair.runs) && pair.runs.length === FILE_BENCHMARK_PROFILE.logicalRuns,
        "paired benchmark run evidence is incomplete"
    );
    for (const [sequence, run] of pair.runs.entries()) {
        exactObjectKeys(run, `paired benchmark run evidence ${sequence}`, ["sequence", "local", "cloudflare"]);
        check(run?.sequence === sequence, `paired benchmark run ${sequence} sequence drifted`);
        for (const kind of ["local", "cloudflare"]) {
            exactObjectKeys(run[kind], `paired benchmark run ${sequence} ${kind} invariants`, PAIR_INVARIANTS);
            const invariantNames = Object.keys(run?.[kind] ?? {}).sort();
            check(
                isDeepStrictEqual(invariantNames, [...PAIR_INVARIANTS].sort()) &&
                    PAIR_INVARIANTS.every(name => run[kind][name] === true),
                `paired benchmark run ${sequence} ${kind} invariants failed`
            );
        }
    }
    const expectedReports = {
        local: "local.json",
        cloudflare: "cloudflare.json",
        comparison: "comparison.json",
    };
    exactObjectKeys(pair.reports, "paired benchmark report references", Object.keys(expectedReports));
    const reports = {};
    for (const [name, relative] of Object.entries(expectedReports)) {
        exactObjectKeys(pair.reports[name], `paired benchmark ${name} reference`, ["path", "sha256"]);
        check(pair.reports?.[name]?.path === relative, `paired benchmark ${name} path drifted`);
        check(/^[a-f0-9]{64}$/.test(pair.reports[name].sha256 ?? ""), `paired benchmark ${name} SHA-256 is invalid`);
        const bytes = await readFile(path.join(root, relative));
        check(sha256(bytes) === pair.reports[name].sha256, `paired benchmark ${name} digest drifted`);
        reports[name] = JSON.parse(bytes.toString("utf8"));
    }
    for (const [kind, report] of [
        ["local", reports.local],
        ["cloudflare", reports.cloudflare],
    ]) {
        exactObjectKeys(report, `${kind} benchmark report`, [
            "schema",
            "ok",
            "candidate",
            "workload",
            "target",
            "profile",
            "execution",
            "runner",
            "runs",
            "aggregate",
        ]);
        check(Array.isArray(report.runs), `${kind} benchmark runs must be an array`);
        for (const [sequence, run] of report.runs.entries()) {
            exactObjectKeys(run, `${kind} benchmark run ${sequence}`, [
                "sequence",
                "startedAt",
                "completedAt",
                "payloads",
            ]);
        }
    }
    const local = assertFileBenchmarkReport(reports.local);
    const cloudflare = assertFileBenchmarkReport(reports.cloudflare);
    check(
        isDeepStrictEqual(reports.comparison, compareFileBenchmarkReports(local, cloudflare)),
        "paired benchmark comparison drifted"
    );
    check(isDeepStrictEqual(pair.candidate, local.candidate), "paired benchmark candidate does not match local");
    check(
        isDeepStrictEqual(pair.candidate, cloudflare.candidate),
        "paired benchmark candidate does not match Cloudflare"
    );
    check(isDeepStrictEqual(pair.execution, local.execution), "paired benchmark execution does not match local");
    check(
        isDeepStrictEqual(pair.execution, cloudflare.execution),
        "paired benchmark execution does not match Cloudflare"
    );
    const pairSha256 = sha256(pairBytes);
    const manifest = await readFile(path.join(root, "benchmark-evidence.sha256"), "utf8");
    check(manifest === `${pairSha256}  paired.json\n`, "benchmark evidence manifest drifted");
    return { schema: FILE_BENCHMARK_PAIR_SCHEMA, candidate: pair.candidate, pairSha256, files: 4 };
}

export async function runPairedFileBenchmark(options) {
    const tarballBytes = await readFile(options.tarball);
    const candidate = { sha256: sha256(tarballBytes), bytes: tarballBytes.byteLength };
    await mkdir(options.output, { recursive: true });
    if ((await readdir(options.output)).length > 0) throw new Error("file benchmark output directory must be empty");
    const startedAt = new Date().toISOString();
    const targetTemplates = {
        local: {
            kind: "local",
            origin: options.localUrl,
            adminToken: options.adminToken,
            runId: options.runId,
            runtime: {
                name: "wrangler-miniflare",
                version: options.wranglerVersion,
                compatibilityDate: options.compatibilityDate,
            },
            r2: { provider: "miniflare", binding: "CDB_FILES", bucket: options.localBucket },
            ...(options.onUpload ? { onUpload: options.onUpload } : {}),
        },
        cloudflare: {
            kind: "cloudflare",
            origin: options.cloudflareUrl,
            adminToken: options.adminToken,
            runId: options.runId,
            runtime: {
                name: "cloudflare-workers",
                version: options.wranglerVersion,
                compatibilityDate: options.compatibilityDate,
            },
            deploymentVersion: options.cloudflareDeploymentVersion,
            r2: { provider: "cloudflare", binding: "CDB_FILES", bucket: options.cloudflareBucket },
            ...(options.onUpload ? { onUpload: options.onUpload } : {}),
        },
    };
    const runs = { local: [], cloudflare: [] };
    const executionOrder = [];
    const runInvariants = [];
    for (let runSequence = 0; runSequence < FILE_BENCHMARK_PROFILE.logicalRuns; runSequence++) {
        const runStartedAt = new Date().toISOString();
        const suffix = `${Date.now().toString(36)}-${runSequence}-${randomUUID().slice(0, 8)}`;
        const targets = {
            local: { ...targetTemplates.local },
            cloudflare: { ...targetTemplates.cloudflare },
        };
        const payloads = { local: [], cloudflare: [] };
        const flags = {
            local: {
                nativeBetterAuth: false,
                organizationIsolation: false,
                exactBytes: false,
                exactDigest: false,
                cleanupComplete: false,
            },
            cloudflare: {
                nativeBetterAuth: false,
                organizationIsolation: false,
                exactBytes: false,
                exactDigest: false,
                cleanupComplete: false,
            },
        };
        let runError;
        try {
            await Promise.all(Object.values(targets).map(target => initializeTarget(target, candidate.sha256, suffix)));
            flags.local.nativeBetterAuth = true;
            flags.cloudflare.nativeBetterAuth = true;
            for (const [payloadIndex, plan] of FILE_BENCHMARK_PROFILE.payloads.entries()) {
                const order = alternatingTargetOrder(runSequence + payloadIndex);
                executionOrder.push({ run: runSequence, payload: plan.name, targets: order });
                for (const kind of order) {
                    payloads[kind].push(await runPayloadPlan(targets[kind], plan, candidate.sha256, runSequence));
                    flags[kind].organizationIsolation = true;
                }
            }
            for (const kind of ["local", "cloudflare"]) {
                const measured = payloads[kind].flatMap(payload =>
                    Object.values(payload.operations).flatMap(operation => operation.samples)
                );
                flags[kind].exactBytes = measured.every(sample => sample.correctness.exactBytes);
                flags[kind].exactDigest = measured.every(sample => sample.correctness.exactDigest);
            }
        } catch (error) {
            runError = error;
        }
        for (const kind of ["local", "cloudflare"]) {
            try {
                flags[kind].cleanupComplete = await cleanupTarget(targets[kind]);
                if (flags[kind].cleanupComplete) payloads[kind] = payloads[kind].map(markPayloadCleanupComplete);
            } catch (error) {
                runError ??= error;
            }
        }
        if (runError) throw runError;
        for (const [kind, result] of Object.entries(flags)) {
            check(Object.values(result).every(Boolean), `${kind} run ${runSequence} invariants did not all pass`);
        }
        const runCompletedAt = new Date().toISOString();
        for (const kind of ["local", "cloudflare"]) {
            runs[kind].push({
                sequence: runSequence,
                startedAt: runStartedAt,
                completedAt: runCompletedAt,
                payloads: payloads[kind],
            });
        }
        runInvariants.push({ sequence: runSequence, ...flags });
    }
    const completedAt = new Date().toISOString();
    const runner = runnerIdentity();
    const reports = {};
    for (const kind of ["local", "cloudflare"]) {
        reports[kind] = createFileBenchmarkReport({
            ok: true,
            candidate,
            workload: { id: FILE_BENCHMARK_WORKLOAD_ID, version: FILE_BENCHMARK_WORKLOAD_VERSION },
            target: {
                kind,
                origin: targetTemplates[kind].origin.origin,
                runtime: targetTemplates[kind].runtime,
                ...(targetTemplates[kind].deploymentVersion
                    ? { deploymentVersion: targetTemplates[kind].deploymentVersion }
                    : {}),
                r2: targetTemplates[kind].r2,
            },
            profile: FILE_BENCHMARK_PROFILE,
            execution: { startedAt, completedAt },
            runner,
            runs: runs[kind],
            aggregate: summarizeFileBenchmarkRuns(runs[kind]),
        });
        await atomicJson(path.join(options.output, `${kind}.json`), reports[kind]);
    }
    const comparison = compareFileBenchmarkReports(reports.local, reports.cloudflare);
    await atomicJson(path.join(options.output, "comparison.json"), comparison);
    const reportDigests = {
        local: sha256(await readFile(path.join(options.output, "local.json"))),
        cloudflare: sha256(await readFile(path.join(options.output, "cloudflare.json"))),
        comparison: sha256(await readFile(path.join(options.output, "comparison.json"))),
    };
    const pair = {
        schema: FILE_BENCHMARK_PAIR_SCHEMA,
        ok: true,
        candidate,
        profile: FILE_BENCHMARK_PROFILE,
        execution: { startedAt, completedAt },
        executionOrder,
        reports: {
            local: { path: "local.json", sha256: reportDigests.local },
            cloudflare: { path: "cloudflare.json", sha256: reportDigests.cloudflare },
            comparison: { path: "comparison.json", sha256: reportDigests.comparison },
        },
        runs: runInvariants,
    };
    await atomicJson(path.join(options.output, "paired.json"), pair);
    const pairSha256 = sha256(await readFile(path.join(options.output, "paired.json")));
    await writeFile(path.join(options.output, "benchmark-evidence.sha256"), `${pairSha256}  paired.json\n`);
    const validation = await validateFileBenchmarkEvidence(options.output, candidate.sha256);
    return { pair, reports, comparison, validation };
}

async function usage() {
    return [
        "Usage: bun scripts/run-file-benchmark.mjs [options]",
        "",
        "Required: --tarball --output --local-url --cloudflare-url --local-bucket --cloudflare-bucket",
        "          --cloudflare-deployment-version --wrangler-version",
        "Secrets:  CHARDB_FILE_BENCH_ADMIN_TOKEN and CHARDB_FILE_BENCH_RUN_ID",
        "The immutable standard-v1 workload runs five fresh organization pairs at 64 KiB and 5 MiB.",
    ].join("\n");
}

if (import.meta.main) {
    const options = parseFileBenchmarkArgs(process.argv.slice(2));
    if (options.help) console.log(await usage());
    else {
        const result = await runPairedFileBenchmark(options);
        console.log(JSON.stringify({ ok: true, schema: result.pair.schema, output: options.output }));
    }
}
