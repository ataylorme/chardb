import { api } from "@chardb/core/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { channels, messages } from "./schema.ts";

export const postMessage = api.mutation({
    ref: "src/server/api.ts#postMessage",
    authority: "organization",
    args: z.object({
        id: z.string(),
        organizationId: z.string(),
        channelId: z.string(),
        body: z.string().min(1),
        clientCreatedAt: z.number(),
    }),
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        if (!ctx.auth.userId || !ctx.auth.tenantId || ctx.auth.tenantId !== args.organizationId) {
            throw new Error("CDB_FORBIDDEN: active organization does not match the routed partition");
        }
        const channel = ctx.db.select().from(channels).where(eq(channels.id, args.channelId)).get();
        if (!channel) {
            ctx.db
                .insert(channels)
                .values({ id: args.channelId, name: args.channelId, createdAt: args.clientCreatedAt })
                .run();
        }
        ctx.db
            .insert(messages)
            .values({
                id: args.id,
                channelId: args.channelId,
                body: args.body,
                createdAt: args.clientCreatedAt,
            })
            .run();
        return { id: args.id };
    },
});
