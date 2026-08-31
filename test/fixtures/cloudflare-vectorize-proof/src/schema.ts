import { forOrg } from "@chardb/core/server";
import { text } from "drizzle-orm/sqlite-core";
import { auth } from "./auth.ts";
import { vector } from "./vector-proof.ts";

const { cdbTable } = forOrg();

export const vectorDocuments = cdbTable(
    "vector_proof_documents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id, { onDelete: "cascade" }),
        body: text("body").notNull(),
        embedding: vector("embedding", {
            dim: 32,
            binding: "CDB_PROOF_VECTORS",
            metric: "cosine",
        }),
    },
    {
        roles: {
            owner: "*",
            admin: "*",
            member: {
                create: ["id", "body", "embedding"],
                read: { exclude: ["embedding"] },
                update: ["body", "embedding"],
                delete: true,
            },
        },
    }
);
