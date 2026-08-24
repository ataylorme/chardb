/**
 * Coverage for the `auth/runtime.ts` binding + `auth/sql.ts` rendering
 * path. These tests run the SQL helpers against bun:sqlite via a
 * `SyncSql`-shaped adapter and exercise the epoch-scope metadata that
 * successful Catalog writes use for invalidation.
 */

import { Database as BunSqlite } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { organization } from "better-auth/plugins/organization";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
    type AuthPartitionRule,
    bindAuthRuntime,
    placementFor,
    resetAuthRuntime,
    tableFor,
} from "../../src/auth/runtime.ts";
import {
    AUTH_BULK_PRELOAD_MAX_ROWS,
    AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES,
    AUTH_BULK_REPLACEMENT_MAX_BYTES,
    assertAuthIncrementInput,
    authCount,
    authCreate,
    authDelete,
    authFindFirstId,
    authFindFirstIncrementId,
    authFindMany,
    authFindOne,
    authIncrementOne,
    authPreloadScopeRows,
    authTableColumns,
    authTableName,
    authUpdate,
} from "../../src/auth/sql.ts";
import { defineAuth } from "../../src/auth/synthesize.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import type { RawJson } from "../../src/types.ts";

function bunSyncSql(db: BunSqlite, statements: string[] = []): SyncSql {
    return {
        exec(sql, ...params) {
            statements.push(sql);
            db.query(sql).run(...(params as never[]));
        },
        one<T>(sql: string, ...params: never[]): T | null {
            statements.push(sql);
            return db.query(sql).get(...params) as T | null;
        },
        all<T>(sql: string, ...params: never[]): T[] {
            statements.push(sql);
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

describe("auth/runtime — epoch scope", () => {
    test("core models identify their canonical principal scope", () => {
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

    test("organization plugin models identify their tenant scope", () => {
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
        const colDDL = [...cfg.entries()].map(([_, sqlName]) => `"${sqlName}" TEXT`).join(", ");
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

    test("findMany maps sort fields to renamed SQL columns", () => {
        const { sql } = bootstrap();
        const renamed = sqliteTable("renamed_auth", {
            id: text("auth_id"),
            displayName: text("display_name"),
        });
        sql.exec('CREATE TABLE "renamed_auth" ("auth_id" TEXT, "display_name" TEXT)');
        for (const [id, displayName] of [
            ["d", "Delta"],
            ["a", "Alpha"],
            ["c", "Charlie"],
            ["b", "Bravo"],
        ] as const) {
            authCreate(sql, renamed, { id, displayName });
        }

        expect(
            authFindMany(sql, renamed, {}, 2, 1, { field: "displayName", direction: "asc" }).map(row => row.displayName)
        ).toEqual(["Bravo", "Charlie"]);
        expect(
            authFindMany(sql, renamed, {}, 2, 1, { field: "displayName", direction: "desc" }).map(
                row => row.displayName
            )
        ).toEqual(["Charlie", "Bravo"]);
    });

    test("selects one deterministic schema-mapped auth id without materializing full rows", () => {
        const { db } = bootstrap();
        const statements: string[] = [];
        const sql = bunSyncSql(db, statements);
        const renamed = sqliteTable("single_auth_target", {
            id: text("db_id"),
            group: text("group_name"),
            wide: text("wide_payload"),
        });
        sql.exec(
            'CREATE TABLE "single_auth_target" ("db_id" TEXT PRIMARY KEY, "group_name" TEXT, "wide_payload" TEXT)'
        );
        const insert = db.prepare(
            'INSERT INTO "single_auth_target" ("db_id", "group_name", "wide_payload") VALUES (?, ?, ?)'
        );
        for (const id of ["target-c", "target-a", "target-b"]) insert.run(id, "shared", "w".repeat(1_024 * 1_024));
        statements.length = 0;

        expect(authFindFirstId(sql, renamed, { group: "shared" })).toBe("target-a");
        expect(statements).toHaveLength(1);
        expect(statements[0]).toContain('SELECT "db_id" AS auth_target_id');
        expect(statements[0]).toContain('ORDER BY "db_id" ASC');
        expect(statements[0]).toContain("LIMIT 1");
        expect(statements[0]).not.toContain("wide_payload");
        expect(statements[0]).not.toContain("SELECT *");
    });

    test("atomically increments the deterministic guarded row through renamed columns", () => {
        const { db } = bootstrap();
        const statements: string[] = [];
        const sql = bunSyncSql(db, statements);
        const renamed = sqliteTable("increment_auth_target", {
            id: text("db_id").primaryKey(),
            bucket: text("bucket_name"),
            count: integer("request_count"),
            lastRequest: integer("last_request"),
            marker: text("nullable_marker"),
        });
        sql.exec(
            'CREATE TABLE "increment_auth_target" ("db_id" TEXT PRIMARY KEY, "bucket_name" TEXT, "request_count" INTEGER, "last_request" INTEGER, "nullable_marker" TEXT)'
        );
        for (const id of ["target-c", "target-a", "target-b"]) {
            authCreate(sql, renamed, { id, bucket: "shared", count: 1, lastRequest: 100, marker: null });
        }
        const guards = [
            { field: "bucket", operator: "eq" as const, value: "shared" },
            { field: "count", operator: "lt" as const, value: 2 },
            { field: "lastRequest", operator: "gte" as const, value: 100 },
        ];
        statements.length = 0;

        expect(authFindFirstIncrementId(sql, renamed, guards)).toBe("target-a");
        expect(
            authIncrementOne(sql, renamed, "target-a", guards, { count: 1 }, { lastRequest: 200 }).row
        ).toMatchObject({
            id: "target-a",
            count: 2,
            lastRequest: 200,
        });
        expect(
            authIncrementOne(sql, renamed, "target-b", [{ field: "marker", operator: "eq", value: null }], {
                count: 1,
            }).row
        ).toMatchObject({ id: "target-b", count: 2 });
        expect(
            authIncrementOne(sql, renamed, "target-c", [{ field: "count", operator: "gt", value: 100 }], { count: 1 })
        ).toEqual({ affected: 0, row: null });
        expect(statements.some(statement => statement.includes('ORDER BY "db_id" ASC'))).toBe(true);
        expect(
            statements.some(
                statement =>
                    statement.includes('UPDATE "increment_auth_target"') &&
                    statement.includes('"request_count" = COALESCE("request_count", 0) + ?') &&
                    statement.includes('"last_request" = ?')
            )
        ).toBe(true);

        statements.length = 0;
        expect(() => assertAuthIncrementInput(renamed, guards, { missing: 1 })).toThrow(/not a column/);
        expect(() => assertAuthIncrementInput(renamed, guards, { count: Number.NaN })).toThrow(/must be finite/);
        expect(() =>
            assertAuthIncrementInput(renamed, [{ field: "count", operator: "contains" as never, value: 1 }], {
                count: 1,
            })
        ).toThrow(/operator.*not supported/);
        expect(statements).toEqual([]);
    });

    test("findMany rejects invalid paging and sorting", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const { sql } = bootstrap();
        const t = tableFor("user");
        const cfg = authTableColumns(t);
        const colDDL = [...cfg.entries()].map(([_, n]) => `"${n}" TEXT`).join(", ");
        sql.exec(`CREATE TABLE "user" (${colDDL})`);

        expect(() => authFindMany(sql, t, {}, -1)).toThrow(/limit must be a non-negative safe integer/);
        expect(() => authFindMany(sql, t, {}, 1.5)).toThrow(/limit must be a non-negative safe integer/);
        expect(() => authFindMany(sql, t, {}, 1, -1)).toThrow(/offset must be a non-negative safe integer/);
        expect(() => authFindMany(sql, t, {}, 1, 0, { field: "missing", direction: "asc" })).toThrow(
            /sort field "missing" is not a column/
        );
        expect(() => authFindMany(sql, t, {}, 1, 0, { field: "name", direction: "sideways" } as never)).toThrow(
            /invalid sort direction/
        );
    });

    test("bulk scope preload accepts exactly 4096 rows and rejects the next row", () => {
        const { db } = bootstrap();
        const statements: string[] = [];
        const sql = bunSyncSql(db, statements);
        const scoped = sqliteTable("bulk_scope_rows", { id: text("scope_id") });
        sql.exec('CREATE TABLE "bulk_scope_rows" ("scope_id" TEXT PRIMARY KEY)');
        const insert = db.prepare('INSERT INTO "bulk_scope_rows" ("scope_id") VALUES (?)');
        db.transaction(() => {
            for (let index = 0; index < AUTH_BULK_PRELOAD_MAX_ROWS; index++) insert.run(`scope-${index}`);
        })();

        const exact = authPreloadScopeRows(sql, scoped, {}, ["id"]);
        expect(exact.matchedRows).toBe(AUTH_BULK_PRELOAD_MAX_ROWS);
        expect(exact.rows).toHaveLength(AUTH_BULK_PRELOAD_MAX_ROWS);

        insert.run("scope-over");
        expect(() => authPreloadScopeRows(sql, scoped, {}, ["id"])).toThrow(
            new RegExp(`${AUTH_BULK_PRELOAD_MAX_ROWS}-row preload limit`)
        );
    });

    test("bulk scope preload maps renamed columns, ignores wide fields, and enforces exact stored bytes", () => {
        const { db } = bootstrap();
        const statements: string[] = [];
        const sql = bunSyncSql(db, statements);
        const scoped = sqliteTable("bulk_scope_bytes", {
            id: text("db_id"),
            organizationId: text("org_id"),
            wide: text("wide_payload"),
        });
        sql.exec('CREATE TABLE "bulk_scope_bytes" ("db_id" TEXT PRIMARY KEY, "org_id" TEXT, "wide_payload" TEXT)');
        const insert = db.prepare(
            'INSERT INTO "bulk_scope_bytes" ("db_id", "org_id", "wide_payload") VALUES (?, ?, ?)'
        );
        insert.run("a", "o".repeat(AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES - 1), "w".repeat(1_024 * 1_024));
        statements.length = 0;

        const exact = authPreloadScopeRows(sql, scoped, {}, ["id", "organizationId"]);
        expect(exact.scopeBytes).toBe(AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES);
        expect(exact.rows).toEqual([{ id: "a", organizationId: "o".repeat(AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES - 1) }]);
        expect(statements.every(statement => !statement.includes("wide_payload"))).toBe(true);
        expect(statements.some(statement => statement.includes('typeof("db_id")'))).toBe(true);
        expect(statements.some(statement => statement.includes('typeof("org_id")'))).toBe(true);

        db.exec('DELETE FROM "bulk_scope_bytes"');
        insert.run("x".repeat(AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES + 1), null, "wide");
        expect(() => authPreloadScopeRows(sql, scoped, {}, ["id"])).toThrow(
            new RegExp(`${AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES}-scope-byte preload limit`)
        );

        db.exec('DELETE FROM "bulk_scope_bytes"');
        insert.run("a", null, "wide");
        expect(() =>
            authPreloadScopeRows(sql, scoped, {}, ["id"], ["n".repeat(AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES)])
        ).toThrow(new RegExp(`${AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES}-scope-byte preload limit`));
    });

    test("bulk preload caps expanded text, JSON, binary, and scalar replacements", () => {
        const { db } = bootstrap();
        const sql = bunSyncSql(db);
        const replacements = sqliteTable("bulk_replacements", {
            id: text("id"),
            textValue: text("text_value"),
            jsonValue: text("json_value", { mode: "json" }),
            binaryValue: blob("binary_value"),
            numberValue: integer("number_value"),
            nullableValue: text("nullable_value"),
        });
        sql.exec(
            'CREATE TABLE "bulk_replacements" ("id" TEXT PRIMARY KEY, "text_value" TEXT, "json_value" TEXT, "binary_value" BLOB, "number_value" INTEGER, "nullable_value" TEXT)'
        );
        sql.exec('INSERT INTO "bulk_replacements" ("id") VALUES (?)', "one");

        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                textValue: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES),
            })
        ).not.toThrow();
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                textValue: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES + 1),
            })
        ).toThrow(new RegExp(`${AUTH_BULK_REPLACEMENT_MAX_BYTES}-expanded-replacement-byte preload limit`));
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                textValue: "é".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES / 2),
            })
        ).not.toThrow();
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                textValue: "é".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES / 2 + 1),
            })
        ).toThrow(new RegExp(`${AUTH_BULK_REPLACEMENT_MAX_BYTES}-expanded-replacement-byte preload limit`));

        const emptyJsonBytes = JSON.stringify({ value: "" }).length;
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                jsonValue: { value: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES - emptyJsonBytes) },
            })
        ).not.toThrow();
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                jsonValue: { value: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES - emptyJsonBytes + 1) },
            })
        ).toThrow(new RegExp(`${AUTH_BULK_REPLACEMENT_MAX_BYTES}-expanded-replacement-byte preload limit`));
        const emptyArrayBytes = JSON.stringify([""]).length;
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                jsonValue: ["x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES - emptyArrayBytes)],
            })
        ).not.toThrow();

        const exactMixed = {
            binaryValue: new Uint8Array(AUTH_BULK_REPLACEMENT_MAX_BYTES - 8),
            numberValue: 42,
            nullableValue: null,
        } as unknown as Record<string, RawJson>;
        expect(() => authPreloadScopeRows(sql, replacements, {}, ["id"], [], exactMixed)).not.toThrow();
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                ...exactMixed,
                binaryValue: new Uint8Array(AUTH_BULK_REPLACEMENT_MAX_BYTES - 7),
            } as unknown as Record<string, RawJson>)
        ).toThrow(new RegExp(`${AUTH_BULK_REPLACEMENT_MAX_BYTES}-expanded-replacement-byte preload limit`));
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                unknown: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES + 1),
            })
        ).not.toThrow();
        expect(() =>
            authPreloadScopeRows(sql, replacements, { id: "missing" }, ["id"], [], {
                textValue: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES + 1),
            })
        ).not.toThrow();
    });

    test("bulk replacement budget multiplies each bound value by matched rows", () => {
        const { db } = bootstrap();
        const sql = bunSyncSql(db);
        const replacements = sqliteTable("bulk_replacement_rows", {
            id: text("id"),
            value: text("value"),
        });
        sql.exec('CREATE TABLE "bulk_replacement_rows" ("id" TEXT PRIMARY KEY, "value" TEXT)');
        sql.exec('INSERT INTO "bulk_replacement_rows" ("id") VALUES (?), (?)', "one", "two");

        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                value: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES / 2),
            })
        ).not.toThrow();
        expect(() =>
            authPreloadScopeRows(sql, replacements, {}, ["id"], [], {
                value: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES / 2 + 1),
            })
        ).toThrow(new RegExp(`${AUTH_BULK_REPLACEMENT_MAX_BYTES}-expanded-replacement-byte preload limit`));
    });

    test("rejects where keys that are not columns", () => {
        resetAuthRuntime();
        bindAuthRuntime({ schema: defineAuth({ plugins: [] }) as never, options: {} });
        const { sql } = bootstrap();
        const t = tableFor("user");
        const cfg = authTableColumns(t);
        const colDDL = [...cfg.entries()].map(([_, n]) => `"${n}" TEXT`).join(", ");
        sql.exec(`CREATE TABLE "user" (${colDDL})`);
        expect(() => authFindOne(sql, t, { notAColumn: "x" } as never)).toThrow(/not a column/);
    });
});

void ({} as AuthPartitionRule);
