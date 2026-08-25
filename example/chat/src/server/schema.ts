import { forOrg, forUser, globalScope } from "chardb/server";
import { integer, text } from "drizzle-orm/sqlite-core";
import { auth } from "./worker.ts";

// Every cdbTable in this file is org-tenanted. The tenant column is
// auto-discovered from the `.references(() => auth.organization.id)`
const { cdbTable } = forOrg();
const { cdbTable: userTable } = forUser();
const { cdbTable: globalTable } = globalScope();

export const channels = cdbTable(
    "channels",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id, { onDelete: "cascade" }),
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
        userId: text("user_id")
            .notNull()
            .references(() => auth.user.id, { onDelete: "cascade" }),
        theme: text("theme").notNull(),
    },
    {
        roles: {
            user: { create: ["id", "theme"], read: "*", update: ["theme"] },
            admin: "*",
        },
    }
);

export const globalNotices = globalTable(
    "global_notices",
    {
        id: text("id").primaryKey(),
        namespace: text("namespace").notNull(),
        body: text("body").notNull(),
    },
    {
        partitionBy: "namespace",
        roles: {
            user: { create: "*", read: "*" },
            admin: "*",
        },
    }
);
