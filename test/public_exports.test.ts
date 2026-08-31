import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as clientApi from "../src/index.ts";
import * as serverApi from "../src/server/index.ts";
import * as viteApi from "../src/vite/index.ts";

describe("published API boundary", () => {
    test("root exports only clients and the shared error contract", () => {
        expect(Object.keys(clientApi).sort()).toEqual([
            "CDB_ERROR_CODES",
            "CdbError",
            "client",
            "createChardbClient",
            "docsUrlFor",
            "isCdbError",
            "isRetryable",
        ]);
    });

    test("server exports only the organization application API", () => {
        expect(Object.keys(serverApi).sort()).toEqual([
            "api",
            "chardb",
            "defineAuth",
            "defineMigrations",
            "defineSchemaBaseline",
            "defineSchemaSnapshot",
            "forOrg",
            "forOrgUser",
            "searchVector",
            "vector",
        ]);
    });

    test("vite exports only the browser-safety transform", () => {
        expect(Object.keys(viteApi).sort()).toEqual(["chardb", "default"]);
    });

    test("package publishes five supported entry points", async () => {
        const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
            readonly exports: Record<string, unknown>;
        };
        expect(Object.keys(pkg.exports)).toEqual([".", "./server", "./react", "./files", "./vite"]);
    });

    test("packed export smoke owns and bounds its child process tree", async () => {
        const source = await readFile(path.join(import.meta.dir, "..", "scripts", "smoke-packed-package.mjs"), "utf8");

        expect(source).toContain('const LOADABLE_EXPORTS = [".", "./files", "./vite"]');
        expect(source).toContain('["./server", "requires the Cloudflare Workers runtime');
        expect(source).toContain('["./react", "requires the optional react peer"]');
        expect(source).toContain('"./observability"');
        expect(source).toContain('label: "packed package smoke"');
        expect(source).toContain("timeoutMs: 5 * 60_000");
        expect(source).toContain("timeout: COMMAND_TIMEOUT_MS");
        expect(source).toContain('killSignal: "SIGTERM"');
    });
});
