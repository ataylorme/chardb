import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { globalScope } from "../../src/server/index.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import { CDB_JSON_MAX_AGGREGATE_MEMBERS, CDB_MUTATION_ARGS_MAX_DEPTH } from "../../src/server/result_limits.ts";
import type {
    CdbMutationRequest,
    CdbSubscriptionRequest,
    GatewayInvalidationRequest,
    GatewayInvalidationResponse,
    LiveSubscriptionId,
} from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, type RawJson, SubId, TenantId } from "../../src/types.ts";

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

let hostileHandlerRuns = 0;
const acceptHostileArgs = api.mutation({
    args: z.any(),
    handler: function acceptHostileArgsHandler(ctx) {
        hostileHandlerRuns += 1;
        ctx.db.insert(messages).values({ id: "hostile-args", value: 1 }).run();
        return null;
    },
});

const manifest = manifestFromExports({ putMessage, putBoth, inspectMessages, failAfterWrite, acceptHostileArgs });
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
        organizationId: TenantId("org-1"),
        ref: ChardbRef("queries.ts#outboxProbe"),
        args: {},
        queryHash: "outbox-query-hash",
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

function nestedArray(depth: number): RawJson {
    let value: RawJson = null;
    for (let level = 0; level < depth; level++) value = [value];
    return value;
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

function outboxDeliveryState(db: Database, registrationId: string): Record<string, unknown> | null {
    return db
        .prepare(
            `SELECT gateway_id, registration_id, change_seq, attempts, next_attempt_at, last_error, dead_lettered_at
             FROM _chardb_invalidation_outbox
             WHERE registration_id = ?`
        )
        .get(registrationId) as Record<string, unknown> | null;
}

describe("Cdb invalidation outbox", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    async function setup(): Promise<{
        readonly db: Database;
        readonly cdb: Cdb;
        readonly clock: { value: number };
        readonly alarms: number[];
        readonly gateway: {
            calls: GatewayInvalidationRequest[];
            behavior: (request: GatewayInvalidationRequest) => unknown | Promise<unknown>;
        };
        readonly alarm: { fail: boolean };
    }> {
        const db = new Database(":memory:");
        databases.push(db);
        const clock = { value: 10_000 };
        const alarms: number[] = [];
        const alarm = { fail: false };
        const gateway = {
            calls: [] as GatewayInvalidationRequest[],
            behavior: (() => {
                throw new Error("Gateway unavailable");
            }) as (request: GatewayInvalidationRequest) => unknown | Promise<unknown>,
        };
        const gatewayRpc = {
            async invalidateSubscriptions(request: GatewayInvalidationRequest): Promise<GatewayInvalidationResponse> {
                gateway.calls.push(request);
                return (await gateway.behavior(request)) as GatewayInvalidationResponse;
            },
        };
        const gatewayNamespace = {
            idFromString: (id: string) => ({ toString: () => id }),
            get: () => gatewayRpc,
        } as unknown as DurableObjectNamespace;
        let ready: Promise<unknown> = Promise.resolve();
        const state = {
            id: { toString: () => "outbox-shard-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                setAlarm: async (scheduledTime: number | Date): Promise<void> => {
                    if (alarm.fail) throw new Error("alarm unavailable");
                    alarms.push(scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime);
                },
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        class TestCdb extends ConfiguredCdb {
            protected override invalidationNowMs(): number {
                return clock.value;
            }
        }
        const cdb = new TestCdb(state, { CDB_GATEWAY: gatewayNamespace });
        await ready;
        return { db, cdb, clock, alarms, gateway, alarm };
    }

    test("rejects hostile mutation args before descriptor lookup, alarm, handler, or transaction", async () => {
        const { db, cdb, alarms } = await setup();
        hostileHandlerRuns = 0;
        const overMembers = await cdb.mutate(
            mutation(
                acceptHostileArgs,
                "hostile-members",
                Array.from({ length: CDB_JSON_MAX_AGGREGATE_MEMBERS + 1 }, () => null)
            )
        );
        expect(overMembers).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } });

        const overDepth = await cdb.mutate({
            principalId: "user-1",
            mutId: "hostile-depth",
            ref: "missing.ts#descriptor",
            args: nestedArray(CDB_MUTATION_ARGS_MAX_DEPTH + 1),
            auth: AUTH,
            schemaEpoch: 1,
        });
        expect(overDepth).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } });
        expect(alarms).toEqual([]);
        expect(hostileHandlerRuns).toBe(0);
        expect(db.prepare("SELECT * FROM outbox_messages").all()).toEqual([]);
        expect(db.prepare("SELECT * FROM _chardb_op_log").all()).toEqual([]);
    });

    test("rejects non-JSON direct mutation args without invoking accessors or side effects", async () => {
        const { db, cdb, alarms } = await setup();
        hostileHandlerRuns = 0;
        let getterRuns = 0;
        const accessor = Object.defineProperty({}, "value", {
            enumerable: true,
            get() {
                getterRuns += 1;
                return "must-not-run";
            },
        });
        const sparse = new Array<RawJson>(1);
        const extraArray = [null] as RawJson[] & { extra?: RawJson };
        extraArray.extra = null;
        const symbolObject = { value: null } as Record<PropertyKey, unknown>;
        symbolObject[Symbol("hostile")] = null;
        class HostileClass {
            readonly value = null;
        }
        const hostileArgs = [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            -0,
            new Date(0),
            new HostileClass(),
            sparse,
            extraArray,
            symbolObject,
            accessor,
        ];

        for (let index = 0; index < hostileArgs.length; index++) {
            const response = await cdb.mutate(
                mutation(acceptHostileArgs, `hostile-json-${index}`, hostileArgs[index] as unknown as RawJson)
            );
            expect(response).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } });
        }

        expect(getterRuns).toBe(0);
        expect(alarms).toEqual([]);
        expect(hostileHandlerRuns).toBe(0);
        expect(db.prepare("SELECT * FROM outbox_messages").all()).toEqual([]);
        expect(db.prepare("SELECT * FROM _chardb_op_log").all()).toEqual([]);
    });

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

        expect(await cdb.mutate(mutation(putMessage, "message-1", { id: "message-1", value: 1 }))).toMatchObject({
            ok: true,
            ran: true,
            touchedTables: ["outbox_messages"],
        });
        expect(changeSeq(db)).toBe(1);
        expect(outbox(db)).toEqual([{ gateway_id: "gateway-1", registration_id: "messages", change_seq: 1 }]);

        expect(await cdb.mutate(mutation(putMessage, "message-2", { id: "message-2", value: 2 }))).toMatchObject({
            ok: true,
            ran: true,
        });
        expect(changeSeq(db)).toBe(2);
        expect(outbox(db)).toEqual([{ gateway_id: "gateway-1", registration_id: "messages", change_seq: 2 }]);

        expect(await cdb.mutate(mutation(putMessage, "message-2", { id: "message-2", value: 2 }))).toMatchObject({
            ok: true,
            ran: false,
            touchedTables: [],
        });
        expect(await cdb.mutate(mutation(inspectMessages, "read-only", {}))).toMatchObject({
            ok: true,
            ran: true,
            touchedTables: [],
        });
        expect(await cdb.mutate(mutation(failAfterWrite, "handler-failure", { id: "failed", value: 9 }))).toMatchObject(
            {
                ok: false,
                error: { code: "CDB_INVARIANT" },
            }
        );
        expect(changeSeq(db)).toBe(2);
        expect(outbox(db)).toEqual([{ gateway_id: "gateway-1", registration_id: "messages", change_seq: 2 }]);
        expect(db.prepare("SELECT id FROM outbox_messages WHERE id = 'failed'").get()).toBeNull();

        await cdb.unsubscribe(messageRegistration);
        expect(outbox(db)).toEqual([]);
        expect(
            db.prepare("SELECT * FROM _chardb_live_subscription_tables WHERE registration_id = 'messages'").all()
        ).toEqual([]);
        expect(await cdb.mutate(mutation(putMessage, "message-3", { id: "message-3", value: 3 }))).toMatchObject({
            ok: true,
            ran: true,
        });
        expect(changeSeq(db)).toBe(3);
        await expect(
            cdb.subscribe(subscription(identity("after-three", 3), ["outbox_messages"]))
        ).resolves.toMatchObject({ changeSeq: 3 });

        expect(await cdb.mutate(mutation(putBoth, "both-1", { id: "both-1", value: 4 }))).toMatchObject({
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

    test("coalesces existing rows at capacity and rolls back clock, mutation, and op-log before outbox growth", async () => {
        const { db, cdb, gateway } = await setup();
        const first = identity("capacity-first", 1);
        const second = identity("capacity-second", 2);
        const excess = identity("capacity-excess", 3);
        await cdb.subscribe(subscription(first, ["outbox_messages"]));
        await cdb.subscribe(subscription(second, ["outbox_messages"]));
        await cdb.subscribe(subscription(excess, ["outbox_reactions"]));
        db.run("UPDATE _chardb_change_clock SET change_seq = 1 WHERE singleton = 1");
        db.prepare(
            `INSERT INTO _chardb_invalidation_outbox (gateway_id, registration_id, change_seq)
             VALUES (?, ?, 1), (?, ?, 1)`
        ).run(first.gatewayId, first.registrationId, second.gatewayId, second.registrationId);
        db.run(
            `WITH RECURSIVE filler(n) AS (
               SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < 4094
             )
             INSERT INTO _chardb_live_subscriptions
               (gateway_id, registration_id, connection_id, client_id, sub_id, state)
             SELECT 'gateway-filler', 'registration-filler-' || n, 'connection-filler-' || n,
                    'client-filler-' || n, n, 'retired'
             FROM filler`
        );
        db.run(
            `WITH RECURSIVE filler(n) AS (
               SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < 4094
             )
             INSERT INTO _chardb_invalidation_outbox
               (gateway_id, registration_id, change_seq, next_attempt_at)
             SELECT 'gateway-filler', 'registration-filler-' || n, 1, 999999999
             FROM filler`
        );

        await expect(
            cdb.mutate(mutation(putMessage, "capacity-coalesce", { id: "capacity-coalesce", value: 1 }))
        ).resolves.toMatchObject({ ok: true, ran: true });
        expect(gateway.calls).toHaveLength(1);
        expect(gateway.calls[0]?.invalidations).toHaveLength(2);
        expect(changeSeq(db)).toBe(2);
        expect(db.prepare("SELECT COUNT(*) AS count FROM _chardb_invalidation_outbox").get()).toEqual({ count: 4_096 });
        const outboxBefore = db.prepare("SELECT * FROM _chardb_invalidation_outbox ORDER BY registration_id").all();

        await expect(
            cdb.mutate(mutation(putBoth, "capacity-over", { id: "capacity-over", value: 2 }))
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_RATE_LIMITED", retryable: true } });
        expect(changeSeq(db)).toBe(2);
        expect(db.prepare("SELECT id FROM outbox_messages WHERE id = 'capacity-over'").get()).toBeNull();
        expect(db.prepare("SELECT id FROM outbox_reactions WHERE id = 'capacity-over'").get()).toBeNull();
        expect(db.prepare("SELECT mut_id FROM _chardb_op_log WHERE mut_id = 'capacity-over'").get()).toBeNull();
        expect(db.prepare("SELECT * FROM _chardb_invalidation_outbox ORDER BY registration_id").all()).toEqual(
            outboxBefore
        );
        expect(gateway.calls).toHaveLength(1);
    });

    test("bounds legacy invalidation fanout at exactly 4096 before accumulating another registration", async () => {
        const { db, cdb } = await setup();
        db.run(
            `WITH RECURSIVE registrations(n) AS (
               SELECT 1 UNION ALL SELECT n + 1 FROM registrations WHERE n < 4096
             )
             INSERT INTO _chardb_live_subscriptions
               (gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                principal_id, organization_id, ref, args_json, policy_digest, query_hash, tables_json, intervals_json)
             SELECT 'gateway-fanout', 'registration-fanout-' || n, 'connection-fanout-' || n,
                    'client-fanout-' || n, n, 'active', 'legacy-hash', 'principal-fanout', 'org-1',
                    'queries.ts#legacy', 'null', 'legacy-policy', 'legacy-query',
                    '["outbox_messages"]', '[]'
             FROM registrations`
        );
        db.run(
            `WITH RECURSIVE registrations(n) AS (
               SELECT 1 UNION ALL SELECT n + 1 FROM registrations WHERE n < 4096
             )
             INSERT INTO _chardb_live_subscription_tables (gateway_id, registration_id, table_name)
             SELECT 'gateway-fanout', 'registration-fanout-' || n, 'outbox_messages'
             FROM registrations`
        );

        await expect(
            cdb.mutate(mutation(putMessage, "fanout-boundary", { id: "fanout-boundary", value: 1 }))
        ).resolves.toMatchObject({ ok: true, ran: true });
        expect(changeSeq(db)).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS count FROM _chardb_invalidation_outbox").get()).toEqual({ count: 4_096 });

        db.prepare(
            `INSERT INTO _chardb_live_subscriptions
             (gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
              principal_id, organization_id, ref, args_json, policy_digest, query_hash, tables_json, intervals_json)
             VALUES ('gateway-fanout', 'registration-fanout-4097', 'connection-fanout-4097',
                     'client-fanout-4097', 4097, 'active', 'legacy-hash', 'principal-fanout', 'org-1',
                     'queries.ts#legacy', 'null', 'legacy-policy', 'legacy-query', '["outbox_messages"]', '[]')`
        ).run();
        db.prepare(
            `INSERT INTO _chardb_live_subscription_tables (gateway_id, registration_id, table_name)
             VALUES ('gateway-fanout', 'registration-fanout-4097', 'outbox_messages')`
        ).run();

        await expect(
            cdb.mutate(mutation(putMessage, "fanout-over", { id: "fanout-over", value: 2 }))
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_RATE_LIMITED", retryable: true } });
        expect(changeSeq(db)).toBe(1);
        expect(db.prepare("SELECT id FROM outbox_messages WHERE id = 'fanout-over'").get()).toBeNull();
        expect(db.prepare("SELECT mut_id FROM _chardb_op_log WHERE mut_id = 'fanout-over'").get()).toBeNull();
        expect(db.prepare("SELECT COUNT(*) AS count FROM _chardb_invalidation_outbox").get()).toEqual({ count: 4_096 });
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

        expect(
            await cdb.mutate(mutation(putMessage, "must-roll-back", { id: "must-roll-back", value: 1 }))
        ).toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        expect(changeSeq(db)).toBe(0);
        expect(outbox(db)).toEqual([]);
        expect(db.prepare("SELECT id FROM outbox_messages WHERE id = 'must-roll-back'").get()).toBeNull();
        expect(db.prepare("SELECT mut_id FROM _chardb_op_log WHERE mut_id = 'must-roll-back'").get()).toBeNull();
    });

    test("groups delivery by Gateway and clears accepted and stale acknowledgements", async () => {
        const { db, cdb, gateway, alarms } = await setup();
        const accepted = identity("accepted", 1);
        const stale = identity("stale", 2);
        await cdb.subscribe(subscription(accepted, ["outbox_messages"]));
        await cdb.subscribe(subscription(stale, ["outbox_reactions"]));
        gateway.behavior = request => ({
            gatewayId: request.gatewayId,
            acknowledgements: request.invalidations.map(invalidation => ({
                registrationId: invalidation.subscription.registrationId,
                changeSeq: invalidation.changeSeq,
                status: invalidation.subscription.registrationId === "accepted" ? "accepted" : "stale",
            })),
        });

        await expect(
            cdb.mutate(mutation(putBoth, "deliver-both", { id: "deliver-both", value: 1 }))
        ).resolves.toMatchObject({ ok: true, ran: true });
        expect(gateway.calls).toHaveLength(1);
        expect(gateway.calls[0]).toMatchObject({
            sourceCdbId: "outbox-shard-1",
            gatewayId: "gateway-1",
            invalidations: [
                { subscription: { registrationId: "accepted", connectionId: "connection-accepted" }, changeSeq: 1 },
                { subscription: { registrationId: "stale", connectionId: "connection-stale" }, changeSeq: 1 },
            ],
        });
        expect(outbox(db)).toEqual([]);
        expect(alarms).toEqual([10_001]);
    });

    test("keeps malformed responses queued and retries them from the alarm", async () => {
        const { db, cdb, clock, gateway, alarms } = await setup();
        await cdb.subscribe(subscription(identity("malformed", 1), ["outbox_messages"]));
        gateway.behavior = request => ({
            gatewayId: request.gatewayId,
            acknowledgements: [
                {
                    registrationId: "malformed",
                    changeSeq: request.invalidations[0]?.changeSeq,
                    status: "accepted",
                    extra: true,
                },
            ],
        });

        await expect(
            cdb.mutate(mutation(putMessage, "malformed-response", { id: "malformed-response", value: 1 }))
        ).resolves.toMatchObject({ ok: true, ran: true });
        expect(outboxDeliveryState(db, "malformed")).toMatchObject({
            change_seq: 1,
            attempts: 1,
            next_attempt_at: 11_000,
            dead_lettered_at: null,
        });
        expect(alarms).toEqual([10_001, 11_000]);

        gateway.behavior = request => ({
            gatewayId: request.gatewayId,
            acknowledgements: request.invalidations.map(invalidation => ({
                registrationId: invalidation.subscription.registrationId,
                changeSeq: invalidation.changeSeq,
                status: "accepted",
            })),
        });
        clock.value = 11_000;
        await cdb.alarm();
        expect(outbox(db)).toEqual([]);
        expect(gateway.calls).toHaveLength(2);
    });

    test("deletes only the exact acknowledged change sequence", async () => {
        const { db, cdb, clock, gateway, alarms } = await setup();
        await cdb.subscribe(subscription(identity("advanced", 1), ["outbox_messages"]));
        gateway.behavior = request => {
            db.prepare(
                `UPDATE _chardb_invalidation_outbox
                 SET change_seq = change_seq + 1
                 WHERE registration_id = 'advanced'`
            ).run();
            return {
                gatewayId: request.gatewayId,
                acknowledgements: request.invalidations.map(invalidation => ({
                    registrationId: invalidation.subscription.registrationId,
                    changeSeq: invalidation.changeSeq,
                    status: "accepted",
                })),
            };
        };

        await cdb.mutate(mutation(putMessage, "advanced-sequence", { id: "advanced-sequence", value: 1 }));
        expect(outboxDeliveryState(db, "advanced")).toMatchObject({ change_seq: 2, attempts: 0 });
        expect(alarms.at(-1)).toBe(10_001);

        gateway.behavior = request => ({
            gatewayId: request.gatewayId,
            acknowledgements: request.invalidations.map(invalidation => ({
                registrationId: invalidation.subscription.registrationId,
                changeSeq: invalidation.changeSeq,
                status: "stale",
            })),
        });
        clock.value = 10_001;
        await cdb.alarm();
        expect(outbox(db)).toEqual([]);
    });

    test("pre-arms before commit and preserves a committed result when post-commit scheduling fails", async () => {
        const { db, cdb, clock, gateway, alarm, alarms } = await setup();
        await cdb.subscribe(subscription(identity("retry-replay", 1), ["outbox_messages"]));
        alarm.fail = true;

        await expect(
            cdb.mutate(mutation(putMessage, "retry-replay", { id: "retry-replay", value: 1 }))
        ).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_SHARD_UNAVAILABLE", retryable: true },
        });
        expect(changeSeq(db)).toBe(0);
        expect(outbox(db)).toEqual([]);
        expect(db.prepare("SELECT id FROM outbox_messages WHERE id = 'retry-replay'").get()).toBeNull();

        alarm.fail = false;
        gateway.behavior = () => {
            alarm.fail = true;
            throw new Error("delivery unavailable");
        };
        await expect(
            cdb.mutate(mutation(putMessage, "retry-replay", { id: "retry-replay", value: 1 }))
        ).resolves.toMatchObject({ ok: true, ran: true, touchedTables: ["outbox_messages"] });
        expect(changeSeq(db)).toBe(1);
        expect(outboxDeliveryState(db, "retry-replay")).toMatchObject({ change_seq: 1, attempts: 1 });
        expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 1 });
        expect(alarms).toEqual([10_001]);

        alarm.fail = false;
        gateway.behavior = request => ({
            gatewayId: request.gatewayId,
            acknowledgements: request.invalidations.map(invalidation => ({
                registrationId: invalidation.subscription.registrationId,
                changeSeq: invalidation.changeSeq,
                status: "accepted",
            })),
        });
        await expect(
            cdb.mutate(mutation(putMessage, "retry-replay", { id: "retry-replay", value: 1 }))
        ).resolves.toMatchObject({ ok: true, ran: false, touchedTables: [] });
        expect(outboxDeliveryState(db, "retry-replay")).toMatchObject({ attempts: 1, next_attempt_at: 11_000 });
        clock.value = 11_000;
        await cdb.alarm();
        expect(outbox(db)).toEqual([]);
    });

    test("keeps retrying at the capped delay after marking a dead letter", async () => {
        const { db, cdb, clock, gateway, alarms } = await setup();
        await cdb.subscribe(subscription(identity("dead-letter", 1), ["outbox_messages"]));
        await cdb.mutate(mutation(putMessage, "dead-letter", { id: "dead-letter", value: 1 }));

        let firstDeadLetteredAt: unknown;
        for (let expectedAttempts = 2; expectedAttempts <= 9; expectedAttempts++) {
            const state = outboxDeliveryState(db, "dead-letter");
            clock.value = state?.next_attempt_at as number;
            await cdb.alarm();
            const retried = outboxDeliveryState(db, "dead-letter");
            expect(retried).toMatchObject({ attempts: expectedAttempts });
            if (expectedAttempts === 8) firstDeadLetteredAt = retried?.dead_lettered_at;
        }
        const deadLetter = outboxDeliveryState(db, "dead-letter");
        expect(deadLetter).toMatchObject({ attempts: 9, last_error: "Gateway unavailable" });
        expect(deadLetter?.dead_lettered_at).toEqual(expect.any(Number));
        expect(deadLetter?.dead_lettered_at).toBe(firstDeadLetteredAt);
        expect((deadLetter?.next_attempt_at as number) - clock.value).toBe(60_000);
        expect(gateway.calls).toHaveLength(9);
        expect(alarms.at(-1)).toBe(deadLetter?.next_attempt_at as number);
    });

    test("drains at most one bounded batch and alarms the remainder", async () => {
        const { db, cdb, clock, gateway, alarms } = await setup();
        for (let index = 0; index < 65; index++) {
            const registrationId = `batch-${index.toString().padStart(2, "0")}`;
            await cdb.subscribe(subscription(identity(registrationId, index + 1), ["outbox_messages"]));
        }
        gateway.behavior = request => ({
            gatewayId: request.gatewayId,
            acknowledgements: request.invalidations.map(invalidation => ({
                registrationId: invalidation.subscription.registrationId,
                changeSeq: invalidation.changeSeq,
                status: "accepted",
            })),
        });

        await cdb.mutate(mutation(putMessage, "bounded-batch", { id: "bounded-batch", value: 1 }));
        expect(gateway.calls.map(call => call.invalidations.length)).toEqual([64]);
        expect(db.prepare("SELECT COUNT(*) AS count FROM _chardb_invalidation_outbox").get()).toEqual({ count: 1 });
        expect(alarms.at(-1)).toBe(10_001);

        clock.value = 10_001;
        await cdb.alarm();
        expect(gateway.calls.map(call => call.invalidations.length)).toEqual([64, 1]);
        expect(outbox(db)).toEqual([]);
    });
});
