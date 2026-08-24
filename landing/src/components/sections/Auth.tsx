import { CodeCard } from "../CodeCard";
import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Cmt, Fn, Id, Kw, P, Str } from "../syn";

export function Auth() {
    return (
        <Section id="auth" num="04" label="auth">
            <SectionHeading>Declare access beside the table.</SectionHeading>
            <SectionLead>
                Better Auth models live in Catalog. For each declared organization mutation or exact-partition query,
                Gateway re-derives membership, roles, and auth epochs from Catalog. Cdb then enforces schema-declared
                write and select rules. The query path persists an exact generation and sends replacement snapshots
                after matching commits.
            </SectionLead>

            <BulletList
                items={[
                    "Catalog-backed Better Auth models and signed Gateway identity",
                    "declared organization writes use current membership, roles, auth epochs, row predicates, and column rules",
                    "declared exact-partition queries return policy-filtered initial and replacement snapshots",
                    "durable delivery retries until an exact client acknowledgement",
                    "packed replay and cross-organization denial pass for two anonymous principals",
                    "resume replay, packed restart, JWKS rotation, and migrations remain unfinished",
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
                Declared organization mutations and exact-partition live queries execute through the policy wrapper in
                focused workerd tests. The package remains experimental; do not use production data.
            </p>

            <PullQuote>one narrow live path works. it is not production ready.</PullQuote>
        </Section>
    );
}
