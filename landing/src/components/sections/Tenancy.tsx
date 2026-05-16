import { CodeCard } from "../CodeCard";
import { InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Cmt, Fn, Id, Kw, P, Str } from "../syn";

export function Tenancy() {
    return (
        <Section id="tenancy" num="03" label="tenancy">
            <SectionHeading>Sharded the way your app already works.</SectionHeading>
            <SectionLead>
                Per-tenant ACID, declared in the schema. <InlineCode>forOrg()</InlineCode>,{" "}
                <InlineCode>forUser()</InlineCode>, and <InlineCode>globalScope()</InlineCode> from{" "}
                <InlineCode>chardb/server</InlineCode> mark the boundary; chardb routes every query and transaction by
                it.
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
                    <Cmt>// shard key — you already wrote it.</Cmt>
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
