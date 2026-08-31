import { fileURLToPath } from "node:url";

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_FORCE_MS = 2_000;
const POLL_MS = 10;
const WINDOWS_UTILITY_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const ISOLATED_CHILD_ARGUMENT = "--chardb-managed-process-child";

export class ManagedProcessError extends Error {
    constructor(
        message,
        { cause, exitCode = null, signalCode = null, timedOut = false, stdout = "", stderr = "" } = {}
    ) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "ManagedProcessError";
        this.exitCode = exitCode;
        this.signalCode = signalCode;
        this.timedOut = timedOut;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

export async function settleBounded(operation, { label = "operation", timeoutMs = DEFAULT_FORCE_MS } = {}) {
    positiveDuration(timeoutMs, `${label} deadline`);
    let timer;
    try {
        const result = await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
        return result;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export function preserveFailure(primary, cleanup, label = "cleanup failed") {
    if (primary === undefined) return cleanup;
    if (cleanup === undefined) return primary;
    return new AggregateError([primary, cleanup], label, { cause: primary });
}

function positiveDuration(value, name) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    return value;
}

function isMissingProcess(error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH";
}

function isPermissionDenied(error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
}

function delay(milliseconds) {
    return Bun.sleep(milliseconds);
}

async function collectOutput(stream, destination, limit) {
    const decoder = new TextDecoder();
    let output = "";
    const append = text => {
        output += text;
        if (output.length > limit) output = output.slice(-limit);
    };
    for await (const chunk of stream) {
        if (destination !== undefined) destination.write(chunk);
        append(decoder.decode(chunk, { stream: true }));
    }
    append(decoder.decode());
    return output;
}

async function runWindowsUtility(command, timeoutMs = WINDOWS_UTILITY_TIMEOUT_MS) {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let timer;
    const timedOut = new Promise(resolve => {
        timer = setTimeout(() => resolve(true), timeoutMs);
    });
    const result = await Promise.race([child.exited.then(exitCode => ({ exitCode })), timedOut]);
    clearTimeout(timer);
    if (result === true) {
        child.kill("SIGKILL");
        await Promise.race([child.exited, delay(1_000)]);
        throw new Error(`${command[0]} exceeded ${timeoutMs}ms`);
    }
    return { exitCode: result.exitCode, stdout: await stdout, stderr: await stderr };
}

async function windowsProcessSnapshot() {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId) | ConvertTo-Json -Compress",
    ].join("; ");
    const result = await runWindowsUtility([
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]);
    if (result.exitCode !== 0) {
        throw new Error(`PowerShell process enumeration failed with ${result.exitCode}: ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
        .map(row => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId) }))
        .filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.parentPid));
}

function descendantPids(snapshot, rootPid) {
    const children = new Map();
    for (const row of snapshot) {
        const entries = children.get(row.parentPid) ?? [];
        entries.push(row.pid);
        children.set(row.parentPid, entries);
    }
    const descendants = [];
    const pending = [...(children.get(rootPid) ?? [])];
    const seen = new Set([rootPid]);
    while (pending.length > 0) {
        const pid = pending.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        descendants.push(pid);
        pending.push(...(children.get(pid) ?? []));
    }
    return descendants;
}

async function windowsTreePids(rootPid) {
    const snapshot = await windowsProcessSnapshot();
    const rootExists = snapshot.some(row => row.pid === rootPid);
    return { rootExists, descendants: descendantPids(snapshot, rootPid) };
}

async function signalWindowsTree(rootPid, force) {
    const tree = await windowsTreePids(rootPid);
    const targets = tree.rootExists ? [rootPid] : tree.descendants;
    for (const pid of targets) {
        const command = ["taskkill.exe", "/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
        await runWindowsUtility(command).catch(() => undefined);
    }
    return targets.length > 0;
}

function posixTreeExists(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (isMissingProcess(error)) return false;
        if (isPermissionDenied(error)) return true;
        throw error;
    }
}

function signalPosixTree(pid, signal) {
    try {
        process.kill(-pid, signal);
        return true;
    } catch (error) {
        if (isMissingProcess(error)) return false;
        throw error;
    }
}

async function treeExists(pid) {
    if (process.platform !== "win32") return posixTreeExists(pid);
    const tree = await windowsTreePids(pid);
    return tree.rootExists || tree.descendants.length > 0;
}

async function waitForTreeExit(pid, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (await treeExists(pid)) {
        if (performance.now() >= deadline) return false;
        await delay(POLL_MS);
    }
    return true;
}

async function signalTree(child, signal, force = false) {
    if (process.platform === "win32") return signalWindowsTree(child.pid, force);
    return signalPosixTree(child.pid, signal);
}

export function spawnManagedProcess(command, options = {}) {
    const {
        label = Array.isArray(command) ? String(command[0]) : String(command),
        graceMs = DEFAULT_GRACE_MS,
        forceMs = DEFAULT_FORCE_MS,
        signalSource = process,
        ...spawnOptions
    } = options;
    positiveDuration(graceMs, "termination grace");
    positiveDuration(forceMs, "forced termination deadline");
    const child = Bun.spawn(command, {
        ...spawnOptions,
        detached: process.platform !== "win32",
    });
    let stopPromise;
    let interruptedSignal = null;

    const stop = (signal = "SIGTERM") => {
        stopPromise ??= (async () => {
            try {
                await signalTree(child, signal, false);
                if (!(await waitForTreeExit(child.pid, graceMs))) {
                    await signalTree(child, "SIGKILL", true);
                    if (!(await waitForTreeExit(child.pid, forceMs))) {
                        throw new Error(`${label} process tree ${child.pid} survived forced termination`);
                    }
                }
                const settled = await Promise.race([child.exited.then(() => true), delay(forceMs).then(() => false)]);
                if (!settled) throw new Error(`${label} leader ${child.pid} did not report exit`);
                return child.exitCode;
            } finally {
                signalSource.off("SIGINT", onSigint);
                signalSource.off("SIGTERM", onSigterm);
            }
        })();
        return stopPromise;
    };
    const onSigint = () => {
        interruptedSignal ??= "SIGINT";
        void stop("SIGINT").catch(() => undefined);
    };
    const onSigterm = () => {
        interruptedSignal ??= "SIGTERM";
        void stop("SIGTERM").catch(() => undefined);
    };
    signalSource.on("SIGINT", onSigint);
    signalSource.on("SIGTERM", onSigterm);

    return {
        child,
        get interruptedSignal() {
            return interruptedSignal;
        },
        stop,
    };
}

export async function runManagedCommand(command, args = [], options = {}) {
    const {
        captureOutput = false,
        mirrorOutput = false,
        outputLimit = DEFAULT_OUTPUT_LIMIT,
        reject = true,
        timeoutMs,
        label = command,
        stdout = captureOutput ? "pipe" : "inherit",
        stderr = captureOutput ? "pipe" : "inherit",
        ...spawnOptions
    } = options;
    if (timeoutMs !== undefined) positiveDuration(timeoutMs, "process timeout");
    positiveDuration(outputLimit, "output limit");
    const managed = spawnManagedProcess([command, ...args], { ...spawnOptions, label, stdout, stderr });
    const stdoutText = captureOutput
        ? collectOutput(managed.child.stdout, mirrorOutput ? process.stdout : undefined, outputLimit)
        : Promise.resolve("");
    const stderrText = captureOutput
        ? collectOutput(managed.child.stderr, mirrorOutput ? process.stderr : undefined, outputLimit)
        : Promise.resolve("");
    let timer;
    const timeout =
        timeoutMs === undefined
            ? new Promise(() => undefined)
            : new Promise(resolve => {
                  timer = setTimeout(() => resolve("timeout"), timeoutMs);
              });
    const outcome = await Promise.race([managed.child.exited.then(() => "exit"), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    let cleanupFailure;
    try {
        await managed.stop("SIGTERM");
    } catch (error) {
        cleanupFailure = error;
    }
    let capturedStdout = "";
    let capturedStderr = "";
    try {
        [capturedStdout, capturedStderr] = await settleBounded(() => Promise.all([stdoutText, stderrText]), {
            label: `${label} output drain`,
            timeoutMs: spawnOptions.forceMs ?? DEFAULT_FORCE_MS,
        });
    } catch (error) {
        cleanupFailure = preserveFailure(cleanupFailure, error, `${label} cleanup and output drain failed`);
    }
    const signalCode = managed.interruptedSignal ?? (outcome === "timeout" ? null : managed.child.signalCode);
    const result = {
        status: managed.child.exitCode,
        signal: signalCode,
        stdout: capturedStdout,
        stderr: capturedStderr,
        timedOut: outcome === "timeout",
    };
    const failed = result.timedOut || signalCode !== null || result.status !== 0 || cleanupFailure !== undefined;
    if (!failed || (!reject && cleanupFailure === undefined)) return result;
    const message = result.timedOut
        ? `${label} exceeded ${timeoutMs}ms`
        : signalCode !== null
          ? `${label} exited from signal ${signalCode}`
          : result.status !== 0
            ? `${label} exited with status ${String(result.status)}`
            : `${label} cleanup failed`;
    throw new ManagedProcessError(message, {
        cause: cleanupFailure,
        exitCode: result.status,
        signalCode,
        timedOut: result.timedOut,
        stdout: capturedStdout,
        stderr: capturedStderr,
    });
}

export async function isolateProcessTree(scriptUrl, { argv = process.argv.slice(2), label, timeoutMs } = {}) {
    const markerIndex = process.argv.indexOf(ISOLATED_CHILD_ARGUMENT);
    if (markerIndex !== -1) {
        process.argv.splice(markerIndex, 1);
        return false;
    }
    const scriptPath = fileURLToPath(scriptUrl);
    try {
        await runManagedCommand(process.execPath, [scriptPath, ...argv, ISOLATED_CHILD_ARGUMENT], {
            label: label ?? scriptPath,
            timeoutMs,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        });
        return true;
    } catch (error) {
        if (error instanceof ManagedProcessError && error.signalCode !== null) {
            try {
                process.kill(process.pid, error.signalCode);
                await new Promise(() => undefined);
            } catch {
                process.exit(error.signalCode === "SIGINT" ? 130 : 143);
            }
        }
        throw error;
    }
}
