import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    assertCloudflareVectorizeProofCandidateBridge,
    assertCloudflareVectorizeProofPackageLock,
    fingerprintCloudflareVectorizeDeployment,
    renderCloudflareVectorizeProofPackage,
    validateCloudflareVectorizeProofApp,
} from "./cloudflare-vectorize-proof-orchestrator.mjs";
import { fingerprintVectorizeProofCandidate } from "./run-cloudflare-vectorize-proof.mjs";

export const FILE_RESHARD_PROOF_PREPARATION_SCHEMA = "chardb.file-vector-reshard-proof.preparation.v1";
export const FILE_RESHARD_PROOF_PREPARATION_EVIDENCE_SCHEMA =
    "chardb.file-vector-reshard-proof.preparation-evidence.v1";
export const FILE_RESHARD_PROOF_DEPLOYMENT_FILES = Object.freeze(
    [
        "chardb-proof.tgz",
        "package-lock.json",
        "package.json",
        "src/api.ts",
        "src/auth.ts",
        "src/migrations.ts",
        "src/proof-config.ts",
        "src/schema.ts",
        "src/vector-proof.ts",
        "src/worker.ts",
        "tsconfig.json",
        "wrangler.toml",
    ].sort()
);

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_FIXTURE = path.join(ROOT, "test", "fixtures", "cloudflare-file-reshard-proof");
const FIXTURE_FILES = FILE_RESHARD_PROOF_DEPLOYMENT_FILES.filter(
    file => !["chardb-proof.tgz", "package-lock.json", "package.json", "wrangler.toml"].includes(file)
);
const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{16}$/;
const RUN_ID = /^[A-Za-z0-9_-]{16,80}$/;
const TARGET = /^chardb-file-reshard-proof-[a-f0-9]{10}-[a-f0-9]{16}$/;
const VALIDATION_PHASES = Object.freeze(["package-lock", "install", "typecheck", "wrangler-doctor", "worker-dry-run"]);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

async function regularFile(file, label) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new Error(`${label} must be a regular file, not a symlink`);
    return metadata;
}

function exactObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(exactObject(value, label)).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new Error(`${label} fields must be exactly ${wanted.join(", ")}`);
    }
    return value;
}

function within(parent, child) {
    return child.startsWith(`${parent}${path.sep}`);
}

export function deriveFileReshardProofTarget(candidateDigest, nonce) {
    if (!SHA256.test(candidateDigest ?? "")) throw new Error("file/vector reshard proof candidate digest is invalid");
    if (!NONCE.test(nonce ?? "")) throw new Error("file/vector reshard proof nonce is invalid");
    return `chardb-file-reshard-proof-${candidateDigest.slice(0, 10)}-${nonce}`;
}

async function emptyDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await readdir(directory)).length !== 0) throw new Error(`prepared app directory is not empty: ${directory}`);
}

async function atomicJson(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
}

function fingerprintRecords(records) {
    return Object.freeze({
        algorithm: "sha256",
        digest: sha256(JSON.stringify(records)),
        files: Object.freeze(records.map(record => Object.freeze({ ...record }))),
    });
}

function configurationDigest(input) {
    return sha256(
        JSON.stringify({
            candidate: input.candidate,
            target: input.target,
            nonce: input.nonce,
            runId: input.runId,
            fixtureInput: input.fixtureInput,
        })
    );
}

function candidateIdentity(value, label) {
    exactKeys(value, ["algorithm", "bytes", "digest"], label);
    if (
        value.algorithm !== "sha256" ||
        !SHA256.test(value.digest ?? "") ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 1
    ) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function deploymentFingerprint(value, label) {
    exactKeys(value, ["algorithm", "digest", "files"], label);
    if (value.algorithm !== "sha256" || !SHA256.test(value.digest ?? "") || !Array.isArray(value.files)) {
        throw new Error(`${label} is invalid`);
    }
    const paths = [];
    for (const [index, record] of value.files.entries()) {
        exactKeys(record, ["bytes", "path", "sha256"], `${label} file ${index}`);
        if (
            typeof record.path !== "string" ||
            record.path.length === 0 ||
            path.isAbsolute(record.path) ||
            record.path.split(/[\\/]/).includes("..") ||
            !Number.isSafeInteger(record.bytes) ||
            record.bytes < 1 ||
            !SHA256.test(record.sha256 ?? "")
        ) {
            throw new Error(`${label} file ${index} is invalid`);
        }
        paths.push(record.path);
    }
    if (JSON.stringify(paths) !== JSON.stringify([...paths].sort()) || new Set(paths).size !== paths.length) {
        throw new Error(`${label} files must be unique and sorted`);
    }
    if (sha256(JSON.stringify(value.files)) !== value.digest) throw new Error(`${label} digest is invalid`);
    return value;
}

function preparedPackageManifest() {
    return { ...renderCloudflareVectorizeProofPackage(), name: "chardb-cloudflare-file-vector-reshard-proof" };
}

export function assertFileReshardProofPreparationEvidence(value, expectedCandidate) {
    const evidence = exactKeys(
        value,
        [
            "candidate",
            "configurationSha256",
            "deploymentInput",
            "fixtureInput",
            "mutatingCommandsExecuted",
            "nonce",
            "runId",
            "schema",
            "target",
            "validation",
        ],
        "file/vector reshard preparation evidence"
    );
    if (evidence.schema !== FILE_RESHARD_PROOF_PREPARATION_EVIDENCE_SCHEMA) {
        throw new Error("preparation evidence schema drifted");
    }
    candidateIdentity(evidence.candidate, "preparation evidence candidate");
    if (expectedCandidate !== undefined) {
        candidateIdentity(expectedCandidate, "expected preparation candidate");
        if (JSON.stringify(evidence.candidate) !== JSON.stringify(expectedCandidate)) {
            throw new Error("preparation evidence candidate drifted");
        }
    }
    exactKeys(evidence.target, ["bucket", "vectorizeIndex", "worker"], "preparation evidence target");
    const expectedTarget = deriveFileReshardProofTarget(evidence.candidate.digest, evidence.nonce);
    if (
        evidence.target.worker !== expectedTarget ||
        evidence.target.bucket !== expectedTarget ||
        evidence.target.vectorizeIndex !== expectedTarget
    ) {
        throw new Error("preparation evidence target ownership drifted");
    }
    if (!RUN_ID.test(evidence.runId ?? "") || !SHA256.test(evidence.configurationSha256 ?? "")) {
        throw new Error("preparation evidence run or configuration identity drifted");
    }
    const fixtureInput = deploymentFingerprint(evidence.fixtureInput, "preparation fixture fingerprint");
    const expectedFixturePaths = [...FIXTURE_FILES, "wrangler.deployed.template.toml"].sort();
    if (JSON.stringify(fixtureInput.files.map(record => record.path)) !== JSON.stringify(expectedFixturePaths)) {
        throw new Error("preparation fixture files drifted");
    }
    exactKeys(evidence.validation, ["phases"], "preparation validation");
    if (JSON.stringify(evidence.validation.phases) !== JSON.stringify(VALIDATION_PHASES)) {
        throw new Error("preparation validation phases drifted");
    }
    const deploymentInput = deploymentFingerprint(evidence.deploymentInput, "preparation deployment fingerprint");
    if (
        JSON.stringify(deploymentInput.files.map(record => record.path)) !==
        JSON.stringify(FILE_RESHARD_PROOF_DEPLOYMENT_FILES)
    ) {
        throw new Error("preparation deployment files drifted");
    }
    const tarball = deploymentInput.files.find(record => record.path === "chardb-proof.tgz");
    if (tarball?.sha256 !== evidence.candidate.digest || tarball?.bytes !== evidence.candidate.bytes) {
        throw new Error("preparation deployment tarball identity drifted");
    }
    if (
        evidence.configurationSha256 !==
        configurationDigest({
            candidate: evidence.candidate,
            target: evidence.target,
            nonce: evidence.nonce,
            runId: evidence.runId,
            fixtureInput,
        })
    ) {
        throw new Error("preparation evidence configuration digest drifted");
    }
    if (evidence.mutatingCommandsExecuted !== false) {
        throw new Error("preparation evidence must not claim Cloudflare mutations");
    }
    return Object.freeze(evidence);
}

export function assertFileReshardProofWrangler(source, expected) {
    if (typeof source !== "string" || source.length === 0) throw new Error("prepared Wrangler configuration is empty");
    let value;
    try {
        value = Bun.TOML.parse(source);
    } catch {
        throw new Error("prepared Wrangler configuration is invalid TOML");
    }
    if (value.name !== expected.target || value.main !== "src/worker.ts") {
        throw new Error("prepared Wrangler Worker identity drifted");
    }
    const durableObjectBindings = [
        { name: "CDB_CATALOG", class_name: "Catalog" },
        { name: "CDB_SHARD", class_name: "Cdb" },
        { name: "CDB_GATEWAY", class_name: "Gateway" },
        { name: "CDB_RESHARD", class_name: "Resharder" },
    ];
    if (JSON.stringify(value.durable_objects?.bindings) !== JSON.stringify(durableObjectBindings)) {
        throw new Error("prepared Wrangler Durable Object bindings drifted");
    }
    const r2 = value.r2_buckets;
    if (
        !Array.isArray(r2) ||
        r2.length !== 1 ||
        r2[0]?.binding !== "CDB_FILES" ||
        r2[0]?.bucket_name !== expected.target
    ) {
        throw new Error("prepared Wrangler R2 identity drifted");
    }
    const vectorize = value.vectorize;
    if (
        !Array.isArray(vectorize) ||
        vectorize.length !== 1 ||
        vectorize[0]?.binding !== "CDB_PROOF_VECTORS" ||
        vectorize[0]?.index_name !== expected.target
    ) {
        throw new Error("prepared Wrangler Vectorize identity drifted");
    }
    const vars = exactObject(value.vars, "prepared Wrangler vars");
    for (const [name, expectedValue] of Object.entries({
        CDB_PROOF_TARGET_KIND: "deployed",
        CDB_PROOF_RUNTIME: "cloudflare-workers",
        CDB_PROOF_CONFIGURATION_SHA256: expected.configurationSha256,
        CDB_RELEASE_SHA256: expected.candidateSha256,
        CDB_PROOF_RUN_ID: expected.runId,
        CDB_PROOF_R2_BUCKET: expected.target,
        CDB_PROOF_VECTORIZE_INDEX: expected.target,
    })) {
        if (vars[name] !== expectedValue) throw new Error(`prepared Wrangler ${name} drifted`);
    }
    return value;
}

export function renderFileReshardProofWrangler(template, input) {
    if (input.worker !== input.bucket || input.worker !== input.index || !TARGET.test(input.worker ?? "")) {
        throw new Error("file/vector reshard proof resources must share the exact candidate-owned disposable name");
    }
    if (!SHA256.test(input.releaseSha256 ?? "") || !input.worker.includes(input.releaseSha256.slice(0, 10))) {
        throw new Error("file/vector reshard proof target is not owned by the exact candidate digest");
    }
    if (!SHA256.test(input.configurationSha256 ?? "") || !RUN_ID.test(input.runId ?? "")) {
        throw new Error("file/vector reshard proof configuration identity is invalid");
    }
    const replacements = new Map([
        ["__WORKER_NAME__", input.worker],
        ["__BUCKET_NAME__", input.bucket],
        ["__VECTORIZE_INDEX_NAME__", input.index],
        ["__CONFIGURATION_SHA256__", input.configurationSha256],
        ["__RELEASE_SHA256__", input.releaseSha256],
        ["__RUN_ID__", input.runId],
    ]);
    let output = template;
    for (const [placeholder, value] of replacements) {
        const count = output.split(placeholder).length - 1;
        if (count < 1) throw new Error(`Wrangler template is missing ${placeholder}`);
        output = output.split(placeholder).join(value);
    }
    if (/__[A-Z0-9_]+__/.test(output)) throw new Error("Wrangler template contains an unresolved placeholder");
    return output;
}

export async function fingerprintFileReshardProofDeployment(app) {
    return fingerprintCloudflareVectorizeDeployment(app, FILE_RESHARD_PROOF_DEPLOYMENT_FILES);
}

export async function prepareFileReshardProofApp(input, dependencies = {}) {
    const privateDir = path.resolve(input.privateDir);
    const app = path.resolve(input.app ?? path.join(privateDir, "app"));
    if (!within(privateDir, app)) throw new Error("prepared app must be inside the private directory");
    const nonce = input.nonce ?? randomBytes(8).toString("hex");
    const runId = input.runId ?? randomBytes(24).toString("base64url");
    if (!NONCE.test(nonce)) throw new Error("file/vector reshard proof nonce is invalid");
    if (!RUN_ID.test(runId)) throw new Error("file/vector reshard proof run ID is invalid");
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    const privateMetadata = await lstat(privateDir);
    if (!privateMetadata.isDirectory() || privateMetadata.isSymbolicLink()) {
        throw new Error("file/vector reshard private directory must be a directory, not a symlink");
    }
    await chmod(privateDir, 0o700);
    const canonicalPrivateDir = await realpath(privateDir);
    await emptyDirectory(app);
    const appMetadata = await lstat(app);
    if (!appMetadata.isDirectory() || appMetadata.isSymbolicLink()) {
        throw new Error("file/vector reshard app must be a directory, not a symlink");
    }
    await chmod(app, 0o700);
    const canonicalApp = await realpath(app);
    if (!within(canonicalPrivateDir, canonicalApp)) throw new Error("prepared app escaped the private directory");
    const packageFile = path.resolve(input.package);
    await regularFile(packageFile, "file/vector reshard proof package");
    const candidate = await fingerprintVectorizeProofCandidate(packageFile);
    candidateIdentity(candidate, "file/vector reshard proof candidate");
    const worker = deriveFileReshardProofTarget(candidate.digest, nonce);
    if (input.worker !== undefined && input.worker !== worker) {
        throw new Error("file/vector reshard proof Worker name is not derived from candidate and nonce");
    }
    const fixture = path.resolve(input.fixture ?? DEFAULT_FIXTURE);
    const sourceRecords = [];
    for (const relative of FIXTURE_FILES) {
        const source = path.join(fixture, ...relative.split("/"));
        await regularFile(source, `file/vector reshard fixture ${relative}`);
        const bytes = await readFile(source);
        sourceRecords.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
        const destination = path.join(app, ...relative.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination);
    }
    const templatePath = path.join(fixture, "wrangler.deployed.template.toml");
    await regularFile(templatePath, "file/vector reshard Wrangler template");
    const template = await readFile(templatePath);
    sourceRecords.push({
        path: "wrangler.deployed.template.toml",
        bytes: template.byteLength,
        sha256: sha256(template),
    });
    sourceRecords.sort((left, right) => left.path.localeCompare(right.path));
    const fixtureInput = fingerprintRecords(sourceRecords);
    const target = Object.freeze({ worker, bucket: worker, vectorizeIndex: worker });
    const configurationSha256 = configurationDigest({ candidate, target, nonce, runId, fixtureInput });
    await cp(packageFile, path.join(app, "chardb-proof.tgz"));
    const packageJson = preparedPackageManifest();
    await writeFile(path.join(app, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    await writeFile(
        path.join(app, "wrangler.toml"),
        renderFileReshardProofWrangler(template.toString("utf8"), {
            worker,
            bucket: worker,
            index: worker,
            releaseSha256: candidate.digest,
            configurationSha256,
            runId,
        })
    );
    const copied = await fingerprintVectorizeProofCandidate(path.join(app, "chardb-proof.tgz"));
    if (JSON.stringify(copied) !== JSON.stringify(candidate)) throw new Error("copied candidate tarball drifted");
    const validate = dependencies.validate ?? validateCloudflareVectorizeProofApp;
    const validation = await validate({
        app,
        privateDir,
        npmExecutable: input.npmExecutable,
        commandTimeoutMs: input.commandTimeoutMs,
    });
    const lock = JSON.parse(await readFile(path.join(app, "package-lock.json"), "utf8"));
    assertCloudflareVectorizeProofPackageLock(lock);
    await assertCloudflareVectorizeProofCandidateBridge(app);
    const deploymentInput = await fingerprintFileReshardProofDeployment(app);
    const deployedCandidate = deploymentInput.files.find(record => record.path === "chardb-proof.tgz");
    if (deployedCandidate?.sha256 !== candidate.digest || deployedCandidate?.bytes !== candidate.bytes) {
        throw new Error("deployment fingerprint is not bound to the exact candidate tarball");
    }
    const currentCandidate = await fingerprintVectorizeProofCandidate(packageFile);
    if (JSON.stringify(currentCandidate) !== JSON.stringify(candidate)) {
        throw new Error("source candidate tarball changed during preparation");
    }
    assertFileReshardProofWrangler(await readFile(path.join(app, "wrangler.toml"), "utf8"), {
        target: worker,
        candidateSha256: candidate.digest,
        configurationSha256,
        runId,
    });
    const evidence = assertFileReshardProofPreparationEvidence({
        schema: FILE_RESHARD_PROOF_PREPARATION_EVIDENCE_SCHEMA,
        candidate,
        target,
        nonce,
        runId,
        configurationSha256,
        fixtureInput,
        validation,
        deploymentInput,
        mutatingCommandsExecuted: false,
    });
    const receipt = Object.freeze({
        schema: FILE_RESHARD_PROOF_PREPARATION_SCHEMA,
        evidence,
        privateDir: canonicalPrivateDir,
        app: canonicalApp,
    });
    const preparation = path.resolve(input.output ?? path.join(privateDir, "file-reshard-preparation.json"));
    if (!within(privateDir, preparation)) {
        throw new Error("preparation receipt must be inside the private directory");
    }
    if (preparation === app || within(app, preparation)) {
        throw new Error("preparation receipt must be outside the deployable app");
    }
    const evidencePath = path.resolve(
        input.evidenceOutput ?? path.join(privateDir, "file-reshard-preparation-evidence.json")
    );
    if (!within(privateDir, evidencePath) || evidencePath === app || within(app, evidencePath)) {
        throw new Error("preparation evidence must be inside the private directory and outside the deployable app");
    }
    if (evidencePath === preparation) throw new Error("preparation receipt and evidence paths must be distinct");
    await atomicJson(evidencePath, evidence);
    await atomicJson(preparation, receipt);
    return Object.freeze({ preparation, evidencePath, evidence, receipt });
}

export async function validatePreparedFileReshardProof(input) {
    const packageFile = path.resolve(input.package);
    const preparationFile = path.resolve(input.preparation);
    await regularFile(packageFile, "file/vector reshard proof package");
    await regularFile(preparationFile, "file/vector reshard preparation receipt");
    const wrapper = exactKeys(
        JSON.parse(await readFile(preparationFile, "utf8")),
        ["app", "evidence", "privateDir", "schema"],
        "file/vector reshard preparation receipt"
    );
    if (wrapper.schema !== FILE_RESHARD_PROOF_PREPARATION_SCHEMA) throw new Error("preparation schema drifted");
    const candidate = await fingerprintVectorizeProofCandidate(packageFile);
    const evidence = assertFileReshardProofPreparationEvidence(wrapper.evidence, candidate);
    if (typeof wrapper.privateDir !== "string" || !path.isAbsolute(wrapper.privateDir)) {
        throw new Error("preparation private directory is invalid");
    }
    const privateDir = await realpath(wrapper.privateDir);
    if (privateDir !== wrapper.privateDir) throw new Error("preparation private directory identity drifted");
    const app = await realpath(wrapper.app);
    if (app !== wrapper.app || !within(privateDir, app)) throw new Error("prepared app escaped its private directory");
    const canonicalPreparation = await realpath(preparationFile);
    if (
        !within(privateDir, canonicalPreparation) ||
        canonicalPreparation === app ||
        within(app, canonicalPreparation)
    ) {
        throw new Error("preparation receipt is inside the deployable app");
    }
    const copiedCandidate = await fingerprintVectorizeProofCandidate(path.join(app, "chardb-proof.tgz"));
    if (JSON.stringify(copiedCandidate) !== JSON.stringify(candidate))
        throw new Error("prepared candidate copy drifted");
    const packageJson = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
    if (JSON.stringify(packageJson) !== JSON.stringify(preparedPackageManifest())) {
        throw new Error("prepared package manifest drifted");
    }
    assertFileReshardProofWrangler(await readFile(path.join(app, "wrangler.toml"), "utf8"), {
        target: evidence.target.worker,
        candidateSha256: candidate.digest,
        configurationSha256: evidence.configurationSha256,
        runId: evidence.runId,
    });
    const deploymentInput = await fingerprintFileReshardProofDeployment(app);
    if (JSON.stringify(deploymentInput) !== JSON.stringify(evidence.deploymentInput)) {
        throw new Error("prepared deployment tree changed after validation");
    }
    const lock = JSON.parse(await readFile(path.join(app, "package-lock.json"), "utf8"));
    assertCloudflareVectorizeProofPackageLock(lock);
    await assertCloudflareVectorizeProofCandidateBridge(app);
    return Object.freeze({ app, candidate, receipt: evidence, evidence, wrapper: Object.freeze(wrapper) });
}

function argumentValue(argv, flag) {
    const indexes = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (indexes.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (indexes.length === 0) return undefined;
    const result = argv[indexes[0] + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

export function parseFileReshardProofPreparationArgs(argv) {
    const valued = new Set([
        "--package",
        "--private-dir",
        "--app",
        "--output",
        "--evidence",
        "--fixture",
        "--nonce",
        "--run-id",
        "--npm",
    ]);
    const allowed = new Set([...valued, "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument)) throw new Error(`unknown preparation argument ${JSON.stringify(argument)}`);
        if (valued.has(argument)) {
            const next = argv[++index];
            if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
        }
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const options = {
        help,
        package: argumentValue(argv, "--package"),
        privateDir: argumentValue(argv, "--private-dir"),
        app: argumentValue(argv, "--app"),
        output: argumentValue(argv, "--output"),
        evidenceOutput: argumentValue(argv, "--evidence"),
        fixture: argumentValue(argv, "--fixture"),
        nonce: argumentValue(argv, "--nonce"),
        runId: argumentValue(argv, "--run-id"),
        npmExecutable: argumentValue(argv, "--npm") ?? "npm",
    };
    if (help) return Object.freeze(options);
    if (!options.package) throw new Error("--package is required");
    if (!options.privateDir) throw new Error("--private-dir is required");
    if (options.nonce !== undefined && !NONCE.test(options.nonce)) {
        throw new Error("--nonce must contain exactly 16 lowercase hexadecimal characters");
    }
    if (options.runId !== undefined && !RUN_ID.test(options.runId)) {
        throw new Error("--run-id must contain 16 to 80 safe characters");
    }
    for (const field of ["package", "privateDir", "app", "output", "evidenceOutput", "fixture"]) {
        if (options[field] !== undefined) options[field] = path.resolve(options[field]);
    }
    return Object.freeze(options);
}

function usage() {
    return [
        "Usage: bun scripts/prepare-file-reshard-deployment-proof.mjs --package <candidate.tgz> --private-dir <directory> [options]",
        "",
        "Builds and validates an isolated file/vector reshard proof app without changing Cloudflare resources.",
        "The Worker, R2 bucket, and Vectorize index name is derived from the exact package digest and a nonce.",
        "By default the command generates the nonce and run ID, writes the app under <private-dir>/app,",
        "and writes <private-dir>/file-reshard-preparation.json for the deployment proof runner.",
        "",
        "Options: --app, --output, --evidence, --fixture, --nonce, --run-id, --npm, --help",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseFileReshardProofPreparationArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else {
            const prepared = await prepareFileReshardProofApp(options);
            console.log(
                JSON.stringify(
                    {
                        preparation: prepared.preparation,
                        evidence: prepared.evidencePath,
                        candidate: prepared.evidence.candidate,
                        target: prepared.evidence.target,
                        runId: prepared.evidence.runId,
                        configurationSha256: prepared.evidence.configurationSha256,
                        deploymentInput: prepared.evidence.deploymentInput,
                    },
                    null,
                    2
                )
            );
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
