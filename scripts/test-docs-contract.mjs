import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(repositoryRoot, "docs");
const config = JSON.parse(await readFile(join(docsRoot, "docs.json"), "utf8"));

const pageNames = [];
collectPages(config.navigation, pageNames);
if (pageNames.length === 0) fail("docs.json has no navigation pages");

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

for (const [page, source] of pageSources) {
    for (const match of source.matchAll(/\]\(\/([^\s)#]+)(?:#[^)]+)?\)/g)) {
        const target = match[1];
        if (!pageNames.includes(target)) fail(`${page} links to a page outside navigation: ${target}`);
    }
}

const contractedExamples = new Set();
const contractPattern = /\{\/\* contract: ([^\s]+) \*\/\}\s*```[^\n]*\n([\s\S]*?)\n```/g;
for (const [page, source] of pageSources) {
    for (const match of source.matchAll(contractPattern)) {
        const relative = match[1];
        const expected = normalize(await readFile(join(docsRoot, relative), "utf8"));
        const documented = normalize(match[2]);
        if (documented !== expected) fail(`${page} drifted from ${relative}`);
        if (contractedExamples.has(relative)) fail(`example is embedded more than once: ${relative}`);
        contractedExamples.add(relative);
    }
}

const examplesRoot = join(repositoryRoot, "docs-examples");
const exampleFiles = await listFiles(examplesRoot);
for (const path of exampleFiles) {
    const contractPath = relative(docsRoot, path);
    if (!contractedExamples.has(contractPath)) fail(`example is not embedded in a docs page: ${contractPath}`);
}

const wrangler = await readFile(join(examplesRoot, "generated-app/wrangler.toml"), "utf8");
for (const required of [
    'name = "CDB_CATALOG"',
    'name = "CDB_SHARD"',
    'name = "CDB_GATEWAY"',
    'name = "CDB_RESHARD"',
    'binding = "CDB_FILES"',
    'run_worker_first = ["/_chardb/*", "/api/*", "/health", "/ws"]',
]) {
    if (!wrangler.includes(required)) fail(`golden Wrangler config is missing ${required}`);
}
for (const required of ["Cdb", "Catalog", "Gateway", "Resharder"]) {
    if (!wrangler.includes(`"${required}"`)) fail(`golden Wrangler config is missing ${required}`);
}

const quickstart = pageSources.get("quickstart") ?? "";
for (const command of [
    "mkdir my-chardb-app",
    "cd my-chardb-app",
    "bunx @chardb/core@0.1.0 init my-chardb-app",
    "bun install",
    "bun run typecheck",
    "bun run test",
    "bun run build",
    "bun run dev",
]) {
    if (!quickstart.includes(command)) fail(`quickstart is missing ${command}`);
}

for (const unsupported of ["backup create", "backup verify", "restore --from", "automatic sharding"]) {
    if (combined.includes(unsupported)) fail(`public docs advertise an unsupported path: ${unsupported}`);
}

const integration = await readFile(join(repositoryRoot, "DOCS_GAPS.md"), "utf8");
for (const required of [
    "@chardb/core",
    "5da0a1ba1dfbabe06ecd0f6a6b7010e967fd82b791c312f926ba62da53faa338",
    "current empty directory",
]) {
    if (!integration.includes(required)) fail(`DOCS_GAPS.md is missing integration fact: ${required}`);
}

console.log(`docs contract passed: ${pageNames.length} pages, ${contractedExamples.size} embedded files`);

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

async function listFiles(directory) {
    const out = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) out.push(...(await listFiles(path)));
        else out.push(path);
    }
    return out;
}

function normalize(value) {
    return value.replace(/\r\n/g, "\n").trimEnd();
}

function fail(message) {
    throw new Error(`docs contract: ${message}`);
}
