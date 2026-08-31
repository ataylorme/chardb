/** Plumbing for CLI commands so we can unit-test them without touching disk. */

import { link, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type CliFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CliCommandInvocation {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes?: number;
}

export interface CliCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export type CliCommandRunner = (invocation: CliCommandInvocation) => Promise<CliCommandResult>;

export interface CliFileArtifact {
    readonly path: string;
    readonly contents: string;
}

export interface CliFileChange extends CliFileArtifact {
    /** null means the target must not exist; a string is compare-and-swap content. */
    readonly expectedContents: string | null;
}

export interface CliSelfCommand {
    readonly executable: string;
    readonly args: readonly string[];
}

export interface CliContext {
    readonly cwd: string;
    readonly env: { readonly [k: string]: string | undefined };
    readonly stdout: (s: string) => void;
    readonly stderr: (s: string) => void;
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, contents: string) => Promise<void>;
    readonly exists: (path: string) => Promise<boolean>;
    /** Create one exact directory without following an existing symlink. */
    readonly prepareDirectory?: (path: string) => Promise<"created" | "existing">;
    /** List direct child names without following them. Used by destructive-command preflights. */
    readonly readDirectory?: (path: string) => Promise<readonly string[]>;
    /** Remove one empty directory. This never removes files or non-empty directories. */
    readonly removeDirectory?: (path: string) => Promise<void>;
    /** Create a related artifact set without replacing any existing target. */
    readonly writeFilesExclusive?: (artifacts: readonly CliFileArtifact[]) => Promise<void>;
    /** Commit new immutable files and exact-content replacements as one recoverable set. */
    readonly writeFilesAtomic?: (changes: readonly CliFileChange[]) => Promise<void>;
    /** Exact argv prefix for starting this CLI in a fresh process. */
    readonly selfCommand?: CliSelfCommand;
    readonly fetch?: CliFetch;
    /** External process boundary. Commands receive argv directly, never a shell string. */
    readonly runCommand?: CliCommandRunner;
}

export const REAL_CONTEXT: CliContext = {
    cwd: typeof process !== "undefined" ? process.cwd() : "/",
    env: typeof process !== "undefined" ? (process.env as { [k: string]: string | undefined }) : {},
    stdout: s => {
        if (typeof process !== "undefined") process.stdout.write(s);
    },
    stderr: s => {
        if (typeof process !== "undefined") process.stderr.write(s);
    },
    async read(path) {
        return await Bun.file(path).text();
    },
    async write(path, contents) {
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, contents);
    },
    async exists(path) {
        try {
            await lstat(path);
            return true;
        } catch (error) {
            if ((error as { readonly code?: string }).code === "ENOENT") return false;
            throw error;
        }
    },
    async prepareDirectory(path) {
        try {
            await mkdir(path);
            return "created";
        } catch (error) {
            if ((error as { readonly code?: string }).code !== "EEXIST") throw error;
            const stat = await lstat(path);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error(`init target is not a real directory: ${path}`);
            }
            return "existing";
        }
    },
    async readDirectory(path) {
        return (await readdir(path)).sort();
    },
    async removeDirectory(path) {
        await rmdir(path);
    },
    async writeFilesExclusive(artifacts) {
        const paths = new Set<string>();
        for (const artifact of artifacts) {
            if (paths.has(artifact.path)) throw new Error(`duplicate artifact target: ${artifact.path}`);
            paths.add(artifact.path);
            await mkdir(dirname(artifact.path), { recursive: true });
        }
        const staged: {
            readonly target: string;
            readonly temporary: string;
            readonly dev: number;
            readonly ino: number;
        }[] = [];
        const committed: typeof staged = [];
        try {
            for (const artifact of artifacts) {
                const temporary = `${artifact.path}.chardb-${process.pid}-${crypto.randomUUID()}.tmp`;
                const handle = await open(temporary, "wx", 0o644);
                try {
                    const stat = await handle.stat();
                    staged.push({ target: artifact.path, temporary, dev: stat.dev, ino: stat.ino });
                    await handle.writeFile(artifact.contents, "utf8");
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
            for (const artifact of staged) {
                await link(artifact.temporary, artifact.target);
                committed.push(artifact);
            }
        } catch (error) {
            for (const artifact of committed.reverse()) {
                try {
                    const stat = await lstat(artifact.target);
                    if (stat.dev === artifact.dev && stat.ino === artifact.ino) await unlink(artifact.target);
                } catch {
                    // Never replace or remove a target we cannot prove this operation created.
                }
            }
            throw error;
        } finally {
            for (const artifact of staged) {
                try {
                    await unlink(artifact.temporary);
                } catch {
                    // A failed cleanup cannot make a target partially committed.
                }
            }
        }
    },
    async writeFilesAtomic(changes) {
        const paths = new Set<string>();
        for (const change of changes) {
            if (paths.has(change.path)) throw new Error(`duplicate artifact target: ${change.path}`);
            paths.add(change.path);
            await mkdir(dirname(change.path), { recursive: true });
        }
        const staged: {
            readonly target: string;
            readonly temporary: string;
            readonly backup: string | null;
            readonly expectedContents: string | null;
            readonly stagedDev: number;
            readonly stagedIno: number;
            readonly originalDev: number | null;
            readonly originalIno: number | null;
        }[] = [];
        const committed: typeof staged = [];
        const cleanupPaths: string[] = [];
        try {
            for (const change of changes) {
                const suffix = `${process.pid}-${crypto.randomUUID()}`;
                const temporary = `${change.path}.chardb-${suffix}.tmp`;
                cleanupPaths.push(temporary);
                const handle = await open(temporary, "wx", 0o644);
                let stagedDev = 0;
                let stagedIno = 0;
                try {
                    const stat = await handle.stat();
                    stagedDev = stat.dev;
                    stagedIno = stat.ino;
                    await handle.writeFile(change.contents, "utf8");
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                if (change.expectedContents === null) {
                    try {
                        await lstat(change.path);
                        throw new Error(`artifact target already exists: ${change.path}`);
                    } catch (error) {
                        if ((error as { readonly code?: string }).code !== "ENOENT") throw error;
                    }
                    staged.push({
                        target: change.path,
                        temporary,
                        backup: null,
                        expectedContents: null,
                        stagedDev,
                        stagedIno,
                        originalDev: null,
                        originalIno: null,
                    });
                    continue;
                }
                const original = await lstat(change.path);
                if ((await readFile(change.path, "utf8")) !== change.expectedContents) {
                    throw new Error(`artifact target changed: ${change.path}`);
                }
                const backup = `${change.path}.chardb-${suffix}.bak`;
                await link(change.path, backup);
                cleanupPaths.push(backup);
                staged.push({
                    target: change.path,
                    temporary,
                    backup,
                    expectedContents: change.expectedContents,
                    stagedDev,
                    stagedIno,
                    originalDev: original.dev,
                    originalIno: original.ino,
                });
            }
            for (const change of staged.filter(change => change.expectedContents === null)) {
                await link(change.temporary, change.target);
                committed.push(change);
            }
            for (const change of staged.filter(change => change.expectedContents !== null)) {
                const current = await lstat(change.target);
                if (
                    current.dev !== change.originalDev ||
                    current.ino !== change.originalIno ||
                    (await readFile(change.target, "utf8")) !== change.expectedContents
                ) {
                    throw new Error(`artifact target changed: ${change.target}`);
                }
                await rename(change.temporary, change.target);
                committed.push(change);
            }
        } catch (error) {
            for (const change of committed.reverse()) {
                try {
                    const current = await lstat(change.target);
                    if (change.backup) {
                        if (current.dev === change.stagedDev && current.ino === change.stagedIno) {
                            await rename(change.backup, change.target);
                        }
                    } else if (current.dev === change.stagedDev && current.ino === change.stagedIno) {
                        await unlink(change.target);
                    }
                } catch {
                    // Never replace or remove a target whose identity changed.
                }
            }
            throw error;
        } finally {
            for (const path of cleanupPaths) {
                try {
                    await unlink(path);
                } catch {
                    // Temporary cleanup does not change committed artifact identity.
                }
            }
        }
    },
    ...(typeof process !== "undefined" && process.argv[1]
        ? { selfCommand: { executable: process.execPath, args: [process.argv[1]] } }
        : {}),
    fetch: globalThis.fetch,
    async runCommand(invocation) {
        const child = Bun.spawn([invocation.executable, ...invocation.args], {
            cwd: invocation.cwd,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            } catch {
                // The command-level deadline still releases the caller.
            }
        }, invocation.timeoutMs);
        const readBounded = async (stream: ReadableStream<Uint8Array>, label: string): Promise<string> => {
            const limit = invocation.maxOutputBytes ?? 10 * 1_024 * 1_024;
            const decoder = new TextDecoder();
            const reader = stream.getReader();
            let bytes = 0;
            let output = "";
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > limit) throw new Error(`${label} exceeded ${limit} UTF-8 bytes`);
                output += decoder.decode(chunk.value, { stream: true });
            }
            return output + decoder.decode();
        };
        try {
            const [exitCode, stdout, stderr] = await Promise.all([
                child.exited,
                readBounded(child.stdout, "external command stdout"),
                readBounded(child.stderr, "external command stderr"),
            ]);
            if (timedOut) throw new Error("external command exceeded its deadline");
            return { exitCode, stdout, stderr };
        } catch (error) {
            try {
                child.kill();
            } catch {
                // The read or deadline failure is already authoritative.
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    },
};
