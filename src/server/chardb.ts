/**
 * `chardb({ … })` — the single Worker-entry factory.
 *
 * Returns the wrangler-ready module: a Hono app you can mount your own
 * routes on, with `.fetch`, the native `DB` entrypoint, the four chardb Durable Object
 * classes, the synthesized better-auth schema, and the chardb-managed
 * `auth` value all hanging off the same object. One call replaces
 * `defineAuth` + `defineChardb` + `new Hono()` + `mountChardb` + the DO
 * re-exports. Runtime internals remain behind the factory.
 *
 * The shape:
 *
 *   const app = chardb({
 *     appName: "chat",
 *     plugins: [organization()],
 *     schema: domain,
 *     refs: api,
 *   });
 *   app.get("/health", (c) => c.text("ok"));
 *   app.get("/me", async (c) => c.json(
 *     await c.var.auth.api.getSession({ headers: c.req.raw.headers })
 *   ));
 *   export default app;
 *   export const { DB, Cdb, Catalog, Gateway, Resharder } = app;
 *
 * Schema authors reach the synthesized auth tables via the live ESM
 * binding (`import { app } from "./worker.ts"`) — Drizzle's
 * `.references(() => app.auth.organization.id)` thunk defers past the
 * cycle so the import order is safe.
 *
 * API authors keep using `createApi<typeof app.schema>()` — the schema
 * type is published on the factory output, so the user types exactly
 * one schema reference per file (no separate `typeof auth & typeof
 * domain` intersection).
 */

import { type Auth, type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { Hono } from "hono";
import { type ChardbAuthAdapterEnv, chardbAuthAdapter } from "../auth/chardb_adapter.ts";
import { type AuthOptionsInput, type ChardbAuth, type SynthesizedAuthSchema, defineAuth } from "../auth/synthesize.ts";
import type { ChardbBinding } from "../binding.ts";
import { CdbError } from "../errors.ts";
import { type DB, configureDbBindingRuntime } from "./binding.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import { type Catalog, configureCatalogRuntime } from "./do/catalog.ts";
import { type Cdb, configureCdbRuntime } from "./do/cdb.ts";
import type { GatewayJwtConfig } from "./do/gateway-auth-dispatch.ts";
import { type Gateway, configureGatewayRuntime } from "./do/gateway.ts";
import { type Resharder, configureResharderRuntime } from "./do/resharder.ts";
import {
    type ChardbEnv,
    type DefineChardbInput,
    type MountChardbOptions,
    defineChardb,
    mountChardb,
} from "./entrypoint.ts";
import { cdbHttpErrorResponse, chardbHttpErrorHandler } from "./http-errors.ts";
import { sourceChardbEnv } from "./loopback.ts";
import { type OrganizationFileHttpAuth, handleOrganizationFileRequest } from "./organization-file-http.ts";
import { assertSchemaResourceJournal, collectSchemaFileResourceDescriptors } from "./resource-descriptors.ts";
import { type ChardbMigrationJournal, defineMigrations } from "./schema-migrations.ts";

/**
 * Input shape. Two equivalent ways to provide the auth profile:
 *
 *   - `auth: defineAuth({ … })` — pre-built `ChardbAuth` value (the
 *     recommended path; the user's `schema.ts` can `import { auth }
 *     from "./worker.ts"` to FK-reference `auth.organization.id` etc.
 *     without dragging the chardb factory's schema-dependent type
 *     into the cycle).
 *   - `auth: { plugins, appName, … }` — inline better-auth options
 *     when the user doesn't need `auth` as a separate named export
 *     (chardb runs `defineAuth(...)` internally and exposes the
 *     synthesized bundle as `app.auth`).
 *
 * `api?` lets the user pass the handler-module namespace (`import * as
 * api from "./api.ts"`) so chardb can walk it for `__chardbRef`
 * markers and build the manifest lazily — equivalent to the old
 * `refs:` field, just named for what it actually contains. `refs:`
 * remains accepted as a deprecated alias.
 *
 * `routes?: (app) => void` lets the user wire Hono routes inline; if
 * omitted, they can chain `app.get/post/…` on the returned object.
 * Every route receives the same per-env Better Auth instance that owns
 * `/api/auth/*` as `c.var.auth`.
 */
export interface ChardbFactoryInput<
    TPlugins extends readonly BetterAuthPlugin[],
    TSchema extends Record<string, unknown>,
> extends Omit<DefineChardbInput<TSchema>, "auth" | "refs" | "policy" | "manifest"> {
    /**
     * Either a pre-built bundle from `defineAuth({ plugins })` or
     * inline better-auth options (`{ plugins, appName, … }`). Omit to
     * get the core four better-auth tables with no plugins.
     */
    readonly auth?: ChardbAuth<TPlugins> | AuthOptionsInput<TPlugins>;
    /** Handler-module namespace (`import * as api from "./api.ts"`). */
    readonly api?: DefineChardbInput<TSchema>["refs"];
    /** Deprecated alias for `api` — supported for one minor cycle. */
    readonly refs?: DefineChardbInput<TSchema>["refs"];
    /** Inline-route hook so the whole config can read top-to-bottom. */
    readonly routes?: (app: Hono<ChardbHonoEnv<TPlugins>>) => void;
    readonly authBasePath?: MountChardbOptions["authBasePath"];
    /** Immutable migration journal packaged with every Worker and Durable Object class. */
    readonly migrations?: ChardbMigrationJournal;
}

/**
 * The factory return — a single object that satisfies wrangler's
 * worker module contract, the Hono routing surface, AND chardb's
 * typed-handle requirements.
 *
 * Notable fields:
 *   - `fetch` (replaces Hono's) is the chardb-mounted handler.
 *   - `auth` is the `ChardbAuth` value (synthesized tables + options).
 *   - `schema` is the merged auth + domain schema typed for downstream
 *     `createApi<typeof app.schema>()` calls.
 *   - DO classes are direct fields so `export const { Cdb, … } = app`
 *     drops the DO re-export ceremony to a single destructure line.
 */
export type ChardbAppEnv = ChardbEnv & { readonly DB: ChardbBinding };

type MutablePluginTuple<TPlugins extends readonly BetterAuthPlugin[]> = [...TPlugins];

/** The Better Auth server instance available to Hono routes as `c.var.auth`. */
export type ChardbAuthRuntime<TPlugins extends readonly BetterAuthPlugin[]> = Auth<
    Omit<BetterAuthOptions, "plugins"> & { plugins: MutablePluginTuple<TPlugins> }
>;

type ChardbHonoEnv<TPlugins extends readonly BetterAuthPlugin[]> = {
    Bindings: ChardbAppEnv;
    Variables: { auth: ChardbAuthRuntime<TPlugins> };
};

export type ChardbApp<TPlugins extends readonly BetterAuthPlugin[], TSchema extends Record<string, unknown>> = Hono<
    ChardbHonoEnv<TPlugins>
> & {
    readonly fetch: (request: Request, env: ChardbEnv, ctx: ExecutionContext) => Promise<Response>;
    readonly auth: ChardbAuth<TPlugins>;
    readonly schema: TSchema & SynthesizedAuthSchema<TPlugins>;
    readonly DB: typeof DB;
    readonly Cdb: typeof Cdb;
    readonly Catalog: typeof Catalog;
    readonly Gateway: typeof Gateway;
    readonly Resharder: typeof Resharder;
};

/**
 * Type guard: `ChardbAuth` carries an `.options` field (the original
 * better-auth options) and a `user` synthesized table. A raw options
 * object passed inline has neither, so the presence of `.options` is
 * the discriminator.
 */
function isChardbAuth<TPlugins extends readonly BetterAuthPlugin[]>(
    value: ChardbAuth<TPlugins> | AuthOptionsInput<TPlugins>
): value is ChardbAuth<TPlugins> {
    return (
        typeof value === "object" &&
        value !== null &&
        "options" in value &&
        "user" in value &&
        typeof (value as { user: unknown }).user === "object"
    );
}

export function chardb<
    const TPlugins extends readonly BetterAuthPlugin[] = [],
    const TSchema extends Record<string, unknown> = Record<string, unknown>,
>(input: ChardbFactoryInput<TPlugins, TSchema>): ChardbApp<TPlugins, TSchema> {
    // Resolve the auth profile. The `auth` slot accepts either a
    // pre-built `ChardbAuth` (from `defineAuth(...)`) or raw better-auth
    // options (`{ plugins, appName, … }`). We discriminate by the
    // presence of `.options` — `ChardbAuth` carries the original options
    // under `auth.options`, while a freshly-passed options object IS
    // those options. Omit entirely → no plugins, core four tables only.
    const auth: ChardbAuth<TPlugins> = (() => {
        if (input.auth && isChardbAuth(input.auth)) return input.auth;
        return defineAuth((input.auth ?? {}) as unknown as AuthOptionsInput<TPlugins>);
    })();

    // `api` is the new field name; `refs` is the deprecated alias.
    const refsValue = input.api ?? input.refs;
    const authBasePath = input.authBasePath ?? auth.options.basePath ?? "/api/auth";
    const jwtConfig = gatewayJwtConfigFromAuthOptions(auth.options, authBasePath);
    if (refsValue !== undefined && jwtConfig === null) {
        throw new CdbError({
            code: "CDB_AUTH_NOT_BOUND",
            message: "chardb: authenticated DB transport requires Better Auth's jwt() plugin",
            hint: "Add jwt() to defineAuth({ plugins: [...] }) before passing api/refs to chardb().",
        });
    }

    const Chardb = defineChardb({
        schema: input.schema,
        auth,
        ...(refsValue ? { refs: refsValue } : {}),
    });
    const runtimeEntrypoint = Chardb as typeof Chardb & {
        readonly schema: Record<string, unknown>;
        readonly chardbManifest: import("./manifest.ts").ChardbManifest;
    };
    const migrationJournal = input.migrations ?? defineMigrations([]);
    let validatedSchema: Record<string, unknown> | undefined;
    const getValidatedSchema = (): Record<string, unknown> => {
        if (validatedSchema) return validatedSchema;
        const schema = runtimeEntrypoint.schema;
        assertConfiguredAuthTargets(schema, auth.options);
        assertSchemaResourceJournal(schema, migrationJournal.migrations);
        validatedSchema = schema;
        return schema;
    };
    const ConfiguredCdb = configureCdbRuntime({
        schema: getValidatedSchema,
        manifest: () => runtimeEntrypoint.chardbManifest,
        migrations: () => migrationJournal,
    });
    const ConfiguredCatalog = configureCatalogRuntime({ migrations: () => migrationJournal });
    const ConfiguredGateway = configureGatewayRuntime({
        schema: getValidatedSchema,
        manifest: () => runtimeEntrypoint.chardbManifest,
        auth: jwtConfig,
    });
    const ConfiguredResharder = configureResharderRuntime({ schema: getValidatedSchema });
    const ConfiguredDB = configureDbBindingRuntime({
        schema: getValidatedSchema,
        manifest: () => runtimeEntrypoint.chardbManifest,
        auth: jwtConfig,
    });

    const authRuntime = buildDefaultAuthRuntime<TPlugins>(auth.options as BetterAuthOptions);
    const hono = new Hono<ChardbHonoEnv<TPlugins>>();
    hono.onError(chardbHttpErrorHandler);
    hono.use("*", async (c, next) => {
        c.set("auth", authRuntime.get(c.env, c.req.raw));
        await next();
    });
    if (input.routes) input.routes(hono);

    // Snapshot Hono's own `.fetch` BEFORE handing the instance to
    // `mountChardb`. If we let `mountChardb` close over `hono.fetch` and
    // then overwrite `hono.fetch` with the wrapped handler below, the
    // wrapped handler would recurse into itself on the
    // non-reserved-prefix fall-through.
    const honoFetch = hono.fetch.bind(hono);

    // Auto-mount Better Auth at /api/auth/*. The adapter has to be
    // constructed per inbound env (the DO bindings live there), so we memoize a Better Auth
    // instance per env-identity to avoid re-running the adapter factory
    // on every request.
    //
    // The caller's plugin tuple and plugin options pass through unchanged.
    // Better Auth owns organization and user-management permissions;
    // Chardb enforces domain table policy independently.
    const mounted = mountChardb(
        Chardb,
        { fetch: honoFetch as Parameters<typeof mountChardb>[1]["fetch"] },
        {
            authHandler: async (request, env, ctx) => {
                const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as {
                    schemaState(): Promise<{ readonly activeVersion: number; readonly status: "active" | "migrating" }>;
                };
                const state = await catalog.schemaState();
                if (state.status !== "active" || state.activeVersion !== migrationJournal.version) {
                    return cdbHttpErrorResponse(
                        new CdbError({
                            code: "CDB_STALE_EPOCH",
                            message: "Catalog auth schema migration is not active",
                            hint: "retry after the schema migration activates",
                        })
                    );
                }
                return authRuntime.handler(request, env, ctx);
            },
            authBasePath,
            fileHandler: (request, env) =>
                handleOrganizationFileRequest({
                    request,
                    env,
                    auth: authRuntime.get(env, request) as unknown as OrganizationFileHttpAuth,
                    resources: collectSchemaFileResourceDescriptors(getValidatedSchema()),
                }),
        }
    );

    // Hono is an open object — augment it with the chardb-specific fields
    // and override `.fetch` with the prefix-aware mounted handler. The
    // user can still call `.get/.post/.put/.all/.route(...)` after the
    // factory returns; Hono's chaining methods mutate the same instance.
    // `.schema` is exposed as a getter so the merge with the user's
    // domain namespace happens lazily — `chardb({...})` can be called
    // mid-ESM-cycle (worker.ts ↔ schema.ts) before schema.ts's body has
    // finished evaluating, and the merge defers until first access.
    Object.defineProperty(hono, "schema", {
        enumerable: true,
        configurable: false,
        get: () => getValidatedSchema() as TSchema & SynthesizedAuthSchema<TPlugins>,
    });
    const merged = Object.assign(hono, {
        fetch: mounted.fetch,
        auth,
        DB: ConfiguredDB,
        Cdb: ConfiguredCdb,
        Catalog: ConfiguredCatalog,
        Gateway: ConfiguredGateway,
        Resharder: ConfiguredResharder,
    });
    return merged as ChardbApp<TPlugins, TSchema>;
}

function assertConfiguredAuthTargets(schema: Record<string, unknown>, authOptions: BetterAuthOptions): void {
    const hasOrganizationPlugin = (authOptions.plugins ?? []).some(plugin => plugin.id === "organization");
    if (hasOrganizationPlugin) return;
    const orgTable = collectCdbTables(schema).find(({ meta }) => meta.authTarget === "organization");
    if (!orgTable) return;
    throw new CdbError({
        code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
        message: `chardb: cdbTable "${orgTable.meta.name}" uses forOrg(), but defineAuth() did not configure Better Auth's organization() plugin`,
        hint: "Add organization() to defineAuth({ plugins: [...] }).",
    });
}

interface BetterAuthJwtPluginOptions {
    readonly jwt?: {
        readonly issuer?: string;
        readonly audience?: string | readonly string[];
    };
    readonly jwks?: {
        readonly remoteUrl?: string;
        readonly jwksPath?: string;
        readonly keyPairConfig?: { readonly alg?: string };
    };
}

/** Derive the verifier contract from the exact Better Auth JWT plugin instance. */
export function gatewayJwtConfigFromAuthOptions(
    authOptions: BetterAuthOptions,
    authBasePath: string = authOptions.basePath ?? "/api/auth"
): GatewayJwtConfig | null {
    const plugin = (authOptions.plugins ?? []).find(candidate => candidate.id === "jwt");
    if (!plugin) return null;
    const options = (plugin as BetterAuthPlugin & { readonly options?: BetterAuthJwtPluginOptions }).options;
    const configuredOrigin = typeof authOptions.baseURL === "string" ? new URL(authOptions.baseURL).origin : undefined;
    const issuer = options?.jwt?.issuer ?? configuredOrigin;
    const audience = options?.jwt?.audience ?? configuredOrigin;
    return {
        ...(issuer !== undefined ? { issuer } : {}),
        ...(audience !== undefined ? { audience } : {}),
        algorithms: [options?.jwks?.keyPairConfig?.alg ?? "EdDSA"],
        ...(options?.jwks?.remoteUrl ? { jwksUrl: options.jwks.remoteUrl } : {}),
        authBasePath,
        jwksPath: options?.jwks?.jwksPath ?? "/jwks",
    };
}

/**
 * Build the per-env auth runtime. Better Auth constructs its own router
 * eagerly when called, so we defer the call until the first request
 * lands and capture the inbound `env` to wire the chardb adapter. The
 * resulting `betterAuth` instance is memoized per env-identity (one
 * worker isolate typically sees a single env reference, so this caches
 * one instance for the lifetime of the isolate; multi-isolate sharing
 * is by-design avoided so each isolate's adapter holds its own DO
 * stubs).
 */
function buildDefaultAuthRuntime<TPlugins extends readonly BetterAuthPlugin[]>(
    authOptions: BetterAuthOptions
): {
    get: (env: ChardbEnv, request: Request) => ChardbAuthRuntime<TPlugins>;
    handler: NonNullable<MountChardbOptions["authHandler"]>;
} {
    const cache = new WeakMap<object, { key: string; instance: ChardbAuthRuntime<TPlugins> }>();
    const get = (env: ChardbEnv, request: Request): ChardbAuthRuntime<TPlugins> => {
        const e = sourceChardbEnv(env as unknown as object);
        const requestOrigin = new URL(request.url).origin;
        const cacheKey = authOptions.baseURL === undefined ? requestOrigin : "configured";
        const cached = cache.get(e);
        let instance = cached?.key === cacheKey ? cached.instance : undefined;
        if (!instance) {
            instance = betterAuth({
                ...authOptions,
                // Workers can serve workers.dev, custom, preview, and local hosts.
                // Pin an otherwise-unconfigured Better Auth instance to the
                // canonical request origin instead of trusting an arbitrary
                // Host header or forcing a wildcard allow-list.
                ...(authOptions.baseURL === undefined ? { baseURL: requestOrigin } : {}),
                database: chardbAuthAdapter({ env: env as unknown as ChardbAuthAdapterEnv }),
            }) as unknown as ChardbAuthRuntime<TPlugins>;
            // Keep the cache bounded when one Worker serves many custom hosts.
            // A host switch replaces the previous unconfigured instance.
            cache.set(e, { key: cacheKey, instance });
        }
        return instance;
    };
    return {
        get,
        handler: (request, env) => get(env, request).handler(request),
    };
}
