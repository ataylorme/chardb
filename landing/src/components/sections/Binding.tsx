import { CodeCard } from "../CodeCard";
import { InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Fn, Id, Kw, P, Str } from "../syn";

const shippedLabel = <span className="font-mono text-[11px] text-accent">shipped interface</span>;

export function Binding() {
    return (
        <Section id="binding" num="02" label="binding">
            <SectionHeading>It should feel like any other Worker binding.</SectionHeading>
            <SectionLead>
                One package, one schema entry, and one typed database handle beside KV, R2, and D1. Wrangler sees the
                public DB entrypoint and the storage migrations. Chardb resolves its internal objects through native
                loopback exports.
            </SectionLead>

            <div className="mt-10 grid grid-cols-1 gap-5">
                <CodeCard filename="worker.ts" header={shippedLabel}>
                    <Kw>const</Kw> <Id>app</Id> <P>=</P> <Fn>chardb</Fn>
                    <P>({"{"}</P> <Id>auth</Id>
                    <P>,</P> <Id>schema</Id>
                    <P>,</P> <Id>api</Id> <P>{"}"});</P>
                    {"\n\n"}
                    <Kw>export default</Kw> <Id>app</Id>
                    <P>;</P>
                    {"\n"}
                    <Kw>export const</Kw> <P>{"{"}</P> <Id>DB</Id>
                    <P>,</P> <Id>BlobMeta</Id>
                    <P>,</P> <Id>Catalog</Id>
                    <P>,</P> <Id>Cdb</Id>
                    <P>,</P> <Id>Gateway</Id>
                    <P>,</P> <Id>GsiShard</Id>
                    <P>,</P> <Id>Resharder</Id> <P>{"}"}</P> <P>=</P> <Id>app</Id>
                    <P>;</P>
                </CodeCard>

                <CodeCard filename="route.ts" header={shippedLabel}>
                    <Kw>import</Kw> <P>{"{"}</P> <Id>client</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"chardb"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>listMessages</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"./queries"</Str>
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
                    <P>.</P>
                    <Fn>query</Fn>
                    <P>(</P>
                    <Id>listMessages</Id>
                    <P>,</P> <P>{"{"}</P> <Id>organizationId</Id>
                    <P>,</P> <Id>channelId</Id>
                    <P>,</P> <Id>limit</Id>
                    <P>:</P> <P>50</P> <P>{"}"});</P>
                </CodeCard>
            </div>

            <p className="mt-6 text-sm text-fg-muted">
                Query and mutation handles stay in the Worker. Only their stable refs and bounded JSON arguments cross
                <InlineCode>env.DB</InlineCode>, after JWT verification and a fresh Catalog membership check.
            </p>

            <PullQuote>bind it. import it. query it.</PullQuote>
        </Section>
    );
}
