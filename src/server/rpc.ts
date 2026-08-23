import type { CdbError } from "../errors.ts";
import type { RawJson, ShardId } from "../types.ts";
import type { AuthCtx } from "./define.ts";
import type { RouteResult } from "./do/catalog.ts";

/** Structured-cloneable error envelope shared by every mutation RPC hop. */
export type CdbErrorWire = ReturnType<CdbError["toJSON"]>;

/** Local Gateway input for resolving a ref and its partition key. */
export interface MutationRouteRequest {
    readonly ref: string;
    readonly args: RawJson;
}

export type MutationRouteResponse =
    | { readonly ok: true; readonly vshard: number }
    | { readonly ok: false; readonly error: CdbErrorWire };

export type MutationRouteResolver = (request: MutationRouteRequest) => MutationRouteResponse;

/** RPC surface used to map a logical vshard to a physical Cdb DO. */
export interface CatalogMutationRpc {
    route(vshard: number): Promise<RouteResult>;
}

/** Catalog routing surface used by subscription placement. */
export interface CatalogRoutingRpc extends CatalogMutationRpc {
    listShardIds(): Promise<readonly ShardId[]>;
}

export interface CdbMutationRequest {
    readonly principalId: string;
    readonly mutId: string;
    readonly ref: string;
    readonly args: RawJson;
    readonly auth: AuthCtx;
    readonly schemaEpoch: number;
}

export interface CdbMutationSuccess {
    readonly ok: true;
    readonly cookie: string;
    readonly ran: boolean;
    readonly result: RawJson;
    readonly rowsAffected: number;
}

export interface CdbMutationFailure {
    readonly ok: false;
    readonly error: CdbErrorWire;
}

export type CdbMutationResponse = CdbMutationSuccess | CdbMutationFailure;

/** Mutation-only RPC surface exposed by a configured Cdb shard. */
export interface CdbMutationRpc {
    mutate(request: CdbMutationRequest): Promise<CdbMutationResponse> | CdbMutationResponse;
}

/** Auth accepted by dispatch only after a verifier has established it. */
export interface TrustedMutationAuth {
    readonly auth: AuthCtx;
}

export interface TrustedMutationDispatchRequest extends TrustedMutationAuth {
    readonly ref: string;
    readonly mutId: string;
    readonly args: RawJson;
}
