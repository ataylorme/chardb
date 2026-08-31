import { forOrg } from "@chardb/core/server";
import { defineAuth, defineSchemaBaseline } from "@chardb/core/server";
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { integer, text } from "drizzle-orm/sqlite-core";

// This is the deployed version-one schema, not the current application schema.
// Keep it unchanged and append later migrations in worker.ts.
const authV1 = defineAuth({ plugins: [anonymous(), organization(), jwt()] });
const { cdbTable } = forOrg(authV1);

const messagesV1 = cdbTable(
    "messages",
    {
        id: text("id").primaryKey(),
        authorId: text("author_id")
            .notNull()
            .references(() => authV1.user.id, { onDelete: "cascade" }),
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

export const initialSchema = defineSchemaBaseline({
    version: 1,
    name: "initial_schema",
    domainSchema: { messages: messagesV1 },
    authOptions: authV1.options,
});
