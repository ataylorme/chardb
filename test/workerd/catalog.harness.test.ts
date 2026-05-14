/**
 * Workerd-level integration test for the `Catalog` PITR barrier surface.
 *
 * Boots `miniflare@4` with a bundled test worker that exposes `Catalog`
 * (re-exported from `chardb/server`) and drives the `openBarrier` →
 * `ackBarrier` → `openBarriers` flow against real Durable Object
 * `SqlStorage`. This pairs with the pure-helper tests for the cron
 * dispatch path; together they cover what the entrypoint's
 * `runBarrierTick` + `runUserCrons` rely on, without booting the full
 * `WorkerEntrypoint`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Miniflare } from "miniflare";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "catalog.entry.ts");

let mf: Miniflare | undefined;

async function buildWorker(): Promise<string> {
    const out = path.join(HERE, ".test-catalog.bundle.mjs");
    const proc = Bun.spawn(
        ["bun", "build", ENTRY, "--target=browser", "--format=esm", "--external=cloudflare:workers", "--outfile", out],
        { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`bundle failed (exit ${exitCode}):\n${stderr}`);
    }
    return Bun.file(out).text();
}

beforeAll(async () => {
    const workerSource = await buildWorker();
    mf = new Miniflare({
        modules: true,
        script: workerSource,
        durableObjects: { CATALOG: { className: "Catalog", useSQLite: true } },
        compatibilityDate: "2024-09-23",
        compatibilityFlags: ["nodejs_compat"],
    });
    await mf.ready;
});

afterAll(async () => {
    await mf?.dispose();
});

async function call(op: string, body?: unknown): Promise<unknown> {
    if (!mf) throw new Error("miniflare not initialized");
    const url = `http://example.com/${op}`;
    const res = await mf.dispatchFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`rpc ${op} → HTTP ${res.status}: ${text}`);
    }
    return res.json();
}

interface OpenBarrierResult {
    readonly barrierId: string;
    readonly expectedShards: readonly string[];
}

interface OpenBarriersEntry {
    readonly barrierId: string;
    readonly missing: readonly string[];
}

describe("workerd Catalog barrier flow", () => {
    test("openBarrier seeds expected shards from the range table; ackBarrier completes once every expected shard acks", async () => {
        const opened = (await call("openBarrier", { now: 1_700_000_000_000 })) as OpenBarrierResult;
        expect(opened.expectedShards).toEqual(["ShardDO_0"]);
        expect(opened.barrierId).toMatch(/^b-/);

        // First ack covers the only expected shard → complete.
        const acked = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_0",
            bookmark: 42,
        })) as { complete: boolean };
        expect(acked.complete).toBe(true);

        const open = (await call("openBarriers", {})) as readonly OpenBarriersEntry[];
        expect(open.find(b => b.barrierId === opened.barrierId)).toBeUndefined();
    });

    test("ackBarrier is idempotent (same shard re-acks → still complete, no error)", async () => {
        const opened = (await call("openBarrier", { now: 1_700_000_001_000 })) as OpenBarrierResult;
        await call("ackBarrier", { barrierId: opened.barrierId, shardId: "ShardDO_0", bookmark: 50 });
        const second = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_0",
            bookmark: 50,
        })) as { complete: boolean };
        expect(second.complete).toBe(true);
    });

    test("openBarriers reports any barrier with at least one missing shard", async () => {
        // Cutover synthesizes a second shard so we can have a barrier with multiple expected acks.
        await call("cutover", {
            migId: "mig_pitr_1",
            lo: 0,
            hi: 8191,
            fromShard: "ShardDO_0",
            toShard: "ShardDO_1",
        });
        const opened = (await call("openBarrier", { now: 1_700_000_002_000 })) as OpenBarrierResult;
        expect(new Set(opened.expectedShards)).toEqual(new Set(["ShardDO_0", "ShardDO_1"]));
        // Ack only one — barrier remains incomplete.
        const partial = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_0",
            bookmark: 100,
        })) as { complete: boolean };
        expect(partial.complete).toBe(false);
        const open = (await call("openBarriers", {})) as readonly OpenBarriersEntry[];
        const ours = open.find(b => b.barrierId === opened.barrierId);
        expect(ours).toBeDefined();
        expect(ours?.missing).toEqual(["ShardDO_1"]);
        // Final ack from ShardDO_1 closes it.
        const closed = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_1",
            bookmark: 200,
        })) as { complete: boolean };
        expect(closed.complete).toBe(true);
    });

    test("ackBarrier on an unknown barrierId is a silent no-op (never complete) — defends against a stale shard", async () => {
        const result = (await call("ackBarrier", {
            barrierId: "b-doesntexist",
            shardId: "ShardDO_0",
            bookmark: 0,
        })) as { complete: boolean };
        expect(result.complete).toBe(false);
    });
});
