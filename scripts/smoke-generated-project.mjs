import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarballArgument = process.argv[2];
if (!tarballArgument) {
    throw new Error("usage: bun scripts/smoke-generated-project.mjs <package.tgz>");
}

const tarballPath = resolve(tarballArgument);
const smokeDirectory = await mkdtemp(join(tmpdir(), "chardb-generated-project-"));
const bootstrapDirectory = join(smokeDirectory, "bootstrap");
const projectDirectory = join(smokeDirectory, "generated-app");
const npmCache = join(smokeDirectory, "npm-cache");
const environment = {
    npm_config_cache: npmCache,
    WRANGLER_LOG_PATH: join(smokeDirectory, "wrangler.log"),
    WRANGLER_SEND_METRICS: "false",
};

try {
    await mkdir(bootstrapDirectory, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
        join(bootstrapDirectory, "package.json"),
        `${JSON.stringify({ name: "chardb-init-bootstrap", private: true }, null, 2)}\n`
    );
    run(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
        bootstrapDirectory,
        environment
    );
    run(
        join(bootstrapDirectory, "node_modules", ".bin", "chardb"),
        ["init", "generated-app"],
        projectDirectory,
        environment
    );

    const installedChardb = JSON.parse(
        await readFile(join(bootstrapDirectory, "node_modules", "chardb", "package.json"), "utf8")
    );
    const packageJsonPath = join(projectDirectory, "package.json");
    const generatedPackageJson = await readFile(packageJsonPath, "utf8");
    const generatedTsconfig = await readFile(join(projectDirectory, "tsconfig.json"), "utf8");
    rejectMonorepoAliases(`${generatedPackageJson}\n${generatedTsconfig}`);

    const packageJson = JSON.parse(generatedPackageJson);
    if (packageJson.dependencies.chardb !== installedChardb.version) {
        throw new Error(
            `generated chardb version ${String(packageJson.dependencies.chardb)} does not match CLI version ${String(installedChardb.version)}`
        );
    }
    assertExactDependencyVersions(packageJson);
    packageJson.dependencies.chardb = `file:${tarballPath}`;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    if (!JSON.stringify(packageJson).includes(`file:${tarballPath}`)) {
        throw new Error("generated package.json does not consume the packed chardb tarball");
    }
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], projectDirectory, environment);
    run("npm", ["run", "typecheck"], projectDirectory, environment);
    run("npm", ["run", "build"], projectDirectory, environment);
    run(
        join(projectDirectory, "node_modules", ".bin", "chardb"),
        ["doctor", "wrangler"],
        projectDirectory,
        environment
    );

    console.log("generated project passed install, typecheck, Wrangler build, and chardb doctor");
} finally {
    await rm(smokeDirectory, { recursive: true, force: true });
}

function rejectMonorepoAliases(generatedConfigText) {
    for (const forbidden of ["workspace:", '"paths"', '"baseUrl"']) {
        if (generatedConfigText.includes(forbidden)) {
            throw new Error(`generated config contains forbidden monorepo reference: ${forbidden}`);
        }
    }
    if (!projectDirectory.startsWith(tmpdir())) {
        throw new Error("generated project is not isolated under the system temporary directory");
    }
}

function assertExactDependencyVersions(packageJson) {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const [name, version] of Object.entries(dependencies)) {
        if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
            throw new Error(`generated dependency ${name} is not pinned to an exact version: ${String(version)}`);
        }
    }
}

function run(command, args, cwd, extraEnvironment) {
    const subprocessEnvironment = { ...process.env, ...extraEnvironment };
    for (const variable of [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_EMAIL",
        "CF_API_KEY",
        "CF_API_TOKEN",
        "CF_EMAIL",
    ]) {
        delete subprocessEnvironment[variable];
    }
    const result = spawnSync(command, args, {
        cwd,
        env: subprocessEnvironment,
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${String(result.status)}`);
    }
}
