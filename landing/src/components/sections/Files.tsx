import { CodeCard } from "../CodeCard";
import { BulletList, InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Fn, Id, Kw, Num, P, Str } from "../syn";

export function Files() {
    return (
        <Section id="files" num="06" label="files + vectors">
            <SectionHeading>Files and vectors belong in the schema.</SectionHeading>
            <SectionLead>
                R2 objects and Vectorize records stay behind typed columns and organization policy.
                <InlineCode>file()</InlineCode> stores an opaque file identity; <InlineCode>vector()</InlineCode> stores
                one logical vector head. Application code never needs an R2 key or a physical Vectorize ID.
            </SectionLead>

            <BulletList
                items={[
                    "upload, attach, authorize, replace, download, restart, and delete an organization file",
                    "transaction-bound vector set and delete, bounded search, and live-query invalidation",
                    "range movement preserves file and vector identity beside ordinary rows",
                ]}
            />

            <div className="mt-10">
                <CodeCard
                    filename="schema.ts"
                    header={<span className="font-mono text-[11px] text-accent">schema-native</span>}
                >
                    <Kw>import</Kw> <P>{"{"}</P> <Id>file</Id> <P>{"}"}</P> <Kw>from</Kw>{" "}
                    <Str>"@chardb/core/files"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>vector</Id> <P>{"}"}</P> <Kw>from</Kw>{" "}
                    <Str>"@chardb/core/server"</Str>
                    <P>;</P>
                    {"\n\n"}
                    <Kw>export const</Kw> <Id>messages</Id> <P>=</P> <Fn>cdbTable</Fn>
                    <P>(</P>
                    <Str>"messages"</Str>
                    <P>,</P> <P>{"{"}</P>
                    {"\n  "}
                    <Id>attachment</Id>
                    <P>:</P> <Fn>file</Fn>
                    <P>(</P>
                    <Str>"attachment"</Str>
                    <P>, {"{"}</P> <Id>maxSize</Id>
                    <P>:</P> <Num>25</Num> <P>*</P> <Num>1024</Num> <P>*</P> <Num>1024</Num> <P>{"}"}),</P>
                    {"\n  "}
                    <Id>embedding</Id>
                    <P>:</P> <Fn>vector</Fn>
                    <P>(</P>
                    <Str>"embedding"</Str>
                    <P>, {"{"}</P> <Id>dim</Id>
                    <P>:</P> <Num>768</Num>
                    <P>,</P> <Id>binding</Id>
                    <P>:</P> <Str>"VECTORS"</Str>
                    <P>,</P> <Id>metric</Id>
                    <P>:</P> <Str>"cosine"</Str> <P>{"}"}),</P>
                    {"\n"}
                    <P>{"}"});</P>
                </CodeCard>
            </div>

            <PullQuote>one schema, even when the bytes live elsewhere.</PullQuote>
        </Section>
    );
}
