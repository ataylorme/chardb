import {
    type GatewayDirtyRun,
    type GatewayRegistrationInstall,
    acknowledgeGatewaySnapshot,
    claimDirtyGatewayRegistration,
    claimDueGatewaySnapshot,
    installGatewayRegistration,
    stageGatewaySnapshot,
} from "../../src/server/do/gateway.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, type RawJson, SubId, TenantId } from "../../src/types.ts";
import baseWorker, { Catalog, Cdb as LiveCdb, Gateway as LiveGateway } from "./gateway-live.entry.ts";

const REGISTRATION: GatewayRegistrationInstall = {
    registrationId: "registration-workerd-snapshot",
    principalId: PrincipalId("principal-workerd"),
    clientId: ClientId("client-workerd"),
    subId: SubId(7),
    connectionId: "connection-workerd",
    organizationId: TenantId("organization-workerd"),
    ref: ChardbRef("queries.ts#messages"),
    args: { organizationId: "organization-workerd" },
    intent: {
        kind: "select",
        tables: ["messages"],
        partitionKey: { table: "messages", column: "organization_id", values: ["organization-workerd"] },
    },
    policyDigest: "policy-digest-workerd",
    queryHash: "query-hash-workerd",
    shardId: "logical-shard-workerd",
    sourceCdbId: "physical-cdb-workerd",
    schemaEpoch: 1,
    authEpochs: { global: 1, tenant: 2, principal: 3 },
    lastCookie: Cookie("cookie-baseline"),
    nowMs: 100,
};

interface StoredSnapshotState {
    readonly instanceId: string;
    readonly generation: {
        readonly lifecycle: string;
        readonly cdbState: string;
        readonly dirtyVersion: number;
        readonly deliveredVersion: number;
        readonly runToken: string | null;
        readonly runTargetVersion: number | null;
        readonly runVersion: number;
        readonly lastCookie: string | null;
        readonly lastSnapshotCookie: string | null;
        readonly headRegistrationId: string | null;
    } | null;
    readonly outbox: {
        readonly cookie: string;
        readonly targetVersion: number;
        readonly rowsJson: string;
        readonly sendAttempts: number;
        readonly nextAttemptAt: number;
        readonly claimToken: string | null;
        readonly claimVersion: number;
        readonly claimExpiresAt: number | null;
        readonly lastSentAt: number | null;
    } | null;
}

interface FixtureDeliveryState {
    readonly registrationId: string;
    readonly dirtyVersion: number;
    readonly deliveredVersion: number;
    readonly lastCookie: string | null;
    readonly lastSnapshotCookie: string | null;
    readonly cookie: string | null;
    readonly targetVersion: number | null;
    readonly rowsJson: string | null;
    readonly sendAttempts: number | null;
    readonly claimVersion: number | null;
    readonly claimExpiresAt: number | null;
    readonly lastSentAt: number | null;
}

export { Catalog };

export class Gateway extends LiveGateway {
    private readonly snapshotFixtureInstanceId = crypto.randomUUID();
    private snapshotNowMs: number | null = null;

    // Production bootstrap schedules overdue snapshot work against wall-clock
    // time. This durability fixture claims and acknowledges explicitly, so keep
    // the alarm from racing those deterministic transitions after reconstruction.
    override async alarm(): Promise<void> {}

    protected override gatewayNowMs(): number {
        return this.snapshotNowMs ?? super.gatewayNowMs();
    }

    async fixtureDrainAt(nowMs: number): Promise<void> {
        this.snapshotNowMs = nowMs;
        try {
            await this.fixtureDrain();
        } finally {
            this.snapshotNowMs = null;
        }
    }

    fixtureDeliveryState(clientId: string, subId: number): FixtureDeliveryState | null {
        const row = adaptSqlStorage(this.ctx.storage.sql).one<{
            registration_id: string;
            dirty_version: number;
            delivered_version: number;
            last_cookie: string | null;
            last_snapshot_cookie: string | null;
            cookie: string | null;
            target_version: number | null;
            rows_json: string | null;
            send_attempts: number | null;
            claim_version: number | null;
            claim_expires_at: number | null;
            last_sent_at: number | null;
        }>(
            `SELECT g.registration_id, g.dirty_version, g.delivered_version, g.last_cookie,
                    g.last_snapshot_cookie, o.cookie, o.target_version, o.rows_json,
                    o.send_attempts, o.claim_version, o.claim_expires_at, o.last_sent_at
             FROM _gw_registration_generations g
             INNER JOIN _gw_registration_heads h ON h.registration_id = g.registration_id
             LEFT JOIN _gw_snapshot_outbox o ON o.registration_id = g.registration_id
             WHERE g.client_id = ? AND g.sub_id = ?
             ORDER BY g.created_at DESC, g.registration_id DESC
             LIMIT 1`,
            clientId,
            subId
        );
        if (!row) return null;
        return {
            registrationId: row.registration_id,
            dirtyVersion: row.dirty_version,
            deliveredVersion: row.delivered_version,
            lastCookie: row.last_cookie,
            lastSnapshotCookie: row.last_snapshot_cookie,
            cookie: row.cookie,
            targetVersion: row.target_version,
            rowsJson: row.rows_json,
            sendAttempts: row.send_attempts,
            claimVersion: row.claim_version,
            claimExpiresAt: row.claim_expires_at,
            lastSentAt: row.last_sent_at,
        };
    }

    fixtureInstall(): boolean {
        return this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            installGatewayRegistration(sql, REGISTRATION);
            sql.exec(
                `UPDATE _gw_registration_generations
                 SET lifecycle = 'active', cdb_state = 'active', dirty_version = 2, delivered_version = 2,
                     updated_at = 110
                 WHERE registration_id = ?`,
                REGISTRATION.registrationId
            );
            return sql.changes() === 1;
        });
    }

    fixtureDirty(dirtyVersion: number): boolean {
        return this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `UPDATE _gw_registration_generations
                 SET dirty_version = MAX(dirty_version, ?), updated_at = 120
                 WHERE registration_id = ? AND lifecycle = 'active' AND cdb_state = 'active'`,
                dirtyVersion,
                REGISTRATION.registrationId
            );
            return sql.changes() === 1;
        });
    }

    fixtureClaim(nowMs = 200): GatewayDirtyRun | null {
        return this.ctx.storage.transactionSync(() =>
            claimDirtyGatewayRegistration(adaptSqlStorage(this.ctx.storage.sql), {
                ...registrationIdentity(),
                nowMs,
                leaseExpiresAt: nowMs + 100,
            })
        );
    }

    fixtureStage(run: GatewayDirtyRun): boolean {
        return this.ctx.storage.transactionSync(() =>
            stageGatewaySnapshot(adaptSqlStorage(this.ctx.storage.sql), {
                ...registrationIdentity(),
                runToken: run.runToken,
                runVersion: run.runVersion,
                targetVersion: run.targetVersion,
                cookie: Cookie("cookie-target-5"),
                rows: [{ id: "row-from-target-5" }],
                authEpochs: { global: 10, tenant: 11, principal: 12 },
                nowMs: 220,
            })
        );
    }

    fixtureClaimSend(): RawJson {
        return this.ctx.storage.transactionSync(
            () =>
                claimDueGatewaySnapshot(adaptSqlStorage(this.ctx.storage.sql), {
                    nowMs: 220,
                    attemptExpiresAt: 320,
                }) as unknown as RawJson
        );
    }

    fixtureAcknowledge(cookie = "cookie-target-5"): boolean {
        return this.ctx.storage.transactionSync(() =>
            acknowledgeGatewaySnapshot(adaptSqlStorage(this.ctx.storage.sql), {
                ...registrationIdentity(),
                cookie: Cookie(cookie),
                nowMs: 240,
            })
        );
    }

    fixtureInspect(): StoredSnapshotState {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const generation = sql.one<{
            lifecycle: string;
            cdb_state: string;
            dirty_version: number;
            delivered_version: number;
            run_token: string | null;
            run_target_version: number | null;
            run_version: number;
            last_cookie: string | null;
            last_snapshot_cookie: string | null;
            head_registration_id: string | null;
        }>(
            `SELECT g.lifecycle, g.cdb_state, g.dirty_version, g.delivered_version, g.run_token,
                    g.run_target_version, g.run_version, g.last_cookie, g.last_snapshot_cookie,
                    h.registration_id AS head_registration_id
             FROM _gw_registration_generations g
             LEFT JOIN _gw_registration_heads h ON h.registration_id = g.registration_id
             WHERE g.registration_id = ?`,
            REGISTRATION.registrationId
        );
        const outbox = sql.one<{
            cookie: string;
            target_version: number;
            rows_json: string;
            send_attempts: number;
            next_attempt_at: number;
            claim_token: string | null;
            claim_version: number;
            claim_expires_at: number | null;
            last_sent_at: number | null;
        }>(
            `SELECT cookie, target_version, rows_json, send_attempts, next_attempt_at,
                    claim_token, claim_version, claim_expires_at, last_sent_at
             FROM _gw_snapshot_outbox WHERE registration_id = ?`,
            REGISTRATION.registrationId
        );
        return {
            instanceId: this.snapshotFixtureInstanceId,
            generation: generation
                ? {
                      lifecycle: generation.lifecycle,
                      cdbState: generation.cdb_state,
                      dirtyVersion: generation.dirty_version,
                      deliveredVersion: generation.delivered_version,
                      runToken: generation.run_token,
                      runTargetVersion: generation.run_target_version,
                      runVersion: generation.run_version,
                      lastCookie: generation.last_cookie,
                      lastSnapshotCookie: generation.last_snapshot_cookie,
                      headRegistrationId: generation.head_registration_id,
                  }
                : null,
            outbox: outbox
                ? {
                      cookie: outbox.cookie,
                      targetVersion: outbox.target_version,
                      rowsJson: outbox.rows_json,
                      sendAttempts: outbox.send_attempts,
                      nextAttemptAt: outbox.next_attempt_at,
                      claimToken: outbox.claim_token,
                      claimVersion: outbox.claim_version,
                      claimExpiresAt: outbox.claim_expires_at,
                      lastSentAt: outbox.last_sent_at,
                  }
                : null,
        };
    }
}

export class Cdb extends LiveCdb {
    override async alarm(): Promise<void> {}

    async fixtureDrain(): Promise<void> {
        await super.alarm();
    }
}

function registrationIdentity() {
    return {
        principalId: REGISTRATION.principalId,
        clientId: REGISTRATION.clientId,
        subId: REGISTRATION.subId,
        registrationId: REGISTRATION.registrationId,
        connectionId: REGISTRATION.connectionId,
    } as const;
}

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

interface GatewayFixtureRpc {
    fixtureDrainAt(nowMs: number): Promise<void>;
    fixtureDeliveryState(clientId: string, subId: number): Promise<FixtureDeliveryState | null>;
    fixtureInstall(): Promise<boolean>;
    fixtureDirty(dirtyVersion: number): Promise<boolean>;
    fixtureClaim(nowMs?: number): Promise<GatewayDirtyRun | null>;
    fixtureStage(run: GatewayDirtyRun): Promise<boolean>;
    fixtureClaimSend(): Promise<RawJson>;
    fixtureAcknowledge(cookie?: string): Promise<boolean>;
    fixtureInspect(): Promise<StoredSnapshotState>;
}

interface CdbFixtureRpc {
    fixtureDrain(): Promise<void>;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const operation = url.pathname.slice(1);
        if (url.pathname === "/snapshot-cdb-drain") {
            const shardId = url.searchParams.get("shardId");
            if (!shardId) return new Response("missing shardId", { status: 400 });
            const cdb = env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as CdbFixtureRpc;
            await cdb.fixtureDrain();
            return Response.json({ ok: true });
        }
        if (url.pathname === "/snapshot-gateway-drain-at") {
            const clientId = url.searchParams.get("clientId");
            const nowMs = Number(url.searchParams.get("nowMs"));
            if (!clientId || !Number.isSafeInteger(nowMs) || nowMs < 0) {
                return new Response("invalid drain target", { status: 400 });
            }
            const gateway = env.CDB_GATEWAY.get(
                env.CDB_GATEWAY.idFromName(clientId.slice(0, 12))
            ) as unknown as GatewayFixtureRpc;
            await gateway.fixtureDrainAt(nowMs);
            return Response.json({ ok: true });
        }
        if (url.pathname === "/snapshot-delivery-state") {
            const clientId = url.searchParams.get("clientId");
            const subId = Number(url.searchParams.get("subId"));
            if (!clientId || !Number.isSafeInteger(subId) || subId < 0) {
                return new Response("invalid delivery identity", { status: 400 });
            }
            const gateway = env.CDB_GATEWAY.get(
                env.CDB_GATEWAY.idFromName(clientId.slice(0, 12))
            ) as unknown as GatewayFixtureRpc;
            return Response.json(await gateway.fixtureDeliveryState(clientId, subId));
        }
        if (!new Set(["install", "dirty", "claim", "stage", "claim-send", "ack", "inspect"]).has(operation)) {
            return baseWorker.fetch(request, env);
        }
        const gateway = env.CDB_GATEWAY.get(
            env.CDB_GATEWAY.idFromName("snapshot-delivery-proof")
        ) as unknown as GatewayFixtureRpc;
        const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
        switch (operation) {
            case "install":
                return Response.json(await gateway.fixtureInstall());
            case "dirty":
                return Response.json(await gateway.fixtureDirty(Number(body.dirtyVersion)));
            case "claim":
                return Response.json(
                    await gateway.fixtureClaim(body.nowMs === undefined ? undefined : Number(body.nowMs))
                );
            case "stage":
                return Response.json(await gateway.fixtureStage(body.run as unknown as GatewayDirtyRun));
            case "claim-send":
                return Response.json(await gateway.fixtureClaimSend());
            case "ack":
                return Response.json(
                    await gateway.fixtureAcknowledge(body.cookie === undefined ? undefined : String(body.cookie))
                );
            case "inspect":
                return Response.json(await gateway.fixtureInspect());
            default:
                return new Response("not found", { status: 404 });
        }
    },
};
