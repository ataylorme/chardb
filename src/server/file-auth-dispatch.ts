import { CdbError } from "../errors.ts";
import type { PrincipalId, TenantId } from "../types.ts";
import { PrincipalId as PrincipalIdValue, TenantId as TenantIdValue } from "../types.ts";
import { vshardOf } from "../vshard.ts";
import type { AuthCtx } from "./define.ts";
import type { RouteResult } from "./do/catalog.ts";
import { isCatalogRouteResult, projectOrganizationMutationAuth } from "./do/gateway-auth-dispatch.ts";
import type { ChardbFileResourceDescriptor } from "./resource-descriptors.ts";
import type { CatalogOrganizationAuthorityRouteRpc, CatalogOrganizationAuthorityRpc } from "./rpc.ts";

export interface OrganizationFileSession {
    readonly principalId: PrincipalId;
    readonly activeOrganizationId: TenantId;
}

export interface OrganizationFileLocator {
    readonly organizationId: string;
    readonly table: string;
    readonly column: string;
}

export type OrganizationFileDispatchFailure = {
    readonly ok: false;
    readonly status: 401 | 404 | 500 | 503;
    readonly code: "UNAUTHENTICATED" | "NOT_FOUND" | "MISSING_BINDING" | "CATALOG_UNAVAILABLE";
};

export interface OrganizationFileDispatchContext {
    readonly session: OrganizationFileSession;
    readonly auth: AuthCtx;
    readonly resource: ChardbFileResourceDescriptor;
    readonly bucket: R2Bucket;
    /** Present when Catalog can resolve authority and placement in one turn. */
    readonly route?: RouteResult;
    /** Required after any external write and before a Cdb state transition. */
    readonly refreshAuthority: () => Promise<AuthCtx>;
    /** Resolve current authority and placement so a stale file RPC can retry once on the new owner. */
    readonly refreshAuthorityRoute: () => Promise<{ readonly auth: AuthCtx; readonly route?: RouteResult }>;
}

function ownEnumerableData(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}

function projectSession(value: unknown): OrganizationFileSession | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const user = record.user;
    const session = record.session;
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
    const principalId = (user as Record<string, unknown>).id;
    const activeOrganizationId = (session as Record<string, unknown>).activeOrganizationId;
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

function notFound(): OrganizationFileDispatchFailure {
    return { ok: false, status: 404, code: "NOT_FOUND" };
}

/**
 * The single private dispatcher for organization file operations. It accepts a
 * Better Auth session projection, requires the requested active organization,
 * resolves fresh Catalog membership, and only then exposes the R2 binding.
 */
export async function dispatchOrganizationFileOperation<TResult>(input: {
    readonly session: unknown;
    readonly locator: OrganizationFileLocator;
    readonly resources: readonly ChardbFileResourceDescriptor[];
    readonly catalog: CatalogOrganizationAuthorityRpc & Partial<CatalogOrganizationAuthorityRouteRpc>;
    readonly bucket: R2Bucket | undefined;
    readonly operation: (context: OrganizationFileDispatchContext) => Promise<TResult>;
}): Promise<{ readonly ok: true; readonly value: TResult } | OrganizationFileDispatchFailure> {
    const session = projectSession(input.session);
    if (!session) return { ok: false, status: 401, code: "UNAUTHENTICATED" };
    if (input.locator.organizationId !== session.activeOrganizationId) return notFound();
    const resource = input.resources.find(
        candidate => candidate.table === input.locator.table && candidate.column === input.locator.column
    );
    if (!resource) return notFound();
    if (!input.bucket) return { ok: false, status: 500, code: "MISSING_BINDING" };

    const refresh = async (): Promise<
        | { readonly ok: true; readonly auth: AuthCtx; readonly route?: RouteResult }
        | Extract<ReturnType<typeof projectOrganizationMutationAuth>, { readonly ok: false }>
    > => {
        try {
            if (input.catalog.resolveOrganizationAuthorityRoute) {
                const resolved = await input.catalog.resolveOrganizationAuthorityRoute({
                    principalId: session.principalId,
                    organizationId: session.activeOrganizationId,
                    vshard: Number(vshardOf([session.activeOrganizationId])),
                });
                const projected = projectOrganizationMutationAuth(ownEnumerableData(resolved, "authority"), {
                    principalId: session.principalId,
                    organizationId: session.activeOrganizationId,
                });
                if (!projected.ok) return projected;
                const route = ownEnumerableData(resolved, "route");
                if (!isCatalogRouteResult(route)) {
                    return { ok: false, code: "CDB_CATALOG_UNAVAILABLE", message: "Catalog route is unavailable" };
                }
                if (projected.recoveryGeneration !== route.recoveryGeneration) {
                    return {
                        ok: false,
                        code: "CDB_STALE_EPOCH",
                        message: "Catalog authority and route generations differ",
                    };
                }
                return { ok: true, auth: projected.auth, route };
            }
            return projectOrganizationMutationAuth(
                await input.catalog.resolveOrganizationAuthority({
                    principalId: session.principalId,
                    organizationId: session.activeOrganizationId,
                }),
                { principalId: session.principalId, organizationId: session.activeOrganizationId }
            );
        } catch {
            return { ok: false, code: "CDB_CATALOG_UNAVAILABLE", message: "Catalog authority refresh failed" };
        }
    };
    const projected = await refresh();
    if (!projected.ok) {
        return projected.code === "CDB_FORBIDDEN"
            ? notFound()
            : { ok: false, status: 503, code: "CATALOG_UNAVAILABLE" };
    }
    const refreshAuthorityRoute = async (): Promise<{ readonly auth: AuthCtx; readonly route?: RouteResult }> => {
        const refreshed = await refresh();
        if (refreshed.ok) {
            return {
                auth: refreshed.auth,
                ...(refreshed.route ? { route: refreshed.route } : {}),
            };
        }
        throw new CdbError({ code: refreshed.code, message: refreshed.message });
    };
    return {
        ok: true,
        value: await input.operation({
            session,
            auth: projected.auth,
            resource,
            bucket: input.bucket,
            ...(projected.route ? { route: projected.route } : {}),
            refreshAuthority: async () => {
                const refreshed = await refreshAuthorityRoute();
                if (
                    projected.route &&
                    (!refreshed.route ||
                        refreshed.route.shardId !== projected.route.shardId ||
                        refreshed.route.schemaEpoch !== projected.route.schemaEpoch ||
                        refreshed.route.recoveryGeneration !== projected.route.recoveryGeneration ||
                        refreshed.route.domainSchemaEpoch !== projected.route.domainSchemaEpoch)
                ) {
                    throw new CdbError({
                        code: "CDB_STALE_EPOCH",
                        message: "file placement changed during upload",
                    });
                }
                return refreshed.auth;
            },
            refreshAuthorityRoute,
        }),
    };
}
