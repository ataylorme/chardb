import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { globalScope } from "../../src/server/index.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import type { CdbMutationRequest, CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId } from "../../src/types.ts";

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

const { cdbTable } = globalScope();
const messages = cdbTable(
    "outbox_messages",
    {
        id: text("id").primaryKey(),
        value: integer("value").notNull(),
    },
    { partitionBy: "id", roles: { member: { create: "*", read: "*" } } }
);
const reactions = cdbTable(
    "outbox_reactions",
    {
        id: text("id").primaryKey(),
        value: integer("value").notNull(),
    },
    { partitionBy: "id", roles: { member: { create: "*", read: "*" } } }
);
const schema = { messages, reactions };
const api = createApi(schema);

const putMessage = api.mutation({
    args: z.object({ id: z.string(), value: z.number().int() }),
    handler: function putMessageHandler(ctx, args) {
        ctx.db.insert(messages).values(args).run();
        return args.id;
    },
});

const putBoth = api.mutation({
    args: z.object({ id: z.string(), value: z.number().int() }),
    handler: function putBothHandler(ctx, args) {
        ctx.db.insert(messages).values(args).run();
        ctx.db.insert(reactions).values(args).run();
        return args.id;
    },
});

const inspectMessages = api.mutation({
    args: z.object({}),
    handler: function inspectMessagesHandler(ctx) {
        return ctx.db.select().from(messages).all();
    },
});

const failAfterWrite = api.mutation({
    args: z.object({ id: z.string(), value: z.number().int() }),
    handler: function failAfterWriteHandler(ctx, args) {
        ctx.db.insert(messages).values(args).run();
        throw new Error("handler failed after write");
    },
});

const manifest = manifestFromExports({ putMessage, putBoth, inspectMessages, failAfterWrite });
const ConfiguredCdb = configureCdbRuntime({ schema: () => schema, manifest: () => manifest });
const AUTH = {
    userId: "user-1",
    roles: ["member"],
    claims: {},
} as const;

function identity(registrationId: string, subId: number): LiveSubscriptionId {
    return {
        gatewayId: "gateway-1",
        registrationId,
        connectionId: `connection-${registrationId}`,
        clientId: ClientId("client-1"),
        subId: SubId(subId),
    };
}

function subscription(registration: LiveSubscriptionId, tables: readonly string[]): CdbSubscriptionRequest {
    return {
        subscription: registration,
        principalId: PrincipalId("user-1"),
        ref: ChardbRef("queries.ts#outboxProbe"),
        args: {},
        tables,
        intervals: [],
    };
}

function mutation(
    descriptor: { readonly __chardbRef: string },
    mutId: string,
    args: CdbMutationRequest["args"]
): CdbMutationRequest {
    return {
        principalId: "user-1",
        mutId,
        ref: descriptor.__chardbRef,
        args,
        auth: AUTH,
        schemaEpoch: 1,
    };
}

function changeSeq(db: Database): number {
    return (
        db.prepare("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1").get() as {
            change_seq: number;
        }
    ).change_seq;
}

function outbox(db: Database): readonly Record<string, unknown>[] {
    return db
        .prepare(
            `SELECT gateway_id, registration_id, change_seq
             FROM _chardb_invalidation_outbox
             ORDER BY gateway_id, registration_id`
        )
        .all() as Record<string, unknown>[];
}

describe("Cdb invalidation outbox", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    async function setup(): Promise<{ readonly db: Database; readonly cdb: Cdb }> {
        const db = new Database(":memory:");
        databases.push(db);
        let ready: Promise<unknown> = Promise.resolve();
        const state = {
            id: { toString: () => "outbox-shard-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        const cdb = new ConfiguredCdb(state, {});
        await ready;
        return { db, cdb };
    }

    test("advances once per committed write set and coalesces matching registrations", async () => {
        const { db, cdb } = await setup();
        const messageRegistration = identity("messages", 1);
        const reactionRegistration = identity("reactions", 2);
        await expect(
            cdb.subscribe(subscription(messageRegistration, ["outbox_messages", "outbox_messages"]))
        ).resolves.toMatchObject({ changeSeq: 0 });
        await expect(cdb.subscribe(subscription(reactionRegistration, ["outbox_reactions"]))).resolves.toMatchObject({
            changeSeq: 0,
        });
        expect(db.prepare("SELECT table_name FROM _chardb_live_subscription_tables ORDER BY table_name").all()).toEqual(
            [{ table_name: "outbox_messages" }, { table_name: "outbox_reactions" }]
        );

        expect(cdb.mutate(mutation(putMessage, "message-1", { id: "message-1", value: 1 }))).toMatchObject({
            ok: true,
            ran: true,
            touchedTables: ["outbox_messages"],
        });
        expect(changeSeq(db)).toBe(1);
        expect(outbox(db)).toEqual([{ gateway_id: "gateway-1", registration_id: "messages", change_seq: 1 }]);

        expect(cdb.mutate(mutation(putMessage, "message-2", { id: "message-2", value: 2 }))).toMatchObject({
            ok: true,
            ran: true,
        });
        expect(changeSeq(db)).toBe(2);
        expect(outbox(db)).toEqual([{ gateway_id: "gateway-1", registration_id: "messages", change_seq: 2 }]);

        expect(cdb.mutate(mutation(putMessage, "message-2", { id: "message-2", value: 2 }))).toMatchObject({
            ok: true,
            ran: false,
            touchedTables: [],
        });
        expect(cdb.mutate(mutation(inspectMessages, "read-only", {}))).toMatchObject({
            ok: true,
            ran: true,
            touchedTables: [],
        });
        expect(cdb.mutate(mutation(failAfterWrite, "handler-failure", { id: "failed", value: 9 }))).toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        expect(changeSeq(db)).toBe(2);
        expect(outbox(db)).toEqual([{ gateway_id: "gateway-1", registration_id: "messages", change_seq: 2 }]);
        expect(db.prepare("SELECT id FROM outbox_messages WHERE id = 'failed'").get()).toBeNull();

        await cdb.unsubscribe(messageRegistration);
        expect(outbox(db)).toEqual([]);
        expect(
            db.prepare("SELECT * FROM _chardb_live_subscription_tables WHERE registration_id = 'messages'").all()
        ).toEqual([]);
        expect(cdb.mutate(mutation(putMessage, "message-3", { id: "message-3", value: 3 }))).toMatchObject({
            ok: true,
            ran: true,
        });
        expect(changeSeq(db)).toBe(3);
        await expect(
            cdb.subscribe(subscription(identity("after-three", 3), ["outbox_messages"]))
        ).resolves.toMatchObject({ changeSeq: 3 });

        expect(cdb.mutate(mutation(putBoth, "both-1", { id: "both-1", value: 4 }))).toMatchObject({
            ok: true,
            ran: true,
            touchedTables: ["outbox_messages", "outbox_reactions"],
        });
        expect(changeSeq(db)).toBe(4);
        expect(outbox(db)).toEqual([
            { gateway_id: "gateway-1", registration_id: "after-three", change_seq: 4 },
            { gateway_id: "gateway-1", registration_id: "reactions", change_seq: 4 },
        ]);
    });

    test("rolls back the domain write and clock when outbox enqueue fails", async () => {
        const { db, cdb } = await setup();
        await cdb.subscribe(subscription(identity("messages", 1), ["outbox_messages"]));
        db.run(
            `CREATE TRIGGER fail_outbox_insert
             BEFORE INSERT ON _chardb_invalidation_outbox
             BEGIN
               SELECT RAISE(ABORT, 'forced outbox failure');
             END`
        );

        expect(cdb.mutate(mutation(putMessage, "must-roll-back", { id: "must-roll-back", value: 1 }))).toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        expect(changeSeq(db)).toBe(0);
        expect(outbox(db)).toEqual([]);
        expect(db.prepare("SELECT id FROM outbox_messages WHERE id = 'must-roll-back'").get()).toBeNull();
        expect(db.prepare("SELECT mut_id FROM _chardb_op_log WHERE mut_id = 'must-roll-back'").get()).toBeNull();
    });
});
