import { GITHUB_URL } from "../lib/constants";
import { CoalShader } from "./CoalShader";

export function Hero() {
    return (
        <section id="top" className="relative">
            <div className="mx-auto max-w-page px-5 sm:px-8 pt-16 sm:pt-24 lg:pt-32 pb-20 lg:pb-28 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
                <div className="lg:col-span-7">
                    <h1
                        className="font-sans font-semibold tracking-tight text-fg"
                        style={{ fontSize: "clamp(40px, 6vw, 72px)", lineHeight: 1.05, letterSpacing: "-0.02em" }}
                    >
                        A database experiment for tenant-shaped apps.
                    </h1>
                    <p
                        className="mt-6 text-fg-muted max-w-2xl"
                        style={{ fontSize: "clamp(16px, 1.4vw, 18px)", lineHeight: 1.6 }}
                    >
                        Declare an organization boundary in Drizzle. Declared organization mutations now cross verified
                        identity, Catalog membership, tenant routing, policy enforcement, and one shard-local
                        transaction. Public queries, live results, and migrations are not connected yet.
                    </p>

                    <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-4">
                        <a
                            href={GITHUB_URL}
                            rel="noopener"
                            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors"
                        >
                            Read the code and current plan <span aria-hidden="true">→</span>
                        </a>
                    </div>

                    <p className="mt-8 text-xs text-fg-dim font-mono lowercase">
                        <span>experimental</span>
                        <span className="px-2 text-fg-dim/70" aria-hidden="true">
                            ·
                        </span>
                        <span>for Cloudflare Workers</span>
                        <span className="px-2 text-fg-dim/70" aria-hidden="true">
                            ·
                        </span>
                        <span>Drizzle-native</span>
                    </p>
                </div>

                <div className="lg:col-span-5">
                    <CoalShader />
                </div>
            </div>
        </section>
    );
}
