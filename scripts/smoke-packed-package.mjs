import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolateProcessTree } from "./process-lifecycle.mjs";

if (await isolateProcessTree(import.meta.url, { label: "packed package smoke", timeoutMs: 5 * 60_000 })) {
    process.exit(0);
}

const LOADABLE_EXPORTS = [".", "./files", "./vite"];
const COMMAND_TIMEOUT_MS = 3 * 60_000;

const RUNTIME_SPECIFIC_EXPORTS = new Map([
    ["./server", "requires the Cloudflare Workers runtime and the optional better-auth peer"],
    ["./react", "requires the optional react peer"],
]);

const REMOVED_EXPORTS = [
    "./auth",
    "./cli",
    "./drizzle",
    "./eslint-plugin",
    "./files/arktype",
    "./files/typebox",
    "./files/valibot",
    "./files/zod",
    "./miniflare-plugin",
    "./observability",
    "./reshard",
];

const tarballArgument = process.argv[2];
if (!tarballArgument) {
    throw new Error("usage: bun scripts/smoke-packed-package.mjs <package.tgz>");
}

const tarballPath = resolve(tarballArgument);
const consumerDirectory = await mkdtemp(join(tmpdir(), "chardb-package-consumer-"));

try {
    await writeFile(
        join(consumerDirectory, "package.json"),
        `${JSON.stringify({ name: "chardb-package-consumer", private: true, type: "module" }, null, 2)}\n`
    );
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], consumerDirectory, {
        npm_config_cache: join(consumerDirectory, ".npm-cache"),
    });

    const packageJson = JSON.parse(
        await readFile(join(consumerDirectory, "node_modules/@chardb/core/package.json"), "utf8")
    );
    const advertisedExports = Object.keys(packageJson.exports);
    const accountedFor = new Set([...LOADABLE_EXPORTS, ...RUNTIME_SPECIFIC_EXPORTS.keys()]);
    const missingChecks = advertisedExports.filter(exportPath => !accountedFor.has(exportPath));
    const staleChecks = [...accountedFor].filter(exportPath => !advertisedExports.includes(exportPath));
    if (missingChecks.length > 0 || staleChecks.length > 0) {
        throw new Error(
            `package export smoke list is stale; missing checks: ${missingChecks.join(", ") || "none"}; stale checks: ${staleChecks.join(", ") || "none"}`
        );
    }

    const specifiers = LOADABLE_EXPORTS.map(exportPath =>
        exportPath === "." ? "@chardb/core" : `@chardb/core${exportPath.slice(1)}`
    );
    const importProgram = `for (const specifier of ${JSON.stringify(specifiers)}) { await import(specifier); console.log(\`imported \${specifier}\`); }`;
    run("bun", ["--eval", importProgram], consumerDirectory);

    const rejectionProgram = `
      for (const exportPath of ${JSON.stringify(REMOVED_EXPORTS)}) {
        const specifier = "@chardb/core" + exportPath.slice(1);
        try {
          await import(specifier);
          throw new Error("unexpectedly imported " + specifier);
        } catch (error) {
          if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
          console.log("rejected " + specifier);
        }
      }
    `;
    run("node", ["--eval", rejectionProgram], consumerDirectory);

    for (const [exportPath, reason] of RUNTIME_SPECIFIC_EXPORTS) {
        console.log(`skipped @chardb/core${exportPath.slice(1)}: ${reason}`);
    }
} finally {
    await rm(consumerDirectory, { recursive: true, force: true });
}

function run(command, args, cwd, extraEnvironment = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...extraEnvironment },
        stdio: "inherit",
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: "SIGTERM",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${String(result.status)}`);
    }
}
