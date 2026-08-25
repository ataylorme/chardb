/**
 * `chardbAuthAdapter` — chardb's native better-auth `database` adapter.
 *
 * Implements the `CustomAdapter` contract from
 * `@better-auth/core/db/adapter` so it composes with
 * `createAdapterFactory({adapter, config})` and slots straight into
 * `betterAuth({database: chardbAuthAdapter(env)})`. Every auth model is
 * stored in the singleton Catalog DO. Better Auth routinely looks up rows
 * by session token, email, provider/account key, and membership fields;
 * central storage keeps those reads deterministic without shard fan-out or
 * a second set of auth-specific indexes.
 *
 * Catalog applies each auth write and every affected auth-epoch bump in
 * one SQLite transaction. The adapter does not issue a second invalidation
 * RPC after the row has committed.
 *
 * Reads support `eq` and bounded `in` filters joined by AND. Writes use
 * equality predicates. The organization plugin uses `in` to load users
 * for a page of membership rows.
 */

import type { AdapterFactory, CleanedWhere } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { createAdapterFactory } from "better-auth/adapters";
import { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";
import { AUTH_READ_IN_MAX_VALUES, type AuthIncrementWhere, type AuthReadWhere } from "./sql.ts";

/**
 * Bindings the adapter needs at runtime. Provided by `mountChardb` /
 * `chardb({auth})` once the inbound `env` is known.
 */
export interface ChardbAuthAdapterEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
}

interface CatalogRpc {
    mutateAuth(args: {
        model: string;
        op: "create" | "update" | "delete";
        where?: { [k: string]: RawJson };
        payload?: { [k: string]: RawJson };
        returnRow?: boolean;
        limitOne?: boolean;
    }): Promise<{ ok: true; row?: Record<string, RawJson> | null; affected?: number }>;
    queryAuth(args: {
        model: string;
        where: readonly AuthReadWhere[];
        limit?: number;
        offset?: number;
        sortBy?: { field: string; direction: "asc" | "desc" };
    }): Promise<readonly Record<string, RawJson>[]>;
    countAuth(args: { model: string; where: readonly AuthReadWhere[] }): Promise<number>;
    incrementAuth(args: {
        model: string;
        where: readonly AuthIncrementWhere[];
        increment: { readonly [k: string]: number };
        set?: { readonly [k: string]: RawJson };
    }): Promise<{ ok: true; row: Record<string, RawJson> | null; affected: number }>;
}

export interface ChardbAuthAdapterOptions {
    readonly env: ChardbAuthAdapterEnv;
}

export function chardbAuthAdapter(opts: ChardbAuthAdapterOptions): AdapterFactory<BetterAuthOptions> {
    const { env } = opts;
    const catalog = (): CatalogRpc =>
        env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;

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
        adapter: ({ getFieldName, schema }) => {
            const canonicalModels = new Map<string, string>();
            const canonicalFields = new Map<string, ReadonlyMap<string, string>>();
            for (const [canonicalModel, modelSchema] of Object.entries(schema)) {
                const physicalModel = modelSchema.modelName;
                const existingModel = canonicalModels.get(physicalModel);
                if (existingModel !== undefined) {
                    throw incompatibleAuthMapping(
                        `models "${existingModel}" and "${canonicalModel}" both map to "${physicalModel}"`
                    );
                }
                canonicalModels.set(physicalModel, canonicalModel);

                const fields = new Map<string, string>([["id", "id"]]);
                for (const [canonicalField, fieldSchema] of Object.entries(modelSchema.fields)) {
                    const physicalField = fieldSchema.fieldName ?? canonicalField;
                    const existingField = fields.get(physicalField);
                    if (existingField !== undefined) {
                        throw incompatibleAuthMapping(
                            `fields "${existingField}" and "${canonicalField}" on model "${canonicalModel}" both map to "${physicalField}"`
                        );
                    }
                    fields.set(physicalField, canonicalField);
                }
                canonicalFields.set(canonicalModel, fields);
            }

            const canonicalModelFor = (physicalModel: string): string => {
                const canonicalModel = canonicalModels.get(physicalModel);
                if (canonicalModel === undefined) {
                    throw new CdbError({
                        code: "CDB_INVALID_ARGS",
                        message: `chardb auth adapter: unknown physical model "${physicalModel}"`,
                    });
                }
                return canonicalModel;
            };
            const canonicalFieldFor = (canonicalModel: string, physicalField: string): string => {
                const canonicalField = canonicalFields.get(canonicalModel)?.get(physicalField);
                if (canonicalField === undefined) {
                    throw new CdbError({
                        code: "CDB_INVALID_ARGS",
                        message: `chardb auth adapter: unknown physical field "${physicalField}" on model "${canonicalModel}"`,
                    });
                }
                return canonicalField;
            };

            return {
                async create({ model, data }) {
                    const payload = data as { [k: string]: RawJson };
                    const r = await catalog().mutateAuth({ model, op: "create", payload });
                    return (r.row ?? payload) as never;
                },

                async findOne({ model, where }) {
                    const filters = whereToReadFilters(where);
                    const rows = await catalog().queryAuth({ model, where: filters, limit: 1 });
                    return (rows[0] ?? null) as never;
                },

                async findMany({ model, where, limit, offset, sortBy }) {
                    const filters = where ? whereToReadFilters(where) : [];
                    const rows = await catalog().queryAuth({
                        model,
                        where: filters,
                        limit: limit ?? 100,
                        ...(offset === undefined ? {} : { offset }),
                        ...(sortBy === undefined ? {} : { sortBy }),
                    });
                    return rows as never;
                },

                async count({ model, where }) {
                    const filters = where ? whereToReadFilters(where) : [];
                    return catalog().countAuth({ model, where: filters });
                },

                async update({ model, where, update }) {
                    const flat = whereToFlat(where);
                    const r = await catalog().mutateAuth({
                        model,
                        op: "update",
                        where: flat,
                        payload: update as { [k: string]: RawJson },
                        returnRow: true,
                        limitOne: true,
                    });
                    return (r.row ?? null) as never;
                },

                async updateMany({ model, where, update }) {
                    const flat = whereToFlat(where);
                    const r = await catalog().mutateAuth({
                        model,
                        op: "update",
                        where: flat,
                        payload: update as { [k: string]: RawJson },
                        returnRow: false,
                        limitOne: false,
                    });
                    return r.affected ?? 0;
                },

                async delete({ model, where }) {
                    const flat = whereToFlat(where);
                    await catalog().mutateAuth({ model, op: "delete", where: flat, limitOne: true });
                },

                async deleteMany({ model, where }) {
                    const flat = whereToFlat(where);
                    const r = await catalog().mutateAuth({ model, op: "delete", where: flat, limitOne: false });
                    return r.affected ?? 0;
                },

                async incrementOne({ model, where, increment, set }) {
                    const defaultModel = canonicalModelFor(model);
                    const defaultField = (field: string): string => canonicalFieldFor(defaultModel, field);
                    const guardedWhere = whereToIncrementGuards(where, defaultField);
                    const ownedIncrement: Record<string, number> = Object.create(null);
                    for (const [field, delta] of Object.entries(increment)) {
                        if (typeof delta !== "number" || !Number.isFinite(delta) || Object.is(delta, -0)) {
                            throw new CdbError({
                                code: "CDB_INVALID_ARGS",
                                message: `chardb auth adapter: increment delta for "${field}" must be finite and not negative zero`,
                            });
                        }
                        ownedIncrement[defaultField(field)] = delta;
                    }
                    const ownedSet: Record<string, RawJson> | undefined =
                        set === undefined ? undefined : Object.create(null);
                    if (ownedSet) {
                        for (const [field, value] of Object.entries(set ?? {})) {
                            ownedSet[defaultField(field)] = value as RawJson;
                        }
                    }
                    const r = await catalog().incrementAuth({
                        model: defaultModel,
                        where: guardedWhere,
                        increment: ownedIncrement,
                        ...(ownedSet === undefined ? {} : { set: ownedSet }),
                    });
                    if (!r.row) return null;
                    const storageRow: Record<string, RawJson> = Object.create(null);
                    for (const [field, value] of Object.entries(r.row)) {
                        storageRow[getFieldName({ model: defaultModel, field })] = value;
                    }
                    return storageRow as never;
                },
            };
        },
    }) as AdapterFactory<BetterAuthOptions>;
}

function incompatibleAuthMapping(message: string): CdbError {
    return new CdbError({
        code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
        message: `chardb auth adapter: ${message}`,
    });
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

function whereToReadFilters(where: CleanedWhere[]): AuthReadWhere[] {
    const out: AuthReadWhere[] = [];
    for (const condition of where) {
        if (condition.connector === "OR") {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: "chardb auth adapter: OR connectors are not supported in where clauses",
            });
        }
        if (condition.mode !== "sensitive") {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: "chardb auth adapter: case-insensitive where clauses are not supported",
            });
        }
        if (condition.operator === "eq") {
            out.push({ field: condition.field, operator: "eq", value: normalize(condition.value) });
            continue;
        }
        if (condition.operator === "in") {
            if (!Array.isArray(condition.value)) {
                throw new CdbError({
                    code: "CDB_INVALID_ARGS",
                    message: "chardb auth adapter: in filter value must be an array",
                });
            }
            if (condition.value.length > AUTH_READ_IN_MAX_VALUES) {
                throw new CdbError({
                    code: "CDB_INVALID_ARGS",
                    message: `chardb auth adapter: in filter exceeds ${AUTH_READ_IN_MAX_VALUES} values`,
                });
            }
            out.push({
                field: condition.field,
                operator: "in",
                value: condition.value.map(value => normalize(value)),
            });
            continue;
        }
        throw new CdbError({
            code: "CDB_UNSUPPORTED_FEATURE",
            message: `chardb auth adapter: where operator "${condition.operator}" not supported`,
        });
    }
    return out;
}

function whereToIncrementGuards(where: CleanedWhere[], defaultField: (field: string) => string): AuthIncrementWhere[] {
    const out: AuthIncrementWhere[] = [];
    for (const condition of where) {
        if (condition.connector === "OR") {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: "chardb auth adapter: OR connectors are not supported in incrementOne guards",
            });
        }
        if (condition.mode !== "sensitive") {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: "chardb auth adapter: case-insensitive incrementOne guards are not supported",
            });
        }
        if (
            condition.operator !== "eq" &&
            condition.operator !== "lt" &&
            condition.operator !== "lte" &&
            condition.operator !== "gt" &&
            condition.operator !== "gte"
        ) {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: `chardb auth adapter: incrementOne where operator "${condition.operator}" is not supported`,
            });
        }
        const value = normalize(condition.value);
        if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            throw new CdbError({
                code: "CDB_INVALID_ARGS",
                message: "chardb auth adapter: incrementOne comparison values must be scalar",
            });
        }
        if (value === null && condition.operator !== "eq") {
            throw new CdbError({
                code: "CDB_INVALID_ARGS",
                message: "chardb auth adapter: incrementOne only supports null with the eq operator",
            });
        }
        if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
            throw new CdbError({
                code: "CDB_INVALID_ARGS",
                message: "chardb auth adapter: incrementOne comparison numbers must be finite and not negative zero",
            });
        }
        out.push({ field: defaultField(condition.field), operator: condition.operator, value });
    }
    return out;
}

function normalize(v: CleanedWhere["value"]): RawJson {
    if (v instanceof Date) return v.getTime();
    if (Array.isArray(v)) {
        return v as unknown as RawJson;
    }
    return v as RawJson;
}
