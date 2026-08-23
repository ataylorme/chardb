/**
 * Coverage for the INSERT auto-fill proxy.
 *
 * The proxy intercepts `db.insert(table).values(row)` against `cdbTable`
 * instances and splices the table's tenant / self columns onto rows
 * that omit them. This file exercises:
 *
 *   - explicit `selfBy` column → filled with `auth.userId`
 *   - explicit `tenantBy` column → filled with `auth.tenantId`
 *   - convention column under `forOrg()` (`organizationId`) → filled
 *     even when no `tenantBy:` is set
 *   - `forUser()` → user FK column filled with `auth.userId`
 *   - explicit values from the caller win over auto-fill
 *   - non-cdbTables pass through unchanged (the proxy never touches
 *     rows targeting a raw `sqliteTable(...)`)
 *   - missing auth field (e.g. `tenantId == null`) leaves the column
 *     missing instead of writing `null`
 *   - array `.values([...])` form is fan-out filled
 *   - other builder methods (`returning`, `onConflictDoNothing`) pass
 *     through after `.values()` is wrapped
 */

import { describe, expect, test } from "bun:test";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { BaseSQLiteDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";
import { forOrg, forUser, wrapDb } from "../../src/server/index.ts";
import type { AuthCtx } from "../../src/server/define.ts";

/**
 * The stub satisfies the surface chardb's proxy actually inspects
 * (`insert(table)` returning a chainable builder) — Drizzle's
 * `BaseSQLiteDatabase` is huge so we cast the stub to the right shape
 * for type compatibility with `wrapDb<TDb extends object>` and
 * `MutationCtx<BaseSQLiteDatabase>`. The cast is sound because no test
 * here exercises any non-`insert` method on the db value.
 */
type StubDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

const orgTable = sqliteTable("organization", { id: text("id").primaryKey() });
const userTable = sqliteTable("user", { id: text("id").primaryKey() });

interface CapturedInsert {
    readonly table: SQLiteTable;
    rows: unknown;
}

/**
 * Minimal stub for the surface the proxy actually inspects: an
 * `insert(table)` method that returns a builder whose `.values(rows)`
 * captures its argument and forwards a chainable `returning()` for the
 * "other methods pass through" case.
 */
function makeStubDb(): { db: StubDb; captured: CapturedInsert[] } {
    const captured: CapturedInsert[] = [];
    const db: unknown = {
        insert(table: SQLiteTable) {
            const entry: CapturedInsert = { table, rows: undefined };
            captured.push(entry);
            const builder = {
                values(rows: unknown) {
                    entry.rows = rows;
                    return builder;
                },
                returning() {
                    return Promise.resolve([]);
                },
                onConflictDoNothing() {
                    return builder;
                },
            };
            return builder;
        },
    };
    return { db: db as StubDb, captured };
}

const baseAuth: AuthCtx = Object.freeze({
    userId: "u-alice",
    tenantId: "org-acme",
    role: "member",
    roles: ["member"],
    claims: {},
});

describe("wrapDb / cdbTable insert auto-fill", () => {
    test("explicit selfBy column is filled from auth.userId", () => {
        const { cdbTable } = forOrg();
        const messages = cdbTable(
            "messages_self_only",
            {
                id: text("id").primaryKey(),
                authorId: text("author_id")
                    .notNull()
                    .references(() => userTable.id),
                body: text("body").notNull(),
            },
            { selfBy: "authorId", roles: { self: { read: "*" } } }
        );

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(messages).values({ id: "m1", body: "hi" });

        expect(captured).toHaveLength(1);
        expect(captured[0]?.rows).toEqual({ id: "m1", body: "hi", authorId: "u-alice" });
    });

    test("forOrg() conventional `organizationId` is filled from auth.tenantId without explicit tenantBy", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable("channels_conv", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            name: text("name").notNull(),
        });

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(channels).values({ id: "c1", name: "general" });

        expect(captured[0]?.rows).toEqual({ id: "c1", name: "general", organizationId: "org-acme" });
    });

    test("explicit tenantBy override is filled from auth.tenantId", () => {
        const { cdbTable } = forOrg();
        const ledger = cdbTable(
            "ledger_explicit",
            {
                id: text("id").primaryKey(),
                primaryOrgId: text("primary_org_id")
                    .notNull()
                    .references(() => orgTable.id),
                shadowOrgId: text("shadow_org_id").references(() => orgTable.id),
                amount: integer("amount").notNull(),
            },
            { tenantBy: "primaryOrgId" }
        );

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(ledger).values({ id: "l1", amount: 100 });

        expect(captured[0]?.rows).toEqual({ id: "l1", amount: 100, primaryOrgId: "org-acme" });
    });

    test("forUser(): user FK column is filled from auth.userId", () => {
        const { cdbTable } = forUser();
        const notes = cdbTable("notes_user", {
            id: text("id").primaryKey(),
            userId: text("user_id")
                .notNull()
                .references(() => userTable.id),
            body: text("body").notNull(),
        });

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(notes).values({ id: "n1", body: "todo" });

        expect(captured[0]?.rows).toEqual({ id: "n1", body: "todo", userId: "u-alice" });
    });

    test("explicit values from the caller win over auto-fill", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable("channels_explicit_wins", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            name: text("name").notNull(),
        });

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(channels).values({ id: "c1", organizationId: "org-other", name: "general" });

        expect(captured[0]?.rows).toEqual({
            id: "c1",
            organizationId: "org-other",
            name: "general",
        });
    });

    test("array .values([...]) form fans out auto-fill across rows", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable("channels_batch", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            name: text("name").notNull(),
        });

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth)
            .insert(channels)
            .values([
                { id: "c1", name: "general" },
                { id: "c2", name: "random", organizationId: "org-override" },
            ]);

        expect(captured[0]?.rows).toEqual([
            { id: "c1", name: "general", organizationId: "org-acme" },
            { id: "c2", name: "random", organizationId: "org-override" },
        ]);
    });

    test("non-cdbTables pass through unchanged", () => {
        const raw = sqliteTable("raw_passthrough", {
            id: text("id").primaryKey(),
            value: text("value").notNull(),
        });

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(raw).values({ id: "r1", value: "noop" });

        expect(captured[0]?.rows).toEqual({ id: "r1", value: "noop" });
    });

    test("missing auth.tenantId leaves convention column unfilled (so DB raises NOT NULL)", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable("channels_no_tenant_id", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            name: text("name").notNull(),
        });

        const anonAuth: AuthCtx = { ...baseAuth, tenantId: undefined };
        const { db, captured } = makeStubDb();
        wrapDb(db, anonAuth).insert(channels).values({ id: "c1", name: "general" });

        expect(captured[0]?.rows).toEqual({ id: "c1", name: "general" });
    });

    test("api.mutation handler receives a wrapped ctx.db (auto-fill happens end-to-end)", async () => {
        const { api } = await import("../../src/server/index.ts");
        const { cdbTable } = forOrg();
        const channels = cdbTable("channels_e2e", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            name: text("name").notNull(),
        });

        const { db, captured } = makeStubDb();
        const create = api.mutation({
            handler: (ctx, args: { id: string; name: string }) => {
                ctx.db.insert(channels).values({ id: args.id, name: args.name });
                return args.id;
            },
        });
        const result = create({ db: db as never, auth: baseAuth }, { id: "c-e2e", name: "general" });
        expect(result).toBe("c-e2e");
        expect(captured[0]?.rows).toEqual({ id: "c-e2e", name: "general", organizationId: "org-acme" });
    });

    test("other builder methods on the wrapped insert pass through (returning / onConflictDoNothing)", async () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable("channels_chain", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            name: text("name").notNull(),
        });

        const { db } = makeStubDb();
        const inserted = wrapDb(db, baseAuth)
            .insert(channels)
            .values({ id: "c1", name: "general" })
            .onConflictDoNothing()
            .returning();
        expect(await inserted).toEqual([]);
    });
});
