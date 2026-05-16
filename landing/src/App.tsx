import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { TopNav } from "./components/TopNav";
import { Auth } from "./components/sections/Auth";
import { Binding } from "./components/sections/Binding";
import { Closing } from "./components/sections/Closing";
import { Files } from "./components/sections/Files";
import { License } from "./components/sections/License";
import { Scale } from "./components/sections/Scale";
import { Tenancy } from "./components/sections/Tenancy";

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
                <Binding />
                <Scale />
                <Tenancy />
                <Auth />
                <Files />
                <License />
                <Closing />
            </main>

            <Footer />
        </>
    );
}
