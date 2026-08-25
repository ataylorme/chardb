import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import type { DBAdapter, Session } from "better-auth/types";
import { client } from "chardb";
import { chardb, defineAuth, defineMigrations, defineSchemaBaseline } from "chardb/server";
import * as api from "./api.ts";
import * as queries from "./queries.ts";
import * as domain from "./schema.ts";

const DEMO_ORG_ID = "demo-org" as const;

type DemoSession = Pick<Session, "id" | "userId">;
type DemoAdapter = Pick<DBAdapter, "create" | "findOne" | "update">;

async function createOrganizationIfMissing(adapter: DemoAdapter): Promise<void> {
    const findOrganization = () =>
        adapter.findOne<{ id: string }>({
            model: "organization",
            where: [{ field: "id", operator: "eq", value: DEMO_ORG_ID, connector: "AND" }],
        });
    if (await findOrganization()) return;
    try {
        await adapter.create({
            model: "organization",
            data: {
                id: DEMO_ORG_ID,
                name: "Demo",
                slug: "demo",
                createdAt: new Date(),
            },
            forceAllowId: true,
        });
    } catch (error) {
        // Another session may have created the singleton after our read.
        if (!(await findOrganization())) throw error;
    }
}

async function createMembershipIfMissing(adapter: DemoAdapter, userId: string): Promise<void> {
    const findMembership = () =>
        adapter.findOne<{ id: string }>({
            model: "member",
            where: [
                { field: "organizationId", operator: "eq", value: DEMO_ORG_ID, connector: "AND" },
                { field: "userId", operator: "eq", value: userId, connector: "AND" },
            ],
        });
    if (await findMembership()) return;
    try {
        await adapter.create({
            model: "member",
            data: {
                id: `${DEMO_ORG_ID}-${userId}`,
                organizationId: DEMO_ORG_ID,
                userId,
                role: "member",
                createdAt: new Date(),
            },
            forceAllowId: true,
        });
    } catch (error) {
        // Treat only a confirmed concurrent create as success.
        if (!(await findMembership())) throw error;
    }
}

export async function bootstrapDemoSession(adapter: DemoAdapter, session: DemoSession): Promise<void> {
    await createOrganizationIfMissing(adapter);
    await createMembershipIfMissing(adapter, session.userId);
    await adapter.update({
        model: "session",
        where: [{ field: "id", operator: "eq", value: session.id, connector: "AND" }],
        update: { activeOrganizationId: DEMO_ORG_ID },
    });
}

// `defineAuth` bakes `organization()` and `admin()` into the plugin
// list automatically — schema files reference `auth.organization` /
// `auth.member` / etc without the user listing the plugin, and
// cdbTable's role lattice (member.role for org tenants, user.role for
// user/global tenants) is wired up the same way.
export const auth = defineAuth({
    appName: "chardb-chat-example",
    plugins: [anonymous(), jwt()],
    databaseHooks: {
        session: {
            create: {
                after: async (session, ctx) => {
                    if (!ctx?.context.adapter) return;
                    await bootstrapDemoSession(ctx.context.adapter, session);
                },
            },
        },
    },
});

export const migrations = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "initial_schema",
        domainSchema: domain,
        authOptions: auth.options,
    }),
]);

export const app = chardb({ auth, schema: domain, api: { ...api, ...queries }, migrations });

app.get("/health", c => c.text("ok"));
app.get("/api/version", c => c.json({ name: "chardb-chat-example", version: "0.1.0" }));
app.get("/api/db/messages", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const rows = await client(c.env.DB, { jwt, authOrigin: url.origin }).query(queries.listMessages, {
        organizationId: url.searchParams.get("organizationId") ?? "",
        channelId: url.searchParams.get("channelId") ?? "",
        limit: Number(url.searchParams.get("limit") ?? 50),
    });
    return c.json(rows);
});
app.post("/api/db/messages", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const body = await c.req.json<{
        id: string;
        organizationId: string;
        channelId: string;
        body: string;
        clientCreatedAt: number;
        mutId?: string;
    }>();
    const result = await client(c.env.DB, { jwt, authOrigin: url.origin }).mutate(api.postMessage, body, {
        ...(body.mutId ? { mutId: body.mutId } : {}),
    });
    return c.json(result);
});

export default app;
export const { DB, BlobMeta, Catalog, Cdb, Gateway, GsiShard, Resharder } = app;
