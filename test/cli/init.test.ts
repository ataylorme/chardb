import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { integer, text } from "drizzle-orm/sqlite-core";
import { defineAuth } from "../../src/auth/synthesize.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import type { CliContext } from "../../src/cli/context.ts";
import { SCAFFOLD_INITIAL_SNAPSHOT } from "../../src/cli/scaffold-initial-snapshot.ts";
import { file } from "../../src/files/index.ts";
import { forOrg } from "../../src/server/schema-ownership.ts";
import { inspectInitialSchemaSnapshot } from "../../src/server/schema-snapshot.ts";

function generatedProject(): {
    readonly ctx: CliContext;
    readonly files: Map<string, string>;
    readonly writes: string[];
} {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const ctx: CliContext = {
        cwd: "/tmp/generated",
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
            return files.has(path);
        },
        async readDirectory(path) {
            const prefix = path.endsWith("/") ? path : `${path}/`;
            return [
                ...new Set(
                    [...files.keys()].flatMap(file => {
                        if (!file.startsWith(prefix)) return [];
                        const child = file.slice(prefix.length).split("/")[0];
                        return child ? [child] : [];
                    })
                ),
            ].sort();
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
    return { ctx, files, writes };
}

describe("generated tutorial flow", () => {
    test("refuses an existing package.json before writing", async () => {
        const { ctx, files, writes } = generatedProject();
        files.set("/tmp/generated/package.json", '{"name":"keep-me"}\n');

        await expect(runInit(ctx, { name: "must-not-overwrite" })).rejects.toThrow("generated targets: package.json");

        expect(writes).toEqual([]);
        expect(files).toEqual(new Map([["/tmp/generated/package.json", '{"name":"keep-me"}\n']]));
    });

    test("refuses an existing nested schema before writing", async () => {
        const { ctx, files, writes } = generatedProject();
        files.set("/tmp/generated/src/schema.ts", "export const existing = true;\n");

        await expect(runInit(ctx, { name: "must-not-overwrite" })).rejects.toThrow("generated targets: src/schema.ts");

        expect(writes).toEqual([]);
        expect(files.get("/tmp/generated/src/schema.ts")).toBe("export const existing = true;\n");
        expect(files.size).toBe(1);
    });

    test("refuses a partial scaffold and leaves every existing file unchanged", async () => {
        const { ctx, files, writes } = generatedProject();
        const existing = new Map([
            ["/tmp/generated/README.md", "existing readme\n"],
            ["/tmp/generated/wrangler.toml", 'name = "existing"\n'],
            ["/tmp/generated/src/auth.ts", "export const existing = true;\n"],
        ]);
        for (const [path, contents] of existing) files.set(path, contents);

        await expect(runInit(ctx, { name: "must-not-overwrite" })).rejects.toThrow(
            "chardb init requires an empty directory"
        );

        expect(writes).toEqual([]);
        expect(files).toEqual(existing);
    });

    test("refuses unrelated directory contents but allows Git metadata and Finder metadata", async () => {
        const blocked = generatedProject();
        blocked.files.set("/tmp/generated/notes.txt", "keep me\n");
        await expect(runInit(blocked.ctx, { name: "blocked" })).rejects.toThrow("top-level entries: notes.txt");
        expect(blocked.writes).toEqual([]);

        const allowed = generatedProject();
        allowed.files.set("/tmp/generated/.git/config", "[core]\n");
        allowed.files.set("/tmp/generated/.DS_Store", "finder metadata");
        await runInit(allowed.ctx, { name: "allowed" });
        expect(allowed.files.get("/tmp/generated/.git/config")).toBe("[core]\n");
        expect(allowed.files.get("/tmp/generated/.DS_Store")).toBe("finder metadata");
        expect(allowed.files.has("/tmp/generated/package.json")).toBe(true);
    });

    test("keeps the embedded scaffold snapshot identical to a fresh inspection", () => {
        const auth = defineAuth({ plugins: [anonymous(), organization(), jwt()] });
        const { cdbTable } = forOrg(auth);
        const messages = cdbTable(
            "messages",
            {
                id: text("id").primaryKey(),
                authorId: text("author_id")
                    .notNull()
                    .references(() => auth.user.id, { onDelete: "cascade" }),
                body: text("body").notNull(),
                attachment: file("attachment", {
                    maxSize: 5 * 1_024 * 1_024,
                    contentTypes: ["image/jpeg", "image/png"],
                }),
                createdAt: integer("created_at").notNull(),
            },
            {
                selfBy: "authorId",
                roles: {
                    owner: "*",
                    admin: "*",
                    member: { read: "*", create: ["id", "body", "attachment", "createdAt"] },
                    self: { read: "*", update: ["body", "attachment"], delete: true },
                },
            }
        );

        expect(
            inspectInitialSchemaSnapshot({
                name: "initial_schema",
                domainSchema: { messages },
                authOptions: auth.options,
            })
        ).toEqual(SCAFFOLD_INITIAL_SNAPSHOT);
    });

    test("keeps version one independent from mutable application schema", async () => {
        const { ctx, files } = generatedProject();
        await runInit(ctx, { name: "migration-history-check" });

        const migrations = files.get("/tmp/generated/src/migrations.ts") ?? "";
        const versionOne = files.get("/tmp/generated/src/migrations/v1.ts") ?? "";
        const snapshotOne = files.get("/tmp/generated/src/migrations/v1.json") ?? "";
        const readme = files.get("/tmp/generated/README.md") ?? "";

        expect(migrations).toContain('import { initialSchema } from "./migrations/v1.ts"');
        expect(migrations).toContain("defineMigrations([\n  initialSchema,\n])");
        expect(migrations).not.toContain('from "./schema.ts"');
        expect(migrations).not.toContain('from "./auth.ts"');
        expect(migrations).not.toContain("defineSchemaBaseline");

        expect(versionOne).toContain("immutable version-one schema snapshot");
        expect(versionOne).toContain("Do not edit this file after");
        expect(versionOne).not.toContain('from "../schema.ts"');
        expect(versionOne).not.toContain('from "../auth.ts"');
        expect(versionOne).not.toContain("defineAuth");
        expect(versionOne).not.toContain("cdbTable(");
        expect(versionOne).not.toContain("defineSchemaBaseline");
        expect(versionOne).not.toContain("better-auth");
        expect(versionOne).not.toContain("drizzle-orm");
        expect(versionOne).toContain("defineSchemaSnapshot({");
        expect(versionOne).toContain('"format": "chardb.schema-snapshot.v1"');
        expect(versionOne).toContain('"digest": "0fd0fcf9a9449e01fdeeb9834234b794a8d6b20b8031319aa0734b2ea03481f7"');
        expect(versionOne).toContain(".initialMigration");
        expect(JSON.parse(snapshotOne)).toEqual(SCAFFOLD_INITIAL_SNAPSHOT);
        expect(readme).toContain(
            "run `bunx @chardb/core migrations generate --name <name>` to append the next sequential version"
        );
        expect(readme).toContain("verifies the full JSON digest chain, every generated TypeScript file");
        expect(readme).not.toContain("shards split");
        expect(readme).not.toContain("virtual-shard range");
    });

    test("matches the visible organization tutorial contract", async () => {
        const { ctx, files } = generatedProject();
        await runInit(ctx, { name: "tutorial-check" });

        const root = resolve(import.meta.dir, "../..");
        const [chatAuth, chatApi, chatQueries, chatMigrations, chatWorker, chatDev, chatApp] = await Promise.all([
            readFile(resolve(root, "example/chat/src/server/auth.ts"), "utf8"),
            readFile(resolve(root, "example/chat/src/server/api.ts"), "utf8"),
            readFile(resolve(root, "example/chat/src/server/queries.ts"), "utf8"),
            readFile(resolve(root, "example/chat/src/server/migrations.ts"), "utf8"),
            readFile(resolve(root, "example/chat/src/server/worker.ts"), "utf8"),
            readFile(resolve(root, "example/chat/scripts/dev-worker.mjs"), "utf8"),
            readFile(resolve(root, "example/chat/src/web/App.tsx"), "utf8"),
        ]);

        const generatedAuth = files.get("/tmp/generated/src/auth.ts") ?? "";
        const generatedApi = files.get("/tmp/generated/src/api.ts") ?? "";
        const generatedQueries = files.get("/tmp/generated/src/queries.ts") ?? "";
        const generatedMigrations = files.get("/tmp/generated/src/migrations.ts") ?? "";
        const generatedV1 = files.get("/tmp/generated/src/migrations/v1.ts") ?? "";
        const generatedWorker = files.get("/tmp/generated/src/worker.ts") ?? "";
        const generatedDev = files.get("/tmp/generated/scripts/dev.mjs") ?? "";
        const generatedApp = files.get("/tmp/generated/src/web/App.tsx") ?? "";
        const generatedVite = files.get("/tmp/generated/vite.config.ts") ?? "";
        const generatedVitest = files.get("/tmp/generated/vitest.config.ts") ?? "";
        const generatedWorkerTest = files.get("/tmp/generated/test/worker.test.ts") ?? "";
        const generatedTest = files.get("/tmp/generated/scripts/test.mjs") ?? "";
        const generatedSetup = files.get("/tmp/generated/scripts/setup-cloudflare.mjs") ?? "";
        const generatedDeploy = files.get("/tmp/generated/scripts/deploy.mjs") ?? "";
        const generatedPackage = files.get("/tmp/generated/package.json") ?? "";
        const generatedReadme = files.get("/tmp/generated/README.md") ?? "";
        const generatedGitignore = files.get("/tmp/generated/.gitignore") ?? "";
        const generatedEnvExample = files.get("/tmp/generated/.env.example") ?? "";

        expect(generatedDev).toContain('import.meta.resolve("wrangler/package.json")');
        expect(generatedDev).toContain('import.meta.resolve("vite/package.json")');
        expect(generatedDev).toContain("[nodeRuntime, viteModule");
        expect(generatedDev).toContain("nodeRuntime,\n    wranglerModule");
        expect(generatedDev).toContain('["taskkill.exe", "/PID", String(pid), "/T", "/F"]');
        expect(generatedDev).toContain("runWindowsWatchdog(rootPid)");
        expect(generatedDev).toContain("Select-Object ProcessId, ParentProcessId, CreationDate");
        expect(generatedDev).toContain("tracked.set(child.pid, child.createdAt)");
        expect(generatedDev).toContain("live.get(pid) === createdAt");
        expect(generatedTest).toContain('import.meta.resolve("vitest/package.json")');
        expect(generatedTest).toContain('realpathSync.native(join(dirname(vitestPackage), "vitest.mjs"))');
        expect(generatedTest).toContain('[nodeRuntime, vitestCli, "run", "--no-file-parallelism"');
        expect(JSON.parse(generatedPackage).scripts.test).toBe("bun scripts/test.mjs");

        expect(generatedWorker).toContain("{ DB, Catalog, Cdb, Gateway, Resharder }");
        expect(generatedWorker).toContain("attachment?: string | null");
        expect(generatedWorker).toContain("body.attachment == null ? null : FileId(body.attachment)");

        expect(generatedAuth).toContain('import { organization } from "better-auth/plugins/organization"');
        expect(generatedAuth).toContain("plugins: [anonymous(), organization(), jwt()]");
        expect(generatedAuth).not.toContain('model: "organization"');
        expect(generatedAuth).not.toContain('model: "member"');
        expect(generatedAuth).not.toContain("activeOrganizationId");
        expect(generatedAuth).not.toContain('"demo-org"');
        expect(generatedAuth).not.toContain("databaseHooks");
        expect(generatedAuth).not.toContain("DBAdapter");
        expect(generatedAuth).not.toContain("forceAllowId");
        expect(chatAuth).toContain("anonymous()");
        for (const source of [generatedApi, chatApi]) {
            expect(source).toContain('authority: "organization"');
            expect(source).toContain('partitionKey: "organizationId"');
            expect(source).toContain("clientCreatedAt");
            expect(source).toContain("ctx.auth.tenantId !== args.organizationId");
        }
        for (const source of [generatedQueries, chatQueries]) {
            expect(source).toContain("limit: z.number().int().min(1).max(100).default(50)");
            expect(source).toContain("desc(messages.createdAt), desc(messages.id)");
        }
        expect(generatedMigrations).toContain('from "./migrations/v1.ts"');
        expect(generatedV1).toContain("defineSchemaSnapshot");
        expect(generatedV1).not.toContain("defineSchemaBaseline");
        expect(chatMigrations).toContain('from "./migrations/v1.ts"');
        expect(chatWorker).toContain('from "./migrations.ts"');
        for (const source of [generatedWorker, chatWorker]) {
            expect(source).toContain("schemaVersion: migrations.version");
        }
        for (const source of [generatedDev, chatDev]) {
            expect(source).toContain("body.schemaVersion");
            expect(source).toContain('"--target"');
        }
        for (const source of [generatedWorker, chatWorker]) {
            expect(source).toContain('app.get("/api/messages"');
            expect(source).toContain('app.post("/api/messages"');
            expect(source).toContain("desc(");
            expect(source).toContain("limit must be an integer from 1 through 100");
        }
        for (const source of [generatedApp, chatApp]) {
            expect(source).toContain("anonymousSignInRequest ??=");
            expect(source).toContain("Sign-in failed:");
        }
        expect(chatApp).toContain("authClient.signIn.anonymous()");
        expect(chatApp).toContain("useQuery(listMessages");
        expect(chatApp).toContain("useMutation<");
        expect(chatApp).toContain("<ChardbProvider");
        expect(generatedApp).toContain('import { createAuthClient } from "better-auth/react"');
        expect(generatedApp).toContain('import { createChardbReactClient } from "@chardb/react"');
        expect(generatedApp).toContain("const workerUrl = window.location.origin");
        expect(generatedApp).toContain("const db = createChardbReactClient({");
        expect(generatedApp).toContain("url: workerUrl");
        expect(generatedApp).toContain('ownership: "organization"');
        expect(generatedApp).toContain("auth: ({ baseURL }) => createAuthClient({");
        expect(generatedApp).toContain("baseURL,");
        expect(generatedApp).toContain("plugins: [anonymousClient(), organizationClient(), jwtClient()]");
        expect(generatedApp).toContain("(organization: Organization)");
        expect(generatedApp).toContain("const session = db.auth.useSession()");
        expect(generatedApp).toContain("const identity = db.useIdentity()");
        expect(generatedApp).toContain("const organizations = db.auth.useListOrganizations()");
        expect(generatedApp).not.toContain("useAuthSession");
        expect(generatedApp).not.toContain("useOrganizations");
        expect(generatedApp).not.toContain("useSession.get()");
        expect(generatedApp).not.toContain("useSession.subscribe(");
        expect(generatedApp).not.toContain('useSession } from "@chardb/react"');
        expect(generatedApp).toContain("db.auth.organization.create({");
        expect(generatedApp).toContain("db.auth.organization.setActive({ organizationId");
        expect(generatedApp).toContain("db.auth.organization.delete({ organizationId: activeOrganizationId })");
        expect(generatedApp).toContain('data-testid="delete-organization"');
        expect(generatedApp).toContain("db.useQuery(listMessages, { limit: 50 })");
        expect(generatedApp).toContain("db.useMutation(postMessage)");
        expect(generatedApp).not.toContain("db.useQuery(listMessages, { organizationId");
        expect(generatedApp).not.toContain("id: uuidv7(),\n        organizationId,");
        expect(generatedApp).toContain('fileRef("messages", "attachment")');
        expect(generatedApp).toContain("db.useFile(messageAttachment)");
        expect(generatedApp).not.toContain("attachment.upload({\n        organizationId,");
        expect(generatedApp).toContain("attachment.downloadUrl({ rowId: message.id })");
        expect(generatedApp).toContain('data-testid="message-file"');
        expect(generatedApp).toContain('data-testid="message-attachment"');
        expect(generatedApp).toContain("replaceMessageAttachment");
        expect(generatedApp).toContain('data-testid="message-replacement-file"');
        expect(generatedApp).not.toContain('from "../schema.ts"');
        expect(generatedApp).toContain('data-testid="auth-status"');
        expect(generatedApp).toContain('data-testid="organization-select"');
        expect(generatedApp).toContain("data-slug={organization.slug}");
        expect(generatedApp).toContain('data-testid="create-organization-name"');
        expect(generatedApp).toContain('data-testid="create-organization-slug"');
        expect(generatedApp).toContain('data-testid="create-organization-submit"');
        expect(generatedApp).toContain('data-testid="message-list"');
        expect(generatedApp).toContain('data-testid="query-state"');
        expect(generatedApp).toContain("data-organization-id={organizationId}");
        expect(generatedApp).not.toContain("ORGANIZATION_ID");
        expect(generatedVite).toContain('import { chardb } from "@chardb/core/vite"');
        expect(generatedVite).toContain("publicDir: false");
        expect(generatedVite).toContain("chardb()");
        expect(generatedVite).not.toContain("serverModuleGlob");
        expect(generatedVite).not.toContain("migrations:");
        expect(generatedVite).not.toContain("schema:");
        expect(generatedVite).toContain('outDir: "public"');
        expect(generatedVite).toContain('const workerOrigin = process.env.CHARDB_URL ?? "http://127.0.0.1:8787"');
        expect(generatedVite).toContain('"/ws": { target: workerSocket, ws: true, changeOrigin: true }');
        expect(generatedVite).toContain('request.setHeader("origin", workerOrigin)');
        expect(generatedVitest).toContain('configPath: "./wrangler.toml"');
        expect(generatedVitest).toContain('CDB_ADMIN_TOKEN: "chardb-vitest-admin"');
        expect(generatedWorkerTest).toContain('from "cloudflare:workers"');
        expect(generatedWorkerTest).toContain('migration("complete"');
        expect(generatedWorkerTest).toContain('auth("sign-in/anonymous"');
        expect(generatedWorkerTest).toContain('auth("organization/create"');
        expect(generatedWorkerTest).toContain('auth("organization/list"');
        expect(generatedWorkerTest).toContain("session.body.session.activeOrganizationId");
        expect(generatedWorkerTest).toContain('from "@msw/cloudflare"');
        expect(generatedWorkerTest).toContain('http.get(origin + "/api/auth/jwks"');
        expect(generatedWorkerTest).toContain('body: "written inside workerd"');
        expect(generatedWorker).toContain("schemaDigest: migrations.digest");
        expect(generatedWorkerTest).toContain("schemaDigest: migrations.digest");
        expect(generatedWorkerTest).toContain("const targetVersion = migrations.version");
        expect(generatedSetup).toContain('wrangler("r2", "bucket", "create", filesBucket)');
        expect(generatedDeploy).toContain("deploymentDecision({ bootstrap, exists");
        expect(generatedDeploy).toContain('chardb(\n      "migrate"');
        expect(JSON.parse(generatedPackage).scripts).toMatchObject({
            "setup:cloudflare": "bun scripts/setup-cloudflare.mjs",
            "deploy:bootstrap": "bun scripts/deploy.mjs --bootstrap",
            deploy: "bun scripts/deploy.mjs",
        });
        expect(generatedReadme).toContain("Copy `.env.example` to `.env.local`");
        expect(generatedReadme).toContain("bun run deploy:bootstrap\nbun run deploy");
        expect(generatedReadme).not.toContain("CHARDB_URL=https://");
        expect(generatedGitignore).toContain(".env.*\n!.env.example");
        expect(generatedEnvExample).toContain("CHARDB_URL=https://your-worker.example.com");
        expect(generatedEnvExample).not.toContain("bun run");
    });
});
