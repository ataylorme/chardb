import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CHARDB_PACKAGE_NAME, CHARDB_REACT_PACKAGE_NAME, npmPackFilename } from "../scripts/package-identity.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCANNED_EXTENSIONS = new Set([".json", ".md", ".mjs", ".mts", ".ts", ".tsx", ".toml", ".yml", ".yaml"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".wrangler", "artifacts", "coverage", "dist", "node_modules"]);

async function sourceFiles(directory = ROOT): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name))
                files.push(...(await sourceFiles(path.join(directory, entry.name))));
        } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
            files.push(path.join(directory, entry.name));
        }
    }
    return files;
}

describe("scoped npm package identity", () => {
    test("keeps the public package scoped while preserving the chardb binary", async () => {
        const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
        expect(packageJson.name).toBe(CHARDB_PACKAGE_NAME);
        expect(packageJson.publishConfig).toEqual({ access: "public" });
        expect(packageJson.bin).toEqual({
            chardb: "./dist/cli/bin.mjs",
            core: "./dist/cli/bin.mjs",
        });
        expect(packageJson.files).toEqual([
            "dist",
            "README.md",
            "COST.md",
            "ARCHITECTURE.md",
            "OPERATIONS.md",
            "SECURITY.md",
        ]);
        expect(npmPackFilename(CHARDB_PACKAGE_NAME, packageJson.version)).toBe("chardb-core-0.1.0.tgz");
        const reactPackage = JSON.parse(await readFile(path.join(ROOT, "packages", "react", "package.json"), "utf8"));
        expect(reactPackage.name).toBe(CHARDB_REACT_PACKAGE_NAME);
        expect(reactPackage.publishConfig).toEqual({ access: "public" });
        expect(npmPackFilename(CHARDB_REACT_PACKAGE_NAME, reactPackage.version)).toBe("chardb-react-0.1.0.tgz");
    });

    test("keeps the one-line project command direct", async () => {
        const [readme, landing] = await Promise.all([
            readFile(path.join(ROOT, "README.md"), "utf8"),
            readFile(path.join(ROOT, "landing", "src", "lib", "constants.ts"), "utf8"),
        ]);
        for (const source of [readme, landing]) {
            expect(source).toContain("bunx @chardb/core init my-chardb-app");
            expect(source).not.toMatch(/mkdir my-chardb-app|bunx chardb\b/);
        }
    });

    test("rejects stale executable package literals without banning the product or CLI name", async () => {
        const stale = [];
        for (const file of await sourceFiles()) {
            if (file === import.meta.path) continue;
            const source = await readFile(file, "utf8");
            const checks = [
                /(?:from\s*|import\s*\(|require\s*\()\s*["']chardb(?:\/[A-Za-z0-9_./-]+)?["']/,
                /\b(?:bunx|npx)\s+chardb\b/,
                /node_modules\/chardb(?:\/|["'])/,
                /["']node_modules["']\s*,\s*["']chardb["']\s*,/,
                /\bchardb-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz\b/,
            ];
            if (checks.some(pattern => pattern.test(source))) stale.push(path.relative(ROOT, file));
        }
        expect(stale).toEqual([]);
    });
});
