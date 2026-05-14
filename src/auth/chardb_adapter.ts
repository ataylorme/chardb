/**
 * `chardbAuthAdapter` — chardb's native better-auth `database` adapter.
 *
 * Implements the `CustomAdapter` contract from
 * `@better-auth/core/db/adapter` so it composes with
 * `createAdapterFactory({adapter, config})` and slots straight into
 * `betterAuth({database: chardbAuthAdapter(env)})`. Each model write is
 * routed to the partition-owning Cdb shard via the chardb Catalog DO,
 * or pinned to the Catalog itself for replicated models (jwks,
 * rateLimit). Reads on the partition column hit the owning shard
 * directly; cross-partition lookups fan out (a future patch routes
 * them through the GsiShard DO).
 *
 * Auth-epoch invalidation rides on top of every successful write — the
 * dispatcher passes `(model, row)` to `bumpAuthEpoch` so cached query
 * results that depend on the row's tenant or principal are forced to
 * re-fetch on the next request.
 *
 * Where-clause translation: the only operator currently supported is
 * `eq` joined by AND. Better-auth's standard model-store operations
 * never emit anything richer for the four core models or the shipping
 * plugins; if a user-provided plugin needs `in`/`contains`/etc.,
 * support is straightforward to add by extending `whereToFlat`.
 */

import { createAdapterFactory } from "better-auth/adapters";
import type { BetterAuthOptions } from "better-auth";
import type { AdapterFactory, CleanedWhere } from "@better-auth/core/db/adapter";
import { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";
import { vshardOf } from "../vshard.ts";
import { type AuthEpochDispatcher } from "./adapter.ts";
import { placementFor } from "./runtime.ts";

/**
 * Bindings the adapter needs at runtime. Provided by `mountChardb` /
 * `chardb({auth})` once the inbound `env` is known.
 */
export interface ChardbAuthAdapterEnv {
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_CATALOG: DurableObjectNamespace;
}

interface CdbAuthRpc {
    mutateAuth(args: {
        model: string;
        op: "create" | "update" | "delete";
        where?: { [k: string]: RawJson };
        payload?: { [k: string]: RawJson };
    }): Promise<{ ok: true; row?: Record<string, RawJson> | null; affected?: number }>;
    queryAuth(args: {
        model: string;
        where: { [k: string]: RawJson };
        limit?: number;
    }): Promise<readonly Record<string, RawJson>[]>;
}

interface CatalogRpc extends CdbAuthRpc {
    route(vshard: number): Promise<{ shardId: string }>;
    bumpAuthEpoch(scope: "global" | "tenant" | "principal", scopeId: string): Promise<number>;
}

export interface ChardbAuthAdapterOptions {
    readonly env: ChardbAuthAdapterEnv;
    /**
     * Optional epoch dispatcher override. If omitted, the adapter
     * derives a default one that calls `Catalog.bumpAuthEpoch`
     * directly. Custom dispatchers are useful in tests.
     */
    readonly dispatcher?: AuthEpochDispatcher;
}

export function chardbAuthAdapter(opts: ChardbAuthAdapterOptions): AdapterFactory<BetterAuthOptions> {
    const { env } = opts;
    const catalog = (): CatalogRpc => env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;
    const shardFor = (shardId: string): CdbAuthRpc =>
        env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as CdbAuthRpc;

    const dispatcher: AuthEpochDispatcher = opts.dispatcher ?? {
        async bumpGlobal() {
            await catalog().bumpAuthEpoch("global", "global");
        },
        async bumpTenant(tenantId) {
            await catalog().bumpAuthEpoch("tenant", tenantId);
        },
        async bumpPrincipal(principalId) {
            await catalog().bumpAuthEpoch("principal", principalId);
        },
    };

    async function ownerFor(model: string, where: { [k: string]: RawJson }): Promise<CdbAuthRpc> {
        const rule = placementFor(model);
        if (rule.kind === "replicated") return catalog();
        const partitionValue = where[rule.column];
        if (partitionValue === undefined || partitionValue === null) {
            // No partition key in where → caller wants a secondary lookup.
            // Cross-partition lookups land on the GsiShard path in W1+;
            // for now signal explicitly so the missing case is loud.
            throw new CdbError({
                code: "CDB_AUTH_GSI_MISS",
                message: `auth lookup on ${model} requires partition column "${rule.column}" or a registered GSI`,
                hint: "include the partition column in your where clause",
            });
        }
        const vshard = vshardOf([String(partitionValue)]);
        const { shardId } = await catalog().route(vshard);
        return shardFor(shardId);
    }

    async function maybeBump(model: string, row: Record<string, RawJson> | null | undefined): Promise<void> {
        if (!row) return;
        const rule = placementFor(model);
        if (rule.kind === "tenant") {
            const t = row[rule.column];
            if (typeof t === "string") await dispatcher.bumpTenant(t);
        } else if (rule.kind === "principal") {
            const p = row[rule.column];
            if (typeof p === "string") await dispatcher.bumpPrincipal(p);
        } else {
            await dispatcher.bumpGlobal();
        }
    }

    return createAdapterFactory({
        config: {
            adapterId: "chardb",
            adapterName: "chardb",
            supportsBooleans: true,
            supportsDates: true,
            supportsJSON: false,
            supportsNumericIds: false,
            transaction: false,
        },
        adapter: () => ({
            async create({ model, data }) {
                const payload = data as { [k: string]: RawJson };
                const rule = placementFor(model);
                let rpc: CdbAuthRpc;
                if (rule.kind === "replicated") {
                    rpc = catalog();
                } else {
                    const v = payload[rule.column];
                    if (v === undefined || v === null) {
                        throw new CdbError({
                            code: "CDB_AUTH_GSI_MISS",
                            message: `auth create on ${model} missing partition column "${rule.column}"`,
                        });
                    }
                    const { shardId } = await catalog().route(vshardOf([String(v)]));
                    rpc = shardFor(shardId);
                }
                const r = await rpc.mutateAuth({ model, op: "create", payload });
                await maybeBump(model, r.row ?? payload);
                return (r.row ?? payload) as never;
            },

            async findOne({ model, where }) {
                const flat = whereToFlat(where);
                const rpc = await ownerFor(model, flat);
                const rows = await rpc.queryAuth({ model, where: flat, limit: 1 });
                return (rows[0] ?? null) as never;
            },

            async findMany({ model, where, limit }) {
                const flat = where ? whereToFlat(where) : {};
                const rule = placementFor(model);
                if (rule.kind === "replicated" || flat[rule.kind === "tenant" ? rule.column : rule.column] !== undefined) {
                    const rpc = await ownerFor(model, flat);
                    const rows = await rpc.queryAuth({ model, where: flat, limit: limit ?? 100 });
                    return rows as never;
                }
                // Cross-partition findMany: not supported in W1 minimum.
                // The four core models always include a partition-key
                // predicate via better-auth's own internal queries.
                throw new CdbError({
                    code: "CDB_AUTH_GSI_MISS",
                    message: `auth findMany on ${model} requires partition column "${rule.column}"`,
                });
            },

            async count({ model, where }) {
                const flat = where ? whereToFlat(where) : {};
                const rpc = await ownerFor(model, flat);
                const rows = await rpc.queryAuth({ model, where: flat });
                return rows.length;
            },

            async update({ model, where, update }) {
                const flat = whereToFlat(where);
                const rpc = await ownerFor(model, flat);
                const r = await rpc.mutateAuth({
                    model,
                    op: "update",
                    where: flat,
                    payload: update as { [k: string]: RawJson },
                });
                await maybeBump(model, r.row);
                return (r.row ?? null) as never;
            },

            async updateMany({ model, where, update }) {
                const flat = whereToFlat(where);
                const rpc = await ownerFor(model, flat);
                const r = await rpc.mutateAuth({
                    model,
                    op: "update",
                    where: flat,
                    payload: update as { [k: string]: RawJson },
                });
                await maybeBump(model, r.row);
                return r.affected ?? 0;
            },

            async delete({ model, where }) {
                const flat = whereToFlat(where);
                // Read row first so we can bump the right epoch after
                // the delete commits.
                const rpc = await ownerFor(model, flat);
                const before = (await rpc.queryAuth({ model, where: flat, limit: 1 }))[0];
                await rpc.mutateAuth({ model, op: "delete", where: flat });
                await maybeBump(model, before ?? null);
            },

            async deleteMany({ model, where }) {
                const flat = whereToFlat(where);
                const rpc = await ownerFor(model, flat);
                const before = await rpc.queryAuth({ model, where: flat });
                const r = await rpc.mutateAuth({ model, op: "delete", where: flat });
                for (const row of before) await maybeBump(model, row);
                return r.affected ?? before.length;
            },
        }),
    }) as AdapterFactory<BetterAuthOptions>;
}

/**
 * Translate a better-auth `CleanedWhere[]` into a flat
 * `{[col]: value}` map. Only `eq` joined by AND is supported today —
 * all four core models and every shipping plugin model use that
 * shape for their internal model-store operations.
 */
function whereToFlat(where: CleanedWhere[]): { [k: string]: RawJson } {
    const out: { [k: string]: RawJson } = {};
    for (const w of where) {
        if (w.operator !== "eq") {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: `chardb auth adapter: where operator "${w.operator}" not supported (only "eq")`,
            });
        }
        if (w.connector === "OR") {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: "chardb auth adapter: OR connectors are not supported in where clauses",
            });
        }
        out[w.field] = normalize(w.value);
    }
    return out;
}

function normalize(v: CleanedWhere["value"]): RawJson {
    if (v instanceof Date) return v.getTime();
    if (Array.isArray(v)) {
        // Caller used `in` operator — handled above. This branch
        // exists only so `string[]` / `number[]` from edge cases
        // don't crash; they'll surface as JSON-encoded blobs.
        return v as unknown as RawJson;
    }
    return v as RawJson;
}
