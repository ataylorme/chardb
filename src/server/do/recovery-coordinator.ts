import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { parseStoredRecoveryContinuationState } from "../recovery-continuation.ts";

const COORDINATOR_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_recovery_operation (
  digest TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('preparing', 'committing', 'reconciling', 'catalog', 'complete')),
  files INTEGER NOT NULL CHECK (files >= 0),
  files_retained INTEGER NOT NULL CHECK (files_retained >= 0),
  vectors INTEGER NOT NULL CHECK (vectors >= 0),
  commit_index INTEGER NOT NULL DEFAULT 0 CHECK (commit_index >= 0),
  continuation_json TEXT,
  files_rehydrated INTEGER,
  vectors_requeued INTEGER
);
CREATE TABLE IF NOT EXISTS _chardb_recovery_commit (
  digest TEXT NOT NULL,
  object_id TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent', 'scheduled')),
  PRIMARY KEY (digest, object_id),
  FOREIGN KEY (digest) REFERENCES _chardb_recovery_operation(digest) ON DELETE CASCADE
);`;

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

export type RecoveryCoordinatorState =
    | { readonly phase: "new" }
    | { readonly phase: "preparing"; readonly continuationJson: string }
    | ({
          readonly phase: "committing";
          readonly commitIndex: number;
      } & RecoveryProviderCounts)
    | ({ readonly phase: "reconciling"; readonly continuationJson: string } & RecoveryProviderCounts)
    | ({ readonly phase: "catalog" | "complete" } & RecoveryProviderCounts & RecoveryReconcileCounts);

interface StoredOperation {
    readonly digest: string;
    readonly phase: "preparing" | "committing" | "reconciling" | "catalog" | "complete";
    readonly files: number | bigint;
    readonly files_retained: number | bigint;
    readonly vectors: number | bigint;
    readonly commit_index: number | bigint;
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

function assertDigest(value: string): void {
    if (!DIGEST.test(value)) invalid("digest is invalid");
}

function assertCounts(value: RecoveryProviderCounts | RecoveryReconcileCounts): void {
    for (const [label, candidate] of Object.entries(value)) count(candidate, label);
}

function continuation(value: string, kind: "restore" | "reconcile"): string {
    if (typeof value !== "string" || TEXT.encode(value).byteLength > 16_384) {
        invalid(`${kind} cursor is invalid`);
    }
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
            .filter(Boolean)) {
            sql.exec(statement);
        }
    }

    read(digest: string): RecoveryCoordinatorState {
        assertDigest(digest);
        const row = this.sql.one<StoredOperation>("SELECT * FROM _chardb_recovery_operation WHERE digest = ?", digest);
        if (!row) return { phase: "new" };
        if (row.phase === "preparing") {
            if (typeof row.continuation_json !== "string") invalid("preparation cursor is missing");
            return { phase: "preparing", continuationJson: row.continuation_json };
        }
        const provider = {
            files: count(row.files, "files"),
            filesRetained: count(row.files_retained, "filesRetained"),
            vectors: count(row.vectors, "vectors"),
        };
        if (row.phase === "committing") {
            return {
                phase: row.phase,
                ...provider,
                commitIndex: count(row.commit_index, "commitIndex"),
            };
        }
        if (row.phase === "reconciling") {
            if (typeof row.continuation_json !== "string") invalid("reconciliation cursor is missing");
            return { phase: row.phase, ...provider, continuationJson: row.continuation_json };
        }
        return {
            phase: row.phase,
            ...provider,
            filesRehydrated: count(row.files_rehydrated, "filesRehydrated"),
            vectorsRequeued: count(row.vectors_requeued, "vectorsRequeued"),
        };
    }

    beginCommits(digest: string, counts: RecoveryProviderCounts): RecoveryCoordinatorState {
        assertDigest(digest);
        assertCounts(counts);
        const current = this.read(digest);
        if (current.phase === "new") invalid("recovery preparation has not begun");
        if (current.phase !== "preparing") {
            if (
                current.files !== counts.files ||
                current.filesRetained !== counts.filesRetained ||
                current.vectors !== counts.vectors
            ) {
                invalid("provider counts changed after commit began");
            }
            return current;
        }
        this.sql.exec(
            `UPDATE _chardb_recovery_operation
             SET phase = 'committing', files = ?, files_retained = ?, vectors = ?, continuation_json = NULL
             WHERE digest = ?`,
            counts.files,
            counts.filesRetained,
            counts.vectors,
            digest
        );
        return { phase: "committing", ...counts, commitIndex: 0 };
    }

    claimPreparation(digest: string, continuationJson: string): RecoveryCoordinatorState {
        assertDigest(digest);
        continuation(continuationJson, "restore");
        const current = this.read(digest);
        if (current.phase !== "new") return current;
        const active = this.sql.one<{ readonly digest: string }>(
            "SELECT digest FROM _chardb_recovery_operation WHERE phase <> 'complete' LIMIT 1"
        );
        if (active) invalid("another recovery operation is active");
        const migrationTable = this.sql.one<{ readonly present: number }>(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'"
        );
        if (
            migrationTable &&
            this.sql.one<{ readonly present: number }>(
                "SELECT 1 AS present FROM migration_state WHERE phase NOT IN (-1, 6) LIMIT 1"
            )
        ) {
            invalid("resharding blocks point-in-time recovery");
        }
        const startTable = this.sql.one<{ readonly present: number }>(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'migration_start_intent'"
        );
        if (
            startTable &&
            this.sql.one<{ readonly present: number }>(
                "SELECT 1 AS present FROM migration_start_intent WHERE state = 'starting' LIMIT 1"
            )
        ) {
            invalid("resharding blocks point-in-time recovery");
        }
        this.sql.exec(
            `INSERT INTO _chardb_recovery_operation
             (digest, phase, files, files_retained, vectors, continuation_json)
             VALUES (?, 'preparing', 0, 0, 0, ?)`,
            digest,
            continuationJson
        );
        return { phase: "preparing", continuationJson };
    }

    savePreparation(digest: string, continuationJson: string): RecoveryCoordinatorState {
        const current = this.read(digest);
        if (current.phase !== "preparing") return current;
        continuation(continuationJson, "restore");
        this.sql.exec(
            "UPDATE _chardb_recovery_operation SET continuation_json = ? WHERE digest = ? AND phase = 'preparing'",
            continuationJson,
            digest
        );
        return { phase: "preparing", continuationJson };
    }

    beginCatalog(digest: string, counts: RecoveryReconcileCounts): RecoveryCoordinatorState {
        assertCounts(counts);
        const current = this.read(digest);
        if (current.phase === "new" || current.phase === "preparing") invalid("shard commits have not begun");
        if (current.phase === "committing") invalid("shard commits have not completed");
        if (current.phase === "catalog" || current.phase === "complete") {
            if (
                current.filesRehydrated !== counts.filesRehydrated ||
                current.vectorsRequeued !== counts.vectorsRequeued
            ) {
                invalid("reconciliation counts changed after Catalog commit began");
            }
            return current;
        }
        this.sql.exec(
            `UPDATE _chardb_recovery_operation
             SET phase = 'catalog', files_rehydrated = ?, vectors_requeued = ?
             WHERE digest = ?`,
            counts.filesRehydrated,
            counts.vectorsRequeued,
            digest
        );
        return {
            phase: "catalog",
            files: current.files,
            filesRetained: current.filesRetained,
            vectors: current.vectors,
            ...counts,
        };
    }

    finishShards(digest: string, continuationJson: string, shardCount: number): RecoveryCoordinatorState {
        continuation(continuationJson, "reconcile");
        const current = this.read(digest);
        if (current.phase !== "committing") return current;
        if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 16_384) {
            invalid("shard count is invalid");
        }
        if (current.commitIndex !== shardCount) invalid("not every shard commit is proven");
        this.sql.exec(
            "UPDATE _chardb_recovery_operation SET phase = 'reconciling', continuation_json = ? WHERE digest = ?",
            continuationJson,
            digest
        );
        return { ...current, phase: "reconciling", continuationJson };
    }

    advanceShard(digest: string, index: number, objectId: string): RecoveryCoordinatorState {
        const current = this.read(digest);
        if (current.phase !== "committing") return current;
        if (!Number.isSafeInteger(index) || index < 0 || current.commitIndex !== index || !OBJECT_ID.test(objectId)) {
            invalid("shard commit cursor is invalid");
        }
        const commit = this.sql.one<{ readonly status: string }>(
            "SELECT status FROM _chardb_recovery_commit WHERE digest = ? AND object_id = ?",
            digest,
            objectId
        );
        if (commit?.status !== "scheduled") invalid("shard commit is not proven");
        this.sql.exec(
            `UPDATE _chardb_recovery_operation SET commit_index = commit_index + 1
             WHERE digest = ? AND phase = 'committing' AND commit_index = ?`,
            digest,
            index
        );
        if (this.sql.changes() !== 1) invalid("shard commit cursor changed concurrently");
        return { ...current, commitIndex: index + 1 };
    }

    saveReconcile(digest: string, continuationJson: string): RecoveryCoordinatorState {
        continuation(continuationJson, "reconcile");
        const current = this.read(digest);
        if (current.phase !== "reconciling") return current;
        this.sql.exec(
            "UPDATE _chardb_recovery_operation SET continuation_json = ? WHERE digest = ? AND phase = 'reconciling'",
            continuationJson,
            digest
        );
        return { ...current, continuationJson };
    }

    hasActiveRecovery(): boolean {
        return Boolean(
            this.sql.one<{ readonly present: number }>(
                "SELECT 1 AS present FROM _chardb_recovery_operation WHERE phase <> 'complete' LIMIT 1"
            )
        );
    }

    complete(digest: string): RecoveryCoordinatorState {
        const current = this.read(digest);
        if (current.phase === "complete") return current;
        if (current.phase !== "catalog") invalid("Catalog commit has not begun");
        this.sql.exec("UPDATE _chardb_recovery_operation SET phase = 'complete' WHERE digest = ?", digest);
        this.sql.exec(
            `DELETE FROM _chardb_recovery_commit WHERE digest IN (
               SELECT digest FROM _chardb_recovery_operation
               WHERE phase = 'complete' ORDER BY rowid DESC LIMIT -1 OFFSET ?
             )`,
            MAX_TERMINAL_OPERATIONS
        );
        this.sql.exec(
            `DELETE FROM _chardb_recovery_operation WHERE digest IN (
               SELECT digest FROM _chardb_recovery_operation
               WHERE phase = 'complete' ORDER BY rowid DESC LIMIT -1 OFFSET ?
             )`,
            MAX_TERMINAL_OPERATIONS
        );
        return { ...current, phase: "complete" };
    }

    beginObject(digest: string, objectId: string, bookmark: string): { readonly status: "intent" | "scheduled" } {
        const operation = this.read(digest);
        if (operation.phase === "new") invalid("operation commit has not begun");
        if (!OBJECT_ID.test(objectId) || !BOOKMARK.test(bookmark)) invalid("commit identity is invalid");
        const current = this.sql.one<StoredCommit>(
            "SELECT object_id, bookmark, status FROM _chardb_recovery_commit WHERE digest = ? AND object_id = ?",
            digest,
            objectId
        );
        if (current) {
            if (current.bookmark !== bookmark) invalid("commit bookmark changed");
            return { status: current.status };
        }
        this.sql.exec(
            "INSERT INTO _chardb_recovery_commit (digest, object_id, bookmark, status) VALUES (?, ?, ?, 'intent')",
            digest,
            objectId,
            bookmark
        );
        return { status: "intent" };
    }

    finishObject(digest: string, objectId: string, bookmark: string): { readonly status: "scheduled" } {
        const current = this.beginObject(digest, objectId, bookmark);
        if (current.status !== "scheduled") {
            this.sql.exec(
                `UPDATE _chardb_recovery_commit SET status = 'scheduled'
                 WHERE digest = ? AND object_id = ? AND bookmark = ?`,
                digest,
                objectId,
                bookmark
            );
        }
        return { status: "scheduled" };
    }
}
