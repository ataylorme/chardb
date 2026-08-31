import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { vshardOf } from "../../vshard.ts";
import {
    CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL,
    CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL,
} from "./cdb-background-delivery-ownership-sql.ts";
import { CdbVectorOutboxStore } from "./cdb-vector-outbox-store.ts";

export const CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE = 500;
export const CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT = 32;

export const CDB_VECTOR_ORGANIZATION_DELETION_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_deleted_organizations (
  organization_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0),
  placement_vshard INTEGER NOT NULL CHECK (placement_vshard >= 0 AND placement_vshard < 16384),
  vector_unproven_turns INTEGER NOT NULL DEFAULT 0
    CHECK (vector_unproven_turns BETWEEN 0 AND ${CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT})
);
CREATE INDEX IF NOT EXISTS _chardb_deleted_organizations_by_placement
  ON _chardb_deleted_organizations (placement_vshard, organization_id);
CREATE INDEX IF NOT EXISTS _chardb_vectors_active_by_organization_sequence
  ON _chardb_vectors (organization_id, created_seq)
  WHERE state IN ('pending', 'ready');
CREATE INDEX IF NOT EXISTS _chardb_vectors_by_organization
  ON _chardb_vectors (organization_id, vector_id);
` as const;

export const CDB_VECTOR_DELETED_ORGANIZATION_INSERT_GUARD = "_chardb_vectors_reject_deleted_organization_insert";
export const CDB_VECTOR_DELETED_ORGANIZATION_WRITE_GUARD = "_chardb_vectors_reject_deleted_organization_write";

const CDB_VECTOR_REJECT_DELETED_ORGANIZATION_INSERT_DDL = `
CREATE TRIGGER IF NOT EXISTS ${CDB_VECTOR_DELETED_ORGANIZATION_INSERT_GUARD}
BEFORE INSERT ON _chardb_vectors
WHEN EXISTS (
  SELECT 1 FROM _chardb_deleted_organizations AS deleted
  WHERE deleted.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'vector organization was deleted');
END;
` as const;

const CDB_VECTOR_REJECT_DELETED_ORGANIZATION_WRITE_DDL = `
CREATE TRIGGER IF NOT EXISTS ${CDB_VECTOR_DELETED_ORGANIZATION_WRITE_GUARD}
BEFORE UPDATE OF organization_id, version, values_enc, metadata_json, state ON _chardb_vectors
WHEN NEW.state != 'deleting' AND EXISTS (
  SELECT 1 FROM _chardb_deleted_organizations AS deleted
  WHERE deleted.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'vector organization was deleted');
END;
` as const;

export type CdbVectorOrganizationDeletionTransaction = <T>(callback: () => T) => T;

export interface CdbVectorOrganizationDeletionFence {
    readonly organizationId: string;
    readonly deletedAt: number;
    readonly placementVshard: number;
}

export interface CdbVectorOrganizationDeletionPage {
    readonly organizationId: string;
    readonly staged: number;
    readonly done: boolean;
}

export interface CdbVectorOrganizationDeletionPendingPage {
    readonly organizationId: string;
}

export interface CdbVectorOrganizationDeletionAcceptance {
    readonly organizationId: string;
    readonly accepted: true;
}

export interface CdbVectorOrganizationPurgeStatus {
    readonly organizationId: string;
    readonly state: "pending" | "complete" | "failed_unproven";
    readonly remainingHeads: number;
    readonly outboxRows: number;
    readonly attemptRows: number;
    readonly unprovenTurns: number;
    readonly lastError: string | null;
}

interface StoredTombstone {
    readonly deleted_at: number | bigint;
    readonly placement_vshard: number | bigint;
    readonly vector_unproven_turns: number | bigint;
}

interface StoredHeadIdentity {
    readonly vector_id: string;
}

interface StoredDeletionCandidate {
    readonly organization_id: string;
}

export const CDB_VECTOR_ORGANIZATION_PURGE_STATUS_SQL = `SELECT
  (SELECT COUNT(*) FROM _chardb_vectors WHERE organization_id = ?) AS remaining_heads,
  (SELECT COUNT(*) FROM _chardb_vector_outbox AS outbox
     INNER JOIN _chardb_vectors AS head ON head.vector_id = outbox.vector_id
     WHERE head.organization_id = ?) AS outbox_rows,
  (SELECT COUNT(*) FROM _chardb_vector_attempts AS attempt
     INNER JOIN _chardb_vectors AS head ON head.vector_id = attempt.vector_id
     WHERE head.organization_id = ?) AS attempt_rows,
  (SELECT outbox.last_error FROM _chardb_vectors AS head
     INDEXED BY _chardb_vectors_deleting_by_organization
     INNER JOIN _chardb_vector_outbox AS outbox ON outbox.vector_id = head.vector_id
     WHERE head.organization_id = ? AND head.state = 'deleting' AND outbox.terminal_failure = 1
     ORDER BY head.vector_id LIMIT 1) AS last_error` as const;

const TEXT = new TextEncoder();

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `vector organization deletion: ${message}` });
}

function invariant(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message: `vector organization deletion: ${message}` });
}

function inputInteger(value: number, subject: string): number {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`${subject} is invalid`);
    return value;
}

function storedInteger(value: number | bigint, subject: string): number {
    const projected = Number(value);
    if (!Number.isSafeInteger(projected) || projected < 0) invariant(`${subject} is invalid`);
    return projected;
}

function organizationId(value: string): string {
    if (typeof value !== "string" || value.length === 0 || TEXT.encode(value).byteLength > 256) {
        invalid("organization id is invalid");
    }
    return value;
}

export function installCdbVectorOrganizationDeletionGuards(sql: SyncSql): void {
    sql.exec(CDB_VECTOR_REJECT_DELETED_ORGANIZATION_INSERT_DDL);
    sql.exec(CDB_VECTOR_REJECT_DELETED_ORGANIZATION_WRITE_DDL);
}

export function uninstallCdbVectorOrganizationDeletionGuards(sql: SyncSql): void {
    sql.exec(`DROP TRIGGER IF EXISTS ${CDB_VECTOR_DELETED_ORGANIZATION_INSERT_GUARD}`);
    sql.exec(`DROP TRIGGER IF EXISTS ${CDB_VECTOR_DELETED_ORGANIZATION_WRITE_GUARD}`);
}

export function initializeCdbVectorOrganizationDeletionStore(sql: SyncSql): void {
    sql.exec("DROP TRIGGER IF EXISTS _chardb_vector_organization_progress_after_tombstone_delete");
    sql.exec("DROP TABLE IF EXISTS _chardb_vector_organization_deletions");
    sql.exec("DROP INDEX IF EXISTS _chardb_vectors_by_organization_sequence");
    sql.exec("DROP INDEX IF EXISTS _chardb_vectors_by_organization_state_sequence");
    for (const statement of CDB_VECTOR_ORGANIZATION_DELETION_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
    const tombstoneColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_deleted_organizations)").map(column => column.name)
    );
    if (!tombstoneColumns.has("vector_unproven_turns")) {
        sql.exec(
            `ALTER TABLE _chardb_deleted_organizations ADD COLUMN vector_unproven_turns INTEGER NOT NULL DEFAULT 0
             CHECK (vector_unproven_turns BETWEEN 0 AND ${CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT})`
        );
    }
    installCdbVectorOrganizationDeletionGuards(sql);
}

/** Tombstoned pending and ready heads are the durable cleanup queue. */
export class CdbVectorOrganizationDeletionStore {
    constructor(
        private readonly sql: SyncSql,
        private readonly transactionSync: CdbVectorOrganizationDeletionTransaction
    ) {}

    fenceOrganization(input: {
        readonly organizationId: string;
        readonly nowMs: number;
    }): CdbVectorOrganizationDeletionFence {
        const organization = organizationId(input.organizationId);
        const nowMs = inputInteger(input.nowMs, "timestamp");
        return this.transactionSync(() => this.fence(organization, nowMs));
    }

    acceptOrganization(input: {
        readonly organizationId: string;
        readonly nowMs: number;
    }): CdbVectorOrganizationDeletionAcceptance {
        const organization = organizationId(input.organizationId);
        const nowMs = inputInteger(input.nowMs, "timestamp");
        return this.transactionSync(() => {
            this.fence(organization, nowMs);
            if (this.readPurgeStatus(organization)?.state !== "failed_unproven") {
                this.stagePage(organization, nowMs);
            }
            return Object.freeze({ organizationId: organization, accepted: true as const });
        });
    }

    stageNextPage(input: {
        readonly organizationId: string;
        readonly nowMs: number;
    }): CdbVectorOrganizationDeletionPage {
        const organization = organizationId(input.organizationId);
        const nowMs = inputInteger(input.nowMs, "timestamp");
        return this.transactionSync(() => {
            this.assertFence(organization);
            return this.stagePage(organization, nowMs);
        });
    }

    /** Read only. The caller uses the organization to open its captured transaction. */
    nextPendingPage(): CdbVectorOrganizationDeletionPendingPage | null {
        const candidate = this.sql.one<StoredDeletionCandidate>(
            `SELECT delivery_head.organization_id
             FROM _chardb_deleted_organizations AS delivery_head
             WHERE ${CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL}
               AND ${CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL}
               AND EXISTS (
                 SELECT 1 FROM _chardb_vectors AS active_head
                   INDEXED BY _chardb_vectors_active_by_organization_sequence
                 WHERE active_head.organization_id = delivery_head.organization_id
                   AND active_head.state IN ('pending', 'ready')
               )
             ORDER BY delivery_head.placement_vshard, delivery_head.organization_id LIMIT 1`
        );
        return candidate ? Object.freeze({ organizationId: organizationId(candidate.organization_id) }) : null;
    }

    readPurgeStatus(organizationValue: string): CdbVectorOrganizationPurgeStatus | null {
        const organization = organizationId(organizationValue);
        const tombstone = this.tombstone(organization);
        if (!tombstone) return null;
        const counts = this.sql.one<{
            remaining_heads: number | bigint;
            outbox_rows: number | bigint;
            attempt_rows: number | bigint;
            last_error: string | null;
        }>(CDB_VECTOR_ORGANIZATION_PURGE_STATUS_SQL, organization, organization, organization, organization);
        if (!counts) invariant("organization purge status is unavailable");
        const remainingHeads = storedInteger(counts.remaining_heads, "remaining vector head count");
        const outboxRows = storedInteger(counts.outbox_rows, "remaining vector outbox count");
        const attemptRows = storedInteger(counts.attempt_rows, "remaining vector attempt count");
        const unprovenTurns = storedInteger(tombstone.vector_unproven_turns, "vector unproven turn count");
        if (unprovenTurns > CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT) {
            invariant("vector unproven turn count exceeds its bound");
        }
        return Object.freeze({
            organizationId: organization,
            state: counts.last_error !== null ? "failed_unproven" : remainingHeads === 0 ? "complete" : "pending",
            remainingHeads,
            outboxRows,
            attemptRows,
            unprovenTurns,
            lastError: counts.last_error,
        });
    }

    recordUnprovenTurn(organizationValue: string): { readonly turns: number; readonly terminal: boolean } | null {
        const organization = organizationId(organizationValue);
        const tombstone = this.tombstone(organization);
        if (!tombstone) return null;
        const current = storedInteger(tombstone.vector_unproven_turns, "vector unproven turn count");
        if (current > CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT) {
            invariant("vector unproven turn count exceeds its bound");
        }
        const turns = Math.min(CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT, current + 1);
        this.sql.exec(
            `UPDATE _chardb_deleted_organizations SET vector_unproven_turns = ?
             WHERE organization_id = ? AND vector_unproven_turns = ?`,
            turns,
            organization,
            current
        );
        if (this.sql.changes() !== 1) invariant("vector unproven turn count changed concurrently");
        return Object.freeze({ turns, terminal: turns === CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT });
    }

    private stagePage(organization: string, nowMs: number): CdbVectorOrganizationDeletionPage {
        if (this.readPurgeStatus(organization)?.state === "failed_unproven") {
            throw new CdbError({
                code: "CDB_FORBIDDEN",
                message: "vector organization deletion: external purge requires manual intervention",
            });
        }
        const rows = this.sql.all<StoredHeadIdentity>(
            `SELECT vector_id FROM _chardb_vectors
               INDEXED BY _chardb_vectors_active_by_organization_sequence
             WHERE organization_id = ? AND state IN ('pending', 'ready')
             ORDER BY created_seq LIMIT ?`,
            organization,
            CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE + 1
        );
        const pageRows = rows.slice(0, CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE);
        const outbox = new CdbVectorOutboxStore(this.sql);
        for (const row of pageRows) {
            const staged = outbox.stageDelete({ vectorId: row.vector_id, organizationId: organization, nowMs });
            if (!staged || staged.state !== "deleting") invariant("selected vector head was not staged for deletion");
        }
        return Object.freeze({
            organizationId: organization,
            staged: pageRows.length,
            done: rows.length <= CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE,
        });
    }

    private fence(organization: string, nowMs: number): CdbVectorOrganizationDeletionFence {
        const expectedPlacement = Number(vshardOf([organization]));
        this.sql.exec(
            `INSERT OR IGNORE INTO _chardb_deleted_organizations
               (organization_id, deleted_at, placement_vshard) VALUES (?, ?, ?)`,
            organization,
            nowMs,
            expectedPlacement
        );
        const tombstone = this.tombstone(organization);
        if (!tombstone) invariant("organization tombstone is missing");
        const placement = storedInteger(tombstone.placement_vshard, "organization tombstone placement");
        if (placement !== expectedPlacement) invariant("organization tombstone placement is invalid");
        return Object.freeze({
            organizationId: organization,
            deletedAt: storedInteger(tombstone.deleted_at, "organization deletion time"),
            placementVshard: placement,
        });
    }

    private assertFence(organization: string): void {
        const tombstone = this.tombstone(organization);
        if (!tombstone) {
            throw new CdbError({
                code: "CDB_FORBIDDEN",
                message: "vector organization deletion: organization is not deletion-fenced",
            });
        }
        const placement = storedInteger(tombstone.placement_vshard, "organization tombstone placement");
        if (placement !== Number(vshardOf([organization]))) invariant("organization tombstone placement is invalid");
    }

    private tombstone(organization: string): StoredTombstone | null {
        return this.sql.one<StoredTombstone>(
            `SELECT deleted_at, placement_vshard, vector_unproven_turns FROM _chardb_deleted_organizations
             WHERE organization_id = ?`,
            organization
        );
    }
}
