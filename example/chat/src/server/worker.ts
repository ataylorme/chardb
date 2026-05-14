import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { chardb, defineAuth, defineRoles } from "chardb/server";
import * as api from "./api.ts";
import * as queries from "./queries.ts";
import * as domain from "./schema.ts";

const DEMO_ORG_ID = "demo-org" as const;

export const auth = defineAuth({
    appName: "chardb-chat-example",
    plugins: [organization(), anonymous(), jwt()],
    // Bootstrap a single shared demo organization on every successful
    // sign-in (anonymous flow included): create it if missing, add the
    // signing-in user as a member, set it active. Production apps
    // typically gate org creation behind a paid tier — this hook is
    // the example's stand-in for that flow.
    databaseHooks: {
        session: {
            create: {
                after: async (session, ctx) => {
                    if (!ctx?.context.adapter) return;
                    const adapter = ctx.context.adapter;
                    let org = await adapter.findOne<{ id: string }>({
                        model: "organization",
                        where: [{ field: "id", operator: "eq", value: DEMO_ORG_ID, connector: "AND" }],
                    });
                    if (!org) {
                        org = await adapter.create<{ id: string }>({
                            model: "organization",
                            data: {
                                id: DEMO_ORG_ID,
                                name: "Demo",
                                slug: "demo",
                                createdAt: new Date(),
                            },
                        });
                    }
                    await adapter.create({
                        model: "member",
                        data: {
                            id: `${DEMO_ORG_ID}-${session.userId}`,
                            organizationId: DEMO_ORG_ID,
                            userId: session.userId,
                            role: "member",
                            createdAt: new Date(),
                        },
                    });
                    await adapter.update({
                        model: "session",
                        where: [{ field: "id", operator: "eq", value: session.id, connector: "AND" }],
                        update: { activeOrganizationId: DEMO_ORG_ID },
                    });
                },
            },
        },
    },
});

export const chatRoles = defineRoles(
    {
        messages: ["create", "update", "delete"],
        channels: ["create", "rename", "delete"],
    },
    {
        admin: { channels: ["create", "rename"] },
        member: { messages: ["create"] },
    }
);

export const app = chardb({ auth, schema: domain, api: { ...api, ...queries } });

app.get("/health", c => c.text("ok"));
app.get("/api/version", c => c.json({ name: "chardb-chat-example", version: "0.1.0" }));

export default app;
export const { BlobMeta, Catalog, Cdb, Gateway, GsiShard, Resharder } = app;
