import { describe, expect, test } from "bun:test";
import type { Server } from "node:net";
import {
    type LocalFileProofChild,
    type LocalFileProofRuntimeDependencies,
    reserveLoopbackPort,
    startLocalFileProofRuntime,
} from "../scripts/local-file-proof-runtime.mjs";

const releaseSha256 = "a".repeat(64);

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
        },
    });
}

function fakeChild(stdout = stream(), stderr = stream()) {
    const exited = Promise.withResolvers<number>();
    const child = {
        pid: 1234,
        exitCode: null as number | null,
        exited: exited.promise,
        stdout,
        stderr,
        kill() {},
    } satisfies LocalFileProofChild;
    return { child, exited };
}

function baseDependencies(child: LocalFileProofChild): LocalFileProofRuntimeDependencies {
    return {
        reservePort: async () => 43_210,
        preparePersistence: async () => {},
        readSecretsFile: async () =>
            "BETTER_AUTH_SECRET=better-auth-secret\nCDB_ADMIN_TOKEN=admin-token\nCDB_PROOF_RUN_ID=proof-run-id\n",
        installDevVars: async () => {},
        removeDevVars: async () => {},
        spawn: () => child,
        sleep: async () => {},
        now: Date.now,
    };
}

describe("local file proof runtime", () => {
    test("reserves an ephemeral port on the loopback interface", async () => {
        let listenArguments: unknown[] = [];
        const server = {
            once() {
                return server;
            },
            listen(...arguments_: unknown[]) {
                listenArguments = arguments_;
                (arguments_.at(-1) as () => void)();
                return server;
            },
            address() {
                return { address: "127.0.0.1", family: "IPv4", port: 41_234 };
            },
            close(callback: (error?: Error) => void) {
                callback();
                return server;
            },
        };
        expect(await reserveLoopbackPort(() => server as unknown as Server)).toBe(41_234);
        expect(listenArguments.slice(0, 2)).toEqual([0, "127.0.0.1"]);
    });

    test("starts native local Wrangler with exact persistence, secrets, and release health", async () => {
        const { child, exited } = fakeChild(stream("discard-this-prefix", "-stdout-tail"), stream("stderr-tail"));
        let alive = true;
        const signals: NodeJS.Signals[] = [];
        const spawned: Array<{
            command: readonly string[];
            options: { cwd: string; detached: boolean; env: Record<string, string | undefined> };
        }> = [];
        const installed: Array<{ file: string; contents: string }> = [];
        const removed: string[] = [];
        let healthChecks = 0;
        const dependencies: LocalFileProofRuntimeDependencies = {
            ...baseDependencies(child),
            spawn: (command, options) => {
                spawned.push({ command, options });
                return child;
            },
            installDevVars: async (file, contents) => {
                installed.push({ file, contents });
            },
            removeDevVars: async file => {
                removed.push(file);
            },
            fetch: async () => {
                healthChecks++;
                return Response.json(
                    healthChecks === 1
                        ? { ok: true, releaseSha256: "b".repeat(64), proofConfigured: true }
                        : { ok: true, releaseSha256, proofConfigured: healthChecks === 3 }
                );
            },
            signalGroup: (_, signal) => {
                signals.push(signal);
                alive = false;
                child.exitCode = 143;
                exited.resolve(143);
                return true;
            },
            groupAlive: () => alive,
        };
        const runtime = await startLocalFileProofRuntime(
            {
                app: "/proof/app",
                config: "/proof/app/wrangler.local.toml",
                persistenceDir: "/proof/state",
                secretsFile: "/proof/secrets.json",
                wrangler: "/proof/node_modules/wrangler/wrangler-dist/cli.js",
                runtimeExecutable: "/proof/bun",
                releaseSha256,
                logLimitBytes: 12,
                env: {
                    CDB_ADMIN_TOKEN: "must-not-win",
                    CDB_RELEASE_SHA256: "must-not-win",
                    UNRELATED_PROOF_VALUE: "preserved",
                },
            },
            dependencies
        );
        expect(runtime.origin).toBe("http://127.0.0.1:43210");
        expect(healthChecks).toBe(3);
        expect(spawned).toHaveLength(1);
        expect(spawned[0]?.command).toEqual([
            "/proof/bun",
            "/proof/node_modules/wrangler/wrangler-dist/cli.js",
            "dev",
            "--config",
            "/proof/app/wrangler.local.toml",
            "--local",
            "--ip",
            "127.0.0.1",
            "--port",
            "43210",
            "--persist-to",
            "/proof/state",
            "--env-file",
            "/proof/app/.dev.vars",
        ]);
        expect(spawned[0]?.options).toMatchObject({ cwd: "/proof/app", detached: process.platform !== "win32" });
        expect(spawned[0]?.options.env.UNRELATED_PROOF_VALUE).toBe("preserved");
        expect(spawned[0]?.options.env.BETTER_AUTH_SECRET).toBeUndefined();
        expect(spawned[0]?.options.env.CDB_ADMIN_TOKEN).toBeUndefined();
        expect(spawned[0]?.options.env.CDB_PROOF_RUN_ID).toBeUndefined();
        expect(spawned[0]?.options.env.CDB_RELEASE_SHA256).toBeUndefined();
        expect(installed).toEqual([
            {
                file: "/proof/app/.dev.vars",
                contents: `BETTER_AUTH_SECRET=better-auth-secret\nCDB_ADMIN_TOKEN=admin-token\nCDB_PROOF_RUN_ID=proof-run-id\nCDB_RELEASE_SHA256=${releaseSha256}\n`,
            },
        ]);
        expect(runtime.command).not.toContain("/proof/secrets.json");
        expect(runtime.logs.stdout()).toBe("-stdout-tail");
        expect(runtime.logs.stderr()).toBe("stderr-tail");
        await runtime.stop();
        await runtime.stop();
        expect(signals).toEqual(["SIGTERM"]);
        expect(removed).toEqual(["/proof/app/.dev.vars"]);
    });

    test("kills a process group that ignores SIGTERM", async () => {
        const { child, exited } = fakeChild();
        let alive = true;
        const signals: NodeJS.Signals[] = [];
        const dependencies: LocalFileProofRuntimeDependencies = {
            ...baseDependencies(child),
            fetch: async () => Response.json({ ok: true, releaseSha256, proofConfigured: true }),
            signalGroup: (_, signal) => {
                signals.push(signal);
                if (signal === "SIGKILL") {
                    alive = false;
                    child.exitCode = 137;
                    exited.resolve(137);
                }
                return true;
            },
            groupAlive: () => alive,
            now: (() => {
                let now = 0;
                return () => now++;
            })(),
        };
        const runtime = await startLocalFileProofRuntime(
            {
                app: "/proof/app",
                persistenceDir: "/proof/state",
                secretsFile: "/proof/secrets.json",
                wrangler: "/proof/wrangler",
                releaseSha256,
                graceMs: 2,
            },
            dependencies
        );
        await runtime.stop();
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    test("cleans up startup failures and reports only bounded log tails", async () => {
        const { child, exited } = fakeChild(stream("0123456789", "stdout-end"), stream("stderr-end"));
        let alive = true;
        let now = 0;
        const signals: NodeJS.Signals[] = [];
        const dependencies: LocalFileProofRuntimeDependencies = {
            ...baseDependencies(child),
            fetch: async () => Response.json({ ok: true, releaseSha256: "b".repeat(64) }),
            signalGroup: (_, signal) => {
                signals.push(signal);
                alive = false;
                child.exitCode = 143;
                exited.resolve(143);
                return true;
            },
            groupAlive: () => alive,
            now: () => now++,
        };
        await expect(
            startLocalFileProofRuntime(
                {
                    app: "/proof/app",
                    persistenceDir: "/proof/state",
                    secretsFile: "/proof/secrets.json",
                    wrangler: "/proof/wrangler",
                    releaseSha256,
                    startupTimeoutMs: 2,
                    logLimitBytes: 10,
                },
                dependencies
            )
        ).rejects.toThrow("stdout tail:\nstdout-end\nstderr tail:\nstderr-end");
        expect(signals).toEqual(["SIGTERM"]);
    });

    test.each([
        ["missing", "BETTER_AUTH_SECRET=secret\nCDB_ADMIN_TOKEN=token\n", "missing CDB_PROOF_RUN_ID"],
        [
            "duplicate",
            "BETTER_AUTH_SECRET=secret\nCDB_ADMIN_TOKEN=token\nCDB_ADMIN_TOKEN=again\nCDB_PROOF_RUN_ID=run\n",
            "repeats key CDB_ADMIN_TOKEN",
        ],
        [
            "unknown",
            "BETTER_AUTH_SECRET=secret\nCDB_ADMIN_TOKEN=token\nCDB_PROOF_RUN_ID=run\nEXTRA_SECRET=nope\n",
            "unsupported key EXTRA_SECRET",
        ],
        ["malformed", "BETTER_AUTH_SECRET=secret\nCDB_ADMIN_TOKEN=token\nCDB_PROOF_RUN_ID\n", "line 3 is invalid"],
    ])("rejects a %s secrets file before spawning", async (_case, contents, message) => {
        const { child } = fakeChild();
        let spawned = false;
        await expect(
            startLocalFileProofRuntime(
                {
                    app: "/proof/app",
                    persistenceDir: "/proof/state",
                    secretsFile: "/proof/secrets.env",
                    wrangler: "/proof/wrangler",
                    releaseSha256,
                },
                {
                    ...baseDependencies(child),
                    readSecretsFile: async () => contents,
                    spawn: () => {
                        spawned = true;
                        return child;
                    },
                }
            )
        ).rejects.toThrow(message);
        expect(spawned).toBe(false);
    });

    test("removes installed .dev.vars when Wrangler fails to spawn", async () => {
        const { child } = fakeChild();
        const removed: string[] = [];
        await expect(
            startLocalFileProofRuntime(
                {
                    app: "/proof/app",
                    persistenceDir: "/proof/state",
                    secretsFile: "/proof/secrets.env",
                    wrangler: "/proof/wrangler",
                    releaseSha256,
                },
                {
                    ...baseDependencies(child),
                    spawn: () => {
                        throw new Error("spawn failed");
                    },
                    removeDevVars: async file => {
                        removed.push(file);
                    },
                }
            )
        ).rejects.toThrow("spawn failed");
        expect(removed).toEqual(["/proof/app/.dev.vars"]);
    });
});
