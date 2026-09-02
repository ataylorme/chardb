import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { validateCloudflareFileProofEvidence } from "./cloudflare-file-proof-report.mjs";
import { startLocalFileProofRuntime } from "./local-file-proof-runtime.mjs";
import { runPairedFileBenchmark, validateFileBenchmarkEvidence } from "./run-file-benchmark.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "cloudflare-file-proof");
const REPORT_SCHEMA = "chardb.cloudflare-r2-proof.report.v3";
const LEDGER_SCHEMA = "chardb.cloudflare-r2-proof.ownership.v3";
const LEDGER_FIELDS = Object.freeze(
    [
        "schema",
        "candidateSha256",
        "accountIdSha256",
        "nonce",
        "runId",
        "worker",
        "bucket",
        "workerAbsentConfirmed",
        "bucketAbsentConfirmed",
        "workerCreateIntent",
        "workerCreated",
        "bucketCreateIntent",
        "bucketCreated",
        "knownKeys",
    ].sort()
);
const RESOURCE_PREFIX = "chardb-r2-proof-";
export const CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION = "4.125.0";
export const CLOUDFLARE_FILE_PROOF_MINIFLARE_VERSION = "5.20260820.0-alpha";
export const CLOUDFLARE_FILE_PROOF_WORKERD_VERSION = "1.20260820.1";
const WRANGLER_VERSION = CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const MIGRATION_EDGE_404_WINDOW_MS = 30_000;
const MIGRATION_EDGE_404_BASE_DELAY_MS = 1_000;
const MIGRATION_EDGE_404_MAX_DELAY_MS = 5_000;
const RECOVERY_OPERATION_TURNS = 10_000;

export async function resolveWranglerExecutable(packageJsonAnchor) {
    const resolver = createRequire(path.resolve(packageJsonAnchor));
    const packageJsonPath = resolver.resolve("wrangler/package.json");
    const packageRoot = path.dirname(packageJsonPath);
    const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.wrangler;
    if (typeof declared !== "string" || declared.length === 0 || path.isAbsolute(declared)) {
        throw new Error("Wrangler package does not declare a relative wrangler executable");
    }
    const executable = path.resolve(packageRoot, declared);
    if (!executable.startsWith(`${packageRoot}${path.sep}`)) {
        throw new Error("Wrangler executable escapes its package directory");
    }
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Wrangler executable must be a regular package file");
    }
    return executable;
}

function value(argv, flag) {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
}

export function parseCloudflareFileProofArgs(argv) {
    const allowed = new Set([
        "--tarball",
        "--output",
        "--private-dir",
        "--workers-dev-subdomain",
        "--account-id",
        "--cloudflare-api-token-file",
        "--confirm-disposable-resources",
        "--help",
        "-h",
    ]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument)) throw new Error(`unknown file proof argument ${JSON.stringify(argument)}`);
        if (!argument.startsWith("--confirm-") && argument !== "--help" && argument !== "-h") index++;
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const tarball = value(argv, "--tarball");
    const output = value(argv, "--output");
    const privateDir = value(argv, "--private-dir");
    const workersDevSubdomain = value(argv, "--workers-dev-subdomain");
    const accountId = value(argv, "--account-id")?.toLowerCase();
    const cloudflareApiTokenFile = value(argv, "--cloudflare-api-token-file");
    const confirmed = argv.includes("--confirm-disposable-resources");
    if (!help) {
        for (const [flag, item] of [
            ["--tarball", tarball],
            ["--output", output],
            ["--private-dir", privateDir],
            ["--workers-dev-subdomain", workersDevSubdomain],
            ["--account-id", accountId],
        ]) {
            if (!item) throw new Error(`${flag} is required`);
        }
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersDevSubdomain)) {
            throw new Error("--workers-dev-subdomain must be one lowercase Cloudflare subdomain label");
        }
        if (!confirmed) throw new Error("--confirm-disposable-resources is required");
        if (!/^[a-f0-9]{32}$/.test(accountId)) {
            throw new Error("--account-id must be exactly 32 hexadecimal characters");
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
    }
    return {
        help,
        tarball,
        output,
        privateDir,
        workersDevSubdomain,
        accountId,
        cloudflareApiTokenFile,
        confirmed,
    };
}

async function readCloudflareApiToken(file) {
    if (file === undefined) return undefined;
    const absolute = path.resolve(file);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Cloudflare API token file must be a regular file, not a symlink");
    }
    const raw = await readFile(absolute, "utf8");
    const token = raw.trim();
    if ((raw !== token && raw !== `${token}\n`) || token.length < 16 || token.length > 4_096 || /\s/.test(token)) {
        throw new Error("Cloudflare API token file is invalid");
    }
    return token;
}

function cloudflareEnvironment(accountId, apiToken, wranglerLogPath) {
    const environment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_LOG_PATH: wranglerLogPath };
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

export async function prepareCloudflareFileProofDirectories(outputInput, privateInput) {
    const output = path.resolve(outputInput);
    const privateDir = path.resolve(privateInput);
    await mkdir(output, { recursive: true });
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    for (const [directory, label] of [
        [output, "file proof evidence directory"],
        [privateDir, "file proof private directory"],
    ]) {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error(`${label} must be a directory, not a symlink`);
        }
    }
    const [canonicalOutput, canonicalPrivateDir] = await Promise.all([realpath(output), realpath(privateDir)]);
    if (
        canonicalOutput === canonicalPrivateDir ||
        canonicalOutput.startsWith(`${canonicalPrivateDir}${path.sep}`) ||
        canonicalPrivateDir.startsWith(`${canonicalOutput}${path.sep}`)
    ) {
        throw new Error("file proof evidence and private directories must resolve to separate trees");
    }
    if ((await readdir(output)).length > 0) throw new Error("file proof evidence directory must be empty");
    if ((await readdir(privateDir)).length > 0) throw new Error("file proof private directory must be empty");
    await chmod(privateDir, 0o700);
    return Object.freeze({ output: canonicalOutput, privateDir: canonicalPrivateDir });
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

export function deriveDisposableResourceNames(candidateDigest, nonce) {
    if (!/^[a-f0-9]{64}$/.test(candidateDigest)) throw new Error("candidate SHA-256 is invalid");
    if (!/^[a-f0-9]{16}$/.test(nonce)) throw new Error("proof nonce must contain 16 lowercase hex characters");
    const name = `${RESOURCE_PREFIX}${candidateDigest.slice(0, 10)}-${nonce}`;
    if (name.length > 63) throw new Error("disposable resource name exceeds the Cloudflare limit");
    return Object.freeze({ worker: name, bucket: name });
}

export function renderFileProofWrangler(source, input) {
    if (!input.worker.startsWith(RESOURCE_PREFIX) || input.worker !== input.bucket) {
        throw new Error("file proof Worker and bucket must share the exact disposable name");
    }
    if (!/^[a-f0-9]{64}$/.test(input.releaseSha256)) throw new Error("release SHA-256 is invalid");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.runId)) throw new Error("proof run ID is invalid");
    const replacements = new Map([
        ["__WORKER_NAME__", input.worker],
        ["__BUCKET_NAME__", input.bucket],
        ["__RELEASE_SHA256__", input.releaseSha256],
    ]);
    let rendered = source;
    for (const [placeholder, replacement] of replacements) {
        if (!rendered.includes(placeholder)) throw new Error(`Wrangler template is missing ${placeholder}`);
        rendered = rendered.replaceAll(placeholder, replacement);
    }
    if (rendered.includes("__")) throw new Error("Wrangler template contains an unresolved placeholder");
    return rendered;
}

export function renderFileProofPackage(relativeTarball) {
    if (!relativeTarball || path.isAbsolute(relativeTarball)) throw new Error("tarball package path must be relative");
    const normalized = relativeTarball.split(path.sep).join("/");
    return {
        name: "chardb-cloudflare-file-proof",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: { typecheck: "tsc --noEmit", "deploy:dry": "wrangler deploy --dry-run --outdir worker-dist" },
        dependencies: {
            "better-auth": "~1.6.30",
            "@chardb/core": `file:${normalized.startsWith(".") ? normalized : `./${normalized}`}`,
            "drizzle-orm": "^0.45.2",
            zod: "^4.0.0",
        },
        devDependencies: {
            "@cloudflare/workers-types": "5.20260830.1",
            miniflare: CLOUDFLARE_FILE_PROOF_MINIFLARE_VERSION,
            typescript: "5.9.3",
            workerd: CLOUDFLARE_FILE_PROOF_WORKERD_VERSION,
            wrangler: WRANGLER_VERSION,
        },
    };
}

export function assertCleanupOwnership(ledger, expectedCandidateDigest, expectedAccountId) {
    if (!ledger || ledger.schema !== LEDGER_SCHEMA) throw new Error("cleanup ownership ledger schema is invalid");
    if (JSON.stringify(Object.keys(ledger).sort()) !== JSON.stringify(LEDGER_FIELDS)) {
        throw new Error(`cleanup ownership ledger fields must be exactly ${LEDGER_FIELDS.join(", ")}`);
    }
    if (ledger.candidateSha256 !== expectedCandidateDigest) throw new Error("cleanup candidate digest drifted");
    if (!/^[a-f0-9]{32}$/.test(expectedAccountId ?? "")) throw new Error("cleanup account ID is invalid");
    if (ledger.accountIdSha256 !== sha256(expectedAccountId)) throw new Error("cleanup account identity drifted");
    if (!/^[a-f0-9]{16}$/.test(ledger.nonce ?? "")) throw new Error("cleanup nonce is invalid");
    const expected = deriveDisposableResourceNames(expectedCandidateDigest, ledger.nonce);
    if (ledger.worker !== expected.worker || ledger.bucket !== expected.bucket || ledger.worker !== ledger.bucket) {
        throw new Error("cleanup resource name is not derived from the owned digest and nonce");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(ledger.runId ?? "")) throw new Error("cleanup run ID is invalid");
    for (const field of [
        "workerAbsentConfirmed",
        "bucketAbsentConfirmed",
        "workerCreateIntent",
        "workerCreated",
        "bucketCreateIntent",
        "bucketCreated",
    ]) {
        if (typeof ledger[field] !== "boolean") throw new Error(`cleanup ownership ${field} must be boolean`);
    }
    if (ledger.workerCreated && (!ledger.workerCreateIntent || !ledger.workerAbsentConfirmed)) {
        throw new Error("cleanup ownership Worker creation state is impossible");
    }
    if (ledger.bucketCreated && (!ledger.bucketCreateIntent || !ledger.bucketAbsentConfirmed)) {
        throw new Error("cleanup ownership bucket creation state is impossible");
    }
    if (ledger.workerCreateIntent && !ledger.workerAbsentConfirmed) {
        throw new Error("cleanup Worker intent requires a recorded absent-resource preflight check");
    }
    if (ledger.bucketCreateIntent && !ledger.bucketAbsentConfirmed) {
        throw new Error("cleanup bucket intent requires a recorded absent-resource preflight check");
    }
    const keys = ledger.knownKeys ?? [];
    if (
        !Array.isArray(keys) ||
        keys.length > 512 ||
        new Set(keys).size !== keys.length ||
        keys.some(key => typeof key !== "string" || !/^v1\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/.test(key))
    ) {
        throw new Error("cleanup object-key ledger is invalid");
    }
    return expected;
}

export function cleanupCommands(ledger, expectedCandidateDigest, expectedAccountId) {
    const names = assertCleanupOwnership(ledger, expectedCandidateDigest, expectedAccountId);
    const commands = [];
    if (ledger.workerCreateIntent) commands.push(Object.freeze(["delete", names.worker, "--force"]));
    if (ledger.bucketCreateIntent) commands.push(Object.freeze(["r2", "bucket", "delete", names.bucket]));
    return Object.freeze(commands);
}

export function exactObjectCleanupCommands(ledger, expectedCandidateDigest, expectedAccountId) {
    const names = assertCleanupOwnership(ledger, expectedCandidateDigest, expectedAccountId);
    if (!ledger.bucketCreateIntent) return Object.freeze([]);
    return Object.freeze(
        (ledger.knownKeys ?? []).map(key =>
            Object.freeze(["r2", "object", "delete", `${names.bucket}/${key}`, "--remote", "--force"])
        )
    );
}

export function scrubSensitive(value, secrets) {
    let output = String(value);
    for (const secret of secrets.filter(item => typeof item === "string" && item.length > 0)) {
        output = output.split(secret).join("[redacted]");
    }
    return output;
}

async function filesBelow(directory, root = directory) {
    const files = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
    )) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) files.push(...(await filesBelow(absolute, root)));
        else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
    return files;
}

export async function assertNoSensitiveEvidence(output, secrets) {
    const needles = secrets.filter(item => typeof item === "string" && item.length > 0);
    for (const relative of await filesBelow(output)) {
        const bytes = await readFile(path.join(output, ...relative.split("/")));
        const text = bytes.toString("utf8");
        for (const secret of needles) {
            if (text.includes(secret)) throw new Error(`sensitive value leaked into evidence file ${relative}`);
        }
    }
    return { filesScanned: (await filesBelow(output)).length, valuesScanned: needles.length };
}

async function atomicJson(file, value, mode) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, file);
}

async function exists(file) {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
    }
}

async function fingerprintFiles(root, paths) {
    const records = [];
    for (const relative of paths.sort()) {
        const bytes = await readFile(path.join(root, relative));
        records.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
    return { algorithm: "sha256", digest: sha256(JSON.stringify(records)), files: records };
}

async function fingerprintDeployment(app, paths, secretsPath) {
    const tree = await fingerprintFiles(app, paths);
    const secretSetSha256 = sha256(await readFile(secretsPath));
    return {
        ...tree,
        digest: sha256(JSON.stringify({ files: tree.files, secretSetSha256 })),
        secretSetSha256,
    };
}

export async function finalizeFileProofEvidence(output, report, secrets, benchmarkEvidence) {
    if (benchmarkEvidence) {
        check(/^[a-f0-9]{64}$/.test(benchmarkEvidence.pairSha256 ?? ""), "benchmark evidence digest is invalid");
    }
    const reportPath = path.join(output, "r2-proof-report.json");
    const finalReport = {
        ...report,
        evidence: {
            secretScanPassed: true,
            checksumFile: "evidence.sha256",
            ...(benchmarkEvidence
                ? {
                      benchmark: {
                          directory: "benchmarks",
                          manifestFile: "benchmark-evidence.sha256",
                          pairFile: "paired.json",
                          pairSha256: benchmarkEvidence.pairSha256,
                      },
                  }
                : {}),
        },
    };
    await atomicJson(reportPath, finalReport);
    const scan = await assertNoSensitiveEvidence(output, secrets);
    const digest = sha256(await readFile(reportPath));
    await writeFile(path.join(output, "evidence.sha256"), `${digest}  r2-proof-report.json\n`);
    await assertNoSensitiveEvidence(output, secrets);
    return { reportPath, digest, scan };
}

export async function prepareCloudflareFileProofApp(input) {
    const app = path.resolve(input.app);
    await mkdir(app, { recursive: true });
    if ((await readdir(app)).length > 0) throw new Error("file proof app directory must be empty");
    await cp(path.join(FIXTURE, "src"), path.join(app, "src"), { recursive: true });
    await cp(path.join(FIXTURE, "tsconfig.json"), path.join(app, "tsconfig.json"));
    const tarball = path.resolve(input.tarball);
    const copiedTarball = path.join(app, "chardb-proof.tgz");
    await cp(tarball, copiedTarball);
    const packageJson = renderFileProofPackage("./chardb-proof.tgz");
    await writeFile(path.join(app, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    const template = await readFile(path.join(FIXTURE, "wrangler.template.toml"), "utf8");
    await writeFile(path.join(app, "wrangler.toml"), renderFileProofWrangler(template, input));
    return fingerprintFiles(app, [
        "chardb-proof.tgz",
        "package.json",
        "src/api.ts",
        "src/auth.ts",
        "src/migrations.ts",
        "src/schema.ts",
        "src/worker.ts",
        "tsconfig.json",
        "wrangler.toml",
    ]);
}

async function runCommand(command, args, options = {}) {
    const child = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]).finally(() => clearTimeout(timer));
    const result = { exitCode, stdout, stderr };
    if (exitCode !== 0 && !options.allowFailure) {
        const detail = scrubSensitive(`${stdout}\n${stderr}`.trim(), options.secrets ?? []);
        throw new Error(`${options.label ?? command} failed with exit ${exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return result;
}

export async function runFileProofMigrationCommand(input, dependencies = {}) {
    const run = dependencies.run ?? runCommand;
    const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const now = dependencies.now ?? Date.now;
    const startedAt = now();
    let delayMs = MIGRATION_EDGE_404_BASE_DELAY_MS;
    while (true) {
        try {
            return await run(input.command, input.args, input.options);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("migration endpoint returned 404 with invalid JSON")) throw error;
            const remainingMs = MIGRATION_EDGE_404_WINDOW_MS - (now() - startedAt);
            if (remainingMs <= 0) throw error;
            await wait(Math.min(delayMs, remainingMs));
            delayMs = Math.min(delayMs * 2, MIGRATION_EDGE_404_MAX_DELAY_MS);
        }
    }
}

function parseJsonOutput(result, label) {
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`${label} returned invalid JSON`);
    }
}

function newestVersion(input) {
    if (!Array.isArray(input) || input.length === 0) throw new Error("Wrangler returned no Worker versions");
    const versions = input.filter(
        item => item && /^[a-f0-9-]{36}$/.test(item.id ?? "") && Number.isSafeInteger(item.number)
    );
    if (versions.length !== input.length) throw new Error("Wrangler returned an invalid Worker version");
    return versions.sort((left, right) => right.number - left.number)[0];
}

function assertFullTraffic(input, versionId) {
    if (
        !input ||
        !Array.isArray(input.versions) ||
        input.versions.length !== 1 ||
        input.versions[0]?.version_id !== versionId ||
        input.versions[0]?.percentage !== 100
    ) {
        throw new Error(`Worker version ${versionId} does not have 100% traffic`);
    }
    return { deploymentId: input.id, versionId, percentage: 100 };
}

export function remoteAbsenceConfirmed(kind, result) {
    if (kind === "bucket") {
        if (result.exitCode !== 0) throw new Error("R2 bucket preflight failed");
        const output = result.stdout.trim();
        if (output.startsWith("[")) {
            const parsed = parseJsonOutput(result, "R2 bucket list");
            if (!Array.isArray(parsed)) throw new Error("R2 bucket list was not an array");
            return parsed;
        }
        if (!/Listing buckets\.\.\./.test(output)) {
            throw new Error("R2 bucket list did not contain Wrangler's completion marker");
        }
        return [...output.matchAll(/^name:\s+([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\s*$/gm)].map(match => ({
            name: match[1],
        }));
    }
    if (result.exitCode === 0) {
        const parsed = parseJsonOutput(result, "Worker version list");
        if (!Array.isArray(parsed)) throw new Error("Worker version list was not an array");
        return parsed;
    }
    const text = `${result.stdout}\n${result.stderr}`;
    if (!/(not found|does not exist|code:\s*10090|workers\.api\.error\.service_not_found)/i.test(text)) {
        throw new Error("Worker preflight failed without a recognized absence response");
    }
    return [];
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

async function request(origin, pathname, init = {}) {
    const response = await fetch(new URL(pathname, origin), { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // Keep non-JSON error bodies for status assertions. They never enter evidence.
    }
    return { response, body };
}

function check(condition, message) {
    if (!condition) throw new Error(message);
}

async function authPost(origin, principal, route, body) {
    const result = await request(origin, `/api/auth${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: principal.cookie, origin },
        body: JSON.stringify(body),
    });
    check(result.response.ok, `Better Auth ${route} failed with ${result.response.status}`);
    principal.cookie = mergeCookies(principal.cookie, result.response.headers);
    return result.body;
}

async function refreshPrincipal(origin, principal) {
    const session = await request(origin, "/api/auth/get-session", { headers: { cookie: principal.cookie } });
    check(session.response.ok && session.body?.user?.id, "Better Auth session refresh failed");
    principal.cookie = mergeCookies(principal.cookie, session.response.headers);
    principal.session = session.body;
    const token = await request(origin, "/api/auth/token", { headers: { cookie: principal.cookie } });
    check(token.response.ok && typeof token.body?.token === "string", "Better Auth token issue failed");
    principal.cookie = mergeCookies(principal.cookie, token.response.headers);
    principal.token = token.body.token;
}

async function newPrincipal(origin) {
    const signIn = await request(origin, "/api/auth/sign-in/anonymous", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: "{}",
    });
    check(signIn.response.ok, `anonymous sign-in failed with ${signIn.response.status}`);
    const principal = { cookie: sessionCookies(signIn.response.headers), session: null, token: null };
    await refreshPrincipal(origin, principal);
    return principal;
}

async function createOrganization(origin, principal, label) {
    const organization = await authPost(origin, principal, "/organization/create", {
        name: `R2 proof ${label}`,
        slug: `r2-proof-${label}-${randomUUID().slice(0, 8)}`,
        keepCurrentActiveOrganization: true,
    });
    check(typeof organization?.id === "string", "organization creation returned no id");
    await authPost(origin, principal, "/organization/set-active", { organizationId: organization.id });
    await refreshPrincipal(origin, principal);
    return organization.id;
}

async function setActive(origin, principal, organizationId) {
    await authPost(origin, principal, "/organization/set-active", { organizationId });
    await refreshPrincipal(origin, principal);
}

async function upload(origin, principal, organizationId, bytes, key, contentType = "application/octet-stream") {
    const query = new URLSearchParams({ organizationId, table: "documents", column: "attachment" });
    const result = await request(origin, `/_chardb/files/upload?${query}`, {
        method: "PUT",
        headers: {
            "content-type": contentType,
            "idempotency-key": key,
            cookie: principal.cookie,
            origin,
        },
        body: bytes,
    });
    check(
        result.response.ok && typeof result.body?.file?.fileId === "string",
        `upload failed with ${result.response.status}`
    );
    return result.body.file;
}

async function mutateDocument(origin, principal, action, id, organizationId, fileId, mutId) {
    return request(origin, "/api/documents", {
        method: "POST",
        headers: { authorization: `Bearer ${principal.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action, id, organizationId, fileId, mutId }),
    });
}

async function download(origin, principal, organizationId, rowId) {
    const query = new URLSearchParams({ organizationId, table: "documents", column: "attachment", rowId });
    const response = await fetch(new URL(`/_chardb/files/download?${query}`, origin), {
        headers: { cookie: principal.cookie, origin },
        signal: AbortSignal.timeout(30_000),
    });
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function proofState(origin, adminToken, runId, organizationId) {
    const query = new URLSearchParams(organizationId ? { organizationId } : {});
    const result = await request(origin, `/proof/r2-state?${query}`, {
        headers: { authorization: `Bearer ${adminToken}`, "x-chardb-proof-run-id": runId },
    });
    check(result.response.ok && Number.isSafeInteger(result.body?.count), "proof R2 state request failed");
    return result.body;
}

async function migrationState(origin, adminToken) {
    const result = await request(origin, "/_chardb/migrations/state", {
        headers: { authorization: `Bearer ${adminToken}` },
    });
    check(result.response.ok && result.body?.state, "migration state request failed");
    return result.body.state;
}

async function migrationAdmin(origin, adminToken, pathName, body) {
    const result = await request(origin, `/_chardb/migrations/${pathName}`, {
        ...(body === undefined
            ? { headers: { authorization: `Bearer ${adminToken}` } }
            : {
                  method: "POST",
                  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
                  body: JSON.stringify(body),
              }),
    });
    const detail =
        typeof result.body === "string" ? result.body : result.body === null ? "" : JSON.stringify(result.body);
    check(
        result.response.ok,
        `migration ${pathName} failed with ${result.response.status}${detail ? `: ${detail.slice(0, 1_000)}` : ""}`
    );
    return result.body;
}

async function createRecoveryPoint(origin, adminToken) {
    const result = await request(origin, "/_chardb/backups/create", {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: "{}",
    });
    check(result.response.ok, `recovery-point creation failed with ${result.response.status}`);
    const point = result.body?.recoveryPoint;
    check(
        point?.format === "chardb-recovery-point/v1" &&
            /^[a-f0-9]{64}$/.test(point.digest ?? "") &&
            Array.isArray(point.shards) &&
            point.shards.length > 0,
        "recovery-point creation returned an invalid manifest"
    );
    return point;
}

async function restoreRecoveryPoint(origin, adminToken, recoveryPoint) {
    const result = await runRecoveryOperation(origin, adminToken, "restore", recoveryPoint);
    const accepted =
        result.response.status === 202 &&
        result.body?.accepted === true &&
        result.body?.recoveryPointDigest === recoveryPoint.digest &&
        Number.isSafeInteger(result.body?.providerReset?.files) &&
        result.body.providerReset.files >= 0 &&
        Number.isSafeInteger(result.body?.providerReset?.filesRetained) &&
        result.body.providerReset.filesRetained >= 0 &&
        Number.isSafeInteger(result.body?.providerReset?.vectors) &&
        result.body.providerReset.vectors >= 0;
    const diagnostic =
        typeof result.body === "object" && result.body !== null
            ? [result.body.code, result.body.error].filter(value => typeof value === "string").join(": ")
            : "";
    check(accepted, `recovery-point restore returned ${result.response.status}${diagnostic ? `: ${diagnostic}` : ""}`);
    return {
        status: result.response.status,
        filesReset: result.body.providerReset.files,
        filesRetained: result.body.providerReset.filesRetained,
        vectorsReset: result.body.providerReset.vectors,
    };
}

async function reconcileRecoveryPoint(origin, adminToken, recoveryPoint) {
    const result = await runRecoveryOperation(origin, adminToken, "reconcile", recoveryPoint);
    const reconciled =
        result.response.ok &&
        result.body?.reconciled === true &&
        result.body?.recoveryPointDigest === recoveryPoint.digest &&
        Number.isSafeInteger(result.body?.filesRehydrated) &&
        result.body.filesRehydrated >= 0 &&
        Number.isSafeInteger(result.body?.vectorsRequeued) &&
        result.body.vectorsRequeued >= 0;
    const diagnostic =
        typeof result.body === "object" && result.body !== null
            ? [result.body.code, result.body.error].filter(value => typeof value === "string").join(": ")
            : "";
    check(
        reconciled,
        `recovery reconciliation returned ${result.response.status}${diagnostic ? `: ${diagnostic}` : ""}`
    );
    return { filesRehydrated: result.body.filesRehydrated, vectorsRequeued: result.body.vectorsRequeued };
}

async function runRecoveryOperation(origin, adminToken, action, recoveryPoint) {
    let continuation;
    let continuationIdentity;
    for (let turn = 0; turn < RECOVERY_OPERATION_TURNS; turn++) {
        const result = await request(origin, `/_chardb/backups/${action}`, {
            method: "POST",
            headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
            body: JSON.stringify(continuation === undefined ? { recoveryPoint } : { recoveryPoint, continuation }),
        });
        if (result.body?.pending !== true) return result;
        const next = result.body?.continuation;
        check(
            result.response.status === 202 &&
                result.body?.recoveryPointDigest === recoveryPoint.digest &&
                next !== null &&
                typeof next === "object" &&
                !Array.isArray(next),
            `recovery ${action} returned an invalid continuation`
        );
        const nextIdentity = JSON.stringify(next);
        check(nextIdentity !== continuationIdentity, `recovery ${action} returned a stalled continuation`);
        continuation = next;
        continuationIdentity = nextIdentity;
    }
    throw new Error(`recovery ${action} exceeded its continuation bound`);
}

function boundedDiagnostic(value) {
    const text = String(value);
    return text.length <= 512 ? text : text.slice(0, 512);
}

export async function collectMigrationShardFailureDiagnostics(input, requestImpl = request) {
    const diagnostic = {
        phase: "migrate-schema-shard",
        migrationId: input.migrationId,
        shardId: input.shardId,
        inventoryHttpStatus: null,
        shardStatus: null,
        lastError: null,
        inventoryError: null,
    };
    try {
        const inventory = await requestImpl(
            input.origin,
            `/_chardb/migrations/shards?migrationId=${encodeURIComponent(input.migrationId)}`,
            { headers: { authorization: `Bearer ${input.adminToken}` } }
        );
        diagnostic.inventoryHttpStatus = inventory.response.status;
        if (!inventory.response.ok) {
            diagnostic.inventoryError = boundedDiagnostic(
                typeof inventory.body === "string" ? inventory.body : JSON.stringify(inventory.body)
            );
            return Object.freeze(diagnostic);
        }
        const shards = Array.isArray(inventory.body?.shards) ? inventory.body.shards : [];
        const shard = shards.find(candidate => candidate?.shardId === input.shardId);
        if (!shard) {
            diagnostic.inventoryError = "Catalog shard inventory omitted the failed shard";
            return Object.freeze(diagnostic);
        }
        diagnostic.shardStatus = typeof shard.status === "string" ? boundedDiagnostic(shard.status) : null;
        diagnostic.lastError = typeof shard.lastError === "string" ? boundedDiagnostic(shard.lastError) : null;
        return Object.freeze(diagnostic);
    } catch (error) {
        diagnostic.inventoryError = boundedDiagnostic(error instanceof Error ? error.message : error);
        return Object.freeze(diagnostic);
    }
}

export function migrationShardFailureMessage(error, diagnostic) {
    const message = error instanceof Error ? error.message : String(error);
    return `${message}; Catalog shard diagnostics ${JSON.stringify(diagnostic)}`;
}

function migrationShardHttpFailure(result) {
    const detail =
        typeof result.body === "string" ? result.body : result.body === null ? "" : JSON.stringify(result.body);
    return new Error(
        `migration shard failed with ${result.response.status}${detail ? `: ${detail.slice(0, 1_000)}` : ""}`
    );
}

export async function activateMigrationShardWithRetry(input, injected = {}) {
    const requestImpl = injected.request ?? request;
    const sleep = injected.sleep ?? Bun.sleep;
    let lastFailure = new Error("migration shard did not run");
    let lastDiagnostic = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        let result;
        try {
            result = await requestImpl(input.origin, "/_chardb/migrations/shard", {
                method: "POST",
                headers: { authorization: `Bearer ${input.adminToken}`, "content-type": "application/json" },
                body: JSON.stringify({ migrationId: input.migrationId, shardId: input.shardId }),
            });
        } catch (error) {
            lastFailure = error instanceof Error ? error : new Error(String(error));
        }
        if (result?.response.ok) {
            if (result.body?.shard?.shardId !== input.shardId || result.body.shard.status !== "active") {
                throw new Error("file proof migration returned an invalid activated shard");
            }
            return result.body;
        }
        if (result) lastFailure = migrationShardHttpFailure(result);
        lastDiagnostic = await collectMigrationShardFailureDiagnostics(input, requestImpl);
        if (lastDiagnostic.shardStatus === "active") {
            return Object.freeze({
                shard: Object.freeze({
                    shardId: input.shardId,
                    status: "active",
                    lastError: lastDiagnostic.lastError,
                }),
            });
        }
        const status = result?.response.status;
        const retryable = result === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599);
        if (!retryable || attempt === 3) {
            throw new Error(migrationShardFailureMessage(lastFailure, lastDiagnostic), { cause: lastFailure });
        }
        await sleep(250 * attempt);
    }
    throw new Error(migrationShardFailureMessage(lastFailure, lastDiagnostic));
}

async function retry(checkValue, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            return await checkValue();
        } catch (error) {
            last = error;
            await Bun.sleep(500);
        }
    }
    throw last ?? new Error("proof poll timed out");
}

async function usage() {
    return [
        "Usage: bun scripts/run-cloudflare-file-proof.mjs [options]",
        "",
        "  --tarball <file>                  exact passing chardb package tarball",
        "  --output <directory>              new redacted evidence directory",
        "  --private-dir <directory>         separate mode-0700 work and secret directory",
        "  --workers-dev-subdomain <label>   account workers.dev subdomain",
        "  --account-id <32-hex-id>          exact Cloudflare account to mutate",
        "  --cloudflare-api-token-file <file> use a private token file instead of stored Wrangler OAuth",
        "  --confirm-disposable-resources    permit this run to create and delete its unique Worker and bucket",
    ].join("\n");
}

async function main() {
    const options = parseCloudflareFileProofArgs(process.argv.slice(2));
    if (options.help) {
        console.log(await usage());
        return;
    }
    const tarball = path.resolve(options.tarball);
    const candidateBytes = await readFile(tarball);
    const candidateSha256 = sha256(candidateBytes);
    const { output, privateDir } = await prepareCloudflareFileProofDirectories(options.output, options.privateDir);
    const apiToken = await readCloudflareApiToken(options.cloudflareApiTokenFile);
    const wranglerEnvironment = cloudflareEnvironment(
        options.accountId,
        apiToken,
        path.join(privateDir, "wrangler.log")
    );
    const ledgerPath = path.join(privateDir, "ownership.json");
    const app = path.join(privateDir, "app");
    const nonce = randomBytes(8).toString("hex");
    const runId = randomBytes(24).toString("base64url");
    const names = deriveDisposableResourceNames(candidateSha256, nonce);
    const origin = `https://${names.worker}.${options.workersDevSubdomain}.workers.dev`;
    const authSecret = randomBytes(32).toString("base64url");
    const adminToken = randomBytes(32).toString("base64url");
    const secrets =
        apiToken === undefined ? [authSecret, adminToken, runId] : [authSecret, adminToken, runId, apiToken];
    const secretsPath = path.join(privateDir, "secrets.env");
    await writeFile(
        secretsPath,
        `BETTER_AUTH_SECRET=${authSecret}\nCDB_ADMIN_TOKEN=${adminToken}\nCDB_PROOF_RUN_ID=${runId}\n`,
        { mode: 0o600 }
    );
    await chmod(secretsPath, 0o600);
    let ledger = {
        schema: LEDGER_SCHEMA,
        candidateSha256,
        accountIdSha256: sha256(options.accountId),
        nonce,
        runId,
        worker: names.worker,
        bucket: names.bucket,
        workerAbsentConfirmed: false,
        bucketAbsentConfirmed: false,
        workerCreateIntent: false,
        workerCreated: false,
        bucketCreateIntent: false,
        bucketCreated: false,
        knownKeys: [],
    };
    await atomicJson(ledgerPath, ledger, 0o600);
    const report = {
        schema: REPORT_SCHEMA,
        ok: false,
        startedAt: new Date().toISOString(),
        completedAt: null,
        candidate: { algorithm: "sha256", digest: candidateSha256, bytes: candidateBytes.byteLength },
        target: { worker: names.worker, bucket: names.bucket, origin, accountIdSha256: sha256(options.accountId) },
        wranglerVersion: WRANGLER_VERSION,
        deploymentInput: null,
        versions: {},
        migration: null,
        recovery: null,
        lifecycle: null,
        cleanup: { workerDeleted: false, bucketDeleted: false, fallbackPurge: false },
        error: null,
    };
    let wrangler = await resolveWranglerExecutable(path.join(ROOT, "package.json"));
    const runWrangler = (args, commandOptions = {}) =>
        runCommand(wrangler, args, { ...commandOptions, env: wranglerEnvironment });
    let proofSucceeded = false;
    let localRuntime;
    let benchmarkEvidence;
    let ledgerWrite = Promise.resolve();
    const recordObjects = objects => {
        ledgerWrite = ledgerWrite.then(async () => {
            const keys = objects.map(({ organizationId, fileId }) => `v1/${organizationId}/${fileId}`);
            ledger = { ...ledger, knownKeys: [...new Set([...ledger.knownKeys, ...keys])] };
            assertCleanupOwnership(ledger, candidateSha256, options.accountId);
            await atomicJson(ledgerPath, ledger, 0o600);
        });
        return ledgerWrite;
    };
    const recordObject = (organizationId, fileId) => recordObjects([{ organizationId, fileId }]);
    try {
        report.deploymentInput = await prepareCloudflareFileProofApp({
            app,
            tarball,
            worker: names.worker,
            bucket: names.bucket,
            releaseSha256: candidateSha256,
            runId,
        });
        const npmCache = path.join(privateDir, "npm-cache");
        await runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
            cwd: app,
            env: { ...process.env, npm_config_cache: npmCache },
            label: "proof dependency install",
            secrets,
        });
        wrangler = await resolveWranglerExecutable(path.join(app, "package.json"));
        await runCommand("npm", ["run", "typecheck"], { cwd: app, label: "proof fixture typecheck", secrets });
        await runCommand(
            process.execPath,
            [path.join(app, "node_modules", "@chardb", "core", "dist", "cli", "bin.mjs"), "doctor", "wrangler"],
            {
                cwd: app,
                label: "proof Wrangler doctor",
                secrets,
            }
        );
        await runWrangler(["deploy", "--dry-run", "--outdir", "worker-dist"], {
            cwd: app,
            label: "proof Worker dry run",
            secrets,
        });
        report.deploymentInput = await fingerprintDeployment(
            app,
            [...report.deploymentInput.files.map(file => file.path), "package-lock.json"],
            secretsPath
        );

        const buckets = remoteAbsenceConfirmed(
            "bucket",
            await runWrangler(["r2", "bucket", "list"], {
                cwd: app,
                label: "R2 bucket absence preflight",
                secrets,
                allowFailure: true,
            })
        );
        check(!buckets.some(bucket => bucket?.name === names.bucket), "disposable R2 bucket name already exists");
        ledger = { ...ledger, bucketAbsentConfirmed: true };
        await atomicJson(ledgerPath, ledger, 0o600);
        const workerVersions = remoteAbsenceConfirmed(
            "worker",
            await runWrangler(["versions", "list", "--name", names.worker, "--json"], {
                cwd: app,
                label: "Worker absence preflight",
                secrets,
                allowFailure: true,
            })
        );
        check(workerVersions.length === 0, "disposable Worker name already exists");
        ledger = { ...ledger, workerAbsentConfirmed: true };
        await atomicJson(ledgerPath, ledger, 0o600);

        ledger = { ...ledger, bucketCreateIntent: true };
        await atomicJson(ledgerPath, ledger, 0o600);
        await runWrangler(["r2", "bucket", "create", names.bucket], {
            cwd: app,
            label: "R2 bucket create",
            secrets,
        });
        ledger = { ...ledger, bucketCreated: true, workerCreateIntent: true };
        await atomicJson(ledgerPath, ledger, 0o600);
        await runWrangler(
            [
                "deploy",
                "--name",
                names.worker,
                "--strict",
                "--secrets-file",
                secretsPath,
                "--tag",
                `${nonce}-v1`,
                "--message",
                "Chardb disposable R2 proof v1",
            ],
            { cwd: app, label: "initial proof deploy", secrets }
        );
        ledger = { ...ledger, workerCreated: true };
        await atomicJson(ledgerPath, ledger, 0o600);
        const initial = newestVersion(
            parseJsonOutput(
                await runWrangler(["versions", "list", "--name", names.worker, "--json"], {
                    cwd: app,
                    label: "initial Worker version list",
                    secrets,
                }),
                "initial Worker version list"
            )
        );
        const initialDeployment = assertFullTraffic(
            parseJsonOutput(
                await runWrangler(["deployments", "status", "--name", names.worker, "--json"], {
                    cwd: app,
                    label: "initial deployment status",
                    secrets,
                }),
                "initial deployment status"
            ),
            initial.id
        );
        report.versions.initial = { ...initialDeployment, number: initial.number };
        await retry(async () => {
            const health = await request(origin, "/health");
            check(
                health.response.ok &&
                    health.body?.releaseSha256 === candidateSha256 &&
                    health.body?.proofConfigured === true,
                "proof health is not ready"
            );
            const state = await migrationState(origin, adminToken);
            check(
                state.status === "active" && state.activeVersion === 0 && state.activeEpoch === 1,
                "fresh file proof Worker did not start at schema version 0 epoch 1"
            );
            return state;
        });
        const cli = path.join(app, "node_modules", "@chardb", "core", "dist", "cli", "bin.mjs");
        const migrationId = `r2-${candidateSha256.slice(0, 10)}-${nonce}`;
        const begunMigration = await migrationAdmin(origin, adminToken, "begin", {
            migrationId,
            targetVersion: 1,
        });
        check(
            begunMigration?.state?.status === "migrating" && begunMigration.state.migrationId === migrationId,
            "file proof migration did not enter the migrating state"
        );
        const shardInventory = await migrationAdmin(
            origin,
            adminToken,
            `shards?migrationId=${encodeURIComponent(migrationId)}`
        );
        const pendingShards = shardInventory?.shards?.filter(shard => shard.status === "pending") ?? [];
        check(pendingShards.length > 0, "file proof migration exposed no pending shard to interrupt after");
        const interruptedShard = pendingShards[0].shardId;
        const activatedShard = await activateMigrationShardWithRetry({
            origin,
            adminToken,
            migrationId,
            shardId: interruptedShard,
        });
        check(
            activatedShard?.shard?.shardId === interruptedShard && activatedShard.shard.status === "active",
            "file proof migration did not activate the interrupted shard"
        );
        const interruptedState = await migrationState(origin, adminToken);
        check(
            interruptedState.status === "migrating" &&
                interruptedState.activeVersion === 0 &&
                interruptedState.migrationId === migrationId,
            "file proof migration did not remain durably interrupted"
        );
        const fencedSignIn = await request(origin, "/api/auth/sign-in/anonymous", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: "{}",
        });
        check(!fencedSignIn.response.ok, "public traffic did not fail closed during file migration");
        for (let attempt = 0; attempt < 2; attempt++) {
            await runFileProofMigrationCommand({
                command: process.execPath,
                args: [cli, "migrate", "--url", origin, "--id", migrationId, "--target", "1", "--concurrency", "2"],
                options: {
                    cwd: app,
                    env: { ...process.env, CHARDB_ADMIN_TOKEN: adminToken },
                    label: `file proof migration ${attempt + 1}`,
                    secrets,
                },
            });
        }
        const activeMigration = await migrationState(origin, adminToken);
        check(
            activeMigration.status === "active" &&
                activeMigration.activeVersion === 1 &&
                activeMigration.activeEpoch === 2,
            "file proof migration did not activate schema version 1 epoch 2"
        );
        report.migration = {
            id: migrationId,
            before: { activeVersion: 0, activeEpoch: 1 },
            after: { activeVersion: 1, activeEpoch: 2 },
            interruptedShard,
            interruptedState: {
                status: interruptedState.status,
                activeVersion: interruptedState.activeVersion,
                migrationId: interruptedState.migrationId,
            },
            trafficFenceStatus: fencedSignIn.response.status,
            sameIdResume: true,
            idempotentRetry: true,
        };

        const principal = await newPrincipal(origin);
        const organizationA = await createOrganization(origin, principal, "a");
        const organizationB = await createOrganization(origin, principal, "b");
        await setActive(origin, principal, organizationA);
        const firstBytes = new TextEncoder().encode(`first-${nonce}`);
        const first = await upload(origin, principal, organizationA, firstBytes, `first-${nonce}`);
        await recordObject(organizationA, first.fileId);
        const firstRetry = await upload(origin, principal, organizationA, firstBytes, `first-${nonce}`);
        check(JSON.stringify(firstRetry) === JSON.stringify(first), "idempotent upload changed its result");
        const rowId = `row-${nonce}`;
        let mutation = await mutateDocument(
            origin,
            principal,
            "create",
            rowId,
            organizationA,
            first.fileId,
            `create-${nonce}`
        );
        check(mutation.response.ok, `document create failed with ${mutation.response.status}`);
        let downloaded = await download(origin, principal, organizationA, rowId);
        check(downloaded.response.ok && sha256(downloaded.bytes) === first.sha256, "attached file download drifted");
        const expectedDownloadHeaders = {
            "cache-control": "private, no-store",
            "content-disposition": "attachment",
            "content-length": String(firstBytes.byteLength),
            "content-security-policy": "sandbox",
            "content-type": "application/octet-stream",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
        };
        for (const [name, expected] of Object.entries(expectedDownloadHeaders)) {
            check(downloaded.response.headers.get(name) === expected, `download ${name} header drifted`);
        }
        const locator = new URLSearchParams({
            organizationId: organizationA,
            table: "documents",
            column: "attachment",
            rowId,
        });
        const crossOriginUpload = await request(
            origin,
            `/_chardb/files/upload?${new URLSearchParams({ organizationId: organizationA, table: "documents", column: "attachment" })}`,
            {
                method: "PUT",
                headers: {
                    "content-type": "text/plain",
                    "idempotency-key": `cross-origin-${nonce}`,
                    cookie: principal.cookie,
                    origin: "https://attacker.invalid",
                },
                body: "denied",
            }
        );
        check(crossOriginUpload.response.status === 403, "cross-origin upload was not rejected");
        const crossOriginDownload = await request(origin, `/_chardb/files/download?${locator}`, {
            headers: { cookie: principal.cookie, origin: "https://attacker.invalid" },
        });
        check(crossOriginDownload.response.status === 403, "cross-origin download was not rejected");
        const rangeDownload = await request(origin, `/_chardb/files/download?${locator}`, {
            headers: { cookie: principal.cookie, origin, range: "bytes=0-3" },
        });
        check(rangeDownload.response.status === 416, "range download was not rejected");
        const policyPrincipal = await newPrincipal(origin);
        const addedPolicyMember = await request(origin, "/proof/add-member", {
            method: "POST",
            headers: {
                authorization: `Bearer ${adminToken}`,
                "content-type": "application/json",
                "x-chardb-proof-run-id": runId,
            },
            body: JSON.stringify({ organizationId: organizationA, userId: policyPrincipal.session.user.id }),
        });
        check(addedPolicyMember.response.ok, "same-organization policy member could not be added");
        await setActive(origin, policyPrincipal, organizationA);
        const rowPolicyDenied = await download(origin, policyPrincipal, organizationA, rowId);
        check(rowPolicyDenied.response.status === 404, "same-organization row policy did not hide the file");
        const unsupportedType = await request(
            origin,
            `/_chardb/files/upload?${new URLSearchParams({ organizationId: organizationA, table: "documents", column: "attachment" })}`,
            {
                method: "PUT",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": `unsupported-type-${nonce}`,
                    cookie: principal.cookie,
                    origin,
                },
                body: "{}",
            }
        );
        check(
            unsupportedType.response.status === 400,
            `unsupported upload content type returned ${unsupportedType.response.status}: ${
                typeof unsupportedType.body === "string"
                    ? unsupportedType.body.slice(0, 500)
                    : JSON.stringify(unsupportedType.body).slice(0, 500)
            }`
        );
        const oversizedUpload = await request(
            origin,
            `/_chardb/files/upload?${new URLSearchParams({ organizationId: organizationA, table: "documents", column: "attachment" })}`,
            {
                method: "PUT",
                headers: {
                    "content-type": "application/octet-stream",
                    "idempotency-key": `oversized-${nonce}`,
                    cookie: principal.cookie,
                    origin,
                },
                body: new Uint8Array(5 * 1_024 * 1_024 + 1),
            }
        );
        check(oversizedUpload.response.status === 400, "oversized upload was not rejected");
        const firstObject = `v1/${organizationA}/${first.fileId}`;
        const firstObjectPath = path.join(privateDir, "first-object.bin");
        await runWrangler(
            ["r2", "object", "get", `${names.bucket}/${firstObject}`, "--remote", "--file", firstObjectPath],
            {
                cwd: app,
                label: "independent first R2 download",
                secrets,
            }
        );
        check(sha256(await readFile(firstObjectPath)) === first.sha256, "independent R2 digest drifted");

        const replacementBytes = new TextEncoder().encode(`replacement-${nonce}`);
        const replacement = await upload(origin, principal, organizationA, replacementBytes, `replacement-${nonce}`);
        await recordObject(organizationA, replacement.fileId);
        mutation = await mutateDocument(
            origin,
            principal,
            "replace",
            rowId,
            organizationA,
            replacement.fileId,
            `replace-${nonce}`
        );
        check(mutation.response.ok, `document replacement failed with ${mutation.response.status}`);
        await retry(async () => {
            const old = await runWrangler(
                ["r2", "object", "get", `${names.bucket}/${firstObject}`, "--remote", "--file", firstObjectPath],
                { cwd: app, label: "old object cleanup poll", secrets, allowFailure: true }
            );
            check(old.exitCode !== 0, "superseded object still exists");
            return true;
        });

        const bulk = [];
        for (let index = 0; index < 34; index++) {
            const bytes = new TextEncoder().encode(`bulk-${index}-${nonce}`);
            const uploaded = await upload(origin, principal, organizationA, bytes, `bulk-${index}-${nonce}`);
            await recordObject(organizationA, uploaded.fileId);
            bulk.push(uploaded);
            if (index % 2 === 0) {
                const id = `bulk-row-${index}-${nonce}`;
                const attached = await mutateDocument(
                    origin,
                    principal,
                    "create",
                    id,
                    organizationA,
                    uploaded.fileId,
                    `bulk-attach-${index}-${nonce}`
                );
                check(attached.response.ok, `bulk attachment ${index} failed`);
            }
        }
        const isolationTenants = await Promise.all(
            Array.from({ length: 8 }, async (_, organizationIndex) => {
                const isolatedPrincipal = await newPrincipal(origin);
                const organizationId = await createOrganization(
                    origin,
                    isolatedPrincipal,
                    `isolation-${organizationIndex}`
                );
                const uploads = await Promise.all(
                    Array.from({ length: 8 }, async (_, objectIndex) => {
                        const bytes = new TextEncoder().encode(
                            `isolation-${organizationIndex}-${objectIndex}-${nonce}`
                        );
                        const uploaded = await upload(
                            origin,
                            isolatedPrincipal,
                            organizationId,
                            bytes,
                            `isolation-${organizationIndex}-${objectIndex}-${nonce}`
                        );
                        return { bytes, uploaded, rowId: `isolation-row-${organizationIndex}-${objectIndex}-${nonce}` };
                    })
                );
                await recordObjects(uploads.map(item => ({ organizationId, fileId: item.uploaded.fileId })));
                for (let objectIndex = 0; objectIndex < uploads.length; objectIndex++) {
                    const item = uploads[objectIndex];
                    const attached = await mutateDocument(
                        origin,
                        isolatedPrincipal,
                        "create",
                        item.rowId,
                        organizationId,
                        item.uploaded.fileId,
                        `isolation-attach-${organizationIndex}-${objectIndex}-${nonce}`
                    );
                    check(attached.response.ok, `isolation attachment ${organizationIndex}/${objectIndex} failed`);
                }
                const downloads = await Promise.all(
                    uploads.map(item => download(origin, isolatedPrincipal, organizationId, item.rowId))
                );
                for (let objectIndex = 0; objectIndex < downloads.length; objectIndex++) {
                    check(
                        downloads[objectIndex].response.ok &&
                            sha256(downloads[objectIndex].bytes) === uploads[objectIndex].uploaded.sha256,
                        `isolation download ${organizationIndex}/${objectIndex} drifted`
                    );
                }
                return { principal: isolatedPrincipal, organizationId, uploads };
            })
        );
        for (let index = 0; index < isolationTenants.length; index++) {
            const deniedTenant = isolationTenants[index];
            const foreignTenant = isolationTenants[(index + 1) % isolationTenants.length];
            const denied = await download(
                origin,
                deniedTenant.principal,
                foreignTenant.organizationId,
                foreignTenant.uploads[0].rowId
            );
            check(denied.response.status === 404, `isolation tenant ${index} read a neighboring organization`);
        }
        await setActive(origin, principal, organizationB);
        const survivorBytes = new TextEncoder().encode(`survivor-${nonce}`);
        const survivor = await upload(origin, principal, organizationB, survivorBytes, `survivor-${nonce}`);
        await recordObject(organizationB, survivor.fileId);
        const survivorRow = `survivor-row-${nonce}`;
        mutation = await mutateDocument(
            origin,
            principal,
            "create",
            survivorRow,
            organizationB,
            survivor.fileId,
            `survivor-create-${nonce}`
        );
        check(mutation.response.ok, "survivor attachment failed");

        const recoveryPoint = await createRecoveryPoint(origin, adminToken);
        const survivorObject = `v1/${organizationB}/${survivor.fileId}`;
        const survivorRetainedObject = `_chardb/retained/sha256/${survivor.sha256}`;
        const pointFileState = await proofState(origin, adminToken, runId, organizationB);
        const originalRetainedPath = path.join(privateDir, "original-survivor-retained-object.bin");
        await runWrangler(
            [
                "r2",
                "object",
                "get",
                `${names.bucket}/${survivorRetainedObject}`,
                "--remote",
                "--file",
                originalRetainedPath,
            ],
            { cwd: app, label: "original retained-file verification", secrets }
        );
        check(
            sha256(await readFile(originalRetainedPath)) === survivor.sha256,
            "recovery fault target was not retained before deletion"
        );
        await runWrangler(
            ["r2", "object", "delete", `${names.bucket}/${survivorRetainedObject}`, "--remote", "--force"],
            {
                cwd: app,
                label: "recovery expired-retention fault",
                secrets,
            }
        );
        const deletedRetainedPath = path.join(privateDir, "deleted-survivor-retained-object.bin");
        const missingRetainedObject = await runWrangler(
            [
                "r2",
                "object",
                "get",
                `${names.bucket}/${survivorRetainedObject}`,
                "--remote",
                "--file",
                deletedRetainedPath,
            ],
            { cwd: app, label: "expired retained-file absence check", secrets, allowFailure: true }
        );
        check(missingRetainedObject.exitCode !== 0, "recovery fault did not remove the retained object");
        const livePointFileState = await proofState(origin, adminToken, runId, organizationB);
        check(
            livePointFileState.count === pointFileState.count && livePointFileState.digest === pointFileState.digest,
            "recovery retained-file fault changed the live object set"
        );
        const afterPointBytes = new TextEncoder().encode(`after-recovery-point-${nonce}`);
        const afterPointFile = await upload(
            origin,
            principal,
            organizationB,
            afterPointBytes,
            `after-recovery-point-${nonce}`
        );
        await recordObject(organizationB, afterPointFile.fileId);
        const afterPointRow = `after-recovery-point-row-${nonce}`;
        const afterPointMutation = await mutateDocument(
            origin,
            principal,
            "create",
            afterPointRow,
            organizationB,
            afterPointFile.fileId,
            `after-recovery-point-create-${nonce}`
        );
        check(afterPointMutation.response.ok, "post-recovery-point attachment failed");
        const beforeRestore = await download(origin, principal, organizationB, afterPointRow);
        check(
            beforeRestore.response.ok && sha256(beforeRestore.bytes) === afterPointFile.sha256,
            "post-recovery-point row was not readable before restore"
        );
        const recoveryAccepted = await restoreRecoveryPoint(origin, adminToken, recoveryPoint);
        await retry(async () => {
            const restoredAfterPoint = await download(origin, principal, organizationB, afterPointRow);
            check(restoredAfterPoint.response.status === 404, "recovery point did not remove the later row");
            return true;
        }, 120_000);
        const recoveryReconciled = await retry(
            () => reconcileRecoveryPoint(origin, adminToken, recoveryPoint),
            120_000
        );
        const restoredSurvivor = await download(origin, principal, organizationB, survivorRow);
        check(
            restoredSurvivor.response.ok && sha256(restoredSurvivor.bytes) === survivor.sha256,
            "recovery point did not restore its retained file"
        );
        const restoredSurvivorPath = path.join(privateDir, "restored-survivor-object.bin");
        await runWrangler(
            ["r2", "object", "get", `${names.bucket}/${survivorObject}`, "--remote", "--file", restoredSurvivorPath],
            { cwd: app, label: "restored retained-file verification", secrets }
        );
        check(
            sha256(await readFile(restoredSurvivorPath)) === survivor.sha256,
            "retained file was not restored to its canonical live R2 key"
        );
        const refreshedRetainedPath = path.join(privateDir, "refreshed-survivor-retained-object.bin");
        await runWrangler(
            [
                "r2",
                "object",
                "get",
                `${names.bucket}/${survivorRetainedObject}`,
                "--remote",
                "--file",
                refreshedRetainedPath,
            ],
            { cwd: app, label: "refreshed retained-file verification", secrets }
        );
        check(
            sha256(await readFile(refreshedRetainedPath)) === survivor.sha256,
            "restore did not recreate the expired retained object from live bytes"
        );
        const afterPointObject = `v1/${organizationB}/${afterPointFile.fileId}`;
        const afterPointObjectPath = path.join(privateDir, "after-recovery-point-object.bin");
        const removedAfterPointObject = await runWrangler(
            ["r2", "object", "get", `${names.bucket}/${afterPointObject}`, "--remote", "--file", afterPointObjectPath],
            { cwd: app, label: "post-restore R2 cleanup check", secrets, allowFailure: true }
        );
        check(removedAfterPointObject.exitCode !== 0, "restore left the later R2 object behind");
        report.recovery = {
            format: recoveryPoint.format,
            digest: recoveryPoint.digest,
            shardCount: recoveryPoint.shards.length,
            schemaVersion: recoveryPoint.schema.version,
            routingEpoch: recoveryPoint.routingEpoch,
            acceptedStatus: recoveryAccepted.status,
            filesReset: recoveryAccepted.filesReset,
            filesRetained: recoveryAccepted.filesRetained,
            vectorsReset: recoveryAccepted.vectorsReset,
            filesRehydrated: recoveryReconciled.filesRehydrated,
            vectorsRequeued: recoveryReconciled.vectorsRequeued,
            postPointRowReadableBeforeRestore: true,
            pointRowReadableAfterRestore: true,
            postPointRowHiddenAfterRestore: true,
            postPointR2ObjectRemoved: true,
            pointFileRecoveredFromRetention: true,
            pointFileRetentionRefreshedBeforeScrub: true,
        };

        const inputAfterSeed = await fingerprintDeployment(
            app,
            report.deploymentInput.files.map(file => file.path),
            secretsPath
        );
        check(inputAfterSeed.digest === report.deploymentInput.digest, "deployment inputs changed before redeploy");
        await runWrangler(
            [
                "versions",
                "upload",
                "--name",
                names.worker,
                "--secrets-file",
                secretsPath,
                "--tag",
                `${nonce}-v2`,
                "--message",
                "Chardb byte-identical disposable R2 proof redeploy",
            ],
            { cwd: app, label: "byte-identical version upload", secrets }
        );
        const second = newestVersion(
            parseJsonOutput(
                await runWrangler(["versions", "list", "--name", names.worker, "--json"], {
                    cwd: app,
                    label: "second Worker version list",
                    secrets,
                }),
                "second Worker version list"
            )
        );
        check(
            second.id !== initial.id && second.number > initial.number,
            "redeploy did not create a new Worker version"
        );
        await runWrangler(
            [
                "versions",
                "deploy",
                `${second.id}@100`,
                "--name",
                names.worker,
                "--message",
                "Activate R2 proof redeploy",
                "--yes",
            ],
            { cwd: app, label: "second version deploy", secrets }
        );
        report.versions.redeploy = {
            ...assertFullTraffic(
                parseJsonOutput(
                    await runWrangler(["deployments", "status", "--name", names.worker, "--json"], {
                        cwd: app,
                        label: "second deployment status",
                        secrets,
                    }),
                    "second deployment status"
                ),
                second.id
            ),
            number: second.number,
            byteIdentical: true,
        };
        const redeployedMigration = await migrationState(origin, adminToken);
        check(
            redeployedMigration.status === "active" &&
                redeployedMigration.activeVersion === 1 &&
                redeployedMigration.activeEpoch === 2,
            "schema state did not persist across the byte-identical redeploy"
        );
        downloaded = await download(origin, principal, organizationB, survivorRow);
        check(
            downloaded.response.ok && sha256(downloaded.bytes) === survivor.sha256,
            "survivor did not persist across redeploy"
        );

        await setActive(origin, principal, organizationA);
        const stale = { cookie: principal.cookie, token: principal.token };
        await authPost(origin, principal, "/organization/delete", { organizationId: organizationA });
        const staleUpload = await request(
            origin,
            `/_chardb/files/upload?${new URLSearchParams({ organizationId: organizationA, table: "documents", column: "attachment" })}`,
            {
                method: "PUT",
                headers: {
                    "content-type": "text/plain",
                    "idempotency-key": `late-${nonce}`,
                    cookie: stale.cookie,
                    origin,
                },
                body: "late",
            }
        );
        const staleAttach = await mutateDocument(
            origin,
            { ...principal, token: stale.token },
            "replace",
            rowId,
            organizationA,
            replacement.fileId,
            `late-attach-${nonce}`
        );
        const staleDownload = await download(origin, { ...principal, cookie: stale.cookie }, organizationA, rowId);
        check(
            !staleUpload.response.ok && !staleAttach.response.ok && !staleDownload.response.ok,
            "deleted organization accepted stale access"
        );
        const deletedA = await retry(async () => {
            const state = await proofState(origin, adminToken, runId, organizationA);
            check(state.count === 0, `organization A still has ${state.count} R2 objects`);
            return state;
        }, 120_000);
        const removedObjectPath = path.join(privateDir, "removed-object.bin");
        const removedObject = await runWrangler(
            [
                "r2",
                "object",
                "get",
                `${names.bucket}/v1/${organizationA}/${replacement.fileId}`,
                "--remote",
                "--file",
                removedObjectPath,
            ],
            { cwd: app, label: "deleted organization object check", secrets, allowFailure: true }
        );
        check(removedObject.exitCode !== 0, "deleted organization object remains in R2");
        const survivorObjectPath = path.join(privateDir, "survivor-object.bin");
        await runWrangler(
            [
                "r2",
                "object",
                "get",
                `${names.bucket}/v1/${organizationB}/${survivor.fileId}`,
                "--remote",
                "--file",
                survivorObjectPath,
            ],
            { cwd: app, label: "survivor R2 check", secrets }
        );
        check(
            sha256(await readFile(survivorObjectPath)) === survivor.sha256,
            "survivor R2 object changed during A deletion"
        );
        for (const [index, tenant] of isolationTenants.entries()) {
            await authPost(origin, tenant.principal, "/organization/delete", {
                organizationId: tenant.organizationId,
            });
            await retry(async () => {
                const state = await proofState(origin, adminToken, runId, tenant.organizationId);
                check(state.count === 0, `isolation organization ${index} still has ${state.count} R2 objects`);
                return state;
            }, 120_000);
        }
        await setActive(origin, principal, organizationB);
        await authPost(origin, principal, "/organization/delete", { organizationId: organizationB });
        const finalState = await retry(async () => {
            const state = await proofState(origin, adminToken, runId, "");
            check(state.count === 0, `disposable bucket still has ${state.count} objects`);
            return state;
        }, 120_000);
        report.lifecycle = {
            uploadIdempotent: true,
            boundaryRejections: {
                crossOriginUploadStatus: crossOriginUpload.response.status,
                crossOriginDownloadStatus: crossOriginDownload.response.status,
                rangeDownloadStatus: rangeDownload.response.status,
                rowPolicyDeniedStatus: rowPolicyDenied.response.status,
                unsupportedTypeStatus: unsupportedType.response.status,
                oversizedUploadStatus: oversizedUpload.response.status,
            },
            safeDownloadHeaders: expectedDownloadHeaders,
            firstSha256: first.sha256,
            independentR2Sha256: first.sha256,
            replacementSha256: replacement.sha256,
            replacementCleanup: true,
            bulkObjects: bulk.length,
            attachedBulkObjects: 17,
            isolationBatch: {
                organizations: isolationTenants.length,
                uploads: isolationTenants.reduce((sum, tenant) => sum + tenant.uploads.length, 0),
                attached: isolationTenants.reduce((sum, tenant) => sum + tenant.uploads.length, 0),
                exactDownloads: isolationTenants.reduce((sum, tenant) => sum + tenant.uploads.length, 0),
                crossOrganizationDenials: isolationTenants.length,
                deletedOrganizations: isolationTenants.length,
            },
            deletedOrganizationState: deletedA,
            staleAccess: {
                uploadStatus: staleUpload.response.status,
                attachStatus: staleAttach.response.status,
                downloadStatus: staleDownload.response.status,
            },
            survivorSha256: survivor.sha256,
            finalState,
        };

        localRuntime = await startLocalFileProofRuntime({
            app,
            persistenceDir: path.join(privateDir, "local-miniflare"),
            secretsFile: secretsPath,
            wrangler,
            releaseSha256: candidateSha256,
        });
        const localMigrationId = `r2-local-${candidateSha256.slice(0, 10)}-${nonce}`;
        await runCommand(
            process.execPath,
            [
                cli,
                "migrate",
                "--url",
                localRuntime.origin,
                "--id",
                localMigrationId,
                "--target",
                "1",
                "--concurrency",
                "2",
            ],
            {
                cwd: app,
                env: { ...process.env, CHARDB_ADMIN_TOKEN: adminToken },
                label: "local Miniflare file benchmark migration",
                secrets,
            }
        );
        const localMigration = await migrationState(localRuntime.origin, adminToken);
        check(
            localMigration.status === "active" &&
                localMigration.activeVersion === 1 &&
                localMigration.activeEpoch === 2,
            "local Miniflare file benchmark migration did not activate schema version 1"
        );
        const benchmark = await runPairedFileBenchmark({
            tarball,
            output: path.join(output, "benchmarks"),
            localUrl: new URL(localRuntime.origin),
            cloudflareUrl: new URL(origin),
            localBucket: names.bucket,
            cloudflareBucket: names.bucket,
            cloudflareDeploymentVersion: second.id,
            wranglerVersion: WRANGLER_VERSION,
            compatibilityDate: "2026-05-10",
            adminToken,
            runId,
            onUpload: (targetKind, uploaded) =>
                targetKind === "cloudflare" ? recordObject(uploaded.organizationId, uploaded.fileId) : undefined,
        });
        benchmarkEvidence = benchmark.validation;
        const postBenchmarkState = await retry(async () => {
            const state = await proofState(origin, adminToken, runId, "");
            check(state.count === 0, `benchmark cleanup left ${state.count} objects in the disposable bucket`);
            return state;
        }, 120_000);
        check(
            postBenchmarkState.digest === finalState.digest,
            "benchmark cleanup did not restore the empty disposable bucket state"
        );
        proofSucceeded = true;
    } catch (error) {
        report.error = scrubSensitive(error instanceof Error ? error.message : error, secrets);
    } finally {
        let cleanupError = null;
        if (localRuntime) {
            try {
                await localRuntime.stop();
            } catch (error) {
                cleanupError = scrubSensitive(error instanceof Error ? error.message : error, secrets);
            }
        }
        try {
            const currentLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
            const commands = cleanupCommands(currentLedger, candidateSha256, options.accountId);
            if (currentLedger.bucketCreateIntent && (await exists(app))) {
                const purge = await request(origin, "/proof/r2-purge", {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${adminToken}`,
                        "content-type": "application/json",
                        "x-chardb-proof-run-id": runId,
                    },
                    body: JSON.stringify({ confirm: "PURGE_DISPOSABLE_BUCKET" }),
                }).catch(() => null);
                const purged = Boolean(purge?.response.ok);
                if (proofSucceeded) {
                    check(purged, "retained R2 recovery object cleanup failed");
                } else {
                    report.cleanup.fallbackPurge = purged;
                }
                if (!proofSucceeded && !purged) {
                    const objectCommands = exactObjectCleanupCommands(
                        currentLedger,
                        candidateSha256,
                        options.accountId
                    );
                    let failures = 0;
                    for (const command of objectCommands) {
                        const deleted = await runWrangler(command, {
                            cwd: app,
                            label: "owned exact R2 object cleanup",
                            secrets,
                            allowFailure: true,
                        });
                        if (deleted.exitCode !== 0) failures++;
                    }
                    report.cleanup.exactKeyDeletes = { attempted: objectCommands.length, failures };
                }
            }
            const commandResults = [];
            for (const command of commands) {
                commandResults.push(
                    await runWrangler(command, {
                        cwd: (await exists(app)) ? app : ROOT,
                        label: command[0] === "delete" ? "owned disposable Worker cleanup" : "owned R2 bucket cleanup",
                        secrets,
                        allowFailure: true,
                    })
                );
            }
            const cleanupCwd = (await exists(app)) ? app : ROOT;
            const workerCheck = await runWrangler(["versions", "list", "--name", names.worker, "--json"], {
                cwd: cleanupCwd,
                label: "owned disposable Worker deletion check",
                secrets,
                allowFailure: true,
            });
            report.cleanup.workerDeleted = remoteAbsenceConfirmed("worker", workerCheck).length === 0;
            const remainingBuckets = remoteAbsenceConfirmed(
                "bucket",
                await runWrangler(["r2", "bucket", "list"], {
                    cwd: cleanupCwd,
                    label: "owned disposable R2 bucket deletion check",
                    secrets,
                    allowFailure: true,
                })
            );
            report.cleanup.bucketDeleted = !remainingBuckets.some(bucket => bucket?.name === names.bucket);
            report.cleanup.deleteCommandsSucceeded = commandResults.every(result => result.exitCode === 0);
            check(
                report.cleanup.workerDeleted && report.cleanup.bucketDeleted,
                "disposable Cloudflare resource cleanup failed"
            );
        } catch (error) {
            cleanupError ??= scrubSensitive(error instanceof Error ? error.message : error, secrets);
        }
        if (cleanupError) report.cleanup.error = cleanupError;
        report.completedAt = new Date().toISOString();
        report.ok = proofSucceeded && !cleanupError && report.cleanup.fallbackPurge === false;
        const finalized = await finalizeFileProofEvidence(output, report, secrets, benchmarkEvidence);
        if (report.ok) {
            const correctness = await validateCloudflareFileProofEvidence({
                report: finalized.reportPath,
                candidate: tarball,
            });
            const benchmark = await validateFileBenchmarkEvidence(path.join(output, "benchmarks"), candidateSha256);
            check(
                benchmark.pairSha256 === benchmarkEvidence?.pairSha256,
                "retained benchmark evidence is not anchored by the correctness report"
            );
            await atomicJson(path.join(output, "r2-proof-validation.json"), {
                schema: "chardb.cloudflare-r2-proof.validation-bundle.v1",
                ok: true,
                correctness,
                benchmark,
            });
            await assertNoSensitiveEvidence(output, secrets);
        }
    }
    if (!report.ok) throw new Error(report.error ?? report.cleanup.error ?? "Cloudflare R2 proof failed");
}

if (import.meta.main) await main();
