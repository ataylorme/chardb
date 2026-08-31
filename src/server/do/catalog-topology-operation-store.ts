import { CdbError } from "../../errors.ts";
import { VSHARD_COUNT } from "../../vshard.ts";
import type { CatalogSql } from "./catalog-schema-store.ts";

export type CatalogTopologyOperationStatus = "active" | "completed" | "aborted";

/** Terminal records remain permanent retry tombstones, so history has a fixed ceiling. */
export const CATALOG_TOPOLOGY_OPERATION_HISTORY_LIMIT = VSHARD_COUNT;

export interface CatalogTopologyOperationIdentity {
    readonly migrationId: string;
    readonly sourceShard: string;
    readonly destinationShard: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
    readonly startEpoch: number;
    readonly schemaVersion: number;
    readonly schemaEpoch: number;
    readonly schemaDigest: string;
}

export interface CatalogTopologyOperation extends CatalogTopologyOperationIdentity {
    readonly status: CatalogTopologyOperationStatus;
    readonly completedEpoch: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}

interface StoredTopologyOperation {
    readonly migration_id: string;
    readonly source_shard: string;
    readonly destination_shard: string;
    readonly range_lo: number;
    readonly range_hi: number;
    readonly start_epoch: number;
    readonly schema_version: number;
    readonly schema_epoch: number;
    readonly schema_digest: string;
    readonly status: CatalogTopologyOperationStatus;
    readonly completed_epoch: number | null;
    readonly created_at: number;
    readonly updated_at: number;
}

const TOPOLOGY_OPERATION_DDL = `
CREATE TABLE IF NOT EXISTS catalog_topology_operations (
  migration_id TEXT PRIMARY KEY,
  source_shard TEXT NOT NULL,
  destination_shard TEXT NOT NULL,
  range_lo INTEGER NOT NULL,
  range_hi INTEGER NOT NULL,
  start_epoch INTEGER NOT NULL CHECK (start_epoch > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  schema_epoch INTEGER NOT NULL CHECK (schema_epoch > 0),
  schema_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'aborted')),
  completed_epoch INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (range_lo >= 0 AND range_hi >= range_lo AND range_hi < ${VSHARD_COUNT}),
  CHECK (
    (status = 'completed' AND completed_epoch IS NOT NULL AND completed_epoch > start_epoch)
    OR
    (status IN ('active', 'aborted') AND completed_epoch IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_topology_operations_one_active
ON catalog_topology_operations (status) WHERE status = 'active';
` as const;

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCHEMA_DIGEST = /^[a-f0-9]{64}$/;

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message });
}

function assertIdentity(identity: CatalogTopologyOperationIdentity): void {
    if (!MIGRATION_ID.test(identity.migrationId)) invalid("topology migration id is invalid");
    if (!SHARD_ID.test(identity.sourceShard) || !SHARD_ID.test(identity.destinationShard)) {
        invalid("topology shard id is invalid");
    }
    if (identity.sourceShard === identity.destinationShard) invalid("topology source and destination must differ");
    if (
        !Number.isSafeInteger(identity.rangeLo) ||
        !Number.isSafeInteger(identity.rangeHi) ||
        identity.rangeLo < 0 ||
        identity.rangeHi < identity.rangeLo ||
        identity.rangeHi >= VSHARD_COUNT
    ) {
        invalid("topology vshard range is invalid");
    }
    if (!Number.isSafeInteger(identity.startEpoch) || identity.startEpoch < 1) {
        invalid("topology start epoch is invalid");
    }
    if (!Number.isSafeInteger(identity.schemaVersion) || identity.schemaVersion < 0) {
        invalid("topology schema version is invalid");
    }
    if (!Number.isSafeInteger(identity.schemaEpoch) || identity.schemaEpoch < 1) {
        invalid("topology schema epoch is invalid");
    }
    if (!SCHEMA_DIGEST.test(identity.schemaDigest)) invalid("topology schema digest is invalid");
}

function fromStored(row: StoredTopologyOperation): CatalogTopologyOperation {
    return {
        migrationId: row.migration_id,
        sourceShard: row.source_shard,
        destinationShard: row.destination_shard,
        rangeLo: row.range_lo,
        rangeHi: row.range_hi,
        startEpoch: row.start_epoch,
        schemaVersion: row.schema_version,
        schemaEpoch: row.schema_epoch,
        schemaDigest: row.schema_digest,
        status: row.status,
        completedEpoch: row.completed_epoch,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function sameIdentity(stored: CatalogTopologyOperation, requested: CatalogTopologyOperationIdentity): boolean {
    return (
        stored.migrationId === requested.migrationId &&
        stored.sourceShard === requested.sourceShard &&
        stored.destinationShard === requested.destinationShard &&
        stored.rangeLo === requested.rangeLo &&
        stored.rangeHi === requested.rangeHi &&
        stored.startEpoch === requested.startEpoch &&
        stored.schemaVersion === requested.schemaVersion &&
        stored.schemaEpoch === requested.schemaEpoch &&
        stored.schemaDigest === requested.schemaDigest
    );
}

export function initializeCatalogTopologyOperationStore(sql: CatalogSql): void {
    for (const statement of TOPOLOGY_OPERATION_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
    const columns = sql.all<{ name: string }>("PRAGMA table_info(catalog_topology_operations)");
    if (!columns.some(column => column.name === "schema_epoch")) {
        sql.exec("ALTER TABLE catalog_topology_operations ADD COLUMN schema_epoch INTEGER CHECK (schema_epoch > 0)");
    }
}

/** Owns the one-at-a-time Catalog lease for a durable topology change. */
export class CatalogTopologyOperationStore {
    constructor(private readonly sql: CatalogSql) {}

    read(migrationId: string): CatalogTopologyOperation | null {
        const row = this.sql.one<StoredTopologyOperation>(
            `SELECT migration_id, source_shard, destination_shard, range_lo, range_hi,
                    start_epoch, schema_version, schema_epoch, schema_digest, status, completed_epoch,
                    created_at, updated_at
             FROM catalog_topology_operations WHERE migration_id = ?`,
            migrationId
        );
        return row ? fromStored(row) : null;
    }

    active(): CatalogTopologyOperation | null {
        const row = this.sql.one<StoredTopologyOperation>(
            `SELECT migration_id, source_shard, destination_shard, range_lo, range_hi,
                    start_epoch, schema_version, schema_epoch, schema_digest, status, completed_epoch,
                    created_at, updated_at
             FROM catalog_topology_operations WHERE status = 'active'`
        );
        return row ? fromStored(row) : null;
    }

    begin(identity: CatalogTopologyOperationIdentity, nowMs: number): CatalogTopologyOperation {
        assertIdentity(identity);
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid("topology operation timestamp is invalid");
        const existing = this.read(identity.migrationId);
        if (existing) {
            this.assertExact(existing, identity);
            return existing;
        }
        const historyCount =
            this.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM catalog_topology_operations")?.count ?? 0;
        if (historyCount >= CATALOG_TOPOLOGY_OPERATION_HISTORY_LIMIT) {
            throw new CdbError({
                code: "CDB_RATE_LIMITED",
                message: `topology operation history reached its ${CATALOG_TOPOLOGY_OPERATION_HISTORY_LIMIT}-record limit`,
            });
        }
        const active = this.active();
        if (active) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: `topology operation ${active.migrationId} is already active`,
            });
        }
        this.sql.exec(
            `INSERT INTO catalog_topology_operations
             (migration_id, source_shard, destination_shard, range_lo, range_hi,
              start_epoch, schema_version, schema_epoch, schema_digest, status, completed_epoch,
              created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
            identity.migrationId,
            identity.sourceShard,
            identity.destinationShard,
            identity.rangeLo,
            identity.rangeHi,
            identity.startEpoch,
            identity.schemaVersion,
            identity.schemaEpoch,
            identity.schemaDigest,
            nowMs,
            nowMs
        );
        const inserted = this.read(identity.migrationId);
        if (!inserted) throw new CdbError({ code: "CDB_INVARIANT", message: "topology operation disappeared" });
        return inserted;
    }

    assertActive(identity: CatalogTopologyOperationIdentity): CatalogTopologyOperation {
        assertIdentity(identity);
        const operation = this.read(identity.migrationId);
        if (!operation) {
            throw new CdbError({ code: "CDB_STALE_EPOCH", message: "topology operation lease is missing" });
        }
        this.assertExact(operation, identity);
        if (operation.status !== "active") {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: `topology operation is ${operation.status}`,
            });
        }
        return operation;
    }

    complete(
        identity: CatalogTopologyOperationIdentity,
        completedEpoch: number,
        nowMs: number
    ): CatalogTopologyOperation {
        if (!Number.isSafeInteger(completedEpoch) || completedEpoch <= identity.startEpoch) {
            invalid("topology completion epoch is invalid");
        }
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid("topology operation timestamp is invalid");
        const operation = this.readExact(identity);
        if (operation.status === "completed") {
            if (operation.completedEpoch !== completedEpoch) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "topology completion epoch changed" });
            }
            return operation;
        }
        if (operation.status === "aborted") {
            throw new CdbError({ code: "CDB_STALE_EPOCH", message: "aborted topology operation cannot complete" });
        }
        this.sql.exec(
            `UPDATE catalog_topology_operations
             SET status = 'completed', completed_epoch = ?, updated_at = ?
             WHERE migration_id = ? AND status = 'active'`,
            completedEpoch,
            nowMs,
            identity.migrationId
        );
        return this.readExact(identity);
    }

    abort(identity: CatalogTopologyOperationIdentity, nowMs: number): CatalogTopologyOperation {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid("topology operation timestamp is invalid");
        const operation = this.readExact(identity);
        if (operation.status === "aborted") return operation;
        if (operation.status === "completed") {
            throw new CdbError({ code: "CDB_STALE_EPOCH", message: "completed topology operation cannot abort" });
        }
        this.sql.exec(
            `UPDATE catalog_topology_operations
             SET status = 'aborted', updated_at = ?
             WHERE migration_id = ? AND status = 'active'`,
            nowMs,
            identity.migrationId
        );
        return this.readExact(identity);
    }

    assertNoActive(): void {
        const active = this.active();
        if (!active) return;
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: `topology operation ${active.migrationId} is in progress`,
        });
    }

    private readExact(identity: CatalogTopologyOperationIdentity): CatalogTopologyOperation {
        assertIdentity(identity);
        const operation = this.read(identity.migrationId);
        if (!operation) {
            throw new CdbError({ code: "CDB_STALE_EPOCH", message: "topology operation lease is missing" });
        }
        this.assertExact(operation, identity);
        return operation;
    }

    private assertExact(operation: CatalogTopologyOperation, identity: CatalogTopologyOperationIdentity): void {
        if (sameIdentity(operation, identity)) return;
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "topology operation identity changed" });
    }
}
