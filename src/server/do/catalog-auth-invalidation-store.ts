import { CdbError } from "../../errors.ts";
import { VSHARD_COUNT } from "../../vshard.ts";
import type { AuthEpochScope } from "./catalog-authority-store.ts";
import type { CatalogSql } from "./catalog-schema-store.ts";

export const CATALOG_AUTH_INVALIDATION_BATCH_SIZE = 32;
export const CATALOG_AUTH_INVALIDATION_TARGET_LIMIT = VSHARD_COUNT * 2;
export const CATALOG_AUTH_INVALIDATION_RETRY_INITIAL_MS = 1_000;
export const CATALOG_AUTH_INVALIDATION_RETRY_MAX_MS = 60_000;

const DDL = `
CREATE TABLE IF NOT EXISTS catalog_auth_invalidation_targets (
  scope           TEXT NOT NULL CHECK (scope IN ('tenant', 'principal')),
  scope_id        TEXT NOT NULL,
  shard_id        TEXT NOT NULL,
  epoch           INTEGER NOT NULL CHECK (epoch > 0),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at      INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
  last_error      TEXT,
  PRIMARY KEY (scope, scope_id, shard_id)
);
CREATE INDEX IF NOT EXISTS catalog_auth_invalidation_targets_due
ON catalog_auth_invalidation_targets (next_attempt_at, shard_id, scope, scope_id);
CREATE TABLE IF NOT EXISTS catalog_auth_invalidation_global (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch           INTEGER NOT NULL CHECK (epoch > 0),
  cursor_shard_id TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at      INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
  last_error      TEXT
);
CREATE TABLE IF NOT EXISTS catalog_auth_invalidation_principals (
  scope_id        TEXT PRIMARY KEY,
  epoch           INTEGER NOT NULL CHECK (epoch > 0),
  cursor_shard_id TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at      INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS catalog_auth_invalidation_principals_due
ON catalog_auth_invalidation_principals (next_attempt_at, scope_id);
` as const;

const SCOPE_ID_MAX_BYTES = 256;
const SCOPE_ID = /^[^\0]+$/;
const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CatalogAuthInvalidationTarget {
    readonly scope: Exclude<AuthEpochScope, "global">;
    readonly scopeId: string;
    readonly shardId: string;
    readonly epoch: number;
    readonly attempts: number;
    readonly nextAttemptAt: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly lastError: string | null;
}

export interface CatalogGlobalAuthInvalidation {
    readonly epoch: number;
    readonly cursorShardId: string | null;
    readonly attempts: number;
    readonly nextAttemptAt: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly lastError: string | null;
}

export interface CatalogPrincipalAuthInvalidation extends CatalogGlobalAuthInvalidation {
    readonly scopeId: string;
}

interface StoredTarget {
    readonly scope: "tenant" | "principal";
    readonly scope_id: string;
    readonly shard_id: string;
    readonly epoch: number;
    readonly attempts: number;
    readonly next_attempt_at: number;
    readonly created_at: number;
    readonly updated_at: number;
    readonly last_error: string | null;
}

interface StoredGlobal {
    readonly epoch: number;
    readonly cursor_shard_id: string | null;
    readonly attempts: number;
    readonly next_attempt_at: number;
    readonly created_at: number;
    readonly updated_at: number;
    readonly last_error: string | null;
}

interface StoredPrincipal extends StoredGlobal {
    readonly scope_id: string;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `Catalog auth invalidation: ${message}` });
}

function capacityExceeded(): never {
    throw new CdbError({
        code: "CDB_RATE_LIMITED",
        message: `Catalog auth invalidation target outbox reached its ${CATALOG_AUTH_INVALIDATION_TARGET_LIMIT}-row limit`,
        retryAfterMs: CATALOG_AUTH_INVALIDATION_RETRY_INITIAL_MS,
        hint: "wait for Catalog alarm delivery before retrying the auth mutation",
    });
}

function safeTime(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) invalid("timestamp is invalid");
}

function safeEpoch(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) invalid("epoch is invalid");
}

function boundedScopeId(value: string): string {
    if (
        typeof value !== "string" ||
        !SCOPE_ID.test(value) ||
        new TextEncoder().encode(value).byteLength > SCOPE_ID_MAX_BYTES
    ) {
        invalid("scope id is invalid");
    }
    return value;
}

function boundedShardId(value: string): string {
    if (typeof value !== "string" || !SHARD_ID.test(value)) invalid("shard id is invalid");
    return value;
}

function projectTarget(row: StoredTarget): CatalogAuthInvalidationTarget {
    return Object.freeze({
        scope: row.scope,
        scopeId: row.scope_id,
        shardId: row.shard_id,
        epoch: Number(row.epoch),
        attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastError: row.last_error,
    });
}

function projectGlobal(row: StoredGlobal): CatalogGlobalAuthInvalidation {
    return Object.freeze({
        epoch: Number(row.epoch),
        cursorShardId: row.cursor_shard_id,
        attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastError: row.last_error,
    });
}

function projectPrincipal(row: StoredPrincipal): CatalogPrincipalAuthInvalidation {
    return Object.freeze({ scopeId: row.scope_id, ...projectGlobal(row) });
}

function retryDelay(attempts: number): number {
    return Math.min(
        CATALOG_AUTH_INVALIDATION_RETRY_MAX_MS,
        CATALOG_AUTH_INVALIDATION_RETRY_INITIAL_MS * 2 ** Math.min(Math.max(0, attempts - 1), 16)
    );
}

export function initializeCatalogAuthInvalidationStore(sql: CatalogSql): void {
    for (const statement of DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
}

/** Durable coalescing handoff from Catalog auth epochs to the owning Cdbs. */
export class CatalogAuthInvalidationStore {
    constructor(readonly sql: CatalogSql) {}

    enqueueTargets(
        scope: Exclude<AuthEpochScope, "global">,
        scopeId: string,
        epoch: number,
        shardIds: readonly string[],
        nowMs: number
    ): readonly CatalogAuthInvalidationTarget[] {
        if (scope !== "tenant" && scope !== "principal") invalid("target scope is invalid");
        boundedScopeId(scopeId);
        safeEpoch(epoch);
        safeTime(nowMs);
        const targets = [...new Set(shardIds.map(boundedShardId))].sort();
        if (targets.length < 1 || targets.length > 3)
            invalid("target shard inventory must contain from one through three shards");

        const count = this.sql.one<{ count: number }>(
            "SELECT COUNT(*) AS count FROM catalog_auth_invalidation_targets"
        )?.count;
        if (!Number.isSafeInteger(count) || (count as number) < 0) {
            throw new CdbError({ code: "CDB_INVARIANT", message: "Catalog auth invalidation target count is invalid" });
        }
        let projected = count as number;
        for (const shardId of targets) {
            const existing = this.sql.one<{ present: number }>(
                `SELECT 1 AS present FROM catalog_auth_invalidation_targets
                 WHERE scope = ? AND scope_id = ? AND shard_id = ?`,
                scope,
                scopeId,
                shardId
            );
            if (!existing) projected++;
        }
        if (projected > CATALOG_AUTH_INVALIDATION_TARGET_LIMIT) capacityExceeded();

        for (const shardId of targets) {
            this.sql.exec(
                `INSERT INTO catalog_auth_invalidation_targets
                  (scope, scope_id, shard_id, epoch, attempts, next_attempt_at, created_at, updated_at, last_error)
                 VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)
                 ON CONFLICT(scope, scope_id, shard_id) DO UPDATE SET
                   epoch = MAX(epoch, excluded.epoch),
                   attempts = CASE WHEN excluded.epoch > epoch THEN 0 ELSE attempts END,
                   next_attempt_at = CASE WHEN excluded.epoch > epoch THEN excluded.next_attempt_at ELSE next_attempt_at END,
                   updated_at = CASE WHEN excluded.epoch > epoch THEN excluded.updated_at ELSE updated_at END,
                   last_error = CASE WHEN excluded.epoch > epoch THEN NULL ELSE last_error END`,
                scope,
                scopeId,
                shardId,
                epoch,
                nowMs,
                nowMs,
                nowMs
            );
        }
        return this.targets(scope, scopeId);
    }

    enqueueGlobal(epoch: number, nowMs: number): CatalogGlobalAuthInvalidation {
        safeEpoch(epoch);
        safeTime(nowMs);
        this.sql.exec(
            `INSERT INTO catalog_auth_invalidation_global
              (singleton, epoch, cursor_shard_id, attempts, next_attempt_at, created_at, updated_at, last_error)
             VALUES (1, ?, NULL, 0, ?, ?, ?, NULL)
             ON CONFLICT(singleton) DO UPDATE SET
               epoch = MAX(epoch, excluded.epoch),
               cursor_shard_id = CASE WHEN excluded.epoch > epoch THEN NULL ELSE cursor_shard_id END,
               attempts = CASE WHEN excluded.epoch > epoch THEN 0 ELSE attempts END,
               next_attempt_at = CASE WHEN excluded.epoch > epoch THEN excluded.next_attempt_at ELSE next_attempt_at END,
               updated_at = CASE WHEN excluded.epoch > epoch THEN excluded.updated_at ELSE updated_at END,
               last_error = CASE WHEN excluded.epoch > epoch THEN NULL ELSE last_error END`,
            epoch,
            nowMs,
            nowMs,
            nowMs
        );
        const result = this.global();
        if (!result) throw new CdbError({ code: "CDB_INVARIANT", message: "global auth invalidation disappeared" });
        return result;
    }

    enqueuePrincipal(scopeId: string, epoch: number, nowMs: number): CatalogPrincipalAuthInvalidation {
        boundedScopeId(scopeId);
        safeEpoch(epoch);
        safeTime(nowMs);
        const count =
            this.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM catalog_auth_invalidation_principals")
                ?.count ?? 0;
        const existing = this.principal(scopeId);
        if (!existing && count >= CATALOG_AUTH_INVALIDATION_TARGET_LIMIT) capacityExceeded();
        this.sql.exec(
            `INSERT INTO catalog_auth_invalidation_principals
              (scope_id, epoch, cursor_shard_id, attempts, next_attempt_at, created_at, updated_at, last_error)
             VALUES (?, ?, NULL, 0, ?, ?, ?, NULL)
             ON CONFLICT(scope_id) DO UPDATE SET
               epoch = MAX(epoch, excluded.epoch),
               cursor_shard_id = CASE WHEN excluded.epoch > epoch THEN NULL ELSE cursor_shard_id END,
               attempts = CASE WHEN excluded.epoch > epoch THEN 0 ELSE attempts END,
               next_attempt_at = CASE WHEN excluded.epoch > epoch THEN excluded.next_attempt_at ELSE next_attempt_at END,
               updated_at = CASE WHEN excluded.epoch > epoch THEN excluded.updated_at ELSE updated_at END,
               last_error = CASE WHEN excluded.epoch > epoch THEN NULL ELSE last_error END`,
            scopeId,
            epoch,
            nowMs,
            nowMs,
            nowMs
        );
        const queued = this.principal(scopeId);
        if (!queued) throw new CdbError({ code: "CDB_INVARIANT", message: "principal auth invalidation disappeared" });
        return queued;
    }

    principal(scopeId: string): CatalogPrincipalAuthInvalidation | null {
        const row = this.sql.one<StoredPrincipal>(
            "SELECT * FROM catalog_auth_invalidation_principals WHERE scope_id = ?",
            scopeId
        );
        return row ? projectPrincipal(row) : null;
    }

    duePrincipal(nowMs: number): CatalogPrincipalAuthInvalidation | null {
        safeTime(nowMs);
        const row = this.sql.one<StoredPrincipal>(
            `SELECT * FROM catalog_auth_invalidation_principals
             WHERE next_attempt_at <= ? ORDER BY next_attempt_at, scope_id LIMIT 1`,
            nowMs
        );
        return row ? projectPrincipal(row) : null;
    }

    advancePrincipal(scopeId: string, epoch: number, cursorShardId: string, nowMs: number): void {
        boundedScopeId(scopeId);
        safeEpoch(epoch);
        boundedShardId(cursorShardId);
        safeTime(nowMs);
        this.sql.exec(
            `UPDATE catalog_auth_invalidation_principals
             SET cursor_shard_id = ?, attempts = 0, next_attempt_at = ?, updated_at = ?, last_error = NULL
             WHERE scope_id = ? AND epoch = ?`,
            cursorShardId,
            nowMs + 1,
            nowMs,
            scopeId,
            epoch
        );
    }

    completePrincipal(scopeId: string, epoch: number): void {
        boundedScopeId(scopeId);
        safeEpoch(epoch);
        this.sql.exec(
            "DELETE FROM catalog_auth_invalidation_principals WHERE scope_id = ? AND epoch = ?",
            scopeId,
            epoch
        );
    }

    deferPrincipal(scopeId: string, epoch: number, nowMs: number, error: unknown): void {
        boundedScopeId(scopeId);
        safeEpoch(epoch);
        safeTime(nowMs);
        const current = this.sql.one<{ attempts: number }>(
            "SELECT attempts FROM catalog_auth_invalidation_principals WHERE scope_id = ? AND epoch = ?",
            scopeId,
            epoch
        );
        if (!current) return;
        const attempts = Math.min(current.attempts + 1, 31);
        this.sql.exec(
            `UPDATE catalog_auth_invalidation_principals
             SET attempts = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
             WHERE scope_id = ? AND epoch = ?`,
            attempts,
            nowMs + retryDelay(attempts),
            nowMs,
            (error instanceof Error ? error.message : String(error)).slice(0, 512),
            scopeId,
            epoch
        );
    }

    dueTargets(nowMs: number, limit = CATALOG_AUTH_INVALIDATION_BATCH_SIZE): readonly CatalogAuthInvalidationTarget[] {
        safeTime(nowMs);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_AUTH_INVALIDATION_BATCH_SIZE) {
            invalid(`target batch must be from one through ${CATALOG_AUTH_INVALIDATION_BATCH_SIZE}`);
        }
        return this.sql
            .all<StoredTarget>(
                `SELECT * FROM catalog_auth_invalidation_targets
                 WHERE next_attempt_at <= ?
                 ORDER BY next_attempt_at, shard_id, scope, scope_id
                 LIMIT ?`,
                nowMs,
                limit
            )
            .map(projectTarget);
    }

    targets(scope: Exclude<AuthEpochScope, "global">, scopeId: string): readonly CatalogAuthInvalidationTarget[] {
        return this.sql
            .all<StoredTarget>(
                `SELECT * FROM catalog_auth_invalidation_targets
                 WHERE scope = ? AND scope_id = ? ORDER BY shard_id`,
                scope,
                scopeId
            )
            .map(projectTarget);
    }

    global(): CatalogGlobalAuthInvalidation | null {
        const row = this.sql.one<StoredGlobal>("SELECT * FROM catalog_auth_invalidation_global WHERE singleton = 1");
        return row ? projectGlobal(row) : null;
    }

    dueGlobal(nowMs: number): CatalogGlobalAuthInvalidation | null {
        safeTime(nowMs);
        const row = this.sql.one<StoredGlobal>(
            "SELECT * FROM catalog_auth_invalidation_global WHERE singleton = 1 AND next_attempt_at <= ?",
            nowMs
        );
        return row ? projectGlobal(row) : null;
    }

    completeTarget(target: Pick<CatalogAuthInvalidationTarget, "scope" | "scopeId" | "shardId" | "epoch">): void {
        this.sql.exec(
            `DELETE FROM catalog_auth_invalidation_targets
             WHERE scope = ? AND scope_id = ? AND shard_id = ? AND epoch = ?`,
            target.scope,
            target.scopeId,
            target.shardId,
            target.epoch
        );
    }

    deferTarget(
        target: Pick<CatalogAuthInvalidationTarget, "scope" | "scopeId" | "shardId" | "epoch">,
        nowMs: number,
        error: unknown
    ): void {
        safeTime(nowMs);
        const current = this.sql.one<{ attempts: number }>(
            `SELECT attempts FROM catalog_auth_invalidation_targets
             WHERE scope = ? AND scope_id = ? AND shard_id = ? AND epoch = ?`,
            target.scope,
            target.scopeId,
            target.shardId,
            target.epoch
        );
        if (!current) return;
        const attempts = Math.min(current.attempts + 1, 31);
        this.sql.exec(
            `UPDATE catalog_auth_invalidation_targets
             SET attempts = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
             WHERE scope = ? AND scope_id = ? AND shard_id = ? AND epoch = ?`,
            attempts,
            nowMs + retryDelay(attempts),
            nowMs,
            (error instanceof Error ? error.message : String(error)).slice(0, 512),
            target.scope,
            target.scopeId,
            target.shardId,
            target.epoch
        );
    }

    advanceGlobal(epoch: number, cursorShardId: string, nowMs: number): void {
        safeEpoch(epoch);
        boundedShardId(cursorShardId);
        safeTime(nowMs);
        this.sql.exec(
            `UPDATE catalog_auth_invalidation_global
             SET cursor_shard_id = ?, attempts = 0, next_attempt_at = ?, updated_at = ?, last_error = NULL
             WHERE singleton = 1 AND epoch = ?`,
            cursorShardId,
            nowMs,
            nowMs,
            epoch
        );
    }

    completeGlobal(epoch: number): void {
        safeEpoch(epoch);
        this.sql.exec("DELETE FROM catalog_auth_invalidation_global WHERE singleton = 1 AND epoch = ?", epoch);
    }

    deferGlobal(epoch: number, nowMs: number, error: unknown): void {
        safeEpoch(epoch);
        safeTime(nowMs);
        const current = this.sql.one<{ attempts: number }>(
            "SELECT attempts FROM catalog_auth_invalidation_global WHERE singleton = 1 AND epoch = ?",
            epoch
        );
        if (!current) return;
        const attempts = Math.min(current.attempts + 1, 31);
        this.sql.exec(
            `UPDATE catalog_auth_invalidation_global
             SET attempts = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
             WHERE singleton = 1 AND epoch = ?`,
            attempts,
            nowMs + retryDelay(attempts),
            nowMs,
            (error instanceof Error ? error.message : String(error)).slice(0, 512),
            epoch
        );
    }

    nextPendingAt(): number | null {
        const row = this.sql.one<{ next_attempt_at: number | null }>(
            `SELECT MIN(next_attempt_at) AS next_attempt_at FROM (
               SELECT next_attempt_at FROM catalog_auth_invalidation_targets
               UNION ALL
               SELECT next_attempt_at FROM catalog_auth_invalidation_global
               UNION ALL
               SELECT next_attempt_at FROM catalog_auth_invalidation_principals
             )`
        );
        return row?.next_attempt_at ?? null;
    }
}
