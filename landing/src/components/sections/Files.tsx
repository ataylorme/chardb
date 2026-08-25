import { CodeCard } from "../CodeCard";
import { BulletList, InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Fn, Id, Kw, Num, P, Str } from "../syn";

export function Files() {
    return (
        <Section id="files" num="06" label="files + vectors">
            <SectionHeading>Files and vectors belong in the schema.</SectionHeading>
            <SectionLead>
                The destination keeps R2 objects and Vectorize records behind typed columns, tenant policy, and the same
                query surface as SQL. <InlineCode>file()</InlineCode>, <InlineCode>fileArray()</InlineCode>, and{" "}
                <InlineCode>vector()</InlineCode> exist as experimental schema primitives. Their storage, indexing,
                cleanup, and live-query paths are not supported yet.
            </SectionLead>

            <BulletList
                items={[
                    "target: upload, validate, retain, and authorize a file through one column type",
                    "target: index and query embeddings without a second application data model",
                    "required before support: end-to-end lifecycle, quota, failure, and tenant-isolation proofs",
                ]}
            />

            <div className="mt-10">
                <CodeCard
                    filename="schema.ts"
                    header={
                        <span className="font-mono text-[11px] text-accent">target runtime · experimental types</span>
                    }
                >
                    <Kw>import</Kw> <P>{"{"}</P> <Id>file</Id>
                    <P>,</P> <Id>fileArray</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"chardb/files"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>vector</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"chardb/server"</Str>
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
                    <Id>images</Id>
                    <P>:</P> <Fn>fileArray</Fn>
                    <P>(</P>
                    <Str>"images"</Str>
                    <P>),</P>
                    {"\n  "}
                    <Id>embedding</Id>
                    <P>:</P> <Fn>vector</Fn>
                    <P>(</P>
                    <Str>"embedding"</Str>
                    <P>, {"{"}</P> <Id>dim</Id>
                    <P>:</P> <Num>1536</Num> <P>{"}"}),</P>
                    {"\n"}
                    <P>{"}"});</P>
                </CodeCard>
            </div>

            <PullQuote>one schema, even when the bytes live elsewhere.</PullQuote>
        </Section>
    );
}
