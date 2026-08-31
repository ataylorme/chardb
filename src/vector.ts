/**
 * `@chardb/core/server` vector column types.
 *
 * `vector('col', { dim, binding, metric })` — backed by Cloudflare Vectorize (eventually
 * consistent). See
 * https://developers.cloudflare.com/vectorize/reference/client-api/ for the
 * underlying `insert` / `upsert` / `query` surface.
 *
 * `inlineVector('col', { dim })` — BLOB column; brute-force k-NN inside a
 * single partition. Reads against `inlineVector` join the surrounding
 * mutation's strict-serializable transaction.
 */

import type { Column } from "drizzle-orm";
import { customType } from "drizzle-orm/sqlite-core";

export const CDB_VECTOR_MAX_DIMENSIONS = 1_536;
export const CDB_INLINE_VECTOR_MAX_DIMENSIONS = 4_096;
export const CDB_VECTOR_SEARCH_MAX_RESULTS = 100;
const VECTOR_BINDING = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TEXT = new TextEncoder();

export type VectorMetric = "cosine" | "euclidean" | "dot-product";

export interface VectorConfig {
    readonly dim: number;
    readonly binding: string;
    readonly metric: VectorMetric;
}

export interface NormalizedVectorConfig {
    readonly dimensions: number;
    readonly binding: string;
    readonly metric: VectorMetric;
}

export interface InlineVectorConfig {
    readonly dim: number;
}

export interface VectorColumnHandle {
    /** Stable logical id stored in the vector column. */
    readonly id: string;
}

export type VectorColumn = Column & {
    readonly _: { readonly data: VectorColumnHandle | null };
};

export type VectorRowPk = string | number | boolean;
export type VectorValues = Float32Array | readonly number[];

/** Vector writes available inside one organization mutation transaction. */
export interface VectorMutationApi {
    set(column: VectorColumn, rowPk: VectorRowPk, values: VectorValues): VectorColumnHandle;
    delete(column: VectorColumn, rowPk: VectorRowPk): void;
}

export interface VectorSearchInput {
    readonly organizationId: string;
    readonly values: VectorValues;
    readonly limit?: number;
}

export interface VectorSearchResult extends Readonly<Record<string, string | number>> {
    readonly rowPk: string;
    readonly score: number;
}

/** The planned-query result marker carried by `searchVector`. */
export interface VectorSearchBuilder {
    readonly _: { readonly result: VectorSearchResult[] };
}

export interface NormalizedVectorSearchBuilder {
    readonly column: VectorColumn;
    readonly organizationId: string;
    readonly values: readonly number[];
    readonly limit: number;
}

const vectorSearchBuilders = new WeakMap<object, NormalizedVectorSearchBuilder>();

export function normalizeVectorConfig(config: VectorConfig | undefined): NormalizedVectorConfig {
    if (!config || !Number.isSafeInteger(config.dim) || config.dim < 1 || config.dim > CDB_VECTOR_MAX_DIMENSIONS) {
        throw new TypeError(`vector dim must be an integer from 1 through ${CDB_VECTOR_MAX_DIMENSIONS}`);
    }
    if (typeof config.binding !== "string" || !VECTOR_BINDING.test(config.binding)) {
        throw new TypeError("vector binding must be a valid Worker binding name");
    }
    if (config.metric !== "cosine" && config.metric !== "euclidean" && config.metric !== "dot-product") {
        throw new TypeError("vector metric must be cosine, euclidean, or dot-product");
    }
    return Object.freeze({ dimensions: config.dim, binding: config.binding, metric: config.metric });
}

const vectorTypeParams = {
    dataType(config: VectorConfig | undefined): string {
        normalizeVectorConfig(config);
        return "text";
    },
    toDriver(value: VectorColumnHandle | null): string {
        return value ? value.id : "";
    },
    fromDriver(value: string): VectorColumnHandle | null {
        if (!value) return null;
        return { id: value };
    },
};

/** Nullable Vectorize-backed column for an organization-owned cdbTable. */
export const vector = customType<{
    data: VectorColumnHandle | null;
    driverData: string;
    config: VectorConfig;
}>(vectorTypeParams);

export function isChardbVectorColumn(column: Column): column is VectorColumn {
    if (column.dataType !== "custom") return false;
    const config = (column as unknown as { config?: { customTypeParams?: object } }).config;
    return config?.customTypeParams === vectorTypeParams;
}

export function getChardbVectorColumnConfig(column: Column): NormalizedVectorConfig | undefined {
    if (!isChardbVectorColumn(column)) return undefined;
    const config = (column as unknown as { config?: { fieldConfig?: VectorConfig } }).config;
    return normalizeVectorConfig(config?.fieldConfig);
}

function normalizeFloat32Values(values: VectorValues, dimensions: number): readonly number[] {
    if (!(values instanceof Float32Array) && !Array.isArray(values)) {
        throw new TypeError("vector values must be a Float32Array or an array of numbers");
    }
    if (values.length !== dimensions) {
        throw new RangeError(`vector values must contain exactly ${dimensions} numbers`);
    }
    const normalized = Array.from(values, value => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new TypeError("vector values must contain only finite numbers");
        }
        const rounded = new Float32Array([value])[0];
        if (rounded === undefined || !Number.isFinite(rounded)) {
            throw new RangeError("vector values must fit in finite float32 values");
        }
        return rounded;
    });
    return Object.freeze(normalized);
}

/** Build one organization-scoped Vectorize query for `api.query`. */
export function searchVector(column: VectorColumn, input: VectorSearchInput): VectorSearchBuilder {
    if (typeof column !== "object" || column === null) {
        throw new TypeError("searchVector column must be a vector column");
    }
    const config = getChardbVectorColumnConfig(column);
    if (!config) throw new TypeError("searchVector column must be a vector column");
    if (
        !input ||
        typeof input !== "object" ||
        typeof input.organizationId !== "string" ||
        input.organizationId.length === 0 ||
        TEXT.encode(input.organizationId).byteLength > 256
    ) {
        throw new TypeError("searchVector organizationId must contain 1 through 256 UTF-8 bytes");
    }
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CDB_VECTOR_SEARCH_MAX_RESULTS) {
        throw new RangeError(`searchVector limit must be an integer from 1 through ${CDB_VECTOR_SEARCH_MAX_RESULTS}`);
    }
    const builder = Object.freeze(Object.create(null)) as VectorSearchBuilder;
    vectorSearchBuilders.set(
        builder,
        Object.freeze({
            column,
            organizationId: input.organizationId,
            values: normalizeFloat32Values(input.values, config.dimensions),
            limit,
        })
    );
    return builder;
}

/** Internal guard used by the registered-query compiler. */
export function isChardbVectorSearchBuilder(value: unknown): value is VectorSearchBuilder {
    return typeof value === "object" && value !== null && vectorSearchBuilders.has(value);
}

/** Internal accessor. Copies and object lookalikes are rejected. */
export function normalizeChardbVectorSearchBuilder(value: unknown): NormalizedVectorSearchBuilder {
    if (!isChardbVectorSearchBuilder(value)) {
        throw new TypeError("value is not a searchVector builder created by this module");
    }
    const normalized = vectorSearchBuilders.get(value);
    if (!normalized) throw new TypeError("searchVector builder payload is unavailable");
    return normalized;
}

/** Inline BLOB-stored embedding for brute-force in-partition search. */
export const inlineVector = customType<{
    data: Float32Array;
    driverData: Uint8Array;
    config: InlineVectorConfig;
}>({
    dataType(config) {
        const dimensions = config?.dim;
        if (
            typeof dimensions !== "number" ||
            !Number.isSafeInteger(dimensions) ||
            dimensions < 1 ||
            dimensions > CDB_INLINE_VECTOR_MAX_DIMENSIONS
        ) {
            throw new TypeError(
                `inline vector dim must be an integer from 1 through ${CDB_INLINE_VECTOR_MAX_DIMENSIONS}`
            );
        }
        return "blob";
    },
    toDriver(value: Float32Array): Uint8Array {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    },
    fromDriver(value: Uint8Array): Float32Array {
        return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    },
});

/** Cosine similarity. Used by inline brute-force k-NN. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) throw new RangeError(`dim mismatch: ${a.length} vs ${b.length}`);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i] as number;
        const bv = b[i] as number;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
