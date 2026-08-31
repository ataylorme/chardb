import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { awaitCloudflareVectorizeWranglerChild } from "./cloudflare-vectorize-proof-orchestrator.mjs";
import { fileReshardBenchmarkProfile } from "./file-reshard-benchmark-report.mjs";
import {
    FILE_RESHARD_DEPLOYMENT_TEARDOWN_SCHEMA,
    assertFileReshardDeploymentPair,
    assertFileReshardDeploymentTeardown,
} from "./file-reshard-deployment-proof.mjs";
import { startLocalFileProofRuntime } from "./local-file-proof-runtime.mjs";
import {
    deriveFileReshardProofTarget,
    prepareFileReshardProofApp,
    validatePreparedFileReshardProof,
} from "./prepare-file-reshard-deployment-proof.mjs";
import { assertMatchingBrowserReport } from "./preview-gate-report.mjs";
import { assertNoSensitiveEvidence, remoteAbsenceConfirmed, scrubSensitive } from "./run-cloudflare-file-proof.mjs";
import {
    assertIndexDescriptor,
    assertMetadataIndex,
    exactIndexNames,
    isIndexAbsent,
} from "./run-cloudflare-vectorize-proof.mjs";
import {
    FILE_RESHARD_VECTOR_DIMENSIONS,
    fileReshardDeploymentRunKey,
    runFileReshardDeploymentProof,
    wranglerDisposableCleanupCommands,
    wranglerDisposableDeploymentCommands,
} from "./run-file-reshard-deployment-proof.mjs";

export const FILE_RESHARD_PROOF_ORCHESTRATOR_SCHEMA = "chardb.file-vector-reshard-proof.orchestration.v1";
export const FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA = "chardb.file-vector-reshard-proof.ownership.v1";

const ROOT = path.resolve(import.meta.dirname, "..");
const BROWSER_SCRIPT = path.join(ROOT, "scripts", "smoke-packed-browser.mjs");
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const BROWSER_TIMEOUT_MS = 20 * 60_000;
const POLL_TIMEOUT_MS = 2 * 60_000;
const WORKLOAD_CLEANUP_INTERVAL_MS = 250;
const WORKLOAD_CLEANUP_REQUEST_TIMEOUT_MS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{16}$/;
const RUN_ID = /^[A-Za-z0-9_-]{16,80}$/;
const OWNERSHIP_BOOLEAN_FIELDS = Object.freeze([
    "workerAbsentConfirmed",
    "bucketAbsentConfirmed",
    "vectorizeIndexAbsentConfirmed",
    "bucketCreateIntent",
    "bucketCreated",
    "vectorizeIndexCreateIntent",
    "vectorizeIndexCreated",
    "metadataIndexCreateIntent",
    "metadataIndexCreated",
    "workerCreateIntent",
    "workerCreated",
]);
const OWNERSHIP_FIELDS = Object.freeze(
    [
        "schema",
        "candidateSha256",
        "nonce",
        "runId",
        "worker",
        "bucket",
        "vectorizeIndex",
        ...OWNERSHIP_BOOLEAN_FIELDS,
    ].sort()
);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function failureMessages(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof AggregateError)) return [message];
    return [message, ...error.errors.map(cause => (cause instanceof Error ? cause.message : String(cause)))];
}

function argumentValue(argv, flag) {
    const positions = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (positions.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (positions.length === 0) return undefined;
    const result = argv[positions[0] + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

function separateTrees(left, right) {
    return left !== right && !left.startsWith(`${right}${path.sep}`) && !right.startsWith(`${left}${path.sep}`);
}

export function parseFileReshardProofOrchestratorArgs(argv) {
    const valued = new Set([
        "--tarball",
        "--output",
        "--private-dir",
        "--workers-dev-subdomain",
        "--account-id",
        "--cloudflare-api-token-file",
    ]);
    const allowed = new Set([...valued, "--confirm-disposable-resources", "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument)) throw new Error(`unknown reshard proof argument ${JSON.stringify(argument)}`);
        if (valued.has(argument)) {
            const next = argv[++index];
            if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
        }
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const options = {
        help,
        tarball: argumentValue(argv, "--tarball"),
        output: argumentValue(argv, "--output"),
        privateDir: argumentValue(argv, "--private-dir"),
        workersDevSubdomain: argumentValue(argv, "--workers-dev-subdomain"),
        accountId: argumentValue(argv, "--account-id")?.toLowerCase(),
        cloudflareApiTokenFile: argumentValue(argv, "--cloudflare-api-token-file"),
        confirmed: argv.includes("--confirm-disposable-resources"),
    };
    if (help) return Object.freeze(options);
    for (const [flag, item] of [
        ["--tarball", options.tarball],
        ["--output", options.output],
        ["--private-dir", options.privateDir],
        ["--workers-dev-subdomain", options.workersDevSubdomain],
        ["--account-id", options.accountId],
    ]) {
        if (!item) throw new Error(`${flag} is required`);
    }
    if (!options.confirmed) throw new Error("--confirm-disposable-resources is required");
    if (!ACCOUNT_ID.test(options.accountId)) throw new Error("--account-id must be exactly 32 hexadecimal characters");
    if (!SUBDOMAIN.test(options.workersDevSubdomain)) {
        throw new Error("--workers-dev-subdomain must be one lowercase Cloudflare subdomain label");
    }
    for (const field of ["tarball", "output", "privateDir", "cloudflareApiTokenFile"]) {
        if (options[field] !== undefined) options[field] = path.resolve(options[field]);
    }
    if (!separateTrees(options.output, options.privateDir)) {
        throw new Error("--output and --private-dir must be separate trees");
    }
    return Object.freeze(options);
}

async function atomicJson(file, value, mode = 0o600) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, file);
}

async function assertNewDirectory(directory, label, mode) {
    await mkdir(directory, { recursive: true, mode });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${label} must be a directory, not a symlink`);
    }
    if ((await readdir(directory)).length !== 0) throw new Error(`${label} must be empty`);
    if (mode !== undefined) await chmod(directory, mode);
    return realpath(directory);
}

async function canonicalPlannedPath(target) {
    let current = path.resolve(target);
    const missing = [];
    while (true) {
        try {
            return path.join(await realpath(current), ...missing);
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            const parent = path.dirname(current);
            if (parent === current) throw error;
            missing.unshift(path.basename(current));
            current = parent;
        }
    }
}

export function renderFileReshardLocalWrangler(input) {
    return [
        `name = ${JSON.stringify(input.target)}`,
        'main = "src/worker.ts"',
        'compatibility_date = "2026-08-27"',
        'compatibility_flags = ["nodejs_compat"]',
        "",
        "[[migrations]]",
        'tag = "init"',
        'new_sqlite_classes = ["Cdb", "Catalog", "Gateway", "Resharder", "VectorIndexProbe"]',
        "",
        "[[durable_objects.bindings]]",
        'name = "CDB_CATALOG"',
        'class_name = "Catalog"',
        "",
        "[[durable_objects.bindings]]",
        'name = "CDB_SHARD"',
        'class_name = "Cdb"',
        "",
        "[[durable_objects.bindings]]",
        'name = "CDB_GATEWAY"',
        'class_name = "Gateway"',
        "",
        "[[durable_objects.bindings]]",
        'name = "CDB_RESHARD"',
        'class_name = "Resharder"',
        "",
        "[[durable_objects.bindings]]",
        'name = "CDB_VECTOR_PROBE"',
        'class_name = "VectorIndexProbe"',
        "",
        "[[r2_buckets]]",
        'binding = "CDB_FILES"',
        `bucket_name = ${JSON.stringify(input.target)}`,
        "",
        "[version_metadata]",
        'binding = "CF_VERSION_METADATA"',
        "",
        "[vars]",
        'CDB_PROOF_TARGET_KIND = "local"',
        'CDB_PROOF_RUNTIME = "wrangler-miniflare-workerd"',
        'CDB_PROOF_LOCAL_VERSION = "local-dev"',
        `CDB_PROOF_CONFIGURATION_SHA256 = ${JSON.stringify(input.configurationSha256)}`,
        `CDB_RELEASE_SHA256 = ${JSON.stringify(input.candidateSha256)}`,
        `CDB_PROOF_RUN_ID = ${JSON.stringify(input.runId)}`,
        `CDB_PROOF_R2_BUCKET = ${JSON.stringify(input.target)}`,
        `CDB_PROOF_VECTORIZE_INDEX = ${JSON.stringify(input.target)}`,
        "",
        "[observability.logs]",
        "enabled = true",
        "",
    ].join("\n");
}

async function defaultRunCommand(command, args, options = {}) {
    const child = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: options.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const result = await awaitCloudflareVectorizeWranglerChild(child, {
        timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
        const detail = scrubSensitive(`${result.stdout}\n${result.stderr}`.trim(), options.secrets ?? []);
        throw new Error(
            `${options.label ?? command} failed with exit ${result.exitCode}${detail ? `: ${detail}` : ""}`
        );
    }
    return result;
}

async function readSecret(file, label) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
    const raw = await readFile(file, "utf8");
    const value = raw.trim();
    if (value.length < 16 || value.length > 4_096 || /\s/.test(value)) throw new Error(`${label} is invalid`);
    return value;
}

function cloudflareEnvironment(options, apiToken) {
    const environment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: options.accountId };
    for (const key of [
        "CLOUDFLARE_API_TOKEN",
        "CF_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CF_API_KEY",
        "CF_ACCOUNT_ID",
    ]) {
        Reflect.deleteProperty(environment, key);
    }
    if (apiToken !== undefined) environment.CLOUDFLARE_API_TOKEN = apiToken;
    return environment;
}

function jsonResult(result, label) {
    check(result.exitCode === 0, `${label} failed`);
    let value;
    try {
        value = JSON.parse(result.stdout);
    } catch {
        throw new Error(`${label} returned invalid JSON`);
    }
    return value;
}

async function pollRead(checkValue, dependencies, label) {
    const now = dependencies.now ?? Date.now;
    const sleep = dependencies.sleep ?? (milliseconds => Bun.sleep(milliseconds));
    const deadline = now() + (dependencies.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    let lastError;
    while (now() < deadline) {
        try {
            const value = await checkValue();
            if (value !== undefined) return value;
        } catch (error) {
            lastError = error;
        }
        await sleep(1_000);
    }
    throw lastError ?? new Error(`${label} did not settle before the deadline`);
}

function initialOwnership(prepared) {
    return {
        schema: FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA,
        candidateSha256: prepared.candidate.digest,
        nonce: prepared.receipt.nonce,
        runId: prepared.receipt.runId,
        worker: prepared.receipt.target.worker,
        bucket: prepared.receipt.target.bucket,
        vectorizeIndex: prepared.receipt.target.vectorizeIndex,
        workerAbsentConfirmed: false,
        bucketAbsentConfirmed: false,
        vectorizeIndexAbsentConfirmed: false,
        bucketCreateIntent: false,
        bucketCreated: false,
        vectorizeIndexCreateIntent: false,
        vectorizeIndexCreated: false,
        metadataIndexCreateIntent: false,
        metadataIndexCreated: false,
        workerCreateIntent: false,
        workerCreated: false,
    };
}

export function assertFileReshardProofOwnership(value, expected) {
    check(value && typeof value === "object" && !Array.isArray(value), "proof ownership ledger must be an object");
    check(
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify(OWNERSHIP_FIELDS),
        `proof ownership ledger fields must be exactly ${OWNERSHIP_FIELDS.join(", ")}`
    );
    check(value.schema === FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA, "proof ownership ledger schema drifted");
    check(SHA256.test(value.candidateSha256 ?? ""), "proof ownership candidate digest is invalid");
    check(NONCE.test(value.nonce ?? "") && RUN_ID.test(value.runId ?? ""), "proof ownership run identity is invalid");
    const target = deriveFileReshardProofTarget(value.candidateSha256, value.nonce);
    check(
        value.worker === target && value.bucket === target && value.vectorizeIndex === target,
        "proof ownership resource names are not derived from the candidate and nonce"
    );
    check(expected && typeof expected === "object", "prepared proof ownership identity is required");
    for (const field of ["candidateSha256", "nonce", "runId", "worker", "bucket", "vectorizeIndex"]) {
        check(value[field] === expected[field], `proof ownership ${field} drifted from the prepared run`);
    }
    for (const field of OWNERSHIP_BOOLEAN_FIELDS) {
        check(typeof value[field] === "boolean", `proof ownership ${field} must be boolean`);
    }
    for (const [resource, absent, intent, created] of [
        ["Worker", "workerAbsentConfirmed", "workerCreateIntent", "workerCreated"],
        ["R2 bucket", "bucketAbsentConfirmed", "bucketCreateIntent", "bucketCreated"],
        ["Vectorize index", "vectorizeIndexAbsentConfirmed", "vectorizeIndexCreateIntent", "vectorizeIndexCreated"],
    ]) {
        check(!value[intent] || value[absent], `proof ownership ${resource} intent lacks an absence preflight`);
        check(!value[created] || value[intent], `proof ownership ${resource} creation state is impossible`);
    }
    check(
        !value.metadataIndexCreateIntent || value.vectorizeIndexCreateIntent,
        "proof ownership metadata-index intent lacks Vectorize index intent"
    );
    check(
        !value.metadataIndexCreated || (value.metadataIndexCreateIntent && value.vectorizeIndexCreated),
        "proof ownership metadata-index creation state is impossible"
    );
    return value;
}

async function readOwnership(file, expected) {
    return assertFileReshardProofOwnership(JSON.parse(await readFile(file, "utf8")), expected);
}

async function updateOwnership(file, patch, expected) {
    const current = await readOwnership(file, expected);
    const next = { ...current, ...patch };
    assertFileReshardProofOwnership(next, expected);
    await atomicJson(file, next);
    return next;
}

export async function provisionFileReshardProofResources(input, dependencies = {}) {
    const run = dependencies.runCommand ?? defaultRunCommand;
    const environment = cloudflareEnvironment(input.options, input.apiToken);
    const execute = (args, options = {}) =>
        run(input.wrangler, args, {
            cwd: input.prepared.app,
            env: environment,
            secrets: input.secrets,
            ...options,
        });
    let ownership = await readOwnership(input.ownershipPath, input.expectedOwnership);
    const workerCheck = await execute(["versions", "list", "--name", ownership.worker, "--json"], {
        allowFailure: true,
        label: "Worker absence preflight",
    });
    check(remoteAbsenceConfirmed("worker", workerCheck).length === 0, "disposable Worker name already exists");
    const buckets = remoteAbsenceConfirmed(
        "bucket",
        await execute(["r2", "bucket", "list"], { label: "R2 bucket absence preflight" })
    );
    check(!buckets.some(item => item?.name === ownership.bucket), "disposable R2 bucket name already exists");
    const indexes = exactIndexNames(
        jsonResult(
            await execute(["vectorize", "list", "--json"], { label: "Vectorize index list preflight" }),
            "Vectorize index list preflight"
        ),
        "Vectorize index list preflight"
    );
    check(!indexes.includes(ownership.vectorizeIndex), "disposable Vectorize index name already exists");
    const directIndex = await execute(["vectorize", "get", ownership.vectorizeIndex, "--json"], {
        allowFailure: true,
        label: "Vectorize index absence preflight",
    });
    check(isIndexAbsent(directIndex), "Vectorize index direct preflight did not prove absence");
    ownership = await updateOwnership(
        input.ownershipPath,
        {
            workerAbsentConfirmed: true,
            bucketAbsentConfirmed: true,
            vectorizeIndexAbsentConfirmed: true,
        },
        input.expectedOwnership
    );

    const commands = wranglerDisposableDeploymentCommands({
        worker: ownership.worker,
        bucket: ownership.bucket,
        index: ownership.vectorizeIndex,
        config: path.join(input.prepared.app, "wrangler.toml"),
        secretsFile: input.secretsFile,
        tag: `proof-${ownership.nonce}`,
    });
    ownership = await updateOwnership(input.ownershipPath, { bucketCreateIntent: true }, input.expectedOwnership);
    await execute(commands[0], { label: "R2 bucket creation" });
    ownership = await updateOwnership(
        input.ownershipPath,
        { bucketCreated: true, vectorizeIndexCreateIntent: true },
        input.expectedOwnership
    );
    await execute(commands[1], { label: "Vectorize index creation" });
    ownership = await updateOwnership(input.ownershipPath, { vectorizeIndexCreated: true }, input.expectedOwnership);
    await pollRead(
        async () => {
            const result = await execute(["vectorize", "get", ownership.vectorizeIndex, "--json"], {
                allowFailure: true,
                label: "Vectorize readiness",
            });
            if (result.exitCode !== 0) return undefined;
            return assertIndexDescriptor(
                jsonResult(result, "Vectorize readiness"),
                ownership.vectorizeIndex,
                "Vectorize readiness",
                { dimensions: FILE_RESHARD_VECTOR_DIMENSIONS, metric: "cosine" }
            );
        },
        dependencies,
        "Vectorize index"
    );
    ownership = await updateOwnership(
        input.ownershipPath,
        { metadataIndexCreateIntent: true },
        input.expectedOwnership
    );
    await execute(commands[2], { label: "Vectorize metadata index creation" });
    await pollRead(
        async () => {
            const result = await execute(["vectorize", "list-metadata-index", ownership.vectorizeIndex, "--json"], {
                allowFailure: true,
                label: "Vectorize metadata index readiness",
            });
            if (result.exitCode !== 0) return undefined;
            return assertMetadataIndex(
                jsonResult(result, "Vectorize metadata index readiness"),
                "Vectorize metadata index readiness"
            );
        },
        dependencies,
        "Vectorize metadata index"
    );
    ownership = await updateOwnership(
        input.ownershipPath,
        { metadataIndexCreated: true, workerCreateIntent: true },
        input.expectedOwnership
    );
    await execute(commands[3], { label: "Worker deployment" });
    await updateOwnership(input.ownershipPath, { workerCreated: true }, input.expectedOwnership);

    const version = await pollRead(
        async () => {
            const result = await execute(["versions", "list", "--name", ownership.worker, "--json"], {
                allowFailure: true,
                label: "Worker version evidence",
            });
            if (result.exitCode !== 0) return undefined;
            let versions;
            try {
                versions = JSON.parse(result.stdout);
            } catch {
                throw new Error("Worker version evidence returned invalid JSON");
            }
            if (!Array.isArray(versions) || versions.length === 0) return undefined;
            const sorted = [...versions].sort((left, right) => Number(right?.number ?? 0) - Number(left?.number ?? 0));
            const id = sorted[0]?.id;
            return typeof id === "string" && id.length >= 8 ? id : undefined;
        },
        dependencies,
        "Worker version"
    );
    return Object.freeze({ deploymentVersion: version });
}

export async function cleanupFileReshardProofResources(input, dependencies = {}) {
    const run = dependencies.runCommand ?? defaultRunCommand;
    const ownership = await readOwnership(input.ownershipPath, input.expectedOwnership);
    const environment = cloudflareEnvironment(input.options, input.apiToken);
    const execute = (args, options = {}) =>
        run(input.wrangler, args, {
            cwd: input.prepared.app,
            env: environment,
            secrets: input.secrets,
            allowFailure: true,
            ...options,
        });
    const cleanupCommands = wranglerDisposableCleanupCommands(
        ownership.worker,
        ownership.bucket,
        ownership.vectorizeIndex
    );
    for (const [intent, args] of [
        [ownership.workerCreateIntent, cleanupCommands[0]],
        [ownership.bucketCreateIntent, cleanupCommands[1]],
        [ownership.vectorizeIndexCreateIntent, cleanupCommands[2]],
    ]) {
        if (intent) await execute(args);
    }
    const workerAbsent = await pollRead(
        async () => {
            const absent =
                remoteAbsenceConfirmed(
                    "worker",
                    await execute(["versions", "list", "--name", ownership.worker, "--json"])
                ).length === 0;
            return absent ? true : undefined;
        },
        dependencies,
        "Worker cleanup"
    );
    const bucketAbsent = await pollRead(
        async () => {
            const absent = !remoteAbsenceConfirmed("bucket", await execute(["r2", "bucket", "list"])).some(
                item => item?.name === ownership.bucket
            );
            return absent ? true : undefined;
        },
        dependencies,
        "R2 bucket cleanup"
    );
    const vectorizeIndexAbsent = await pollRead(
        async () => {
            const indexGet = await execute(["vectorize", "get", ownership.vectorizeIndex, "--json"]);
            const indexes = exactIndexNames(
                jsonResult(await execute(["vectorize", "list", "--json"]), "Vectorize cleanup list"),
                "Vectorize cleanup list"
            );
            return isIndexAbsent(indexGet) && !indexes.includes(ownership.vectorizeIndex) ? true : undefined;
        },
        dependencies,
        "Vectorize index cleanup"
    );
    return Object.freeze({
        workerDeleted: workerAbsent,
        bucketDeleted: bucketAbsent,
        vectorizeIndexDeleted: vectorizeIndexAbsent,
        workerAbsentVerified: workerAbsent,
        bucketAbsentVerified: bucketAbsent,
        vectorizeIndexAbsentVerified: vectorizeIndexAbsent,
    });
}

export async function runFileReshardBrowserProof(input, dependencies = {}) {
    const reportPath = path.resolve(input.reportPath);
    const run = dependencies.runCommand ?? defaultRunCommand;
    const result = await run(process.execPath, [BROWSER_SCRIPT, input.tarball], {
        cwd: ROOT,
        env: { ...process.env, CDB_BROWSER_PROOF_REPORT: reportPath },
        timeoutMs: BROWSER_TIMEOUT_MS,
        label: "packed browser proof",
    });
    check(result.exitCode === 0, "packed browser proof failed");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assertMatchingBrowserReport(report, input.candidate);
    return report;
}

async function cleanupTargetRuns(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = input.now ?? Date.now;
    const sleep = input.sleep ?? (milliseconds => Bun.sleep(milliseconds));
    const timeoutMs = input.timeoutMs ?? POLL_TIMEOUT_MS;
    const intervalMs = input.intervalMs ?? WORKLOAD_CLEANUP_INTERVAL_MS;
    const requestTimeoutMs = input.requestTimeoutMs ?? WORKLOAD_CLEANUP_REQUEST_TIMEOUT_MS;
    for (const [label, value] of [
        ["timeout", timeoutMs],
        ["interval", intervalMs],
        ["request timeout", requestTimeoutMs],
    ]) {
        check(Number.isSafeInteger(value) && value > 0, `${input.kind} workload cleanup ${label} is invalid`);
    }
    const started = now();
    const deadline = started + timeoutMs;
    const maximumAttempts = Math.ceil(timeoutMs / intervalMs) + 2;
    const cleanupRun = async runKey => {
        let lastError;
        for (let attempt = 0; attempt < maximumAttempts; attempt++) {
            const remainingMs = deadline - now();
            if (remainingMs <= 0) break;
            let response;
            try {
                response = await fetchImpl(new URL("/proof/file-reshard/cleanup", input.origin), {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${input.token}`,
                        "content-type": "application/json",
                        "x-chardb-proof-run-id": input.runId,
                    },
                    body: JSON.stringify({ runId: input.runId, runKey }),
                    signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs))),
                });
            } catch (error) {
                lastError = error;
            }
            if (response) {
                if (!response.ok) {
                    const error = new Error(`${input.kind} workload cleanup failed with ${response.status}`);
                    if (
                        response.status !== 408 &&
                        response.status !== 425 &&
                        response.status !== 429 &&
                        response.status < 500
                    ) {
                        throw error;
                    }
                    lastError = error;
                } else {
                    let current;
                    try {
                        current = await response.json();
                    } catch {
                        lastError = new Error(`${input.kind} workload cleanup returned invalid JSON`);
                    }
                    if (current?.done === true && current?.remaining === 0) return current;
                    if (current !== undefined) {
                        lastError = new Error(`${input.kind} workload cleanup did not finish`);
                    }
                }
            }
            const afterAttemptMs = deadline - now();
            if (attempt === maximumAttempts - 1 || afterAttemptMs <= 0) break;
            await sleep(Math.min(intervalMs, afterAttemptMs));
        }
        throw new Error(`${input.kind} workload cleanup timed out after ${timeoutMs}ms`, {
            cause: lastError,
        });
    };
    let replay = { done: true, remaining: 0 };
    for (const runKey of input.runKeys) {
        await cleanupRun(runKey);
        replay = await cleanupRun(runKey);
    }
    return replay;
}

export async function cleanupFileReshardProofWorkloads(input, dependencies = {}) {
    const pairedRunKeys = input.pair
        ? [input.pair.warmup.local.runKey, ...input.pair.runs.map(run => run.local.runKey)]
        : undefined;
    const runKeys = input.runKeys ?? pairedRunKeys;
    check(Array.isArray(runKeys) && runKeys.length > 0, "file reshard proof cleanup run keys are required");
    check(
        runKeys.every(runKey => typeof runKey === "string" && runKey.length > 0),
        "file reshard proof cleanup run keys are invalid"
    );
    check(new Set(runKeys).size === runKeys.length, "file reshard proof cleanup run keys are not unique");
    if (pairedRunKeys) {
        check(
            JSON.stringify(runKeys) === JSON.stringify(pairedRunKeys),
            "file reshard proof cleanup run keys drifted from paired evidence"
        );
    }
    const targets = [
        cleanupTargetRuns({
            kind: "local",
            origin: input.localOrigin,
            token: input.token,
            runId: input.runId,
            runKeys,
            fetchImpl: dependencies.fetch,
            now: dependencies.now,
            sleep: dependencies.sleep,
            timeoutMs: dependencies.cleanupTimeoutMs,
            intervalMs: dependencies.cleanupIntervalMs,
            requestTimeoutMs: dependencies.requestTimeoutMs,
        }),
        cleanupTargetRuns({
            kind: "deployed",
            origin: input.deployedOrigin,
            token: input.token,
            runId: input.runId,
            runKeys,
            fetchImpl: dependencies.fetch,
            now: dependencies.now,
            sleep: dependencies.sleep,
            timeoutMs: dependencies.cleanupTimeoutMs,
            intervalMs: dependencies.cleanupIntervalMs,
            requestTimeoutMs: dependencies.requestTimeoutMs,
        }),
    ];
    const settled = await Promise.allSettled(targets);
    const failures = settled.flatMap((result, index) =>
        result.status === "rejected" ? [{ kind: index === 0 ? "local" : "deployed", error: result.reason }] : []
    );
    if (failures.length > 0) {
        throw new AggregateError(
            failures.map(failure => failure.error),
            `file reshard workload cleanup failed for ${failures.map(failure => failure.kind).join(", ")}`
        );
    }
    const [local, deployed] = settled.map(result => result.value);
    return Object.freeze({
        done: local.done === true && deployed.done === true,
        remaining: local.remaining + deployed.remaining,
    });
}

async function checksumFile(root, relative) {
    return `${sha256(await readFile(path.join(root, relative)))}  ${relative}`;
}

async function writeSupplementalEvidence(output) {
    await writeFile(
        path.join(output, "supplemental.sha256"),
        `${await checksumFile(output, "browser-proof.json")}\n${await checksumFile(
            output,
            "orchestration.json"
        )}\n${await checksumFile(output, "teardown.json")}\n`
    );
    await writeFile(path.join(output, "teardown.sha256"), `${await checksumFile(output, "teardown.json")}\n`);
}

function proofRunInput(input) {
    return {
        package: input.options.tarball,
        preparation: input.prepared.preparation,
        output: input.options.output,
        wrangler: input.wrangler,
        localUrl: input.local.origin,
        deployedUrl: input.deployedOrigin,
        localTokenFile: input.tokenFile,
        deployedTokenFile: input.tokenFile,
        cloudflareApiTokenFile: input.options.cloudflareApiTokenFile,
        cloudflareAccountId: input.options.accountId,
        worker: input.prepared.evidence.target.worker,
        bucket: input.prepared.evidence.target.bucket,
        vectorizeIndex: input.prepared.evidence.target.vectorizeIndex,
        deploymentVersion: input.provisioned.deploymentVersion,
        configurationSha256: input.prepared.evidence.configurationSha256,
        runId: input.prepared.evidence.runId,
        profileName: "small",
        confirmed: true,
    };
}

export async function orchestrateFileReshardCloudflareProof(options, dependencies = {}) {
    check(options.confirmed === true, "disposable reshard proof confirmation is required");
    check(ACCOUNT_ID.test(options.accountId ?? ""), "Cloudflare account ID must be exactly 32 hexadecimal characters");
    check(SUBDOMAIN.test(options.workersDevSubdomain ?? ""), "Cloudflare workers.dev subdomain is invalid");
    for (const field of ["tarball", "output", "privateDir"]) {
        check(typeof options[field] === "string" && path.isAbsolute(options[field]), `${field} must be absolute`);
    }
    check(
        separateTrees(options.output, options.privateDir),
        "proof output and private directory must be separate trees"
    );
    const tarballMetadata = await lstat(options.tarball);
    check(tarballMetadata.isFile() && !tarballMetadata.isSymbolicLink(), "candidate tarball must be a regular file");
    const canonicalPrivateDir = await assertNewDirectory(options.privateDir, "reshard proof private directory", 0o700);
    const canonicalOutput = await canonicalPlannedPath(options.output);
    check(
        separateTrees(canonicalOutput, canonicalPrivateDir),
        "proof output and private directory must resolve to separate trees"
    );
    try {
        await lstat(options.output);
        throw new Error("reshard proof output directory must not exist");
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    const prepare = dependencies.prepare ?? prepareFileReshardProofApp;
    const prepared = await prepare({ package: options.tarball, privateDir: options.privateDir });
    const validated = await (dependencies.validatePreparation ?? validatePreparedFileReshardProof)({
        package: options.tarball,
        preparation: prepared.preparation,
    });
    check(
        validated.candidate.digest === prepared.evidence.candidate.digest &&
            validated.candidate.bytes === prepared.evidence.candidate.bytes,
        "prepared proof validation returned another candidate"
    );
    check(
        JSON.stringify(validated.evidence) === JSON.stringify(prepared.evidence),
        "prepared proof validation returned different public evidence"
    );
    const candidate = prepared.evidence.candidate;
    const adminToken = randomBytes(32).toString("base64url");
    const betterAuthSecret = randomBytes(32).toString("base64url");
    // The run ID is public evidence. Only authentication material is secret.
    const proofSecrets = [adminToken, betterAuthSecret];
    const secretsFile = path.join(options.privateDir, "secrets.env");
    const tokenFile = path.join(options.privateDir, "admin.token");
    await writeFile(
        secretsFile,
        `BETTER_AUTH_SECRET=${betterAuthSecret}\nCDB_ADMIN_TOKEN=${adminToken}\nCDB_PROOF_RUN_ID=${prepared.evidence.runId}\n`,
        { mode: 0o600 }
    );
    await writeFile(tokenFile, `${adminToken}\n`, { mode: 0o600 });
    const ownershipPath = path.join(options.privateDir, "ownership.json");
    await atomicJson(ownershipPath, initialOwnership(validated));
    const wrangler = path.join(validated.app, "node_modules", ".bin", "wrangler");
    const localConfig = path.join(validated.app, "wrangler.local.toml");
    await writeFile(
        localConfig,
        renderFileReshardLocalWrangler({
            target: prepared.evidence.target.worker,
            candidateSha256: candidate.digest,
            configurationSha256: prepared.evidence.configurationSha256,
            runId: prepared.evidence.runId,
        })
    );
    const apiToken = options.cloudflareApiTokenFile
        ? await readSecret(options.cloudflareApiTokenFile, "Cloudflare API token")
        : undefined;
    const secrets =
        apiToken === undefined ? [...proofSecrets, options.accountId] : [...proofSecrets, apiToken, options.accountId];
    const deployedOrigin = `https://${prepared.evidence.target.worker}.${options.workersDevSubdomain}.workers.dev`;
    const profile = fileReshardBenchmarkProfile("small");
    const runKeys = [-1, ...Array.from({ length: profile.logicalRuns }, (_, sequence) => sequence)].map(sequence =>
        fileReshardDeploymentRunKey(prepared.evidence.runId, sequence)
    );
    const browserPrivatePath = path.join(options.privateDir, "browser-proof.json");
    const runBrowser = dependencies.runBrowserProof ?? runFileReshardBrowserProof;
    const startLocal = dependencies.startLocal ?? startLocalFileProofRuntime;
    const provision = dependencies.provision ?? provisionFileReshardProofResources;
    const runProof = dependencies.runProof ?? runFileReshardDeploymentProof;
    const cleanupWorkloads = dependencies.cleanupWorkloads ?? cleanupFileReshardProofWorkloads;
    const cleanupRemote = dependencies.cleanupRemote ?? cleanupFileReshardProofResources;
    const scan = dependencies.scanSecrets ?? assertNoSensitiveEvidence;
    const expectedOwnership = Object.freeze({
        candidateSha256: candidate.digest,
        nonce: prepared.evidence.nonce,
        runId: prepared.evidence.runId,
        worker: prepared.evidence.target.worker,
        bucket: prepared.evidence.target.bucket,
        vectorizeIndex: prepared.evidence.target.vectorizeIndex,
    });
    const phaseInput = {
        options,
        prepared: validated,
        wrangler,
        ownershipPath,
        expectedOwnership,
        apiToken,
        secrets,
        secretsFile,
    };
    let browser;
    let local;
    let pair;
    let replay = { done: false, remaining: -1 };
    let proofAttempted = false;
    let workloadCleanupComplete = false;
    let primaryError;
    let workloadCleanupError;
    let localCleanupError;
    let remoteCleanupError;
    let remoteCleanup = {
        workerDeleted: false,
        bucketDeleted: false,
        vectorizeIndexDeleted: false,
        workerAbsentVerified: false,
        bucketAbsentVerified: false,
        vectorizeIndexAbsentVerified: false,
    };
    try {
        browser = await runBrowser({ tarball: options.tarball, reportPath: browserPrivatePath, candidate });
        assertMatchingBrowserReport(browser, candidate);
        local = await startLocal(
            {
                app: validated.app,
                config: localConfig,
                persistenceDir: path.join(options.privateDir, "local-state"),
                secretsFile,
                wrangler,
                releaseSha256: candidate.digest,
                healthPath: "/proof/file-reshard/capabilities",
                healthHeaders: {
                    authorization: `Bearer ${adminToken}`,
                    "x-chardb-proof-run-id": prepared.evidence.runId,
                },
                healthReady: body =>
                    body?.schema === "chardb.file-vector-reshard-proof-capabilities.v2" &&
                    body.releaseSha256 === candidate.digest &&
                    body.runId === prepared.evidence.runId &&
                    body.target?.kind === "local" &&
                    body.target?.configurationSha256 === prepared.evidence.configurationSha256,
            },
            dependencies.localRuntimeDependencies
        );
        const provisioned = await provision(phaseInput, dependencies.provisionDependencies);
        proofAttempted = true;
        pair = assertFileReshardDeploymentPair(
            await runProof(
                proofRunInput({
                    options,
                    prepared,
                    wrangler,
                    local,
                    deployedOrigin,
                    tokenFile,
                    provisioned,
                })
            )
        );
        replay = await cleanupWorkloads(
            {
                pair,
                runKeys,
                localOrigin: local.origin,
                deployedOrigin,
                token: adminToken,
                runId: prepared.evidence.runId,
            },
            dependencies.workloadCleanupDependencies
        );
        check(replay.done === true && replay.remaining === 0, "proof workload cleanup did not finish idempotently");
        workloadCleanupComplete = true;
    } catch (error) {
        primaryError = error;
    } finally {
        if (local && proofAttempted && !workloadCleanupComplete) {
            try {
                replay = await cleanupWorkloads(
                    {
                        runKeys,
                        localOrigin: local.origin,
                        deployedOrigin,
                        token: adminToken,
                        runId: prepared.evidence.runId,
                    },
                    dependencies.workloadCleanupDependencies
                );
                check(
                    replay.done === true && replay.remaining === 0,
                    "proof workload cleanup did not finish idempotently"
                );
                workloadCleanupComplete = true;
            } catch (error) {
                workloadCleanupError = error;
            }
        }
        if (local) {
            try {
                await local.stop();
            } catch (error) {
                localCleanupError = error;
            }
        }
        try {
            remoteCleanup = await cleanupRemote(phaseInput, dependencies.cleanupDependencies);
        } catch (error) {
            remoteCleanupError = error;
        }
    }
    const cleanupPassed =
        !localCleanupError &&
        !remoteCleanupError &&
        remoteCleanup.workerDeleted === true &&
        remoteCleanup.bucketDeleted === true &&
        remoteCleanup.vectorizeIndexDeleted === true &&
        remoteCleanup.workerAbsentVerified === true &&
        remoteCleanup.bucketAbsentVerified === true &&
        remoteCleanup.vectorizeIndexAbsentVerified === true;
    const success = Boolean(
        !primaryError && cleanupPassed && replay.done === true && replay.remaining === 0 && browser && pair
    );
    await mkdir(options.output, { recursive: true });
    if (browser) await cp(browserPrivatePath, path.join(options.output, "browser-proof.json"));
    const failureText =
        primaryError || workloadCleanupError || localCleanupError || remoteCleanupError
            ? scrubSensitive(
                  [primaryError, workloadCleanupError, localCleanupError, remoteCleanupError]
                      .filter(Boolean)
                      .flatMap(failureMessages)
                      .join("; "),
                  secrets
              )
            : null;
    const orchestration = {
        schema: FILE_RESHARD_PROOF_ORCHESTRATOR_SCHEMA,
        ok: success,
        candidate,
        target: prepared.evidence.target,
        phases: {
            browser: Boolean(browser),
            localStopped: local ? !localCleanupError : true,
            pair: Boolean(pair),
            workloadCleanup: replay.done === true && replay.remaining === 0,
            remoteCleanup: cleanupPassed,
        },
        secretScanPassed: false,
        error: failureText,
    };
    await atomicJson(path.join(options.output, "orchestration.json"), orchestration);
    let scanError;
    let teardown;
    try {
        await scan(options.output, secrets);
        orchestration.secretScanPassed = true;
        await atomicJson(path.join(options.output, "orchestration.json"), orchestration);
        if (success) {
            teardown = assertFileReshardDeploymentTeardown(
                {
                    schema: FILE_RESHARD_DEPLOYMENT_TEARDOWN_SCHEMA,
                    ok: true,
                    candidateSha256: candidate.digest,
                    worker: prepared.evidence.target.worker,
                    bucket: prepared.evidence.target.bucket,
                    vectorizeIndex: prepared.evidence.target.vectorizeIndex,
                    localStateStopped: true,
                    ...remoteCleanup,
                    idempotentReplay: replay,
                },
                { candidateSha256: candidate.digest }
            );
            await atomicJson(path.join(options.output, "teardown.json"), teardown);
            await writeSupplementalEvidence(options.output);
            await scan(options.output, secrets);
        }
    } catch (error) {
        scanError = error;
        orchestration.ok = false;
        orchestration.secretScanPassed = false;
        orchestration.error = scrubSensitive(error instanceof Error ? error.message : String(error), secrets);
        await Promise.allSettled(
            ["teardown.json", "teardown.sha256", "supplemental.sha256"].map(relative =>
                unlink(path.join(options.output, relative))
            )
        );
        await atomicJson(path.join(options.output, "orchestration.json"), orchestration);
    }
    if (!success || scanError) {
        const errors = [primaryError, workloadCleanupError, localCleanupError, remoteCleanupError, scanError]
            .filter(Boolean)
            .flatMap(failureMessages)
            .map(message => scrubSensitive(message, secrets));
        throw new Error(errors.join("; ") || "file/vector reshard proof did not complete every required phase");
    }
    return Object.freeze({
        schema: FILE_RESHARD_PROOF_ORCHESTRATOR_SCHEMA,
        ok: true,
        candidate,
        target: prepared.evidence.target,
        pair,
        browser,
        teardown,
        output: options.output,
    });
}

function usage() {
    return [
        "Usage: bun run proof:cloudflare:reshard -- --tarball <candidate.tgz> --output <evidence-dir> \\",
        "  --private-dir <private-dir> --workers-dev-subdomain <label> --account-id <32-hex-id> \\",
        "  --confirm-disposable-resources [--cloudflare-api-token-file <file>]",
        "",
        "Prepares one exact candidate, runs the packed browser and local Wrangler proofs, provisions one",
        "disposable Worker/R2/Vectorize target, runs the paired proof, then cleans up and verifies absence.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseFileReshardProofOrchestratorArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else console.log(JSON.stringify(await orchestrateFileReshardCloudflareProof(options), null, 2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
