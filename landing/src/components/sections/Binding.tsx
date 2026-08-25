import { CodeCard } from "../CodeCard";
import { InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Fn, Id, Kw, P, Str } from "../syn";

const targetLabel = <span className="font-mono text-[11px] text-accent">target interface · not shipped</span>;

export function Binding() {
    return (
        <Section id="binding" num="02" label="binding">
            <SectionHeading>It should feel like any other Worker binding.</SectionHeading>
            <SectionLead>
                The target is one package, one schema entry, and one typed database handle beside KV, R2, and D1.
                Today's scaffold already hides its internal Durable Object bindings behind Wrangler migrations and
                native loopback exports. The typed DB handle shown below is the remaining interface work.
            </SectionLead>

            <div className="mt-10 grid grid-cols-1 gap-5">
                <CodeCard header={targetLabel}>
                    <P>{"{"}</P>
                    {"\n  "}
                    <Str>"chardb"</Str>
                    <P>:</P> <P>[{"{"}</P>
                    {"\n    "}
                    <Str>"binding"</Str>
                    <P>:</P> <Str>"DB"</Str>
                    <P>,</P>
                    {"\n    "}
                    <Str>"schema"</Str>
                    <P>:</P> <Str>"./src/schema.ts"</Str> <P>{"}]"}</P>
                    {"\n"}
                    <P>{"}"}</P>
                </CodeCard>

                <CodeCard filename="worker.ts" header={targetLabel}>
                    <Kw>import</Kw> <P>{"{"}</P> <Id>client</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"chardb"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>eq</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"drizzle-orm"</Str>
                    <P>;</P>
                    {"\n\n"}
                    <Kw>const</Kw> <Id>db</Id> <P>=</P> <Fn>client</Fn>
                    <P>(</P>
                    <Id>env</Id>
                    <P>.</P>
                    <Id>DB</Id>
                    <P>);</P>
                    {"\n"}
                    <Kw>const</Kw> <Id>rows</Id> <P>=</P> <Kw>await</Kw> <Id>db</Id>
                    {"\n  "}
                    <P>.</P>
                    <Fn>select</Fn>
                    <P>()</P>
                    {"\n  "}
                    <P>.</P>
                    <Fn>from</Fn>
                    <P>(</P>
                    <Id>messages</Id>
                    <P>)</P>
                    {"\n  "}
                    <P>.</P>
                    <Fn>where</Fn>
                    <P>(</P>
                    <Fn>eq</Fn>
                    <P>(</P>
                    <Id>messages</Id>
                    <P>.</P>
                    <Id>channelId</Id>
                    <P>,</P> <Id>id</Id>
                    <P>));</P>
                </CodeCard>
            </div>

            <p className="mt-6 text-sm text-fg-muted">
                Until that adapter exists, use <InlineCode>chardb init</InlineCode> and the generated Worker boundary.
            </p>

            <PullQuote>bind it. import it. query it.</PullQuote>
        </Section>
    );
}
