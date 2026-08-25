import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    Gateway,
    type GatewayEnv,
    type GatewayRegistrationInstall,
    installGatewayRegistration,
} from "../../src/server/do/gateway.ts";
import type { GatewayInvalidationRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";

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

function syncSql(db: Database): SyncSql {
    return {
        exec(query, ...params) {
            db.run(query, params as never[]);
        },
        one<T>(query: string, ...params: never[]): T | null {
            return (db.query(query).get(...params) as T | null) ?? null;
        },
        all<T>(query: string, ...params: never[]): T[] {
            return db.query(query).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS changes").get() as { changes: number }).changes);
        },
    };
}

function registration(
    registrationId: string,
    overrides: Partial<GatewayRegistrationInstall> = {}
): GatewayRegistrationInstall {
    return {
        registrationId,
        principalId: PrincipalId("principal-1"),
        clientId: ClientId("client-1"),
        subId: SubId(1),
        connectionId: `connection-${registrationId}`,
        organizationId: TenantId("org-1"),
        ref: ChardbRef("queries.ts#messages"),
        args: { organizationId: "org-1" },
        intent: {
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
        },
        policyDigest: "policy-digest-1",
        queryHash: "query-hash-1",
        shardId: "logical-shard-1",
        sourceCdbId: "physical-cdb-1",
        schemaEpoch: 1,
        domainSchemaEpoch: 1,
        authEpochs: { global: 1, tenant: 2, principal: 3 },
        nowMs: 100,
        ...overrides,
    };
}

function identity(input: GatewayRegistrationInstall, overrides: Partial<LiveSubscriptionId> = {}): LiveSubscriptionId {
    return {
        gatewayId: "gateway-do-1",
        registrationId: input.registrationId,
        connectionId: input.connectionId,
        clientId: input.clientId,
        subId: input.subId,
        ...overrides,
    };
}

function invalidationRequest(
    invalidations: GatewayInvalidationRequest["invalidations"],
    overrides: Partial<Omit<GatewayInvalidationRequest, "invalidations">> = {}
): GatewayInvalidationRequest {
    return {
        sourceCdbId: "physical-cdb-1",
        gatewayId: "gateway-do-1",
        invalidations,
        ...overrides,
    };
}

describe("Gateway invalidation receiver", () => {
    let db: Database;
    let gateway: Gateway;
    let ready: Promise<unknown>;
    let sql: SyncSql;
    let alarms: number[];
    let currentAlarm: number | null;
    let alarmFails: boolean;

    beforeEach(async () => {
        db = new Database(":memory:");
        ready = Promise.resolve();
        alarms = [];
        currentAlarm = null;
        alarmFails = false;
        const state = {
            id: { toString: () => "gateway-do-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async (): Promise<number | null> => currentAlarm,
                setAlarm: async (scheduledTime: number | Date): Promise<void> => {
                    if (alarmFails) throw new Error("alarm unavailable");
                    currentAlarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
                    alarms.push(currentAlarm);
                },
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        gateway = new Gateway(state, {} as GatewayEnv);
        await ready;
        sql = syncSql(db);
    });

    afterEach(() => db.close());

    function install(input: GatewayRegistrationInstall): void {
        db.transaction(() => installGatewayRegistration(sql, input))();
    }

    function dirtyVersion(registrationId: string): number {
        return (
            db
                .query("SELECT dirty_version FROM _gw_registration_generations WHERE registration_id = ?")
                .get(registrationId) as { dirty_version: number }
        ).dirty_version;
    }

    test("accepts an exact current generation and acknowledges unknown generations as stale", async () => {
        const current = registration("registration-current");
        install(current);
        const unknown: LiveSubscriptionId = {
            ...identity(current),
            registrationId: "registration-unknown",
            connectionId: "connection-unknown",
            subId: SubId(2),
        };

        await expect(
            gateway.invalidateSubscriptions(
                invalidationRequest([
                    { subscription: identity(current), changeSeq: 8 },
                    { subscription: unknown, changeSeq: 9 },
                ])
            )
        ).resolves.toEqual({
            gatewayId: "gateway-do-1",
            acknowledgements: [
                { registrationId: "registration-current", changeSeq: 8, status: "accepted" },
                { registrationId: "registration-unknown", changeSeq: 9, status: "stale" },
            ],
        });
        expect(dirtyVersion(current.registrationId)).toBe(8);
        expect(alarms).toHaveLength(1);
    });

    test("rejects current registrations whose socket, client, or sub identity conflicts", async () => {
        const current = registration("registration-exact");
        install(current);
        const mismatches: LiveSubscriptionId[] = [
            identity(current, { connectionId: "connection-wrong" }),
            identity(current, { clientId: ClientId("client-wrong") }),
            identity(current, { subId: SubId(2) }),
        ];

        for (const subscription of mismatches) {
            await expect(
                gateway.invalidateSubscriptions(invalidationRequest([{ subscription, changeSeq: 4 }]))
            ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        }
        expect(dirtyVersion(current.registrationId)).toBe(0);
        expect(alarms).toEqual([]);
    });

    test("rejects a current physical Cdb source mismatch without acknowledging it as stale", async () => {
        const current = registration("registration-source");
        install(current);

        await expect(
            gateway.invalidateSubscriptions(
                invalidationRequest([{ subscription: identity(current), changeSeq: 5 }], {
                    sourceCdbId: "logical-shard-1",
                })
            )
        ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        expect(dirtyVersion(current.registrationId)).toBe(0);
        expect(alarms).toEqual([]);
    });

    test("rolls back earlier accepted items when a later current identity conflicts", async () => {
        const first = registration("registration-batch-first");
        const second = registration("registration-batch-second", {
            clientId: ClientId("client-2"),
            subId: SubId(2),
        });
        install(first);
        install(second);

        await expect(
            gateway.invalidateSubscriptions(
                invalidationRequest([
                    { subscription: identity(first), changeSeq: 7 },
                    {
                        subscription: identity(second, { connectionId: "connection-conflict" }),
                        changeSeq: 8,
                    },
                ])
            )
        ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        expect(dirtyVersion(first.registrationId)).toBe(0);
        expect(dirtyVersion(second.registrationId)).toBe(0);
        expect(alarms).toEqual([]);
    });

    test("cannot dirty a superseded generation but accepts its replacement", async () => {
        const old = registration("registration-old");
        const replacement = registration("registration-new", { nowMs: 200 });
        install(old);
        install(replacement);

        await expect(
            gateway.invalidateSubscriptions(
                invalidationRequest([
                    { subscription: identity(old), changeSeq: 6 },
                    { subscription: identity(replacement), changeSeq: 7 },
                ])
            )
        ).resolves.toEqual({
            gatewayId: "gateway-do-1",
            acknowledgements: [
                { registrationId: old.registrationId, changeSeq: 6, status: "stale" },
                { registrationId: replacement.registrationId, changeSeq: 7, status: "accepted" },
            ],
        });
        expect(dirtyVersion(old.registrationId)).toBe(0);
        expect(dirtyVersion(replacement.registrationId)).toBe(7);
    });

    test("rejects duplicates and malformed batches before any write", async () => {
        const current = registration("registration-validation");
        install(current);
        const exact = identity(current);

        await expect(
            gateway.invalidateSubscriptions(
                invalidationRequest([
                    { subscription: exact, changeSeq: 2 },
                    { subscription: exact, changeSeq: 3 },
                ])
            )
        ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        await expect(
            gateway.invalidateSubscriptions({
                ...invalidationRequest([]),
                invalidations: [
                    { subscription: exact, changeSeq: 4 },
                    {
                        subscription: {
                            ...identity(current, { registrationId: "registration-other" }),
                            unexpected: true,
                        },
                        changeSeq: 5,
                    },
                ],
            } as never)
        ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        await expect(
            gateway.invalidateSubscriptions(
                invalidationRequest(
                    Array.from({ length: 65 }, (_, index) => ({
                        subscription: identity(current, {
                            registrationId: `registration-overflow-${index}`,
                            connectionId: `connection-overflow-${index}`,
                            subId: SubId(index),
                        }),
                        changeSeq: index + 1,
                    }))
                )
            )
        ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        await expect(
            gateway.invalidateSubscriptions(
                invalidationRequest([{ subscription: exact, changeSeq: 4 }], { gatewayId: "gateway-do-other" })
            )
        ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        expect(dirtyVersion(current.registrationId)).toBe(0);
        expect(alarms).toEqual([]);
    });

    test("coalesces monotonically while accepting and re-arming retries", async () => {
        const current = registration("registration-monotonic");
        install(current);
        const requestAt = (changeSeq: number) => invalidationRequest([{ subscription: identity(current), changeSeq }]);

        await expect(gateway.invalidateSubscriptions(requestAt(9))).resolves.toMatchObject({
            acknowledgements: [{ changeSeq: 9, status: "accepted" }],
        });
        await expect(gateway.invalidateSubscriptions(requestAt(4))).resolves.toMatchObject({
            acknowledgements: [{ changeSeq: 4, status: "accepted" }],
        });
        await expect(gateway.invalidateSubscriptions(requestAt(9))).resolves.toMatchObject({
            acknowledgements: [{ changeSeq: 9, status: "accepted" }],
        });
        expect(dirtyVersion(current.registrationId)).toBe(9);
        expect(alarms).toHaveLength(1);
    });

    test("retains dirty state when alarm scheduling fails and safely retries", async () => {
        const current = registration("registration-alarm");
        install(current);
        const request = invalidationRequest([{ subscription: identity(current), changeSeq: 11 }]);
        alarmFails = true;

        await expect(gateway.invalidateSubscriptions(request)).rejects.toMatchObject({ code: "CDB_SHARD_UNAVAILABLE" });
        expect(dirtyVersion(current.registrationId)).toBe(11);
        expect(alarms).toEqual([]);

        alarmFails = false;
        await expect(gateway.invalidateSubscriptions(request)).resolves.toMatchObject({
            acknowledgements: [{ registrationId: current.registrationId, changeSeq: 11, status: "accepted" }],
        });
        expect(dirtyVersion(current.registrationId)).toBe(11);
        expect(alarms).toHaveLength(1);
    });
});
