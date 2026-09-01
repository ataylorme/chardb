import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CHARDB_PACKAGE_NAME, CHARDB_REACT_PACKAGE_NAME, npmPackFilename } from "../scripts/package-identity.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("scoped npm package identity", () => {
    test("keeps the public package scoped while preserving the chardb binary", async () => {
        const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
        expect(packageJson.name).toBe(CHARDB_PACKAGE_NAME);
        expect(packageJson.publishConfig).toEqual({ access: "public" });
        expect(packageJson.bin).toEqual({
            chardb: "./dist/cli/bin.mjs",
            core: "./dist/cli/bin.mjs",
        });
        expect(packageJson.files).toEqual(["dist", "README.md"]);
        expect(npmPackFilename(CHARDB_PACKAGE_NAME, packageJson.version)).toBe("chardb-core-0.1.0.tgz");
        const reactPackage = JSON.parse(await readFile(path.join(ROOT, "packages", "react", "package.json"), "utf8"));
        expect(reactPackage.name).toBe(CHARDB_REACT_PACKAGE_NAME);
        expect(reactPackage.publishConfig).toEqual({ access: "public" });
        expect(npmPackFilename(CHARDB_REACT_PACKAGE_NAME, reactPackage.version)).toBe("chardb-react-0.1.0.tgz");
    });
});
