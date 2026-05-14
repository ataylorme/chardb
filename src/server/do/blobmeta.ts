/**
 * `BlobMeta` DO. Hash-sharded by `blobKey`; default 8 instances.
 *
 * Blob refcount lives here, not on per-shard triggers — this is the only model
 * that doesn't orphan or 404 under a Resharder cutover or a PITR restore.
 */

import { DurableObject } from "cloudflare:workers";
import { adaptSqlStorage } from "./sql_adapter.ts";

const BLOBMETA_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_blob (
  id            TEXT PRIMARY KEY,
  bucket        TEXT NOT NULL,
  key           TEXT NOT NULL,
  sha256        BLOB NOT NULL,
  size          INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  refcount      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_status ON _chardb_blob (status);
CREATE INDEX IF NOT EXISTS idx_blob_last_seen ON _chardb_blob (last_seen_at);
` as const;

export type BlobStatus = "pending" | "live" | "quarantined";

export interface BlobMetaEnv {
    readonly CDB_R2?: unknown;
}

export class BlobMeta extends DurableObject<BlobMetaEnv> {
    private bootstrapped = false;

    constructor(state: DurableObjectState, env: BlobMetaEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    private bootstrap(): void {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        for (const stmt of BLOBMETA_DDL.split(";")
            .map(s => s.trim())
            .filter(Boolean))
            sql.exec(stmt);
        this.bootstrapped = true;
    }

    /** Reserve a (bucket, key) pair before R2 upload starts. */
    async reserve(args: {
        id: string;
        bucket: string;
        key: string;
        contentType: string;
    }): Promise<void> {
        const now = Date.now();
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT INTO _chardb_blob (id, bucket, key, sha256, size, content_type, refcount, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 0, ?, 0, 'pending', ?, ?)`,
            args.id,
            args.bucket,
            args.key,
            new Uint8Array(0),
            args.contentType,
            now,
            now
        );
    }

    async finalize(args: { id: string; sha256: Uint8Array; size: number }): Promise<void> {
        const now = Date.now();
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            "UPDATE _chardb_blob SET sha256 = ?, size = ?, status = 'live', last_seen_at = ? WHERE id = ?",
            args.sha256,
            args.size,
            now,
            args.id
        );
    }

    async incRefcount(id: string, delta: number): Promise<number> {
        let next = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec("UPDATE _chardb_blob SET refcount = refcount + ? WHERE id = ?", delta, id);
            const row = sql.one<{ refcount: number }>("SELECT refcount FROM _chardb_blob WHERE id = ?", id);
            next = row?.refcount ?? 0;
            if (next <= 0) {
                sql.exec("UPDATE _chardb_blob SET status = 'quarantined' WHERE id = ?", id);
            }
        });
        return next;
    }
}
