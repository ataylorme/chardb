import { CdbError, rehydrateCdbRpcError } from "../errors.ts";
import { adminJsonError, authorizeAdmin } from "./admin-http.ts";
import type { CatalogOrganizationDeletionStatus } from "./do/catalog.ts";

export interface OrganizationDeletionAdminEnv {
    readonly CDB_ADMIN_TOKEN?: string;
    readonly CDB_CATALOG: DurableObjectNamespace;
}

interface CatalogOrganizationDeletionStatusRpc {
    organizationDeletionPurgeStatus(input: {
        readonly organizationId: string;
    }): Promise<CatalogOrganizationDeletionStatus>;
}

function organizationId(value: string | undefined): string {
    if (!value || new TextEncoder().encode(value).byteLength > 256) {
        throw new TypeError("organization deletion status requires one bounded organizationId");
    }
    return value;
}

function statusError(error: unknown): Response {
    const projected = rehydrateCdbRpcError(error);
    if (projected instanceof TypeError || projected instanceof SyntaxError) {
        return adminJsonError(400, projected.message);
    }
    if (projected instanceof CdbError) {
        const status =
            projected.code === "CDB_INVALID_ARGS"
                ? 400
                : projected.code === "CDB_STALE_EPOCH"
                  ? 409
                  : projected.code === "CDB_SHARD_UNAVAILABLE"
                    ? 503
                    : 500;
        return adminJsonError(status, projected.message);
    }
    throw projected;
}

/** Private token-protected deletion status. Physical owner selection remains Catalog-owned. */
export async function handleOrganizationDeletionAdminRequest(
    request: Request,
    env: OrganizationDeletionAdminEnv
): Promise<Response> {
    const denied = await authorizeAdmin(request, env);
    if (denied) return denied;
    try {
        if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
        const url = new URL(request.url);
        if (url.pathname !== "/_chardb/organizations/deletion/status")
            return new Response("not found", { status: 404 });
        const values = url.searchParams.getAll("organizationId");
        if (values.length !== 1 || [...url.searchParams.keys()].some(key => key !== "organizationId")) {
            throw new TypeError("organization deletion status requires exactly one organizationId");
        }
        const catalog = env.CDB_CATALOG.get(
            env.CDB_CATALOG.idFromName("global")
        ) as unknown as CatalogOrganizationDeletionStatusRpc;
        return Response.json({
            ok: true,
            state: await catalog.organizationDeletionPurgeStatus({ organizationId: organizationId(values[0]) }),
        });
    } catch (error) {
        return statusError(error);
    }
}
