/**
 * Coverage for the cdbTable schema-first RLS+CLS surface.
 *
 *   - factory binding: forOrg / forUser / globalScope produce tables
 *     that carry the right tenant kind + auth target on their meta
 *   - tenant column auto-discovery from `.references()` (FK to org/user)
 *   - ambiguity / missing-FK error codes
 *   - selfBy validation + compile-required when `self` appears
 *   - column matrix compilation: role-axis, column-axis, contradictions
 *   - PolicyDefinition emission parity with the old helpers' shapes
 *   - column mask + writability check
 *   - AccessControl materialization including `user:` prefix routing
 */

import { describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CdbError, type CdbErrorCode } from "../../src/errors.ts";
import {
    applyColumnMask,
    assertColumnsWritable,
    buildAccessControl,
    compileCdbPolicies,
    forOrg,
    forUser,
    getCdbMeta,
    globalScope,
    isCdbTable,
    resolveCdbMeta,
} from "../../src/server/index.ts";

function expectCdbError(fn: () => unknown, expectedCode: CdbErrorCode): void {
    let caught: unknown;
    try {
        fn();
    } catch (e) {
        caught = e;
    }
    expect(caught).toBeInstanceOf(CdbError);
    expect((caught as CdbError).code).toBe(expectedCode);
}

// Synthetic better-auth tables (we don't run the real defineAuth here
// to keep the test free of plugin side-effects). The `getTableName`
// match the names the auto-discoverer compares against.
const orgTable = sqliteTable("organization", { id: text("id").primaryKey() });
const userTable = sqliteTable("user", { id: text("id").primaryKey() });

describe("forOrg() / cdbTable", () => {
    const { cdbTable } = forOrg();

    test("attaches metadata + isCdbTable detects it", () => {
        const channels = cdbTable(
            "channels_forOrg_basic",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            { publicRead: true, roles: { admin: "*" } }
        );
        expect(isCdbTable(channels)).toBe(true);
        const meta = getCdbMeta(channels);
        expect(meta).toBeDefined();
        expect(meta?.tenantKind).toBe("org");
        expect(meta?.publicRead).toBe(true);
    });

    test("auto-discovers tenant column from FK to organization", () => {
        const t = cdbTable(
            "tbl_forOrg_autodiscover",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                name: text("name").notNull(),
            },
            {}
        );
        const resolved = resolveCdbMeta(t);
        expect(resolved.tenantBy).toBe("organization_id");
    });

    test("ambiguous FK to organization throws CDB_AMBIGUOUS_TENANT", () => {
        const t = cdbTable(
            "tbl_forOrg_ambig",
            {
                id: text("id").primaryKey(),
                primaryOrgId: text("primary_org_id")
                    .notNull()
                    .references(() => orgTable.id),
                secondaryOrgId: text("secondary_org_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            {}
        );
        expectCdbError(() => resolveCdbMeta(t), "CDB_AMBIGUOUS_TENANT");
    });

    test("ambiguity is silenced by explicit tenantBy:", () => {
        const t = cdbTable(
            "tbl_forOrg_ambig_resolved",
            {
                id: text("id").primaryKey(),
                primaryOrgId: text("primary_org_id")
                    .notNull()
                    .references(() => orgTable.id),
                secondaryOrgId: text("secondary_org_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            { tenantBy: "primaryOrgId" }
        );
        // tenantBy normalized to the SQL column name internally.
        expect(resolveCdbMeta(t).tenantBy).toBe("primary_org_id");
    });

    test("missing FK to organization throws CDB_MISSING_TENANT_FK", () => {
        const t = cdbTable("tbl_forOrg_missing", { id: text("id").primaryKey(), name: text("name").notNull() }, {});
        expectCdbError(() => resolveCdbMeta(t), "CDB_MISSING_TENANT_FK");
    });

    test("`self` in roles requires selfBy at construction time", () => {
        expectCdbError(
            () =>
                cdbTable(
                    "tbl_forOrg_selfWithoutSelfBy",
                    {
                        id: text("id").primaryKey(),
                        organizationId: text("organization_id")
                            .notNull()
                            .references(() => orgTable.id),
                        authorId: text("author_id")
                            .notNull()
                            .references(() => userTable.id),
                    },
                    { roles: { self: { read: "*" } } }
                ),
            "CDB_INVALID_SELF"
        );
    });

    test("selfBy bound to a column accepts the table", () => {
        const t = cdbTable(
            "tbl_forOrg_selfOk",
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
            { selfBy: "authorId", roles: { self: { read: "*", update: ["body"], delete: true } } }
        );
        // selfBy is normalized to the SQL column name internally.
        expect(resolveCdbMeta(t).selfBy).toBe("author_id");
    });
});

describe("forUser() / cdbTable", () => {
    const { cdbTable } = forUser();

    test("auto-discovers tenant column from FK to user", () => {
        const t = cdbTable(
            "tbl_forUser_autodiscover",
            {
                id: text("id").primaryKey(),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
                body: text("body").notNull(),
            },
            { roles: { admin: "*" } }
        );
        const resolved = resolveCdbMeta(t);
        expect(resolved.tenantKind).toBe("user");
        expect(resolved.tenantBy).toBe("user_id");
    });

    test("rejects selfBy (self is implicit under forUser)", () => {
        expectCdbError(
            () =>
                cdbTable(
                    "tbl_forUser_rejectsSelfBy",
                    {
                        id: text("id").primaryKey(),
                        userId: text("user_id")
                            .notNull()
                            .references(() => userTable.id),
                    },
                    { selfBy: "userId" } as never
                ),
            "CDB_INVALID_SELF"
        );
    });
});

describe("globalScope() / cdbTable", () => {
    const { cdbTable } = globalScope();

    test("partitionBy: replicated marks the table as replicated", () => {
        const t = cdbTable(
            "tbl_global_replicated",
            { id: text("id").primaryKey(), name: text("name").notNull() },
            { partitionBy: "replicated", publicRead: true }
        );
        const meta = resolveCdbMeta(t);
        expect(meta.partitionBy.kind).toBe("replicated");
        expect(meta.tenantBy).toBeUndefined();
    });

    test("partitionBy: <col> marks the table as colocated by that column", () => {
        const t = cdbTable(
            "tbl_global_colocated",
            {
                id: text("id").primaryKey(),
                rootId: text("root_id").notNull(),
                name: text("name").notNull(),
            },
            { partitionBy: "rootId" }
        );
        const meta = resolveCdbMeta(t);
        expect(meta.partitionBy).toEqual({ kind: "colocate", via: ["root_id"] });
    });
});

describe("compileCdbPolicies — RLS shape parity", () => {
    const { cdbTable } = forOrg();
    const messages = cdbTable(
        "messages_for_compile",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            authorId: text("author_id")
                .notNull()
                .references(() => userTable.id),
            body: text("body").notNull(),
            flagged: text("flagged"),
        },
        {
            selfBy: "authorId",
            publicRead: false,
            roles: {
                admin: "*",
                member: { read: "*", create: ["body"] },
                self: { update: ["body"], delete: true },
            },
        }
    );

    const policies = compileCdbPolicies(messages);

    test("emits a tenant predicate policy named <table>_tenant", () => {
        const tenantPolicy = policies.find(p => p.name === "messages_for_compile_tenant");
        expect(tenantPolicy).toBeDefined();
        expect(tenantPolicy?.for).toBe("all");
        expect(tenantPolicy?.to).toBe("authenticated");
    });

    test("tenant predicate enforces row[organization_id] === auth.tenantId", () => {
        const tenantPolicy = policies.find(p => p.name === "messages_for_compile_tenant");
        const auth = { userId: "u1", tenantId: "org-A", claims: {} };
        const ok = tenantPolicy?.using?.(auth, { organization_id: "org-A" } as never);
        const denied = tenantPolicy?.using?.(auth, { organization_id: "org-B" } as never);
        expect(ok).toBe(true);
        expect(denied).toBe(false);
    });

    test("emits one role gate per role × verb that grants the verb", () => {
        const adminPolicies = policies.filter(p => p.name.startsWith("messages_for_compile_role_admin_"));
        // admin: "*" → 4 verbs
        expect(adminPolicies.length).toBe(4);
        const memberPolicies = policies.filter(p => p.name.startsWith("messages_for_compile_role_member_"));
        // member: { read: "*", create: ["body"] } → 2 verbs
        expect(memberPolicies.length).toBe(2);
    });

    test("emits self_<verb> policies bound to selfBy", () => {
        const selfUpdate = policies.find(p => p.name === "messages_for_compile_self_update");
        const selfDelete = policies.find(p => p.name === "messages_for_compile_self_delete");
        expect(selfUpdate).toBeDefined();
        expect(selfDelete).toBeDefined();
        const auth = { userId: "u-self", claims: {} };
        expect(selfUpdate?.using?.(auth, { author_id: "u-self" } as never)).toBe(true);
        expect(selfUpdate?.using?.(auth, { author_id: "u-other" } as never)).toBe(false);
    });
});

describe("CLS — applyColumnMask + assertColumnsWritable", () => {
    const { cdbTable } = forOrg();
    const messages = cdbTable(
        "messages_for_cls",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
            authorId: text("author_id")
                .notNull()
                .references(() => userTable.id),
            body: text("body").notNull(),
            flaggedReason: text("flagged_reason"),
        },
        {
            selfBy: "authorId",
            roles: {
                admin: "*",
                member: { read: { exclude: ["flaggedReason"] }, create: ["body"] },
                self: { update: ["body"], read: "*" },
            },
        }
    );

    test("admin sees every column unchanged", () => {
        const out = applyColumnMask({
            rows: [{ id: "1", organization_id: "o", author_id: "u", body: "hi", flagged_reason: "spam" }],
            table: messages,
            auth: { userId: "u-admin", role: "admin", claims: {} },
        });
        expect(out[0]?.flagged_reason).toBe("spam");
    });

    test("member's flagged_reason is null-masked", () => {
        const out = applyColumnMask({
            rows: [{ id: "1", organization_id: "o", author_id: "u", body: "hi", flagged_reason: "spam" }],
            table: messages,
            auth: { userId: "u-member", role: "member", claims: {} },
        });
        expect(out[0]?.body).toBe("hi");
        expect(out[0]?.flagged_reason).toBeNull();
    });

    test("self sees every column on their own row even though `member` excludes flagged", () => {
        const out = applyColumnMask({
            rows: [
                { id: "1", organization_id: "o", author_id: "u-self", body: "mine", flagged_reason: "x" },
                { id: "2", organization_id: "o", author_id: "u-other", body: "theirs", flagged_reason: "y" },
            ],
            table: messages,
            auth: { userId: "u-self", role: "member", claims: {} },
        });
        expect(out[0]?.flagged_reason).toBe("x");
        expect(out[1]?.flagged_reason).toBeNull();
    });

    test("member cannot create columns outside their grant", () => {
        // values are typed in SQL column names because that's what raw row
        // payloads use at the storage boundary.
        expectCdbError(
            () =>
                assertColumnsWritable({
                    values: { body: "hi", flagged_reason: "spam" },
                    table: messages,
                    auth: { userId: "u-member", role: "member", claims: {} },
                    verb: "create",
                }),
            "CDB_FORBIDDEN_COLUMN"
        );
    });

    test("autoFilled columns bypass the create check", () => {
        expect(() =>
            assertColumnsWritable({
                values: { body: "hi", flagged_reason: "framework set" },
                table: messages,
                auth: { userId: "u-member", role: "member", claims: {} },
                verb: "create",
                autoFilled: new Set(["flagged_reason"]),
            })
        ).not.toThrow();
    });
});

describe("buildAccessControl", () => {
    const { cdbTable } = forOrg();
    const channels = cdbTable(
        "channels_for_ac",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => orgTable.id),
        },
        { roles: { admin: "*", member: { read: "*" } } }
    );
    const messages = cdbTable(
        "messages_for_ac",
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
        {
            selfBy: "authorId",
            roles: {
                admin: "*",
                member: { create: ["body"] },
                self: { update: ["body"] },
                "user:superadmin": "*",
            },
        }
    );
    const built = buildAccessControl({ channels, messages });

    test("emits org-scope roles for unprefixed names", () => {
        expect(built.roles.admin).toBeDefined();
        expect(built.roles.member).toBeDefined();
    });

    test("emits user-scope roles for `user:`-prefixed names", () => {
        expect(built.userRoles.superadmin).toBeDefined();
    });

    test("admin authorizes every verb on every cdbTable", () => {
        const admin = built.roles.admin;
        if (!admin) throw new Error("expected buildAccessControl to create the admin role");
        expect(admin.authorize({ messages_for_ac: ["read", "create", "update", "delete"] }).success).toBe(true);
    });
});
