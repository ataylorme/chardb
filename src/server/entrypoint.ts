/**
 * `defineChardb({ schema, auth })` returns a `WorkerEntrypoint` subclass.
 *
 * The class:
 *   - implements `fetch(req)` for the reserved-route prefix list:
 *       /ws         — hibernatable WebSocket to the Gateway DO (wired)
 *       /_chardb/*  — internal dashboard / admin routes (wired)
 *     Everything else falls through to the user's `app.fetch` via
 *     `mountChardb`.
 *   - implements `scheduled(event)` for Cron Triggers
 *     (https://developers.cloudflare.com/workers/configuration/cron-triggers/),
 *     where the recurring PITR barrier ticks and user `defineCron` callbacks
 *     are dispatched.
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
import { buildColocationOverrides } from "./cdb-colocation.ts";
import type { CatalogSchemaShardState, CatalogSchemaState } from "./do/catalog.ts";
import { withChardbLoopbacks } from "./loopback.ts";
import { type ChardbManifest, emptyManifest, manifestFromExports } from "./manifest.ts";
import { decorateResponse, extractCorrelationId, selectMatchingCrons } from "./observability_helpers.ts";

export {
    decorateResponse,
    extractCorrelationId,
    selectMatchingCrons,
} from "./observability_helpers.ts";

export interface ChardbEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_BLOBMETA: DurableObjectNamespace;
    readonly CDB_RESHARDER: DurableObjectNamespace;
    readonly CDB_GSI: DurableObjectNamespace;
    readonly CDB_R2?: R2Bucket;
    readonly CDB_VECTORIZE?: unknown;
    readonly CDB_GSI_QUEUE?: Queue<unknown>;
    readonly CDB_DASHBOARD?: Fetcher;
    /** Secret bearer token for the migration control route. Keep it in Wrangler secrets. */
    readonly CDB_ADMIN_TOKEN?: string;
}

interface CatalogMigrationRpc {
    schemaState(): Promise<CatalogSchemaState>;
    beginSchemaMigration(args: {
        readonly migrationId: string;
        readonly targetVersion: number;
    }): Promise<CatalogSchemaState>;
    beginSchemaBaseline(args: {
        readonly migrationId: string;
        readonly targetVersion: number;
    }): Promise<CatalogSchemaState>;
    schemaMigrationShards(args: { readonly migrationId: string }): Promise<readonly CatalogSchemaShardState[]>;
    migrateSchemaShard(args: {
        readonly migrationId: string;
        readonly shardId: string;
    }): Promise<CatalogSchemaShardState>;
    applyCatalogSchemaMigration(args: {
        readonly migrationId: string;
        readonly version: number;
    }): Promise<CatalogSchemaState>;
    completeSchemaMigration(args: { readonly migrationId: string }): Promise<CatalogSchemaState>;
}

const MIGRATION_BODY_MAX_BYTES = 4_096;
const MIGRATION_TOKEN_MAX_BYTES = 512;
const MIGRATION_TEXT_ENCODER = new TextEncoder();

/**
 * Auth profile for `defineChardb`. Pass either:
 *   - `{ options: BetterAuthOptions }` — chardb synthesizes the auth
 *     schema for you;
 *   - the result of `defineAuth(options, [...require])` from
 *     `chardb/auth` — the bundle of options + synthesized tables;
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
     * Module exports containing `defineMutation` / `defineQuery` / `defineCron`
     * / `definePresenceKey` values. `defineChardb` walks the record at first
     * use, picking up every `__chardbRef`-marked value and (combined with
     * any ledgers in `schema`) builds the runtime manifest for you. The
     * Vite plugin assembles this automatically; tests and ad-hoc callers
     * may pass `import * as api from "./api.ts"` directly.
     */
    readonly refs?: Readonly<Record<string, unknown>>;
    /**
     * Pre-built manifest override. When provided, takes precedence over
     * `refs`. Useful when the Vite plugin has already assembled a manifest
     * at build time.
     */
    readonly manifest?: ChardbManifest;
}

function isReserved(path: string): boolean {
    return path === "/ws" || path.startsWith("/ws/") || path.startsWith("/_chardb/");
}

const SERVER_VERSION = "0.1.0";

async function equalSecret(left: string, right: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [leftDigest, rightDigest] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(left)),
        crypto.subtle.digest("SHA-256", encoder.encode(right)),
    ]);
    const a = new Uint8Array(leftDigest);
    const b = new Uint8Array(rightDigest);
    let difference = a.byteLength ^ b.byteLength;
    const length = Math.max(a.byteLength, b.byteLength);
    for (let index = 0; index < length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
    return difference === 0 && left.length > 0;
}

async function readMigrationBody(request: Request): Promise<unknown> {
    const declared = request.headers.get("content-length");
    if (declared !== null) {
        const bytes = Number(declared);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MIGRATION_BODY_MAX_BYTES) {
            throw new TypeError("migration request body is too large");
        }
    }
    if (!request.body) throw new TypeError("migration request body is required");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MIGRATION_BODY_MAX_BYTES) {
            await reader.cancel();
            throw new TypeError("migration request body is too large");
        }
        chunks.push(next.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}

function exactMigrationObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("migration request body must be an object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const expected = [...keys].sort();
    if (
        actual.length !== expected.length ||
        actual.some((key, index) => key !== expected[index]) ||
        actual.some(key => {
            const descriptor = descriptors[key];
            return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
        })
    ) {
        throw new TypeError("migration request body has unexpected fields");
    }
    return Object.fromEntries(actual.map(key => [key, descriptors[key]?.value]));
}

function migrationJsonError(status: number, error: string): Response {
    return Response.json({ ok: false, error }, { status });
}

export async function handleMigrationAdminRequest(request: Request, env: ChardbEnv): Promise<Response> {
    const configuredToken = env.CDB_ADMIN_TOKEN;
    if (!configuredToken) return new Response("not found", { status: 404 });
    if (MIGRATION_TEXT_ENCODER.encode(configuredToken).byteLength > MIGRATION_TOKEN_MAX_BYTES) {
        return migrationJsonError(500, "migration admin token is misconfigured");
    }
    const supplied = request.headers.get("authorization");
    const token = supplied?.startsWith("Bearer ") ? supplied.slice("Bearer ".length) : "";
    if (
        MIGRATION_TEXT_ENCODER.encode(token).byteLength > MIGRATION_TOKEN_MAX_BYTES ||
        !(await equalSecret(token, configuredToken))
    ) {
        return new Response("forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const catalogId = env.CDB_CATALOG.idFromName("global");
    const catalog = env.CDB_CATALOG.get(catalogId) as unknown as CatalogMigrationRpc;
    try {
        if (request.method === "GET" && url.pathname === "/_chardb/migrations/state") {
            return Response.json({ ok: true, state: await catalog.schemaState() });
        }
        if (request.method === "GET" && url.pathname === "/_chardb/migrations/shards") {
            const migrationId = url.searchParams.get("migrationId");
            if (!migrationId) return migrationJsonError(400, "migrationId is required");
            return Response.json({ ok: true, shards: await catalog.schemaMigrationShards({ migrationId }) });
        }
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        const body = await readMigrationBody(request);
        if (url.pathname === "/_chardb/migrations/begin") {
            const input = exactMigrationObject(body, ["migrationId", "targetVersion"]);
            if (typeof input.migrationId !== "string" || typeof input.targetVersion !== "number") {
                return migrationJsonError(400, "migrationId and targetVersion are required");
            }
            return Response.json({
                ok: true,
                state: await catalog.beginSchemaMigration({
                    migrationId: input.migrationId,
                    targetVersion: input.targetVersion,
                }),
            });
        }
        if (url.pathname === "/_chardb/migrations/baseline") {
            const input = exactMigrationObject(body, ["migrationId", "targetVersion"]);
            if (typeof input.migrationId !== "string" || typeof input.targetVersion !== "number") {
                return migrationJsonError(400, "migrationId and targetVersion are required");
            }
            return Response.json({
                ok: true,
                state: await catalog.beginSchemaBaseline({
                    migrationId: input.migrationId,
                    targetVersion: input.targetVersion,
                }),
            });
        }
        if (url.pathname === "/_chardb/migrations/shard") {
            const input = exactMigrationObject(body, ["migrationId", "shardId"]);
            if (typeof input.migrationId !== "string" || typeof input.shardId !== "string") {
                return migrationJsonError(400, "migrationId and shardId are required");
            }
            return Response.json({
                ok: true,
                shard: await catalog.migrateSchemaShard({ migrationId: input.migrationId, shardId: input.shardId }),
            });
        }
        if (url.pathname === "/_chardb/migrations/catalog") {
            const input = exactMigrationObject(body, ["migrationId", "version"]);
            if (typeof input.migrationId !== "string" || typeof input.version !== "number") {
                return migrationJsonError(400, "migrationId and version are required");
            }
            return Response.json({
                ok: true,
                state: await catalog.applyCatalogSchemaMigration({
                    migrationId: input.migrationId,
                    version: input.version,
                }),
            });
        }
        if (url.pathname === "/_chardb/migrations/complete") {
            const input = exactMigrationObject(body, ["migrationId"]);
            if (typeof input.migrationId !== "string") {
                return migrationJsonError(400, "migrationId is required");
            }
            return Response.json({
                ok: true,
                state: await catalog.completeSchemaMigration({ migrationId: input.migrationId }),
            });
        }
        return new Response("not found", { status: 404 });
    } catch (error) {
        if (error instanceof TypeError || error instanceof SyntaxError) {
            return migrationJsonError(400, error.message);
        }
        throw error;
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

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const correlationId = extractCorrelationId(request);
        const start = Date.now();
        let response: Response;
        try {
            if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
                response = await this.handleWebSocket(request);
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
        return decorateResponse(response, start, correlationId, SERVER_VERSION);
    }

    private async handleWebSocket(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const clientId = url.searchParams.get("clientId") ?? crypto.randomUUID();
        url.searchParams.set("clientId", clientId);
        const id = this.env.CDB_GATEWAY.idFromName(clientId.slice(0, 12));
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

    /**
     * Cron entry point. Cloudflare invokes this on every Cron Trigger; the
     * scheduled cron expression is set in Wrangler config. We run two pipelines
     * here:
     *
     *   1. PITR barrier tick — opens a fresh barrier on the Catalog, then fans
     *      out an `ackBarrier` RPC to every Cdb shard with its current op-log
     *      bookmark. Once every shard acks, the barrier is the durable PITR
     *      coordinate for that minute.
     *   2. User cron callbacks — `defineCron` registrations are dispatched here
     *      from the bundler-generated manifest (wired in a follow-up).
     */
    override async scheduled(event: ScheduledEvent): Promise<void> {
        await this.runBarrierTick();
        await this.runUserCrons(event);
    }

    /**
     * Dispatch any user `defineCron` whose expression matches `event.cron`. The
     * Cloudflare runtime sets `event.cron` to the same string the user wrote in
     * Wrangler config, so we use string-equality dispatch — translation between
     * cron grammars is the bundler's job, not ours.
     */
    private async runUserCrons(event: ScheduledEvent): Promise<void> {
        const cron = (event as { cron?: string }).cron;
        const matching = selectMatchingCrons(this.manifest(), cron);
        if (matching.length === 0) return;
        await Promise.all(
            matching.map(async c => {
                try {
                    await c.invoke();
                } catch (err) {
                    console.error(`[chardb] cron ${c.ref} failed`, err);
                }
            })
        );
    }

    private async runBarrierTick(): Promise<void> {
        const catalogId = this.env.CDB_CATALOG.idFromName("global");
        const catalog = this.env.CDB_CATALOG.get(catalogId) as unknown as {
            openBarrier(now: number): Promise<{ barrierId: string; expectedShards: readonly string[] }>;
            ackBarrier(args: { barrierId: string; shardId: string; bookmark: number }): Promise<{
                complete: boolean;
            }>;
        };
        const { barrierId, expectedShards } = await catalog.openBarrier(Date.now());
        await Promise.all(
            expectedShards.map(async shardId => {
                const id = this.env.CDB_SHARD.idFromName(shardId);
                const shard = this.env.CDB_SHARD.get(id) as unknown as {
                    barrierBookmark(): Promise<number>;
                };
                const bookmark = await shard.barrierBookmark();
                await catalog.ackBarrier({ barrierId, shardId, bookmark });
            })
        );
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
 * export { Cdb, Catalog, Gateway, BlobMeta, Resharder, GsiShard } from "chardb/server";
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
            // Walk the user's refs (mutations / queries / presence keys /
            // crons) plus the merged schema (ledger tables) for any
            // `__chardbRef`-marked exports.
            const merged: Record<string, unknown> = { ...input.refs };
            const schema = getSchema();
            if (schema && typeof schema === "object") {
                for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
                    if (!(k in merged)) merged[k] = v;
                }
            }
            built = manifestFromExports(merged);
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
 * Chardb's reserved prefixes (`/ws`, `/_chardb/*`) win over the auth
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
    return {
        async fetch(request, env, ctx): Promise<Response> {
            const resolvedEnv = withChardbLoopbacks(env, ctx);
            const url = new URL(request.url);
            if (isReserved(url.pathname)) {
                const instance = new Chardb(ctx, resolvedEnv);
                return instance.fetch(request);
            }
            if (authHandler && (url.pathname === authBase || url.pathname.startsWith(`${authBase}/`))) {
                return authHandler(request, resolvedEnv, ctx);
            }
            return app.fetch(request, resolvedEnv, ctx);
        },
    };
}
