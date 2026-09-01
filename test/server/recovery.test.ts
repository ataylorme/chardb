import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    DurableObjectRecovery,
    abortForArmedRecoveryRestore,
    assertRecoveryAvailable,
    initializeRecoveryStorage,
    readArmedRecoveryRestore,
} from "../../src/server/do/recovery.ts";
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

describe("Durable Object point-in-time recovery", () => {
    let db: Database;
    let currentBookmark: string;
    let requestedTimes: (number | Date)[];
    let restoreTargets: string[];
    let alarms: number[];
    let storage: DurableObjectStorage;
    let recovery: DurableObjectRecovery;

    beforeEach(() => {
        db = new Database(":memory:");
        currentBookmark = "00000001-current";
        requestedTimes = [];
        restoreTargets = [];
        alarms = [];
        storage = {
            sql: sqlStorage(db),
            transactionSync<T>(callback: () => T): T {
                db.exec("BEGIN IMMEDIATE");
                try {
                    const result = callback();
                    db.exec("COMMIT");
                    return result;
                } catch (error) {
                    db.exec("ROLLBACK");
                    throw error;
                }
            },
            async getCurrentBookmark() {
                return currentBookmark;
            },
            async getBookmarkForTime(timestamp: number | Date) {
                requestedTimes.push(timestamp);
                return "00000000-history";
            },
            async onNextSessionRestoreBookmark(bookmark: string) {
                restoreTargets.push(bookmark);
                return "00000002-undo";
            },
            async setAlarm(timestamp: number | Date) {
                alarms.push(typeof timestamp === "number" ? timestamp : timestamp.getTime());
            },
        } as unknown as DurableObjectStorage;
        const sql = adaptSqlStorage(storage.sql);
        initializeRecoveryStorage(sql);
        recovery = new DurableObjectRecovery(storage, () => adaptSqlStorage(storage.sql));
    });

    afterEach(() => db.close());

    test("captures current and historical native bookmarks", async () => {
        expect(await recovery.bookmark()).toEqual({ bookmark: currentBookmark, atMs: expect.any(Number) });
        const atMs = Date.now() - 1_000;
        expect(await recovery.bookmark(atMs)).toEqual({ bookmark: "00000000-history", atMs });
        expect(requestedTimes).toEqual([atMs]);
        await expect(recovery.bookmark(Date.now() + 1_000)).rejects.toMatchObject({ code: "CDB_INVALID_ARGS" });
    });

    test("arms idempotently, fences traffic, and schedules activation", async () => {
        const armed = await recovery.arm("00000000-history", 42);
        expect(armed).toEqual({
            targetBookmark: "00000000-history",
            undoBookmark: "00000002-undo",
            armedAt: 42,
        });
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toEqual(armed);
        expect(restoreTargets).toEqual(["00000000-history"]);
        await expect(recovery.arm("00000000-other", 43)).rejects.toMatchObject({ code: "CDB_STALE_EPOCH" });
        expect(await recovery.arm("00000000-history", 44)).toEqual(armed);
        expect(() => assertRecoveryAvailable(adaptSqlStorage(storage.sql))).toThrow("restore is in progress");

        expect(await recovery.commit("00000000-history")).toEqual({ scheduled: true });
        expect(alarms).toHaveLength(1);
    });

    test("cancels an armed restore by replacing the native target with current storage", async () => {
        await recovery.arm("00000000-history", 42);
        currentBookmark = "00000003-after-arm";
        expect(await recovery.cancel("00000000-history")).toEqual({ cancelled: true });
        expect(restoreTargets).toEqual(["00000000-history", "00000003-after-arm"]);
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toBeNull();
        expect(await recovery.cancel("00000000-history")).toEqual({ cancelled: false });
    });

    test("aborts an alarm turn only while a restore is armed", async () => {
        let abortedWith = "";
        const state = {
            abort(reason: string) {
                abortedWith = reason;
                throw new Error(reason);
            },
        } as unknown as DurableObjectState;
        abortForArmedRecoveryRestore(state, adaptSqlStorage(storage.sql));
        expect(abortedWith).toBe("");
        await recovery.arm("00000000-history", 42);
        expect(() => abortForArmedRecoveryRestore(state, adaptSqlStorage(storage.sql))).toThrow(
            "applying Chardb point-in-time restore"
        );
    });
});
