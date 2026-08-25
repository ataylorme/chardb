/**
 * Bundler-emitted registry of `chardb/server` exports.
 *
 * Every helper attaches `__chardbRef` and `__chardbKind` markers (see
 * `src/server/refs.ts`). The Vite plugin walks the user's worker entry, pulls
 * each named export through `manifestFromExports`, and the result is supplied
 * to `defineChardb({ manifest })`. The configured Cdb class retains this
 * registry in its own isolate and resolves mutation refs locally. The
 * configured Gateway retains the same manifest for mutation and query
 * routing, while `scheduled()` invokes user `defineCron` callbacks.
 *
 * The manifest contains functions and Maps and must never cross RPC. Only
 * serializable mutation and subscription requests cross into Cdb.
 *
 * ### Wire boundary: TArgs is `RawJson`
 *
 * `defineMutation<TArgs>` and `defineQuery<TArgs>` accept a typed argument
 * shape so the user-side handler stays statically checked. The descriptor
 * stored in the manifest, however, deliberately erases that generic to
 * `RawJson`. This is the wire contract: an `Up.mut` envelope carries
 * `args: RawJson` after `decodeWire`; `Up.sub` carries the same pair for
 * queries. The Gateway's local route resolvers pass those values into manifest
 * descriptors with the same erased argument shape. Mutation results
 * remain `unknown` until the op-log wrapper verifies they are JSON.
 *
 * A phantom-map alternative (parallel `WeakMap<ChardbRef, TArgs>`) was
 * rejected because TypeScript lacks generic existentials: the map's value
 * type would still need to be `unknown` at the consumption site, and
 * threading `TArgs` through would force every dispatch through a generic
 * lookup that can't be resolved at the wire boundary anyway. Validation
 * (Zod / TypeBox / Valibot / ArkType) lives one level up in the user's
 * handler — `chardb/files/{zod,…}` is wired so the user can refine `args`
 * before calling into business logic. See `src/server/define.ts` for the
 * forward direction (typed → erased) and the routing functions in this file
 * for the consumers that need the erased shape.
 */

import { CdbError } from "../errors.ts";
import type { Brand, ChardbRef, RawJson } from "../types.ts";
import { stableJson } from "../util/canonical.ts";
import type { CdbIntent } from "../wire.ts";
import type { MutationAuthority } from "./define.ts";
import type { ChardbFunctionKind } from "./refs.ts";
import {
    CDB_JSON_MAX_AGGREGATE_MEMBERS,
    CDB_QUERY_ARGS_MAX_BYTES,
    CDB_QUERY_ARGS_MAX_DEPTH,
    snapshotCdbJsonByteLimit,
    snapshotCdbMutationArgs,
    snapshotCdbQueryArgs,
} from "./result_limits.ts";

interface RefMarked {
    readonly __chardbRef: Brand<string, "ChardbRef">;
    readonly __chardbKind: ChardbFunctionKind;
}

interface MutationMarked extends RefMarked {
    readonly __chardbKind: "mutation";
    readonly __chardbPartitionKey?: (args: RawJson) => string | number | bigint | undefined;
    readonly __chardbSinglePartition?: boolean;
    readonly __chardbAuthority?: MutationAuthority;
    readonly __chardbInvokeValidated?: (ctx: unknown, args: RawJson) => unknown;
    readonly __chardbValidateArgs?: (args: unknown) => RawJson;
}

interface QueryMarked extends RefMarked {
    readonly __chardbKind: "query";
    readonly __chardbIntent?: (args: RawJson) => CdbIntent;
    readonly __chardbValidateArgs?: (args: unknown) => Promise<RawJson>;
    readonly __chardbAuthority?: MutationAuthority;
    readonly __chardbPartitionKey?: (args: RawJson) => string | number | bigint | undefined;
    readonly __chardbInvokeValidated?: (ctx: unknown, args: RawJson) => Promise<unknown>;
}

interface CronMarked extends RefMarked {
    readonly __chardbKind: "cron";
    readonly __chardbCron: string;
}

export interface MutationDescriptor {
    readonly ref: ChardbRef;
    readonly invoke: (ctx: unknown, args: RawJson) => unknown;
    readonly invokeValidated: (ctx: unknown, args: RawJson) => unknown;
    readonly validateArgs?: (args: unknown) => RawJson;
    readonly extractPartitionKey?: (args: RawJson) => string | number | bigint | undefined;
    readonly singlePartition: boolean;
    readonly authority?: MutationAuthority;
}

export interface QueryDescriptor {
    readonly ref: ChardbRef;
    readonly invoke: (ctx: unknown, args: RawJson) => Promise<unknown>;
    readonly invokeValidated: (ctx: unknown, args: RawJson) => Promise<unknown>;
    readonly validateArgs?: (args: unknown) => Promise<RawJson>;
    readonly extractIntent?: (args: RawJson) => CdbIntent;
    readonly authority?: MutationAuthority;
    readonly extractPartitionKey?: (args: RawJson) => string | number | bigint | undefined;
}

export type QueryRouteResponse =
    | {
          readonly ok: true;
          readonly args: RawJson;
          readonly intent: CdbIntent;
          readonly policyDigest: string;
          readonly queryHash: string;
          readonly authority: MutationAuthority | null;
          readonly partitionKey: string | null;
      }
    | { readonly ok: false; readonly error: ReturnType<CdbError["toJSON"]> };

export interface CronDescriptor {
    readonly ref: ChardbRef;
    readonly cronExpr: string;
    readonly invoke: () => void | Promise<void>;
}

export interface LedgerDescriptor {
    readonly ref: ChardbRef;
    readonly tableName: string;
}

export interface ChardbManifest {
    readonly mutations: ReadonlyMap<ChardbRef, MutationDescriptor>;
    readonly queries: ReadonlyMap<ChardbRef, QueryDescriptor>;
    readonly crons: readonly CronDescriptor[];
    readonly ledgers: ReadonlyMap<ChardbRef, LedgerDescriptor>;
}

const EMPTY: ChardbManifest = {
    mutations: new Map(),
    queries: new Map(),
    crons: [],
    ledgers: new Map(),
};

export function emptyManifest(): ChardbManifest {
    return EMPTY;
}

function isRefMarked(v: unknown): v is RefMarked {
    if (v === null) return false;
    if (typeof v !== "function" && typeof v !== "object") return false;
    const r = v as { __chardbRef?: unknown; __chardbKind?: unknown };
    return typeof r.__chardbRef === "string" && typeof r.__chardbKind === "string";
}

/**
 * Walk an object of named exports and produce a `ChardbManifest`. Anything
 * without a `__chardbRef` marker is silently ignored — the user's worker
 * exports schemas, types, and miscellanea alongside chardb-marked values.
 */
export function manifestFromExports(exports: Record<string, unknown>): ChardbManifest {
    const mutations = new Map<ChardbRef, MutationDescriptor>();
    const queries = new Map<ChardbRef, QueryDescriptor>();
    const crons: CronDescriptor[] = [];
    const ledgers = new Map<ChardbRef, LedgerDescriptor>();
    const seenRefs = new Map<ChardbRef, { readonly kind: string; readonly value: unknown }>();

    for (const value of Object.values(exports)) {
        if (!isRefMarked(value)) continue;
        const ref = value.__chardbRef as ChardbRef;
        const seen = seenRefs.get(ref);
        if (seen && seen.value !== value) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: `duplicate ref across ${seen.kind} and ${value.__chardbKind}: ${ref}`,
            });
        }
        if (seen) continue;
        seenRefs.set(ref, { kind: value.__chardbKind, value });
        switch (value.__chardbKind) {
            case "mutation": {
                const m = value as MutationMarked & ((ctx: unknown, args: RawJson) => unknown);
                const duplicate = mutations.get(ref);
                if (duplicate && duplicate.invoke !== m) {
                    throw new CdbError({ code: "CDB_INVARIANT", message: `duplicate mutation ref: ${ref}` });
                }
                mutations.set(ref, {
                    ref,
                    invoke: m,
                    invokeValidated: m.__chardbInvokeValidated ?? m,
                    ...(m.__chardbValidateArgs ? { validateArgs: m.__chardbValidateArgs } : {}),
                    ...(m.__chardbPartitionKey ? { extractPartitionKey: m.__chardbPartitionKey } : {}),
                    singlePartition: m.__chardbSinglePartition === true,
                    ...(m.__chardbAuthority ? { authority: m.__chardbAuthority } : {}),
                });
                break;
            }
            case "query": {
                const query = value as QueryMarked & ((ctx: unknown, args: RawJson) => Promise<unknown>);
                const duplicate = queries.get(ref);
                if (duplicate && duplicate.invoke !== query) {
                    throw new CdbError({ code: "CDB_INVARIANT", message: `duplicate query ref: ${ref}` });
                }
                queries.set(ref, {
                    ref,
                    invoke: query,
                    invokeValidated: query.__chardbInvokeValidated ?? query,
                    ...(query.__chardbValidateArgs ? { validateArgs: query.__chardbValidateArgs } : {}),
                    ...(query.__chardbIntent ? { extractIntent: query.__chardbIntent } : {}),
                    ...(query.__chardbAuthority ? { authority: query.__chardbAuthority } : {}),
                    ...(query.__chardbPartitionKey ? { extractPartitionKey: query.__chardbPartitionKey } : {}),
                });
                break;
            }
            case "cron": {
                const c = value as CronMarked & (() => void | Promise<void>);
                crons.push({ ref, cronExpr: c.__chardbCron, invoke: c });
                break;
            }
            case "ledger": {
                const l = value as RefMarked & { readonly tableName?: string };
                ledgers.set(ref, { ref, tableName: l.tableName ?? ref });
                break;
            }
            default:
                break;
        }
    }
    return { mutations, queries, crons, ledgers };
}

/**
 * Resolve a mutation by ref, raising `CDB_REF_NOT_FOUND` if the manifest
 * doesn't know about it. Used for entrypoint routing and shard-local execution.
 */
export function resolveMutation(manifest: ChardbManifest, ref: ChardbRef): MutationDescriptor {
    const desc = manifest.mutations.get(ref);
    if (!desc) {
        throw new CdbError({ code: "CDB_REF_NOT_FOUND", message: `unknown mutation ref: ${ref}` });
    }
    return desc;
}

export function resolveQuery(manifest: ChardbManifest, ref: ChardbRef): QueryDescriptor {
    const descriptor = manifest.queries.get(ref);
    if (!descriptor) {
        throw new CdbError({ code: "CDB_REF_NOT_FOUND", message: `unknown query ref: ${ref}` });
    }
    return descriptor;
}

function requireAuthorityPartition(
    authority: MutationAuthority | undefined,
    kind: "mutation" | "query",
    ref: string,
    key: string | number | bigint | undefined
): asserts key is string {
    if (authority === undefined) return;
    if (typeof key === "string" && key.length > 0) return;
    throw new CdbError({
        code: "CDB_INVALID_ARGS",
        message: `${authority} ${kind} ${ref} requires a nonempty string partition key`,
    });
}

/** Re-derive query placement from arguments that Gateway already validated. */
export function routeValidatedQuery(
    manifest: ChardbManifest,
    input: { readonly ref: string; readonly args: RawJson },
    policyDigestForTables: (tableNames: readonly string[]) => string
): Extract<QueryRouteResponse, { readonly ok: true }> {
    const callbackArgs = snapshotCdbQueryArgs(input.args);
    const descriptor = resolveQuery(manifest, input.ref as ChardbRef);
    if (!descriptor.extractIntent) {
        throw new CdbError({
            code: "CDB_NO_INTENT_FOR_RAW_SQL",
            message: `query ${input.ref} has no server intent extractor`,
        });
    }
    const intentCandidate = descriptor.extractIntent(callbackArgs);
    const key = descriptor.extractPartitionKey?.(callbackArgs);
    const args = snapshotCdbQueryArgs(callbackArgs);
    const intent = snapshotCdbJsonByteLimit(
        intentCandidate as unknown as RawJson,
        CDB_QUERY_ARGS_MAX_BYTES,
        {
            code: "CDB_INVARIANT",
            subject: "query intent",
            hint: "reduce query intent metadata",
        },
        { maxAggregateMembers: CDB_JSON_MAX_AGGREGATE_MEMBERS, maxDepth: CDB_QUERY_ARGS_MAX_DEPTH }
    ) as unknown as CdbIntent;
    const policyDigest = policyDigestForTables(intent.tables);
    requireAuthorityPartition(descriptor.authority, "query", input.ref, key);
    return {
        ok: true,
        args,
        intent,
        policyDigest,
        queryHash: stableJson({ ref: input.ref, args, intent, policyDigest }),
        authority: descriptor.authority ?? null,
        partitionKey: key === undefined ? null : String(key),
    };
}

/** Resolve server-owned query routing metadata without executing the query. */
export async function routeQuery(
    manifest: ChardbManifest,
    input: { readonly ref: string; readonly args: RawJson },
    policyDigestForTables: (tableNames: readonly string[]) => string
): Promise<QueryRouteResponse> {
    try {
        const rawArgs = snapshotCdbQueryArgs(input.args);
        const descriptor = resolveQuery(manifest, input.ref as ChardbRef);
        if (!descriptor.extractIntent) {
            throw new CdbError({
                code: "CDB_NO_INTENT_FOR_RAW_SQL",
                message: `query ${input.ref} has no server intent extractor`,
            });
        }
        const validatedArgs = snapshotCdbQueryArgs(
            (descriptor.validateArgs ? await descriptor.validateArgs(rawArgs) : rawArgs) as RawJson
        );
        return routeValidatedQuery(manifest, { ref: input.ref, args: validatedArgs }, policyDigestForTables);
    } catch (error) {
        const cdb =
            error instanceof CdbError
                ? error
                : new CdbError({ code: "CDB_INVARIANT", message: "query intent extraction failed", cause: error });
        return { ok: false, error: cdb.toJSON() };
    }
}

/**
 * Pure routing decision: extract the partition key for a mutation and compute
 * the target vshard. Kept pure so configured Gateway isolates and tests share
 * the same decision without booting workerd. Returns the JSON-serialisable
 * shape consumed by the mutation dispatcher.
 */
export function routeMutation(
    manifest: ChardbManifest,
    input: { readonly ref: string; readonly args: RawJson },
    vshardOf: (parts: readonly (string | number | bigint | Uint8Array)[]) => number
):
    | {
          readonly ok: true;
          readonly vshard: number;
          readonly authority: MutationAuthority | null;
          readonly partitionKey: string | null;
          readonly args: RawJson;
      }
    | { readonly ok: false; readonly error: ReturnType<CdbError["toJSON"]> } {
    try {
        const rawArgs = snapshotCdbMutationArgs(input.args);
        const desc = resolveMutation(manifest, input.ref as ChardbRef);
        const validatedArgs = snapshotCdbMutationArgs(
            (desc.validateArgs ? desc.validateArgs(rawArgs) : rawArgs) as RawJson
        );
        let key: string | number | bigint | undefined;
        if (desc.extractPartitionKey) key = desc.extractPartitionKey(snapshotCdbMutationArgs(validatedArgs));
        const args = snapshotCdbMutationArgs(validatedArgs);
        requireAuthorityPartition(desc.authority, "mutation", input.ref, key);
        if (key === undefined && desc.singlePartition) {
            throw new CdbError({
                code: "CDB_CROSS_PARTITION",
                message: `mutation ${input.ref} declared singlePartition without resolvable partitionKey`,
            });
        }
        const scalar = key === undefined ? stableJson(args) : String(key);
        return {
            ok: true,
            vshard: Number(vshardOf([scalar])),
            authority: desc.authority ?? null,
            partitionKey: key === undefined ? null : String(key),
            args,
        };
    } catch (err) {
        if (err instanceof CdbError) return { ok: false, error: err.toJSON() };
        const cdb = new CdbError({
            code: "CDB_INVARIANT",
            message: err instanceof Error ? err.message : "internal",
        });
        return { ok: false, error: cdb.toJSON() };
    }
}
