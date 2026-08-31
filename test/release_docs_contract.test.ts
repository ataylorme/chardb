import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
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
            [...packageEntries].some(entry => {
                const absolute = path.join(root, entry);
                return statSync(absolute).isDirectory() ? target.startsWith(`${entry}/`) : target === entry;
            });

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

    test("records the exact-candidate deployed proofs and keeps benchmark language descriptive", () => {
        const status = read("STATUS.md");
        const plan = read("PLAN.md");
        const readme = read("README.md");
        const operations = read("OPERATIONS.md");
        const preview = read("PREVIEW.md");

        expect(status).not.toMatch(/Candidate\d+/);
        expect(status).toContain("The exact-candidate proof harness verifies live invalidation");
        expect(status).toContain("The exact-candidate combined harness exercises response loss");
        expect(status).toContain("Local fake services isolate Chardb execution time");
        expect(status).not.toContain("Local fake services isolate Chardb cost");
        expect(plan).toContain("- [x] One exact packed proof candidate passes the deployed Worker and R2 file proof");
        expect(readme).not.toMatch(/Candidate\d+/);
        expect(readme).toContain("Every release starts from one packed npm tarball");
        expect(readme).toContain("the Linux, macOS, and Windows CI matrix");
        expect(readme).not.toMatch(/bun run (?:test:correctness|preview:gate|proof:cloudflare|release:admit)/);
        expect(readme).not.toContain("github.com/zpg6/chardb/blob/main");
        expect(operations).not.toMatch(/Candidate\d+/);
        expect(operations).toContain("Release evidence must include the combined row, file, and vector movement proof");
        expect(operations).toContain("not automatic resharding, a merge or rebalance service");
        expect(preview).toContain("R2 file lifecycle, organization deletion fencing");
        expect(preview).toContain("deployed combined row, file, and vector movement");
    });

    test("records explicit internal bindings and activation-only live wake", () => {
        const status = read("STATUS.md");
        const plan = read("PLAN.md");
        const preview = read("PREVIEW.md");
        const architecture = read("ARCHITECTURE.md");
        const operations = read("OPERATIONS.md");

        expect(status).toContain("schema activation, or source cutover");
        expect(plan).toContain("- [x] Schema activation without a domain write wakes every idle live registration");
        expect(preview).toContain("The serialized Workerd migration harness supplies a separate correctness proof");
        expect(preview).toContain("does not replace the deployed Cloudflare gates");
        expect(architecture).toContain("Explicit bindings are the primary Durable Object path");
        expect(architecture).toContain("queues every active registration in one transaction");
        expect(operations).toContain("`CDB_GATEWAY`, `CDB_CATALOG`, `CDB_SHARD`, and `CDB_RESHARD`");
        expect(operations).toContain(
            "A runtime-provided loopback fallback does not repair a missing or wrong generated binding"
        );
    });

    test("keeps the production warning as prose rather than a closable gate", () => {
        const plan = read("PLAN.md");

        expect(plan).toContain("The production warning is a standing release invariant");
        expect(plan).not.toContain("- [ ] Keep the production warning");
        expect(plan).not.toContain("- [x] Keep the production warning");
    });

    test("keeps Better Auth permissions and Chardb row policy separate", () => {
        const readme = read("README.md");

        expect(readme).toContain("The `roles` block is Chardb's policy for domain rows");
        expect(readme).toContain("It does not add roles or permissions to Better Auth's organization or admin plugins");
        expect(readme).toContain("manage their roles through Better Auth");
    });

    test("requires one bound cross-OS GitHub bundle", () => {
        const preview = read("PREVIEW.md");
        const readme = read("README.md");
        const status = read("STATUS.md");
        const plan = read("PLAN.md");

        expect(preview).toContain(
            "The OS input must contain canonical Ubuntu x64, macOS arm64, and Windows x64 reports"
        );
        expect(preview).toContain("Admission requires that bundle; it cannot be omitted");
        expect(preview).toContain("Do not substitute a local report");
        expect(preview).toContain("it is not a GitHub signature");
        expect(readme).toContain("the Linux, macOS, and Windows CI matrix");
        expect(status).toContain("checksummed Ubuntu x64, macOS arm64, and Windows x64 reports");
        expect(plan).toContain("and `os-ci` evidence");
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
        expect(status).toContain("A total cost remains unmeasured");
        expect(plan).toContain("Publish the Cloudflare meter and operation mapping in [COST.md](COST.md)");
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
