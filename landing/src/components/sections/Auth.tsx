import { CodeCard } from "../CodeCard";
import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Cmt, Fn, Id, Kw, P, Str } from "../syn";

export function Auth() {
    return (
        <Section id="auth" num="05" label="auth">
            <SectionHeading>Auth and data, one schema.</SectionHeading>
            <SectionLead>
                Better Auth identities, tenant membership, roles, row rules, and column masks belong in the same typed
                model as application data. The organization path enforces that boundary today. The destination is one
                transaction and query layer across the full supported Better Auth workflow.
            </SectionLead>

            <BulletList
                items={[
                    "today: Catalog-backed Better Auth identity, membership, roles, and auth epochs",
                    "today: row predicates and readable or writable column rules enforced inside Cdb",
                    "today: live reruns re-check authority before replacing client state",
                    "target: supported Better Auth workflows can make atomic multi-write changes",
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

            <p className="mt-6 text-sm text-fg-muted">
                The tested organization slice includes anonymous sign-in, membership lookup, mutation, readback,
                cross-organization denial, role revocation, reconnect, and restart. Do not use production data yet.
            </p>

            <PullQuote>users should not require a second data system.</PullQuote>
        </Section>
    );
}
