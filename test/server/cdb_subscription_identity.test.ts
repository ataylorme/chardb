import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cdb } from "../../src/server/do/cdb.ts";
import type { CdbSubscriptionRequest, LiveSubscriptionId } from "../../src/server/rpc.ts";
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

function subscription(gatewayId: string, clientId: string): LiveSubscriptionId {
    return { gatewayId, clientId: ClientId(clientId), subId: SubId(1) };
}

function request(identity: LiveSubscriptionId): CdbSubscriptionRequest {
    return {
        subscription: identity,
        principalId: PrincipalId("user-1"),
        ref: ChardbRef("queries.ts#messages"),
        args: { organizationId: "org-1" },
        tables: ["messages"],
        intervals: [{ table: "messages", indexName: "by_org", intervals: [{ kind: "full" }] }],
    };
}

describe("Cdb live subscription identity", () => {
    let db: Database;
    let cdb: Cdb;
    let bootstrap: Promise<unknown>;
    let state: DurableObjectState;

    async function reconstruct(): Promise<void> {
        cdb = new Cdb(state, {});
        await bootstrap;
    }

    beforeEach(async () => {
        db = new Database(":memory:");
        bootstrap = Promise.resolve();
        state = {
            id: { toString: () => "shard-do-1" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                bootstrap = callback();
            },
        } as unknown as DurableObjectState;
        await reconstruct();
    });

    afterEach(() => db.close());

    test("rebuilds colliding numeric subIds and persists a targeted unsubscribe", async () => {
        const first = subscription("gateway-do-1", "client-1");
        const second = subscription("gateway-do-1", "client-2");
        const third = subscription("gateway-do-2", "client-1");
        await cdb.subscribe(request(first));
        await cdb.subscribe(request(second));
        await cdb.subscribe(request(third));

        expect(
            db
                .prepare(
                    `SELECT principal_id, ref, args_json, tables_json, intervals_json
                     FROM _chardb_subscriptions
                     WHERE gateway_id = ? AND client_id = ? AND sub_id = ?`
                )
                .get(second.gatewayId, second.clientId, second.subId)
        ).toEqual({
            principal_id: "user-1",
            ref: "queries.ts#messages",
            args_json: '{"organizationId":"org-1"}',
            tables_json: '["messages"]',
            intervals_json: '[{"table":"messages","indexName":"by_org","intervals":[{"kind":"full"}]}]',
        });

        await reconstruct();

        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([
            first,
            second,
            third,
        ]);

        await cdb.unsubscribe({ ...second });

        await reconstruct();

        expect(cdb.matchSubsForRow("messages", [{ indexName: "by_org", key: ["org-1"] }])).toEqual([first, third]);
    });
});
