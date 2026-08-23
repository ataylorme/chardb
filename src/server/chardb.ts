/**
 * `chardb({ … })` — the single Worker-entry factory.
 *
 * Returns the wrangler-ready module: a Hono app you can mount your own
 * routes on, with `.fetch`, `.scheduled`, the six chardb Durable Object
 * classes, the synthesized better-auth schema, and the chardb-managed
 * `auth` value all hanging off the same object. One call replaces
 * `defineAuth` + `defineChardb` + `new Hono()` + `mountChardb` + the DO
 * re-exports. The lower-level primitives remain public for advanced
 * split-worker setups (`chardb/server` still exports `defineAuth`,
 * `defineChardb`, `mountChardb`).
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
 *   export default app;
 *   export const { Cdb, Catalog, Gateway, BlobMeta, Resharder, GsiShard } = app;
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

import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { Hono } from "hono";
import { type ChardbAuthAdapterEnv, chardbAuthAdapter } from "../auth/chardb_adapter.ts";
import {
    type AuthOptionsInput,
    type ChardbAuth,
    type InferPluginTables,
    type SynthesizedAuthSchema,
    defineAuth,
} from "../auth/synthesize.ts";
import { buildAccessControl } from "./cdb-access.ts";
import { BlobMeta } from "./do/blobmeta.ts";
import { Catalog } from "./do/catalog.ts";
import { type Cdb, configureCdbRuntime } from "./do/cdb.ts";
import { type Gateway, type GatewayJwtConfig, configureGatewayRuntime } from "./do/gateway.ts";
import { GsiShard } from "./do/gsishard.ts";
import { Resharder } from "./do/resharder.ts";
import {
    type ChardbEnv,
    type DefineChardbInput,
    type MountChardbOptions,
    defineChardb,
    mountChardb,
} from "./entrypoint.ts";

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
 * `authHandler?` is for users who construct `betterAuth(options)` and
 * want chardb to auto-mount `/api/auth/*`.
 */
export interface ChardbFactoryInput<
    TPlugins extends readonly BetterAuthPlugin[],
    TSchema extends Record<string, unknown>,
> extends Omit<DefineChardbInput<TSchema>, "auth" | "refs"> {
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
    readonly routes?: (app: Hono<{ Bindings: ChardbEnv }>) => void;
    /** Better-auth fetch handler from `betterAuth(options).handler`; auto-mounted at `/api/auth/*`. */
    readonly authHandler?: MountChardbOptions["authHandler"];
    readonly authBasePath?: MountChardbOptions["authBasePath"];
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
export type ChardbApp<TPlugins extends readonly BetterAuthPlugin[], TSchema extends Record<string, unknown>> = Hono<{
    Bindings: ChardbEnv;
}> & {
    readonly fetch: (request: Request, env: ChardbEnv, ctx: ExecutionContext) => Promise<Response>;
    readonly auth: ChardbAuth<TPlugins>;
    readonly schema: TSchema & SynthesizedAuthSchema<InferPluginTables<TPlugins>>;
    readonly Cdb: typeof Cdb;
    readonly Catalog: typeof Catalog;
    readonly Gateway: typeof Gateway;
    readonly BlobMeta: typeof BlobMeta;
    readonly Resharder: typeof Resharder;
    readonly GsiShard: typeof GsiShard;
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

    const Chardb = defineChardb({
        schema: input.schema,
        auth,
        ...(refsValue ? { refs: refsValue } : {}),
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.manifest ? { manifest: input.manifest } : {}),
    });
    const runtimeEntrypoint = Chardb as typeof Chardb & {
        readonly schema: Record<string, unknown>;
        readonly chardbManifest: import("./manifest.ts").ChardbManifest;
    };
    const ConfiguredCdb = configureCdbRuntime({
        schema: () => runtimeEntrypoint.schema,
        manifest: () => runtimeEntrypoint.chardbManifest,
    });
    const authBasePath = input.authBasePath ?? auth.options.basePath ?? "/api/auth";
    const ConfiguredGateway = configureGatewayRuntime({
        manifest: () => runtimeEntrypoint.chardbManifest,
        auth: gatewayJwtConfigFromAuthOptions(auth.options, authBasePath),
    });

    const hono = new Hono<{ Bindings: ChardbEnv }>();
    if (input.routes) input.routes(hono);

    // Snapshot Hono's own `.fetch` BEFORE handing the instance to
    // `mountChardb`. If we let `mountChardb` close over `hono.fetch` and
    // then overwrite `hono.fetch` with the wrapped handler below, the
    // wrapped handler would recurse into itself on the
    // non-reserved-prefix fall-through.
    const honoFetch = hono.fetch.bind(hono);

    // Auto-mount better-auth at /api/auth/* unless the caller passed an
    // explicit authHandler. The adapter has to be constructed per inbound
    // env (the DO bindings live there), so we memoize a betterAuth
    // instance per env-identity to avoid re-running the adapter factory
    // on every request.
    //
    // The cdbTable subsystem materializes a single AccessControl from
    // the user's schema at first-request time (deferred so the
    // worker.ts ↔ schema.ts ESM cycle has fully evaluated AND so the
    // `.schema` getter stays lazy). The result is patched into the
    // `organization()` and `admin()` plugin instances by
    // re-constructing them with `{ ac, roles }` before handing the
    // plugin list to betterAuth().
    // The auth runtime was bound when defineChardb ran. Resolve the full
    // schema lazily here only to build access-control metadata after the
    // worker.ts ↔ schema.ts ESM cycle has completed.
    const getMergedSchemaForAc = (): Record<string, unknown> => runtimeEntrypoint.schema;
    const authHandler =
        input.authHandler ?? buildDefaultAuthHandler(auth.options as BetterAuthOptions, getMergedSchemaForAc);

    const mounted = mountChardb(
        Chardb,
        { fetch: honoFetch as Parameters<typeof mountChardb>[1]["fetch"] },
        {
            ...(authHandler ? { authHandler } : {}),
            authBasePath,
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
        get: () => ({ ...auth, ...input.schema }) as TSchema & SynthesizedAuthSchema<InferPluginTables<TPlugins>>,
    });
    const merged = Object.assign(hono, {
        fetch: mounted.fetch,
        auth,
        Cdb: ConfiguredCdb,
        Catalog,
        Gateway: ConfiguredGateway,
        BlobMeta,
        Resharder,
        GsiShard,
    });
    return merged as ChardbApp<TPlugins, TSchema>;
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
 * Build the per-env auth handler. Better-auth constructs its own router
 * eagerly when called, so we defer the call until the first request
 * lands and capture the inbound `env` to wire the chardb adapter. The
 * resulting `betterAuth` instance is memoized per env-identity (one
 * worker isolate typically sees a single env reference, so this caches
 * one instance for the lifetime of the isolate; multi-isolate sharing
 * is by-design avoided so each isolate's adapter holds its own DO
 * stubs).
 */
function buildDefaultAuthHandler(
    authOptions: BetterAuthOptions,
    getSchema: () => Record<string, unknown>
): MountChardbOptions["authHandler"] {
    const cache = new WeakMap<object, (request: Request) => Response | Promise<Response>>();
    let cachedAcOptions: BetterAuthOptions | undefined;
    return (request, env) => {
        const e = env as unknown as object;
        let handler = cache.get(e);
        if (!handler) {
            if (!cachedAcOptions) cachedAcOptions = applyCdbAccessControl(authOptions, getSchema());
            const instance = betterAuth({
                ...cachedAcOptions,
                database: chardbAuthAdapter({ env: env as unknown as ChardbAuthAdapterEnv }),
            });
            handler = instance.handler.bind(instance);
            cache.set(e, handler);
        }
        return handler(request);
    };
}

/**
 * Patch the `organization()` and `admin()` plugin instances in the
 * options object with the chardb-built `{ ac, roles }` derived from
 * the schema. Returns a NEW options object (no mutation) — the
 * original `auth.options` stays referentially stable so callers
 * destructuring it elsewhere see the un-patched view.
 *
 * The user's plugin instance, if present, has its options preserved
 * via re-instantiation. If the user already passed `{ ac, roles }`,
 * those win (we only fill in the chardb defaults when the keys are
 * absent).
 */
function applyCdbAccessControl(authOptions: BetterAuthOptions, schema: Record<string, unknown>): BetterAuthOptions {
    const built = buildAccessControl(schema);
    const plugins = (authOptions.plugins ?? []) as readonly BetterAuthPlugin[];
    const next: BetterAuthPlugin[] = [];
    let patchedOrg = false;
    let patchedAdmin = false;
    for (const p of plugins) {
        const id = (p as { id?: string }).id;
        if (id === "organization" && !patchedOrg) {
            const opts = ((p as { options?: Record<string, unknown> }).options ?? {}) as Record<string, unknown>;
            next.push(
                organization({
                    ...opts,
                    ac: opts.ac ?? built.ac,
                    roles: (opts.roles as Record<string, unknown> | undefined) ?? built.roles,
                } as Parameters<typeof organization>[0])
            );
            patchedOrg = true;
            continue;
        }
        if (id === "admin" && !patchedAdmin) {
            const opts = ((p as { options?: Record<string, unknown> }).options ?? {}) as Record<string, unknown>;
            next.push(
                admin({
                    ...opts,
                    roles: (opts.roles as Record<string, unknown> | undefined) ?? built.userRoles,
                } as Parameters<typeof admin>[0])
            );
            patchedAdmin = true;
            continue;
        }
        next.push(p);
    }
    return { ...authOptions, plugins: next };
}
