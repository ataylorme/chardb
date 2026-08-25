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
const npmCache = process.env.CHARDB_GENERATED_NPM_CACHE ?? join(smokeDirectory, "npm-cache");
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
    const generatedWrangler = await readFile(join(projectDirectory, "wrangler.toml"), "utf8");
    rejectMonorepoAliases(`${generatedPackageJson}\n${generatedTsconfig}`);
    assertNativeWranglerConfig(generatedWrangler);

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
    await proveWranglerLoopbackRuntime(projectDirectory, environment);

    console.log("generated project passed install, typecheck, Wrangler build, doctor, and native loopback runtime");
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

function assertNativeWranglerConfig(source) {
    const config = Bun.TOML.parse(source);
    if (config.durable_objects !== undefined) {
        throw new Error("generated wrangler.toml exposes internal Durable Object bindings");
    }
    const classes = (config.migrations ?? []).flatMap(migration => migration.new_sqlite_classes ?? []).sort();
    const expected = ["BlobMeta", "Catalog", "Cdb", "Gateway", "GsiShard", "Resharder"];
    if (JSON.stringify(classes) !== JSON.stringify(expected)) {
        throw new Error(`generated Wrangler migrations drifted: ${JSON.stringify(classes)}`);
    }
    if (String(config.compatibility_date) < "2025-11-17") {
        throw new Error(
            `generated compatibility date predates native ctx.exports: ${String(config.compatibility_date)}`
        );
    }
}

async function proveWranglerLoopbackRuntime(cwd, extraEnvironment) {
    await instrumentLoopbackProbe(cwd);
    const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
    const port = reservation.port;
    await reservation.stop(true);
    const token = "chardb-native-loopback-smoke";
    const subprocess = Bun.spawn(
        [
            join(cwd, "node_modules", ".bin", "wrangler"),
            "dev",
            "--ip",
            "127.0.0.1",
            "--port",
            String(port),
            "--var",
            `CDB_ADMIN_TOKEN:${token}`,
        ],
        {
            cwd,
            env: { ...process.env, ...extraEnvironment },
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
        }
    );
    const stdout = new Response(subprocess.stdout).text();
    const stderr = new Response(subprocess.stderr).text();
    let runtimeError;
    try {
        const origin = new URL(`http://127.0.0.1:${port}`);
        await waitForWrangler(subprocess, new URL("/health", origin));
        const probeResponse = await fetch(new URL("/__chardb_loopback_probe", origin));
        const probeText = await probeResponse.text();
        const probe = JSON.parse(probeText);
        if (
            !probeResponse.ok ||
            probe.exportCatalog?.type !== "function" ||
            probe.exportCatalog?.idFromName !== "function" ||
            probe.resolvedCatalog?.idFromName !== "function"
        ) {
            throw new Error(`Wrangler loopback shape drifted: ${probeText}`);
        }
        const stateResponse = await fetch(new URL("/_chardb/migrations/state", origin), {
            headers: { authorization: `Bearer ${token}` },
        });
        const stateText = await stateResponse.text();
        if (!stateResponse.ok) {
            throw new Error(
                `Wrangler native loopback request failed (${stateResponse.status}): ${stateText}; probe=${probeText}`
            );
        }
        const state = JSON.parse(stateText);
        if (state?.state?.activeVersion !== 0 || state?.state?.status !== "active") {
            throw new Error(`Wrangler native loopback state drifted: ${stateText}`);
        }
    } catch (error) {
        runtimeError = error;
    } finally {
        await terminate(subprocess);
    }
    const [out, err] = await Promise.all([stdout, stderr]);
    if (runtimeError) throw new Error(`${String(runtimeError)}\n${out}${err}`, { cause: runtimeError });
}

async function instrumentLoopbackProbe(cwd) {
    const path = join(cwd, "src", "worker.ts");
    const source = await readFile(path, "utf8");
    const marker = 'app.get("/health", (c) => c.text("ok"));';
    const probe = `${marker}
app.get("/__chardb_loopback_probe", (c) => {
  const shape = (value: any) => ({
    type: typeof value,
    get: typeof value?.get,
    idFromName: typeof value?.idFromName,
    idFromString: typeof value?.idFromString,
  });
  const execution = c.executionCtx as ExecutionContext & { exports?: Record<string, unknown> };
  return c.json({
    envCatalog: shape((c.env as unknown as Record<string, unknown>).Catalog),
    resolvedCatalog: shape((c.env as unknown as Record<string, unknown>).CDB_CATALOG),
    exportCatalog: shape(execution.exports?.Catalog),
  });
});`;
    if (!source.includes(marker)) throw new Error("generated Worker health route drifted");
    await writeFile(path, source.replace(marker, probe));
}

async function waitForWrangler(process, url) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) throw new Error(`wrangler dev exited before ${url}`);
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The local Workerd listener is still starting.
        }
        await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${url}`);
}

async function terminate(subprocess) {
    if (subprocess.exitCode !== null) return;
    if (process.platform === "win32") subprocess.kill("SIGTERM");
    else process.kill(-subprocess.pid, "SIGTERM");
    await Promise.race([subprocess.exited, Bun.sleep(2_000)]);
    if (subprocess.exitCode !== null) return;
    if (process.platform === "win32") subprocess.kill("SIGKILL");
    else process.kill(-subprocess.pid, "SIGKILL");
    await subprocess.exited;
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
