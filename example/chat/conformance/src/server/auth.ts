import { defineAuth } from "@chardb/core/server";
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import type { DBAdapter, Session } from "better-auth/types";

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
