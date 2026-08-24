import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    Gateway,
    type GatewayDirtyRun,
    type GatewayEnv,
    type GatewayRegistrationInstall,
    type VerifiedGwAttachment,
    claimDirtyGatewayRegistration,
    installGatewayRegistration,
    stageGatewaySnapshot,
} from "../../src/server/do/gateway.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, ShardId, SubId, TenantId } from "../../src/types.ts";

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

function registration(overrides: Partial<GatewayRegistrationInstall> = {}): GatewayRegistrationInstall {
    return {
        registrationId: "registration-runner",
        principalId: PrincipalId("principal-1"),
        clientId: ClientId("client-1"),
        subId: SubId(1),
        connectionId: "connection-1",
        organizationId: TenantId("org-1"),
        ref: ChardbRef("queries.ts#messages"),
        args: { organizationId: "org-1" },
        intent: {
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
        },
        queryHash: "query-hash-1",
        shardId: "logical-shard-1",
        sourceCdbId: "physical-cdb-1",
        schemaEpoch: 1,
        authEpochs: { global: 1, tenant: 2, principal: 3 },
        nowMs: 10,
        ...overrides,
    };
}

class FakeSocket {
    readonly sent: string[] = [];
    throwOnSend = false;

    constructor(public attachment: VerifiedGwAttachment) {}

    deserializeAttachment(): VerifiedGwAttachment {
        return this.attachment;
    }

    serializeAttachment(attachment: VerifiedGwAttachment): void {
        this.attachment = attachment;
    }

    send(message: string): void {
        if (this.throwOnSend) throw new Error("socket send failed");
        this.sent.push(message);
    }
}

describe("Gateway active snapshot runner", () => {
    let db: Database;
    let sql: SyncSql;
    let gateway: Gateway;
    let ready: Promise<unknown>;
    let clock: number;
    let currentAlarm: number | null;
    let alarms: number[];
    let events: string[];
    let sockets: FakeSocket[];
    let queryCalls: unknown[];
    let queryBehavior: () => unknown | Promise<unknown>;
    let authorityBehavior: () => unknown | Promise<unknown>;
    let routePhysicalId: string;

    beforeEach(async () => {
        db = new Database(":memory:");
        sql = syncSql(db);
        ready = Promise.resolve();
        clock = 100;
        currentAlarm = null;
        alarms = [];
        events = [];
        sockets = [];
        queryCalls = [];
        queryBehavior = () => ({ ok: true, result: [{ id: 1, body: "hello" }] });
        authorityBehavior = () => ({
            principalId: PrincipalId("principal-1"),
            organizationId: TenantId("org-1"),
            role: "member",
            roles: ["member"],
            authEpochs: { global: 10, tenant: 11, principal: 12 },
        });
        routePhysicalId = "physical-cdb-1";

        const catalog = {
            async resolveOrganizationAuthority() {
                events.push("authority");
                return await authorityBehavior();
            },
            async route() {
                events.push("route");
                return { shardId: ShardId("logical-shard-1"), schemaEpoch: 1 };
            },
            async listShardIds() {
                return [ShardId("logical-shard-1")];
            },
        };
        const cdb = {
            async queryRegistered(request: unknown) {
                queryCalls.push(request);
                events.push("query");
                return await queryBehavior();
            },
            async unsubscribe() {},
        };
        const catalogNamespace = {
            idFromName: () => ({ toString: () => "catalog-global" }),
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const shardNamespace = {
            idFromName: () => ({ toString: () => routePhysicalId }),
            idFromString: (id: string) => ({ toString: () => id }),
            get: () => cdb,
        } as unknown as DurableObjectNamespace;
        const state = {
            id: { toString: () => "gateway-do-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async (): Promise<number | null> => currentAlarm,
                setAlarm: async (scheduledTime: number | Date): Promise<void> => {
                    currentAlarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
                    alarms.push(currentAlarm);
                    events.push(`alarm:${currentAlarm}`);
                },
            },
            getWebSockets: (): WebSocket[] => sockets as unknown as WebSocket[],
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        class TestGateway extends Gateway {
            protected override gatewayNowMs(): number {
                return clock;
            }
        }
        gateway = new TestGateway(state, { CDB_CATALOG: catalogNamespace, CDB_SHARD: shardNamespace } as GatewayEnv);
        await ready;
    });

    afterEach(() => db.close());

    function installActive(input = registration(), dirtyVersion = 5, deliveredVersion = 2): void {
        db.transaction(() => installGatewayRegistration(sql, input))();
        db.query(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'active', cdb_state = 'active', dirty_version = ?, delivered_version = ?,
                 retry_count = 0, retry_at = NULL, retry_error = NULL
             WHERE registration_id = ?`
        ).run(dirtyVersion, deliveredVersion, input.registrationId);
    }

    function attach(input = registration(), overrides: Partial<VerifiedGwAttachment> = {}): FakeSocket {
        const socket = new FakeSocket({
            kind: "verified",
            connectionId: input.connectionId,
            authOrigin: "https://app.example",
            clientId: input.clientId,
            principalId: input.principalId,
            jwtExp: 1_000,
            lastCookie: Cookie("cookie-base"),
            snapshotSubIds: [input.subId],
            ...overrides,
        });
        sockets.push(socket);
        return socket;
    }

    async function fireAlarm(): Promise<void> {
        currentAlarm = null;
        await gateway.alarm();
    }

    function generationState(registrationId = "registration-runner"): Record<string, unknown> | null {
        return db
            .query(
                `SELECT lifecycle, dirty_version, delivered_version, run_token, run_target_version,
                        run_lease_expires_at, run_version, retry_count, retry_at, retry_error,
                        last_cookie, last_snapshot_cookie
                 FROM _gw_registration_generations WHERE registration_id = ?`
            )
            .get(registrationId) as Record<string, unknown> | null;
    }

    test("pre-arms recovery, preserves newer dirtiness, sends, and acks without regressing a later socket cookie", async () => {
        const input = registration();
        installActive(input);
        const socket = attach(input);
        queryBehavior = () => {
            db.query("UPDATE _gw_registration_generations SET dirty_version = 9 WHERE registration_id = ?").run(
                input.registrationId
            );
            return { ok: true, result: [{ id: 1, body: "new" }] };
        };

        await fireAlarm();

        expect(events.indexOf("alarm:30100")).toBeLessThan(events.indexOf("authority"));
        expect(queryCalls).toHaveLength(1);
        expect(socket.sent).toHaveLength(1);
        const snapshot = JSON.parse(socket.sent[0] as string) as { cookie: Cookie; rows: unknown[]; subId: number };
        expect(snapshot).toMatchObject({ subId: 1, rows: [{ id: 1, body: "new" }] });
        expect(generationState()).toMatchObject({ dirty_version: 9, delivered_version: 2 });

        socket.attachment = { ...socket.attachment, lastCookie: Cookie("cookie-mutation") };
        clock = 10_100;
        await fireAlarm();
        expect(socket.sent).toHaveLength(2);
        expect(socket.sent[1]).toBe(socket.sent[0]);

        const forgedSocket = new FakeSocket({
            ...socket.attachment,
            connectionId: "connection-forged",
        });
        gateway.webSocketMessage(
            forgedSocket as unknown as WebSocket,
            JSON.stringify({ t: "ack", cookie: snapshot.cookie })
        );
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_snapshot_outbox").get()).toEqual({ count: 1 });

        gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "ack", cookie: snapshot.cookie }));
        expect(generationState()).toMatchObject({
            dirty_version: 9,
            delivered_version: 5,
            last_cookie: snapshot.cookie,
            last_snapshot_cookie: snapshot.cookie,
        });
        expect(socket.attachment.lastCookie).toBe(Cookie("cookie-mutation"));
        expect(db.query("SELECT * FROM _gw_snapshot_outbox").get()).toBeNull();

        gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "ack", cookie: snapshot.cookie }));
        expect(socket.attachment.lastCookie).toBe(Cookie("cookie-mutation"));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(currentAlarm).toBe(10_101);
    });

    test("fences query failure and schedules retry without losing dirty state", async () => {
        installActive();
        attach();
        queryBehavior = () => {
            throw new Error("query unavailable");
        };

        await fireAlarm();

        expect(generationState()).toMatchObject({
            dirty_version: 5,
            delivered_version: 2,
            run_token: null,
            run_target_version: null,
            run_lease_expires_at: null,
            run_version: 2,
            retry_count: 1,
            retry_at: 1_100,
            retry_error: "query unavailable",
        });
        expect(currentAlarm).toBe(1_100);
    });

    test("retires a nonretryable registered-query failure", async () => {
        installActive();
        const socket = attach();
        queryBehavior = () => ({
            ok: false,
            error: new CdbError({
                code: "CDB_INVARIANT",
                message: "registered query subscription does not exist",
            }).toJSON(),
        });

        await fireAlarm();

        expect(db.query("SELECT * FROM _gw_registration_heads").get()).toBeNull();
        expect(generationState()).toMatchObject({ lifecycle: "retiring", run_token: null });
        expect(currentAlarm).toBe(101);
        expect(socket.attachment.snapshotSubIds).toEqual([]);
        expect(JSON.parse(socket.sent[0] as string)).toMatchObject({
            t: "error",
            code: "CDB_INVARIANT",
            subId: 1,
        });
    });

    test("settles revoked authority instead of leaving stale live rows", async () => {
        installActive();
        const socket = attach();
        authorityBehavior = () => null;

        await fireAlarm();

        expect(db.query("SELECT * FROM _gw_registration_heads").get()).toBeNull();
        expect(generationState()).toMatchObject({ lifecycle: "retiring", run_token: null });
        expect(queryCalls).toEqual([]);
        expect(socket.attachment.snapshotSubIds).toEqual([]);
        expect(JSON.parse(socket.sent[0] as string)).toMatchObject({
            t: "error",
            code: "CDB_FORBIDDEN",
            subId: 1,
        });
    });

    test("requests a refetch after the physical shard route changes", async () => {
        installActive();
        const socket = attach();
        routePhysicalId = "physical-cdb-2";

        await fireAlarm();

        expect(db.query("SELECT * FROM _gw_registration_heads").get()).toBeNull();
        expect(generationState()).toMatchObject({ lifecycle: "retiring", run_token: null });
        expect(queryCalls).toEqual([]);
        expect(socket.attachment.snapshotSubIds).toEqual([]);
        expect(JSON.parse(socket.sent[0] as string)).toEqual({
            t: "mustRefetch",
            subIds: [1],
            reason: "shardsChanged",
        });
    });

    test("a stolen run fences the old query's terminal socket retirement", async () => {
        installActive();
        const socket = attach();
        db.query(
            `UPDATE _gw_registration_generations
             SET run_token = 'expired', run_target_version = 5, run_lease_expires_at = 99, run_version = 1
             WHERE registration_id = 'registration-runner'`
        ).run();
        let release: (value: unknown) => void = () => {};
        queryBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });

        const alarm = fireAlarm();
        while (queryCalls.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
        db.query(
            `UPDATE _gw_registration_generations
             SET run_token = 'stolen', run_target_version = 5, run_lease_expires_at = 50_000,
                 run_version = run_version + 1
             WHERE registration_id = 'registration-runner'`
        ).run();
        socket.attachment = { ...socket.attachment, jwtExp: 0 };
        release({ ok: true, result: [{ id: 2 }] });
        await alarm;

        expect(queryCalls).toHaveLength(1);
        expect(socketMessages()).toEqual([]);
        expect(generationState()).toMatchObject({
            run_token: "stolen",
            run_target_version: 5,
            run_lease_expires_at: 50_000,
            run_version: 3,
        });
        expect(db.query("SELECT * FROM _gw_snapshot_outbox").get()).toBeNull();
    });

    test("pre-arms a send-only recovery lease before claiming and sending a staged snapshot", async () => {
        const input = registration();
        installActive(input);
        const socket = attach(input);
        const run = db.transaction(() =>
            claimDirtyGatewayRegistration(sql, {
                principalId: input.principalId,
                clientId: input.clientId,
                subId: input.subId,
                registrationId: input.registrationId,
                connectionId: input.connectionId,
                nowMs: clock,
                leaseExpiresAt: clock + 30_000,
            })
        )() as GatewayDirtyRun;
        expect(
            db.transaction(() =>
                stageGatewaySnapshot(sql, {
                    principalId: input.principalId,
                    clientId: input.clientId,
                    subId: input.subId,
                    registrationId: input.registrationId,
                    connectionId: input.connectionId,
                    runToken: run.runToken,
                    runVersion: run.runVersion,
                    targetVersion: run.targetVersion,
                    cookie: Cookie("cookie-send-only"),
                    rows: [{ id: 4 }],
                    authEpochs: { global: 10, tenant: 11, principal: 12 },
                    nowMs: clock,
                })
            )()
        ).toBe(true);
        alarms = [];
        events = [];
        currentAlarm = null;

        await fireAlarm();

        expect(events[0]).toBe("alarm:10100");
        expect(socket.sent).toHaveLength(1);
        expect(
            db
                .query("SELECT send_attempts, claim_version FROM _gw_snapshot_outbox WHERE registration_id = ?")
                .get(input.registrationId)
        ).toEqual({ send_attempts: 1, claim_version: 1 });
    });

    test("retains a staged snapshot and records bounded retry when socket send throws", async () => {
        installActive();
        const socket = attach();
        socket.throwOnSend = true;

        await fireAlarm();

        expect(db.query("SELECT COUNT(*) AS count FROM _gw_snapshot_outbox").get()).toEqual({ count: 1 });
        expect(
            db
                .query(
                    `SELECT send_attempts, next_attempt_at, claim_token, claim_expires_at, last_error
                     FROM _gw_snapshot_outbox`
                )
                .get()
        ).toEqual({
            send_attempts: 1,
            next_attempt_at: 1_100,
            claim_token: null,
            claim_expires_at: null,
            last_error: "socket send failed",
        });
        expect(currentAlarm).toBe(101);
    });

    test("retires missing or stale socket identity and arms exact cleanup", async () => {
        installActive();

        await fireAlarm();

        expect(queryCalls).toEqual([]);
        expect(db.query("SELECT * FROM _gw_registration_heads").get()).toBeNull();
        expect(generationState()).toMatchObject({ lifecycle: "retiring" });
        expect(currentAlarm).toBe(101);
    });

    test("rechecks JWT time after a held query and retires before staging or send", async () => {
        installActive();
        attach(registration(), { jwtExp: 1 });
        let release: (value: unknown) => void = () => {};
        queryBehavior = () =>
            new Promise(resolve => {
                release = resolve;
            });

        const alarm = fireAlarm();
        while (queryCalls.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
        clock = 1_000;
        release({ ok: true, result: [{ id: 3 }] });
        await alarm;

        expect(db.query("SELECT * FROM _gw_registration_heads").get()).toBeNull();
        expect(db.query("SELECT * FROM _gw_snapshot_outbox").get()).toBeNull();
        expect(socketMessages()).toEqual([]);
    });

    function socketMessages(): string[] {
        return sockets.flatMap(socket => socket.sent);
    }
});
