import { Footer } from "./components/Footer";
import { TopNav } from "./components/TopNav";
import { Why } from "./components/sections/Why";

export function WhyPage() {
    return (
        <>
            <a
                href="#main"
                className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-ink-800 focus:text-fg focus:px-3 focus:py-2 focus:rounded"
            >
                Skip to article
            </a>

            <TopNav homeHref="/" storyActive />

            <main id="main">
                <Why />
            </main>

            <Footer />
        </>
    );
}
