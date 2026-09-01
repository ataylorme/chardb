import { useState } from "react";
import { GITHUB_URL } from "../lib/constants";

function DatabaseSnippet() {
    return (
        <code>
            <span className="syntax-comment">{"// Better Auth config"}</span>
            {"\n"}
            <span className="syntax-keyword">export const</span> <span className="syntax-variable">auth</span> {"= "}
            <span className="syntax-function">defineAuth</span>
            <span className="syntax-punctuation">({"{"}</span>
            {"\n  "}
            <span className="syntax-property">plugins</span>: [<span className="syntax-function">anonymous</span>(),{" "}
            <span className="syntax-function">organization</span>(), <span className="syntax-function">jwt</span>()],
            {"\n"}
            <span className="syntax-punctuation">{"});"}</span>
            {"\n\n"}
            <span className="syntax-comment">{"// Drizzle + Better Auth ownership"}</span>
            {"\n"}
            <span className="syntax-keyword">const</span> {"{ "}
            <span className="syntax-variable">cdbTable</span>
            {" } = "}
            <span className="syntax-function">forOrg</span>
            <span className="syntax-punctuation">(auth);</span>
            {"\n\n"}
            <span className="syntax-keyword">export const</span> <span className="syntax-variable">messages</span>{" "}
            {"= "}
            <span className="syntax-function">cdbTable</span>
            <span className="syntax-punctuation">(</span>
            <span className="syntax-string">"messages"</span>
            <span className="syntax-punctuation">, {"{"}</span>
            {"\n  "}
            <span className="syntax-property">id</span>: <span className="syntax-function">text</span>(
            <span className="syntax-string">"id"</span>).<span className="syntax-function">primaryKey</span>(),
            {"\n  "}
            <span className="syntax-property">body</span>: <span className="syntax-function">text</span>(
            <span className="syntax-string">"body"</span>).<span className="syntax-function">notNull</span>(),
            {"\n"}
            <span className="syntax-punctuation">{"});"}</span>
            {"\n\n"}
            <span className="syntax-keyword">export default</span> <span className="syntax-function">chardb</span>
            <span className="syntax-punctuation">({"{"}</span>
            {"\n  "}
            <span className="syntax-property">auth</span>, <span className="syntax-property">schema</span>: {"{ "}
            <span className="syntax-variable">messages</span>
            {" },"}
            {"\n"}
            <span className="syntax-punctuation">{"});"}</span>
        </code>
    );
}

function ReactClientSnippet() {
    return (
        <code>
            <span className="syntax-keyword">import</span> {"{ "}
            <span className="syntax-function">createChardbReactClient</span>
            {" } "}
            <span className="syntax-keyword">from</span> <span className="syntax-string">"@chardb/react"</span>
            <span className="syntax-punctuation">;</span>
            {"\n\n"}
            <span className="syntax-keyword">const</span> <span className="syntax-variable">url</span> {"= "}
            <span className="syntax-variable">import</span>.<span className="syntax-property">meta</span>.
            <span className="syntax-property">env</span>.<span className="syntax-property">VITE_CHARD_DB_URL</span>
            {" ?? "}
            <span className="syntax-variable">window</span>.<span className="syntax-property">location</span>.
            <span className="syntax-property">origin</span>
            <span className="syntax-punctuation">;</span>
            {"\n\n"}
            <span className="syntax-keyword">export const</span> <span className="syntax-variable">db</span> {"= "}
            <span className="syntax-function">createChardbReactClient</span>
            <span className="syntax-punctuation">({"{"}</span>
            {"\n  "}
            <span className="syntax-property">url</span>,{"\n  "}
            <span className="syntax-property">ownership</span>: <span className="syntax-string">"organization"</span>,
            {"\n  "}
            <span className="syntax-property">auth</span>: ({"{ "}
            <span className="syntax-property">baseURL</span> {"}"}) ={">"}{" "}
            <span className="syntax-function">createAuthClient</span>({"{"}
            {"\n    "}
            <span className="syntax-property">baseURL</span>, <span className="syntax-property">plugins</span>: [
            <span className="syntax-function">anonymousClient</span>(),{" "}
            <span className="syntax-function">organizationClient</span>(),{" "}
            <span className="syntax-function">jwtClient</span>()],
            {"\n  "}
            {"}"}),{"\n"}
            <span className="syntax-punctuation">{"});"}</span>
            {"\n\n"}
            <span className="syntax-keyword">const</span> <span className="syntax-variable">signIn</span> {"= () => "}
            <span className="syntax-variable">db</span>.<span className="syntax-property">auth</span>.
            <span className="syntax-property">signIn</span>.<span className="syntax-function">anonymous</span>();
            {"\n\n"}
            <span className="syntax-keyword">export function</span> <span className="syntax-function">App</span>() {"{"}
            {"\n  "}
            <span className="syntax-keyword">const</span> <span className="syntax-variable">session</span> {"= "}
            <span className="syntax-variable">db</span>.<span className="syntax-property">auth</span>.
            <span className="syntax-function">useSession</span>();
            {"\n  "}
            <span className="syntax-keyword">if</span> (!<span className="syntax-variable">session</span>.
            <span className="syntax-property">data</span>) {"return <button onClick={signIn}>Sign in</button>;"}
            {"\n  "}
            <span className="syntax-keyword">return</span> {"<db.Provider><Workspace />"}
            {"\n    <button onClick={() => db.auth.signOut()}>Sign out</button>"}
            {"\n  </db.Provider>;"}
            {"\n"}
            {"}"}
            {"\n\n"}
            <span className="syntax-keyword">function</span> <span className="syntax-function">Workspace</span>() {"{"}
            {"\n  "}
            <span className="syntax-keyword">const</span> <span className="syntax-variable">identity</span> {"= "}
            <span className="syntax-variable">db</span>.<span className="syntax-function">useIdentity</span>();
            {"\n  "}
            <span className="syntax-keyword">const</span> {"{ "}
            <span className="syntax-variable">data</span>
            {" } = "}
            <span className="syntax-variable">db</span>.<span className="syntax-function">useQuery</span>(
            <span className="syntax-variable">listMessages</span>, {"{"}
            {"\n    "}
            <span className="syntax-property">limit</span>: <span className="syntax-number">50</span>,{"\n  "}
            {"});"}
            {"\n  "}
            <span className="syntax-keyword">if</span> (<span className="syntax-variable">identity</span>.
            <span className="syntax-property">status</span> !== <span className="syntax-string">"ready"</span>){" "}
            {"return <ChooseOrganization />;"}
            {"\n  "}
            <span className="syntax-keyword">return</span> {"<MessageList user={identity.user} data={data} />;"}
            {"\n"}
            {"}"}
        </code>
    );
}

function RustClientSnippet() {
    return (
        <code>
            <span className="syntax-keyword">use</span> <span className="syntax-variable">crate</span>::
            <span className="syntax-variable">operations</span>::{"{"}
            <span className="syntax-type">ListMessagesArgs</span>,{" "}
            <span className="syntax-variable">LIST_MESSAGES</span>
            {"};\n"}
            <span className="syntax-keyword">use</span> <span className="syntax-variable">chardb_client</span>::{"{"}
            <span className="syntax-type">AsyncClient</span>, <span className="syntax-type">ClientConfig</span>,{" "}
            <span className="syntax-type">SubscriptionEvent</span>
            {"};\n\n"}
            <span className="syntax-keyword">let</span> <span className="syntax-variable">client</span> {"= "}
            <span className="syntax-type">AsyncClient</span>::<span className="syntax-function">connect</span>(
            <span className="syntax-type">ClientConfig</span>::<span className="syntax-function">with_token</span>(
            <span className="syntax-variable">endpoint</span>, <span className="syntax-variable">jwt</span>))
            {"\n  ."}
            <span className="syntax-keyword">await</span>?;
            {"\n\n"}
            <span className="syntax-keyword">let mut</span> <span className="syntax-variable">messages</span> {"= "}
            <span className="syntax-variable">client</span>.<span className="syntax-function">subscribe</span>({"\n  "}
            <span className="syntax-variable">LIST_MESSAGES</span>,{"\n  &"}
            <span className="syntax-type">ListMessagesArgs</span> {"{"}
            <span className="syntax-property"> organization_id</span>, <span className="syntax-property">limit</span>:{" "}
            <span className="syntax-number">50</span> {"}"},{"\n"}
            )?;
            {"\n\n"}
            <span className="syntax-keyword">loop</span> {"{"}
            {"\n  "}
            <span className="syntax-keyword">let</span> <span className="syntax-variable">event</span> {"= "}
            <span className="syntax-variable">messages</span>.<span className="syntax-function">recv</span>().
            <span className="syntax-keyword">await</span>?;
            {"\n  "}
            <span className="syntax-keyword">if</span> <span className="syntax-function">matches!</span>(
            <span className="syntax-variable">event</span>, <span className="syntax-type">SubscriptionEvent</span>::
            <span className="syntax-property">Closed</span>) {"{ break; }"}
            {"\n  "}
            <span className="syntax-function">render</span>(<span className="syntax-variable">event</span>);
            {"\n"}
            {"}"}
        </code>
    );
}

const clientSdks = [
    { name: "React", icon: "/brands/react.svg", fileIcon: "/brands/file-react-ts.svg", available: true },
    { name: "Rust", icon: "/brands/rust.svg", fileIcon: "/brands/file-rust.svg", available: true },
    { name: "Python", icon: "/brands/python.svg", fileIcon: "/brands/python.svg", available: false },
    { name: "Swift", icon: "/brands/swift.svg", fileIcon: "/brands/swift.svg", available: false },
    { name: "Flutter", icon: "/brands/flutter.svg", fileIcon: "/brands/flutter.svg", available: false },
    { name: "Expo", icon: "/brands/expo.svg", fileIcon: "/brands/expo.svg", available: false },
] as const;
type ClientSdk = (typeof clientSdks)[number]["name"];

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
    const [clientSdk, setClientSdk] = useState<ClientSdk>("React");
    const selectedSdk = clientSdks.find(sdk => sdk.name === clientSdk) ?? clientSdks[0];

    return (
        <>
            <section id="files" className="border-y border-line bg-ink-900/50">
                <div className="mx-auto max-w-page px-5 py-20 sm:px-8 sm:py-28">
                    <div className="max-w-2xl">
                        <p className="eyebrow">Worker → client</p>
                        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                            Set up your Worker. Use it like an app SDK.
                        </h2>
                        <p className="mt-5 text-base leading-7 text-fg-muted">
                            Pick organization or user ownership once. Chardb carries the successful Better Auth identity
                            through routing, policy, typed handles, and every client query.
                        </p>
                    </div>

                    <div className="connection-stage mt-12">
                        <article className="code-window" aria-label="Worker database setup">
                            <header>
                                <span className="file-dot" />
                                <span className="file-dot" />
                                <span className="file-dot" />
                                <img
                                    className="file-type-icon"
                                    src="/brands/file-typescript.svg"
                                    alt=""
                                    width="18"
                                    height="18"
                                />
                                <code>src/database.ts</code>
                                <span className="code-surface">Worker</span>
                            </header>
                            <pre>
                                <DatabaseSnippet />
                            </pre>
                        </article>

                        <div className="connection-rail" aria-label="Authenticated live connection">
                            <span className="connection-line" />
                            <span className="connection-node" aria-hidden="true">
                                ↔
                            </span>
                            <span className="connection-label">Better Auth JWT</span>
                            <span className="connection-label">typed + live</span>
                        </div>

                        <article className="code-window" aria-label="Client SDK consumption">
                            <header>
                                <span className="file-dot" />
                                <span className="file-dot" />
                                <span className="file-dot" />
                                <img
                                    className="file-type-icon"
                                    src={selectedSdk.fileIcon}
                                    alt=""
                                    width="18"
                                    height="18"
                                />
                                <code>{clientSdk === "Rust" ? "src/main.rs" : "src/App.tsx"}</code>
                                <span className="code-surface">Client</span>
                            </header>
                            <div className="client-sdk-tabs" role="tablist" aria-label="Client SDK">
                                {clientSdks.map(sdk => {
                                    return (
                                        <button
                                            type="button"
                                            role="tab"
                                            aria-selected={clientSdk === sdk.name}
                                            disabled={!sdk.available}
                                            onClick={() => setClientSdk(sdk.name)}
                                            key={sdk.name}
                                        >
                                            <img
                                                className="sdk-tab-icon"
                                                src={sdk.icon}
                                                alt=""
                                                width="14"
                                                height="14"
                                            />
                                            {sdk.name}
                                            {!sdk.available ? <span>soon</span> : null}
                                        </button>
                                    );
                                })}
                            </div>
                            <pre>{clientSdk === "Rust" ? <RustClientSnippet /> : <ReactClientSnippet />}</pre>
                        </article>
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
                        <a href="/docs" className="text-fg-dim hover:text-fg transition-colors">
                            Docs
                        </a>
                    </div>
                </div>
            </section>
        </>
    );
}
