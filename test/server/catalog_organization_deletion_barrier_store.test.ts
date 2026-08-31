import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    CatalogOrganizationDeletionBarrierStore,
    initializeCatalogOrganizationDeletionBarrierStore,
} from "../../src/server/do/catalog-organization-deletion-barrier-store.ts";
import {
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

const IDENTITY = Object.freeze({ migrationId: "file-move-7-9", rangeLo: 7, rangeHi: 9 });

describe("Catalog organization deletion range barrier", () => {
    let db: Database;
    let deletions: CatalogOrganizationDeletionStore;
    let barriers: CatalogOrganizationDeletionBarrierStore;

    beforeEach(() => {
        db = new Database(":memory:");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCatalogOrganizationDeletionStore(sql);
        initializeCatalogOrganizationDeletionBarrierStore(sql);
        deletions = new CatalogOrganizationDeletionStore(sql);
        barriers = new CatalogOrganizationDeletionBarrierStore(sql);
    });

    afterEach(() => db.close());

    test("waits only for older pending deletions inside the exact range", () => {
        deletions.record("older-inside", 8, 10);
        deletions.record("older-outside", 12, 11);
        expect(barriers.begin(IDENTITY, 20)).toMatchObject({
            ...IDENTITY,
            deletionWatermark: 2,
            status: "active",
        });
        expect(barriers.status(IDENTITY).olderDeletionsComplete).toBe(false);
        deletions.complete("older-outside", 21);
        expect(barriers.status(IDENTITY).olderDeletionsComplete).toBe(false);
        deletions.complete("older-inside", 22);
        expect(barriers.status(IDENTITY).olderDeletionsComplete).toBe(true);

        // This row bypasses the admission guard to prove the durable watermark
        // distinguishes pre-barrier work from impossible post-barrier work.
        deletions.record("newer-inside", 8, 23);
        expect(barriers.status(IDENTITY).olderDeletionsComplete).toBe(true);
    });

    test("rolls a newly deleted organization back with its surrounding auth transaction", () => {
        barriers.begin(IDENTITY, 20);
        expect(() =>
            db.transaction(() => {
                db.run("CREATE TABLE IF NOT EXISTS auth_organizations (id TEXT PRIMARY KEY)");
                db.run("INSERT INTO auth_organizations (id) VALUES ('org-delete')");
                db.run("DELETE FROM auth_organizations WHERE id = 'org-delete'");
                deletions.record("org-delete", 8, 21);
                barriers.assertDeletionAllowed(8);
            })()
        ).toThrow(expect.objectContaining({ code: "CDB_STALE_EPOCH" }));
        expect(deletions.read("org-delete")).toBeNull();
        expect(() => barriers.assertDeletionAllowed(6)).not.toThrow();
        expect(() => barriers.assertDeletionAllowed(10)).not.toThrow();
    });

    test("releases only after older work completes and keeps terminal retry tombstones", () => {
        deletions.record("older", 7, 10);
        const active = barriers.begin(IDENTITY, 20);
        expect(barriers.begin(IDENTITY, 21)).toEqual(active);
        expect(() => barriers.release(IDENTITY, 22)).toThrow(/still pending/);
        deletions.complete("older", 23);
        const released = barriers.release(IDENTITY, 24);
        expect(released).toMatchObject({ status: "released", finishedAt: 24 });
        expect(barriers.release(IDENTITY, 25)).toEqual(released);
        expect(() => barriers.abort(IDENTITY, 26)).toThrow(/cannot abort/);
        expect(() => barriers.assertDeletionAllowed(8)).not.toThrow();
        expect(() => barriers.begin({ ...IDENTITY, rangeHi: 10 }, 27)).toThrow(/different range/);
    });

    test("abort reopens deletion admission without treating pending older work as complete", () => {
        deletions.record("older", 9, 10);
        barriers.begin(IDENTITY, 20);
        const aborted = barriers.abort(IDENTITY, 21);
        expect(aborted).toMatchObject({ status: "aborted", finishedAt: 21 });
        expect(barriers.abort(IDENTITY, 22)).toEqual(aborted);
        expect(barriers.status(IDENTITY)).toMatchObject({
            barrier: { status: "aborted" },
            olderDeletionsComplete: false,
        });
        expect(() => barriers.assertDeletionAllowed(9)).not.toThrow();
        expect(() => barriers.release(IDENTITY, 23)).toThrow(/cannot release/);
    });

    test("fails closed if durable corruption creates overlapping active barriers", () => {
        barriers.begin(IDENTITY, 20);
        db.run("DROP INDEX catalog_organization_deletion_barriers_one_active");
        db.run(
            `INSERT INTO catalog_organization_deletion_barriers
             (migration_id, range_lo, range_hi, deletion_watermark, status, created_at, finished_at)
             VALUES ('corrupt-overlap', 8, 10, 0, 'active', 21, NULL)`
        );
        expect(() => barriers.assertDeletionAllowed(8)).toThrow(/overlapping active barriers/);
    });
});
