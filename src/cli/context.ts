/** Plumbing for CLI commands so we can unit-test them without touching disk. */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface CliContext {
    readonly cwd: string;
    readonly env: { readonly [k: string]: string | undefined };
    readonly stdout: (s: string) => void;
    readonly stderr: (s: string) => void;
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, contents: string) => Promise<void>;
    readonly exists: (path: string) => Promise<boolean>;
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
        return await Bun.file(path).exists();
    },
};
