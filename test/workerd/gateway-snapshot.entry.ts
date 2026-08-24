import {
    type GatewayDirtyRun,
    type GatewayRegistrationInstall,
    Gateway as ProductionGateway,
    acknowledgeGatewaySnapshot,
    claimDirtyGatewayRegistration,
    claimDueGatewaySnapshot,
    installGatewayRegistration,
    stageGatewaySnapshot,
} from "../../src/server/do/gateway.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { ChardbRef, ClientId, Cookie, PrincipalId, type RawJson, SubId, TenantId } from "../../src/types.ts";

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

export class Gateway extends ProductionGateway {
    private readonly fixtureInstanceId = crypto.randomUUID();

    // Production bootstrap schedules overdue snapshot work against wall-clock
    // time. This durability fixture claims and acknowledges explicitly, so keep
    // the alarm from racing those deterministic transitions after reconstruction.
    override async alarm(): Promise<void> {}

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
            instanceId: this.fixtureInstanceId,
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
    readonly GATEWAY: DurableObjectNamespace;
}

interface GatewayFixtureRpc {
    fixtureInstall(): Promise<boolean>;
    fixtureDirty(dirtyVersion: number): Promise<boolean>;
    fixtureClaim(nowMs?: number): Promise<GatewayDirtyRun | null>;
    fixtureStage(run: GatewayDirtyRun): Promise<boolean>;
    fixtureClaimSend(): Promise<RawJson>;
    fixtureAcknowledge(cookie?: string): Promise<boolean>;
    fixtureInspect(): Promise<StoredSnapshotState>;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const operation = new URL(request.url).pathname.slice(1);
        const gateway = env.GATEWAY.get(
            env.GATEWAY.idFromName("snapshot-delivery-proof")
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
