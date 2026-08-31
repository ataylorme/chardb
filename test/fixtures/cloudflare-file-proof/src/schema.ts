import { file } from "@chardb/core/files";
import { forOrg } from "@chardb/core/server";
import { text } from "drizzle-orm/sqlite-core";
import { auth } from "./auth.ts";

const { cdbTable } = forOrg();

export const documents = cdbTable(
    "documents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id, { onDelete: "cascade" }),
        ownerId: text("owner_id")
            .notNull()
            .references(() => auth.user.id, { onDelete: "cascade" }),
        attachment: file("attachment", {
            maxSize: 5 * 1_024 * 1_024,
            contentTypes: ["application/octet-stream", "text/plain"],
        }),
    },
    {
        selfBy: "ownerId",
        roles: {
            owner: "*",
            admin: "*",
            member: { create: ["id", "attachment"] },
            self: { read: "*", update: ["attachment"], delete: true },
        },
    }
);
