import { forOrg } from "@chardb/core/server";
import { integer, text } from "drizzle-orm/sqlite-core";
import { auth } from "./auth.ts";

const { cdbTable } = forOrg(auth);

export const channels = cdbTable(
    "channels",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    {
        publicRead: true,
        roles: {
            admin: "*",
            member: { create: ["id", "name", "createdAt"] },
        },
    }
);

export const messages = cdbTable(
    "messages",
    {
        id: text("id").primaryKey(),
        channelId: text("channel_id")
            .notNull()
            .references(() => channels.id, { onDelete: "cascade" }),
        authorId: text("author_id")
            .notNull()
            .references(() => auth.user.id, { onDelete: "cascade" }),
        body: text("body").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    {
        // `self` appears under `roles:` below, so chardb requires an
        // explicit binding to the user-FK column. Validated at boot.
        selfBy: "authorId",
        roles: {
            admin: "*",
            member: {
                read: "*",
                create: ["id", "body", "channelId", "createdAt"],
            },
            self: {
                read: "*",
                update: ["body"],
                delete: true,
            },
        },
    }
);
