import { CodeCard } from "../CodeCard";
import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Cmt, Fn, Id, Kw, P, Str } from "../syn";

export function Auth() {
    return (
        <Section id="auth" num="04" label="auth">
            <SectionHeading>Auth and data, one schema.</SectionHeading>
            <SectionLead>
                Auth tables live in the same schema, the same client, the same query layer. Roles, permissions, and
                column-level access compile down with the rest of your types.
            </SectionLead>

            <BulletList
                items={[
                    "better-auth under the hood",
                    "roles and column masks in the schema",
                    "one query layer, not three services",
                ]}
            />

            <div className="mt-10">
                <CodeCard filename="schema.ts">
                    <Kw>export const</Kw> <Id>messages</Id> <P>=</P> <Fn>cdbTable</Fn>
                    <P>(</P>
                    {"\n    "}
                    <Str>"messages"</Str>
                    <P>,</P>
                    {"\n    "}
                    <P>{"{"}</P>
                    {"\n        "}
                    <Id>id</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"id"</Str>
                    <P>).</P>
                    <Fn>primaryKey</Fn>
                    <P>(),</P>
                    {"\n        "}
                    <Id>channelId</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"channel_id"</Str>
                    <P>)</P>
                    {"\n            "}
                    <P>.</P>
                    <Fn>notNull</Fn>
                    <P>()</P>
                    {"\n            "}
                    <P>.</P>
                    <Fn>references</Fn>
                    <P>(()</P> <Kw>{"=>"}</Kw> <Id>channels</Id>
                    <P>.</P>
                    <Id>id</Id>
                    <P>,</P> <P>{"{"}</P> <Id>onDelete</Id>
                    <P>:</P> <Str>"cascade"</Str> <P>{"}"}),</P>
                    {"\n        "}
                    <Id>organizationId</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"organization_id"</Str>
                    <P>)</P>
                    {"\n            "}
                    <P>.</P>
                    <Fn>notNull</Fn>
                    <P>()</P>
                    {"\n            "}
                    <P>.</P>
                    <Fn>references</Fn>
                    <P>(()</P> <Kw>{"=>"}</Kw> <Id>auth</Id>
                    <P>.</P>
                    <Id>organization</Id>
                    <P>.</P>
                    <Id>id</Id>
                    <P>,</P> <P>{"{"}</P> <Id>onDelete</Id>
                    <P>:</P> <Str>"cascade"</Str> <P>{"}"}),</P>
                    {"\n        "}
                    <Id>authorId</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"author_id"</Str>
                    <P>)</P>
                    {"\n            "}
                    <P>.</P>
                    <Fn>notNull</Fn>
                    <P>()</P>
                    {"\n            "}
                    <P>.</P>
                    <Fn>references</Fn>
                    <P>(()</P> <Kw>{"=>"}</Kw> <Id>auth</Id>
                    <P>.</P>
                    <Id>user</Id>
                    <P>.</P>
                    <Id>id</Id>
                    <P>,</P> <P>{"{"}</P> <Id>onDelete</Id>
                    <P>:</P> <Str>"cascade"</Str> <P>{"}"}),</P>
                    {"\n        "}
                    <Id>body</Id>
                    <P>:</P> <Fn>text</Fn>
                    <P>(</P>
                    <Str>"body"</Str>
                    <P>).</P>
                    <Fn>notNull</Fn>
                    <P>(),</P>
                    {"\n        "}
                    <Id>createdAt</Id>
                    <P>:</P> <Fn>integer</Fn>
                    <P>(</P>
                    <Str>"created_at"</Str>
                    <P>).</P>
                    <Fn>notNull</Fn>
                    <P>(),</P>
                    {"\n    "}
                    <P>{"}"},</P>
                    {"\n    "}
                    <P>{"{"}</P>
                    {"\n        "}
                    <Cmt>{"// `self` appears under `roles:` below, so chardb requires an"}</Cmt>
                    {"\n        "}
                    <Cmt>{"// explicit binding to the user-FK column. Validated at boot."}</Cmt>
                    {"\n        "}
                    <Id>selfBy</Id>
                    <P>:</P> <Str>"authorId"</Str>
                    <P>,</P>
                    {"\n        "}
                    <Id>roles</Id>
                    <P>:</P> <P>{"{"}</P>
                    {"\n            "}
                    <Id>admin</Id>
                    <P>:</P> <Str>"*"</Str>
                    <P>,</P>
                    {"\n            "}
                    <Id>member</Id>
                    <P>:</P> <P>{"{"}</P>
                    {"\n                "}
                    <Id>read</Id>
                    <P>:</P> <Str>"*"</Str>
                    <P>,</P>
                    {"\n                "}
                    <Id>create</Id>
                    <P>:</P> <P>[</P>
                    <Str>"body"</Str>
                    <P>,</P> <Str>"channelId"</Str>
                    <P>],</P>
                    {"\n            "}
                    <P>{"}"},</P>
                    {"\n            "}
                    <Id>self</Id>
                    <P>:</P> <P>{"{"}</P>
                    {"\n                "}
                    <Id>read</Id>
                    <P>:</P> <Str>"*"</Str>
                    <P>,</P>
                    {"\n                "}
                    <Id>update</Id>
                    <P>:</P> <P>[</P>
                    <Str>"body"</Str>
                    <P>],</P>
                    {"\n                "}
                    <Id>delete</Id>
                    <P>:</P> <Kw>true</Kw>
                    <P>,</P>
                    {"\n            "}
                    <P>{"}"},</P>
                    {"\n        "}
                    <P>{"}"},</P>
                    {"\n    "}
                    <P>{"}"}</P>
                    {"\n"}
                    <P>);</P>
                </CodeCard>
            </div>

            <p className="mt-6 text-sm text-fg-muted">row + column policies live with the column. validated at boot.</p>

            <PullQuote>users are just another table.</PullQuote>
        </Section>
    );
}
