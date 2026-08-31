import { CdbError } from "@chardb/core";
import { FileId } from "@chardb/core/files";
import { api, searchVector } from "@chardb/core/server";
import { z } from "zod";
import { documents } from "./schema.ts";

export const attachDocument = api.mutation({
    ref: "cloudflare-file-reshard-proof/api.ts#attachDocument",
    authority: "organization",
    args: z.object({
        id: z.string().min(1).max(128),
        organizationId: z.string().min(1).max(128),
        ownerId: z.string().min(1).max(128),
        fileId: z.string().min(1).max(128),
        body: z.string().min(1).max(256),
        values: z.array(z.number().finite()).length(32),
    }),
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        if (ctx.auth.tenantId !== args.organizationId || ctx.auth.userId !== args.ownerId) {
            throw new CdbError({ code: "CDB_FORBIDDEN", message: "proof document authority drifted" });
        }
        const embedding = ctx.vector.set(documents.embedding, args.id, args.values);
        ctx.db
            .insert(documents)
            .values({
                id: args.id,
                ownerId: args.ownerId,
                attachment: FileId(args.fileId),
                body: args.body,
                embedding,
            })
            .run();
        return { id: args.id, fileId: args.fileId, vectorId: embedding.id };
    },
});

export const searchDocuments = api.query({
    ref: "cloudflare-file-reshard-proof/api.ts#searchDocuments",
    args: z.object({
        organizationId: z.string().min(1).max(128),
        values: z.array(z.number().finite()).length(32),
        limit: z.number().int().min(1).max(16),
    }),
    query: (_db, args) => searchVector(documents.embedding, args),
});
