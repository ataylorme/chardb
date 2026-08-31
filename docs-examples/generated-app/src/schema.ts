import { file } from "@chardb/core/files";
import { integer, text } from "drizzle-orm/sqlite-core";
import { forOrg } from "@chardb/core/server";
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
    attachment: file("attachment", { maxSize: 5 * 1_024 * 1_024, contentTypes: ["image/jpeg", "image/png"] }),
    createdAt: integer("created_at").notNull(),
  },
  {
    selfBy: "authorId",
    roles: {
      owner: "*",
      admin: "*",
      member: { read: "*", create: ["id", "body", "attachment", "createdAt"] },
      self: { read: "*", update: ["body", "attachment"], delete: true },
    },
  },
);
