import { CodeCard } from "../CodeCard";
import { PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Fn, Id, Kw, P, Str } from "../syn";

const shippedLabel = <span className="font-mono text-[11px] text-accent">shipped interface</span>;

export function Binding() {
    return (
        <Section id="binding" num="02" label="binding">
            <SectionHeading>It feels like a native Worker binding.</SectionHeading>
            <SectionLead>
                One package, one schema entry, and one typed database handle beside KV, R2, and D1. Wrangler sees the
                public DB entrypoint, the storage migrations, and four private same-Worker namespace bindings. The
                scaffold writes <code>wrangler.toml</code> by default, while existing JSONC projects remain supported.
                Explicit bindings carry internal Durable Object calls. Native loopback exports remain a fallback where
                the runtime supplies them.
            </SectionLead>

            <div className="mt-10 grid grid-cols-1 gap-5">
                <CodeCard filename="worker.ts" header={shippedLabel}>
                    <Kw>const</Kw> <Id>app</Id> <P>=</P> <Fn>chardb</Fn>
                    <P>({"{"}</P> <Id>auth</Id>
                    <P>,</P> <Id>schema</Id>
                    <P>,</P> <Id>api</Id>
                    <P>,</P> <Id>migrations</Id> <P>{"}"});</P>
                    {"\n\n"}
                    <Kw>export default</Kw> <Id>app</Id>
                    <P>;</P>
                    {"\n"}
                    <Kw>export const</Kw> <P>{"{"}</P> <Id>DB</Id>
                    <P>,</P> <Id>Catalog</Id>
                    <P>,</P> <Id>Cdb</Id>
                    <P>,</P> <Id>Gateway</Id>
                    <P>,</P> <Id>Resharder</Id> <P>{"}"}</P> <P>=</P> <Id>app</Id>
                    <P>;</P>
                </CodeCard>

                <CodeCard filename="route.ts" header={shippedLabel}>
                    <Kw>import</Kw> <P>{"{"}</P> <Id>client</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"@chardb/core"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>eq</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"drizzle-orm"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>messages</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"./schema"</Str>
                    <P>;</P>
                    {"\n\n"}
                    <Kw>const</Kw> <Id>db</Id> <P>=</P> <Fn>client</Fn>
                    <P>(</P>
                    <Id>c</Id>
                    <P>.</P>
                    <Id>env</Id>
                    <P>.</P>
                    <Id>DB</Id>
                    <P>,</P> <P>{"{"}</P> <Id>jwt</Id>
                    <P>,</P> <Id>authOrigin</Id> <P>{"}"});</P>
                    {"\n"}
                    <Kw>const</Kw> <Id>rows</Id> <P>=</P> <Kw>await</Kw> <Id>db</Id>
                    {"\n    "}
                    <P>.</P>
                    <Fn>select</Fn>
                    <P>()</P>
                    {"\n    "}
                    <P>.</P>
                    <Fn>from</Fn>
                    <P>(</P>
                    <Id>messages</Id>
                    <P>)</P>
                    {"\n    "}
                    <P>.</P>
                    <Fn>where</Fn>
                    <P>(</P>
                    <Fn>eq</Fn>
                    <P>(</P>
                    <Id>messages</Id>
                    <P>.</P>
                    <Id>organizationId</Id>
                    <P>,</P> <Id>organizationId</Id>
                    <P>))</P>
                    {"\n    "}
                    <P>.</P>
                    <Fn>limit</Fn>
                    <P>(</P>
                    <P>50</P>
                    <P>);</P>
                </CodeCard>
            </div>

            <p className="mt-6 text-sm text-fg-muted">
                The select sends a bounded plan, never SQL text. The DB entrypoint and Cdb each validate schema and
                placement. Catalog refreshes authority; Cdb applies policy. Version one is one full-row table, one exact
                partition, and at most 100 rows. Registered query handles still send only stable refs and bounded JSON
                arguments.
            </p>

            <PullQuote>bind it. import it. query it.</PullQuote>
        </Section>
    );
}
