import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    GATEWAY_CLEANUP_MAX_ERROR_LENGTH,
    GATEWAY_CLEANUP_MAX_RETRY_COUNT,
    GATEWAY_CLEANUP_MAX_RETRY_MS,
    GATEWAY_REGISTRATION_DDL,
    Gateway,
    type GatewayEnv,
    type GatewayRegistrationInstall,
    type VerifiedGwAttachment,
    installGatewayRegistration,
    retireGatewayRegistration,
} from "../../src/server/do/gateway.ts";
import type { LiveSubscriptionId } from "../../src/server/rpc.ts";
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
        authEpochs: { global: 1, tenant: 2, principal: 3 },
        nowMs: 10,
        ...overrides,
    };
}

describe("Gateway retired-generation cleanup", () => {
    let db: Database;
    let sql: SyncSql;
    let gateway: Gateway;
    let ready: Promise<unknown>;
    let clock: number;
    let alarms: number[];
    let currentAlarm: number | null;
    let stringLookups: string[];
    let nameLookups: string[];
    let unsubscribeCalls: LiveSubscriptionId[];
    let finalizeCalls: LiveSubscriptionId[];
    let unsubscribeBehavior: (subscription: LiveSubscriptionId) => unknown | Promise<unknown>;
    let sockets: { deserializeAttachment: () => VerifiedGwAttachment }[];
    let state: DurableObjectState;
    let env: GatewayEnv;

    async function reconstruct(): Promise<void> {
        class TestGateway extends Gateway {
            protected override gatewayNowMs(): number {
                return clock;
            }
        }
        gateway = new TestGateway(state, env);
        await ready;
    }

    beforeEach(async () => {
        db = new Database(":memory:");
        sql = syncSql(db);
        ready = Promise.resolve();
        clock = 100;
        alarms = [];
        currentAlarm = null;
        stringLookups = [];
        nameLookups = [];
        unsubscribeCalls = [];
        finalizeCalls = [];
        unsubscribeBehavior = () => undefined;
        sockets = [];
        const cdb = {
            async unsubscribe(subscription: LiveSubscriptionId): Promise<unknown> {
                unsubscribeCalls.push(subscription);
                return await unsubscribeBehavior(subscription);
            },
            async finalizeUnsubscribe(subscription: LiveSubscriptionId): Promise<void> {
                finalizeCalls.push(subscription);
            },
        };
        const shardNamespace = {
            idFromString(id: string) {
                stringLookups.push(id);
                return { physicalId: id };
            },
            idFromName(name: string) {
                nameLookups.push(name);
                return { logicalName: name };
            },
            get() {
                return cdb;
            },
        } as unknown as DurableObjectNamespace;
        env = { CDB_SHARD: shardNamespace } as GatewayEnv;
        state = {
            id: { toString: () => "gateway-do-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async (): Promise<number | null> => currentAlarm,
                setAlarm: async (scheduledTime: number | Date): Promise<void> => {
                    currentAlarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
                    alarms.push(currentAlarm);
                },
            },
            getWebSockets: () => sockets as unknown as WebSocket[],
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        await reconstruct();
    });

    afterEach(() => db.close());

    function install(input: GatewayRegistrationInstall): void {
        db.transaction(() => installGatewayRegistration(sql, input))();
    }

    function activate(input: GatewayRegistrationInstall, changeSeq = 0): void {
        const result = db
            .query(
                `UPDATE _gw_registration_generations
                 SET lifecycle = 'active', cdb_state = 'active', dirty_version = MAX(dirty_version, ?),
                     initial_snapshot_pending = 1, retry_count = 0, retry_at = NULL,
                     retry_error = NULL, updated_at = ?
                 WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
                   AND connection_id = ? AND lifecycle = 'installing' AND cdb_state = 'pending'`
            )
            .run(
                changeSeq,
                input.nowMs,
                input.registrationId,
                input.principalId,
                input.clientId,
                input.subId,
                input.connectionId
            );
        expect(result.changes).toBe(1);
    }

    function retire(input: GatewayRegistrationInstall, nowMs = clock): void {
        expect(db.transaction(() => retireGatewayRegistration(sql, input, input.registrationId, nowMs))()).toBe(true);
    }

    function cleanupState(registrationId: string): Record<string, unknown> | null {
        return db
            .query(
                `SELECT lifecycle, cdb_state, retry_count, retry_at, retry_error
                 FROM _gw_registration_generations WHERE registration_id = ?`
            )
            .get(registrationId) as Record<string, unknown> | null;
    }

    async function fireCleanupAlarm(): Promise<void> {
        currentAlarm = null;
        await gateway.alarm();
    }

    async function waitForUnsubscribe(): Promise<void> {
        for (let attempt = 0; attempt < 50; attempt++) {
            if (unsubscribeCalls.length > 0) return;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error("Gateway did not start Cdb unsubscribe");
    }

    function resetWithLegacyNullableSourceSchema(): void {
        db.close();
        db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys = ON");
        db.exec(GATEWAY_REGISTRATION_DDL.replace("  source_cdb_id TEXT NOT NULL,\n", "  source_cdb_id TEXT,\n"));
        sql = syncSql(db);
        (state.storage as unknown as { sql: ReturnType<typeof sqlStorage> }).sql = sqlStorage(db);
        currentAlarm = null;
        alarms = [];
    }

    test("uses the exact physical Cdb ID and deletes only after unsubscribe succeeds", async () => {
        const current = registration("registration-success", {
            connectionId: "connection-success",
            sourceCdbId: "physical-object-success",
        });
        install(current);
        activate(current);
        retire(current);

        await fireCleanupAlarm();

        expect(stringLookups).toEqual(["physical-object-success"]);
        expect(nameLookups).toEqual([]);
        expect(unsubscribeCalls).toEqual([
            {
                gatewayId: "gateway-do-1",
                registrationId: "registration-success",
                connectionId: "connection-success",
                clientId: ClientId("client-1"),
                subId: SubId(1),
            },
        ]);
        expect(finalizeCalls).toEqual(unsubscribeCalls);
        expect(cleanupState(current.registrationId)).toBeNull();
        expect(alarms).toEqual([]);
    });

    test("retains failures and malformed outcomes with capped exponential retry state", async () => {
        const current = registration("registration-retry");
        install(current);
        activate(current);
        retire(current);
        unsubscribeBehavior = () => {
            throw new Error("Cdb unavailable");
        };

        await fireCleanupAlarm();
        expect(finalizeCalls).toEqual([]);
        expect(cleanupState(current.registrationId)).toEqual({
            lifecycle: "retiring",
            cdb_state: "retiring",
            retry_count: 1,
            retry_at: 1_100,
            retry_error: "Cdb unavailable",
        });
        expect(alarms).toEqual([1_100]);

        clock = 1_100;
        unsubscribeBehavior = () => ({ malformed: true });
        await fireCleanupAlarm();
        expect(cleanupState(current.registrationId)).toEqual({
            lifecycle: "retiring",
            cdb_state: "retiring",
            retry_count: 2,
            retry_at: 3_100,
            retry_error: "Cdb returned a malformed unsubscribe outcome",
        });
        expect(alarms).toEqual([1_100, 3_100]);

        db.query(
            "UPDATE _gw_registration_generations SET retry_count = 29, retry_at = ? WHERE registration_id = ?"
        ).run(clock, current.registrationId);
        unsubscribeBehavior = () => {
            throw new Error("x".repeat(1_000));
        };
        await fireCleanupAlarm();
        const capped = cleanupState(current.registrationId);
        expect(capped).toMatchObject({
            retry_count: GATEWAY_CLEANUP_MAX_RETRY_COUNT,
            retry_at: clock + GATEWAY_CLEANUP_MAX_RETRY_MS,
        });
        expect((capped?.retry_error as string).length).toBe(GATEWAY_CLEANUP_MAX_ERROR_LENGTH);
    });

    test("cleans a superseded generation without deleting its replacement", async () => {
        const old = registration("registration-old", { connectionId: "connection-old" });
        const replacement = registration("registration-new", { connectionId: "connection-new", nowMs: clock });
        install(old);
        activate(old);
        install(replacement);

        await fireCleanupAlarm();

        expect(unsubscribeCalls).toEqual([
            {
                gatewayId: "gateway-do-1",
                registrationId: old.registrationId,
                connectionId: old.connectionId,
                clientId: old.clientId,
                subId: old.subId,
            },
        ]);
        expect(cleanupState(old.registrationId)).toBeNull();
        expect(cleanupState(replacement.registrationId)).toMatchObject({
            lifecycle: "installing",
            cdb_state: "pending",
        });
        expect(db.query("SELECT registration_id FROM _gw_registration_heads").all()).toEqual([
            { registration_id: replacement.registrationId },
        ]);
    });

    test("deletes a retired migrated generation with no physical Cdb ID without retrying", async () => {
        resetWithLegacyNullableSourceSchema();
        const legacy = registration("registration-legacy-retired");
        install(legacy);
        activate(legacy);
        db.query("UPDATE _gw_registration_generations SET source_cdb_id = NULL WHERE registration_id = ?").run(
            legacy.registrationId
        );
        await reconstruct();
        retire(legacy);

        await fireCleanupAlarm();

        expect(cleanupState(legacy.registrationId)).toBeNull();
        expect(stringLookups).toEqual([]);
        expect(unsubscribeCalls).toEqual([]);
        expect(alarms).toEqual([]);
    });

    test("deletes a superseded migrated generation without touching its replacement head", async () => {
        resetWithLegacyNullableSourceSchema();
        const legacy = registration("registration-legacy-old", { connectionId: "connection-legacy-old" });
        install(legacy);
        activate(legacy);
        db.query("UPDATE _gw_registration_generations SET source_cdb_id = NULL WHERE registration_id = ?").run(
            legacy.registrationId
        );
        await reconstruct();
        const replacement = registration("registration-legacy-new", {
            connectionId: "connection-legacy-new",
            nowMs: clock,
        });
        install(replacement);

        await fireCleanupAlarm();

        expect(cleanupState(legacy.registrationId)).toBeNull();
        expect(cleanupState(replacement.registrationId)).toMatchObject({
            lifecycle: "installing",
            cdb_state: "pending",
        });
        expect(db.query("SELECT registration_id FROM _gw_registration_heads").all()).toEqual([
            { registration_id: replacement.registrationId },
        ]);
        expect(stringLookups).toEqual([]);
        expect(unsubscribeCalls).toEqual([]);
        expect(alarms).toEqual([]);
    });

    test("bounds each cleanup pass and schedules immediately when due rows remain", async () => {
        for (let index = 0; index < 33; index++) {
            const current = registration(`registration-batch-${index.toString().padStart(2, "0")}`, {
                subId: SubId(index),
                connectionId: `connection-batch-${index}`,
            });
            install(current);
            activate(current);
            retire(current);
        }

        await fireCleanupAlarm();

        expect(unsubscribeCalls).toHaveLength(32);
        expect(
            db.query("SELECT COUNT(*) AS count FROM _gw_registration_generations WHERE lifecycle = 'retiring'").get()
        ).toEqual({ count: 1 });
        expect(alarms).toEqual([clock + 1]);
    });

    test("restarts by scheduling active dirty work ahead of later retired cleanup", async () => {
        const retired = registration("registration-restart", { subId: SubId(1) });
        install(retired);
        activate(retired);
        retire(retired, 500);
        db.query("UPDATE _gw_registration_generations SET retry_at = NULL WHERE registration_id = ?").run(
            retired.registrationId
        );
        const active = registration("registration-active", { subId: SubId(2), connectionId: "connection-active" });
        install(active);
        db.query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'active', cdb_state = 'active', dirty_version = 9, retry_at = 50
             WHERE registration_id = ?`
        ).run(active.registrationId);

        await reconstruct();
        expect(alarms).toEqual([101]);
        expect(cleanupState(retired.registrationId)).toMatchObject({ lifecycle: "retiring", retry_at: 500 });
        expect(cleanupState(active.registrationId)).toMatchObject({ lifecycle: "active", retry_at: 50 });
    });

    test("retains and retries a generation changed while Cdb unsubscribe is paused", async () => {
        const current = registration("registration-raced-cleanup");
        install(current);
        activate(current);
        retire(current);
        let finishUnsubscribe: (outcome: unknown) => void = () => {};
        unsubscribeBehavior = () =>
            new Promise(resolve => {
                finishUnsubscribe = resolve;
            });

        const cleanup = fireCleanupAlarm();
        await waitForUnsubscribe();
        db.query("UPDATE _gw_registration_generations SET source_cdb_id = ? WHERE registration_id = ?").run(
            "physical-cdb-changed",
            current.registrationId
        );
        finishUnsubscribe(undefined);
        await cleanup;

        expect(cleanupState(current.registrationId)).toEqual({
            lifecycle: "retiring",
            cdb_state: "retiring",
            retry_count: 1,
            retry_at: 1_100,
            retry_error: "retired Gateway generation changed before cleanup could complete",
        });
        expect(
            db
                .query("SELECT source_cdb_id FROM _gw_registration_generations WHERE registration_id = ?")
                .get(current.registrationId)
        ).toEqual({ source_cdb_id: "physical-cdb-changed" });
        expect(alarms).toEqual([1_100]);
    });

    test("preserves an earlier dirty alarm while retired cleanup is in flight", async () => {
        const retired = registration("registration-cleanup-alarm", { subId: SubId(1) });
        install(retired);
        activate(retired);
        retire(retired);
        const active = registration("registration-dirty-alarm", {
            clientId: ClientId("client-dirty"),
            subId: SubId(2),
            connectionId: "connection-dirty",
        });
        install(active);
        activate(active);
        sockets.push({
            deserializeAttachment: () => ({
                kind: "verified",
                connectionId: active.connectionId,
                authOrigin: "https://app.example",
                clientId: active.clientId,
                principalId: active.principalId,
                jwtExp: 1_000,
                snapshotSubIds: [active.subId],
            }),
        });
        let failUnsubscribe: (error: Error) => void = () => {};
        unsubscribeBehavior = () =>
            new Promise((_resolve, reject) => {
                failUnsubscribe = reject;
            });

        const cleanup = fireCleanupAlarm();
        await waitForUnsubscribe();
        await gateway.invalidateSubscriptions({
            sourceCdbId: active.sourceCdbId,
            gatewayId: "gateway-do-1",
            invalidations: [
                {
                    subscription: {
                        gatewayId: "gateway-do-1",
                        registrationId: active.registrationId,
                        connectionId: active.connectionId,
                        clientId: active.clientId,
                        subId: active.subId,
                    },
                    changeSeq: 5,
                },
            ],
        });
        failUnsubscribe(new Error("cleanup unavailable"));
        await cleanup;

        expect(currentAlarm).toBe(101);
        expect(alarms).toEqual([101]);
        expect(cleanupState(retired.registrationId)).toMatchObject({
            retry_count: 1,
            retry_at: 1_100,
            retry_error: "cleanup unavailable",
        });
        expect(
            db
                .query("SELECT dirty_version FROM _gw_registration_generations WHERE registration_id = ?")
                .get(active.registrationId)
        ).toEqual({ dirty_version: 5 });
    });
});
