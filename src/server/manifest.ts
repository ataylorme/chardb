/**
 * Bundler-emitted registry of `chardb/server` exports.
 *
 * Every helper attaches `__chardbRef` and `__chardbKind` markers (see
 * `src/server/refs.ts`). The Vite plugin walks the user's worker entry, pulls
 * each named export through `manifestFromExports`, and the result is supplied
 * to `defineChardb({ manifest })`. The configured Cdb class retains this
 * registry in its own isolate and resolves mutation refs locally. The Worker
 * entrypoint uses the same manifest for partition extraction, while
 * `scheduled()` invokes user `defineCron` callbacks.
 *
 * The manifest contains functions and Maps and must never cross RPC. Only the
 * serializable mutation request crosses into Cdb.
 *
 * ### Wire boundary: TArgs is `RawJson`
 *
 * `defineMutation<TArgs>` and `defineQuery<TArgs>` accept a typed argument
 * shape so the user-side handler stays statically checked. The descriptor
 * stored in the manifest, however, deliberately erases that generic to
 * `RawJson`. This is the wire contract: an `Up.mut` envelope carries
 * `args: RawJson` after `decodeWire`, and the Gateway's local route resolver
 * passes that value into a manifest descriptor with the same erased argument
 * shape. Mutation results
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
 * forward direction (typed → erased) and `routeMutation` in this file for
 * the only consumer that needs the erased shape.
 */

import { CdbError } from "../errors.ts";
import type { Brand, ChardbRef, RawJson } from "../types.ts";
import type { ChardbFunctionKind } from "./refs.ts";

interface RefMarked {
    readonly __chardbRef: Brand<string, "ChardbRef">;
    readonly __chardbKind: ChardbFunctionKind;
}

interface MutationMarked extends RefMarked {
    readonly __chardbKind: "mutation";
    readonly __chardbPartitionKey?: (args: RawJson) => string | number | bigint | undefined;
    readonly __chardbSinglePartition?: boolean;
}

interface CronMarked extends RefMarked {
    readonly __chardbKind: "cron";
    readonly __chardbCron: string;
}

export interface MutationDescriptor {
    readonly ref: ChardbRef;
    readonly invoke: (ctx: unknown, args: RawJson) => unknown;
    readonly extractPartitionKey?: (args: RawJson) => string | number | bigint | undefined;
    readonly singlePartition: boolean;
}

export interface QueryDescriptor {
    readonly ref: ChardbRef;
    readonly invoke: (ctx: unknown, args: RawJson) => Promise<unknown>;
}

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

    for (const value of Object.values(exports)) {
        if (!isRefMarked(value)) continue;
        const ref = value.__chardbRef as ChardbRef;
        switch (value.__chardbKind) {
            case "mutation": {
                const m = value as MutationMarked & ((ctx: unknown, args: RawJson) => unknown);
                mutations.set(ref, {
                    ref,
                    invoke: m,
                    ...(m.__chardbPartitionKey ? { extractPartitionKey: m.__chardbPartitionKey } : {}),
                    singlePartition: m.__chardbSinglePartition === true,
                });
                break;
            }
            case "query": {
                queries.set(ref, {
                    ref,
                    invoke: value as unknown as (ctx: unknown, args: RawJson) => Promise<unknown>,
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
    | { readonly ok: true; readonly vshard: number }
    | { readonly ok: false; readonly error: ReturnType<CdbError["toJSON"]> } {
    try {
        const desc = resolveMutation(manifest, input.ref as ChardbRef);
        const argsObj = (input.args ?? {}) as RawJson;
        let key: string | number | bigint | undefined;
        if (desc.extractPartitionKey) key = desc.extractPartitionKey(argsObj);
        if (key === undefined && desc.singlePartition) {
            throw new CdbError({
                code: "CDB_CROSS_PARTITION",
                message: `mutation ${input.ref} declared singlePartition without resolvable partitionKey`,
            });
        }
        const scalar = key === undefined ? JSON.stringify(argsObj) : String(key);
        return { ok: true, vshard: Number(vshardOf([scalar])) };
    } catch (err) {
        if (err instanceof CdbError) return { ok: false, error: err.toJSON() };
        const cdb = new CdbError({
            code: "CDB_INVARIANT",
            message: err instanceof Error ? err.message : "internal",
        });
        return { ok: false, error: cdb.toJSON() };
    }
}
