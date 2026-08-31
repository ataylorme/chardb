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
import { CdbError, type CdbErrorCode } from "../errors.ts";
import type { Brand, RawJson } from "../types.ts";
import type { VectorMutationApi } from "../vector.ts";
import type { CdbIntent } from "../wire.ts";
import { wrapDb } from "./cdb-db-proxy.ts";
import { type PolicyDefinition, chardbPolicy } from "./policy.ts";
import { attachRef } from "./refs.ts";
import { type RegisteredQueryPlan, compileRegisteredQueryPlan } from "./registered-query-plan.ts";

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
    /** Transaction-bound Vectorize writes for organization vector columns. */
    readonly vector: VectorMutationApi;
}

export interface QueryCtx<TDb> {
    readonly db: TDb;
    readonly auth: AuthCtx;
}

/**
 * Authentication context handed to every mutation, query, and policy
 * callback. For organization mutations, Gateway takes only the verified JWT
 * subject and resolves the remaining fields from Catalog membership:
 *
 *   - `userId`           ← signature-verified JWT subject
 *   - `tenantId`         ← the declared mutation partition key
 *   - `role`             ← `member.role` for that org; comma
 *                          separated for multi-role membership (matches
 *                          the better-auth convention from
 *                          `plugins/organization/permission.ts`)
 *   - `roles`            ← `role.split(",")` for convenience
 *   - `authEpochs`       ← current Catalog global, tenant, and principal epochs
 *   - `claims`           ← empty on this path; JWT tenant and role claims are ignored
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
    readonly authEpochs?:
        | {
              readonly global: number;
              readonly tenant: number;
              readonly principal: number;
          }
        | undefined;
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
export type MutationAuthority = "organization" | "user" | "global";
export type IdempotentMutation<F, _Ttl extends IdempotencyTtl> = F & {
    readonly __chardbIdempotencyTtl: _Ttl;
};

interface MutationOptionsBase<TArgs = unknown> {
    /** Stable wire ref shared by browser and Worker builds. Must contain `#`. */
    readonly ref?: string;
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

export type MutationOptions<TArgs = unknown> =
    | (MutationOptionsBase<TArgs> & {
          /** Opens dispatch only after Catalog confirms membership in the extracted organization partition. */
          readonly authority: "organization";
          readonly ref: string;
      })
    | (MutationOptionsBase<TArgs> & {
          /** Opens dispatch only when the extracted partition is the verified JWT subject. */
          readonly authority: "user";
          readonly ref: string;
          readonly partitionKey: (args: TArgs) => string | number | bigint | undefined;
      })
    | (MutationOptionsBase<TArgs> & {
          /** Places the mutation in an explicit application-wide partition. */
          readonly authority: "global";
          readonly ref: string;
          readonly partitionKey: (args: TArgs) => string | number | bigint | undefined;
      })
    | (MutationOptionsBase<TArgs> & { readonly authority?: undefined });

export type MutationFn<TDb, TArgs, TResult> = ((ctx: MutationCtx<TDb>, args: TArgs) => TResult) & {
    readonly __chardbKind: "mutation";
    readonly __chardbRef: Brand<string, "ChardbRef">;
};

export type QueryFn<TDb, TArgs, TResult> = ((ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>) & {
    readonly __chardbKind: "query";
    readonly __chardbRef: Brand<string, "ChardbRef">;
    readonly __chardbAuthority?: MutationAuthority;
    readonly __chardbPartitionKey?: (args: TArgs) => string | number | bigint | undefined;
    readonly __chardbInvokeValidated?: (ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>;
    /** Server-only validator used before routing intent extraction. */
    readonly __chardbValidateArgs?: (args: unknown) => Promise<TArgs>;
    /**
     * Server-owned `CdbIntent` extractor. The configured Gateway reads this
     * from its local manifest; clients send only the query ref and raw args.
     */
    readonly __chardbIntent?: (args: TArgs) => CdbIntent;
    /** Runtime-compiled plan for the single-source Drizzle query form. */
    readonly __chardbCompilePlan?: (args: TArgs) => RegisteredQueryPlan;
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

interface MutationConfigBase<TDb, TArgs extends Record<string, unknown>, TResult> {
    /** Stable wire ref shared by browser and Worker builds. Must contain `#`. */
    readonly ref?: string;
    readonly args?: StandardSchemaV1<unknown, TArgs>;
    readonly handler: (ctx: MutationCtx<TDb>, args: TArgs) => TResult;
    /**
     * Either a field name (typechecked against the args schema) or an
     * arbitrary extractor closure.
     */
    readonly partitionKey?: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
    readonly singlePartition?: boolean;
    readonly idempotencyTtl?: IdempotencyTtl;
    readonly returnUserErrors?: boolean;
}

export type MutationConfig<TDb, TArgs extends Record<string, unknown>, TResult> =
    | (MutationConfigBase<TDb, TArgs, TResult> & {
          /** Opens dispatch only after Catalog confirms membership in the extracted organization partition. */
          readonly authority: "organization";
          readonly ref: string;
      })
    | (MutationConfigBase<TDb, TArgs, TResult> & {
          /** The extracted partition must equal the verified JWT subject. */
          readonly authority: "user";
          readonly ref: string;
          readonly partitionKey: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
      })
    | (MutationConfigBase<TDb, TArgs, TResult> & {
          /** Places the mutation in an explicit application-wide partition. */
          readonly authority: "global";
          readonly ref: string;
          readonly partitionKey: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
      })
    | (MutationConfigBase<TDb, TArgs, TResult> & { readonly authority?: undefined });

/**
 * Mutation handler. The body runs inside the partition-owning `Cdb` shard DO,
 * inside `transactionSync`, using Drizzle's synchronous `durable-sqlite`
 * driver. A mutation handler must not be `async` and must not return a
 * thenable: Durable Object SQLite cannot keep a transaction open across an
 * `await` boundary.
 *
 * Two call shapes — both fully inferred:
 *
 * ```ts
 * // 1. Config object with `args` validator → `TArgs` is the
 * //    validator's output type, the handler is fully typed.
 * defineMutation({
 *   args: zod.object({ id: zod.string(), body: zod.string() }),
 *   handler: (ctx, args) => { … },
 *   partitionKey: (a) => a.id,
 * });
 *
 * // 2. Positional form with an inline annotation on the handler.
 * //    Use when you don't want a runtime validator.
 * defineMutation((ctx, args: { id: string; body: string }) => { … }, {
 *   partitionKey: (a) => a.id,
 * });
 * ```
 */
export function defineMutation<TDb, TArgs extends Record<string, unknown>, TResult>(
    config: MutationConfig<TDb, TArgs, TResult>
): MutationFn<TDb, TArgs, TResult>;
export function defineMutation<TDb, TArgs extends Record<string, unknown>, TResult>(
    handler: (ctx: MutationCtx<TDb>, args: TArgs) => TResult,
    options?: MutationOptions<TArgs>
): MutationFn<TDb, TArgs, TResult>;
export function defineMutation<TDb, TArgs extends Record<string, unknown>, TResult>(
    configOrHandler: MutationConfig<TDb, TArgs, TResult> | ((ctx: MutationCtx<TDb>, args: TArgs) => TResult),
    optionsArg?: MutationOptions<TArgs>
): MutationFn<TDb, TArgs, TResult> {
    const isConfig = typeof configOrHandler === "object";
    const handler = isConfig ? configOrHandler.handler : configOrHandler;
    const validator: StandardSchemaV1<unknown, TArgs> | undefined = isConfig ? configOrHandler.args : undefined;
    const explicitRef = isConfig ? configOrHandler.ref : optionsArg?.ref;
    if (explicitRef !== undefined && (explicitRef.length === 0 || !explicitRef.includes("#"))) {
        throw new TypeError("chardb: mutation ref must be a nonempty string containing #");
    }
    const authority = isConfig ? configOrHandler.authority : optionsArg?.authority;
    if (authority !== undefined && explicitRef === undefined) {
        throw new TypeError(`chardb: ${authority} mutations require an explicit ref`);
    }
    const partitionKey = isConfig ? configOrHandler.partitionKey : optionsArg?.partitionKey;
    const partitionKeyFn: ((args: TArgs) => string | number | bigint | undefined) | undefined =
        typeof partitionKey === "string"
            ? (args: TArgs) => {
                  const v = (args as Record<string, unknown>)[partitionKey];
                  return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? v : undefined;
              }
            : partitionKey;
    if (authority === "global" && partitionKeyFn === undefined) {
        throw new TypeError("chardb: global mutations require an explicit partitionKey extractor");
    }
    const invokeValidated = (ctx: MutationCtx<TDb>, args: TArgs): TResult => {
        const wrappedCtx = wrapCtxDb(ctx) as MutationCtx<TDb>;
        return handler(wrappedCtx, args);
    };
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
    const options = (
        isConfig
            ? {
                  ...(partitionKeyFn ? { partitionKey: partitionKeyFn } : {}),
                  ...(authority ? { authority } : {}),
                  ...(inferredSinglePartition ? { singlePartition: inferredSinglePartition } : {}),
                  ...(inferredIdempotencyTtl ? { idempotencyTtl: inferredIdempotencyTtl } : {}),
                  ...(configOrHandler.returnUserErrors !== undefined
                      ? { returnUserErrors: configOrHandler.returnUserErrors }
                      : {}),
              }
            : optionsArg
    ) as MutationOptions<TArgs> | undefined;
    const fn = ((ctx: MutationCtx<TDb>, args: TArgs) => {
        const validated = validator ? runValidatorSync(validator, args) : args;
        return invokeValidated(ctx, validated);
    }) as MutationFn<TDb, TArgs, TResult>;
    // Preserve the handler's identity for `autoRef` when no explicit ref is
    // configured. Without this every wrapper collapses to
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
    if (options?.authority) {
        Object.defineProperty(fn, "__chardbAuthority", {
            value: options.authority,
            enumerable: false,
        });
    }
    if (options?.singlePartition) {
        Object.defineProperty(fn, "__chardbSinglePartition", { value: true, enumerable: false });
    }
    if (explicitRef) {
        Object.defineProperty(fn, "__chardbExplicitRef", { value: true, enumerable: false });
    }
    Object.defineProperty(fn, "__chardbInvokeValidated", {
        value: invokeValidated,
        enumerable: false,
    });
    if (validator) {
        Object.defineProperty(fn, "__chardbValidateArgs", {
            value: (args: unknown) => runValidatorSync(validator, args),
            enumerable: false,
        });
    }
    return attachRef(fn, "mutation", explicitRef) as MutationFn<TDb, TArgs, TResult>;
}

function runValidatorSync<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): T {
    const result = schema["~standard"].validate(value);
    if (result instanceof Promise) {
        throw new TypeError("chardb: mutation argument validators must be synchronous");
    }
    return valueFromValidationResult(result);
}

/**
 * Object form of `defineQuery`. Same validator-driven inference as
 * `MutationConfig`.
 */
interface QueryConfigBase<TDb, TArgs extends Record<string, unknown>, TResult> {
    /** Stable wire ref shared by browser and Worker builds. Must contain `#`. */
    readonly ref?: string;
    readonly args?: StandardSchemaV1<unknown, TArgs>;
    readonly handler: (ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>;
    readonly partitionKey?: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
    /**
     * Optional server-owned `CdbIntent` extractor. When provided, the
     * returned `QueryFn` carries `__chardbIntent` for the configured Gateway
     * to resolve subscription routing from trusted code.
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

export type QueryConfig<TDb, TArgs extends Record<string, unknown>, TResult> =
    | (QueryConfigBase<TDb, TArgs, TResult> & {
          readonly authority: "organization";
          readonly ref: string;
          readonly partitionKey: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
          readonly intent: (args: TArgs) => CdbIntent;
      })
    | (QueryConfigBase<TDb, TArgs, TResult> & {
          readonly authority: "user";
          readonly ref: string;
          readonly partitionKey: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
          readonly intent: (args: TArgs) => CdbIntent;
      })
    | (QueryConfigBase<TDb, TArgs, TResult> & {
          readonly authority: "global";
          readonly ref: string;
          readonly partitionKey: PartitionKeyOf<TArgs> | ((args: TArgs) => string | number | bigint | undefined);
          readonly intent: (args: TArgs) => CdbIntent;
      })
    | (QueryConfigBase<TDb, TArgs, TResult> & { readonly authority?: undefined });

export interface PlannedQueryConfig<TDb, TArgs extends Record<string, unknown>, TBuilder extends PlannedQueryBuilder> {
    /** Stable across Wrangler, Vite, browser, Gateway, and Cdb builds. */
    readonly ref: string;
    readonly args?: StandardSchemaV1<unknown, TArgs>;
    /** Pure synchronous builder. Chardb compiles it before Catalog and executes it inside Cdb. */
    readonly query: (db: TDb, args: TArgs) => TBuilder;
    readonly handler?: never;
    readonly authority?: never;
    readonly partitionKey?: never;
    readonly intent?: never;
}

export interface PlannedQueryBuilder {
    readonly _: { readonly result: unknown };
}

type PlannedQueryResult<TBuilder extends PlannedQueryBuilder> = TBuilder["_"]["result"];

/**
 * Read handler. Body executes against a read-only `Cdb` shard view; live-query
 * fan-in shares the same shape. Accepts either a config object with an
 * `args:` validator (inference) or a bare handler with an inline
 * annotation.
 */
export function defineQuery<TDb, TArgs extends Record<string, unknown>, TResult>(
    config: QueryConfig<TDb, TArgs, TResult>
): QueryFn<TDb, TArgs, TResult>;
export function defineQuery<TDb, TArgs extends Record<string, unknown>, TBuilder extends PlannedQueryBuilder>(
    config: PlannedQueryConfig<TDb, TArgs, TBuilder>
): QueryFn<TDb, TArgs, PlannedQueryResult<TBuilder>>;
export function defineQuery<TDb, TArgs extends Record<string, unknown>, TResult>(
    handler: (ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>
): QueryFn<TDb, TArgs, TResult>;
export function defineQuery<TDb, TArgs extends Record<string, unknown>, TResult>(
    configOrHandler:
        | QueryConfig<TDb, TArgs, TResult>
        | PlannedQueryConfig<TDb, TArgs, PlannedQueryBuilder>
        | ((ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>)
): QueryFn<TDb, TArgs, TResult> {
    const isConfig = typeof configOrHandler === "object";
    const isPlanned = isConfig && "query" in configOrHandler;
    const handler = isPlanned ? undefined : isConfig ? configOrHandler.handler : configOrHandler;
    const plannedQuery = isPlanned ? configOrHandler.query : undefined;
    const validator: StandardSchemaV1<unknown, TArgs> | undefined = isConfig ? configOrHandler.args : undefined;
    const intent = isConfig ? configOrHandler.intent : undefined;
    const authority = isConfig ? configOrHandler.authority : undefined;
    const partitionKey = isConfig ? configOrHandler.partitionKey : undefined;
    const partitionKeyFn: ((args: TArgs) => string | number | bigint | undefined) | undefined =
        typeof partitionKey === "string"
            ? (args: TArgs) => {
                  const value: unknown = args[partitionKey];
                  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
                      ? value
                      : undefined;
              }
            : partitionKey;
    const explicitRef = isConfig ? configOrHandler.ref : undefined;
    if (isPlanned) {
        if (typeof plannedQuery !== "function") {
            throw new TypeError("chardb: planned query requires a query callback");
        }
        const mixed = ["handler", "authority", "partitionKey", "intent"].filter(field => field in configOrHandler);
        if (mixed.length > 0) {
            throw new TypeError(`chardb: planned query cannot mix query with ${mixed.join(", ")}`);
        }
    }
    if (explicitRef !== undefined && (explicitRef.length === 0 || !explicitRef.includes("#"))) {
        throw new TypeError("chardb: query ref must be a nonempty string containing #");
    }
    if (authority !== undefined && explicitRef === undefined) {
        throw new TypeError(`chardb: ${authority} queries require an explicit ref`);
    }
    if (authority === "global" && partitionKeyFn === undefined) {
        throw new TypeError("chardb: global queries require an explicit partitionKey extractor");
    }
    if (authority === "global" && intent === undefined) {
        throw new TypeError("chardb: global queries require an explicit intent extractor");
    }
    if (isPlanned && explicitRef === undefined) {
        throw new TypeError("chardb: planned queries require an explicit ref");
    }
    const invokeValidated = async (ctx: QueryCtx<TDb>, args: TArgs): Promise<TResult> => {
        if (plannedQuery) {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: "planned query handles are dispatch-only; Cdb executes their compiled select plan",
            });
        }
        const wrappedCtx = wrapCtxDb(ctx) as QueryCtx<TDb>;
        return (handler as (ctx: QueryCtx<TDb>, args: TArgs) => Promise<TResult>)(wrappedCtx, args);
    };
    const fn = (async (ctx: QueryCtx<TDb>, args: TArgs) => {
        const validated = validator ? await runValidator(validator, args) : args;
        return invokeValidated(ctx, validated);
    }) as QueryFn<TDb, TArgs, TResult>;
    if (handler?.name && handler.name !== "fn") {
        Object.defineProperty(fn, "name", { value: handler.name, configurable: true });
    }
    if (explicitRef) {
        Object.defineProperty(fn, "__chardbExplicitRef", { value: true, enumerable: false });
    }
    if (intent) {
        Object.defineProperty(fn, "__chardbIntent", {
            value: intent,
            enumerable: false,
            configurable: false,
        });
    }
    if (plannedQuery) {
        Object.defineProperty(fn, "__chardbCompilePlan", {
            value: (args: TArgs) =>
                compileRegisteredQueryPlan(plannedQuery as unknown as (db: unknown, args: TArgs) => unknown, args),
            enumerable: false,
            configurable: false,
        });
    }
    if (authority) {
        Object.defineProperty(fn, "__chardbAuthority", { value: authority, enumerable: false });
    }
    if (partitionKeyFn) {
        Object.defineProperty(fn, "__chardbPartitionKey", { value: partitionKeyFn, enumerable: false });
    }
    Object.defineProperty(fn, "__chardbInvokeValidated", { value: invokeValidated, enumerable: false });
    if (validator) {
        Object.defineProperty(fn, "__chardbValidateArgs", {
            value: (args: unknown) => runValidator(validator, args),
            enumerable: false,
            configurable: false,
        });
    }
    return attachRef(fn, "query", explicitRef) as QueryFn<TDb, TArgs, TResult>;
}

/**
 * Replace `ctx.db` with the auto-fill proxy from `cdb-db-proxy.ts`.
 * Defensive against synthetic ctxs (test stubs, the `chardb` placeholder
 * ctx in the Convex-style call signature) that pass a non-object `db`
 * value: in those cases the original ctx flows through unchanged and the
 * (no-op) handler still typechecks.
 */
function wrapCtxDb<TCtx extends { readonly db: unknown; readonly auth?: AuthCtx }>(ctx: TCtx): TCtx {
    const db = ctx.db;
    const auth = ctx.auth;
    if (db === null || typeof db !== "object" || !auth) return ctx;
    return { ...ctx, db: wrapDb(db as object, auth) } as TCtx;
}

/**
 * Run a `StandardSchemaV1` validator over an unknown payload. Invalid caller
 * input is a typed, non-retryable boundary error rather than a server
 * invariant failure deep inside the user's handler.
 */
async function runValidator<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<T> {
    const result = await schema["~standard"].validate(value);
    return valueFromValidationResult(result);
}

function valueFromValidationResult<T>(result: StandardSchemaV1.Result<T>): T {
    if (result.issues) {
        const first = result.issues[0];
        const path = first?.path
            ? Array.from(first.path)
                  .map(p => (typeof p === "object" && "key" in p ? String(p.key) : String(p)))
                  .join(".")
            : "(root)";
        throw new CdbError({
            code: "CDB_INVALID_ARGS",
            message: `chardb: args validation failed at ${path}: ${first?.message ?? "invalid"}`,
        });
    }
    return result.value;
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
export type ChardbDb<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"sync", unknown, TSchema>;

/**
 * Typed `mutation` / `query` factories bound to a concrete schema. The
 * args type for each handler is inferred from the inline annotation
 * (`(ctx, args: { … }) => { … }`) and the result from the return
 * value — no `defineMutation<Db, Args, Result>` explicit-generic
 * triplet, no `& { [k: string]: RawJson }` intersection.
 */
export interface ChardbApi<TSchema extends Record<string, unknown>> {
    mutation<TArgs extends Record<string, unknown>, TResult>(
        config: MutationConfig<ChardbDb<TSchema>, TArgs, TResult>
    ): MutationFn<ChardbDb<TSchema>, TArgs, TResult>;
    mutation<TArgs extends Record<string, unknown>, TResult>(
        handler: (ctx: MutationCtx<ChardbDb<TSchema>>, args: TArgs) => TResult,
        options?: MutationOptions<TArgs>
    ): MutationFn<ChardbDb<TSchema>, TArgs, TResult>;
    query<TArgs extends Record<string, unknown>, TResult>(
        config: QueryConfig<ChardbDb<TSchema>, TArgs, TResult>
    ): QueryFn<ChardbDb<TSchema>, TArgs, TResult>;
    query<TArgs extends Record<string, unknown>, TBuilder extends PlannedQueryBuilder>(
        config: PlannedQueryConfig<ChardbDb<TSchema>, TArgs, TBuilder>
    ): QueryFn<ChardbDb<TSchema>, TArgs, PlannedQueryResult<TBuilder>>;
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
 * import { createApi } from "@chardb/core/server";
 *
 * const api = createApi({ ...auth, ...schema });
 *
 * export const postMessage = api.mutation(
 *   async (ctx, args: { organizationId: string; body: string; … }) => { … },
 *   { singlePartition: true, partitionKey: (a) => a.organizationId },
 * );
 * ```
 *
 * The `@chardb/core/react` hooks derive their `TArgs` / `TResult` types from
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
 * does `import { api } from "@chardb/core/server"` and writes `api.mutation
 * ({...})` directly. Calls like `ctx.db.select().from(messages)`
 * still typecheck because Drizzle's `.from(table)` reads the table's
 * own row type rather than the bound schema generic.
 *
 * For full Drizzle "relational queries" typing (`ctx.db.query
 * .messages.findMany()`), users can still write `const api =
 * createApi<typeof schema>()` — the local-binding path stays public.
 */
export const api: ChardbApi<Record<string, unknown>> = createApi();
