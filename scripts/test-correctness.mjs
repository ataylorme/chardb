import { readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_ROOT = path.join(ROOT, "test");
const WORKERD_ROOT = path.join(TEST_ROOT, "workerd");
const WORKERD_SUFFIX = ".harness.test.ts";
const TERMINATION_GRACE_MS = 2_000;

export class ChildProcessFailure extends Error {
    constructor(message, { exitCode = null, signalCode = null, timedOut = false } = {}) {
        super(message);
        this.name = "ChildProcessFailure";
        this.exitCode = exitCode;
        this.signalCode = signalCode;
        this.timedOut = timedOut;
    }
}

function outerTimeoutMs() {
    const raw = process.env.CHARDB_WORKERD_TEST_TIMEOUT_MS ?? "120000";
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
            `CHARDB_WORKERD_TEST_TIMEOUT_MS must be a positive safe integer, received ${JSON.stringify(raw)}`
        );
    }
    return value;
}

async function filesUnder(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await filesUnder(file)));
        else files.push(file);
    }
    return files;
}

function relative(file) {
    return path.relative(ROOT, file).split(path.sep).join("/");
}

function isMissingProcess(error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH";
}

function isPermissionDenied(error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
}

function signalProcessGroup(child, signal) {
    if (process.platform === "win32") {
        child.kill(signal);
        return true;
    }
    try {
        process.kill(-child.pid, signal);
        return true;
    } catch (error) {
        if (isMissingProcess(error)) return false;
        throw error;
    }
}

function processGroupExists(pid) {
    if (process.platform === "win32") return false;
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (isMissingProcess(error)) return false;
        if (isPermissionDenied(error)) return true;
        throw error;
    }
}

async function waitForProcessGroupExit(pid, waitMs) {
    const deadline = performance.now() + waitMs;
    while (processGroupExists(pid) && performance.now() < deadline) {
        await Bun.sleep(10);
    }
    return !processGroupExists(pid);
}

async function terminateProcessTree(child, signal, graceMs) {
    if (!signalProcessGroup(child, signal)) return;
    if (process.platform === "win32") {
        await Promise.race([child.exited, Bun.sleep(graceMs)]);
        if (child.exitCode === null) child.kill("SIGKILL");
        return;
    }
    if (await waitForProcessGroupExit(child.pid, graceMs)) return;
    signalProcessGroup(child, "SIGKILL");
    if (!(await waitForProcessGroupExit(child.pid, graceMs))) {
        throw new Error(`process group ${child.pid} survived SIGKILL`);
    }
}

export async function run(label, args, timeoutMs, options = {}) {
    console.log(`\n> ${label}`);
    const child = Bun.spawn(args, {
        cwd: options.cwd ?? ROOT,
        env: options.env ?? process.env,
        stdin: options.stdin ?? "inherit",
        stdout: options.stdout ?? "inherit",
        stderr: options.stderr ?? "inherit",
        detached: process.platform !== "win32",
    });
    const signalSource = options.signalSource ?? process;
    const graceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS;
    let timedOut = false;
    let forwardedSignal = null;
    let termination;
    let timeout;
    const requestTermination = signal => {
        if (termination === undefined) {
            termination = terminateProcessTree(child, signal, graceMs);
            // Signal handlers cannot await; the main run path awaits and
            // rethrows this same promise after the child exits.
            void termination.catch(() => {});
        }
        return termination;
    };
    const clearOuterTimeout = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
    };
    const onSigint = () => {
        forwardedSignal ??= "SIGINT";
        clearOuterTimeout();
        void requestTermination("SIGINT");
    };
    const onSigterm = () => {
        forwardedSignal ??= "SIGTERM";
        clearOuterTimeout();
        void requestTermination("SIGTERM");
    };
    signalSource.on("SIGINT", onSigint);
    signalSource.on("SIGTERM", onSigterm);
    timeout =
        timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true;
                  void requestTermination("SIGTERM");
              }, timeoutMs);
    try {
        const exitCode = await child.exited;
        let cleanupFailure;
        if (termination !== undefined) {
            await termination;
        } else if (process.platform !== "win32") {
            try {
                await terminateProcessTree(child, "SIGTERM", graceMs);
            } catch (error) {
                cleanupFailure = error;
            }
        }
        if (timedOut) {
            throw new ChildProcessFailure(`${label} exceeded its ${timeoutMs} ms outer timeout`, { timedOut: true });
        }
        if (forwardedSignal !== null) {
            throw new ChildProcessFailure(`${label} interrupted by ${forwardedSignal}`, {
                signalCode: forwardedSignal,
            });
        }
        if (exitCode !== 0 || child.signalCode !== null) {
            const failure = new ChildProcessFailure(
                child.signalCode === null
                    ? `${label} exited with code ${exitCode}`
                    : `${label} exited from signal ${child.signalCode}`,
                { exitCode, signalCode: child.signalCode }
            );
            if (cleanupFailure !== undefined) failure.cause = cleanupFailure;
            throw failure;
        }
        if (cleanupFailure !== undefined) throw cleanupFailure;
    } finally {
        clearOuterTimeout();
        signalSource.off("SIGINT", onSigint);
        signalSource.off("SIGTERM", onSigterm);
    }
}

export async function main(argv = process.argv.slice(2)) {
    const watch = argv.includes("--watch");
    const allTests = (await filesUnder(TEST_ROOT))
        .filter(file => file.endsWith(".test.ts") || file.endsWith(".test.tsx"))
        .sort();
    const workerdTests = allTests.filter(
        file => file.startsWith(`${WORKERD_ROOT}${path.sep}`) && file.endsWith(WORKERD_SUFFIX)
    );
    const nonWorkerdTests = allTests.filter(file => !workerdTests.includes(file));

    if (nonWorkerdTests.length === 0) throw new Error("No non-workerd correctness tests found");
    if (!watch && workerdTests.length === 0) throw new Error("No workerd correctness harnesses found");

    await run(watch ? "non-workerd correctness tests in watch mode" : "non-workerd correctness tests", [
        "bun",
        "test",
        ...(watch ? ["--watch"] : []),
        ...nonWorkerdTests.map(relative),
    ]);

    if (!watch) {
        const timeoutMs = outerTimeoutMs();
        for (const harness of workerdTests) {
            const file = relative(harness);
            await run(file, ["bun", "test", file], timeoutMs);
        }
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        if (error instanceof ChildProcessFailure) {
            if (error.signalCode !== null) {
                process.kill(process.pid, error.signalCode);
                await new Promise(() => {});
            }
            process.exit(error.exitCode ?? 1);
        }
        process.exit(1);
    }
}
