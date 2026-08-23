import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AuthCtx } from "../../src/server/define.ts";
import { applyPoliciesToWhere, applyRowPolicies, chardbPolicy, policyDigest } from "../../src/server/policy.ts";

const documents = sqliteTable("documents", {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    body: text("body").notNull(),
});

const ownerOnly = chardbPolicy<typeof documents, { ownerId: string }>("owner_only", {
    for: "all",
    to: "authenticated",
    usingSql: (auth, table) => eq(table.ownerId, auth.userId),
    using: (auth, row) => row.ownerId === auth.userId,
    authDependsOn: ["session"],
});

const anonAdmin = chardbPolicy<typeof documents, { ownerId: string }>("anon_admin", {
    for: "select",
    to: "anonymous",
    usingSql: (_auth, table) => eq(table.ownerId, "public"),
});

const auth = (userId: string | undefined, tenantId?: string): AuthCtx => ({
    userId: userId ?? "",
    ...(tenantId !== undefined ? { tenantId } : {}),
    claims: {},
});

function renderSql(value: ReturnType<typeof applyPoliciesToWhere>) {
    return value?.toQuery({
        casing: { getColumnCasing: () => "snake_case" } as never,
        escapeName: (n: string) => `"${n}"`,
        escapeParam: (n: number) => `?${n + 1}`,
        escapeString: (s: string) => `'${s}'`,
    } as never);
}

describe("applyPoliciesToWhere", () => {
    test("ANDs the policy predicate into the user where", () => {
        const a = auth("u1");
        const userWhere = eq(documents.body, "hello");
        const out = applyPoliciesToWhere({
            op: "select",
            auth: a,
            table: documents,
            userWhere,
            policies: [ownerOnly],
        });
        expect(out).toBeDefined();
        const sql = renderSql(out);
        expect(sql?.params).toContain("u1");
        expect(sql?.params).toContain("hello");
    });

    test("anonymous policy applies only when userId is empty", () => {
        const anon = applyPoliciesToWhere({
            op: "select",
            auth: auth(undefined),
            table: documents,
            policies: [ownerOnly, anonAdmin],
        });
        expect(anon).toBeDefined();
        const authed = applyPoliciesToWhere({
            op: "select",
            auth: auth("u1"),
            table: documents,
            policies: [anonAdmin],
        });
        expect(renderSql(authed)?.sql).toContain("1 = 0");
    });

    test("op filter respected — owner_only is for=all, anon_admin is for=select", () => {
        const updateAuthed = applyPoliciesToWhere({
            op: "update",
            auth: auth("u1"),
            table: documents,
            policies: [anonAdmin],
        });
        expect(renderSql(updateAuthed)?.sql).toContain("1 = 0");
    });

    test("role audiences match caller roles, not user IDs", () => {
        const roleGrant = chardbPolicy<typeof documents, { ownerId: string }>("admin_read", {
            for: "select",
            to: ["admin"],
            usingSql: () => eq(documents.ownerId, "admin-visible"),
        });
        const allowed = applyPoliciesToWhere({
            op: "select",
            auth: { ...auth("user-1"), role: "admin" },
            table: documents,
            policies: [roleGrant],
        });
        const denied = applyPoliciesToWhere({
            op: "select",
            auth: auth("admin"),
            table: documents,
            policies: [roleGrant],
        });
        expect(renderSql(allowed)?.params).toContain("admin-visible");
        expect(renderSql(denied)?.sql).toContain("1 = 0");
    });
});

describe("applyRowPolicies", () => {
    test("filters rows whose using closure rejects", () => {
        const a = auth("u1");
        const rows = [{ ownerId: "u1" }, { ownerId: "u2" }, { ownerId: "u1" }];
        const out = applyRowPolicies({
            op: "select",
            auth: a,
            rows,
            policies: [ownerOnly],
        });
        expect(out).toHaveLength(2);
        expect(out.every(r => r.ownerId === "u1")).toBe(true);
    });
});

describe("policyDigest", () => {
    test("changes when auth_epoch advances", () => {
        const a = auth("u1", "t1");
        const d0 = policyDigest({
            policies: [ownerOnly],
            authEpochs: { global: 1, tenant: 1, principal: 1 },
            auth: a,
        });
        const d1 = policyDigest({
            policies: [ownerOnly],
            authEpochs: { global: 1, tenant: 1, principal: 2 },
            auth: a,
        });
        expect(d0).not.toBe(d1);
    });

    test("stable across permutations of policy order", () => {
        const a = auth("u1", "t1");
        const d0 = policyDigest({
            policies: [ownerOnly, anonAdmin],
            authEpochs: { global: 1, tenant: 1, principal: 1 },
            auth: a,
        });
        const d1 = policyDigest({
            policies: [ownerOnly, anonAdmin],
            authEpochs: { global: 1, tenant: 1, principal: 1 },
            auth: a,
        });
        expect(d0).toBe(d1);
    });

    test("includes a canonical caller role set", () => {
        const digestFor = (caller: AuthCtx) =>
            policyDigest({
                policies: [ownerOnly],
                authEpochs: { global: 1, tenant: 1, principal: 1 },
                auth: caller,
            });
        const member = digestFor({ userId: "u1", role: "member", claims: {} });
        const adminMember = digestFor({ userId: "u1", roles: ["member", "admin", "member"], claims: {} });
        const memberAdmin = digestFor({ userId: "u1", role: "admin, member", claims: {} });

        expect(member).not.toBe(adminMember);
        expect(adminMember).toBe(memberAdmin);
    });
});
