// Client-safe query handles + intent extractors.
//
// This module is intentionally free of `chardb({...})` factory imports
// (no `worker.ts`, no `chatRoles`) so the React bundle that calls
// `useQuery(listMessages, args)` doesn't drag the server-side schema /
// auth / Drizzle runtime into the browser. Every export is a chardb
// query handle the Vite plugin discovers at build time.

import { api } from "chardb/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { messages } from "./schema.ts";

const listMessagesArgs = z.object({
    organizationId: z.string(),
    channelId: z.string(),
    limit: z.number().int().positive(),
});

export const listMessages = api.query({
    ref: "src/server/queries.ts#listMessages",
    args: listMessagesArgs,
    // The configured Gateway evaluates this extractor from its local
    // manifest; the browser sends only the handle ref and raw args. The shape
    // MUST match what
    // the handler's `where` would compile to via `StaticIntentExtractor`
    // — partition values, intervals, table list — otherwise the
    // subscription and the read will return divergent rows.
    intent: args => ({
        kind: "select",
        tables: ["messages"],
        partitionKey: { table: "messages", column: "organization_id", values: [args.organizationId] },
        joinShape: "colocated",
        intervals: [
            {
                table: "messages",
                indexName: "channel_id",
                intervals: [
                    {
                        kind: "range",
                        lo: { kind: "value", value: [args.channelId], inclusive: true },
                        hi: { kind: "value", value: [args.channelId], inclusive: true },
                    },
                ],
            },
        ],
    }),
    handler: async (ctx, args) =>
        ctx.db
            .select()
            .from(messages)
            .where(and(eq(messages.organizationId, args.organizationId), eq(messages.channelId, args.channelId)))
            .limit(args.limit),
});
