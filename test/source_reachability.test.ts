import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");
const sourceRoot = join(root, "src");
const extensions = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"] as const;

function filesUnder(directory: string): string[] {
    return readdirSync(directory).flatMap(name => {
        const path = join(directory, name);
        return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
}

function sourceFilesUnder(directory: string): string[] {
    return filesUnder(directory).filter(path => extensions.includes(extname(path) as (typeof extensions)[number]));
}

function resolveLocalImport(from: string, specifier: string): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(dirname(from), specifier);
    const candidates = extname(base)
        ? [base, ...extensions.map(extension => base.replace(/\.[^.]+$/, extension))]
        : [
              ...extensions.map(extension => `${base}${extension}`),
              ...extensions.map(extension => join(base, `index${extension}`)),
          ];
    return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function importGraph(paths: readonly string[]): ReadonlyMap<string, readonly string[]> {
    return new Map(
        paths.map(path => {
            const imports = ts
                .preProcessFile(readFileSync(path, "utf8"), true, true)
                .importedFiles.map(entry => resolveLocalImport(path, entry.fileName))
                .filter((entry): entry is string => entry !== null);
            return [path, imports] as const;
        })
    );
}

function reachableFrom(graph: ReadonlyMap<string, readonly string[]>, roots: readonly string[]): ReadonlySet<string> {
    const reached = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
        const path = pending.pop();
        if (!path || reached.has(path)) continue;
        reached.add(path);
        pending.push(...(graph.get(path) ?? []));
    }
    return reached;
}

describe("source reachability", () => {
    test("every source module belongs to a production, test, tooling, or compiler path", () => {
        const source = sourceFilesUnder(sourceRoot);
        const tests = sourceFilesUnder(join(root, "test"));
        const tooling = [...sourceFilesUnder(join(root, "scripts")), ...sourceFilesUnder(join(root, "example"))];
        const graph = importGraph([...source, ...tests, ...tooling]);
        const production = reachableFrom(
            graph,
            [
                "src/index.ts",
                "src/server/index.ts",
                "src/react/index.ts",
                "src/files/index.ts",
                "src/internal/vector-proof.ts",
                "src/cli/bin.ts",
                "src/cli/schema-inspector-preload.ts",
                "src/vite/index.ts",
            ].map(path => join(root, path))
        );
        const tested = reachableFrom(graph, tests);
        const usedByTooling = reachableFrom(graph, tooling);

        const testOnly = source
            .filter(path => !production.has(path) && tested.has(path))
            .map(path => relative(root, path))
            .sort();
        expect(testOnly).toEqual(
            [
                "src/auth/profile.ts",
                "src/cli/commands/deploy.ts",
                "src/cli/index.ts",
                "src/colocation/derive.ts",
                "src/eslint-plugin/index.ts",
                "src/observability/index.ts",
                "src/server/dt.ts",
                "src/server/dt_protocol.ts",
                "src/server/ledger.ts",
                "src/server/logpush.ts",
                "src/server/merge.ts",
            ].sort()
        );

        const compilerLoaded = ["src/eslint-plugin/peer-deps.d.ts"];
        const compilerOnly = source
            .filter(path => !production.has(path) && !tested.has(path) && !usedByTooling.has(path))
            .map(path => relative(root, path));
        expect(compilerOnly).toEqual(compilerLoaded);
    });
});
