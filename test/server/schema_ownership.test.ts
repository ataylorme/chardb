import { describe, expect, test } from "bun:test";
import { organization } from "better-auth/plugins/organization";
import { getTableName } from "drizzle-orm";
import { getTableConfig, text } from "drizzle-orm/sqlite-core";
import { defineAuth } from "../../src/auth/synthesize.ts";
import { CdbError } from "../../src/errors.ts";
import { wrapDb } from "../../src/server/cdb-db-proxy.ts";
import { compileCdbPolicies } from "../../src/server/cdb-policy.ts";
import { resolveCdbMeta } from "../../src/server/cdb-table.ts";
import { applyRowPolicies } from "../../src/server/policy.ts";
import { defineSchemaBaseline } from "../../src/server/schema-migrations.ts";
import { forOrg, forOrgUser, forUser } from "../../src/server/schema-ownership.ts";

function insertCapture() {
    let rows: unknown;
    const db = {
        insert(_table: unknown) {
            return {
                values(value: unknown) {
                    rows = value;
                    return this;
                },
            };
        },
    };
    return { db, rows: () => rows };
}

describe("explicit schema ownership", () => {
    const auth = defineAuth({ plugins: [organization()] });

    test("injects real organization and user foreign keys", () => {
        const { cdbTable: organizationTable } = forOrg(auth);
        const projects = organizationTable("owned_projects", {
            id: text("id").primaryKey(),
            name: text("name").notNull(),
        });
        const { cdbTable: userTable } = forUser(auth);
        const preferences = userTable("owned_preferences", {
            id: text("id").primaryKey(),
            value: text("value").notNull(),
        });
        const { cdbTable: organizationUserTable } = forOrgUser(auth);
        const drafts = organizationUserTable("owned_drafts", {
            id: text("id").primaryKey(),
            title: text("title").notNull(),
        });

        const projectForeignKeys = getTableConfig(projects).foreignKeys;
        const preferenceForeignKeys = getTableConfig(preferences).foreignKeys;
        const draftForeignKeys = getTableConfig(drafts).foreignKeys;
        expect(projectForeignKeys.map(fk => getTableName(fk.reference().foreignTable))).toEqual(["organization"]);
        expect(preferenceForeignKeys.map(fk => getTableName(fk.reference().foreignTable))).toEqual(["user"]);
        expect(draftForeignKeys.map(fk => getTableName(fk.reference().foreignTable))).toEqual(["organization", "user"]);
        expect(projectForeignKeys.map(fk => fk.onDelete)).toEqual(["cascade"]);
        expect(preferenceForeignKeys.map(fk => fk.onDelete)).toEqual(["cascade"]);
        expect(draftForeignKeys.map(fk => fk.onDelete)).toEqual(["cascade", "cascade"]);
        expect(resolveCdbMeta(projects)).toMatchObject({ tenantKind: "org", tenantBy: "organization_id" });
        expect(resolveCdbMeta(preferences)).toMatchObject({ tenantKind: "user", tenantBy: "user_id" });
        expect(resolveCdbMeta(drafts)).toMatchObject({
            tenantKind: "org",
            tenantBy: "organization_id",
            selfBy: "user_id",
        });

        const projectInsert: typeof projects.$inferInsert = { id: "project-1", name: "Roadmap" };
        const preferenceInsert: typeof preferences.$inferInsert = { id: "preference-1", value: "compact" };
        const draftInsert: typeof drafts.$inferInsert = { id: "draft-1", title: "Notes" };
        expect([projectInsert, preferenceInsert, draftInsert]).toHaveLength(3);

        const compileTimeAssertions = () => {
            // @ts-expect-error The organization factory owns this column and its foreign key.
            organizationTable("duplicate_org_owner", { organizationId: text("organization_id"), id: text("id") });
            // @ts-expect-error The user factory owns this column and its foreign key.
            userTable("duplicate_user_owner", { userId: text("user_id"), id: text("id") });
            // @ts-expect-error Organization ownership requires an organization auth table.
            forOrg({ user: auth.user });
        };
        void compileTimeAssertions;
    });

    test("keeps ownership columns in generated migrations", () => {
        const { cdbTable } = forOrg(auth);
        const projects = cdbTable("owned_migration_projects", {
            id: text("id").primaryKey(),
            name: text("name").notNull(),
        });
        const baseline = defineSchemaBaseline({
            version: 1,
            name: "owned_schema",
            domainSchema: { projects },
            authOptions: auth.options,
        });

        expect(baseline.statements).toEqual([expect.stringContaining('"organization_id" text NOT NULL')]);
    });

    test("autofills verified ownership and rejects forged values", () => {
        const { cdbTable } = forOrgUser(auth);
        const drafts = cdbTable(
            "owned_runtime_drafts",
            { id: text("id").primaryKey(), title: text("title").notNull() },
            { roles: { self: { create: "*", read: "*" } } }
        );
        const authority = { userId: "user-1", tenantId: "org-1", role: "member", claims: {} } as const;
        const accepted = insertCapture();

        wrapDb(accepted.db, authority).insert(drafts).values({ id: "draft-1", title: "Accepted" });
        expect(accepted.rows()).toEqual({
            id: "draft-1",
            title: "Accepted",
            organizationId: "org-1",
            userId: "user-1",
        });

        const forged = insertCapture();
        expect(() =>
            wrapDb(forged.db, authority)
                .insert(drafts)
                .values({ id: "draft-2", title: "Forged", organizationId: "org-2" })
        ).toThrow(CdbError);
        expect(forged.rows()).toBeUndefined();

        const mine = { id: "mine", organization_id: "org-1", user_id: "user-1", title: "Mine" };
        expect(
            applyRowPolicies({
                op: "select",
                auth: authority,
                rows: [
                    mine,
                    { id: "peer", organization_id: "org-1", user_id: "user-2", title: "Peer" },
                    { id: "other-org", organization_id: "org-2", user_id: "user-1", title: "Other" },
                ],
                policies: compileCdbPolicies(drafts),
            })
        ).toEqual([mine]);
    });

    test("rejects ownership overrides even through untyped input", () => {
        const { cdbTable } = forOrg(auth);
        expect(() =>
            cdbTable("owned_duplicate_runtime", { id: text("id"), organizationId: text("organization_id") } as never)
        ).toThrow(/organizationId is managed/);
        expect(() =>
            cdbTable("owned_tenant_override_runtime", { id: text("id") }, { tenantBy: "id" } as never)
        ).toThrow(/tenantBy is fixed/);
        expect(() => forOrg({} as never)).toThrow(/auth\.organization\.id/);
    });
});
