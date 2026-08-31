import { forOrg } from "@chardb/core/server";
import { integer, text } from "drizzle-orm/sqlite-core";
import { auth } from "./auth.ts";

const { cdbTable } = forOrg(auth);

export const messages = cdbTable(
    "messages",
    {
        id: text("id").primaryKey(),
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
