import { GITHUB_URL } from "../lib/constants";

type TopNavProps = {
    homeHref?: string;
    storyActive?: boolean;
};

export function TopNav({ homeHref = "#top", storyActive = false }: TopNavProps) {
    return (
        <header id="topnav" className="sticky top-0 z-40 border-b border-line bg-ink-950/80 backdrop-blur">
            <div className="mx-auto max-w-page px-5 sm:px-8 h-14 flex items-center justify-between">
                <a
                    href={homeHref}
                    className="font-mono text-[19px] sm:text-[20px] font-medium tracking-tight text-fg lowercase"
                    aria-label="chardb home"
                >
                    chardb
                </a>

                <nav aria-label="Primary" className="flex items-center gap-5">
                    <ul className="flex items-center gap-4 text-xs text-fg-muted sm:gap-5 sm:text-sm">
                        <li>
                            <a
                                href="/why/"
                                className="nav-link hover:text-fg transition-colors"
                                data-active={storyActive ? "true" : undefined}
                            >
                                why
                            </a>
                        </li>
                        <li>
                            <span className="text-fg-dim" aria-label="Documentation coming soon">
                                docs soon
                            </span>
                        </li>
                    </ul>
                    <a
                        href={GITHUB_URL}
                        rel="noopener"
                        className="text-sm text-fg hover:text-accent transition-colors inline-flex items-center gap-1"
                    >
                        GitHub <span aria-hidden="true">→</span>
                    </a>
                </nav>
            </div>
        </header>
    );
}
