import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const DEFAULT_LOG_LIMIT_BYTES = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_STOP_GRACE_MS = 3_000;
const REQUIRED_SECRET_NAMES = Object.freeze(["BETTER_AUTH_SECRET", "CDB_ADMIN_TOKEN", "CDB_PROOF_RUN_ID"]);

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function errorCode(error) {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function defaultSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parseSecretsFile(contents) {
    check(typeof contents === "string", "local proof secrets file must be UTF-8 text");
    const allowed = new Set(REQUIRED_SECRET_NAMES);
    const secrets = {};
    for (const [index, line] of contents.split(/\r?\n/u).entries()) {
        if (line.length === 0) continue;
        const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]+)$/u.exec(line);
        check(match !== null, `local proof secrets file line ${index + 1} is invalid`);
        const [, name, value] = match;
        check(allowed.has(name), `local proof secrets file contains unsupported key ${name}`);
        check(!(name in secrets), `local proof secrets file repeats key ${name}`);
        secrets[name] = value;
    }
    for (const name of REQUIRED_SECRET_NAMES) check(name in secrets, `local proof secrets file is missing ${name}`);
    check(Object.keys(secrets).length === REQUIRED_SECRET_NAMES.length, "local proof secrets file has unexpected keys");
    return secrets;
}

function renderDevVars(secrets, releaseSha256) {
    return `${REQUIRED_SECRET_NAMES.map(name => `${name}=${secrets[name]}`).join("\n")}\nCDB_RELEASE_SHA256=${releaseSha256}\n`;
}

async function defaultRemoveDevVars(file) {
    try {
        await unlink(file);
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
    }
}

export async function reserveLoopbackPort(createServerImpl = createServer) {
    const server = createServerImpl();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : undefined;
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    check(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "could not reserve an ephemeral loopback port");
    return port;
}

function createTail(limitBytes) {
    let bytes = Buffer.alloc(0);
    return {
        append(chunk) {
            const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (next.byteLength >= limitBytes) {
                bytes = next.subarray(next.byteLength - limitBytes);
                return;
            }
            const keep = Math.min(bytes.byteLength, limitBytes - next.byteLength);
            bytes = Buffer.concat([bytes.subarray(bytes.byteLength - keep), next], keep + next.byteLength);
        },
        text() {
            return bytes.toString("utf8");
        },
    };
}

async function drain(stream, tail) {
    if (!stream) return;
    if (typeof stream.getReader === "function") {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                tail.append(value);
            }
        } finally {
            reader.releaseLock();
        }
    }
    for await (const chunk of stream) tail.append(chunk);
}

function defaultSignalGroup(child, signal) {
    if (process.platform === "win32") {
        child.kill(signal);
        return true;
    }
    try {
        process.kill(-child.pid, signal);
        return true;
    } catch (error) {
        if (errorCode(error) === "ESRCH") return false;
        throw error;
    }
}

function defaultGroupAlive(child) {
    if (process.platform === "win32") return child.exitCode === null;
    try {
        process.kill(-child.pid, 0);
        return true;
    } catch (error) {
        if (errorCode(error) === "ESRCH") return false;
        if (errorCode(error) === "EPERM") return true;
        throw error;
    }
}

async function waitUntil(predicate, timeoutMs, dependencies) {
    const deadline = dependencies.now() + timeoutMs;
    while (predicate() && dependencies.now() < deadline) await dependencies.sleep(10);
    return !predicate();
}

async function settleWithin(promise, timeoutMs) {
    let timeout;
    try {
        return await Promise.race([
            Promise.resolve(promise).then(() => true),
            new Promise(resolve => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function boundedDrain(drainTasks, timeoutMs) {
    await settleWithin(Promise.allSettled(drainTasks), timeoutMs);
}

async function stopProcessGroup(child, drainTasks, options, dependencies) {
    if (dependencies.groupAlive(child)) {
        dependencies.signalGroup(child, "SIGTERM");
        if (!(await waitUntil(() => dependencies.groupAlive(child), options.graceMs, dependencies))) {
            dependencies.signalGroup(child, "SIGKILL");
            if (!(await waitUntil(() => dependencies.groupAlive(child), options.graceMs, dependencies))) {
                throw new Error(`local Wrangler process group ${child.pid} survived SIGKILL`);
            }
        }
    }
    const exited = await settleWithin(child.exited, options.graceMs);
    if (!exited) throw new Error(`local Wrangler process ${child.pid} did not report exit`);
    await boundedDrain(drainTasks, options.graceMs);
}

async function readHealth(origin, options, fetchImpl) {
    const response = await fetchImpl(new URL(options.healthPath, origin), {
        headers: options.healthHeaders,
        signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    if (!response.ok) return undefined;
    try {
        return await response.json();
    } catch {
        return undefined;
    }
}

async function waitForRelease(child, origin, releaseSha256, options, dependencies) {
    const deadline = dependencies.now() + options.startupTimeoutMs;
    while (dependencies.now() < deadline) {
        if (child.exitCode !== null)
            throw new Error(`local Wrangler exited with ${String(child.exitCode)} before health`);
        try {
            const health = await readHealth(origin, options, dependencies.fetch);
            if (options.healthReady(health, releaseSha256)) {
                return health;
            }
        } catch {
            // Wrangler may not have opened its listener yet.
        }
        await dependencies.sleep(100);
    }
    throw new Error(`timed out waiting for /health release ${releaseSha256}`);
}

export async function startLocalFileProofRuntime(input, injected = {}) {
    check(input !== null && typeof input === "object", "local file proof runtime input is required");
    check(/^[a-f0-9]{64}$/.test(input.releaseSha256 ?? ""), "local proof release SHA-256 is invalid");
    for (const field of ["app", "persistenceDir", "secretsFile", "wrangler"]) {
        check(typeof input[field] === "string" && input[field].length > 0, `${field} is required`);
    }
    const logLimitBytes = input.logLimitBytes ?? DEFAULT_LOG_LIMIT_BYTES;
    check(Number.isSafeInteger(logLimitBytes) && logLimitBytes > 0, "logLimitBytes must be a positive integer");
    const options = {
        startupTimeoutMs: input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        requestTimeoutMs: input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        graceMs: input.graceMs ?? DEFAULT_STOP_GRACE_MS,
        healthPath: input.healthPath ?? "/health",
        healthHeaders: input.healthHeaders,
        healthReady:
            input.healthReady ??
            ((health, releaseSha256) =>
                health?.ok === true && health.releaseSha256 === releaseSha256 && health.proofConfigured === true),
    };
    for (const [name, value] of Object.entries({
        startupTimeoutMs: options.startupTimeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
        graceMs: options.graceMs,
    })) {
        check(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
    }
    check(
        typeof options.healthPath === "string" &&
            options.healthPath.startsWith("/") &&
            !options.healthPath.startsWith("//"),
        "healthPath must be an absolute URL path"
    );
    check(typeof options.healthReady === "function", "healthReady must be a function");
    const dependencies = {
        reservePort: injected.reservePort ?? reserveLoopbackPort,
        preparePersistence: injected.preparePersistence ?? (directory => mkdir(directory, { recursive: true })),
        readSecretsFile: injected.readSecretsFile ?? (file => readFile(file, "utf8")),
        installDevVars:
            injected.installDevVars ??
            ((file, contents) => writeFile(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 })),
        removeDevVars: injected.removeDevVars ?? defaultRemoveDevVars,
        spawn: injected.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions)),
        fetch: injected.fetch ?? fetch,
        signalGroup: injected.signalGroup ?? defaultSignalGroup,
        groupAlive: injected.groupAlive ?? defaultGroupAlive,
        sleep: injected.sleep ?? defaultSleep,
        now: injected.now ?? Date.now,
    };
    const app = path.resolve(input.app);
    const persistenceDir = path.resolve(input.persistenceDir);
    const secretsFile = path.resolve(input.secretsFile);
    const wrangler = path.resolve(input.wrangler);
    const secrets = parseSecretsFile(await dependencies.readSecretsFile(secretsFile));
    const devVarsFile = path.join(app, ".dev.vars");
    await dependencies.preparePersistence(persistenceDir);
    const port = await dependencies.reservePort();
    check(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "reserved local proof port is invalid");
    const origin = `http://127.0.0.1:${port}`;
    const runtimeExecutable = input.runtimeExecutable ? path.resolve(input.runtimeExecutable) : undefined;
    const command = [
        runtimeExecutable ?? wrangler,
        ...(runtimeExecutable ? [wrangler] : []),
        "dev",
        ...(input.config ? ["--config", path.resolve(input.config)] : []),
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persistenceDir,
        "--env-file",
        devVarsFile,
    ];
    await dependencies.installDevVars(devVarsFile, renderDevVars(secrets, input.releaseSha256));
    const childEnv = { ...process.env, ...input.env };
    for (const name of REQUIRED_SECRET_NAMES) delete childEnv[name];
    childEnv.CDB_RELEASE_SHA256 = undefined;
    let child;
    try {
        child = dependencies.spawn(command, {
            cwd: app,
            env: childEnv,
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
        });
    } catch (error) {
        await dependencies.removeDevVars(devVarsFile);
        throw error;
    }
    check(Number.isSafeInteger(child.pid) && child.pid > 0, "local Wrangler did not expose a process ID");
    const stdout = createTail(logLimitBytes);
    const stderr = createTail(logLimitBytes);
    const drainTasks = [drain(child.stdout, stdout), drain(child.stderr, stderr)];
    let stopPromise;
    const stop = () => {
        stopPromise ??= (async () => {
            let processError;
            try {
                await stopProcessGroup(child, drainTasks, options, dependencies);
            } catch (error) {
                processError = error;
            }
            let devVarsError;
            try {
                await dependencies.removeDevVars(devVarsFile);
            } catch (error) {
                devVarsError = error;
            }
            if (processError || devVarsError) {
                throw new Error(
                    [
                        processError ? `local Wrangler cleanup failed: ${String(processError)}` : "",
                        devVarsError ? `local .dev.vars cleanup failed: ${String(devVarsError)}` : "",
                    ]
                        .filter(Boolean)
                        .join("\n"),
                    { cause: processError ?? devVarsError }
                );
            }
        })();
        return stopPromise;
    };
    try {
        const health = await waitForRelease(child, origin, input.releaseSha256, options, dependencies);
        return Object.freeze({
            origin,
            port,
            releaseSha256: input.releaseSha256,
            health,
            command: Object.freeze([...command]),
            logs: Object.freeze({
                stdout: () => stdout.text(),
                stderr: () => stderr.text(),
            }),
            stop,
        });
    } catch (error) {
        let cleanupError;
        try {
            await stop();
        } catch (caught) {
            cleanupError = caught;
        }
        const diagnostics = `stdout tail:\n${stdout.text()}\nstderr tail:\n${stderr.text()}`;
        throw new Error(`${String(error)}${cleanupError ? `\ncleanup: ${String(cleanupError)}` : ""}\n${diagnostics}`, {
            cause: error,
        });
    }
}
