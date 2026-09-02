import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
    CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION,
    assertCleanupOwnership,
    remoteAbsenceConfirmed,
    scrubSensitive,
} from "./run-cloudflare-file-proof.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const CONFIRMATION = "--confirm-disposable-resources";
const COMMAND_TIMEOUT_MS = 15 * 60_000;

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function value(argv, flag) {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
}

export function parseCloudflareFileProofRecoveryArgs(argv) {
    const valued = new Set([
        "--tarball",
        "--ledger",
        "--workers-dev-subdomain",
        "--account-id",
        "--cloudflare-api-token-file",
    ]);
    const flags = new Set([CONFIRMATION, "--help", "-h"]);
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        check(valued.has(argument) || flags.has(argument), `unknown R2 recovery argument ${JSON.stringify(argument)}`);
        check(!seen.has(argument), `duplicate R2 recovery argument ${argument}`);
        seen.add(argument);
        if (valued.has(argument)) {
            const item = argv[++index];
            check(
                typeof item === "string" && item.length > 0 && !item.startsWith("--"),
                `${argument} requires a value`
            );
        }
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const input = {
        help,
        tarball: value(argv, "--tarball"),
        ledger: value(argv, "--ledger"),
        workersDevSubdomain: value(argv, "--workers-dev-subdomain"),
        accountId: value(argv, "--account-id")?.toLowerCase(),
        cloudflareApiTokenFile: value(argv, "--cloudflare-api-token-file"),
        confirmed: argv.includes(CONFIRMATION),
    };
    if (!help) {
        for (const [flag, item] of [
            ["--tarball", input.tarball],
            ["--ledger", input.ledger],
            ["--workers-dev-subdomain", input.workersDevSubdomain],
            ["--account-id", input.accountId],
        ]) {
            check(item, `${flag} is required`);
        }
        check(input.confirmed, `${CONFIRMATION} is required`);
        check(ACCOUNT_ID.test(input.accountId), "--account-id must be exactly 32 hexadecimal characters");
        check(
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.workersDevSubdomain),
            "--workers-dev-subdomain must be one lowercase Cloudflare subdomain label"
        );
    }
    return Object.freeze(input);
}

async function privateRegularFile(file, label, requiredMode = undefined) {
    const absolute = path.resolve(file);
    const metadata = await lstat(absolute);
    check(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file, not a symlink`);
    if (requiredMode !== undefined) {
        check((metadata.mode & 0o777) === requiredMode, `${label} must have mode 0${requiredMode.toString(8)}`);
    }
    return absolute;
}

async function readToken(file) {
    if (file === undefined) return undefined;
    const absolute = await privateRegularFile(file, "Cloudflare API token file");
    const raw = await readFile(absolute, "utf8");
    const token = raw.trim();
    check(
        (raw === token || raw === `${token}\n`) && token.length >= 16 && token.length <= 4_096 && !/\s/u.test(token),
        "Cloudflare API token file is invalid"
    );
    return token;
}

function cloudflareEnvironment(accountId, token, logPath) {
    const environment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_LOG_PATH: logPath };
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
    if (token !== undefined) environment.CLOUDFLARE_API_TOKEN = token;
    return environment;
}

export function assertRecoveryAccount(value, expectedAccountId) {
    check(value && typeof value === "object" && !Array.isArray(value), "Wrangler account evidence must be an object");
    check(value.loggedIn === true && Array.isArray(value.accounts), "Wrangler is not authenticated for recovery");
    const ids = value.accounts.map(account => account?.id);
    check(
        ids.length > 0 &&
            ids.length <= 100 &&
            ids.every(id => typeof id === "string" && ACCOUNT_ID.test(id)) &&
            new Set(ids).size === ids.length,
        "Wrangler returned malformed account ownership evidence"
    );
    check(ids.includes(expectedAccountId), "Wrangler credentials do not own the requested Cloudflare account");
    return Object.freeze({ accountIdSha256: sha256(expectedAccountId), matched: true });
}

export function parseRecoverySecrets(source, expectedRunId) {
    check(typeof source === "string" && source.endsWith("\n"), "R2 recovery secrets file is malformed");
    const values = new Map();
    for (const line of source.slice(0, -1).split("\n")) {
        const separator = line.indexOf("=");
        check(separator > 0, "R2 recovery secrets file is malformed");
        const key = line.slice(0, separator);
        const item = line.slice(separator + 1);
        check(
            ["BETTER_AUTH_SECRET", "CDB_ADMIN_TOKEN", "CDB_PROOF_RUN_ID"].includes(key) &&
                !values.has(key) &&
                item.length >= 16 &&
                item.length <= 4_096 &&
                !/\s/u.test(item),
            "R2 recovery secrets file is malformed"
        );
        values.set(key, item);
    }
    check(values.size === 3, "R2 recovery secrets file is malformed");
    check(values.get("CDB_PROOF_RUN_ID") === expectedRunId, "R2 recovery run ID drifted from the ownership ledger");
    return Object.freeze({
        adminToken: values.get("CDB_ADMIN_TOKEN"),
        runId: values.get("CDB_PROOF_RUN_ID"),
        secretValues: Object.freeze([...values.values()]),
    });
}

function parseJson(result, label) {
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`${label} returned invalid JSON`);
    }
}

async function spawnWrangler(executable, args, options) {
    const child = Bun.spawn([process.execPath, executable, ...args], {
        cwd: options.cwd,
        env: options.environment,
        stdout: "pipe",
        stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]).finally(() => clearTimeout(timer));
    return Object.freeze({ exitCode, stdout, stderr });
}

async function requestJson(fetchImpl, origin, pathname, init = {}) {
    const response = await fetchImpl(new URL(pathname, origin), {
        ...init,
        signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = null;
    }
    return Object.freeze({ response, body });
}

async function waitForHealth(fetchImpl, origin, candidateSha256, sleep) {
    let last;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const result = await requestJson(fetchImpl, origin, "/health");
            if (
                result.response.ok &&
                result.body?.ok === true &&
                result.body.releaseSha256 === candidateSha256 &&
                result.body.proofConfigured === true
            ) {
                return result.body;
            }
            last = new Error("recovery Worker health did not match the owned candidate");
        } catch (error) {
            last = error;
        }
        await sleep(500);
    }
    throw last ?? new Error("recovery Worker health timed out");
}

function recoveryState(value, label) {
    check(
        value &&
            Number.isSafeInteger(value.count) &&
            value.count >= 0 &&
            Number.isSafeInteger(value.bytes) &&
            value.bytes >= 0 &&
            /^[a-f0-9]{64}$/.test(value.digest ?? ""),
        `${label} returned malformed authoritative R2 state`
    );
    return value;
}

export async function recoverCloudflareFileProof(input, dependencies = {}) {
    check(input?.confirmed === true, `${CONFIRMATION} is required`);
    check(ACCOUNT_ID.test(input.accountId ?? ""), "R2 recovery account ID is invalid");
    const ledgerPath = await privateRegularFile(input.ledger, "R2 recovery ownership ledger", 0o600);
    const privateDir = path.dirname(ledgerPath);
    const privateMetadata = await lstat(privateDir);
    check(
        privateMetadata.isDirectory() && !privateMetadata.isSymbolicLink() && (privateMetadata.mode & 0o077) === 0,
        "R2 recovery private directory must not be accessible by group or other users"
    );
    const canonicalPrivate = await realpath(privateDir);
    const tarballPath = await privateRegularFile(input.tarball, "R2 recovery candidate tarball");
    const candidateBytes = await readFile(tarballPath);
    const candidateSha256 = sha256(candidateBytes);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const names = assertCleanupOwnership(ledger, candidateSha256, input.accountId);
    check(
        ledger.workerCreateIntent || ledger.bucketCreateIntent,
        "R2 recovery ledger records no disposable resource creation intent"
    );
    const token = await readToken(input.cloudflareApiTokenFile);
    const secrets = token === undefined ? [] : [token];
    const environment = cloudflareEnvironment(
        input.accountId,
        token,
        path.join(canonicalPrivate, "recovery-wrangler.log")
    );
    const app = path.join(canonicalPrivate, "app");
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const sleep = dependencies.sleep ?? Bun.sleep;
    let wrangler;
    let wranglerCwd = ROOT;
    let runWrangler = dependencies.runWrangler;
    if (!runWrangler) {
        const rootWrangler = createRequire(path.join(ROOT, "package.json")).resolve("wrangler");
        wrangler = rootWrangler;
        try {
            const appMetadata = await lstat(app);
            if (appMetadata.isDirectory() && !appMetadata.isSymbolicLink()) {
                wrangler = createRequire(path.join(app, "package.json")).resolve("wrangler");
                wranglerCwd = app;
            }
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        runWrangler = args => spawnWrangler(wrangler, args, { cwd: wranglerCwd, environment });
    }
    const run = async (args, label, allowFailure = false) => {
        const result = await runWrangler(args, { cwd: app, environment, label, secrets });
        check(
            result &&
                Number.isInteger(result.exitCode) &&
                typeof result.stdout === "string" &&
                typeof result.stderr === "string",
            `${label} returned an invalid command result`
        );
        if (result.exitCode !== 0 && !allowFailure) {
            throw new Error(`${label} failed with exit ${result.exitCode}`);
        }
        return result;
    };

    const whoami = parseJson(
        await run(["whoami", "--json"], "Wrangler account ownership preflight"),
        "Wrangler whoami"
    );
    const account = assertRecoveryAccount(whoami, input.accountId);
    const listBuckets = async () =>
        remoteAbsenceConfirmed("bucket", await run(["r2", "bucket", "list"], "R2 recovery bucket list", true));
    const listWorkerVersions = async () =>
        remoteAbsenceConfirmed(
            "worker",
            await run(["versions", "list", "--name", names.worker, "--json"], "R2 recovery Worker list", true)
        );
    let bucketPresent = (await listBuckets()).some(bucket => bucket?.name === names.bucket);
    let workerPresent = (await listWorkerVersions()).length > 0;
    check(!bucketPresent || ledger.bucketCreateIntent, "derived R2 bucket exists without an owned creation intent");
    check(!workerPresent || ledger.workerCreateIntent, "derived Worker exists without an owned creation intent");
    const origin = `https://${names.worker}.${input.workersDevSubdomain}.workers.dev`;
    let workerRecovered = false;
    let discoveredObjects = 0;
    let purgedObjects = 0;

    const secretsPath = path.join(canonicalPrivate, "secrets.env");
    let proofSecrets;
    const loadProofSecrets = async () => {
        if (proofSecrets) return proofSecrets;
        const exact = await privateRegularFile(secretsPath, "R2 recovery secrets file", 0o600);
        proofSecrets = parseRecoverySecrets(await readFile(exact, "utf8"), ledger.runId);
        return proofSecrets;
    };
    const verifyWorker = async () => waitForHealth(fetchImpl, origin, candidateSha256, sleep);
    const deployRecoveryWorker = async () => {
        check(ledger.workerCreateIntent, "R2 recovery cannot recreate a Worker without owned creation intent");
        const appMetadata = await lstat(app);
        check(appMetadata.isDirectory() && !appMetadata.isSymbolicLink(), "R2 recovery app directory is missing");
        const appCandidate = await privateRegularFile(path.join(app, "chardb-proof.tgz"), "R2 recovery app candidate");
        check(sha256(await readFile(appCandidate)) === candidateSha256, "R2 recovery app candidate drifted");
        await loadProofSecrets();
        await run(
            [
                "deploy",
                "--name",
                names.worker,
                "--strict",
                "--secrets-file",
                secretsPath,
                "--tag",
                `${ledger.nonce}-recovery`,
                "--message",
                "CharDB disposable R2 proof recovery",
            ],
            "R2 recovery Worker deploy"
        );
        await verifyWorker();
        workerPresent = true;
        workerRecovered = true;
    };

    if (workerPresent) await verifyWorker();
    if (bucketPresent && !workerPresent && ledger.workerCreateIntent) await deployRecoveryWorker();
    if (bucketPresent && workerPresent) {
        const ownedSecrets = await loadProofSecrets();
        const headers = {
            authorization: `Bearer ${ownedSecrets.adminToken}`,
            "x-chardb-proof-run-id": ownedSecrets.runId,
        };
        const before = await requestJson(fetchImpl, origin, "/proof/r2-state", { headers });
        check(before.response.ok, "R2 recovery authoritative bucket listing failed");
        const beforeState = recoveryState(before.body, "R2 recovery listing");
        discoveredObjects = beforeState.count;
        if (beforeState.count > 0) {
            const purged = await requestJson(fetchImpl, origin, "/proof/r2-purge", {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ confirm: "PURGE_DISPOSABLE_BUCKET" }),
            });
            check(purged.response.ok && Number.isSafeInteger(purged.body?.deleted), "R2 recovery purge failed");
            purgedObjects = purged.body.deleted;
        }
        const after = await requestJson(fetchImpl, origin, "/proof/r2-state", { headers });
        check(
            after.response.ok && recoveryState(after.body, "R2 recovery post-purge listing").count === 0,
            "R2 recovery did not empty the authoritative bucket listing"
        );
    }

    if (workerPresent) {
        await run(["delete", names.worker, "--force"], "R2 recovery Worker delete", true);
        workerPresent = (await listWorkerVersions()).length > 0;
        check(!workerPresent, "R2 recovery could not verify Worker absence");
    }
    if (bucketPresent) {
        await run(["r2", "bucket", "delete", names.bucket], "R2 recovery bucket delete", true);
        bucketPresent = (await listBuckets()).some(bucket => bucket?.name === names.bucket);
        check(!bucketPresent, "R2 recovery could not verify bucket absence");
    }
    return Object.freeze({
        schema: "chardb.cloudflare-r2-proof.recovery.v1",
        ok: true,
        candidate: Object.freeze({ algorithm: "sha256", digest: candidateSha256, bytes: candidateBytes.byteLength }),
        account,
        target: Object.freeze({ worker: names.worker, bucket: names.bucket }),
        reconciliation: Object.freeze({ workerRecovered, discoveredObjects, purgedObjects }),
        absence: Object.freeze({ worker: true, bucket: true }),
        wranglerVersion: CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION,
    });
}

export function cloudflareFileProofRecoveryUsage() {
    return [
        "Usage: bun scripts/recover-cloudflare-file-proof.mjs [options]",
        "",
        "  --tarball <file>                  exact candidate tarball recorded by the ownership ledger",
        "  --ledger <ownership.json>         retained mode-0600 standalone R2 proof ledger",
        "  --workers-dev-subdomain <label>   account workers.dev subdomain",
        "  --account-id <32-hex-id>          exact Cloudflare account to mutate",
        "  --cloudflare-api-token-file <file> optional private API token file",
        `  ${CONFIRMATION}    authorize deletion of the exact ledger-owned resources`,
    ].join("\n");
}

export async function runCloudflareFileProofRecoveryCli(argv, io = process, dependencies = {}) {
    let token;
    try {
        const input = parseCloudflareFileProofRecoveryArgs(argv);
        if (input.help) {
            io.stdout.write(`${cloudflareFileProofRecoveryUsage()}\n`);
            return 0;
        }
        if (input.cloudflareApiTokenFile) token = await readToken(input.cloudflareApiTokenFile);
        const result = await recoverCloudflareFileProof(input, dependencies);
        io.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    } catch (error) {
        const message = scrubSensitive(error instanceof Error ? error.message : error, token ? [token] : []);
        io.stderr.write(`Cloudflare R2 proof recovery failed: ${message}\n`);
        return 1;
    }
}

if (import.meta.main) process.exitCode = await runCloudflareFileProofRecoveryCli(process.argv.slice(2));
