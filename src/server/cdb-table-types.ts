/**
 * Type vocabulary shared across the cdbTable subsystem.
 *
 * The ownership factory layer (`schema-ownership.ts`) and the table builder
 * (`cdb-table.ts`) both consume these types; the registry
 * (`cdb-table-registry.ts`) stores them at runtime. Splitting them
 * into a leaf module avoids the import cycle every other arrangement
 * would create.
 *
 * Two parallel layers are modelled:
 *   - **Authoring types** (`CdbTableConfig`, `RoleValue`, `VerbValue`)
 *     constrain what the schema author can write inside a `cdbTable
 *     (...)` call. Discriminated on factory scope so `forOrgUser()` can
 *     require both organization and user ownership, `forUser()` rejects
 *     `selfBy:` (self is implicit there), and internal non-tenant tables
 *     require `partitionBy:`.
 *   - **Resolved metadata** (`CdbTableMeta`) is the compile-once boot-
 *     time record stored in the WeakMap. It carries the auto-discovered
 *     tenant column, materialized roles, partition spec, and audit
 *     trail (source key) the rest of the framework consumes.
 *
 * Verbs are intrinsic: `Verb` is fixed at four values for row-level
 * (`read`/`create`/`update`/`delete`) and `ColVerb` is fixed at three
 * for column-level (no column-level delete; you cannot remove part of
 * a row). There is no `defineRoles(...)` to extend the verb vocabulary.
 */

import type { SQLiteTable } from "drizzle-orm/sqlite-core";

export type Verb = "read" | "create" | "update" | "delete";
export type ColVerb = "read" | "create" | "update";

export const ROW_VERBS: readonly Verb[] = Object.freeze(["read", "create", "update", "delete"]);
export const COL_VERBS: readonly ColVerb[] = Object.freeze(["read", "create", "update"]);

/** The tenancy axis a schema file is bound to via its factory. */
export type TenantKind = "org" | "user" | "none";

/** The schema authoring scope selected by a cdbTable factory. */
export type CdbScopeKind = TenantKind | "orgUser";

/**
 * The subset of role names with framework meaning. `self` is reserved
 * (binds to the row's user-FK column via `selfBy`); other names match
 * the active tenancy lattice (`member.role` for `forOrg`,
 * `user.role` for `forUser` and internal tables). A `user:`-prefixed name always
 * matches `user.role` regardless of file lattice.
 */
export type ReservedRoleName = "owner" | "admin" | "member" | "self";
export type RoleName = ReservedRoleName | (string & {});

/**
 * Per-verb value inside `roles:`. Column-granular for the three CLS
 * verbs; the `delete` verb ignores the column list (columns can't be
 * partially deleted) but still accepts `true` / `false` / `"*"` /
 * `string[]` for shape uniformity.
 */
// `_V` is an unused phantom for now (kept for future per-verb shape
// divergence — e.g. `delete` rejecting the `string[]` form). The type
// stays consumer-positionally identical to the array/exclude/boolean
// universe across all four verbs today.
export type VerbValue<TCols, _V extends Verb = Verb> =
    | "*"
    | readonly (keyof TCols & string)[]
    | { readonly exclude: readonly (keyof TCols & string)[] }
    | true
    | false;

/**
 * Per-role value: either a verb-only shorthand (`"*"` = all verbs, all
 * columns; `["read","create"]` = these verbs, all columns) or a
 * per-verb breakdown.
 */
export type RoleValue<TCols> = "*" | readonly Verb[] | { readonly [V in Verb]?: VerbValue<TCols> };

/** Column-axis CLS spec: one entry per column, listing which roles get each verb. */
export type ColumnSpec<_TCols, R extends string = RoleName> = {
    readonly read?: readonly R[];
    readonly create?: readonly R[];
    readonly update?: readonly R[];
};

interface BaseConfigCommon<TCols> {
    /**
     * Per-table override for the auto-discovered tenant column. Only
     * required when a table contains multiple FKs to the factory's
     * auth target (e.g. both `parentOrgId` and `tenantOrgId`); otherwise
     * left blank.
     */
    readonly tenantBy?: keyof TCols & string;
    /**
     * Override the partition column (defaults to the tenant column under
     * `forOrg`/`forUser`; required under `global`). Single string =
     * single-column FK partition. Array = composite FK colocation.
     * `"replicated"` = catalog table copied to every shard.
     */
    readonly partitionBy?: (keyof TCols & string) | readonly (keyof TCols & string)[] | "replicated";
    /** Allow anonymous SELECT. Writes still gated by `roles:`. */
    readonly publicRead?: boolean;
}

/** When `self` may appear, selfBy is required if a policy uses it. */
type WithOptionalSelf<TCols> =
    | (BaseConfigCommon<TCols> & {
          readonly selfBy?: never;
          readonly roles?: { readonly [R in Exclude<RoleName, "self">]?: RoleValue<TCols> };
          readonly columns?: { readonly [C in keyof TCols & string]?: ColumnSpec<TCols, Exclude<RoleName, "self">> };
      })
    | (BaseConfigCommon<TCols> & {
          readonly selfBy: keyof TCols & string;
          readonly roles?: { readonly [R in RoleName]?: RoleValue<TCols> };
          readonly columns?: { readonly [C in keyof TCols & string]?: ColumnSpec<TCols, RoleName> };
      });

/** When self is implicit (forUser): no selfBy, but `self` allowed in roles for shape symmetry. */
type SelfImplicit<TCols> = BaseConfigCommon<TCols> & {
    readonly selfBy?: never;
    readonly roles?: { readonly [R in RoleName]?: RoleValue<TCols> };
    readonly columns?: { readonly [C in keyof TCols & string]?: ColumnSpec<TCols, RoleName> };
};

/**
 * Organization-routed rows owned by a user inside that organization.
 * `selfBy` is optional because forOrgUser auto-discovers the FK to the
 * Better Auth user table. It remains available to disambiguate multiple
 * user FKs.
 */
type OrgUserConfig<TCols> = BaseConfigCommon<TCols> & {
    readonly selfBy?: keyof TCols & string;
    readonly roles?: { readonly [R in RoleName]?: RoleValue<TCols> };
    readonly columns?: { readonly [C in keyof TCols & string]?: ColumnSpec<TCols, RoleName> };
};

/** Internal non-tenant tables must set `partitionBy`. */
type GlobalConfig<TCols> =
    | (BaseConfigCommon<TCols> & {
          readonly partitionBy: (keyof TCols & string) | readonly (keyof TCols & string)[] | "replicated";
          readonly selfBy?: never;
          readonly roles?: { readonly [R in Exclude<RoleName, "self">]?: RoleValue<TCols> };
          readonly columns?: { readonly [C in keyof TCols & string]?: ColumnSpec<TCols, Exclude<RoleName, "self">> };
      })
    | (BaseConfigCommon<TCols> & {
          readonly partitionBy: (keyof TCols & string) | readonly (keyof TCols & string)[] | "replicated";
          readonly selfBy: keyof TCols & string;
          readonly roles?: { readonly [R in RoleName]?: RoleValue<TCols> };
          readonly columns?: { readonly [C in keyof TCols & string]?: ColumnSpec<TCols, RoleName> };
      });

/** The authoring config the user passes to `cdbTable`. */
export type CdbTableConfig<TCols, K extends CdbScopeKind> = K extends "org"
    ? WithOptionalSelf<TCols>
    : K extends "orgUser"
      ? OrgUserConfig<TCols>
      : K extends "user"
        ? SelfImplicit<TCols>
        : GlobalConfig<TCols>;

/**
 * The four canonical auth target tables we care about for tenancy
 * binding. `null` covers internal non-tenant tables. Stored on the meta record so the
 * boot-time validator can match a column's `.references()` target
 * without re-resolving the auth synthesizer.
 */
export type AuthTargetKind = "organization" | "user" | null;

/**
 * Resolved column-level matrix entry. The boot-time compiler folds the
 * role-axis (verb values inside `roles:`) and column-axis (`columns:`)
 * into one structure: per role, per column, per verb, allowed?
 */
export interface ColumnMatrix {
    /** allowed[role][verb] = set of column names allowed (or null for "all"). */
    readonly allowed: ReadonlyMap<string, ReadonlyMap<ColVerb, ReadonlySet<string> | null>>;
    /** Every column the table declares (used to expand "*" / "exclude" forms). */
    readonly allColumns: readonly string[];
}

/**
 * Frozen runtime metadata attached to every `cdbTable` instance. Stored
 * in `cdb-table-registry`'s WeakMap and as a non-enumerable Symbol
 * property on the table itself.
 */
export interface CdbTableMeta {
    /** Drizzle SQL table name (matches `getTableName(table)`). */
    readonly name: string;
    /** Tenancy axis declared by the file's factory. */
    readonly tenantKind: TenantKind;
    /** Auth target the tenant column FKs into; null for internal non-tenant tables. */
    readonly authTarget: AuthTargetKind;
    /** Auth target used to auto-discover user ownership under `forOrgUser()`. */
    readonly selfTarget: "user" | undefined;
    /**
     * Auto-discovered tenant column name (or the explicit `tenantBy`
     * override). Undefined for internal non-tenant tables. Resolved lazily — the
     * registry call site triggers FK walk.
     */
    readonly tenantBy: string | undefined;
    /** Resolved partition spec for the colocation algorithm. */
    readonly partitionBy:
        | { readonly kind: "colocate"; readonly via: readonly string[] }
        | { readonly kind: "self" }
        | { readonly kind: "replicated" };
    /** Whether SELECT is open to anonymous callers. */
    readonly publicRead: boolean;
    /** User-declared roles (raw, unvalidated). */
    readonly rawRoles: { readonly [roleName: string]: RoleValue<Record<string, unknown>> };
    /** User-declared columns axis (raw). */
    readonly rawColumns: { readonly [colName: string]: ColumnSpec<Record<string, unknown>, RoleName> };
    /** Compiled column matrix (the union of role-axis + column-axis). */
    readonly matrix: ColumnMatrix;
    /** Explicit or auto-discovered user ownership column. */
    readonly selfBy: string | undefined;
    /** Source export key used for diagnostics (set by `attachExportKey` once the schema is walked). */
    readonly exportKey?: string;
    /** Underlying Drizzle table reference (forward — useful when meta is discovered without the table value). */
    readonly table: SQLiteTable;
}
