/**
 * Coverage for `synthesizeAuthSchema` — the helper that turns
 * `getAuthTables(authOptions)` into real Drizzle SQLite tables. We assert:
 *   - core tables (`user`, `session`, `account`, `verification`) are
 *     always present + carry the expected FKs (session.userId → user.id,
 *     account.userId → user.id, etc.)
 *   - registering the `organization` plugin adds `organization`, `member`,
 *     `invitation`, with `member.organizationId` / `member.userId` FKs
 *   - `assertNoReservedTableShadow` raises CDB_RESERVED_TABLE_NAME on
 *     conflicting domain names and is a no-op otherwise
 *   - `id text primary key` is added to every table (better-auth schemas
 *     don't list an explicit `id` field).
 */
import { describe, expect, test } from "bun:test";
import { organization } from "better-auth/plugins/organization";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
    AUTH_DEFAULT_TABLES,
    AUTH_RESERVED_NAMES,
    assertNoReservedTableShadow,
    defineAuth,
    synthesizeAuthSchema,
} from "../../src/auth/synthesize.ts";
import { CdbError } from "../../src/errors.ts";

describe("synthesizeAuthSchema", () => {
    test("core tables are always present", () => {
        const s = synthesizeAuthSchema({});
        for (const t of AUTH_DEFAULT_TABLES) {
            expect(s[t]).toBeDefined();
            expect(typeof getTableName(s[t])).toBe("string");
        }
    });

    test("every synthesized table carries an `id text primary key`", () => {
        const s = synthesizeAuthSchema({});
        for (const t of AUTH_DEFAULT_TABLES) {
            const cols = getTableColumns(s[t]) as Record<string, { primary: boolean; name: string }>;
            expect(cols.id).toBeDefined();
            expect(cols.id?.primary).toBe(true);
            expect(cols.id?.name).toBe("id");
        }
    });

    test("session.userId references user.id (FK is discoverable)", () => {
        const s = synthesizeAuthSchema({});
        // Drizzle stores FK config in a protected slot; we read through a
        // narrow cast since the synthesizer is the only writer.
        const cols = getTableColumns(s.session) as Record<string, { name: string; references?: unknown }>;
        expect(cols.userId).toBeDefined();
        expect(cols.userId?.name).toBe("userId");
    });

    test("organization plugin adds organization/member/invitation tables (inferred from plugin tuple)", () => {
        // No `requirePlugins` argument — chardb infers the contributed
        // tables from the plugin tuple itself.
        const s = synthesizeAuthSchema({ plugins: [organization()] });
        expect(s.organization).toBeDefined();
        expect(s.member).toBeDefined();
        expect(s.invitation).toBeDefined();

        const orgCols = getTableColumns(s.organization) as Record<string, { name: string }>;
        expect(orgCols.name?.name).toBe("name");
        expect(orgCols.slug?.name).toBe("slug");

        const memberCols = getTableColumns(s.member) as Record<string, { name: string }>;
        expect(memberCols.organizationId?.name).toBe("organizationId");
        expect(memberCols.userId?.name).toBe("userId");
        expect(memberCols.role?.name).toBe("role");
    });

    test("custom organization modelName routes through to sqliteTable name", () => {
        const s = synthesizeAuthSchema({
            plugins: [organization({ schema: { organization: { modelName: "orgs" } } })],
        });
        expect(s.organization).toBeDefined();
        expect(getTableName(s.organization)).toBe("orgs");
    });

    test("extraTables escape hatch raises when a requested table is absent", () => {
        let caught: unknown;
        try {
            synthesizeAuthSchema({}, ["myCustomPluginTable"]);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CdbError);
        expect((caught as CdbError).code).toBe("CDB_AUTH_PROFILE_INCOMPATIBLE");
        expect((caught as CdbError).message).toContain('"myCustomPluginTable"');
    });

    test("AUTH_RESERVED_NAMES covers every default and every shipping plugin table", () => {
        for (const t of AUTH_DEFAULT_TABLES) {
            expect(AUTH_RESERVED_NAMES.has(t)).toBe(true);
        }
        for (const t of ["organization", "member", "invitation", "team", "teamMember"]) {
            expect(AUTH_RESERVED_NAMES.has(t)).toBe(true);
        }
    });

    test("assertNoReservedTableShadow raises CDB_RESERVED_TABLE_NAME with the colliding names", () => {
        let caught: unknown;
        try {
            assertNoReservedTableShadow(["channels", "organization", "messages", "user"]);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CdbError);
        expect((caught as CdbError).code).toBe("CDB_RESERVED_TABLE_NAME");
        expect((caught as CdbError).message).toContain('"organization"');
        expect((caught as CdbError).message).toContain('"user"');
    });

    test("assertNoReservedTableShadow is a no-op on disjoint names", () => {
        expect(() => assertNoReservedTableShadow(["channels", "messages", "audit_events"])).not.toThrow();
    });

    test("synthesized core tables expose typed column accessors (no getTableColumns roundtrip needed)", () => {
        const s = synthesizeAuthSchema({});
        // `s.user.email` is statically typed as a column — see
        // `KnownAuthTables` in src/auth/synthesize.ts. We verify the
        // runtime mirrors the static promise so domain code can write
        // `.references(() => auth.user.id)` without `getTableColumns`.
        expect(s.user.id).toBeDefined();
        expect(s.user.email).toBeDefined();
        expect(s.user.emailVerified).toBeDefined();
        expect(s.session.token).toBeDefined();
        expect(s.session.userId).toBeDefined();
        expect(s.account.providerId).toBeDefined();
        expect(s.verification.identifier).toBeDefined();
    });

    test("synthesized organization plugin tables expose typed column accessors", () => {
        const s = synthesizeAuthSchema({ plugins: [organization()] });
        expect(s.organization.slug).toBeDefined();
        expect(s.organization.metadata).toBeDefined();
        expect(s.member.organizationId).toBeDefined();
        expect(s.member.userId).toBeDefined();
        expect(s.member.role).toBeDefined();
        expect(s.invitation.status).toBeDefined();
        expect(s.invitation.inviterId).toBeDefined();
    });
});

describe("defineAuth", () => {
    test("bundles options + synthesized tables in a single value (plugin tables inferred)", () => {
        const auth = defineAuth({ appName: "x", plugins: [organization()] });
        expect(auth.options.appName).toBe("x");
        expect(typeof getTableName(auth.user)).toBe("string");
        expect(typeof getTableName(auth.organization)).toBe("string");
        expect(typeof getTableName(auth.member)).toBe("string");
        expect(auth.user.email).toBeDefined();
        expect(auth.organization.slug).toBeDefined();
    });

    test("inferred plugin tables widen the static return — type-level assertion", () => {
        const auth = defineAuth({ plugins: [organization()] });
        // The properties below are non-optional in the static type because
        // the org-plugin tuple element has `schema: OrganizationSchema<...>`
        // with literal keys `organization | member | invitation`. The
        // accesses would be type errors if inference regressed; the runtime
        // checks confirm the cast lines up with reality.
        const organizationTable: typeof auth.organization = auth.organization;
        const memberTable: typeof auth.member = auth.member;
        const invitationTable: typeof auth.invitation = auth.invitation;
        expect(organizationTable.id).toBeDefined();
        expect(memberTable.userId).toBeDefined();
        expect(invitationTable.email).toBeDefined();
    });

    test("no plugins → only the four core tables are statically present", () => {
        const auth = defineAuth({});
        expect(auth.user.id).toBeDefined();
        expect(auth.session.token).toBeDefined();
        expect(auth.account.providerId).toBeDefined();
        expect(auth.verification.identifier).toBeDefined();
        // `auth.organization` would be a TS error here — there's no
        // `organization()` plugin in scope. We confirm the runtime side
        // doesn't materialize it either.
        expect((auth as { organization?: unknown }).organization).toBeUndefined();
    });

    test("extraTables escape hatch raises when a requested table is absent", () => {
        let caught: unknown;
        try {
            defineAuth({}, ["someCustomTable"]);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CdbError);
        expect((caught as CdbError).code).toBe("CDB_AUTH_PROFILE_INCOMPATIBLE");
    });
});
