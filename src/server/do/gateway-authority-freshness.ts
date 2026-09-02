import type { ChardbRef, PrincipalId, RawJson, TenantId } from "../../types.ts";
import { vshardOf } from "../../vshard.ts";
import type { AuthCtx } from "../define.ts";
import type { QueryRouteResponse } from "../manifest.ts";
import type {
    CatalogOrganizationAuthorityRouteRpc,
    CatalogOrganizationAuthorityRpc,
    CatalogRoutingRpc,
    CatalogUserAuthorityRpc,
} from "../rpc.ts";
import { resolvePartitionAuthRoute } from "./gateway-auth-dispatch.ts";

type GatewayAuthorityCatalog = CatalogRoutingRpc &
    CatalogOrganizationAuthorityRpc &
    Partial<CatalogOrganizationAuthorityRouteRpc & CatalogUserAuthorityRpc>;

export interface GatewayAuthorityExpectation {
    readonly principalId: PrincipalId;
    readonly organizationId: TenantId;
    readonly ref: ChardbRef;
    readonly args: RawJson;
    readonly policyDigest: string;
    readonly queryHash: string;
    readonly shardId: string;
    readonly sourceCdbId: string;
    readonly schemaEpoch: number;
    readonly recoveryGeneration: number;
    readonly domainSchemaEpoch: number;
    readonly authEpochs: {
        readonly global: number;
        readonly tenant: number;
        readonly principal: number;
    };
}

export interface GatewayAuthorityFreshnessDeps {
    readonly shardNamespace: DurableObjectNamespace;
    readonly routeQuery: (request: { readonly ref: string; readonly args: RawJson }) => Promise<QueryRouteResponse>;
    readonly catalog: () => GatewayAuthorityCatalog;
}

export type GatewayAuthorityFreshness =
    | { readonly kind: "fresh"; readonly auth: AuthCtx }
    | { readonly kind: "changed" }
    | { readonly kind: "refetch" }
    | { readonly kind: "retire"; readonly code: "CDB_FORBIDDEN" | "CDB_INVARIANT" }
    | { readonly kind: "retry"; readonly message: string };

function sameEpochs(
    left: GatewayAuthorityExpectation["authEpochs"],
    right: GatewayAuthorityExpectation["authEpochs"]
): boolean {
    return left.global === right.global && left.tenant === right.tenant && left.principal === right.principal;
}

/** Re-resolve the exact query authority and placement before a snapshot crosses a durable boundary. */
export async function checkGatewayAuthorityFreshness(
    deps: GatewayAuthorityFreshnessDeps,
    expected: GatewayAuthorityExpectation
): Promise<GatewayAuthorityFreshness> {
    let rerouted: QueryRouteResponse;
    try {
        rerouted = await deps.routeQuery({ ref: expected.ref, args: expected.args });
    } catch (error) {
        return { kind: "retry", message: error instanceof Error ? error.message : String(error) };
    }
    if (
        !rerouted.ok ||
        (rerouted.authority !== "organization" && rerouted.authority !== "user" && rerouted.authority !== "global") ||
        rerouted.partitionKey !== expected.organizationId
    ) {
        return { kind: "retire", code: "CDB_INVARIANT" };
    }

    const projected = await resolvePartitionAuthRoute(
        deps.catalog(),
        rerouted.authority,
        expected.principalId,
        expected.organizationId,
        Number(vshardOf([expected.organizationId]))
    );
    if (!projected.ok) {
        return projected.code === "CDB_FORBIDDEN"
            ? { kind: "retire", code: projected.code }
            : { kind: "retry", message: projected.message };
    }
    const physicalId = deps.shardNamespace.idFromName(projected.route.shardId).toString();
    if (
        projected.route.shardId !== expected.shardId ||
        physicalId !== expected.sourceCdbId ||
        projected.route.schemaEpoch !== expected.schemaEpoch ||
        projected.route.recoveryGeneration !== expected.recoveryGeneration ||
        projected.route.domainSchemaEpoch !== expected.domainSchemaEpoch
    ) {
        return { kind: "refetch" };
    }
    if (rerouted.policyDigest !== expected.policyDigest || rerouted.queryHash !== expected.queryHash) {
        return { kind: "changed" };
    }
    const authEpochs = projected.auth.authEpochs;
    if (!authEpochs) return { kind: "retry", message: "Catalog authority omitted auth epochs" };
    return sameEpochs(authEpochs, expected.authEpochs) ? { kind: "fresh", auth: projected.auth } : { kind: "changed" };
}
