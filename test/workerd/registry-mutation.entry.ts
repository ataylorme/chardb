import { DurableObject } from "cloudflare:workers";
import { gte } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { isCdbError } from "../../src/errors.ts";
import { cdbPolicyDigest } from "../../src/server/cdb-policy.ts";
import { chardb } from "../../src/server/chardb.ts";
import { createApi } from "../../src/server/define.ts";
import type { CdbMutationRequest, CdbMutationResponse } from "../../src/server/do/cdb.ts";
import { globalScope } from "../../src/server/index.ts";
import { manifestFromExports, routeMutation, routeValidatedQuery } from "../../src/server/manifest.ts";
import type {
    CdbRegisteredQueryRequest,
    CdbSubscriptionRequest,
    GatewayInvalidationRequest,
    GatewayInvalidationResponse,
    LiveSubscriptionId,
} from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";

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

let registeredQueryRuns = 0;
const registryEntries = api.query({
    ref: "queries.ts#registryEntries",
    args: z.object({ organizationId: z.string(), minimum: z.number().int() }),
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string; minimum: number }) => ({
        kind: "select" as const,
        tables: ["registry_entries"],
        partitionKey: {
            table: "registry_entries",
            column: "organization_id",
            values: [args.organizationId],
        },
    }),
    handler: async function registryEntries(ctx, args) {
        registeredQueryRuns++;
        const rows = await ctx.db
            .select()
            .from(entries)
            .where(gte(entries.value, args.minimum))
            .orderBy(entries.id)
            .all();
        return rows.map(row => ({ ...row, freshProbe: ctx.auth.claims.probe ?? null }));
    },
});

const app = chardb({ schema, api: { putEntry, inspectEntries, rawAfterTyped, registryEntries } });
const manifest = manifestFromExports({ putEntry, inspectEntries, rawAfterTyped, registryEntries });

interface StoredEntry extends Record<string, SqlStorageValue> {
    readonly id: string;
    readonly owner_id: string;
    readonly value: number;
}

interface CountRow extends Record<string, SqlStorageValue> {
    readonly count: number;
}

export class Cdb extends app.Cdb {
    registeredQueryRunCount(): number {
        return registeredQueryRuns;
    }

    corruptRegisteredQuery(registrationId: string, kind: "malformed" | "mismatch" | "mapping"): void {
        if (kind === "mapping") {
            this.ctx.storage.sql.exec(
                `DELETE FROM _chardb_live_subscription_tables
                 WHERE registration_id = ?`,
                registrationId
            );
            return;
        }
        this.ctx.storage.sql.exec(
            `UPDATE _chardb_live_subscriptions
             SET args_json = ?
             WHERE registration_id = ?`,
            kind === "malformed" ? "{" : '{"minimum":0}',
            registrationId
        );
    }

    async subscribeForProof(request: CdbSubscriptionRequest): Promise<Record<string, unknown>> {
        try {
            return { ok: true, result: await this.subscribe(request) };
        } catch (error) {
            return {
                ok: false,
                error: isCdbError(error)
                    ? error.toJSON()
                    : { code: "CDB_INVARIANT", message: error instanceof Error ? error.message : "unknown failure" },
            };
        }
    }

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
        organizationId: TenantId(AUTH.tenantId),
        ref: ChardbRef("queries.ts#registryEntries"),
        args: {},
        queryHash: "registry-invalidation-query-hash",
        tables: ["registry_entries"],
        intervals: [],
    };
}

function registeredSubscriptionRequest(gatewayId: string, registrationId: string): CdbSubscriptionRequest {
    const args = { organizationId: AUTH.tenantId, minimum: 60 };
    const routed = routeValidatedQuery(manifest, { ref: registryEntries.__chardbRef, args }, tables =>
        cdbPolicyDigest(schema, tables)
    );
    return {
        subscription: {
            gatewayId,
            registrationId,
            connectionId: `connection-${registrationId}`,
            clientId: ClientId(`client-${registrationId}`),
            subId: SubId(2),
        },
        principalId: PrincipalId(AUTH.userId),
        organizationId: TenantId(AUTH.tenantId),
        ref: registryEntries.__chardbRef,
        args: routed.args,
        queryHash: routed.queryHash,
        tables: routed.intent.tables,
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
            registeredQueryRunCount(): Promise<number>;
            corruptRegisteredQuery(registrationId: string, kind: "malformed" | "mismatch" | "mapping"): Promise<void>;
            subscribeForProof(input: CdbSubscriptionRequest): Promise<Record<string, unknown>>;
            subscribe(input: CdbSubscriptionRequest): Promise<unknown>;
            unsubscribe(input: LiveSubscriptionId): Promise<void>;
            queryRegistered(input: CdbRegisteredQueryRequest): Promise<unknown>;
        };
        const url = new URL(request.url);
        if (url.pathname === "/state") return Response.json(await stub.inspectAtomicState());
        if (url.pathname === "/gateway-state") {
            const gateway = env.CDB_GATEWAY.get(gatewayId) as unknown as {
                inspectInvalidations(): Promise<readonly GatewayInvalidationRequest[]>;
            };
            return Response.json(await gateway.inspectInvalidations());
        }
        if (url.pathname === "/subscribe") {
            return Response.json(await stub.subscribe(subscribeRequest));
        }
        if (url.pathname === "/unsubscribe") {
            await stub.unsubscribe(subscribeRequest.subscription);
            return Response.json({ ok: true });
        }
        if (url.pathname.startsWith("/registered/")) {
            const body = (await request.json()) as {
                readonly registrationId: string;
                readonly forgedIdentity?: boolean;
                readonly forgedPrincipal?: boolean;
                readonly forgedOrganization?: boolean;
                readonly corruption?: "malformed" | "mismatch" | "mapping";
            };
            const registered = registeredSubscriptionRequest(gatewayId.toString(), body.registrationId);
            if (url.pathname === "/registered/runs") {
                return Response.json({ runs: await stub.registeredQueryRunCount() });
            }
            if (url.pathname === "/registered/subscribe") {
                return Response.json(await stub.subscribeForProof(registered));
            }
            if (url.pathname === "/registered/unsubscribe") {
                await stub.unsubscribe(registered.subscription);
                return Response.json({ ok: true });
            }
            if (url.pathname === "/registered/corrupt") {
                if (!body.corruption) return Response.json({ ok: false }, { status: 400 });
                await stub.corruptRegisteredQuery(body.registrationId, body.corruption);
                return Response.json({ ok: true });
            }
            if (url.pathname === "/registered/query") {
                return Response.json(
                    await stub.queryRegistered({
                        subscription: body.forgedIdentity
                            ? { ...registered.subscription, connectionId: "forged-connection" }
                            : registered.subscription,
                        auth: {
                            ...AUTH,
                            userId: body.forgedPrincipal ? "forged-principal" : AUTH.userId,
                            tenantId: body.forgedOrganization ? "forged-organization" : AUTH.tenantId,
                            claims: { probe: "fresh-query-auth" },
                        },
                    })
                );
            }
            return Response.json({ ok: false }, { status: 404 });
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
