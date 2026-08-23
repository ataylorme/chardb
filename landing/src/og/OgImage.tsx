import { CoalShader } from "../components/CoalShader";

export function OgImage() {
    return (
        <div className="relative bg-ink-950 text-fg overflow-hidden" style={{ width: 1200, height: 630 }}>
            <div className="absolute inset-0 grid grid-cols-12 gap-10 px-20 py-16 items-center">
                <div className="col-span-8 relative z-10">
                    <div className="flex items-center gap-3 font-mono text-[22px] text-fg-muted lowercase">
                        <span className="text-fg">chardb</span>
                        <span className="text-fg-dim">·</span>
                        <span>chardb.dev</span>
                    </div>

                    <h1
                        className="mt-8 font-sans font-semibold tracking-tight text-fg"
                        style={{ fontSize: 70, lineHeight: 1.05, letterSpacing: "-0.02em" }}
                    >
                        Tenant-sharded SQLite experiments on Cloudflare.
                    </h1>

                    <p className="mt-7 text-fg-muted" style={{ fontSize: 24, lineHeight: 1.5, maxWidth: 640 }}>
                        Tested organization mutations and one-shot snapshots derived from Drizzle. Live delivery and
                        migrations remain unfinished.
                    </p>

                    <div className="mt-10 inline-flex items-center rounded-full border border-line2 bg-ink-850 px-6 py-2.5 font-mono">
                        <span className="text-fg text-[20px]">experimental prototype</span>
                    </div>

                    <div className="mt-12 font-mono text-[16px] text-fg-dim lowercase flex items-center gap-3">
                        <span>source available</span>
                        <span className="text-fg-dim/60">·</span>
                        <span>for Cloudflare Workers</span>
                        <span className="text-fg-dim/60">·</span>
                        <span>Drizzle-native</span>
                    </div>
                </div>

                <div className="col-span-4 relative h-full flex items-center justify-center">
                    <div style={{ width: 380, height: 380 }}>
                        <CoalShader />
                    </div>
                </div>
            </div>

            <div
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none"
                style={{
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04), inset 0 -1px 0 rgba(236,87,19,0.25)",
                }}
            />
        </div>
    );
}
