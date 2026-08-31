import { describe, expect, test } from "bun:test";
import { runMigrate } from "../../src/cli/commands/migrate.ts";
import type { CliContext, CliFetch } from "../../src/cli/context.ts";

const activeState = {
    activeVersion: 0,
    activeEpoch: 1,
    status: "active",
    migrationId: null,
    targetVersion: null,
} as const;

const migratingState = {
    activeVersion: 0,
    activeEpoch: 1,
    status: "migrating",
    migrationId: "retry-v1",
    targetVersion: 1,
} as const;

function context(fetch: CliFetch): { readonly ctx: CliContext; readonly out: string[] } {
    const out: string[] = [];
    return {
        ctx: {
            cwd: "/tmp/chardb-migrate-retry",
            env: {},
            fetch,
            stdout: value => out.push(value),
            stderr() {},
            async read() {
                throw new Error("not used");
            },
            async write() {},
            async exists() {
                return false;
            },
        },
        out,
    };
}

function completedState() {
    return {
        activeVersion: 1,
        activeEpoch: 2,
        lastMigrationId: "retry-v1",
        status: "active",
        migrationId: null,
        targetVersion: null,
    };
}

function options(fetch: CliFetch, overrides: { readonly requestTimeoutMs?: number } = {}) {
    return {
        baseUrl: "https://worker.example",
        token: "migration-secret",
        migrationId: "retry-v1",
        targetVersion: 1,
        concurrency: 1,
        fetch,
        ...overrides,
    };
}

function terminalResponse(pathname: string): Response | undefined {
    if (pathname.endsWith("/state")) return Response.json({ ok: true, state: activeState });
    if (pathname.endsWith("/begin")) return Response.json({ ok: true, state: migratingState });
    if (pathname.endsWith("/catalog")) return Response.json({ ok: true, state: migratingState });
    if (pathname.endsWith("/complete")) return Response.json({ ok: true, state: completedState() });
    return undefined;
}

describe("migration shard retry and reconciliation", () => {
    test("bounds a fetch that never resolves", async () => {
        const fetch: CliFetch = async () => await new Promise<Response>(() => {});
        const { ctx } = context(fetch);

        await expect(runMigrate(ctx, options(fetch, { requestTimeoutMs: 10 }))).rejects.toThrow(
            "migration endpoint request timed out after 10ms"
        );
    });

    test("bounds a response body that stalls after headers", async () => {
        const fetch: CliFetch = async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{"ok":'));
                    },
                }),
                { status: 200 }
            );
        const { ctx } = context(fetch);

        await expect(runMigrate(ctx, options(fetch, { requestTimeoutMs: 10 }))).rejects.toThrow(
            "migration endpoint request timed out after 10ms"
        );
    });

    test("accepts an active shard after a lost 5xx response without replaying it", async () => {
        let shardPosts = 0;
        let inventories = 0;
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            const terminal = terminalResponse(pathname);
            if (terminal) return terminal;
            if (pathname.endsWith("/shards")) {
                inventories++;
                return Response.json({
                    ok: true,
                    shards: [
                        {
                            shardId: "ShardDO_0",
                            status: inventories === 1 ? "pending" : "active",
                            lastError: null,
                        },
                    ],
                });
            }
            if (pathname.endsWith("/shard")) {
                shardPosts++;
                return Response.json({ error: "internal error; reference = transient" }, { status: 500 });
            }
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx, out } = context(fetch);

        await runMigrate(ctx, options(fetch));

        expect(shardPosts).toBe(1);
        expect(inventories).toBe(2);
        expect(out.join("")).toContain("activated shard ShardDO_0");
        expect(out.join("")).toContain("schema version 1 active at epoch 2");
    });

    test("reconciles retryable 408 and 429 responses before replaying", async () => {
        for (const status of [408, 429]) {
            let shardPosts = 0;
            let inventories = 0;
            const fetch: CliFetch = async input => {
                const pathname = new URL(String(input)).pathname;
                const terminal = terminalResponse(pathname);
                if (terminal) return terminal;
                if (pathname.endsWith("/shards")) {
                    inventories++;
                    return Response.json({
                        ok: true,
                        shards: [
                            {
                                shardId: "ShardDO_0",
                                status: inventories === 1 ? "pending" : "active",
                                lastError: null,
                            },
                        ],
                    });
                }
                if (pathname.endsWith("/shard")) {
                    shardPosts++;
                    return Response.json({ error: "transient edge response" }, { status });
                }
                throw new Error(`unexpected migration request ${pathname}`);
            };
            const { ctx } = context(fetch);

            await runMigrate(ctx, options(fetch));

            expect(shardPosts).toBe(1);
            expect(inventories).toBe(2);
        }
    });

    test("retries the same pending shard after a network failure", async () => {
        let shardPosts = 0;
        let inventories = 0;
        const fetch: CliFetch = async (input, init) => {
            const pathname = new URL(String(input)).pathname;
            const terminal = terminalResponse(pathname);
            if (terminal) return terminal;
            if (pathname.endsWith("/shards")) {
                inventories++;
                return Response.json({
                    ok: true,
                    shards: [{ shardId: "ShardDO_0", status: "pending", lastError: "temporary Cdb RPC failure" }],
                });
            }
            if (pathname.endsWith("/shard")) {
                shardPosts++;
                expect(JSON.parse(String(init?.body))).toEqual({
                    migrationId: "retry-v1",
                    shardId: "ShardDO_0",
                });
                if (shardPosts === 1) throw new TypeError("connection reset");
                return Response.json({
                    ok: true,
                    shard: { shardId: "ShardDO_0", status: "active", lastError: null },
                });
            }
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        await runMigrate(ctx, options(fetch));

        expect(shardPosts).toBe(2);
        expect(inventories).toBe(2);
    });

    test("reconciles a successful shard after its 200 response stream fails", async () => {
        let shardPosts = 0;
        let inventories = 0;
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            const terminal = terminalResponse(pathname);
            if (terminal) return terminal;
            if (pathname.endsWith("/shards")) {
                inventories++;
                return Response.json({
                    ok: true,
                    shards: [
                        {
                            shardId: "ShardDO_0",
                            status: inventories === 1 ? "pending" : "active",
                            lastError: null,
                        },
                    ],
                });
            }
            if (pathname.endsWith("/shard")) {
                shardPosts++;
                return new Response(
                    new ReadableStream<Uint8Array>({
                        pull(controller) {
                            controller.error(new Error("connection reset while reading response"));
                        },
                    }),
                    { status: 200 }
                );
            }
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        await runMigrate(ctx, options(fetch));

        expect(shardPosts).toBe(1);
        expect(inventories).toBe(2);
    });

    test("does not retry an intentionally rejected oversized response", async () => {
        let shardPosts = 0;
        let inventories = 0;
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            const terminal = terminalResponse(pathname);
            if (terminal) return terminal;
            if (pathname.endsWith("/shards")) {
                inventories++;
                return Response.json({
                    ok: true,
                    shards: [{ shardId: "ShardDO_0", status: "pending", lastError: null }],
                });
            }
            if (pathname.endsWith("/shard")) {
                shardPosts++;
                return new Response("{}", { headers: { "content-length": String(4 * 1_024 * 1_024 + 1) } });
            }
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        await expect(runMigrate(ctx, options(fetch))).rejects.toThrow("invalid content length");
        expect(shardPosts).toBe(1);
        expect(inventories).toBe(1);
    });

    test("bounds retries and preserves the Catalog shard failure detail", async () => {
        let shardPosts = 0;
        let inventories = 0;
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname.endsWith("/state")) return Response.json({ ok: true, state: activeState });
            if (pathname.endsWith("/begin")) return Response.json({ ok: true, state: migratingState });
            if (pathname.endsWith("/shards")) {
                inventories++;
                return Response.json({
                    ok: true,
                    shards: [{ shardId: "ShardDO_0", status: "pending", lastError: "Cdb startup unavailable" }],
                });
            }
            if (pathname.endsWith("/shard")) {
                shardPosts++;
                return Response.json({ error: "edge unavailable" }, { status: 503 });
            }
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        await expect(runMigrate(ctx, options(fetch))).rejects.toThrow(
            "migration shard ShardDO_0 failed after 3 attempts: migration endpoint returned 503: edge unavailable; Catalog last error: Cdb startup unavailable"
        );
        expect(shardPosts).toBe(3);
        expect(inventories).toBe(4);
    });

    test("does not retry or reconcile deterministic 4xx failures", async () => {
        let shardPosts = 0;
        let inventories = 0;
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname.endsWith("/state")) return Response.json({ ok: true, state: activeState });
            if (pathname.endsWith("/begin")) return Response.json({ ok: true, state: migratingState });
            if (pathname.endsWith("/shards")) {
                inventories++;
                return Response.json({
                    ok: true,
                    shards: [{ shardId: "ShardDO_0", status: "pending", lastError: null }],
                });
            }
            if (pathname.endsWith("/shard")) {
                shardPosts++;
                return Response.json({ error: "invalid shard owner" }, { status: 409 });
            }
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        await expect(runMigrate(ctx, options(fetch))).rejects.toThrow(
            "migration endpoint returned 409: invalid shard owner"
        );
        expect(shardPosts).toBe(1);
        expect(inventories).toBe(1);
    });

    test("bounds remote error detail before reporting it", async () => {
        const detail = "x".repeat(10_000);
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname.endsWith("/state")) return Response.json({ ok: true, state: activeState });
            if (pathname.endsWith("/begin")) return Response.json({ ok: true, state: migratingState });
            if (pathname.endsWith("/shards")) {
                return Response.json({
                    ok: true,
                    shards: [{ shardId: "ShardDO_0", status: "pending", lastError: null }],
                });
            }
            if (pathname.endsWith("/shard")) return Response.json({ error: detail }, { status: 409 });
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        let reported = "";
        try {
            await runMigrate(ctx, options(fetch));
        } catch (error) {
            reported = error instanceof Error ? error.message : String(error);
        }
        expect(reported).toContain("...[truncated]");
        expect(reported.length).toBeLessThan(1_200);
    });

    test("accepts same-ID completion that wins the begin race", async () => {
        const wonRace = completedState();
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname.endsWith("/state")) return Response.json({ ok: true, state: activeState });
            if (pathname.endsWith("/begin")) return Response.json({ ok: true, state: wonRace });
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx, out } = context(fetch);

        await runMigrate(ctx, options(fetch));

        expect(out.join("")).toBe("schema version 1 active at epoch 2\n");
    });

    test("rejects a downgrade before beginning a migration", async () => {
        const requests: string[] = [];
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            requests.push(pathname);
            if (pathname.endsWith("/state")) {
                return Response.json({
                    ok: true,
                    state: { ...completedState(), activeVersion: 2, activeEpoch: 3 },
                });
            }
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        await expect(runMigrate(ctx, options(fetch))).rejects.toThrow(
            "deployed schema version 2 is newer than target 1"
        );
        expect(requests).toEqual(["/_chardb/migrations/state"]);
    });

    test("rejects an active begin response owned by another migration", async () => {
        const wrongOwner = { ...completedState(), lastMigrationId: "another-migration" };
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname.endsWith("/state")) return Response.json({ ok: true, state: activeState });
            if (pathname.endsWith("/begin")) return Response.json({ ok: true, state: wrongOwner });
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx } = context(fetch);

        await expect(runMigrate(ctx, options(fetch))).rejects.toThrow("different migration owner or target");
    });

    test("accepts same-ID completion that wins the Catalog-step race", async () => {
        const wonRace = completedState();
        const fetch: CliFetch = async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname.endsWith("/state")) return Response.json({ ok: true, state: activeState });
            if (pathname.endsWith("/begin")) return Response.json({ ok: true, state: migratingState });
            if (pathname.endsWith("/shards")) return Response.json({ ok: true, shards: [] });
            if (pathname.endsWith("/catalog")) return Response.json({ ok: true, state: wonRace });
            throw new Error(`unexpected migration request ${pathname}`);
        };
        const { ctx, out } = context(fetch);

        await runMigrate(ctx, options(fetch));

        expect(out.join("")).toContain("schema version 1 active at epoch 2\n");
    });
});
