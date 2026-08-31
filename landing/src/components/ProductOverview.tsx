import type { CSSProperties } from "react";
import { GITHUB_URL } from "../lib/constants";

const files = [
    {
        name: "schema.ts",
        code: `const { cdbTable } = forOrg();

export const messages = cdbTable(
  "messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    body: text("body").notNull(),
    attachment: file("attachment", {
      maxSize: 5 * 1_024 * 1_024,
      contentTypes: ["image/jpeg", "image/png"],
    }),
  },
);`,
    },
    {
        name: "auth.ts",
        code: `export const auth = defineAuth({
  appName: "my-chardb-app",
  plugins: [anonymous(), organization(), jwt()],
});`,
    },
    {
        name: "worker.ts",
        code: `export const app = chardb({
  auth,
  schema: domain,
  api: { ...api, ...queries },
  migrations,
});

export default app;`,
    },
    {
        name: "wrangler.toml",
        code: `main = "src/worker.ts"

[[durable_objects.bindings]]
name = "CDB_SHARD"
class_name = "Cdb"`,
    },
] as const;

const moments = [
    {
        label: "SQL + live",
        title: "The organization is the shard key.",
        body: "Drizzle queries stay inside the organization that Better Auth already resolved. Writes are transactional. Live handles update from the same shard.",
    },
    {
        label: "Files + vectors",
        title: "Rows can point to more than scalar data.",
        body: "File columns route to R2. Vector columns route to Vectorize. The schema keeps the organization boundary and application code keeps the row identity.",
    },
    {
        label: "Local + Cloudflare",
        title: "The same Worker runs on both sides of deploy.",
        body: "Wrangler owns the config. Miniflare and Cloudflare's Vitest integration run it locally. The generated Worker deploys without a separate database service.",
    },
] as const;

export function ProductOverview() {
    return (
        <>
            <section id="files" className="border-y border-line bg-ink-900/50">
                <div className="mx-auto max-w-page px-5 py-20 sm:px-8 sm:py-28 lg:grid lg:grid-cols-12 lg:items-center lg:gap-16">
                    <div className="lg:col-span-4">
                        <p className="eyebrow">the stack you already use</p>
                        <h2 className="mt-4 max-w-md text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                            Four familiar files. One database.
                        </h2>
                        <p className="mt-5 max-w-md text-base leading-7 text-fg-muted">
                            Better Auth supplies identity. Drizzle supplies the schema. Chardb turns both into a
                            Wrangler-native Worker backed by Durable Objects, R2, and Vectorize.
                        </p>
                    </div>

                    <div className="file-stack mt-12 lg:col-span-8 lg:mt-0" aria-label="Generated project files">
                        {files.map((file, index) => (
                            <article
                                className="file-card"
                                key={file.name}
                                style={{ "--file-index": index } as CSSProperties}
                            >
                                <header>
                                    <span className="file-dot" />
                                    <span className="file-dot" />
                                    <span className="file-dot" />
                                    <code>{file.name}</code>
                                </header>
                                <pre>
                                    <code>{file.code}</code>
                                </pre>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section id="product" className="mx-auto max-w-page px-5 py-20 sm:px-8 sm:py-28">
                <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
                    {moments.map(moment => (
                        <article className="bg-ink-950 p-7 sm:p-8" key={moment.label}>
                            <p className="font-mono text-xs text-accent">{moment.label}</p>
                            <h2 className="mt-8 text-xl font-medium leading-snug text-fg">{moment.title}</h2>
                            <p className="mt-3 text-sm leading-6 text-fg-muted">{moment.body}</p>
                        </article>
                    ))}
                </div>

                <div className="mt-16 flex flex-col items-start justify-between gap-7 border-t border-line pt-8 sm:flex-row sm:items-center">
                    <p className="max-w-xl text-xl leading-8 text-fg">
                        Start with the generated app. Keep the Cloudflare stack you already know.
                    </p>
                    <div className="flex items-center gap-5 text-sm">
                        <a href="/why/" className="text-fg hover:text-accent transition-colors">
                            Why Chardb
                        </a>
                        <a href={GITHUB_URL} rel="noopener" className="text-fg hover:text-accent transition-colors">
                            GitHub
                        </a>
                        <span className="text-fg-dim" aria-label="Documentation coming soon">
                            Docs soon
                        </span>
                    </div>
                </div>
            </section>
        </>
    );
}
