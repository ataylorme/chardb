import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedProcessError, runManagedCommand, spawnManagedProcess } from "../scripts/process-lifecycle.mjs";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function processTree(leaderCompletion = "await new Promise(() => {});") {
    const directory = await mkdtemp(join(tmpdir(), "chardb-process-lifecycle-"));
    directories.push(directory);
    const pidFile = join(directory, "descendant.pid");
    const descendant = `
        process.on("SIGINT", () => {});
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1_000);
    `;
    const leader = `
        process.on("SIGINT", () => {});
        process.on("SIGTERM", () => {});
        const child = Bun.spawn([process.execPath, "--eval", ${JSON.stringify(descendant)}], {
            stdin: "ignore", stdout: "ignore", stderr: "ignore"
        });
        await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
        ${leaderCompletion}
    `;
    return { pidFile, args: ["--eval", leader] };
}

async function readPid(path: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            const pid = Number(await readFile(path, "utf8"));
            if (Number.isSafeInteger(pid) && pid > 0) return pid;
        } catch {
            await Bun.sleep(10);
        }
    }
    throw new Error("leader did not publish its descendant pid");
}

async function expectGone(pid: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
            throw error;
        }
        await Bun.sleep(20);
    }
    throw new Error(`descendant ${pid} survived cleanup on ${process.platform}`);
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    return address.port;
}

describe("managed process lifecycle", () => {
    test("kills a signal-resistant descendant after timeout", async () => {
        const tree = await processTree();
        const completion = runManagedCommand(process.execPath, tree.args, {
            label: "timeout fixture",
            timeoutMs: 100,
            graceMs: 100,
            forceMs: 2_000,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        }).catch(error => error);
        const descendantPid = await readPid(tree.pidFile);

        await expect(completion).resolves.toMatchObject({ timedOut: true, signalCode: null });
        await expectGone(descendantPid);
    }, 15_000);

    test("cleans descendants after a successful leader exit", async () => {
        const tree = await processTree("process.exit(0);");
        const completion = runManagedCommand(process.execPath, tree.args, {
            label: "successful fixture",
            graceMs: 100,
            forceMs: 2_000,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        const descendantPid = await readPid(tree.pidFile);

        await completion;
        await expectGone(descendantPid);
    }, 15_000);

    test("cleans two concurrent trees without crossing their lifecycle state", async () => {
        const firstTree = await processTree();
        const secondTree = await processTree();
        const first = spawnManagedProcess([process.execPath, ...firstTree.args], {
            label: "first concurrent fixture",
            graceMs: 100,
            forceMs: 2_000,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        const second = spawnManagedProcess([process.execPath, ...secondTree.args], {
            label: "second concurrent fixture",
            graceMs: 100,
            forceMs: 2_000,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        const [firstDescendant, secondDescendant] = await Promise.all([
            readPid(firstTree.pidFile),
            readPid(secondTree.pidFile),
        ]);

        await Promise.all([first.stop(), second.stop()]);
        await Promise.all([expectGone(firstDescendant), expectGone(secondDescendant)]);
    }, 15_000);

    test("coalesces signal-driven cleanup and removes its handlers", async () => {
        const signals = new EventEmitter();
        const managed = spawnManagedProcess(
            [process.execPath, "--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
            {
                label: "signal fixture",
                graceMs: 100,
                forceMs: 2_000,
                signalSource: signals,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            }
        );

        signals.emit("SIGTERM");
        await managed.stop("SIGTERM");
        expect(managed.interruptedSignal).toBe("SIGTERM");
        expect(signals.listenerCount("SIGINT")).toBe(0);
        expect(signals.listenerCount("SIGTERM")).toBe(0);
    });

    test("retains output and the original exit status", async () => {
        const failure = await runManagedCommand(
            process.execPath,
            ["--eval", 'console.log("stdout evidence"); console.error("stderr evidence"); process.exit(23)'],
            { label: "failure fixture", captureOutput: true }
        ).catch(error => error);

        expect(failure).toBeInstanceOf(ManagedProcessError);
        expect(failure).toMatchObject({ exitCode: 23, stdout: "stdout evidence\n", stderr: "stderr evidence\n" });
    });

    test("drains output larger than a pipe buffer before returning", async () => {
        const bytes = 256 * 1_024;
        const result = await runManagedCommand(
            process.execPath,
            ["--eval", `process.stdout.write("x".repeat(${bytes})); process.stderr.write("y".repeat(${bytes}))`],
            { label: "output drain fixture", captureOutput: true, outputLimit: bytes + 1_024 }
        );

        expect(result.stdout).toHaveLength(bytes);
        expect(result.stderr).toHaveLength(bytes);
    });

    test("releases a listening port before cleanup resolves", async () => {
        const port = await reservePort();
        const managed = spawnManagedProcess(
            [
                process.execPath,
                "--eval",
                `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("fixture") }); await new Promise(() => {})`,
            ],
            {
                label: "port fixture",
                graceMs: 100,
                forceMs: 2_000,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            }
        );
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            try {
                if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
            } catch {
                await Bun.sleep(20);
            }
        }

        await managed.stop();
        const rebound = createServer();
        await new Promise<void>((resolve, reject) => {
            rebound.once("error", reject);
            rebound.listen(port, "127.0.0.1", resolve);
        });
        expect((rebound.address() as { port: number }).port).toBe(port);
        await new Promise<void>((resolve, reject) => rebound.close(error => (error ? reject(error) : resolve())));
    });

    test("does not register signal handlers when spawn fails", () => {
        const signals = new EventEmitter();
        expect(() =>
            spawnManagedProcess([`missing-chardb-command-${crypto.randomUUID()}`], { signalSource: signals })
        ).toThrow();
        expect(signals.listenerCount("SIGINT")).toBe(0);
        expect(signals.listenerCount("SIGTERM")).toBe(0);
    });

    test("coalesces repeated cleanup calls", async () => {
        const managed = spawnManagedProcess(
            [process.execPath, "--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
            {
                label: "idempotent fixture",
                graceMs: 100,
                forceMs: 2_000,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            }
        );

        const first = managed.stop();
        expect(managed.stop()).toBe(first);
        await first;
        await expect(managed.stop()).resolves.toBe(managed.child.exitCode);
    });
});
