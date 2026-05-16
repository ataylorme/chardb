/**
 * `synthesizeAuthSchema(authOptions)` — materialize the canonical Drizzle
 * schema for every table in `getAuthTables(authOptions)`.
 *
 * The auth-table namespace is reserved by chardb: the four core models
 * (`user`, `session`, `account`, `verification`) plus every model
 * contributed by a registered better-auth plugin (`organization`,
 * `member`, `invitation`, `team`, `teamMember`, `passkey`, `apiKey`,
 * `jwks`, `rateLimit`, …) belong to this namespace. User-defined Drizzle
 * tables MUST NOT shadow these names; `assertNoReservedTableShadow`
 * raises `CDB_RESERVED_TABLE_NAME` when they do.
 *
 * The synthesized tables are real Drizzle `SQLiteTable`s — domain tables
 * `.references(() => authSchema.organization.id)` exactly the way they
 * would against a hand-written `auth-schema.ts`, except the source-of-
 * truth is the better-auth options object the user already wrote.
 * `defineChardb({ auth, schema })` runs the synthesizer at construction
 * time so the colocation walker sees the merged schema (auth +
 * domain). FK chains from domain tables into `organization` /  `user`
 * are exactly what the default colocation policy walks
 * (`distributionRoots: ["organization", "user"]`).
 *
 * The mapping from `DBFieldAttribute.type` to a SQLite column:
 *   string  → text
 *   number  → integer
 *   boolean → integer({mode:"boolean"})
 *   date    → integer({mode:"timestamp_ms"})
 *   json    → text({mode:"json"})
 * Arrays and unknown types degrade to JSON-text so the synthesizer never
 * fails on a forward-compat schema; consumers needing a stricter mapping
 * can post-process the returned record before passing to `defineChardb`.
 */

import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { getAuthTables } from "better-auth/db";
import type {
    BaseAccount,
    BaseRateLimit,
    BaseSession,
    BaseUser,
    BaseVerification,
    BetterAuthDBSchema,
    DBFieldAttribute,
} from "better-auth/db";
import type {
    Invitation,
    Member,
    Organization,
    OrganizationRole,
    Team,
    TeamMember,
} from "better-auth/plugins/organization";
import { getTableColumns } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn, AnySQLiteTable, SQLiteColumnBuilderBase } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";

/** Core better-auth tables — always present regardless of plugins. */
export const AUTH_DEFAULT_TABLES = ["user", "session", "account", "verification"] as const;
export type AuthDefaultTable = (typeof AUTH_DEFAULT_TABLES)[number];

/**
 * Closed list of model names that any better-auth plugin in the ecosystem
 * may contribute. Used as the static guard list in `chardb doctor schema`;
 * the per-app reserved set at runtime is the dynamic union of these and
 * `Object.keys(getAuthTables(authOptions))`.
 */
export const AUTH_PLUGIN_TABLES: readonly string[] = Object.freeze([
    "rateLimit",
    "organization",
    "member",
    "invitation",
    "team",
    "teamMember",
    "organizationRole",
    "apiKey",
    "jwks",
    "passkey",
    "twoFactor",
    "ssoProvider",
    "oauthApplication",
    "oauthAccessToken",
    "oauthConsent",
    "deviceCode",
]);

export const AUTH_RESERVED_NAMES: ReadonlySet<string> = new Set([...AUTH_DEFAULT_TABLES, ...AUTH_PLUGIN_TABLES]);

/**
 * Drizzle column-typed view of a synthesized auth table. Used when the
 * static column set of the table is known (every default model + every
 * shipping plugin model below); additional fields contributed via
 * `options.user?.additionalFields` etc. are accessible through
 * `getTableColumns(table)` at runtime but don't surface at the type
 * level — typing them statically would require parsing the user's
 * `additionalFields` declarations through the bundler.
 */
type WithColumns<TKey extends string> = AnySQLiteTable & {
    readonly [K in TKey | "id"]: AnySQLiteColumn;
};

/**
 * Field-name union for a better-auth model, derived from the model's
 * own row type (`BaseUser`, `Organization`, ...). Better-auth declares
 * each model as a Zod object whose inferred `z.infer<...>` type is
 * exported alongside it; reading `keyof` off that type keeps the
 * column union locked to upstream's source of truth so when better-
 * auth adds a field (e.g. `user.phoneNumber`) it surfaces here on the
 * next dependency bump without a hand edit.
 */
type FieldsOf<T> = keyof T & string;

/**
 * Static column maps for every chardb-bundled better-auth table. The
 * field unions are inferred from upstream's exported row types
 * (`BaseUser` / `BaseSession` / ... from `@better-auth/core/db`,
 * `Organization` / `Member` / ... from
 * `better-auth/plugins/organization/schema`). Plugin tables outside
 * this set (passkey, twoFactor, apiKey, jwks, ssoProvider, ...)
 * surface through `FieldsOfPluginTable<TPlugins, T>` instead — only
 * users who add the plugin to their `defineAuth` see those tables, and
 * the field union is read straight off the plugin's `schema.fields`
 * declaration.
 */
export interface KnownAuthTables {
    readonly user: WithColumns<FieldsOf<BaseUser>>;
    readonly session: WithColumns<FieldsOf<BaseSession>>;
    readonly account: WithColumns<FieldsOf<BaseAccount>>;
    readonly verification: WithColumns<FieldsOf<BaseVerification>>;
    readonly organization: WithColumns<FieldsOf<Organization>>;
    readonly member: WithColumns<FieldsOf<Member>>;
    readonly invitation: WithColumns<FieldsOf<Invitation>>;
    readonly team: WithColumns<FieldsOf<Team>>;
    readonly teamMember: WithColumns<FieldsOf<TeamMember>>;
    readonly organizationRole: WithColumns<FieldsOf<OrganizationRole>>;
    readonly rateLimit: WithColumns<FieldsOf<BaseRateLimit>>;
}

/**
 * Type-level extraction of the field-name union for a single plugin
 * table. Returns the literal keys of `<plugin>.schema[<table>].fields`
 * when the plugin's `schema` is typed concretely (via the
 * `satisfies BetterAuthPlugin` pattern or via better-auth's own typed
 * schemas like `OrganizationSchema<O>`); falls back to `never` for
 * plugins whose `schema` is typed only as the abstract
 * `BetterAuthPluginDBSchema`.
 */
type FieldsOfPluginTable<TPlugins, T extends string> = TPlugins extends readonly (infer P)[]
    ? P extends { schema: infer S }
        ? T extends keyof S
            ? S[T] extends { fields: infer F }
                ? F extends object
                    ? string extends keyof F
                        ? never
                        : keyof F & string
                    : never
                : never
            : never
        : never
    : never;

/**
 * Synthesized-table type for `T`. For the four core models we use the
 * static `KnownAuthTables` map (their columns aren't contributed by a
 * plugin and so can't be inferred from `options.plugins`). For
 * everything else we read field names directly out of the plugin's
 * declared `schema` — that's how `auth.botToken.token`, `auth.member.role`,
 * etc. all become statically typed.
 */
export type SynthesizedAuthTable<
    T extends string = string,
    TPlugins extends readonly unknown[] = readonly unknown[],
> = T extends keyof KnownAuthTables
    ? KnownAuthTables[T]
    : AnySQLiteTable & {
          readonly [K in FieldsOfPluginTable<TPlugins, T> | "id"]: AnySQLiteColumn;
      };

export type SynthesizedAuthSchema<TPlugins extends readonly unknown[] = [], TExtra extends string = never> = {
    readonly [K in AuthDefaultTable | InferPluginTables<TPlugins> | TExtra]: SynthesizedAuthTable<K, TPlugins>;
};

/**
 * Type-level extraction of the table-name union a single better-auth
 * plugin contributes. We read the `schema` property's keys when they're
 * concrete literals (e.g. `OrganizationSchema<O>` from
 * `better-auth/plugins/organization`) and fall back to `never` when the
 * schema is typed only as the abstract `BetterAuthPluginDBSchema`
 * (string index signature), so user-authored plugins without a concrete
 * `schema` type don't pollute the inferred union with `string`.
 */
type PluginTables<P> = P extends { schema: infer S }
    ? S extends object
        ? string extends keyof S
            ? never
            : keyof S & string
        : never
    : never;

/**
 * Type-level union of every table contributed by the user's `plugins:
 * [...]` tuple. Inferred automatically by `defineAuth` /
 * `synthesizeAuthSchema` — the user never types plugin names twice.
 */
export type InferPluginTables<TPlugins extends readonly unknown[] | undefined> = TPlugins extends
    | readonly (infer P)[]
    | undefined
    ? PluginTables<P>
    : never;

/**
 * Constrain the input so `TPlugins` infers as a tuple (not the
 * widened `BetterAuthPlugin[]`). `BetterAuthOptions["plugins"]` is
 * typed as `BetterAuthPlugin[]` which would erase the per-element
 * type; we override it to capture the literal tuple via `const
 * TPlugins`.
 */
export type AuthOptionsInput<TPlugins extends readonly BetterAuthPlugin[]> = Omit<BetterAuthOptions, "plugins"> & {
    readonly plugins?: TPlugins;
};

/**
 * Synthesize a Drizzle SQLite schema for every model
 * `getAuthTables(options)` would emit. The plugin tables `options.plugins`
 * contributes are inferred from the tuple — `synthesizeAuthSchema({
 * plugins: [organization()] })` returns a schema typed as `{ user,
 * session, account, verification, organization, member, invitation }`
 * without the caller having to repeat any names.
 *
 * The result is keyed by *model name*, not the SQL table name —
 * `authSchema.organization` works even if the user remapped
 * `options.organization?.modelName = "orgs"`. The synthesized table's
 * `.name` matches the SQL name.
 *
 * `extraTables` is a manual escape hatch for cases where chardb cannot
 * infer a custom plugin's tables — pass `["myCustomTable"]` and the
 * return type widens accordingly. Most users never need it.
 */
export function synthesizeAuthSchema<
    const TPlugins extends readonly BetterAuthPlugin[] = [],
    const TExtra extends readonly string[] = [],
>(options: AuthOptionsInput<TPlugins>, extraTables?: TExtra): SynthesizedAuthSchema<TPlugins, TExtra[number]> {
    const spec = getAuthTables(options as unknown as BetterAuthOptions);
    const tables: Record<string, AnySQLiteTable> = {};

    const ordered = Object.entries(spec).sort(([ka, a], [kb, b]) => orderOf(a) - orderOf(b) || ka.localeCompare(kb));
    for (const [model, entry] of ordered) {
        tables[model] = buildTable(entry, () => tables);
    }

    for (const k of AUTH_DEFAULT_TABLES) {
        if (!tables[k]) {
            throw new CdbError({
                code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
                message: `synthesizeAuthSchema: better-auth options omit the required "${k}" table`,
            });
        }
    }
    if (extraTables) {
        for (const k of extraTables) {
            if (!tables[k]) {
                throw new CdbError({
                    code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
                    message: `synthesizeAuthSchema: extraTables requested "${k}" but no plugin contributed it`,
                });
            }
        }
    }

    // The cast widens each `AnySQLiteTable` to its per-key typed shape
    // via the `KnownAuthTables` map; at runtime every column the static
    // type promises is actually a property on the table object (Drizzle
    // places columns directly on the table), so the structural promise
    // is sound even though Drizzle's loose `AnySQLiteTable` type doesn't
    // surface them.
    return tables as unknown as SynthesizedAuthSchema<TPlugins, TExtra[number]>;
}

/**
 * `defineAuth(options)` — one-shot helper that bundles the better-auth
 * options object with the synthesized Drizzle schema so the user writes
 * their auth config exactly once.
 *
 * ```ts
 * // src/server/auth.ts
 * import { organization } from "better-auth/plugins/organization";
 * import { defineAuth } from "chardb/auth";
 *
 * export const auth = defineAuth({ plugins: [organization()] });
 * //     ^ typed as ChardbAuth<"organization" | "member" | "invitation">
 *
 * // src/server/schema.ts
 * import { auth } from "./auth.ts";
 *
 * export const channels = sqliteTable("channels", {
 *   organizationId: text("organization_id")
 *     .references(() => auth.organization.id, { onDelete: "cascade" }),
 * });
 *
 * // src/server/worker.ts
 * defineChardb({ schema: domain, auth, manifest });
 * ```
 *
 * Plugin tables are inferred from the `plugins` tuple — the user never
 * lists them by hand. `defineChardb` reads `auth.options` and merges the
 * synthesized tables into the runtime schema automatically.
 */
export type ChardbAuth<TPlugins extends readonly unknown[] = [], TExtra extends string = never> = {
    readonly options: BetterAuthOptions;
} & SynthesizedAuthSchema<TPlugins, TExtra>;

/**
 * The two better-auth plugins chardb bakes into every `defineAuth`
 * call by default.
 *
 *   - `organization()` — every chardb app is multi-tenant by default;
 *     the `member.role` lattice is the org-scoped RBAC axis cdbTable's
 *     unprefixed role names match against (`admin`, `member`, custom
 *     names).
 *   - `admin()` — system-wide user roles. cdbTable's `user:`-prefixed
 *     role names match against `user.role` from this plugin.
 *
 * Users may still pass either explicitly to `defineAuth` to override
 * options (e.g. `organization({ teams: true })`); chardb's defaults
 * only apply when the user did not supply an instance of the same
 * plugin id.
 */
const ORGANIZATION_PLUGIN_ID = "organization";
const ADMIN_PLUGIN_ID = "admin";

function pluginById(plugins: readonly BetterAuthPlugin[] | undefined, id: string): BetterAuthPlugin | undefined {
    if (!plugins) return undefined;
    for (const p of plugins) {
        if ((p as { id?: string }).id === id) return p;
    }
    return undefined;
}

/** Tables the bundled `organization()` plugin contributes. Used to widen the synthesized schema's static type. */
const ORG_PLUGIN_TABLES = [
    "organization",
    "member",
    "invitation",
    "team",
    "teamMember",
    "organizationRole",
] as const;

/**
 * Default chardb auth profile: `organization()` and `admin()` are
 * always present unless the user passed their own configured instance
 * of the same plugin (in which case theirs wins). The user's
 * additional plugins (`anonymous()`, `jwt()`, `passkey()`, ...) are
 * appended verbatim.
 */
export function withChardbDefaults<TPlugins extends readonly BetterAuthPlugin[]>(
    options: AuthOptionsInput<TPlugins>
): AuthOptionsInput<readonly BetterAuthPlugin[]> {
    const userPlugins = (options.plugins ?? []) as readonly BetterAuthPlugin[];
    const merged: BetterAuthPlugin[] = [];
    if (!pluginById(userPlugins, ORGANIZATION_PLUGIN_ID)) merged.push(organization());
    if (!pluginById(userPlugins, ADMIN_PLUGIN_ID)) merged.push(admin());
    for (const p of userPlugins) merged.push(p);
    return { ...options, plugins: merged };
}

export function defineAuth<
    const TPlugins extends readonly BetterAuthPlugin[] = [],
    const TExtra extends readonly string[] = [],
>(options: AuthOptionsInput<TPlugins>, extraTables?: TExtra): ChardbAuth<TPlugins, TExtra[number] | (typeof ORG_PLUGIN_TABLES)[number]> {
    const expandedOptions = withChardbDefaults(options);
    const tables = synthesizeAuthSchema(expandedOptions, extraTables);
    // Re-key the result back to TPlugins-shaped (the bundled defaults
    // contribute the org tables, which are also enumerated in
    // `KnownAuthTables` and so already typed at the consumer surface).
    return { options: expandedOptions as unknown as BetterAuthOptions, ...tables } as unknown as ChardbAuth<
        TPlugins,
        TExtra[number] | (typeof ORG_PLUGIN_TABLES)[number]
    >;
}

/**
 * Raise when any name in `userTableNames` collides with a reserved auth
 * model name. Called by `defineChardb` before merging user schema with
 * the synthesized auth schema so the source of any shadow is obvious.
 */
export function assertNoReservedTableShadow(userTableNames: Iterable<string>): void {
    const conflicts: string[] = [];
    for (const name of userTableNames) {
        if (AUTH_RESERVED_NAMES.has(name)) conflicts.push(name);
    }
    if (conflicts.length === 0) return;
    throw new CdbError({
        code: "CDB_RESERVED_TABLE_NAME",
        message: `domain schema shadows reserved better-auth table name(s): ${conflicts
            .map(n => JSON.stringify(n))
            .join(", ")}`,
        hint: "rename the conflicting table(s) or remove the better-auth plugin that reserves the name",
    });
}

function orderOf(entry: BetterAuthDBSchema[string]): number {
    return typeof entry.order === "number" ? entry.order : 100;
}

type TableLookup = () => Record<string, AnySQLiteTable>;

function buildTable(entry: BetterAuthDBSchema[string], lookup: TableLookup): AnySQLiteTable {
    const columns: Record<string, SQLiteColumnBuilderBase> = {
        id: text("id").primaryKey(),
    };
    for (const [key, attr] of Object.entries(entry.fields)) {
        columns[key] = buildColumn(attr.fieldName ?? key, attr, lookup);
    }
    return sqliteTable(entry.modelName, columns);
}

/**
 * Build a Drizzle column for `attr`. Drizzle's chained methods (`notNull`,
 * `unique`, `references`) return branded subtypes of `this`; we cast back
 * to the concrete builder type after each step so the chain stays typed
 * but the variable type doesn't drift across branches.
 */
function buildColumn(name: string, attr: DBFieldAttribute, lookup: TableLookup): SQLiteColumnBuilderBase {
    switch (attr.type) {
        case "string": {
            let c = text(name);
            if (attr.required !== false) c = c.notNull() as typeof c;
            if (attr.unique) c = c.unique() as typeof c;
            if (attr.references) {
                const ref = attr.references;
                c = c.references(() => resolveReference(lookup(), ref.model, ref.field), {
                    ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
                }) as typeof c;
            }
            return c;
        }
        case "boolean": {
            let c = integer(name, { mode: "boolean" });
            if (attr.required !== false) c = c.notNull() as typeof c;
            if (attr.unique) c = c.unique() as typeof c;
            if (attr.references) {
                const ref = attr.references;
                c = c.references(() => resolveReference(lookup(), ref.model, ref.field), {
                    ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
                }) as typeof c;
            }
            return c;
        }
        case "date": {
            let c = integer(name, { mode: "timestamp_ms" });
            if (attr.required !== false) c = c.notNull() as typeof c;
            if (attr.unique) c = c.unique() as typeof c;
            if (attr.references) {
                const ref = attr.references;
                c = c.references(() => resolveReference(lookup(), ref.model, ref.field), {
                    ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
                }) as typeof c;
            }
            return c;
        }
        case "number": {
            let c = integer(name);
            if (attr.required !== false) c = c.notNull() as typeof c;
            if (attr.unique) c = c.unique() as typeof c;
            if (attr.references) {
                const ref = attr.references;
                c = c.references(() => resolveReference(lookup(), ref.model, ref.field), {
                    ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
                }) as typeof c;
            }
            return c;
        }
        default: {
            // string[] / number[] / Literal[] / json all degrade to a JSON-encoded
            // text column. The runtime adapter serializes via the better-auth
            // field-converter; chardb just provides storage affinity.
            let c = text(name, { mode: "json" });
            if (attr.required !== false) c = c.notNull() as typeof c;
            if (attr.unique) c = c.unique() as typeof c;
            if (attr.references) {
                const ref = attr.references;
                c = c.references(() => resolveReference(lookup(), ref.model, ref.field), {
                    ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
                }) as typeof c;
            }
            return c;
        }
    }
}

function resolveReference(tables: Record<string, AnySQLiteTable>, model: string, field: string): AnySQLiteColumn {
    const target = tables[model];
    if (!target) {
        throw new CdbError({
            code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
            message: `synthesizeAuthSchema: reference to unknown table "${model}"`,
        });
    }
    const cols = getTableColumns(target) as Record<string, Column>;
    const col = cols[field];
    if (!col) {
        throw new CdbError({
            code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
            message: `synthesizeAuthSchema: reference to unknown column "${model}.${field}"`,
        });
    }
    return col as AnySQLiteColumn;
}
