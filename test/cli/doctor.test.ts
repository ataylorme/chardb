import { describe, expect, test } from "bun:test";
import { runDoctor } from "../../src/cli/commands/doctor.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import type { CliContext } from "../../src/cli/context.ts";
import { checkWrangler, renderWrangler, renderWranglerJsonc } from "../../src/cli/wrangler_template.ts";

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
            assetsDir: ".chardb/dashboard",
        });
        const r = checkWrangler(text);
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
        expect(r.warnings).toEqual([]);
        const config = Bun.TOML.parse(text) as {
            services?: unknown;
            durable_objects?: unknown;
            r2_buckets?: unknown;
            vectorize?: unknown;
            queues?: unknown;
            triggers?: unknown;
            tail_consumers?: unknown;
            compatibility_flags?: unknown;
            assets: { run_worker_first?: unknown };
        };
        expect(config.services).toBeUndefined();
        expect(config.durable_objects).toBeUndefined();
        expect(config.r2_buckets).toBeUndefined();
        expect(config.vectorize).toBeUndefined();
        expect(config.queues).toBeUndefined();
        expect(config.triggers).toBeUndefined();
        expect(config.tail_consumers).toBeUndefined();
        expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
        expect(config.assets.run_worker_first).toEqual(["/_chardb/*", "/ws"]);
    });

    test("checkWrangler reports each missing Durable Object migration", () => {
        const r = checkWrangler('{"name":"x","main":"y","compatibility_date":"2026-05-10"}');
        expect(r.ok).toBe(false);
        expect(r.errors.some(e => e.includes('"Catalog"'))).toBe(true);
        expect(r.errors.some(e => e.includes('"Cdb"'))).toBe(true);
    });

    test("requires native loopback compatibility by date or explicit flag", () => {
        const oldConfig = JSON.parse(
            renderWranglerJsonc({ name: "old", compatibilityDate: "2025-11-16", assetsDir: "public" })
        );
        expect(checkWrangler(JSON.stringify(oldConfig)).errors).toContain(
            'native loopback exports require compatibility_date >= "2025-11-17" or compatibility_flags to include "enable_ctx_exports"'
        );

        oldConfig.compatibility_flags.push("enable_ctx_exports");
        expect(checkWrangler(JSON.stringify(oldConfig)).ok).toBe(true);

        oldConfig.compatibility_flags.push("disable_ctx_exports");
        expect(checkWrangler(JSON.stringify(oldConfig)).ok).toBe(false);
    });

    test("checkWrangler tolerates JSONC comments", () => {
        const text = `${renderWranglerJsonc({
            name: "x",
            compatibilityDate: "2026-05-10",
            assetsDir: ".chardb/dashboard",
        })}\n// trailing comment`;
        const r = checkWrangler(`// header\n${text}`);
        expect(r.ok).toBe(true);
    });

    test("checkWrangler warns only about missing live reserved routes", () => {
        const cfg = JSON.parse(
            renderWranglerJsonc({
                name: "x",
                compatibilityDate: "2026-05-10",
                assetsDir: ".chardb/dashboard",
            })
        );
        cfg.assets.run_worker_first = [];

        const result = checkWrangler(JSON.stringify(cfg));

        expect(result.warnings).toEqual([
            "assets.run_worker_first should include reserved chardb routes (/_chardb/*,/ws)",
        ]);
        expect(result.warnings.join("")).not.toMatch(/\/q|\/f|\/p|\/s,/);
    });
});

describe("chardb init + doctor end-to-end", () => {
    test("init writes wrangler.toml + scaffolding; doctor passes", async () => {
        const { ctx, files } = fakeCtx();
        await runInit(ctx, { name: "myapp" });
        expect(files.has("/tmp/proj/package.json")).toBe(true);
        expect(files.has("/tmp/proj/tsconfig.json")).toBe(true);
        expect(files.has("/tmp/proj/.gitignore")).toBe(true);
        expect(files.has("/tmp/proj/README.md")).toBe(true);
        expect(files.has("/tmp/proj/wrangler.toml")).toBe(true);
        expect(files.has("/tmp/proj/wrangler.jsonc")).toBe(false);
        expect(files.has("/tmp/proj/src/schema.ts")).toBe(true);
        expect(files.has("/tmp/proj/src/api.ts")).toBe(true);
        expect(files.has("/tmp/proj/src/worker.ts")).toBe(true);
        expect(files.has("/tmp/proj/public/index.html")).toBe(true);
        expect(JSON.parse(files.get("/tmp/proj/package.json") ?? "")).toMatchObject({
            packageManager: "bun@1.2.22",
            dependencies: { chardb: "0.1.0" },
            devDependencies: {
                "@cloudflare/workers-types": "5.20260820.1",
                wrangler: "4.125.0",
            },
            scripts: { typecheck: "tsc --noEmit", build: "wrangler deploy --dry-run --outdir dist" },
        });
        expect(JSON.parse(files.get("/tmp/proj/tsconfig.json") ?? "").compilerOptions).not.toHaveProperty("paths");
        // Worker template must be specialised to the app name.
        expect(files.get("/tmp/proj/src/worker.ts")).toContain('appName: "myapp"');
        expect(files.get("/tmp/proj/src/worker.ts")).toContain("{ DB, BlobMeta, Catalog, Cdb, Gateway");
        expect(files.get("/tmp/proj/src/worker.ts")).not.toContain("ChardbWorker");
        expect(files.get("/tmp/proj/wrangler.toml")).not.toContain("CDB_WORKER");
        expect(files.get("/tmp/proj/src/schema.ts")).toContain("const { cdbTable } = forOrg()");
        expect(files.get("/tmp/proj/src/schema.ts")).toContain('selfBy: "authorId"');
        expect(files.get("/tmp/proj/src/api.ts")).toContain('partitionKey: "organizationId"');
        expect(files.get("/tmp/proj/src/api.ts")).toContain('authority: "organization"');
        expect(files.get("/tmp/proj/src/api.ts")).toContain('ref: "src/api.ts#postMessage"');
        expect(files.get("/tmp/proj/src/api.ts")).toContain("handler: (ctx, args) =>");
        expect(files.get("/tmp/proj/src/api.ts")).toContain("}).run()");
        expect(files.get("/tmp/proj/src/api.ts")).not.toContain("handler: async");
        expect(files.get("/tmp/proj/src/api.ts")).not.toContain("tenantScope");
        expect(files.get("/tmp/proj/README.md")).toContain("no application-visible Durable Object bindings");
        expect(files.get("/tmp/proj/wrangler.toml")).not.toContain("durable_objects");
        expect(files.get("/tmp/proj/wrangler.toml")).toContain("new_sqlite_classes");

        const r = await runDoctor(ctx, { which: "wrangler" });
        expect(r.ok).toBe(true);
    });

    test("doctor accepts an existing wrangler.jsonc project", async () => {
        const { ctx, files, out } = fakeCtx();
        files.set(
            "/tmp/proj/wrangler.jsonc",
            renderWranglerJsonc({ name: "legacy-jsonc", compatibilityDate: "2026-05-10", assetsDir: "public" })
        );

        const result = await runDoctor(ctx, { which: "wrangler" });

        expect(result.ok).toBe(true);
        expect(out).toEqual(["chardb doctor: wrangler.jsonc passes\n"]);
    });

    test("escapes the application name in generated TypeScript", async () => {
        const { ctx, files } = fakeCtx();

        await runInit(ctx, { name: 'quoted"app' });

        expect(files.get("/tmp/proj/src/worker.ts")).toContain('appName: "quoted\\"app"');
    });
});

describe("unimplemented doctor targets", () => {
    test("schema reports a failed check on stderr", async () => {
        const { ctx, out, err } = fakeCtx();

        const result = await runDoctor(ctx, { which: "schema" });

        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("not implemented");
        expect(out).toEqual([]);
        expect(err).toEqual([`error: ${result.errors[0]}\n`]);
    });

    test("auth reports a failed check on stderr", async () => {
        const { ctx, out, err } = fakeCtx();

        const result = await runDoctor(ctx, { which: "auth" });

        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("not implemented");
        expect(out).toEqual([]);
        expect(err).toEqual([`error: ${result.errors[0]}\n`]);
    });
});
