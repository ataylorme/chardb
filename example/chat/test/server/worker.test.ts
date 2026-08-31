import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdbError } from "@chardb/core";
import { postMessage } from "../../src/server/api.ts";
import { auth } from "../../src/server/auth.ts";
import { listMessages } from "../../src/server/queries.ts";

describe("tutorial Better Auth integration", () => {
    test("uses Better Auth's organization and JWT plugins", () => {
        const pluginIds = (auth.options.plugins ?? []).map(plugin => plugin.id);
        expect(pluginIds).toContain("anonymous");
        expect(pluginIds).toContain("organization");
        expect(pluginIds).toContain("jwt");
    });

    test("trusts only HTTP loopback origins during local development", async () => {
        const trustedOrigins = auth.options.trustedOrigins;
        expect(typeof trustedOrigins).toBe("function");
        if (typeof trustedOrigins !== "function") throw new Error("expected dynamic trusted origins");

        expect(
            await trustedOrigins(
                new Request("http://127.0.0.1:8787/api/auth/organization/create", {
                    headers: { origin: "http://127.0.0.1:5173" },
                })
            )
        ).toEqual(["http://127.0.0.1:5173"]);
        expect(
            await trustedOrigins(
                new Request("https://chat.example.com/api/auth/organization/create", {
                    headers: { origin: "http://127.0.0.1:5173" },
                })
            )
        ).toEqual([]);
        expect(
            await trustedOrigins(
                new Request("http://127.0.0.1:8787/api/auth/organization/create", {
                    headers: { origin: "https://attacker.example" },
                })
            )
        ).toEqual([]);
    });

    test("uses the React client and native organization workflow", async () => {
        const root = resolve(import.meta.dir, "../..");
        const [app, authSource, schema, versionOne, worker, wrangler, vite] = await Promise.all([
            readFile(resolve(root, "src/web/App.tsx"), "utf8"),
            readFile(resolve(root, "src/server/auth.ts"), "utf8"),
            readFile(resolve(root, "src/server/schema.ts"), "utf8"),
            readFile(resolve(root, "src/server/migrations/v1.ts"), "utf8"),
            readFile(resolve(root, "src/server/worker.ts"), "utf8"),
            readFile(resolve(root, "wrangler.template.toml"), "utf8"),
            readFile(resolve(root, "vite.config.ts"), "utf8"),
        ]);

        expect(app).toContain('from "better-auth/react"');
        expect(app).toContain("plugins: [anonymousClient(), organizationClient(), jwtClient()]");
        expect(app).toContain("const session = authClient.useSession()");
        expect(app).toContain("anonymousSignInRequest ??=");
        expect(app).toContain("Sign-in failed:");
        expect(app).toContain("const organizations = authClient.useListOrganizations()");
        expect(app).toContain("authClient.organization.create({");
        expect(app).toContain("authClient.organization.setActive({ organizationId");
        expect(app).not.toContain("session.refetch");
        expect(app).toContain("useQuery(listMessages, { organizationId, limit: 50 })");
        expect(app).not.toContain("DEMO_ORG_ID");
        expect(app).not.toContain("useSession.get()");
        expect(app).not.toContain("useSession.subscribe(");
        expect(authSource).not.toContain("DBAdapter");
        expect(authSource).not.toContain("databaseHooks");
        expect(schema).toContain('owner: "*"');
        expect(versionOne).toContain("plugins: [anonymous(), organization(), jwt()]");
        expect(versionOne).toContain('owner: "*"');
        expect(worker).toContain('authBasePath: "/api/auth"');
        expect(worker).toContain("{ DB, Catalog, Cdb, Gateway, Resharder }");
        expect(wrangler).toContain('new_sqlite_classes = ["Cdb", "Catalog", "Gateway", "Resharder"]');
        expect(Bun.TOML.parse(wrangler)).toHaveProperty("durable_objects.bindings", [
            { name: "CDB_CATALOG", class_name: "Catalog" },
            { name: "CDB_SHARD", class_name: "Cdb" },
            { name: "CDB_GATEWAY", class_name: "Gateway" },
            { name: "CDB_RESHARD", class_name: "Resharder" },
        ]);
        expect(wrangler).toContain('run_worker_first = ["/ws", "/_chardb/*", "/api/*", "/health"]');
        expect(vite).toContain('const workerOrigin = process.env.CHARDB_URL ?? "http://127.0.0.1:8787"');
        expect(vite).not.toContain("localhost:8787");
    });
});

describe("tutorial organization flow", () => {
    test("defaults the live query to the same bounded direct-read shape", async () => {
        const internals = listMessages as typeof listMessages & {
            readonly __chardbValidateArgs: (args: unknown) => Promise<{
                readonly organizationId: string;
                readonly limit: number;
            }>;
            readonly __chardbCompilePlan: (args: { readonly organizationId: string; readonly limit: number }) => {
                readonly authority: string;
                readonly partitionKey: string;
                readonly limit: number;
                readonly orderBy: readonly { readonly column: string; readonly direction: string }[];
            };
        };

        const args = await internals.__chardbValidateArgs({ organizationId: "org-1" });
        const plan = internals.__chardbCompilePlan(args);

        expect(args).toEqual({ organizationId: "org-1", limit: 50 });
        expect(plan.authority).toBe("organization");
        expect(plan.partitionKey).toBe("org-1");
        expect(plan.limit).toBe(50);
        expect(plan.orderBy).toEqual([
            { column: "created_at", direction: "desc" },
            { column: "id", direction: "desc" },
        ]);
    });

    test("rejects a mutation when its active organization and route disagree", () => {
        let error: unknown;
        try {
            postMessage(
                {
                    db: {} as never,
                    auth: { userId: "user-1", tenantId: "other-org", claims: {} },
                },
                {
                    id: "message-1",
                    organizationId: "org-1",
                    body: "hello",
                    clientCreatedAt: 1,
                }
            );
        } catch (cause) {
            error = cause;
        }
        expect(error).toBeInstanceOf(CdbError);
        expect(error).toMatchObject({ code: "CDB_FORBIDDEN", retryable: false });
    });
});
