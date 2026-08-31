import { CdbError } from "@chardb/core";
import { FileId } from "@chardb/core/files";
import { api } from "@chardb/core/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { documents } from "./schema.ts";

const documentArgs = z.object({
    id: z.string().min(1).max(128),
    organizationId: z.string().min(1).max(128),
    fileId: z.string().min(1).max(128),
});

function assertOrganization(tenantId: string | undefined, organizationId: string): void {
    if (!tenantId || tenantId !== organizationId) {
        throw new CdbError({ code: "CDB_FORBIDDEN", message: "active organization does not match the document" });
    }
}

export const createDocument = api.mutation({
    ref: "cloudflare-file-proof/api.ts#createDocument",
    authority: "organization",
    args: documentArgs,
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        assertOrganization(ctx.auth.tenantId, args.organizationId);
        ctx.db
            .insert(documents)
            .values({ id: args.id, attachment: FileId(args.fileId) })
            .run();
        return { id: args.id, fileId: args.fileId };
    },
});

export const replaceDocumentFile = api.mutation({
    ref: "cloudflare-file-proof/api.ts#replaceDocumentFile",
    authority: "organization",
    args: documentArgs,
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        assertOrganization(ctx.auth.tenantId, args.organizationId);
        ctx.db
            .update(documents)
            .set({ attachment: FileId(args.fileId) })
            .where(eq(documents.id, args.id))
            .run();
        return { id: args.id, fileId: args.fileId };
    },
});
