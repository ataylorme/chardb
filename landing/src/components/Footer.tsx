import { GITHUB_URL } from "../lib/constants";

export function Footer() {
    return (
        <footer className="border-t border-line">
            <div className="mx-auto max-w-page px-5 sm:px-8 py-8 text-xs text-fg-dim font-mono lowercase flex flex-wrap gap-x-3 gap-y-2 items-center">
                <span className="text-fg-muted">chardb</span>
                <span aria-hidden="true">·</span>
                <span>MIT</span>
                <span aria-hidden="true">·</span>
                <a href={GITHUB_URL} rel="noopener" className="hover:text-fg transition-colors">
                    GitHub
                </a>
                <span aria-hidden="true">·</span>
                <span>experimental prototype</span>
            </div>
        </footer>
    );
}
