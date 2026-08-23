/**
 * Tenant factories — the ONLY way to obtain a `cdbTable` constructor.
 *
 * A schema file declares its tenancy axis once at the top:
 *
 *   const { cdbTable } = forOrg();   // every table is org-tenanted
 *   const { cdbTable } = forUser();  // every table is user-tenanted
 *   const { cdbTable } = global();   // no tenant; partitionBy: required
 *
 * Lifting the declaration out of every per-table config eliminates a
 * footgun (writing `tenant: "organizationId"` on six tables and
 * forgetting the seventh) and makes the file's contract explicit.
 *
 * The returned `cdbTable` is bound to that tenancy axis: it carries the
 * tenant kind + the auth target table name, both of which the boot-time
 * meta resolver consumes to auto-discover the tenant column from the
 * schema's `.references()` chain.
 *
 * Mixing tenancy axes in one file is a deliberate non-goal — schemas
 * that need both an org-tenanted and a user-tenanted table split into
 * two files. The factory pattern makes this constraint enforceable: a
 * file imports `forOrg` xor `forUser` xor `global`; mixing factories
 * inside one file produces visibly weird code that's easy to flag in
 * review (and at the eslint layer we ship a `no-mixed-tenant-factories`
 * rule for the strict path).
 */

import type { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import type { sqliteTable } from "drizzle-orm/sqlite-core";
import type { AuthTargetKind, CdbTableConfig, TenantKind } from "./cdb-table-types.ts";
import { type CdbColumnsInput, createCdbTable } from "./cdb-table.ts";

/** The Drizzle table type `sqliteTable(name, cols)` produces, with column inference preserved. */
type BuiltTable<TName extends string, TCols extends CdbColumnsInput> = SQLiteTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: ReturnType<typeof sqliteTable<TName, TCols>>["_"]["columns"];
    dialect: "sqlite";
}>;

/**
 * Compute the union of column keys chardb's INSERT auto-fill (the
 * `wrapDb` proxy in `cdb-db-proxy.ts`) populates from `ctx.auth`:
 *
 *   - `selfBy` when set explicitly in `config.selfBy`
 *   - `tenantBy` when set explicitly in `config.tenantBy`
 *   - the conventional tenant column (`organizationId` / `userId`)
 *     when present in `TCols` and no explicit `tenantBy` overrides
 *
 * The auto-discovered FK-walk path resolves at boot time and so can't
 * drive the type-level optionality from here; the convention rule
 * covers the standard chat / SaaS naming and `tenantBy: "..."` covers
 * everything else.
 */
type AutoFillKeys<K extends TenantKind, TCols, TConfig> =
    | (TConfig extends { readonly selfBy: infer S extends string } ? S & keyof TCols & string : never)
    | (TConfig extends { readonly tenantBy: infer T extends string }
          ? T & keyof TCols & string
          : K extends "org"
            ? "organizationId" extends keyof TCols
                ? "organizationId"
                : never
            : K extends "user"
              ? "userId" extends keyof TCols
                  ? "userId"
                  : never
              : never);

/**
 * Override `$inferInsert` on the underlying Drizzle table type so the
 * auto-fillable keys collapse from required → optional. `.values(...)`
 * derives its parameter type from `TTable['$inferInsert']`
 * (`SQLiteInsertValue<TTable>`), so this propagates cleanly without
 * touching the column builders themselves — the runtime shape Drizzle
 * snapshots in `_.columns` is unchanged, and the proxy fills the value
 * before Drizzle's insert builder runs.
 */
type CdbBuiltTable<TName extends string, TCols extends CdbColumnsInput, TAutoFill extends string> = BuiltTable<
    TName,
    TCols
> extends infer T
    ? T extends { readonly $inferInsert: infer I }
        ? Omit<T, "$inferInsert"> & {
              readonly $inferInsert: Omit<I, TAutoFill & keyof I> & Partial<Pick<I, TAutoFill & keyof I>>;
          }
        : T
    : never;

export interface BoundCdbTable<K extends TenantKind> {
    /**
     * Construct a tenancy-bound table. The tenant column is auto-
     * discovered from the FK to the factory's auth target on first
     * access (boot time) — no `tenant:` field required per table.
     * Provide `tenantBy: "<colName>"` only when auto-discovery is
     * ambiguous (multiple FKs to the auth target).
     *
     * The return type preserves the column shape `TCols` (so
     * `messages.id` is a typed Drizzle column at the call site) AND
     * narrows `$inferInsert` so chardb's auto-filled columns become
     * optional on `db.insert(table).values(...)` — see `AutoFillKeys`
     * for the exact rule set.
     */
    cdbTable<TName extends string, TCols extends CdbColumnsInput, const TConfig extends CdbTableConfig<TCols, K>>(
        name: TName,
        columns: TCols,
        config?: TConfig
    ): CdbBuiltTable<TName, TCols, AutoFillKeys<K, TCols, TConfig>>;
}

const ORG_FACTORY: BoundCdbTable<"org"> = makeBound<"org">("org", "organization");
const USER_FACTORY: BoundCdbTable<"user"> = makeBound<"user">("user", "user");
const GLOBAL_FACTORY: BoundCdbTable<"none"> = makeBound<"none">("none", null);

/**
 * Org-tenanted schema file. Every `cdbTable` returned has its tenant
 * column auto-discovered from a `.references(() => auth.organization.id)`
 * call — defaulting `partitionBy` to that column, RLS to org-equality,
 * INSERT auto-fill to `ctx.auth.tenantId`, and the role lattice to
 * `member.role` for the active org.
 */
export function forOrg(): BoundCdbTable<"org"> {
    return ORG_FACTORY;
}

/**
 * User-tenanted schema file. Tenant column is the user FK; partition by
 * user; role lattice is `user.role` (better-auth admin plugin); `self`
 * is implicit (you ARE the tenant) — `selfBy:` is not required and not
 * accepted on tables in this file.
 */
export function forUser(): BoundCdbTable<"user"> {
    return USER_FACTORY;
}

/**
 * Global / no-tenant schema file. No RLS predicate. Every table MUST
 * specify `partitionBy:` explicitly (no implicit tenant column to
 * default to). Use for catalog / lookup tables shared across all
 * tenants. Role lattice is `user.role`.
 */
// Renamed to `globalScope` because `global` shadows the lib.dom global
// symbol in some toolchains; the export is re-aliased downstream when
// needed but the canonical name avoids the ambient collision.
export function globalScope(): BoundCdbTable<"none"> {
    return GLOBAL_FACTORY;
}

function makeBound<K extends TenantKind>(kind: K, target: AuthTargetKind): BoundCdbTable<K> {
    return Object.freeze({
        cdbTable<TName extends string, TCols extends CdbColumnsInput, const TConfig extends CdbTableConfig<TCols, K>>(
            name: TName,
            columns: TCols,
            config?: TConfig
        ): CdbBuiltTable<TName, TCols, AutoFillKeys<K, TCols, TConfig>> {
            return createCdbTable<TName, TCols, K>({
                name,
                columns,
                config: (config ?? ({} as CdbTableConfig<TCols, K>)) as CdbTableConfig<TCols, K>,
                tenantKind: kind,
                authTarget: target,
            }) as CdbBuiltTable<TName, TCols, AutoFillKeys<K, TCols, TConfig>>;
        },
    });
}
