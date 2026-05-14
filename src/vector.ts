/**
 * `chardb/server` vector column types.
 *
 * `vector('col', { dim })` — backed by Cloudflare Vectorize (eventually
 * consistent, ≤60s). See
 * https://developers.cloudflare.com/vectorize/reference/client-api/ for the
 * underlying `insert` / `upsert` / `query` surface.
 *
 * `inlineVector('col', { dim })` — BLOB column; brute-force k-NN inside a
 * single partition. Reads against `inlineVector` join the surrounding
 * mutation's strict-serializable transaction.
 */

import { customType } from "drizzle-orm/sqlite-core";

export interface VectorConfig {
    readonly dim: number;
    /** Optional Vectorize index name override (defaults to `<logicalDB>/<table>/<column>`). */
    readonly indexName?: string;
}

export interface VectorColumnHandle {
    /** Embedding vector (dim-length). */
    readonly value: Float32Array;
    /** Stable id assigned by chardb (== row id by default). */
    readonly id: string;
}

/** Vectorize-backed column. The row holds only the Vectorize document id. */
export const vector = customType<{
    data: VectorColumnHandle | null;
    driverData: string;
    config: VectorConfig;
}>({
    dataType() {
        return "text";
    },
    toDriver(value: VectorColumnHandle | null): string {
        return value ? value.id : "";
    },
    fromDriver(value: string): VectorColumnHandle | null {
        if (!value) return null;
        return { id: value, value: new Float32Array(0) };
    },
});

/** Inline BLOB-stored embedding for brute-force in-partition search. */
export const inlineVector = customType<{
    data: Float32Array;
    driverData: Uint8Array;
    config: VectorConfig;
}>({
    dataType() {
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
