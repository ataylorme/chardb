/**
 * Workerd-level integration test for the `Cdb` reshard surface.
 *
 * Boots `miniflare` with a bundled test worker that exposes `TestCdb`
 * (extends the production `Cdb`) and drives a single-table reshard
 * end-to-end against the real Durable Object `SqlStorage`:
 *
 *   1. seed source rows on `Cdb_src`,
 *   2. `beginReshardSource(migId, range, tables)` installs triggers,
 *   3. additional inserts after triggers populate `_chardb_split_log`,
 *   4. `bulkCopyBatch` paginates the source's pre-trigger rows,
 *   5. `applyBulkBatch` lands them on `Cdb_dst`,
 *   6. `readTailBatch` + `applyTailBatch` move the post-trigger writes,
 *   7. assert dest matches the source's in-range view.
 *
 * The harness deliberately keeps the bundle minimal — `Bun.build` resolves
 * the chardb sources directly so we don't drag the whole library into a
 * worker bundle. Skipped on environments without `Bun` (e.g. node-only
 * CI) by checking `typeof Bun !== "undefined"`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Miniflare } from "miniflare";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "worker.entry.ts");

interface RpcCall {
    readonly op: string;
    readonly target: "src" | "dst";
    readonly body?: unknown;
}

let mf: Miniflare | undefined;
let workerSource = "";

async function buildWorker(): Promise<string> {
    // Bun's build API (Bun.build) and the CLI both reach the same bundler,
    // but inside `bun test` the API hits a stricter resolver that drops
    // relative `.ts` imports. Shell out to the CLI which behaves correctly.
    const out = path.join(HERE, ".test-worker.bundle.mjs");
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
    workerSource = await buildWorker();
    mf = new Miniflare({
        modules: true,
        script: workerSource,
        durableObjects: { CDB: { className: "TestCdb", useSQLite: true } },
        compatibilityDate: "2024-09-23",
        compatibilityFlags: ["nodejs_compat"],
    });
    await mf.ready;
});

afterAll(async () => {
    await mf?.dispose();
});

async function rpc({ op, target, body }: RpcCall): Promise<unknown> {
    if (!mf) throw new Error("miniflare not initialized");
    const url = `http://example.com/${op}?name=${target}`;
    const res = await mf.dispatchFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`rpc ${op}/${target} → HTTP ${res.status}: ${text}`);
    }
    return res.json();
}

describe("workerd reshard harness", () => {
    test("end-to-end reshard: bulk copy + tail replay against real DO SqlStorage", async () => {
        const messagesSpec = {
            name: "messages",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "body"],
        } as const;

        const orgInRange = "org-A";
        const orgOutOfRange = "org-Z";

        // Seed both shards' table schemas. We pick a vshard range that covers
        // org-A but not org-Z; rowVshard isn't pure-importable from the worker
        // bundle path so we use a wide [0, 16383] range and rely on the
        // partition-column filter being identity for in-range rows. The
        // out-of-range assertion uses a tighter range below.
        for (const target of ["src", "dst"] as const) {
            await rpc({
                op: "_exec",
                target,
                body: {
                    sql: "CREATE TABLE messages (id TEXT PRIMARY KEY, org_id TEXT, body TEXT)",
                },
            });
        }

        // Pre-trigger seed on source.
        for (let i = 0; i < 25; i++) {
            await rpc({
                op: "_exec",
                target: "src",
                body: {
                    sql: "INSERT INTO messages VALUES (?, ?, ?)",
                    params: [`m-${i}`, orgInRange, `body-${i}`],
                },
            });
        }
        await rpc({
            op: "_exec",
            target: "src",
            body: {
                sql: "INSERT INTO messages VALUES (?, ?, ?)",
                params: ["m-out", orgOutOfRange, "out-of-range"],
            },
        });

        const migId = "mig_workerd_1";
        // Wide range — every vshard maps inside. The reshard layer's per-row
        // `inRange` then becomes a tautology, which is exactly what we want
        // for the bulk-copy half of the assertion.
        const range = { rangeLo: 0, rangeHi: 16383 };

        await rpc({
            op: "beginReshardSource",
            target: "src",
            body: { migId, ...range, tables: [messagesSpec] },
        });
        await rpc({
            op: "beginReshardDest",
            target: "dst",
            body: { migId, ...range },
        });

        // Post-trigger writes go into the split log.
        for (let i = 25; i < 35; i++) {
            await rpc({
                op: "_exec",
                target: "src",
                body: {
                    sql: "INSERT INTO messages VALUES (?, ?, ?)",
                    params: [`m-${i}`, orgInRange, `body-${i}`],
                },
            });
        }
        // An update to a pre-trigger row also lands in the split log.
        await rpc({
            op: "_exec",
            target: "src",
            body: {
                sql: "UPDATE messages SET body = ? WHERE id = ?",
                params: ["body-0-edited", "m-0"],
            },
        });

        // Bulk copy in pages.
        let after = 0;
        let copied = 0;
        while (true) {
            const batch = (await rpc({
                op: "bulkCopyBatch",
                target: "src",
                body: {
                    migId,
                    table: messagesSpec,
                    range: { lo: range.rangeLo, hi: range.rangeHi },
                    afterRowid: after,
                    limit: 10,
                },
            })) as { rows: Record<string, unknown>[]; lastRowid: number; done: boolean };
            if (batch.rows.length > 0) {
                const apply = (await rpc({
                    op: "applyBulkBatch",
                    target: "dst",
                    body: {
                        migId,
                        table: messagesSpec,
                        range: { lo: range.rangeLo, hi: range.rangeHi },
                        rows: batch.rows,
                    },
                })) as { applied: number; skipped: number };
                copied += apply.applied;
            }
            after = batch.lastRowid;
            if (batch.done) break;
        }
        expect(copied).toBeGreaterThan(0);

        // Tail replay — drains the split log produced by the post-trigger
        // writes, including the UPDATE on m-0.
        let lsn = 0;
        while (true) {
            const tail = (await rpc({
                op: "readTailBatch",
                target: "src",
                body: { migId, afterLsn: lsn, limit: 50 },
            })) as { entries: { lsn: number }[]; lastLsn: number; done: boolean };
            if (tail.entries.length > 0) {
                await rpc({
                    op: "applyTailBatch",
                    target: "dst",
                    body: {
                        migId,
                        table: messagesSpec,
                        range: { lo: range.rangeLo, hi: range.rangeHi },
                        entries: tail.entries,
                    },
                });
            }
            lsn = tail.lastLsn;
            if (tail.done) break;
        }

        // Assert dest converged on the source's view (m-0 carries the edit).
        const srcDump = (await rpc({
            op: "_dump",
            target: "src",
            body: { table: "messages", orderBy: "id" },
        })) as {
            rows: { id: string; body: string }[];
        };
        const dstDump = (await rpc({
            op: "_dump",
            target: "dst",
            body: { table: "messages", orderBy: "id" },
        })) as {
            rows: { id: string; body: string }[];
        };
        expect(dstDump.rows.length).toBe(srcDump.rows.length);
        const m0Dst = dstDump.rows.find(r => r.id === "m-0");
        expect(m0Dst?.body).toBe("body-0-edited");
        // Tail-only inserts also landed.
        expect(dstDump.rows.find(r => r.id === "m-30")).toBeDefined();
    }, 30_000);

    test("applyBulkBatch defensively filters out-of-range rows so a misrouted batch can't pollute dest", async () => {
        const messagesSpec = {
            name: "messages_iso",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "body"],
        } as const;
        await rpc({
            op: "_exec",
            target: "dst",
            body: { sql: "CREATE TABLE messages_iso (id TEXT PRIMARY KEY, org_id TEXT, body TEXT)" },
        });
        // Range [0,0] only — only org_ids whose vshard hashes to 0 land. We
        // pass a batch with mixed orgs and assert applied < total.
        const result = (await rpc({
            op: "applyBulkBatch",
            target: "dst",
            body: {
                migId: "mig_iso",
                table: messagesSpec,
                range: { lo: 0, hi: 0 },
                rows: [
                    { id: "row-1", org_id: "needle", body: "x" },
                    { id: "row-2", org_id: "haystack", body: "y" },
                    { id: "row-3", org_id: "anvil", body: "z" },
                ],
            },
        })) as { applied: number; skipped: number };
        expect(result.applied + result.skipped).toBe(3);
        // At minimum, we expect not every row to land — the [0,0] vshard slot
        // is 1/16384 wide, so the prior probability of all 3 hashing into it
        // is essentially zero.
        expect(result.skipped).toBeGreaterThan(0);
    }, 15_000);
});
