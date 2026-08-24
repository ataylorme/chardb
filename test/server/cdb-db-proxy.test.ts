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
 *   - non-cdbTables fail closed at the application boundary
 *   - missing tenant/user authority rejects even caller-supplied values
 *   - array `.values([...])` validates every row before forwarding
 *   - the post-values builder exposes only safe execution and inspection
 */

import { describe, expect, test } from "bun:test";
import { type SQL, asc, desc, eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BaseSQLiteDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../../src/errors.ts";
import { type QueryReadRangeObservation, wrapMutationDb, wrapQueryDb } from "../../src/server/cdb-db-proxy.ts";
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

interface CapturedDelete {
    readonly table: SQLiteTable;
    where: unknown;
}

/**
 * Minimal stub for the surface the proxy actually inspects: an
 * `insert(table)` method that returns a builder whose `.values(rows)`
 * captures its argument and exposes representative Drizzle chain methods.
 */
function makeStubDb(): {
    db: StubDb;
    captured: CapturedInsert[];
    capturedUpdates: CapturedUpdate[];
    capturedDeletes: CapturedDelete[];
} {
    const captured: CapturedInsert[] = [];
    const capturedUpdates: CapturedUpdate[] = [];
    const capturedDeletes: CapturedDelete[] = [];
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
                onConflictDoUpdate() {
                    return builder;
                },
                select() {
                    return builder;
                },
                prepare() {
                    return builder;
                },
                run() {
                    return { changes: 1 };
                },
                toSQL() {
                    return { sql: "insert", params: [] };
                },
                getSQL() {
                    return "insert";
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
        delete(table: SQLiteTable) {
            const entry: CapturedDelete = { table, where: undefined };
            capturedDeletes.push(entry);
            const builder = {
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
    return { db: db as StubDb, captured, capturedUpdates, capturedDeletes };
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

function forbiddenFeature(run: () => unknown): CdbError {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(CdbError);
    const cdbError = caught as CdbError;
    expect(cdbError.code).toBe("CDB_UNSUPPORTED_FEATURE");
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

    test("rejects inserts into non-cdbTables before constructing a builder", () => {
        const raw = sqliteTable("raw_passthrough", {
            id: text("id").primaryKey(),
            value: text("value").notNull(),
        });

        const { db, captured } = makeStubDb();
        const error = forbiddenFeature(() => wrapDb(db, baseAuth).insert(raw));
        expect(error.message).toContain("plain table");
        expect(captured).toHaveLength(0);
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

    test("allows execution while blocking returned rows and conflict oracles", async () => {
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
        const inserted = wrapDb(db, baseAuth).insert(channels).values({ id: "c1", name: "general" }).run();
        expect(await inserted).toEqual({ changes: 1 });

        const returned = wrapDb(db, baseAuth).insert(channels).values({ id: "c2", name: "private" });
        const error = forbiddenFeature(() => returned.returning());
        expect(error.message).toContain('insert property "returning"');

        const conflict = wrapDb(db, baseAuth).insert(channels).values({ id: "c3", name: "collision probe" });
        const conflictError = forbiddenFeature(() => conflict.onConflictDoNothing());
        expect(conflictError.message).toContain('insert property "onConflictDoNothing"');
    });

    test("blocks cross-tenant conflict updates and insert-select", () => {
        const { cdbTable } = forOrg();
        const channels = cdbTable(
            "channels_insert_shapes",
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
        const valuesBuilder = wrapDb(db, baseAuth).insert(channels).values({ id: "c1", name: "general" });
        const upsert = forbiddenFeature(() =>
            valuesBuilder.onConflictDoUpdate({
                target: channels.id,
                set: { organizationId: "org-other", name: "hostile" },
            })
        );
        expect(upsert.message).toContain('insert property "onConflictDoUpdate"');

        const insertRoot = wrapDb(db, baseAuth).insert(channels);
        const insertSelect = forbiddenFeature(() => Reflect.get(insertRoot, "select"));
        expect(insertSelect.message).toContain('insert property "select"');
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

    test("blocks returning and non-cdbTable updates", () => {
        const profiles = profileTable("profiles_update_returning", {
            member: { update: ["displayName"] },
        });
        const policyDb = makeStubDb();
        const updateRoot = wrapDb(policyDb.db, baseAuth).update(profiles);
        for (const property of ["session", "dialect", "_", "$dynamic"]) {
            const preSet = forbiddenFeature(() => Reflect.get(updateRoot, property));
            expect(preSet.message).toContain(`update property "${property}"`);
        }
        const returned = forbiddenFeature(() =>
            wrapDb(policyDb.db, baseAuth).update(profiles).set({ displayName: "secret" }).returning()
        );
        expect(returned.message).toContain('update property "returning"');

        const raw = sqliteTable("raw_update_passthrough", {
            id: text("id").primaryKey(),
            value: text("value").notNull(),
        });
        const { db, capturedUpdates } = makeStubDb();
        const plain = forbiddenFeature(() => wrapDb(db, baseAuth).update(raw));
        expect(plain.message).toContain("plain table");
        expect(capturedUpdates).toHaveLength(0);
    });
});

describe("wrapDb / cdbTable delete authorization", () => {
    function deletableTable(
        name: string,
        roles: {
            readonly admin?: RoleValue<{ readonly id: unknown; readonly organizationId: unknown }>;
            readonly member?: RoleValue<{ readonly id: unknown; readonly organizationId: unknown }>;
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
            },
            { roles }
        );
    }

    test("denies delete when no applicable grant exists", () => {
        const rows = deletableTable("rows_delete_denied", { member: { read: "*" } });
        const { db, capturedDeletes } = makeStubDb();
        const error = forbiddenError(() => wrapDb(db, baseAuth).delete(rows));
        expect(error.message).toBe("rows_delete_denied: caller has no applicable delete grant");
        expect(capturedDeletes).toHaveLength(0);
    });

    test("allows a member delete and protects the no-WHERE case", () => {
        const rows = deletableTable("rows_delete_no_where", { member: { delete: true } });
        const { db, capturedDeletes } = makeStubDb();
        wrapDb(db, baseAuth).delete(rows).run();

        const scoped = renderSql(capturedDeletes[0]?.where);
        expect(scoped.params).toContain("org-acme");
        expect(scoped.sql).toContain("organization_id");
    });

    test("ANDs a hostile tenant WHERE with the server tenant floor", () => {
        const rows = deletableTable("rows_delete_tenant_floor", { member: { delete: true } });
        const { db, capturedDeletes } = makeStubDb();
        wrapDb(db, baseAuth).delete(rows).where(eq(rows.organizationId, "org-other")).run();

        const scoped = renderSql(capturedDeletes[0]?.where);
        expect(scoped.params).toContain("org-other");
        expect(scoped.params).toContain("org-acme");
        expect(scoped.sql.toLowerCase()).toContain(" and ");
    });

    test("ORs alternative role grants for delete", () => {
        const rows = deletableTable("rows_delete_roles", {
            admin: { delete: true },
            member: { delete: true },
        });
        const { db, capturedDeletes } = makeStubDb();
        wrapDb(db, baseAuth).delete(rows).run();
        expect(renderSql(capturedDeletes[0]?.where).sql.toLowerCase()).toContain(" or ");
    });

    test("a self-only delete is scoped by both tenant and owner", () => {
        const { cdbTable } = forOrg();
        const rows = cdbTable(
            "rows_delete_self",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                ownerId: text("owner_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { selfBy: "ownerId", roles: { self: { delete: true } } }
        );
        const { db, capturedDeletes } = makeStubDb();
        wrapDb(db, baseAuth).delete(rows).run();

        const scoped = renderSql(capturedDeletes[0]?.where);
        expect(scoped.params).toContain("org-acme");
        expect(scoped.params).toContain("u-alice");
        expect(scoped.sql).toContain("organization_id");
        expect(scoped.sql).toContain("owner_id");
    });

    test("blocks returning and non-cdbTable deletes", () => {
        const rows = deletableTable("rows_delete_returning", { member: { delete: true } });
        const policyDb = makeStubDb();
        const returned = forbiddenFeature(() => wrapDb(policyDb.db, baseAuth).delete(rows).returning());
        expect(returned.message).toContain('delete property "returning"');

        const raw = sqliteTable("raw_delete_passthrough", { id: text("id").primaryKey() });
        const { db, capturedDeletes } = makeStubDb();
        const plain = forbiddenFeature(() => wrapDb(db, baseAuth).delete(raw));
        expect(plain.message).toContain("plain table");
        expect(capturedDeletes).toHaveLength(0);
    });
});

describe("wrapMutationDb / write observation", () => {
    const { cdbTable } = forOrg();
    const records = cdbTable(
        "observed_records",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            value: integer("value").notNull(),
        },
        { roles: { member: { create: "*", update: ["value"], delete: true } } }
    );

    test("observes successful insert, update, and delete execution but not SQL inspection", () => {
        const { db } = makeStubDb();
        const touched: string[] = [];
        const wrapped = wrapMutationDb(db, baseAuth, tableName => touched.push(tableName));

        const insert = wrapped.insert(records).values({ id: "record-1", value: 1 });
        insert.toSQL();
        expect(touched).toEqual([]);

        insert.run();
        wrapped.update(records).set({ value: 2 }).run();
        wrapped.delete(records).run();
        // The stub reports zero changed rows for update and delete. The observer
        // intentionally records successful builder execution for coarse invalidation.
        expect(touched).toEqual(["observed_records", "observed_records", "observed_records"]);
    });

    test("does not observe a write whose execution throws", () => {
        const builder = {
            values() {
                return builder;
            },
            run() {
                throw new Error("write failed");
            },
        };
        const raw = { insert: () => builder } as unknown as StubDb;
        const touched: string[] = [];
        const wrapped = wrapMutationDb(raw, baseAuth, tableName => touched.push(tableName));

        expect(() => wrapped.insert(records).values({ id: "record-1", value: 1 }).run()).toThrow("write failed");
        expect(touched).toEqual([]);
    });

    test("shares the observer with transaction callback wrappers", () => {
        const nested = makeStubDb();
        const raw = {
            transaction(callback: (tx: StubDb) => void) {
                callback(nested.db);
            },
        };
        const touched: string[] = [];
        wrapMutationDb(raw, baseAuth, tableName => touched.push(tableName)).transaction(tx => {
            tx.insert(records).values({ id: "record-1", value: 1 }).run();
        });

        expect(touched).toEqual(["observed_records"]);
    });
});

describe("wrapQueryDb / read observation", () => {
    const { cdbTable } = forOrg();
    const records = cdbTable(
        "observed_reads",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
        },
        { roles: { member: { read: "*" } } }
    );

    function selectDb(all: () => unknown = () => [{ id: "record-1", organizationId: "org-acme" }]) {
        const builder = {
            where() {
                return builder;
            },
            all,
            get() {
                const rows = all();
                return Array.isArray(rows) ? rows[0] : undefined;
            },
            execute() {
                return all();
            },
            // biome-ignore lint/suspicious/noThenProperty: Drizzle select builders are intentionally thenable.
            then(onFulfilled?: (rows: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
                return Promise.resolve().then(all).then(onFulfilled, onRejected);
            },
            catch(onRejected?: (error: unknown) => unknown) {
                return Promise.resolve().then(all).catch(onRejected);
            },
            finally(onFinally?: () => void) {
                return Promise.resolve().then(all).finally(onFinally);
            },
            orderBy(..._expressions: readonly unknown[]) {
                return builder;
            },
            toSQL() {
                return { sql: "select", params: [] };
            },
        };
        return { select: () => ({ from: (_table: SQLiteTable) => builder }) };
    }

    test("conservatively observes FROM construction before inspection or execution", () => {
        const readTables: string[] = [];
        const query = wrapQueryDb(selectDb(), baseAuth, tableName => readTables.push(tableName))
            .select()
            .from(records);

        expect(readTables).toEqual(["observed_reads"]);
        query.toSQL();
        expect(query.all()).toEqual([{ id: "record-1", organizationId: "org-acme" }]);
        expect(readTables).toEqual(["observed_reads"]);
    });

    test("counts an unused builder as a conservative read", () => {
        const readTables: string[] = [];
        wrapQueryDb(selectDb(), baseAuth, tableName => readTables.push(tableName))
            .select()
            .from(records);
        expect(readTables).toEqual(["observed_reads"]);
    });

    test("keeps the conservative observation when execution throws", () => {
        const readTables: string[] = [];
        const wrapped = wrapQueryDb(
            selectDb(() => {
                throw new Error("read failed");
            }),
            baseAuth,
            tableName => readTables.push(tableName)
        );

        expect(() => wrapped.select().from(records).all()).toThrow("read failed");
        expect(readTables).toEqual(["observed_reads"]);
    });

    test("observes each execution surface once without observing SQL inspection", async () => {
        const observations: QueryReadRangeObservation[] = [];
        const query = wrapQueryDb(selectDb(), baseAuth, undefined, observation => observations.push(observation))
            .select()
            .from(records);

        query.toSQL();
        expect(observations).toHaveLength(0);
        query.all();
        expect(observations).toHaveLength(1);
        query.get();
        expect(observations).toHaveLength(2);
        query.execute();
        expect(observations).toHaveLength(3);
        await (query as PromiseLike<unknown>);
        expect(observations).toHaveLength(4);
        await query.catch();
        expect(observations).toHaveLength(5);
        await query.finally();
        expect(observations).toHaveLength(6);
        expect(new Set(observations.map(observation => observation.token)).size).toBe(6);
    });

    test("shares the observer with transaction callback wrappers", () => {
        const nested = selectDb();
        const raw = {
            transaction(callback: (tx: typeof nested) => unknown) {
                return callback(nested);
            },
        };
        const readTables: string[] = [];

        wrapQueryDb(raw, baseAuth, tableName => readTables.push(tableName)).transaction(tx => {
            tx.select().from(records).all();
        });

        expect(readTables).toEqual(["observed_reads"]);
    });

    test("accepts typed ascending and descending column order", () => {
        const readTables = new Set<string>();
        const query = wrapQueryDb(selectDb(), baseAuth, tableName => readTables.add(tableName))
            .select()
            .from(records)
            .orderBy(asc(records.id), desc(records.organizationId));

        expect(query.all()).toEqual([{ id: "record-1", organizationId: "org-acme" }]);
        expect(readTables).toEqual(new Set(["observed_reads"]));
    });

    test("rejects order callbacks before they can return hidden raw SQL", () => {
        let invoked = false;
        const wrapped = wrapQueryDb(selectDb(), baseAuth);
        const callback = () => {
            invoked = true;
            return sql.raw('(SELECT id FROM "hidden_order_rows")');
        };

        const error = forbiddenFeature(() => wrapped.select().from(records).orderBy(callback));
        expect(error.message).toContain("orderBy callbacks are unavailable");
        expect(invoked).toBe(false);
    });
});

describe("wrapDb / select bypass guards", () => {
    test("rejects raw execution, relational, CTE, cache, and client/session escape hatches", () => {
        const raw: Record<string, unknown> = {
            query: { records: { findMany: () => [] } },
            $count: () => 0,
            run: () => undefined,
            all: () => [],
            get: () => undefined,
            values: () => [],
            execute: () => [],
            exec: () => undefined,
            prepare: () => undefined,
            batch: () => undefined,
            with: () => undefined,
            $with: () => undefined,
            $cache: { invalidate: () => undefined },
            $client: { sql: {} },
            session: { run: () => undefined },
            dialect: {},
            _: {},
            resultKind: "sync",
            $primary: {},
            $replicas: [],
        };
        const wrapped = wrapDb(raw, baseAuth);
        for (const property of Object.keys(raw)) {
            const error = forbiddenFeature(() => Reflect.get(wrapped, property));
            expect(error.message).toContain("use typed chardb builders");
        }
    });

    test("preserves typed builders and raw blocking inside transaction callbacks", () => {
        const nested = makeStubDb();
        const { cdbTable } = forOrg();
        const records = cdbTable(
            "transaction_cdb_insert",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            { roles: { member: { create: "*" } } }
        );
        const raw = {
            transaction(callback: (tx: StubDb) => CdbError) {
                return callback(nested.db);
            },
        };
        const error = wrapDb(raw, baseAuth).transaction(tx => {
            tx.insert(records).values({ id: "typed-inside-transaction" }).run();
            return forbiddenFeature(() => Reflect.get(tx, "run"));
        });
        expect(nested.captured[0]?.rows).toEqual({
            id: "typed-inside-transaction",
            organizationId: "org-acme",
        });
        expect(error.code).toBe("CDB_UNSUPPORTED_FEATURE");
    });

    test("rejects non-cdbTable selects in application mutation wrappers", () => {
        const rawTable = sqliteTable("raw_select_passthrough", { id: text("id").primaryKey() });
        let selected = false;
        const builder = {
            from(table: SQLiteTable) {
                expect(table).toBe(rawTable);
                selected = true;
                return [{ id: "raw-1" }];
            },
        };
        const rawDb = { select: () => builder };
        const selectRoot = wrapDb(rawDb, baseAuth).select();
        for (const property of ["session", "dialect", "_", "$dynamic"]) {
            const preFrom = forbiddenFeature(() => Reflect.get(selectRoot, property));
            expect(preFrom.message).toContain(`select property "${property}"`);
        }
        const error = forbiddenFeature(() => selectRoot.from(rawTable));
        expect(error.message).toContain("only from cdbTable");
        expect(selected).toBe(false);
    });
});
