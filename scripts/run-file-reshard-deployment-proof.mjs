import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileReshardBenchmarkProfile } from "./file-reshard-benchmark-report.mjs";
import {
    FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA,
    FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA,
    assertFileReshardDeploymentCapabilities,
    assertFileReshardDeploymentFault,
    assertFileReshardDeploymentPair,
    assertFileReshardDeploymentSample,
    compareFileReshardDeploymentSamples,
} from "./file-reshard-deployment-proof.mjs";
import { validatePreparedFileReshardProof } from "./prepare-file-reshard-deployment-proof.mjs";

const DISPOSABLE_PREFIX = "chardb-file-reshard-proof-";
const COMMAND_TIMEOUT_MS = 60_000;
const CLOUDFLARE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const FILE_RESHARD_VECTOR_DIMENSIONS = 32;
const FILE_RESHARD_PROOF_CHECKPOINTS = new Set([
    "authorization",
    "download-verify",
    "fault-receipt",
    "file-alarm",
    "file-seed",
    "migration-finish",
    "migration-setup",
    "migration-start",
    "organization-delete",
    "organization-seed",
    "post-move-inventory",
    "pre-move-inventory",
    "receipt-claim",
    "receipt-complete",
    "request-parse",
    "retry-receipt",
    "snapshot-commit",
    "source-fence",
    "vector-search",
    "vector-settlement",
    "vector-verify",
]);

function value(argv, flag) {
    const positions = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (positions.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (positions.length === 0) return undefined;
    const result = argv[positions[0] + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

function origin(raw, flag, deployed) {
    const parsed = new URL(raw);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw new Error(`${flag} must be an origin without path, credentials, query, or fragment`);
    }
    if ((deployed && parsed.protocol !== "https:") || (!deployed && !["http:", "https:"].includes(parsed.protocol))) {
        throw new Error(`${flag} uses an invalid protocol`);
    }
    return parsed.origin;
}

function assertDisposableNames(worker, bucket, index, label) {
    if (
        typeof worker !== "string" ||
        worker !== bucket ||
        !worker.startsWith(DISPOSABLE_PREFIX) ||
        !CLOUDFLARE_NAME.test(worker) ||
        typeof index !== "string" ||
        index !== worker ||
        !CLOUDFLARE_NAME.test(index)
    ) {
        throw new Error(`${label} requires one identical disposable Worker, bucket, and Vectorize index name`);
    }
}

export function parseFileReshardDeploymentProofArgs(argv) {
    const valueFlags = new Set([
        "--package",
        "--preparation",
        "--output",
        "--wrangler",
        "--local-url",
        "--deployed-url",
        "--local-token-file",
        "--deployed-token-file",
        "--cloudflare-api-token-file",
        "--cloudflare-account-id",
        "--worker",
        "--bucket",
        "--vectorize-index",
        "--deployment-version",
        "--configuration-sha256",
        "--run-id",
        "--profile",
    ]);
    const allowed = new Set([...valueFlags, "--confirm-disposable-target", "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument)) throw new Error(`unknown deployment proof argument ${JSON.stringify(argument)}`);
        if (valueFlags.has(argument)) index++;
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const options = {
        help,
        confirmed: argv.includes("--confirm-disposable-target"),
        package: value(argv, "--package"),
        preparation: value(argv, "--preparation"),
        output: value(argv, "--output"),
        wrangler: value(argv, "--wrangler"),
        localUrl: value(argv, "--local-url"),
        deployedUrl: value(argv, "--deployed-url"),
        localTokenFile: value(argv, "--local-token-file"),
        deployedTokenFile: value(argv, "--deployed-token-file"),
        cloudflareApiTokenFile: value(argv, "--cloudflare-api-token-file"),
        cloudflareAccountId: value(argv, "--cloudflare-account-id"),
        worker: value(argv, "--worker"),
        bucket: value(argv, "--bucket"),
        vectorizeIndex: value(argv, "--vectorize-index"),
        deploymentVersion: value(argv, "--deployment-version"),
        configurationSha256: value(argv, "--configuration-sha256"),
        runId: value(argv, "--run-id"),
        profileName: value(argv, "--profile") ?? "small",
    };
    fileReshardBenchmarkProfile(options.profileName);
    if (help) return options;
    for (const [flag, item] of [
        ["--package", options.package],
        ["--preparation", options.preparation],
        ["--output", options.output],
        ["--wrangler", options.wrangler],
        ["--local-url", options.localUrl],
        ["--deployed-url", options.deployedUrl],
        ["--local-token-file", options.localTokenFile],
        ["--deployed-token-file", options.deployedTokenFile],
        ["--cloudflare-account-id", options.cloudflareAccountId],
        ["--worker", options.worker],
        ["--bucket", options.bucket],
        ["--vectorize-index", options.vectorizeIndex],
        ["--deployment-version", options.deploymentVersion],
        ["--configuration-sha256", options.configurationSha256],
        ["--run-id", options.runId],
    ]) {
        if (!item) throw new Error(`${flag} is required`);
    }
    if (!options.confirmed) throw new Error("--confirm-disposable-target is required");
    assertDisposableNames(options.worker, options.bucket, options.vectorizeIndex, "deployment proof");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.deploymentVersion)) {
        throw new Error("--deployment-version is invalid");
    }
    if (!SHA256.test(options.configurationSha256)) throw new Error("--configuration-sha256 is invalid");
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(options.runId)) throw new Error("--run-id is invalid");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.cloudflareAccountId)) {
        throw new Error("--cloudflare-account-id is invalid");
    }
    options.localUrl = origin(options.localUrl, "--local-url", false);
    options.deployedUrl = origin(options.deployedUrl, "--deployed-url", true);
    if (options.localUrl === options.deployedUrl) throw new Error("local and deployed targets must be distinct");
    for (const field of ["package", "preparation", "output", "wrangler", "localTokenFile", "deployedTokenFile"]) {
        options[field] = path.resolve(options[field]);
    }
    if (options.cloudflareApiTokenFile) {
        options.cloudflareApiTokenFile = path.resolve(options.cloudflareApiTokenFile);
    }
    return options;
}

export function wranglerDeploymentInspectionCommands(worker, bucket, index) {
    assertDisposableNames(worker, bucket, index, "deployment inspection");
    return Object.freeze([
        Object.freeze(["versions", "list", "--name", worker, "--json"]),
        Object.freeze(["deployments", "status", "--name", worker, "--json"]),
        Object.freeze(["r2", "bucket", "info", bucket, "--json"]),
        Object.freeze(["vectorize", "get", index, "--json"]),
    ]);
}

export function wranglerDisposableDeploymentCommands(input) {
    assertDisposableNames(input.worker, input.bucket, input.index, "deployment commands");
    for (const field of ["config", "secretsFile", "tag"]) {
        if (typeof input[field] !== "string" || input[field].length === 0) throw new Error(`${field} is required`);
    }
    return Object.freeze([
        Object.freeze(["r2", "bucket", "create", input.bucket]),
        Object.freeze([
            "vectorize",
            "create",
            input.index,
            "--dimensions",
            String(FILE_RESHARD_VECTOR_DIMENSIONS),
            "--metric",
            "cosine",
            "--description",
            "CharDB disposable cross-resource movement proof",
            "--json",
        ]),
        Object.freeze([
            "vectorize",
            "create-metadata-index",
            input.index,
            "--propertyName",
            "cdb_resource",
            "--type",
            "string",
        ]),
        Object.freeze([
            "deploy",
            "--config",
            input.config,
            "--name",
            input.worker,
            "--strict",
            "--secrets-file",
            input.secretsFile,
            "--tag",
            input.tag,
            "--message",
            "CharDB disposable file reshard proof",
        ]),
    ]);
}

export function wranglerDisposableCleanupCommands(worker, bucket, index) {
    assertDisposableNames(worker, bucket, index, "cleanup");
    return Object.freeze([
        Object.freeze(["delete", worker, "--force"]),
        Object.freeze(["r2", "bucket", "delete", bucket]),
        Object.freeze(["vectorize", "delete", index, "--force"]),
    ]);
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function readSecret(file, label) {
    const raw = await readFile(file, "utf8");
    const secret = raw.trim();
    if (raw !== secret && raw !== `${secret}\n`) throw new Error(`${label} contains unexpected whitespace`);
    if (secret.length < 16 || secret.length > 4_096 || /\s/.test(secret)) throw new Error(`${label} is invalid`);
    return secret;
}

async function defaultRunCommand(command, args, options) {
    const child = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: options.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), COMMAND_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]).finally(() => clearTimeout(timer));
    if (exitCode !== 0) throw new Error(`Wrangler deployment inspection failed with exit ${exitCode}`);
    return { stdout, stderr, exitCode };
}

function parseJson(text, label) {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label} returned invalid JSON`);
    }
}

export async function inspectDisposableDeployment(input) {
    const runCommand = input.runCommand ?? defaultRunCommand;
    const outputs = [];
    const env = {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: input.accountId,
    };
    for (const key of [
        "CLOUDFLARE_API_TOKEN",
        "CF_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CF_API_KEY",
        "CF_ACCOUNT_ID",
    ]) {
        Reflect.deleteProperty(env, key);
    }
    if (input.apiToken !== undefined) env.CLOUDFLARE_API_TOKEN = input.apiToken;
    for (const args of wranglerDeploymentInspectionCommands(input.worker, input.bucket, input.index)) {
        outputs.push(
            await runCommand(input.wrangler, args, {
                cwd: input.app,
                env,
            })
        );
    }
    const versions = parseJson(outputs[0].stdout, "Wrangler version inspection");
    if (!Array.isArray(versions) || !versions.some(item => String(item?.id ?? item?.number) === input.version)) {
        throw new Error("expected deployed Worker version was not found");
    }
    const deployment = parseJson(outputs[1].stdout, "Wrangler deployment inspection");
    if (
        !Array.isArray(deployment?.versions) ||
        deployment.versions.length !== 1 ||
        deployment.versions[0]?.percentage !== 100 ||
        String(deployment.versions[0]?.version_id) !== input.version
    ) {
        throw new Error("expected Worker version does not have 100% traffic");
    }
    const bucket = parseJson(outputs[2].stdout, "Wrangler R2 bucket inspection");
    if (bucket?.name !== input.bucket) throw new Error("Wrangler did not confirm the expected R2 bucket");
    const index = parseJson(outputs[3].stdout, "Wrangler Vectorize index inspection");
    if (index?.name !== input.index) throw new Error("Wrangler did not confirm the expected Vectorize index");
    return { version: input.version, percentage: 100, bucket: input.bucket, index: input.index };
}

async function requestJson(fetchImpl, target, pathname, init = {}) {
    const response = await fetchImpl(new URL(pathname, target.origin), {
        ...init,
        headers: {
            authorization: `Bearer ${target.token}`,
            "x-chardb-proof-run-id": target.runId,
            ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(8 * 60_000),
    });
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`${target.kind} proof endpoint returned non-JSON status ${response.status}`);
    }
    return { response, body };
}

function safeResponseCode(body) {
    const code = body && typeof body === "object" && !Array.isArray(body) ? body.code : undefined;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "unclassified";
}

function safeResponseCheckpoint(body) {
    const checkpoint = body && typeof body === "object" && !Array.isArray(body) ? body.checkpoint : undefined;
    return typeof checkpoint === "string" && FILE_RESHARD_PROOF_CHECKPOINTS.has(checkpoint)
        ? checkpoint
        : "unclassified";
}

export function fileReshardDeploymentRunKey(runId, sequence) {
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(runId)) throw new Error("deployment proof run ID is invalid");
    if (!Number.isSafeInteger(sequence) || sequence < -1) throw new Error("deployment proof sequence is invalid");
    return `${runId}_${sequence < 0 ? "warmup" : sequence}`;
}

export async function requestFileReshardDeploymentSample(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const runKey = fileReshardDeploymentRunKey(input.runId, input.sequence);
    const request = {
        runId: input.runId,
        runKey,
        sequence: input.sequence,
        excluded: input.sequence === -1,
        candidateSha256: input.candidateSha256,
        profile: fileReshardBenchmarkProfile(input.profileName),
        fault: { operation: "apply_snapshot", mode: "commit-then-response-loss-once" },
    };
    const target = { kind: input.kind, origin: input.origin, token: input.token, runId: input.runId };
    const first = await requestJson(fetchImpl, target, "/proof/file-reshard/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-chardb-proof-inject": request.fault.mode },
        body: JSON.stringify(request),
    });
    if (first.response.status !== 503) {
        throw new Error(
            `${input.kind} proof did not lose the committed response exactly once ` +
                `(status ${first.response.status}, code ${safeResponseCode(first.body)}, ` +
                `checkpoint ${safeResponseCheckpoint(first.body)})`
        );
    }
    assertFileReshardDeploymentFault(first.body, { runKey, operation: request.fault.operation });
    const retried = await requestJson(fetchImpl, target, "/proof/file-reshard/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
    });
    if (!retried.response.ok) {
        throw new Error(
            `${input.kind} proof retry failed with ${retried.response.status} ` +
                `(code ${safeResponseCode(retried.body)}, checkpoint ${safeResponseCheckpoint(retried.body)})`
        );
    }
    return assertFileReshardDeploymentSample(retried.body, {
        sequence: input.sequence,
        runKey,
        profile: input.profileName,
        kind: input.kind,
        candidateSha256: input.candidateSha256,
    });
}

async function writeJsonAtomic(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
}

export async function runFileReshardDeploymentProof(options) {
    if (options.confirmed !== true) throw new Error("disposable deployment proof confirmation is required");
    assertDisposableNames(options.worker, options.bucket, options.vectorizeIndex, "deployment proof");
    const localUrl = origin(options.localUrl, "local proof URL", false);
    const deployedUrl = origin(options.deployedUrl, "deployed proof URL", true);
    if (localUrl === deployedUrl) throw new Error("local and deployed targets must be distinct");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.deploymentVersion)) {
        throw new Error("deployment proof version is invalid");
    }
    if (!SHA256.test(options.configurationSha256)) throw new Error("deployment proof configuration digest is invalid");
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(options.runId)) throw new Error("deployment proof run ID is invalid");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.cloudflareAccountId)) {
        throw new Error("deployment proof account ID is invalid");
    }
    const prepared = await (options.validatePreparation ?? validatePreparedFileReshardProof)({
        package: options.package,
        preparation: options.preparation,
    });
    const candidateBytes = await readFile(options.package);
    if (candidateBytes.byteLength < 1) throw new Error("candidate tarball is empty");
    const candidateSha256 = sha256(candidateBytes);
    if (
        prepared.candidate?.digest !== candidateSha256 ||
        prepared.candidate?.bytes !== candidateBytes.byteLength ||
        prepared.receipt?.target?.worker !== options.worker ||
        prepared.receipt?.target?.bucket !== options.bucket ||
        prepared.receipt?.target?.vectorizeIndex !== options.vectorizeIndex ||
        prepared.receipt?.runId !== options.runId ||
        prepared.receipt?.configurationSha256 !== options.configurationSha256
    ) {
        throw new Error("prepared proof identity drifted from the requested execution");
    }
    const [localToken, deployedToken, apiToken] = await Promise.all([
        readSecret(options.localTokenFile, "local proof token"),
        readSecret(options.deployedTokenFile, "deployed proof token"),
        options.cloudflareApiTokenFile
            ? readSecret(options.cloudflareApiTokenFile, "Cloudflare API token")
            : Promise.resolve(undefined),
    ]);
    await mkdir(options.output);
    await writeJsonAtomic(path.join(options.output, "preparation.json"), prepared.receipt);
    const inspection = {
        wrangler: options.wrangler,
        app: prepared.app,
        worker: options.worker,
        bucket: options.bucket,
        index: options.vectorizeIndex,
        version: options.deploymentVersion,
        accountId: options.cloudflareAccountId,
        runCommand: options.runCommand,
    };
    if (apiToken !== undefined) inspection.apiToken = apiToken;
    const inspected = await (options.inspectDeployment ?? inspectDisposableDeployment)(inspection);
    if (
        inspected?.version !== options.deploymentVersion ||
        inspected?.percentage !== 100 ||
        inspected?.bucket !== options.bucket ||
        inspected?.index !== options.vectorizeIndex
    ) {
        throw new Error("deployment inspection receipt drifted from the requested target");
    }
    const deploymentInspection = {
        version: inspected.version,
        percentage: inspected.percentage,
        bucket: inspected.bucket,
        index: inspected.index,
    };
    await writeJsonAtomic(path.join(options.output, "deployment-inspection.json"), deploymentInspection);
    const targets = {
        local: { kind: "local", origin: localUrl, token: localToken, runId: options.runId },
        deployed: { kind: "deployed", origin: deployedUrl, token: deployedToken, runId: options.runId },
    };
    for (const kind of ["local", "deployed"]) {
        const capabilities = await requestJson(
            options.fetchImpl ?? fetch,
            targets[kind],
            "/proof/file-reshard/capabilities"
        );
        if (!capabilities.response.ok)
            throw new Error(`${kind} capabilities failed with ${capabilities.response.status}`);
        const validatedCapabilities = assertFileReshardDeploymentCapabilities(capabilities.body, {
            releaseSha256: candidateSha256,
            runId: options.runId,
            kind,
            configurationSha256: options.configurationSha256,
        });
        await writeJsonAtomic(path.join(options.output, `capabilities-${kind}.json`), validatedCapabilities);
        if (kind === "deployed") {
            if (
                validatedCapabilities.target.deploymentVersion !== options.deploymentVersion ||
                validatedCapabilities.target.r2Bucket !== options.bucket ||
                validatedCapabilities.target.vectorizeIndex !== options.vectorizeIndex
            ) {
                throw new Error("deployed capability identity drifted from Wrangler inspection");
            }
        }
    }
    const profile = fileReshardBenchmarkProfile(options.profileName ?? "small");
    const startedAt = new Date().toISOString();
    const plan = [-1, ...Array.from({ length: profile.logicalRuns }, (_, sequence) => sequence)];
    const order = plan.map((sequence, index) => ({
        sequence,
        targets: index % 2 === 0 ? ["local", "deployed"] : ["deployed", "local"],
    }));
    const samples = { local: [], deployed: [] };
    const warmup = {};
    const runs = Array.from({ length: profile.logicalRuns }, (_, sequence) => ({ sequence }));
    const raw = path.join(options.output, "raw-v1");
    await mkdir(raw);
    for (const step of order) {
        for (const kind of step.targets) {
            const sample = await requestFileReshardDeploymentSample({
                ...targets[kind],
                kind,
                sequence: step.sequence,
                candidateSha256,
                profileName: profile.name,
                fetchImpl: options.fetchImpl,
            });
            await writeJsonAtomic(
                path.join(raw, `${kind}-${step.sequence < 0 ? "warmup" : step.sequence}.json`),
                sample
            );
            if (step.sequence < 0) warmup[kind] = sample;
            else {
                runs[step.sequence][kind] = sample;
                samples[kind].push(sample);
            }
        }
    }
    const pair = assertFileReshardDeploymentPair({
        schema: FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA,
        ok: true,
        candidate: { sha256: candidateSha256, bytes: candidateBytes.byteLength },
        profile,
        execution: { startedAt, completedAt: new Date().toISOString(), order },
        deployment: {
            worker: options.worker,
            bucket: options.bucket,
            vectorizeIndex: options.vectorizeIndex,
            version: options.deploymentVersion,
            accountIdSha256: sha256(options.cloudflareAccountId),
        },
        warmup,
        runs,
        comparison: compareFileReshardDeploymentSamples(samples.local, samples.deployed, profile.name),
    });
    await writeJsonAtomic(path.join(options.output, "paired.json"), pair);
    const manifest = [];
    for (const relative of [
        "paired.json",
        "preparation.json",
        "deployment-inspection.json",
        "capabilities-local.json",
        "capabilities-deployed.json",
        ...order.flatMap(step =>
            step.targets.map(kind => `raw-v1/${kind}-${step.sequence < 0 ? "warmup" : step.sequence}.json`)
        ),
    ]) {
        manifest.push(`${sha256(await readFile(path.join(options.output, relative)))}  ${relative}`);
    }
    await writeFile(path.join(options.output, "evidence.sha256"), `${manifest.join("\n")}\n`);
    return pair;
}

function usage() {
    return [
        "Usage: bun scripts/run-file-reshard-deployment-proof.mjs [options]",
        "",
        "This command verifies an already-provisioned disposable proof Worker. It does not deploy.",
        "All target, proof-token, Wrangler, package, preparation, version, account, and output options are required.",
        "Cloudflare authentication defaults to Wrangler's stored OAuth; --cloudflare-api-token-file overrides it.",
        "Pass --confirm-disposable-target to acknowledge the isolated Worker, R2 bucket, and Vectorize index.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseFileReshardDeploymentProofArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else console.log(JSON.stringify((await runFileReshardDeploymentProof(options)).comparison, null, 2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
