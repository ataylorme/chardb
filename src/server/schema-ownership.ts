import { Column, is } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import { type sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import type { CdbScopeKind, CdbTableConfig } from "./cdb-table-types.ts";
import { type CdbColumnsInput, createCdbTable } from "./cdb-table.ts";

type AuthTable = { readonly id: AnySQLiteColumn };

interface OrganizationOwnershipAuth {
    readonly organization: AuthTable;
}

interface UserOwnershipAuth {
    readonly user: AuthTable;
}

type OrganizationUserOwnershipAuth = OrganizationOwnershipAuth & UserOwnershipAuth;

function ownershipColumn(name: "organization_id" | "user_id", target: AnySQLiteColumn) {
    return text(name)
        .notNull()
        .references(() => target, { onDelete: "cascade" });
}

type OwnershipColumnBuilder = ReturnType<typeof ownershipColumn>;

type ManagedColumns<K extends CdbScopeKind> = K extends "org"
    ? { readonly organizationId: OwnershipColumnBuilder }
    : K extends "orgUser"
      ? { readonly organizationId: OwnershipColumnBuilder; readonly userId: OwnershipColumnBuilder }
      : K extends "user"
        ? { readonly userId: OwnershipColumnBuilder }
        : Record<never, never>;

type ManagedColumnName<K extends CdbScopeKind> = keyof ManagedColumns<K> & string;
type RejectManagedColumns<K extends CdbScopeKind> = { readonly [P in ManagedColumnName<K>]?: never };
type OwnedColumns<K extends CdbScopeKind, TCols extends CdbColumnsInput> = ManagedColumns<K> & TCols;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OwnedTableConfig<TCols, K extends CdbScopeKind> = DistributiveOmit<
    CdbTableConfig<TCols, K>,
    "tenantBy" | (K extends "orgUser" ? "selfBy" : never)
>;

type BuiltTable<TName extends string, TCols extends CdbColumnsInput> = SQLiteTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: ReturnType<typeof sqliteTable<TName, TCols>>["_"]["columns"];
    dialect: "sqlite";
}>;

type OwnedBuiltTable<TName extends string, TCols extends CdbColumnsInput, K extends CdbScopeKind, TConfig> = BuiltTable<
    TName,
    OwnedColumns<K, TCols>
> extends infer T
    ? T extends { readonly $inferInsert: infer I }
        ? Omit<T, "$inferInsert"> & {
              readonly $inferInsert: Omit<I, AutoFillColumnName<K, TConfig> & keyof I> &
                  Partial<Pick<I, AutoFillColumnName<K, TConfig> & keyof I>>;
          }
        : T
    : never;

type AutoFillColumnName<K extends CdbScopeKind, TConfig> =
    | ManagedColumnName<K>
    | (TConfig extends { readonly selfBy: infer TSelf extends string } ? TSelf : never);

/** A table builder with fixed, framework-managed ownership columns. */
interface OwnedCdbTable<K extends Exclude<CdbScopeKind, "none">> {
    cdbTable<
        TName extends string,
        TCols extends CdbColumnsInput,
        const TConfig extends OwnedTableConfig<OwnedColumns<K, TCols>, K>,
    >(
        name: TName,
        columns: TCols & RejectManagedColumns<K>,
        config?: TConfig
    ): OwnedBuiltTable<TName, TCols, K, TConfig>;
}

/** Bind every table in this schema module to organization ownership. */
export function forOrg(auth: OrganizationOwnershipAuth): OwnedCdbTable<"org"> {
    const organizationId = requireAuthId(auth, "organization");
    return bindOwnership("org", () => ({
        organizationId: ownershipColumn("organization_id", organizationId),
    }));
}

/** Bind every table in this schema module to the signed-in user. */
export function forUser(auth: UserOwnershipAuth): OwnedCdbTable<"user"> {
    const userId = requireAuthId(auth, "user");
    return bindOwnership("user", () => ({ userId: ownershipColumn("user_id", userId) }));
}

/** Bind every table to an organization and to one user inside it. */
export function forOrgUser(auth: OrganizationUserOwnershipAuth): OwnedCdbTable<"orgUser"> {
    const organizationId = requireAuthId(auth, "organization");
    const userId = requireAuthId(auth, "user");
    return bindOwnership("orgUser", () => ({
        organizationId: ownershipColumn("organization_id", organizationId),
        userId: ownershipColumn("user_id", userId),
    }));
}

function requireAuthId(auth: unknown, target: "organization" | "user"): AnySQLiteColumn {
    const table = auth && typeof auth === "object" ? (auth as Record<string, unknown>)[target] : undefined;
    const id = table && typeof table === "object" ? (table as Record<string, unknown>).id : undefined;
    if (!is(id, Column)) {
        throw new CdbError({
            code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
            message: `for${target === "organization" ? "Org" : "User"}(auth) requires auth.${target}.id`,
            hint:
                target === "organization"
                    ? "Add organization() to defineAuth({ plugins: [...] }) and pass that auth object to forOrg()."
                    : "Pass the object returned by defineAuth() to forUser().",
        });
    }
    return id as AnySQLiteColumn;
}

function bindOwnership<K extends "org" | "orgUser" | "user">(
    kind: K,
    makeManagedColumns: () => ManagedColumns<K>
): OwnedCdbTable<K> {
    return Object.freeze({
        cdbTable<
            TName extends string,
            TCols extends CdbColumnsInput,
            const TConfig extends OwnedTableConfig<OwnedColumns<K, TCols>, K>,
        >(
            name: TName,
            columns: TCols & RejectManagedColumns<K>,
            config?: TConfig
        ): OwnedBuiltTable<TName, TCols, K, TConfig> {
            const managedColumns = makeManagedColumns();
            const managedNames = Object.keys(managedColumns);
            for (const managedName of managedNames) {
                if (Object.prototype.hasOwnProperty.call(columns, managedName)) {
                    throw new CdbError({
                        code: "CDB_INVALID_TENANT",
                        message: `cdbTable("${name}"): ${managedName} is managed by the ownership factory`,
                        hint: `remove ${managedName} from the columns passed to cdbTable()`,
                    });
                }
            }
            const rawConfig = (config ?? {}) as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(rawConfig, "tenantBy")) {
                throw new CdbError({
                    code: "CDB_INVALID_TENANT",
                    message: `cdbTable("${name}"): tenantBy is fixed by the ownership factory`,
                });
            }
            if (kind === "orgUser" && Object.prototype.hasOwnProperty.call(rawConfig, "selfBy")) {
                throw new CdbError({
                    code: "CDB_INVALID_SELF",
                    message: `cdbTable("${name}"): selfBy is fixed to userId by forOrgUser(auth)`,
                });
            }

            const allColumns = (
                Object.prototype.hasOwnProperty.call(columns, "id")
                    ? {
                          id: columns.id,
                          ...managedColumns,
                          ...Object.fromEntries(Object.entries(columns).filter(([column]) => column !== "id")),
                      }
                    : { ...managedColumns, ...columns }
            ) as OwnedColumns<K, TCols>;
            const ownedConfig = {
                ...rawConfig,
                tenantBy: kind === "user" ? "userId" : "organizationId",
                ...(kind === "orgUser" ? { selfBy: "userId" } : {}),
            } as CdbTableConfig<OwnedColumns<K, TCols>, K>;
            return createCdbTable({
                name,
                columns: allColumns,
                config: ownedConfig,
                tenantKind: kind === "user" ? "user" : "org",
                authTarget: kind === "user" ? "user" : "organization",
                ...(kind === "orgUser" ? { selfTarget: "user" as const } : {}),
            }) as OwnedBuiltTable<TName, TCols, K, TConfig>;
        },
    });
}
