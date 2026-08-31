import { CdbError } from "../../errors.ts";
import type { CatalogSql } from "./catalog-schema-store.ts";

export const CATALOG_ORGANIZATION_DELETION_BATCH_SIZE = 16;
export const CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE = 32;
export const CATALOG_ORGANIZATION_DELETION_RETRY_INITIAL_MS = 1_000;
export const CATALOG_ORGANIZATION_DELETION_RETRY_MAX_MS = 60_000;

const DDL = `
CREATE TABLE IF NOT EXISTS catalog_organization_deletions (
  organization_id TEXT PRIMARY KEY,
  vshard INTEGER NOT NULL CHECK (vshard >= 0 AND vshard < 16384),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER,
  last_error TEXT,
  CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status = 'complete' AND completed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS catalog_organization_deletions_due
  ON catalog_organization_deletions (status, next_attempt_at, organization_id);
CREATE INDEX IF NOT EXISTS catalog_organization_deletions_barrier_status
  ON catalog_organization_deletions (vshard, status);
CREATE TABLE IF NOT EXISTS catalog_organization_deletion_shards (
  organization_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (organization_id, shard_id),
  CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status = 'complete' AND completed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS catalog_organization_deletion_shards_due
  ON catalog_organization_deletion_shards (status, next_attempt_at, organization_id, shard_id);
` as const;

export interface CatalogOrganizationDeletion {
    readonly organizationId: string;
    readonly vshard: number;
    readonly status: "pending" | "complete";
    readonly attempts: number;
    readonly nextAttemptAt: number;
    readonly createdAt: number;
    readonly completedAt: number | null;
    readonly lastError: string | null;
}

interface StoredDeletion {
    readonly organization_id: string;
    readonly vshard: number | bigint;
    readonly status: CatalogOrganizationDeletion["status"];
    readonly attempts: number | bigint;
    readonly next_attempt_at: number | bigint;
    readonly created_at: number | bigint;
    readonly completed_at: number | bigint | null;
    readonly last_error: string | null;
}

export interface CatalogOrganizationDeletionShard {
    readonly organizationId: string;
    readonly vshard: number;
    readonly shardId: string;
    readonly status: "pending" | "complete";
    readonly attempts: number;
    readonly nextAttemptAt: number;
    readonly createdAt: number;
    readonly completedAt: number | null;
    readonly lastError: string | null;
}

interface StoredDeletionShard {
    readonly organization_id: string;
    readonly vshard: number | bigint;
    readonly shard_id: string;
    readonly status: CatalogOrganizationDeletionShard["status"];
    readonly attempts: number | bigint;
    readonly next_attempt_at: number | bigint;
    readonly created_at: number | bigint;
    readonly completed_at: number | bigint | null;
    readonly last_error: string | null;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `organization deletion: ${message}` });
}

function boundedOrganizationId(value: string): string {
    if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 256) {
        invalid("organization id is invalid");
    }
    return value;
}

function safeTime(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) invalid("timestamp is invalid");
    return value;
}

function boundedShardId(value: string): string {
    if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 256) {
        invalid("shard id is invalid");
    }
    return value;
}

function project(row: StoredDeletion): CatalogOrganizationDeletion {
    return Object.freeze({
        organizationId: row.organization_id,
        vshard: Number(row.vshard),
        status: row.status,
        attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        createdAt: Number(row.created_at),
        completedAt: row.completed_at === null ? null : Number(row.completed_at),
        lastError: row.last_error,
    });
}

function projectShard(row: StoredDeletionShard): CatalogOrganizationDeletionShard {
    return Object.freeze({
        organizationId: row.organization_id,
        vshard: Number(row.vshard),
        shardId: row.shard_id,
        status: row.status,
        attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        createdAt: Number(row.created_at),
        completedAt: row.completed_at === null ? null : Number(row.completed_at),
        lastError: row.last_error,
    });
}

export function initializeCatalogOrganizationDeletionStore(sql: CatalogSql): void {
    for (const statement of DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
}

/** Permanent identity fence plus retryable cleanup work. Completed rows are deliberately retained. */
export class CatalogOrganizationDeletionStore {
    readonly sql: CatalogSql;

    constructor(sql: CatalogSql) {
        this.sql = sql;
    }

    record(organizationId: string, vshard: number, nowMs: number): CatalogOrganizationDeletion {
        boundedOrganizationId(organizationId);
        safeTime(nowMs);
        if (!Number.isSafeInteger(vshard) || vshard < 0 || vshard >= 16_384) invalid("vshard is invalid");
        this.sql.exec(
            `INSERT OR IGNORE INTO catalog_organization_deletions
              (organization_id, vshard, status, attempts, next_attempt_at, created_at, completed_at, last_error)
             VALUES (?, ?, 'pending', 0, ?, ?, NULL, NULL)`,
            organizationId,
            vshard,
            nowMs,
            nowMs
        );
        return this.require(organizationId);
    }

    isDeleted(organizationId: string): boolean {
        boundedOrganizationId(organizationId);
        return (
            this.sql.one<{ present: number }>(
                "SELECT 1 AS present FROM catalog_organization_deletions WHERE organization_id = ?",
                organizationId
            ) !== null
        );
    }

    due(
        nowMs: number,
        limit: number = CATALOG_ORGANIZATION_DELETION_BATCH_SIZE
    ): readonly CatalogOrganizationDeletion[] {
        safeTime(nowMs);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_ORGANIZATION_DELETION_BATCH_SIZE) {
            invalid(`batch must be from 1 through ${CATALOG_ORGANIZATION_DELETION_BATCH_SIZE}`);
        }
        return this.sql
            .all<StoredDeletion>(
                `SELECT * FROM catalog_organization_deletions
                 WHERE status = 'pending' AND next_attempt_at <= ?
                   AND NOT EXISTS (
                     SELECT 1 FROM catalog_organization_deletion_shards AS shards
                     WHERE shards.organization_id = catalog_organization_deletions.organization_id
                   )
                 ORDER BY next_attempt_at, organization_id
                 LIMIT ?`,
                nowMs,
                limit
            )
            .map(project);
    }

    recordShards(
        organizationId: string,
        shardIds: readonly string[],
        nowMs: number
    ): readonly CatalogOrganizationDeletionShard[] {
        boundedOrganizationId(organizationId);
        safeTime(nowMs);
        const uniqueShardIds = [...new Set(shardIds.map(boundedShardId))].sort();
        if (uniqueShardIds.length === 0) invalid("shard inventory is empty");
        const deletion = this.require(organizationId);
        if (deletion.status === "complete") return this.shards(organizationId);
        for (const shardId of uniqueShardIds) {
            this.sql.exec(
                `INSERT OR IGNORE INTO catalog_organization_deletion_shards
                  (organization_id, shard_id, status, attempts, next_attempt_at, created_at, completed_at, last_error)
                 VALUES (?, ?, 'pending', 0, ?, ?, NULL, NULL)`,
                organizationId,
                shardId,
                nowMs,
                nowMs
            );
        }
        return this.shards(organizationId);
    }

    dueShards(
        nowMs: number,
        limit: number = CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE
    ): readonly CatalogOrganizationDeletionShard[] {
        safeTime(nowMs);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE) {
            invalid(`shard batch must be from 1 through ${CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE}`);
        }
        return this.sql
            .all<StoredDeletionShard>(
                `SELECT shards.*, deletions.vshard
                 FROM catalog_organization_deletion_shards AS shards
                 INNER JOIN catalog_organization_deletions AS deletions
                   ON deletions.organization_id = shards.organization_id
                 WHERE deletions.status = 'pending'
                   AND shards.status = 'pending'
                   AND shards.next_attempt_at <= ?
                 ORDER BY shards.next_attempt_at, shards.shard_id, shards.organization_id
                 LIMIT ?`,
                nowMs,
                limit
            )
            .map(projectShard);
    }

    completeShard(organizationId: string, shardId: string, nowMs: number): CatalogOrganizationDeletionShard {
        boundedOrganizationId(organizationId);
        boundedShardId(shardId);
        safeTime(nowMs);
        this.requireShard(organizationId, shardId);
        this.sql.exec(
            `UPDATE catalog_organization_deletion_shards
             SET status = 'complete', completed_at = ?, next_attempt_at = ?, last_error = NULL
             WHERE organization_id = ? AND shard_id = ? AND status = 'pending'`,
            nowMs,
            nowMs,
            organizationId,
            shardId
        );
        const remaining = this.sql.one<{ present: number }>(
            `SELECT 1 AS present FROM catalog_organization_deletion_shards
             WHERE organization_id = ? AND status = 'pending' LIMIT 1`,
            organizationId
        );
        if (!remaining) this.complete(organizationId, nowMs);
        return this.requireShard(organizationId, shardId);
    }

    deferShard(
        organizationId: string,
        shardId: string,
        nowMs: number,
        error?: string
    ): CatalogOrganizationDeletionShard {
        boundedOrganizationId(organizationId);
        boundedShardId(shardId);
        safeTime(nowMs);
        const current = this.requireShard(organizationId, shardId);
        if (current.status === "complete") return current;
        const attempts = Math.min(current.attempts + 1, 31);
        const delay = Math.min(
            CATALOG_ORGANIZATION_DELETION_RETRY_MAX_MS,
            CATALOG_ORGANIZATION_DELETION_RETRY_INITIAL_MS * 2 ** Math.min(attempts - 1, 16)
        );
        const lastError = error === undefined ? null : String(error).slice(0, 512);
        this.sql.exec(
            `UPDATE catalog_organization_deletion_shards
             SET attempts = ?, next_attempt_at = ?, last_error = ?
             WHERE organization_id = ? AND shard_id = ? AND status = 'pending'`,
            attempts,
            nowMs + delay,
            lastError,
            organizationId,
            shardId
        );
        return this.requireShard(organizationId, shardId);
    }

    defer(organizationId: string, nowMs: number, error?: string): CatalogOrganizationDeletion {
        boundedOrganizationId(organizationId);
        safeTime(nowMs);
        const current = this.require(organizationId);
        if (current.status === "complete") return current;
        const attempts = Math.min(current.attempts + 1, 31);
        const delay = Math.min(
            CATALOG_ORGANIZATION_DELETION_RETRY_MAX_MS,
            CATALOG_ORGANIZATION_DELETION_RETRY_INITIAL_MS * 2 ** Math.min(attempts - 1, 16)
        );
        const lastError = error === undefined ? null : String(error).slice(0, 512);
        this.sql.exec(
            `UPDATE catalog_organization_deletions
             SET attempts = ?, next_attempt_at = ?, last_error = ?
             WHERE organization_id = ? AND status = 'pending'`,
            attempts,
            nowMs + delay,
            lastError,
            organizationId
        );
        return this.require(organizationId);
    }

    deferUntil(organizationId: string, nowMs: number, deadline: number): CatalogOrganizationDeletion {
        boundedOrganizationId(organizationId);
        safeTime(nowMs);
        safeTime(deadline);
        if (deadline <= nowMs) invalid("retry deadline must be in the future");
        const current = this.require(organizationId);
        if (current.status === "complete") return current;
        this.sql.exec(
            `UPDATE catalog_organization_deletions
             SET next_attempt_at = ?, last_error = NULL
             WHERE organization_id = ? AND status = 'pending'`,
            deadline,
            organizationId
        );
        return this.require(organizationId);
    }

    complete(organizationId: string, nowMs: number): CatalogOrganizationDeletion {
        boundedOrganizationId(organizationId);
        safeTime(nowMs);
        const current = this.require(organizationId);
        if (current.status === "complete") return current;
        this.sql.exec(
            `UPDATE catalog_organization_deletions
             SET status = 'complete', completed_at = ?, next_attempt_at = ?, last_error = NULL
             WHERE organization_id = ? AND status = 'pending'`,
            nowMs,
            nowMs,
            organizationId
        );
        return this.require(organizationId);
    }

    nextPendingAt(): number | null {
        const row = this.sql.one<{ next_attempt_at: number | bigint | null }>(
            `SELECT MIN(next_attempt_at) AS next_attempt_at FROM (
               SELECT deletions.next_attempt_at
               FROM catalog_organization_deletions AS deletions
               WHERE deletions.status = 'pending'
                 AND NOT EXISTS (
                   SELECT 1 FROM catalog_organization_deletion_shards AS shards
                   WHERE shards.organization_id = deletions.organization_id
                 )
               UNION ALL
               SELECT shards.next_attempt_at
               FROM catalog_organization_deletion_shards AS shards
               INNER JOIN catalog_organization_deletions AS deletions
                 ON deletions.organization_id = shards.organization_id
               WHERE deletions.status = 'pending' AND shards.status = 'pending'
             )`
        );
        if (row?.next_attempt_at === null || row?.next_attempt_at === undefined) return null;
        return Number(row.next_attempt_at);
    }

    read(organizationId: string): CatalogOrganizationDeletion | null {
        boundedOrganizationId(organizationId);
        const row = this.sql.one<StoredDeletion>(
            "SELECT * FROM catalog_organization_deletions WHERE organization_id = ?",
            organizationId
        );
        return row ? project(row) : null;
    }

    shards(organizationId: string): readonly CatalogOrganizationDeletionShard[] {
        boundedOrganizationId(organizationId);
        return this.sql
            .all<StoredDeletionShard>(
                `SELECT shards.*, deletions.vshard
                 FROM catalog_organization_deletion_shards AS shards
                 INNER JOIN catalog_organization_deletions AS deletions
                   ON deletions.organization_id = shards.organization_id
                 WHERE shards.organization_id = ?
                 ORDER BY shards.shard_id`,
                organizationId
            )
            .map(projectShard);
    }

    private require(organizationId: string): CatalogOrganizationDeletion {
        const row = this.read(organizationId);
        if (!row) invalid("organization deletion does not exist");
        return row;
    }

    private requireShard(organizationId: string, shardId: string): CatalogOrganizationDeletionShard {
        const row = this.sql.one<StoredDeletionShard>(
            `SELECT shards.*, deletions.vshard
             FROM catalog_organization_deletion_shards AS shards
             INNER JOIN catalog_organization_deletions AS deletions
               ON deletions.organization_id = shards.organization_id
             WHERE shards.organization_id = ? AND shards.shard_id = ?`,
            organizationId,
            shardId
        );
        if (!row) invalid("organization deletion shard does not exist");
        return projectShard(row);
    }
}
