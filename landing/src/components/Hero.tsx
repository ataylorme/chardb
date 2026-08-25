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
                        A real database inside your Worker.
                    </h1>
                    <p
                        className="mt-6 text-fg-muted max-w-2xl"
                        style={{ fontSize: "clamp(16px, 1.4vw, 18px)", lineHeight: 1.6 }}
                    >
                        One binding and one typed query layer for tenant-shaped SQL, auth, files, vectors, and live
                        queries. That is the destination. The organization-scoped SQL and live-query core works today;
                        the rest is an explicit roadmap.
                    </p>

                    <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-4">
                        <a
                            href="#today"
                            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors"
                        >
                            See what works today <span aria-hidden="true">→</span>
                        </a>
                    </div>

                    <p className="mt-8 text-xs text-fg-dim font-mono lowercase">
                        <span>working core</span>
                        <span className="px-2 text-fg-dim/70" aria-hidden="true">
                            ·
                        </span>
                        <span>for Cloudflare Workers</span>
                        <span className="px-2 text-fg-dim/70" aria-hidden="true">
                            ·
                        </span>
                        <span>unfinished product</span>
                    </p>
                </div>

                <div className="lg:col-span-5">
                    <CoalShader />
                </div>
            </div>
        </section>
    );
}
