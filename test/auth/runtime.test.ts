/**
 * Coverage for the `auth/runtime.ts` binding + `auth/sql.ts` rendering
 * path. The Cdb DO can't be exercised in bun without workerd, so these
 * tests run the SQL helpers against bun:sqlite via a `SyncSql`-shaped
 * adapter — verifying the SQL we'd emit on a real shard is correct.
 */

import { Database as BunSqlite } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { organization } from "better-auth/plugins/organization";
import {
    authCount,
    authCreate,
    authDelete,
    authFindMany,
    authFindOne,
    authTableColumns,
    authTableName,
    authUpdate,
} from "../../src/auth/sql.ts";
import { defineAuth } from "../../src/auth/synthesize.ts";
import {
    type AuthPartitionRule,
    bindAuthRuntime,
    placementFor,
    resetAuthRuntime,
    tableFor,
} from "../../src/auth/runtime.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";

function bunSyncSql(db: BunSqlite): SyncSql {
    return {
        exec(sql, ...params) {
            db.query(sql).run(...(params as never[]));
        },
        one<T>(sql: string, ...params: never[]): T | null {
            return db.query(sql).get(...params) as T | null;
        },
        all<T>(sql: string, ...params: never[]): T[] {
            return db.query(sql).all(...params) as T[];
        },
        changes() {
            const row = db.query("SELECT changes() AS c").get() as { c: number } | null;
            return row?.c ?? 0;
        },
    };
}

function bootstrap(): { db: BunSqlite; sql: SyncSql } {
    const db = new BunSqlite(":memory:");
    return { db, sql: bunSyncSql(db) };
}

describe("auth/runtime — partition placement", () => {
    test("core models route to their canonical partition", () => {
        resetAuthRuntime();
        bindAuthRuntime({
            schema: defineAuth({ plugins: [] }) as never,
            options: {},
        });
        expect(placementFor("user")).toEqual({ kind: "principal", column: "id" });
        expect(placementFor("session")).toEqual({ kind: "principal", column: "userId" });
        expect(placementFor("account")).toEqual({ kind: "principal", column: "userId" });
        expect(placementFor("verification")).toEqual({ kind: "principal", column: "userId" });
    });

    test("organization plugin models route to tenant", () => {
        resetAuthRuntime();
        bindAuthRuntime({
            schema: defineAuth({ plugins: [organization()] }) as never,
            options: {},
        });
        expect(placementFor("organization")).toEqual({ kind: "tenant", column: "id" });
        expect(placementFor("member")).toEqual({ kind: "tenant", column: "organizationId" });
        expect(placementFor("invitation")).toEqual({ kind: "tenant", column: "organizationId" });
    });

    test("tableFor returns the synthesized Drizzle table", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const t = tableFor("user");
        expect(authTableName(t)).toBe("user");
        const cols = authTableColumns(t);
        expect(cols.has("id")).toBe(true);
        expect(cols.has("email")).toBe(true);
    });
});

describe("auth/sql — render path against bun:sqlite", () => {
    test("create then findOne round-trips a row", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const { sql } = bootstrap();
        const t = tableFor("user");
        const cfg = authTableColumns(t);
        const colDDL = [...cfg.entries()]
            .map(([_, sqlName]) => `"${sqlName}" TEXT`)
            .join(", ");
        sql.exec(`CREATE TABLE "user" (${colDDL})`);

        authCreate(sql, t, { id: "u1", email: "a@b.com", name: "A", emailVerified: false });
        const found = authFindOne(sql, t, { id: "u1" });
        expect(found?.email).toBe("a@b.com");
    });

    test("update mutates and returns the merged row", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const { sql } = bootstrap();
        const t = tableFor("user");
        const cfg = authTableColumns(t);
        const colDDL = [...cfg.entries()].map(([_, n]) => `"${n}" TEXT`).join(", ");
        sql.exec(`CREATE TABLE "user" (${colDDL})`);
        authCreate(sql, t, { id: "u2", email: "x@y.com" });
        const r = authUpdate(sql, t, { id: "u2" }, { email: "z@y.com" });
        expect(r.row?.email).toBe("z@y.com");
    });

    test("delete reports affected count", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const { sql } = bootstrap();
        const t = tableFor("user");
        const cfg = authTableColumns(t);
        const colDDL = [...cfg.entries()].map(([_, n]) => `"${n}" TEXT`).join(", ");
        sql.exec(`CREATE TABLE "user" (${colDDL})`);
        authCreate(sql, t, { id: "u3" });
        const r = authDelete(sql, t, { id: "u3" });
        expect(r.affected).toBe(1);
    });

    test("findMany and count agree on row counts", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const { sql } = bootstrap();
        const t = tableFor("user");
        const cfg = authTableColumns(t);
        const colDDL = [...cfg.entries()].map(([_, n]) => `"${n}" TEXT`).join(", ");
        sql.exec(`CREATE TABLE "user" (${colDDL})`);
        for (let i = 0; i < 5; i++) authCreate(sql, t, { id: `u${i}`, name: "x" });
        expect(authFindMany(sql, t, { name: "x" }).length).toBe(5);
        expect(authCount(sql, t, { name: "x" })).toBe(5);
    });

    test("rejects where keys that are not columns", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const { sql } = bootstrap();
        const t = tableFor("user");
        const cfg = authTableColumns(t);
        const colDDL = [...cfg.entries()].map(([_, n]) => `"${n}" TEXT`).join(", ");
        sql.exec(`CREATE TABLE "user" (${colDDL})`);
        expect(() => authFindOne(sql, t, { notAColumn: "x" } as never)).toThrow(
            /not a column/
        );
    });
});

void ({} as AuthPartitionRule);
