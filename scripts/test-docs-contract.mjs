import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATE = Object.freeze({
  name: "@chardb/core",
  version: "0.1.0",
  size: 455_344,
  sha256: "4ec16920f255cd9eaefdb41cac004d9320d81e4c23e2f92e73a12cc680691ae4",
});

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(repositoryRoot, "docs");
const tarballInput = process.env.CHARDB_DOCS_TARBALL;
if (!tarballInput) fail("set CHARDB_DOCS_TARBALL to the candidate .tgz");
const tarballPath = resolve(tarballInput);

const tarball = await readFile(tarballPath).catch(() => fail(`cannot read candidate: ${tarballPath}`));
if (tarball.byteLength !== CANDIDATE.size) {
  fail(`candidate size is ${tarball.byteLength}; expected ${CANDIDATE.size}`);
}
const digest = createHash("sha256").update(tarball).digest("hex");
if (digest !== CANDIDATE.sha256) fail(`candidate SHA-256 is ${digest}; expected ${CANDIDATE.sha256}`);

const temporaryRoot = await mkdtemp(join(tmpdir(), "chardb-docs-contract-"));
try {
  run("tar", ["-xzf", tarballPath, "-C", temporaryRoot]);
  await symlink(join(repositoryRoot, "node_modules"), join(temporaryRoot, "node_modules"), "dir");

  const packageRoot = join(temporaryRoot, "package");
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== CANDIDATE.name || packageJson.version !== CANDIDATE.version) {
    fail(`candidate identity is ${packageJson.name}@${packageJson.version}`);
  }
  const expectedExports = [".", "./server", "./react", "./files", "./vite"];
  if (JSON.stringify(Object.keys(packageJson.exports)) !== JSON.stringify(expectedExports)) {
    fail(`public exports must be ${expectedExports.join(", ")}`);
  }

  const cli = join(packageRoot, "dist/cli/bin.mjs");
  const help = run(process.execPath, [cli, "--help"]).stdout;
  for (const command of ["init <name>", "doctor [wrangler]", "migrations generate", "vectorize prepare", "migrate --url"]) {
    requireText(help, command, `CLI help is missing ${command}`);
  }
  rejectText(help, "experimental shards", "experimental range movement leaked into primary help");
  const rangeResult = spawnSync(process.execPath, [cli, "experimental", "shards", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (rangeResult.status !== 2) fail(`range help exited ${rangeResult.status}; expected 2`);
  const rangeHelp = `${rangeResult.stdout}${rangeResult.stderr}`;
  for (const word of ["split", "status|recover|abort", "--max-steps"]) {
    requireText(rangeHelp, word, `range command help is missing ${word}`);
  }

  const init = run(process.execPath, [cli, "init", "my-chardb-app"], temporaryRoot);
  requireText(init.stdout, 'initialised "my-chardb-app"', "initializer did not report the created directory");
  const appRoot = join(temporaryRoot, "my-chardb-app");
  const generatedPackage = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
  if (generatedPackage.dependencies?.[CANDIDATE.name] !== CANDIDATE.version) {
    fail("generated app does not pin the candidate package version");
  }

  const config = JSON.parse(await readFile(join(docsRoot, "docs.json"), "utf8"));
  const pageNames = [];
  collectPages(config.navigation, pageNames);
  const expectedPages = [
    "quickstart",
    "ownership",
    "live-queries",
    "files",
    "vectors",
    "deploy",
    "schema-migrations",
    "cookbook/chat-app",
  ];
  if (JSON.stringify(pageNames) !== JSON.stringify(expectedPages)) {
    fail(`navigation must be ${expectedPages.join(", ")}`);
  }

  const pageSources = new Map();
  for (const page of pageNames) {
    const path = join(docsRoot, `${page}.mdx`);
    const source = await readFile(path, "utf8").catch(() => fail(`navigation page does not exist: ${page}`));
    if (!source.startsWith("---\n") || !/^---\n[\s\S]*?\n---\n/.test(source)) {
      fail(`page has invalid frontmatter: ${page}`);
    }
    pageSources.set(page, source);
  }

  const combined = [...pageSources.values()].join("\n");
  for (const legacy of [/from ["']chardb(?:\/[^"']*)?["']/, /\bbunx chardb\b/, /\bbun add chardb\b/]) {
    if (legacy.test(combined)) fail(`public docs contain a legacy package path: ${legacy}`);
  }
  for (const unsupported of [
    "forUser",
    "globalScope",
    "fileArray",
    "inlineVector",
    ".nearest(",
    "backup create",
    "backup verify",
    "restore --from",
    "automatic sharding",
  ]) {
    rejectText(combined, unsupported, `public docs advertise an unsupported path: ${unsupported}`);
  }

  for (const [page, source] of pageSources) {
    for (const match of source.matchAll(/\]\(\/([^\s)#]+)(?:#[^)]+)?\)/g)) {
      const target = match[1];
      if (!pageNames.includes(target)) fail(`${page} links to a page outside navigation: ${target}`);
    }
  }

  const generatedExamples = new Set();
  const generatedPattern = /\{\/\* generated: ([^\s]+) \*\/\}\s*```[^\n]*\n([\s\S]*?)\n```/g;
  for (const [page, source] of pageSources) {
    for (const match of source.matchAll(generatedPattern)) {
      const relativePath = match[1];
      const expected = normalize(await readFile(join(appRoot, relativePath), "utf8"));
      const documented = normalize(match[2]);
      if (documented !== expected) fail(`${page} drifted from generated ${relativePath}`);
      if (generatedExamples.has(relativePath)) fail(`generated example is embedded more than once: ${relativePath}`);
      generatedExamples.add(relativePath);
    }
  }
  for (const expected of ["src/schema.ts", "src/queries.ts"]) {
    if (!generatedExamples.has(expected)) fail(`docs do not embed generated ${expected}`);
  }

  const quickstart = pageSources.get("quickstart") ?? "";
  requireInOrder(quickstart, [
    "bunx @chardb/core@0.1.0 init my-chardb-app",
    "cd my-chardb-app",
    "bun install",
    "bun run typecheck",
    "bun run test",
    "bun run build",
    "bun run dev",
  ], "quickstart command order");
  rejectText(quickstart, "mkdir my-chardb-app", "quickstart must let init create the directory");

  const generatedWrangler = await readFile(join(appRoot, "wrangler.toml"), "utf8");
  for (const binding of ["CDB_SHARD", "CDB_CATALOG", "CDB_GATEWAY", "CDB_RESHARD", "CDB_FILES"]) {
    requireText(generatedWrangler, binding, `generated Wrangler config is missing ${binding}`);
  }
  const generatedAuth = await readFile(join(appRoot, "src/auth.ts"), "utf8");
  const generatedSchema = await readFile(join(appRoot, "src/schema.ts"), "utf8");
  const generatedQueries = await readFile(join(appRoot, "src/queries.ts"), "utf8");
  const generatedApi = await readFile(join(appRoot, "src/api.ts"), "utf8");
  const generatedWeb = await readFile(join(appRoot, "src/web/App.tsx"), "utf8");
  const generatedTest = await readFile(join(appRoot, "test/worker.test.ts"), "utf8");
  const generatedVitest = await readFile(join(appRoot, "vitest.config.ts"), "utf8");
  requireText(generatedAuth, "organization()", "generated auth does not enable Better Auth organizations");
  requireText(generatedSchema, "forOrg()", "generated schema does not use organization ownership");
  requireText(generatedQueries, "api.query", "generated app has no read path");
  requireText(generatedApi, "api.mutation", "generated app has no write path");
  for (const feature of ["useQuery", "useMutation", "useFile", "upload(", "downloadUrl("]) {
    requireText(generatedWeb, feature, `generated browser app is missing ${feature}`);
  }
  requireText(generatedVitest, "cloudflareTest", "generated tests do not use Cloudflare Vitest");
  for (const proof of ["sign-in/anonymous", "organization/create", "organization/set-active", "/api/messages"]) {
    requireText(generatedTest, proof, `generated test is missing ${proof}`);
  }

  const serverTypes = await readFile(join(packageRoot, "dist/server/index.d.ts"), "utf8");
  const publicServerExport = [...serverTypes.matchAll(/^export \{([^}]+)\};$/gm)].at(-1)?.[1] ?? "";
  for (const symbol of ["api", "chardb", "defineAuth", "defineSchemaSnapshot", "forOrg", "forOrgUser"]) {
    requireText(publicServerExport, symbol, `server export is missing ${symbol}`);
  }
  for (const privateSymbol of ["forUser", "globalScope"]) {
    rejectText(publicServerExport, privateSymbol, `server publicly exports ${privateSymbol}`);
  }
  const sharedTypes = await firstFileContaining(join(packageRoot, "dist/shared"), "declare function searchVector");
  for (const vectorSurface of ["declare const vector", "set(column", "delete(column", "declare function searchVector"]) {
    requireText(sharedTypes, vectorSurface, `vector type surface is missing ${vectorSurface}`);
  }

  await linkGeneratedDependencies(appRoot, packageRoot);
  const editedSchema = generatedSchema.replace(
    '    createdAt: integer("created_at").notNull(),',
    '    createdAt: integer("created_at").notNull(),\n    editedAt: integer("edited_at"),',
  );
  if (editedSchema === generatedSchema) fail("migration probe could not edit the generated schema");
  await writeFile(join(appRoot, "src/schema.ts"), editedSchema);
  run(process.execPath, [cli, "migrations", "generate", "--name", "docs_probe"], appRoot);
  for (const output of ["src/migrations/v2.json", "src/migrations/v2.ts", "src/migrations.ts"]) {
    await stat(join(appRoot, output)).catch(() => fail(`migration generator did not write ${output}`));
  }
  requireText(await readFile(join(appRoot, "src/migrations/v2.ts"), "utf8"), "edited_at", "v2 migration lacks the additive column");

  const deploy = pageSources.get("deploy") ?? "";
  const cost = (await readFile(join(packageRoot, "COST.md"), "utf8")).toLowerCase();
  const operations = (await readFile(join(packageRoot, "OPERATIONS.md"), "utf8")).toLowerCase();
  for (const phrase of ["does not add a hosted-service charge", "does not publish a total monthly-cost claim"]) {
    requireText(cost, phrase, `candidate cost note is missing: ${phrase}`);
  }
  for (const phrase of ["there is no backup", "point-in-time recovery", "operator path, not automatic resharding"]) {
    requireText(operations, phrase, `candidate operations note is missing: ${phrase}`);
  }
  for (const claim of ["unmeasured", "no backup", "operator-driven"]) {
    requireText(deploy.toLowerCase(), claim, `deploy page is missing the ${claim} limit`);
  }

  const audit = await readFile(join(repositoryRoot, "DOCS_GAPS.md"), "utf8");
  for (const fact of [CANDIDATE.name, CANDIDATE.sha256, String(CANDIDATE.size), "creates the named directory"]) {
    requireText(audit, fact, `DOCS_GAPS.md is missing integration fact: ${fact}`);
  }

  const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (rootPackage.scripts?.["test:docs"]) fail("docs must not change the package scripts or release bytes");

  console.log(`docs contract passed: ${pageNames.length} pages, ${generatedExamples.size} exact generated examples`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`);
  }
  return result;
}

async function linkGeneratedDependencies(appRoot, packageRoot) {
  const nodeModules = join(appRoot, "node_modules");
  await mkdir(join(nodeModules, "@chardb"), { recursive: true });
  await symlink(packageRoot, join(nodeModules, "@chardb/core"), "dir");
  for (const dependency of ["better-auth", "drizzle-orm", "zod"]) {
    await symlink(join(repositoryRoot, "node_modules", dependency), join(nodeModules, dependency), "dir");
  }
}

async function firstFileContaining(directory, needle) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await firstFileContaining(path, needle).catch(() => null);
      if (nested) return nested;
    } else if (entry.name.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      if (source.includes(needle)) return source;
    }
  }
  fail(`could not find declaration containing ${needle}`);
}

function collectPages(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectPages(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.pages)) {
    for (const page of value.pages) {
      if (typeof page === "string") out.push(page);
      else collectPages(page, out);
    }
  }
  for (const key of ["groups", "tabs", "anchors", "dropdowns", "products", "versions", "languages"]) {
    if (key in value) collectPages(value[key], out);
  }
}

function requireInOrder(source, values, label) {
  let cursor = -1;
  for (const value of values) {
    const next = source.indexOf(value, cursor + 1);
    if (next === -1) fail(`${label} is missing or misorders ${value}`);
    cursor = next;
  }
}

function requireText(source, needle, message) {
  if (!source.includes(needle)) fail(message);
}

function rejectText(source, needle, message) {
  if (source.includes(needle)) fail(message);
}

function normalize(value) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function fail(message) {
  throw new Error(`docs contract: ${message}`);
}
