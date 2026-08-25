/**
 * `chardb` — public client surface.
 *
 * Re-exports the SDK entry point (`createChardbClient`), the locked error and
 * wire types, the branded id constructors, and the pure helpers (`IntervalSet`,
 * `VshardMap`, etc.) that downstream tooling needs. Server-side helpers like
 * `defineMutation` live in `chardb/server`; React hooks in `chardb/react`.
 */

export {
    CDB_ERROR_CODES,
    CdbError,
    docsUrlFor,
    isCdbError,
    isRetryable,
    type CdbErrorCode,
    type CdbErrorInit,
} from "./errors.ts";
export {
    ChardbRef,
    ClientId,
    Cookie,
    CorrelationId,
    MutId,
    PrincipalId,
    ShardId,
    SubId,
    TenantId,
    Vshard,
    type Brand,
    type RawJson,
} from "./types.ts";
export type {
    CdbIntent,
    Down,
    Envelope,
    MutResult,
    MustRefetchReason,
    PresenceV,
    ProtocolV,
    RowPatch,
    Up,
    WireEndpoint,
    WireInterval,
    WireMessage,
} from "./wire.ts";
export { decodeWire, encodeWire, PRESENCE_V, PROTOCOL_V } from "./wire.ts";
export {
    closedRange,
    contains,
    FULL,
    IntervalMap,
    IntervalSet,
    overlaps,
    point,
    prefixRange,
    type Endpoint,
    type Interval,
    type IntervalKey,
    type IntervalScalar,
} from "./intervals.ts";
export {
    intervalFromWire,
    intervalSetFromWire,
    intervalSetToWire,
    intervalToWire,
} from "./intervals_wire.ts";
export { canonicalConcat, VSHARD_COUNT, VshardMap, vshardOf, type VshardRange } from "./vshard.ts";
export { createChardbClient, type ChardbClient, type ChardbClientOptions } from "./client/index.ts";
export {
    CHARDB_BINDING_MAX_IN_FLIGHT,
    client,
    type ChardbBinding,
    type ChardbBindingAuth,
    type ChardbBindingClient,
    type ChardbBindingFailure,
    type ChardbBindingMutationOptions,
    type ChardbBindingMutationRequest,
    type ChardbBindingMutationResponse,
    type ChardbBindingQueryRequest,
    type ChardbBindingQueryResponse,
} from "./binding.ts";
