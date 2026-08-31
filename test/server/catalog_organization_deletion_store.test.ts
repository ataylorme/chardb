import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    CATALOG_ORGANIZATION_DELETION_BATCH_SIZE,
    CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE,
    CatalogOrganizationDeletionStore,
    initializeCatalogOrganizationDeletionStore,
} from "../../src/server/do/catalog-organization-deletion-store.ts";
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

describe("Catalog organization deletion store", () => {
    let db: Database;
    let store: CatalogOrganizationDeletionStore;

    beforeEach(() => {
        db = new Database(":memory:");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCatalogOrganizationDeletionStore(sql);
        store = new CatalogOrganizationDeletionStore(sql);
    });

    afterEach(() => db.close());

    test("retains a permanent idempotent identity fence after delivery", () => {
        expect(store.record("org-a", 7, 100)).toMatchObject({
            organizationId: "org-a",
            vshard: 7,
            status: "pending",
            attempts: 0,
        });
        expect(store.record("org-a", 9, 200)).toMatchObject({ vshard: 7, createdAt: 100 });
        expect(store.complete("org-a", 300)).toMatchObject({ status: "complete", completedAt: 300 });
        expect(store.record("org-a", 11, 400)).toMatchObject({
            vshard: 7,
            status: "complete",
            completedAt: 300,
        });
        expect(store.isDeleted("org-a")).toBe(true);
        expect(store.nextPendingAt()).toBeNull();
    });

    test("orders and bounds due work", () => {
        for (let index = CATALOG_ORGANIZATION_DELETION_BATCH_SIZE; index >= 0; index--) {
            store.record(`org-${String(index).padStart(2, "0")}`, index, 100 + index);
        }
        const due = store.due(1_000);
        expect(due).toHaveLength(CATALOG_ORGANIZATION_DELETION_BATCH_SIZE);
        expect(due[0]?.organizationId).toBe("org-00");
        expect(due.at(-1)?.organizationId).toBe("org-15");
    });

    test("separates expected continuation deadlines from failure backoff", () => {
        store.record("org-a", 1, 100);
        expect(store.deferUntil("org-a", 100, 5_000)).toMatchObject({
            attempts: 0,
            nextAttemptAt: 5_000,
            lastError: null,
        });
        expect(store.due(4_999)).toEqual([]);
        expect(store.defer("org-a", 5_000, "network down")).toMatchObject({
            attempts: 1,
            nextAttemptAt: 6_000,
            lastError: "network down",
        });
        expect(store.defer("org-a", 6_000, "still down")).toMatchObject({
            attempts: 2,
            nextAttemptAt: 8_000,
        });
    });

    test("bounds shard handoff and never requeues an acknowledged shard", () => {
        store.record("org-many", 1, 100);
        const shardIds = Array.from(
            { length: CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE + 8 },
            (_, index) => `ShardDO_${String(index).padStart(2, "0")}`
        );
        expect(store.recordShards("org-many", [...shardIds].reverse(), 100)).toHaveLength(40);

        const first = store.dueShards(100);
        expect(first).toHaveLength(CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE);
        expect(first.map(item => item.shardId)).toEqual(shardIds.slice(0, 32));
        for (const handoff of first) store.completeShard(handoff.organizationId, handoff.shardId, 101);

        const second = store.dueShards(101);
        expect(second.map(item => item.shardId)).toEqual(shardIds.slice(32));
        const [failed, ...accepted] = second;
        if (!failed) throw new Error("missing failed shard fixture");
        expect(store.deferShard(failed.organizationId, failed.shardId, 101, "unavailable")).toMatchObject({
            attempts: 1,
            nextAttemptAt: 1_101,
            lastError: "unavailable",
        });
        for (const handoff of accepted) store.completeShard(handoff.organizationId, handoff.shardId, 102);

        expect(store.dueShards(1_100)).toEqual([]);
        expect(store.dueShards(1_101).map(item => item.shardId)).toEqual([failed.shardId]);
        store.completeShard(failed.organizationId, failed.shardId, 1_101);
        expect(store.read("org-many")).toMatchObject({ status: "complete", completedAt: 1_101 });
        expect(store.nextPendingAt()).toBeNull();
        expect(store.recordShards("org-many", ["ShardDO_new"], 2_000).map(item => item.shardId)).toEqual(shardIds);
    });

    test("reconstructs a pending shard retry without resetting completed acknowledgements", () => {
        store.record("org-restart", 2, 100);
        store.recordShards("org-restart", ["ShardDO_a", "ShardDO_b"], 100);
        store.completeShard("org-restart", "ShardDO_a", 101);
        store.deferShard("org-restart", "ShardDO_b", 101, "restart me");

        const reconstructed = new CatalogOrganizationDeletionStore(store.sql);
        expect(reconstructed.shards("org-restart")).toEqual([
            expect.objectContaining({ shardId: "ShardDO_a", status: "complete", attempts: 0 }),
            expect.objectContaining({
                shardId: "ShardDO_b",
                status: "pending",
                attempts: 1,
                nextAttemptAt: 1_101,
            }),
        ]);
        expect(reconstructed.dueShards(1_101).map(item => item.shardId)).toEqual(["ShardDO_b"]);
    });

    test("shares one shard batch across organizations before advancing either inventory", () => {
        const shardIds = Array.from({ length: 20 }, (_, index) => `ShardDO_${String(index).padStart(2, "0")}`);
        for (const organizationId of ["org-a", "org-b"]) {
            store.record(organizationId, organizationId === "org-a" ? 1 : 2, 100);
            store.recordShards(organizationId, shardIds, 100);
        }
        const due = store.dueShards(100);
        expect(due).toHaveLength(CATALOG_ORGANIZATION_DELETION_SHARD_BATCH_SIZE);
        expect(due.filter(item => item.organizationId === "org-a")).toHaveLength(16);
        expect(due.filter(item => item.organizationId === "org-b")).toHaveLength(16);
        expect(new Set(due.map(item => item.shardId))).toEqual(new Set(shardIds.slice(0, 16)));
    });

    test("rolls back the fence with its surrounding transaction", () => {
        expect(() =>
            db.transaction(() => {
                store.record("org-rollback", 1, 100);
                throw new Error("rollback");
            })()
        ).toThrow("rollback");
        expect(store.read("org-rollback")).toBeNull();
    });
});
