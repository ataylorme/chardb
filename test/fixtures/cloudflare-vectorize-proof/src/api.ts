import { CdbError } from "@chardb/core";
import { api, searchVector } from "@chardb/core/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { vectorDocuments } from "./schema.ts";

const vectorArgs = z.object({
    id: z.string().min(1).max(128),
    organizationId: z.string().min(1).max(128),
    body: z.string().min(1).max(2_000),
    values: z.array(z.number().finite()).length(32),
});

const deleteArgs = z.object({
    id: z.string().min(1).max(128),
    organizationId: z.string().min(1).max(128),
});

function assertOrganization(tenantId: string | undefined, organizationId: string): void {
    if (!tenantId || tenantId !== organizationId) {
        throw new CdbError({ code: "CDB_FORBIDDEN", message: "active organization does not match vector placement" });
    }
}

export const createVectorDocument = api.mutation({
    ref: "cloudflare-vectorize-proof/api.ts#createVectorDocument",
    authority: "organization",
    args: vectorArgs,
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        assertOrganization(ctx.auth.tenantId, args.organizationId);
        const embedding = ctx.vector.set(vectorDocuments.embedding, args.id, args.values);
        ctx.db.insert(vectorDocuments).values({ id: args.id, body: args.body, embedding }).run();
        return { id: args.id, vectorId: embedding.id };
    },
});

export const replaceVectorDocument = api.mutation({
    ref: "cloudflare-vectorize-proof/api.ts#replaceVectorDocument",
    authority: "organization",
    args: vectorArgs,
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        assertOrganization(ctx.auth.tenantId, args.organizationId);
        const embedding = ctx.vector.set(vectorDocuments.embedding, args.id, args.values);
        ctx.db.update(vectorDocuments).set({ body: args.body, embedding }).where(eq(vectorDocuments.id, args.id)).run();
        return { id: args.id, vectorId: embedding.id };
    },
});

export const deleteVectorDocument = api.mutation({
    ref: "cloudflare-vectorize-proof/api.ts#deleteVectorDocument",
    authority: "organization",
    args: deleteArgs,
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        assertOrganization(ctx.auth.tenantId, args.organizationId);
        ctx.vector.delete(vectorDocuments.embedding, args.id);
        ctx.db.delete(vectorDocuments).where(eq(vectorDocuments.id, args.id)).run();
        return { id: args.id };
    },
});

export const listVectorDocuments = api.query({
    ref: "cloudflare-vectorize-proof/api.ts#listVectorDocuments",
    args: z.object({
        organizationId: z.string().min(1).max(128),
        limit: z.number().int().min(1).max(100),
    }),
    query: (db, args) =>
        db
            .select({ id: vectorDocuments.id, body: vectorDocuments.body })
            .from(vectorDocuments)
            .where(eq(vectorDocuments.organizationId, args.organizationId))
            .orderBy(asc(vectorDocuments.id))
            .limit(args.limit),
});

export const searchVectorDocuments = api.query({
    ref: "cloudflare-vectorize-proof/api.ts#searchVectorDocuments",
    args: z.object({
        organizationId: z.string().min(1).max(128),
        values: z.array(z.number().finite()).length(32),
        limit: z.number().int().min(1).max(100),
    }),
    query: (_db, args) => searchVector(vectorDocuments.embedding, args),
});
