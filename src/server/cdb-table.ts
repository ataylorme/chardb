/**
 * Internal `cdbTable(name, columns, config)` builder. Not exported
 * directly from `@chardb/core/server`. Schema files obtain an ownership-bound
 * `cdbTable` from `schema-ownership.ts`.
 *
 * Responsibilities:
 *   1. Delegate to Drizzle's `sqliteTable(name, columns)` so downstream
 *      consumers (drizzle-kit, drizzle migrations, query builder typing)
 *      see a normal Drizzle table.
 *   2. Compile the user's `roles:` + `columns:` into a single
 *      `ColumnMatrix` (eagerly — no FK walks needed).
 *   3. Attach `CdbTableMeta` via `attachCdbMeta`.
 *
 * FK-dependent resolution (auto-discovering the tenant column,
 * defaulting `partitionBy` to it) is deferred to `resolveCdbMeta`
 * because `.references()` thunks run lazily — they cannot fire during
 * the worker.ts ↔ schema.ts ESM cycle that user code typically lives
 * inside.
 */

import { type AnyColumn, getTableColumns, getTableName } from "drizzle-orm";
import type { ForeignKey, SQLiteColumnBuilderBase, SQLiteTable, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import { getTableConfig, sqliteTable } from "drizzle-orm/sqlite-core";

import { CdbError } from "../errors.ts";
import { attachCdbMeta, getCdbMeta } from "./cdb-table-registry.ts";
import {
    type AuthTargetKind,
    COL_VERBS,
    type CdbScopeKind,
    type CdbTableConfig,
    type CdbTableMeta,
    type ColVerb,
    type ColumnMatrix,
    type ColumnSpec,
    type RoleName,
    type RoleValue,
    type TenantKind,
    type Verb,
    type VerbValue,
} from "./cdb-table-types.ts";

/**
 * Drizzle column-builder record shape. Mirrors the constraint Drizzle's
 * `sqliteTable` accepts so the user's `cols` argument keeps full
 * inference for `keyof TCols`.
 */
export type CdbColumnsInput = Record<string, SQLiteColumnBuilderBase>;

/** Result of `sqliteTable(name, cols)` with the columns inferred. */
type BuiltTable<TName extends string, TCols extends CdbColumnsInput> = SQLiteTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: ReturnType<typeof sqliteTable<TName, TCols>>["_"]["columns"];
    dialect: "sqlite";
}>;

/**
 * Construct a single cdbTable with an explicit tenancy axis. Ownership
 * factories call this after adding their managed columns.
 */
export function createCdbTable<TName extends string, TCols extends CdbColumnsInput, K extends CdbScopeKind>(args: {
    readonly name: TName;
    readonly columns: TCols;
    readonly config: CdbTableConfig<TCols, K>;
    readonly tenantKind: TenantKind;
    readonly authTarget: AuthTargetKind;
    readonly selfTarget?: "user";
}): BuiltTable<TName, TCols> {
    const table = sqliteTable(args.name, args.columns) as BuiltTable<TName, TCols>;

    // The user types column names in JS (the `keyof TCols` they wrote).
    // Drizzle stores them by JS key but exposes the SQL column name on
    // each column's `.name` field. We materialize a JS→SQL map at boot
    // and translate every reference (selfBy, tenantBy, partitionBy,
    // role-axis column lists, column-axis keys) into SQL names. The
    // matrix + meta are SQL-keyed. Storage and policy helpers use SQL keys;
    // the full-row Drizzle select adapter translates JS-keyed result objects
    // before and after column masking.
    const jsKeys: readonly string[] = Object.freeze(Object.keys(args.columns));
    const cols = getTableColumns(table) as Record<string, { readonly name: string }>;
    const jsToSql: Record<string, string> = {};
    for (const k of jsKeys) {
        const c = cols[k];
        jsToSql[k] = c ? c.name : k;
    }
    const toSql = (jsOrSql: string): string => jsToSql[jsOrSql] ?? jsOrSql;
    const allColumns: readonly string[] = Object.freeze(jsKeys.map(toSql));

    // Eager validation: `selfBy` must reference an actual column when set.
    const cfg = args.config as Record<string, unknown>;
    const selfByJs = typeof cfg.selfBy === "string" ? (cfg.selfBy as string) : undefined;
    if (selfByJs !== undefined && !jsKeys.includes(selfByJs)) {
        throw new CdbError({
            code: "CDB_INVALID_SELF",
            message: `cdbTable("${args.name}"): selfBy "${selfByJs}" is not a column on this table`,
            hint: `add a column named "${selfByJs}" or pick one of: ${jsKeys.join(", ")}`,
        });
    }
    const selfBy = selfByJs !== undefined ? toSql(selfByJs) : undefined;

    // `tenantBy` (manual override) must reference a real column when set.
    const tenantByJs = typeof cfg.tenantBy === "string" ? (cfg.tenantBy as string) : undefined;
    if (tenantByJs !== undefined && !jsKeys.includes(tenantByJs)) {
        throw new CdbError({
            code: "CDB_INVALID_TENANT",
            message: `cdbTable("${args.name}"): tenantBy "${tenantByJs}" is not a column on this table`,
            hint: `add a column named "${tenantByJs}" or pick one of: ${jsKeys.join(", ")}`,
        });
    }
    const tenantByOverride = tenantByJs !== undefined ? toSql(tenantByJs) : undefined;

    const partitionByRaw = cfg.partitionBy as string | readonly string[] | "replicated" | undefined;
    let partitionByResolved: string | readonly string[] | "replicated" | undefined = partitionByRaw;
    if (Array.isArray(partitionByRaw)) {
        const sqlVia: string[] = [];
        for (const c of partitionByRaw) {
            if (!jsKeys.includes(c)) {
                throw new CdbError({
                    code: "CDB_INVALID_PARTITION",
                    message: `cdbTable("${args.name}"): partitionBy column "${c}" not declared on this table`,
                });
            }
            sqlVia.push(toSql(c));
        }
        partitionByResolved = sqlVia;
    } else if (typeof partitionByRaw === "string" && partitionByRaw !== "replicated") {
        if (!jsKeys.includes(partitionByRaw)) {
            throw new CdbError({
                code: "CDB_INVALID_PARTITION",
                message: `cdbTable("${args.name}"): partitionBy column "${partitionByRaw}" not declared on this table`,
            });
        }
        partitionByResolved = toSql(partitionByRaw);
    }

    const rawRoles =
        (cfg.roles as { readonly [k: string]: RoleValue<TCols> } | undefined) ??
        (args.tenantKind === "user" ? ({ self: "*" } as const) : ({} as { readonly [k: string]: RoleValue<TCols> }));
    const rawColumns =
        (cfg.columns as { readonly [k: string]: ColumnSpec<TCols, RoleName> } | undefined) ??
        ({} as { readonly [k: string]: ColumnSpec<TCols, RoleName> });

    // Reject `self` in roles/columns when the file's tenancy axis bans it
    // (non-tenant + missing selfBy → the caller must spell selfBy first; "user" →
    // self is implicit, so an explicit selfBy is rejected).
    if (args.tenantKind === "user" && selfBy !== undefined) {
        throw new CdbError({
            code: "CDB_INVALID_SELF",
            message: `cdbTable("${args.name}"): selfBy is not allowed under forUser() — \`self\` is implicit (you ARE the tenant)`,
            hint: "remove the `selfBy:` field; the `self` role resolves to the user-tenant predicate automatically",
        });
    }
    if (args.tenantKind !== "user" && selfBy === undefined && args.selfTarget === undefined) {
        if (rolesContainSelf(rawRoles) || columnsContainSelf(rawColumns)) {
            throw new CdbError({
                code: "CDB_INVALID_SELF",
                message: `cdbTable("${args.name}"): \`self\` appears in roles/columns but selfBy is missing`,
                hint: 'add `selfBy: "<userFkColumn>"` to bind the row\'s user-FK column',
            });
        }
    }

    const matrix = compileColumnMatrix({
        tableName: args.name,
        jsKeys,
        allColumns,
        toSql,
        rawRoles,
        rawColumns,
    });

    const partitionByMeta = resolvePartitionByMeta(partitionByResolved);

    const meta: CdbTableMeta = Object.freeze({
        name: args.name,
        tenantKind: args.tenantKind,
        authTarget: args.authTarget,
        selfTarget: args.selfTarget ?? (selfBy ? "user" : undefined),
        tenantBy: tenantByOverride,
        partitionBy: partitionByMeta,
        publicRead: cfg.publicRead === true,
        rawRoles: rawRoles as { readonly [k: string]: RoleValue<Record<string, unknown>> },
        rawColumns: rawColumns as { readonly [k: string]: ColumnSpec<Record<string, unknown>, RoleName> },
        matrix,
        selfBy,
        table,
    });

    attachCdbMeta(table, meta);
    return table;
}

/**
 * Public read accessor — lazy. The first call walks the table's foreign
 * keys to auto-discover the tenant column when the file factory is
 * `forOrg`/`forUser` and no explicit `tenantBy:` was set. Subsequent
 * calls return the memoized resolution. Throws on ambiguity / missing.
 */
const RESOLVED = new WeakMap<SQLiteTable, ResolvedCdbMeta>();

export interface ResolvedCdbMeta extends CdbTableMeta {
    /** Resolved tenant column (auto-discovered or explicit). */
    readonly tenantBy: string | undefined;
    /** Resolved user ownership column under forOrgUser or explicit selfBy. */
    readonly selfBy: string | undefined;
}

export function resolveCdbMeta(table: SQLiteTable): ResolvedCdbMeta {
    const cached = RESOLVED.get(table);
    if (cached) return cached;
    const meta = getCdbMeta(table);
    if (!meta) {
        throw new CdbError({
            code: "CDB_NOT_CDB_TABLE",
            message: `${getTableName(table)}: this table was not created by a chardb ownership factory`,
        });
    }
    const tenantBy = autoDiscoverTenantColumn(table, meta);
    const selfBy = resolveSelfColumn(table, meta);
    const resolved: ResolvedCdbMeta = { ...meta, tenantBy, selfBy };
    RESOLVED.set(table, resolved);
    return resolved;
}

function autoDiscoverTenantColumn(table: SQLiteTable, meta: CdbTableMeta): string | undefined {
    if (meta.tenantBy) return meta.tenantBy;
    if (meta.tenantKind === "none" || meta.authTarget === null) return undefined;

    // Walk the table's foreign keys; pick the column FK'd to the auth
    // target. `getTableConfig(table).foreignKeys` invokes each FK
    // builder's thunk, which is fine post-boot since both modules in
    // the worker.ts ↔ schema.ts cycle have fully evaluated by now.
    const cfg = getTableConfig(table);
    const targetName = meta.authTarget;
    const matches: string[] = [];
    for (const fk of cfg.foreignKeys as readonly ForeignKey[]) {
        const ref = fk.reference();
        const foreignTableName = getTableName(ref.foreignTable);
        if (foreignTableName !== targetName) continue;
        for (const col of ref.columns as readonly AnyColumn[]) matches.push(col.name);
    }
    const unique = [...new Set(matches)];
    if (unique.length === 0) {
        throw new CdbError({
            code: "CDB_MISSING_TENANT_FK",
            message: `cdbTable("${meta.name}"): no FK to "${targetName}" found — the file's factory promised a ${meta.tenantKind} tenant column`,
            hint: `add a \`.references(() => auth.${targetName}.id)\` on a column, or move this table to a different tenancy file`,
        });
    }
    if (unique.length > 1) {
        throw new CdbError({
            code: "CDB_AMBIGUOUS_TENANT",
            message: `cdbTable("${meta.name}"): multiple FKs to "${targetName}" (${unique.join(", ")})`,
            hint: `add \`tenantBy: "<colName>"\` to disambiguate`,
        });
    }
    return unique[0];
}

function resolveSelfColumn(table: SQLiteTable, meta: CdbTableMeta): string | undefined {
    if (!meta.selfTarget) return undefined;
    const matches = foreignKeyColumnsTo(table, meta.selfTarget);
    if (meta.selfBy) {
        if (matches.includes(meta.selfBy)) return meta.selfBy;
        throw new CdbError({
            code: "CDB_INVALID_SELF",
            message: `cdbTable("${meta.name}"): selfBy "${meta.selfBy}" does not reference the Better Auth user table`,
            hint: "point selfBy at a column with `.references(() => auth.user.id)`",
        });
    }
    if (matches.length === 0) {
        throw new CdbError({
            code: "CDB_INVALID_SELF",
            message: `cdbTable("${meta.name}"): forOrgUser() requires an FK to "user"`,
            hint: "add a `.references(() => auth.user.id)` column, or use forOrg() for organization-level rows",
        });
    }
    if (matches.length > 1) {
        throw new CdbError({
            code: "CDB_INVALID_SELF",
            message: `cdbTable("${meta.name}"): multiple FKs to "user" (${matches.join(", ")})`,
            hint: `add \`selfBy: "<colName>"\` to disambiguate`,
        });
    }
    const discovered = matches[0] as string;
    const columns = getTableColumns(table) as Record<string, { readonly name: string }>;
    const jsKey = Object.entries(columns).find(([, column]) => column.name === discovered)?.[0];
    if (jsKey !== "userId") {
        throw new CdbError({
            code: "CDB_INVALID_SELF",
            message: `cdbTable("${meta.name}"): forOrgUser() requires selfBy for nonconventional user column "${jsKey ?? discovered}"`,
            hint: `add \`selfBy: "${jsKey ?? discovered}"\` so insert types include the managed owner column`,
        });
    }
    return discovered;
}

function foreignKeyColumnsTo(table: SQLiteTable, targetName: string): string[] {
    const cfg = getTableConfig(table);
    const matches: string[] = [];
    for (const fk of cfg.foreignKeys as readonly ForeignKey[]) {
        const ref = fk.reference();
        if (getTableName(ref.foreignTable) !== targetName) continue;
        for (const col of ref.columns as readonly AnyColumn[]) matches.push(col.name);
    }
    return [...new Set(matches)];
}

function resolvePartitionByMeta(
    raw: string | readonly string[] | "replicated" | undefined
): CdbTableMeta["partitionBy"] {
    if (raw === undefined) {
        // Default; the caller (resolveCdbMeta consumer / colocation builder)
        // will fold in the auto-discovered tenant column when applicable.
        return { kind: "colocate", via: [] };
    }
    if (raw === "replicated") return { kind: "replicated" };
    if (Array.isArray(raw)) return { kind: "colocate", via: Object.freeze([...raw]) };
    return { kind: "colocate", via: Object.freeze([raw as string]) };
}

function rolesContainSelf(roles: { readonly [k: string]: unknown }): boolean {
    return Object.prototype.hasOwnProperty.call(roles, "self");
}

function columnsContainSelf(cols: { readonly [k: string]: ColumnSpec<Record<string, unknown>, RoleName> }): boolean {
    for (const spec of Object.values(cols)) {
        for (const verb of COL_VERBS) {
            const list = spec[verb];
            if (list?.includes("self" as RoleName)) return true;
        }
    }
    return false;
}

/**
 * Compile a single ColumnMatrix from the role-axis (verb values inside
 * `roles:`) and the column-axis (`columns:`). Direct contradictions raise
 * `CDB_POLICY_CONFLICT` so two declarations of the same role × verb ×
 * column never silently override each other.
 *
 * The user types JS column names (matching `keyof TCols`); the matrix
 * stores SQL names so row consumers (which read raw rows keyed by SQL
 * names) compare against the right key without a per-row translation.
 */
function compileColumnMatrix<TCols extends CdbColumnsInput>(args: {
    readonly tableName: string;
    readonly jsKeys: readonly string[];
    readonly allColumns: readonly string[];
    readonly toSql: (jsName: string) => string;
    readonly rawRoles: { readonly [k: string]: RoleValue<TCols> };
    readonly rawColumns: { readonly [k: string]: ColumnSpec<TCols, RoleName> };
}): ColumnMatrix {
    // allowed.get(role).get(verb) = Set<colName> | null (null means "all columns").
    const allowed = new Map<string, Map<ColVerb, Set<string> | null>>();

    const ensure = (role: string): Map<ColVerb, Set<string> | null> => {
        let r = allowed.get(role);
        if (!r) {
            r = new Map();
            allowed.set(role, r);
        }
        return r;
    };

    // Role axis ------------------------------------------------------
    for (const [role, value] of Object.entries(args.rawRoles)) {
        const r = ensure(role);
        if (value === "*") {
            for (const v of COL_VERBS) r.set(v, null);
            continue;
        }
        if (Array.isArray(value)) {
            for (const verb of value as readonly Verb[]) {
                if (verb === "delete") continue;
                r.set(verb as ColVerb, null);
            }
            continue;
        }
        if (typeof value !== "object" || value === null) continue;
        for (const verb of COL_VERBS) {
            const vv = (value as { readonly [V in Verb]?: VerbValue<TCols> })[verb];
            if (vv === undefined) continue;
            r.set(verb, expandVerbValue(vv, args.jsKeys, args.allColumns, args.toSql, args.tableName, role, verb));
        }
    }

    // Column axis ----------------------------------------------------
    for (const [colJs, spec] of Object.entries(args.rawColumns)) {
        if (!args.jsKeys.includes(colJs)) {
            throw new CdbError({
                code: "CDB_INVALID_COLUMN",
                message: `cdbTable("${args.tableName}"): columns block references unknown column "${colJs}"`,
            });
        }
        const colSql = args.toSql(colJs);
        for (const verb of COL_VERBS) {
            const roles = spec[verb];
            if (!roles) continue;
            for (const role of roles) {
                const r = ensure(role);
                const existing = r.get(verb);
                if (existing === undefined) {
                    r.set(verb, new Set([colSql]));
                    continue;
                }
                if (existing === null) continue;
                existing.add(colSql);
            }
        }
    }

    // Detect contradictions: role-axis "exclude" intersected with column-axis "include".
    for (const [role, spec] of Object.entries(args.rawRoles)) {
        if (typeof spec !== "object" || spec === null || Array.isArray(spec)) continue;
        for (const verb of COL_VERBS) {
            const vv = (spec as { readonly [V in Verb]?: VerbValue<CdbColumnsInput> })[verb];
            if (vv && typeof vv === "object" && !Array.isArray(vv) && vv !== null && "exclude" in vv) {
                const excluded = (vv as { readonly exclude: readonly string[] }).exclude;
                for (const colJs of excluded) {
                    const colSpec = args.rawColumns[colJs];
                    if (colSpec?.[verb]?.includes(role as RoleName)) {
                        throw new CdbError({
                            code: "CDB_POLICY_CONFLICT",
                            message: `cdbTable("${args.tableName}"): role "${role}" verb "${verb}" excludes column "${colJs}" but the columns block grants it to "${role}"`,
                            hint: "remove either the role-axis exclude or the column-axis grant",
                        });
                    }
                }
            }
        }
    }

    // Freeze nested structures
    const allowedFrozen = new Map<string, ReadonlyMap<ColVerb, ReadonlySet<string> | null>>();
    for (const [role, byVerb] of allowed) {
        const v = new Map<ColVerb, ReadonlySet<string> | null>();
        for (const [verb, cols] of byVerb) {
            v.set(verb, cols === null ? null : (Object.freeze(new Set(cols)) as ReadonlySet<string>));
        }
        allowedFrozen.set(role, v as ReadonlyMap<ColVerb, ReadonlySet<string> | null>);
    }

    return {
        allowed: allowedFrozen as ReadonlyMap<string, ReadonlyMap<ColVerb, ReadonlySet<string> | null>>,
        allColumns: args.allColumns,
    };
}

function expandVerbValue<TCols extends CdbColumnsInput>(
    vv: VerbValue<TCols>,
    jsKeys: readonly string[],
    allColumnsSql: readonly string[],
    toSql: (jsName: string) => string,
    tableName: string,
    role: string,
    verb: ColVerb
): Set<string> | null {
    if (vv === "*" || vv === true) return null;
    if (vv === false) return new Set();
    if (Array.isArray(vv)) {
        const set = new Set<string>();
        for (const c of vv) {
            if (!jsKeys.includes(c as string)) {
                throw new CdbError({
                    code: "CDB_INVALID_COLUMN",
                    message: `cdbTable("${tableName}"): role "${role}" verb "${verb}" references unknown column "${String(c)}"`,
                });
            }
            set.add(toSql(c as string));
        }
        return set;
    }
    if (typeof vv === "object" && vv !== null && "exclude" in vv) {
        const excludeJs = (vv as { readonly exclude: readonly string[] }).exclude;
        const excludeSql = new Set<string>();
        for (const c of excludeJs) {
            if (!jsKeys.includes(c)) {
                throw new CdbError({
                    code: "CDB_INVALID_COLUMN",
                    message: `cdbTable("${tableName}"): role "${role}" verb "${verb}" excludes unknown column "${c}"`,
                });
            }
            excludeSql.add(toSql(c));
        }
        const set = new Set<string>();
        for (const c of allColumnsSql) if (!excludeSql.has(c)) set.add(c);
        return set;
    }
    return new Set();
}
