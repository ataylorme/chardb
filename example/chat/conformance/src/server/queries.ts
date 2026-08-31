// Single-source server query plans and client-addressable handles. The Vite
// client environment replaces this module with lightweight ref-only handles;
// Worker, SSR, and virtual-manifest builds retain the complete plans.

import { api } from "@chardb/core/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { globalNotices, messages, userPreferences } from "./schema.ts";

const listMessagesArgs = z.object({
    organizationId: z.string(),
    channelId: z.string(),
    limit: z.number().int().min(1).max(100),
});

export const listMessages = api.query({
    ref: "src/server/queries.ts#listMessages",
    args: listMessagesArgs,
    query: (db, args) =>
        db
            .select()
            .from(messages)
            .where(and(eq(messages.organizationId, args.organizationId), eq(messages.channelId, args.channelId)))
            .orderBy(desc(messages.createdAt), desc(messages.id))
            .limit(args.limit),
});

export const listUserPreferences = api.query({
    ref: "src/server/queries.ts#listUserPreferences",
    args: z.object({ userId: z.string() }),
    query: (db, args) =>
        db
            .select()
            .from(userPreferences)
            .where(eq(userPreferences.userId, args.userId))
            .orderBy(userPreferences.id)
            .limit(100),
});

export const listGlobalNotices = api.query({
    ref: "src/server/queries.ts#listGlobalNotices",
    args: z.object({ namespace: z.string() }),
    query: (db, args) =>
        db
            .select()
            .from(globalNotices)
            .where(eq(globalNotices.namespace, args.namespace))
            .orderBy(globalNotices.id)
            .limit(100),
});
