import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    CATALOG_AUTH_INVALIDATION_BATCH_SIZE,
    CATALOG_AUTH_INVALIDATION_TARGET_LIMIT,
    CatalogAuthInvalidationStore,
    initializeCatalogAuthInvalidationStore,
} from "../../src/server/do/catalog-auth-invalidation-store.ts";
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

describe("Catalog auth invalidation store", () => {
    let db: Database;
    let store: CatalogAuthInvalidationStore;

    beforeEach(() => {
        db = new Database(":memory:");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCatalogAuthInvalidationStore(sql);
        store = new CatalogAuthInvalidationStore(sql);
    });

    afterEach(() => db.close());

    test("coalesces one scoped target to the newest exact epoch", () => {
        expect(store.enqueueTargets("tenant", "org-a", 2, ["ShardDO_0"], 100)).toEqual([
            expect.objectContaining({ scope: "tenant", scopeId: "org-a", shardId: "ShardDO_0", epoch: 2 }),
        ]);
        const firstTarget = store.targets("tenant", "org-a")[0];
        if (!firstTarget) throw new Error("expected queued tenant target");
        store.deferTarget(firstTarget, 100, "offline");
        expect(store.targets("tenant", "org-a")[0]).toMatchObject({ epoch: 2, attempts: 1, nextAttemptAt: 1_100 });

        store.enqueueTargets("tenant", "org-a", 2, ["ShardDO_0"], 200);
        expect(store.targets("tenant", "org-a")[0]).toMatchObject({ epoch: 2, attempts: 1, nextAttemptAt: 1_100 });

        store.enqueueTargets("tenant", "org-a", 3, ["ShardDO_0"], 300);
        expect(store.targets("tenant", "org-a")[0]).toMatchObject({
            epoch: 3,
            attempts: 0,
            nextAttemptAt: 300,
            lastError: null,
        });
        store.completeTarget({ scope: "tenant", scopeId: "org-a", shardId: "ShardDO_0", epoch: 2 });
        expect(store.targets("tenant", "org-a")).toHaveLength(1);
        store.completeTarget({ scope: "tenant", scopeId: "org-a", shardId: "ShardDO_0", epoch: 3 });
        expect(store.targets("tenant", "org-a")).toEqual([]);
    });

    test("retains routed and active-topology participants as a bounded exact target set", () => {
        const targets = store.enqueueTargets(
            "tenant",
            "org-a",
            4,
            ["ShardDO_dest", "ShardDO_current", "ShardDO_source", "ShardDO_dest"],
            100
        );
        expect(targets.map(target => target.shardId)).toEqual(["ShardDO_current", "ShardDO_dest", "ShardDO_source"]);
        expect(() => store.enqueueTargets("tenant", "org-a", 5, ["a", "b", "c", "d"], 200)).toThrow(
            "one through three shards"
        );
    });

    test("pages principal invalidation across physical shards and restarts on a newer epoch", () => {
        expect(store.enqueuePrincipal("user-a", 2, 100)).toMatchObject({
            scopeId: "user-a",
            epoch: 2,
            cursorShardId: null,
        });
        store.advancePrincipal("user-a", 2, "ShardDO_031", 200);
        expect(new CatalogAuthInvalidationStore(store.sql).principal("user-a")).toMatchObject({
            epoch: 2,
            cursorShardId: "ShardDO_031",
        });
        store.enqueuePrincipal("user-a", 3, 300);
        expect(store.principal("user-a")).toMatchObject({ epoch: 3, cursorShardId: null, attempts: 0 });
        store.completePrincipal("user-a", 2);
        expect(store.principal("user-a")).toMatchObject({ epoch: 3 });
        store.completePrincipal("user-a", 3);
        expect(store.principal("user-a")).toBeNull();
    });

    test("yields to another due principal between physical-shard pages", () => {
        store.enqueuePrincipal("user-a", 2, 100);
        store.enqueuePrincipal("user-b", 2, 100);
        expect(store.duePrincipal(100)?.scopeId).toBe("user-a");
        store.advancePrincipal("user-a", 2, "ShardDO_031", 100);
        expect(store.duePrincipal(100)?.scopeId).toBe("user-b");
        store.advancePrincipal("user-b", 2, "ShardDO_031", 100);
        expect(store.duePrincipal(101)?.scopeId).toBe("user-a");
    });

    test("bounds due work and backs off only the failed exact epoch", () => {
        for (let index = CATALOG_AUTH_INVALIDATION_BATCH_SIZE; index >= 0; index--) {
            store.enqueueTargets("tenant", `org-${String(index).padStart(2, "0")}`, 1, ["ShardDO_0"], 100 + index);
        }
        const due = store.dueTargets(1_000);
        expect(due).toHaveLength(CATALOG_AUTH_INVALIDATION_BATCH_SIZE);
        expect(due[0]?.scopeId).toBe("org-00");
        expect(due.at(-1)?.scopeId).toBe("org-31");
        const failed = due[0];
        if (!failed) throw new Error("expected due tenant target");
        store.deferTarget(failed, 1_000, "network down");
        expect(store.targets("tenant", failed.scopeId)[0]).toMatchObject({ attempts: 1, nextAttemptAt: 2_000 });
        expect(store.dueTargets(1_999).some(target => target.scopeId === failed.scopeId)).toBe(false);
    });

    test("pages one global job durably and restarts from the beginning for a newer epoch", () => {
        expect(store.enqueueGlobal(2, 100)).toMatchObject({ epoch: 2, cursorShardId: null, attempts: 0 });
        store.advanceGlobal(2, "ShardDO_031", 200);
        expect(new CatalogAuthInvalidationStore(store.sql).global()).toMatchObject({
            epoch: 2,
            cursorShardId: "ShardDO_031",
        });
        store.deferGlobal(2, 200, "response lost");
        expect(store.global()).toMatchObject({ epoch: 2, attempts: 1, nextAttemptAt: 1_200 });

        store.enqueueGlobal(3, 300);
        expect(store.global()).toMatchObject({
            epoch: 3,
            cursorShardId: null,
            attempts: 0,
            nextAttemptAt: 300,
            lastError: null,
        });
        store.completeGlobal(2);
        expect(store.global()).toMatchObject({ epoch: 3 });
        store.completeGlobal(3);
        expect(store.global()).toBeNull();
    });

    test("rolls capacity failure back with the surrounding auth transaction", () => {
        const insert = db.prepare(
            `INSERT INTO catalog_auth_invalidation_targets
              (scope, scope_id, shard_id, epoch, attempts, next_attempt_at, created_at, updated_at)
             VALUES ('tenant', ?, 'ShardDO_0', 1, 0, 0, 0, 0)`
        );
        db.transaction(() => {
            for (let index = 0; index < CATALOG_AUTH_INVALIDATION_TARGET_LIMIT; index++) {
                insert.run(`full-${index}`);
            }
        })();
        expect(() =>
            db.transaction(() => {
                db.run("CREATE TABLE auth_effect (id TEXT PRIMARY KEY)");
                db.run("INSERT INTO auth_effect VALUES ('rolled-back')");
                store.enqueueTargets("tenant", "overflow", 1, ["ShardDO_1"], 100);
            })()
        ).toThrow("reached its");
        expect(() => db.query("SELECT * FROM auth_effect").all()).toThrow();
    });

    test("bounds coalesced principal scans without multiplying them by shard count", () => {
        const insert = db.prepare(
            `INSERT INTO catalog_auth_invalidation_principals
              (scope_id, epoch, cursor_shard_id, attempts, next_attempt_at, created_at, updated_at)
             VALUES (?, 1, NULL, 0, 0, 0, 0)`
        );
        db.transaction(() => {
            for (let index = 0; index < CATALOG_AUTH_INVALIDATION_TARGET_LIMIT; index++) {
                insert.run(`principal-${index}`);
            }
        })();
        expect(() =>
            db.transaction(() => {
                db.run("CREATE TABLE principal_effect (id TEXT PRIMARY KEY)");
                db.run("INSERT INTO principal_effect VALUES ('rolled-back')");
                store.enqueuePrincipal("principal-overflow", 1, 100);
            })()
        ).toThrow("reached its");
        expect(() => db.query("SELECT * FROM principal_effect").all()).toThrow();
        expect(store.enqueuePrincipal("principal-0", 2, 100)).toMatchObject({ epoch: 2, cursorShardId: null });
    });
});
