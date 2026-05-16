import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { chardb, defineAuth } from "chardb/server";
import * as api from "./api.ts";
import * as queries from "./queries.ts";
import * as domain from "./schema.ts";

const DEMO_ORG_ID = "demo-org" as const;

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

export const app = chardb({ auth, schema: domain, api: { ...api, ...queries } });

app.get("/health", c => c.text("ok"));
app.get("/api/version", c => c.json({ name: "chardb-chat-example", version: "0.1.0" }));

export default app;
export const { BlobMeta, Catalog, Cdb, Gateway, GsiShard, Resharder } = app;
