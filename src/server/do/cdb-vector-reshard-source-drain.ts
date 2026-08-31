import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { assertCdbReshardRangeIdentity } from "./cdb-reshard-identity-store.ts";
import type { CdbVectorReshardIdentity } from "./cdb-vector-reshard-records.ts";

export const CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE = 500;

export interface CdbVectorReshardSourcePrepareCursor {
    readonly afterPlacement: number;
    readonly afterVectorId: string;
}

export interface CdbVectorReshardSourceDeleteCursor {
    readonly kind: "attempt" | "outbox" | "head" | "done";
    readonly afterVectorId: string;
    readonly afterPhysicalVersion: number;
}

export interface CdbVectorReshardSourcePrepareResult {
    readonly prepared: number;
    readonly cursor: CdbVectorReshardSourcePrepareCursor;
    readonly done: boolean;
}

export interface CdbVectorReshardSourceDeleteResult {
    readonly deleted: number;
    readonly cursor: CdbVectorReshardSourceDeleteCursor;
    readonly done: boolean;
}

const TEXT = new TextEncoder();

function mismatch(message: string): never {
    throw new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message: `vector source drain: ${message}` });
}

function validateVectorId(value: unknown): string {
    if (typeof value !== "string" || TEXT.encode(value).byteLength > 256) mismatch("cursor vector id is invalid");
    return value;
}

function validatePrepareCursor(cursor: CdbVectorReshardSourcePrepareCursor): CdbVectorReshardSourcePrepareCursor {
    if (
        !cursor ||
        !Number.isSafeInteger(cursor.afterPlacement) ||
        cursor.afterPlacement < -1 ||
        cursor.afterPlacement >= 16_384 ||
        (cursor.afterPlacement === -1 && cursor.afterVectorId !== "")
    ) {
        mismatch("preparation cursor is invalid");
    }
    return Object.freeze({
        afterPlacement: cursor.afterPlacement,
        afterVectorId: validateVectorId(cursor.afterVectorId),
    });
}

function validateDeleteCursor(cursor: CdbVectorReshardSourceDeleteCursor): CdbVectorReshardSourceDeleteCursor {
    if (
        !cursor ||
        (cursor.kind !== "attempt" && cursor.kind !== "outbox" && cursor.kind !== "head" && cursor.kind !== "done") ||
        !Number.isSafeInteger(cursor.afterPhysicalVersion) ||
        cursor.afterPhysicalVersion < 0 ||
        ((cursor.kind === "outbox" || cursor.kind === "head" || cursor.kind === "done") &&
            cursor.afterPhysicalVersion !== 0) ||
        (cursor.kind === "done" && cursor.afterVectorId !== "")
    ) {
        mismatch("deletion cursor is invalid");
    }
    return Object.freeze({
        kind: cursor.kind,
        afterVectorId: validateVectorId(cursor.afterVectorId),
        afterPhysicalVersion: cursor.afterPhysicalVersion,
    });
}

/** Bounded local-only cleanup of vector side-state after a committed range cutover. */
export class CdbVectorReshardSourceDrainStore {
    constructor(private readonly sql: SyncSql) {}

    prepare(
        identity: CdbVectorReshardIdentity,
        input: CdbVectorReshardSourcePrepareCursor
    ): CdbVectorReshardSourcePrepareResult {
        assertCdbReshardRangeIdentity(identity);
        const cursor = validatePrepareCursor(input);
        const rows = this.sql.all<{ vector_id: string; placement_vshard: number; version: number; state: string }>(
            `SELECT vector_id, placement_vshard, version, state FROM _chardb_vectors
             WHERE placement_vshard BETWEEN ? AND ?
               AND (placement_vshard > ? OR (placement_vshard = ? AND vector_id > ?))
             ORDER BY placement_vshard, vector_id LIMIT ?`,
            identity.rangeLo,
            identity.rangeHi,
            cursor.afterPlacement,
            cursor.afterPlacement,
            cursor.afterVectorId,
            CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE + 1
        );
        const page = rows.slice(0, CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE);
        for (const row of page) {
            if (row.state === "deleting") continue;
            if (!Number.isSafeInteger(row.version) || row.version < 1 || row.version >= Number.MAX_SAFE_INTEGER) {
                mismatch(`head ${row.vector_id} version cannot enter local drain state`);
            }
            this.sql.exec(
                `UPDATE _chardb_vectors SET version = ?, values_enc = NULL, state = 'deleting'
                 WHERE vector_id = ? AND placement_vshard = ? AND version = ? AND state = ?`,
                row.version + 1,
                row.vector_id,
                row.placement_vshard,
                row.version,
                row.state
            );
            if (this.sql.changes() !== 1) mismatch(`head ${row.vector_id} changed during preparation`);
        }
        const last = page.at(-1);
        return Object.freeze({
            prepared: page.length,
            cursor: last
                ? Object.freeze({ afterPlacement: last.placement_vshard, afterVectorId: last.vector_id })
                : cursor,
            done: rows.length <= CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE,
        });
    }

    delete(
        identity: CdbVectorReshardIdentity,
        input: CdbVectorReshardSourceDeleteCursor
    ): CdbVectorReshardSourceDeleteResult {
        assertCdbReshardRangeIdentity(identity);
        const cursor = validateDeleteCursor(input);
        if (cursor.kind === "done") return Object.freeze({ deleted: 0, cursor, done: true });
        this.assertPrepared(identity);
        if (cursor.kind === "attempt") return this.deleteAttempts(identity, cursor);
        if (cursor.kind === "outbox") return this.deleteOutbox(identity, cursor);
        return this.deleteHeads(identity, cursor);
    }

    private assertPrepared(identity: CdbVectorReshardIdentity): void {
        if (
            this.sql.one<{ present: number }>(
                `SELECT 1 AS present FROM _chardb_vectors
                 WHERE placement_vshard BETWEEN ? AND ? AND state != 'deleting' LIMIT 1`,
                identity.rangeLo,
                identity.rangeHi
            )
        ) {
            mismatch("every moved head must be prepared before child deletion");
        }
    }

    private deleteAttempts(
        identity: CdbVectorReshardIdentity,
        cursor: CdbVectorReshardSourceDeleteCursor
    ): CdbVectorReshardSourceDeleteResult {
        const rows = this.sql.all<{ vector_id: string; physical_version: number }>(
            `SELECT attempt.vector_id, attempt.physical_version
             FROM _chardb_vector_attempts AS attempt
             JOIN _chardb_vectors AS head ON head.vector_id = attempt.vector_id
             WHERE head.placement_vshard BETWEEN ? AND ?
               AND (attempt.vector_id > ? OR (attempt.vector_id = ? AND attempt.physical_version > ?))
             ORDER BY attempt.vector_id, attempt.physical_version LIMIT ?`,
            identity.rangeLo,
            identity.rangeHi,
            cursor.afterVectorId,
            cursor.afterVectorId,
            cursor.afterPhysicalVersion,
            CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE + 1
        );
        const page = rows.slice(0, CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE);
        for (const row of page) {
            this.sql.exec(
                "DELETE FROM _chardb_vector_attempts WHERE vector_id = ? AND physical_version = ?",
                row.vector_id,
                row.physical_version
            );
            if (this.sql.changes() !== 1) mismatch("attempt changed during deletion");
        }
        const last = page.at(-1);
        if (rows.length > CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE) {
            return Object.freeze({
                deleted: page.length,
                cursor: Object.freeze({
                    kind: "attempt" as const,
                    afterVectorId: last?.vector_id ?? cursor.afterVectorId,
                    afterPhysicalVersion: last?.physical_version ?? cursor.afterPhysicalVersion,
                }),
                done: false,
            });
        }
        return Object.freeze({
            deleted: page.length,
            cursor: Object.freeze({ kind: "outbox" as const, afterVectorId: "", afterPhysicalVersion: 0 }),
            done: false,
        });
    }

    private deleteOutbox(
        identity: CdbVectorReshardIdentity,
        cursor: CdbVectorReshardSourceDeleteCursor
    ): CdbVectorReshardSourceDeleteResult {
        const rows = this.sql.all<{ vector_id: string }>(
            `SELECT outbox.vector_id FROM _chardb_vector_outbox AS outbox
             JOIN _chardb_vectors AS head ON head.vector_id = outbox.vector_id
             WHERE head.placement_vshard BETWEEN ? AND ? AND outbox.vector_id > ?
             ORDER BY outbox.vector_id LIMIT ?`,
            identity.rangeLo,
            identity.rangeHi,
            cursor.afterVectorId,
            CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE + 1
        );
        const page = rows.slice(0, CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE);
        for (const row of page) {
            this.sql.exec("DELETE FROM _chardb_vector_outbox WHERE vector_id = ?", row.vector_id);
            if (this.sql.changes() !== 1) mismatch("outbox changed during deletion");
        }
        const last = page.at(-1);
        if (rows.length > CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE) {
            return Object.freeze({
                deleted: page.length,
                cursor: Object.freeze({
                    kind: "outbox" as const,
                    afterVectorId: last?.vector_id ?? cursor.afterVectorId,
                    afterPhysicalVersion: 0,
                }),
                done: false,
            });
        }
        return Object.freeze({
            deleted: page.length,
            cursor: Object.freeze({ kind: "head" as const, afterVectorId: "", afterPhysicalVersion: 0 }),
            done: false,
        });
    }

    private deleteHeads(
        identity: CdbVectorReshardIdentity,
        cursor: CdbVectorReshardSourceDeleteCursor
    ): CdbVectorReshardSourceDeleteResult {
        const rows = this.sql.all<{ vector_id: string }>(
            `SELECT vector_id FROM _chardb_vectors
             WHERE placement_vshard BETWEEN ? AND ? AND vector_id > ?
               AND NOT EXISTS (SELECT 1 FROM _chardb_vector_attempts WHERE vector_id = _chardb_vectors.vector_id)
               AND NOT EXISTS (SELECT 1 FROM _chardb_vector_outbox WHERE vector_id = _chardb_vectors.vector_id)
             ORDER BY vector_id LIMIT ?`,
            identity.rangeLo,
            identity.rangeHi,
            cursor.afterVectorId,
            CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE + 1
        );
        const page = rows.slice(0, CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE);
        for (const row of page) {
            this.sql.exec("DELETE FROM _chardb_vectors WHERE vector_id = ? AND state = 'deleting'", row.vector_id);
            if (this.sql.changes() !== 1) mismatch(`head ${row.vector_id} changed during deletion`);
        }
        const last = page.at(-1);
        if (rows.length > CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE) {
            return Object.freeze({
                deleted: page.length,
                cursor: Object.freeze({
                    kind: "head" as const,
                    afterVectorId: last?.vector_id ?? cursor.afterVectorId,
                    afterPhysicalVersion: 0,
                }),
                done: false,
            });
        }
        const remaining = this.sql.one<{ present: number }>(
            "SELECT 1 AS present FROM _chardb_vectors WHERE placement_vshard BETWEEN ? AND ? LIMIT 1",
            identity.rangeLo,
            identity.rangeHi
        );
        if (remaining) mismatch("moved vector side-state remains after deletion");
        return Object.freeze({
            deleted: page.length,
            cursor: Object.freeze({ kind: "done" as const, afterVectorId: "", afterPhysicalVersion: 0 }),
            done: true,
        });
    }
}
