import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { CDB_VECTOR_RESHARD_START_CURSOR } from "../../src/server/do/cdb-vector-reshard-records.ts";
import {
    RESHARDER_VECTOR_CURSOR_DDL,
    ResharderVectorCursorStore,
} from "../../src/server/do/resharder-vector-cursor-store.ts";
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

function setup(nowMs = 100) {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE migration_state (
          mig_id TEXT PRIMARY KEY,
          phase INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ${RESHARDER_VECTOR_CURSOR_DDL}
        INSERT INTO migration_state VALUES ('mig-a', 1, 1);
    `);
    const store = new ResharderVectorCursorStore(adaptSqlStorage(sqlStorage(db)), () => nowMs);
    store.ensureForMigrations();
    return { db, store };
}

describe("resharder vector cursor store", () => {
    const databases: Database[] = [];
    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("checkpoints exact begin, copy, parity, abort, and finish progress", () => {
        const fixture = setup(500);
        databases.push(fixture.db);
        const { store } = fixture;
        expect(store.read("mig-a")).toMatchObject({ enabled: null, copyPageNumber: 0, copyDone: false });

        const start = { ...CDB_VECTOR_RESHARD_START_CURSOR, throughHeadSeq: 9 };
        store.persistBegin("mig-a", 1, true, 9, start);
        const headDone = { ...start, kind: "outbox" as const };
        store.persistCopy("mig-a", 1, 0, start, headDone, false);
        expect(store.read("mig-a")).toMatchObject({
            enabled: true,
            throughHeadSeq: 9,
            copyPageNumber: 1,
            copyCursor: headDone,
            copyDone: false,
        });

        const done = { ...headDone, kind: "done" as const };
        store.persistCopy("mig-a", 1, 1, headDone, done, true);
        store.persistParity("mig-a", 1, 0, store.read("mig-a").parityCursor, done, true);
        store.persistSourcePrepare("mig-a", 1, { afterPlacement: 7, afterVectorId: "vector-a" }, true);
        store.persistSourceDelete(
            "mig-a",
            1,
            { kind: "outbox", afterVectorId: "vector-a", afterPhysicalVersion: 0 },
            false
        );
        store.persistAbort("mig-a", 1, { kind: "attempt", afterVectorId: "vector-a", afterPhysicalVersion: 2 }, false);
        store.persistFinish("mig-a", 1, "source");
        store.persistFinish("mig-a", 1, "dest");
        expect(store.read("mig-a")).toMatchObject({
            copyDone: true,
            parityDone: true,
            parityPageNumber: 1,
            sourcePrepareCursor: { afterPlacement: 7, afterVectorId: "vector-a" },
            sourcePrepareDone: true,
            sourceDeleteCursor: { kind: "outbox", afterVectorId: "vector-a", afterPhysicalVersion: 0 },
            abortCursor: { kind: "attempt", afterVectorId: "vector-a", afterPhysicalVersion: 2 },
            sourceFinishDone: true,
            destFinishDone: true,
        });
        expect(fixture.db.query("SELECT updated_at FROM migration_vector_cursor").get()).toEqual({ updated_at: 500 });
    });

    test("rejects response drift and phase changes without moving the cursor", () => {
        const fixture = setup();
        databases.push(fixture.db);
        const { db, store } = fixture;
        const start = { ...CDB_VECTOR_RESHARD_START_CURSOR, throughHeadSeq: 3 };
        store.persistBegin("mig-a", 1, true, 3, start);
        expect(() => store.persistCopy("mig-a", 1, 1, start, start, false)).toThrow(
            "vector copy response does not match its durable request"
        );
        expect(store.read("mig-a").copyPageNumber).toBe(0);

        db.run("UPDATE migration_state SET phase = 2 WHERE mig_id = 'mig-a'");
        expect(() => store.persistCopy("mig-a", 1, 0, start, start, false)).toThrow("migId=mig-a expected=1 actual=2");
        expect(store.read("mig-a").copyPageNumber).toBe(0);
    });

    test("fails closed on corrupt durable state", () => {
        const fixture = setup();
        databases.push(fixture.db);
        fixture.db.run("PRAGMA ignore_check_constraints = ON");
        fixture.db.run('UPDATE migration_vector_cursor SET parity_cursor_json = \'{"kind":"wat"}\'');
        expect(() => fixture.store.read("mig-a")).toThrow("page cursor kind is invalid");
    });

    test("upgrades an inactive legacy cursor and rejects an active incompatible movement", () => {
        const legacy = () => {
            const db = new Database(":memory:");
            db.exec(`
                CREATE TABLE migration_state (mig_id TEXT PRIMARY KEY, phase INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE migration_vector_cursor (
                  mig_id TEXT PRIMARY KEY,
                  enabled INTEGER,
                  through_head_seq INTEGER,
                  copy_page_number INTEGER NOT NULL DEFAULT 0,
                  copy_cursor_json TEXT,
                  copy_done INTEGER NOT NULL DEFAULT 0,
                  parity_cursor_json TEXT NOT NULL,
                  parity_done INTEGER NOT NULL DEFAULT 0,
                  updated_at INTEGER NOT NULL
                );
            `);
            return db;
        };
        const inactive = legacy();
        databases.push(inactive);
        inactive.run("INSERT INTO migration_state VALUES ('legacy', 6, 1)");
        inactive.run("INSERT INTO migration_vector_cursor VALUES (?, 0, NULL, 0, NULL, 1, ?, 0, 1)", [
            "legacy",
            JSON.stringify(CDB_VECTOR_RESHARD_START_CURSOR),
        ]);
        const upgraded = new ResharderVectorCursorStore(adaptSqlStorage(sqlStorage(inactive)));
        upgraded.ensureSchema();
        expect(upgraded.read("legacy")).toMatchObject({
            enabled: false,
            sourceFrozen: false,
            abortDone: false,
            sourceFinishDone: false,
            destFinishDone: false,
        });

        const active = legacy();
        databases.push(active);
        active.run("INSERT INTO migration_state VALUES ('active', 1, 1)");
        active.run("INSERT INTO migration_vector_cursor VALUES (?, 1, 3, 0, ?, 0, ?, 0, 1)", [
            "active",
            JSON.stringify({ ...CDB_VECTOR_RESHARD_START_CURSOR, throughHeadSeq: 3 }),
            JSON.stringify(CDB_VECTOR_RESHARD_START_CURSOR),
        ]);
        expect(() => new ResharderVectorCursorStore(adaptSqlStorage(sqlStorage(active))).ensureSchema()).toThrow(
            "predates durable lifecycle cursors"
        );
    });

    test("reports malformed legacy core columns as a controlled phase mismatch", () => {
        const malformed = new Database(":memory:");
        databases.push(malformed);
        malformed.exec(`
            CREATE TABLE migration_state (mig_id TEXT PRIMARY KEY, phase INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE migration_vector_cursor (mig_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
        `);
        expect(() => new ResharderVectorCursorStore(adaptSqlStorage(sqlStorage(malformed))).ensureSchema()).toThrow(
            "vector migration cursor schema is incompatible; missing enabled"
        );
    });
});
