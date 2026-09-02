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

function completeRecovery(coordinator: RecoveryCoordinatorStore, digest: string): void {
    coordinator.claimPreparation(digest, restoreCursor);
    coordinator.beginCommits(digest, { files: 1, filesRetained: 2, vectors: 3 });
    coordinator.beginObject(digest, "shard:only", "00000001-target");
    coordinator.finishObject(digest, "shard:only", "00000001-target");
    coordinator.advanceShard(digest, 0, "shard:only");
    coordinator.finishShards(digest, reconcileCursor, 1);
    coordinator.beginCatalog(digest, { filesRehydrated: 1, vectorsRequeued: 3 });
    coordinator.complete(digest);
}

describe("recovery coordinator", () => {
    test("owns the durable cursor and excludes a different active digest", () => {
        const db = new Database(":memory:");
        const coordinator = store(db);
        const first = "a".repeat(64);
        const second = "b".repeat(64);
        expect(coordinator.claimPreparation(first, restoreCursor)).toEqual({
            phase: "preparing",
            continuationJson: restoreCursor,
        });
        expect(() => coordinator.claimPreparation(second, restoreCursor)).toThrow("another recovery operation");
        const advanced = restoreCursor.replace('"shardIndex":0', '"shardIndex":1');
        expect(coordinator.savePreparation(first, advanced)).toEqual({
            phase: "preparing",
            continuationJson: advanced,
        });
        expect(store(db).read(first)).toEqual({ phase: "preparing", continuationJson: advanced });
        db.close();
    });

    test("permits sequential recovery points and retains the latest 64 terminal results", () => {
        const db = new Database(":memory:");
        const coordinator = store(db);
        for (let index = 0; index < 65; index++) {
            completeRecovery(coordinator, index.toString(16).padStart(64, "0"));
        }
        expect(coordinator.read("0".repeat(64))).toEqual({ phase: "new" });
        expect(coordinator.read("1".padStart(64, "0"))).toMatchObject({ phase: "complete" });
        expect(coordinator.claimPreparation("1".padStart(64, "0"), restoreCursor)).toMatchObject({
            phase: "complete",
        });
        expect(coordinator.read("4".repeat(64))).toEqual({ phase: "new" });
        db.close();
    });

    test("rejects recovery while a reshard operation is active", () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE migration_state (phase INTEGER NOT NULL)");
        db.exec("INSERT INTO migration_state (phase) VALUES (3)");
        const coordinator = store(db);
        expect(() => coordinator.claimPreparation("c".repeat(64), restoreCursor)).toThrow(
            "resharding blocks point-in-time recovery"
        );
        db.close();
    });

    test("rejects malformed and oversized internal cursors", () => {
        const db = new Database(":memory:");
        const coordinator = store(db);
        expect(() => coordinator.claimPreparation("d".repeat(64), "{}")).toThrow("continuation state is invalid");
        expect(() =>
            coordinator.claimPreparation("d".repeat(64), `{"kind":"restore","x":"${"é".repeat(9_000)}"}`)
        ).toThrow("restore cursor is invalid");
        db.close();
    });
});
