import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    CATALOG_TOPOLOGY_OPERATION_HISTORY_LIMIT,
    type CatalogTopologyOperationIdentity,
    CatalogTopologyOperationStore,
    initializeCatalogTopologyOperationStore,
} from "../../src/server/do/catalog-topology-operation-store.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
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
}

const digest = "a".repeat(64);
const identity = (overrides: Partial<CatalogTopologyOperationIdentity> = {}): CatalogTopologyOperationIdentity => ({
    migrationId: "split-1",
    sourceShard: "ShardDO_0",
    destinationShard: "ShardDO_1",
    rangeLo: 0,
    rangeHi: 127,
    startEpoch: 1,
    schemaVersion: 3,
    schemaEpoch: 4,
    schemaDigest: digest,
    ...overrides,
});

describe("Catalog topology operation store", () => {
    let db: Database;
    let store: CatalogTopologyOperationStore;

    beforeEach(() => {
        db = new Database(":memory:");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCatalogTopologyOperationStore(sql);
        store = new CatalogTopologyOperationStore(sql);
    });

    afterEach(() => db.close());

    test("resumes one active operation only for the exact durable identity", () => {
        expect(store.begin(identity(), 10)).toMatchObject({ status: "active", createdAt: 10 });
        expect(store.begin(identity(), 99)).toMatchObject({ status: "active", createdAt: 10, updatedAt: 10 });

        for (const changed of [
            identity({ sourceShard: "ShardDO_2" }),
            identity({ destinationShard: "ShardDO_2" }),
            identity({ rangeLo: 1 }),
            identity({ rangeHi: 128 }),
            identity({ startEpoch: 2 }),
            identity({ schemaVersion: 4 }),
            identity({ schemaEpoch: 5 }),
            identity({ schemaDigest: "b".repeat(64) }),
        ]) {
            expect(() => store.begin(changed, 99)).toThrow(
                expect.objectContaining({ code: "CDB_STALE_EPOCH", message: "topology operation identity changed" })
            );
        }
        expect(() => store.begin(identity({ migrationId: "split-2" }), 99)).toThrow(
            expect.objectContaining({
                code: "CDB_STALE_EPOCH",
                message: "topology operation split-1 is already active",
            })
        );
    });

    test("reconstructs an active lease from SQLite after a process restart", () => {
        store.begin(identity(), 10);
        const reconstructed = new CatalogTopologyOperationStore(adaptSqlStorage(sqlStorage(db)));

        expect(reconstructed.active()).toEqual(store.active());
        expect(reconstructed.assertActive(identity())).toMatchObject({ migrationId: "split-1", status: "active" });
    });

    test("completes and aborts with exact terminal-state idempotency", () => {
        store.begin(identity(), 10);
        expect(store.complete(identity(), 2, 20)).toMatchObject({ status: "completed", completedEpoch: 2 });
        expect(store.complete(identity(), 2, 30)).toMatchObject({ status: "completed", updatedAt: 20 });
        expect(() => store.complete(identity(), 3, 30)).toThrow("topology completion epoch changed");
        expect(() => store.abort(identity(), 30)).toThrow("completed topology operation cannot abort");

        const aborted = identity({ migrationId: "split-abort", startEpoch: 2 });
        store.begin(aborted, 40);
        expect(store.abort(aborted, 50)).toMatchObject({ status: "aborted", completedEpoch: null });
        expect(store.abort(aborted, 60)).toMatchObject({ status: "aborted", updatedAt: 50 });
        expect(() => store.complete(aborted, 3, 60)).toThrow("aborted topology operation cannot complete");
    });

    test("keeps terminal retry tombstones and fails closed at the hard history limit", () => {
        const insert = db.prepare(
            `INSERT INTO catalog_topology_operations
             (migration_id, source_shard, destination_shard, range_lo, range_hi,
              start_epoch, schema_version, schema_epoch, schema_digest, status, completed_epoch,
              created_at, updated_at)
             VALUES (?, 'ShardDO_0', 'ShardDO_1', 0, 127, 1, 3, 4, ?, 'completed', 2, 10, 20)`
        );
        db.transaction(() => {
            for (let index = 0; index < CATALOG_TOPOLOGY_OPERATION_HISTORY_LIMIT; index++) {
                insert.run(`split-${index}`, digest);
            }
        })();

        expect(store.begin(identity(), 99)).toMatchObject({ status: "completed", completedEpoch: 2 });
        expect(() => store.begin(identity({ rangeHi: 128 }), 99)).toThrow("topology operation identity changed");
        expect(() => store.begin(identity({ migrationId: "split-overflow" }), 99)).toThrow(
            expect.objectContaining({
                code: "CDB_RATE_LIMITED",
                message: `topology operation history reached its ${CATALOG_TOPOLOGY_OPERATION_HISTORY_LIMIT}-record limit`,
            })
        );
        expect(db.query("SELECT COUNT(*) AS count FROM catalog_topology_operations").get()).toEqual({
            count: CATALOG_TOPOLOGY_OPERATION_HISTORY_LIMIT,
        });
    });
});
