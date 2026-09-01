import { forOrg, forUser } from "@chardb/core/server";
import { integer, text } from "drizzle-orm/sqlite-core";
import { createCdbTable } from "../../../../../src/server/cdb-table.ts";
import { auth } from "./auth.ts";

// Organization and user ownership use the public schema factories.
const { cdbTable } = forOrg(auth);
const { cdbTable: userTable } = forUser(auth);

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

export const userPreferences = userTable(
    "user_preferences",
    {
        id: text("id").primaryKey(),
        theme: text("theme").notNull(),
    },
    {
        roles: {
            user: { create: ["id", "theme"], read: "*", update: ["theme"] },
            admin: "*",
        },
    }
);

const globalNoticeColumns = {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    body: text("body").notNull(),
};
export const globalNotices = createCdbTable({
    name: "global_notices",
    columns: globalNoticeColumns,
    config: {
        partitionBy: "namespace",
        roles: {
            user: { create: "*", read: "*" },
            admin: "*",
        },
    },
    tenantKind: "none",
    authTarget: null,
});
