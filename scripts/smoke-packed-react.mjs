import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const [coreArgument, reactArgument] = process.argv.slice(2);
if (!coreArgument || !reactArgument) {
    throw new Error("usage: bun scripts/smoke-packed-react.mjs <core.tgz> <react.tgz>");
}

const coreTarball = resolve(coreArgument);
const reactTarball = resolve(reactArgument);
const directory = await mkdtemp(join(tmpdir(), "chardb-react-consumer-"));
const npmCache = join(directory, "npm-cache");

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: npmCache },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
    }
}

try {
    await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify(
            {
                name: "chardb-react-packed-consumer",
                private: true,
                type: "module",
                dependencies: {
                    "@chardb/core": `file:${coreTarball}`,
                    "@chardb/react": `file:${reactTarball}`,
                    "better-auth": "1.6.30",
                    "drizzle-orm": "0.45.2",
                    react: "18.3.1",
                    "react-dom": "18.3.1",
                    "@types/react-dom": "18.3.7",
                    typescript: "5.9.3",
                },
            },
            null,
            2
        )}\n`
    );
    await writeFile(
        join(directory, "index.tsx"),
        `import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createChardbReactClient } from "@chardb/react";

let authBaseURL: string | undefined;
const auth = {
  async $fetch<T>() { return { data: { token: "test" } as T, error: null }; },
  $store: { atoms: { session: {
    get: () => ({ data: null, isPending: false }),
    subscribe: () => () => {},
  } } },
};
const db = createChardbReactClient({
  url: "https://db.example.com/api/../",
  ownership: "user",
  auth: ({ baseURL }) => {
    authBaseURL = baseURL;
    return auth;
  },
});
if (authBaseURL !== "https://db.example.com") throw new Error("React SDK split auth from the Worker URL");
if (db.auth !== auth || db.url !== authBaseURL) throw new Error("React SDK replaced the configured auth connection");
const html = renderToString(createElement(db.Provider, null, createElement("main", null, "ready")));
if (!html.includes("ready")) throw new Error("packed Provider did not render");
`
    );
    await writeFile(
        join(directory, "tsconfig.json"),
        `${JSON.stringify(
            {
                compilerOptions: {
                    target: "ES2022",
                    module: "ESNext",
                    moduleResolution: "Bundler",
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                    jsx: "react-jsx",
                },
                include: ["index.tsx"],
            },
            null,
            2
        )}\n`
    );

    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    run("npm", ["exec", "--", "tsc", "--noEmit"]);
    run("bun", ["index.tsx"]);

    const coreManifest = JSON.parse(
        await readFile(join(directory, "node_modules", "@chardb", "core", "package.json"), "utf8")
    );
    if (coreManifest.exports?.["./react"] !== undefined) {
        throw new Error("packed @chardb/core still publishes the removed ./react entry");
    }
    const reactManifest = JSON.parse(
        await readFile(join(directory, "node_modules", "@chardb", "react", "package.json"), "utf8")
    );
    if (reactManifest.name !== "@chardb/react") throw new Error("installed the wrong React package");
    process.stdout.write(`packed React SDK passed: ${basename(coreTarball)} + ${basename(reactTarball)}\n`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
