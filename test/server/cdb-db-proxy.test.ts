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
 *   - matching explicit identity values pass; conflicts fail closed
 *   - non-cdbTables pass through unchanged (the proxy never touches
 *     rows targeting a raw `sqliteTable(...)`)
 *   - missing tenant/user authority rejects even caller-supplied values
 *   - array `.values([...])` validates every row before forwarding
 *   - other builder methods (`returning`, `onConflictDoNothing`) pass
 *     through after `.values()` is wrapped
 */

import { describe, expect, test } from "bun:test";
import { type SQL, eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BaseSQLiteDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../../src/errors.ts";
import type { RoleValue } from "../../src/server/cdb-table-types.ts";
import type { AuthCtx } from "../../src/server/define.ts";
import { forOrg, forUser, wrapDb } from "../../src/server/index.ts";

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

interface CapturedUpdate {
    readonly table: SQLiteTable;
    values: unknown;
    where: unknown;
}

/**
 * Minimal stub for the surface the proxy actually inspects: an
 * `insert(table)` method that returns a builder whose `.values(rows)`
 * captures its argument and forwards a chainable `returning()` for the
 * "other methods pass through" case.
 */
function makeStubDb(): { db: StubDb; captured: CapturedInsert[]; capturedUpdates: CapturedUpdate[] } {
    const captured: CapturedInsert[] = [];
    const capturedUpdates: CapturedUpdate[] = [];
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
        update(table: SQLiteTable) {
            const entry: CapturedUpdate = { table, values: undefined, where: undefined };
            capturedUpdates.push(entry);
            const builder = {
                set(values: unknown) {
                    entry.values = values;
                    return builder;
                },
                where(where: unknown) {
                    entry.where = where;
                    return builder;
                },
                returning() {
                    return Promise.resolve([]);
                },
                run() {
                    return { changes: 0 };
                },
            };
            return builder;
        },
    };
    return { db: db as StubDb, captured, capturedUpdates };
}

const baseAuth: AuthCtx = Object.freeze({
    userId: "u-alice",
    tenantId: "org-acme",
    role: "member",
    roles: ["member"],
    claims: {},
});

function expectForbidden(run: () => unknown): void {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(CdbError);
    expect((caught as CdbError).code).toBe("CDB_FORBIDDEN");
}

function forbiddenError(run: () => unknown): CdbError {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(CdbError);
    const cdbError = caught as CdbError;
    expect(cdbError.code).toBe("CDB_FORBIDDEN");
    return cdbError;
}

function renderSql(value: unknown) {
    return (value as SQL).toQuery({
        casing: { getColumnCasing: (column: { readonly name: string }) => column.name } as never,
        escapeName: (name: string) => `"${name}"`,
        escapeParam: (index: number) => `?${index + 1}`,
        escapeString: (value: string) => `'${value}'`,
    } as never);
}

describe("wrapDb / cdbTable insert auto-fill", () => {
    test("explicit selfBy column is filled from auth.userId", () => {
        const { cdbTable } = forOrg();
        const messages = cdbTable(
            "messages_self_only",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                authorId: text("author_id")
                    .notNull()
                    .references(() => userTable.id),
                body: text("body").notNull(),
            },
            { selfBy: "authorId", roles: { self: { create: ["id", "body"] } } }
        );

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(messages).values({ id: "m1", body: "hi" });

        expect(captured).toHaveLength(1);
        expect(captured[0]?.rows).toEqual({
            id: "m1",
            body: "hi",
            authorId: "u-alice",
            organizationId: "org-acme",
        });
    });

    test("selfBy accepts the verified user and rejects a conflicting explicit owner", () => {
        const { cdbTable } = forOrg();
        const messages = cdbTable(
            "messages_self_explicit",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                authorId: text("author_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { selfBy: "authorId", roles: { self: { create: "*" } } }
        );

        const matching = makeStubDb();
        wrapDb(matching.db, baseAuth).insert(messages).values({ id: "m1", authorId: "u-alice" });
        expect(matching.captured[0]?.rows).toEqual({
            id: "m1",
            authorId: "u-alice",
            organizationId: "org-acme",
        });

        const conflicting = makeStubDb();
        expectForbidden(() =>
            wrapDb(conflicting.db, baseAuth).insert(messages).values({ id: "m2", authorId: "u-mallory" })
        );
        expect(conflicting.captured[0]?.rows).toBeUndefined();
    });

    test("forOrg() conventional `organizationId` is filled from auth.tenantId without explicit tenantBy", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable(
            "channels_conv",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            { roles: { member: { create: "*" } } }
        );

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
            { tenantBy: "primaryOrgId", roles: { member: { create: "*" } } }
        );

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(ledger).values({ id: "l1", amount: 100 });

        expect(captured[0]?.rows).toEqual({ id: "l1", amount: 100, primaryOrgId: "org-acme" });
    });

    test("forUser(): user FK column is filled from auth.userId", () => {
        const { cdbTable } = forUser();
        const notes = cdbTable(
            "notes_user",
            {
                id: text("id").primaryKey(),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
                body: text("body").notNull(),
            },
            { roles: { member: { create: "*" } } }
        );

        const { db, captured } = makeStubDb();
        wrapDb(db, baseAuth).insert(notes).values({ id: "n1", body: "todo" });

        expect(captured[0]?.rows).toEqual({ id: "n1", body: "todo", userId: "u-alice" });
    });

    test("user tenancy rejects conflicting values and missing verified user authority", () => {
        const { cdbTable } = forUser();
        const notes = cdbTable(
            "notes_user_authority",
            {
                id: text("id").primaryKey(),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { roles: { member: { create: "*" } } }
        );

        const conflicting = makeStubDb();
        expectForbidden(() => wrapDb(conflicting.db, baseAuth).insert(notes).values({ id: "n1", userId: "u-mallory" }));
        expect(conflicting.captured[0]?.rows).toBeUndefined();

        const missing = makeStubDb();
        expectForbidden(() =>
            wrapDb(missing.db, { ...baseAuth, userId: "" })
                .insert(notes)
                .values({ id: "n2", userId: "u-alice" })
        );
        expect(missing.captured).toHaveLength(0);
    });

    test("org tenancy accepts a matching explicit value and rejects a conflict", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable(
            "channels_explicit_wins",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            { roles: { member: { create: "*" } } }
        );

        const matching = makeStubDb();
        wrapDb(matching.db, baseAuth)
            .insert(channels)
            .values({ id: "c1", organizationId: "org-acme", name: "general" });
        expect(matching.captured[0]?.rows).toEqual({
            id: "c1",
            organizationId: "org-acme",
            name: "general",
        });

        const conflicting = makeStubDb();
        expectForbidden(() =>
            wrapDb(conflicting.db, baseAuth)
                .insert(channels)
                .values({ id: "c2", organizationId: "org-other", name: "private" })
        );
        expect(conflicting.captured[0]?.rows).toBeUndefined();
    });

    test("array .values([...]) validates every row before forwarding", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable(
            "channels_batch",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            { roles: { member: { create: "*" } } }
        );

        const matching = makeStubDb();
        wrapDb(matching.db, baseAuth)
            .insert(channels)
            .values([
                { id: "c1", name: "general" },
                { id: "c2", name: "random", organizationId: "org-acme" },
            ]);
        expect(matching.captured[0]?.rows).toEqual([
            { id: "c1", name: "general", organizationId: "org-acme" },
            { id: "c2", name: "random", organizationId: "org-acme" },
        ]);

        const conflicting = makeStubDb();
        expectForbidden(() =>
            wrapDb(conflicting.db, baseAuth)
                .insert(channels)
                .values([
                    { id: "c3", name: "first" },
                    { id: "c4", name: "second", organizationId: "org-other" },
                ])
        );
        expect(conflicting.captured[0]?.rows).toBeUndefined();
    });

    test("denies create when no role or self grant applies", () => {
        const { cdbTable } = forOrg();
        const privateRows = cdbTable(
            "private_rows_no_create",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            { roles: { member: { read: "*" } } }
        );
        const denied = makeStubDb();
        const error = forbiddenError(() => wrapDb(denied.db, baseAuth).insert(privateRows).values({ id: "p1" }));
        expect(error.message).toBe("private_rows_no_create: caller has no applicable create grant");
        expect(denied.captured[0]?.rows).toBeUndefined();
    });

    test("ORs alternative role grants and enforces snake_case create columns", () => {
        const { cdbTable } = forOrg();
        const profiles = cdbTable(
            "profiles_create_columns",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                displayName: text("display_name").notNull(),
                secretNote: text("secret_note"),
            },
            {
                roles: {
                    admin: { create: ["id", "secretNote"] },
                    member: { create: ["id", "displayName"] },
                },
            }
        );

        const allowed = makeStubDb();
        wrapDb(allowed.db, baseAuth)
            .insert(profiles)
            .values({ id: "profile-1", organizationId: "org-acme", displayName: "Ada" });
        expect(allowed.captured[0]?.rows).toEqual({
            id: "profile-1",
            displayName: "Ada",
            organizationId: "org-acme",
        });

        const denied = makeStubDb();
        const error = forbiddenError(() =>
            wrapDb(denied.db, baseAuth)
                .insert(profiles)
                .values({ id: "profile-2", displayName: "Mallory", secretNote: "forbidden" })
        );
        expect(error.message).toBe('profiles_create_columns: caller is not authorized to create column "secret_note"');
        expect(denied.captured[0]?.rows).toBeUndefined();
    });

    test("a forbidden column in any batch row rejects the whole values call", () => {
        const { cdbTable } = forOrg();
        const profiles = cdbTable(
            "profiles_create_batch",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                displayName: text("display_name").notNull(),
                secretNote: text("secret_note"),
            },
            { roles: { member: { create: ["id", "displayName"] } } }
        );
        const denied = makeStubDb();
        const error = forbiddenError(() =>
            wrapDb(denied.db, baseAuth)
                .insert(profiles)
                .values([
                    { id: "profile-1", displayName: "Allowed" },
                    { id: "profile-2", displayName: "Denied", secretNote: "forbidden" },
                ])
        );
        expect(error.message).toBe('profiles_create_batch: caller is not authorized to create column "secret_note"');
        expect(denied.captured[0]?.rows).toBeUndefined();
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

    test("missing org authority rejects even an explicitly supplied tenant", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable(
            "channels_no_tenant_id",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            { roles: { member: { create: "*" } } }
        );

        const anonAuth: AuthCtx = { ...baseAuth, tenantId: undefined };
        const { db, captured } = makeStubDb();
        expectForbidden(() =>
            wrapDb(db, anonAuth).insert(channels).values({ id: "c1", organizationId: "org-acme", name: "general" })
        );
        expect(captured).toHaveLength(0);
    });

    test("api.mutation handler receives a wrapped ctx.db (auto-fill happens end-to-end)", async () => {
        const { api } = await import("../../src/server/index.ts");
        const { cdbTable } = forOrg();
        const channels = cdbTable(
            "channels_e2e",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            { roles: { member: { create: "*" } } }
        );

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
        const channels = cdbTable(
            "channels_chain",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            { roles: { member: { create: "*" } } }
        );

        const { db } = makeStubDb();
        const inserted = wrapDb(db, baseAuth)
            .insert(channels)
            .values({ id: "c1", name: "general" })
            .onConflictDoNothing()
            .returning();
        expect(await inserted).toEqual([]);
    });
});

describe("wrapDb / cdbTable update authorization", () => {
    type ProfileColumns = {
        readonly id: unknown;
        readonly organizationId: unknown;
        readonly displayName: unknown;
        readonly secretNote: unknown;
    };

    function profileTable(
        name: string,
        roles: {
            readonly admin?: RoleValue<ProfileColumns>;
            readonly member?: RoleValue<ProfileColumns>;
        }
    ) {
        const { cdbTable } = forOrg();
        return cdbTable(
            name,
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                displayName: text("display_name").notNull(),
                secretNote: text("secret_note"),
            },
            { roles }
        );
    }

    test("denies update when no applicable grant exists", () => {
        const profiles = profileTable("profiles_update_denied", { member: { read: "*" } });
        const { db, capturedUpdates } = makeStubDb();
        const error = forbiddenError(() => wrapDb(db, baseAuth).update(profiles));
        expect(error.message).toBe("profiles_update_denied: caller has no applicable update grant");
        expect(capturedUpdates).toHaveLength(0);
    });

    test("allows a member column and installs the tenant floor without a user WHERE", () => {
        const profiles = profileTable("profiles_update_no_where", {
            member: { update: ["displayName"] },
        });
        const { db, capturedUpdates } = makeStubDb();
        wrapDb(db, baseAuth).update(profiles).set({ displayName: "Updated" }).run();

        expect(capturedUpdates[0]?.values).toEqual({ displayName: "Updated" });
        const scoped = renderSql(capturedUpdates[0]?.where);
        expect(scoped.params).toContain("org-acme");
        expect(scoped.sql).toContain("organization_id");
    });

    test("ANDs a hostile tenant WHERE with the server tenant floor", () => {
        const profiles = profileTable("profiles_update_tenant_floor", {
            member: { update: ["displayName"] },
        });
        const { db, capturedUpdates } = makeStubDb();
        wrapDb(db, baseAuth)
            .update(profiles)
            .set({ displayName: "Wrong tenant" })
            .where(eq(profiles.organizationId, "org-other"))
            .run();

        const scoped = renderSql(capturedUpdates[0]?.where);
        expect(scoped.params).toContain("org-other");
        expect(scoped.params).toContain("org-acme");
        expect(scoped.sql.toLowerCase()).toContain(" and ");
    });

    test("rejects a column outside the caller's update grant", () => {
        const profiles = profileTable("profiles_update_columns", {
            member: { update: ["displayName"] },
        });
        const { db, capturedUpdates } = makeStubDb();
        const error = forbiddenError(() => wrapDb(db, baseAuth).update(profiles).set({ secretNote: "not allowed" }));
        expect(error.message).toBe('profiles_update_columns: caller is not authorized to update column "secret_note"');
        expect(capturedUpdates[0]?.values).toBeUndefined();
    });

    test("ORs alternative role grants for update", () => {
        const profiles = profileTable("profiles_update_roles", {
            admin: { update: ["secretNote"] },
            member: { update: ["displayName"] },
        });
        const { db, capturedUpdates } = makeStubDb();
        wrapDb(db, baseAuth).update(profiles).set({ displayName: "Member edit" }).run();
        expect(capturedUpdates[0]?.values).toEqual({ displayName: "Member edit" });
        expect(renderSql(capturedUpdates[0]?.where).sql.toLowerCase()).toContain(" or ");
    });

    test("rejects every attempt to update tenant authority columns", () => {
        const profiles = profileTable("profiles_update_tenant_column", {
            member: { update: "*" },
        });
        const { db, capturedUpdates } = makeStubDb();
        const error = forbiddenError(() => wrapDb(db, baseAuth).update(profiles).set({ organizationId: "org-acme" }));
        expect(error.message).toBe('cannot update managed tenant column "organizationId"');
        expect(capturedUpdates[0]?.values).toBeUndefined();
    });

    test("a self update grant scopes no-WHERE updates by both tenant and user", () => {
        const { cdbTable } = forOrg();
        const profiles = cdbTable(
            "profiles_update_self",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                ownerId: text("owner_id")
                    .notNull()
                    .references(() => userTable.id),
                displayName: text("display_name").notNull(),
            },
            { selfBy: "ownerId", roles: { self: { update: ["displayName"] } } }
        );
        const { db, capturedUpdates } = makeStubDb();
        wrapDb(db, baseAuth).update(profiles).set({ displayName: "Mine" }).run();

        const scoped = renderSql(capturedUpdates[0]?.where);
        expect(scoped.params).toContain("org-acme");
        expect(scoped.params).toContain("u-alice");
        expect(scoped.sql).toContain("organization_id");
        expect(scoped.sql).toContain("owner_id");

        const denied = makeStubDb();
        const error = forbiddenError(() => wrapDb(denied.db, baseAuth).update(profiles).set({ ownerId: "u-alice" }));
        expect(error.message).toBe('cannot update managed self column "ownerId"');
        expect(denied.capturedUpdates[0]?.values).toBeUndefined();
    });

    test("non-cdbTable updates remain passthrough", () => {
        const raw = sqliteTable("raw_update_passthrough", {
            id: text("id").primaryKey(),
            value: text("value").notNull(),
        });
        const { db, capturedUpdates } = makeStubDb();
        wrapDb(db, baseAuth).update(raw).set({ value: "changed" }).run();
        expect(capturedUpdates[0]).toMatchObject({ values: { value: "changed" }, where: undefined });
    });
});
