import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { filterRowsInRange, inRange, rowVshard } from "../../src/reshard/range.ts";
import { type TableSpec, renderRowApply, renderTableTriggers } from "../../src/reshard/triggers.ts";
import { vshardOf } from "../../src/vshard.ts";

const ORDERS: TableSpec = {
    name: "orders",
    partitionColumn: "tenant_id",
    columns: ["id", "tenant_id", "total"],
};

let db: Database;

beforeEach(() => {
    db = new Database(":memory:");
    db.run(`CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, total INTEGER NOT NULL)`);
    db.run(`CREATE TABLE _chardb_split_log (
    lsn INTEGER PRIMARY KEY AUTOINCREMENT,
    mig_id TEXT NOT NULL, op TEXT NOT NULL, table_name TEXT NOT NULL,
    pk TEXT NOT NULL, before BLOB, after BLOB, ts INTEGER NOT NULL
  )`);
});

afterEach(() => db.close());

describe("renderTableTriggers", () => {
    test("install + uninstall is symmetric and idempotent", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);
        for (const stmt of ts.install) db.run(stmt); // CREATE IF NOT EXISTS → no error
        for (const stmt of ts.uninstall) db.run(stmt);
        for (const stmt of ts.uninstall) db.run(stmt); // DROP IF EXISTS → no error
    });

    test("captures inserts and updates as JSON in _chardb_split_log", () => {
        const ts = renderTableTriggers("mig-1", ORDERS);
        for (const stmt of ts.install) db.run(stmt);
        db.run("INSERT INTO orders (id, tenant_id, total) VALUES (?, ?, ?)", [1, "t-A", 100]);
        db.run("UPDATE orders SET total = ? WHERE id = ?", [150, 1]);
        db.run("DELETE FROM orders WHERE id = ?", [1]);
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
        const after = JSON.parse(rows[1]!.after!) as { total: number };
        expect(after.total).toBe(150);
        expect(rows[2]?.op).toBe("del");
        expect(rows[2]?.after).toBeNull();
    });

    test("rejects identifier-unsafe table names and migIds", () => {
        expect(() => renderTableTriggers("mig 1", ORDERS)).toThrow();
        expect(() => renderTableTriggers("mig-1", { ...ORDERS, name: "drop;" })).toThrow();
    });
});

describe("renderRowApply", () => {
    test("renders parameterized INSERT OR REPLACE in column order", () => {
        const { sql, params } = renderRowApply(ORDERS, { id: 9, tenant_id: "t-X", total: 42 });
        expect(sql).toBe('INSERT OR REPLACE INTO "orders" ("id", "tenant_id", "total") VALUES (?, ?, ?)');
        expect(params).toEqual([9, "t-X", 42]);
    });

    test("backfills missing columns with null", () => {
        const { params } = renderRowApply(ORDERS, { id: 1 });
        expect(params).toEqual([1, null, null]);
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
