import type { CliContext } from "../context.ts";
import { renderWrangler } from "../wrangler_template.ts";

export interface InitOptions {
    readonly name: string;
    readonly compatibilityDate?: string;
}

const DEFAULT_COMPAT_DATE = "2026-05-10";

const SCHEMA_TEMPLATE = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { auth } from "./worker.ts";

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => auth.organization.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => auth.user.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});
`;

const API_TEMPLATE = `import { api, tenantScope } from "chardb/server";
import { z } from "zod";
import { messages } from "./schema.ts";

export const postMessage = api.mutation({
  args: z.object({
    id: z.string(),
    organizationId: z.string(),
    body: z.string().min(1),
    authorId: z.string(),
    clientCreatedAt: z.number(),
  }),
  partitionKey: "organizationId",
  handler: async (ctx, args) => {
    await ctx.db.insert(messages).values({
      id: args.id,
      organizationId: args.organizationId,
      authorId: args.authorId,
      body: args.body,
      createdAt: args.clientCreatedAt,
    });
    return { id: args.id };
  },
});

/** One-line row policy: messages are visible only to the active org's members. */
export const orgIsolation = tenantScope(() => messages);
`;

const WORKER_TEMPLATE = `import { organization } from "better-auth/plugins/organization";
import { chardb, defineAuth } from "chardb/server";
import * as api from "./api.ts";
import * as domain from "./schema.ts";

// Better-auth profile. Plugin tables are inferred from the tuple;
// \`auth.user\`, \`auth.organization\`, etc. are typed Drizzle tables
// the domain schema FKs into. Declared at the top level so
// \`schema.ts\` can \`import { auth } from "./worker.ts"\` cleanly.
export const auth = defineAuth({
  appName: "{{NAME}}",
  plugins: [organization()],
});

// One factory call composes the runtime: merged Drizzle schema, lazy
// manifest from \`api\`'s exports, Hono router for non-reserved routes,
// the six Durable Object classes wrangler binds. The returned \`app\`
// is the wrangler-ready module — chain user routes on it directly.
export const app = chardb({ auth, schema: domain, api });

app.get("/health", (c) => c.text("ok"));

export default app;
export const { BlobMeta, Catalog, Cdb, Gateway, GsiShard, Resharder } = app;
`;

const CONFIG_TEMPLATE = `// drizzle-kit config. chardb's runtime owns the schema merge at
// \`defineChardb({ auth, schema })\` time; drizzle-kit only sees the
// domain tables here for migration-file generation against the local
// dev database.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  dialect: "sqlite",
  out: "./drizzle",
});
`;

export async function runInit(ctx: CliContext, opts: InitOptions): Promise<void> {
    const compat = opts.compatibilityDate ?? DEFAULT_COMPAT_DATE;
    const wrangler = renderWrangler({
        name: opts.name,
        compatibilityDate: compat,
        r2Bucket: `${opts.name}-blobs`,
        vectorizeIndex: `${opts.name}-embeddings`,
        gsiQueue: `${opts.name}-gsi-tail`,
        assetsDir: ".chardb/dashboard",
    });
    await ctx.write(`${ctx.cwd}/wrangler.jsonc`, `${wrangler}\n`);
    await ctx.write(`${ctx.cwd}/src/schema.ts`, SCHEMA_TEMPLATE);
    await ctx.write(`${ctx.cwd}/src/api.ts`, API_TEMPLATE);
    await ctx.write(`${ctx.cwd}/src/worker.ts`, WORKER_TEMPLATE.replace("{{NAME}}", opts.name));
    await ctx.write(`${ctx.cwd}/drizzle.config.ts`, CONFIG_TEMPLATE);
    ctx.stdout(`chardb: initialised "${opts.name}" with compat date ${compat}\n`);
}
