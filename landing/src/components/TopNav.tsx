import { useEffect, useState } from "react";
import { GITHUB_URL } from "../lib/constants";

const SECTIONS = ["binding", "scale", "tenancy", "auth", "files"] as const;

export function TopNav() {
    const [scrolled, setScrolled] = useState(false);
    const [active, setActive] = useState<string | null>(null);

    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 4);
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    useEffect(() => {
        if (!("IntersectionObserver" in window)) return;
        const els = SECTIONS.map(id => document.getElementById(id)).filter((e): e is HTMLElement => Boolean(e));
        if (!els.length) return;
        const io = new IntersectionObserver(
            entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) setActive(e.target.id);
                });
            },
            { rootMargin: "-40% 0px -55% 0px", threshold: 0 }
        );
        els.forEach(el => io.observe(el));
        return () => io.disconnect();
    }, []);

    return (
        <header id="topnav" className={`sticky top-0 z-40 border-b border-transparent${scrolled ? " scrolled" : ""}`}>
            <div className="mx-auto max-w-page px-5 sm:px-8 h-14 flex items-center justify-between">
                <a
                    href="#top"
                    className="font-mono text-[19px] sm:text-[20px] font-medium tracking-tight text-fg lowercase"
                    aria-label="chardb home"
                >
                    chardb
                </a>

                <nav aria-label="Primary" className="flex items-center gap-6">
                    <ul className="hidden md:flex items-center gap-6 text-sm text-fg-muted">
                        {SECTIONS.map(id => (
                            <li key={id}>
                                <a
                                    href={`#${id}`}
                                    className="nav-link hover:text-fg transition-colors capitalize"
                                    data-active={active === id ? "true" : undefined}
                                >
                                    {id}
                                </a>
                            </li>
                        ))}
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
