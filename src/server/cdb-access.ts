/**
 * Materialize a single better-auth `AccessControl` + `RolesMap` from
 * every `cdbTable` in the user's schema.
 *
 * Algorithm:
 *   1. Walk the schema's cdbTable exports (`collectCdbTables`).
 *   2. Compute `Statements`: every cdbTable contributes `{ <tableName>:
 *      ROW_VERBS }`. Verbs are intrinsic — every table supports the
 *      same four — so the statement record is uniform.
 *   3. For every role name appearing in any table's `roles:` block,
 *      compute its `Subset<...>` permission map (which verbs it has on
 *      which resources).
 *   4. `createAccessControl(statements)` and `ac.newRole(perm)` per
 *      role. Smart defaults: bare `admin` keeps the conventional ALL on
 *      every resource it didn't explicitly restrict; `member` defaults
 *      to empty unless opted in; custom names get only what they
 *      explicitly listed.
 *
 * `user:`-prefixed role names are stripped of their prefix and routed
 * to a parallel "user role" map that the admin plugin's lattice
 * consumes; they DO NOT participate in the org-scoped AccessControl
 * (which would be wrong — the org plugin's roles are per-membership,
 * not per-user).
 *
 * Result: `{ ac, roles, userRoles }`. `chardb()` patches the user's
 * `organization()` plugin instance with `{ ac, roles }` and the
 * `admin()` plugin with `{ roles: userRoles }`.
 */

import { createAccessControl } from "better-auth/plugins/access";
import type { AccessControl, Role, Statements } from "better-auth/plugins/access";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import {
    type CdbTableMeta,
    ROW_VERBS,
    type Verb,
} from "./cdb-table-types.ts";
import { resolveCdbMeta } from "./cdb-table.ts";

export interface BuiltAccessControl {
    readonly ac: AccessControl<Statements>;
    /** Org-scoped roles (member.role lattice). */
    readonly roles: Readonly<Record<string, Role<Statements>>>;
    /** User-scoped roles (user.role / admin plugin lattice). */
    readonly userRoles: Readonly<Record<string, Role<Statements>>>;
}

/**
 * Walk a schema namespace and build a single AccessControl that covers
 * every cdbTable. Idempotent: calling twice with the same schema returns
 * structurally identical maps.
 */
export function buildAccessControl(schema: Record<string, unknown>): BuiltAccessControl {
    const tables = collectCdbTables(schema);
    if (tables.length === 0) {
        const ac = createAccessControl({});
        return { ac, roles: {}, userRoles: {} };
    }

    // Statements = { <tableName>: ["read","create","update","delete"] }
    const statements: Record<string, readonly Verb[]> = {};
    for (const t of tables) statements[t.meta.name] = ROW_VERBS;

    // Collect role names. Bare names (member, admin, owner, custom) ⇒
    // org-scoped. `user:`-prefixed ⇒ user-scoped.
    const orgRoles = new Set<string>();
    const userRoleNames = new Set<string>();

    // Gather grants per role per table per verb.
    type Grant = { readonly [tableName: string]: readonly Verb[] };
    const orgGrants = new Map<string, Map<string, Set<Verb>>>();
    const userGrants = new Map<string, Map<string, Set<Verb>>>();

    for (const { meta } of tables) {
        for (const [roleName, value] of Object.entries(meta.rawRoles)) {
            if (roleName === "self") continue;
            const target = roleName.startsWith("user:") ? userGrants : orgGrants;
            const cleanedName = roleName.startsWith("user:") ? roleName.slice("user:".length) : roleName;
            if (roleName.startsWith("user:")) userRoleNames.add(cleanedName);
            else orgRoles.add(cleanedName);

            const verbs = expandRoleVerbs(value);
            let perTable = target.get(cleanedName);
            if (!perTable) {
                perTable = new Map();
                target.set(cleanedName, perTable);
            }
            let perVerb = perTable.get(meta.name);
            if (!perVerb) {
                perVerb = new Set();
                perTable.set(meta.name, perVerb);
            }
            for (const v of verbs) perVerb.add(v);
        }
    }

    const ac = createAccessControl(statements as Statements);

    const buildRolesMap = (
        names: ReadonlySet<string>,
        grants: ReadonlyMap<string, Map<string, Set<Verb>>>
    ): Record<string, Role<Statements>> => {
        const out: Record<string, Role<Statements>> = {};
        for (const name of names) {
            const perTable = grants.get(name) ?? new Map();
            const subset: Record<string, Verb[]> = {};
            for (const t of tables) {
                const verbs = perTable.get(t.meta.name);
                if (!verbs || verbs.size === 0) continue;
                subset[t.meta.name] = [...verbs];
            }
            // Smart defaults for the conventional names.
            if (name === "admin" || name === "owner") {
                for (const t of tables) {
                    if (!subset[t.meta.name]) subset[t.meta.name] = [...ROW_VERBS];
                }
            }
            out[name] = ac.newRole(subset as never) as unknown as Role<Statements>;
        }
        return out;
    };

    return {
        ac,
        roles: buildRolesMap(orgRoles, orgGrants),
        userRoles: buildRolesMap(userRoleNames, userGrants),
    };
}

function expandRoleVerbs(value: unknown): readonly Verb[] {
    if (value === "*" || value === true) return ROW_VERBS;
    if (value === false || value === undefined || value === null) return [];
    if (Array.isArray(value)) return value as readonly Verb[];
    if (typeof value === "object") {
        const out: Verb[] = [];
        for (const v of ROW_VERBS) {
            const vv = (value as { readonly [V in Verb]?: unknown })[v];
            if (vv === undefined || vv === false) continue;
            out.push(v);
        }
        return out;
    }
    return [];
}

/**
 * Resolve a single table's meta and assert it before consumers (e.g.
 * the colocation builder) walk it. Surfaces ambiguity at boot, not at
 * first query.
 */
export function preflightCdbTable(table: SQLiteTable): CdbTableMeta {
    try {
        return resolveCdbMeta(table);
    } catch (err) {
        if (err instanceof CdbError) throw err;
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `cdbTable preflight failed: ${(err as Error).message}`,
        });
    }
}
