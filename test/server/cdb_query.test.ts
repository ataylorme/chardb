import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { forOrg } from "../../src/server/index.ts";
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

const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const user = sqliteTable("user", { id: text("id").primaryKey() });
const { cdbTable } = forOrg();
const records = cdbTable(
    "query_records",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        ownerId: text("owner_id")
            .notNull()
            .references(() => user.id),
        groupId: text("group_id").notNull(),
        value: integer("value").notNull(),
        secretNote: text("secret_note"),
    },
    {
        selfBy: "ownerId",
        roles: {
            member: { read: { exclude: ["secretNote"] } },
            self: { read: "*" },
        },
    }
);
const privateRecords = cdbTable(
    "query_private_records",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
    },
    { roles: { member: { create: "*" } } }
);
const publicRecords = cdbTable(
    "query_public_records",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        displayName: text("display_name").notNull(),
    },
    { publicRead: true }
);
const joinTarget = sqliteTable("query_join_target", { id: text("id").primaryKey() });
const schema = { organization, user, records, privateRecords, publicRecords };
const api = createApi(schema);

const listRecords = api.query(async function listRecordsHandler(ctx, args: { groupId: string }) {
    return ctx.db.select().from(records).where(eq(records.groupId, args.groupId)).orderBy(records.id).all();
});
const getRecord = api.query(async function getRecordHandler(ctx, args: { id: string }) {
    return ctx.db.select().from(records).where(eq(records.id, args.id)).get();
});
const awaitRecords = api.query(async function awaitRecordsHandler(ctx) {
    return await ctx.db.select().from(records).orderBy(records.id);
});
const listPrivateRecords = api.query(async function listPrivateRecordsHandler(ctx) {
    return ctx.db.select().from(privateRecords).all();
});
const listPublicRecords = api.query(async function listPublicRecordsHandler(ctx) {
    return ctx.db.select().from(publicRecords).orderBy(publicRecords.id).all();
});
const projectionAttempt = api.query(async function projectionAttemptHandler(ctx) {
    return ctx.db.select({ id: records.id }).from(records).all();
});
const joinAttempt = api.query(async function joinAttemptHandler(ctx) {
    return ctx.db.select().from(records).innerJoin(joinTarget, eq(joinTarget.id, records.id)).all();
});
const groupAttempt = api.query(async function groupAttemptHandler(ctx) {
    return ctx.db.select().from(records).groupBy(records.groupId).all();
});
const setAttempt = api.query(async function setAttemptHandler(ctx) {
    return ctx.db.select().from(records).union(ctx.db.select().from(records)).all();
});
const distinctAttempt = api.query(async function distinctAttemptHandler(ctx) {
    return ctx.db.selectDistinct().from(records).all();
});
const relationalAttempt = api.query(async function relationalAttemptHandler(ctx) {
    return (ctx.db.query as unknown as { records: { findMany(): Promise<unknown> } }).records.findMany();
});
const countAttempt = api.query(async function countAttemptHandler(ctx) {
    return ctx.db.$count(records);
});
const nonCdbAttempt = api.query(async function nonCdbAttemptHandler(ctx) {
    return ctx.db.select().from(organization).all();
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
    getRecord,
    awaitRecords,
    listPrivateRecords,
    listPublicRecords,
    projectionAttempt,
    joinAttempt,
    groupAttempt,
    setAttempt,
    distinctAttempt,
    relationalAttempt,
    countAttempt,
    nonCdbAttempt,
    nonJsonResult,
    thrownQuery,
    insertAttempt,
    updateAttempt,
    deleteAttempt,
    rawAttempt,
    transactionAttempt,
});
const ConfiguredCdb = configureCdbRuntime({ schema: () => schema, manifest: () => manifest });
const AUTH: CdbQueryRequest["auth"] = {
    userId: "user-1",
    tenantId: "org-a",
    roles: ["member"],
    claims: {},
};
const ANONYMOUS: CdbQueryRequest["auth"] = { userId: "", claims: {} };

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
        db.run(
            "INSERT INTO query_records (id, organization_id, owner_id, group_id, value, secret_note) VALUES (?, ?, ?, ?, ?, ?)",
            ["record-1", "org-a", "user-1", "group-a", 1, "mine"]
        );
        db.run(
            "INSERT INTO query_records (id, organization_id, owner_id, group_id, value, secret_note) VALUES (?, ?, ?, ?, ?, ?)",
            ["record-2", "org-a", "user-2", "group-a", 2, "theirs"]
        );
        db.run(
            "INSERT INTO query_records (id, organization_id, owner_id, group_id, value, secret_note) VALUES (?, ?, ?, ?, ?, ?)",
            ["record-other-tenant", "org-b", "user-1", "group-a", 3, "cross-tenant"]
        );
        db.run("INSERT INTO query_private_records (id, organization_id) VALUES ('private-1', 'org-a')");
        db.run(
            "INSERT INTO query_public_records (id, organization_id, display_name) VALUES ('public-a', 'org-a', 'Alpha'), ('public-b', 'org-b', 'Beta')"
        );
        return { db, cdb: configured.cdb };
    }

    test("reads persisted rows and returns an empty JSON array when nothing matches", async () => {
        const { cdb } = await setup();
        await expect(
            cdb.query({ ref: listRecords.__chardbRef, args: { groupId: "group-a" }, auth: AUTH })
        ).resolves.toEqual({
            ok: true,
            result: [
                {
                    id: "record-1",
                    organizationId: "org-a",
                    ownerId: "user-1",
                    groupId: "group-a",
                    value: 1,
                    secretNote: "mine",
                },
                {
                    id: "record-2",
                    organizationId: "org-a",
                    ownerId: "user-2",
                    groupId: "group-a",
                    value: 2,
                    secretNote: null,
                },
            ],
        });
        await expect(
            cdb.query({ ref: listRecords.__chardbRef, args: { groupId: "missing" }, auth: AUTH })
        ).resolves.toEqual({ ok: true, result: [] });
    });

    test("masks get and awaited full-row results while preserving JS field names", async () => {
        const { cdb } = await setup();
        await expect(cdb.query({ ref: getRecord.__chardbRef, args: { id: "record-2" }, auth: AUTH })).resolves.toEqual({
            ok: true,
            result: {
                id: "record-2",
                organizationId: "org-a",
                ownerId: "user-2",
                groupId: "group-a",
                value: 2,
                secretNote: null,
            },
        });
        await expect(cdb.query({ ref: awaitRecords.__chardbRef, args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: true,
            result: [
                { id: "record-1", secretNote: "mine" },
                { id: "record-2", secretNote: null },
            ],
        });
    });

    test("default-denies private reads and permits anonymous publicRead", async () => {
        const { cdb } = await setup();
        await expect(cdb.query({ ref: listPrivateRecords.__chardbRef, args: {}, auth: AUTH })).resolves.toEqual({
            ok: true,
            result: [],
        });
        await expect(cdb.query({ ref: listPublicRecords.__chardbRef, args: {}, auth: ANONYMOUS })).resolves.toEqual({
            ok: true,
            result: [
                { id: "public-a", organizationId: "org-a", displayName: "Alpha" },
                { id: "public-b", organizationId: "org-b", displayName: "Beta" },
            ],
        });
    });

    test("rejects unmaskable select shapes and query-builder bypasses", async () => {
        const { cdb } = await setup();
        for (const ref of [
            projectionAttempt.__chardbRef,
            joinAttempt.__chardbRef,
            groupAttempt.__chardbRef,
            setAttempt.__chardbRef,
            distinctAttempt.__chardbRef,
            relationalAttempt.__chardbRef,
            countAttempt.__chardbRef,
            nonCdbAttempt.__chardbRef,
        ]) {
            await expect(cdb.query({ ref, args: {}, auth: AUTH })).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_UNSUPPORTED_FEATURE" },
            });
        }
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
                { id: "record-other-tenant", value: 3 },
            ]);
        }
    });
});
