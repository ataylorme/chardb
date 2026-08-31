import { forOrg } from "@chardb/core/server";
import { integer, text } from "drizzle-orm/sqlite-core";
import { auth } from "./auth.ts";

const { cdbTable } = forOrg();

export const messages = cdbTable(
    "messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id, { onDelete: "cascade" }),
        authorId: text("author_id")
            .notNull()
            .references(() => auth.user.id, { onDelete: "cascade" }),
        body: text("body").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    {
        selfBy: "authorId",
        roles: {
            owner: "*",
            admin: "*",
            member: { create: ["id", "body", "createdAt"], read: "*" },
            self: { update: ["body"], delete: true },
        },
    }
);
