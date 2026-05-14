/**
 * The locked `defineXxx` surface.
 *
 * Each helper takes a typed handler and returns a typed function reference.
 * The reference IS the wire identifier; there is no hidden runtime managing a
 * separate string registry. On the server, the helper's return value is a
 * function `(ctx, args) => result`. On the client, the same value is passed
 * to `useMutation(postMessage)` and the SDK reads `__chardbRef` to fill the
 * wire `ref` field. Renaming an export bumps the wire id; deleting it
 * removes it. Users never type a wire identifier.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { CdbErrorCode } from "../errors.ts";
import type { Brand, RawJson } from "../types.ts";
import type { CdbIntent } from "../wire.ts";
import { type PolicyDefinition, chardbPolicy } from "./policy.ts";
import { attachRef } from "./refs.ts";

/**
 * Type-level inference helper. `InferArgs<S>` resolves to the output
 * type of any `StandardSchemaV1` validator (zod, valibot, arktype,
 * typebox, drizzle-zod's `createInsertSchema`, …). With it
 * `defineMutation({ args: zod.object({...}), handler })` infers the
 * handler's `args` parameter from the validator — no inline type
 * annotation, no separate type alias.
 */
export type InferArgs<S> = S extends StandardSchemaV1<unknown, infer O>
    ? O extends Record<string, unknown>
        ? O
        : never
    : never;

export interface MutationCtx<TDb> {
    readonly db: TDb;
    readonly auth: AuthCtx;
}

export interface QueryCtx<TDb> {
    readonly db: TDb;
    readonly auth: AuthCtx;
}

/**
 * Authentication context handed to every mutation / query / policy
 * callback. Chardb populates this from the inbound JWT (better-auth
 * session shape):
 *
 *   - `userId`           ← `session.userId`
 *   - `tenantId`         ← `session.activeOrganizationId` (set by the
 *                          better-auth `organization` plugin's
 *                          `setActiveOrganization` route)
 *   - `role`             ← `member.role` for the active org; comma
 *                          separated for multi-role membership (matches
 *                          the better-auth convention from
 *                          `plugins/organization/permission.ts`)
 *   - `roles`            ← `role.split(",")` for convenience
 *   - `activeTeamId`     ← `session.activeTeamId` when the teams sub-
 *                          feature is enabled
 *   - `claims`           ← every remaining session field, opaque
 *
 * The shape mirrors better-auth's session so policies can be written
 * against the same vocabulary the rest of the app uses (no chardb-
 * specific auth model to learn).
 */
export interface AuthCtx {
    readonly userId: string;
    readonly tenantId?: string | undefined;
    readonly role?: string | undefined;
    readonly roles?: readonly string[] | undefined;
    readonly activeTeamId?: string | undefined;
    /** Remaining session fields the user added via better-auth's custom-session / additional-fields plugins. */
    readonly claims: { readonly [k: string]: RawJson };
}

/**
 * Idempotency horizon brand. `24h` is the sole branded TTL surfaced today;
 * the brand is a user-facing signal of expected retry horizon for type
 * ergonomics, not a knob that weakens the per-shard op-log floor.
 */
export type IdempotencyTtl = "24h";
export type IdempotentMutation<F, _Ttl extends IdempotencyTtl> = F & {
    readonly __chardbIdempotencyTtl: _Ttl;
};

export interface MutationOptions<TArgs = unknown> {
    readonly idempotencyTtl?: IdempotencyTtl;
    /** Hint to the type system + scheduler that this mutation only writes a single partition. */
    readonly singlePartition?: boolean;
    /** When true, errors are surfaced as `MutResult.ok=false` (not retryable). */
    readonly returnUserErrors?: boolean;
    /**
     * Extracts the partition key from `args`. Required for `singlePartition: true`
     * mutations so the Gateway can derive a vshard without invoking the user
     * closure. Returning `undefined` defers to a deterministic fallback (xxhash
     * of stable JSON) and emits `CDB_CROSS_PARTITION` if the runtime detects a
     * cross-shard write.
     */
    readonly partitionKey?: (args: TArgs) => string | number | bigint | undefined;
}

export type MutationFn<TDb, TArgs, TResult> = ((ctx: MutationCtx<TDb>, args: TArgs) => Promise<TResult>) & {
    readonly __chardbKind: "mutation";
    readonly __chardbRef: Brand<string, "ChardbRef">;
};

export type QueryFn<TDb, TArgs, TResult> = ((ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>) & {
    readonly __chardbKind: "query";
    readonly __chardbRef: Brand<string, "ChardbRef">;
    /**
     * Wire-shape `CdbIntent` extractor. Stamped only when the user's
     * `defineQuery({ intent: (args) => … })` declared one. The React
     * `useQuery(handle, args)` overload reads this to produce the
     * subscription intent without forcing the user to hand-write a
     * literal that mirrors the server handler.
     */
    readonly __chardbIntent?: (args: TArgs) => CdbIntent;
};

export type CronFn = (() => void) & {
    readonly __chardbKind: "cron";
    readonly __chardbRef: Brand<string, "ChardbRef">;
    readonly __chardbCron: string;
};

export type StreamFn<TDb, TArgs, TChunk, TResult> = ((
    ctx: MutationCtx<TDb>,
    args: TArgs
) => AsyncGenerator<TChunk, TResult, void>) & {
    readonly __chardbKind: "stream";
    readonly __chardbRef: Brand<string, "ChardbRef">;
};

export type GsiHandle<TTable, TCols extends readonly string[]> = {
    readonly __chardbKind: "gsi";
    readonly __chardbRef: Brand<string, "ChardbRef">;
    readonly table: TTable;
    readonly columns: TCols;
    readonly strict: boolean;
};

export type PresenceKey<TState> = ((scope: string) => {
    readonly __chardbKind: "presenceKey";
    readonly __chardbRef: Brand<string, "ChardbRef">;
    readonly key: string;
    readonly __chardbStateType: TState;
}) & {
    readonly __chardbKind: "presenceKey";
    readonly __chardbRef: Brand<string, "ChardbRef">;
};

/**
 * Object form of `defineMutation`. The `args` field accepts any
 * `StandardSchemaV1` validator (zod, valibot, arktype, typebox,
 * drizzle-zod, …); chardb infers `TArgs` from it so the handler gets
 * fully typed args without an inline annotation. The validator's
 * `.validate(unknown)` is invoked at the wire boundary to reject
 * malformed payloads before the mutation closure runs.
 */
/**
 * Extract the field names of `TArgs` whose value type is a valid
 * partition key (string / number / bigint). Used so the config-form
 * `partitionKey: "organizationId"` shorthand is typechecked against
 * the args schema.
 */
type PartitionKeyOf<TArgs> = {
    readonly [K in keyof TArgs]: TArgs[K] extends string | number | bigint ? K : never;
}[keyof TArgs] &
    string;

export interface MutationConfig<TDb, TArgs extends Record<string, unknown>, TResult> {
    readonly args?: StandardSchemaV1<unknown, TArgs>;
    readonly handler: (ctx: MutationCtx<TDb>, args: TArgs) => Promise<TResult>;
    /**
     * Either a field name (typechecked against the args schema) or an
     * arbitrary extractor closure.
     */
    readonly partitionKey?: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
    readonly singlePartition?: boolean;
    readonly idempotencyTtl?: IdempotencyTtl;
    readonly returnUserErrors?: boolean;
}

/**
 * Mutation handler. The body runs inside the partition-owning `Cdb` shard DO,
 * inside `transactionSync`, with the full Drizzle `db.transaction(async tx)`
 * surface available against `durable-sqlite`. This is the single execution
 * venue for interactive transactions; the client-side `db.batch` and `db.tx`
 * APIs serialize closure-only statements onto the same shard.
 *
 * Two call shapes — both fully inferred:
 *
 * ```ts
 * // 1. Config object with `args` validator → `TArgs` is the
 * //    validator's output type, the handler is fully typed.
 * defineMutation({
 *   args: zod.object({ id: zod.string(), body: zod.string() }),
 *   handler: async (ctx, args) => { … },
 *   partitionKey: (a) => a.id,
 * });
 *
 * // 2. Positional form with an inline annotation on the handler.
 * //    Use when you don't want a runtime validator.
 * defineMutation(async (ctx, args: { id: string; body: string }) => { … }, {
 *   partitionKey: (a) => a.id,
 * });
 * ```
 */
export function defineMutation<TDb, TArgs extends Record<string, unknown>, TResult>(
    config: MutationConfig<TDb, TArgs, TResult>
): MutationFn<TDb, TArgs, TResult>;
export function defineMutation<TDb, TArgs extends Record<string, unknown>, TResult>(
    handler: (ctx: MutationCtx<TDb>, args: TArgs) => Promise<TResult>,
    options?: MutationOptions<TArgs>
): MutationFn<TDb, TArgs, TResult>;
export function defineMutation<TDb, TArgs extends Record<string, unknown>, TResult>(
    configOrHandler: MutationConfig<TDb, TArgs, TResult> | ((ctx: MutationCtx<TDb>, args: TArgs) => Promise<TResult>),
    optionsArg?: MutationOptions<TArgs>
): MutationFn<TDb, TArgs, TResult> {
    const isConfig = typeof configOrHandler === "object";
    const handler = isConfig ? configOrHandler.handler : configOrHandler;
    const validator: StandardSchemaV1<unknown, TArgs> | undefined = isConfig ? configOrHandler.args : undefined;
    const partitionKey = isConfig ? configOrHandler.partitionKey : optionsArg?.partitionKey;
    const partitionKeyFn: ((args: TArgs) => string | number | bigint | undefined) | undefined =
        typeof partitionKey === "string"
            ? (args: TArgs) => {
                  const v = (args as Record<string, unknown>)[partitionKey];
                  return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? v : undefined;
              }
            : partitionKey;
    // Chardb's pragmatic defaults for the config-object form (Phase 1 of
    // the "just makes sense" cluster):
    //   - declaring `partitionKey` implies `singlePartition: true` —
    //     extracting a key only makes sense when the mutation lives in
    //     exactly one partition; the redundant flag was pure ceremony.
    //   - `singlePartition: true` implies `idempotencyTtl: "24h"` —
    //     partition-owning mutations are retry-safe via the op-log dedup
    //     wrapper; the 24h horizon matches what every SaaS app wants.
    //   - explicit values always win (a user passing `singlePartition:
    //     false` alongside a partitionKey gets `false`).
    const inferredSinglePartition = isConfig
        ? (configOrHandler.singlePartition ?? configOrHandler.partitionKey !== undefined)
        : optionsArg?.singlePartition;
    const inferredIdempotencyTtl = isConfig
        ? (configOrHandler.idempotencyTtl ?? (inferredSinglePartition ? ("24h" as const) : undefined))
        : optionsArg?.idempotencyTtl;
    const options: MutationOptions<TArgs> | undefined = isConfig
        ? {
              ...(partitionKeyFn ? { partitionKey: partitionKeyFn } : {}),
              ...(inferredSinglePartition ? { singlePartition: inferredSinglePartition } : {}),
              ...(inferredIdempotencyTtl ? { idempotencyTtl: inferredIdempotencyTtl } : {}),
              ...(configOrHandler.returnUserErrors !== undefined
                  ? { returnUserErrors: configOrHandler.returnUserErrors }
                  : {}),
          }
        : optionsArg;
    const fn = (async (ctx: MutationCtx<TDb>, args: TArgs) => {
        const validated = validator ? await runValidator(validator, args) : args;
        return handler(ctx, validated);
    }) as MutationFn<TDb, TArgs, TResult>;
    // Preserve the handler's identity for `autoRef` (dev/test path before the
    // Vite plugin rewrites refs). Without this every wrapper collapses to
    // `Function.name === "fn"` and the manifest deduplicates everything.
    if (handler.name && handler.name !== "fn") {
        Object.defineProperty(fn, "name", { value: handler.name, configurable: true });
    }
    if (options?.idempotencyTtl) {
        Object.defineProperty(fn, "__chardbIdempotencyTtl", {
            value: options.idempotencyTtl,
            enumerable: false,
        });
    }
    if (options?.partitionKey) {
        Object.defineProperty(fn, "__chardbPartitionKey", {
            value: options.partitionKey,
            enumerable: false,
        });
    }
    if (options?.singlePartition) {
        Object.defineProperty(fn, "__chardbSinglePartition", { value: true, enumerable: false });
    }
    return attachRef(fn, "mutation") as MutationFn<TDb, TArgs, TResult>;
}

/**
 * Object form of `defineQuery`. Same validator-driven inference as
 * `MutationConfig`.
 */
export interface QueryConfig<TDb, TArgs extends Record<string, unknown>, TResult> {
    readonly args?: StandardSchemaV1<unknown, TArgs>;
    readonly handler: (ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>;
    /**
     * Optional `CdbIntent` extractor. When provided, the returned
     * `QueryFn` carries `__chardbIntent` so the React `useQuery(handle,
     * args)` overload can subscribe without the user hand-writing a
     * literal `CdbIntent` that mirrors `handler`'s filter shape.
     *
     * The intent the user returns must be wire-equivalent to what the
     * Drizzle expression in `handler` would compile to via the
     * `StaticIntentExtractor` — partition values, intervals, and table
     * list. That equivalence is the user's responsibility (no auto-
     * extraction); the `defineQuery({ intent })` callback is the
     * one place chardb requires the correspondence to be spelled out.
     */
    readonly intent?: (args: TArgs) => CdbIntent;
}

/**
 * Read handler. Body executes against a read-only `Cdb` shard view; live-query
 * fan-in shares the same shape. Accepts either a config object with an
 * `args:` validator (inference) or a bare handler with an inline
 * annotation.
 */
export function defineQuery<TDb, TArgs extends Record<string, unknown>, TResult>(
    config: QueryConfig<TDb, TArgs, TResult>
): QueryFn<TDb, TArgs, TResult>;
export function defineQuery<TDb, TArgs extends Record<string, unknown>, TResult>(
    handler: (ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>
): QueryFn<TDb, TArgs, TResult>;
export function defineQuery<TDb, TArgs extends Record<string, unknown>, TResult>(
    configOrHandler: QueryConfig<TDb, TArgs, TResult> | ((ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>)
): QueryFn<TDb, TArgs, TResult> {
    const isConfig = typeof configOrHandler === "object";
    const handler = isConfig ? configOrHandler.handler : configOrHandler;
    const validator: StandardSchemaV1<unknown, TArgs> | undefined = isConfig ? configOrHandler.args : undefined;
    const intent = isConfig ? configOrHandler.intent : undefined;
    const fn = (async (ctx: QueryCtx<TDb>, args: TArgs) => {
        const validated = validator ? await runValidator(validator, args) : args;
        return handler(ctx, validated);
    }) as QueryFn<TDb, TArgs, TResult>;
    if (handler.name && handler.name !== "fn") {
        Object.defineProperty(fn, "name", { value: handler.name, configurable: true });
    }
    if (intent) {
        Object.defineProperty(fn, "__chardbIntent", {
            value: intent,
            enumerable: false,
            configurable: false,
        });
    }
    return attachRef(fn, "query") as QueryFn<TDb, TArgs, TResult>;
}

/**
 * Run a `StandardSchemaV1` validator over an unknown payload. Throws
 * `TypeError` with the first issue's path + message on failure, so the
 * Gateway sees a 4xx-flavoured boundary error rather than a panic deep
 * inside the user's mutation closure.
 */
async function runValidator<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<T> {
    const result = await schema["~standard"].validate(value);
    if (result.issues) {
        const first = result.issues[0];
        const path = first?.path
            ? Array.from(first.path)
                  .map(p => (typeof p === "object" && "key" in p ? String(p.key) : String(p)))
                  .join(".")
            : "(root)";
        throw new TypeError(`chardb: args validation failed at ${path}: ${first?.message ?? "invalid"}`);
    }
    return result.value;
}

/**
 * Recurring schedule. The cron expression follows the Cloudflare Workers Cron
 * Triggers grammar
 * (https://developers.cloudflare.com/workers/configuration/cron-triggers/).
 * The wire id assigned by the bundler becomes the deterministic
 * `cronExportId` baked into `mutId = sha256(cronExportId ||
 * occurrenceMinute || canonicalArgs)` — backfills and replays remain
 * idempotent through the per-shard op-log dedup.
 */
export function defineCron<TDb, TArgs extends Record<string, unknown>, TResult>(
    cronExpr: string,
    mutationOrHandler: MutationFn<TDb, TArgs, TResult> | ((ctx: MutationCtx<TDb>, args: TArgs) => Promise<TResult>),
    args: TArgs = {} as TArgs
): CronFn {
    // Whether the target was produced by `defineMutation` — informs whether
    // op-log idempotency applies. The runtime entrypoint inspects this flag
    // when the cron fires; non-mutation handlers run inline in the Worker
    // isolate without per-shard transactional guarantees.
    const isMutation = typeof (mutationOrHandler as { __chardbRef?: unknown }).__chardbRef === "string";
    const invoke = async (): Promise<void> => {
        try {
            // The cron path has no shard ctx of its own — for plain handlers we
            // pass an undefined ctx; users that need shard-bound semantics must
            // wrap the work in `defineMutation` so the runtime routes it to a
            // partition. Mutation-targets here are invoked directly so the
            // entrypoint can later swap in a real shard-routed dispatch.
            const ctx = undefined as unknown as MutationCtx<TDb>;
            const target = mutationOrHandler as (ctx: MutationCtx<TDb>, args: TArgs) => Promise<TResult>;
            await target(ctx, args);
        } catch (err) {
            console.error(`[chardb] cron handler ${cronExpr} failed`, err);
        }
    };
    const fn = Object.assign(invoke, {
        __chardbCron: cronExpr,
        __chardbCronIsMutation: isMutation,
    }) as unknown as CronFn;
    return attachRef(fn, "cron") as CronFn;
}

/**
 * Stream handler. The body runs inside the partition-owning shard; intermediate
 * chunks are best-effort over WebSocket, while the final state is durably
 * written via the wrapping op-log row so retries through the same `mutId`
 * return the cached result without re-streaming.
 */
export function defineStream<TDb, TArgs extends Record<string, unknown>, TChunk, TResult>(
    handler: (ctx: MutationCtx<TDb>, args: TArgs) => AsyncGenerator<TChunk, TResult, void>
): StreamFn<TDb, TArgs, TChunk, TResult> {
    const fn = ((ctx: MutationCtx<TDb>, args: TArgs) => handler(ctx, args)) as StreamFn<TDb, TArgs, TChunk, TResult>;
    return attachRef(fn, "stream") as StreamFn<TDb, TArgs, TChunk, TResult>;
}

/**
 * Eventually-consistent secondary index. A `defineGsi` declaration provisions
 * a fleet of `GsiShard` DOs hash-partitioned on the indexed columns; every
 * base-table write tail-captures into a queue that fans out to the GSI shards.
 * `strict: true` raises `CDB_GSI_STRICT_REQUIRES_2PC` until cross-shard 2PC
 * lights up.
 */
export function defineGsi<TTable, TCols extends readonly string[]>(
    table: TTable,
    columns: TCols,
    options: { readonly strict?: boolean } = {}
): GsiHandle<TTable, TCols> {
    const handle = {
        table,
        columns,
        strict: options.strict ?? false,
    };
    return attachRef(handle as object, "gsi") as unknown as GsiHandle<TTable, TCols>;
}

/**
 * Optionally-typed presence key. Presence rides the same hibernated WebSocket
 * as live queries but bypasses the IntervalMap pipeline; states are
 * best-effort, ephemeral, and capped per key.
 */
export function definePresenceKey<TState>(prefix: string): PresenceKey<TState> {
    const factory = ((scope: string) => {
        const key = `${prefix}:${scope}`;
        const handle = {
            key,
            __chardbStateType: undefined as unknown as TState,
        };
        return attachRef(handle, "presenceKey", `presenceKey#${prefix}:${scope}`);
    }) as PresenceKey<TState>;
    return attachRef(
        factory as unknown as object,
        "presenceKey",
        `presenceKey#${prefix}`
    ) as unknown as PresenceKey<TState>;
}

/** Result kept transient on a mutation outcome. */
export interface UserError {
    readonly code: CdbErrorCode;
    readonly message: string;
}

/**
 * The `db` instance handed to mutation / query closures. Parameterised
 * over the merged schema record (auth tables + the user's domain tables);
 * `createApi<typeof schema>()` binds this for you so call sites never
 * have to spell out a `BaseSQLiteDatabase<...>` alias.
 */
export type ChardbDb<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>;

/**
 * Typed `mutation` / `query` factories bound to a concrete schema. The
 * args type for each handler is inferred from the inline annotation
 * (`async (ctx, args: { … }) => { … }`) and the result from the return
 * value — no `defineMutation<Db, Args, Result>` explicit-generic
 * triplet, no `& { [k: string]: RawJson }` intersection.
 */
export interface ChardbApi<TSchema extends Record<string, unknown>> {
    mutation<TArgs extends Record<string, unknown>, TResult>(
        config: MutationConfig<ChardbDb<TSchema>, TArgs, TResult>
    ): MutationFn<ChardbDb<TSchema>, TArgs, TResult>;
    mutation<TArgs extends Record<string, unknown>, TResult>(
        handler: (ctx: MutationCtx<ChardbDb<TSchema>>, args: TArgs) => Promise<TResult>,
        options?: MutationOptions<TArgs>
    ): MutationFn<ChardbDb<TSchema>, TArgs, TResult>;
    query<TArgs extends Record<string, unknown>, TResult>(
        config: QueryConfig<ChardbDb<TSchema>, TArgs, TResult>
    ): QueryFn<ChardbDb<TSchema>, TArgs, TResult>;
    query<TArgs extends Record<string, unknown>, TResult>(
        handler: (ctx: QueryCtx<ChardbDb<TSchema>>, args: TArgs) => Promise<TResult>
    ): QueryFn<ChardbDb<TSchema>, TArgs, TResult>;
    presence<TState>(prefix: string): PresenceKey<TState>;
    /**
     * Row-level policy with `TRow` inferred from the `TTable` generic's
     * Drizzle `$inferSelect`. Pass the table at the type level only —
     * `api.policy<typeof messages>("name", { using, usingSql, … })` —
     * so the call site doesn't have to read a table value at module init
     * (which would force ESM cycle evaluation between `worker.ts` and
     * `schema.ts`).
     */
    policy<TTable>(
        name: string,
        def: Omit<PolicyDefinition<TTable, RowFromTable<TTable>>, "name">
    ): PolicyDefinition<TTable, RowFromTable<TTable>>;
}

type RowFromTable<TTable> = TTable extends { readonly $inferSelect: infer R } ? R : unknown;

/**
 * Build a schema-bound `{ mutation, query, presence }` object. The
 * user's `api.ts` calls this once with their schema namespace and the
 * synthesized auth tables; every subsequent definition reuses the bound
 * `TDb`, so the inline call sites stay declaration-free.
 *
 * ```ts
 * import { auth } from "./worker.ts";
 * import * as schema from "./schema.ts";
 * import { createApi } from "chardb/server";
 *
 * const api = createApi({ ...auth, ...schema });
 *
 * export const postMessage = api.mutation(
 *   async (ctx, args: { organizationId: string; body: string; … }) => { … },
 *   { singlePartition: true, partitionKey: (a) => a.organizationId },
 * );
 * ```
 *
 * The `chardb/react` hooks derive their `TArgs` / `TResult` types from
 * the returned function via `Parameters<typeof postMessage>[1]` and
 * `Awaited<ReturnType<typeof postMessage>>`, so the user never exports a
 * separate `*Args` type alias for the wire shape.
 */
export function createApi<const TSchema extends Record<string, unknown>>(_schema?: TSchema): ChardbApi<TSchema> {
    return {
        mutation: defineMutation as ChardbApi<TSchema>["mutation"],
        query: defineQuery as ChardbApi<TSchema>["query"],
        presence: definePresenceKey,
        // `policy` is structurally identical to the standalone `chardbPolicy`
        // — the method exists on `api` for symmetry with `api.mutation` /
        // `api.query`, but it's a type-only sugar (TTable is a generic, not
        // a value arg) so the call site never reads a table value at module
        // init and the ESM cycle stays benign.
        policy: chardbPolicy as ChardbApi<TSchema>["policy"],
    };
}

/**
 * Ready-to-use `{ mutation, query, presence, policy }` factory bound
 * to an open schema. Drops the `createApi<typeof auth & typeof
 * domain>()` line every `api.ts` used to start with — the user just
 * does `import { api } from "chardb/server"` and writes `api.mutation
 * ({...})` directly. Calls like `ctx.db.select().from(messages)`
 * still typecheck because Drizzle's `.from(table)` reads the table's
 * own row type rather than the bound schema generic.
 *
 * For full Drizzle "relational queries" typing (`ctx.db.query
 * .messages.findMany()`), users can still write `const api =
 * createApi<typeof schema>()` — the local-binding path stays public.
 */
export const api: ChardbApi<Record<string, unknown>> = createApi();
