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
 */

import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CdbError, type CdbErrorCode } from "../../src/errors.ts";
import { applyColumnMask, assertColumnsWritable } from "../../src/server/cdb-cls.ts";
import { cdbPolicyDigest, compileCdbPolicies } from "../../src/server/cdb-policy.ts";
import { getCdbMeta, isCdbTable } from "../../src/server/cdb-table-registry.ts";
import { resolveCdbMeta } from "../../src/server/cdb-table.ts";
import { applyPoliciesToWhere, applyRowPolicies } from "../../src/server/policy.ts";
import { forOrg, forOrgUser, forUser, globalScope } from "../helpers/cdb-table.ts";

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

describe("forOrgUser() / cdbTable", () => {
    const { cdbTable } = forOrgUser();

    test("auto-discovers organization routing and user ownership", () => {
        const rows = cdbTable(
            "tbl_forOrgUser_autodiscover",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
                body: text("body").notNull(),
            },
            { roles: { admin: "*", self: { read: "*", update: ["body"] } } }
        );

        expect(resolveCdbMeta(rows)).toMatchObject({
            tenantKind: "org",
            tenantBy: "organization_id",
            selfBy: "user_id",
            selfTarget: "user",
        });
    });

    test("requires one unambiguous user FK unless selfBy selects one", () => {
        const missing = cdbTable(
            "tbl_forOrgUser_missing_user",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            { roles: { self: { read: "*" } } }
        );
        expectCdbError(() => resolveCdbMeta(missing), "CDB_INVALID_SELF");

        const selected = cdbTable(
            "tbl_forOrgUser_selected_user",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                ownerId: text("owner_id")
                    .notNull()
                    .references(() => userTable.id),
                reviewerId: text("reviewer_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { selfBy: "ownerId", roles: { self: { read: "*" } } }
        );
        expect(resolveCdbMeta(selected).selfBy).toBe("owner_id");
    });

    test("requires selfBy for nonconventional owners and verifies that it targets user", () => {
        const implicitOwner = cdbTable(
            "tbl_forOrgUser_implicit_owner",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                ownerId: text("owner_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { roles: { self: { read: "*" } } }
        );
        expectCdbError(() => resolveCdbMeta(implicitOwner), "CDB_INVALID_SELF");

        const invalidOwner = cdbTable(
            "tbl_forOrgUser_invalid_owner",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                ownerId: text("owner_id").notNull(),
                reviewerId: text("reviewer_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { selfBy: "ownerId", roles: { self: { read: "*" } } }
        );
        expectCdbError(() => resolveCdbMeta(invalidOwner), "CDB_INVALID_SELF");
    });

    test("keeps managed insert columns aligned with what TypeScript can infer", () => {
        const conventional = cdbTable(
            "tbl_forOrgUser_conventional_insert",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { roles: { self: { create: "*" } } }
        );
        const conventionalInsert: typeof conventional.$inferInsert = { id: "conventional" };

        const implicitOwner = cdbTable(
            "tbl_forOrgUser_implicit_owner_insert",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                ownerId: text("owner_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { roles: { self: { create: "*" } } }
        );
        // @ts-expect-error ownerId stays required until selfBy marks it as managed.
        const missingImplicitOwner: typeof implicitOwner.$inferInsert = { id: "implicit" };

        const explicitOwner = cdbTable(
            "tbl_forOrgUser_explicit_owner_insert",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                ownerId: text("owner_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { selfBy: "ownerId", roles: { self: { create: "*" } } }
        );
        const explicitInsert: typeof explicitOwner.$inferInsert = { id: "explicit" };

        expect([conventionalInsert.id, missingImplicitOwner.id, explicitInsert.id]).toEqual([
            "conventional",
            "implicit",
            "explicit",
        ]);
    });

    test("keeps the organization floor while allowing org roles and self grants", () => {
        const rows = cdbTable(
            "tbl_forOrgUser_policy",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { roles: { admin: { read: "*" }, self: { read: "*" } } }
        );
        const policies = compileCdbPolicies(rows);
        const mine = { id: "mine", organization_id: "org-A", user_id: "user-A" };
        const peer = { id: "peer", organization_id: "org-A", user_id: "user-B" };
        const otherOrg = { id: "other-org", organization_id: "org-B", user_id: "user-A" };
        const data = [mine, peer, otherOrg];

        expect(
            applyRowPolicies({
                op: "select",
                auth: { userId: "user-A", tenantId: "org-A", role: "member", claims: {} },
                rows: data,
                policies,
            })
        ).toEqual([mine]);
        expect(
            applyRowPolicies({
                op: "select",
                auth: { userId: "admin-A", tenantId: "org-A", role: "admin", claims: {} },
                rows: data,
                policies,
            })
        ).toEqual([mine, peer]);
    });

    test("keeps organization and user role namespaces separate for rows and columns", () => {
        const userAdminRows = cdbTable(
            "tbl_forOrgUser_user_admin_rows",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
            },
            { roles: { "user:admin": { read: "*" } } }
        );
        const row = { id: "row", organization_id: "org-A", user_id: "owner" };
        const orgAdmin = {
            userId: "org-admin",
            tenantId: "org-A",
            role: "admin",
            roles: ["admin"],
            claims: { userRole: "member" },
        };
        const userAdmin = {
            userId: "user-admin",
            tenantId: "org-A",
            role: "member",
            roles: ["member"],
            claims: { userRole: "admin" },
        };
        const forgedUserNamespace = {
            userId: "forged-user-admin",
            tenantId: "org-A",
            role: "user:admin",
            roles: ["user:admin"],
            claims: { userRole: "member" },
        };

        expect(
            applyRowPolicies({
                op: "select",
                auth: orgAdmin,
                rows: [row],
                policies: compileCdbPolicies(userAdminRows),
            })
        ).toEqual([]);
        expect(
            applyRowPolicies({
                op: "select",
                auth: userAdmin,
                rows: [row],
                policies: compileCdbPolicies(userAdminRows),
            })
        ).toEqual([row]);
        expect(
            applyRowPolicies({
                op: "select",
                auth: forgedUserNamespace,
                rows: [row],
                policies: compileCdbPolicies(userAdminRows),
            })
        ).toEqual([]);

        const roleColumns = cdbTable(
            "tbl_forOrgUser_role_columns",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
                organizationSecret: text("organization_secret").notNull(),
                userSecret: text("user_secret").notNull(),
            },
            {
                roles: {
                    admin: { read: ["id", "organizationSecret"] },
                    "user:admin": { read: ["id", "userSecret"] },
                },
            }
        );
        const visible: Record<string, string | null> = {
            id: "row",
            organization_id: "org-A",
            user_id: "owner",
            organization_secret: "organization-only",
            user_secret: "user-only",
        };

        expect(applyColumnMask({ rows: [visible], table: roleColumns, auth: orgAdmin })).toEqual([
            {
                id: "row",
                organization_id: null,
                user_id: null,
                organization_secret: "organization-only",
                user_secret: null,
            },
        ]);
        expect(applyColumnMask({ rows: [visible], table: roleColumns, auth: userAdmin })).toEqual([
            {
                id: "row",
                organization_id: null,
                user_id: null,
                organization_secret: null,
                user_secret: "user-only",
            },
        ]);
        expect(
            applyColumnMask({
                rows: [visible],
                table: roleColumns,
                auth: {
                    userId: "both-admins",
                    tenantId: "org-A",
                    role: "admin",
                    roles: ["admin"],
                    claims: { userRole: "admin" },
                },
            })
        ).toEqual([
            {
                id: "row",
                organization_id: null,
                user_id: null,
                organization_secret: "organization-only",
                user_secret: "user-only",
            },
        ]);
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

    test("a bare table gives its owning user the implicit self grant", () => {
        const owned = cdbTable(
            "tbl_forUser_implicit_self",
            {
                id: text("id").primaryKey(),
                userId: text("user_id")
                    .notNull()
                    .references(() => userTable.id),
                body: text("body").notNull(),
            },
            {}
        );
        const auth = { userId: "user-a", claims: {} };
        const row = { id: "row-a", user_id: "user-a", body: "owned" };
        const policies = compileCdbPolicies(owned);

        for (const op of ["select", "insert", "update", "delete"] as const) {
            expect(applyRowPolicies({ op, auth, rows: [row], policies })).toEqual([row]);
        }
        expect(applyColumnMask({ rows: [row], table: owned, auth })).toEqual([row]);
        expect(() =>
            assertColumnsWritable({ values: { body: "changed" }, table: owned, auth, verb: "update" })
        ).not.toThrow();
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

    const sameTenantRow = { organization_id: "org-A", author_id: "u-member", body: "same tenant" };
    const rows = [sameTenantRow, { organization_id: "org-B", author_id: "u-member", body: "other tenant" }];

    test("emits a tenant predicate policy named <table>_tenant", () => {
        const tenantPolicy = policies.find(p => p.name === "messages_for_compile_tenant");
        expect(tenantPolicy).toBeDefined();
        expect(tenantPolicy?.for).toBe("all");
        expect(tenantPolicy?.to).toBe("authenticated");
        expect(tenantPolicy?.effect).toBe("floor");
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
        expect(adminPolicies.every(policy => policy.effect === "grant")).toBe(true);
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

    test("denies anonymous reads on a private table", () => {
        const visible = applyRowPolicies({
            op: "select",
            auth: { userId: "", claims: {} },
            rows,
            policies,
        });
        expect(visible).toEqual([]);

        const predicate = applyPoliciesToWhere({
            op: "select",
            auth: { userId: "", claims: {} },
            table: messages,
            policies,
        });
        const rendered = predicate?.toQuery({
            casing: { getColumnCasing: () => "snake_case" } as never,
            escapeName: (name: string) => `"${name}"`,
            escapeParam: (index: number) => `?${index + 1}`,
            escapeString: (value: string) => `'${value}'`,
        } as never);
        expect(rendered?.sql).toContain("1 = 0");
    });

    test("ORs member and admin grants while retaining the tenant floor", () => {
        const memberRows = applyRowPolicies({
            op: "select",
            auth: { userId: "u-member", tenantId: "org-A", role: "member", claims: {} },
            rows,
            policies,
        });
        const adminRows = applyRowPolicies({
            op: "select",
            auth: { userId: "u-admin", tenantId: "org-A", role: "admin", claims: {} },
            rows,
            policies,
        });
        expect(memberRows).toEqual([sameTenantRow]);
        expect(adminRows).toEqual([sameTenantRow]);
    });

    test("denies writes when the table compiled no grant for that operation", () => {
        const { cdbTable } = forOrg();
        const readOnly = cdbTable(
            "read_only_for_compile",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            { roles: { member: { read: "*" } } }
        );
        const readOnlyPolicies = compileCdbPolicies(readOnly);
        const visible = applyRowPolicies({
            op: "insert",
            auth: { userId: "u-member", tenantId: "org-A", role: "member", claims: {} },
            rows: [{ id: "1", organization_id: "org-A" }],
            policies: readOnlyPolicies,
        });
        expect(visible).toEqual([]);
        const predicate = applyPoliciesToWhere({
            op: "insert",
            auth: { userId: "u-member", tenantId: "org-A", role: "member", claims: {} },
            table: readOnly,
            policies: readOnlyPolicies,
        });
        const rendered = predicate?.toQuery({
            casing: { getColumnCasing: () => "snake_case" } as never,
            escapeName: (name: string) => `"${name}"`,
            escapeParam: (index: number) => `?${index + 1}`,
            escapeString: (value: string) => `'${value}'`,
        } as never);
        expect(rendered?.sql).toContain("1 = 0");
    });

    test("publicRead grants select only", () => {
        const { cdbTable } = forOrg();
        const publicFeed = cdbTable(
            "public_feed_for_compile",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            { publicRead: true }
        );
        const publicPolicies = compileCdbPolicies(publicFeed);
        const publicRows = [{ id: "1", organization_id: "org-A" }];
        const anonymous = { userId: "", claims: {} };
        expect(applyRowPolicies({ op: "select", auth: anonymous, rows: publicRows, policies: publicPolicies })).toEqual(
            publicRows
        );
        expect(applyRowPolicies({ op: "insert", auth: anonymous, rows: publicRows, policies: publicPolicies })).toEqual(
            []
        );
    });

    test("policy identity covers only the declared tables and changes with their access rules", () => {
        const restrictedMessages = cdbTable(
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
            { roles: { member: { read: { exclude: ["flagged"] } } } }
        );
        const unrelated = cdbTable(
            "unrelated_policy_table",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
            },
            { publicRead: true }
        );

        const digest = cdbPolicyDigest({ messages, unrelated }, ["messages_for_compile"]);
        expect(cdbPolicyDigest({ unrelated, messages }, ["messages_for_compile", "messages_for_compile"])).toBe(digest);
        expect(cdbPolicyDigest({ messages }, ["messages_for_compile"])).toBe(digest);
        expect(cdbPolicyDigest({ restrictedMessages }, ["messages_for_compile"])).not.toBe(digest);
        expect(() => cdbPolicyDigest({ messages }, ["missing_table"])).toThrow("unknown cdbTable missing_table");
    });

    test("policy identity reuses the digest for one stable runtime schema and table set", () => {
        let schemaReads = 0;
        const schema: Record<string, unknown> = {};
        Object.defineProperty(schema, "messages", {
            enumerable: true,
            get: () => {
                schemaReads += 1;
                return messages;
            },
        });

        const first = cdbPolicyDigest(schema, ["messages_for_compile"]);
        const second = cdbPolicyDigest(schema, ["messages_for_compile", "messages_for_compile"]);

        expect(second).toBe(first);
        expect(schemaReads).toBe(1);
    });

    test("policy identity uses locale-independent Unicode name ordering", () => {
        const makeTable = (roles: Record<string, { readonly read: "*" }>) =>
            cdbTable(
                "unicode_policy_order",
                {
                    id: text("id").primaryKey(),
                    organizationId: text("organization_id")
                        .notNull()
                        .references(() => orgTable.id),
                },
                { roles }
            );
        const first = makeTable({ équipe: { read: "*" }, zebra: { read: "*" } });
        const second = makeTable({ zebra: { read: "*" }, équipe: { read: "*" } });

        expect(cdbPolicyDigest({ first }, ["unicode_policy_order"])).toBe(
            cdbPolicyDigest({ second }, ["unicode_policy_order"])
        );
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

    test("publicRead does not erase an authenticated caller's column mask", () => {
        const publicMessages = cdbTable(
            "public_messages_for_cls",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => orgTable.id),
                body: text("body").notNull(),
                moderationNote: text("moderation_note"),
            },
            {
                publicRead: true,
                roles: { member: { read: { exclude: ["moderationNote"] } } },
            }
        );
        const row: Record<string, string | null> = {
            id: "1",
            organization_id: "org",
            body: "hello",
            moderation_note: "private",
        };

        expect(
            applyColumnMask({
                rows: [row],
                table: publicMessages,
                auth: { userId: "member", role: "member", claims: {} },
            })
        ).toEqual([{ ...row, moderation_note: null }]);
        expect(applyColumnMask({ rows: [row], table: publicMessages, auth: { userId: "", claims: {} } })).toEqual([
            row,
        ]);
    });
});
