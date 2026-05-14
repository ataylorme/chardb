/**
 * `defineChardb({ schema, auth })` returns a `WorkerEntrypoint` subclass.
 *
 * The class:
 *   - exposes a typed RPC surface for service-binding callers
 *     (`env.CDB.query.<table>.findMany(...)` via `wrangler types`); see
 *     https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
 *   - implements `fetch(req)` for the reserved-route prefix list:
 *       /ws         — hibernatable WebSocket to the Gateway DO (wired)
 *       /_chardb/*  — internal dashboard / admin routes (wired)
 *       /q /f /p /s — reserved for the live-query, file, presence, and
 *                     stream HTTP shims; currently return 501 with a
 *                     `not implemented in foundation` body. The prefix
 *                     is reserved so user routers won't shadow them
 *                     when these handlers land.
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
import { assertNoReservedTableShadow, type SynthesizedAuthSchema, synthesizeAuthSchema } from "../auth/synthesize.ts";
import type { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";
import { vshardOf } from "../vshard.ts";
import { type ChardbManifest, emptyManifest, manifestFromExports, routeMutation } from "./manifest.ts";
import { decorateResponse, extractCorrelationId, selectMatchingCrons } from "./observability_helpers.ts";

export {
    decorateResponse,
    extractCorrelationId,
    selectMatchingCrons,
} from "./observability_helpers.ts";

export interface ChardbEnv {
    readonly CDB?: unknown;
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
}

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

const RESERVED_PREFIXES = ["/q", "/ws", "/f", "/p", "/s", "/_chardb/"] as const;

function isReserved(path: string): boolean {
    for (const p of RESERVED_PREFIXES) if (path === p || path.startsWith(`${p}/`) || path.startsWith(p)) return true;
    return false;
}

const SERVER_VERSION = "0.1.0";

class ChardbEntrypoint extends WorkerEntrypoint<ChardbEnv> {
    /** Subclass overrides this via `defineChardb({ manifest })`. */
    protected manifest(): ChardbManifest {
        return emptyManifest();
    }

    /**
     * Resolve a mutation by ref, derive its partition vshard from `args` (if the
     * mutation declared `partitionKey`), and dispatch to the owning shard. The
     * Gateway DO calls into this RPC for `Up.mut` messages so the user's
     * mutation closure stays in the Worker isolate while the Gateway handles
     * fan-in/fan-out. Cross-binding contract: only structured-cloneable args
     * cross the boundary; the partition extractor is invoked here, not in the
     * Gateway.
     */
    async runMutation(input: {
        readonly ref: string;
        readonly args: RawJson;
        readonly mutId: string;
        /**
         * JWT-derived auth context the Gateway DO threaded into the
         * envelope. Forwarded to the shard `Cdb.mutate` call so the
         * user's mutation closure can read `ctx.auth` for tenant /
         * principal scoping and policy enforcement. `null` means the
         * inbound JWT was missing or unverified — the mutation is
         * dispatched as anonymous and policies decide whether that's
         * allowed.
         */
        readonly auth?: {
            readonly userId: string;
            readonly tenantId: string | null;
            readonly role: string | null;
            readonly claims: { readonly [k: string]: unknown };
        } | null;
    }): Promise<
        | { readonly ok: true; readonly vshard: number }
        | { readonly ok: false; readonly error: ReturnType<CdbError["toJSON"]> }
    > {
        return routeMutation(this.manifest(), { ref: input.ref, args: input.args }, vshardOf);
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const correlationId = extractCorrelationId(request);
        const start = Date.now();
        let response: Response;
        try {
            if (url.pathname.startsWith("/ws")) {
                response = await this.handleWebSocket(request);
            } else if (url.pathname.startsWith("/_chardb/")) {
                response = await this.handleDashboard(request);
            } else if (
                url.pathname.startsWith("/q") ||
                url.pathname.startsWith("/f") ||
                url.pathname.startsWith("/p") ||
                url.pathname.startsWith("/s")
            ) {
                response = await this.handleApi(request, url, correlationId);
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
        const id = this.env.CDB_GATEWAY.idFromName(clientId.slice(0, 12));
        return this.env.CDB_GATEWAY.get(id).fetch(request);
    }

    private async handleApi(_request: Request, _url: URL, correlationId: string): Promise<Response> {
        return new Response(JSON.stringify({ ok: false, error: "not implemented in foundation", correlationId }), {
            status: 501,
            headers: { "content-type": "application/json" },
        });
    }

    private async handleDashboard(request: Request): Promise<Response> {
        const dash = this.env.CDB_DASHBOARD;
        if (!dash) return new Response("dashboard not bound", { status: 500 });
        return dash.fetch(request);
    }

    /**
     * Cron entry point. Cloudflare invokes this on every Cron Trigger; the
     * scheduled cron expression is set in `wrangler.jsonc`. We run two pipelines
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
     * `wrangler.jsonc`, so we use string-equality dispatch — translation between
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
    // Lazy construction. `defineChardb` is typically called at module init
    // in the user's `worker.ts`, which often participates in an ESM
    // cycle with their schema module (`schema.ts` references `auth` from
    // `worker.ts`, `worker.ts` imports `* as domain from schema.ts`).
    // Iterating `schema` at this point would force every binding to
    // evaluate and crash with a TDZ on the partial namespace; deferring
    // until first call works against fully-evaluated modules.
    let cachedSchema: TSchema | null = null;
    let cachedManifest: ChardbManifest | null = null;
    let cachedPolicy: import("../colocation/types.ts").PolicyInput | undefined;
    function getSchema(): TSchema {
        if (cachedSchema !== null) return cachedSchema;
        cachedSchema = mergeAuthIntoSchema(input.schema, input.auth);
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
        cachedPolicy = {
            distributionRoots: input.policy?.distributionRoots ?? ["organization", "user"],
            strictMultiRoot: input.policy?.strictMultiRoot ?? false,
            requireRoot: input.policy?.requireRoot ?? false,
            allowMissingRoots: input.policy?.allowMissingRoots ?? false,
            overrides: input.policy?.overrides ?? {},
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

function mergeAuthIntoSchema<TSchema>(schema: TSchema, auth: DefineChardbAuth | undefined): TSchema {
    if (!auth) return schema;
    if (!schema || typeof schema !== "object") return schema;
    const userNames: string[] = [];
    for (const k of Object.keys(schema)) userNames.push(k);
    assertNoReservedTableShadow(userNames);
    // The runtime synthesizer accepts a `BetterAuthOptions` shape via its
    // `AuthOptionsInput<...>` constraint; we cast through `unknown` because
    // better-auth's `plugins?: BetterAuthPlugin[]` is mutable while the
    // input expects `readonly`.
    const synthesized = synthesizeAuthSchema(auth.options as unknown as Parameters<typeof synthesizeAuthSchema>[0]);
    // Bind the synthesized schema into the module-level auth runtime so the
    // chardb adapter (executing inside Cdb DOs) can resolve model→table
    // and partition rules without a separate registration step.
    bindAuthRuntime({
        schema: synthesized as unknown as SynthesizedAuthSchema,
        options: auth.options as { readonly [k: string]: unknown },
    });
    return { ...synthesized, ...schema } as TSchema;
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
 * Chardb's reserved prefixes (`/ws`, `/_chardb/*`, plus the prefix
 * list for the live-query / file / presence / stream HTTP shims) win
 * over the auth handler; everything else falls through to `app.fetch`.
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
    readonly authHandler?: (
        request: Request,
        env: ChardbEnv,
        ctx: ExecutionContext
    ) => Response | Promise<Response>;
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
            const url = new URL(request.url);
            if (isReserved(url.pathname)) {
                const instance = new Chardb(ctx, env);
                return instance.fetch(request);
            }
            if (authHandler && (url.pathname === authBase || url.pathname.startsWith(`${authBase}/`))) {
                return authHandler(request, env, ctx);
            }
            return app.fetch(request, env, ctx);
        },
    };
}
