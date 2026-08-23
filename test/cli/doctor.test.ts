import { describe, expect, test } from "bun:test";
import { runDoctor } from "../../src/cli/commands/doctor.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import type { CliContext } from "../../src/cli/context.ts";
import { checkWrangler, renderWrangler } from "../../src/cli/wrangler_template.ts";

function fakeCtx(): { ctx: CliContext; files: Map<string, string>; out: string[]; err: string[] } {
    const files = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CliContext = {
        cwd: "/tmp/proj",
        env: {},
        stdout: s => out.push(s),
        stderr: s => err.push(s),
        async read(p) {
            const v = files.get(p);
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return v;
        },
        async write(p, contents) {
            files.set(p, contents);
        },
        async exists(p) {
            return files.has(p);
        },
    };
    return { ctx, files, out, err };
}

describe("renderWrangler / checkWrangler", () => {
    test("renderWrangler emits a complete config that doctor accepts", () => {
        const text = renderWrangler({
            name: "myapp",
            compatibilityDate: "2026-05-10",
            r2Bucket: "myapp-blobs",
            vectorizeIndex: "myapp-embeddings",
            gsiQueue: "myapp-gsi-tail",
            assetsDir: ".chardb/dashboard",
        });
        const r = checkWrangler(text);
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
        expect(JSON.parse(text).services).toBeUndefined();
    });

    test("checkWrangler reports each missing DO binding", () => {
        const r = checkWrangler('{"name":"x","main":"y","compatibility_date":"2026-05-10"}');
        expect(r.ok).toBe(false);
        expect(r.errors.some(e => e.includes("CDB_CATALOG"))).toBe(true);
        expect(r.errors.some(e => e.includes("CDB_SHARD"))).toBe(true);
    });

    test("checkWrangler tolerates JSONC comments", () => {
        const text = `${renderWrangler({
            name: "x",
            compatibilityDate: "2026-05-10",
            r2Bucket: "b",
            vectorizeIndex: "v",
            gsiQueue: "q",
            assetsDir: ".chardb/dashboard",
        })}\n// trailing comment`;
        const r = checkWrangler(`// header\n${text}`);
        expect(r.ok).toBe(true);
    });
});

describe("chardb init + doctor end-to-end", () => {
    test("init writes wrangler.jsonc + scaffolding; doctor passes", async () => {
        const { ctx, files } = fakeCtx();
        await runInit(ctx, { name: "myapp" });
        expect(files.has("/tmp/proj/wrangler.jsonc")).toBe(true);
        expect(files.has("/tmp/proj/src/schema.ts")).toBe(true);
        expect(files.has("/tmp/proj/src/api.ts")).toBe(true);
        expect(files.has("/tmp/proj/src/worker.ts")).toBe(true);
        // Worker template must be specialised to the app name.
        expect(files.get("/tmp/proj/src/worker.ts")).toContain('appName: "myapp"');
        expect(files.get("/tmp/proj/src/worker.ts")).not.toContain("ChardbWorker");
        expect(files.get("/tmp/proj/wrangler.jsonc")).not.toContain("CDB_WORKER");
        expect(files.get("/tmp/proj/src/schema.ts")).toContain("const { cdbTable } = forOrg()");
        expect(files.get("/tmp/proj/src/schema.ts")).toContain('selfBy: "authorId"');
        expect(files.get("/tmp/proj/src/api.ts")).toContain('partitionKey: "organizationId"');
        expect(files.get("/tmp/proj/src/api.ts")).toContain("handler: (ctx, args) =>");
        expect(files.get("/tmp/proj/src/api.ts")).toContain("}).run()");
        expect(files.get("/tmp/proj/src/api.ts")).not.toContain("handler: async");
        expect(files.get("/tmp/proj/src/api.ts")).not.toContain("tenantScope");

        const r = await runDoctor(ctx, { which: "wrangler" });
        expect(r.ok).toBe(true);
    });
});
