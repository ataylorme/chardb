import { describe, expect, test } from "bun:test";
import type { CliContext, CliFetch } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";

function fakeCtx(overrides: Partial<CliContext> = {}): { ctx: CliContext; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
        ctx: {
            cwd: "/tmp/proj",
            env: {},
            stdout: value => out.push(value),
            stderr: value => err.push(value),
            async read() {
                throw new Error("not used");
            },
            async write() {},
            async exists() {
                return false;
            },
            ...overrides,
        },
        out,
        err,
    };
}

describe("chardb explain CLI", () => {
    test("explains a partition-key query from positional JSON", async () => {
        const { ctx, out, err } = fakeCtx();
        const intent = JSON.stringify({
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
            joinShape: "colocated",
        });

        expect(await runCli(ctx, ["explain", intent])).toBe(0);
        expect(out.join("")).toContain("path=partition-key fanout~1");
        expect(err).toEqual([]);
    });

    test("returns one for a scatter plan in strict mode", async () => {
        const { ctx, out } = fakeCtx();
        const intent = JSON.stringify({ kind: "select", tables: ["messages"], joinShape: "cross-partition" });

        expect(await runCli(ctx, ["explain", "--strict", "--intent", intent])).toBe(1);
        expect(out.join("")).toContain("path=rejected");
        expect(out.join("")).toContain("CDB_SCATTER_NOT_INDEX");
    });

    test("returns usage errors for missing and malformed intents", async () => {
        const missing = fakeCtx();
        expect(await runCli(missing.ctx, ["explain"])).toBe(2);
        expect(missing.err.join("")).toContain("usage: chardb explain");

        const malformed = fakeCtx();
        expect(await runCli(malformed.ctx, ["explain", '{"kind":"select"}'])).toBe(2);
        expect(malformed.err.join("")).toContain("intent.tables");
    });
});

describe("chardb command availability", () => {
    test("help labels every unavailable command", async () => {
        const { ctx, out, err } = fakeCtx();

        expect(await runCli(ctx, ["--help"])).toBe(0);
        expect(err).toEqual([]);
        for (const command of ["deploy", "shards", "snapshot", "restore", "export", "schedule"]) {
            expect(out.join("")).toContain(`chardb ${command}`);
        }
        expect(out.join("").match(/not implemented/g)).toHaveLength(6);
    });

    test("unavailable commands fail clearly without running placeholder implementations", async () => {
        for (const command of ["deploy", "shards", "snapshot", "restore", "export", "schedule"]) {
            const { ctx, out, err } = fakeCtx();

            expect(await runCli(ctx, [command])).toBe(1);
            expect(out).toEqual([]);
            expect(err).toEqual([`chardb ${command}: not implemented in this release\n`]);
        }
    });
});

describe("chardb migrate CLI", () => {
    test("resumes pending shards with bounded workers and completes the exact migration", async () => {
        const calls: { readonly path: string; readonly body: Record<string, unknown> | null }[] = [];
        const fetch: CliFetch = async (input, init) => {
            const url = new URL(String(input));
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer migration-secret");
            const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
            calls.push({ path: `${url.pathname}${url.search}`, body });
            if (url.pathname.endsWith("/state")) {
                return Response.json({
                    ok: true,
                    state: {
                        activeVersion: 1,
                        activeEpoch: 4,
                        status: "active",
                        migrationId: null,
                        targetVersion: null,
                    },
                });
            }
            if (url.pathname.endsWith("/begin")) {
                return Response.json({
                    ok: true,
                    state: {
                        activeVersion: 1,
                        activeEpoch: 4,
                        status: "migrating",
                        migrationId: "deploy-2",
                        targetVersion: 2,
                    },
                });
            }
            if (url.pathname.endsWith("/shards")) {
                return Response.json({
                    ok: true,
                    shards: [
                        { shardId: "ShardDO_0", status: "active" },
                        { shardId: "ShardDO_1", status: "pending" },
                        { shardId: "ShardDO_2", status: "pending" },
                    ],
                });
            }
            if (url.pathname.endsWith("/shard")) {
                return Response.json({ ok: true, shard: { shardId: body?.shardId, status: "active" } });
            }
            if (url.pathname.endsWith("/catalog")) {
                return Response.json({
                    ok: true,
                    state: {
                        activeVersion: 1,
                        activeEpoch: 4,
                        status: "migrating",
                        migrationId: "deploy-2",
                        targetVersion: 2,
                    },
                });
            }
            if (url.pathname.endsWith("/complete")) {
                return Response.json({
                    ok: true,
                    state: {
                        activeVersion: 2,
                        activeEpoch: 5,
                        status: "active",
                        migrationId: null,
                        targetVersion: null,
                    },
                });
            }
            return new Response("missing", { status: 404 });
        };
        const { ctx, out, err } = fakeCtx({
            env: { CHARDB_ADMIN_TOKEN: "migration-secret" },
            fetch,
        });

        expect(
            await runCli(ctx, [
                "migrate",
                "--url",
                "https://worker.example",
                "--id",
                "deploy-2",
                "--target",
                "2",
                "--concurrency",
                "2",
            ])
        ).toBe(0);
        expect(err).toEqual([]);
        expect(out.join("")).toContain("migrating 2 pending shard(s)");
        expect(out.join("")).toContain("applied Catalog schema version 2");
        expect(out.join("")).toContain("schema version 2 active at epoch 5");
        expect(
            calls
                .filter(call => call.path.endsWith("/shard"))
                .map(call => call.body?.shardId)
                .sort()
        ).toEqual(["ShardDO_1", "ShardDO_2"]);
        expect(calls.at(-1)?.path).toBe("/_chardb/migrations/complete");
        expect(calls.find(call => call.path.endsWith("/catalog"))?.body).toEqual({
            migrationId: "deploy-2",
            version: 2,
        });
    });

    test("requires the secret and refuses unsafe remote HTTP", async () => {
        const missing = fakeCtx({ fetch: globalThis.fetch });
        expect(
            await runCli(missing.ctx, ["migrate", "--url", "https://worker.example", "--id", "m1", "--target", "1"])
        ).toBe(2);

        const unsafe = fakeCtx({
            env: { CHARDB_ADMIN_TOKEN: "secret" },
            fetch: async () => Response.json({ ok: true }),
        });
        expect(
            await runCli(unsafe.ctx, ["migrate", "--url", "http://worker.example", "--id", "m1", "--target", "1"])
        ).toBe(1);
        expect(unsafe.err.join("")).toContain("must use HTTPS");
    });

    test("uses the explicit baseline endpoint for version-zero adoption", async () => {
        const paths: string[] = [];
        const fetch: CliFetch = async input => {
            const url = new URL(String(input));
            paths.push(url.pathname);
            if (url.pathname.endsWith("/state")) {
                return Response.json({
                    state: {
                        activeVersion: 0,
                        activeEpoch: 1,
                        status: "active",
                        migrationId: null,
                        targetVersion: null,
                    },
                });
            }
            if (url.pathname.endsWith("/baseline") || url.pathname.endsWith("/catalog")) {
                return Response.json({
                    state: {
                        activeVersion: 0,
                        activeEpoch: 1,
                        status: "migrating",
                        migrationId: "adopt-v1",
                        targetVersion: 1,
                    },
                });
            }
            if (url.pathname.endsWith("/shards")) return Response.json({ shards: [] });
            if (url.pathname.endsWith("/complete")) {
                return Response.json({
                    state: {
                        activeVersion: 1,
                        activeEpoch: 2,
                        status: "active",
                        migrationId: null,
                        targetVersion: null,
                    },
                });
            }
            throw new Error(`unexpected request ${url.pathname}`);
        };
        const { ctx, err } = fakeCtx({ env: { CHARDB_ADMIN_TOKEN: "secret" }, fetch });
        expect(
            await runCli(ctx, [
                "migrate",
                "--url",
                "https://worker.example",
                "--id",
                "adopt-v1",
                "--target",
                "1",
                "--baseline",
            ])
        ).toBe(0);
        expect(err).toEqual([]);
        expect(paths).toContain("/_chardb/migrations/baseline");
        expect(paths).not.toContain("/_chardb/migrations/begin");
    });
});

describe("chardb doctor CLI", () => {
    test("help only advertises the implemented Wrangler check", async () => {
        const { ctx, out } = fakeCtx();

        expect(await runCli(ctx, ["--help"])).toBe(0);
        expect(out.join("")).toContain("chardb doctor [wrangler]");
        expect(out.join("")).not.toContain("wrangler.jsonc / schema / auth");
    });

    test("schema and auth exit one and print their errors", async () => {
        for (const target of ["schema", "auth"]) {
            const { ctx, out, err } = fakeCtx();

            expect(await runCli(ctx, ["doctor", target])).toBe(1);
            expect(out).toEqual([]);
            expect(err.join("")).toContain(`chardb doctor ${target}: not implemented`);
        }
    });

    test("unknown targets are usage errors", async () => {
        const { ctx, out, err } = fakeCtx();

        expect(await runCli(ctx, ["doctor", "spelling-error"])).toBe(2);
        expect(out).toEqual([]);
        expect(err).toEqual(["usage: chardb doctor [wrangler|schema|auth]\n"]);
    });
});
