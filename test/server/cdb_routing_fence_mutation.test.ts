import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { cdbPolicyDigest } from "../../src/server/cdb-policy.ts";
import { createApi } from "../../src/server/define.ts";
import type { CdbRoutingFenceIdentity } from "../../src/server/do/cdb-routing-fence-store.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { manifestFromExports, routeValidatedQuery } from "../../src/server/manifest.ts";
import type {
    CdbMutationRequest,
    CdbRegisteredQueryRequest,
    CdbSubscriptionRequest,
    GatewayInvalidationRequest,
    GatewayInvalidationResponse,
} from "../../src/server/rpc.ts";
import { ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";
import { vshardOf } from "../../src/vshard.ts";
import { globalScope } from "../helpers/cdb-table.ts";
import { withRecoveryEnv } from "../helpers/recovery.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database, afterExec: (query: string) => void = () => undefined) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            afterExec(query);
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

function construct(
    CdbClass: typeof Cdb,
    db: Database,
    env: Record<string, unknown> = {},
    afterExec: (query: string) => void = () => undefined
): { readonly cdb: Cdb; readonly ready: Promise<unknown> } {
    let ready: Promise<unknown> = Promise.resolve();
    const state = {
        id: { toString: () => "routing-fence-shard" },
        storage: {
            sql: sqlStorage(db, afterExec),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            setAlarm: async (): Promise<void> => {},
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    return { cdb: new CdbClass(state, withRecoveryEnv(env)), ready };
}

const databases: Database[] = [];

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

describe("Cdb routing fence", () => {
    test("checks the placed partition and routing generation inside mutation admission", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const { cdbTable } = globalScope();
        const records = cdbTable(
            "routing_fence_records",
            {
                id: text("id").primaryKey(),
                ownerId: text("owner_id").notNull(),
                value: integer("value").notNull(),
            },
            { partitionBy: "ownerId", roles: { member: { create: "*", read: "*" } } }
        );
        const api = createApi({ records });
        let queryRuns = 0;
        const listRecords = api.query({
            ref: "routing-fence.ts#listRecords",
            query: (db, args: { ownerId: string }) => {
                queryRuns += 1;
                return db
                    .select()
                    .from(records)
                    .where(eq(records.ownerId, args.ownerId))
                    .orderBy(records.id)
                    .limit(100);
            },
        });
        const putRecord = api.mutation({
            ref: "routing-fence.ts#putRecord",
            authority: "global",
            partitionKey: "ownerId",
            args: z.object({ id: z.string(), ownerId: z.string(), value: z.number().int() }),
            handler: (ctx, args) => {
                ctx.db.insert(records).values(args).run();
                return args.id;
            },
        });
        const manifest = manifestFromExports({ listRecords, putRecord });
        const ConfiguredCdb = configureCdbRuntime({
            schema: () => ({ records }),
            manifest: () => manifest,
        });
        const runtime = construct(ConfiguredCdb, db);
        await runtime.ready;

        const partitionKey = "routing-user";
        const vshard = vshardOf([partitionKey]);
        const fence = {
            migrationId: "native-source-fence",
            recoveryGeneration: 0,
            rangeLo: vshard,
            rangeHi: vshard,
            sourceGeneration: 1,
            destinationGeneration: 2,
        } as const;
        runtime.cdb.prepareRoutingFence(fence);

        const request = (mutId: string, id: string, schemaEpoch: number): CdbMutationRequest => ({
            recoveryGeneration: 0,
            principalId: partitionKey,
            mutId,
            ref: putRecord.__chardbRef,
            args: { id, ownerId: partitionKey, value: 1 },
            placement: { authority: "global", partitionKey },
            auth: { userId: partitionKey, role: "member", roles: ["member"], claims: {} },
            schemaEpoch,
            domainSchemaEpoch: 1,
        });

        await expect(
            runtime.cdb.mutate(request("wrong-prepared-generation", "wrong-prepared", 2))
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH", retryable: true } });
        const sourceRequest = request("source-write", "before-cutover", 1);
        const sourceWrite = runtime.cdb.mutate(sourceRequest);
        (sourceRequest.placement as { partitionKey: string }).partitionKey = "caller-mutated-after-admission";
        await expect(sourceWrite).resolves.toMatchObject({
            ok: true,
            ran: true,
            result: "before-cutover",
        });
        await runtime.cdb.activateRoutingFence(fence);

        await expect(
            runtime.cdb.query({
                recoveryGeneration: 0,
                ref: listRecords.__chardbRef,
                args: { ownerId: partitionKey },
                placement: { authority: "global", partitionKey },
                auth: { userId: partitionKey, role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH", retryable: true } });
        await expect(
            runtime.cdb.executePlan({
                recoveryGeneration: 0,
                plan: {
                    version: 1,
                    kind: "select",
                    table: "routing_fence_records",
                    selection: { kind: "all" },
                    where: { kind: "compare", op: "eq", column: "owner_id", value: partitionKey },
                    cardinality: "many",
                },
                placement: { authority: "global", partitionKey },
                auth: { userId: partitionKey, role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH", retryable: true } });
        expect(queryRuns).toBe(0);

        for (const [schemaEpoch, id] of [
            [1, "stale-source"],
            [2, "misrouted-destination"],
            [3, "unrecognized-newer"],
        ] as const) {
            await expect(runtime.cdb.mutate(request(`fenced-${schemaEpoch}`, id, schemaEpoch))).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_STALE_EPOCH", retryable: true },
            });
        }

        expect(db.query("SELECT id FROM routing_fence_records ORDER BY id").all()).toEqual([{ id: "before-cutover" }]);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 1 });
    });

    test("activation durably wakes an idle source subscription and fences its planned rerun", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const { cdbTable } = globalScope();
        const records = cdbTable(
            "routing_fence_live_records",
            {
                id: text("id").primaryKey(),
                ownerId: text("owner_id").notNull(),
            },
            { partitionBy: "ownerId", roles: { member: { read: "*" } } }
        );
        const api = createApi({ records });
        const listRecords = api.query({
            ref: "routing-fence.ts#liveRecords",
            query: (db, args: { ownerId: string }) =>
                db.select().from(records).where(eq(records.ownerId, args.ownerId)).orderBy(records.id).limit(100),
        });
        const manifest = manifestFromExports({ listRecords });
        const ConfiguredCdb = configureCdbRuntime({ schema: () => ({ records }), manifest: () => manifest });
        const invalidations: GatewayInvalidationRequest[] = [];
        const gateway = {
            async invalidateSubscriptions(request: GatewayInvalidationRequest): Promise<GatewayInvalidationResponse> {
                invalidations.push(request);
                return {
                    gatewayId: request.gatewayId,
                    acknowledgements: request.invalidations.map(item => ({
                        registrationId: item.subscription.registrationId,
                        changeSeq: item.changeSeq,
                        status: "accepted" as const,
                    })),
                };
            },
        };
        const gatewayNamespace = {
            idFromString: (id: string) => ({ toString: () => id }),
            get: () => gateway,
        } as unknown as DurableObjectNamespace;
        let fenceToActivate: CdbRoutingFenceIdentity | undefined;
        let activation: Promise<unknown> | undefined;
        const runtime = construct(ConfiguredCdb, db, { CDB_GATEWAY: gatewayNamespace }, query => {
            if (!fenceToActivate || !/from\s+["`]routing_fence_live_records["`]/i.test(query)) return;
            const fence = fenceToActivate;
            fenceToActivate = undefined;
            activation = runtime.cdb.activateRoutingFence(fence);
        });
        await runtime.ready;

        const partitionKey = "idle-routing-user";
        const vshard = Number(vshardOf([partitionKey]));
        const args = { ownerId: partitionKey };
        const routed = routeValidatedQuery(manifest, { ref: listRecords.__chardbRef, args }, tables =>
            cdbPolicyDigest({ records }, tables)
        );
        const subscription = {
            gatewayId: "gateway-idle",
            registrationId: "registration-idle",
            connectionId: "connection-idle",
            clientId: ClientId("client-idle"),
            subId: SubId(1),
        };
        const subscribeRequest: CdbSubscriptionRequest = {
            recoveryGeneration: 0,
            subscription,
            principalId: PrincipalId(partitionKey),
            organizationId: TenantId(partitionKey),
            placement: { authority: "global", partitionKey },
            schemaEpoch: 1,
            vshard,
            domainSchemaEpoch: 1,
            ref: listRecords.__chardbRef,
            args,
            queryHash: routed.queryHash,
            tables: routed.intent.tables,
            intervals: routed.intent.intervals ?? [],
        };
        await expect(runtime.cdb.subscribe(subscribeRequest)).resolves.toMatchObject({ ok: true });

        const fence = {
            migrationId: "idle-source-fence",
            recoveryGeneration: 0,
            rangeLo: vshard,
            rangeHi: vshard,
            sourceGeneration: 1,
            destinationGeneration: 2,
        } as const;
        runtime.cdb.prepareRoutingFence(fence);
        const rerun: CdbRegisteredQueryRequest = {
            recoveryGeneration: 0,
            subscription,
            placement: { authority: "global", partitionKey },
            auth: { userId: partitionKey, role: "member", roles: ["member"], claims: {} },
            schemaEpoch: 1,
            vshard,
            domainSchemaEpoch: 1,
        };
        fenceToActivate = fence;
        await expect(runtime.cdb.queryRegistered(rerun)).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_STALE_EPOCH", retryable: true },
        });
        await activation;

        // Retrying activation after response loss must not create a second invalidation.
        await runtime.cdb.activateRoutingFence(fence);

        expect(
            db
                .query(
                    "SELECT gateway_id, registration_id, attempts FROM _chardb_invalidation_outbox ORDER BY registration_id"
                )
                .all()
        ).toEqual([{ gateway_id: "gateway-idle", registration_id: "registration-idle", attempts: 0 }]);
        await expect(runtime.cdb.queryRegistered(rerun)).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_STALE_EPOCH", retryable: true },
        });
        const replacement = {
            ...subscribeRequest,
            subscription: {
                ...subscription,
                registrationId: "registration-after-cutover",
            },
        };
        await expect(runtime.cdb.subscribe(replacement)).resolves.toMatchObject({
            ok: false,
            registrationState: "absent",
            subscription: replacement.subscription,
            error: { code: "CDB_STALE_EPOCH", retryable: true },
        });

        await runtime.cdb.alarm();
        expect(invalidations).toHaveLength(1);
        expect(invalidations[0]).toMatchObject({
            sourceCdbId: "routing-fence-shard",
            gatewayId: "gateway-idle",
            invalidations: [{ subscription, changeSeq: 1 }],
        });
        expect(db.query("SELECT * FROM _chardb_invalidation_outbox").all()).toEqual([]);
    });
});
