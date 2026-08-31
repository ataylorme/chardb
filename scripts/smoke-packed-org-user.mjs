import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { fingerprintFile, writeJsonAtomically } from "./browser-proof-report.mjs";
import { disposeMiniflareBounded } from "./miniflare-lifecycle.mjs";
import { buildPackedOrgUserReport, parsePackedOrgUserArgs } from "./packed-org-user-report.mjs";

const options = parsePackedOrgUserArgs(process.argv.slice(2));
const tarballPath = resolve(options.tarball);
const reportPath = resolve(
    process.env.CDB_PACKED_ORG_USER_REPORT ?? options.reportPath ?? `${tarballPath}.org-user.json`
);
const consumerDirectory = await mkdtemp(join(tmpdir(), "chardb-org-user-consumer-"));
const npmCache = process.env.npm_config_cache ?? join(consumerDirectory, ".npm-cache");

try {
    await writeFile(
        join(consumerDirectory, "package.json"),
        `${JSON.stringify(
            {
                name: "chardb-org-user-consumer",
                private: true,
                type: "module",
                dependencies: {
                    "@chardb/core": `file:${tarballPath}`,
                    "better-auth": "1.6.30",
                    "drizzle-orm": "0.45.2",
                    typescript: "5.6.3",
                    zod: "4.0.0",
                },
            },
            null,
            2
        )}\n`
    );
    await writeFile(
        join(consumerDirectory, "tsconfig.json"),
        `${JSON.stringify(
            {
                compilerOptions: {
                    target: "ES2022",
                    module: "ESNext",
                    moduleResolution: "Bundler",
                    strict: true,
                    noEmit: true,
                    allowImportingTsExtensions: true,
                    skipLibCheck: true,
                },
                include: ["*.ts"],
            },
            null,
            2
        )}\n`
    );
    await writeFile(
        join(consumerDirectory, "auth.ts"),
        `import { organization } from "better-auth/plugins/organization";
import { defineAuth } from "@chardb/core/server";

export const auth = defineAuth({ plugins: [organization()] });
`
    );
    await writeFile(
        join(consumerDirectory, "project-schema.ts"),
        `import { text } from "drizzle-orm/sqlite-core";
import { forOrg } from "@chardb/core/server";
import { auth } from "./auth.ts";

const { cdbTable: orgTable } = forOrg(auth);
export const projects = orgTable(
    "projects",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
    },
    { roles: { owner: "*", admin: "*", member: { read: "*" } } }
);

const projectInsert: typeof projects.$inferInsert = { id: "project-1", name: "Roadmap" };
void projectInsert;
`
    );
    await writeFile(
        join(consumerDirectory, "draft-schema.ts"),
        `import { text } from "drizzle-orm/sqlite-core";
import { forOrgUser } from "@chardb/core/server";
import { auth } from "./auth.ts";

const { cdbTable: orgUserTable } = forOrgUser(auth);
export const drafts = orgUserTable(
    "drafts",
    {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
    },
    {
        roles: {
            admin: { read: "*" },
            self: { create: ["id", "title"], read: "*", update: ["title"], delete: true },
        },
    }
);

const draftInsert: typeof drafts.$inferInsert = { id: "draft-1", title: "Launch notes" };
void draftInsert;
`
    );
    await writeFile(
        join(consumerDirectory, "user-schema.ts"),
        `import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { api, forUser } from "@chardb/core/server";
import { auth } from "./auth.ts";

const { cdbTable } = forUser(auth);
export const preferences = cdbTable("preferences", {
    id: text("id").primaryKey(),
    value: text("value").notNull(),
});

const preferenceInsert: typeof preferences.$inferInsert = { id: "preference-1", value: "compact" };
void preferenceInsert;

export const savePreference = api.mutation({
    ref: "user-schema.ts#savePreference",
    authority: "user",
    args: z.object({ userId: z.string(), id: z.string(), value: z.string() }),
    partitionKey: "userId",
    handler: (ctx, args: { userId: string; id: string; value: string }) => {
        ctx.db.insert(preferences).values({ id: args.id, value: args.value }).run();
        return args.id;
    },
});
`
    );
    await writeFile(
        join(consumerDirectory, "runtime-worker.ts"),
        `import { organization } from "better-auth/plugins/organization";
import { jwt } from "better-auth/plugins/jwt";
import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { api, chardb, defineAuth, forOrg, forOrgUser } from "@chardb/core/server";

const auth = defineAuth({
    appName: "packed-org-user-runtime",
    baseURL: "https://packed-org-user.invalid",
    plugins: [organization(), jwt()],
});

const { cdbTable: orgTable } = forOrg(auth);
const projects = orgTable(
    "runtime_projects",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
    },
    { roles: { member: { create: ["id", "name"], read: "*" } } }
);

const { cdbTable: orgUserTable } = forOrgUser(auth);
const drafts = orgUserTable(
    "runtime_drafts",
    {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
    },
    {
        roles: {
            admin: { read: "*" },
            self: { create: ["id", "title"], read: "*" },
        },
    }
);

const createProject = api.mutation({
    ref: "packed-org-user/runtime-worker.ts#createProject",
    authority: "organization",
    args: z.object({ id: z.string(), organizationId: z.string(), name: z.string() }),
    partitionKey: "organizationId",
    handler: (ctx, args: { id: string; organizationId: string; name: string }) => {
        ctx.db.insert(projects).values({ id: args.id, name: args.name }).run();
        return args.id;
    },
});

const listProjects = api.mutation({
    ref: "packed-org-user/runtime-worker.ts#listProjects",
    authority: "organization",
    args: z.object({ organizationId: z.string() }),
    partitionKey: "organizationId",
    handler: (ctx, _args: { organizationId: string }) => ctx.db.select().from(projects).orderBy(projects.id).all(),
});

const createDraft = api.mutation({
    ref: "packed-org-user/runtime-worker.ts#createDraft",
    authority: "organization",
    args: z.object({ id: z.string(), organizationId: z.string(), title: z.string() }),
    partitionKey: "organizationId",
    handler: (ctx, args: { id: string; organizationId: string; title: string }) => {
        ctx.db.insert(drafts).values({ id: args.id, title: args.title }).run();
        return args.id;
    },
});

const listDrafts = api.mutation({
    ref: "packed-org-user/runtime-worker.ts#listDrafts",
    authority: "organization",
    args: z.object({ organizationId: z.string() }),
    partitionKey: "organizationId",
    handler: (ctx, _args: { organizationId: string }) => ctx.db.select().from(drafts).orderBy(drafts.id).all(),
});

const app = chardb({
    auth,
    schema: { projects, drafts },
    api: { createProject, listProjects, createDraft, listDrafts },
});

export const { Cdb, Catalog, Gateway, Resharder, DB } = app;
export default {
    async fetch(
        request: Request,
        env: {
            Cdb: {
                idFromName(name: string): unknown;
                get(id: unknown): unknown;
            };
        }
    ): Promise<Response> {
        const input = (await request.json()) as {
            shard: string;
            principalId: string;
            mutId: string;
            ref: string;
            args: Record<string, unknown>;
            auth: Record<string, unknown>;
        };
        const cdb = env.Cdb.get(env.Cdb.idFromName(input.shard)) as unknown as {
            mutate(request: Record<string, unknown>): Promise<Record<string, unknown>>;
        };
        return Response.json(
            await cdb.mutate({
                principalId: input.principalId,
                mutId: input.mutId,
                ref: input.ref,
                args: input.args,
                auth: input.auth,
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        );
    },
};
`
    );

    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerDirectory, {
        npm_config_cache: npmCache,
    });
    run("npm", ["exec", "--", "tsc", "--project", "tsconfig.json"], consumerDirectory, {
        npm_config_cache: npmCache,
    });

    const workerPath = join(consumerDirectory, "runtime-worker.mjs");
    run(
        "bun",
        [
            "build",
            join(consumerDirectory, "runtime-worker.ts"),
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            workerPath,
        ],
        consumerDirectory
    );
    let workerSource = await readFile(workerPath, "utf8");
    workerSource = workerSource.replace(
        "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
        'await Promise.reject(new Error("Node file migrations are unavailable in workerd"))'
    );
    workerSource = workerSource.replace(
        "await import(nodeSqlite)",
        'await Promise.reject(new Error("Node sqlite is unavailable in workerd"))'
    );
    if (/\bimport\s*\([^"'`]/.test(workerSource)) {
        throw new Error("packed org-user Worker contains an unsupported dynamic import");
    }

    const packageJson = JSON.parse(
        await readFile(join(consumerDirectory, "node_modules", "@chardb", "core", "package.json"), "utf8")
    );
    if (packageJson.name !== "@chardb/core") {
        throw new Error(`packed package name is ${JSON.stringify(packageJson.name)}, expected "@chardb/core"`);
    }
    const serverExport = packageJson.exports?.["./server"];
    if (serverExport?.types !== "./dist/server/index.d.mts" || serverExport?.import !== "./dist/server/index.mjs") {
        throw new Error("packed package does not expose the supported server entry point");
    }
    const declaration = await readFile(
        join(consumerDirectory, "node_modules", "@chardb", "core", "dist", "server", "index.d.mts"),
        "utf8"
    );
    if (!["forOrg", "forOrgUser", "forUser"].every(name => declaration.includes(`declare function ${name}(`))) {
        throw new Error("packed server declaration lost explicit organization-user ownership");
    }
    if (declaration.includes("bindOrganizationOwnership") || declaration.includes("bindOrganizationUserOwnership")) {
        throw new Error("packed server declaration leaked ownership implementation names");
    }
    const exportedTypes = declaration.match(/export type \{([^}]*)\};/)?.[1] ?? "";
    if (
        /\b(?:OrganizationOwnershipAuth|OrganizationUserOwnershipAuth|UserOwnershipAuth|OwnedCdbTable)\b/.test(
            exportedTypes
        )
    ) {
        throw new Error("packed server declaration exported ownership implementation types");
    }
    if (!/export \{[^}]*\bforOrg\b[^}]*\bforOrgUser\b[^}]*\bforUser\b[^}]*\};/.test(declaration)) {
        throw new Error("packed server declaration does not export explicit ownership factories");
    }
    const runtime = await readFile(
        join(consumerDirectory, "node_modules", "@chardb", "core", "dist", "server", "index.mjs"),
        "utf8"
    );
    if (!/export \{[^}]*\bforOrgUser\b[^}]*\};/.test(runtime)) {
        throw new Error("packed server runtime does not export forOrgUser");
    }
    const rootDeclaration = await readFile(
        join(consumerDirectory, "node_modules", "@chardb", "core", "dist", "index.d.mts"),
        "utf8"
    );
    if (rootDeclaration.includes("forOrgUser")) {
        throw new Error("packed client entry point leaked the server-only forOrgUser export");
    }

    await runRuntimeProof(workerSource);

    const report = buildPackedOrgUserReport({
        package: {
            name: packageJson.name,
            version: packageJson.version,
            tarball: await fingerprintFile(tarballPath),
        },
        checks: {
            strictConsumerTypecheck: true,
            organizationScopeCompiled: true,
            organizationUserScopeCompiled: true,
            implicitTenantColumnsOmittedFromInserts: true,
            serverDeclarationExported: true,
            serverRuntimeExported: true,
            clientEntryPointExcludedServerScope: true,
            workerdRuntimeExecuted: true,
            organizationPeerReadAllowed: true,
            organizationUserSelfWriteAllowed: true,
            organizationUserPeerReadDenied: true,
            organizationAdminReadAllowed: true,
            crossOrganizationIsolation: true,
            unauthorizedOrganizationWriteDenied: true,
        },
    });
    await writeJsonAtomically(reportPath, report);

    console.log(`verified ${packageJson.name}@${packageJson.version}`);
    console.log(
        "verified one organization table and one organization-user table from the packed runtime and declaration"
    );
    console.log(`wrote ${reportPath}`);
} finally {
    await rm(consumerDirectory, { recursive: true, force: true });
}

async function runRuntimeProof(workerSource) {
    const instance = new Miniflare({
        modules: true,
        script: workerSource,
        durableObjects: {
            Cdb: { className: "Cdb", useSQLite: true },
            Catalog: { className: "Catalog", useSQLite: true },
            Gateway: { className: "Gateway", useSQLite: true },
            Resharder: { className: "Resharder", useSQLite: true },
        },
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
    let primaryFailure;
    let disposal;
    try {
        await instance.ready;
        const call = async ({ principalId, organizationId, role, mutId, ref, args }) => {
            const response = await instance.dispatchFetch("http://packed-org-user.invalid/proof", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    shard: "packed-org-user-runtime",
                    principalId,
                    mutId,
                    ref,
                    args: { organizationId, ...args },
                    auth: {
                        userId: principalId,
                        tenantId: organizationId,
                        role,
                        roles: [role],
                        claims: {},
                    },
                }),
            });
            if (!response.ok) throw new Error(`packed org-user Worker returned HTTP ${response.status}`);
            return response.json();
        };
        const expectSuccess = (result, label) => {
            if (result?.ok !== true) throw new Error(`${label} failed: ${JSON.stringify(result)}`);
            return result.result;
        };
        const expectDenied = (result, label) => {
            if (result?.ok !== false || result.error?.code !== "CDB_FORBIDDEN") {
                throw new Error(`${label} did not fail closed: ${JSON.stringify(result)}`);
            }
        };

        expectSuccess(
            await call({
                principalId: "user-a",
                organizationId: "org-a",
                role: "member",
                mutId: "project-create-a",
                ref: "packed-org-user/runtime-worker.ts#createProject",
                args: { id: "project-a", name: "Organization roadmap" },
            }),
            "organization project creation"
        );
        expectSuccess(
            await call({
                principalId: "user-a",
                organizationId: "org-a",
                role: "member",
                mutId: "draft-create-a",
                ref: "packed-org-user/runtime-worker.ts#createDraft",
                args: { id: "draft-a", title: "Private launch notes" },
            }),
            "organization-user self creation"
        );
        const peerProjects = expectSuccess(
            await call({
                principalId: "user-b",
                organizationId: "org-a",
                role: "member",
                mutId: "projects-peer-read",
                ref: "packed-org-user/runtime-worker.ts#listProjects",
                args: {},
            }),
            "same-organization project read"
        );
        if (peerProjects?.length !== 1 || peerProjects[0]?.id !== "project-a") {
            throw new Error(`same-organization project read drifted: ${JSON.stringify(peerProjects)}`);
        }
        const peerDrafts = expectSuccess(
            await call({
                principalId: "user-b",
                organizationId: "org-a",
                role: "member",
                mutId: "drafts-peer-read",
                ref: "packed-org-user/runtime-worker.ts#listDrafts",
                args: {},
            }),
            "organization-user peer read"
        );
        if (!Array.isArray(peerDrafts) || peerDrafts.length !== 0) {
            throw new Error(`organization-user peer read leaked rows: ${JSON.stringify(peerDrafts)}`);
        }
        const adminDrafts = expectSuccess(
            await call({
                principalId: "admin-a",
                organizationId: "org-a",
                role: "admin",
                mutId: "drafts-admin-read",
                ref: "packed-org-user/runtime-worker.ts#listDrafts",
                args: {},
            }),
            "organization admin draft read"
        );
        if (adminDrafts?.length !== 1 || adminDrafts[0]?.id !== "draft-a" || adminDrafts[0]?.userId !== "user-a") {
            throw new Error(`organization admin draft read drifted: ${JSON.stringify(adminDrafts)}`);
        }
        for (const [label, ref] of [
            ["project", "packed-org-user/runtime-worker.ts#listProjects"],
            ["draft", "packed-org-user/runtime-worker.ts#listDrafts"],
        ]) {
            const rows = expectSuccess(
                await call({
                    principalId: "user-a",
                    organizationId: "org-b",
                    role: "member",
                    mutId: `${label}-cross-organization-read`,
                    ref,
                    args: {},
                }),
                `cross-organization ${label} read`
            );
            if (!Array.isArray(rows) || rows.length !== 0) {
                throw new Error(`cross-organization ${label} read leaked rows: ${JSON.stringify(rows)}`);
            }
        }
        expectDenied(
            await call({
                principalId: "viewer-a",
                organizationId: "org-a",
                role: "viewer",
                mutId: "project-forbidden-create",
                ref: "packed-org-user/runtime-worker.ts#createProject",
                args: { id: "project-forbidden", name: "must not persist" },
            }),
            "unauthorized organization project creation"
        );
        const finalProjects = expectSuccess(
            await call({
                principalId: "user-a",
                organizationId: "org-a",
                role: "member",
                mutId: "projects-final-read",
                ref: "packed-org-user/runtime-worker.ts#listProjects",
                args: {},
            }),
            "final organization project read"
        );
        if (finalProjects?.length !== 1 || finalProjects[0]?.id !== "project-a") {
            throw new Error(`denied organization write changed state: ${JSON.stringify(finalProjects)}`);
        }
    } catch (error) {
        primaryFailure = error;
    } finally {
        disposal = await disposeMiniflareBounded(instance, { label: "packed org-user runtime" });
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (disposal?.status !== "disposed") throw new Error(`packed org-user runtime cleanup ${disposal?.status}`);
}

function run(command, args, cwd, extraEnvironment = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...extraEnvironment },
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`);
}
