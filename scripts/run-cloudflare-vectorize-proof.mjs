import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTemporaryWranglerLogRemoved } from "./cloudflare-vectorize-wrangler-log.mjs";

export const CLOUDFLARE_VECTORIZE_PROOF_OWNERSHIP_SCHEMA = "chardb.cloudflare-vectorize-proof.ownership.v1";
export const CLOUDFLARE_VECTORIZE_PROOF_PLAN_SCHEMA = "chardb.cloudflare-vectorize-proof.plan.v1";

const RESOURCE_PREFIX = "chardb-vx-proof-";
// Operational patience for Cloudflare's eventually consistent list view, not a service settlement guarantee.
const VECTORIZE_REMOTE_SETTLEMENT_TIMEOUT_MS = 10 * 60_000;
const WRANGLER_VERSION = "4.125.0";
const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{16}$/;
const RUN_ID = /^[A-Za-z0-9_-]{16,128}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PHYSICAL_ID = /^p1_([A-Za-z0-9_-]{43})_([1-9a-z][0-9a-z]*)$/;
const AUTH_ENV_KEYS = Object.freeze([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_API_TOKEN",
    "CF_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
]);
const XDG_ENV_KEYS = Object.freeze(["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]);
const WRANGLER_SCOPED_ENV_KEYS = Object.freeze([...AUTH_ENV_KEYS, "WRANGLER_LOG_PATH", ...XDG_ENV_KEYS]);
const LEDGER_BOOLEAN_FIELDS = Object.freeze([
    "workerAbsentConfirmed",
    "indexAbsentConfirmed",
    "indexCreateIntent",
    "indexCreated",
    "metadataIndexCreateIntent",
    "metadataIndexCreated",
    "workerCreateIntent",
    "workerCreated",
    "workerDeleted",
    "indexDeleted",
]);
const LEDGER_KEYS = Object.freeze(
    [
        "schema",
        "candidateSha256",
        "nonce",
        "runId",
        "worker",
        "index",
        ...LEDGER_BOOLEAN_FIELDS,
        "knownPhysicalIds",
    ].sort()
);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function value(argv, flag) {
    const indexes = argv.flatMap((item, index) => (item === flag ? [index] : []));
    if (indexes.length > 1) throw new Error(`${flag} may be provided only once`);
    return indexes.length === 0 ? undefined : argv[indexes[0] + 1];
}

export function parseCloudflareVectorizeProofArgs(argv) {
    const valued = new Set([
        "--tarball",
        "--output",
        "--private-dir",
        "--workers-dev-subdomain",
        "--account-id",
        "--cleanup-ledger",
        "--config",
        "--cwd",
        "--secrets-file",
        "--wrangler",
        "--profile",
    ]);
    const boolean = new Set(["--confirm-disposable-resources", "--execute", "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!valued.has(argument) && !boolean.has(argument)) {
            throw new Error(`unknown Vectorize proof argument ${JSON.stringify(argument)}`);
        }
        if (valued.has(argument)) {
            const next = argv[++index];
            if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
        }
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const tarball = value(argv, "--tarball");
    const output = value(argv, "--output");
    const privateDir = value(argv, "--private-dir");
    const workersDevSubdomain = value(argv, "--workers-dev-subdomain");
    const rawAccountId = value(argv, "--account-id");
    const accountId = rawAccountId?.toLowerCase();
    const cleanupLedger = value(argv, "--cleanup-ledger");
    const config = value(argv, "--config");
    const cwd = value(argv, "--cwd");
    const secretsFile = value(argv, "--secrets-file");
    const wranglerExecutable = value(argv, "--wrangler") ?? "wrangler";
    const profile = value(argv, "--profile");
    const confirmed = argv.includes("--confirm-disposable-resources");
    const execute = argv.includes("--execute");
    const mode = cleanupLedger ? "cleanup-plan" : "proof-plan";
    if (!help) {
        if (!tarball) throw new Error("--tarball is required");
        if (!accountId || !ACCOUNT_ID.test(accountId)) {
            throw new Error("--account-id must be exactly 32 hexadecimal characters");
        }
        if (!confirmed) throw new Error("--confirm-disposable-resources is required");
        if (mode === "proof-plan") {
            for (const [flag, item] of [
                ["--output", output],
                ["--private-dir", privateDir],
                ["--workers-dev-subdomain", workersDevSubdomain],
            ]) {
                if (!item) throw new Error(`${flag} is required`);
            }
            if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersDevSubdomain)) {
                throw new Error("--workers-dev-subdomain must be one lowercase Cloudflare subdomain label");
            }
            const outputPath = path.resolve(output);
            const privatePath = path.resolve(privateDir);
            if (
                outputPath === privatePath ||
                outputPath.startsWith(`${privatePath}${path.sep}`) ||
                privatePath.startsWith(`${outputPath}${path.sep}`)
            ) {
                throw new Error("--output and --private-dir must be separate trees");
            }
        } else if (output || privateDir || workersDevSubdomain) {
            throw new Error("--cleanup-ledger mode does not accept proof output or subdomain options");
        }
        if (execute) {
            if (!config) throw new Error("--config is required with --execute");
            if (!cwd) throw new Error("--cwd is required with --execute");
            if (mode === "proof-plan" && !secretsFile) throw new Error("--secrets-file is required with --execute");
            if (profile !== undefined && !PROFILE.test(profile)) {
                throw new Error("--profile must be a safe Wrangler profile name");
            }
        } else if (config || cwd || secretsFile || value(argv, "--wrangler") || profile) {
            throw new Error("Wrangler execution options require --execute");
        }
    }
    return {
        help,
        mode,
        tarball,
        output,
        privateDir,
        workersDevSubdomain,
        accountId,
        cleanupLedger,
        confirmed,
        execute,
        config,
        cwd,
        secretsFile,
        wranglerExecutable,
        profile,
    };
}

export function deriveDisposableVectorizeResourceNames(candidateDigest, nonce) {
    if (!SHA256.test(candidateDigest)) throw new Error("candidate SHA-256 is invalid");
    if (!NONCE.test(nonce)) throw new Error("proof nonce must contain 16 lowercase hexadecimal characters");
    const name = `${RESOURCE_PREFIX}${candidateDigest.slice(0, 10)}-${nonce}`;
    if (new TextEncoder().encode(name).byteLength > 64) throw new Error("disposable Vectorize name exceeds 64 bytes");
    return Object.freeze({ worker: name, index: name });
}

function assertPhysicalIds(value) {
    const invalidVersion = item => {
        const match = PHYSICAL_ID.exec(item);
        const rawDigest = match?.[1] ?? "";
        const bytes = Buffer.from(rawDigest, "base64url");
        if (bytes.byteLength !== 32 || bytes.toString("base64url") !== rawDigest) return true;
        const rawVersion = match?.[2];
        let version = 0;
        for (const character of rawVersion ?? "") {
            const digit = Number.parseInt(character, 36);
            if (version > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 36)) return true;
            version = version * 36 + digit;
        }
        return !Number.isSafeInteger(version) || version < 1 || version.toString(36) !== rawVersion;
    };
    if (
        !Array.isArray(value) ||
        value.length > 512 ||
        new Set(value).size !== value.length ||
        value.some(item => typeof item !== "string" || !PHYSICAL_ID.test(item) || invalidVersion(item))
    ) {
        throw new Error("Vectorize cleanup physical-id ledger is invalid");
    }
    return value;
}

function assertVectorizeOwnershipLedger(ledger, expectedCandidateDigest) {
    if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
        throw new Error("Vectorize cleanup ownership ledger must be an object");
    }
    const actualKeys = Object.keys(ledger).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(LEDGER_KEYS)) {
        throw new Error(`Vectorize cleanup ownership ledger fields must be exactly ${LEDGER_KEYS.join(", ")}`);
    }
    if (ledger.schema !== CLOUDFLARE_VECTORIZE_PROOF_OWNERSHIP_SCHEMA) {
        throw new Error("Vectorize cleanup ownership ledger schema is invalid");
    }
    if (ledger.candidateSha256 !== expectedCandidateDigest) {
        throw new Error("Vectorize cleanup candidate digest drifted");
    }
    if (!NONCE.test(ledger.nonce ?? "") || !RUN_ID.test(ledger.runId ?? "")) {
        throw new Error("Vectorize cleanup nonce or run ID is invalid");
    }
    const expected = deriveDisposableVectorizeResourceNames(expectedCandidateDigest, ledger.nonce);
    if (ledger.worker !== expected.worker || ledger.index !== expected.index || ledger.worker !== ledger.index) {
        throw new Error("Vectorize cleanup resource names are not derived from the owned candidate and nonce");
    }
    for (const field of LEDGER_BOOLEAN_FIELDS) {
        if (typeof ledger[field] !== "boolean") throw new Error(`Vectorize ownership ${field} must be boolean`);
    }
    if (ledger.indexCreated && (!ledger.indexCreateIntent || !ledger.indexAbsentConfirmed)) {
        throw new Error("Vectorize ownership index creation state is impossible");
    }
    if (ledger.metadataIndexCreateIntent && !ledger.indexCreateIntent) {
        throw new Error("Vectorize ownership metadata-index intent requires index intent");
    }
    if (ledger.metadataIndexCreated && (!ledger.metadataIndexCreateIntent || !ledger.indexCreated)) {
        throw new Error("Vectorize ownership metadata-index creation state is impossible");
    }
    if (ledger.workerCreated && (!ledger.workerCreateIntent || !ledger.workerAbsentConfirmed)) {
        throw new Error("Vectorize ownership Worker creation state is impossible");
    }
    if (ledger.workerDeleted && !ledger.workerCreated) {
        throw new Error("Vectorize ownership cannot delete an unowned Worker");
    }
    if (ledger.indexDeleted && !ledger.indexCreated) {
        throw new Error("Vectorize ownership cannot delete an unowned index");
    }
    assertPhysicalIds(ledger.knownPhysicalIds);
    return Object.freeze({ ...ledger, ...expected, knownPhysicalIds: Object.freeze([...ledger.knownPhysicalIds]) });
}

export function assertVectorizeCleanupOwnership(ledger, expectedCandidateDigest) {
    const owned = assertVectorizeOwnershipLedger(ledger, expectedCandidateDigest);
    if (!owned.workerAbsentConfirmed || !owned.indexAbsentConfirmed) {
        throw new Error("Vectorize cleanup requires both absent-resource preflight checks");
    }
    if (!owned.workerCreateIntent && !owned.indexCreateIntent) {
        throw new Error("Vectorize cleanup ledger records no resource creation intent");
    }
    return owned;
}

function command(args, phase, destructive = false) {
    return Object.freeze({ executable: "wrangler", args: Object.freeze([...args]), phase, destructive });
}

function withWranglerProfile(planned, profile) {
    if (profile === undefined) return planned;
    if (!PROFILE.test(profile)) throw new Error("Wrangler profile name is invalid");
    return command([...planned.args, "--profile", profile], planned.phase, planned.destructive);
}

function profileAccountPreflightCommands(profile) {
    if (profile === undefined) return [];
    if (!PROFILE.test(profile)) throw new Error("Wrangler profile name is invalid");
    return [
        withWranglerProfile(command(["auth", "token", "--json"], "profile-auth-preflight"), profile),
        command(["whoami", "--json"], "profile-account-preflight"),
    ];
}

export function planCloudflareVectorizeCommands(input) {
    const names = deriveDisposableVectorizeResourceNames(input.candidateSha256, input.nonce);
    const description = `Chardb disposable proof ${input.candidateSha256.slice(0, 12)}`;
    const plan = {
        schema: CLOUDFLARE_VECTORIZE_PROOF_PLAN_SCHEMA,
        mutatingCommandsExecuted: false,
        preflight: Object.freeze([
            ...profileAccountPreflightCommands(input.profile),
            command(["versions", "list", "--name", names.worker, "--json"], "worker-absence"),
            command(["vectorize", "list", "--json"], "index-list-absence"),
            command(["vectorize", "get", names.index, "--json"], "index-get-absence"),
        ]),
        creation: Object.freeze([
            command(
                [
                    "vectorize",
                    "create",
                    names.index,
                    "--dimensions",
                    "32",
                    "--metric",
                    "cosine",
                    "--description",
                    description,
                    "--json",
                ],
                "index-create",
                true
            ),
            command(["vectorize", "get", names.index, "--json"], "index-readiness"),
            command(
                [
                    "vectorize",
                    "create-metadata-index",
                    names.index,
                    "--propertyName",
                    "cdb_resource",
                    "--type",
                    "string",
                ],
                "metadata-index-create",
                true
            ),
            command(["vectorize", "list-metadata-index", names.index, "--json"], "metadata-index-readiness"),
            command(
                [
                    "deploy",
                    "--name",
                    names.worker,
                    "--strict",
                    "--secrets-file",
                    input.secretsFile ?? "<private-secrets-file>",
                    "--tag",
                    `vx-${input.nonce}-v1`,
                ],
                "worker-deploy",
                true
            ),
            command(["versions", "list", "--name", names.worker, "--json"], "worker-version-evidence"),
            command(["deployments", "status", "--name", names.worker, "--json"], "worker-deployment-evidence"),
        ]),
    };
    return Object.freeze({
        ...plan,
        preflight: Object.freeze(
            plan.preflight.map(item =>
                item.phase === "profile-auth-preflight" || item.phase === "profile-account-preflight"
                    ? item
                    : withWranglerProfile(item, input.profile)
            )
        ),
        creation: Object.freeze(plan.creation.map(item => withWranglerProfile(item, input.profile))),
    });
}

export function planVectorizeListCommand(index, cursor, phase = "vector-list-before-cleanup", profile = undefined) {
    if (typeof index !== "string" || !index.startsWith(RESOURCE_PREFIX))
        throw new Error("Vectorize index name is invalid");
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 1024)) {
        throw new Error("Vectorize list cursor is invalid");
    }
    return withWranglerProfile(
        command(
            [
                "vectorize",
                "list-vectors",
                index,
                "--count",
                "1000",
                ...(cursor === undefined ? [] : ["--cursor", cursor]),
                "--json",
            ],
            phase
        ),
        profile
    );
}

export function planCloudflareVectorizeCleanupCommands(ledger, expectedCandidateDigest, options = {}) {
    const owned = assertVectorizeCleanupOwnership(ledger, expectedCandidateDigest);
    const vectorDeletes = [];
    for (let index = 0; index < owned.knownPhysicalIds.length; index += 32) {
        const ids = owned.knownPhysicalIds.slice(index, index + 32);
        vectorDeletes.push(
            command(["vectorize", "delete-vectors", owned.index, "--ids", ...ids], "exact-vector-delete", true)
        );
    }
    const commands = [
        ...profileAccountPreflightCommands(options.profile),
        ...(!ledger.indexCreated && ledger.indexCreateIntent
            ? [command(["vectorize", "get", owned.index, "--json"], "index-create-reconcile")]
            : []),
        ...(!ledger.workerCreated && ledger.workerCreateIntent
            ? [command(["versions", "list", "--name", owned.worker, "--json"], "worker-create-reconcile")]
            : []),
        ...(ledger.indexCreated && !ledger.indexDeleted
            ? [
                  planVectorizeListCommand(owned.index),
                  ...vectorDeletes,
                  planVectorizeListCommand(owned.index, undefined, "exact-vector-absence-verify"),
              ]
            : []),
        ...(ledger.workerCreated && !ledger.workerDeleted
            ? [
                  command(["versions", "list", "--name", owned.worker, "--json"], "worker-delete-reconcile"),
                  command(["delete", owned.worker, "--force"], "worker-delete", true),
              ]
            : []),
        ...(ledger.indexCreated && !ledger.indexDeleted
            ? [
                  command(["vectorize", "get", owned.index, "--json"], "index-delete-reconcile"),
                  command(["vectorize", "delete", owned.index, "--force"], "index-delete", true),
              ]
            : []),
        command(["versions", "list", "--name", owned.worker, "--json"], "worker-absence-verify"),
        command(["vectorize", "get", owned.index, "--json"], "index-absence-verify"),
        command(["vectorize", "list", "--json"], "index-list-absence-verify"),
    ];
    return Object.freeze(
        commands.map(item =>
            item.phase === "profile-auth-preflight" || item.phase === "profile-account-preflight"
                ? item
                : withWranglerProfile(item, options.profile)
        )
    );
}

export async function withWranglerAuthEnvironment(baseEnvironment, input, run) {
    if (!ACCOUNT_ID.test(input.accountId ?? "")) throw new Error("Wrangler account ID is invalid");
    const tokenMode = typeof input.apiToken === "string";
    const profileMode = typeof input.profile === "string";
    if (tokenMode === profileMode) throw new Error("Wrangler execution requires exactly one API token or profile");
    if (tokenMode && input.apiToken.length < 16) throw new Error("Wrangler API token is invalid");
    if (profileMode && !PROFILE.test(input.profile)) throw new Error("Wrangler profile name is invalid");
    if (typeof input.logPath !== "string" || !path.isAbsolute(input.logPath)) {
        throw new Error("Wrangler log path must be an absolute path inside the private proof directory");
    }
    const environment = { ...baseEnvironment };
    for (const key of [...AUTH_ENV_KEYS, "WRANGLER_LOG_PATH"]) delete environment[key];
    if (tokenMode) {
        for (const key of XDG_ENV_KEYS) delete environment[key];
        environment.CLOUDFLARE_ACCOUNT_ID = input.accountId;
        environment.CLOUDFLARE_API_TOKEN = input.apiToken;
    } else {
        environment.CLOUDFLARE_ACCOUNT_ID = input.accountId;
    }
    environment.WRANGLER_LOG_PATH = input.logPath;
    if (tokenMode) {
        const scopedRoot = path.dirname(input.logPath);
        environment.XDG_CONFIG_HOME = path.join(scopedRoot, "xdg-config");
        environment.XDG_CACHE_HOME = path.join(scopedRoot, "xdg-cache");
        environment.XDG_STATE_HOME = path.join(scopedRoot, "xdg-state");
    }
    try {
        return await run(environment);
    } finally {
        for (const key of WRANGLER_SCOPED_ENV_KEYS) delete environment[key];
    }
}

async function atomicJson(file, value, mode) {
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
}

async function emptyDirectory(directory, mode) {
    await mkdir(directory, { recursive: true, mode });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${directory} must be a directory, not a symlink`);
    }
    if ((await readdir(directory)).length > 0) throw new Error(`${directory} must be empty`);
    if (mode !== undefined) await chmod(directory, mode);
    return realpath(directory);
}

export async function fingerprintVectorizeProofCandidate(file) {
    const absolute = path.resolve(file);
    const [bytes, metadata] = await Promise.all([readFile(absolute), stat(absolute)]);
    if (!metadata.isFile()) throw new Error("Vectorize proof candidate must be a file");
    return Object.freeze({ algorithm: "sha256", digest: sha256(bytes), bytes: metadata.size });
}

export async function writeVectorizeOwnershipLedgerBeforeCreation(input) {
    const candidateSha256 = input.candidateSha256;
    const names = deriveDisposableVectorizeResourceNames(candidateSha256, input.nonce);
    const ledger = Object.freeze({
        schema: CLOUDFLARE_VECTORIZE_PROOF_OWNERSHIP_SCHEMA,
        candidateSha256,
        nonce: input.nonce,
        runId: input.runId,
        ...names,
        workerAbsentConfirmed: false,
        indexAbsentConfirmed: false,
        indexCreateIntent: false,
        indexCreated: false,
        metadataIndexCreateIntent: false,
        metadataIndexCreated: false,
        workerCreateIntent: false,
        workerCreated: false,
        workerDeleted: false,
        indexDeleted: false,
        knownPhysicalIds: Object.freeze([]),
    });
    if (!RUN_ID.test(input.runId ?? "")) throw new Error("proof run ID is invalid");
    await atomicJson(path.resolve(input.file), ledger, 0o600);
    return ledger;
}

export async function prepareCloudflareVectorizeProofPlan(input) {
    const output = path.resolve(input.output);
    const privateDir = path.resolve(input.privateDir);
    if (
        output === privateDir ||
        output.startsWith(`${privateDir}${path.sep}`) ||
        privateDir.startsWith(`${output}${path.sep}`)
    ) {
        throw new Error("Vectorize proof output and private directories must be separate trees");
    }
    const canonicalOutput = await emptyDirectory(output);
    const canonicalPrivateDir = await emptyDirectory(privateDir, 0o700);
    if (
        canonicalOutput === canonicalPrivateDir ||
        canonicalOutput.startsWith(`${canonicalPrivateDir}${path.sep}`) ||
        canonicalPrivateDir.startsWith(`${canonicalOutput}${path.sep}`)
    ) {
        throw new Error("Vectorize proof output and private directories must resolve to separate trees");
    }
    const candidate = await fingerprintVectorizeProofCandidate(input.tarball);
    const nonce = input.nonce ?? randomBytes(8).toString("hex");
    const runId = input.runId ?? randomBytes(24).toString("base64url");
    const ledgerPath = path.join(privateDir, "ownership.json");
    const ledger = await writeVectorizeOwnershipLedgerBeforeCreation({
        file: ledgerPath,
        candidateSha256: candidate.digest,
        nonce,
        runId,
    });
    const commands = planCloudflareVectorizeCommands({ candidateSha256: candidate.digest, nonce });
    const publicPlan = Object.freeze({
        schema: CLOUDFLARE_VECTORIZE_PROOF_PLAN_SCHEMA,
        candidate,
        target: { worker: ledger.worker, index: ledger.index },
        wranglerVersion: WRANGLER_VERSION,
        commands,
        mutatingCommandsExecuted: false,
    });
    await atomicJson(path.join(output, "vectorize-proof-plan.json"), publicPlan, 0o600);
    return Object.freeze({ publicPlan, ledgerPath });
}

async function readJson(file) {
    try {
        return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${file} is not valid JSON`);
        throw error;
    }
}

function commandForPhase(commands, phase) {
    const matches = commands.filter(item => item.phase === phase);
    if (matches.length !== 1) throw new Error(`Wrangler plan must contain exactly one ${phase} command`);
    return matches[0];
}

function strictJson(text, label) {
    if (typeof text !== "string" || text.trim().length === 0) throw new Error(`${label} returned no JSON`);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label} returned malformed JSON`);
    }
}

function resultObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        if ("success" in value && value.success !== true) throw new Error("Wrangler JSON envelope reports failure");
        if ("errors" in value && (!Array.isArray(value.errors) || value.errors.length > 0)) {
            throw new Error("Wrangler JSON envelope contains errors");
        }
        if ("result" in value) return value.result;
    }
    return value;
}

function assertCommandResult(value, label) {
    if (
        !value ||
        typeof value !== "object" ||
        !Number.isInteger(value.exitCode) ||
        typeof value.stdout !== "string" ||
        typeof value.stderr !== "string"
    ) {
        throw new Error(`${label} executor returned an invalid command result`);
    }
    return value;
}

function jsonSuccess(result, label) {
    if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
    return strictJson(result.stdout, label);
}

function isNotFound(result) {
    if (result.exitCode === 0) return false;
    return /(?:not[_.\s-]*found|does\s+not\s+exist|10090)/i.test(`${result.stdout}\n${result.stderr}`);
}

export function isIndexAbsent(result) {
    if (isNotFound(result)) return true;
    if (result.exitCode === 0) return false;
    const output = `${result.stdout}\n${result.stderr}`;
    return /vectorize\.index\.deleted/i.test(output) && /(?:\[code:\s*3005\]|\bcode\s*[:=]\s*3005\b)/i.test(output);
}

function asArray(value, label) {
    const unwrapped = resultObject(value);
    if (!Array.isArray(unwrapped)) throw new Error(`${label} must be a JSON array`);
    return unwrapped;
}

function indexEntries(value, label) {
    const unwrapped = resultObject(value);
    if (Array.isArray(unwrapped)) return unwrapped;
    if (unwrapped && typeof unwrapped === "object" && Array.isArray(unwrapped.indexes)) return unwrapped.indexes;
    throw new Error(`${label} must contain an index array`);
}

export function assertIndexDescriptor(value, expectedName, label, expected = { dimensions: 32, metric: "cosine" }) {
    const descriptor = resultObject(value);
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        throw new Error(`${label} must contain an index descriptor`);
    }
    const config = descriptor.config;
    if (
        descriptor.name !== expectedName ||
        !config ||
        typeof config !== "object" ||
        config.dimensions !== expected.dimensions ||
        config.metric !== expected.metric
    ) {
        throw new Error(`${label} Vectorize descriptor drifted from name, dimensions, or metric`);
    }
    return descriptor;
}

export function assertMetadataIndex(value, label) {
    const unwrapped = resultObject(value);
    const indexes = Array.isArray(unwrapped)
        ? unwrapped
        : unwrapped && typeof unwrapped === "object" && Array.isArray(unwrapped.metadataIndexes)
          ? unwrapped.metadataIndexes
          : undefined;
    if (!indexes) throw new Error(`${label} must contain a metadata-index array`);
    if (indexes.length === 0) return undefined;
    if (indexes.length !== 1) throw new Error(`${label} contains conflicting metadata indexes`);
    const index = indexes[0];
    if (!index || typeof index !== "object" || Array.isArray(index)) {
        throw new Error(`${label} contains a malformed metadata index`);
    }
    const propertyName = index.propertyName ?? index.property_name;
    const rawTypes = [index.type, index.indexType, index.index_type].filter(value => value !== undefined);
    const normalizedTypes = rawTypes.map(value => (value === "String" ? "string" : value));
    if (
        (index.propertyName !== undefined &&
            index.property_name !== undefined &&
            index.propertyName !== index.property_name) ||
        new Set(normalizedTypes).size > 1
    ) {
        throw new Error(`${label} contains a conflicting metadata index`);
    }
    if (propertyName !== "cdb_resource" || normalizedTypes.length === 0 || normalizedTypes[0] !== "string") {
        throw new Error(`${label} lacks the exact cdb_resource string metadata index`);
    }
    return Object.freeze({ propertyName: "cdb_resource", type: "string" });
}

function parseVersions(value, expectedWorker, label, allowedTags) {
    const versions = asArray(value, label);
    const parsed = versions.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error(`${label} has an invalid version`);
        const versionId = item.id ?? item.version_id;
        const number = item.number ?? item.version_number;
        if (typeof versionId !== "string" || versionId.length < 8 || !Number.isInteger(number) || number < 1) {
            throw new Error(`${label} has invalid immutable version evidence`);
        }
        if (item.name !== undefined && item.name !== expectedWorker) throw new Error(`${label} Worker name drifted`);
        const annotations = item.annotations;
        if (
            annotations !== undefined &&
            (!annotations || typeof annotations !== "object" || Array.isArray(annotations))
        ) {
            throw new Error(`${label} has invalid immutable version annotations`);
        }
        const tag = annotations?.["workers/tag"] ?? null;
        if (tag !== null && (typeof tag !== "string" || tag.length < 1 || tag.length > 128)) {
            throw new Error(`${label} has an invalid immutable version tag`);
        }
        if (allowedTags && tag !== null && !allowedTags.has(tag)) {
            throw new Error(`${label} immutable version tag drifted`);
        }
        return { versionId, number, tag };
    });
    if (
        new Set(parsed.map(item => item.versionId)).size !== parsed.length ||
        new Set(parsed.map(item => item.number)).size !== parsed.length
    ) {
        throw new Error(`${label} contains duplicate immutable version identity`);
    }
    return parsed;
}

function exactTaggedVersion(versions, tag, label) {
    const matches = versions.filter(item => item.tag === tag);
    if (matches.length > 1) throw new Error(`${label} contains duplicate immutable version tags`);
    return matches[0];
}

function visibleDeployment(value, version, label) {
    const deployment = resultObject(value);
    if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
        throw new Error(`${label} must contain a deployment object`);
    }
    const deploymentId = deployment.id ?? deployment.deployment_id;
    if (typeof deploymentId !== "string" || deploymentId.length < 8 || !Array.isArray(deployment.versions)) {
        throw new Error(`${label} has invalid deployment evidence`);
    }
    const versions = deployment.versions.map(item => {
        const versionId = item?.version_id ?? item?.versionId;
        const percentage = item?.percentage;
        if (
            typeof versionId !== "string" ||
            versionId.length < 8 ||
            typeof percentage !== "number" ||
            !Number.isFinite(percentage) ||
            percentage <= 0 ||
            percentage > 100
        ) {
            throw new Error(`${label} has invalid deployment evidence`);
        }
        return { versionId, percentage };
    });
    if (versions.length !== 1 || versions[0].versionId !== version.versionId || versions[0].percentage !== 100) {
        return undefined;
    }
    return Object.freeze({
        deploymentId,
        versionId: version.versionId,
        number: version.number,
        percentage: 100,
    });
}

export function exactIndexNames(value, label) {
    return indexEntries(value, label).map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.name !== "string") {
            throw new Error(`${label} has an invalid index entry`);
        }
        return item.name;
    });
}

function parseVectorPage(value, label) {
    const page = resultObject(value);
    if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.vectors)) {
        throw new Error(`${label} must contain a vector page`);
    }
    const ids = page.vectors.map(item => {
        if (!item || typeof item !== "object" || typeof item.id !== "string") {
            throw new Error(`${label} contains an invalid vector`);
        }
        return item.id;
    });
    const count = page.count ?? ids.length;
    const totalCount = page.totalCount ?? page.total_count ?? count;
    const cursor = page.nextCursor ?? page.next_cursor ?? page.cursor;
    const truncated = page.isTruncated ?? page.is_truncated ?? cursor !== undefined;
    if (
        !Number.isInteger(count) ||
        count !== ids.length ||
        count < 0 ||
        count > 1000 ||
        !Number.isInteger(totalCount) ||
        totalCount < count ||
        typeof truncated !== "boolean" ||
        (truncated && (typeof cursor !== "string" || cursor.length < 1)) ||
        (!truncated && cursor !== undefined)
    ) {
        throw new Error(`${label} pagination metadata is invalid`);
    }
    return Object.freeze({ ids: Object.freeze(ids), count, totalCount, truncated, cursor });
}

function assertMutationSuccess(result, label) {
    if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
    if (result.stdout.trim().startsWith("{") || result.stdout.trim().startsWith("[")) {
        const value = resultObject(strictJson(result.stdout, label));
        if (!value || typeof value !== "object" || Object.keys(value).length === 0) {
            throw new Error(`${label} returned an invalid mutation receipt`);
        }
        return value;
    }
    if (!/(?:created|deleted|success|uploaded|deployed)/i.test(`${result.stdout}\n${result.stderr}`)) {
        throw new Error(`${label} returned no recognizable mutation receipt`);
    }
    return Object.freeze({ accepted: true });
}

async function loadOwnedLedger(file, candidateSha256, cleanup = false) {
    const absolute = path.resolve(file);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("ownership ledger must be a regular file");
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("ownership ledger must have mode 0600");
    const ledger = await readJson(absolute);
    return {
        absolute,
        ledger: cleanup
            ? assertVectorizeCleanupOwnership(ledger, candidateSha256)
            : assertVectorizeOwnershipLedger(ledger, candidateSha256),
    };
}

async function saveOwnedLedger(file, ledger) {
    await atomicJson(file, ledger, 0o600);
    return ledger;
}

const ledgerMutationTails = new Map();

async function serializeLedgerMutation(file, mutate) {
    const absolute = path.resolve(file);
    const previous = ledgerMutationTails.get(absolute) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => {
        release = resolve;
    });
    ledgerMutationTails.set(absolute, current);
    await previous.catch(() => {});
    try {
        return await mutate(absolute);
    } finally {
        release();
        if (ledgerMutationTails.get(absolute) === current) ledgerMutationTails.delete(absolute);
    }
}

export async function appendVectorizeOwnedPhysicalIds(ledgerPath, candidateSha256, ids) {
    assertPhysicalIds(ids);
    return serializeLedgerMutation(ledgerPath, async absolute => {
        const loaded = await loadOwnedLedger(absolute, candidateSha256);
        const ledger = loaded.ledger;
        if (!ledger.indexCreateIntent || !ledger.indexCreated || ledger.indexDeleted) {
            throw new Error("Vectorize physical IDs require a live owned index");
        }
        const knownPhysicalIds = [...new Set([...ledger.knownPhysicalIds, ...ids])];
        assertPhysicalIds(knownPhysicalIds);
        if (knownPhysicalIds.length === ledger.knownPhysicalIds.length) return ledger;
        return saveOwnedLedger(absolute, { ...ledger, knownPhysicalIds });
    });
}

function executionDependencies(dependencies) {
    if (!dependencies || typeof dependencies.run !== "function") {
        throw new Error("Vectorize execution requires an injected command runner");
    }
    return {
        run: dependencies.run,
        now: dependencies.now ?? Date.now,
        sleep: dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    };
}

function assertExecutionInput(input, requireSecrets = true) {
    if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) throw new Error("Wrangler cwd must be absolute");
    if (typeof input.config !== "string" || !path.isAbsolute(input.config)) {
        throw new Error("Wrangler config path must be absolute");
    }
    if (typeof input.wranglerExecutable !== "string" || input.wranglerExecutable.length < 1) {
        throw new Error("Wrangler executable is required");
    }
    if (requireSecrets && (typeof input.secretsFile !== "string" || !path.isAbsolute(input.secretsFile))) {
        throw new Error("Wrangler secrets file must be absolute");
    }
    const ledgerDirectory = path.dirname(path.resolve(input.ledgerPath));
    if (path.dirname(input.logPath) !== ledgerDirectory) {
        throw new Error("Wrangler log path must stay beside the private ownership ledger");
    }
}

async function prepareScopedWranglerDirectories(logPath) {
    const root = path.dirname(logPath);
    await Promise.all(
        ["xdg-config", "xdg-cache", "xdg-state"].map(directory =>
            mkdir(path.join(root, directory), { recursive: true, mode: 0o700 })
        )
    );
}

async function runPlanned(execution, planned, input, environment) {
    const invoked = Object.freeze({
        command: planned,
        executable: input.wranglerExecutable,
        cwd: input.cwd,
        config: input.config,
        environment: Object.freeze({ ...environment }),
    });
    return withTemporaryWranglerLogRemoved(input.logPath, async () =>
        assertCommandResult(await execution.run(invoked), planned.phase)
    );
}

async function runProfileAuthPreflight(execution, commands, input, environment) {
    if (!input.profile) return undefined;
    const credentialCommand = commandForPhase(commands, "profile-auth-preflight");
    const credential = jsonSuccess(
        await runPlanned(execution, credentialCommand, input, environment),
        credentialCommand.phase
    );
    if (
        !credential ||
        typeof credential !== "object" ||
        Array.isArray(credential) ||
        JSON.stringify(Object.keys(credential).sort()) !== JSON.stringify(["token", "type"]) ||
        credential.type !== "oauth" ||
        typeof credential.token !== "string" ||
        credential.token.length < 16 ||
        credential.token.length > 16_384 ||
        /\s/u.test(credential.token)
    ) {
        throw new Error("profile-auth-preflight returned malformed OAuth credentials");
    }
    const accountCommand = commandForPhase(commands, "profile-account-preflight");
    const accountEnvironment = {
        ...environment,
        CLOUDFLARE_API_TOKEN: credential.token,
        CLOUDFLARE_ACCOUNT_ID: input.accountId,
    };
    let whoami;
    try {
        whoami = jsonSuccess(
            await runPlanned(execution, accountCommand, input, accountEnvironment),
            accountCommand.phase
        );
    } finally {
        for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete accountEnvironment[key];
    }
    const expectedKeys = ["accounts", "authType", "email", "loggedIn", "tokenPermissions"];
    if (
        !whoami ||
        typeof whoami !== "object" ||
        Array.isArray(whoami) ||
        JSON.stringify(Object.keys(whoami).sort()) !== JSON.stringify(expectedKeys) ||
        whoami.loggedIn !== true ||
        typeof whoami.authType !== "string" ||
        typeof whoami.email !== "string" ||
        !Array.isArray(whoami.accounts) ||
        whoami.accounts.length < 1 ||
        whoami.accounts.length > 100 ||
        !Array.isArray(whoami.tokenPermissions) ||
        whoami.tokenPermissions.some(item => typeof item !== "string")
    ) {
        throw new Error("profile-account-preflight returned malformed account evidence");
    }
    const accountIds = whoami.accounts.map(account => account?.id);
    if (
        accountIds.some(id => typeof id !== "string" || !ACCOUNT_ID.test(id)) ||
        new Set(accountIds).size !== accountIds.length
    ) {
        throw new Error("profile-account-preflight returned malformed account evidence");
    }
    if (!accountIds.includes(input.accountId)) {
        throw new Error("selected Wrangler profile does not contain the requested Cloudflare account");
    }
    return Object.freeze({
        method: "profile-oauth-token-whoami",
        profile: input.profile,
        accountIdSha256: sha256(input.accountId),
        matched: true,
    });
}

async function pollExact(input, execution, label, read, options = {}) {
    const timeoutMs = options.timeoutMs ?? input.pollTimeoutMs ?? 30_000;
    const intervalMs = input.pollIntervalMs ?? 250;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(intervalMs) || intervalMs < 1) {
        throw new Error("Vectorize poll bounds are invalid");
    }
    const started = execution.now();
    const maximumAttempts = Math.ceil(timeoutMs / intervalMs) + 1;
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
        const result = await read();
        if (result !== undefined) return result;
        if (attempt === maximumAttempts - 1 || execution.now() - started >= timeoutMs) {
            throw new Error(`${label} readiness timed out`);
        }
        await execution.sleep(intervalMs);
    }
    throw new Error(`${label} readiness timed out`);
}

function phaseList(plan) {
    return [...plan.preflight, ...plan.creation];
}

export function planCloudflareVectorizeRedeployCommands(input) {
    const original = planCloudflareVectorizeCommands(input);
    const firstDeploy = commandForPhase(original.creation, "worker-deploy");
    const tagIndex = firstDeploy.args.indexOf("--tag");
    if (tagIndex < 0 || firstDeploy.args[tagIndex + 1] !== `vx-${input.nonce}-v1`) {
        throw new Error("Vectorize Worker deployment plan has no canonical first tag");
    }
    const redeployArgs = [...firstDeploy.args];
    redeployArgs[tagIndex + 1] = `vx-${input.nonce}-v2`;
    return Object.freeze([
        ...(input.profile
            ? [
                  commandForPhase(original.preflight, "profile-auth-preflight"),
                  commandForPhase(original.preflight, "profile-account-preflight"),
              ]
            : []),
        command(redeployArgs, "worker-redeploy", true),
        commandForPhase(original.creation, "worker-version-evidence"),
        commandForPhase(original.creation, "worker-deployment-evidence"),
    ]);
}

export async function executeCloudflareVectorizeProvisioning(input, dependencies) {
    assertExecutionInput(input);
    await prepareScopedWranglerDirectories(input.logPath);
    const execution = executionDependencies(dependencies);
    const loaded = await loadOwnedLedger(input.ledgerPath, input.candidateSha256);
    let ledger = loaded.ledger;
    if (LEDGER_BOOLEAN_FIELDS.some(field => ledger[field])) {
        throw new Error("Vectorize provisioning requires a pristine ownership ledger");
    }
    const plan = planCloudflareVectorizeCommands({
        candidateSha256: input.candidateSha256,
        nonce: ledger.nonce,
        secretsFile: input.secretsFile,
        profile: input.profile,
    });
    const commands = phaseList(plan);
    return withWranglerAuthEnvironment(
        input.baseEnvironment ?? {},
        {
            accountId: input.accountId,
            apiToken: input.apiToken,
            profile: input.profile,
            logPath: input.logPath,
        },
        async environment => {
            const accountVerification = await runProfileAuthPreflight(execution, commands, input, environment);
            const workerAbsence = await runPlanned(
                execution,
                commandForPhase(commands, "worker-absence"),
                input,
                environment
            );
            if (workerAbsence.exitCode === 0) {
                if (
                    parseVersions(strictJson(workerAbsence.stdout, "worker-absence"), ledger.worker, "worker-absence")
                        .length !== 0
                ) {
                    throw new Error("disposable Worker name already exists");
                }
            } else if (!isNotFound(workerAbsence)) throw new Error("Worker absence preflight failed");

            const indexList = jsonSuccess(
                await runPlanned(execution, commandForPhase(commands, "index-list-absence"), input, environment),
                "index-list-absence"
            );
            const foundNames = indexEntries(indexList, "index-list-absence").map(item => item?.name);
            if (foundNames.some(name => typeof name !== "string"))
                throw new Error("index-list-absence has an invalid entry");
            if (foundNames.includes(ledger.index)) throw new Error("disposable Vectorize index name already exists");

            const indexGet = await runPlanned(
                execution,
                commandForPhase(commands, "index-get-absence"),
                input,
                environment
            );
            if (!isIndexAbsent(indexGet)) throw new Error("Vectorize index get did not independently prove absence");
            ledger = await saveOwnedLedger(loaded.absolute, {
                ...ledger,
                workerAbsentConfirmed: true,
                indexAbsentConfirmed: true,
            });

            ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, indexCreateIntent: true });
            const indexCreate = await runPlanned(
                execution,
                commandForPhase(commands, "index-create"),
                input,
                environment
            );
            assertMutationSuccess(indexCreate, "index-create");
            ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, indexCreated: true });

            await pollExact(input, execution, "Vectorize index", async () => {
                const result = await runPlanned(
                    execution,
                    commandForPhase(commands, "index-readiness"),
                    input,
                    environment
                );
                if (isIndexAbsent(result)) return undefined;
                return assertIndexDescriptor(jsonSuccess(result, "index-readiness"), ledger.index, "index-readiness");
            });

            ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, metadataIndexCreateIntent: true });
            assertMutationSuccess(
                await runPlanned(execution, commandForPhase(commands, "metadata-index-create"), input, environment),
                "metadata-index-create"
            );
            ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, metadataIndexCreated: true });
            await pollExact(input, execution, "Vectorize metadata index", async () => {
                const result = await runPlanned(
                    execution,
                    commandForPhase(commands, "metadata-index-readiness"),
                    input,
                    environment
                );
                if (isIndexAbsent(result)) return undefined;
                return assertMetadataIndex(jsonSuccess(result, "metadata-index-readiness"), "metadata-index-readiness");
            });

            ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, workerCreateIntent: true });
            const deploy = commandForPhase(commands, "worker-deploy");
            assertMutationSuccess(await runPlanned(execution, deploy, input, environment), "worker-deploy");
            ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, workerCreated: true });

            const versionCommand = commandForPhase(commands, "worker-version-evidence");
            const expectedTag = `vx-${ledger.nonce}-v1`;
            const version = await pollExact(input, execution, "Worker immutable version", async () => {
                const result = await runPlanned(execution, versionCommand, input, environment);
                if (isNotFound(result)) return undefined;
                const versions = parseVersions(
                    jsonSuccess(result, versionCommand.phase),
                    ledger.worker,
                    versionCommand.phase,
                    new Set([expectedTag])
                );
                return exactTaggedVersion(versions, expectedTag, versionCommand.phase);
            });
            const deploymentCommand = commandForPhase(commands, "worker-deployment-evidence");
            const deployment = await pollExact(input, execution, "Worker 100 percent deployment", async () => {
                const result = await runPlanned(execution, deploymentCommand, input, environment);
                if (isNotFound(result) || /has no deployments/i.test(`${result.stdout}\n${result.stderr}`))
                    return undefined;
                return visibleDeployment(
                    jsonSuccess(result, deploymentCommand.phase),
                    version,
                    deploymentCommand.phase
                );
            });
            return Object.freeze({ ledger: Object.freeze({ ...ledger }), deployment, accountVerification });
        }
    );
}

export async function executeCloudflareVectorizeRedeploy(input, dependencies) {
    assertExecutionInput(input);
    if (typeof input.initialVersionId !== "string" || input.initialVersionId.length < 8) {
        throw new Error("Vectorize redeploy initial version ID is invalid");
    }
    await prepareScopedWranglerDirectories(input.logPath);
    const execution = executionDependencies(dependencies);
    const loaded = await loadOwnedLedger(input.ledgerPath, input.candidateSha256);
    const ledger = loaded.ledger;
    if (!ledger.workerCreated || ledger.workerDeleted || !ledger.indexCreated || ledger.indexDeleted) {
        throw new Error("Vectorize redeploy requires live owned Worker and index resources");
    }
    const commands = planCloudflareVectorizeRedeployCommands({
        candidateSha256: input.candidateSha256,
        nonce: ledger.nonce,
        secretsFile: input.secretsFile,
        profile: input.profile,
    });
    return withWranglerAuthEnvironment(
        input.baseEnvironment ?? {},
        {
            accountId: input.accountId,
            apiToken: input.apiToken,
            profile: input.profile,
            logPath: input.logPath,
        },
        async environment => {
            const accountVerification = await runProfileAuthPreflight(execution, commands, input, environment);
            const initialTag = `vx-${ledger.nonce}-v1`;
            const redeployTag = `vx-${ledger.nonce}-v2`;
            const allowedTags = new Set([initialTag, redeployTag]);
            const versionCommand = commandForPhase(commands, "worker-version-evidence");
            const baselineResult = await runPlanned(execution, versionCommand, input, environment);
            const baselineVersions = parseVersions(
                jsonSuccess(baselineResult, versionCommand.phase),
                ledger.worker,
                versionCommand.phase,
                allowedTags
            );
            if (
                baselineVersions.length !== 1 ||
                baselineVersions[0].versionId !== input.initialVersionId ||
                baselineVersions[0].tag !== initialTag
            ) {
                throw new Error("Worker redeploy baseline immutable version drifted");
            }
            const initial = baselineVersions[0];
            const redeploy = commandForPhase(commands, "worker-redeploy");
            const redeployResult = await runPlanned(execution, redeploy, input, environment);
            try {
                const newer = await pollExact(input, execution, "Worker redeploy immutable version", async () => {
                    const result = await runPlanned(execution, versionCommand, input, environment);
                    if (isNotFound(result)) return undefined;
                    const versions = parseVersions(
                        jsonSuccess(result, versionCommand.phase),
                        ledger.worker,
                        versionCommand.phase,
                        allowedTags
                    );
                    const observedInitial = versions.find(item => item.versionId === input.initialVersionId);
                    if (
                        !observedInitial ||
                        observedInitial.number !== initial.number ||
                        observedInitial.tag !== initialTag
                    ) {
                        throw new Error("Worker redeploy initial immutable version drifted during reconciliation");
                    }
                    const candidate = exactTaggedVersion(versions, redeployTag, versionCommand.phase);
                    const unrelatedNewer = versions.some(
                        item => item.number > initial.number && item.tag !== redeployTag
                    );
                    if (unrelatedNewer) throw new Error("Worker redeploy found an unrelated newer immutable version");
                    if (!candidate) return undefined;
                    if (candidate.versionId === initial.versionId || candidate.number <= initial.number) {
                        throw new Error("Worker redeploy tagged immutable version did not advance");
                    }
                    return candidate;
                });
                const deploymentCommand = commandForPhase(commands, "worker-deployment-evidence");
                const deployment = await pollExact(
                    input,
                    execution,
                    "Worker redeploy 100 percent deployment",
                    async () => {
                        const result = await runPlanned(execution, deploymentCommand, input, environment);
                        if (isNotFound(result) || /has no deployments/i.test(`${result.stdout}\n${result.stderr}`))
                            return undefined;
                        return visibleDeployment(
                            jsonSuccess(result, deploymentCommand.phase),
                            newer,
                            deploymentCommand.phase
                        );
                    }
                );
                return Object.freeze({
                    deployment,
                    accountVerification,
                    reconciliation: Object.freeze({
                        initialVersionId: initial.versionId,
                        redeployVersionId: newer.versionId,
                        redeployTag,
                        deployExitCode: redeployResult.exitCode,
                        acceptedAfterNonzeroExit: redeployResult.exitCode !== 0,
                    }),
                });
            } catch {
                throw new Error(
                    redeployResult.exitCode === 0
                        ? "Worker redeploy immutable reconciliation failed"
                        : `worker-redeploy failed with exit code ${redeployResult.exitCode} and immutable reconciliation failed`
                );
            }
        }
    );
}

async function listAllVectors(input, execution, environment, ledger, allowedIds, phase, options = {}) {
    const ids = [];
    const cursors = new Set();
    let cursor;
    let expectedTotal;
    for (let pageNumber = 0; pageNumber < 512; pageNumber++) {
        const planned = planVectorizeListCommand(ledger.index, cursor, phase, input.profile);
        const result = await runPlanned(execution, planned, input, environment);
        if (result.exitCode !== 0 && options.retryNonzero === true) return undefined;
        const page = parseVectorPage(jsonSuccess(result, phase), phase);
        expectedTotal ??= page.totalCount;
        if (page.totalCount !== expectedTotal) throw new Error("Vectorize list total changed during pagination");
        for (const id of page.ids) {
            assertPhysicalIds([id]);
            if (!allowedIds.has(id)) throw new Error(`Vectorize cleanup discovered unknown vector ID ${id}`);
            if (ids.includes(id)) throw new Error(`Vectorize cleanup listed duplicate vector ID ${id}`);
            ids.push(id);
        }
        if (!page.truncated) {
            if (ids.length !== expectedTotal) throw new Error("Vectorize list page counts do not match totalCount");
            return Object.freeze(ids);
        }
        if (cursors.has(page.cursor)) throw new Error("Vectorize list cursor repeated");
        cursors.add(page.cursor);
        cursor = page.cursor;
    }
    throw new Error("Vectorize list exceeded 512 pages");
}

export async function executeCloudflareVectorizeCleanup(input, dependencies) {
    assertExecutionInput(input, false);
    await prepareScopedWranglerDirectories(input.logPath);
    const execution = executionDependencies(dependencies);
    const loaded = await loadOwnedLedger(input.ledgerPath, input.candidateSha256, true);
    let ledger = loaded.ledger;
    let discoveredPhysicalIds = Object.freeze([]);
    let finalVectorCount = 0;
    const cleanupPlanFor = state =>
        planCloudflareVectorizeCleanupCommands(state, input.candidateSha256, { profile: input.profile });
    return withWranglerAuthEnvironment(
        input.baseEnvironment ?? {},
        {
            accountId: input.accountId,
            apiToken: input.apiToken,
            profile: input.profile,
            logPath: input.logPath,
        },
        async environment => {
            if (input.profile) {
                await runProfileAuthPreflight(execution, cleanupPlanFor(ledger), input, environment);
            }
            if (ledger.indexCreateIntent && !ledger.indexCreated) {
                const cleanupPlan = cleanupPlanFor(ledger);
                const result = await runPlanned(
                    execution,
                    commandForPhase(cleanupPlan, "index-create-reconcile"),
                    input,
                    environment
                );
                if (!isIndexAbsent(result)) {
                    assertIndexDescriptor(
                        jsonSuccess(result, "index-create-reconcile"),
                        ledger.index,
                        "index-create-reconcile"
                    );
                    ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, indexCreated: true });
                }
            }
            if (ledger.workerCreateIntent && !ledger.workerCreated) {
                const cleanupPlan = cleanupPlanFor(ledger);
                const result = await runPlanned(
                    execution,
                    commandForPhase(cleanupPlan, "worker-create-reconcile"),
                    input,
                    environment
                );
                if (result.exitCode === 0) {
                    const versions = parseVersions(
                        strictJson(result.stdout, "worker-create-reconcile"),
                        ledger.worker,
                        "worker-create-reconcile"
                    );
                    if (versions.length > 0)
                        ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, workerCreated: true });
                } else if (!isNotFound(result)) throw new Error("Worker creation reconciliation failed");
            }

            let allowedPhysicalIds;
            let initiallyVisiblePhysicalIds = Object.freeze([]);
            if (ledger.indexCreated && !ledger.indexDeleted) {
                allowedPhysicalIds = new Set(ledger.knownPhysicalIds);
                const discovered = await listAllVectors(
                    input,
                    execution,
                    environment,
                    ledger,
                    allowedPhysicalIds,
                    "vector-list-before-cleanup"
                );
                initiallyVisiblePhysicalIds = discovered;
                discoveredPhysicalIds = Object.freeze([...discovered].sort());
            }

            if (ledger.workerCreated && !ledger.workerDeleted) {
                let cleanupPlan = cleanupPlanFor(ledger);
                const reconcileCommand = commandForPhase(cleanupPlan, "worker-delete-reconcile");
                const reconcile = await runPlanned(execution, reconcileCommand, input, environment);
                let exists = true;
                if (reconcile.exitCode === 0) {
                    exists =
                        parseVersions(
                            strictJson(reconcile.stdout, reconcileCommand.phase),
                            ledger.worker,
                            reconcileCommand.phase
                        ).length > 0;
                } else if (isNotFound(reconcile)) exists = false;
                else throw new Error("Worker deletion reconciliation failed");
                if (!exists) {
                    ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, workerDeleted: true });
                } else {
                    cleanupPlan = cleanupPlanFor(ledger);
                    const planned = commandForPhase(cleanupPlan, "worker-delete");
                    assertMutationSuccess(await runPlanned(execution, planned, input, environment), planned.phase);
                    ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, workerDeleted: true });
                }
            }
            const workerAbsencePlan = cleanupPlanFor(ledger);
            const workerAbsenceCommand = commandForPhase(workerAbsencePlan, "worker-absence-verify");
            await pollExact(input, execution, "Worker deletion", async () => {
                const result = await runPlanned(execution, workerAbsenceCommand, input, environment);
                if (isNotFound(result)) return true;
                if (result.exitCode !== 0) throw new Error("Worker absence verification failed");
                return parseVersions(
                    strictJson(result.stdout, workerAbsenceCommand.phase),
                    ledger.worker,
                    workerAbsenceCommand.phase
                ).length === 0
                    ? true
                    : undefined;
            });

            if (ledger.indexCreated && !ledger.indexDeleted) {
                const allowed = allowedPhysicalIds;
                if (!(allowed instanceof Set)) throw new Error("Vectorize cleanup ownership allowlist is missing");
                const submitted = new Set();
                const observed = new Set(discoveredPhysicalIds);
                const deleteExact = async ids => {
                    if (ids.length === 0) return;
                    const deletionPlan = cleanupPlanFor({ ...ledger, knownPhysicalIds: ids });
                    for (const planned of deletionPlan.filter(item => item.phase === "exact-vector-delete")) {
                        assertMutationSuccess(
                            await runPlanned(execution, planned, input, environment),
                            "exact-vector-delete"
                        );
                    }
                    for (const id of ids) submitted.add(id);
                };
                await deleteExact(initiallyVisiblePhysicalIds);
                await pollExact(
                    input,
                    execution,
                    "Vectorize vector deletion",
                    async () => {
                        const visible = await listAllVectors(
                            input,
                            execution,
                            environment,
                            ledger,
                            allowed,
                            "exact-vector-absence-verify",
                            { retryNonzero: true }
                        );
                        if (visible === undefined) return undefined;
                        for (const id of visible) observed.add(id);
                        discoveredPhysicalIds = Object.freeze([...observed].sort());
                        const newlyVisible = visible.filter(id => !submitted.has(id));
                        await deleteExact(newlyVisible);
                        if (visible.length === 0) {
                            finalVectorCount = 0;
                            return true;
                        }
                        return undefined;
                    },
                    { timeoutMs: input.settlementTimeoutMs ?? VECTORIZE_REMOTE_SETTLEMENT_TIMEOUT_MS }
                );
            }

            if (ledger.indexCreated && !ledger.indexDeleted) {
                let cleanupPlan = cleanupPlanFor(ledger);
                const reconcileCommand = commandForPhase(cleanupPlan, "index-delete-reconcile");
                const reconcile = await runPlanned(execution, reconcileCommand, input, environment);
                if (isIndexAbsent(reconcile)) {
                    ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, indexDeleted: true });
                } else {
                    assertIndexDescriptor(
                        jsonSuccess(reconcile, reconcileCommand.phase),
                        ledger.index,
                        reconcileCommand.phase
                    );
                    cleanupPlan = cleanupPlanFor(ledger);
                    const planned = commandForPhase(cleanupPlan, "index-delete");
                    assertMutationSuccess(await runPlanned(execution, planned, input, environment), planned.phase);
                    ledger = await saveOwnedLedger(loaded.absolute, { ...ledger, indexDeleted: true });
                }
            }
            const indexAbsencePlan = cleanupPlanFor(ledger);
            const indexAbsenceCommand = commandForPhase(indexAbsencePlan, "index-absence-verify");
            const indexListCommand = commandForPhase(indexAbsencePlan, "index-list-absence-verify");
            await pollExact(input, execution, "Vectorize index deletion", async () => {
                const getResult = await runPlanned(execution, indexAbsenceCommand, input, environment);
                if (!isIndexAbsent(getResult)) {
                    assertIndexDescriptor(
                        jsonSuccess(getResult, indexAbsenceCommand.phase),
                        ledger.index,
                        indexAbsenceCommand.phase
                    );
                    return undefined;
                }
                const names = exactIndexNames(
                    jsonSuccess(
                        await runPlanned(execution, indexListCommand, input, environment),
                        indexListCommand.phase
                    ),
                    indexListCommand.phase
                );
                return names.includes(ledger.index) ? undefined : true;
            });
            return Object.freeze({
                ledger: Object.freeze({ ...ledger }),
                discoveredPhysicalIds,
                finalVectorCount,
                workerAbsent: true,
                indexAbsent: true,
            });
        }
    );
}

export async function prepareCloudflareVectorizeCleanupPlan(input) {
    const candidate = await fingerprintVectorizeProofCandidate(input.tarball);
    const ledgerPath = path.resolve(input.cleanupLedger);
    const metadata = await lstat(ledgerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("cleanup ledger must be a regular file");
    const ledger = await readJson(ledgerPath);
    return Object.freeze({
        schema: CLOUDFLARE_VECTORIZE_PROOF_PLAN_SCHEMA,
        candidate,
        commands: planCloudflareVectorizeCleanupCommands(ledger, candidate.digest),
        mutatingCommandsExecuted: false,
    });
}

function usage() {
    return [
        "Usage: bun scripts/run-cloudflare-vectorize-proof.mjs [options]",
        "",
        "Plan mode is the default. Wrangler runs only when --execute is present.",
        "",
        "  --tarball <file>",
        "  --output <empty-directory>",
        "  --private-dir <separate-empty-directory>",
        "  --workers-dev-subdomain <label>",
        "  --account-id <32-hex-id>",
        "  --confirm-disposable-resources",
        "  --cleanup-ledger <ownership.json>  plan cleanup without executing it",
        "  --execute                          run the planned mutations",
        "  --cwd <absolute-directory>         required with --execute",
        "  --config <absolute-wrangler.toml>  required with --execute",
        "  --secrets-file <absolute-file>     required for proof execution",
        "  --wrangler <executable>            defaults to wrangler",
        "  --profile <safe-name>              use Wrangler's stored OAuth profile",
    ].join("\n");
}

async function runWranglerInvocation(invocation) {
    const child = Bun.spawn([invocation.executable, ...invocation.command.args, "--config", invocation.config], {
        cwd: invocation.cwd,
        env: invocation.environment,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { exitCode, stdout, stderr };
}

function cliExecutionInput(options, candidateSha256, ledgerPath) {
    const apiToken = options.profile ? undefined : process.env.CLOUDFLARE_API_TOKEN;
    if (!apiToken && !options.profile) {
        throw new Error("CLOUDFLARE_API_TOKEN or --profile is required with --execute");
    }
    return {
        ledgerPath,
        candidateSha256,
        accountId: options.accountId,
        apiToken,
        profile: options.profile,
        logPath: path.join(path.dirname(path.resolve(ledgerPath)), "wrangler.log"),
        cwd: path.resolve(options.cwd),
        config: path.resolve(options.config),
        secretsFile: options.secretsFile ? path.resolve(options.secretsFile) : undefined,
        wranglerExecutable: options.wranglerExecutable,
        baseEnvironment: process.env,
    };
}

if (import.meta.main) {
    const options = parseCloudflareVectorizeProofArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
    } else if (options.mode === "cleanup-plan") {
        const plan = await prepareCloudflareVectorizeCleanupPlan({
            tarball: options.tarball,
            cleanupLedger: options.cleanupLedger,
        });
        if (options.execute) {
            const result = await executeCloudflareVectorizeCleanup(
                cliExecutionInput(options, plan.candidate.digest, options.cleanupLedger),
                { run: runWranglerInvocation }
            );
            process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
            process.stdout.write(`${JSON.stringify(plan)}\n`);
        }
    } else {
        const prepared = await prepareCloudflareVectorizeProofPlan({
            tarball: options.tarball,
            output: options.output,
            privateDir: options.privateDir,
        });
        if (options.execute) {
            const result = await executeCloudflareVectorizeProvisioning(
                cliExecutionInput(options, prepared.publicPlan.candidate.digest, prepared.ledgerPath),
                { run: runWranglerInvocation }
            );
            process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
            process.stdout.write(`${JSON.stringify(prepared.publicPlan)}\n`);
        }
    }
}
