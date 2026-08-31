import type { RawJson } from "../../types.ts";
import { ClientId, Cookie, PrincipalId, SubId } from "../../types.ts";
import { vshardOf } from "../../vshard.ts";
import type { QueryRouteResponse } from "../manifest.ts";
import type {
    CatalogOrganizationAuthorityRouteRpc,
    CatalogOrganizationAuthorityRpc,
    CatalogRoutingRpc,
    CatalogUserAuthorityRpc,
    CdbRegisteredQueryRpc,
} from "../rpc.ts";
import {
    isTerminalRegisteredQueryFailure,
    projectCdbQueryRows,
    resolvePartitionAuthRoute,
} from "./gateway-auth-dispatch.ts";
import { checkGatewayAuthorityFreshness } from "./gateway-authority-freshness.ts";
import {
    GATEWAY_AUTH_REFRESH_PENDING_ERROR,
    GATEWAY_QUERY_BATCH_SIZE,
    GATEWAY_QUERY_LEASE_MS,
    type GatewayDirtyRun,
    type GatewayRegistrationKey,
    type GatewaySnapshotStage,
    type StoredGatewayRunCandidate,
    claimDirtyGatewayRegistration,
    deferGatewayDirtyRun,
    failGatewayDirtyRun,
    retireClaimedGatewayRegistration,
    retireGatewayRegistration,
} from "./gateway-registration-store.ts";
import type {
    GatewayExactSnapshotSocket,
    GatewaySnapshotRetirement,
    GatewaySnapshotStorage,
} from "./gateway-snapshot-delivery.ts";

type GatewayAuthorityCatalog = CatalogRoutingRpc &
    CatalogOrganizationAuthorityRpc &
    Partial<CatalogOrganizationAuthorityRouteRpc & CatalogUserAuthorityRpc>;

export interface GatewaySnapshotMaterializerDeps {
    readonly storage: GatewaySnapshotStorage;
    readonly shardNamespace: DurableObjectNamespace;
    readonly gatewayId: string;
    readonly nowMs: () => number;
    readonly scheduleAlarm: (requestedAt: number) => Promise<void>;
    readonly scheduleWork: (nowMs: number) => Promise<void>;
    readonly currentPolicyDigest: (intentJson: string) => string | null;
    readonly routeQuery: (request: { readonly ref: string; readonly args: RawJson }) => Promise<QueryRouteResponse>;
    readonly catalog: () => GatewayAuthorityCatalog;
    readonly exactSocket: (
        identity: GatewayRegistrationKey & { readonly connectionId: string },
        nowMs: number
    ) => GatewayExactSnapshotSocket;
    readonly settleRetired: (
        identity: GatewayRegistrationKey & { readonly connectionId: string },
        settlement: GatewaySnapshotRetirement
    ) => void;
    readonly stageSnapshot: (input: GatewaySnapshotStage) => Promise<boolean>;
}

export class GatewaySnapshotMaterializer {
    constructor(private readonly deps: GatewaySnapshotMaterializerDeps) {}

    dueCandidates(
        nowMs: number,
        connectionId?: string,
        excludedConnectionIds: readonly string[] = []
    ): readonly StoredGatewayRunCandidate[] {
        if (connectionId !== undefined && connectionId.length === 0) {
            throw new TypeError("connectionId must be nonempty");
        }
        if (excludedConnectionIds.some(excludedConnectionId => excludedConnectionId.length === 0)) {
            throw new TypeError("excluded connection IDs must be nonempty");
        }
        const connectionFilter = connectionId === undefined ? "" : "AND g.connection_id = ?";
        const uniqueExcludedConnectionIds = [...new Set(excludedConnectionIds)];
        const exclusionFilter =
            uniqueExcludedConnectionIds.length === 0
                ? ""
                : `AND g.connection_id NOT IN (${uniqueExcludedConnectionIds.map(() => "?").join(", ")})`;
        return this.deps.storage.sql.all<StoredGatewayRunCandidate>(
            `SELECT g.principal_id, g.client_id, g.sub_id, g.registration_id, g.connection_id
             FROM _gw_registration_generations g
             INNER JOIN _gw_registration_heads h
               ON h.registration_id = g.registration_id
              AND h.principal_id = g.principal_id
              AND h.client_id = g.client_id
              AND h.sub_id = g.sub_id
             WHERE g.lifecycle = 'active' AND g.cdb_state = 'active'
               AND g.source_cdb_id IS NOT NULL AND g.source_cdb_id <> ''
               ${connectionFilter}
               ${exclusionFilter}
               AND (g.initial_snapshot_pending = 1 OR g.dirty_version > g.delivered_version)
               AND (g.retry_at IS NULL OR g.retry_at <= ?)
               AND NOT EXISTS (
                 SELECT 1 FROM _gw_snapshot_outbox o WHERE o.registration_id = g.registration_id
               )
               AND (
                 (g.run_token IS NULL AND g.run_target_version IS NULL AND g.run_lease_expires_at IS NULL)
                 OR
                 (g.run_token IS NOT NULL AND g.run_target_version IS NOT NULL
                  AND g.run_lease_expires_at IS NOT NULL AND g.run_lease_expires_at <= ?)
               )
             ORDER BY COALESCE(g.retry_at, 0), g.registration_id
            LIMIT ?`,
            ...(connectionId === undefined ? [] : [connectionId]),
            ...uniqueExcludedConnectionIds,
            nowMs,
            nowMs,
            GATEWAY_QUERY_BATCH_SIZE
        );
    }

    async runCandidate(candidate: StoredGatewayRunCandidate, nowMs: number): Promise<void> {
        const identity = {
            principalId: PrincipalId(candidate.principal_id),
            clientId: ClientId(candidate.client_id),
            subId: SubId(candidate.sub_id),
            registrationId: candidate.registration_id,
            connectionId: candidate.connection_id,
        };
        const initialSocket = this.deps.exactSocket(identity, nowMs);
        if (initialSocket.status === "refreshing") {
            await this.deferForAuthRefresh(identity, nowMs, initialSocket.retryAt);
            return;
        }
        if (initialSocket.status === "terminal") {
            if (this.retireRegistration(identity, nowMs)) {
                await this.deps.scheduleWork(nowMs).catch(() => {});
            }
            return;
        }
        await this.deps.scheduleAlarm(nowMs + GATEWAY_QUERY_LEASE_MS);
        const claimNowMs = this.deps.nowMs();
        const claimSocket = this.deps.exactSocket(identity, claimNowMs);
        if (claimSocket.status === "refreshing") {
            await this.deferForAuthRefresh(identity, claimNowMs, claimSocket.retryAt);
            return;
        }
        if (claimSocket.status === "terminal") {
            if (this.retireRegistration(identity, claimNowMs)) {
                await this.deps.scheduleWork(claimNowMs).catch(() => {});
            }
            return;
        }
        const run = this.deps.storage.transactionSync(() =>
            claimDirtyGatewayRegistration(this.deps.storage.sql, {
                ...identity,
                nowMs: claimNowMs,
                leaseExpiresAt: claimNowMs + GATEWAY_QUERY_LEASE_MS,
            })
        );
        if (!run) return;

        try {
            const rerouted = await this.deps.routeQuery({ ref: run.ref, args: run.args });
            if (
                !rerouted.ok ||
                (rerouted.authority !== "organization" &&
                    rerouted.authority !== "user" &&
                    rerouted.authority !== "global") ||
                rerouted.partitionKey !== run.organizationId
            ) {
                await this.retireWithSettlement(identity, run, { kind: "error", code: "CDB_INVARIANT" });
                return;
            }
            const catalog = this.deps.catalog();
            const projected = await resolvePartitionAuthRoute(
                catalog,
                rerouted.authority,
                identity.principalId,
                run.organizationId,
                Number(vshardOf([run.organizationId]))
            );
            if (!projected.ok) {
                if (projected.code === "CDB_FORBIDDEN") {
                    await this.retireWithSettlement(identity, run, { kind: "error", code: projected.code });
                } else {
                    await this.settleFailure(candidate, run, this.deps.nowMs(), projected.message);
                }
                return;
            }

            const route = projected.route;
            const vshard = Number(vshardOf([run.organizationId]));
            const routedPhysicalId = this.deps.shardNamespace.idFromName(route.shardId).toString();
            if (
                routedPhysicalId !== run.sourceCdbId ||
                route.schemaEpoch !== run.schemaEpoch ||
                route.domainSchemaEpoch !== run.domainSchemaEpoch
            ) {
                await this.retireWithSettlement(identity, run, { kind: "refetch", reason: "shardsChanged" });
                return;
            }
            const sourceId = this.deps.shardNamespace.idFromString(run.sourceCdbId);
            const cdb = this.deps.shardNamespace.get(sourceId) as unknown as CdbRegisteredQueryRpc;
            const response = projectCdbQueryRows(
                await cdb.queryRegistered({
                    subscription: {
                        gatewayId: this.deps.gatewayId,
                        registrationId: identity.registrationId,
                        connectionId: identity.connectionId,
                        clientId: identity.clientId,
                        subId: identity.subId,
                    },
                    placement: { authority: rerouted.authority, partitionKey: run.organizationId },
                    auth: projected.auth,
                    schemaEpoch: route.schemaEpoch,
                    vshard,
                    domainSchemaEpoch: route.domainSchemaEpoch,
                })
            );
            if (!response.ok) {
                if (response.error.code === "CDB_STALE_EPOCH") {
                    const freshness = await checkGatewayAuthorityFreshness(this.deps, {
                        principalId: identity.principalId,
                        organizationId: run.organizationId,
                        ref: run.ref,
                        args: run.args,
                        policyDigest: rerouted.policyDigest,
                        queryHash: rerouted.queryHash,
                        shardId: route.shardId,
                        sourceCdbId: run.sourceCdbId,
                        schemaEpoch: route.schemaEpoch,
                        domainSchemaEpoch: route.domainSchemaEpoch,
                        authEpochs: projected.auth.authEpochs ?? { global: 0, tenant: 0, principal: 0 },
                    });
                    if (freshness.kind === "refetch") {
                        await this.retireWithSettlement(identity, run, { kind: "refetch", reason: "shardsChanged" });
                    } else if (freshness.kind === "retire") {
                        await this.retireWithSettlement(identity, run, { kind: "error", code: freshness.code });
                    } else {
                        await this.settleFailure(
                            candidate,
                            run,
                            this.deps.nowMs(),
                            freshness.kind === "retry"
                                ? freshness.message
                                : freshness.kind === "changed"
                                  ? "authorization changed while awaiting the Catalog schema epoch"
                                  : "Cdb schema epoch is ahead of Catalog routing"
                        );
                    }
                    return;
                }
                if (isTerminalRegisteredQueryFailure(response.error.code)) {
                    await this.retireWithSettlement(identity, run, {
                        kind: "error",
                        code: response.error.code,
                    });
                } else {
                    await this.settleFailure(candidate, run, this.deps.nowMs(), response.error.message);
                }
                return;
            }

            const freshness = await checkGatewayAuthorityFreshness(this.deps, {
                principalId: identity.principalId,
                organizationId: run.organizationId,
                ref: run.ref,
                args: run.args,
                policyDigest: rerouted.policyDigest,
                queryHash: rerouted.queryHash,
                shardId: route.shardId,
                sourceCdbId: run.sourceCdbId,
                schemaEpoch: route.schemaEpoch,
                domainSchemaEpoch: route.domainSchemaEpoch,
                authEpochs: projected.auth.authEpochs ?? { global: 0, tenant: 0, principal: 0 },
            });
            if (freshness.kind === "retry" || freshness.kind === "changed") {
                await this.settleFailure(
                    candidate,
                    run,
                    this.deps.nowMs(),
                    freshness.kind === "retry" ? freshness.message : "authorization changed while querying"
                );
                return;
            }
            if (freshness.kind === "refetch") {
                await this.retireWithSettlement(identity, run, { kind: "refetch", reason: "shardsChanged" });
                return;
            }
            if (freshness.kind === "retire") {
                await this.retireWithSettlement(identity, run, { kind: "error", code: freshness.code });
                return;
            }

            const currentPolicyDigest = this.deps.currentPolicyDigest(run.intentJson);
            if (currentPolicyDigest !== null && currentPolicyDigest !== run.policyDigest) {
                await this.retireWithSettlement(identity, run, { kind: "error", code: "CDB_INVARIANT" });
                return;
            }

            const settledAt = this.deps.nowMs();
            const currentSocket = this.deps.exactSocket(identity, settledAt);
            if (currentSocket.status === "refreshing") {
                await this.settleFailure(
                    candidate,
                    run,
                    settledAt,
                    GATEWAY_AUTH_REFRESH_PENDING_ERROR,
                    currentSocket.retryAt
                );
                return;
            }
            if (currentSocket.status === "terminal") {
                if (this.retireRegistration(identity, settledAt, run)) {
                    await this.deps.scheduleWork(settledAt).catch(() => {});
                }
                return;
            }
            const authEpochs = freshness.auth.authEpochs;
            if (!authEpochs) {
                await this.settleFailure(candidate, run, settledAt, "Catalog authority omitted auth epochs");
                return;
            }
            await this.deps.stageSnapshot({
                ...identity,
                runToken: run.runToken,
                runVersion: run.runVersion,
                targetVersion: run.targetVersion,
                cookie: Cookie(`${identity.clientId}:${run.targetVersion}:${crypto.randomUUID()}`),
                rows: response.result,
                authEpochs,
                nowMs: settledAt,
            });
        } catch (error) {
            await this.settleFailure(candidate, run, this.deps.nowMs(), error);
        }
    }

    private retireRegistration(
        identity: GatewayRegistrationKey & { readonly registrationId: string; readonly connectionId: string },
        nowMs: number,
        run?: GatewayDirtyRun
    ): boolean {
        return this.deps.storage.transactionSync(() =>
            run
                ? retireClaimedGatewayRegistration(this.deps.storage.sql, {
                      ...identity,
                      runToken: run.runToken,
                      runVersion: run.runVersion,
                      nowMs,
                  })
                : retireGatewayRegistration(this.deps.storage.sql, identity, identity.registrationId, nowMs)
        );
    }

    private async retireWithSettlement(
        identity: GatewayRegistrationKey & { readonly registrationId: string; readonly connectionId: string },
        run: GatewayDirtyRun,
        settlement: GatewaySnapshotRetirement
    ): Promise<void> {
        const retiredAt = this.deps.nowMs();
        if (!this.retireRegistration(identity, retiredAt, run)) return;
        this.deps.settleRetired(identity, settlement);
        await this.deps.scheduleWork(retiredAt).catch(() => {});
    }

    private async settleFailure(
        candidate: StoredGatewayRunCandidate,
        run: GatewayDirtyRun,
        nowMs: number,
        error: unknown,
        retryNotBeforeMs?: number
    ): Promise<void> {
        this.deps.storage.transactionSync(() => {
            failGatewayDirtyRun(this.deps.storage.sql, {
                principalId: PrincipalId(candidate.principal_id),
                clientId: ClientId(candidate.client_id),
                subId: SubId(candidate.sub_id),
                registrationId: candidate.registration_id,
                connectionId: candidate.connection_id,
                runToken: run.runToken,
                runVersion: run.runVersion,
                nowMs,
                ...(retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs }),
                error,
            });
        });
        await this.deps.scheduleWork(nowMs);
    }

    private async deferForAuthRefresh(
        identity: GatewayRegistrationKey & { readonly registrationId: string; readonly connectionId: string },
        nowMs: number,
        retryAt: number
    ): Promise<void> {
        const deferred = this.deps.storage.transactionSync(() =>
            deferGatewayDirtyRun(this.deps.storage.sql, { ...identity, nowMs, retryAt })
        );
        if (deferred) await this.deps.scheduleWork(nowMs);
    }
}
