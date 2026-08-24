import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import baseWorker, { Catalog, Cdb as ProductionCdb, Gateway as ProductionGateway } from "./gateway-jwt.entry.ts";

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

interface GatewayLiveState {
    readonly instanceId: string;
    readonly registrations: readonly {
        readonly registrationId: string;
        readonly connectionId: string;
        readonly clientId: string;
        readonly subId: number;
        readonly organizationId: string;
        readonly lifecycle: string;
        readonly cdbState: string;
        readonly dirtyVersion: number;
        readonly deliveredVersion: number;
        readonly initialSnapshotPending: boolean;
        readonly lastCookie: string | null;
        readonly lastSnapshotCookie: string | null;
        readonly currentHead: boolean;
        readonly outboxCookie: string | null;
        readonly outboxTargetVersion: number | null;
    }[];
}

interface CdbLiveState {
    readonly instanceId: string;
    readonly subscriptions: readonly {
        readonly gatewayId: string;
        readonly registrationId: string;
        readonly clientId: string;
        readonly subId: number;
        readonly state: string;
        readonly organizationId: string | null;
    }[];
    readonly invalidations: readonly {
        readonly gatewayId: string;
        readonly registrationId: string;
        readonly changeSeq: number;
    }[];
}

export { Catalog };

export class Gateway extends ProductionGateway {
    private readonly fixtureInstanceId = crypto.randomUUID();
    private fixtureNowSequence: number[] = [];

    // Tests call fixtureDrain after they inspect each durable transition. Keep
    // workerd's alarm delivery from racing those assertions.
    override async alarm(): Promise<void> {}

    protected override gatewayNowMs(): number {
        return this.fixtureNowSequence.shift() ?? super.gatewayNowMs();
    }

    async fixtureDrain(): Promise<void> {
        await super.alarm();
    }

    async fixtureStageOnly(): Promise<void> {
        const nowMs = super.gatewayNowMs();
        this.fixtureNowSequence = [nowMs, nowMs, nowMs + 1, nowMs, nowMs];
        try {
            await super.alarm();
        } finally {
            this.fixtureNowSequence = [];
        }
    }

    fixtureLiveState(): GatewayLiveState {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const rows = sql.all<{
            registration_id: string;
            connection_id: string;
            client_id: string;
            sub_id: number;
            organization_id: string;
            lifecycle: string;
            cdb_state: string;
            dirty_version: number;
            delivered_version: number;
            initial_snapshot_pending: number;
            last_cookie: string | null;
            last_snapshot_cookie: string | null;
            current_head: number;
            outbox_cookie: string | null;
            outbox_target_version: number | null;
        }>(
            `SELECT g.registration_id, g.connection_id, g.client_id, g.sub_id, g.organization_id,
                    g.lifecycle, g.cdb_state, g.dirty_version, g.delivered_version,
                    g.initial_snapshot_pending, g.last_cookie, g.last_snapshot_cookie,
                    CASE WHEN h.registration_id IS NULL THEN 0 ELSE 1 END AS current_head,
                    o.cookie AS outbox_cookie, o.target_version AS outbox_target_version
             FROM _gw_registration_generations AS g
             LEFT JOIN _gw_registration_heads AS h ON h.registration_id = g.registration_id
             LEFT JOIN _gw_snapshot_outbox AS o ON o.registration_id = g.registration_id
             ORDER BY g.created_at, g.registration_id`
        );
        return {
            instanceId: this.fixtureInstanceId,
            registrations: rows.map(row => ({
                registrationId: row.registration_id,
                connectionId: row.connection_id,
                clientId: row.client_id,
                subId: row.sub_id,
                organizationId: row.organization_id,
                lifecycle: row.lifecycle,
                cdbState: row.cdb_state,
                dirtyVersion: row.dirty_version,
                deliveredVersion: row.delivered_version,
                initialSnapshotPending: row.initial_snapshot_pending === 1,
                lastCookie: row.last_cookie,
                lastSnapshotCookie: row.last_snapshot_cookie,
                currentHead: row.current_head === 1,
                outboxCookie: row.outbox_cookie,
                outboxTargetVersion: row.outbox_target_version,
            })),
        };
    }
}

export class Cdb extends ProductionCdb {
    private readonly fixtureInstanceId = crypto.randomUUID();

    fixtureMatchOrganization(): CdbLiveState["subscriptions"] {
        const matched = this.matchSubsForRow("gateway_writes", [
            { indexName: "organization_id", key: ["workerd-org"] },
        ]);
        const state = this.fixtureLiveState();
        const registrationIds = new Set(matched.map(subscription => subscription.registrationId));
        return state.subscriptions.filter(subscription => registrationIds.has(subscription.registrationId));
    }

    fixtureLiveState(): CdbLiveState {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            instanceId: this.fixtureInstanceId,
            subscriptions: sql
                .all<{
                    gateway_id: string;
                    registration_id: string;
                    client_id: string;
                    sub_id: number;
                    state: string;
                    organization_id: string | null;
                }>(
                    `SELECT gateway_id, registration_id, client_id, sub_id, state, organization_id
                     FROM _chardb_live_subscriptions
                     ORDER BY gateway_id, registration_id`
                )
                .map(row => ({
                    gatewayId: row.gateway_id,
                    registrationId: row.registration_id,
                    clientId: row.client_id,
                    subId: row.sub_id,
                    state: row.state,
                    organizationId: row.organization_id,
                })),
            invalidations: sql
                .all<{ gateway_id: string; registration_id: string; change_seq: number }>(
                    `SELECT gateway_id, registration_id, change_seq
                     FROM _chardb_invalidation_outbox
                     ORDER BY gateway_id, registration_id, change_seq`
                )
                .map(row => ({
                    gatewayId: row.gateway_id,
                    registrationId: row.registration_id,
                    changeSeq: row.change_seq,
                })),
        };
    }
}

interface GatewayFixtureRpc {
    fixtureDrain(): Promise<void>;
    fixtureStageOnly(): Promise<void>;
    fixtureLiveState(): Promise<GatewayLiveState>;
}

interface CdbFixtureRpc {
    fixtureMatchOrganization(): Promise<CdbLiveState["subscriptions"]>;
    fixtureLiveState(): Promise<CdbLiveState>;
}

type MembershipMutation =
    | { readonly action: "delete"; readonly organizationId: string; readonly userId: string }
    | {
          readonly action: "upsert";
          readonly organizationId: string;
          readonly userId: string;
          readonly role: string;
      };

interface CatalogFixtureRpc {
    mutateAuth(args: {
        readonly model: string;
        readonly op: "create" | "update" | "delete";
        readonly where?: { readonly [key: string]: string };
        readonly payload?: { readonly [key: string]: string | number };
    }): Promise<{ readonly affected?: number }>;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/live-membership") {
            const mutation = (await request.json()) as MembershipMutation;
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as CatalogFixtureRpc;
            const where = {
                organizationId: mutation.organizationId,
                userId: mutation.userId,
            };
            if (mutation.action === "delete") {
                return Response.json(await catalog.mutateAuth({ model: "member", op: "delete", where }));
            }
            const updated = await catalog.mutateAuth({
                model: "member",
                op: "update",
                where,
                payload: { role: mutation.role },
            });
            if ((updated.affected ?? 0) > 0) return Response.json(updated);
            return Response.json(
                await catalog.mutateAuth({
                    model: "member",
                    op: "create",
                    payload: {
                        id: `fixture-${mutation.organizationId}-${mutation.userId}`,
                        ...where,
                        role: mutation.role,
                        createdAt: Date.parse("2026-08-23T00:00:00Z"),
                    },
                })
            );
        }
        if (
            url.pathname === "/live-gateway-drain" ||
            url.pathname === "/live-gateway-stage" ||
            url.pathname === "/live-gateway-state"
        ) {
            const clientId = url.searchParams.get("clientId");
            if (!clientId) return new Response("missing clientId", { status: 400 });
            const id = env.CDB_GATEWAY.idFromName(clientId.slice(0, 12));
            const gateway = env.CDB_GATEWAY.get(id) as unknown as GatewayFixtureRpc;
            if (url.pathname === "/live-gateway-drain") {
                await gateway.fixtureDrain();
                return Response.json({ ok: true });
            }
            if (url.pathname === "/live-gateway-stage") {
                await gateway.fixtureStageOnly();
                return Response.json({ ok: true });
            }
            return Response.json(await gateway.fixtureLiveState());
        }
        if (url.pathname === "/live-cdb-state" || url.pathname === "/live-cdb-match") {
            const shardId = url.searchParams.get("shardId");
            if (!shardId) return new Response("missing shardId", { status: 400 });
            const id = env.CDB_SHARD.idFromName(shardId);
            const cdb = env.CDB_SHARD.get(id) as unknown as CdbFixtureRpc;
            if (url.pathname === "/live-cdb-match") {
                return Response.json(await cdb.fixtureMatchOrganization());
            }
            return Response.json(await cdb.fixtureLiveState());
        }
        return baseWorker.fetch(request, env);
    },
};
