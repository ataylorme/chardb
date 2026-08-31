import { CdbError } from "../../errors.ts";
import { VSHARD_COUNT } from "../../vshard.ts";
import type { CatalogSql } from "./catalog-schema-store.ts";

export const CATALOG_ORGANIZATION_DELETION_BARRIER_HISTORY_LIMIT = VSHARD_COUNT;

const DDL = `
CREATE TABLE IF NOT EXISTS catalog_organization_deletion_barriers (
  migration_id TEXT PRIMARY KEY,
  range_lo INTEGER NOT NULL CHECK (range_lo >= 0 AND range_lo < 16384),
  range_hi INTEGER NOT NULL CHECK (range_hi >= range_lo AND range_hi < 16384),
  deletion_watermark INTEGER NOT NULL CHECK (deletion_watermark >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'aborted')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  finished_at INTEGER,
  CHECK (
    (status = 'active' AND finished_at IS NULL)
    OR (status IN ('released', 'aborted') AND finished_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_organization_deletion_barriers_one_active
  ON catalog_organization_deletion_barriers (status) WHERE status = 'active';
` as const;

export interface CatalogOrganizationDeletionBarrierIdentity {
    readonly migrationId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}

export interface CatalogOrganizationDeletionBarrier extends CatalogOrganizationDeletionBarrierIdentity {
    readonly deletionWatermark: number;
    readonly status: "active" | "released" | "aborted";
    readonly createdAt: number;
    readonly finishedAt: number | null;
}

export interface CatalogOrganizationDeletionBarrierStatus {
    readonly barrier: CatalogOrganizationDeletionBarrier;
    readonly olderDeletionsComplete: boolean;
}

interface StoredBarrier {
    readonly migration_id: string;
    readonly range_lo: number | bigint;
    readonly range_hi: number | bigint;
    readonly deletion_watermark: number | bigint;
    readonly status: CatalogOrganizationDeletionBarrier["status"];
    readonly created_at: number | bigint;
    readonly finished_at: number | bigint | null;
}

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `organization deletion barrier: ${message}` });
}

function mismatch(message: string): never {
    throw new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message: `organization deletion barrier: ${message}` });
}

function stale(message: string): never {
    throw new CdbError({ code: "CDB_STALE_EPOCH", message: `organization deletion barrier: ${message}` });
}

function safeStored(value: number | bigint, subject: string): number {
    const projected = Number(value);
    if (!Number.isSafeInteger(projected) || projected < 0) mismatch(`${subject} is invalid`);
    return projected;
}

function assertIdentity(identity: CatalogOrganizationDeletionBarrierIdentity): void {
    if (!MIGRATION_ID.test(identity.migrationId)) invalid("migration id is invalid");
    if (
        !Number.isSafeInteger(identity.rangeLo) ||
        !Number.isSafeInteger(identity.rangeHi) ||
        identity.rangeLo < 0 ||
        identity.rangeHi < identity.rangeLo ||
        identity.rangeHi >= VSHARD_COUNT
    ) {
        invalid("vshard range is invalid");
    }
}

function safeTime(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) invalid("timestamp is invalid");
    return value;
}

function project(row: StoredBarrier): CatalogOrganizationDeletionBarrier {
    return Object.freeze({
        migrationId: row.migration_id,
        rangeLo: safeStored(row.range_lo, "range start"),
        rangeHi: safeStored(row.range_hi, "range end"),
        deletionWatermark: safeStored(row.deletion_watermark, "deletion watermark"),
        status: row.status,
        createdAt: safeStored(row.created_at, "creation time"),
        finishedAt: row.finished_at === null ? null : safeStored(row.finished_at, "finish time"),
    });
}

export function initializeCatalogOrganizationDeletionBarrierStore(sql: CatalogSql): void {
    for (const statement of DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
}

/** Durable Catalog fence used only during the final file-movement convergence window. */
export class CatalogOrganizationDeletionBarrierStore {
    constructor(readonly sql: CatalogSql) {}

    begin(identity: CatalogOrganizationDeletionBarrierIdentity, nowMs: number): CatalogOrganizationDeletionBarrier {
        assertIdentity(identity);
        safeTime(nowMs);
        const existing = this.read(identity.migrationId);
        if (existing) {
            this.assertExact(existing, identity);
            return existing;
        }
        const history = this.sql.one<{ count: number | bigint }>(
            "SELECT COUNT(*) AS count FROM catalog_organization_deletion_barriers"
        );
        if (
            safeStored(history?.count ?? 0, "barrier history count") >=
            CATALOG_ORGANIZATION_DELETION_BARRIER_HISTORY_LIMIT
        ) {
            throw new CdbError({
                code: "CDB_RATE_LIMITED",
                message: `organization deletion barrier history reached ${CATALOG_ORGANIZATION_DELETION_BARRIER_HISTORY_LIMIT} rows`,
            });
        }
        const active = this.active();
        if (active) stale(`migration ${active.migrationId} already owns an active range`);
        const watermark = this.sql.one<{ watermark: number | bigint }>(
            "SELECT COALESCE(MAX(rowid), 0) AS watermark FROM catalog_organization_deletions"
        );
        const deletionWatermark = safeStored(watermark?.watermark ?? 0, "deletion watermark");
        this.sql.exec(
            `INSERT INTO catalog_organization_deletion_barriers
               (migration_id, range_lo, range_hi, deletion_watermark, status, created_at, finished_at)
             VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
            identity.migrationId,
            identity.rangeLo,
            identity.rangeHi,
            deletionWatermark,
            nowMs
        );
        return this.require(identity.migrationId);
    }

    status(identity: CatalogOrganizationDeletionBarrierIdentity): CatalogOrganizationDeletionBarrierStatus {
        assertIdentity(identity);
        const barrier = this.require(identity.migrationId);
        this.assertExact(barrier, identity);
        return Object.freeze({
            barrier,
            olderDeletionsComplete: !this.hasOlderPending(barrier),
        });
    }

    assertDeletionAllowed(vshard: number): void {
        if (!Number.isSafeInteger(vshard) || vshard < 0 || vshard >= VSHARD_COUNT) invalid("vshard is invalid");
        const rows = this.sql.all<StoredBarrier>(
            `SELECT * FROM catalog_organization_deletion_barriers
             WHERE status = 'active' AND ? BETWEEN range_lo AND range_hi
             ORDER BY migration_id LIMIT 2`,
            vshard
        );
        if (rows.length > 1) mismatch("overlapping active barriers exist");
        if (rows.length === 1) stale("new organization deletion is fenced while its vshard moves");
    }

    release(identity: CatalogOrganizationDeletionBarrierIdentity, nowMs: number): CatalogOrganizationDeletionBarrier {
        assertIdentity(identity);
        safeTime(nowMs);
        const barrier = this.require(identity.migrationId);
        this.assertExact(barrier, identity);
        if (barrier.status === "released") return barrier;
        if (barrier.status === "aborted") stale("aborted barrier cannot release");
        if (this.hasOlderPending(barrier)) mismatch("older organization deletions are still pending");
        this.finish(identity.migrationId, "released", nowMs);
        return this.require(identity.migrationId);
    }

    abort(identity: CatalogOrganizationDeletionBarrierIdentity, nowMs: number): CatalogOrganizationDeletionBarrier {
        assertIdentity(identity);
        safeTime(nowMs);
        const barrier = this.require(identity.migrationId);
        this.assertExact(barrier, identity);
        if (barrier.status === "aborted") return barrier;
        if (barrier.status === "released") stale("released barrier cannot abort");
        this.finish(identity.migrationId, "aborted", nowMs);
        return this.require(identity.migrationId);
    }

    read(migrationId: string): CatalogOrganizationDeletionBarrier | null {
        if (!MIGRATION_ID.test(migrationId)) invalid("migration id is invalid");
        const row = this.sql.one<StoredBarrier>(
            "SELECT * FROM catalog_organization_deletion_barriers WHERE migration_id = ?",
            migrationId
        );
        return row ? project(row) : null;
    }

    private active(): CatalogOrganizationDeletionBarrier | null {
        const row = this.sql.one<StoredBarrier>(
            "SELECT * FROM catalog_organization_deletion_barriers WHERE status = 'active'"
        );
        return row ? project(row) : null;
    }

    private require(migrationId: string): CatalogOrganizationDeletionBarrier {
        const barrier = this.read(migrationId);
        if (!barrier) stale("barrier does not exist");
        return barrier;
    }

    private hasOlderPending(barrier: CatalogOrganizationDeletionBarrier): boolean {
        return (
            this.sql.one<{ present: number }>(
                `SELECT 1 AS present FROM catalog_organization_deletions
                 WHERE rowid <= ? AND vshard BETWEEN ? AND ? AND status = 'pending' LIMIT 1`,
                barrier.deletionWatermark,
                barrier.rangeLo,
                barrier.rangeHi
            ) !== null
        );
    }

    private finish(migrationId: string, status: "released" | "aborted", nowMs: number): void {
        this.sql.exec(
            `UPDATE catalog_organization_deletion_barriers SET status = ?, finished_at = ?
             WHERE migration_id = ? AND status = 'active'`,
            status,
            nowMs,
            migrationId
        );
        if (this.sql.changes() !== 1) stale("barrier changed before its terminal transition");
    }

    private assertExact(
        barrier: CatalogOrganizationDeletionBarrier,
        identity: CatalogOrganizationDeletionBarrierIdentity
    ): void {
        if (barrier.rangeLo !== identity.rangeLo || barrier.rangeHi !== identity.rangeHi) {
            stale("migration id belongs to a different range");
        }
    }
}
