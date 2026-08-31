import type { ReactNode } from "react";
import { PullQuote, SectionHeading } from "../Section";

function StorySection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="border-t border-line pt-8 first:border-t-0 first:pt-0">
            <h3 className="font-semibold text-fg text-xl tracking-tight">{title}</h3>
            <div className="mt-4 space-y-4 text-fg-muted leading-7">{children}</div>
        </section>
    );
}

export function Why() {
    return (
        <section id="why">
            <article className="mx-auto max-w-page px-5 sm:px-8 py-16 lg:py-28">
                <p className="eyebrow">founder note / august 2026</p>

                <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-start">
                    <header className="lg:col-span-5 lg:sticky lg:top-24">
                        <SectionHeading>Why I built Chardb.</SectionHeading>
                        <p className="mt-5 text-fg-muted text-[17px] leading-7">
                            I want to share the inspiration for why I built this and what I think it could become.
                        </p>
                        <a
                            href="/"
                            className="mt-7 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors"
                        >
                            Back to the product <span aria-hidden="true">→</span>
                        </a>
                    </header>

                    <div className="lg:col-span-7 space-y-10">
                        <StorySection title="I ❤️ Better Auth">
                            <p>
                                I immediately fell in love with the{" "}
                                <a
                                    href="https://better-auth.com/"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-fg underline decoration-line underline-offset-4 transition-colors hover:text-accent"
                                >
                                    Better Auth
                                </a>{" "}
                                library. Coming from NextAuth, it felt like a much more scalable foundation. I bought
                                into the larger idea immediately: an auth system that could become part of the
                                application, not just an OAuth login screen.
                            </p>
                            <p>
                                Building the{" "}
                                <a
                                    href="https://github.com/zpg6/better-auth-cloudflare"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-fg underline decoration-line underline-offset-4 transition-colors hover:text-accent"
                                >
                                    better-auth-cloudflare
                                </a>{" "}
                                plugin connected that with my love for deploying to Cloudflare Workers and using KV, R2,
                                and D1. It filled a void in Cloudflare, which doesn&apos;t have an auth service. When
                                you deploy Better Auth Cloudflare, it feels native to developing with Workers. I
                                especially like using it with Drizzle because it handles my D1 migrations well.
                            </p>
                        </StorySection>

                        <StorySection title="Cloudflare is still missing an auto-scaling database">
                            <p>
                                But there&apos;s a limit. D1 has a 10 gigabyte limit. Besides an auth service,
                                Cloudflare is also missing an auto-scaling database. You can use D1. You can use Durable
                                Objects. Theoretically, you could use KV at a much larger scale, but it makes data
                                harder to query in the ways real apps need. You definitely don&apos;t want to store data
                                in R2 and try to query it at scale.
                            </p>
                            <p>
                                Realistically, you have to use Hyperdrive to bring in a Postgres or MySQL database that
                                you host on AWS or somewhere else. Not only is this expensive, it feels clunky, and the
                                network hops are less than desirable.
                            </p>
                        </StorySection>

                        <StorySection title="Why not use auth to shard organization data?">
                            <p>
                                I came up with the idea to combine my auth with my need for a scalable database and use
                                organization identity as the stable placement key. One organization operation still
                                belongs to one physical Cdb transaction. Range movement can redistribute organizations
                                between Cdbs without changing application keys, but it does not split one
                                organization&apos;s rows across several Cdbs today.
                            </p>
                            <p>
                                Because we&apos;re built on Durable Objects and SQLite, you can run real queries and get
                                live updates through the same organization route. Durable Objects already provide the
                                SQLite transaction and WebSocket primitives that path needs.
                            </p>
                        </StorySection>

                        <StorySection title="Files should be a first-class data type">
                            <p>
                                I think the next big enabler is that Better Auth Cloudflare has already mastered how to
                                map a user and their database records to files stored in R2. I&apos;ve always dreamed of
                                a database that had files as a first-class object, as a column data type.
                            </p>
                            <p>
                                It has always been a pain to store a key and then have to look up the file somewhere
                                else. Can&apos;t I just get it from the database? Can&apos;t the database route that for
                                me? Chardb treats organization-owned files and vectors as first-class schema values. The
                                row keeps an opaque identity while the database handles policy, delivery, and cleanup.
                                It&apos;s 2026. These should feel native.
                            </p>
                        </StorySection>

                        <StorySection title="It has to feel native">
                            <p>
                                The idea is a database that can add physical Cdbs behind stable organization routing.
                                The only remaining question is how to host it. Chardb lives as an extension of Wrangler,
                                Drizzle, and Miniflare, so you can use it within an existing Cloudflare project and test
                                it locally with Miniflare.
                            </p>
                            <p>
                                I&apos;m especially proud of how it extends the Drizzle migration experience. That was a
                                key requirement for me. When you grow something big, already have users, and need to
                                make changes, you need something you can rely on. For me, that has always been Drizzle.
                                <code>chardb migrations generate</code> now inspects the application&apos;s Drizzle and
                                Better Auth definitions twice in fresh processes. It writes an immutable initial
                                snapshot and conservative sequential additive migrations without a second
                                hand-maintained schema. The runner resumes interrupted work, fences old code, and
                                publishes the new epoch only after every shard finishes.
                            </p>
                            <p>
                                This is an experimental database, but the developer experience is something I&apos;ve
                                always dreamed of, and the initial performance measurements are promising. The package
                                is built to run the same way through Wrangler, local Workerd, and real Cloudflare
                                services. I think this could be something special with community contributions.
                            </p>
                        </StorySection>

                        <PullQuote>
                            this is an experimental database, but the developer experience is something I&apos;ve always
                            dreamed of.
                        </PullQuote>

                        <aside className="border-t border-accent/50 pt-8" aria-labelledby="cloudflare-postscript">
                            <h3 id="cloudflare-postscript" className="font-mono text-sm text-accent tracking-tight">
                                P.S. Cloudflare
                            </h3>
                            <p className="mt-4 text-xl sm:text-2xl leading-8 sm:leading-9 text-fg tracking-tight">
                                If you would just release an auto-scaling database that&apos;s as amazing as the rest of
                                your pricing, I would end this now, delete this repo, and you would never hear from me
                                about this again.
                            </p>
                        </aside>
                    </div>
                </div>
            </article>
        </section>
    );
}
