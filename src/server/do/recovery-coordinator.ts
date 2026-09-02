import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { parseStoredRecoveryContinuationState } from "../recovery-continuation.ts";

const COORDINATOR_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_recovery_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  active_operation_id TEXT
);
INSERT OR IGNORE INTO _chardb_recovery_clock (singleton, generation, active_operation_id) VALUES (1, 0, NULL);
CREATE TABLE IF NOT EXISTS _chardb_recovery_operation_v2 (
  operation_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  phase TEXT NOT NULL CHECK (phase IN ('preparing', 'committing', 'reconciling', 'releasing', 'catalog', 'complete')),
  files INTEGER NOT NULL CHECK (files >= 0),
  files_retained INTEGER NOT NULL CHECK (files_retained >= 0),
  vectors INTEGER NOT NULL CHECK (vectors >= 0),
  commit_index INTEGER NOT NULL DEFAULT 0 CHECK (commit_index >= 0),
  release_index INTEGER NOT NULL DEFAULT 0 CHECK (release_index >= 0),
  continuation_json TEXT,
  files_rehydrated INTEGER,
  vectors_requeued INTEGER
);
CREATE INDEX IF NOT EXISTS _chardb_recovery_operation_v2_digest
  ON _chardb_recovery_operation_v2 (digest);
CREATE TABLE IF NOT EXISTS _chardb_recovery_commit_v2 (
  operation_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent', 'scheduled')),
  PRIMARY KEY (operation_id, object_id),
  FOREIGN KEY (operation_id) REFERENCES _chardb_recovery_operation_v2(operation_id) ON DELETE CASCADE
);`;

export const RECOVERY_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const BOOKMARK = /^[A-Za-z0-9-]{1,512}$/;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TERMINAL_OPERATIONS = 64;
const TEXT = new TextEncoder();

export interface RecoveryProviderCounts {
    readonly files: number;
    readonly filesRetained: number;
    readonly vectors: number;
}

export interface RecoveryReconcileCounts {
    readonly filesRehydrated: number;
    readonly vectorsRequeued: number;
}

interface RecoveryIdentity {
    readonly operationId: string;
    readonly digest: string;
    readonly generation: number;
}

export type RecoveryCoordinatorState =
    | { readonly phase: "new"; readonly operationId: string }
    | (RecoveryIdentity & { readonly phase: "preparing"; readonly continuationJson: string })
    | (RecoveryIdentity & RecoveryProviderCounts & { readonly phase: "committing"; readonly commitIndex: number })
    | (RecoveryIdentity & RecoveryProviderCounts & { readonly phase: "reconciling"; readonly continuationJson: string })
    | (RecoveryIdentity &
          RecoveryProviderCounts &
          RecoveryReconcileCounts & { readonly phase: "releasing"; readonly releaseIndex: number })
    | (RecoveryIdentity &
          RecoveryProviderCounts &
          RecoveryReconcileCounts & { readonly phase: "catalog" | "complete" });

export interface RecoveryAdmissionClock {
    readonly generation: number;
    readonly activeOperationId: string | null;
    readonly activeDigest: string | null;
}

interface StoredOperation {
    readonly operation_id: string;
    readonly digest: string;
    readonly generation: number | bigint;
    readonly phase: "preparing" | "committing" | "reconciling" | "releasing" | "catalog" | "complete";
    readonly files: number | bigint;
    readonly files_retained: number | bigint;
    readonly vectors: number | bigint;
    readonly commit_index: number | bigint;
    readonly release_index: number | bigint;
    readonly continuation_json: string | null;
    readonly files_rehydrated: number | bigint | null;
    readonly vectors_requeued: number | bigint | null;
}

interface StoredCommit {
    readonly object_id: string;
    readonly bookmark: string;
    readonly status: "intent" | "scheduled";
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `recovery coordinator: ${message}` });
}

function count(value: number | bigint | null, label: string): number {
    const projected = Number(value);
    if (!Number.isSafeInteger(projected) || projected < 0) invalid(`${label} is invalid`);
    return projected;
}

function assertIdentity(operationId: string, digest?: string): void {
    if (!RECOVERY_OPERATION_ID.test(operationId)) invalid("operation id is invalid");
    if (digest !== undefined && !DIGEST.test(digest)) invalid("digest is invalid");
}

function assertCounts(value: RecoveryProviderCounts | RecoveryReconcileCounts): void {
    for (const [label, candidate] of Object.entries(value)) count(candidate, label);
}

function continuation(value: string, kind: "restore" | "reconcile"): string {
    if (typeof value !== "string" || TEXT.encode(value).byteLength > 16_384) invalid(`${kind} cursor is invalid`);
    try {
        parseStoredRecoveryContinuationState(value, kind);
    } catch {
        invalid("continuation state is invalid");
    }
    return value;
}

export class RecoveryCoordinatorStore {
    constructor(private readonly sql: SyncSql) {
        for (const statement of COORDINATOR_DDL.split(";")
            .map(value => value.trim())
            .filter(Boolean))
            sql.exec(statement);
        this.retireLegacyCoordinator();
    }

    admissionClock(): RecoveryAdmissionClock {
        const clock = this.sql.one<{
            readonly generation: number | bigint;
            readonly active_operation_id: string | null;
        }>("SELECT generation, active_operation_id FROM _chardb_recovery_clock WHERE singleton = 1");
        if (!clock) invalid("generation clock is missing");
        const generation = count(clock.generation, "generation");
        if (clock.active_operation_id === null) return { generation, activeOperationId: null, activeDigest: null };
        const active = this.row(clock.active_operation_id);
        if (!active || active.phase === "complete" || count(active.generation, "generation") !== generation) {
            invalid("active operation clock is inconsistent");
        }
        return { generation, activeOperationId: active.operation_id, activeDigest: active.digest };
    }

    read(operationId: string): RecoveryCoordinatorState {
        assertIdentity(operationId);
        const row = this.row(operationId);
        if (!row) return { phase: "new", operationId };
        return this.project(row);
    }

    activeForDigest(digest: string): RecoveryCoordinatorState | null {
        if (!DIGEST.test(digest)) invalid("digest is invalid");
        const clock = this.admissionClock();
        if (!clock.activeOperationId) return null;
        if (clock.activeDigest !== digest) invalid("another recovery operation is active");
        return this.read(clock.activeOperationId);
    }

    claimPreparation(operationId: string, digest: string, continuationJson: string): RecoveryCoordinatorState {
        assertIdentity(operationId, digest);
        continuation(continuationJson, "restore");
        const existing = this.read(operationId);
        if (existing.phase !== "new") {
            if (existing.digest !== digest) invalid("operation digest changed");
            return existing;
        }
        const active = this.admissionClock();
        if (active.activeOperationId) {
            if (active.activeDigest !== digest) invalid("another recovery operation is active");
            return this.read(active.activeOperationId);
        }
        this.assertNoReshard();
        if (active.generation >= Number.MAX_SAFE_INTEGER) invalid("generation is exhausted");
        const generation = active.generation + 1;
        this.sql.exec(
            `INSERT INTO _chardb_recovery_operation_v2
             (operation_id, digest, generation, phase, files, files_retained, vectors, continuation_json)
             VALUES (?, ?, ?, 'preparing', 0, 0, 0, ?)`,
            operationId,
            digest,
            generation,
            continuationJson
        );
        this.sql.exec(
            "UPDATE _chardb_recovery_clock SET generation = ?, active_operation_id = ? WHERE singleton = 1",
            generation,
            operationId
        );
        return { operationId, digest, generation, phase: "preparing", continuationJson };
    }

    savePreparation(operationId: string, continuationJson: string): RecoveryCoordinatorState {
        const current = this.read(operationId);
        if (current.phase !== "preparing") return current;
        continuation(continuationJson, "restore");
        this.sql.exec(
            "UPDATE _chardb_recovery_operation_v2 SET continuation_json = ? WHERE operation_id = ? AND phase = 'preparing'",
            continuationJson,
            operationId
        );
        return { ...current, continuationJson };
    }

    cancelPreparation(operationId: string): RecoveryAdmissionClock {
        const current = this.read(operationId);
        if (current.phase !== "preparing") invalid("only an unarmed preparation may be cancelled");
        const clock = this.admissionClock();
        if (clock.activeOperationId !== operationId) invalid("cancelled preparation is not active");
        this.sql.exec(
            "DELETE FROM _chardb_recovery_operation_v2 WHERE operation_id = ? AND phase = 'preparing'",
            operationId
        );
        if (this.sql.changes() !== 1) invalid("preparation changed before cancellation");
        this.sql.exec(
            "UPDATE _chardb_recovery_clock SET active_operation_id = NULL WHERE singleton = 1 AND active_operation_id = ?",
            operationId
        );
        if (this.sql.changes() !== 1) invalid("active preparation changed before cancellation");
        return { generation: clock.generation, activeOperationId: null, activeDigest: null };
    }

    beginCommits(operationId: string, counts: RecoveryProviderCounts): RecoveryCoordinatorState {
        assertCounts(counts);
        const current = this.read(operationId);
        if (current.phase === "new") invalid("recovery preparation has not begun");
        if (current.phase !== "preparing") {
            if (
                current.files !== counts.files ||
                current.filesRetained !== counts.filesRetained ||
                current.vectors !== counts.vectors
            )
                invalid("provider counts changed after commit began");
            return current;
        }
        this.sql.exec(
            `UPDATE _chardb_recovery_operation_v2
             SET phase = 'committing', files = ?, files_retained = ?, vectors = ?, continuation_json = NULL
             WHERE operation_id = ?`,
            counts.files,
            counts.filesRetained,
            counts.vectors,
            operationId
        );
        return { ...current, phase: "committing", ...counts, commitIndex: 0 };
    }

    finishShards(operationId: string, continuationJson: string, shardCount: number): RecoveryCoordinatorState {
        continuation(continuationJson, "reconcile");
        const current = this.read(operationId);
        if (current.phase !== "committing") return current;
        if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 16_384)
            invalid("shard count is invalid");
        if (current.commitIndex !== shardCount) invalid("not every shard commit is proven");
        this.sql.exec(
            "UPDATE _chardb_recovery_operation_v2 SET phase = 'reconciling', continuation_json = ? WHERE operation_id = ?",
            continuationJson,
            operationId
        );
        return { ...current, phase: "reconciling", continuationJson };
    }

    advanceShard(operationId: string, index: number, objectId: string): RecoveryCoordinatorState {
        const current = this.read(operationId);
        if (current.phase !== "committing") return current;
        if (!Number.isSafeInteger(index) || index < 0 || current.commitIndex !== index || !OBJECT_ID.test(objectId))
            invalid("shard commit cursor is invalid");
        const commit = this.sql.one<{ readonly status: string }>(
            "SELECT status FROM _chardb_recovery_commit_v2 WHERE operation_id = ? AND object_id = ?",
            operationId,
            objectId
        );
        if (commit?.status !== "scheduled") invalid("shard commit is not proven");
        this.sql.exec(
            `UPDATE _chardb_recovery_operation_v2 SET commit_index = commit_index + 1
             WHERE operation_id = ? AND phase = 'committing' AND commit_index = ?`,
            operationId,
            index
        );
        if (this.sql.changes() !== 1) invalid("shard commit cursor changed concurrently");
        return { ...current, commitIndex: index + 1 };
    }

    saveReconcile(operationId: string, continuationJson: string): RecoveryCoordinatorState {
        continuation(continuationJson, "reconcile");
        const current = this.read(operationId);
        if (current.phase !== "reconciling") return current;
        this.sql.exec(
            "UPDATE _chardb_recovery_operation_v2 SET continuation_json = ? WHERE operation_id = ? AND phase = 'reconciling'",
            continuationJson,
            operationId
        );
        return { ...current, continuationJson };
    }

    beginReleases(operationId: string, counts: RecoveryReconcileCounts): RecoveryCoordinatorState {
        assertCounts(counts);
        const current = this.read(operationId);
        if (current.phase === "new" || current.phase === "preparing" || current.phase === "committing")
            invalid("shard reconciliation has not completed");
        if (current.phase !== "reconciling") {
            if (
                current.filesRehydrated !== counts.filesRehydrated ||
                current.vectorsRequeued !== counts.vectorsRequeued
            )
                invalid("reconciliation counts changed after release began");
            return current;
        }
        this.sql.exec(
            `UPDATE _chardb_recovery_operation_v2
             SET phase = 'releasing', files_rehydrated = ?, vectors_requeued = ?, continuation_json = NULL
             WHERE operation_id = ?`,
            counts.filesRehydrated,
            counts.vectorsRequeued,
            operationId
        );
        return { ...current, phase: "releasing", ...counts, releaseIndex: 0 };
    }

    advanceRelease(operationId: string, index: number): RecoveryCoordinatorState {
        const current = this.read(operationId);
        if (current.phase !== "releasing") return current;
        if (!Number.isSafeInteger(index) || index < 0 || current.releaseIndex !== index)
            invalid("release cursor is invalid");
        this.sql.exec(
            `UPDATE _chardb_recovery_operation_v2 SET release_index = release_index + 1
             WHERE operation_id = ? AND phase = 'releasing' AND release_index = ?`,
            operationId,
            index
        );
        if (this.sql.changes() !== 1) invalid("release cursor changed concurrently");
        return { ...current, releaseIndex: index + 1 };
    }

    beginCatalog(operationId: string, shardCount: number): RecoveryCoordinatorState {
        const current = this.read(operationId);
        if (current.phase !== "releasing") return current;
        if (!Number.isSafeInteger(shardCount) || shardCount < 1 || current.releaseIndex !== shardCount)
            invalid("not every shard release is proven");
        this.sql.exec("UPDATE _chardb_recovery_operation_v2 SET phase = 'catalog' WHERE operation_id = ?", operationId);
        return { ...current, phase: "catalog" };
    }

    complete(operationId: string): RecoveryCoordinatorState {
        const current = this.read(operationId);
        if (current.phase === "complete") return current;
        if (current.phase !== "catalog") invalid("Catalog release has not begun");
        this.sql.exec(
            "UPDATE _chardb_recovery_operation_v2 SET phase = 'complete' WHERE operation_id = ?",
            operationId
        );
        this.sql.exec(
            "UPDATE _chardb_recovery_clock SET active_operation_id = NULL WHERE singleton = 1 AND active_operation_id = ?",
            operationId
        );
        if (this.sql.changes() !== 1) invalid("active recovery operation changed before completion");
        this.sql.exec(
            `DELETE FROM _chardb_recovery_commit_v2 WHERE operation_id IN (
               SELECT operation_id FROM _chardb_recovery_operation_v2 WHERE phase = 'complete'
               ORDER BY rowid DESC LIMIT -1 OFFSET ?
             )`,
            MAX_TERMINAL_OPERATIONS
        );
        this.sql.exec(
            `DELETE FROM _chardb_recovery_operation_v2 WHERE operation_id IN (
               SELECT operation_id FROM _chardb_recovery_operation_v2 WHERE phase = 'complete'
               ORDER BY rowid DESC LIMIT -1 OFFSET ?
             )`,
            MAX_TERMINAL_OPERATIONS
        );
        return { ...current, phase: "complete" };
    }

    beginObject(operationId: string, objectId: string, bookmark: string): { readonly status: "intent" | "scheduled" } {
        const operation = this.read(operationId);
        if (operation.phase === "new") invalid("operation commit has not begun");
        if (!OBJECT_ID.test(objectId) || !BOOKMARK.test(bookmark)) invalid("commit identity is invalid");
        const current = this.sql.one<StoredCommit>(
            "SELECT object_id, bookmark, status FROM _chardb_recovery_commit_v2 WHERE operation_id = ? AND object_id = ?",
            operationId,
            objectId
        );
        if (current) {
            if (current.bookmark !== bookmark) invalid("commit bookmark changed");
            return { status: current.status };
        }
        this.sql.exec(
            "INSERT INTO _chardb_recovery_commit_v2 (operation_id, object_id, bookmark, status) VALUES (?, ?, ?, 'intent')",
            operationId,
            objectId,
            bookmark
        );
        return { status: "intent" };
    }

    finishObject(operationId: string, objectId: string, bookmark: string): { readonly status: "scheduled" } {
        const current = this.beginObject(operationId, objectId, bookmark);
        if (current.status !== "scheduled") {
            this.sql.exec(
                `UPDATE _chardb_recovery_commit_v2 SET status = 'scheduled'
                 WHERE operation_id = ? AND object_id = ? AND bookmark = ?`,
                operationId,
                objectId,
                bookmark
            );
        }
        return { status: "scheduled" };
    }

    hasActiveRecovery(): boolean {
        return this.admissionClock().activeOperationId !== null;
    }

    private row(operationId: string): StoredOperation | null {
        return this.sql.one<StoredOperation>(
            "SELECT * FROM _chardb_recovery_operation_v2 WHERE operation_id = ?",
            operationId
        );
    }

    private project(row: StoredOperation): Exclude<RecoveryCoordinatorState, { readonly phase: "new" }> {
        const identity = {
            operationId: row.operation_id,
            digest: row.digest,
            generation: count(row.generation, "generation"),
        };
        if (row.phase === "preparing") {
            if (typeof row.continuation_json !== "string") invalid("preparation cursor is missing");
            return { ...identity, phase: row.phase, continuationJson: row.continuation_json };
        }
        const provider = {
            files: count(row.files, "files"),
            filesRetained: count(row.files_retained, "filesRetained"),
            vectors: count(row.vectors, "vectors"),
        };
        if (row.phase === "committing")
            return { ...identity, ...provider, phase: row.phase, commitIndex: count(row.commit_index, "commitIndex") };
        if (row.phase === "reconciling") {
            if (typeof row.continuation_json !== "string") invalid("reconciliation cursor is missing");
            return { ...identity, ...provider, phase: row.phase, continuationJson: row.continuation_json };
        }
        const reconciled = {
            filesRehydrated: count(row.files_rehydrated, "filesRehydrated"),
            vectorsRequeued: count(row.vectors_requeued, "vectorsRequeued"),
        };
        if (row.phase === "releasing")
            return {
                ...identity,
                ...provider,
                ...reconciled,
                phase: row.phase,
                releaseIndex: count(row.release_index, "releaseIndex"),
            };
        return { ...identity, ...provider, ...reconciled, phase: row.phase };
    }

    private assertNoReshard(): void {
        const migrationTable = this.sql.one<{ readonly present: number }>(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'"
        );
        if (
            migrationTable &&
            this.sql.one<{ readonly present: number }>(
                "SELECT 1 AS present FROM migration_state WHERE phase NOT IN (-1, 6) LIMIT 1"
            )
        )
            invalid("resharding blocks point-in-time recovery");
        const startTable = this.sql.one<{ readonly present: number }>(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'migration_start_intent'"
        );
        if (
            startTable &&
            this.sql.one<{ readonly present: number }>(
                "SELECT 1 AS present FROM migration_start_intent WHERE state = 'starting' LIMIT 1"
            )
        )
            invalid("resharding blocks point-in-time recovery");
    }

    private retireLegacyCoordinator(): void {
        const legacy = this.sql.one<{ readonly present: number }>(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_chardb_recovery_operation'"
        );
        if (!legacy) return;
        const active = this.sql.one<{ readonly phase: string }>(
            "SELECT phase FROM _chardb_recovery_operation WHERE phase <> 'complete' LIMIT 1"
        );
        if (active) invalid("an active legacy recovery operation requires manual resolution");
        this.sql.exec("DROP TABLE IF EXISTS _chardb_recovery_commit");
        this.sql.exec("DROP TABLE _chardb_recovery_operation");
    }
}
