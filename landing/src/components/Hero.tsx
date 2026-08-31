import { CloudflareWorkersMark } from "./CloudflareWorkersMark";
import { CoalShader } from "./CoalShader";
import { CopyPill } from "./CopyPill";

export function Hero() {
    return (
        <section id="top" className="relative">
            <div className="mx-auto max-w-page px-5 sm:px-8 pt-16 sm:pt-24 lg:pt-32 pb-20 lg:pb-28 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
                <div className="lg:col-span-7">
                    <h1
                        className="font-sans font-semibold tracking-tight text-fg"
                        style={{ fontSize: "clamp(40px, 6vw, 72px)", lineHeight: 1.05, letterSpacing: "-0.02em" }}
                    >
                        A real database inside your
                        <span className="worker-lockup">
                            <span className="worker-mark">
                                <CloudflareWorkersMark />
                            </span>
                            <span>
                                <span className="worker-cloudflare">Cloudflare</span> Worker.
                            </span>
                        </span>
                    </h1>
                    <p
                        className="mt-6 text-fg-muted max-w-2xl"
                        style={{ fontSize: "clamp(16px, 1.4vw, 18px)", lineHeight: 1.6 }}
                    >
                        Organization-sharded SQL, live queries, files, and vectors. One Drizzle schema. One Cloudflare
                        Worker binding.
                    </p>

                    <div className="mt-8 max-w-full overflow-x-auto pb-2">
                        <CopyPill />
                    </div>

                    <div className="mt-6 flex flex-col sm:flex-row sm:items-center gap-4">
                        <a
                            href="/why/"
                            className="inline-flex items-center gap-1 text-sm text-fg hover:text-accent transition-colors"
                        >
                            Why I built Chardb <span aria-hidden="true">→</span>
                        </a>
                        <a
                            href="#files"
                            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors"
                        >
                            See the project <span aria-hidden="true">→</span>
                        </a>
                    </div>

                    <p className="mt-8 text-xs text-fg-dim font-mono lowercase">
                        <span>Wrangler + Miniflare</span>
                        <span className="px-2 text-fg-dim/70" aria-hidden="true">
                            ·
                        </span>
                        <span>Drizzle + Better Auth</span>
                        <span className="px-2 text-fg-dim/70" aria-hidden="true">
                            ·
                        </span>
                        <span>MIT licensed</span>
                    </p>
                </div>

                <div className="lg:col-span-5">
                    <CoalShader />
                </div>
            </div>
        </section>
    );
}
