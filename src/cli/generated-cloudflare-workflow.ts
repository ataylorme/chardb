export interface GeneratedCloudflareWorkflowInput {
    readonly workerName: string;
    readonly filesBucket: string;
    readonly packageName: string;
    readonly deploymentId: string;
}

export const GENERATED_WRANGLER_VERSION = "4.125.0";

const DEPLOYMENT_ID = /^chardb\.app\.v1\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireDeploymentId(input: GeneratedCloudflareWorkflowInput): void {
    if (!DEPLOYMENT_ID.test(input.deploymentId)) {
        throw new TypeError("generated Cloudflare workflow requires a chardb.app.v1 UUID deployment ID");
    }
}

/** Render the one-time native-resource setup used by generated projects. */
export function renderCloudflareSetupScript(input: GeneratedCloudflareWorkflowInput): string {
    requireDeploymentId(input);
    return `import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerName = ${JSON.stringify(input.workerName)};
const filesBucket = ${JSON.stringify(input.filesBucket)};
const deploymentId = ${JSON.stringify(input.deploymentId)};
const ownershipKey = "_chardb/control/ownership.json";
const ownershipMarker = JSON.stringify({
  format: "chardb.r2-ownership.v1",
  deploymentId,
  workerName,
  filesBucket,
}) + "\\n";
const wranglerModule = fileURLToPath(import.meta.resolve("wrangler"));
const chardbModule = join(dirname(fileURLToPath(import.meta.resolve(${JSON.stringify(input.packageName)}))), "cli", "bin.mjs");
const wrangler = (...args) => [process.execPath, wranglerModule, ...args];
const chardb = (...args) => [process.execPath, chardbModule, ...args];

function childEnvironment() {
  const env = { ...process.env };
  delete env.CHARDB_URL;
  delete env.CHARDB_ADMIN_TOKEN;
  delete env.BETTER_AUTH_SECRET;
  return env;
}

async function command(args, { capture = false } = {}) {
  const child = Bun.spawn(args, {
    env: childEnvironment(),
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    capture ? new Response(child.stdout).text() : "",
    capture ? new Response(child.stderr).text() : "",
  ]);
  return { exitCode, stdout, stderr };
}

function detail(result) {
  return (result.stderr || result.stdout).trim().slice(0, 2_000);
}

export function isMissingBucket(result) {
  return result.exitCode !== 0 && /The specified bucket does not exist\\./i.test(result.stderr + "\\n" + result.stdout);
}

export function isMissingObject(result) {
  return result.exitCode !== 0 && /The specified (?:key|object) does not exist\.|object not found/i.test(
    result.stderr + "\\n" + result.stdout,
  );
}

export function parseSetupArguments(args) {
  const adoptExistingBucket = args.includes("--adopt-existing-bucket");
  if (args.some(arg => arg !== "--adopt-existing-bucket") || args.length !== (adoptExistingBucket ? 1 : 0)) {
    throw new Error("usage: bun scripts/setup-cloudflare.mjs [--adopt-existing-bucket]");
  }
  return { adoptExistingBucket };
}

function parseTomlString(line, key) {
  const match = line.match(new RegExp("^" + key + "\\\\s*=\\\\s*(\\\"(?:[^\\\"\\\\\\\\]|\\\\\\\\.)*\\\")\\\\s*(?:#.*)?$"));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("wrangler.toml contains an invalid quoted " + key);
  }
}

export function configuredIdentity(raw) {
  let section = "root";
  let name;
  const buckets = [];
  let bucket = null;
  const finishBucket = () => {
    if (bucket) buckets.push(bucket);
    bucket = null;
  };
  for (const rawLine of raw.split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\\[\\[r2_buckets\\]\\]\\s*(?:#.*)?$/.test(line)) {
      finishBucket();
      section = "r2";
      bucket = {};
      continue;
    }
    if (/^\\[/.test(line)) {
      finishBucket();
      section = "other";
      continue;
    }
    if (section === "root") name ??= parseTomlString(line, "name");
    if (section === "r2") {
      bucket.binding ??= parseTomlString(line, "binding");
      bucket.bucketName ??= parseTomlString(line, "bucket_name");
    }
  }
  finishBucket();
  const files = buckets.filter(candidate => candidate.binding === "CDB_FILES");
  if (typeof name !== "string" || files.length !== 1 || typeof files[0].bucketName !== "string") {
    throw new Error("wrangler.toml must contain one Worker name and one CDB_FILES R2 bucket");
  }
  return { workerName: name, filesBucket: files[0].bucketName };
}

export function assertGeneratedConfig(raw) {
  const configured = configuredIdentity(raw);
  if (configured.workerName !== workerName || configured.filesBucket !== filesBucket) {
    throw new Error("wrangler.toml drifted from the generated deployment contract; regenerate or review the scripts");
  }
  return configured;
}

async function requireCurrentConfig() {
  const path = join(process.cwd(), "wrangler.toml");
  if (!(await Bun.file(path).exists())) throw new Error("generated Cloudflare commands require wrangler.toml");
  assertGeneratedConfig(await Bun.file(path).text());
}

async function probeBucket(run = command) {
  const result = await run(wrangler("r2", "bucket", "info", filesBucket, "--json"), { capture: true });
  if (result.exitCode !== 0) return { result };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned invalid JSON while inspecting R2 bucket " + filesBucket);
  }
  if (!parsed || parsed.name !== filesBucket) {
    throw new Error("Wrangler inspected a different R2 bucket than " + filesBucket);
  }
  return { result, parsed };
}

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "chardb-r2-ownership-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readOwnershipMarker(run = command) {
  return withTemporaryDirectory(async directory => {
    const path = join(directory, "ownership.json");
    const result = await run(wrangler("r2", "object", "get", filesBucket + "/" + ownershipKey, "--file", path), {
      capture: true,
    });
    if (isMissingObject(result)) return null;
    if (result.exitCode !== 0) {
      throw new Error("could not inspect the CharDB R2 ownership marker: " + detail(result));
    }
    if (!(await Bun.file(path).exists())) {
      throw new Error("Wrangler did not write the CharDB R2 ownership marker");
    }
    return Bun.file(path).text();
  });
}

async function writeOwnershipMarker(run = command) {
  await withTemporaryDirectory(async directory => {
    const path = join(directory, "ownership.json");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(ownershipMarker);
    } finally {
      await file.close();
    }
    const result = await run(wrangler("r2", "object", "put", filesBucket + "/" + ownershipKey, "--file", path), {
      capture: true,
    });
    if (result.exitCode !== 0) {
      throw new Error("could not write the CharDB R2 ownership marker: " + detail(result));
    }
  });
}

function assertOwnershipMarker(marker) {
  if (marker !== ownershipMarker) {
    throw new Error(
      "R2 bucket " + filesBucket + " has a different CharDB ownership marker; refusing to modify it",
    );
  }
}

export async function setupFilesBucket({ adoptExistingBucket = false, run = command } = {}) {
  const before = await probeBucket(run);
  let createdBucket = false;
  try {
    if (!before.parsed) {
      if (!isMissingBucket(before.result)) {
        throw new Error("could not inspect R2 bucket " + filesBucket + ": " + detail(before.result));
      }
      const created = await run(wrangler("r2", "bucket", "create", filesBucket));
      if (created.exitCode !== 0) throw new Error("could not create R2 bucket " + filesBucket);
      createdBucket = true;
      const after = await probeBucket(run);
      if (!after.parsed) throw new Error("R2 bucket " + filesBucket + " was not visible after creation");
    }
    const marker = await readOwnershipMarker(run);
    if (marker === null) {
      if (!createdBucket && !adoptExistingBucket) {
        throw new Error(
          "R2 bucket " + filesBucket + " already exists without CharDB ownership; " +
          "review it, then rerun with --adopt-existing-bucket to adopt it",
        );
      }
      await writeOwnershipMarker(run);
      assertOwnershipMarker(await readOwnershipMarker(run));
    } else {
      assertOwnershipMarker(marker);
    }
  } catch (error) {
    if (createdBucket) {
      const rollback = await run(wrangler("r2", "bucket", "delete", filesBucket), { capture: true });
      if (rollback.exitCode !== 0) {
        throw new AggregateError([error, new Error("could not roll back the new R2 bucket: " + detail(rollback))]);
      }
    }
    throw error;
}
}

async function main() {
  const { adoptExistingBucket } = parseSetupArguments(process.argv.slice(2));
  for (const path of [wranglerModule, chardbModule]) {
    if (!(await Bun.file(path).exists())) throw new Error("missing local dependencies; run bun install first");
  }
  const doctor = await command(chardb("doctor"));
  if (doctor.exitCode !== 0) throw new Error("chardb doctor rejected wrangler.toml");
  await requireCurrentConfig();

  await setupFilesBucket({ adoptExistingBucket });
  console.log("Cloudflare R2 bucket " + filesBucket + " is owned by " + workerName);
}

if (import.meta.main) await main();
`;
}

/** Render the resumable bootstrap and routine deployment driver used by generated projects. */
export function renderCloudflareDeployScript(input: GeneratedCloudflareWorkflowInput): string {
    requireDeploymentId(input);
    return `import { mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerName = ${JSON.stringify(input.workerName)};
const filesBucket = ${JSON.stringify(input.filesBucket)};
const deploymentId = ${JSON.stringify(input.deploymentId)};
const pinnedWranglerVersion = ${JSON.stringify(GENERATED_WRANGLER_VERSION)};
const wranglerModule = fileURLToPath(import.meta.resolve("wrangler"));
const wranglerPackage = fileURLToPath(import.meta.resolve("wrangler/package.json"));
const chardbModule = join(dirname(fileURLToPath(import.meta.resolve(${JSON.stringify(input.packageName)}))), "cli", "bin.mjs");
const wrangler = (...args) => [process.execPath, wranglerModule, ...args];
const chardb = (...args) => [process.execPath, chardbModule, ...args];
const bootstrap = process.argv.slice(2).includes("--bootstrap");
const deploymentDirectory = join(process.cwd(), ".wrangler");
const deploymentCachePath = join(deploymentDirectory, "chardb-deployment.json");
const wranglerOutputPath = join(deploymentDirectory, "chardb-deploy-output.jsonl");

function childEnvironment(extra = {}) {
  const env = { ...process.env };
  delete env.CHARDB_URL;
  delete env.CHARDB_ADMIN_TOKEN;
  delete env.BETTER_AUTH_SECRET;
  delete env.WRANGLER_OUTPUT_FILE_PATH;
  return { ...env, ...extra };
}

async function command(args, { capture = false, env = childEnvironment() } = {}) {
  const child = Bun.spawn(args, {
    env,
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    capture ? new Response(child.stdout).text() : "",
    capture ? new Response(child.stderr).text() : "",
  ]);
  return { exitCode, stdout, stderr };
}

function detail(result) {
  return (result.stderr || result.stdout).trim().slice(0, 2_000);
}

async function mustRun(args, options) {
  const result = await command(args, options);
  if (result.exitCode !== 0) throw new Error(args[0] + " exited with status " + result.exitCode);
  return result;
}

export function validateChardbUrl(raw) {
  if (!raw) throw new Error("CHARDB_URL is required and must name the deployed Worker origin");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CHARDB_URL must be a valid HTTPS origin");
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash
  ) {
    throw new Error("CHARDB_URL must be an HTTPS origin without credentials, a path, a query, or a fragment");
  }
  return url.origin;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function plainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function validateWranglerPackage(value) {
  if (!plainRecord(value) || !exactKeys(value, ["version"]) || value.version !== pinnedWranglerVersion) {
    throw new Error("generated deployment requires Wrangler " + pinnedWranglerVersion);
  }
  return value.version;
}

async function requirePinnedWrangler() {
  let parsed;
  try {
    parsed = JSON.parse(await Bun.file(wranglerPackage).text());
  } catch {
    throw new Error("could not read the installed Wrangler package version");
  }
  return validateWranglerPackage({ version: parsed?.version });
}

function validateDeployRecord(value) {
  const keys = [
    "timestamp", "type", "version", "version_id", "worker_name", "worker_name_overridden", "worker_tag", "targets",
  ];
  if (!plainRecord(value) || !exactKeys(value, keys)) {
    throw new Error("Wrangler deployment output does not match the pinned deploy-v1 schema");
  }
  if (
    value.type !== "deploy" || value.version !== 1 || value.worker_name !== workerName ||
    value.worker_name_overridden !== false ||
    (value.worker_tag !== null && (typeof value.worker_tag !== "string" || !value.worker_tag)) ||
    typeof value.version_id !== "string" || !value.version_id ||
    typeof value.timestamp !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value.timestamp) ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    !Array.isArray(value.targets) || value.targets.length > 64 ||
    value.targets.some(target => typeof target !== "string" || !target || target.length > 2_048) ||
    new Set(value.targets).size !== value.targets.length
  ) {
    throw new Error("Wrangler deployment output contains an invalid deploy-v1 record");
  }
  return value;
}

function workersDevOrigin(target) {
  let origin;
  try {
    origin = validateChardbUrl(target);
  } catch {
    return null;
  }
  const hostname = new URL(origin).hostname.toLowerCase();
  if (!hostname.endsWith(".workers.dev") || !hostname.startsWith(workerName.toLowerCase() + ".")) return null;
  return origin;
}

export function originFromWranglerOutput(raw) {
  const lines = raw.split(/\\r?\\n/).filter(line => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error("Wrangler deployment output must contain exactly one deploy-v1 record");
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new Error("Wrangler deployment output is not valid JSON");
  }
  const record = validateDeployRecord(parsed);
  const candidates = record.targets.map(workersDevOrigin).filter(Boolean);
  if (candidates.length !== 1) {
    throw new Error(
      "Wrangler deployed the Worker without one unambiguous workers.dev URL. " +
      "Set CHARDB_URL=https://your-worker.example.com in .env.local, then rerun bun run deploy:bootstrap.",
    );
  }
  return candidates[0];
}

export function validateDeploymentCache(value) {
  const keys = ["deploymentId", "format", "origin", "workerName", "wranglerVersion"];
  if (
    !plainRecord(value) || !exactKeys(value, keys) || value.format !== "chardb.deployment.v1" ||
    value.deploymentId !== deploymentId || value.workerName !== workerName ||
    value.wranglerVersion !== pinnedWranglerVersion || typeof value.origin !== "string"
  ) {
    throw new Error("the cached CharDB deployment identity does not match this generated project");
  }
  return validateChardbUrl(value.origin);
}

async function readJsonFile(path, label) {
  if (!(await Bun.file(path).exists())) return null;
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    throw new Error(label + " is not valid JSON");
  }
}

export async function cacheDeploymentOrigin(origin, path = deploymentCachePath) {
  const normalized = validateChardbUrl(origin);
  const value = {
    format: "chardb.deployment.v1",
    deploymentId,
    workerName,
    wranglerVersion: pinnedWranglerVersion,
    origin: normalized,
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + "\\n");
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return value;
}

export async function existingDeploymentOrigin(
  rawExplicit,
  { cachePath = deploymentCachePath, outputPath = wranglerOutputPath } = {},
) {
  if (rawExplicit) return validateChardbUrl(rawExplicit);
  const cached = await readJsonFile(cachePath, "the cached CharDB deployment identity");
  if (cached) return validateDeploymentCache(cached);
  if (await Bun.file(outputPath).exists()) {
    const recovered = originFromWranglerOutput(await Bun.file(outputPath).text());
    await cacheDeploymentOrigin(recovered, cachePath);
    return recovered;
  }
  throw new Error(
    "Worker exists but no public origin is cached. " +
    "Set CHARDB_URL=https://your-worker.example.com in .env.local, then rerun bun run deploy:bootstrap.",
  );
}

export function migrationIdentity(journal) {
  if (!journal || !Number.isSafeInteger(journal.version) || journal.version < 1) {
    throw new Error("the packaged migration journal has an invalid version");
  }
  if (typeof journal.digest !== "string" || !/^[a-f0-9]{64}$/.test(journal.digest)) {
    throw new Error("the packaged migration journal has an invalid digest");
  }
  return {
    version: journal.version,
    digest: journal.digest,
    migrationId: "schema-v" + journal.version + "-" + journal.digest,
  };
}

function parseTomlString(line, key) {
  const match = line.match(new RegExp("^" + key + "\\\\s*=\\\\s*(\\\"(?:[^\\\"\\\\\\\\]|\\\\\\\\.)*\\\")\\\\s*(?:#.*)?$"));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("wrangler.toml contains an invalid quoted " + key);
  }
}

export function configuredIdentity(raw) {
  let section = "root";
  let name;
  const buckets = [];
  let bucket = null;
  const finishBucket = () => {
    if (bucket) buckets.push(bucket);
    bucket = null;
  };
  for (const rawLine of raw.split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\\[\\[r2_buckets\\]\\]\\s*(?:#.*)?$/.test(line)) {
      finishBucket();
      section = "r2";
      bucket = {};
      continue;
    }
    if (/^\\[/.test(line)) {
      finishBucket();
      section = "other";
      continue;
    }
    if (section === "root") name ??= parseTomlString(line, "name");
    if (section === "r2") {
      bucket.binding ??= parseTomlString(line, "binding");
      bucket.bucketName ??= parseTomlString(line, "bucket_name");
    }
  }
  finishBucket();
  const files = buckets.filter(candidate => candidate.binding === "CDB_FILES");
  if (typeof name !== "string" || files.length !== 1 || typeof files[0].bucketName !== "string") {
    throw new Error("wrangler.toml must contain one Worker name and one CDB_FILES R2 bucket");
  }
  return { workerName: name, filesBucket: files[0].bucketName };
}

export function assertGeneratedConfig(raw) {
  const configured = configuredIdentity(raw);
  if (configured.workerName !== workerName || configured.filesBucket !== filesBucket) {
    throw new Error("wrangler.toml drifted from the generated deployment contract; regenerate or review the scripts");
  }
  return configured;
}

async function requireCurrentConfig() {
  const path = join(process.cwd(), "wrangler.toml");
  if (!(await Bun.file(path).exists())) throw new Error("generated Cloudflare commands require wrangler.toml");
  assertGeneratedConfig(await Bun.file(path).text());
}

export function validateAdminToken(raw) {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : 0;
  if (bytes < 32 || bytes > 512) {
    throw new Error("CHARDB_ADMIN_TOKEN must contain from 32 through 512 UTF-8 bytes");
  }
  return raw;
}

export function workerExistsResult(result) {
  if (result.exitCode === 0) {
    let deployments;
    try {
      deployments = JSON.parse(result.stdout);
    } catch {
      throw new Error("Wrangler returned invalid JSON while checking Worker " + workerName);
    }
    if (!Array.isArray(deployments)) throw new Error("Wrangler returned invalid deployment data");
    return deployments.length > 0;
  }
  const message = result.stderr + "\\n" + result.stdout;
  if (/Worker .* not found|Worker not found|code[^0-9]*10090/i.test(message)) return false;
  throw new Error("could not inspect Worker " + workerName + ": " + detail(result));
}

async function workerExists() {
  return workerExistsResult(await command(wrangler("deployments", "list", "--name", workerName, "--json"), {
    capture: true,
  }));
}

async function requireFilesBucket() {
  const result = await command(wrangler("r2", "bucket", "info", filesBucket, "--json"), { capture: true });
  if (result.exitCode !== 0) {
    throw new Error("R2 bucket " + filesBucket + " is unavailable; run bun run setup:cloudflare first: " + detail(result));
  }
  let bucket;
  try {
    bucket = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned invalid JSON while inspecting R2 bucket " + filesBucket);
  }
  if (!bucket || bucket.name !== filesBucket) throw new Error("Wrangler inspected a different R2 bucket");
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(url + " returned invalid JSON with status " + response.status);
    }
    if (!response.ok || !body || typeof body !== "object") {
      throw new Error(url + " returned status " + response.status);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function validateHealth(body) {
  if (
    body.ok !== true || !Number.isSafeInteger(body.schemaVersion) || body.schemaVersion < 1 ||
    typeof body.schemaDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.schemaDigest) ||
    body.deploymentId !== deploymentId
  ) {
    throw new Error("/health did not identify the expected Worker " + deploymentId);
  }
  return { version: body.schemaVersion, digest: body.schemaDigest, deploymentId: body.deploymentId };
}

async function health(origin) {
  return validateHealth(await fetchJson(origin + "/health"));
}

async function migrationState(origin, token) {
  const body = await fetchJson(origin + "/_chardb/migrations/state", {
    headers: { authorization: "Bearer " + token },
  });
  const state = body.state;
  if (
    body.ok !== true || !state || typeof state !== "object" ||
    !Number.isSafeInteger(state.activeVersion) || state.activeVersion < 0 ||
    typeof state.activeDigest !== "string" || !/^[a-f0-9]{64}$/.test(state.activeDigest) ||
    (state.status !== "active" && state.status !== "migrating")
  ) {
    throw new Error("the migration state endpoint returned an invalid version or digest");
  }
  return state;
}

export function deploymentDecision({ bootstrap, exists, health, state, expected }) {
  if (!exists) {
    if (!bootstrap) throw new Error("Worker does not exist; run bun run deploy:bootstrap first");
    return "bootstrap-upload";
  }
  if (!health || !state) throw new Error("an existing Worker requires health and migration state");
  if (health.deploymentId !== deploymentId) {
    throw new Error("CHARDB_URL points at a different Worker: expected " + deploymentId);
  }
  const packageIsExpected = health.version === expected.version && health.digest === expected.digest;
  if (packageIsExpected) {
    if (state.status === "migrating") {
      if (
        state.migrationId !== expected.migrationId || state.targetVersion !== expected.version ||
        state.targetDigest !== expected.digest
      ) {
        throw new Error("the deployed package has a migration owned by a different ID, version, or digest");
      }
    }
    return "resume";
  }
  if (bootstrap) {
    throw new Error(
      "bootstrap found an existing Worker with a different schema package; use bun run deploy for routine changes",
    );
  }
  if (
    state.status !== "active" || state.activeVersion !== health.version ||
    state.activeDigest !== health.digest
  ) {
    throw new Error("the current Worker package and active migration state do not match; finish that migration first");
  }
  return "routine-upload";
}

async function waitForHealth(origin, expected) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const actual = await health(origin);
      if (actual.version === expected.version && actual.digest === expected.digest) return actual;
      lastError = new Error(
        "/health reports schema v" + actual.version + " " + actual.digest +
        ", expected v" + expected.version + " " + expected.digest,
      );
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(500);
  }
  throw new Error("deployed Worker did not report the packaged schema identity: " + (lastError?.message ?? "timeout"));
}

export async function createSecretFile(secrets, temporaryRoot = tmpdir()) {
  const directory = await mkdtemp(join(temporaryRoot, "chardb-bootstrap-"));
  try {
    const path = join(directory, "secrets.json");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(secrets));
    } finally {
      await file.close();
    }
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function deployBootstrap() {
  const adminToken = validateAdminToken(process.env.CHARDB_ADMIN_TOKEN);
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!adminToken) throw new Error("CHARDB_ADMIN_TOKEN is required for bootstrap");
  if (!authSecret || new TextEncoder().encode(authSecret).byteLength < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 UTF-8 bytes for bootstrap");
  }
  await mkdir(deploymentDirectory, { recursive: true });
  await rm(wranglerOutputPath, { force: true });
  const output = await open(wranglerOutputPath, "wx", 0o600);
  await output.close();
  const secretFile = await createSecretFile({ CDB_ADMIN_TOKEN: adminToken, BETTER_AUTH_SECRET: authSecret });
  try {
    await mustRun(wrangler("deploy", "--strict", "--secrets-file", secretFile.path), {
      env: childEnvironment({ WRANGLER_OUTPUT_FILE_PATH: wranglerOutputPath }),
    });
  } finally {
    await rm(secretFile.directory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== "--bootstrap")) {
    throw new Error("usage: bun scripts/deploy.mjs [--bootstrap]");
  }
  for (const path of [wranglerModule, chardbModule]) {
    if (!(await Bun.file(path).exists())) throw new Error("missing local dependencies; run bun install first");
  }
  await requirePinnedWrangler();
  const explicitOrigin = process.env.CHARDB_URL ? validateChardbUrl(process.env.CHARDB_URL) : null;
  const adminToken = validateAdminToken(process.env.CHARDB_ADMIN_TOKEN);
  const imported = await import(pathToFileURL(join(process.cwd(), "src", "migrations.ts")).href);
  const expected = migrationIdentity(imported.migrations);

  await mustRun(chardb("doctor"));
  await requireCurrentConfig();
  await requireFilesBucket();
  const exists = await workerExists();
  let origin = exists ? await existingDeploymentOrigin(explicitOrigin) : explicitOrigin;
  const beforeHealth = exists ? await health(origin) : null;
  const beforeState = exists ? await migrationState(origin, adminToken) : null;
  const decision = deploymentDecision({ bootstrap, exists, health: beforeHealth, state: beforeState, expected });
  if (decision === "resume") {
    console.log("the expected Worker package already exists; resuming without uploading code or secrets");
  }

  await mustRun([process.execPath, "run", "typecheck"]);
  await mustRun([process.execPath, "run", "test"]);
  await mustRun([process.execPath, "run", "build:web"]);
  await mustRun([process.execPath, "run", "build:worker"]);
  if (decision === "bootstrap-upload") {
    await deployBootstrap();
    origin ??= originFromWranglerOutput(await Bun.file(wranglerOutputPath).text());
  }
  if (decision === "routine-upload") await mustRun(wrangler("deploy", "--strict"));

  await waitForHealth(origin, expected);
  await cacheDeploymentOrigin(origin);
  const migrated = await command(
    chardb(
      "migrate",
      "--url",
      origin,
      "--id",
      expected.migrationId,
      "--target",
      String(expected.version),
      "--concurrency",
      "4",
    ),
    { env: childEnvironment({ CHARDB_ADMIN_TOKEN: adminToken }) },
  );
  if (migrated.exitCode !== 0) {
    throw new Error(
      "migration did not finish; rerun the same command to resume migration " + expected.migrationId,
    );
  }
  const active = await migrationState(origin, adminToken);
  if (
    active.status !== "active" || active.activeVersion !== expected.version ||
    active.activeDigest !== expected.digest
  ) {
    throw new Error("migration returned without activating the packaged schema version and digest");
  }
  await waitForHealth(origin, expected);
  console.log(
    workerName + " is deployed at " + origin + " with schema v" + expected.version + " " + expected.digest,
  );
}

if (import.meta.main) await main();
`;
}
