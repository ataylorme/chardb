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
        const footer = read("landing/src/components/Footer.tsx");

        expect(app).toContain("<ProductOverview />");
        for (const oldSection of ["Today", "Binding", "Scale", "Tenancy", "Auth", "Files", "License", "Closing"]) {
            expect(app).not.toContain(`<${oldSection} />`);
        }
        for (const filename of ["schema.ts", "auth.ts", "worker.ts", "wrangler.toml"]) {
            expect(overview).toContain(filename);
        }
        expect(overview).toContain("The organization is the shard key.");
        expect(overview).toContain("File columns route to R2. Vector columns route to Vectorize.");
        expect(overview).toContain("Miniflare and Cloudflare's Vitest integration run it locally.");
        expect(overview).toContain("Docs soon");
        expect(footer).toContain("infrastructure billed by Cloudflare · no Chardb service fee");
    });
});
