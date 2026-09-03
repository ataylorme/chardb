/**
 * `defineChardb({ schema, auth })` returns a `WorkerEntrypoint` subclass.
 *
 * The class:
 *   - implements `fetch(req)` for the reserved-route prefix list:
 *       /ws         — hibernatable WebSocket to the Gateway DO (wired)
 *       /_chardb/*  — internal dashboard / admin routes (wired)
 *     Everything else falls through to the user's `app.fetch` via
 *     `mountChardb`.
 *
 * Every response carries a `Server-Timing` header (per
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Server-Timing) and
 * a `cf-chardb-correlation-id` so client traces, server logs, and the
 * `chardb-tail` Worker can be joined on a single id. Inbound requests may
 * supply their own correlation id; otherwise a UUIDv7 is minted server-side.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { BetterAuthOptions } from "better-auth";
import { bindAuthRuntime } from "../auth/runtime.ts";
import { type SynthesizedAuthSchema, assertNoReservedTableShadow, synthesizeAuthSchema } from "../auth/synthesize.ts";
import { isCdbError, rehydrateCdbRpcError } from "../errors.ts";
import { adminJsonError, authorizeAdmin, exactAdminObject, readAdminBody } from "./admin-http.ts";
import { buildColocationOverrides } from "./cdb-colocation.ts";
import type { CatalogSchemaShardState, CatalogSchemaState } from "./do/catalog-schema-store.ts";
import { gatewayBucketName } from "./gateway-bucket.ts";
import { httpStatusForCdbError } from "./http-errors.ts";
import { withChardbLoopbacks } from "./loopback.ts";
import { type ChardbManifest, emptyManifest, manifestFromExports } from "./manifest.ts";
import { CHARDB_SERVER_VERSION, decorateResponse, extractCorrelationId } from "./observability_helpers.ts";
import { handleOrganizationDeletionAdminRequest } from "./organization-deletion-admin.ts";
import { handleRecoveryAdminRequest } from "./recovery-admin.ts";
import { handleReshardAdminRequest } from "./reshard-admin.ts";

export { CHARDB_SERVER_VERSION, decorateResponse, extractCorrelationId } from "./observability_helpers.ts";

export interface ChardbEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    /** Native same-Worker loopback for internal reshard orchestration. */
    readonly CDB_RESHARD?: DurableObjectNamespace;
    /** Fixed native bucket used only when the private file contract is configured. */
    readonly CDB_FILES?: R2Bucket;
    readonly CDB_DASHBOARD?: Fetcher;
    /** Secret bearer token for private migration and shard controls. Keep it in Wrangler secrets. */
    readonly CDB_ADMIN_TOKEN?: string;
}

interface CatalogMigrationRpc {
    adminSchemaState(): Promise<CatalogSchemaState>;
    adminBeginSchemaMigration(args: {
        readonly migrationId: string;
        readonly targetVersion: number;
    }): Promise<CatalogSchemaState>;
    adminBeginSchemaBaseline(args: {
        readonly migrationId: string;
        readonly targetVersion: number;
    }): Promise<CatalogSchemaState>;
    adminSchemaMigrationShards(args: {
        readonly migrationId: string;
    }): Promise<readonly CatalogSchemaShardState[]>;
    adminMigrateSchemaShard(args: {
        readonly migrationId: string;
        readonly shardId: string;
    }): Promise<CatalogSchemaShardState>;
    adminApplyCatalogSchemaMigration(args: {
        readonly migrationId: string;
        readonly version: number;
    }): Promise<CatalogSchemaState>;
    adminCompleteSchemaMigration(args: { readonly migrationId: string }): Promise<CatalogSchemaState>;
}

/**
 * Auth profile for `defineChardb`. Pass either:
 *   - `{ options: BetterAuthOptions }` — chardb synthesizes the auth
 *     schema for you;
 *   - the result of `defineAuth(options, [...require])` from
 *     `defineAuth()` — the bundle of options and synthesized tables;
 *     `defineChardb` uses `.options` and the tables you already have.
 *
 * Either way the auth-table namespace (`user`, `session`, `account`,
 * `verification`, plus everything the registered plugins contribute) is
 * reserved by chardb: a user `schema` key that shadows it raises
 * `CDB_RESERVED_TABLE_NAME` here at construction time rather than at
 * first query.
 */
export interface DefineChardbAuth {
    readonly options: BetterAuthOptions;
}

export interface DefineChardbInput<TSchema = unknown> {
    readonly schema: TSchema;
    readonly auth?: DefineChardbAuth;
    /** Override `policy.distributionRoots` etc. */
    readonly policy?: Partial<import("../colocation/types.ts").PolicyInput>;
    /**
     * Module exports containing mutations and queries.
     * `defineChardb` walks the record at first
     * use, picking up every `__chardbRef`-marked value and (combined with
     * any ledgers in `schema`) builds the runtime manifest for you. The
     * `chardb({ api })` supplies this from the application's API module
     * namespaces.
     */
    readonly refs?: Readonly<Record<string, unknown>>;
    /**
     * Pre-built manifest override. When provided, takes precedence over
     * `refs`. Intended for internal tests and custom server assembly.
     */
    readonly manifest?: ChardbManifest;
}

function isReserved(path: string): boolean {
    return path === "/ws" || path.startsWith("/ws/") || path.startsWith("/_chardb/");
}

export async function handleMigrationAdminRequest(request: Request, env: ChardbEnv): Promise<Response> {
    const denied = await authorizeAdmin(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const catalogId = env.CDB_CATALOG.idFromName("global");
    const catalog = env.CDB_CATALOG.get(catalogId) as unknown as CatalogMigrationRpc;
    try {
        if (request.method === "GET" && url.pathname === "/_chardb/migrations/state") {
            return Response.json({ ok: true, state: await catalog.adminSchemaState() });
        }
        if (request.method === "GET" && url.pathname === "/_chardb/migrations/shards") {
            const migrationId = url.searchParams.get("migrationId");
            if (!migrationId) return adminJsonError(400, "migrationId is required");
            return Response.json({ ok: true, shards: await catalog.adminSchemaMigrationShards({ migrationId }) });
        }
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        const body = await readAdminBody(request);
        if (url.pathname === "/_chardb/migrations/begin") {
            const input = exactAdminObject(body, ["migrationId", "targetVersion"]);
            if (typeof input.migrationId !== "string" || typeof input.targetVersion !== "number") {
                return adminJsonError(400, "migrationId and targetVersion are required");
            }
            return Response.json({
                ok: true,
                state: await catalog.adminBeginSchemaMigration({
                    migrationId: input.migrationId,
                    targetVersion: input.targetVersion,
                }),
            });
        }
        if (url.pathname === "/_chardb/migrations/baseline") {
            const input = exactAdminObject(body, ["migrationId", "targetVersion"]);
            if (typeof input.migrationId !== "string" || typeof input.targetVersion !== "number") {
                return adminJsonError(400, "migrationId and targetVersion are required");
            }
            return Response.json({
                ok: true,
                state: await catalog.adminBeginSchemaBaseline({
                    migrationId: input.migrationId,
                    targetVersion: input.targetVersion,
                }),
            });
        }
        if (url.pathname === "/_chardb/migrations/shard") {
            const input = exactAdminObject(body, ["migrationId", "shardId"]);
            if (typeof input.migrationId !== "string" || typeof input.shardId !== "string") {
                return adminJsonError(400, "migrationId and shardId are required");
            }
            return Response.json({
                ok: true,
                shard: await catalog.adminMigrateSchemaShard({
                    migrationId: input.migrationId,
                    shardId: input.shardId,
                }),
            });
        }
        if (url.pathname === "/_chardb/migrations/catalog") {
            const input = exactAdminObject(body, ["migrationId", "version"]);
            if (typeof input.migrationId !== "string" || typeof input.version !== "number") {
                return adminJsonError(400, "migrationId and version are required");
            }
            return Response.json({
                ok: true,
                state: await catalog.adminApplyCatalogSchemaMigration({
                    migrationId: input.migrationId,
                    version: input.version,
                }),
            });
        }
        if (url.pathname === "/_chardb/migrations/complete") {
            const input = exactAdminObject(body, ["migrationId"]);
            if (typeof input.migrationId !== "string") {
                return adminJsonError(400, "migrationId is required");
            }
            return Response.json({
                ok: true,
                state: await catalog.adminCompleteSchemaMigration({ migrationId: input.migrationId }),
            });
        }
        return new Response("not found", { status: 404 });
    } catch (error) {
        if (error instanceof TypeError || error instanceof SyntaxError) {
            return adminJsonError(400, error.message);
        }
        const projected = rehydrateCdbRpcError(error);
        if (isCdbError(projected)) {
            return Response.json(
                {
                    ok: false,
                    error: projected.message,
                    code: projected.code,
                    retryable: projected.retryable,
                },
                {
                    status: httpStatusForCdbError(projected.code),
                    headers: { "cache-control": "no-store" },
                }
            );
        }
        return adminJsonError(500, "internal error");
    }
}

class ChardbEntrypoint extends WorkerEntrypoint<ChardbEnv> {
    constructor(ctx: ExecutionContext, env: ChardbEnv) {
        super(ctx, withChardbLoopbacks(env, ctx));
    }

    /** Subclass overrides this via `defineChardb({ manifest })`. */
    protected manifest(): ChardbManifest {
        return emptyManifest();
    }

    /** Subclass binds the exact packaged schema used by every Cdb isolate. */
    protected schema(): Record<string, unknown> {
        return {};
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const correlationId = extractCorrelationId(request);
        const start = Date.now();
        let response: Response;
        try {
            if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
                response = await this.handleWebSocket(request);
            } else if (url.pathname.startsWith("/_chardb/backups/")) {
                response = await handleRecoveryAdminRequest(request, this.env);
            } else if (url.pathname.startsWith("/_chardb/shards/")) {
                response = await handleReshardAdminRequest(request, this.env, this.schema());
            } else if (url.pathname.startsWith("/_chardb/organizations/deletion/")) {
                response = await handleOrganizationDeletionAdminRequest(request, this.env);
            } else if (url.pathname.startsWith("/_chardb/migrations/")) {
                response = await this.handleMigrations(request);
            } else if (url.pathname.startsWith("/_chardb/")) {
                response = await this.handleDashboard(request);
            } else {
                response = new Response("not found", { status: 404 });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "internal error";
            response = new Response(JSON.stringify({ ok: false, error: message, correlationId }), {
                status: 500,
                headers: { "content-type": "application/json" },
            });
        }
        return decorateResponse(response, start, correlationId, CHARDB_SERVER_VERSION);
    }

    private async handleWebSocket(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const clientId = url.searchParams.get("clientId") ?? crypto.randomUUID();
        url.searchParams.set("clientId", clientId);
        const id = this.env.CDB_GATEWAY.idFromName(gatewayBucketName(clientId));
        return this.env.CDB_GATEWAY.get(id).fetch(new Request(url, request));
    }

    private async handleDashboard(request: Request): Promise<Response> {
        const dash = this.env.CDB_DASHBOARD;
        if (!dash) return new Response("dashboard not bound", { status: 500 });
        return dash.fetch(request);
    }

    private async handleMigrations(request: Request): Promise<Response> {
        return handleMigrationAdminRequest(request, this.env);
    }
}

/**
 * Returns a concrete `WorkerEntrypoint` subclass bound to the user's
 * schema and (optionally) better-auth options. When `auth.options` is
 * present, the four core auth tables (`user`, `session`, `account`,
 * `verification`) plus every plugin-contributed table are synthesized
 * via `synthesizeAuthSchema(options)` and merged into the runtime
 * schema — the user only writes their domain tables in `schema`. A
 * domain table whose key collides with a reserved auth-table name
 * raises `CDB_RESERVED_TABLE_NAME` at construction time.
 *
 * Usage in the customer's `worker.ts`:
 * ```ts
 * export default defineChardb({
 *   schema: domain,
 *   auth: { options: authOptions },
 *   manifest,
 * });
 * export const { DB, Catalog, Cdb, Gateway, Resharder } = app;
 * ```
 */
export function defineChardb<TSchema>(input: DefineChardbInput<TSchema>): typeof ChardbEntrypoint {
    // Auth options do not depend on the domain-schema namespace, so bind
    // their synthesized tables at module initialization. Every Worker and
    // Durable Object isolate evaluates the application module separately;
    // eager binding ensures a Catalog created for the first request has the
    // model tables before its bootstrap runs.
    const synthesizedAuth = input.auth
        ? (synthesizeAuthSchema(
              input.auth.options as unknown as Parameters<typeof synthesizeAuthSchema>[0]
          ) as unknown as SynthesizedAuthSchema)
        : undefined;
    if (synthesizedAuth && input.auth) {
        bindAuthRuntime({
            schema: synthesizedAuth,
            options: input.auth.options as { readonly [k: string]: unknown },
        });
    }

    // Domain-schema construction remains lazy. `defineChardb` is usually
    // called in a worker.ts ↔ schema.ts ESM cycle; iterating that namespace
    // during module initialization can hit a partially evaluated binding.
    let cachedSchema: TSchema | null = null;
    let cachedManifest: ChardbManifest | null = null;
    let cachedPolicy: import("../colocation/types.ts").PolicyInput | undefined;
    function getSchema(): TSchema {
        if (cachedSchema !== null) return cachedSchema;
        cachedSchema = mergeAuthIntoSchema(input.schema, synthesizedAuth);
        return cachedSchema;
    }
    function getManifest(): ChardbManifest {
        if (cachedManifest !== null) return cachedManifest;
        let built: ChardbManifest;
        if (input.manifest) {
            built = input.manifest;
        } else if (input.refs) {
            built = manifestFromExports(input.refs);
        } else {
            built = emptyManifest();
        }
        cachedManifest = built;
        return built;
    }
    function getPolicy(): import("../colocation/types.ts").PolicyInput | undefined {
        if (cachedPolicy !== undefined) return cachedPolicy;
        if (!input.auth && !input.policy) return undefined;
        // Defaults mirror `colocation/types.DEFAULT_POLICY`:
        //   - `distributionRoots: ["organization", "user"]` matches better-auth.
        //   - `strictMultiRoot: false` lets the algorithm auto-resolve every
        //     multi-root table (the typical SaaS shape — `messages` FK to
        //     `organization` + `user`) via the first matching root in
        //     priority order, instead of forcing the user to write a
        //     `policy.overrides[t] = { … via: "organizationId" }` entry.
        // cdbTable-derived colocation overrides live alongside any
        // user-supplied `policy.overrides`. The user's explicit map wins
        // (it's their escape hatch for outliers); chardb's auto-derived
        // overrides fill the rest.
        const schema = getSchema();
        const fromTables =
            schema && typeof schema === "object"
                ? buildColocationOverrides(schema as Record<string, unknown>).overrides
                : {};
        cachedPolicy = {
            distributionRoots: input.policy?.distributionRoots ?? ["organization", "user"],
            strictMultiRoot: input.policy?.strictMultiRoot ?? false,
            requireRoot: input.policy?.requireRoot ?? false,
            allowMissingRoots: input.policy?.allowMissingRoots ?? false,
            overrides: { ...fromTables, ...(input.policy?.overrides ?? {}) },
        };
        return cachedPolicy;
    }
    return class Configured extends ChardbEntrypoint {
        static get schema(): TSchema {
            return getSchema();
        }
        static readonly authConfig = input.auth;
        static get chardbPolicy(): import("../colocation/types.ts").PolicyInput | undefined {
            return getPolicy();
        }
        static get chardbManifest(): ChardbManifest {
            return getManifest();
        }
        protected override manifest(): ChardbManifest {
            return getManifest();
        }
        protected override schema(): Record<string, unknown> {
            return getSchema() as Record<string, unknown>;
        }
    };
}

function mergeAuthIntoSchema<TSchema>(schema: TSchema, synthesizedAuth: SynthesizedAuthSchema | undefined): TSchema {
    if (!synthesizedAuth) return schema;
    if (!schema || typeof schema !== "object") return schema;
    const userNames: string[] = [];
    for (const k of Object.keys(schema)) userNames.push(k);
    assertNoReservedTableShadow(userNames);
    return { ...synthesizedAuth, ...schema } as TSchema;
}

/**
 * Compose `defineChardb` with a user-provided fetch handler that owns the
 * non-reserved routes (e.g. a Hono app).
 *
 * Optional `options.authHandler` accepts a better-auth fetch handler
 * (the `auth.handler` field returned by `betterAuth(options)`).
 * `mountChardb` routes any request whose path starts with the
 * better-auth basePath (default `/api/auth`) straight to it, so the
 * user never wires the better-auth router into their app manually.
 * CharDB's reserved prefixes (`/ws`, `/_chardb/*`) win over the auth
 * handler; everything else falls through to `app.fetch`.
 */
export interface MountChardbOptions {
    /**
     * Better-auth-compatible fetch handler. Receives the raw `Request`,
     * the wrangler `env` (so the handler can lazily construct
     * `betterAuth(options)` against the chardb-native adapter the
     * first time it's called), and the `ExecutionContext`. The wider
     * signature is required by `chardb({auth})`'s auto-mount path —
     * it has no `env` at module-init time and must defer construction
     * until the first request lands.
     */
    readonly authHandler?: (request: Request, env: ChardbEnv, ctx: ExecutionContext) => Response | Promise<Response>;
    /** Path prefix the better-auth handler owns. Defaults to `/api/auth`. */
    readonly authBasePath?: string;
    /** Private reserved file handler. The public package does not expose a file client yet. */
    readonly fileHandler?: (request: Request, env: ChardbEnv, ctx: ExecutionContext) => Response | Promise<Response>;
}

export function mountChardb(
    Chardb: typeof ChardbEntrypoint,
    app: {
        fetch: (request: Request, env: ChardbEnv, ctx: ExecutionContext) => Response | Promise<Response>;
    },
    options: MountChardbOptions = {}
): {
    fetch: (request: Request, env: ChardbEnv, ctx: ExecutionContext) => Promise<Response>;
} {
    const authBase = options.authBasePath ?? "/api/auth";
    const authHandler = options.authHandler;
    const fileHandler = options.fileHandler;
    return {
        async fetch(request, env, ctx): Promise<Response> {
            const resolvedEnv = withChardbLoopbacks(env, ctx);
            const url = new URL(request.url);
            const start = Date.now();
            const correlationId = extractCorrelationId(request);
            if (fileHandler && (url.pathname === "/_chardb/files" || url.pathname.startsWith("/_chardb/files/"))) {
                return decorateResponse(
                    await fileHandler(request, resolvedEnv, ctx),
                    start,
                    correlationId,
                    CHARDB_SERVER_VERSION
                );
            }
            if (isReserved(url.pathname)) {
                const instance = new Chardb(ctx, resolvedEnv);
                return instance.fetch(request);
            }
            if (authHandler && (url.pathname === authBase || url.pathname.startsWith(`${authBase}/`))) {
                return decorateResponse(
                    await authHandler(request, resolvedEnv, ctx),
                    start,
                    correlationId,
                    CHARDB_SERVER_VERSION
                );
            }
            return decorateResponse(
                await app.fetch(request, resolvedEnv, ctx),
                start,
                correlationId,
                CHARDB_SERVER_VERSION
            );
        },
    };
}
