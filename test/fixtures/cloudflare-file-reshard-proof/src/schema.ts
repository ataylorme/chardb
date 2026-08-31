import { file } from "@chardb/core/files";
import { forOrg, vector } from "@chardb/core/server";
import { text } from "drizzle-orm/sqlite-core";
import { auth } from "./auth.ts";
import { FILE_RESHARD_PROOF_VECTOR } from "./proof-config.ts";

const { cdbTable } = forOrg(auth);

export const documents = cdbTable(
    "proof_documents",
    {
        id: text("id").primaryKey(),
        ownerId: text("owner_id")
            .notNull()
            .references(() => auth.user.id, { onDelete: "cascade" }),
        attachment: file("attachment", {
            maxSize: 4_096,
            contentTypes: ["application/octet-stream"],
        }),
        body: text("body").notNull(),
        embedding: vector("embedding", {
            dim: FILE_RESHARD_PROOF_VECTOR.dimensions,
            binding: FILE_RESHARD_PROOF_VECTOR.binding,
            metric: FILE_RESHARD_PROOF_VECTOR.metric,
        }),
    },
    {
        selfBy: "ownerId",
        roles: {
            owner: "*",
            admin: "*",
            member: {
                create: ["id", "attachment", "body", "embedding"],
                read: { exclude: ["embedding"] },
                delete: true,
            },
            self: { read: { exclude: ["embedding"] }, delete: true },
        },
    }
);
