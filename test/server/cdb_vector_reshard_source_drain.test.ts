import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { initializeCdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import {
    CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE,
    CdbVectorReshardSourceDrainStore,
} from "../../src/server/do/cdb-vector-reshard-source-drain.ts";
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

function insertHead(db: Database, index: number, placement = 7): string {
    const vectorId = `vector-${index.toString().padStart(4, "0")}`;
    db.prepare(
        `INSERT INTO _chardb_vectors
           (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions,
            version, delivered_version, values_enc, metadata_json, state, updated_at)
         VALUES (?, ?, ?, ?, 'resource-a', ?, 1, 1, 1, X'00000000', '{}', 'ready', 1)`
    ).run(vectorId, index + 1, `org-${placement}`, placement, `row-${index}`);
    db.prepare(
        `INSERT INTO _chardb_vector_outbox
           (vector_id, target_version, operation, phase, attempts, next_attempt_at)
         VALUES (?, 1, 'upsert', 'submit', 0, 1)`
    ).run(vectorId);
    db.prepare(
        `INSERT INTO _chardb_vector_attempts
           (vector_id, physical_version, first_sent_at, settle_after)
         VALUES (?, 1, 1, 1)`
    ).run(vectorId);
    return vectorId;
}

describe("vector reshard source drain", () => {
    const databases: Database[] = [];
    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("prepares and deletes 500/501 rows child-first without touching nonmoving state", () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("PRAGMA foreign_keys = ON");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCdbVectorOutboxStore(sql);
        for (let index = 0; index <= CDB_VECTOR_RESHARD_SOURCE_DRAIN_PAGE_SIZE; index++) insertHead(db, index);
        const survivor = insertHead(db, 9000, 8);
        const store = new CdbVectorReshardSourceDrainStore(sql);
        const identity = { migId: "mig-a", rangeLo: 7, rangeHi: 7 } as const;

        const first = store.prepare(identity, { afterPlacement: -1, afterVectorId: "" });
        expect(first).toMatchObject({ prepared: 500, done: false });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vectors WHERE state = 'deleting'").get()).toEqual({
            count: 500,
        });
        const replay = store.prepare(identity, { afterPlacement: -1, afterVectorId: "" });
        expect(replay).toEqual(first);
        const final = store.prepare(identity, first.cursor);
        expect(final).toMatchObject({ prepared: 1, done: true });

        let deletion = store.delete(identity, { kind: "attempt", afterVectorId: "", afterPhysicalVersion: 0 });
        expect(deletion).toMatchObject({ deleted: 500, done: false, cursor: { kind: "attempt" } });
        deletion = store.delete(identity, deletion.cursor);
        expect(deletion).toMatchObject({ deleted: 1, done: false, cursor: { kind: "outbox" } });
        deletion = store.delete(identity, deletion.cursor);
        expect(deletion).toMatchObject({ deleted: 500, done: false, cursor: { kind: "outbox" } });
        deletion = store.delete(identity, deletion.cursor);
        expect(deletion).toMatchObject({ deleted: 1, done: false, cursor: { kind: "head" } });
        deletion = store.delete(identity, deletion.cursor);
        expect(deletion).toMatchObject({ deleted: 500, done: false, cursor: { kind: "head" } });
        deletion = store.delete(identity, deletion.cursor);
        expect(deletion).toMatchObject({ deleted: 1, done: true, cursor: { kind: "done" } });

        expect(db.query("SELECT vector_id, state, version FROM _chardb_vectors").all()).toEqual([
            { vector_id: survivor, state: "ready", version: 1 },
        ]);
        expect(db.query("SELECT * FROM _chardb_vector_capacity").get()).toEqual({
            singleton: 1,
            reconciled: 1,
            head_count: 1,
            stored_bytes: 6,
            outbox_rows: 1,
            attempt_rows: 1,
        });
        expect(db.query("SELECT last_seq FROM _chardb_vector_head_sequence").get()).toEqual({ last_seq: 0 });
        expect(db.query("SELECT next_vshard FROM _chardb_vector_scheduler").get()).toEqual({ next_vshard: 0 });
    });

    test("rejects child deletion before every moved head is prepared", () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.run("PRAGMA foreign_keys = ON");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCdbVectorOutboxStore(sql);
        insertHead(db, 1);
        const store = new CdbVectorReshardSourceDrainStore(sql);
        expect(() =>
            store.delete(
                { migId: "mig-a", rangeLo: 7, rangeHi: 7 },
                { kind: "attempt", afterVectorId: "", afterPhysicalVersion: 0 }
            )
        ).toThrow("every moved head must be prepared");
    });
});
