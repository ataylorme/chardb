import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const read = (relativePath: string): string => readFileSync(path.join(root, relativePath), "utf8");

describe("founder story landing contract", () => {
    test("ships the story as a separate article page", () => {
        const app = read("landing/src/App.tsx");
        const hero = read("landing/src/components/Hero.tsx");
        const constants = read("landing/src/lib/constants.ts");
        const vite = read("landing/vite.config.ts");
        const articlePage = read("landing/why/index.html");

        expect(app).not.toContain("<Why");
        expect(hero).toContain('href="/why/"');
        expect(hero).toContain("<CopyPill />");
        expect(constants).toContain("bunx @chardb/core init my-chardb-app");
        expect(constants).not.toContain("mkdir");
        expect(constants).not.toContain("cd my-chardb-app");
        expect(constants).not.toContain("git clone");
        expect(vite).toContain('why: resolve(import.meta.dirname, "why/index.html")');
        expect(articlePage).toContain('<meta property="og:type" content="article" />');
        expect(articlePage).toContain('<link rel="canonical" href="https://chardb.dev/why/" />');
        expect(articlePage).toContain('src="/src/why-main.tsx"');
    });

    test("ends with the direct Cloudflare postscript and states the design plainly", () => {
        const story = read("landing/src/components/sections/Why.tsx");

        expect(story).toContain("P.S. Cloudflare");
        expect(story).toContain("I would end this now, delete this repo");
        expect(story).toContain("organization-owned files and vectors as first-class schema values");
        expect(story).toContain("chardb migrations generate");
        expect(story).toContain("conservative sequential additive migrations");
        expect(story).toContain(
            "does not split one\n                                organization&apos;s rows across several Cdbs today"
        );
        expect(story).toContain("built to run the same way through Wrangler, local Workerd, and real Cloudflare");
    });

    test("keeps the homepage compact and grounded in the generated project", () => {
        const app = read("landing/src/App.tsx");
        const overview = read("landing/src/components/ProductOverview.tsx");
        const sdkStrip = read("landing/src/components/SdkStrip.tsx");
        const footer = read("landing/src/components/Footer.tsx");

        expect(app).toContain("<ProductOverview />");
        expect(app).toContain("<SdkStrip />");
        for (const oldSection of ["Today", "Binding", "Scale", "Tenancy", "Auth", "Files", "License", "Closing"]) {
            expect(app).not.toContain(`<${oldSection} />`);
        }
        expect(overview).toContain("src/database.ts");
        expect(overview).toContain("src/App.tsx");
        expect(overview).not.toContain("worker.ts");
        expect(overview).not.toContain("wrangler.toml");
        expect(overview).toContain("Set up your Worker. Use it like an app SDK.");
        expect(overview).toContain("defineAuth");
        expect(overview).toContain("cdbTable");
        expect(overview).toContain("createChardbReactClient");
        expect(overview).toContain("useIdentity");
        expect(overview).toContain("useQuery");
        expect(overview).toContain("// Better Auth config");
        expect(overview).toContain("// Drizzle + Better Auth ownership");
        expect(overview).toContain('className="syntax-property">signIn</span>');
        expect(overview).toContain("db.auth.signOut");
        expect(overview).toContain("/brands/file-react-ts.svg");
        expect(overview).toContain("/brands/file-rust.svg");
        expect(overview).toContain("LIST_MESSAGES");
        expect(overview).not.toContain('"src/queries.ts#listMessages"');
        for (const sdk of ["React", "Rust", "Python", "Swift", "Flutter", "Expo"]) {
            expect(overview).toContain(`name: "${sdk}"`);
        }
        expect(overview).toContain("Better Auth JWT");
        expect(overview).toContain("syntax-punctuation");
        expect(overview).toContain('label: "Realtime"');
        expect(overview).not.toContain('label: "SQL + live"');
        expect(overview).toContain("File columns route to R2. Vector columns route to Vectorize.");
        expect(overview).toContain("Miniflare and Cloudflare's Vitest integration run it locally.");
        expect(overview).toContain("Docs soon");
        for (const available of ["React", "Rust"]) {
            expect(sdkStrip).toContain(
                `name: "${available}", icon: "/brands/${available.toLowerCase()}.svg", available: true`
            );
        }
        for (const comingSoon of ["Python", "Swift", "Flutter", "Expo"]) {
            expect(sdkStrip).toContain(`name: "${comingSoon}"`);
            expect(sdkStrip).toContain(`icon: "/brands/${comingSoon.toLowerCase()}.svg"`);
        }
        expect(footer).toContain("infrastructure billed by Cloudflare · no Chardb service fee");
    });
});
