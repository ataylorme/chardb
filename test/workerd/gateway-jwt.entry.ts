import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { and, eq, or } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { api } from "../../src/server/define.ts";
import { gatewayBucketName } from "../../src/server/gateway-bucket.ts";
import { chardb, defineAuth } from "../../src/server/index.ts";
import { vshardOf } from "../../src/vshard.ts";
import { forOrgUser } from "../helpers/cdb-table.ts";

const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const JWKS_URL = "https://unreachable.invalid/jwks";
const USER_ID = "workerd-user";
const ORGANIZATION_ID = "workerd-org";
const OTHER_ORGANIZATION_ID = "workerd-org-b";
const WRITE_REF = "test/workerd/gateway-jwt.entry.ts#writeOrganizationRow";
const CLOSED_REF = "test/workerd/gateway-jwt.entry.ts#closedOrganizationWrite";
const LIST_REF = "test/workerd/gateway-jwt.entry.ts#listOrganizationRows";
const UNCONSTRAINED_QUERY_REF = "test/workerd/gateway-jwt.entry.ts#unconstrainedOrganizationRows";
const INVALID_QUERY_REF = "test/workerd/gateway-jwt.entry.ts#invalidOrganizationRows";

const auth = defineAuth({
    appName: "gateway-workerd-test",
    baseURL: ISSUER,
    plugins: [
        organization(),
        admin(),
        jwt({
            jwt: { issuer: ISSUER, audience: AUDIENCE },
            jwks: {
                remoteUrl: JWKS_URL,
                keyPairConfig: { alg: "ES256" },
            },
        }),
    ],
});

const { cdbTable } = forOrgUser();
const gatewayWrites = cdbTable(
    "gateway_writes",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        authorId: text("author_id")
            .notNull()
            .references(() => auth.user.id),
        body: text("body").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    {
        selfBy: "authorId",
        roles: {
            member: { read: "*" },
            "user:admin": { create: ["id", "body", "createdAt"] },
        },
    }
);

const writeOrganizationRow = api.mutation({
    ref: WRITE_REF,
    args: z.object({
        id: z.string(),
        organizationId: z.string(),
        body: z.string(),
        createdAt: z.number(),
    }),
    authority: "organization",
    partitionKey: "organizationId",
    handler: (ctx, args: { id: string; organizationId: string; body: string; createdAt: number }) => {
        ctx.db.insert(gatewayWrites).values({ id: args.id, body: args.body, createdAt: args.createdAt }).run();
        return {
            id: args.id,
            userId: ctx.auth.userId,
            tenantId: ctx.auth.tenantId ?? null,
            role: ctx.auth.role ?? null,
            roles: ctx.auth.roles ?? [],
            authEpochs: ctx.auth.authEpochs ?? null,
            claims: ctx.auth.claims,
        };
    },
});

const closedOrganizationWrite = api.mutation({
    ref: CLOSED_REF,
    args: z.object({ organizationId: z.string() }),
    partitionKey: "organizationId",
    handler: (_ctx, args: { organizationId: string }) => args.organizationId,
});

const listOrganizationRows = api.query({
    ref: LIST_REF,
    args: z.object({ organizationId: z.string(), body: z.string().optional() }),
    query: (db, args) => {
        if (args.body === "__throw") throw new Error("forced query failure");
        return db
            .select()
            .from(gatewayWrites)
            .where(
                args.body === undefined
                    ? eq(gatewayWrites.organizationId, args.organizationId)
                    : and(eq(gatewayWrites.organizationId, args.organizationId), eq(gatewayWrites.body, args.body))
            )
            .orderBy(gatewayWrites.id)
            .limit(100);
    },
});

const unconstrainedOrganizationRows = api.query({
    ref: UNCONSTRAINED_QUERY_REF,
    args: z.object({ organizationId: z.string() }),
    query: db => db.select().from(gatewayWrites).orderBy(gatewayWrites.id).limit(100),
});

const invalidOrganizationRows = api.query({
    ref: INVALID_QUERY_REF,
    args: z.object({ organizationId: z.string(), mode: z.enum(["scatter", "cross", "foreign"]) }),
    query: (db, args) =>
        db
            .select()
            .from(gatewayWrites)
            .where(
                args.mode === "scatter"
                    ? undefined
                    : args.mode === "cross"
                      ? or(
                            eq(gatewayWrites.organizationId, args.organizationId),
                            eq(gatewayWrites.organizationId, OTHER_ORGANIZATION_ID)
                        )
                      : eq(gatewayWrites.organizationId, OTHER_ORGANIZATION_ID)
            )
            .orderBy(gatewayWrites.id)
            .limit(100),
});

const app = chardb({
    ownership: "organization",
    auth,
    schema: { gatewayWrites },
    api: {
        writeOrganizationRow,
        closedOrganizationWrite,
        listOrganizationRows,
        unconstrainedOrganizationRows,
        invalidOrganizationRows,
    },
});
export const { Gateway } = app;

export class Cdb extends app.Cdb {
    private heldMutationId: string | undefined;
    private heldMutationResponse: Promise<void> = Promise.resolve();
    private releaseHeldMutationResponse: (() => void) | undefined;
    private heldMutationEntered: Promise<void> = Promise.resolve();
    private markHeldMutationEntered: (() => void) | undefined;

    holdMutationResponse(mutId: string): void {
        this.heldMutationId = mutId;
        this.heldMutationResponse = new Promise(resolve => {
            this.releaseHeldMutationResponse = resolve;
        });
        this.heldMutationEntered = new Promise(resolve => {
            this.markHeldMutationEntered = resolve;
        });
    }

    async waitForHeldMutationResponse(): Promise<void> {
        await this.heldMutationEntered;
    }

    releaseMutationResponse(): void {
        this.heldMutationId = undefined;
        this.releaseHeldMutationResponse?.();
        this.releaseHeldMutationResponse = undefined;
    }

    override async mutate(
        input: Parameters<InstanceType<typeof app.Cdb>["mutate"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["mutate"]> {
        const response = await super.mutate(input);
        if (input.mutId === this.heldMutationId) {
            this.markHeldMutationEntered?.();
            this.markHeldMutationEntered = undefined;
            await this.heldMutationResponse;
        }
        return response;
    }
}

type AuthorityFault =
    | "none"
    | "throw"
    | "malformed"
    | "hold"
    | "hold-throw"
    | "route-throw"
    | "route-malformed"
    | "legacy-throw";

export class Catalog extends app.Catalog {
    private authorityFault: AuthorityFault = "none";
    private authorityHold: Promise<void> = Promise.resolve();
    private releaseAuthorityHold: (() => void) | undefined;
    private authorityEntered: Promise<void> = Promise.resolve();
    private markAuthorityEntered: (() => void) | undefined;

    seedJwkForTest(jwksUrl: string, kid: string, jwkJson: string, ttlMs: number): void {
        const now = Date.now();
        const cursor = this.ctx.storage.sql.exec(
            `INSERT INTO catalog_jwks_v2
             (jwks_url, kid, jwk_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(jwks_url, kid) DO UPDATE SET
               jwk_json = excluded.jwk_json,
               fetched_at = excluded.fetched_at,
               expires_at = excluded.expires_at`,
            jwksUrl,
            kid,
            jwkJson,
            now,
            now + ttlMs
        );
        for (const _ of cursor.raw()) {
            // Drain the write cursor.
        }
    }

    expireJwkForTest(jwksUrl: string, kid: string): boolean {
        const cursor = this.ctx.storage.sql.exec(
            "UPDATE catalog_jwks_v2 SET expires_at = 0 WHERE jwks_url = ? AND kid = ?",
            jwksUrl,
            kid
        );
        for (const _ of cursor.raw()) {
            // Drain the write cursor before reading changes().
        }
        const changes = this.ctx.storage.sql.exec("SELECT changes() AS changes");
        for (const row of changes.raw()) return Number(row[0]) === 1;
        return false;
    }

    releaseJwksCooldownForTest(jwksUrl: string): void {
        const cursor = this.ctx.storage.sql.exec(
            "UPDATE catalog_jwks_refresh SET next_fetch_at = 0, refreshing_until = 0 WHERE jwks_url = ?",
            jwksUrl
        );
        for (const _ of cursor.raw()) {
            // Drain the write cursor.
        }
    }

    setAuthorityFault(fault: AuthorityFault): void {
        this.authorityFault = fault;
        if (fault === "hold" || fault === "hold-throw") {
            this.authorityHold = new Promise(resolve => {
                this.releaseAuthorityHold = resolve;
            });
            this.authorityEntered = new Promise(resolve => {
                this.markAuthorityEntered = resolve;
            });
        }
    }

    async waitForAuthorityHold(): Promise<void> {
        await this.authorityEntered;
    }

    releaseHeldAuthority(): void {
        this.releaseAuthorityHold?.();
        this.releaseAuthorityHold = undefined;
        this.authorityFault = "none";
    }

    override async resolveOrganizationAuthority(
        request: Parameters<InstanceType<typeof app.Catalog>["resolveOrganizationAuthority"]>[0]
    ): ReturnType<InstanceType<typeof app.Catalog>["resolveOrganizationAuthority"]> {
        if (this.authorityFault === "throw" || this.authorityFault === "legacy-throw") {
            throw new Error("forced authority failure");
        }
        if (this.authorityFault === "malformed") return { principalId: 7 } as never;
        if (this.authorityFault === "hold" || this.authorityFault === "hold-throw") {
            const heldFault = this.authorityFault;
            this.markAuthorityEntered?.();
            this.markAuthorityEntered = undefined;
            await this.authorityHold;
            if (heldFault === "hold-throw") throw new Error("forced held authority failure");
        }
        return super.resolveOrganizationAuthority(request);
    }

    override async resolveOrganizationAuthorityRoute(
        request: Parameters<InstanceType<typeof app.Catalog>["resolveOrganizationAuthorityRoute"]>[0]
    ): ReturnType<InstanceType<typeof app.Catalog>["resolveOrganizationAuthorityRoute"]> {
        if (this.authorityFault === "throw") throw new Error("forced authority failure");
        if (this.authorityFault === "malformed") return { authority: { principalId: 7 } } as never;
        if (this.authorityFault === "hold" || this.authorityFault === "hold-throw") {
            const heldFault = this.authorityFault;
            this.markAuthorityEntered?.();
            this.markAuthorityEntered = undefined;
            await this.authorityHold;
            if (heldFault === "hold-throw") throw new Error("forced held authority failure");
        }
        if (this.authorityFault === "route-throw") throw new Error("forced route failure");
        const resolved = await super.resolveOrganizationAuthorityRoute(request);
        if (this.authorityFault === "route-malformed" && resolved.authority) {
            return { authority: resolved.authority, route: { shardId: 7 } } as never;
        }
        return resolved;
    }

    override async route(
        vshard: Parameters<InstanceType<typeof app.Catalog>["route"]>[0]
    ): ReturnType<InstanceType<typeof app.Catalog>["route"]> {
        if (this.authorityFault === "route-throw" || this.authorityFault === "legacy-throw") {
            throw new Error("forced route failure");
        }
        if (this.authorityFault === "route-malformed") return { shardId: 7 } as never;
        return super.route(vshard);
    }
}

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/seed") {
            const body = request.headers.get("content-type")?.includes("application/json")
                ? ((await request.json()) as { readonly kid?: string; readonly jwk?: JsonWebKey })
                : {};
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as {
                seedJwkForTest(jwksUrl: string, kid: string, jwkJson: string, ttlMs: number): Promise<void>;
                mutateAuth(args: {
                    readonly model: string;
                    readonly op: "create";
                    readonly payload: Record<string, unknown>;
                }): Promise<unknown>;
                route(vshard: number): Promise<{ readonly shardId: string }>;
            };
            if (body.kid !== undefined && body.jwk !== undefined) {
                await catalog.seedJwkForTest(JWKS_URL, body.kid, JSON.stringify(body.jwk), 60_000);
            }
            const now = Date.parse("2026-08-23T00:00:00Z");
            await catalog.mutateAuth({
                model: "user",
                op: "create",
                payload: {
                    id: USER_ID,
                    name: "Workerd User",
                    email: "workerd@example.com",
                    emailVerified: true,
                    role: "admin",
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "organization",
                op: "create",
                payload: { id: ORGANIZATION_ID, name: "Workerd Org", slug: "workerd-org", createdAt: now },
            });
            await catalog.mutateAuth({
                model: "organization",
                op: "create",
                payload: {
                    id: OTHER_ORGANIZATION_ID,
                    name: "Workerd Org B",
                    slug: "workerd-org-b",
                    createdAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "member",
                op: "create",
                payload: {
                    id: "workerd-member",
                    organizationId: ORGANIZATION_ID,
                    userId: USER_ID,
                    role: "member",
                    createdAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "user",
                op: "create",
                payload: {
                    id: "workerd-user-b",
                    name: "Workerd User B",
                    email: "workerd-b@example.com",
                    emailVerified: true,
                    role: "admin",
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "member",
                op: "create",
                payload: {
                    id: "workerd-member-b",
                    organizationId: OTHER_ORGANIZATION_ID,
                    userId: "workerd-user-b",
                    role: "member",
                    createdAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "user",
                op: "create",
                payload: {
                    id: "workerd-user-2",
                    name: "Workerd User 2",
                    email: "workerd-2@example.com",
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "member",
                op: "create",
                payload: {
                    id: "workerd-member-2",
                    organizationId: ORGANIZATION_ID,
                    userId: "workerd-user-2",
                    role: "admin",
                    createdAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "user",
                op: "create",
                payload: {
                    id: "workerd-writer",
                    name: "Workerd Writer",
                    email: "workerd-writer@example.com",
                    emailVerified: true,
                    role: "admin",
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "member",
                op: "create",
                payload: {
                    id: "workerd-writer-member",
                    organizationId: ORGANIZATION_ID,
                    userId: "workerd-writer",
                    role: "member",
                    createdAt: now,
                },
            });
            const routeA = await catalog.route(Number(vshardOf([ORGANIZATION_ID])));
            const routeB = await catalog.route(Number(vshardOf([OTHER_ORGANIZATION_ID])));
            return Response.json({
                ok: true,
                mutationRef: writeOrganizationRow.__chardbRef,
                closedMutationRef: closedOrganizationWrite.__chardbRef,
                queryRef: listOrganizationRows.__chardbRef,
                unconstrainedQueryRef: unconstrainedOrganizationRows.__chardbRef,
                invalidQueryRef: invalidOrganizationRows.__chardbRef,
                shardA: routeA.shardId,
                shardB: routeB.shardId,
            });
        }
        if (url.pathname === "/expire-jwk") {
            const body = (await request.json()) as { readonly kid: string; readonly jwksUrl: string };
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as {
                expireJwkForTest(jwksUrl: string, kid: string): Promise<boolean>;
            };
            if (!(await catalog.expireJwkForTest(body.jwksUrl, body.kid))) {
                return new Response("JWK is not cached", { status: 404 });
            }
            return Response.json({ ok: true });
        }
        if (url.pathname === "/release-jwks-cooldown") {
            const body = (await request.json()) as { readonly jwksUrl: string };
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as {
                releaseJwksCooldownForTest(jwksUrl: string): Promise<void>;
            };
            await catalog.releaseJwksCooldownForTest(body.jwksUrl);
            return Response.json({ ok: true });
        }
        if (url.pathname === "/authority-fault") {
            const body = (await request.json()) as { readonly fault: AuthorityFault };
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as {
                setAuthorityFault(fault: AuthorityFault): Promise<void>;
            };
            await catalog.setAuthorityFault(body.fault);
            return Response.json({ ok: true });
        }
        if (url.pathname === "/authority-waiting") {
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as { waitForAuthorityHold(): Promise<void> };
            await catalog.waitForAuthorityHold();
            return Response.json({ ok: true });
        }
        if (url.pathname === "/authority-release") {
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as { releaseHeldAuthority(): Promise<void> };
            await catalog.releaseHeldAuthority();
            return Response.json({ ok: true });
        }
        if (url.pathname.startsWith("/mutation-response-")) {
            const body = (await request.json()) as { readonly shardId: string; readonly mutId?: string };
            const id = env.CDB_SHARD.idFromName(body.shardId);
            const cdb = env.CDB_SHARD.get(id) as unknown as {
                holdMutationResponse(mutId: string): Promise<void>;
                waitForHeldMutationResponse(): Promise<void>;
                releaseMutationResponse(): Promise<void>;
            };
            if (url.pathname === "/mutation-response-hold") {
                if (!body.mutId) return new Response("mutId is required", { status: 400 });
                await cdb.holdMutationResponse(body.mutId);
            } else if (url.pathname === "/mutation-response-waiting") {
                await cdb.waitForHeldMutationResponse();
            } else if (url.pathname === "/mutation-response-release") {
                await cdb.releaseMutationResponse();
            } else {
                return new Response("not found", { status: 404 });
            }
            return Response.json({ ok: true });
        }
        if (url.pathname === "/ws") {
            const routedClientId = url.searchParams.get("clientId");
            const id = env.CDB_GATEWAY.idFromName(gatewayBucketName(routedClientId ?? "missing-client-route"));
            return env.CDB_GATEWAY.get(id).fetch(request);
        }
        return new Response("not found", { status: 404 });
    },
};
