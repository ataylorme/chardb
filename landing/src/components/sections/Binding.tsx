import { useState } from "react";
import { CodeCard } from "../CodeCard";
import { InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";
import { Fn, Id, Kw, P, Str } from "../syn";

type Tab = "toml" | "jsonc";

export function Binding() {
    const [tab, setTab] = useState<Tab>("toml");

    const tabHeader = (
        <div role="tablist" aria-label="wrangler config format" className="flex items-center gap-1">
            <button
                type="button"
                role="tab"
                aria-selected={tab === "toml"}
                onClick={() => setTab("toml")}
                className="wrangler-tab px-2 py-1 rounded-md text-fg-dim hover:text-fg transition-colors"
            >
                wrangler.toml
            </button>
            <span className="text-fg-dim/40">·</span>
            <button
                type="button"
                role="tab"
                aria-selected={tab === "jsonc"}
                onClick={() => setTab("jsonc")}
                className="wrangler-tab px-2 py-1 rounded-md text-fg-dim hover:text-fg transition-colors"
            >
                wrangler.jsonc
            </button>
        </div>
    );

    return (
        <Section id="binding" num="01" label="binding">
            <SectionHeading>It installs like any other binding.</SectionHeading>
            <SectionLead>
                chardb is a Worker binding. One npm install, one entry in <InlineCode>wrangler.jsonc</InlineCode>, and
                your database is in scope next to KV, R2, and D1.
            </SectionLead>

            <div className="mt-10 grid grid-cols-1 gap-5">
                <CodeCard header={tabHeader}>
                    {tab === "toml" ? (
                        <>
                            <P>[[</P>
                            <Id>chardb</Id>
                            <P>]]</P>
                            {"\n"}
                            <Id>binding</Id> <P>=</P> <Str>"DB"</Str>
                            {"\n"}
                            <Id>schema</Id> <P>=</P> <Str>"./src/schema.ts"</Str>
                        </>
                    ) : (
                        <>
                            <P>{"{"}</P>
                            {"\n  "}
                            <Str>"chardb"</Str>
                            <P>:</P> <P>[{"{"}</P> <Str>"binding"</Str>
                            <P>:</P> <Str>"DB"</Str>
                            <P>,</P> <Str>"schema"</Str>
                            <P>:</P> <Str>"./src/schema.ts"</Str> <P>{"}]"}</P>
                            {"\n"}
                            <P>{"}"}</P>
                        </>
                    )}
                </CodeCard>

                <CodeCard filename="worker.ts">
                    <Kw>import</Kw> <P>{"{"}</P> <Id>client</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"chardb"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>eq</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"drizzle-orm"</Str>
                    <P>;</P>
                    {"\n"}
                    <Kw>import</Kw> <P>{"{"}</P> <Id>messages</Id> <P>{"}"}</P> <Kw>from</Kw> <Str>"./schema"</Str>
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
                    <P>.</P>
                    <Fn>select</Fn>
                    <P>().</P>
                    <Fn>from</Fn>
                    <P>(</P>
                    <Id>messages</Id>
                    <P>).</P>
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

            <PullQuote>bind it. import it. query it.</PullQuote>
        </Section>
    );
}
