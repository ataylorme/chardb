import { describe, expect, test } from "bun:test";
import { runVectorizePrepare } from "../../src/cli/commands/vectorize.ts";
import type { CliCommandInvocation, CliCommandResult, CliContext } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";
import { renderWranglerJsonc } from "../../src/cli/wrangler_template.ts";

const WRANGLER_MODULE = "/project/node_modules/wrangler/bin/wrangler.js";
const NODE_RUNTIME = Bun.which("node");
if (!NODE_RUNTIME) throw new Error("test requires Node.js on PATH");

function project(input: {
    readonly toml?: string;
    readonly json?: string;
    readonly jsonc?: string;
    readonly responses?: readonly CliCommandResult[];
}) {
    const files = new Map<string, string>();
    if (input.toml !== undefined) files.set("/project/wrangler.toml", input.toml);
    if (input.json !== undefined) files.set("/project/wrangler.json", input.json);
    if (input.jsonc !== undefined) files.set("/project/wrangler.jsonc", input.jsonc);
    files.set(WRANGLER_MODULE, "executable");
    const calls: CliCommandInvocation[] = [];
    const responses = [...(input.responses ?? [])];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CliContext = {
        cwd: "/project",
        env: {},
        stdout: value => stdout.push(value),
        stderr: value => stderr.push(value),
        read: async path => {
            const value = files.get(path);
            if (value === undefined) throw new Error(`missing ${path}`);
            return value;
        },
        write: async () => {},
        exists: async path => files.has(path),
        runCommand: async invocation => {
            calls.push(invocation);
            const response = responses.shift();
            if (!response) throw new Error("unexpected Wrangler call");
            return response;
        },
    };
    return { ctx, calls, stdout, stderr };
}

function result(value: unknown, exitCode = 0): CliCommandResult {
    return { exitCode, stdout: JSON.stringify(value), stderr: "" };
}

function toml(
    ...entries: readonly { readonly binding: string; readonly index: string; readonly remote?: boolean | "missing" }[]
): string {
    return entries
        .map(
            entry =>
                `[[vectorize]]\nbinding = ${JSON.stringify(entry.binding)}\nindex_name = ${JSON.stringify(entry.index)}${entry.remote === "missing" ? "" : `\nremote = ${entry.remote ?? true}`}`
        )
        .join("\n\n");
}

function jsonc(
    ...entries: readonly { readonly binding: string; readonly index: string; readonly remote?: boolean | "missing" }[]
): string {
    const config = JSON.parse(
        renderWranglerJsonc({ name: "vectors", compatibilityDate: "2026-05-10", assetsDir: "public" })
    );
    config.vectorize = entries.map(entry => ({
        binding: entry.binding,
        index_name: entry.index,
        ...(entry.remote === "missing" ? {} : { remote: entry.remote ?? true }),
    }));
    return `// JSONC remains supported\n${JSON.stringify(config, null, 2)}`;
}

describe("chardb vectorize prepare", () => {
    test("prefers TOML, deduplicates configured index names, and accepts exact ready state", async () => {
        const fixture = project({
            toml: toml(
                { binding: "VECTORS_A", index: "shared-index" },
                { binding: "VECTORS_B", index: "shared-index" }
            ),
            jsonc: jsonc({ binding: "IGNORED", index: "ignored-index" }),
            responses: [result([{ propertyName: "cdb_resource", indexType: "String" }])],
        });

        await runVectorizePrepare(fixture.ctx);

        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]).toEqual({
            executable: NODE_RUNTIME,
            cwd: "/project",
            timeoutMs: 30_000,
            maxOutputBytes: 64 * 1_024,
            args: [
                WRANGLER_MODULE,
                "vectorize",
                "list-metadata-index",
                "shared-index",
                "--json",
                "--config",
                "/project/wrangler.toml",
            ],
        });
        expect(fixture.stdout.join("")).toContain('"shared-index" already has cdb_resource:string');
    });

    test("reads JSONC, creates a missing index once, and polls until exact readiness", async () => {
        const sleeps: number[] = [];
        const fixture = project({
            jsonc: jsonc({ binding: "VECTORS", index: "messages-index" }),
            responses: [
                result([]),
                { exitCode: 0, stdout: "created", stderr: "" },
                result([]),
                result({ metadataIndexes: [{ property_name: "cdb_resource", type: "string" }] }),
            ],
        });

        await runVectorizePrepare(fixture.ctx, {
            pollAttempts: 3,
            pollIntervalMs: 7,
            sleep: async milliseconds => {
                sleeps.push(milliseconds);
            },
        });

        expect(fixture.calls.map(call => call.args[2])).toEqual([
            "list-metadata-index",
            "create-metadata-index",
            "list-metadata-index",
            "list-metadata-index",
        ]);
        expect(fixture.calls[1]?.args).toContain("--propertyName");
        expect(fixture.calls[1]?.args).toContain("--type");
        expect(fixture.calls.every(call => call.args.at(-1) === "/project/wrangler.jsonc")).toBe(true);
        expect(sleeps).toEqual([7]);
        expect(fixture.stdout.join("")).toContain('"messages-index" created cdb_resource:string');
    });

    test("preflights every index before mutation and rejects a wrong-type conflict", async () => {
        const fixture = project({
            toml: toml({ binding: "VECTORS_A", index: "a-index" }, { binding: "VECTORS_B", index: "b-index" }),
            responses: [result([]), result([{ propertyName: "cdb_resource", indexType: "Number" }])],
        });

        await expect(runVectorizePrepare(fixture.ctx)).rejects.toThrow(/has type "number"; expected "string"/);
        expect(fixture.calls.map(call => call.args[2])).toEqual(["list-metadata-index", "list-metadata-index"]);
    });

    test("fails closed on malformed remote state", async () => {
        for (const malformed of [
            { metadataIndexes: "pending" },
            [{ propertyName: "cdb_resource" }],
            [{ propertyName: "cdb_resource", type: "string", indexType: "Number" }],
            [{ propertyName: "cdb_resource", property_name: "other", type: "string" }],
        ]) {
            const fixture = project({
                toml: toml({ binding: "VECTORS", index: "messages-index" }),
                responses: [result(malformed)],
            });
            await expect(runVectorizePrepare(fixture.ctx)).rejects.toThrow();
            expect(fixture.calls).toHaveLength(1);
        }
    });

    test("stops after the bounded pending-readiness budget", async () => {
        const fixture = project({
            toml: toml({ binding: "VECTORS", index: "messages-index" }),
            responses: [result([]), { exitCode: 0, stdout: "created", stderr: "" }, result([]), result([])],
        });

        await expect(
            runVectorizePrepare(fixture.ctx, { pollAttempts: 2, pollIntervalMs: 0, sleep: async () => {} })
        ).rejects.toThrow(/after 2 readiness checks/);
        expect(fixture.calls).toHaveLength(4);
    });

    test("accepts a concurrent or previously pending creation only after exact readiness", async () => {
        const fixture = project({
            toml: toml({ binding: "VECTORS", index: "messages-index" }),
            responses: [
                result([]),
                { exitCode: 1, stdout: "", stderr: "already pending" },
                result([]),
                result([{ propertyName: "cdb_resource", type: "string" }]),
            ],
        });

        await runVectorizePrepare(fixture.ctx, {
            pollAttempts: 2,
            pollIntervalMs: 0,
            sleep: async () => {},
        });

        expect(fixture.stdout.join("")).toContain('"messages-index" confirmed cdb_resource:string');
        expect(fixture.stderr.join("")).not.toContain("already pending");
    });

    test("publishes a bounded actionable Wrangler tail while redacting credentials", async () => {
        const accountId = "0123456789abcdef0123456789abcdef";
        const token = "A_very_long_cloudflare_token_that_must_not_escape_123456789";
        const apiKey = "short-cloudflare-key";
        const clientSecret = "short-client-secret";
        const fixture = project({
            toml: toml({ binding: "VECTORS", index: "messages-index" }),
            responses: [
                {
                    exitCode: 23,
                    stdout: `${"x".repeat(8_192)}\nrequest account ${accountId}`,
                    stderr: `{"authorization":"Bearer ${token}"}\nCLOUDFLARE_API_KEY=${apiKey}\n"client_secret":"${clientSecret}"\nvectorize.index.not_found: messages-index does not exist`,
                },
            ],
        });

        expect(await runCli(fixture.ctx, ["vectorize", "prepare"])).toBe(1);
        const error = fixture.stderr.join("");
        expect(error).toContain("failed with exit code 23");
        expect(error).toContain("Wrangler output tail:");
        expect(error).toContain("vectorize.index.not_found: messages-index does not exist");
        expect(error).not.toContain(accountId);
        expect(error).not.toContain(token);
        expect(error).not.toContain(apiKey);
        expect(error).not.toContain(clientSecret);
        expect(new TextEncoder().encode(error).byteLength).toBeLessThan(4_700);
    });

    test("reads wrangler.json before wrangler.jsonc", async () => {
        const fixture = project({
            json: jsonc({ binding: "VECTORS", index: "json-index" }).replace("// JSONC remains supported\n", ""),
            jsonc: jsonc({ binding: "VECTORS", index: "jsonc-index" }),
            responses: [result([{ propertyName: "cdb_resource", indexType: "String" }])],
        });
        await runVectorizePrepare(fixture.ctx);
        expect(fixture.calls[0]?.args.at(-1)).toBe("/project/wrangler.json");
    });

    test("rejects missing or false remote mode before calling Wrangler in every config format", async () => {
        for (const remote of [false, "missing"] as const) {
            for (const fixture of [
                project({ toml: toml({ binding: "VECTORS", index: "messages", remote }) }),
                project({
                    json: jsonc({ binding: "VECTORS", index: "messages", remote }).replace(
                        "// JSONC remains supported\n",
                        ""
                    ),
                }),
                project({ jsonc: jsonc({ binding: "VECTORS", index: "messages", remote }) }),
            ]) {
                await expect(runVectorizePrepare(fixture.ctx)).rejects.toThrow(
                    'Vectorize does not support local development; set remote = true for binding "VECTORS"'
                );
                expect(fixture.calls).toHaveLength(0);
            }
        }
    });

    test("bounds a runner that never settles", async () => {
        const fixture = project({ toml: toml({ binding: "VECTORS", index: "messages-index" }) });
        const hung: CliContext = {
            ...fixture.ctx,
            runCommand: () => new Promise(() => {}),
        };

        await expect(runVectorizePrepare(hung, { commandTimeoutMs: 1 })).rejects.toThrow(
            /project Wrangler command exceeded its 1ms timeout/
        );
    });
});
