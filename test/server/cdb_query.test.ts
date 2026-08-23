import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { globalScope } from "../../src/server/index.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import type { CdbQueryRequest } from "../../src/server/rpc.ts";
import { ChardbRef } from "../../src/types.ts";

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

function construct(CdbClass: typeof Cdb, db: Database): { readonly cdb: Cdb; readonly ready: Promise<unknown> } {
    let ready: Promise<unknown> = Promise.resolve();
    const state = {
        id: { toString: () => "query-shard-1" },
        storage: {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    return { cdb: new CdbClass(state, {}), ready };
}

const { cdbTable } = globalScope();
const records = cdbTable(
    "query_records",
    {
        id: text("id").primaryKey(),
        groupId: text("group_id").notNull(),
        value: integer("value").notNull(),
    },
    { partitionBy: "groupId" }
);
const schema = { records };
const api = createApi(schema);

const listRecords = api.query(async function listRecordsHandler(ctx, args: { groupId: string }) {
    return ctx.db.select().from(records).where(eq(records.groupId, args.groupId)).orderBy(records.id).all();
});
const nonJsonResult = api.query(async function nonJsonResultHandler() {
    return new Date("2026-08-23T00:00:00Z");
});
const thrownQuery = api.query(async function thrownQueryHandler() {
    throw new Error("query exploded");
});
const insertAttempt = api.query(async function insertAttemptHandler(ctx) {
    ctx.db.insert(records).values({ id: "write-insert", groupId: "group-a", value: 9 }).run();
    return null;
});
const updateAttempt = api.query(async function updateAttemptHandler(ctx) {
    ctx.db.update(records).set({ value: 9 }).run();
    return null;
});
const deleteAttempt = api.query(async function deleteAttemptHandler(ctx) {
    ctx.db.delete(records).run();
    return null;
});
const rawAttempt = api.query(async function rawAttemptHandler(ctx) {
    ctx.db.run(sql.raw('DELETE FROM "query_records"'));
    return null;
});
const transactionAttempt = api.query(async function transactionAttemptHandler(ctx) {
    ctx.db.transaction(() => null);
    return null;
});

const manifest = manifestFromExports({
    listRecords,
    nonJsonResult,
    thrownQuery,
    insertAttempt,
    updateAttempt,
    deleteAttempt,
    rawAttempt,
    transactionAttempt,
});
const ConfiguredCdb = configureCdbRuntime({ schema: () => schema, manifest: () => manifest });
const AUTH: CdbQueryRequest["auth"] = { userId: "user-1", roles: ["member"], claims: {} };

describe("Cdb registered query execution", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    async function setup(): Promise<{ readonly db: Database; readonly cdb: Cdb }> {
        const db = new Database(":memory:");
        databases.push(db);
        const configured = construct(ConfiguredCdb, db);
        await configured.ready;
        db.run("INSERT INTO query_records (id, group_id, value) VALUES ('record-1', 'group-a', 1)");
        db.run("INSERT INTO query_records (id, group_id, value) VALUES ('record-2', 'group-a', 2)");
        return { db, cdb: configured.cdb };
    }

    test("reads persisted rows and returns an empty JSON array when nothing matches", async () => {
        const { cdb } = await setup();
        await expect(
            cdb.query({ ref: listRecords.__chardbRef, args: { groupId: "group-a" }, auth: AUTH })
        ).resolves.toEqual({
            ok: true,
            result: [
                { id: "record-1", groupId: "group-a", value: 1 },
                { id: "record-2", groupId: "group-a", value: 2 },
            ],
        });
        await expect(
            cdb.query({ ref: listRecords.__chardbRef, args: { groupId: "missing" }, auth: AUTH })
        ).resolves.toEqual({ ok: true, result: [] });
    });

    test("returns typed failures for unknown refs, non-JSON results, and thrown handlers", async () => {
        const { cdb } = await setup();
        await expect(cdb.query({ ref: ChardbRef("queries.ts#missing"), args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_REF_NOT_FOUND" },
        });
        await expect(cdb.query({ ref: nonJsonResult.__chardbRef, args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: expect.stringContaining("query result is not JSON") },
        });
        await expect(cdb.query({ ref: thrownQuery.__chardbRef, args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: "query exploded" },
        });
    });

    test("rejects write, raw, and transaction entry points before data changes", async () => {
        const { cdb, db } = await setup();
        for (const ref of [
            insertAttempt.__chardbRef,
            updateAttempt.__chardbRef,
            deleteAttempt.__chardbRef,
            rawAttempt.__chardbRef,
            transactionAttempt.__chardbRef,
        ]) {
            await expect(cdb.query({ ref, args: {}, auth: AUTH })).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_UNSUPPORTED_FEATURE" },
            });
            expect(db.query("SELECT id, value FROM query_records ORDER BY id").all()).toEqual([
                { id: "record-1", value: 1 },
                { id: "record-2", value: 2 },
            ]);
        }
    });
});
