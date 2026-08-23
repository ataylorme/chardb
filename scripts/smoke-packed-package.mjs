import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOADABLE_EXPORTS = [
    ".",
    "./drizzle",
    "./files",
    "./cli",
    "./vite",
    "./miniflare-plugin",
    "./observability",
    "./reshard",
    "./eslint-plugin",
];

const RUNTIME_SPECIFIC_EXPORTS = new Map([
    ["./server", "requires the Cloudflare Workers runtime and the optional better-auth peer"],
    ["./auth", "requires the optional better-auth peer"],
    ["./files/zod", "requires the optional drizzle-zod and zod peers"],
    ["./files/typebox", "requires the optional drizzle-typebox and @sinclair/typebox peers"],
    ["./files/valibot", "requires the optional drizzle-valibot and valibot peers"],
    ["./files/arktype", "requires the optional drizzle-arktype and arktype peers"],
    ["./react", "requires the optional react peer"],
]);

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

    const packageJson = JSON.parse(await readFile(join(consumerDirectory, "node_modules/chardb/package.json"), "utf8"));
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
        exportPath === "." ? "chardb" : `chardb${exportPath.slice(1)}`
    );
    const importProgram = `for (const specifier of ${JSON.stringify(specifiers)}) { await import(specifier); console.log(\`imported \${specifier}\`); }`;
    run("bun", ["--eval", importProgram], consumerDirectory);

    for (const [exportPath, reason] of RUNTIME_SPECIFIC_EXPORTS) {
        console.log(`skipped chardb${exportPath.slice(1)}: ${reason}`);
    }
} finally {
    await rm(consumerDirectory, { recursive: true, force: true });
}

function run(command, args, cwd, extraEnvironment = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...extraEnvironment },
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${String(result.status)}`);
    }
}
