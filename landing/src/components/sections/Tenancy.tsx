import { CodeCard } from "../CodeCard";
import { InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Cmt, Fn, Id, Kw, P, Str } from "../syn";

export function Tenancy() {
    return (
        <Section id="tenancy" num="04" label="tenancy">
            <SectionHeading>Sharded the way your app already works.</SectionHeading>
            <SectionLead>
                <InlineCode>forOrg()</InlineCode>, <InlineCode>forUser()</InlineCode>, and{" "}
                <InlineCode>globalScope()</InlineCode> declare placement, transaction, and policy boundaries once.
                Organization, user, and narrow global paths run through the binding, WebSocket live queries, Catalog
                authority, and Cdb policy enforcement. A global operation names one exact application partition and runs
                on one physical Cdb. Workerd and clean-tarball Miniflare tests prove cross-principal sharing,
                neighboring-partition isolation, reconstruction, replay, and restart. Composite, replicated, and
                cross-boundary operations remain closed.
            </SectionLead>

            <div className="mt-10">
                <CodeCard filename="schema.ts">
                    <Kw>import</Kw> <P>{"{"}</P> <Id>forOrg</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"chardb/server"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>const</Kw> <P>{"{"}</P> <Id>cdbTable</Id> <P>{"}"}</P> <P>=</P> <Fn>forOrg</Fn>
                    <P>();</P>
                    {"\n\n"}
                    <Kw>export const</Kw> <Id>messages</Id> <P>=</P> <Fn>cdbTable</Fn>
                    <P>(</P>
                    <Str>"messages"</Str>
                    <P>,</P> <P>{"{"}</P>
                    {"\n  "}
                    <Id>id</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"id"</Str>
                    <P>).</P>
                    <Fn>primaryKey</Fn>
                    <P>(),</P>
                    {"\n  "}
                    <Cmt>{"// organization placement and policy key"}</Cmt>
                    {"\n  "}
                    <Id>organizationId</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"organization_id"</Str>
                    <P>).</P>
                    <Fn>notNull</Fn>
                    <P>()</P>
                    {"\n    "}
                    <P>.</P>
                    <Fn>references</Fn>
                    <P>(()</P> <Kw>{"=>"}</Kw> <Id>auth</Id>
                    <P>.</P>
                    <Id>organization</Id>
                    <P>.</P>
                    <Id>id</Id>
                    <P>),</P>
                    {"\n  "}
                    <Id>body</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"body"</Str>
                    <P>).</P>
                    <Fn>notNull</Fn>
                    <P>(),</P>
                    {"\n"}
                    <P>{"}"});</P>
                </CodeCard>
            </div>

            <PullQuote>the schema is the boundary.</PullQuote>
        </Section>
    );
}
