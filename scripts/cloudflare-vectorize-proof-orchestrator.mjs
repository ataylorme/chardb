import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    CloudflareVectorizeProofCandidateClassificationError,
    CloudflareVectorizeProofObservationTimeoutError,
    assertCloudflareVectorizeProofCandidateClassificationEvidence,
    assertCloudflareVectorizeProofObservationTimeoutEvidence,
    createCloudflareVectorizeProofController,
} from "./cloudflare-vectorize-proof-controller.mjs";
import {
    CLOUDFLARE_VECTORIZE_PROOF_HTTP_PROTOCOL_REASONS,
    CloudflareVectorizeProofHttpError,
    CloudflareVectorizeProofSettlementError,
    createCloudflareVectorizeProofLifecycle,
} from "./cloudflare-vectorize-proof-lifecycle.mjs";
import { openCloudflareVectorizeProofLiveSubscription } from "./cloudflare-vectorize-proof-live.mjs";
import {
    assertCloudflareVectorizeProofReport,
    validateCloudflareVectorizeProofEvidence,
} from "./cloudflare-vectorize-proof-report.mjs";
import { withTemporaryWranglerLogRemoved } from "./cloudflare-vectorize-wrangler-log.mjs";
import { produceNativeVectorizeBenchmark } from "./produce-native-vectorize-benchmark.mjs";
import {
    appendVectorizeOwnedPhysicalIds,
    deriveDisposableVectorizeResourceNames,
    executeCloudflareVectorizeCleanup,
    executeCloudflareVectorizeProvisioning,
    executeCloudflareVectorizeRedeploy,
    fingerprintVectorizeProofCandidate,
    prepareCloudflareVectorizeProofPlan,
} from "./run-cloudflare-vectorize-proof.mjs";

export const CLOUDFLARE_VECTORIZE_PROOF_PREPARATION_SCHEMA = "chardb.cloudflare-vectorize-proof.preparation.v1";
export const CLOUDFLARE_VECTORIZE_PROOF_EXECUTION_SCHEMA = "chardb.cloudflare-vectorize-proof.execution.v2";
export const CLOUDFLARE_VECTORIZE_PROOF_WRANGLER_VERSION = "4.125.0";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_FIXTURE = path.join(ROOT, "test", "fixtures", "cloudflare-vectorize-proof");
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const WRANGLER_COMMAND_TIMEOUT_MS = 5 * 60_000;
const WRANGLER_TERMINATION_GRACE_MS = 5_000;
const WRANGLER_KILL_GRACE_MS = 5_000;
const WRANGLER_READINESS_TIMEOUT_MS = 2 * 60_000;
const VECTORIZE_LIFECYCLE_TIMEOUT_MS = 10 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{16}$/;
const RUN_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const TARGET = /^chardb-vx-proof-[a-f0-9]{10}-[a-f0-9]{16}$/;
const WORKERS_DEV_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_HTTP_CODE = /^(?:[A-Z][A-Z0-9_]{0,63}|[0-9]{1,10})$/;
const MAX_EXECUTION_ERROR_CAUSES = 8;
const MAX_EXECUTION_ERROR_NAME_BYTES = 128;
const MAX_EXECUTION_ERROR_MESSAGE_BYTES = 2_048;
const MAX_EXECUTION_ERROR_CAUSE_MESSAGE_BYTES = 1_024;
const HTTP_FAILURE_KINDS = new Set(["timeout", "network", "http", "protocol"]);
const HTTP_PROTOCOL_REASONS = new Set(CLOUDFLARE_VECTORIZE_PROOF_HTTP_PROTOCOL_REASONS);
const BENCHMARK_WORKLOAD_ID = "ready-vector-filtered-search-v2";
const QUERY_STABILITY_WINDOW_MS = 10_000;
const QUERY_STABILITY_INTERVAL_MS = 1_000;
const BENCHMARK_WORKLOAD = Object.freeze({
    id: BENCHMARK_WORKLOAD_ID,
    dimensions: 32,
    metric: "cosine",
    topK: 1,
    requestsPerSample: 1,
    warmupSamples: 1,
    measuredSamples: 5,
});

export function cloudflareVectorizeProofExecutionHttpFailureKind(value) {
    return HTTP_FAILURE_KINDS.has(value) ? value : "unknown";
}

export function cloudflareVectorizeProofExecutionHttpProtocolReason(value) {
    if (value === null) return null;
    return HTTP_PROTOCOL_REASONS.has(value) ? value : "unknown";
}
const PROOF_VECTOR_INITIAL_VALUES = Object.freeze([1, ...Array(31).fill(0)]);
const PROOF_VECTOR_REPLACEMENT_VALUES = Object.freeze([0, 1, ...Array(30).fill(0)]);
const PROOF_LIVE_VECTOR_INITIAL_VALUES = Object.freeze([2, 1, ...Array(30).fill(0)]);
const PROOF_LIVE_VECTOR_REPLACEMENT_VALUES = Object.freeze([1, ...Array(31).fill(0)]);
const PROOF_LIVE_VECTOR_QUERY_VALUES = PROOF_LIVE_VECTOR_INITIAL_VALUES;
const PHYSICAL_ID = /^p1_([A-Za-z0-9_-]{43})_([1-9a-z][0-9a-z]*)$/;
const FIXTURE_FILES = Object.freeze([
    "src/api.ts",
    "src/auth.ts",
    "src/migrations.ts",
    "src/schema.ts",
    "src/vector-fault-evidence.ts",
    "src/vector-proof.ts",
    "src/worker.ts",
    "tsconfig.json",
]);
const DEPLOYMENT_FILES = Object.freeze(
    ["chardb-proof.tgz", "package-lock.json", "package.json", ...FIXTURE_FILES, "wrangler.toml"].sort()
);
const ROOT_DEPENDENCIES = Object.freeze({
    "@noble/hashes": "1.8.0",
    "better-auth": "1.6.30",
    "@chardb/core": "file:./chardb-proof.tgz",
    "drizzle-orm": "0.45.2",
    zod: "4.4.3",
});
const ROOT_DEV_DEPENDENCIES = Object.freeze({
    "@cloudflare/workers-types": "5.20260830.1",
    typescript: "5.9.3",
    wrangler: CLOUDFLARE_VECTORIZE_PROOF_WRANGLER_VERSION,
});
const PREPARATION_PHASES = Object.freeze(["package-lock", "install", "typecheck", "wrangler-doctor", "worker-dry-run"]);
const CANDIDATE_VECTOR_PROOF_RUNTIME_EXPORTS = Object.freeze(
    [
        "CDB_VECTOR_DELIVERY_SETTLEMENT_MS",
        "CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR",
        "cdbVectorLogicalId",
        "cdbVectorResourceId",
        "cdbVectorizeOrganizationNamespace",
        "cdbVectorizePhysicalId",
        "cdbVectorizeResourceFilter",
        "collectSchemaResourceDescriptors",
        "deleteCdbVector",
        "dispatchOrganizationVectorSearch",
        "isChardbVectorResourceDescriptor",
        "parseCdbVectorizePhysicalId",
        "stageCdbVector",
        "vector",
        "vshardOf",
    ].sort()
);
const CANDIDATE_VECTOR_PROOF_TYPE_EXPORTS = Object.freeze(
    [
        ...CANDIDATE_VECTOR_PROOF_RUNTIME_EXPORTS,
        "CdbValidatedVectorMatch",
        "CdbVectorizeMatch",
        "CdbVectorizeMutationIndex",
        "CdbVectorizeRecord",
        "CdbVectorizeSearchIndex",
        "OrganizationVectorSearchValidation",
    ].sort()
);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function exactObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
}

function verifiedWranglerAccount(value, profile, accountId) {
    const verification = exactObject(value, "Wrangler profile account verification");
    const keys = Object.keys(verification).sort();
    const expectedKeys = ["accountIdSha256", "matched", "method", "profile"];
    if (
        JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
        verification.method !== "profile-oauth-token-whoami" ||
        verification.profile !== profile ||
        verification.accountIdSha256 !== sha256(accountId) ||
        verification.matched !== true
    ) {
        throw new Error("Wrangler profile account verification does not bind the requested account");
    }
    return Object.freeze({ ...verification });
}

function assertRelativeFile(value, label) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        path.isAbsolute(value) ||
        value.split(/[\\/]/).includes("..")
    ) {
        throw new Error(`${label} must be a relative file path without parent traversal`);
    }
    return value.split(path.sep).join("/");
}

async function assertRegularFile(file, label) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
    return metadata;
}

function namedModuleExports(source, label) {
    const names = new Set();
    for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/gs)) {
        for (const raw of match[1].split(",")) {
            const item = raw.trim().replace(/^type\s+/, "");
            if (item.length === 0) continue;
            const parsed =
                /^(?:[$A-Z_a-z][$\w]*)\s+as\s+([$A-Z_a-z][$\w]*)$/.exec(item) ?? /^([$A-Z_a-z][$\w]*)$/.exec(item);
            if (!parsed) throw new Error(`${label} contains an unsupported named export`);
            names.add(parsed[1]);
        }
    }
    return [...names].sort();
}

function assertExactNamedExports(source, expected, label) {
    const actual = namedModuleExports(source, label);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter(name => !actualSet.has(name));
    const unexpected = actual.filter(name => !expectedSet.has(name));
    throw new Error(
        `${label} named exports drifted` +
            `${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}` +
            `${unexpected.length > 0 ? `; unexpected ${unexpected.join(", ")}` : ""}`
    );
}

export async function assertCloudflareVectorizeProofCandidateBridge(app) {
    const root = path.resolve(app);
    const directory = path.join(root, "node_modules", "@chardb", "core", "dist", "internal");
    const runtimePath = path.join(directory, "vector-proof.mjs");
    const typesPath = path.join(directory, "vector-proof.d.mts");
    const runtimeMetadata = await assertRegularFile(runtimePath, "Vectorize proof candidate runtime bridge");
    const typesMetadata = await assertRegularFile(typesPath, "Vectorize proof candidate type bridge");
    if (runtimeMetadata.size < 1 || runtimeMetadata.size > 256 * 1024) {
        throw new Error("Vectorize proof candidate runtime bridge size is invalid");
    }
    if (typesMetadata.size < 1 || typesMetadata.size > 256 * 1024) {
        throw new Error("Vectorize proof candidate type bridge size is invalid");
    }
    assertExactNamedExports(
        await readFile(runtimePath, "utf8"),
        CANDIDATE_VECTOR_PROOF_RUNTIME_EXPORTS,
        "Vectorize proof candidate runtime bridge"
    );
    assertExactNamedExports(
        await readFile(typesPath, "utf8"),
        CANDIDATE_VECTOR_PROOF_TYPE_EXPORTS,
        "Vectorize proof candidate type bridge"
    );
    return Object.freeze({
        runtimeExports: CANDIDATE_VECTOR_PROOF_RUNTIME_EXPORTS,
        typeExports: CANDIDATE_VECTOR_PROOF_TYPE_EXPORTS,
    });
}

async function assertEmptyOrCreate(directory, mode) {
    await mkdir(directory, { recursive: true, mode });
    if ((await readdir(directory)).length !== 0) throw new Error(`${directory} must be empty`);
    if (mode !== undefined) await chmod(directory, mode);
}

async function atomicWrite(file, value, mode) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
}

async function atomicJson(file, value, mode = 0o600) {
    await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function generatedSecret(bytes, random) {
    const value = Buffer.from(random(bytes)).toString("base64url");
    if (!SECRET.test(value)) throw new Error("generated proof secret is invalid");
    return value;
}

export function renderCloudflareVectorizeProofWrangler(source, input) {
    if (typeof source !== "string" || source.length === 0) throw new Error("Wrangler template must be text");
    if (input.worker !== input.index || !TARGET.test(input.worker ?? "")) {
        throw new Error("Vectorize proof Worker and index must share the exact disposable name");
    }
    if (!SHA256.test(input.releaseSha256 ?? "") || !input.worker.includes(input.releaseSha256.slice(0, 10))) {
        throw new Error("Vectorize proof release digest does not own the disposable target");
    }
    const replacements = new Map([
        ["__WORKER_NAME__", input.worker],
        ["__INDEX_NAME__", input.index],
        ["__RELEASE_SHA256__", input.releaseSha256],
    ]);
    let rendered = source;
    for (const [placeholder, replacement] of replacements) {
        const matches = rendered.split(placeholder).length - 1;
        if (matches !== 1) throw new Error(`Wrangler template must contain ${placeholder} exactly once`);
        rendered = rendered.replace(placeholder, replacement);
    }
    if (/__[A-Z0-9_]+__/.test(rendered)) throw new Error("Wrangler template contains an unresolved placeholder");
    return rendered;
}

export function renderCloudflareVectorizeProofPackage(relativeTarball = "./chardb-proof.tgz") {
    const normalized = assertRelativeFile(relativeTarball, "candidate tarball package path");
    return Object.freeze({
        name: "chardb-cloudflare-vectorize-proof",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: Object.freeze({ typecheck: "tsc --noEmit" }),
        dependencies:
            ROOT_DEPENDENCIES["@chardb/core"] === `file:${normalized}`
                ? ROOT_DEPENDENCIES
                : Object.freeze({
                      ...ROOT_DEPENDENCIES,
                      "@chardb/core": `file:${normalized.startsWith(".") ? normalized : `./${normalized}`}`,
                  }),
        devDependencies: ROOT_DEV_DEPENDENCIES,
    });
}

export function renderCloudflareVectorizeProofSecrets(input) {
    if (!SECRET.test(input.betterAuthSecret ?? "")) throw new Error("Better Auth proof secret is invalid");
    if (!SECRET.test(input.adminToken ?? "")) throw new Error("Vectorize proof admin token is invalid");
    if (!RUN_ID.test(input.runId ?? "")) throw new Error("Vectorize proof run ID is invalid");
    return [
        `BETTER_AUTH_SECRET=${input.betterAuthSecret}`,
        `CDB_ADMIN_TOKEN=${input.adminToken}`,
        `CDB_PROOF_RUN_ID=${input.runId}`,
        "",
    ].join("\n");
}

export function planCloudflareVectorizePreparationCommands(input) {
    const app = path.resolve(input.app);
    const wrangler = path.join(app, "node_modules", ".bin", "wrangler");
    const chardb = path.join(app, "node_modules", ".bin", "chardb");
    return Object.freeze([
        Object.freeze({
            phase: "package-lock",
            executable: input.npmExecutable ?? "npm",
            args: Object.freeze(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]),
        }),
        Object.freeze({
            phase: "install",
            executable: input.npmExecutable ?? "npm",
            args: Object.freeze(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]),
        }),
        Object.freeze({
            phase: "typecheck",
            executable: input.npmExecutable ?? "npm",
            args: Object.freeze(["run", "typecheck"]),
        }),
        Object.freeze({ phase: "wrangler-doctor", executable: chardb, args: Object.freeze(["doctor", "wrangler"]) }),
        Object.freeze({
            phase: "worker-dry-run",
            executable: wrangler,
            args: Object.freeze([
                "deploy",
                "--dry-run",
                "--outdir",
                path.join(input.privateDir, "worker-dist"),
                "--config",
                path.join(app, "wrangler.toml"),
            ]),
        }),
    ]);
}

function assertPinnedPackage(packageJson) {
    const root = exactObject(packageJson, "Vectorize proof package manifest");
    for (const [name, version] of Object.entries(ROOT_DEPENDENCIES)) {
        if (root.dependencies?.[name] !== version)
            throw new Error(`Vectorize proof dependency ${name} must pin ${version}`);
    }
    for (const [name, version] of Object.entries(ROOT_DEV_DEPENDENCIES)) {
        if (root.devDependencies?.[name] !== version) {
            throw new Error(`Vectorize proof development dependency ${name} must pin ${version}`);
        }
    }
    return root;
}

export function assertCloudflareVectorizeProofPackageLock(value) {
    const lock = exactObject(value, "Vectorize proof package lock");
    if (!Number.isSafeInteger(lock.lockfileVersion) || lock.lockfileVersion < 3) {
        throw new Error("Vectorize proof package lock must use npm lockfile version 3 or later");
    }
    const packages = exactObject(lock.packages, "Vectorize proof package-lock packages");
    assertPinnedPackage(packages[""]);
    for (const [name, version] of [
        ["@noble/hashes", ROOT_DEPENDENCIES["@noble/hashes"]],
        ["better-auth", ROOT_DEPENDENCIES["better-auth"]],
        ["drizzle-orm", ROOT_DEPENDENCIES["drizzle-orm"]],
        ["zod", ROOT_DEPENDENCIES.zod],
        ["@cloudflare/workers-types", ROOT_DEV_DEPENDENCIES["@cloudflare/workers-types"]],
        ["typescript", ROOT_DEV_DEPENDENCIES.typescript],
        ["wrangler", ROOT_DEV_DEPENDENCIES.wrangler],
    ]) {
        if (packages[`node_modules/${name}`]?.version !== version) {
            throw new Error(`Vectorize proof package lock must resolve ${name} ${version}`);
        }
    }
    const candidate = packages["node_modules/@chardb/core"];
    if (!candidate || candidate.resolved !== "file:chardb-proof.tgz") {
        throw new Error("Vectorize proof package lock must resolve chardb from the copied candidate tarball");
    }
    return lock;
}

export async function fingerprintCloudflareVectorizeDeployment(app, files = DEPLOYMENT_FILES) {
    const root = path.resolve(app);
    const records = [];
    const normalizedFiles = files.map(item => assertRelativeFile(item, "deployment input path")).sort();
    if (new Set(normalizedFiles).size !== normalizedFiles.length) {
        throw new Error("deployment input paths must be unique");
    }
    for (const relative of normalizedFiles) {
        const absolute = path.join(root, ...relative.split("/"));
        const metadata = await assertRegularFile(absolute, `deployment input ${relative}`);
        const bytes = await readFile(absolute);
        if (metadata.size !== bytes.byteLength || bytes.byteLength < 1) {
            throw new Error(`deployment input ${relative} must not be empty or change while read`);
        }
        records.push(Object.freeze({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) }));
    }
    return Object.freeze({
        algorithm: "sha256",
        digest: sha256(JSON.stringify(records)),
        files: Object.freeze(records),
    });
}

export async function assertNoCloudflareVectorizeProofSecrets(files, secrets) {
    const needles = secrets.filter(item => typeof item === "string" && item.length > 0);
    const uniqueFiles = [...new Set(files.map(item => path.resolve(item)))].sort();
    for (const file of uniqueFiles) {
        await assertRegularFile(file, "secret-scan input");
        const bytes = await readFile(file);
        for (const secret of needles) {
            if (bytes.includes(Buffer.from(secret))) throw new Error(`secret leaked into ${path.basename(file)}`);
        }
    }
    return Object.freeze({ filesScanned: uniqueFiles.length, valuesScanned: needles.length });
}

export async function prepareCloudflareVectorizeProofApp(input) {
    const app = path.resolve(input.app);
    const privateDir = path.resolve(input.privateDir);
    if (!app.startsWith(`${privateDir}${path.sep}`))
        throw new Error("Vectorize proof app must be inside the private directory");
    await assertEmptyOrCreate(app, 0o700);
    const fixture = path.resolve(input.fixture ?? DEFAULT_FIXTURE);
    for (const relative of FIXTURE_FILES) {
        const source = path.join(fixture, ...relative.split("/"));
        await assertRegularFile(source, `Vectorize proof fixture ${relative}`);
        const destination = path.join(app, ...relative.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination);
    }
    await assertRegularFile(path.resolve(input.tarball), "Vectorize proof candidate");
    const candidate = await fingerprintVectorizeProofCandidate(input.tarball);
    if (candidate.digest !== input.candidateSha256)
        throw new Error("Vectorize proof candidate digest changed before copy");
    await cp(path.resolve(input.tarball), path.join(app, "chardb-proof.tgz"));
    await writeFile(
        path.join(app, "package.json"),
        `${JSON.stringify(renderCloudflareVectorizeProofPackage(), null, 2)}\n`
    );
    const templatePath = path.join(fixture, "wrangler.template.toml");
    await assertRegularFile(templatePath, "Vectorize proof Wrangler template");
    const template = await readFile(templatePath, "utf8");
    await writeFile(
        path.join(app, "wrangler.toml"),
        renderCloudflareVectorizeProofWrangler(template, {
            worker: input.worker,
            index: input.index,
            releaseSha256: candidate.digest,
        })
    );
    const copied = await fingerprintVectorizeProofCandidate(path.join(app, "chardb-proof.tgz"));
    if (copied.digest !== candidate.digest || copied.bytes !== candidate.bytes) {
        throw new Error("copied Vectorize proof candidate does not match the source tarball");
    }
    return Object.freeze({ app, candidate });
}

function scrub(value, secrets) {
    let output = String(value);
    for (const secret of secrets) output = output.split(secret).join("[redacted]");
    return output;
}

function boundedScrub(value, secrets, maximumBytes) {
    const output = scrub(value, secrets);
    const bytes = Buffer.from(output);
    if (bytes.byteLength <= maximumBytes) return output;
    let end = maximumBytes;
    while (end > 0) {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
        } catch {
            end--;
        }
    }
    return "";
}

async function runPreparationCommand(invocation) {
    const child = Bun.spawn([invocation.executable, ...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.environment,
        stdout: "pipe",
        stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), invocation.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]).finally(() => clearTimeout(timer));
    return { exitCode, stdout, stderr };
}

function commandEnvironment(base, privateDir) {
    const environment = { ...base };
    for (const key of [
        "BETTER_AUTH_SECRET",
        "CDB_ADMIN_TOKEN",
        "CDB_PROOF_RUN_ID",
        "CLOUDFLARE_API_TOKEN",
        "CF_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
    ]) {
        delete environment[key];
    }
    environment.WRANGLER_LOG_PATH = path.join(privateDir, "wrangler-prepare.log");
    environment.XDG_CONFIG_HOME = path.join(privateDir, "xdg-config");
    environment.XDG_CACHE_HOME = path.join(privateDir, "xdg-cache");
    environment.XDG_STATE_HOME = path.join(privateDir, "xdg-state");
    return Object.freeze(environment);
}

export async function validateCloudflareVectorizeProofApp(input, dependencies = {}) {
    const app = path.resolve(input.app);
    const privateDir = path.resolve(input.privateDir);
    const secrets = input.secrets ?? [];
    const run = dependencies.run ?? runPreparationCommand;
    const assertCandidateBridge = dependencies.assertCandidateBridge ?? assertCloudflareVectorizeProofCandidateBridge;
    const commands = planCloudflareVectorizePreparationCommands({
        app,
        privateDir,
        npmExecutable: input.npmExecutable,
    });
    const environment = commandEnvironment(input.baseEnvironment ?? process.env, privateDir);
    const completed = [];
    for (const command of commands) {
        const result = await withTemporaryWranglerLogRemoved(environment.WRANGLER_LOG_PATH, () =>
            run({
                ...command,
                cwd: app,
                environment,
                timeoutMs: input.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
            })
        );
        if (
            !result ||
            typeof result !== "object" ||
            !Number.isInteger(result.exitCode) ||
            typeof result.stdout !== "string" ||
            typeof result.stderr !== "string"
        ) {
            throw new Error(`${command.phase} returned an invalid command result`);
        }
        if (result.exitCode !== 0) {
            const detail = scrub(`${result.stdout}\n${result.stderr}`.trim(), secrets);
            throw new Error(`${command.phase} failed with exit ${result.exitCode}${detail ? `: ${detail}` : ""}`);
        }
        completed.push(command.phase);
        if (command.phase === "install") await assertCandidateBridge(app);
        if (command.phase === "package-lock") {
            const lock = JSON.parse(await readFile(path.join(app, "package-lock.json"), "utf8"));
            assertCloudflareVectorizeProofPackageLock(lock);
        }
    }
    if (JSON.stringify(completed) !== JSON.stringify(PREPARATION_PHASES)) {
        throw new Error("Vectorize proof preparation did not complete every validation phase");
    }
    return Object.freeze({ phases: Object.freeze(completed) });
}

function value(argv, flag) {
    const indexes = argv.flatMap((item, index) => (item === flag ? [index] : []));
    if (indexes.length > 1) throw new Error(`${flag} may be provided only once`);
    return indexes.length === 0 ? undefined : argv[indexes[0] + 1];
}

export function parseCloudflareVectorizeOrchestratorArgs(argv) {
    const valued = new Set([
        "--tarball",
        "--output",
        "--private-dir",
        "--workers-dev-subdomain",
        "--npm",
        "--account-id",
        "--profile",
    ]);
    const boolean = new Set(["--confirm-disposable-resources", "--execute", "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!valued.has(argument) && !boolean.has(argument))
            throw new Error(`unknown Vectorize proof argument ${JSON.stringify(argument)}`);
        if (valued.has(argument)) {
            const next = argv[++index];
            if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
        }
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const options = {
        help,
        tarball: value(argv, "--tarball"),
        output: value(argv, "--output"),
        privateDir: value(argv, "--private-dir"),
        workersDevSubdomain: value(argv, "--workers-dev-subdomain"),
        npmExecutable: value(argv, "--npm") ?? "npm",
        accountId: value(argv, "--account-id")?.toLowerCase(),
        profile: value(argv, "--profile") ?? "default",
        execute: argv.includes("--execute"),
        confirmed: argv.includes("--confirm-disposable-resources"),
    };
    if (!help) {
        for (const [flag, item] of [
            ["--tarball", options.tarball],
            ["--output", options.output],
            ["--private-dir", options.privateDir],
            ["--workers-dev-subdomain", options.workersDevSubdomain],
        ]) {
            if (!item) throw new Error(`${flag} is required`);
        }
        if (!options.confirmed) throw new Error("--confirm-disposable-resources is required");
        if (!WORKERS_DEV_SUBDOMAIN.test(options.workersDevSubdomain)) {
            throw new Error("--workers-dev-subdomain must be one lowercase Cloudflare subdomain label");
        }
        if (options.execute && !ACCOUNT_ID.test(options.accountId ?? "")) {
            throw new Error("--account-id must be exactly 32 hexadecimal characters with --execute");
        }
        if (!options.execute && value(argv, "--account-id") !== undefined) {
            throw new Error("--account-id requires --execute");
        }
        if (!PROFILE.test(options.profile)) throw new Error("--profile must be a safe Wrangler profile name");
        if (!options.execute && value(argv, "--profile") !== undefined) {
            throw new Error("--profile requires --execute");
        }
    }
    return Object.freeze(options);
}

export async function prepareCloudflareVectorizeProof(input, dependencies = {}) {
    const output = path.resolve(input.output);
    const privateDir = path.resolve(input.privateDir);
    const random = dependencies.randomBytes ?? randomBytes;
    const nonce = input.nonce ?? Buffer.from(random(8)).toString("hex");
    const runId = input.runId ?? Buffer.from(random(24)).toString("base64url");
    if (!NONCE.test(nonce) || !RUN_ID.test(runId)) throw new Error("Vectorize proof nonce or run ID is invalid");
    const betterAuthSecret = input.betterAuthSecret ?? generatedSecret(32, random);
    const adminToken = input.adminToken ?? generatedSecret(32, random);
    if (!WORKERS_DEV_SUBDOMAIN.test(input.workersDevSubdomain ?? "")) {
        throw new Error("Vectorize proof workers.dev subdomain is invalid");
    }
    if (betterAuthSecret === adminToken || betterAuthSecret === runId || adminToken === runId) {
        throw new Error("Vectorize proof credentials must be distinct");
    }
    const secrets = Object.freeze([betterAuthSecret, adminToken, runId]);
    const planned = await prepareCloudflareVectorizeProofPlan({
        tarball: input.tarball,
        output,
        privateDir,
        nonce,
        runId,
    });
    const candidate = planned.publicPlan.candidate;
    const names = deriveDisposableVectorizeResourceNames(candidate.digest, nonce);
    const app = path.join(privateDir, "app");
    const secretsFile = path.join(privateDir, "secrets.env");
    await atomicWrite(
        secretsFile,
        renderCloudflareVectorizeProofSecrets({ betterAuthSecret, adminToken, runId }),
        0o600
    );
    await prepareCloudflareVectorizeProofApp({
        app,
        privateDir,
        fixture: input.fixture,
        tarball: input.tarball,
        candidateSha256: candidate.digest,
        ...names,
    });
    const validation = await validateCloudflareVectorizeProofApp(
        {
            app,
            privateDir,
            npmExecutable: input.npmExecutable,
            baseEnvironment: input.baseEnvironment,
            commandTimeoutMs: input.commandTimeoutMs,
            secrets,
        },
        { run: dependencies.run, assertCandidateBridge: dependencies.assertCandidateBridge }
    );
    const currentCandidate = await fingerprintVectorizeProofCandidate(input.tarball);
    if (currentCandidate.digest !== candidate.digest || currentCandidate.bytes !== candidate.bytes) {
        throw new Error("Vectorize proof candidate changed during preparation");
    }
    const deploymentInput = await fingerprintCloudflareVectorizeDeployment(app);
    const copiedCandidate = deploymentInput.files.find(file => file.path === "chardb-proof.tgz");
    if (!copiedCandidate || copiedCandidate.sha256 !== candidate.digest || copiedCandidate.bytes !== candidate.bytes) {
        throw new Error("Vectorize proof deployment fingerprint is not bound to the exact candidate");
    }
    const preparationPath = path.join(output, "vectorize-proof-preparation.json");
    const publicEvidence = {
        schema: CLOUDFLARE_VECTORIZE_PROOF_PREPARATION_SCHEMA,
        candidate,
        target: Object.freeze({ worker: names.worker, index: names.index }),
        wranglerVersion: CLOUDFLARE_VECTORIZE_PROOF_WRANGLER_VERSION,
        deploymentInput,
        secretSetSha256: sha256(await readFile(secretsFile)),
        validations: validation.phases,
        mutatingCommandsExecuted: false,
        secretScan: Object.freeze({ passed: true, filesScanned: DEPLOYMENT_FILES.length + 2 }),
    };
    await atomicJson(preparationPath, publicEvidence);
    const scanFiles = [
        ...DEPLOYMENT_FILES.map(relative => path.join(app, ...relative.split("/"))),
        path.join(output, "vectorize-proof-plan.json"),
        preparationPath,
    ];
    const scan = await assertNoCloudflareVectorizeProofSecrets(scanFiles, secrets);
    if (scan.filesScanned !== publicEvidence.secretScan.filesScanned) {
        throw new Error("Vectorize proof secret-scan file count drifted");
    }
    const preparationSha256 = sha256(await readFile(preparationPath));
    const checksumPath = path.join(output, "preparation.sha256");
    await atomicWrite(checksumPath, `${preparationSha256}  vectorize-proof-preparation.json\n`, 0o600);
    await assertNoCloudflareVectorizeProofSecrets([...scanFiles, checksumPath], secrets);
    const secretMode = (await stat(secretsFile)).mode & 0o777;
    if (secretMode !== 0o600) throw new Error("Vectorize proof secrets file mode drifted from 0600");
    return Object.freeze({
        publicPlan: planned.publicPlan,
        candidate,
        target: Object.freeze(names),
        deploymentInput,
        preparationPath,
        preparationSha256,
        checksumPath,
        app,
        config: path.join(app, "wrangler.toml"),
        secretsFile,
        ledgerPath: planned.ledgerPath,
        origin: `https://${names.worker}.${input.workersDevSubdomain}.workers.dev`,
    });
}

async function readExactPrivateFile(file, label, maximumBytes = 16_384) {
    const absolute = path.resolve(file);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
    if ((metadata.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600`);
    if (metadata.size < 1 || metadata.size > maximumBytes) throw new Error(`${label} has an invalid size`);
    return readFile(absolute, "utf8");
}

export async function readCloudflareVectorizeProofSecrets(file) {
    const source = await readExactPrivateFile(file, "Vectorize proof secrets file");
    const values = new Map();
    for (const line of source.split("\n")) {
        if (line.length === 0) continue;
        const match = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_-]+)$/.exec(line);
        if (!match || values.has(match[1])) throw new Error("Vectorize proof secrets file is malformed");
        values.set(match[1], match[2]);
    }
    const keys = [...values.keys()].sort();
    const expected = ["BETTER_AUTH_SECRET", "CDB_ADMIN_TOKEN", "CDB_PROOF_RUN_ID"].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new Error(`Vectorize proof secrets file fields must be exactly ${expected.join(", ")}`);
    }
    const betterAuthSecret = values.get("BETTER_AUTH_SECRET");
    const adminToken = values.get("CDB_ADMIN_TOKEN");
    const runId = values.get("CDB_PROOF_RUN_ID");
    if (!SECRET.test(betterAuthSecret) || !SECRET.test(adminToken) || !RUN_ID.test(runId)) {
        throw new Error("Vectorize proof secrets file contains an invalid value");
    }
    if (new Set([betterAuthSecret, adminToken, runId]).size !== 3) {
        throw new Error("Vectorize proof credentials must be distinct");
    }
    return Object.freeze({ betterAuthSecret, adminToken, runId });
}

function benchmarkObservation(value, sequence, label) {
    const input = exactObject(value, label);
    if (Object.keys(input).length === 3) {
        if (
            input.sequence !== sequence ||
            input.excluded !== (sequence === -1) ||
            typeof input.elapsedMs !== "number" ||
            !Number.isFinite(input.elapsedMs) ||
            input.elapsedMs < 0
        ) {
            throw new Error(`${label} is invalid`);
        }
        return Object.freeze({
            requestOrdinal: sequence + 1,
            sequence,
            excluded: sequence === -1,
            classification: "exact",
            status: null,
            code: null,
            elapsedMs: input.elapsedMs,
        });
    }
    const expectedKeys = [
        "requestOrdinal",
        "sequence",
        "excluded",
        "classification",
        "status",
        "code",
        "elapsedMs",
    ].sort();
    if (
        JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedKeys) ||
        input.requestOrdinal !== sequence + 1 ||
        input.sequence !== sequence ||
        input.excluded !== (sequence === -1) ||
        !["exact", "empty", "http-5xx", "timeout"].includes(input.classification) ||
        typeof input.elapsedMs !== "number" ||
        !Number.isFinite(input.elapsedMs) ||
        input.elapsedMs < 0
    ) {
        throw new Error(`${label} is invalid`);
    }
    if (input.classification === "http-5xx") {
        if (!Number.isSafeInteger(input.status) || input.status < 500 || input.status > 599) {
            throw new Error(`${label} HTTP status is invalid`);
        }
    } else if (input.status !== null || input.code !== null) {
        throw new Error(`${label} carries unexpected HTTP identity`);
    }
    return Object.freeze({ ...input });
}

function exactBenchmarkObservations(value, label) {
    if (!Array.isArray(value) || value.length !== 5) throw new Error(`${label} must contain exactly five samples`);
    return Object.freeze(value.map((sample, index) => benchmarkObservation(sample, index, `${label} sample ${index}`)));
}

function exactPhysicalIds(value, label) {
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > 512 ||
        value.some(id => typeof id !== "string" || !PHYSICAL_ID.test(id)) ||
        JSON.stringify(value) !== JSON.stringify([...new Set(value)].sort())
    ) {
        throw new Error(`${label} must contain unique sorted physical IDs`);
    }
    return Object.freeze([...value]);
}

export function cloudflareVectorizeProofBenchmarkTrack(value, expectedLabel) {
    const input = exactObject(value, `${expectedLabel} benchmark input`);
    if (input.workloadId === BENCHMARK_WORKLOAD_ID && input.warmupExcluded === true && input.warmupCount === 1) {
        const warmup = benchmarkObservation(
            input.warmup ?? { sequence: -1, excluded: true, elapsedMs: 0 },
            -1,
            `${expectedLabel} warmup`
        );
        const samples = exactBenchmarkObservations(
            input.samples ?? input.samplesMs?.map((elapsedMs, sequence) => ({ sequence, excluded: false, elapsedMs })),
            expectedLabel
        );
        const exactMatchLatenciesMs = samples
            .filter(sample => sample.classification === "exact")
            .map(sample => sample.elapsedMs);
        if (
            input.exactMatchLatenciesMs !== undefined &&
            JSON.stringify(input.exactMatchLatenciesMs) !== JSON.stringify(exactMatchLatenciesMs)
        ) {
            throw new Error(`${expectedLabel} exact-match latency population drifted`);
        }
        return Object.freeze({
            workloadId: BENCHMARK_WORKLOAD_ID,
            warmupExcluded: true,
            warmupCount: 1,
            warmup,
            samples,
            exactMatchLatenciesMs: Object.freeze(exactMatchLatenciesMs),
        });
    }
    const workload = exactObject(input.workload, `${expectedLabel} benchmark workload`);
    const sampling = exactObject(input.sampling, `${expectedLabel} benchmark sampling`);
    const warmup = exactObject(sampling.warmup, `${expectedLabel} benchmark warmup`);
    const track = exactObject(input.track, `${expectedLabel} benchmark track`);
    for (const [field, expected] of Object.entries(BENCHMARK_WORKLOAD)) {
        if (workload[field] !== expected) throw new Error(`${expectedLabel} benchmark workload ${field} drifted`);
    }
    if (warmup.sequence !== -1 || warmup.excluded !== true) {
        throw new Error(`${expectedLabel} benchmark must exclude exactly one warmup`);
    }
    if (track.label !== expectedLabel) throw new Error(`${expectedLabel} benchmark label drifted`);
    if (!Array.isArray(sampling.samples) || sampling.samples.length !== 5) {
        throw new Error(`${expectedLabel} benchmark sampling evidence requires five samples`);
    }
    const samples = exactBenchmarkObservations(sampling.samples, expectedLabel);
    if (
        !Array.isArray(track.samplesMs) ||
        JSON.stringify(track.samplesMs) !== JSON.stringify(samples.map(sample => sample.elapsedMs))
    ) {
        throw new Error(`${expectedLabel} benchmark sample evidence drifted`);
    }
    return Object.freeze({
        workloadId: BENCHMARK_WORKLOAD_ID,
        warmupExcluded: true,
        warmupCount: 1,
        warmup: benchmarkObservation(warmup, -1, `${expectedLabel} warmup`),
        samples,
        exactMatchLatenciesMs: Object.freeze(samples.map(sample => sample.elapsedMs)),
    });
}

function cloudflareVectorizeProofQueryStability(value, label) {
    const input = exactObject(value, `${label} query stability`);
    const keys = Object.keys(input).sort();
    const expectedKeys = [
        "queryStabilityExactMatchCount",
        "queryStabilityIntervalMs",
        "queryStabilityNonExactCount",
        "queryStabilityObservedMs",
        "queryStabilityResetCount",
        "queryStabilityWindowMs",
        "hardBoundClaimed",
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`${label} query stability fields drifted`);
    }
    if (
        input.queryStabilityWindowMs !== QUERY_STABILITY_WINDOW_MS ||
        input.queryStabilityIntervalMs !== QUERY_STABILITY_INTERVAL_MS
    ) {
        throw new Error(`${label} query stability contract drifted`);
    }
    if (
        typeof input.queryStabilityObservedMs !== "number" ||
        !Number.isFinite(input.queryStabilityObservedMs) ||
        input.queryStabilityObservedMs < QUERY_STABILITY_WINDOW_MS
    ) {
        throw new Error(`${label} query stability observation is incomplete`);
    }
    for (const field of ["queryStabilityExactMatchCount", "queryStabilityResetCount", "queryStabilityNonExactCount"]) {
        if (!Number.isSafeInteger(input[field]) || input[field] < 0) {
            throw new Error(`${label} ${field} is invalid`);
        }
    }
    if (input.queryStabilityExactMatchCount < 1) throw new Error(`${label} query stability has no exact matches`);
    if (input.hardBoundClaimed !== false) throw new Error(`${label} query stability cannot claim a platform bound`);
    return Object.freeze({
        queryStabilityWindowMs: QUERY_STABILITY_WINDOW_MS,
        queryStabilityIntervalMs: QUERY_STABILITY_INTERVAL_MS,
        queryStabilityObservedMs: input.queryStabilityObservedMs,
        queryStabilityExactMatchCount: input.queryStabilityExactMatchCount,
        queryStabilityResetCount: input.queryStabilityResetCount,
        queryStabilityNonExactCount: input.queryStabilityNonExactCount,
        hardBoundClaimed: false,
    });
}

export function assertCloudflareVectorizeProofBenchmark(value) {
    const input = exactObject(value, "Vectorize proof benchmark input");
    if (input.workloadId !== BENCHMARK_WORKLOAD_ID) throw new Error("Vectorize proof benchmark workload drifted");
    return Object.freeze({
        workloadId: BENCHMARK_WORKLOAD_ID,
        localFake: cloudflareVectorizeProofBenchmarkTrack(input.localFake, "local-workerd-fake-vectorize"),
        localRemoteBinding: cloudflareVectorizeProofBenchmarkTrack(
            input.localRemoteBinding,
            "local-wrangler-remote-vectorize"
        ),
        localRemoteQueryStability: cloudflareVectorizeProofQueryStability(
            input.localRemoteQueryStability,
            "local-wrangler-remote-vectorize"
        ),
        localRemotePostStabilitySampling:
            input.localRemotePostStabilitySampling === undefined
                ? undefined
                : exactObject(
                      input.localRemotePostStabilitySampling,
                      "local-wrangler-remote-vectorize post-stability sampling"
                  ),
    });
}

async function assertCloudflareVectorizeDeploymentUnchanged(prepared) {
    const current = await fingerprintCloudflareVectorizeDeployment(prepared.app);
    if (JSON.stringify(current) !== JSON.stringify(prepared.deploymentInput)) {
        throw new Error("prepared Vectorize deployment input changed before execution");
    }
}

async function assertPreparedExecutionInput(prepared) {
    const candidate = exactObject(prepared.candidate, "prepared Vectorize candidate");
    if (!SHA256.test(candidate.digest ?? "") || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 1) {
        throw new Error("prepared Vectorize candidate is invalid");
    }
    const target = exactObject(prepared.target, "prepared Vectorize target");
    if (target.worker !== target.index || !TARGET.test(target.worker ?? "")) {
        throw new Error("prepared Vectorize target is invalid");
    }
    for (const [field, value] of [
        ["app", prepared.app],
        ["config", prepared.config],
        ["secretsFile", prepared.secretsFile],
        ["ledgerPath", prepared.ledgerPath],
        ["preparationPath", prepared.preparationPath],
        ["checksumPath", prepared.checksumPath],
    ]) {
        if (typeof value !== "string" || !path.isAbsolute(value)) {
            throw new Error(`prepared Vectorize ${field} path must be absolute`);
        }
    }
    const privateDir = path.dirname(prepared.ledgerPath);
    if (
        prepared.app !== path.join(privateDir, "app") ||
        prepared.config !== path.join(prepared.app, "wrangler.toml") ||
        prepared.secretsFile !== path.join(privateDir, "secrets.env")
    ) {
        throw new Error("prepared Vectorize private paths drifted from the ownership ledger");
    }
    if (path.dirname(prepared.preparationPath) === privateDir) {
        throw new Error("prepared Vectorize public evidence must be separate from private state");
    }
    if (!SHA256.test(prepared.preparationSha256 ?? "")) {
        throw new Error("prepared Vectorize preparation digest is invalid");
    }
    await assertRegularFile(prepared.config, "prepared Vectorize Wrangler config");
    const [preparationBytes, preparationChecksum] = await Promise.all([
        readFile(prepared.preparationPath),
        readFile(prepared.checksumPath, "utf8"),
    ]);
    const preparationSha256 = sha256(preparationBytes);
    if (
        preparationSha256 !== prepared.preparationSha256 ||
        preparationChecksum !== `${preparationSha256}  vectorize-proof-preparation.json\n`
    ) {
        throw new Error("prepared Vectorize preparation checksum is invalid");
    }
    let preparationEvidence;
    try {
        preparationEvidence = JSON.parse(preparationBytes.toString("utf8"));
    } catch {
        throw new Error("prepared Vectorize preparation evidence is not valid JSON");
    }
    if (
        JSON.stringify(preparationEvidence.candidate) !== JSON.stringify(candidate) ||
        JSON.stringify(preparationEvidence.target) !== JSON.stringify(target) ||
        JSON.stringify(preparationEvidence.deploymentInput) !== JSON.stringify(prepared.deploymentInput)
    ) {
        throw new Error("prepared Vectorize deployment input changed before execution");
    }
    await assertCloudflareVectorizeDeploymentUnchanged(prepared);
    const ledger = JSON.parse(await readExactPrivateFile(prepared.ledgerPath, "Vectorize ownership ledger", 64 * 1024));
    if (
        ledger.candidateSha256 !== candidate.digest ||
        ledger.worker !== target.worker ||
        ledger.index !== target.index ||
        !NONCE.test(ledger.nonce ?? "") ||
        !RUN_ID.test(ledger.runId ?? "")
    ) {
        throw new Error("prepared Vectorize ownership ledger drifted from the candidate or target");
    }
    const secrets = await readCloudflareVectorizeProofSecrets(prepared.secretsFile);
    if (secrets.runId !== ledger.runId) throw new Error("Vectorize proof run ID drifted from its ownership ledger");
    const wranglerExecutable = path.join(prepared.app, "node_modules", ".bin", "wrangler");
    const localModules = path.join(prepared.app, "node_modules");
    const [resolvedWrangler, resolvedLocalModules] = await Promise.all([
        realpath(wranglerExecutable),
        realpath(localModules),
    ]);
    if (!resolvedWrangler.startsWith(`${resolvedLocalModules}${path.sep}`)) {
        throw new Error("Vectorize proof Wrangler must resolve inside the prepared app");
    }
    return Object.freeze({ candidate, target, ledger, secrets, privateDir, wranglerExecutable });
}

async function settleWithin(promise, timeoutMs) {
    const timeout = Symbol("timeout");
    let timer;
    const result = await Promise.race([
        promise,
        new Promise(resolve => {
            timer = setTimeout(() => resolve(timeout), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
    return result === timeout ? null : result;
}

export async function awaitCloudflareVectorizeWranglerChild(child, options) {
    const timeoutMs = Number(options?.timeoutMs);
    const terminationGraceMs = Number(options?.terminationGraceMs ?? WRANGLER_TERMINATION_GRACE_MS);
    const killGraceMs = Number(options?.killGraceMs ?? WRANGLER_KILL_GRACE_MS);
    for (const [value, label] of [
        [timeoutMs, "Wrangler command timeout"],
        [terminationGraceMs, "Wrangler SIGTERM grace"],
        [killGraceMs, "Wrangler SIGKILL grace"],
    ]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
    }

    const stdout = new Response(child.stdout).text().then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error })
    );
    const stderr = new Response(child.stderr).text().then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error })
    );
    const exited = Promise.resolve(child.exited).then(
        exitCode => ({ ok: true, exitCode }),
        error => ({ ok: false, error })
    );

    let exit = await settleWithin(exited, timeoutMs);
    if (exit === null) {
        try {
            child.kill("SIGTERM");
        } catch {
            // The hard deadline below still bounds a child that rejects termination.
        }
        exit = await settleWithin(exited, terminationGraceMs);
        if (exit === null) {
            try {
                child.kill("SIGKILL");
            } catch {
                // The hard deadline below is authoritative even if kill itself fails.
            }
            exit = await settleWithin(exited, killGraceMs);
            if (exit === null) {
                throw new Error(`Wrangler command timed out after ${timeoutMs}ms and did not exit after SIGKILL`);
            }
        }
        throw new Error(`Wrangler command timed out after ${timeoutMs}ms`);
    }
    if (!exit.ok) throw exit.error;
    const [stdoutResult, stderrResult] = await Promise.all([stdout, stderr]);
    if (!stdoutResult.ok) throw stdoutResult.error;
    if (!stderrResult.ok) throw stderrResult.error;
    return { exitCode: exit.exitCode, stdout: stdoutResult.value, stderr: stderrResult.value };
}

async function runWranglerInvocation(invocation) {
    const child = Bun.spawn([invocation.executable, ...invocation.command.args, "--config", invocation.config], {
        cwd: invocation.cwd,
        env: invocation.environment,
        stdout: "pipe",
        stderr: "pipe",
    });
    return awaitCloudflareVectorizeWranglerChild(child, { timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS });
}

function safeExecutionError(error, secrets) {
    if (error instanceof CloudflareVectorizeProofHttpError) {
        const status =
            Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
        const code = typeof error.code === "string" && SAFE_HTTP_CODE.test(error.code) ? error.code : null;
        const failureKind = cloudflareVectorizeProofExecutionHttpFailureKind(error.kind);
        const protocolReason = cloudflareVectorizeProofExecutionHttpProtocolReason(error.protocolReason);
        return Object.freeze({
            name: "CloudflareVectorizeProofHttpError",
            message: "Cloudflare Vectorize proof HTTP request failed",
            failureKind,
            protocolReason,
            http: Object.freeze({ status, code }),
        });
    }
    if (error instanceof CloudflareVectorizeProofObservationTimeoutError) {
        return Object.freeze({
            name: "CloudflareVectorizeProofObservationTimeoutError",
            message: "Cloudflare Vectorize proof observation timed out",
            observation: assertSecretFreeExecutionValue(
                assertCloudflareVectorizeProofObservationTimeoutEvidence(error.evidence),
                secrets,
                "Vectorize observation timeout evidence"
            ),
        });
    }
    if (error instanceof CloudflareVectorizeProofCandidateClassificationError) {
        return Object.freeze({
            name: "CloudflareVectorizeProofCandidateClassificationError",
            message: "Cloudflare Vectorize proof candidate classification failed",
            classification: assertSecretFreeExecutionValue(
                assertCloudflareVectorizeProofCandidateClassificationEvidence(error.evidence),
                secrets,
                "Vectorize candidate classification evidence"
            ),
        });
    }
    const message = boundedScrub(
        error instanceof Error ? error.message : String(error),
        secrets,
        MAX_EXECUTION_ERROR_MESSAGE_BYTES
    );
    const name = boundedScrub(error instanceof Error ? error.name : "Error", secrets, MAX_EXECUTION_ERROR_NAME_BYTES);
    if (error instanceof AggregateError) {
        const errors = Array.isArray(error.errors) ? error.errors : [];
        return Object.freeze({
            name: "AggregateError",
            message,
            causes: Object.freeze(
                errors.slice(0, MAX_EXECUTION_ERROR_CAUSES).map(cause =>
                    Object.freeze({
                        name: boundedScrub(
                            cause instanceof Error ? cause.name : "Error",
                            secrets,
                            MAX_EXECUTION_ERROR_NAME_BYTES
                        ),
                        message: boundedScrub(
                            cause instanceof Error ? cause.message : String(cause),
                            secrets,
                            MAX_EXECUTION_ERROR_CAUSE_MESSAGE_BYTES
                        ),
                    })
                )
            ),
            causeOverflowCount: Math.max(0, errors.length - MAX_EXECUTION_ERROR_CAUSES),
        });
    }
    return Object.freeze({
        name,
        message,
        ...(error instanceof CloudflareVectorizeProofSettlementError
            ? { settlement: assertSecretFreeExecutionValue(error.evidence, secrets, "Vectorize settlement failure") }
            : {}),
    });
}

function assertSecretFreeExecutionValue(value, secrets, label) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    } catch {
        throw new Error(`${label} is not JSON serializable`);
    }
    if (typeof serialized !== "string") throw new Error(`${label} is not JSON serializable`);
    for (const secret of secrets) {
        if (serialized.includes(secret)) throw new Error(`${label} contains a private proof value`);
    }
    return value;
}

function cleanupDecisionFromLedger(currentLedger) {
    for (const field of ["workerAbsentConfirmed", "indexAbsentConfirmed", "workerCreateIntent", "indexCreateIntent"]) {
        if (typeof currentLedger[field] !== "boolean") {
            throw new Error(`Vectorize ownership ledger ${field} is invalid during cleanup`);
        }
    }
    if (!Array.isArray(currentLedger.knownPhysicalIds)) {
        throw new Error("Vectorize ownership ledger physical IDs are invalid during cleanup");
    }
    return Object.freeze({
        required: currentLedger.workerCreateIntent || currentLedger.indexCreateIntent,
        workerAbsentConfirmed: currentLedger.workerAbsentConfirmed,
        indexAbsentConfirmed: currentLedger.indexAbsentConfirmed,
        knownPhysicalIdCount: currentLedger.knownPhysicalIds.length,
    });
}

async function produceLocalRemoteBenchmark(input, dependencies) {
    const module = await import("./cloudflare-vectorize-local-remote-benchmark.mjs");
    return module.runVectorizeLocalRemoteBenchmark(input, dependencies);
}

function proofScenario(execution, prefix = "vector-proof") {
    const suffix = execution.ledger.nonce;
    return Object.freeze({
        migrationId: `${prefix}-migration-${suffix}`,
        owningName: `Vector proof owning ${suffix}`,
        owningSlug: `${prefix}-owning-${suffix}`,
        isolatedName: `Vector proof isolated ${suffix}`,
        isolatedSlug: `${prefix}-isolated-${suffix}`,
        mutationRunId: `${prefix}-${suffix}`,
        documentId: `${prefix}-document-${suffix}`,
        liveDocumentId: `${prefix}-live-document-${suffix}`,
        liveClientId: `${prefix}-live-client-${suffix}`,
    });
}

function controllerDefaults(prepared, execution, provisioning, options) {
    const scenario = proofScenario(execution);
    return Object.freeze({
        origin: prepared.origin,
        admin: Object.freeze({ token: execution.secrets.adminToken, runId: execution.secrets.runId }),
        releaseSha256: execution.candidate.digest,
        ...scenario,
        initialText: "Cloudflare Vectorize proof initial document",
        initialValues: PROOF_VECTOR_INITIAL_VALUES,
        replacementText: "Cloudflare Vectorize proof replacement document",
        replacementValues: PROOF_VECTOR_REPLACEMENT_VALUES,
        liveInitialText: "Cloudflare Vectorize live proof initial document",
        liveInitialValues: PROOF_LIVE_VECTOR_INITIAL_VALUES,
        liveReplacementText: "Cloudflare Vectorize live proof replacement document",
        liveReplacementValues: PROOF_LIVE_VECTOR_REPLACEMENT_VALUES,
        liveQueryValues: PROOF_LIVE_VECTOR_QUERY_VALUES,
        initialVersion: provisioning.deployment,
        timeoutMs: options.timeoutMs ?? VECTORIZE_LIFECYCLE_TIMEOUT_MS,
        intervalMs: options.intervalMs ?? 1_000,
        secrets: Object.freeze([
            execution.secrets.betterAuthSecret,
            execution.secrets.adminToken,
            execution.secrets.runId,
        ]),
        benchmark: options.benchmark,
    });
}

async function finalizeCloudflareVectorizeProofReport(input) {
    const lifecycle = exactObject(input.lifecycle, "Vectorize lifecycle report evidence");
    const cleanup = exactObject(input.cleanupResult, "Vectorize cleanup result");
    const localRemotePhysicalIds = exactPhysicalIds(
        input.benchmarkPreparation.localRemotePhysicalIds,
        "local remote-binding report physical IDs"
    );
    const expectedPhysicalIds = [...cleanup.ledger.knownPhysicalIds];
    const outputFiles = [
        ...DEPLOYMENT_FILES.map(relative => path.join(input.prepared.app, ...relative.split("/"))),
        path.join(input.output, "vectorize-proof-plan.json"),
        input.prepared.preparationPath,
        input.prepared.checksumPath,
        input.executionPath,
        input.executionChecksumPath,
    ];
    const filesScanned = outputFiles.length + 2;
    const completedAt = new Date(input.now()).toISOString();
    const report = {
        schema: "chardb.cloudflare-vectorize-proof.report.v2",
        ok: true,
        startedAt: input.startedAt,
        completedAt,
        candidate: input.execution.candidate,
        target: {
            worker: input.execution.target.worker,
            index: input.execution.target.index,
            origin: input.prepared.origin,
            accountIdSha256: input.accountVerification.accountIdSha256,
        },
        wranglerVersion: CLOUDFLARE_VECTORIZE_PROOF_WRANGLER_VERSION,
        deploymentInput: input.prepared.deploymentInput,
        versions: lifecycle.versions,
        descriptor: lifecycle.descriptor,
        index: {
            absentBefore: input.provisioning.ledger.indexAbsentConfirmed === true,
            created: input.provisioning.ledger.indexCreated === true,
            name: input.execution.target.index,
            dimensions: 32,
            metric: "cosine",
            metadataIndexes: [{ propertyName: "cdb_resource", type: "string" }],
        },
        lifecycle: lifecycle.lifecycle,
        delivery: lifecycle.delivery,
        faults: lifecycle.faults,
        search: lifecycle.search,
        settlement: lifecycle.settlement,
        benchmark: lifecycle.benchmark,
        cleanup: {
            expectedPhysicalIds,
            discoveredPhysicalIds: cleanup.discoveredPhysicalIds,
            localRemotePhysicalIds,
            exactIdsDeleted: true,
            finalVectorCount: cleanup.finalVectorCount,
            workerDeleted: cleanup.ledger.workerDeleted === true,
            indexDeleted: cleanup.ledger.indexDeleted === true,
            workerAbsentVerified: cleanup.workerAbsent === true,
            indexAbsentVerified: cleanup.indexAbsent === true,
        },
        evidence: { secretScanPassed: true, checksumFile: "evidence.sha256", filesScanned },
        error: null,
    };
    assertCloudflareVectorizeProofReport(report, input.execution.candidate);
    const staging = path.join(input.execution.privateDir, "final-report");
    await assertEmptyOrCreate(staging, 0o700);
    const stagedReport = path.join(staging, "vectorize-proof-report.json");
    const stagedChecksum = path.join(staging, "evidence.sha256");
    await atomicJson(stagedReport, report);
    const reportSha256 = sha256(await readFile(stagedReport));
    await atomicWrite(stagedChecksum, `${reportSha256}  vectorize-proof-report.json\n`, 0o600);
    const secrets = [
        input.execution.secrets.betterAuthSecret,
        input.execution.secrets.adminToken,
        input.execution.secrets.runId,
    ];
    await assertNoCloudflareVectorizeProofSecrets([...outputFiles, stagedReport, stagedChecksum], secrets);
    await validateCloudflareVectorizeProofEvidence({
        report: stagedReport,
        checksum: stagedChecksum,
        candidate: path.join(input.prepared.app, "chardb-proof.tgz"),
    });
    const reportPath = path.join(input.output, "vectorize-proof-report.json");
    const checksumPath = path.join(input.output, "evidence.sha256");
    await rename(stagedReport, reportPath);
    await rename(stagedChecksum, checksumPath);
    return Object.freeze({ report, reportPath, checksumPath, reportSha256, completedAt });
}

export async function executePreparedCloudflareVectorizeProof(input, dependencies = {}) {
    const prepared = exactObject(input.prepared, "prepared Vectorize proof");
    const accountId = String(input.accountId ?? "").toLowerCase();
    const profile = input.profile ?? "default";
    if (!ACCOUNT_ID.test(accountId)) throw new Error("Cloudflare account ID must be exactly 32 hexadecimal characters");
    if (!PROFILE.test(profile)) throw new Error("Wrangler profile is invalid");
    const execution = await assertPreparedExecutionInput(prepared);
    const secrets = [execution.secrets.betterAuthSecret, execution.secrets.adminToken, execution.secrets.runId];
    const output = path.dirname(prepared.preparationPath);
    const evidencePath = path.join(output, "vectorize-proof-execution.json");
    const checksumPath = path.join(output, "execution.sha256");
    const wranglerDependencies = Object.freeze({
        run: dependencies.runWrangler ?? runWranglerInvocation,
        now: dependencies.now,
        sleep: dependencies.sleep,
    });
    const privateEnvironmentKeys = new Set(["BETTER_AUTH_SECRET", "CDB_ADMIN_TOKEN", "CDB_PROOF_RUN_ID"]);
    const baseEnvironment = Object.fromEntries(
        Object.entries(input.baseEnvironment ?? process.env).filter(([key]) => !privateEnvironmentKeys.has(key))
    );
    const runnerInput = Object.freeze({
        ledgerPath: prepared.ledgerPath,
        candidateSha256: execution.candidate.digest,
        accountId,
        profile,
        logPath: path.join(execution.privateDir, "wrangler-live.log"),
        cwd: prepared.app,
        config: prepared.config,
        secretsFile: prepared.secretsFile,
        wranglerExecutable: execution.wranglerExecutable,
        baseEnvironment: Object.freeze(baseEnvironment),
        pollTimeoutMs: input.wranglerPollTimeoutMs ?? WRANGLER_READINESS_TIMEOUT_MS,
        pollIntervalMs: input.wranglerPollIntervalMs ?? 1_000,
        settlementTimeoutMs: input.lifecycleTimeoutMs ?? VECTORIZE_LIFECYCLE_TIMEOUT_MS,
    });
    const startedAt = new Date(dependencies.now?.() ?? Date.now()).toISOString();
    let evidence = {
        schema: CLOUDFLARE_VECTORIZE_PROOF_EXECUTION_SCHEMA,
        ok: false,
        phase: "prepared",
        startedAt,
        completedAt: null,
        candidate: execution.candidate,
        target: execution.target,
        profile,
        provisioning: null,
        benchmarkPreparation: null,
        deployedLifecycle: null,
        lifecycle: null,
        redeploy: null,
        cleanup: null,
        error: null,
        cleanupError: null,
        reportGenerated: false,
        checkpoint: null,
    };
    const persist = async () => {
        await atomicJson(evidencePath, evidence);
        await assertNoCloudflareVectorizeProofSecrets([evidencePath], secrets);
    };
    await persist();
    const provision = dependencies.provision ?? executeCloudflareVectorizeProvisioning;
    const cleanup = dependencies.cleanup ?? executeCloudflareVectorizeCleanup;
    const redeploy = dependencies.redeploy ?? executeCloudflareVectorizeRedeploy;
    const appendOwnedIds = dependencies.appendOwnedIds ?? appendVectorizeOwnedPhysicalIds;
    const produceLocalFake = dependencies.produceLocalFakeBenchmark ?? produceNativeVectorizeBenchmark;
    const produceLocalRemote = dependencies.produceLocalRemoteBenchmark ?? produceLocalRemoteBenchmark;
    const lifecycle =
        dependencies.lifecycle ??
        createCloudflareVectorizeProofLifecycle({
            fetch: dependencies.fetch,
            now: dependencies.now,
            sleep: dependencies.sleep,
            openLiveVectorSubscription:
                dependencies.openLiveVectorSubscription ??
                (input =>
                    openCloudflareVectorizeProofLiveSubscription({
                        ...input,
                        candidateEntry: path.join(prepared.app, "node_modules", "@chardb", "core", "dist", "index.mjs"),
                    })),
        });
    const createController = dependencies.createController ?? createCloudflareVectorizeProofController;
    let primaryError;
    let cleanupError;
    let provisioning;
    let accountVerification;
    let cleanupResult;
    let cleanupAttempted = false;
    try {
        evidence = { ...evidence, phase: "local-fake-benchmark" };
        await persist();
        const localFakeArtifact = await produceLocalFake();
        const localFake = cloudflareVectorizeProofBenchmarkTrack(localFakeArtifact, "local-workerd-fake-vectorize");
        await assertCloudflareVectorizeDeploymentUnchanged(prepared);
        evidence = { ...evidence, phase: "provisioning" };
        await persist();
        provisioning = await provision(runnerInput, wranglerDependencies);
        accountVerification = verifiedWranglerAccount(provisioning.accountVerification, profile, accountId);
        evidence = {
            ...evidence,
            phase: "lifecycle",
            provisioning: Object.freeze({
                deployment: provisioning.deployment,
                accountVerification,
                workerCreated: provisioning.ledger.workerCreated === true,
                indexCreated: provisioning.ledger.indexCreated === true,
                metadataIndexCreated: provisioning.ledger.metadataIndexCreated === true,
            }),
        };
        await persist();
        const localScenario = proofScenario(execution, "vector-proof-local");
        let redeployCalls = 0;
        const controller = createController({
            lifecycle,
            now: dependencies.now,
            sleep: dependencies.sleep,
            checkpoint: async value => {
                evidence = { ...evidence, checkpoint: `controller:${value}` };
                await persist();
            },
            appendOwnedIds: async intent => {
                await appendOwnedIds(prepared.ledgerPath, execution.candidate.digest, intent.physicalIds);
            },
            redeploy: async callbackInput => {
                await assertCloudflareVectorizeDeploymentUnchanged(prepared);
                redeployCalls++;
                if (redeployCalls !== 1) throw new Error("Vectorize proof controller requested more than one redeploy");
                if (callbackInput.initialVersion.versionId !== provisioning.deployment.versionId) {
                    throw new Error("Vectorize proof controller redeploy drifted from the provisioned version");
                }
                const result = await redeploy(
                    { ...runnerInput, initialVersionId: provisioning.deployment.versionId },
                    wranglerDependencies
                );
                verifiedWranglerAccount(result.accountVerification, profile, accountId);
                evidence = { ...evidence, redeploy: result.deployment };
                await persist();
                return result.deployment;
            },
            releaseFault: async callbackInput => {
                const organizationId = callbackInput.state.head?.organizationId;
                if (typeof organizationId !== "string" || organizationId.length === 0) {
                    throw new Error("held Vectorize fault has no owning organization");
                }
                const response = await lifecycle.requestJson({
                    origin: prepared.origin,
                    path: "/proof/vector-fault/release",
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${execution.secrets.adminToken}`,
                        "x-chardb-proof-run-id": execution.secrets.runId,
                    },
                    body: {
                        organizationId,
                        vectorId: callbackInput.claim.vectorId,
                        gateDeadline: callbackInput.claim.gateDeadline,
                        physicalIds: callbackInput.claim.physicalIds,
                        payloadSha256: callbackInput.claim.payloadSha256,
                    },
                    label: "vector proof fault release",
                });
                const body = exactObject(response.body, "vector proof fault release response");
                if (body.released !== true || body.gateDeadline !== callbackInput.claim.gateDeadline) {
                    throw new Error("vector proof fault release identity drifted");
                }
                return Object.freeze({ released: true, gateDeadline: body.gateDeadline });
            },
            recordDeployedLifecycle: async deployedLifecycle => {
                evidence = {
                    ...evidence,
                    phase: "deployed-lifecycle",
                    checkpoint: null,
                    deployedLifecycle: assertSecretFreeExecutionValue(
                        deployedLifecycle,
                        secrets,
                        "deployed Vectorize lifecycle evidence"
                    ),
                };
                await persist();
            },
            loadComparisonBenchmark: async () => {
                if (evidence.deployedLifecycle === null) {
                    throw new Error("local remote-binding comparison started before deployed lifecycle evidence");
                }
                await assertCloudflareVectorizeDeploymentUnchanged(prepared);
                evidence = { ...evidence, phase: "local-remote-benchmark", checkpoint: null };
                await persist();
                const remoteResult = exactObject(
                    await produceLocalRemote(
                        {
                            prepared,
                            persistenceDir: path.join(execution.privateDir, "local-remote-runtime", "persistence"),
                            runtimeDir: path.join(execution.privateDir, "local-remote-runtime"),
                            wrangler: execution.wranglerExecutable,
                            profile,
                            accountId,
                            ...localScenario,
                            text: "Cloudflare Vectorize local remote-binding benchmark document",
                            values: PROOF_VECTOR_REPLACEMENT_VALUES,
                            timeoutMs: input.lifecycleTimeoutMs ?? VECTORIZE_LIFECYCLE_TIMEOUT_MS,
                            intervalMs: input.lifecycleIntervalMs,
                            startupTimeoutMs: input.localRemoteStartupTimeoutMs,
                            requestTimeoutMs: input.localRemoteRequestTimeoutMs,
                            baseEnvironment: Object.freeze(baseEnvironment),
                        },
                        {
                            appendOwnedIds: async intent => {
                                await appendOwnedIds(
                                    prepared.ledgerPath,
                                    execution.candidate.digest,
                                    intent.physicalIds
                                );
                            },
                            checkpoint: async value => {
                                evidence = { ...evidence, checkpoint: `local-remote:${value}` };
                                await persist();
                            },
                            fetch: dependencies.fetch,
                            now: dependencies.now,
                            sleep: dependencies.sleep,
                        }
                    ),
                    "local remote-binding benchmark result"
                );
                const benchmark = assertCloudflareVectorizeProofBenchmark({
                    workloadId: BENCHMARK_WORKLOAD_ID,
                    localFake,
                    localRemoteBinding: remoteResult.track,
                    localRemoteQueryStability: exactObject(
                        remoteResult.evidence,
                        "local remote-binding benchmark evidence"
                    ).queryStability,
                    localRemotePostStabilitySampling: exactObject(
                        remoteResult.evidence,
                        "local remote-binding benchmark evidence"
                    ).postStabilitySampling,
                });
                const remoteEvidence = assertSecretFreeExecutionValue(
                    remoteResult.evidence,
                    secrets,
                    "local remote-binding benchmark evidence"
                );
                if (
                    exactObject(remoteEvidence, "local remote-binding benchmark evidence").candidateSha256 !==
                    execution.candidate.digest
                ) {
                    throw new Error("local remote-binding benchmark candidate differs from the proof candidate");
                }
                const remotePhysicalIds = exactPhysicalIds(
                    exactObject(remoteEvidence, "local remote-binding benchmark evidence").physicalIds,
                    "local remote-binding benchmark evidence physical IDs"
                );
                const ledgerAfterRemote = JSON.parse(
                    await readExactPrivateFile(prepared.ledgerPath, "Vectorize ownership ledger", 64 * 1024)
                );
                if (
                    !Array.isArray(ledgerAfterRemote.knownPhysicalIds) ||
                    remotePhysicalIds.some(id => !ledgerAfterRemote.knownPhysicalIds.includes(id))
                ) {
                    throw new Error("local remote-binding benchmark contains an ID absent from the ownership ledger");
                }
                evidence = {
                    ...evidence,
                    checkpoint: null,
                    benchmarkPreparation: Object.freeze({
                        localFake,
                        localRemoteBinding: benchmark.localRemoteBinding,
                        localRemoteQueryStability: benchmark.localRemoteQueryStability,
                        localRemotePostStabilitySampling: benchmark.localRemotePostStabilitySampling,
                        localRemotePhysicalIds: remotePhysicalIds,
                        localRemoteEvidence: remoteEvidence,
                    }),
                };
                await persist();
                return Object.freeze({
                    localRemoteBinding: benchmark.localRemoteBinding,
                    localRemoteQueryStability: benchmark.localRemoteQueryStability,
                    localRemotePostStabilitySampling: benchmark.localRemotePostStabilitySampling,
                });
            },
        });
        const lifecycleEvidence = await controller.run(
            controllerDefaults(prepared, execution, provisioning, {
                timeoutMs: input.lifecycleTimeoutMs,
                intervalMs: input.lifecycleIntervalMs,
                benchmark: Object.freeze({ workloadId: BENCHMARK_WORKLOAD_ID, localFake }),
            })
        );
        evidence = {
            ...evidence,
            phase: "cleanup",
            checkpoint: null,
            lifecycle: assertSecretFreeExecutionValue(lifecycleEvidence, secrets, "Vectorize lifecycle evidence"),
        };
        await persist();
    } catch (error) {
        primaryError = error;
        evidence = { ...evidence, phase: "failed", error: safeExecutionError(error, secrets) };
        await persist();
    } finally {
        try {
            const currentLedger = JSON.parse(
                await readExactPrivateFile(prepared.ledgerPath, "Vectorize ownership ledger", 64 * 1024)
            );
            const decision = cleanupDecisionFromLedger(currentLedger);
            if (decision.required) {
                cleanupAttempted = true;
                const cleaned = await cleanup(runnerInput, wranglerDependencies);
                cleanupResult = cleaned;
                evidence = {
                    ...evidence,
                    cleanup: Object.freeze({
                        required: true,
                        attempted: true,
                        workerAbsent: cleaned.workerAbsent === true,
                        indexAbsent: cleaned.indexAbsent === true,
                        workerDeleted: cleaned.ledger.workerDeleted === true,
                        indexDeleted: cleaned.ledger.indexDeleted === true,
                        knownPhysicalIdCount: cleaned.ledger.knownPhysicalIds.length,
                    }),
                };
            } else {
                evidence = {
                    ...evidence,
                    cleanup: Object.freeze({
                        required: false,
                        attempted: false,
                        workerAbsent: decision.workerAbsentConfirmed === true ? true : null,
                        indexAbsent: decision.indexAbsentConfirmed === true ? true : null,
                        workerDeleted: false,
                        indexDeleted: false,
                        knownPhysicalIdCount: decision.knownPhysicalIdCount,
                    }),
                };
            }
        } catch (error) {
            cleanupError = error;
            evidence = { ...evidence, cleanupError: safeExecutionError(error, secrets) };
            if (cleanupAttempted) {
                try {
                    const partialLedger = JSON.parse(
                        await readExactPrivateFile(prepared.ledgerPath, "Vectorize ownership ledger", 64 * 1024)
                    );
                    const partialDecision = cleanupDecisionFromLedger(partialLedger);
                    if (
                        typeof partialLedger.workerDeleted === "boolean" &&
                        typeof partialLedger.indexDeleted === "boolean"
                    ) {
                        evidence = {
                            ...evidence,
                            cleanup: Object.freeze({
                                required: partialDecision.required,
                                attempted: true,
                                workerAbsent: null,
                                indexAbsent: null,
                                workerDeleted: partialLedger.workerDeleted,
                                indexDeleted: partialLedger.indexDeleted,
                                knownPhysicalIdCount: partialDecision.knownPhysicalIdCount,
                            }),
                        };
                    }
                } catch {
                    // The original cleanup error remains authoritative when its ledger cannot be recovered safely.
                }
            }
        }
        const readyForReport =
            primaryError === undefined &&
            cleanupError === undefined &&
            evidence.lifecycle !== null &&
            cleanupResult !== undefined;
        evidence = {
            ...evidence,
            ok: false,
            phase: readyForReport ? "finalizing-report" : "failed",
            completedAt: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
            reportGenerated: false,
        };
        await persist();
        const digest = sha256(await readFile(evidencePath));
        await atomicWrite(checksumPath, `${digest}  vectorize-proof-execution.json\n`, 0o600);
        await assertNoCloudflareVectorizeProofSecrets([evidencePath, checksumPath], secrets);
    }
    let finalReport;
    if (!primaryError && !cleanupError && evidence.lifecycle !== null && cleanupResult !== undefined) {
        try {
            finalReport = await finalizeCloudflareVectorizeProofReport({
                prepared,
                execution,
                output,
                accountVerification,
                startedAt,
                provisioning,
                lifecycle: evidence.lifecycle,
                benchmarkPreparation: evidence.benchmarkPreparation,
                cleanupResult,
                executionPath: evidencePath,
                executionChecksumPath: checksumPath,
                now: dependencies.now ?? Date.now,
            });
            evidence = {
                ...evidence,
                ok: true,
                phase: "complete",
                completedAt: finalReport.completedAt,
                reportGenerated: true,
                reportSha256: finalReport.reportSha256,
            };
        } catch (error) {
            primaryError = error;
            evidence = {
                ...evidence,
                ok: false,
                phase: "failed",
                error: safeExecutionError(error, secrets),
                reportGenerated: false,
            };
        }
        await persist();
        const digest = sha256(await readFile(evidencePath));
        await atomicWrite(checksumPath, `${digest}  vectorize-proof-execution.json\n`, 0o600);
        await assertNoCloudflareVectorizeProofSecrets([evidencePath, checksumPath], secrets);
    }
    if (primaryError || cleanupError) {
        const failures = [primaryError, cleanupError]
            .filter(Boolean)
            .map(error => safeExecutionError(error, secrets).message);
        throw new Error(`Cloudflare Vectorize proof failed; evidence: ${evidencePath}; ${failures.join("; ")}`);
    }
    return Object.freeze({
        evidence: Object.freeze(evidence),
        evidencePath,
        checksumPath,
        reportPath: finalReport.reportPath,
        reportChecksumPath: finalReport.checksumPath,
        reportSha256: finalReport.reportSha256,
    });
}

function usage() {
    return [
        "Usage: bun scripts/cloudflare-vectorize-proof-orchestrator.mjs [options]",
        "",
        "Prepares and validates the exact candidate. It does not contact Cloudflare.",
        "",
        "  --tarball <file>",
        "  --output <empty-directory>",
        "  --private-dir <separate-empty-directory>",
        "  --workers-dev-subdomain <label>",
        "  --confirm-disposable-resources",
        "  --npm <executable>                 defaults to npm",
        "  --execute                          provision, run proof, and always clean up",
        "  --account-id <32-hex-id>           required with --execute",
        "  --profile <safe-name>              defaults to Wrangler profile default",
    ].join("\n");
}

if (import.meta.main) {
    const options = parseCloudflareVectorizeOrchestratorArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
    } else {
        const prepared = await prepareCloudflareVectorizeProof(options);
        if (options.execute) {
            const executed = await executePreparedCloudflareVectorizeProof({
                prepared,
                accountId: options.accountId,
                profile: options.profile,
            });
            process.stdout.write(`${JSON.stringify(executed)}\n`);
        } else {
            process.stdout.write(`${JSON.stringify(prepared)}\n`);
        }
    }
}
