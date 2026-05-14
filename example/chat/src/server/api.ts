// Mutations + presence + policies. Queries live in `queries.ts` so the
// browser can value-import them without dragging the worker bundle.

import { api, ownerScope, requirePermission, tenantScope } from "chardb/server";
import { z } from "zod";
import { messages } from "./schema.ts";
import { chatRoles } from "./worker.ts";

export const postMessage = api.mutation({
    args: z.object({
        id: z.string(),
        channelId: z.string(),
        body: z.string().min(1),
        clientCreatedAt: z.number(),
    }),
    // `partitionKey` is derived from `ctx.auth.tenantId` at runtime —
    // see the handler. The mutation declares it via the closure form
    // because the value isn't in `args` (it's authoritative-from-JWT).
    partitionKey: () => undefined,
    handler: async (ctx, args) => {
        if (!ctx.auth.userId || !ctx.auth.tenantId) {
            throw new Error("CDB_FORBIDDEN: postMessage requires an authenticated session with an active org");
        }
        await ctx.db.insert(messages).values({
            id: args.id,
            channelId: args.channelId,
            organizationId: ctx.auth.tenantId,
            authorId: ctx.auth.userId,
            body: args.body,
            createdAt: args.clientCreatedAt,
        });
        return { id: args.id };
    },
});

export const typing = api.presence<{ readonly user: string; readonly until: number }>("typing");

// `() => messages` thunks defer past the api.ts ↔ schema.ts cycle.
export const orgIsolation = tenantScope(() => messages);
export const messageOwnerOnly = ownerScope(() => messages, { for: "all" });
export const messageAdmins = requirePermission(
    () => messages,
    () => chatRoles,
    {
        messages: ["delete", "update"],
    }
);
