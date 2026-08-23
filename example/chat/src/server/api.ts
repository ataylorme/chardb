// Mutations + presence. Row- and column-level policies are declared
// inline on each `cdbTable` in `schema.ts`; this file no longer
// exports separate policy values.

import { api } from "chardb/server";
import { z } from "zod";
import { messages } from "./schema.ts";

export const postMessage = api.mutation({
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

export const typing = api.presence<{ readonly user: string; readonly until: number }>("typing");
