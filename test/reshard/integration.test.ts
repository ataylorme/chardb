import { Database } from "bun:sqlite";
/**
 * End-to-end integration test for the resharding pipeline.
 *
 * Drives a workload through a "source" bun:sqlite database with the trigger
 * set installed, then replays the captured `_chardb_split_log` rows into a
 * "destination" bun:sqlite database via `renderRowApply`, filtered by the
 * migration's vshard range. Asserts:
 *   - rows in-range survive INSERT → UPDATE → DELETE → INSERT cycles with
 *     destination state matching the source for every in-range key,
 *   - rows out-of-range never appear in the destination,
 *   - replaying the same log a second time is idempotent (no row drift),
 *   - multi-table workloads share `_chardb_split_log` correctly with no
 *     cross-table contamination.
 *
 * This is the multi-table integration the test-suite audit flagged as a
 * gap; it sits between the per-helper unit tests in `triggers.test.ts` and
 * the workerd-level harness still on the roadmap.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { inRange, rowVshard } from "../../src/reshard/range.ts";
import { type TableSpec, renderRowApply, renderTableTriggers } from "../../src/reshard/triggers.ts";

const SPLIT_LOG_DDL = `
CREATE TABLE _chardb_split_log (
  lsn INTEGER PRIMARY KEY AUTOINCREMENT,
  mig_id TEXT NOT NULL,
  op TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  before TEXT,
  after TEXT,
  ts INTEGER NOT NULL
)`;

const messagesSpec: TableSpec = {
    name: "messages",
    partitionColumn: "org_id",
    columns: ["id", "org_id", "channel_id", "body", "created_at"],
};

const channelsSpec: TableSpec = {
    name: "channels",
    partitionColumn: "org_id",
    columns: ["id", "org_id", "name"],
};

const MIG_ID = "mig_007";

interface TailRow {
    lsn: number;
    op: "ins" | "upd" | "del";
    table_name: string;
    pk: string;
    before: string | null;
    after: string | null;
}

function makeSource() {
    const db = new Database(":memory:");
    db.run(SPLIT_LOG_DDL);
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, org_id TEXT, channel_id TEXT, body TEXT, created_at INTEGER)`);
    db.run(`CREATE TABLE channels (id TEXT PRIMARY KEY, org_id TEXT, name TEXT)`);
    for (const stmt of renderTableTriggers(MIG_ID, messagesSpec).install) db.run(stmt);
    for (const stmt of renderTableTriggers(MIG_ID, channelsSpec).install) db.run(stmt);
    return db;
}

function makeDest() {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, org_id TEXT, channel_id TEXT, body TEXT, created_at INTEGER)`);
    db.run(`CREATE TABLE channels (id TEXT PRIMARY KEY, org_id TEXT, name TEXT)`);
    return db;
}

function spec(name: string): TableSpec {
    return name === "messages" ? messagesSpec : channelsSpec;
}

function applyTail(dest: Database, src: Database, range: { lo: number; hi: number }) {
    const rows = src
        .prepare("SELECT lsn, op, table_name, pk, before, after FROM _chardb_split_log ORDER BY lsn")
        .all() as TailRow[];
    for (const r of rows) {
        if (!inRange(r.pk, range)) continue;
        const t = spec(r.table_name);
        if (r.op === "del") {
            dest.run(`DELETE FROM "${r.table_name}" WHERE "${t.partitionColumn}" = ? AND id = ?`, [
                r.pk,
                (JSON.parse(r.before ?? "{}") as { id?: string }).id ?? "",
            ]);
            continue;
        }
        const after = JSON.parse(r.after ?? "{}") as Record<string, unknown>;
        const apply = renderRowApply(t, after);
        dest.run(apply.sql, apply.params as unknown[] as never[]);
    }
}

function dump(db: Database, table: string): unknown[] {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
}

describe("reshard pipeline — multi-table integration", () => {
    let src: Database;
    let dest: Database;
    // pick a range that contains org "org-A" but not "org-Z"
    const orgA = "org-A";
    const orgZ = "org-zzzz";

    beforeEach(() => {
        src = makeSource();
        dest = makeDest();
    });

    test("INSERT → UPDATE → DELETE → INSERT cycles converge on destination for in-range rows", () => {
        src.run(`INSERT INTO channels VALUES (?, ?, ?)`, ["ch-1", orgA, "general"]);
        src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, ["m-1", orgA, "ch-1", "first", 1]);
        src.run(`UPDATE messages SET body = ? WHERE id = ?`, ["edited", "m-1"]);
        src.run(`DELETE FROM messages WHERE id = ?`, ["m-1"]);
        src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, ["m-1", orgA, "ch-1", "reborn", 2]);

        const aV = rowVshard(orgA);
        applyTail(dest, src, { lo: aV, hi: aV });

        expect(dump(dest, "channels")).toEqual([{ id: "ch-1", org_id: orgA, name: "general" }]);
        expect(dump(dest, "messages")).toEqual([
            { id: "m-1", org_id: orgA, channel_id: "ch-1", body: "reborn", created_at: 2 },
        ]);
    });

    test("out-of-range rows are filtered before apply and never reach the destination", () => {
        src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, ["m-A", orgA, "ch-1", "in", 1]);
        src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, ["m-Z", orgZ, "ch-9", "out", 1]);
        src.run(`INSERT INTO channels VALUES (?, ?, ?)`, ["ch-1", orgA, "in"]);
        src.run(`INSERT INTO channels VALUES (?, ?, ?)`, ["ch-9", orgZ, "out"]);

        const aV = rowVshard(orgA);
        applyTail(dest, src, { lo: aV, hi: aV });

        const msgRows = dump(dest, "messages") as { id: string }[];
        expect(msgRows.map(r => r.id)).toEqual(["m-A"]);
        const chanRows = dump(dest, "channels") as { id: string }[];
        expect(chanRows.map(r => r.id)).toEqual(["ch-1"]);
    });

    test("re-running the tail replay is idempotent — no row drift", () => {
        src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, ["m-1", orgA, "ch-1", "v1", 1]);
        src.run(`UPDATE messages SET body = ? WHERE id = ?`, ["v2", "m-1"]);

        const aV = rowVshard(orgA);
        applyTail(dest, src, { lo: aV, hi: aV });
        const first = dump(dest, "messages");
        applyTail(dest, src, { lo: aV, hi: aV });
        const second = dump(dest, "messages");

        expect(second).toEqual(first);
    });

    test("multi-table workload — channels and messages share the log without contamination", () => {
        for (let i = 0; i < 20; i++) {
            src.run(`INSERT INTO channels VALUES (?, ?, ?)`, [`ch-${i}`, orgA, `c${i}`]);
            src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, [`m-${i}`, orgA, `ch-${i}`, `body-${i}`, i]);
        }

        const aV = rowVshard(orgA);
        applyTail(dest, src, { lo: aV, hi: aV });

        expect((dump(dest, "channels") as unknown[]).length).toBe(20);
        expect((dump(dest, "messages") as unknown[]).length).toBe(20);

        // Tail rows in the log are partitioned cleanly by table_name with no
        // cross-table mix-ups.
        const tail = src
            .prepare("SELECT table_name, COUNT(*) AS n FROM _chardb_split_log GROUP BY table_name")
            .all() as { table_name: string; n: number }[];
        expect(new Set(tail.map(t => t.table_name))).toEqual(new Set(["channels", "messages"]));
        for (const t of tail) expect(t.n).toBe(20);
    });

    test("crash mid-bulk: resume from persisted lsn cursor without double-applying", () => {
        // Seed a workload, then simulate a crash by stopping replay halfway
        // through the log. On restart the driver reads its persisted cursor
        // (the highest applied lsn) and replays only rows with lsn > cursor.
        // Asserts the destination converges and the per-row ops counter
        // confirms no row was applied twice (proxy for "no duplicate work").
        for (let i = 0; i < 50; i++) {
            src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, [`m-${i}`, orgA, "ch-1", `b${i}`, i]);
        }
        for (let i = 0; i < 25; i++) {
            src.run(`UPDATE messages SET body = ? WHERE id = ?`, [`b${i}-edit`, `m-${i}`]);
        }

        const aV = rowVshard(orgA);
        const allRows = src
            .prepare("SELECT lsn, op, table_name, pk, before, after FROM _chardb_split_log ORDER BY lsn")
            .all() as TailRow[];

        // Track every (lsn, table, pk) actually applied to the dest so we can
        // detect if any single tail entry is replayed.
        const applied = new Set<number>();
        const apply = (rows: TailRow[]) => {
            for (const r of rows) {
                if (!inRange(r.pk, { lo: aV, hi: aV })) continue;
                if (applied.has(r.lsn)) {
                    throw new Error(`duplicate replay of lsn=${r.lsn}`);
                }
                applied.add(r.lsn);
                const t = spec(r.table_name);
                if (r.op === "del") {
                    dest.run(`DELETE FROM "${r.table_name}" WHERE "${t.partitionColumn}" = ? AND id = ?`, [
                        r.pk,
                        (JSON.parse(r.before ?? "{}") as { id?: string }).id ?? "",
                    ]);
                    continue;
                }
                const after = JSON.parse(r.after ?? "{}") as Record<string, unknown>;
                const a = renderRowApply(t, after);
                dest.run(a.sql, a.params as unknown[] as never[]);
            }
        };

        // Apply the first half, "crash" after persisting the cursor.
        const half = Math.floor(allRows.length / 2);
        const firstHalf = allRows.slice(0, half);
        apply(firstHalf);
        const persistedCursor = firstHalf[firstHalf.length - 1]?.lsn ?? 0;

        // Concurrent writes happen during the crash window — they must also
        // be picked up on resume, exercising the cursor-vs-tail contract.
        src.run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)`, ["m-100", orgA, "ch-1", "post-crash", 100]);
        src.run(`UPDATE messages SET body = ? WHERE id = ?`, ["post-crash-edit", "m-100"]);

        // Restart: read everything strictly after the cursor and apply.
        const remaining = src
            .prepare("SELECT lsn, op, table_name, pk, before, after FROM _chardb_split_log WHERE lsn > ? ORDER BY lsn")
            .all(persistedCursor) as TailRow[];
        apply(remaining);

        // Final destination matches the source's in-range view.
        const srcView = src.prepare(`SELECT * FROM messages ORDER BY id`).all();
        const destView = dump(dest, "messages");
        expect(destView).toEqual(srcView);
        // Every applied lsn was applied exactly once.
        expect(applied.size).toBe(firstHalf.length + remaining.length);
    });
});
