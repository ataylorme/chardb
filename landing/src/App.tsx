import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { ProductOverview } from "./components/ProductOverview";
import { TopNav } from "./components/TopNav";

export function App() {
    return (
        <>
            <a
                href="#main"
                className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-ink-800 focus:text-fg focus:px-3 focus:py-2 focus:rounded"
            >
                Skip to content
            </a>

            <TopNav />

            <main id="main">
                <Hero />
                <ProductOverview />
            </main>

            <Footer />
        </>
    );
}
