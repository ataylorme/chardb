import { CodeCard } from "../CodeCard";
import { BulletList, InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Fn, Id, Kw, Num, P, Str } from "../syn";

export function Files() {
    return (
        <Section id="files" num="05" label="files">
            <SectionHeading>Files are columns.</SectionHeading>
            <SectionLead>
                <InlineCode>file()</InlineCode> and <InlineCode>fileArray()</InlineCode> are first-class Drizzle column
                types. Stored on R2 in your account, validated with zod / typebox / valibot at the edge, queried
                alongside the rest of your data.
            </SectionLead>

            <BulletList
                items={[
                    "upload, validate, store — one column type",
                    "R2 in your Cloudflare account, no third party",
                    "row-level access policies apply to attachments too",
                ]}
            />

            <div className="mt-10">
                <CodeCard filename="schema.ts">
                    <Kw>import</Kw> <P>{"{"}</P> <Id>file</Id>
                    <P>,</P> <Id>fileArray</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"chardb/files"</Str>
                    <P>;</P>
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
                    <Id>body</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"body"</Str>
                    <P>).</P>
                    <Fn>notNull</Fn>
                    <P>(),</P>
                    {"\n  "}
                    <Id>attachment</Id>
                    <P>:</P> <Fn>file</Fn>
                    <P>({"{"}</P> <Id>maxBytes</Id>
                    <P>:</P> <Num>25</Num> <P>*</P> <Num>1024</Num> <P>*</P> <Num>1024</Num> <P>{"}"}),</P>
                    {"\n  "}
                    <Id>images</Id>
                    <P>:</P> <Fn>fileArray</Fn>
                    <P>({"{"}</P> <Id>mime</Id>
                    <P>:</P> <Str>"image/*"</Str> <P>{"}"}),</P>
                    {"\n"}
                    <P>{"}"});</P>
                </CodeCard>
            </div>

            <PullQuote>no upload endpoint to write.</PullQuote>
        </Section>
    );
}
