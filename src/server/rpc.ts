import type { CdbError } from "../errors.ts";
import type { ChardbRef, ClientId, PrincipalId, RawJson, ShardId, SubId, TenantId } from "../types.ts";
import type { WireInterval } from "../wire.ts";
import type { AuthCtx, MutationAuthority } from "./define.ts";
import type {
    OrganizationAuthority,
    OrganizationAuthorityRequest,
    RouteResult,
    UserAuthority,
    UserAuthorityRequest,
} from "./do/catalog.ts";

/** Structured-cloneable error envelope shared by every mutation RPC hop. */
export type CdbErrorWire = ReturnType<CdbError["toJSON"]>;

/** Local Gateway input for resolving a ref and its partition key. */
export interface MutationRouteRequest {
    readonly ref: string;
    readonly args: RawJson;
}

export type MutationRouteResponse =
    | {
          readonly ok: true;
          readonly vshard: number;
          readonly authority: MutationAuthority | null;
          readonly partitionKey: string | null;
          readonly args: RawJson;
      }
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

/** Catalog boundary for deriving tenant authority from persisted membership. */
export interface CatalogOrganizationAuthorityRpc {
    resolveOrganizationAuthority(request: OrganizationAuthorityRequest): Promise<OrganizationAuthority | null>;
}

/** Catalog boundary for deriving authority from the persisted Better Auth user row. */
export interface CatalogUserAuthorityRpc {
    resolveUserAuthority(request: UserAuthorityRequest): Promise<UserAuthority | null>;
}

/** Globally unique identity for one live subscription registration. */
export interface LiveSubscriptionId {
    readonly gatewayId: string;
    /** Unique registration generation within one Gateway DO. */
    readonly registrationId: string;
    /** Gateway-owned socket generation that created this registration. */
    readonly connectionId: string;
    readonly clientId: ClientId;
    readonly subId: SubId;
}

export interface CdbSubscriptionRequest {
    readonly subscription: LiveSubscriptionId;
    readonly principalId: PrincipalId;
    readonly organizationId: TenantId;
    readonly domainSchemaEpoch: number;
    readonly ref: ChardbRef;
    readonly args: RawJson;
    readonly queryHash: string;
    readonly tables: readonly string[];
    readonly intervals: readonly {
        readonly table: string;
        readonly indexName: string;
        readonly intervals: readonly WireInterval[];
    }[];
}

export type CdbSubscriptionResponse =
    | {
          readonly ok: true;
          readonly subscription: LiveSubscriptionId;
          readonly changeSeq: number;
      }
    | {
          readonly ok: false;
          /** The Cdb transaction proved that this registration was never inserted. */
          readonly registrationState: "absent";
          readonly subscription: LiveSubscriptionId;
          readonly error: CdbErrorWire;
      };

export interface CdbSubscriptionRpc {
    subscribe(args: CdbSubscriptionRequest): Promise<CdbSubscriptionResponse>;
    unsubscribe(subscription: LiveSubscriptionId): Promise<void>;
    finalizeUnsubscribe(subscription: LiveSubscriptionId): Promise<void>;
}

export interface GatewayInvalidation {
    readonly subscription: LiveSubscriptionId;
    readonly changeSeq: number;
}

export interface GatewayInvalidationRequest {
    readonly sourceCdbId: string;
    readonly gatewayId: string;
    readonly invalidations: readonly GatewayInvalidation[];
}

export interface GatewayInvalidationAck {
    readonly registrationId: string;
    readonly changeSeq: number;
    readonly status: "accepted" | "stale";
}

export interface GatewayInvalidationResponse {
    readonly gatewayId: string;
    readonly acknowledgements: readonly GatewayInvalidationAck[];
}

export interface GatewayInvalidationRpc {
    invalidateSubscriptions(request: GatewayInvalidationRequest): Promise<GatewayInvalidationResponse>;
}

export interface CdbMutationRequest {
    readonly principalId: string;
    readonly mutId: string;
    readonly ref: string;
    readonly args: RawJson;
    readonly auth: AuthCtx;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
}

export interface CdbMutationSuccess {
    readonly ok: true;
    readonly cookie: string;
    readonly ran: boolean;
    readonly result: RawJson;
    readonly rowsAffected: number;
    /** Internal coarse write set. Gateway omits this from the public wire result. */
    readonly touchedTables?: readonly string[];
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

/** Internal shard query request. Gateway supplies validated args and trusted auth. */
export interface CdbQueryRequest {
    readonly ref: ChardbRef;
    readonly args: RawJson;
    readonly auth: AuthCtx;
    readonly domainSchemaEpoch: number;
}

export type CdbQueryResponse =
    | { readonly ok: true; readonly result: RawJson }
    | { readonly ok: false; readonly error: CdbErrorWire };

export interface CdbQueryRpc {
    query(request: CdbQueryRequest): Promise<CdbQueryResponse>;
}

/** Authenticated input for one server-routed query outside the live socket path. */
export interface TrustedQueryDispatchRequest {
    readonly principalId: PrincipalId;
    readonly ref: string;
    readonly args: RawJson;
}

/** Re-run one persisted live-query generation with freshly authorized context. */
export interface CdbRegisteredQueryRequest {
    readonly subscription: LiveSubscriptionId;
    readonly auth: AuthCtx;
    readonly domainSchemaEpoch: number;
}

export interface CdbRegisteredQueryRpc {
    queryRegistered(request: CdbRegisteredQueryRequest): Promise<CdbQueryResponse>;
}

/** Auth accepted by dispatch only after a verifier has established it. */
export interface TrustedMutationAuth {
    readonly principalId: PrincipalId;
}

export interface TrustedMutationDispatchRequest extends TrustedMutationAuth {
    readonly ref: string;
    readonly mutId: string;
    readonly args: RawJson;
}
