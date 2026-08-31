import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    CloudflareVectorizeProofHttpError,
    assertSecretFreeVectorEvidence,
    createCloudflareVectorizeProofLifecycle,
} from "./cloudflare-vectorize-proof-lifecycle.mjs";
import { readCloudflareVectorizeProofSecrets } from "./cloudflare-vectorize-proof-orchestrator.mjs";
import { removeTemporaryWranglerLog } from "./cloudflare-vectorize-wrangler-log.mjs";
import { reserveLoopbackPort } from "./local-file-proof-runtime.mjs";

export const VECTORIZE_LOCAL_REMOTE_BENCHMARK_SCHEMA = "chardb.vectorize.local-remote-benchmark.v2";
export const VECTORIZE_LOCAL_REMOTE_WORKLOAD_ID = "ready-vector-filtered-search-v2";
const QUERY_STABILITY_WINDOW_MS = 10_000;
const QUERY_STABILITY_INTERVAL_MS = 1_000;
export const VECTORIZE_LOCAL_REMOTE_WORKLOAD = Object.freeze({
    id: VECTORIZE_LOCAL_REMOTE_WORKLOAD_ID,
    dimensions: 32,
    metric: "cosine",
    topK: 1,
    requestsPerSample: 1,
    warmupSamples: 1,
    measuredSamples: 5,
});

const SHA256 = /^[a-f0-9]{64}$/;
const PHYSICAL_ID = /^p1_[A-Za-z0-9_-]{43}_[1-9a-z][0-9a-z]*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CLOUDFLARE_AUTH_ENV = Object.freeze([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_API_TOKEN",
    "CF_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 250;

function check(condition, message, ErrorType = Error) {
    if (!condition) throw new ErrorType(message);
}

function object(value, label) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    return value;
}

function exactPublicSearchResult(value, expectedRowPk) {
    if (!Array.isArray(value) || value.length !== 1) return false;
    const match = value[0];
    if (match === null || typeof match !== "object" || Array.isArray(match)) return false;
    return (
        JSON.stringify(Object.keys(match).sort()) === JSON.stringify(["rowPk", "score"]) &&
        match.rowPk === expectedRowPk &&
        typeof match.score === "number" &&
        Number.isFinite(match.score)
    );
}

function exact(value, label, keys) {
    object(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    check(
        JSON.stringify(actual) === JSON.stringify(expected),
        `${label} fields must be exactly ${expected.join(", ")}`
    );
    return value;
}

function safeName(value, label) {
    check(typeof value === "string" && SAFE_NAME.test(value), `${label} is invalid`, TypeError);
    return value;
}

function boundedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
    check(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} is invalid`, TypeError);
    return value;
}

function duration(value, label) {
    check(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} is invalid`);
    return value;
}

function defaultSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function removeIfPresent(file) {
    try {
        await unlink(file);
    } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
}

function runtimeConfigPath(app) {
    return path.join(app, ".chardb-vectorize-local-remote.toml");
}

export function renderVectorizeLocalRemoteWrangler(source, indexName) {
    check(typeof source === "string" && source.length > 0, "prepared Wrangler config must be text");
    check(
        /^compatibility_date = "2026-08-27"$/mu.test(source),
        "prepared config must pin compatibility_date 2026-08-27"
    );
    const index = safeName(indexName, "Vectorize index name");
    check(
        (source.match(/^\[\[vectorize\]\]$/gmu) ?? []).length === 1,
        "prepared config must have one Vectorize binding"
    );
    const vectorizeStart = source.indexOf("[[vectorize]]");
    const vectorizeBodyStart = vectorizeStart + "[[vectorize]]".length;
    const nextSectionOffset = source.slice(vectorizeBodyStart).search(/^\[/mu);
    const vectorizeEnd = nextSectionOffset < 0 ? source.length : vectorizeBodyStart + nextSectionOffset;
    const inVectorizeSection = offset => offset > vectorizeStart && offset < vectorizeEnd;
    check(
        [...source.matchAll(/^binding = "CDB_PROOF_VECTORS"$/gmu)].filter(match => inVectorizeSection(match.index))
            .length === 1,
        "prepared config must bind CDB_PROOF_VECTORS exactly once"
    );
    const escaped = index.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const indexPattern = new RegExp(`^index_name = "${escaped}"$`, "mu");
    const indexMatch = indexPattern.exec(source);
    check(
        indexMatch && inVectorizeSection(indexMatch.index),
        "prepared config does not bind the owned Vectorize index"
    );
    const remoteModes = [...source.matchAll(/^\s*remote\s*=.*$/gmu)];
    check(
        remoteModes.length === 0 ||
            (remoteModes.length === 1 &&
                remoteModes[0][0] === "remote = true" &&
                inVectorizeSection(remoteModes[0].index)),
        "prepared config already sets an incompatible remote binding mode"
    );
    const rendered =
        remoteModes.length === 1 ? source : source.replace(indexPattern, match => `${match}\nremote = true`);
    check(
        (rendered.match(/^remote = true$/gmu) ?? []).length === 1,
        "local remote config did not set one remote binding"
    );
    return rendered;
}

function boundedTail(maximumBytes) {
    let bytes = Buffer.alloc(0);
    return {
        append(chunk) {
            const next = Buffer.from(chunk);
            bytes = Buffer.concat([bytes, next]);
            if (bytes.byteLength > maximumBytes) bytes = bytes.subarray(bytes.byteLength - maximumBytes);
        },
        text: () => bytes.toString("utf8"),
    };
}

async function drain(stream, tail) {
    if (!stream) return;
    for await (const chunk of stream) tail.append(chunk);
}

async function defaultTerminate(child, input) {
    const signal = value => {
        if (process.platform === "win32") return child.kill(value);
        try {
            process.kill(-child.pid, value);
            return true;
        } catch (error) {
            if (error && typeof error === "object" && error.code === "ESRCH") return false;
            throw error;
        }
    };
    signal("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), input.sleep(input.graceMs).then(() => false)]);
    if (!exited) {
        signal("SIGKILL");
        const killed = await Promise.race([
            child.exited.then(() => true),
            input.sleep(input.graceMs).then(() => false),
        ]);
        check(killed, "local Wrangler process survived SIGKILL");
    }
}

export async function startVectorizeLocalRemoteRuntime(input, injected = {}) {
    const app = path.resolve(input.app);
    const config = path.resolve(input.config);
    const secretsFile = path.resolve(input.secretsFile);
    const persistenceDir = path.resolve(input.persistenceDir);
    const runtimeDir = path.resolve(input.runtimeDir);
    const wrangler = path.resolve(input.wrangler);
    check(config === path.join(app, "wrangler.toml"), "prepared Wrangler config must be app/wrangler.toml");
    check(
        persistenceDir.startsWith(`${runtimeDir}${path.sep}`),
        "local persistence must be inside the private runtime directory"
    );
    check(SHA256.test(input.releaseSha256 ?? ""), "local remote release digest is invalid");
    const profileMode = typeof input.profile === "string";
    const tokenMode = typeof input.apiToken === "string";
    check(profileMode !== tokenMode, "local remote Wrangler requires exactly one profile or API token");
    check(/^[a-f0-9]{32}$/.test(input.accountId ?? ""), "Wrangler account ID is invalid");
    if (profileMode) safeName(input.profile, "Wrangler profile");
    if (tokenMode) {
        check(input.apiToken.length >= 16, "Wrangler API token is invalid");
    }
    const dependencies = {
        reservePort: injected.reservePort ?? reserveLoopbackPort,
        readFile: injected.readFile ?? readFile,
        writeConfig:
            injected.writeConfig ??
            ((file, contents) => writeFile(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 })),
        removeConfig: injected.removeConfig ?? removeIfPresent,
        removeLog: injected.removeLog ?? removeTemporaryWranglerLog,
        prepareDirectory:
            injected.prepareDirectory ?? (directory => mkdir(directory, { recursive: true, mode: 0o700 })),
        spawn: injected.spawn ?? ((command, options) => Bun.spawn(command, options)),
        fetch: injected.fetch ?? fetch,
        now: injected.now ?? Date.now,
        sleep: injected.sleep ?? defaultSleep,
        terminate: injected.terminate ?? defaultTerminate,
    };
    await dependencies.prepareDirectory(runtimeDir);
    await dependencies.prepareDirectory(persistenceDir);
    const localConfig = runtimeConfigPath(app);
    const rendered = renderVectorizeLocalRemoteWrangler(await dependencies.readFile(config, "utf8"), input.index);
    await dependencies.writeConfig(localConfig, rendered);
    const port = await dependencies.reservePort();
    boundedInteger(port, "local remote loopback port", 65_535);
    const origin = `http://127.0.0.1:${port}`;
    const command = [
        wrangler,
        "dev",
        "--config",
        localConfig,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persistenceDir,
        "--env-file",
        secretsFile,
        ...(profileMode ? ["--profile", input.profile] : []),
        "--log-level",
        "error",
    ];
    check(!command.includes("--local") && !command.includes("--remote"), "local remote command mode is invalid");
    const environment = { ...(input.baseEnvironment ?? process.env) };
    for (const key of ["BETTER_AUTH_SECRET", "CDB_ADMIN_TOKEN", "CDB_PROOF_RUN_ID", "CDB_RELEASE_SHA256"]) {
        delete environment[key];
    }
    for (const key of CLOUDFLARE_AUTH_ENV) delete environment[key];
    const wranglerLogPath = path.join(runtimeDir, "wrangler-local-remote.log");
    environment.WRANGLER_LOG_PATH = wranglerLogPath;
    if (tokenMode) {
        environment.CLOUDFLARE_API_TOKEN = input.apiToken;
        environment.CLOUDFLARE_ACCOUNT_ID = input.accountId;
        environment.XDG_CONFIG_HOME = path.join(runtimeDir, "xdg-config");
        environment.XDG_CACHE_HOME = path.join(runtimeDir, "xdg-cache");
        environment.XDG_STATE_HOME = path.join(runtimeDir, "xdg-state");
    } else {
        environment.CLOUDFLARE_ACCOUNT_ID = input.accountId;
    }
    let child;
    const stdout = boundedTail(64 * 1024);
    const stderr = boundedTail(64 * 1024);
    let drains = [];
    const stopAndRemoveRuntimeFiles = async () => {
        let terminationError;
        if (child) {
            try {
                await dependencies.terminate(child, {
                    graceMs: input.graceMs ?? 3_000,
                    sleep: dependencies.sleep,
                });
            } catch (error) {
                terminationError = error;
            }
        }
        await Promise.allSettled(drains);
        await Promise.all([dependencies.removeConfig(localConfig), dependencies.removeLog(wranglerLogPath)]);
        if (terminationError) throw terminationError;
    };
    try {
        await dependencies.removeLog(wranglerLogPath);
        child = dependencies.spawn(command, {
            cwd: app,
            env: environment,
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
        });
        check(Number.isSafeInteger(child.pid) && child.pid > 0, "local Wrangler did not expose a process ID");
        drains = [drain(child.stdout, stdout), drain(child.stderr, stderr)];
        const deadline = dependencies.now() + boundedInteger(input.startupTimeoutMs ?? 45_000, "startup timeout");
        while (dependencies.now() < deadline) {
            check(child.exitCode === null, `local Wrangler exited before health: ${stderr.text()}`);
            try {
                const response = await dependencies.fetch(new URL("/health", origin), {
                    signal: AbortSignal.timeout(input.requestTimeoutMs ?? 2_000),
                });
                const health = response.ok ? await response.json() : null;
                if (
                    health?.ok === true &&
                    health.releaseSha256 === input.releaseSha256 &&
                    health.proofConfigured === true
                ) {
                    let stopped;
                    const stop = () => {
                        stopped ??= (async () => {
                            await stopAndRemoveRuntimeFiles();
                        })();
                        return stopped;
                    };
                    return Object.freeze({ origin, port, stop });
                }
            } catch {
                // The loopback listener may not be ready yet.
            }
            await dependencies.sleep(100);
        }
        throw new Error(`timed out waiting for local Wrangler release ${input.releaseSha256}`);
    } catch (error) {
        await stopAndRemoveRuntimeFiles();
        throw error;
    }
}

function assertSample(value, sequence, excluded, label) {
    exact(value, label, ["requestOrdinal", "sequence", "excluded", "classification", "status", "code", "elapsedMs"]);
    check(
        value.requestOrdinal === sequence + 1 && value.sequence === sequence && value.excluded === excluded,
        `${label} drifted from the fixed sample plan`
    );
    check(
        value.classification === "exact" ||
            value.classification === "empty" ||
            value.classification === "http-5xx" ||
            value.classification === "timeout",
        `${label} classification is invalid`
    );
    if (value.classification === "http-5xx") {
        check(
            Number.isSafeInteger(value.status) && value.status >= 500 && value.status <= 599,
            `${label} status is invalid`
        );
        check(value.code === null || typeof value.code === "string", `${label} code is invalid`);
    } else {
        check(value.status === null && value.code === null, `${label} carries unexpected HTTP identity`);
    }
    duration(value.elapsedMs, `${label} duration`);
}

function assertQueryStability(value, label) {
    exact(value, `${label} query stability`, [
        "queryStabilityWindowMs",
        "queryStabilityIntervalMs",
        "queryStabilityObservedMs",
        "queryStabilityExactMatchCount",
        "queryStabilityResetCount",
        "queryStabilityNonExactCount",
        "hardBoundClaimed",
    ]);
    check(value.queryStabilityWindowMs === QUERY_STABILITY_WINDOW_MS, `${label} stability window drifted`);
    check(value.queryStabilityIntervalMs === QUERY_STABILITY_INTERVAL_MS, `${label} stability cadence drifted`);
    check(
        typeof value.queryStabilityObservedMs === "number" &&
            Number.isFinite(value.queryStabilityObservedMs) &&
            value.queryStabilityObservedMs >= QUERY_STABILITY_WINDOW_MS,
        `${label} stability observation is incomplete`
    );
    for (const field of ["queryStabilityExactMatchCount", "queryStabilityResetCount", "queryStabilityNonExactCount"]) {
        check(Number.isSafeInteger(value[field]) && value[field] >= 0, `${label} ${field} is invalid`);
    }
    check(value.queryStabilityExactMatchCount > 0, `${label} stability has no exact matches`);
    check(value.hardBoundClaimed === false, `${label} stability cannot claim a platform bound`);
    return value;
}

function assertPostStabilitySampling(value, scheduled, label) {
    exact(value, `${label} post-stability sampling`, [
        "latencyPopulation",
        "availabilityPassThreshold",
        "scheduledRequestCount",
        "exactResponseCount",
        "exactResponseRatio",
        "availabilityMissCount",
        "emptyResponseCount",
        "http5xxResponseCount",
        "timeoutResponseCount",
        "reacquisitionCount",
        "reacquisitions",
        "reacquisitionObservations",
        "hardBoundClaimed",
    ]);
    check(value.latencyPopulation === "exact-results-only", `${label} latency population is invalid`);
    check(value.availabilityPassThreshold === null, `${label} must not invent an availability pass threshold`);
    check(value.scheduledRequestCount === 6 && scheduled.length === 6, `${label} scheduled request count drifted`);
    const exactResponses = scheduled.filter(item => item.classification === "exact").length;
    const misses = scheduled.filter(item => item.classification !== "exact");
    check(
        value.exactResponseCount === exactResponses && value.availabilityMissCount === misses.length,
        `${label} scheduled outcome accounting drifted`
    );
    check(
        typeof value.exactResponseRatio === "number" &&
            Number.isFinite(value.exactResponseRatio) &&
            value.exactResponseRatio === exactResponses / 6,
        `${label} exact response ratio drifted`
    );
    check(
        value.emptyResponseCount === misses.filter(item => item.classification === "empty").length &&
            value.http5xxResponseCount === misses.filter(item => item.classification === "http-5xx").length &&
            value.timeoutResponseCount === misses.filter(item => item.classification === "timeout").length,
        `${label} availability miss accounting drifted`
    );
    check(
        Number.isSafeInteger(value.reacquisitionCount) &&
            value.reacquisitionCount >= 0 &&
            Array.isArray(value.reacquisitions) &&
            value.reacquisitions.length === value.reacquisitionCount,
        `${label} reacquisition count is invalid`
    );
    let reacquiredScheduledMisses = 0;
    let outOfBandRequestCount = 0;
    for (const [index, reacquisition] of value.reacquisitions.entries()) {
        exact(reacquisition, `${label} reacquisition ${index}`, [
            "afterSequence",
            "excluded",
            "scheduledMissCount",
            "outOfBandRequestCount",
            "elapsedMs",
        ]);
        check(
            Number.isSafeInteger(reacquisition.afterSequence) &&
                reacquisition.afterSequence >= -1 &&
                reacquisition.afterSequence < 5,
            `${label} reacquisition ${index} sequence is invalid`
        );
        check(
            reacquisition.excluded === (reacquisition.afterSequence === -1),
            `${label} reacquisition ${index} drifted`
        );
        check(
            Number.isSafeInteger(reacquisition.scheduledMissCount) && reacquisition.scheduledMissCount > 0,
            `${label} reacquisition ${index} miss count is invalid`
        );
        check(
            Number.isSafeInteger(reacquisition.outOfBandRequestCount) && reacquisition.outOfBandRequestCount >= 0,
            `${label} reacquisition ${index} request count is invalid`
        );
        duration(reacquisition.elapsedMs, `${label} reacquisition ${index} duration`);
        reacquiredScheduledMisses += reacquisition.scheduledMissCount;
        outOfBandRequestCount += reacquisition.outOfBandRequestCount;
    }
    check(reacquiredScheduledMisses === misses.length, `${label} reacquisition accounting drifted`);
    check(
        Array.isArray(value.reacquisitionObservations) &&
            value.reacquisitionObservations.length === outOfBandRequestCount,
        `${label} reacquisition observations drifted`
    );
    for (const [index, observation] of value.reacquisitionObservations.entries()) {
        check(observation.requestOrdinal === index, `${label} reacquisition observation ${index} ordinal drifted`);
        check(
            observation.sequence >= -1 && observation.sequence < 5,
            `${label} reacquisition observation ${index} drifted`
        );
        duration(observation.elapsedMs, `${label} reacquisition observation ${index} duration`);
    }
    check(value.hardBoundClaimed === false, `${label} cannot claim a platform bound`);
    return value;
}

export function assertVectorizeLocalRemoteBenchmark(value, expectedCandidateSha256) {
    exact(value, "local remote Vectorize benchmark", ["track", "evidence"]);
    exact(value.track, "local remote benchmark track", [
        "workloadId",
        "warmupExcluded",
        "warmupCount",
        "warmup",
        "samples",
        "exactMatchLatenciesMs",
    ]);
    check(
        value.track.workloadId === VECTORIZE_LOCAL_REMOTE_WORKLOAD_ID &&
            value.track.warmupExcluded === true &&
            value.track.warmupCount === 1,
        "local remote benchmark track drifted"
    );
    check(
        Array.isArray(value.track.samples) && value.track.samples.length === 5,
        "local remote track needs five samples"
    );
    value.track.samples.forEach((sample, index) =>
        assertSample(sample, index, false, `local remote track sample ${index}`)
    );
    assertSample(value.track.warmup, -1, true, "local remote track warmup");
    check(
        Array.isArray(value.track.exactMatchLatenciesMs) && value.track.exactMatchLatenciesMs.length <= 5,
        "local remote exact-match latency population is invalid"
    );
    value.track.exactMatchLatenciesMs.forEach((sample, index) =>
        duration(sample, `local remote exact-match latency ${index}`)
    );
    exact(value.evidence, "local remote benchmark evidence", [
        "schema",
        "label",
        "runtime",
        "backend",
        "realVectorize",
        "candidateSha256",
        "workload",
        "readinessSettlement",
        "queryStability",
        "postStabilitySampling",
        "sampling",
        "physicalIds",
        "correctness",
    ]);
    check(value.evidence.schema === VECTORIZE_LOCAL_REMOTE_BENCHMARK_SCHEMA, "local remote evidence schema is invalid");
    check(
        value.evidence.label === "local-wrangler-remote-vectorize" &&
            value.evidence.runtime === "wrangler-dev/workerd" &&
            value.evidence.backend === "cloudflare-vectorize" &&
            value.evidence.realVectorize === true,
        "local remote evidence has a dishonest runtime or backend label"
    );
    check(SHA256.test(value.evidence.candidateSha256 ?? ""), "local remote candidate digest is invalid");
    if (expectedCandidateSha256 !== undefined) {
        check(SHA256.test(expectedCandidateSha256), "expected local remote candidate digest is invalid", TypeError);
        check(
            value.evidence.candidateSha256 === expectedCandidateSha256,
            "local remote benchmark candidate differs from the proof candidate"
        );
    }
    exact(value.evidence.workload, "local remote benchmark workload", Object.keys(VECTORIZE_LOCAL_REMOTE_WORKLOAD));
    for (const [field, expected] of Object.entries(VECTORIZE_LOCAL_REMOTE_WORKLOAD)) {
        check(value.evidence.workload[field] === expected, `local remote benchmark workload ${field} drifted`);
    }
    exact(value.evidence.readinessSettlement, "local remote readiness settlement", [
        "elapsedMs",
        "attempts",
        "transientHttpFailureCount",
        "transientHttpFailureCounts",
        "transientHttpFailureOverflowCount",
        "hardBoundClaimed",
    ]);
    duration(value.evidence.readinessSettlement.elapsedMs, "local remote readiness settlement duration");
    check(
        Number.isSafeInteger(value.evidence.readinessSettlement.attempts) &&
            value.evidence.readinessSettlement.attempts > 0,
        "local remote readiness settlement attempts are invalid"
    );
    check(
        Number.isSafeInteger(value.evidence.readinessSettlement.transientHttpFailureCount) &&
            value.evidence.readinessSettlement.transientHttpFailureCount >= 0,
        "local remote readiness transient failure count is invalid"
    );
    check(
        Array.isArray(value.evidence.readinessSettlement.transientHttpFailureCounts) &&
            value.evidence.readinessSettlement.transientHttpFailureCounts.length <= 16,
        "local remote readiness transient failure details are invalid"
    );
    let recordedTransientFailures = 0;
    for (const failure of value.evidence.readinessSettlement.transientHttpFailureCounts) {
        exact(failure, "local remote readiness transient failure", ["status", "code", "count"]);
        check(
            Number.isSafeInteger(failure.status) && failure.status >= 500 && failure.status <= 599,
            "local remote readiness transient status is invalid"
        );
        check(
            failure.code === null ||
                (typeof failure.code === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(failure.code)),
            "local remote readiness transient code is invalid"
        );
        check(Number.isSafeInteger(failure.count) && failure.count > 0, "local remote readiness count is invalid");
        recordedTransientFailures += failure.count;
    }
    check(
        Number.isSafeInteger(value.evidence.readinessSettlement.transientHttpFailureOverflowCount) &&
            value.evidence.readinessSettlement.transientHttpFailureOverflowCount >= 0 &&
            recordedTransientFailures + value.evidence.readinessSettlement.transientHttpFailureOverflowCount ===
                value.evidence.readinessSettlement.transientHttpFailureCount,
        "local remote readiness transient failure accounting drifted"
    );
    check(
        value.evidence.readinessSettlement.hardBoundClaimed === false,
        "local remote readiness must not claim a hard platform bound"
    );
    assertQueryStability(value.evidence.queryStability, "local remote");
    exact(value.evidence.sampling, "local remote sampling", ["warmup", "samples"]);
    assertSample(value.evidence.sampling.warmup, -1, true, "local remote warmup");
    check(
        Array.isArray(value.evidence.sampling.samples) && value.evidence.sampling.samples.length === 5,
        "local remote evidence needs five samples"
    );
    value.evidence.sampling.samples.forEach((sample, index) =>
        assertSample(sample, index, false, `local remote sample ${index}`)
    );
    const scheduled = [value.evidence.sampling.warmup, ...value.evidence.sampling.samples];
    assertPostStabilitySampling(value.evidence.postStabilitySampling, scheduled, "local remote");
    check(
        JSON.stringify(value.track.warmup) === JSON.stringify(value.evidence.sampling.warmup) &&
            JSON.stringify(value.track.samples) === JSON.stringify(value.evidence.sampling.samples) &&
            JSON.stringify(value.track.exactMatchLatenciesMs) ===
                JSON.stringify(
                    value.evidence.sampling.samples
                        .filter(sample => sample.classification === "exact")
                        .map(sample => sample.elapsedMs)
                ),
        "local remote track does not match raw samples"
    );
    check(
        Array.isArray(value.evidence.physicalIds) && value.evidence.physicalIds.length > 0,
        "local remote physical IDs are missing"
    );
    check(
        value.evidence.physicalIds.every(id => typeof id === "string" && PHYSICAL_ID.test(id)) &&
            JSON.stringify(value.evidence.physicalIds) ===
                JSON.stringify([...new Set(value.evidence.physicalIds)].sort()),
        "local remote physical IDs must be unique, sorted Vectorize wire IDs"
    );
    exact(value.evidence.correctness, "local remote correctness", [
        "migrationActivated",
        "ownershipRecordedBeforeSend",
        "readyBeforeTiming",
        "owningOrganizationExactMatch",
        "isolatedOrganizationEmpty",
        "assertionsOutsideTiming",
        "deletedAndAbsent",
        "runtimeStopped",
    ]);
    for (const [key, passed] of Object.entries(value.evidence.correctness)) {
        check(passed === true, `local remote correctness ${key} did not pass`);
    }
    return value;
}

export async function runVectorizeLocalRemoteBenchmark(input, injected = {}) {
    const prepared = object(input.prepared, "prepared Vectorize proof");
    check(SHA256.test(prepared.candidate?.digest ?? ""), "prepared candidate digest is invalid");
    check(typeof injected.appendOwnedIds === "function", "appendOwnedIds callback is required", TypeError);
    const readSecrets = injected.readSecrets ?? readCloudflareVectorizeProofSecrets;
    const secrets = await readSecrets(prepared.secretsFile);
    const secretValues = [secrets.betterAuthSecret, secrets.adminToken, secrets.runId];
    const lifecycle =
        injected.lifecycle ??
        createCloudflareVectorizeProofLifecycle({
            fetch: injected.fetch,
            now: injected.now,
            sleep: injected.sleep,
            requestTimeoutMs: input.requestTimeoutMs,
        });
    const runtime = await (injected.startRuntime ?? startVectorizeLocalRemoteRuntime)(
        {
            app: prepared.app,
            config: prepared.config,
            secretsFile: prepared.secretsFile,
            persistenceDir: input.persistenceDir,
            runtimeDir: input.runtimeDir,
            wrangler: input.wrangler,
            releaseSha256: prepared.candidate.digest,
            index: prepared.target.index,
            profile: input.profile,
            apiToken: input.apiToken,
            accountId: input.accountId,
            baseEnvironment: input.baseEnvironment,
            startupTimeoutMs: input.startupTimeoutMs,
            requestTimeoutMs: input.requestTimeoutMs,
            graceMs: input.graceMs,
        },
        injected.runtimeDependencies
    );
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    const checkpoint = injected.checkpoint ?? (async () => undefined);
    check(typeof checkpoint === "function", "checkpoint callback must be a function", TypeError);
    check(
        Array.isArray(input.values) && input.values.length === 32 && input.values.every(Number.isFinite),
        "local remote benchmark values must contain 32 finite numbers",
        TypeError
    );
    const mutationRunId = safeName(input.mutationRunId, "mutation run id");
    check(mutationRunId.length <= 96, "mutation run id is too long", TypeError);
    let stopped = false;
    let result;
    try {
        await checkpoint("health");
        await lifecycle.health({ origin: runtime.origin, releaseSha256: prepared.candidate.digest });
        await checkpoint("migration");
        const migration = await lifecycle.migrateV0ToV1({
            origin: runtime.origin,
            adminToken: secrets.adminToken,
            migrationId: safeName(input.migrationId, "migration id"),
            timeoutMs,
            intervalMs,
        });
        check(migration.afterVersion === 1 && migration.afterEpoch === 2, "local remote migration did not activate v1");
        await checkpoint("organization-setup");
        const setup = await lifecycle.setupOrganizations({
            origin: runtime.origin,
            admin: { token: secrets.adminToken, runId: secrets.runId },
            owningName: input.owningName,
            owningSlug: input.owningSlug,
            isolatedName: input.isolatedName,
            isolatedSlug: input.isolatedSlug,
        });
        const proof = {
            origin: runtime.origin,
            admin: { token: secrets.adminToken, runId: secrets.runId },
            organizationId: setup.owningOrganizationId,
        };
        const intent = await lifecycle.vectorIntent({ ...proof, id: input.documentId, action: "create" });
        await injected.appendOwnedIds({ ...intent, action: "create" });
        const created = object(
            await lifecycle.mutateVector({
                origin: runtime.origin,
                principal: setup.owner,
                action: "create",
                id: input.documentId,
                organizationId: setup.owningOrganizationId,
                mutId: `vector-create:${mutationRunId}`,
                text: input.text,
                values: input.values,
            }),
            "local remote vector create result"
        );
        check(created.vectorId === intent.vectorId, "local remote vector create identity drifted from its intent");
        await lifecycle.pollReady({
            ...proof,
            vectorId: intent.vectorId,
            version: intent.nextVersion,
            timeoutMs,
            intervalMs,
            requiredPhases: ["verify"],
        });
        await checkpoint("readiness-isolation");
        await checkpoint("query-stability");
        const readinessIsolation = await lifecycle.proveNamespaceIsolation({
            origin: runtime.origin,
            owner: setup.owner,
            member: setup.member,
            owningOrganizationId: setup.owningOrganizationId,
            isolatedOrganizationId: setup.isolatedOrganizationId,
            vectorId: intent.vectorId,
            expectedRowPk: input.documentId,
            values: input.values,
            limit: 1,
            timeoutMs,
            intervalMs: QUERY_STABILITY_INTERVAL_MS,
            stabilityWindowMs: QUERY_STABILITY_WINDOW_MS,
        });
        const measure =
            lifecycle.measure ??
            createCloudflareVectorizeProofLifecycle({ now: injected.now, sleep: injected.sleep }).measure;
        const measurement = await measure({
            origin: runtime.origin,
            label: "local-wrangler-remote-vectorize",
            timeoutMs,
            intervalMs: QUERY_STABILITY_INTERVAL_MS,
            operation: async sample => {
                if (sample.phase === "scheduled") {
                    await checkpoint(
                        sample.sequence === -1 ? "timed-search-warmup" : `timed-search-${sample.sequence}`
                    );
                }
                let matches;
                try {
                    matches = await lifecycle.search({
                        origin: runtime.origin,
                        principal: setup.owner,
                        organizationId: setup.owningOrganizationId,
                        values: input.values,
                        limit: 1,
                    });
                } catch (error) {
                    if (error instanceof CloudflareVectorizeProofHttpError) {
                        if (Number.isInteger(error.status) && error.status >= 500 && error.status <= 599) {
                            return { classification: "http-5xx", status: error.status, code: error.code };
                        }
                        if (error.status === null && /timed out$/u.test(error.message)) {
                            return { classification: "timeout" };
                        }
                    }
                    throw error;
                }
                const exact = exactPublicSearchResult(matches, input.documentId);
                check(
                    Array.isArray(matches) && (matches.length === 0 || exact),
                    `local remote search sample ${sample.sequence} returned a non-exact public result`
                );
                return exact;
            },
            secrets: secretValues,
        });
        const raw = [measurement.warmup, ...measurement.samples];
        await checkpoint("post-timing-isolated-search");
        const isolated = await lifecycle.search({
            origin: runtime.origin,
            principal: setup.member,
            organizationId: setup.isolatedOrganizationId,
            values: input.values,
            limit: 1,
        });
        check(isolated.length === 0, "local remote isolated organization returned a match");
        await checkpoint("delete-and-absence");
        const deleteIntent = await lifecycle.vectorIntent({ ...proof, id: input.documentId, action: "delete" });
        await injected.appendOwnedIds({ ...deleteIntent, action: "delete" });
        await lifecycle.mutateVector({
            origin: runtime.origin,
            principal: setup.owner,
            action: "delete",
            id: input.documentId,
            organizationId: setup.owningOrganizationId,
            mutId: `vector-delete:${mutationRunId}`,
        });
        const deletion = await lifecycle.pollDeleted({
            ...proof,
            vectorId: intent.vectorId,
            timeoutMs,
            intervalMs,
            requiredPhases: ["verify"],
        });
        check(
            deletion.result.absent === true && deletion.result.retainedTombstone === false,
            "local remote delete did not verify exact Vectorize absence"
        );
        const afterDelete = await lifecycle.search({
            origin: runtime.origin,
            principal: setup.owner,
            organizationId: setup.owningOrganizationId,
            values: input.values,
            limit: 1,
        });
        check(afterDelete.length === 0, "local remote vector remained searchable after delete");
        const samples = raw.slice(1);
        result = {
            track: {
                workloadId: VECTORIZE_LOCAL_REMOTE_WORKLOAD_ID,
                warmupExcluded: true,
                warmupCount: 1,
                warmup: measurement.warmup,
                samples,
                exactMatchLatenciesMs: measurement.exactMatchLatenciesMs,
            },
            evidence: {
                schema: VECTORIZE_LOCAL_REMOTE_BENCHMARK_SCHEMA,
                label: "local-wrangler-remote-vectorize",
                runtime: "wrangler-dev/workerd",
                backend: "cloudflare-vectorize",
                realVectorize: true,
                candidateSha256: prepared.candidate.digest,
                workload: VECTORIZE_LOCAL_REMOTE_WORKLOAD,
                readinessSettlement: {
                    elapsedMs: readinessIsolation.queryVisibilityElapsedMs,
                    attempts: readinessIsolation.queryVisibilityAttempts,
                    transientHttpFailureCount: readinessIsolation.transientHttpFailureCount,
                    transientHttpFailureCounts: readinessIsolation.transientHttpFailureCounts,
                    transientHttpFailureOverflowCount: readinessIsolation.transientHttpFailureOverflowCount,
                    hardBoundClaimed: false,
                },
                queryStability: {
                    queryStabilityWindowMs: readinessIsolation.queryStabilityWindowMs,
                    queryStabilityIntervalMs: QUERY_STABILITY_INTERVAL_MS,
                    queryStabilityObservedMs: readinessIsolation.queryStabilityObservedMs,
                    queryStabilityExactMatchCount: readinessIsolation.queryStabilityExactMatchCount,
                    queryStabilityResetCount: readinessIsolation.queryStabilityResetCount,
                    queryStabilityNonExactCount: readinessIsolation.queryStabilityNonExactCount,
                    hardBoundClaimed: false,
                },
                postStabilitySampling: measurement.postStabilitySampling,
                sampling: { warmup: raw[0], samples },
                physicalIds: [...new Set([...intent.physicalIds, ...deleteIntent.physicalIds])].sort(),
                correctness: {
                    migrationActivated: true,
                    ownershipRecordedBeforeSend: true,
                    readyBeforeTiming: true,
                    owningOrganizationExactMatch: true,
                    isolatedOrganizationEmpty: true,
                    assertionsOutsideTiming: true,
                    deletedAndAbsent: true,
                    runtimeStopped: false,
                },
            },
        };
    } finally {
        await runtime.stop();
        stopped = true;
    }
    result.evidence.correctness.runtimeStopped = stopped;
    return assertSecretFreeVectorEvidence(
        assertVectorizeLocalRemoteBenchmark(result, prepared.candidate.digest),
        secretValues
    );
}
