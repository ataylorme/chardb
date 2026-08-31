import type { SyncSql } from "../../oplog/wrapper.ts";

const CATALOG_BARRIER_DDL = `
CREATE TABLE IF NOT EXISTS catalog_barrier (
  barrier_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  expected_shards TEXT NOT NULL,
  ack_shards TEXT NOT NULL,
  bookmarks TEXT NOT NULL,
  tenant_prefix TEXT
);`;

export interface CatalogBarrierRecord {
    readonly barrierId: string;
    readonly ts: number;
    readonly expectedShards: readonly string[];
    readonly tenantPrefix?: string;
}

export interface CatalogBarrierAcknowledgement {
    readonly barrierId: string;
    readonly shardId: string;
    readonly bookmark: number;
}

export interface OpenCatalogBarrier {
    readonly barrierId: string;
    readonly ts: number;
    readonly missing: readonly string[];
}

interface StoredCatalogBarrierState {
    readonly expected_shards: string;
    readonly ack_shards: string;
    readonly bookmarks: string;
}

interface StoredOpenCatalogBarrier {
    readonly barrier_id: string;
    readonly ts: number;
    readonly expected_shards: string;
    readonly ack_shards: string;
}

export function initializeCatalogBarrierStorage(sql: SyncSql): void {
    sql.exec(CATALOG_BARRIER_DDL);
}

export function recordCatalogBarrier(sql: SyncSql, input: CatalogBarrierRecord): void {
    sql.exec(
        `INSERT OR REPLACE INTO catalog_barrier
         (barrier_id, ts, expected_shards, ack_shards, bookmarks, tenant_prefix)
         VALUES (?, ?, ?, '[]', '{}', ?)`,
        input.barrierId,
        input.ts,
        JSON.stringify(input.expectedShards),
        input.tenantPrefix ?? null
    );
}

/** Run inside the Catalog storage transaction that owns the acknowledgement RPC. */
export function acknowledgeCatalogBarrier(
    sql: SyncSql,
    input: CatalogBarrierAcknowledgement
): { readonly complete: boolean } {
    const row = sql.one<StoredCatalogBarrierState>(
        "SELECT expected_shards, ack_shards, bookmarks FROM catalog_barrier WHERE barrier_id = ?",
        input.barrierId
    );
    if (!row) return { complete: false };

    const expected = JSON.parse(row.expected_shards) as string[];
    const acknowledgements = new Set<string>(JSON.parse(row.ack_shards) as string[]);
    const bookmarks = JSON.parse(row.bookmarks) as Record<string, number>;
    acknowledgements.add(input.shardId);
    bookmarks[input.shardId] = input.bookmark;
    sql.exec(
        "UPDATE catalog_barrier SET ack_shards = ?, bookmarks = ? WHERE barrier_id = ?",
        JSON.stringify([...acknowledgements].sort()),
        JSON.stringify(bookmarks),
        input.barrierId
    );
    return { complete: expected.every(shardId => acknowledgements.has(shardId)) };
}

export function listOpenCatalogBarriers(sql: SyncSql): readonly OpenCatalogBarrier[] {
    const open: OpenCatalogBarrier[] = [];
    for (const row of sql.all<StoredOpenCatalogBarrier>(
        "SELECT barrier_id, ts, expected_shards, ack_shards FROM catalog_barrier ORDER BY ts ASC"
    )) {
        const expected = JSON.parse(row.expected_shards) as string[];
        const acknowledgements = new Set<string>(JSON.parse(row.ack_shards) as string[]);
        const missing = expected.filter(shardId => !acknowledgements.has(shardId));
        if (missing.length > 0) open.push({ barrierId: row.barrier_id, ts: row.ts, missing });
    }
    return open;
}
