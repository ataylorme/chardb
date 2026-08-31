import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
    CDB_ROUTING_FENCE_MAX_ROWS,
    CDB_ROUTING_FENCE_STORE_DDL,
    type CdbRoutingFenceIdentity,
    CdbRoutingFenceStore,
} from "../../src/server/do/cdb-routing-fence-store.ts";

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

function createStore(db: Database): CdbRoutingFenceStore {
    for (const statement of CDB_ROUTING_FENCE_STORE_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        db.run(statement);
    }
    return new CdbRoutingFenceStore({
        sql: sqlStorage(db),
        transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
    } as unknown as DurableObjectStorage);
}

const first: CdbRoutingFenceIdentity = {
    migrationId: "move-7-8-v1",
    rangeLo: 7,
    rangeHi: 8,
    sourceGeneration: 4,
    destinationGeneration: 5,
};

const databases: Database[] = [];

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

describe("Cdb routing fence store", () => {
    test("prepares and activates only one exact immutable identity", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);

        const prepared = store.prepare(first, 100);
        expect(prepared).toEqual({
            ...first,
            status: "prepared",
            preparedAt: 100,
            activatedAt: null,
            cleanedAt: null,
            supersededAt: null,
        });
        expect(store.prepare(first, 101)).toEqual(prepared);
        expect(() => store.prepare({ ...first, rangeHi: 9 }, 101)).toThrow(
            expect.objectContaining({ code: "CDB_STALE_EPOCH", retryable: true })
        );
        expect(() => store.activate({ ...first, destinationGeneration: 6 }, 102)).toThrow(
            expect.objectContaining({ code: "CDB_INVALID_ARGS", retryable: false })
        );

        const active = store.activate(first, 102);
        expect(active).toEqual({ ...prepared, status: "active", activatedAt: 102 });
        expect(store.activate(first, 103)).toEqual(active);
        expect(store.activeSourceFence(7)).toEqual(active);
        expect(store.activeSourceFence(9)).toBeNull();
    });

    test("admits only the exact source generation while prepared and fences every write after activation", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        store.prepare(first, 100);

        expect(() => store.assertMutationAdmission({ schemaEpoch: 4, vshard: 7 })).not.toThrow();
        for (const schemaEpoch of [3, 5]) {
            expect(() => store.assertMutationAdmission({ schemaEpoch, vshard: 7 })).toThrow(
                expect.objectContaining({ code: "CDB_STALE_EPOCH", retryable: true })
            );
        }
        expect(() => store.assertMutationAdmission({ schemaEpoch: 99, vshard: 9 })).not.toThrow();

        store.activate(first, 101);
        for (const schemaEpoch of [4, 5, 6]) {
            expect(() => store.assertMutationAdmission({ schemaEpoch, vshard: 8 })).toThrow(
                expect.objectContaining({ code: "CDB_STALE_EPOCH", retryable: true })
            );
        }
    });

    test("cancels prepared or active fences into inert tombstones before cutover", () => {
        for (const activate of [false, true]) {
            const db = new Database(":memory:");
            databases.push(db);
            const store = createStore(db);
            store.prepare(first, 100);
            if (activate) store.activate(first, 101);
            expect(store.cancelBeforeCutover(first, 102)).toMatchObject({
                ...first,
                status: "superseded",
                activatedAt: activate ? 101 : 102,
                cleanedAt: 102,
                supersededAt: 102,
            });
            expect(store.cancelBeforeCutover(first, 103)).toEqual(store.byMigrationId(first.migrationId));
            expect(store.activate(first, 104)).toMatchObject({ status: "superseded" });
            expect(store.activeSourceFence(7)).toBeNull();
            expect(() => store.assertMutationAdmission({ schemaEpoch: 4, vshard: 7 })).not.toThrow();
        }
    });

    test("keeps cleanup as a permanent fence and permits only a newer exact-range successor", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        store.prepare(first, 100);
        expect(() => store.cleanup(first, 101)).toThrow(
            expect.objectContaining({ code: "CDB_RESHARD_PHASE_MISMATCH" })
        );
        store.activate(first, 102);
        const cleaned = store.cleanup(first, 103);
        expect(cleaned).toMatchObject({ status: "cleaned", cleanedAt: 103 });
        expect(store.cleanup(first, 104)).toEqual(cleaned);
        expect(store.activeSourceFence(8)).toEqual(cleaned);
        expect(() => store.assertMutationAdmission({ schemaEpoch: 4, vshard: 8 })).toThrow(
            expect.objectContaining({ code: "CDB_STALE_EPOCH", retryable: true })
        );

        const successor: CdbRoutingFenceIdentity = {
            migrationId: "move-7-8-v2",
            rangeLo: 7,
            rangeHi: 8,
            sourceGeneration: 8,
            destinationGeneration: 9,
        };
        expect(store.prepare(successor, 105)).toMatchObject({ status: "prepared" });
        expect(store.byMigrationId(first.migrationId)).toMatchObject({ status: "superseded", supersededAt: 105 });
        expect(store.activeSourceFence(7)).toBeNull();
        expect(() => store.assertMutationAdmission({ schemaEpoch: 8, vshard: 7 })).not.toThrow();
        expect(() =>
            store.prepare(
                { ...successor, migrationId: "not-newer", sourceGeneration: 9, destinationGeneration: 10 },
                106
            )
        ).toThrow(expect.objectContaining({ code: "CDB_STALE_EPOCH" }));
    });

    test("rejects every partial overlap and fails closed if storage contains overlapping live fences", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        store.prepare(first, 100);
        for (const [rangeLo, rangeHi] of [
            [6, 7],
            [8, 9],
            [7, 7],
            [6, 9],
        ] as const) {
            expect(() =>
                store.prepare(
                    {
                        migrationId: `overlap-${rangeLo}-${rangeHi}`,
                        rangeLo,
                        rangeHi,
                        sourceGeneration: 4,
                        destinationGeneration: 5,
                    },
                    101
                )
            ).toThrow(expect.objectContaining({ code: "CDB_STALE_EPOCH", retryable: true }));
        }

        db.run(
            `INSERT INTO _chardb_routing_fences
             (migration_id, range_lo, range_hi, source_generation, destination_generation, status, prepared_at)
             VALUES ('corrupt-overlap', 8, 9, 6, 7, 'prepared', 102)`
        );
        expect(() => store.assertMutationAdmission({ schemaEpoch: 4, vshard: 8 })).toThrow(
            expect.objectContaining({ code: "CDB_INVARIANT", retryable: false })
        );
    });

    test("validates ranges, generations, migration ids, and lookup vshards", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        for (const identity of [
            { ...first, migrationId: "" },
            { ...first, rangeLo: -1 },
            { ...first, rangeHi: 16_384 },
            { ...first, rangeLo: 9, rangeHi: 8 },
            { ...first, sourceGeneration: 0, destinationGeneration: 1 },
            { ...first, destinationGeneration: 6 },
        ]) {
            expect(() => store.prepare(identity, 100)).toThrow(
                expect.objectContaining({ code: "CDB_INVALID_ARGS", retryable: false })
            );
        }
        expect(() => store.activeSourceFence(16_384)).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));
    });

    test("bounds retained superseded history without breaking exact retries", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const store = createStore(db);
        db.run(
            `WITH RECURSIVE history(i) AS (
               SELECT 0
               UNION ALL
               SELECT i + 1 FROM history WHERE i + 1 < ${CDB_ROUTING_FENCE_MAX_ROWS}
             )
             INSERT INTO _chardb_routing_fences
             (migration_id, range_lo, range_hi, source_generation, destination_generation, status,
              prepared_at, activated_at, cleaned_at, superseded_at)
             SELECT 'history-' || i, i, i, 1, 2, 'superseded', 1, 1, 1, 1 FROM history`
        );

        expect(
            store.prepare(
                {
                    migrationId: "history-0",
                    rangeLo: 0,
                    rangeHi: 0,
                    sourceGeneration: 1,
                    destinationGeneration: 2,
                },
                10
            )
        ).toMatchObject({ status: "superseded" });
        expect(() =>
            store.prepare(
                {
                    migrationId: "over-cap",
                    rangeLo: 0,
                    rangeHi: 0,
                    sourceGeneration: 4,
                    destinationGeneration: 5,
                },
                10
            )
        ).toThrow(expect.objectContaining({ code: "CDB_RATE_LIMITED", retryable: true }));
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_routing_fences").get()).toEqual({
            count: CDB_ROUTING_FENCE_MAX_ROWS,
        });
    });
});
