import { BulletList, PullQuote, SectionHeading, SectionLead } from "../Section";

export function Scale() {
    return (
        <section id="scale" className="border-t border-line">
            <div className="mx-auto max-w-page px-5 sm:px-8 py-16 lg:py-28 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-start">
                <div className="lg:col-span-7">
                    <p className="eyebrow">
                        <span className="num">02</span> / scale
                    </p>
                    <SectionHeading>Separate tenant placement from physical shards.</SectionHeading>
                    <SectionLead>
                        Organization keys map deterministically into 16,384 virtual shards, and Catalog stores the
                        current physical range map. Split, copy, tail, and phase logic are tested in isolation;
                        automatic end-to-end resharding and recovery are not.
                    </SectionLead>
                    <BulletList
                        items={[
                            "16,384 virtual shards with deterministic organization routing",
                            "Catalog stores current physical range ownership",
                            "reshard copy, tail, and phase logic are isolated, not an automated production path",
                        ]}
                    />
                    <PullQuote>routing is implemented. live resharding is not.</PullQuote>
                </div>

                <div className="lg:col-span-5">
                    <div className="rounded-xl border border-line bg-ink-850 p-6">
                        <svg
                            viewBox="0 0 360 240"
                            role="img"
                            aria-label="16,384 vshards range-routed across physical shards"
                            className="w-full h-auto"
                        >
                            <defs>
                                <linearGradient id="vshardRamp" x1="0" x2="1" y1="0" y2="0">
                                    <stop offset="0" stopColor="#EC5713" stopOpacity="0.10" />
                                    <stop offset="0.5" stopColor="#EC5713" stopOpacity="0.55" />
                                    <stop offset="1" stopColor="#EC5713" stopOpacity="0.10" />
                                </linearGradient>
                            </defs>

                            <text x="20" y="36" fontFamily="JetBrains Mono, monospace" fontSize="10" fill="#5A5A5A">
                                0
                            </text>
                            <text
                                x="340"
                                y="36"
                                textAnchor="end"
                                fontFamily="JetBrains Mono, monospace"
                                fontSize="10"
                                fill="#5A5A5A"
                            >
                                16,383
                            </text>
                            <rect
                                x="20"
                                y="44"
                                width="320"
                                height="14"
                                rx="3"
                                fill="url(#vshardRamp)"
                                stroke="#EC5713"
                                strokeOpacity="0.45"
                                strokeWidth="1"
                            />
                            <g stroke="rgba(255,255,255,0.18)" strokeWidth="1">
                                <line x1="78" y1="44" x2="78" y2="58" />
                                <line x1="142" y1="44" x2="142" y2="58" />
                                <line x1="172" y1="44" x2="172" y2="58" />
                                <line x1="232" y1="44" x2="232" y2="58" />
                                <line x1="262" y1="44" x2="262" y2="58" />
                                <line x1="298" y1="44" x2="298" y2="58" />
                            </g>
                            <text
                                x="180"
                                y="78"
                                textAnchor="middle"
                                fontFamily="JetBrains Mono, monospace"
                                fontSize="10"
                                fill="#9A9A9A"
                            >
                                16,384 vshards · range-routed
                            </text>

                            <g stroke="rgba(255,255,255,0.12)" strokeWidth="1" fill="none">
                                <path d="M50  58  C 50  100, 70  120, 70  150" />
                                <path d="M110 58  C 110 100, 70  120, 70  150" />
                                <path d="M155 58  C 155 100, 150 120, 150 150" />
                                <path d="M200 58  C 200 100, 150 120, 150 150" />
                                <path d="M245 58  C 245 100, 230 120, 230 150" />
                                <path d="M280 58  C 280 100, 230 120, 230 150" />
                                <path d="M315 58  C 315 100, 310 120, 310 150" />
                            </g>

                            <g fill="none" stroke="#EC5713" strokeOpacity="0.85" strokeWidth="1">
                                <rect x="38" y="150" width="64" height="36" rx="4" />
                                <rect x="118" y="150" width="64" height="36" rx="4" />
                                <rect x="198" y="150" width="64" height="36" rx="4" />
                                <rect x="278" y="150" width="64" height="36" rx="4" />
                            </g>
                            <g fontFamily="JetBrains Mono, monospace" fontSize="9" fill="#9A9A9A" textAnchor="middle">
                                <text x="70" y="172">
                                    shard
                                </text>
                                <text x="150" y="172">
                                    shard
                                </text>
                                <text x="230" y="172">
                                    shard
                                </text>
                                <text x="310" y="172">
                                    shard
                                </text>
                            </g>
                            <text
                                x="180"
                                y="212"
                                textAnchor="middle"
                                fontFamily="JetBrains Mono, monospace"
                                fontSize="10"
                                fill="#5A5A5A"
                            >
                                design target: split a range and move ownership
                            </text>
                        </svg>
                    </div>
                </div>
            </div>
        </section>
    );
}
