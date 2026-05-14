import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { auth } from "./worker.ts";

// Any `organization_id` FK to `auth.organization` auto-colocates the row
// on the org's shard — chardb walks the FK graph; no `partitionKey` here.
export const channels = sqliteTable("channels", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
        .notNull()
        .references(() => auth.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
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
});
