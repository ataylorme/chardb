import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { VSHARD_COUNT } from "../../vshard.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

export const CDB_ROUTING_FENCE_STORE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_routing_fences (
  migration_id TEXT PRIMARY KEY,
  range_lo INTEGER NOT NULL CHECK (range_lo >= 0 AND range_lo < 16384),
  range_hi INTEGER NOT NULL CHECK (range_hi >= range_lo AND range_hi < 16384),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
  destination_generation INTEGER NOT NULL CHECK (destination_generation = source_generation + 1),
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK (recovery_generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'active', 'cleaned', 'superseded')),
  prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
  activated_at INTEGER CHECK (activated_at IS NULL OR activated_at >= prepared_at),
  cleaned_at INTEGER CHECK (cleaned_at IS NULL OR cleaned_at >= activated_at),
  superseded_at INTEGER CHECK (superseded_at IS NULL OR superseded_at >= cleaned_at),
  CHECK (
    (status = 'prepared' AND activated_at IS NULL AND cleaned_at IS NULL AND superseded_at IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND cleaned_at IS NULL AND superseded_at IS NULL)
    OR (status = 'cleaned' AND activated_at IS NOT NULL AND cleaned_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND activated_at IS NOT NULL AND cleaned_at IS NOT NULL AND superseded_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS _chardb_routing_fences_range
ON _chardb_routing_fences (range_lo, range_hi, source_generation);
` as const;

export interface CdbRoutingFenceIdentity {
    readonly migrationId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
    readonly sourceGeneration: number;
    readonly destinationGeneration: number;
    readonly recoveryGeneration: number;
}

export interface CdbRoutingFence extends CdbRoutingFenceIdentity {
    readonly status: "prepared" | "active" | "cleaned" | "superseded";
    readonly preparedAt: number;
    readonly activatedAt: number | null;
    readonly cleanedAt: number | null;
    readonly supersededAt: number | null;
}

interface StoredCdbRoutingFence {
    readonly migration_id: string;
    readonly range_lo: number;
    readonly range_hi: number;
    readonly source_generation: number;
    readonly destination_generation: number;
    readonly recovery_generation: number;
    readonly status: CdbRoutingFence["status"];
    readonly prepared_at: number;
    readonly activated_at: number | null;
    readonly cleaned_at: number | null;
    readonly superseded_at: number | null;
}

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CDB_ROUTING_FENCE_MAX_ROWS = VSHARD_COUNT;

export function initializeCdbRoutingFenceStore(sql: SyncSql): void {
    const columns = sql.all<{ name: string }>("PRAGMA table_info(_chardb_routing_fences)");
    if (!columns.some(column => column.name === "recovery_generation")) {
        sql.exec(
            "ALTER TABLE _chardb_routing_fences ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK (recovery_generation >= 0)"
        );
    }
}

/**
 * Durable source-side routing fence for one physical vshard move.
 *
 * A cleaned fence stays live as a tombstone. This prevents an old Gateway
 * from recreating source rows after cleanup. A later migration may replace
 * that tombstone only for the exact same range and a strictly newer source
 * generation.
 */
export class CdbRoutingFenceStore {
    constructor(private readonly storage: DurableObjectStorage) {}

    prepare(identity: CdbRoutingFenceIdentity, nowMs = Date.now()): CdbRoutingFence {
        assertIdentity(identity);
        assertTimestamp(nowMs);
        let result: CdbRoutingFence | null = null;
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const existing = this.byMigrationId(identity.migrationId, sql);
            if (existing) {
                assertSameIdentity(existing, identity);
                result = existing;
                return;
            }
            const count = sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_routing_fences");
            if (!count || !Number.isSafeInteger(count.count) || count.count < 0) {
                throw corruptFence("routing fence row count is invalid");
            }
            if (count.count >= CDB_ROUTING_FENCE_MAX_ROWS) {
                throw new CdbError({
                    code: "CDB_RATE_LIMITED",
                    message: "Cdb routing fence history reached its durable row limit",
                    hint: "stop resharding this Cdb and inspect its retained migration history",
                });
            }

            const overlaps = this.overlapping(identity.rangeLo, identity.rangeHi, sql);
            if (overlaps.length > 0) {
                const prior = overlaps.length === 1 ? overlaps[0] : undefined;
                if (
                    !prior ||
                    prior.status !== "cleaned" ||
                    prior.rangeLo !== identity.rangeLo ||
                    prior.rangeHi !== identity.rangeHi ||
                    identity.sourceGeneration <= prior.destinationGeneration
                ) {
                    throw staleFence("another routing fence owns an overlapping vshard range");
                }
                sql.exec(
                    `UPDATE _chardb_routing_fences
                     SET status = 'superseded', superseded_at = ?
                     WHERE migration_id = ? AND status = 'cleaned'`,
                    nowMs,
                    prior.migrationId
                );
                if (sql.changes() !== 1) throw staleFence("routing fence changed before supersession");
            }

            sql.exec(
                `INSERT INTO _chardb_routing_fences
                 (migration_id, range_lo, range_hi, source_generation, destination_generation,
                  recovery_generation, status, prepared_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)`,
                identity.migrationId,
                identity.rangeLo,
                identity.rangeHi,
                identity.sourceGeneration,
                identity.destinationGeneration,
                identity.recoveryGeneration,
                nowMs
            );
            result = this.required(identity.migrationId, sql);
        });
        if (!result) throw corruptFence("routing fence prepare completed without a durable result");
        return result;
    }

    activate(
        identity: CdbRoutingFenceIdentity,
        nowMs = Date.now(),
        onActivated?: (sql: SyncSql) => void
    ): CdbRoutingFence {
        assertIdentity(identity);
        assertTimestamp(nowMs);
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.required(identity.migrationId, sql);
            assertSameIdentity(current, identity);
            if (current.status === "prepared") {
                sql.exec(
                    `UPDATE _chardb_routing_fences
                     SET status = 'active', activated_at = ?
                     WHERE migration_id = ? AND status = 'prepared'`,
                    Math.max(nowMs, current.preparedAt),
                    identity.migrationId
                );
                if (sql.changes() !== 1) throw staleFence("routing fence changed before activation");
                onActivated?.(sql);
            }
        });
        return this.required(identity.migrationId);
    }

    cleanup(identity: CdbRoutingFenceIdentity, nowMs = Date.now()): CdbRoutingFence {
        assertIdentity(identity);
        assertTimestamp(nowMs);
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.required(identity.migrationId, sql);
            assertSameIdentity(current, identity);
            if (current.status === "cleaned" || current.status === "superseded") return;
            if (current.status !== "active" || current.activatedAt === null) {
                throw new CdbError({
                    code: "CDB_RESHARD_PHASE_MISMATCH",
                    message: "routing fence cleanup requires an active fence",
                });
            }
            sql.exec(
                `UPDATE _chardb_routing_fences
                 SET status = 'cleaned', cleaned_at = ?
                 WHERE migration_id = ? AND status = 'active'`,
                Math.max(nowMs, current.activatedAt),
                identity.migrationId
            );
            if (sql.changes() !== 1) throw staleFence("routing fence changed before cleanup");
        });
        return this.required(identity.migrationId);
    }

    /** Cancel a fence only after Catalog has durably rejected cutover for this operation. */
    cancelBeforeCutover(identity: CdbRoutingFenceIdentity, nowMs = Date.now()): CdbRoutingFence | null {
        assertIdentity(identity);
        assertTimestamp(nowMs);
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.byMigrationId(identity.migrationId, sql);
            if (!current) return;
            assertSameIdentity(current, identity);
            if (current.status === "superseded") return;
            if (current.status === "cleaned") {
                throw new CdbError({
                    code: "CDB_RESHARD_PHASE_MISMATCH",
                    message: "a cleaned routing fence cannot cancel before cutover",
                });
            }
            const activatedAt = Math.max(current.activatedAt ?? nowMs, current.preparedAt);
            const cleanedAt = Math.max(nowMs, activatedAt);
            sql.exec(
                `UPDATE _chardb_routing_fences
                 SET status = 'superseded', activated_at = ?, cleaned_at = ?, superseded_at = ?
                 WHERE migration_id = ? AND status IN ('prepared', 'active')`,
                activatedAt,
                cleanedAt,
                cleanedAt,
                identity.migrationId
            );
            if (sql.changes() !== 1) throw staleFence("routing fence changed before cancellation");
        });
        return this.byMigrationId(identity.migrationId);
    }

    /** V1 destinations must be fresh and cannot retain any prior source ownership fence. */
    assertDestinationActivationAllowed(
        input: { readonly rangeLo: number; readonly rangeHi: number; readonly destinationGeneration: number },
        sql: SyncSql
    ): void {
        assertVshard(input.rangeLo);
        assertVshard(input.rangeHi);
        assertGeneration(input.destinationGeneration, "destination ownership generation");
        const overlaps = this.overlapping(input.rangeLo, input.rangeHi, sql);
        if (overlaps.length === 0) return;
        throw staleFence("destination ownership conflicts with retained source ownership history");
    }

    byMigrationId(migrationId: string, sql = adaptSqlStorage(this.storage.sql)): CdbRoutingFence | null {
        const row = sql.one<StoredCdbRoutingFence>(
            `SELECT migration_id, range_lo, range_hi, source_generation, destination_generation, recovery_generation,
                    status, prepared_at, activated_at, cleaned_at, superseded_at
             FROM _chardb_routing_fences
             WHERE migration_id = ?`,
            migrationId
        );
        return row ? parseFence(row) : null;
    }

    /** Return the activated source fence, including its permanent cleaned tombstone. */
    activeSourceFence(vshard: number, sql = adaptSqlStorage(this.storage.sql)): CdbRoutingFence | null {
        assertVshard(vshard);
        const rows = sql.all<StoredCdbRoutingFence>(
            `SELECT migration_id, range_lo, range_hi, source_generation, destination_generation, recovery_generation,
                    status, prepared_at, activated_at, cleaned_at, superseded_at
             FROM _chardb_routing_fences
             WHERE range_lo <= ? AND range_hi >= ? AND status IN ('active', 'cleaned')
             ORDER BY source_generation DESC
             LIMIT 2`,
            vshard,
            vshard
        );
        if (rows.length > 1) throw corruptFence("multiple active routing fences overlap one vshard");
        return rows[0] ? parseFence(rows[0]) : null;
    }

    /** Assert the Catalog generation while the mutation's op-log transaction is open. */
    assertMutationAdmission(
        input: { readonly schemaEpoch: number; readonly vshard: number },
        sql = adaptSqlStorage(this.storage.sql)
    ): void {
        assertGeneration(input.schemaEpoch, "mutation routing generation");
        assertVshard(input.vshard);
        const fences = sql.all<StoredCdbRoutingFence>(
            `SELECT migration_id, range_lo, range_hi, source_generation, destination_generation, recovery_generation,
                    status, prepared_at, activated_at, cleaned_at, superseded_at
             FROM _chardb_routing_fences
             WHERE range_lo <= ? AND range_hi >= ? AND status != 'superseded'
             ORDER BY source_generation DESC
             LIMIT 2`,
            input.vshard,
            input.vshard
        );
        if (fences.length > 1) throw corruptFence("multiple routing fences overlap one vshard");
        if (!fences[0]) return;
        const fence = parseFence(fences[0]);
        if (fence.status === "prepared" && input.schemaEpoch === fence.sourceGeneration) return;

        const relation =
            input.schemaEpoch <= fence.destinationGeneration
                ? "is no longer admitted by this source"
                : "is newer than this source fence recognizes";
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: `mutation routing generation ${input.schemaEpoch} ${relation}`,
            hint: "retry after resolving the active vshard placement from Catalog",
        });
    }

    private required(migrationId: string, sql = adaptSqlStorage(this.storage.sql)): CdbRoutingFence {
        const fence = this.byMigrationId(migrationId, sql);
        if (!fence) throw staleFence("routing fence was not prepared on this Cdb");
        return fence;
    }

    private overlapping(rangeLo: number, rangeHi: number, sql: SyncSql): readonly CdbRoutingFence[] {
        return sql
            .all<StoredCdbRoutingFence>(
                `SELECT migration_id, range_lo, range_hi, source_generation, destination_generation, recovery_generation,
                        status, prepared_at, activated_at, cleaned_at, superseded_at
                 FROM _chardb_routing_fences
                 WHERE status != 'superseded' AND range_lo <= ? AND range_hi >= ?
                 ORDER BY range_lo, range_hi, source_generation`,
                rangeHi,
                rangeLo
            )
            .map(parseFence);
    }
}

function assertIdentity(identity: CdbRoutingFenceIdentity): void {
    if (!MIGRATION_ID.test(identity.migrationId)) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "routing fence migration id is invalid" });
    }
    assertVshard(identity.rangeLo);
    assertVshard(identity.rangeHi);
    if (identity.rangeLo > identity.rangeHi) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "routing fence range is invalid" });
    }
    assertGeneration(identity.sourceGeneration, "routing fence source generation");
    assertGeneration(identity.destinationGeneration, "routing fence destination generation");
    assertRecoveryGeneration(identity.recoveryGeneration);
    if (identity.destinationGeneration !== identity.sourceGeneration + 1) {
        throw new CdbError({
            code: "CDB_INVALID_ARGS",
            message: "routing fence destination generation must immediately follow its source generation",
        });
    }
}

function assertSameIdentity(stored: CdbRoutingFence, input: CdbRoutingFenceIdentity): void {
    if (
        stored.migrationId !== input.migrationId ||
        stored.rangeLo !== input.rangeLo ||
        stored.rangeHi !== input.rangeHi ||
        stored.sourceGeneration !== input.sourceGeneration ||
        stored.destinationGeneration !== input.destinationGeneration ||
        stored.recoveryGeneration !== input.recoveryGeneration
    ) {
        throw staleFence("routing fence migration id belongs to a different immutable identity");
    }
}

function assertVshard(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= VSHARD_COUNT) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "routing fence vshard is invalid" });
    }
}

function assertGeneration(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: `${subject} is invalid` });
    }
}

function assertRecoveryGeneration(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "routing fence recovery generation is invalid" });
    }
}

function assertTimestamp(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "routing fence timestamp is invalid" });
    }
}

function parseFence(row: StoredCdbRoutingFence): CdbRoutingFence {
    if (
        !MIGRATION_ID.test(row.migration_id) ||
        !Number.isSafeInteger(row.range_lo) ||
        !Number.isSafeInteger(row.range_hi) ||
        row.range_lo < 0 ||
        row.range_hi < row.range_lo ||
        row.range_hi >= VSHARD_COUNT ||
        !Number.isSafeInteger(row.source_generation) ||
        row.source_generation < 1 ||
        row.destination_generation !== row.source_generation + 1 ||
        !Number.isSafeInteger(row.recovery_generation) ||
        row.recovery_generation < 0 ||
        !["prepared", "active", "cleaned", "superseded"].includes(row.status)
    ) {
        throw corruptFence("stored routing fence is malformed");
    }
    return {
        migrationId: row.migration_id,
        rangeLo: row.range_lo,
        rangeHi: row.range_hi,
        sourceGeneration: row.source_generation,
        destinationGeneration: row.destination_generation,
        recoveryGeneration: row.recovery_generation,
        status: row.status,
        preparedAt: row.prepared_at,
        activatedAt: row.activated_at,
        cleanedAt: row.cleaned_at,
        supersededAt: row.superseded_at,
    };
}

function staleFence(message: string): CdbError {
    return new CdbError({
        code: "CDB_STALE_EPOCH",
        message,
        hint: "retry after reading the current reshard state",
    });
}

function corruptFence(message: string): CdbError {
    return new CdbError({ code: "CDB_INVARIANT", message });
}
