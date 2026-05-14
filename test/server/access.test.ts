/**
 * Coverage for `chardb/server/access` — the declarative policy
 * primitives that compose better-auth's authorization model into chardb.
 *
 * We exercise each primitive end-to-end against an in-memory row set,
 * confirming:
 *   - tenant rows leak across orgs ⇒ `tenantScope` filters them out
 *   - owner rows from other users ⇒ `ownerScope` filters them out
 *   - non-admin callers ⇒ `requireRole("admin")` yields zero rows
 *   - the `request` map drives `requirePermission` exactly like
 *     `role.authorize()` does inside better-auth
 *   - `publicRead` admits everyone, anonymous included
 *   - the better-auth `createAccessControl` re-export shares the same
 *     statements/role types so a single `defaultAc` / `defaultRoles`
 *     pair powers both chardb policies and better-auth endpoint checks.
 */

import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
    createAccessControl,
    defineRoles,
    ownerScope,
    publicRead,
    requirePermission,
    requireRole,
    tenantScope,
} from "../../src/server/access.ts";
import type { AuthCtx } from "../../src/server/define.ts";
import { applyRowPolicies } from "../../src/server/policy.ts";

// Drizzle fixtures match the positional-table signature the access
// helpers expect; the `getTableName` lookup gives every auto-generated
// policy name (e.g. `messages_tenant`) without a manual string.
const messages = sqliteTable("messages", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
});

const workspaces = sqliteTable("workspaces", {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
});

interface DemoRow {
    readonly id: string;
    readonly organizationId: string;
    readonly authorId: string;
    readonly body: string;
}

const ROWS: readonly DemoRow[] = [
    { id: "1", organizationId: "org-A", authorId: "u-1", body: "hi" },
    { id: "2", organizationId: "org-A", authorId: "u-2", body: "yo" },
    { id: "3", organizationId: "org-B", authorId: "u-1", body: "elsewhere" },
    { id: "4", organizationId: "org-B", authorId: "u-3", body: "third user" },
];

function auth(overrides: Partial<AuthCtx>): AuthCtx {
    return {
        userId: "u-1",
        tenantId: "org-A",
        role: "member",
        claims: {},
        ...overrides,
    };
}

describe("tenantScope", () => {
    test("filters rows whose organizationId !== auth.tenantId", () => {
        const policy = tenantScope(messages);
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ tenantId: "org-A" }),
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered.map(r => r.id).sort()).toEqual(["1", "2"]);
    });

    test("auto-generated policy name uses the table identifier", () => {
        expect(tenantScope(messages).name).toBe("messages_tenant");
    });

    test("empty tenantId ⇒ no rows visible", () => {
        const policy = tenantScope(messages);
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ tenantId: undefined }),
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered).toEqual([]);
    });

    test("custom column override", () => {
        interface AltRow {
            readonly id: string;
            readonly workspaceId: string;
        }
        const rows: AltRow[] = [
            { id: "x", workspaceId: "w-1" },
            { id: "y", workspaceId: "w-2" },
        ];
        const policy = tenantScope(workspaces, { column: "workspaceId" });
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ tenantId: "w-2" }),
            rows,
            policies: [policy],
        });
        expect(filtered.map(r => r.id)).toEqual(["y"]);
    });

    test("authDependsOn defaults to better-auth tenant-keyed models", () => {
        const policy = tenantScope(messages);
        expect(policy.authDependsOn).toEqual([
            "organization",
            "member",
            "invitation",
            "team",
            "teamMember",
            "organizationRole",
        ]);
    });
});

describe("ownerScope", () => {
    test("filters rows whose authorId !== auth.userId", () => {
        const policy = ownerScope(messages);
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ userId: "u-2" }),
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered.map(r => r.id)).toEqual(["2"]);
    });

    test("authDependsOn defaults to better-auth principal-keyed models", () => {
        const policy = ownerScope(messages);
        expect(policy.authDependsOn).toContain("user");
        expect(policy.authDependsOn).toContain("session");
        expect(policy.authDependsOn).toContain("apiKey");
    });
});

describe("requireRole", () => {
    test("non-admin callers get zero rows", () => {
        const policy = requireRole(messages, "admin");
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ role: "member" }),
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered).toEqual([]);
    });

    test("admin callers see every row", () => {
        const policy = requireRole(messages, "admin");
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ role: "admin" }),
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered.length).toBe(ROWS.length);
    });

    test("comma-separated roles match better-auth multi-role convention", () => {
        const policy = requireRole(messages, ["admin", "owner"]);
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ role: "billing,owner" }),
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered.length).toBe(ROWS.length);
    });

    test("`roles` array on the auth ctx takes priority over `role`", () => {
        const policy = requireRole(messages, "admin");
        const filtered = applyRowPolicies({
            op: "select",
            auth: auth({ role: "member", roles: ["admin"] }),
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered.length).toBe(ROWS.length);
    });
});

describe("requirePermission", () => {
    test("evaluates against a better-auth AccessControl", () => {
        const ac = createAccessControl({
            messages: ["create", "delete"],
        } as const);
        const roles = {
            admin: ac.newRole({ messages: ["create", "delete"] }),
            member: ac.newRole({ messages: ["create"] }),
        };

        const policy = requirePermission(messages, roles, { messages: ["delete"] }, { for: "delete" });

        // Member can't delete.
        expect(
            applyRowPolicies({
                op: "delete",
                auth: auth({ role: "member" }),
                rows: ROWS,
                policies: [policy],
            })
        ).toEqual([]);

        // Admin can.
        expect(
            applyRowPolicies({
                op: "delete",
                auth: auth({ role: "admin" }),
                rows: ROWS,
                policies: [policy],
            }).length
        ).toBe(ROWS.length);
    });

    test("requirePermission ignores callers whose role isn't registered", () => {
        const ac = createAccessControl({ messages: ["delete"] } as const);
        const roles = { admin: ac.newRole({ messages: ["delete"] }) };
        const policy = requirePermission(messages, roles, { messages: ["delete"] }, { for: "delete" });
        expect(
            applyRowPolicies({
                op: "delete",
                auth: auth({ role: "nonexistent" }),
                rows: ROWS,
                policies: [policy],
            })
        ).toEqual([]);
    });
});

describe("defineRoles", () => {
    test("owner and admin implicitly get ALL permissions on declared resources", () => {
        const chatRoles = defineRoles({
            messages: ["create", "update", "delete"],
            channels: ["create", "rename", "delete"],
        });
        expect(chatRoles.owner.authorize({ messages: ["delete"] }).success).toBe(true);
        expect(chatRoles.owner.authorize({ channels: ["delete"] }).success).toBe(true);
        expect(chatRoles.admin.authorize({ messages: ["delete"] }).success).toBe(true);
        expect(chatRoles.admin.authorize({ channels: ["rename"] }).success).toBe(true);
    });

    test("member implicitly gets NO permissions on declared resources", () => {
        const chatRoles = defineRoles({
            messages: ["create", "update", "delete"],
        });
        expect(chatRoles.member.authorize({ messages: ["create"] }).success).toBe(false);
        expect(chatRoles.member.authorize({ messages: ["delete"] }).success).toBe(false);
    });

    test("admin overrides restrict; member overrides grant", () => {
        const chatRoles = defineRoles(
            {
                messages: ["create", "update", "delete"],
                channels: ["create", "rename", "delete"],
            },
            {
                admin: { channels: ["create", "rename"] },
                member: { messages: ["create"] },
            }
        );
        expect(chatRoles.admin.authorize({ channels: ["delete"] }).success).toBe(false);
        expect(chatRoles.admin.authorize({ channels: ["rename"] }).success).toBe(true);
        expect(chatRoles.member.authorize({ messages: ["create"] }).success).toBe(true);
        expect(chatRoles.member.authorize({ messages: ["delete"] }).success).toBe(false);
    });

    test("custom role names (no defaults) are supported", () => {
        const roles = defineRoles({ reports: ["read", "export"] }, { viewer: { reports: ["read"] } });
        expect(roles.viewer.authorize({ reports: ["read"] }).success).toBe(true);
        expect(roles.viewer.authorize({ reports: ["export"] }).success).toBe(false);
    });

    test("roles produced by defineRoles drop straight into requirePermission", () => {
        const chatRoles = defineRoles({ messages: ["delete"] }, { admin: { messages: ["delete"] }, member: {} });
        const policy = requirePermission(messages, chatRoles, { messages: ["delete"] }, { for: "delete" });
        expect(
            applyRowPolicies({
                op: "delete",
                auth: auth({ role: "admin" }),
                rows: ROWS,
                policies: [policy],
            }).length
        ).toBe(ROWS.length);
        expect(
            applyRowPolicies({
                op: "delete",
                auth: auth({ role: "member" }),
                rows: ROWS,
                policies: [policy],
            }).length
        ).toBe(0);
    });

    test("roles accepted as a thunk for cycle-safe declaration", () => {
        // Simulate "chatRoles lives in worker.ts, api.ts references it
        // via a thunk because the value is in TDZ at api.ts module init."
        // We stash the roles inside an object so biome's `useConst`
        // doesn't flag a late-initialised `let`.
        const lateBound: { roles?: ReturnType<typeof defineRoles> } = {};
        const policy = requirePermission(
            messages,
            () => {
                if (!lateBound.roles) throw new Error("unexpected early read");
                return lateBound.roles;
            },
            { messages: ["delete"] },
            { for: "delete" }
        );
        // First time anything would access roles is when applyRowPolicies
        // calls the check function — by then `lateBound.roles` is set.
        lateBound.roles = defineRoles({ messages: ["delete"] }, { admin: { messages: ["delete"] } });
        expect(
            applyRowPolicies({
                op: "delete",
                auth: auth({ role: "admin" }),
                rows: ROWS,
                policies: [policy],
            }).length
        ).toBe(ROWS.length);
    });
});

describe("publicRead", () => {
    test("admits unauthenticated callers", () => {
        const policy = publicRead(messages);
        const filtered = applyRowPolicies({
            op: "select",
            auth: { userId: "", claims: {} },
            rows: ROWS,
            policies: [policy],
        });
        expect(filtered.length).toBe(ROWS.length);
    });

    test('policy.to is `"*"` so anonymous traffic passes', () => {
        const policy = publicRead(messages);
        expect(policy.to).toBe("*");
    });
});
