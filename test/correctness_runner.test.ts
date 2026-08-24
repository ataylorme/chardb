import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChildProcessFailure, run } from "../scripts/test-correctness.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function processTreeCommand(
    childCompletion = "await new Promise(() => {});"
): Promise<{ readonly args: string[]; readonly pidFile: string }> {
    const directory = await mkdtemp(path.join(tmpdir(), "chardb-correctness-runner-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "grandchild.pid");
    const grandchildSource = `
        process.on("SIGINT", () => {});
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1_000);
    `;
    const childSource = `
        process.on("SIGINT", () => {});
        process.on("SIGTERM", () => {});
        const grandchild = Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchildSource)}], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        await Bun.write(${JSON.stringify(pidFile)}, String(grandchild.pid));
        ${childCompletion}
    `;
    return { args: [process.execPath, "-e", childSource], pidFile };
}

async function readPid(pidFile: string): Promise<number> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        try {
            const pid = Number(await readFile(pidFile, "utf8"));
            if (Number.isSafeInteger(pid) && pid > 0) return pid;
        } catch {
            // The child has not published its grandchild yet.
        }
        await Bun.sleep(10);
    }
    throw new Error("synthetic child did not publish its grandchild pid");
}

async function expectProcessGone(pid: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
            throw error;
        }
        await Bun.sleep(10);
    }
    throw new Error(`process ${pid} survived process-tree cleanup`);
}

const posixTest = process.platform === "win32" ? test.skip : test;

describe("correctness runner process control", () => {
    posixTest("an outer timeout terminates a signal-resistant grandchild", async () => {
        const tree = await processTreeCommand();
        const failure = run("synthetic timeout", tree.args, 100, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            terminationGraceMs: 50,
        }).catch((error: unknown) => error);
        const grandchildPid = await readPid(tree.pidFile);

        await expect(failure).resolves.toMatchObject({ timedOut: true, exitCode: null, signalCode: null });
        await expectProcessGone(grandchildPid);
    });

    posixTest("forwards a parent termination signal to the whole child group", async () => {
        const tree = await processTreeCommand();
        const signals = new EventEmitter();
        const failure = run("synthetic signal", tree.args, undefined, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            terminationGraceMs: 50,
            signalSource: signals,
        }).catch((error: unknown) => error);
        const grandchildPid = await readPid(tree.pidFile);
        signals.emit("SIGTERM");

        await expect(failure).resolves.toMatchObject({ timedOut: false, signalCode: "SIGTERM" });
        await expectProcessGone(grandchildPid);
    });

    posixTest("cleans a resistant grandchild and preserves a nonzero child exit code", async () => {
        const tree = await processTreeCommand("process.exit(23);");
        const failure = run("synthetic exit", tree.args, undefined, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            terminationGraceMs: 50,
        }).catch((error: unknown) => error);
        const grandchildPid = await readPid(tree.pidFile);

        await expect(failure).resolves.toBeInstanceOf(ChildProcessFailure);
        await expect(failure).resolves.toMatchObject({ timedOut: false, exitCode: 23, signalCode: null });
        await expectProcessGone(grandchildPid);
    });

    posixTest("cleans a resistant grandchild and preserves an unprompted child signal", async () => {
        const tree = await processTreeCommand(
            'process.removeAllListeners("SIGTERM"); process.kill(process.pid, "SIGTERM");'
        );
        const failure = run("synthetic child signal", tree.args, undefined, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            terminationGraceMs: 50,
        }).catch((error: unknown) => error);
        const grandchildPid = await readPid(tree.pidFile);

        await expect(failure).resolves.toBeInstanceOf(ChildProcessFailure);
        await expect(failure).resolves.toMatchObject({ timedOut: false, signalCode: "SIGTERM" });
        await expectProcessGone(grandchildPid);
    });

    posixTest("cleans a resistant grandchild after a successful leader exit", async () => {
        const tree = await processTreeCommand("process.exit(0);");
        const completion = run("synthetic success", tree.args, undefined, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            terminationGraceMs: 50,
        });
        const grandchildPid = await readPid(tree.pidFile);

        await expect(completion).resolves.toBeUndefined();
        await expectProcessGone(grandchildPid);
    });
});
