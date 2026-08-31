import { GITHUB_URL } from "../lib/constants";

function DatabaseSnippet() {
    return (
        <code>
            <span className="syntax-comment">{"// auth.ts"}</span>
            {"\n"}
            <span className="syntax-keyword">export const</span> <span className="syntax-variable">auth</span> ={" "}
            <span className="syntax-function">defineAuth</span>({"{"}
            {"\n  "}
            <span className="syntax-property">plugins</span>: [<span className="syntax-function">organization</span>(),{" "}
            <span className="syntax-function">jwt</span>()],
            {"\n"}
            {"});"}
            {"\n\n"}
            <span className="syntax-comment">{"// schema.ts"}</span>
            {"\n"}
            <span className="syntax-keyword">const</span> {"{ "}
            <span className="syntax-variable">cdbTable</span>
            {" }"} = <span className="syntax-function">forOrg</span>();
            {"\n\n"}
            <span className="syntax-keyword">export const</span> <span className="syntax-variable">messages</span> ={" "}
            <span className="syntax-function">cdbTable</span>(<span className="syntax-string">"messages"</span>, {"{"}
            {"\n  "}
            <span className="syntax-property">id</span>: <span className="syntax-function">text</span>(
            <span className="syntax-string">"id"</span>).<span className="syntax-function">primaryKey</span>(),
            {"\n  "}
            <span className="syntax-property">organizationId</span>: <span className="syntax-function">text</span>(
            <span className="syntax-string">"organization_id"</span>){"\n    ."}
            <span className="syntax-function">notNull</span>()
            {"\n    ."}
            <span className="syntax-function">references</span>(() ={">"} <span className="syntax-variable">auth</span>.
            <span className="syntax-property">organization</span>.<span className="syntax-property">id</span>),
            {"\n  "}
            <span className="syntax-property">body</span>: <span className="syntax-function">text</span>(
            <span className="syntax-string">"body"</span>).<span className="syntax-function">notNull</span>(),
            {"\n"}
            {"});"}
        </code>
    );
}

const moments = [
    {
        label: "Realtime",
        title: "Queries update after the transaction commits.",
        body: "Live handles rerun on the owning shard, so the browser sees committed rows without polling or a second sync service.",
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
                        <p className="eyebrow">auth + data</p>
                        <h2 className="mt-4 max-w-md text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                            Your organization is the shard key.
                        </h2>
                        <p className="mt-5 max-w-md text-base leading-7 text-fg-muted">
                            Define Better Auth and one Drizzle table. Chardb turns that relationship into an isolated,
                            transactional database inside your Worker.
                        </p>
                    </div>

                    <article className="code-window mt-12 lg:col-span-8 lg:mt-0" aria-label="Auth and table example">
                        <header>
                            <span className="file-dot" />
                            <span className="file-dot" />
                            <span className="file-dot" />
                            <code>auth.ts + schema.ts</code>
                        </header>
                        <pre>
                            <DatabaseSnippet />
                        </pre>
                    </article>
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
