import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    DurableObjectRecovery,
    abortForArmedRecoveryRestore,
    assertRecoveryAvailable,
    assertRecoveryAvailableFor,
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

    test("arms only the fence and schedules native recovery on commit", async () => {
        const armed = await recovery.arm("00000000-history", 42);
        expect(armed).toEqual({
            targetBookmark: "00000000-history",
            undoBookmark: currentBookmark,
            armedAt: 42,
            commitAt: null,
            nativeScheduled: false,
        });
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toEqual(armed);
        expect(restoreTargets).toEqual([]);
        await expect(recovery.arm("00000000-other", 43)).rejects.toMatchObject({ code: "CDB_STALE_EPOCH" });
        expect(await recovery.arm("00000000-history", 44)).toEqual(armed);
        expect(restoreTargets).toEqual([]);
        expect(() => assertRecoveryAvailable(adaptSqlStorage(storage.sql))).toThrow("restore is in progress");
        expect(() => assertRecoveryAvailableFor(adaptSqlStorage(storage.sql), "00000000-history")).not.toThrow();
        expect(() => assertRecoveryAvailableFor(adaptSqlStorage(storage.sql), "00000000-other")).toThrow(
            "different recovery point"
        );

        const committedAt = Date.now();
        expect(await recovery.commit("00000000-history")).toEqual({ scheduled: true });
        expect(restoreTargets).toEqual(["00000000-history"]);
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toMatchObject({
            undoBookmark: "00000002-undo",
            nativeScheduled: true,
        });
        expect(alarms).toHaveLength(1);
        expect(alarms[0]).toBeGreaterThanOrEqual(committedAt + 4_900);
        expect(await recovery.commit("00000000-history")).toEqual({ scheduled: true });
        expect(restoreTargets).toEqual(["00000000-history"]);
        expect(alarms).toHaveLength(2);
        expect(alarms[1]).toBe(alarms[0]);
    });

    test("cancels a prepared restore without creating a latent native target", async () => {
        await recovery.arm("00000000-history", 42);
        currentBookmark = "00000003-after-arm";
        expect(await recovery.cancel("00000000-history")).toEqual({ cancelled: true });
        expect(restoreTargets).toEqual([]);
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toBeNull();
        initializeRecoveryStorage(adaptSqlStorage(storage.sql));
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toBeNull();
        expect(await recovery.cancel("00000000-history")).toEqual({ cancelled: false });
    });

    test("rejects cancellation after native recovery commit begins", async () => {
        await recovery.arm("00000000-history", 42);
        await recovery.commit("00000000-history");
        await expect(recovery.cancel("00000000-history")).rejects.toMatchObject({ code: "CDB_STALE_EPOCH" });
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toMatchObject({
            targetBookmark: "00000000-history",
            nativeScheduled: true,
        });
    });

    test("keeps the fence when the native commit response is uncertain", async () => {
        let call = 0;
        storage.onNextSessionRestoreBookmark = async bookmark => {
            restoreTargets.push(bookmark);
            call++;
            if (call === 1) throw new Error("native arm response lost");
            return "00000002-undo";
        };
        await recovery.arm("00000000-history", 42);
        await expect(recovery.commit("00000000-history")).rejects.toThrow("native arm response lost");
        expect(restoreTargets).toEqual(["00000000-history"]);
        expect(readArmedRecoveryRestore(adaptSqlStorage(storage.sql))).toMatchObject({
            targetBookmark: "00000000-history",
            commitAt: expect.any(Number),
            nativeScheduled: false,
        });
        expect(await recovery.commit("00000000-history")).toEqual({ scheduled: true });
        expect(restoreTargets).toEqual(["00000000-history", "00000000-history"]);
    });

    test("skips prepared alarms and aborts only after native recovery is committed", async () => {
        let abortedWith = "";
        const state = {
            abort(reason: string) {
                abortedWith = reason;
                throw new Error(reason);
            },
        } as unknown as DurableObjectState;
        expect(abortForArmedRecoveryRestore(state, adaptSqlStorage(storage.sql))).toBe(false);
        expect(abortedWith).toBe("");
        await recovery.arm("00000000-history", 42);
        expect(abortForArmedRecoveryRestore(state, adaptSqlStorage(storage.sql))).toBe(true);
        expect(abortedWith).toBe("");
        expect(restoreTargets).toEqual([]);
        await recovery.commit("00000000-history");
        expect(() => abortForArmedRecoveryRestore(state, adaptSqlStorage(storage.sql))).toThrow(
            "applying CharDB point-in-time restore"
        );
    });
});
