import type { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import type { sqliteTable } from "drizzle-orm/sqlite-core";
import type { AuthTargetKind, CdbScopeKind, CdbTableConfig, TenantKind } from "../../src/server/cdb-table-types.ts";
import { type CdbColumnsInput, createCdbTable } from "../../src/server/cdb-table.ts";

type BuiltTable<TName extends string, TCols extends CdbColumnsInput> = SQLiteTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: ReturnType<typeof sqliteTable<TName, TCols>>["_"]["columns"];
    dialect: "sqlite";
}>;

type AutoFillKeys<K extends CdbScopeKind, TCols, TConfig> =
    | (TConfig extends { readonly selfBy: infer S extends string } ? S & keyof TCols & string : never)
    | (TConfig extends { readonly tenantBy: infer T extends string }
          ? T & keyof TCols & string
          : K extends "org" | "orgUser"
            ? "organizationId" extends keyof TCols
                ? "organizationId"
                : never
            : K extends "user"
              ? "userId" extends keyof TCols
                  ? "userId"
                  : never
              : never)
    | (K extends "orgUser"
          ? TConfig extends { readonly selfBy: string }
              ? never
              : "userId" extends keyof TCols
                ? "userId"
                : never
          : never);

type TestBuiltTable<TName extends string, TCols extends CdbColumnsInput, TAutoFill extends string> = BuiltTable<
    TName,
    TCols
> extends infer T
    ? T extends { readonly $inferInsert: infer I }
        ? Omit<T, "$inferInsert"> & {
              readonly $inferInsert: Omit<I, TAutoFill & keyof I> & Partial<Pick<I, TAutoFill & keyof I>>;
          }
        : T
    : never;

interface TestTableFactory<K extends CdbScopeKind> {
    cdbTable<TName extends string, TCols extends CdbColumnsInput, const TConfig extends CdbTableConfig<TCols, K>>(
        name: TName,
        columns: TCols,
        config?: TConfig
    ): TestBuiltTable<TName, TCols, AutoFillKeys<K, TCols, TConfig>>;
}

/**
 * Low-level table factories for tests that exercise metadata discovery and
 * engine behavior with explicit ownership columns. Application fixtures use
 * the public ownership factories from `src/server/schema-ownership.ts`.
 */
export function forOrg(): TestTableFactory<"org"> {
    return bindTestTables("organization", "org");
}

export function forOrgUser(): TestTableFactory<"orgUser"> {
    return bindTestTables("organization", "org", "user");
}

export function forUser(): TestTableFactory<"user"> {
    return bindTestTables("user", "user");
}

export function globalScope(): TestTableFactory<"none"> {
    return bindTestTables(null, "none");
}

function bindTestTables<K extends CdbScopeKind>(
    authTarget: AuthTargetKind,
    tenantKind: TenantKind,
    selfTarget?: "user"
): TestTableFactory<K> {
    return {
        cdbTable<TName extends string, TCols extends CdbColumnsInput, const TConfig extends CdbTableConfig<TCols, K>>(
            name: TName,
            columns: TCols,
            config?: TConfig
        ): TestBuiltTable<TName, TCols, AutoFillKeys<K, TCols, TConfig>> {
            return createCdbTable({
                name,
                columns,
                config: config ?? ({} as CdbTableConfig<TCols, K>),
                tenantKind,
                authTarget,
                ...(selfTarget ? { selfTarget } : {}),
            }) as TestBuiltTable<TName, TCols, AutoFillKeys<K, TCols, TConfig>>;
        },
    };
}
