import { jwt } from "better-auth/plugins/jwt";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { api, chardb, defineAuth, forOrg } from "../../src/server/index.ts";
import { ClientId, SubId } from "../../src/types.ts";
import type { RowPatch } from "../../src/wire.ts";

const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const USER_ID = "workerd-user";
const ORGANIZATION_ID = "workerd-org";
const WRITE_REF = "test/workerd/gateway-jwt.entry.ts#writeOrganizationRow";
const CLOSED_REF = "test/workerd/gateway-jwt.entry.ts#closedOrganizationWrite";

const auth = defineAuth({
    appName: "gateway-workerd-test",
    baseURL: ISSUER,
    plugins: [
        jwt({
            jwt: { issuer: ISSUER, audience: AUDIENCE },
            jwks: {
                remoteUrl: "https://unreachable.invalid/jwks",
                keyPairConfig: { alg: "ES256" },
            },
        }),
    ],
});

const { cdbTable } = forOrg();
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
        roles: { member: { create: ["id", "body", "createdAt"] } },
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

const app = chardb({
    auth,
    schema: { gatewayWrites },
    api: { writeOrganizationRow, closedOrganizationWrite },
});
export const { Cdb, Gateway } = app;

type AuthorityFault = "none" | "throw" | "malformed" | "hold";

export class Catalog extends app.Catalog {
    private authorityFault: AuthorityFault = "none";
    private authorityHold: Promise<void> = Promise.resolve();
    private releaseAuthorityHold: (() => void) | undefined;
    private authorityEntered: Promise<void> = Promise.resolve();
    private markAuthorityEntered: (() => void) | undefined;

    setAuthorityFault(fault: AuthorityFault): void {
        this.authorityFault = fault;
        if (fault === "hold") {
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
        if (this.authorityFault === "throw") throw new Error("forced authority failure");
        if (this.authorityFault === "malformed") return { principalId: 7 } as never;
        if (this.authorityFault === "hold") {
            this.markAuthorityEntered?.();
            this.markAuthorityEntered = undefined;
            await this.authorityHold;
        }
        return super.resolveOrganizationAuthority(request);
    }
}

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/seed") {
            const body = (await request.json()) as { readonly kid: string; readonly jwk: JsonWebKey };
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as {
                putJwk(kid: string, jwkJson: string, ttlMs: number): Promise<void>;
                mutateAuth(args: {
                    readonly model: string;
                    readonly op: "create";
                    readonly payload: Record<string, unknown>;
                }): Promise<unknown>;
            };
            await catalog.putJwk(body.kid, JSON.stringify(body.jwk), 60_000);
            const now = Date.parse("2026-08-23T00:00:00Z");
            await catalog.mutateAuth({
                model: "user",
                op: "create",
                payload: {
                    id: USER_ID,
                    name: "Workerd User",
                    email: "workerd@example.com",
                    emailVerified: true,
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
                    role: "member",
                    createdAt: now,
                },
            });
            return Response.json({
                ok: true,
                mutationRef: writeOrganizationRow.__chardbRef,
                closedMutationRef: closedOrganizationWrite.__chardbRef,
            });
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
        if (url.pathname === "/patch-poke") {
            const body = (await request.json()) as { readonly clientId: string; readonly rowKey: string };
            const id = env.CDB_GATEWAY.idFromName("gateway-jwt-probe");
            const gateway = env.CDB_GATEWAY.get(id) as unknown as {
                enqueuePatch(clientId: ReturnType<typeof ClientId>, patch: RowPatch): Promise<void>;
            };
            await gateway.enqueuePatch(ClientId(body.clientId), {
                op: "put",
                subId: SubId(1),
                rowKey: body.rowKey,
                row: { id: body.rowKey },
            });
            return Response.json({ ok: true });
        }
        if (url.pathname === "/ws") {
            const id = env.CDB_GATEWAY.idFromName("gateway-jwt-probe");
            return env.CDB_GATEWAY.get(id).fetch(request);
        }
        return new Response("not found", { status: 404 });
    },
};
