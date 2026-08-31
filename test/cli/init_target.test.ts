import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInit } from "../../src/cli/commands/init.ts";
import { type CliContext, REAL_CONTEXT } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";

interface MemoryProject {
    readonly ctx: CliContext;
    readonly directories: Set<string>;
    readonly files: Map<string, string>;
    readonly writes: string[];
}

function memoryProject(): MemoryProject {
    const directories = new Set(["/tmp/chardb-init-target"]);
    const files = new Map<string, string>();
    const writes: string[] = [];
    const ctx: CliContext = {
        cwd: "/tmp/chardb-init-target",
        env: {},
        stdout: () => {},
        stderr: () => {},
        async read(path) {
            const contents = files.get(path);
            if (contents === undefined) throw new Error(`ENOENT: ${path}`);
            return contents;
        },
        async write(path, contents) {
            files.set(path, contents);
        },
        async exists(path) {
            return files.has(path) || directories.has(path);
        },
        async prepareDirectory(path) {
            if (directories.has(path)) return "existing";
            directories.add(path);
            return "created";
        },
        async readDirectory(path) {
            const prefix = `${path}/`;
            return [
                ...new Set(
                    [...directories, ...files.keys()].flatMap(entry => {
                        if (!entry.startsWith(prefix)) return [];
                        const child = entry.slice(prefix.length).split("/", 1)[0];
                        return child ? [child] : [];
                    })
                ),
            ].sort();
        },
        async removeDirectory(path) {
            const prefix = `${path}/`;
            if ([...directories, ...files.keys()].some(entry => entry !== path && entry.startsWith(prefix))) {
                throw new Error("ENOTEMPTY");
            }
            directories.delete(path);
        },
        async writeFilesExclusive(artifacts) {
            const conflict = artifacts.find(artifact => files.has(artifact.path));
            if (conflict) throw new Error(`artifact target already exists: ${conflict.path}`);
            for (const artifact of artifacts) {
                writes.push(artifact.path);
                files.set(artifact.path, artifact.contents);
            }
        },
    };
    return { ctx, directories, files, writes };
}

function cliContext(overrides: Partial<CliContext> = {}): {
    readonly ctx: CliContext;
    readonly stdout: string[];
    readonly stderr: string[];
} {
    const project = memoryProject();
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        ctx: {
            ...project.ctx,
            stdout: value => stdout.push(value),
            stderr: value => stderr.push(value),
            ...overrides,
        },
        stdout,
        stderr,
    };
}

describe("init target contract", () => {
    test("writes only inside a named target, including a name with spaces", async () => {
        const project = memoryProject();

        await runInit(project.ctx, { name: "app-with-spaces", directory: "app with spaces" });

        const target = "/tmp/chardb-init-target/app with spaces/";
        expect(project.files.has("/tmp/chardb-init-target/package.json")).toBe(false);
        expect(project.files.has(`${target}package.json`)).toBe(true);
        expect(project.writes.length).toBeGreaterThan(0);
        expect(project.writes.every(path => path.startsWith(target))).toBe(true);
    });

    test("rejects path syntax before creating a target directory", async () => {
        const invalidNames = ["", ".", "..", "../outside", "/absolute", "a/b", "a\\b", "C:\\outside", "nul\0byte"];

        for (const directory of invalidNames) {
            let prepared = 0;
            const attempt = cliContext({
                async prepareDirectory() {
                    prepared += 1;
                    return "created";
                },
            });
            const code = await runCli(attempt.ctx, ["init", directory]);
            expect(code).not.toBe(0);
            expect(prepared).toBe(0);
            expect(attempt.stdout).toEqual([]);
        }
    });

    test("parses one exact core package override and rejects malformed forms", async () => {
        const specifier = "file:/private/tmp/chardb-core-0.1.0.tgz";
        let packageJson = "";
        const accepted = cliContext({
            async writeFilesExclusive(artifacts) {
                packageJson = artifacts.find(artifact => artifact.path.endsWith("/package.json"))?.contents ?? "";
            },
        });

        expect(await runCli(accepted.ctx, ["init", "candidate app", "--core-package", specifier])).toBe(0);
        expect(accepted.stderr).toEqual([]);
        expect(JSON.parse(packageJson).dependencies["@chardb/core"]).toBe(specifier);
        expect(accepted.stdout.join("")).toContain(`@chardb/core ${specifier}`);

        for (const argv of [
            ["init", "app", "--core-package"],
            ["init", "app", "--core-package", ""],
            ["init", "app", "--other", "value"],
            ["init", "app", "--core-package", "one", "--core-package", "two"],
        ]) {
            let prepared = 0;
            const rejected = cliContext({
                async prepareDirectory() {
                    prepared += 1;
                    return "created";
                },
            });
            expect(await runCli(rejected.ctx, argv)).toBe(2);
            expect(prepared).toBe(0);
            expect(rejected.stderr).toEqual(["usage: chardb init <name> [--core-package <specifier>]\n"]);
        }
    });

    test("refuses a non-empty target without writing or removing existing content", async () => {
        const project = memoryProject();
        const target = "/tmp/chardb-init-target/existing";
        project.directories.add(target);
        project.files.set(`${target}/notes.txt`, "keep me\n");

        await expect(runInit(project.ctx, { name: "existing", directory: "existing" })).rejects.toThrow(
            "top-level entries: notes.txt"
        );

        expect(project.writes).toEqual([]);
        expect(project.directories.has(target)).toBe(true);
        expect(project.files).toEqual(new Map([[`${target}/notes.txt`, "keep me\n"]]));
    });

    test("rejects a symlink target and never writes through it", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "chardb-init-symlink-"));
        const outside = resolve(root, "outside");
        await mkdir(outside);
        await symlink(outside, resolve(root, "linked"), "dir");
        try {
            await expect(
                runInit({ ...REAL_CONTEXT, cwd: root }, { name: "linked", directory: "linked" })
            ).rejects.toThrow("init target is not a real directory");
            expect(await readdir(outside)).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rollback preserves a file created by a concurrent writer", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "chardb-init-race-"));
        const real = { ...REAL_CONTEXT, cwd: root };
        const raced: CliContext = {
            ...real,
            async writeFilesExclusive(artifacts) {
                const conflict = artifacts.find(artifact => artifact.path.endsWith("/tsconfig.json"));
                if (!conflict) throw new Error("missing race target");
                await writeFile(conflict.path, "concurrent owner\n");
                await REAL_CONTEXT.writeFilesExclusive?.(artifacts);
            },
        };
        try {
            await expect(runInit(raced, { name: "raced", directory: "raced" })).rejects.toThrow();
            expect(await readFile(resolve(root, "raced/tsconfig.json"), "utf8")).toBe("concurrent owner\n");
            expect(await readdir(resolve(root, "raced"))).toEqual(["tsconfig.json"]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("persists the requested package specifier and documents package-local CLI commands", async () => {
        const project = memoryProject();
        const specifier = "file:/private/tmp/exact-chardb-candidate.tgz";
        await runInit(project.ctx, {
            name: "candidate-app",
            directory: "candidate-app",
            corePackage: specifier,
        });

        const root = "/tmp/chardb-init-target/candidate-app";
        const manifest = JSON.parse(project.files.get(`${root}/package.json`) ?? "null");
        const readme = project.files.get(`${root}/README.md`) ?? "";
        expect(manifest.dependencies["@chardb/core"]).toBe(specifier);
        expect(readme).toContain("bunx @chardb/core migrations generate --name <name>");
        expect(readme).toContain("bunx @chardb/core vectorize prepare");
        expect(readme).not.toMatch(/\bbun chardb\b/);
    });
});
