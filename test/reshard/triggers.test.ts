import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { filterRowsInRange, inRange, rowVshard } from "../../src/reshard/range.ts";
import {
    type TableSpec,
    legacyTableTriggerNames,
    renderTableTriggers,
    uninstallOwnedLegacyTableTriggers,
} from "../../src/reshard/triggers.ts";
import { vshardOf } from "../../src/vshard.ts";

const ORDERS: TableSpec = {
    name: "orders",
    partitionColumn: "tenant_id",
    columns: ["id", "tenant_id", "total"],
};

let db: Database;

function syncSql(db: Database): SyncSql {
    return {
        exec(query, ...params) {
            db.run(query, params as never[]);
        },
        one<T>(query: string, ...params: never[]): T | null {
            return (db.query(query).get(...params) as T | null) ?? null;
        },
        all<T>(query: string, ...params: never[]): T[] {
            return db.query(query).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS count").get() as { count: number }).count);
        },
    };
}

beforeEach(() => {
    db = new Database(":memory:");
    db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, total INTEGER NOT NULL)");
    db.run(`CREATE TABLE _chardb_split_log (
    lsn INTEGER PRIMARY KEY AUTOINCREMENT,
    source_tx_id INTEGER NOT NULL,
    mig_id TEXT NOT NULL, op TEXT NOT NULL, table_name TEXT NOT NULL,
    pk TEXT NOT NULL, before BLOB, after BLOB, ts INTEGER NOT NULL
  )`);
    db.run(`CREATE TABLE _chardb_split_state (
      mig_id TEXT PRIMARY KEY, range_lo INTEGER NOT NULL, range_hi INTEGER NOT NULL,
      role TEXT NOT NULL, capture INTEGER NOT NULL,
      split_log_rows INTEGER NOT NULL DEFAULT 0, split_log_bytes INTEGER NOT NULL DEFAULT 0,
      capture_tx_id INTEGER, capture_tx_rows INTEGER NOT NULL DEFAULT 0,
      capture_tx_bytes INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`CREATE TABLE _chardb_op_log (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, payload_enc BLOB NOT NULL,
      byte_size INTEGER NOT NULL, placement_vshard INTEGER
    )`);
    db.run("INSERT INTO _chardb_split_state VALUES ('mig-1', 0, 16383, 'source', 1, 0, 0, NULL, 0, 0)");
});

afterEach(() => db.close());

function captured(run: () => void, placementVshard = 0): void {
    db.transaction(() => {
        db.run("INSERT INTO _chardb_op_log (payload_enc, byte_size, placement_vshard) VALUES (X'', 0, ?)", [
            placementVshard,
        ]);
        const tx = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
        run();
        db.run("UPDATE _chardb_op_log SET payload_enc = X'01', byte_size = 1 WHERE event_id = ?", [tx]);
    })();
}

describe("renderTableTriggers", () => {
    test("install + uninstall is symmetric and idempotent", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);
        for (const stmt of ts.install) db.run(stmt); // CREATE IF NOT EXISTS → no error
        for (const stmt of ts.uninstall) db.run(stmt);
        for (const stmt of ts.uninstall) db.run(stmt); // DROP IF EXISTS → no error
    });

    test("uses case-insensitive injective names and removes only an exactly owned legacy trigger", () => {
        const hyphen = renderTableTriggers("move-a", ORDERS);
        const underscore = renderTableTriggers("move_a", ORDERS);
        const upper = renderTableTriggers("Move", ORDERS);
        const lower = renderTableTriggers("move", ORDERS);
        expect(new Set([...hyphen.names, ...underscore.names, ...upper.names, ...lower.names]).size).toBe(12);

        const legacyNames = legacyTableTriggerNames("move-a", ORDERS);
        hyphen.install.forEach((statement, index) => {
            const current = hyphen.names[index];
            const legacy = legacyNames[index];
            if (!current || !legacy) throw new Error("expected complete trigger identities");
            db.run(statement.replace(current, legacy));
        });
        expect(uninstallOwnedLegacyTableTriggers(syncSql(db), "move_a", ORDERS)).toBe(0);
        expect(db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()).toEqual({
            count: 3,
        });
        expect(uninstallOwnedLegacyTableTriggers(syncSql(db), "move-a", ORDERS)).toBe(3);
        expect(db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()).toEqual({
            count: 0,
        });
    });

    test("captures inserts and updates as JSON in _chardb_split_log", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);
        captured(() => db.run("INSERT INTO orders (id, tenant_id, total) VALUES (?, ?, ?)", [1, "t-A", 100]));
        captured(() => db.run("UPDATE orders SET total = ? WHERE id = ?", [150, 1]));
        captured(() => db.run("DELETE FROM orders WHERE id = ?", [1]));
        const rows = db.prepare("SELECT op, table_name, pk, after FROM _chardb_split_log ORDER BY lsn").all() as {
            op: string;
            table_name: string;
            pk: string;
            after: string | null;
        }[];
        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({
            op: "ins",
            table_name: "orders",
            pk: "t-A",
            after: '{"id":1,"tenant_id":"t-A","total":100}',
        });
        expect(rows[1]?.op).toBe("upd");
        const afterJson = rows[1]?.after;
        if (afterJson == null) throw new Error("expected the update trigger to capture the resulting row");
        const after = JSON.parse(afterJson) as { total: number };
        expect(after.total).toBe(150);
        expect(rows[2]?.op).toBe("del");
        expect(rows[2]?.after).toBeNull();
    });

    test("rejects a direct domain write without one provisional mutation outcome", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);

        expect(() => db.run("INSERT INTO orders VALUES (1, 'tenant-a', 10)")).toThrow(
            "active reshard capture requires exactly one pending mutation"
        );
        expect(db.query("SELECT * FROM orders").all()).toEqual([]);
        expect(db.query("SELECT * FROM _chardb_split_log").all()).toEqual([]);
    });

    test("tags every row from one source transaction with the same op-log event", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);

        captured(() => {
            db.run("INSERT INTO orders VALUES (1, 'tenant-a', 10)");
            db.run("INSERT INTO orders VALUES (2, 'tenant-a', 20)");
        });

        const rows = db.query("SELECT source_tx_id FROM _chardb_split_log ORDER BY lsn").all() as {
            source_tx_id: number;
        }[];
        expect(rows).toHaveLength(2);
        const first = rows[0];
        if (!first) throw new Error("expected captured split rows");
        expect(new Set(rows.map(row => row.source_tx_id)).size).toBe(1);
        const state = db
            .query("SELECT capture_tx_id, capture_tx_rows, capture_tx_bytes FROM _chardb_split_state")
            .get() as { capture_tx_id: number; capture_tx_rows: number; capture_tx_bytes: number };
        expect(state.capture_tx_id).toBe(first.source_tx_id);
        expect(state.capture_tx_rows).toBe(2);
        const actualTransferBytes = (
            db
                .query(
                    "SELECT source_tx_id, lsn, op, table_name, pk, before, after FROM _chardb_split_log ORDER BY lsn"
                )
                .all() as unknown[]
        ).reduce<number>((bytes, row) => bytes + new TextEncoder().encode(JSON.stringify(row)).byteLength, 0);
        expect(state.capture_tx_bytes).toBeGreaterThanOrEqual(actualTransferBytes);
    });

    test("the transfer budget covers control characters and multibyte partition text", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);
        const tenant = `${"\u0001".repeat(10_000)}\u0000\n"\\é😀`;

        captured(() => db.run("INSERT INTO orders VALUES (1, ?, 10)", [tenant]));

        const row = db
            .query("SELECT source_tx_id, lsn, op, table_name, pk, before, after FROM _chardb_split_log")
            .get();
        const actual = new TextEncoder().encode(JSON.stringify(row)).byteLength;
        const state = db.query("SELECT capture_tx_bytes FROM _chardb_split_state").get() as {
            capture_tx_bytes: number;
        };
        expect(state.capture_tx_bytes).toBeGreaterThanOrEqual(actual);
    });

    test("does not spend split capacity for a routed mutation outside the moving range", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);
        db.run("UPDATE _chardb_split_state SET range_lo = 100, range_hi = 200");

        captured(() => db.run("INSERT INTO orders VALUES (1, 'tenant-a', 10)"), 99);

        expect(db.query("SELECT id FROM orders").all()).toEqual([{ id: 1 }]);
        expect(db.query("SELECT * FROM _chardb_split_log").all()).toEqual([]);
        expect(
            db.query("SELECT split_log_rows, split_log_bytes, capture_tx_id FROM _chardb_split_state").get()
        ).toEqual({ split_log_rows: 0, split_log_bytes: 0, capture_tx_id: null });
    });

    test("rolls back a source transaction that cannot fit one tail RPC", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);

        expect(() =>
            captured(() =>
                db.run(`WITH RECURSIVE n(i) AS (
                  VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 501
                ) INSERT INTO orders SELECT i, 'tenant-a', i FROM n`)
            )
        ).toThrow("source split log capacity reached");
        expect(db.query("SELECT * FROM orders").all()).toEqual([]);
        expect(db.query("SELECT * FROM _chardb_split_log").all()).toEqual([]);
        expect(db.query("SELECT split_log_rows, capture_tx_rows FROM _chardb_split_state").get()).toEqual({
            split_log_rows: 0,
            capture_tx_rows: 0,
        });
    });

    test("captures both sides when an update changes the partition key", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);
        captured(() => db.run("INSERT INTO orders (id, tenant_id, total) VALUES (?, ?, ?)", [1, "t-A", 100]));
        db.run("DELETE FROM _chardb_split_log");

        captured(() => db.run("UPDATE orders SET tenant_id = ? WHERE id = ?", ["t-B", 1]));

        const rows = db.prepare("SELECT op, pk, before, after FROM _chardb_split_log ORDER BY lsn").all() as {
            op: string;
            pk: string;
            before: string | null;
            after: string | null;
        }[];
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({
            op: "del",
            pk: "t-A",
            before: '{"id":1,"tenant_id":"t-A","total":100}',
            after: null,
        });
        expect(rows[1]).toEqual({
            op: "upd",
            pk: "t-B",
            before: '{"id":1,"tenant_id":"t-A","total":100}',
            after: '{"id":1,"tenant_id":"t-B","total":100}',
        });
        expect(db.query("SELECT split_log_rows FROM _chardb_split_state WHERE mig_id = 'mig-1'").get()).toEqual({
            split_log_rows: 3,
        });
    });

    test("rolls back the base write and both partition-move entries at the durable row cap", () => {
        const ts = renderTableTriggers("mig-1", ORDERS, { maxRows: 2, maxBytes: 1_000_000 });
        for (const stmt of ts.install) db.run(stmt);
        captured(() => db.run("INSERT INTO orders VALUES (1, 'tenant-a', 10)"));
        db.run("DELETE FROM _chardb_split_log");
        db.run("UPDATE _chardb_split_state SET split_log_rows = 1, split_log_bytes = 0 WHERE mig_id = 'mig-1'");

        expect(() => captured(() => db.run("UPDATE orders SET tenant_id = 'tenant-b' WHERE id = 1"))).toThrow(
            "source split log capacity reached"
        );
        expect(db.query("SELECT tenant_id FROM orders WHERE id = 1").get()).toEqual({ tenant_id: "tenant-a" });
        expect(db.query("SELECT * FROM _chardb_split_log").all()).toEqual([]);
        expect(
            db.query("SELECT split_log_rows, split_log_bytes FROM _chardb_split_state WHERE mig_id = 'mig-1'").get()
        ).toEqual({ split_log_rows: 1, split_log_bytes: 0 });
    });

    test("admits the exact byte boundary and rejects the next base write atomically", () => {
        const probe = renderTableTriggers("mig-1", ORDERS, { maxRows: 10, maxBytes: 1_000_000 });
        for (const stmt of probe.install) db.run(stmt);
        captured(() => db.run("INSERT INTO orders VALUES (1, 'tenant-a', 10)"));
        const accounted = (
            db.query("SELECT split_log_bytes AS bytes FROM _chardb_split_state WHERE mig_id = 'mig-1'").get() as {
                bytes: number;
            }
        ).bytes;
        for (const stmt of probe.uninstall) db.run(stmt);
        db.run("DELETE FROM orders");
        db.run("DELETE FROM _chardb_split_log");
        db.run("UPDATE _chardb_split_state SET split_log_rows = 0, split_log_bytes = 0 WHERE mig_id = 'mig-1'");

        const bounded = renderTableTriggers("mig-1", ORDERS, { maxRows: 10, maxBytes: accounted });
        for (const stmt of bounded.install) db.run(stmt);
        captured(() => db.run("INSERT INTO orders VALUES (2, 'tenant-a', 10)"));
        expect(
            db.query("SELECT split_log_rows, split_log_bytes FROM _chardb_split_state WHERE mig_id = 'mig-1'").get()
        ).toEqual({ split_log_rows: 1, split_log_bytes: accounted });
        expect(() => captured(() => db.run("INSERT INTO orders VALUES (3, 'tenant-a', 10)"))).toThrow(
            "source split log capacity reached"
        );
        expect(db.query("SELECT id FROM orders ORDER BY id").all()).toEqual([{ id: 2 }]);
    });

    test("rejects identifier-unsafe table names and migIds", () => {
        expect(() => renderTableTriggers("mig 1", ORDERS)).toThrow();
        expect(() => renderTableTriggers("mig-1", { ...ORDERS, name: "drop;" })).toThrow();
    });
});

describe("range filter", () => {
    test("rowVshard matches vshardOf for a scalar partition value", () => {
        expect(rowVshard("tenant-A")).toBe(Number(vshardOf(["tenant-A"])));
        expect(rowVshard(42)).toBe(Number(vshardOf(["42"])));
    });

    test("inRange and filterRowsInRange agree", () => {
        const v = rowVshard("tenant-A");
        expect(inRange("tenant-A", { lo: v, hi: v })).toBe(true);
        expect(inRange("tenant-A", { lo: v + 1, hi: v + 100 })).toBe(false);
        const rows = [
            { tenant_id: "tenant-A", total: 1 },
            { tenant_id: "tenant-B", total: 2 },
        ];
        const all = filterRowsInRange(rows, "tenant_id", { lo: 0, hi: 16383 });
        expect(all).toHaveLength(2);
    });
});
