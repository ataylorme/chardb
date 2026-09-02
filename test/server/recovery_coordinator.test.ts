import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RecoveryCoordinatorStore } from "../../src/server/do/recovery-coordinator.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { serializeRecoveryContinuationState } from "../../src/server/recovery-continuation.ts";

function store(db: Database): RecoveryCoordinatorStore {
    const storage = {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
    return new RecoveryCoordinatorStore(adaptSqlStorage(storage as unknown as SqlStorage));
}

const O1 = "00000000-0000-4000-8000-000000000001";
const O2 = "00000000-0000-4000-8000-000000000002";
const O3 = "00000000-0000-4000-8000-000000000003";
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);

const restoreCursor = serializeRecoveryContinuationState({
    kind: "restore",
    phase: "arm",
    shardIndex: 0,
    afterRetainedFileId: "",
    afterVectorId: "",
    afterPhysicalVersion: 0,
    files: 0,
    filePages: 0,
    filesRetained: 0,
    retentionPages: 0,
    quiescenceTurns: 0,
    vectors: 0,
    vectorPages: 0,
    commitPolls: 0,
});

const reconcileCursor = serializeRecoveryContinuationState({
    kind: "reconcile",
    phase: "files",
    shardIndex: 0,
    afterFileId: "",
    afterCreatedSeq: 0,
    filesRehydrated: 0,
    filePages: 0,
    vectorsRequeued: 0,
    vectorPages: 0,
    settleTurns: 0,
    nowMs: 1,
});

function completeRecovery(coordinator: RecoveryCoordinatorStore, operationId: string, digest: string): void {
    coordinator.claimPreparation(operationId, digest, restoreCursor);
    coordinator.beginCommits(operationId, { files: 1, filesRetained: 2, vectors: 3 });
    coordinator.beginObject(operationId, "shard:only", "00000001-target");
    coordinator.finishObject(operationId, "shard:only", "00000001-target");
    coordinator.advanceShard(operationId, 0, "shard:only");
    coordinator.finishShards(operationId, reconcileCursor, 1);
    coordinator.beginReleases(operationId, { filesRehydrated: 1, vectorsRequeued: 3 });
    coordinator.advanceRelease(operationId, 0);
    coordinator.beginCatalog(operationId, 1);
    coordinator.complete(operationId);
}

describe("recovery coordinator", () => {
    test("allocates one generation and excludes a different active operation", () => {
        const db = new Database(":memory:");
        const coordinator = store(db);
        expect(coordinator.claimPreparation(O1, D1, restoreCursor)).toMatchObject({
            operationId: O1,
            digest: D1,
            generation: 1,
            phase: "preparing",
        });
        expect(coordinator.admissionClock()).toEqual({ generation: 1, activeOperationId: O1, activeDigest: D1 });
        expect(coordinator.activeForDigest(D1)).toMatchObject({ operationId: O1, phase: "preparing" });
        expect(() => coordinator.claimPreparation(O2, D2, restoreCursor)).toThrow("another recovery operation");
        db.close();
    });

    test("runs the same manifest again under a new operation and generation", () => {
        const db = new Database(":memory:");
        const coordinator = store(db);
        completeRecovery(coordinator, O1, D1);
        expect(coordinator.read(O1)).toMatchObject({ phase: "complete", operationId: O1, generation: 1 });
        expect(coordinator.claimPreparation(O1, D1, restoreCursor)).toMatchObject({ phase: "complete" });
        expect(coordinator.claimPreparation(O2, D1, restoreCursor)).toMatchObject({
            phase: "preparing",
            operationId: O2,
            generation: 2,
        });
        db.close();
    });

    test("cancels only an unarmed preparation without reusing its generation", () => {
        const db = new Database(":memory:");
        const coordinator = store(db);
        coordinator.claimPreparation(O1, D1, restoreCursor);
        expect(coordinator.cancelPreparation(O1)).toEqual({
            generation: 1,
            activeOperationId: null,
            activeDigest: null,
        });
        expect(coordinator.read(O1)).toEqual({ phase: "new", operationId: O1 });
        expect(coordinator.claimPreparation(O2, D1, restoreCursor)).toMatchObject({ generation: 2 });
        expect(() => coordinator.cancelPreparation(O2)).not.toThrow();
        db.close();
    });

    test("fails closed on active legacy recovery state and drops completed legacy history", () => {
        const active = new Database(":memory:");
        active.exec("CREATE TABLE _chardb_recovery_operation (phase TEXT NOT NULL)");
        active.exec("INSERT INTO _chardb_recovery_operation (phase) VALUES ('preparing')");
        expect(() => store(active)).toThrow("active legacy recovery operation requires manual resolution");
        active.close();

        const completed = new Database(":memory:");
        completed.exec("CREATE TABLE _chardb_recovery_operation (phase TEXT NOT NULL)");
        completed.exec("CREATE TABLE _chardb_recovery_commit (object_id TEXT)");
        completed.exec("INSERT INTO _chardb_recovery_operation (phase) VALUES ('complete')");
        expect(store(completed).admissionClock()).toEqual({
            generation: 0,
            activeOperationId: null,
            activeDigest: null,
        });
        const names = completed
            .query("SELECT name FROM sqlite_master WHERE name LIKE '_chardb_recovery_%'")
            .all()
            .map(row => (row as { name: string }).name)
            .sort();
        expect(names).toEqual([
            "_chardb_recovery_clock",
            "_chardb_recovery_commit_v2",
            "_chardb_recovery_operation_v2",
            "_chardb_recovery_operation_v2_digest",
        ]);
        completed.close();
    });

    test("rejects recovery while a reshard operation is active", () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE migration_state (phase INTEGER NOT NULL)");
        db.exec("INSERT INTO migration_state (phase) VALUES (3)");
        expect(() => store(db).claimPreparation(O3, D2, restoreCursor)).toThrow(
            "resharding blocks point-in-time recovery"
        );
        db.close();
    });

    test("rejects malformed and oversized internal cursors", () => {
        const db = new Database(":memory:");
        const coordinator = store(db);
        expect(() => coordinator.claimPreparation(O3, D2, "{}")).toThrow("continuation state is invalid");
        expect(() => coordinator.claimPreparation(O3, D2, `{"kind":"restore","x":"${"é".repeat(9_000)}"}`)).toThrow(
            "restore cursor is invalid"
        );
        db.close();
    });
});
