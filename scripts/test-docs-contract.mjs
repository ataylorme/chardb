import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(repositoryRoot, "docs");
const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "chardb-docs-contract-"));
try {
    const tarballPath = await resolveTarball(temporaryRoot);
    const tarball = await readFile(tarballPath).catch(() => fail(`cannot read packed artifact: ${tarballPath}`));
    const digest = createHash("sha256").update(tarball).digest("hex");

    run("tar", ["-xzf", tarballPath, "-C", temporaryRoot]);
    await symlink(join(repositoryRoot, "node_modules"), join(temporaryRoot, "node_modules"), "dir");

    const packageRoot = join(temporaryRoot, "package");
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (packageJson.name !== rootPackage.name || packageJson.version !== rootPackage.version) {
        fail(`packed identity is ${packageJson.name}@${packageJson.version}`);
    }
    const expectedExports = [".", "./server", "./internal/react", "./files", "./vite"];
    if (JSON.stringify(Object.keys(packageJson.exports)) !== JSON.stringify(expectedExports)) {
        fail(`public exports must be ${expectedExports.join(", ")}`);
    }

    const packageReadme = await readFile(join(packageRoot, "README.md"), "utf8");
    for (const stale of [
        /\bCandidate\d+\b/i,
        /\brelease candidate\b/i,
        /\bfinal candidate\b/i,
        /bun run (?:preview|proof|release):/i,
        /github\.com\/zpg6\/chardb\/blob\/main\//i,
        /Version two deliberately/i,
        /expanded deployed pass open/i,
    ]) {
        if (stale.test(packageReadme)) fail(`packed README contains stale release language: ${stale}`);
    }
    requireText(packageReadme, "@chardb/core", "packed README does not name the published package");
    requireText(packageReadme, "Better Auth", "packed README does not explain the auth integration");
    requireText(packageReadme, "Durable Objects", "packed README does not explain the storage runtime");

    const cli = join(packageRoot, "dist/cli/bin.mjs");
    const help = run(process.execPath, [cli, "--help"]).stdout;
    for (const command of [
        "init <name>",
        "doctor [wrangler]",
        "migrations generate",
        "vectorize prepare",
        "migrate --url",
    ]) {
        requireText(help, command, `CLI help is missing ${command}`);
    }
    rejectText(help, "experimental shards", "experimental range movement leaked into primary help");

    const init = run(process.execPath, [cli, "init", "my-chardb-app"], temporaryRoot);
    requireText(init.stdout, 'initialised "my-chardb-app"', "initializer did not report the created directory");
    const appRoot = join(temporaryRoot, "my-chardb-app");
    const generatedPackage = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
    if (generatedPackage.dependencies?.[rootPackage.name] !== rootPackage.version) {
        fail("generated app does not pin the packed package version");
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
        "plan-ahead",
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
    for (const stale of [
        /\bCandidate\d+\b/i,
        /\brelease candidate\b/i,
        /bun run (?:preview|proof|release):/i,
        /github\.com\/zpg6\/chardb\/blob\/main\//i,
        /Version two deliberately/i,
        /chardb experimental shards/i,
    ]) {
        if (stale.test(combined)) fail(`public docs contain stale or internal release language: ${stale}`);
    }
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
            if (generatedExamples.has(relativePath))
                fail(`generated example is embedded more than once: ${relativePath}`);
            generatedExamples.add(relativePath);
        }
    }
    for (const expected of ["src/schema.ts", "src/queries.ts"]) {
        if (!generatedExamples.has(expected)) fail(`docs do not embed generated ${expected}`);
    }

    const quickstart = pageSources.get("quickstart") ?? "";
    requireInOrder(
        quickstart,
        [
            `bunx ${rootPackage.name}@${rootPackage.version} init my-chardb-app`,
            "cd my-chardb-app",
            "bun install",
            "bun run typecheck",
            "bun run test",
            "bun run build",
            "bun run dev",
        ],
        "quickstart command order"
    );
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
    for (const vectorSurface of [
        "declare const vector",
        "set(column",
        "delete(column",
        "declare function searchVector",
    ]) {
        requireText(sharedTypes, vectorSurface, `vector type surface is missing ${vectorSurface}`);
    }

    await linkGeneratedDependencies(appRoot, packageRoot);
    const editedSchema = generatedSchema.replace(
        '    createdAt: integer("created_at").notNull(),',
        '    createdAt: integer("created_at").notNull(),\n    editedAt: integer("edited_at"),'
    );
    if (editedSchema === generatedSchema) fail("migration probe could not edit the generated schema");
    await writeFile(join(appRoot, "src/schema.ts"), editedSchema);
    run(process.execPath, [cli, "migrations", "generate", "--name", "docs_probe"], appRoot);
    for (const output of ["src/migrations/v2.json", "src/migrations/v2.ts", "src/migrations.ts"]) {
        await stat(join(appRoot, output)).catch(() => fail(`migration generator did not write ${output}`));
    }
    requireText(
        await readFile(join(appRoot, "src/migrations/v2.ts"), "utf8"),
        "edited_at",
        "v2 migration lacks the additive column"
    );

    const deploy = pageSources.get("deploy") ?? "";
    const cost = (await readFile(join(packageRoot, "COST.md"), "utf8")).toLowerCase();
    const operations = (await readFile(join(packageRoot, "OPERATIONS.md"), "utf8")).toLowerCase();
    for (const phrase of ["does not add a hosted-service charge", "does not publish a total monthly-cost claim"]) {
        requireText(cost, phrase, `packed cost note is missing: ${phrase}`);
    }
    for (const phrase of ["there is no backup", "point-in-time recovery"]) {
        requireText(operations, phrase, `packed operations note is missing: ${phrase}`);
    }
    for (const claim of ["unmeasured", "no backup", "automatic resharding"]) {
        requireText(deploy.toLowerCase(), claim, `deploy page is missing the ${claim} limit`);
    }

    const planAhead = pageSources.get("plan-ahead")?.toLowerCase() ?? "";
    for (const claim of [
        "independent source",
        "no supported backup, export, restore, or point-in-time recovery",
        "missing or corrupt data",
        "does not watch load or move ranges automatically",
    ]) {
        requireText(planAhead, claim, `plan-ahead page is missing the ${claim} limit`);
    }

    console.log(
        `docs contract passed: ${pageNames.length} pages, ${generatedExamples.size} generated examples, ${digest.slice(0, 12)} package`
    );
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}

async function resolveTarball(temporaryRoot) {
    const supplied = process.env.CHARDB_DOCS_TARBALL;
    if (supplied) return resolve(supplied);

    run("bun", ["pm", "pack", "--destination", temporaryRoot]);
    const tarballs = (await readdir(temporaryRoot))
        .filter(entry => entry.endsWith(".tgz"))
        .map(entry => join(temporaryRoot, entry));
    if (tarballs.length !== 1) fail(`expected one packed artifact, found ${tarballs.length}`);
    return tarballs[0];
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
