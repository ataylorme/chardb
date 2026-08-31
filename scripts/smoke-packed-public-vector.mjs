import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { fingerprintFile, writeJsonAtomically } from "./browser-proof-report.mjs";
import {
    PACKED_LOCAL_VECTOR_CAPABILITY,
    PACKED_PUBLIC_VECTOR_SCHEMA,
    assertPackedPublicVectorBrowserProof,
    assertPackedPublicVectorBundle,
} from "./packed-public-vector-contract.mjs";
import { isolateProcessTree, settleBounded } from "./process-lifecycle.mjs";

if (await isolateProcessTree(import.meta.url, { label: "packed public vector smoke", timeoutMs: 15 * 60_000 })) {
    process.exit(0);
}

const { tarballArgument, reportArgument } = parseArgs(process.argv.slice(2));

const tarballPath = resolve(tarballArgument);
const scratch = await mkdtemp(join(tmpdir(), "chardb-packed-public-vector-"));
const project = join(scratch, "app");
let browser;
let server;
let passed = false;

try {
    await writeFixture(project, tarballPath);
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], project);
    const doctor = join(project, "node_modules", ".bin", "chardb");
    assertDoctor(runCapture(doctor, ["doctor"], project), "wrangler.toml");
    await rename(join(project, "wrangler.toml"), join(project, "wrangler.toml.accepted"));
    assertDoctor(runCapture(doctor, ["doctor"], project), "wrangler.json");
    await rename(join(project, "wrangler.json"), join(project, "wrangler.json.accepted"));
    assertDoctor(runCapture(doctor, ["doctor"], project), "wrangler.jsonc");
    await rename(join(project, "wrangler.jsonc"), join(project, "wrangler.jsonc.accepted"));
    await assertPackedVectorCliContract(project, doctor);
    run(join(project, "node_modules", ".bin", "tsc"), ["--noEmit"], project);
    run(join(project, "node_modules", ".bin", "vite"), ["build"], project);

    const bundle = await readBrowserBundle(project);
    assertPackedPublicVectorBundle(bundle);

    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const url = new URL(request.url);
            const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
            if (relativePath.includes("..")) return new Response("not found", { status: 404 });
            const file = Bun.file(join(project, "dist", relativePath));
            if (!(await file.exists())) return new Response("not found", { status: 404 });
            return new Response(file);
        },
    });

    browser = await chromium.launch({ executablePath: findChrome(), headless: true });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", error => browserErrors.push(String(error)));
    page.on("console", message => {
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
            browserErrors.push(message.text());
        }
    });
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => globalThis.__packedPublicVectorProof?.done === true, undefined, {
        timeout: 15_000,
    });
    const proof = await page.evaluate(() => globalThis.__packedPublicVectorProof);
    if (browserErrors.length > 0) throw new Error(`browser emitted errors: ${JSON.stringify(browserErrors)}`);
    assertPackedPublicVectorBrowserProof(proof);
    const installedPackage = JSON.parse(
        await readFile(join(project, "node_modules", "@chardb", "core", "package.json"), "utf8")
    );
    if (installedPackage?.name !== "@chardb/core" || typeof installedPackage.version !== "string") {
        throw new Error("installed packed public vector candidate has an invalid package identity");
    }

    const report = {
        schema: PACKED_PUBLIC_VECTOR_SCHEMA,
        ok: true,
        package: {
            name: installedPackage.name,
            version: installedPackage.version,
            filename: basename(tarballPath),
            tarball: await fingerprintFile(tarballPath),
        },
        capability: PACKED_LOCAL_VECTOR_CAPABILITY,
        proof,
    };
    if (reportArgument) await writeJsonAtomically(resolve(reportArgument), report);
    console.log(JSON.stringify(report));
    passed = true;
} finally {
    const cleanupFailures = [];
    if (browser) {
        try {
            await settleBounded(() => browser.close(), {
                label: "packed public vector Chromium close",
                timeoutMs: 5_000,
            });
        } catch (error) {
            cleanupFailures.push(error);
        }
    }
    if (server) {
        try {
            await settleBounded(() => server.stop(true), {
                label: "packed public vector server stop",
                timeoutMs: 5_000,
            });
        } catch (error) {
            cleanupFailures.push(error);
        }
    }
    try {
        if (!passed && process.env.CDB_PACKED_PUBLIC_VECTOR_KEEP_SCRATCH === "1") {
            console.error(`packed public vector scratch retained at ${scratch}`);
        } else {
            await settleBounded(() => rm(scratch, { recursive: true, force: true }), {
                label: "packed public vector scratch cleanup",
                timeoutMs: 5_000,
            });
        }
    } catch (error) {
        cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
        console.error(new AggregateError(cleanupFailures, "packed public vector cleanup failed"));
        process.exitCode = 1;
    }
}

function parseArgs(argv) {
    const [tarball, ...rest] = argv;
    if (!tarball) {
        throw new Error("usage: bun scripts/smoke-packed-public-vector.mjs <package.tgz> [--report <path>]");
    }
    let report;
    for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];
        if (argument !== "--report") {
            throw new Error(`unknown packed public vector argument ${JSON.stringify(argument)}`);
        }
        const value = rest[++index];
        if (!value) throw new Error("--report requires a path");
        if (report !== undefined) throw new Error("--report may be provided only once");
        report = value;
    }
    return { tarballArgument: tarball, reportArgument: report };
}

async function writeFixture(cwd, packageTarball) {
    await mkdir(join(cwd, "src", "web"), { recursive: true });
    const files = {
        "package.json": `${JSON.stringify(
            {
                name: "chardb-packed-public-vector-proof",
                private: true,
                type: "module",
                dependencies: {
                    "better-auth": "1.6.30",
                    "@chardb/core": `file:${packageTarball}`,
                    "drizzle-orm": "0.45.2",
                    react: "18.3.1",
                    "react-dom": "18.3.1",
                    zod: "4.4.3",
                },
                devDependencies: {
                    "@cloudflare/workers-types": "5.20260820.1",
                    "@types/react": "18.3.31",
                    "@types/react-dom": "18.3.7",
                    typescript: "5.9.3",
                    vite: "8.2.2",
                },
            },
            null,
            2
        )}\n`,
        "tsconfig.json": `${JSON.stringify(
            {
                compilerOptions: {
                    lib: ["ES2023", "DOM", "DOM.Iterable"],
                    target: "ES2022",
                    module: "ESNext",
                    moduleResolution: "Bundler",
                    moduleDetection: "force",
                    allowImportingTsExtensions: true,
                    verbatimModuleSyntax: true,
                    noEmit: true,
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noUncheckedIndexedAccess: true,
                    skipLibCheck: true,
                    isolatedModules: true,
                    jsx: "react-jsx",
                    types: ["@cloudflare/workers-types"],
                },
                include: ["src/**/*.ts", "src/**/*.tsx"],
            },
            null,
            2
        )}\n`,
        "vite.config.ts": `
import { chardb } from "@chardb/core/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [chardb()],
  build: { outDir: "dist", emptyOutDir: true, minify: false },
});
`,
        "wrangler.toml": `
name = "chardb-packed-public-vector-proof"
main = "src/worker.ts"
compatibility_date = "2026-08-20"
compatibility_flags = ["nodejs_compat"]

[[migrations]]
tag = "init"
new_sqlite_classes = ["Cdb", "Catalog", "Gateway", "Resharder"]

[[durable_objects.bindings]]
name = "CDB_CATALOG"
class_name = "Catalog"

[[durable_objects.bindings]]
name = "CDB_SHARD"
class_name = "Cdb"

[[durable_objects.bindings]]
name = "CDB_GATEWAY"
class_name = "Gateway"

[[durable_objects.bindings]]
name = "CDB_RESHARD"
class_name = "Resharder"

[[vectorize]]
binding = "CDB_MESSAGES_VECTOR_INDEX"
index_name = "packed-vector-dx-proof"
remote = true

[assets]
directory = "dist"
run_worker_first = ["/_chardb/*", "/api/*", "/health", "/ws"]

[observability.logs]
enabled = true

[observability.traces]
enabled = true
`,
        "wrangler.json": `${JSON.stringify(
            {
                name: "chardb-packed-public-vector-proof",
                main: "src/worker.ts",
                compatibility_date: "2026-08-20",
                compatibility_flags: ["nodejs_compat"],
                migrations: [{ tag: "init", new_sqlite_classes: ["Cdb", "Catalog", "Gateway", "Resharder"] }],
                durable_objects: {
                    bindings: [
                        { name: "CDB_CATALOG", class_name: "Catalog" },
                        { name: "CDB_SHARD", class_name: "Cdb" },
                        { name: "CDB_GATEWAY", class_name: "Gateway" },
                        { name: "CDB_RESHARD", class_name: "Resharder" },
                    ],
                },
                vectorize: [
                    { binding: "CDB_MESSAGES_VECTOR_INDEX", index_name: "packed-vector-dx-proof", remote: true },
                ],
                assets: {
                    directory: "dist",
                    run_worker_first: ["/_chardb/*", "/api/*", "/health", "/ws"],
                },
                observability: { logs: { enabled: true }, traces: { enabled: true } },
            },
            null,
            2
        )}\n`,
        "wrangler.jsonc": `// JSONC uses the same remote-only Vectorize contract.\n${JSON.stringify(
            {
                name: "chardb-packed-public-vector-proof",
                main: "src/worker.ts",
                compatibility_date: "2026-08-20",
                compatibility_flags: ["nodejs_compat"],
                migrations: [{ tag: "init", new_sqlite_classes: ["Cdb", "Catalog", "Gateway", "Resharder"] }],
                durable_objects: {
                    bindings: [
                        { name: "CDB_CATALOG", class_name: "Catalog" },
                        { name: "CDB_SHARD", class_name: "Cdb" },
                        { name: "CDB_GATEWAY", class_name: "Gateway" },
                        { name: "CDB_RESHARD", class_name: "Resharder" },
                    ],
                },
                vectorize: [
                    { binding: "CDB_MESSAGES_VECTOR_INDEX", index_name: "packed-vector-dx-proof", remote: true },
                ],
                assets: {
                    directory: "dist",
                    run_worker_first: ["/_chardb/*", "/api/*", "/health", "/ws"],
                },
                observability: { logs: { enabled: true }, traces: { enabled: true } },
            },
            null,
            2
        )}\n`,
        "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>packed public vector proof</title></head>
  <body>
    <div id="root"></div>
    <script>
      window.__packedPublicVectorProof = {
        schema: "${PACKED_PUBLIC_VECTOR_SCHEMA}",
        queryRef: null,
        queryArgs: null,
        observations: [],
        sent: [],
        done: false
      };
      class BrowserProofWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = BrowserProofWebSocket.CONNECTING;
        onopen = null;
        onclose = null;
        onmessage = null;
        onerror = null;
        subscriptionCount = 0;
        constructor(url) {
          this.url = url;
          queueMicrotask(() => {
            this.readyState = BrowserProofWebSocket.OPEN;
            this.onopen?.({ type: "open" });
          });
        }
        send(raw) {
          const message = JSON.parse(raw);
          window.__packedPublicVectorProof.sent.push(message);
          if (message.t === "hello") {
            queueMicrotask(() => this.emit({
              t: "welcome", protocolV: 3, baseCookie: "browser-proof:0", region: "browser-proof"
            }));
            return;
          }
          if (message.t === "sub") {
            this.subscriptionCount++;
            window.__packedPublicVectorProof.queryRef = message.ref;
            window.__packedPublicVectorProof.queryArgs = message.args;
            const first = this.subscriptionCount === 1;
            setTimeout(() => this.emit({
              t: "snapshot",
              subId: message.subId,
              cookie: first ? "browser-proof:1" : "browser-proof:2",
              rows: first
                ? [{ rowPk: "message-a", score: 0.98 }]
                : [{ rowPk: "message-b", score: 0.91 }]
            }), first ? 30 : 80);
            return;
          }
          if (message.t === "ack" && message.cookie === "browser-proof:1") {
            setTimeout(() => this.emit({ t: "mustRefetch", subIds: [1], reason: "lagged" }), 30);
          }
        }
        close() {
          this.readyState = BrowserProofWebSocket.CLOSED;
          queueMicrotask(() => this.onclose?.({ type: "close" }));
        }
        emit(message) {
          this.onmessage?.({ data: JSON.stringify(message) });
        }
      }
      window.WebSocket = BrowserProofWebSocket;
    </script>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
`,
        "src/auth.ts": `
import { organization } from "better-auth/plugins/organization";
import { defineAuth } from "@chardb/core/server";

export const auth = defineAuth({
  appName: "chardb-packed-public-vector-proof",
  plugins: [organization()],
});
`,
        "src/schema.ts": `
import { forOrg, vector } from "@chardb/core/server";
import { text } from "drizzle-orm/sqlite-core";
import { auth } from "./auth.ts";

const { cdbTable } = forOrg();
export const messages = cdbTable("messages", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => auth.organization.id),
  body: text("body").notNull(),
  embedding: vector("embedding", { dim: 3, binding: "CDB_MESSAGES_VECTOR_INDEX", metric: "cosine" }),
}, { roles: { member: { create: "*", read: "*", update: "*", delete: true } } });
`,
        "src/mutations.ts": `
import { api } from "@chardb/core/server";
import { z } from "zod";
import { messages } from "./schema.ts";

export const putMessage = api.mutation({
  ref: "src/mutations.ts#putMessage",
  args: z.object({
    organizationId: z.string(),
    id: z.string(),
    body: z.string(),
    values: z.array(z.number()).length(3),
  }),
  authority: "organization",
  partitionKey: "organizationId",
  handler: (ctx, args) => {
    const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
    ctx.db.insert(messages).values({ id: args.id, body: args.body, embedding }).run();
    return { id: args.id };
  },
});
`,
        "src/queries.ts": `
import { api, searchVector } from "@chardb/core/server";
import { z } from "zod";
import { messages } from "./schema.ts";

const serverOnly = "PUBLIC_VECTOR_SERVER_CALLBACK_SENTINEL";
export const searchMessages = api.query({
  ref: "src/queries.ts#searchMessages",
  args: z.object({
    organizationId: z.string(),
    values: z.array(z.number()).length(3),
    limit: z.number().int().min(1).max(100),
  }),
  query: (_db, args) => {
    void serverOnly;
    return searchVector(messages.embedding, args);
  },
});
`,
        "src/public-boundary.ts": `
import { api, defineAuth, forOrg, searchVector, vector } from "@chardb/core/server";
// @ts-expect-error Internal mutation binding must not be public.
import { bindCdbVectorMutationContext } from "@chardb/core/server";
// @ts-expect-error Internal logical ids must not be public.
import { cdbVectorLogicalId } from "@chardb/core/server";
// @ts-expect-error Internal query builder guards must not be public.
import { isChardbVectorSearchBuilder } from "@chardb/core/server";
// @ts-expect-error Internal query builder normalization must not be public.
import { normalizeChardbVectorSearchBuilder } from "@chardb/core/server";
// @ts-expect-error Internal descriptors must not be public.
import { resolveOrganizationVectorResourceDescriptor } from "@chardb/core/server";

void [
  api,
  defineAuth,
  forOrg,
  searchVector,
  vector,
  bindCdbVectorMutationContext,
  cdbVectorLogicalId,
  isChardbVectorSearchBuilder,
  normalizeChardbVectorSearchBuilder,
  resolveOrganizationVectorResourceDescriptor,
];
`,
        "src/web/App.tsx": `
import { createChardbClient } from "@chardb/core";
import { ChardbProvider, useQuery } from "@chardb/core/react";
import { useEffect } from "react";
import { searchMessages } from "../queries.ts";

declare global {
  var __packedPublicVectorProof: {
    schema: string;
    queryRef: string | null;
    queryArgs: unknown;
    observations: unknown[];
    sent: unknown[];
    done: boolean;
  };
}

const queryArgs = { organizationId: "org-browser-proof", values: [1, 0, 0], limit: 5 };
const client = createChardbClient({
  endpoint: "ws://proof.invalid/ws",
  clientId: "browser-proof",
  getJwt: async () => "proof.jwt.value",
});

function Results() {
  const result = useQuery(searchMessages, queryArgs);
  const rows = result.data ?? [];
  useEffect(() => {
    globalThis.__packedPublicVectorProof.observations.push({ state: result.state, rows });
    if (result.state === "live" && rows[0]?.rowPk === "message-b") {
      globalThis.__packedPublicVectorProof.done = true;
    }
  }, [result.state, rows]);
  return <output data-testid="vector-results" data-state={result.state}>{JSON.stringify(rows)}</output>;
}

export function App() {
  return <ChardbProvider client={client}><Results /></ChardbProvider>;
}
`,
        "src/web/main.tsx": `
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing root");
createRoot(root).render(<App />);
`,
    };

    await Promise.all(
        Object.entries(files).map(async ([path, contents]) => {
            const target = join(cwd, path);
            await mkdir(join(target, ".."), { recursive: true });
            await writeFile(target, contents.trimStart());
        })
    );
}

async function readBrowserBundle(cwd) {
    const assetDirectory = join(cwd, "dist", "assets");
    const assets = await readdir(assetDirectory);
    const javascript = assets.filter(file => file.endsWith(".js"));
    if (javascript.length === 0) throw new Error("Vite emitted no browser JavaScript");
    return (await Promise.all(javascript.map(file => readFile(join(assetDirectory, file), "utf8")))).join("\n");
}

async function assertPackedVectorCliContract(cwd, doctor) {
    const sources = {
        "wrangler.toml": await readFile(join(cwd, "wrangler.toml.accepted"), "utf8"),
        "wrangler.json": await readFile(join(cwd, "wrangler.json.accepted"), "utf8"),
        "wrangler.jsonc": await readFile(join(cwd, "wrangler.jsonc.accepted"), "utf8"),
    };
    for (const [name, source] of Object.entries(sources)) {
        const isToml = name.endsWith(".toml");
        const cases = isToml
            ? [source.replace("remote = true", "remote = false"), source.replace("\nremote = true", "")]
            : [source.replace('"remote": true', '"remote": false'), source.replace(/,\n\s+"remote": true/, "")];
        for (const config of cases) {
            if (config === source) throw new Error(`packed ${name} Vectorize mutation did not change its source`);
            await writeFile(join(cwd, name), config);
            const result = runCaptureRaw(doctor, ["doctor"], cwd);
            if (
                result.status === 0 ||
                !result.stderr.includes("Vectorize does not support local development; set remote = true")
            ) {
                throw new Error(
                    `packed doctor accepted a non-remote Vectorize binding in ${name}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
                );
            }
        }
        await rm(join(cwd, name), { force: true });
    }

    await rename(join(cwd, "wrangler.toml.accepted"), join(cwd, "wrangler.toml"));
    const wranglerModule = join(cwd, "node_modules", "wrangler", "bin", "wrangler.js");
    await mkdir(join(cwd, "node_modules", "wrangler", "bin"), { recursive: true });
    const token = "packed_cloudflare_token_that_must_never_escape_123456789";
    const apiKey = "short-cloudflare-key";
    const clientSecret = "short-client-secret";
    const account = "0123456789abcdef0123456789abcdef";
    const credentialPath = "/Users/alice/.wrangler/config";
    const windowsCredentialPath = "C:\\Users\\alice\\.wrangler\\config";
    const diagnostic = [
        "x".repeat(8_192),
        JSON.stringify({ authorization: `Bearer ${token}` }),
        `CLOUDFLARE_API_KEY=${apiKey}`,
        `client_secret=${clientSecret}`,
        `account: ${account}`,
        `credentials: ${credentialPath}`,
        `credentials: ${windowsCredentialPath}`,
        "vectorize.index.not_found: packed-vector-dx-proof does not exist",
    ].join("\n");
    await writeFile(
        wranglerModule,
        `process.stderr.write(${JSON.stringify(`${diagnostic}\n`)}); process.exitCode = 23;\n`
    );
    const prepare = runCaptureRaw(doctor, ["vectorize", "prepare"], cwd);
    if (
        prepare.status === 0 ||
        !prepare.stdout.includes("remote Cloudflare provider operation") ||
        !prepare.stderr.includes("vectorize.index.not_found: packed-vector-dx-proof does not exist") ||
        !prepare.stderr.includes("Wrangler output tail:") ||
        prepare.stderr.includes(token) ||
        prepare.stderr.includes(apiKey) ||
        prepare.stderr.includes(clientSecret) ||
        prepare.stderr.includes(account) ||
        prepare.stderr.includes(credentialPath) ||
        prepare.stderr.includes(windowsCredentialPath) ||
        new TextEncoder().encode(prepare.stderr).byteLength > 4_700
    ) {
        throw new Error(
            `packed vectorize prepare did not emit a bounded redacted actionable tail; stdout=${JSON.stringify(prepare.stdout)} stderr=${JSON.stringify(prepare.stderr)}`
        );
    }
}

function findChrome() {
    const candidates = [
        process.env.CHARDB_BROWSER_EXECUTABLE,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ].filter(Boolean);
    const found = candidates.find(candidate => existsSync(candidate));
    if (!found) throw new Error("Chrome not found. Set CHARDB_BROWSER_EXECUTABLE to a Chrome or Chromium binary.");
    return found;
}

function run(command, args, cwd) {
    const environment = { ...process.env, npm_config_cache: join(scratch, "npm-cache") };
    for (const variable of [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_EMAIL",
        "CF_API_KEY",
        "CF_API_TOKEN",
        "CF_EMAIL",
    ]) {
        delete environment[variable];
    }
    const result = spawnSync(command, args, { cwd, env: environment, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`);
}

function runCapture(command, args, cwd) {
    const result = runCaptureRaw(command, args, cwd);
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${String(result.status)}: ${result.stderr}`);
    }
    return result;
}

function runCaptureRaw(command, args, cwd) {
    const environment = { ...process.env, npm_config_cache: join(scratch, "npm-cache") };
    for (const variable of [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_EMAIL",
        "CF_API_KEY",
        "CF_API_TOKEN",
        "CF_EMAIL",
    ]) {
        delete environment[variable];
    }
    const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
}

function assertDoctor(result, config) {
    if (!result.stdout.includes(`chardb doctor: ${config} passes`)) {
        throw new Error(`packed doctor did not accept ${config}`);
    }
    if (
        !result.stderr.includes("uses the real remote Cloudflare index") ||
        !result.stderr.includes("Miniflare does not emulate Vectorize")
    ) {
        throw new Error(
            `packed doctor did not state the remote-only Vectorize contract for ${config}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
        );
    }
}
