import { CdbError, isCdbError, rehydrateCdbRpcError } from "../errors.ts";
import type { PrincipalId, TenantId } from "../types.ts";
import { PrincipalId as PrincipalIdValue, TenantId as TenantIdValue } from "../types.ts";
import { vshardOf } from "../vshard.ts";
import type { AuthCtx } from "./define.ts";
import type { RouteResult } from "./do/catalog.ts";
import {
    type CdbValidatedVectorMatch,
    type CdbVectorizeMatch,
    type CdbVectorizeSearchIndex,
    queryCdbVectorizeCandidates,
} from "./do/cdb-vectorize-adapter.ts";
import { projectOrganizationMutationAuth } from "./do/gateway-auth-dispatch.ts";
import { type VectorResourceV1, cdbVectorResourceId } from "./resource-descriptors.ts";
import type { CatalogOrganizationAuthorityRouteRpc } from "./rpc.ts";

export interface OrganizationVectorSearchSession {
    readonly principalId: PrincipalId;
    readonly activeOrganizationId: TenantId;
}

export interface OrganizationVectorSearchLocator {
    readonly organizationId: string;
    readonly table: string;
    readonly column: string;
}

export type OrganizationVectorSearchDispatchFailure = {
    readonly ok: false;
    readonly status: 401 | 404 | 500 | 503;
    readonly code: "UNAUTHENTICATED" | "NOT_FOUND" | "MISSING_BINDING" | "CATALOG_UNAVAILABLE";
};

export interface OrganizationVectorSearchValidation {
    readonly auth: AuthCtx;
    readonly route: RouteResult;
    readonly resource: VectorResourceV1;
    readonly resourceId: string;
    readonly organizationId: string;
    readonly matches: readonly CdbVectorizeMatch[];
    readonly limit: number;
}

function ownEnumerableData(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}

function projectCatalogRoute(value: unknown): RouteResult | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const keys = Object.keys(value).sort();
    const currentKeys = ["domainSchemaEpoch", "recoveryGeneration", "schemaEpoch", "shardId"].sort();
    if (JSON.stringify(keys) !== JSON.stringify(currentKeys)) {
        return undefined;
    }
    const shardId = ownEnumerableData(value, "shardId");
    const schemaEpoch = ownEnumerableData(value, "schemaEpoch");
    const domainSchemaEpoch = ownEnumerableData(value, "domainSchemaEpoch");
    const recoveryGeneration = ownEnumerableData(value, "recoveryGeneration");
    if (
        typeof shardId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(shardId) ||
        !Number.isSafeInteger(schemaEpoch) ||
        (schemaEpoch as number) < 0 ||
        !Number.isSafeInteger(domainSchemaEpoch) ||
        (domainSchemaEpoch as number) < 1 ||
        !Number.isSafeInteger(recoveryGeneration) ||
        (recoveryGeneration as number) < 0
    ) {
        return undefined;
    }
    return {
        shardId: shardId as RouteResult["shardId"],
        schemaEpoch: schemaEpoch as number,
        domainSchemaEpoch: domainSchemaEpoch as number,
        recoveryGeneration: recoveryGeneration as number,
    };
}

function sameCatalogRoute(left: RouteResult, right: RouteResult): boolean {
    return (
        left.shardId === right.shardId &&
        left.schemaEpoch === right.schemaEpoch &&
        left.recoveryGeneration === right.recoveryGeneration &&
        left.domainSchemaEpoch === right.domainSchemaEpoch
    );
}

function projectSession(value: unknown): OrganizationVectorSearchSession | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const user = ownEnumerableData(value, "user");
    const session = ownEnumerableData(value, "session");
    if (
        typeof user !== "object" ||
        user === null ||
        Array.isArray(user) ||
        typeof session !== "object" ||
        session === null ||
        Array.isArray(session)
    ) {
        return undefined;
    }
    const principalId = ownEnumerableData(user, "id");
    const activeOrganizationId = ownEnumerableData(session, "activeOrganizationId");
    if (
        typeof principalId !== "string" ||
        principalId.length === 0 ||
        typeof activeOrganizationId !== "string" ||
        activeOrganizationId.length === 0
    ) {
        return undefined;
    }
    return {
        principalId: PrincipalIdValue(principalId),
        activeOrganizationId: TenantIdValue(activeOrganizationId),
    };
}

function notFound(): OrganizationVectorSearchDispatchFailure {
    return { ok: false, status: 404, code: "NOT_FOUND" };
}

/**
 * Private Better Auth and Catalog boundary for one organization vector search.
 * It refreshes authority again after the external query, so revocation wins
 * before any match can leave the Worker.
 */
export async function dispatchOrganizationVectorSearch(input: {
    readonly session: unknown;
    readonly locator: OrganizationVectorSearchLocator;
    readonly resources: readonly VectorResourceV1[];
    readonly values: readonly number[];
    readonly limit: number;
    readonly catalog: CatalogOrganizationAuthorityRouteRpc;
    readonly indexes: Readonly<Record<string, CdbVectorizeSearchIndex | undefined>>;
    readonly validate: (input: OrganizationVectorSearchValidation) => Promise<readonly CdbValidatedVectorMatch[]>;
}): Promise<
    { readonly ok: true; readonly value: readonly CdbValidatedVectorMatch[] } | OrganizationVectorSearchDispatchFailure
> {
    const session = projectSession(input.session);
    if (!session) return { ok: false, status: 401, code: "UNAUTHENTICATED" };
    if (input.locator.organizationId !== session.activeOrganizationId) return notFound();
    const resource = input.resources.find(
        candidate => candidate.table === input.locator.table && candidate.column === input.locator.column
    );
    if (!resource) return notFound();
    const binding = Object.getOwnPropertyDescriptor(input.indexes, resource.binding);
    const index = binding && "value" in binding ? binding.value : undefined;
    if (!index || typeof index.query !== "function") {
        return { ok: false, status: 500, code: "MISSING_BINDING" };
    }

    const refresh = async (): Promise<
        | { readonly ok: true; readonly auth: AuthCtx; readonly route: RouteResult }
        | { readonly ok: false; readonly forbidden: boolean }
    > => {
        try {
            const resolved = await input.catalog.resolveOrganizationAuthorityRoute({
                principalId: session.principalId,
                organizationId: session.activeOrganizationId,
                vshard: Number(vshardOf([session.activeOrganizationId])),
            });
            if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
                return { ok: false, forbidden: false };
            }
            const projected = projectOrganizationMutationAuth(ownEnumerableData(resolved, "authority"), {
                principalId: session.principalId,
                organizationId: session.activeOrganizationId,
            });
            if (!projected.ok) return { ok: false, forbidden: projected.code === "CDB_FORBIDDEN" };
            const route = projectCatalogRoute(ownEnumerableData(resolved, "route"));
            if (!route) return { ok: false, forbidden: false };
            if (projected.recoveryGeneration !== route.recoveryGeneration) {
                return { ok: false, forbidden: false };
            }
            return { ok: true, auth: projected.auth, route };
        } catch {
            return { ok: false, forbidden: false };
        }
    };

    let admitted = await refresh();
    if (!admitted.ok) {
        return admitted.forbidden ? notFound() : { ok: false, status: 503, code: "CATALOG_UNAVAILABLE" };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const matches = await queryCdbVectorizeCandidates({
            index,
            resource,
            organizationId: input.locator.organizationId,
            values: input.values,
            limit: input.limit,
        });
        const current = await refresh();
        if (!current.ok) {
            return current.forbidden ? notFound() : { ok: false, status: 503, code: "CATALOG_UNAVAILABLE" };
        }
        if (!sameCatalogRoute(admitted.route, current.route)) {
            if (attempt === 0) {
                admitted = current;
                continue;
            }
            throw new CdbError({ code: "CDB_STALE_EPOCH", message: "vector route changed during search" });
        }
        try {
            return {
                ok: true,
                value: await input.validate({
                    auth: current.auth,
                    route: current.route,
                    resource,
                    resourceId: cdbVectorResourceId(resource),
                    organizationId: input.locator.organizationId,
                    matches,
                    limit: input.limit,
                }),
            };
        } catch (error) {
            const normalized = rehydrateCdbRpcError(error);
            if (isCdbError(normalized)) throw normalized;
            throw new CdbError({
                code: "CDB_SHARD_UNAVAILABLE",
                message: "vector search candidate validation failed",
                cause: normalized,
            });
        }
    }
    throw new CdbError({ code: "CDB_STALE_EPOCH", message: "vector route did not stabilize" });
}
