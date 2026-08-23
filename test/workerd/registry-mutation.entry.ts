import { DurableObject } from "cloudflare:workers";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { chardb } from "../../src/server/chardb.ts";
import { createApi } from "../../src/server/define.ts";
import type { CdbMutationRequest, CdbMutationResponse } from "../../src/server/do/cdb.ts";
import { globalScope } from "../../src/server/index.ts";
import { manifestFromExports, routeMutation } from "../../src/server/manifest.ts";
import type {
    CdbSubscriptionRequest,
    GatewayInvalidationRequest,
    GatewayInvalidationResponse,
    LiveSubscriptionId,
} from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId } from "../../src/types.ts";

const { cdbTable } = globalScope();
const entries = cdbTable(
    "registry_entries",
    {
        id: text("id").primaryKey(),
        ownerId: text("owner_id").notNull(),
        value: integer("value").notNull(),
    },
    { partitionBy: "ownerId", roles: { member: { create: "*", read: "*" } } }
);
const schema = { entries };
const api = createApi(schema);

const putEntry = api.mutation({
    args: z.object({ id: z.string().min(1), value: z.number().int() }),
    handler: function putEntry(ctx, args) {
        if (args.id === "explode") throw new Error("unexpected handler failure");
        ctx.db.insert(entries).values({ id: args.id, ownerId: ctx.auth.userId, value: args.value }).run();
        return {
            saved: { id: args.id, value: args.value },
            actor: {
                userId: ctx.auth.userId,
                tenantId: ctx.auth.tenantId ?? null,
                role: ctx.auth.role ?? null,
                probeClaim: ctx.auth.claims.probe ?? null,
            },
        };
    },
});

const inspectEntries = api.mutation({
    args: z.object({ label: z.string() }),
    handler: function inspectEntries(ctx, args) {
        const rows = ctx.db.select().from(entries).orderBy(entries.id).all();
        return {
            label: args.label,
            rows,
            reader: ctx.auth.userId,
        };
    },
});

const rawAfterTyped = api.mutation({
    args: z.object({ id: z.string().min(1), value: z.number().int() }),
    handler: function rawAfterTyped(ctx, args) {
        ctx.db.insert(entries).values({ id: args.id, ownerId: ctx.auth.userId, value: args.value }).run();
        ctx.db.run('DELETE FROM "registry_entries"');
        return args.id;
    },
});

const app = chardb({ schema, api: { putEntry, inspectEntries, rawAfterTyped } });
const manifest = manifestFromExports({ putEntry, inspectEntries, rawAfterTyped });

interface StoredEntry extends Record<string, SqlStorageValue> {
    readonly id: string;
    readonly owner_id: string;
    readonly value: number;
}

interface CountRow extends Record<string, SqlStorageValue> {
    readonly count: number;
}

export class Cdb extends app.Cdb {
    inspectAtomicState(): {
        readonly entries: readonly StoredEntry[];
        readonly opLogRows: number;
        readonly changeSeq: number;
        readonly mappings: readonly Record<string, SqlStorageValue>[];
        readonly outbox: readonly Record<string, SqlStorageValue>[];
    } {
        const entries = [
            ...this.ctx.storage.sql.exec<StoredEntry>("SELECT id, owner_id, value FROM registry_entries ORDER BY id"),
        ];
        const count = [...this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM _chardb_op_log")][0];
        const clock = [
            ...this.ctx.storage.sql.exec<{ change_seq: number }>(
                "SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1"
            ),
        ][0];
        const mappings = [
            ...this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
                `SELECT gateway_id, registration_id, table_name
                 FROM _chardb_live_subscription_tables
                 ORDER BY gateway_id, registration_id, table_name`
            ),
        ];
        const outbox = [
            ...this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
                `SELECT gateway_id, registration_id, change_seq
                 FROM _chardb_invalidation_outbox
                 ORDER BY gateway_id, registration_id`
            ),
        ];
        return { entries, opLogRows: count?.count ?? 0, changeSeq: clock?.change_seq ?? -1, mappings, outbox };
    }
}

export class InvalidationGateway extends DurableObject<Record<string, never>> {
    constructor(state: DurableObjectState, env: Record<string, never>) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(
                `CREATE TABLE IF NOT EXISTS invalidation_calls (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   request_json TEXT NOT NULL
                 )`
            );
        });
    }

    async invalidateSubscriptions(request: GatewayInvalidationRequest): Promise<GatewayInvalidationResponse> {
        this.ctx.storage.sql.exec("INSERT INTO invalidation_calls (request_json) VALUES (?)", JSON.stringify(request));
        return {
            gatewayId: request.gatewayId,
            acknowledgements: request.invalidations.map(invalidation => ({
                registrationId: invalidation.subscription.registrationId,
                changeSeq: invalidation.changeSeq,
                status: "accepted",
            })),
        };
    }

    inspectInvalidations(): readonly GatewayInvalidationRequest[] {
        return [
            ...this.ctx.storage.sql.exec<{ request_json: string }>(
                "SELECT request_json FROM invalidation_calls ORDER BY id"
            ),
        ].map(row => JSON.parse(row.request_json) as GatewayInvalidationRequest);
    }
}

interface DispatchBody {
    readonly operation: "put" | "inspect" | "raw" | "unknown";
    readonly mutId: string;
    readonly args: unknown;
}

const AUTH = {
    userId: "registry-user",
    tenantId: "registry-org",
    role: "member",
    roles: ["member"],
    claims: { probe: "claim-ok" },
} as const;

function subscriptionRequest(gatewayId: string): CdbSubscriptionRequest {
    return {
        subscription: {
            gatewayId,
            registrationId: "registry-registration",
            connectionId: "registry-connection",
            clientId: ClientId("registry-client"),
            subId: SubId(1),
        },
        principalId: PrincipalId(AUTH.userId),
        ref: ChardbRef("queries.ts#registryEntries"),
        args: {},
        tables: ["registry_entries"],
        intervals: [],
    };
}

interface RegistryEnv {
    readonly CDB: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: RegistryEnv): Promise<Response> {
        const id = env.CDB.idFromName("configured-registry");
        const gatewayId = env.CDB_GATEWAY.idFromName("registry-gateway");
        const subscribeRequest = subscriptionRequest(gatewayId.toString());
        const stub = env.CDB.get(id) as unknown as {
            mutate(input: CdbMutationRequest): Promise<CdbMutationResponse>;
            inspectAtomicState(): Promise<unknown>;
            subscribe(input: CdbSubscriptionRequest): Promise<unknown>;
            unsubscribe(input: LiveSubscriptionId): Promise<void>;
        };
        if (new URL(request.url).pathname === "/state") return Response.json(await stub.inspectAtomicState());
        if (new URL(request.url).pathname === "/gateway-state") {
            const gateway = env.CDB_GATEWAY.get(gatewayId) as unknown as {
                inspectInvalidations(): Promise<readonly GatewayInvalidationRequest[]>;
            };
            return Response.json(await gateway.inspectInvalidations());
        }
        if (new URL(request.url).pathname === "/subscribe") {
            return Response.json(await stub.subscribe(subscribeRequest));
        }
        if (new URL(request.url).pathname === "/unsubscribe") {
            await stub.unsubscribe(subscribeRequest.subscription);
            return Response.json({ ok: true });
        }
        const body = (await request.json()) as DispatchBody;
        const ref =
            body.operation === "put"
                ? putEntry.__chardbRef
                : body.operation === "inspect"
                  ? inspectEntries.__chardbRef
                  : body.operation === "raw"
                    ? rawAfterTyped.__chardbRef
                    : "src/probe.ts#missing";
        const route = routeMutation(manifest, { ref, args: body.args as CdbMutationRequest["args"] }, () => 0);
        if (!route.ok) return Response.json(route);
        const mutationRequest: CdbMutationRequest = {
            principalId: AUTH.userId,
            mutId: body.mutId,
            ref,
            args: route.args,
            auth: AUTH,
            schemaEpoch: 1,
        };
        return Response.json(await stub.mutate(mutationRequest));
    },
};
