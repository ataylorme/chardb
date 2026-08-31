import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const read = (name: string): string => readFileSync(path.join(root, name), "utf8");

describe("release documentation contract", () => {
    test("keeps installed-package documentation links resolvable and readiness claims current", () => {
        const packageJson = JSON.parse(read("package.json")) as { files?: string[] };
        const packageEntries = new Set(["package.json", "LICENSE", ...(packageJson.files ?? [])]);
        const packageDocs = [...packageEntries].filter(entry => entry.endsWith(".md"));
        const unresolved: string[] = [];

        const isPackaged = (target: string): boolean =>
            [...packageEntries].some(
                entry => target === entry || (path.posix.extname(entry) === "" && target.startsWith(`${entry}/`))
            );

        for (const document of packageDocs) {
            const source = read(document);
            for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
                const href = match[1];
                if (href === undefined) continue;
                if (/^(?:https?:|mailto:|#)/.test(href)) continue;
                const [targetHref] = href.split("#");
                if (targetHref === undefined) continue;
                const target = path.posix.normalize(path.posix.join(path.posix.dirname(document), targetHref));
                if (!isPackaged(target)) unresolved.push(`${document}: ${href}`);
            }
        }

        const security = read("SECURITY.md");
        const contributing = read("CONTRIBUTING.md");
        for (const source of [security, contributing]) {
            expect(source).toContain("supported Better Auth organization path");
            expect(source).toMatch(
                /backup, restore, failover, regional resilience, long failure runs, automatic resharding/i
            );
            expect(source).toMatch(/Do not (?:use|test) it with production data/);
        }
        expect(security).not.toContain("incomplete end-to-end authentication");
        expect(contributing).not.toContain("isolated components are not mistaken for a working end-to-end system");
        expect(unresolved).toEqual([]);
    });

    test("describes the shipped path without construction history", () => {
        const status = read("STATUS.md");
        const plan = read("PLAN.md");
        const publicDocs = [read("README.md"), status, plan].join("\n");

        for (const capability of ["Better Auth", "Drizzle", "Durable Objects", "R2", "Vectorize", "Miniflare"]) {
            expect(publicDocs).toContain(capability);
        }
        for (const limit of ["backup", "restore", "regional failover", "automatic resharding"]) {
            expect(publicDocs.toLowerCase()).toContain(limit);
        }
        expect(publicDocs).not.toMatch(/Candidate\d+|exact-candidate|construction diary/i);
        expect(publicDocs).not.toContain("github.com/zpg6/chardb/blob/main");
        expect(plan).toContain("Every release is built once and tested as the artifact users install");
        expect(plan).toContain("same paired `@chardb/core` and `@chardb/react` tarballs");
        expect(status).toContain("plus `@chardb/react`");
        expect(status).not.toContain("`/react`");
        expect(publicDocs).toContain("| `chardb-client` | Native Rust client");
        expect(publicDocs).not.toContain("The preview binary ships");
        expect(publicDocs).not.toContain("Scheduled requests no longer create PITR barriers");
    });

    test("keeps the production warning as prose rather than a closable gate", () => {
        const status = read("STATUS.md");

        expect(status).toMatch(/Do not use Chardb as the only home for production data yet/i);
        expect(status).not.toMatch(/- \[[ x]\].*production warning/i);
    });

    test("keeps Better Auth permissions and Chardb row policy separate", () => {
        const readme = read("README.md");

        expect(readme).toContain("The `roles` block is Chardb's policy for domain rows");
        expect(readme).toContain("It does not add roles or permissions to Better Auth's organization or admin plugins");
        expect(readme).toContain("manage their roles through Better Auth");
    });

    test("documents the configured React client instead of raw transport wiring", () => {
        const readme = read("README.md");
        const reactReadme = read("packages/react/README.md");
        const ownership = read("docs/ownership.mdx");
        const fileDocs = read("docs/files.mdx");
        const chatRecipe = read("docs/cookbook/chat-app.mdx");

        for (const source of [readme, reactReadme]) {
            expect(source).toContain("createChardbReactClient({");
            expect(source).toContain("auth: ({ baseURL }) =>");
            expect(source).not.toContain('from "@chardb/core/react"');
        }
        expect(readme).toContain("db.useQuery(listMessages, { limit: 50 })");
        expect(readme).not.toContain("const chardbEndpoint");
        expect(readme).not.toContain("<ChardbProvider");
        expect(reactReadme).toContain("const workerUrl = new URL(window.location.origin).origin");
        expect(reactReadme).not.toContain("PUBLIC_CHARD_DB_URL");
        expect(ownership).toContain("configured `@chardb/react` client reads the active organization");
        expect(ownership).not.toContain("The caller supplies `organizationId`");
        for (const source of [fileDocs, chatRecipe]) {
            expect(source).not.toMatch(/attachment\.(?:upload|downloadUrl)\(\{\s*organizationId/);
        }
    });

    test("runs package consumers on Linux, macOS, and Windows", () => {
        const workflow = read(".github/workflows/ci.yml");

        expect(workflow).toContain("ubuntu-latest");
        expect(workflow).toContain("macos-latest");
        expect(workflow).toContain("windows-latest");
        expect(workflow).toContain("smoke-packed-package.mjs");
        expect(workflow).toContain("smoke-packed-chat.mjs");
        expect(workflow).toContain("os-ci-evidence");
    });

    test("surfaces the shipped React and Rust clients", () => {
        const navigation = read("docs/docs.json");
        const clients = read("docs/clients.mdx");

        expect(navigation).toContain('"group": "Clients"');
        expect(navigation).toContain('"pages": ["clients"]');
        expect(clients).toContain("@chardb/react");
        expect(clients).toContain("chardb-client");
        expect(clients).toContain("blocking and runtime-neutral async APIs");
        expect(clients).toContain("does not implement files, vectors, `workers-rs`, or `wasm32` transport");
    });

    test("publishes an honest cost boundary without converting latency into billable compute", () => {
        const cost = read("COST.md");
        const readme = read("README.md");
        const status = read("STATUS.md");
        const plan = read("PLAN.md");
        const nextScope = read("NEXT_SCOPE.md");
        const packageJson = JSON.parse(read("package.json")) as { files?: string[] };
        const releaseDocs = [cost, readme, status, plan, nextScope].join("\n");

        expect(packageJson.files).toContain("COST.md");
        expect(readme).toContain("[COST.md](COST.md) maps Chardb operations to Cloudflare's published meters");
        expect(status).toMatch(/cost.*unmeasured|unmeasured.*cost/i);
        expect(plan).toContain("File, vector, and range-movement proofs");
        expect(plan).toContain("disposable Cloudflare resources");
        expect(nextScope).toContain("Do not build a calculator or infer billable compute from latency");
        expect(cost).toContain("End-to-end latency cannot be converted into Worker CPU time or Durable Object GB-s");
        expect(cost).toContain("Chardb does not publish a total monthly-cost claim");
        expect(cost).toContain("https://developers.cloudflare.com/workers/platform/pricing/");
        expect(cost).toContain("https://developers.cloudflare.com/durable-objects/platform/pricing/");
        expect(cost).toContain("https://developers.cloudflare.com/r2/pricing/");
        expect(cost).toContain("https://developers.cloudflare.com/vectorize/platform/pricing/");

        expect(releaseDocs).not.toMatch(/latency (?:is|equals|measures|represents) (?:Worker )?CPU/i);
        expect(releaseDocs).not.toMatch(/latency (?:is|equals|measures|represents) Durable Object (?:duration|GB-s)/i);
        expect(releaseDocs).not.toMatch(/(?:calculate|derive|estimate) (?:Worker )?CPU[^.\n]{0,80}from latency/i);
        expect(releaseDocs).not.toMatch(
            /(?:calculate|derive|estimate) (?:Worker )?CPU[^.\n]{0,80}(?:using|based on) latency/i
        );
        expect(releaseDocs).not.toMatch(
            /(?:calculate|derive|estimate) Durable Object (?:duration|GB-s)[^.\n]{0,80}from latency/i
        );
        expect(releaseDocs).not.toMatch(
            /(?:calculate|derive|estimate) Durable Object (?:duration|GB-s)[^.\n]{0,80}(?:using|based on) latency/i
        );
    });
});
