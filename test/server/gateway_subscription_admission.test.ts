import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import {
    Gateway,
    type GatewayEnv,
    type GatewayRegistrationInstall,
    MAX_INITIAL_SNAPSHOTS_PER_CONNECTION,
    type VerifiedGwAttachment,
    installGatewayRegistration,
} from "../../src/server/do/gateway.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, SubId, TenantId } from "../../src/types.ts";

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

class FakeSocket {
    readonly sent: string[] = [];

    constructor(public attachment: VerifiedGwAttachment) {}

    deserializeAttachment(): VerifiedGwAttachment {
        return this.attachment;
    }

    serializeAttachment(attachment: VerifiedGwAttachment): void {
        this.attachment = attachment;
    }

    send(message: string): void {
        this.sent.push(message);
    }
}

interface GatewayInternals {
    settleSubscription: () => Promise<void>;
    pendingSubscriptions: Map<string, { cancelled: boolean }>;
}

function attachment(client: number, subIds: readonly SubId[] = []): VerifiedGwAttachment {
    return {
        kind: "verified",
        connectionId: `connection-${client}`,
        authOrigin: "https://app.example",
        clientId: ClientId(`client-${client}`),
        principalId: PrincipalId("principal-1"),
        jwtExp: Math.floor(Date.now() / 1_000) + 10_000,
        lastCookie: Cookie(`cookie-${client}`),
        snapshotSubIds: subIds,
    };
}

function subscribe(gateway: Gateway, socket: FakeSocket, subId: number): Promise<void> {
    return gateway.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ t: "sub", subId, ref: "queries.ts#messages", args: { organizationId: "org-1" } })
    );
}

function unsubscribe(gateway: Gateway, socket: FakeSocket, subId: number): Promise<void> {
    return gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "unsub", subId }));
}

function registration(index: number): GatewayRegistrationInstall {
    return {
        registrationId: `registration-${index}`,
        principalId: PrincipalId("principal-1"),
        clientId: ClientId(`client-${index}`),
        subId: SubId(0),
        connectionId: `connection-${index}`,
        organizationId: TenantId("org-1"),
        ref: ChardbRef("queries.ts#messages"),
        args: { organizationId: "org-1" },
        intent: {
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
        },
        policyDigest: "policy-digest-1",
        queryHash: `query-hash-${index}`,
        shardId: "shard-1",
        sourceCdbId: "cdb-object-1",
        schemaEpoch: 1,
        authEpochs: { global: 1, tenant: 1, principal: 1 },
        lastCookie: Cookie(`cookie-${index}`),
        nowMs: 100,
    };
}

describe("Gateway aggregate live-query admission", () => {
    let db: Database;
    let gateway: Gateway;
    let state: DurableObjectState;
    let ready: Promise<unknown>;
    let currentAlarm: number | null;

    beforeEach(async () => {
        db = new Database(":memory:");
        ready = Promise.resolve();
        currentAlarm = null;
        state = {
            id: { toString: () => "gateway-subscription-admission" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
                getAlarm: async () => currentAlarm,
                setAlarm: async (value: number | Date) => {
                    currentAlarm = value instanceof Date ? value.getTime() : value;
                },
                transaction: async <T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) => {
                    const originalAlarm = currentAlarm;
                    let stagedAlarm = currentAlarm;
                    db.exec("BEGIN IMMEDIATE");
                    try {
                        const result = await callback({
                            getAlarm: async () => stagedAlarm,
                            setAlarm: async (value: number | Date) => {
                                stagedAlarm = value instanceof Date ? value.getTime() : value;
                            },
                        } as DurableObjectTransaction);
                        db.exec("COMMIT");
                        currentAlarm = stagedAlarm;
                        return result;
                    } catch (error) {
                        db.exec("ROLLBACK");
                        currentAlarm = originalAlarm;
                        throw error;
                    }
                },
            },
            getWebSockets: () => [] as WebSocket[],
            blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        gateway = createGateway();
        await ready;
    });

    afterEach(() => db.close());

    function createGateway(): Gateway {
        return new Gateway(state, {
            CDB_CATALOG: {} as DurableObjectNamespace,
            CDB_SHARD: {} as DurableObjectNamespace,
        } satisfies GatewayEnv);
    }

    function holdSettlements(): { readonly releases: Array<() => void>; readonly calls: () => number } {
        const releases: Array<() => void> = [];
        let calls = 0;
        (gateway as unknown as GatewayInternals).settleSubscription = () => {
            calls += 1;
            return new Promise(resolve => releases.push(resolve));
        };
        return { releases, calls: () => calls };
    }

    function seedCurrentHeads(count: number): void {
        const sql = syncSql(db);
        db.transaction(() => {
            for (let index = 0; index < count; index++) installGatewayRegistration(sql, registration(index));
        })();
    }

    test("admits 256 pending identities across sockets, rejects the 257th, and reuses cancelled capacity", async () => {
        const held = holdSettlements();
        const sockets = Array.from({ length: 8 }, (_, index) => new FakeSocket(attachment(index)));
        const pending: Promise<void>[] = [];
        for (let socketIndex = 0; socketIndex < sockets.length; socketIndex++) {
            const socket = sockets[socketIndex];
            if (!socket) throw new Error("missing test socket");
            for (let subId = 0; subId < 32; subId++) pending.push(subscribe(gateway, socket, subId));
        }
        expect(held.calls()).toBe(256);
        expect((gateway as unknown as GatewayInternals).pendingSubscriptions.size).toBe(256);

        const duplicate = new FakeSocket({ ...attachment(0), connectionId: "connection-duplicate" });
        await subscribe(gateway, duplicate, 0);
        expect(held.calls()).toBe(256);
        expect(JSON.parse(duplicate.sent.at(-1) as string)).toMatchObject({
            t: "error",
            subId: 0,
            code: "CDB_RATE_LIMITED",
        });

        const overflow = new FakeSocket(attachment(9));
        await subscribe(gateway, overflow, 0);
        expect(held.calls()).toBe(256);
        expect(JSON.parse(overflow.sent.at(-1) as string)).toMatchObject({
            t: "error",
            subId: 0,
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_registration_heads").get()).toEqual({ count: 0 });

        const first = sockets[0];
        if (!first) throw new Error("missing first socket");
        await unsubscribe(gateway, first, 0);
        const replacement = subscribe(gateway, overflow, 0);
        expect(held.calls()).toBe(257);

        for (const release of held.releases) release();
        await Promise.all([...pending, replacement]);
        expect((gateway as unknown as GatewayInternals).pendingSubscriptions.size).toBe(0);
    });

    test("rebuilds capacity from durable heads after restart and admits a same-key replacement", async () => {
        seedCurrentHeads(256);
        gateway = createGateway();
        await ready;
        let calls = 0;
        (gateway as unknown as GatewayInternals).settleSubscription = async () => {
            calls += 1;
        };

        const overflow = new FakeSocket(attachment(256));
        await subscribe(gateway, overflow, 0);
        expect(calls).toBe(0);
        expect(JSON.parse(overflow.sent.at(-1) as string)).toMatchObject({
            t: "error",
            subId: 0,
            code: "CDB_RATE_LIMITED",
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_registration_heads").get()).toEqual({ count: 256 });

        const replacement = new FakeSocket(attachment(0, [SubId(0)]));
        await subscribe(gateway, replacement, 0);
        expect(calls).toBe(1);
        expect(replacement.sent).toEqual([]);
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_registration_heads").get()).toEqual({ count: 256 });
    });

    test("requires one bounded refetch round trip before admitting a resumed subscription", async () => {
        const held = holdSettlements();
        const socket = new FakeSocket({ ...attachment(0), resumeRefetchPendingSubIds: [] });

        await subscribe(gateway, socket, 7);
        expect(held.calls()).toBe(0);
        expect(socket.attachment.resumeRefetchPendingSubIds).toEqual([SubId(7)]);
        expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({
            t: "mustRefetch",
            subIds: [7],
            reason: "lagged",
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_registration_heads").get()).toEqual({ count: 0 });

        const replacement = subscribe(gateway, socket, 7);
        expect(held.calls()).toBe(1);
        expect(socket.attachment.resumeRefetchPendingSubIds).toEqual([]);
        held.releases[0]?.();
        await replacement;

        socket.attachment = {
            ...socket.attachment,
            resumeRefetchPendingSubIds: Array.from({ length: MAX_INITIAL_SNAPSHOTS_PER_CONNECTION }, (_, subId) =>
                SubId(subId)
            ),
        };
        await subscribe(gateway, socket, MAX_INITIAL_SNAPSHOTS_PER_CONNECTION);
        expect(held.calls()).toBe(1);
        expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
            t: "error",
            subId: MAX_INITIAL_SNAPSHOTS_PER_CONNECTION,
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });
    });

    test("releases durable capacity as soon as unsubscribe retires the current head", async () => {
        seedCurrentHeads(256);
        let calls = 0;
        (gateway as unknown as GatewayInternals).settleSubscription = async () => {
            calls += 1;
        };
        const current = new FakeSocket(attachment(0, [SubId(0)]));
        await unsubscribe(gateway, current, 0);
        expect(db.query("SELECT COUNT(*) AS count FROM _gw_registration_heads").get()).toEqual({ count: 255 });

        const replacement = new FakeSocket(attachment(256));
        await subscribe(gateway, replacement, 0);
        expect(calls).toBe(1);
        expect(replacement.sent).toEqual([]);
    });
});
