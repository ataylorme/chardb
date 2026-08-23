/**
 * `chardb/server` public surface.
 *
 * Exports the locked server-side helpers (`defineChardb`, `mountChardb`,
 * `defineMutation`, `defineQuery`, `defineCron`, `defineStream`,
 * `defineLedger`, `defineGsi`, `definePresenceKey`, `chardbPolicy`,
 * `vector`, `inlineVector`) and the Durable Object classes the user binds in
 * `wrangler.jsonc`.
 */

export {
    api,
    createApi,
    defineCron,
    defineGsi,
    defineMutation,
    definePresenceKey,
    defineQuery,
    defineStream,
    type AuthCtx,
    type ChardbApi,
    type ChardbDb,
    type CronFn,
    type GsiHandle,
    type IdempotencyTtl,
    type IdempotentMutation,
    type InferArgs,
    type MutationConfig,
    type MutationAuthority,
    type MutationCtx,
    type MutationFn,
    type MutationOptions,
    type PresenceKey,
    type QueryConfig,
    type QueryCtx,
    type QueryFn,
    type StreamFn,
    type UserError,
} from "./define.ts";
export { defineLedger, type LedgerOptions, type LedgerTable } from "./ledger.ts";
export {
    renderLedgerLogpush,
    renderLedgerPayload,
    renderLogpushJobRequest,
    type LogpushFieldDescriptor,
    type LogpushJobSpec,
} from "./logpush.ts";
export {
    DT_DDL,
    bindDtRuntime,
    crossPartitionMutation,
    recoverDt,
    type CrossPartitionMutationSpec,
    type DtRuntime,
    type DtState,
} from "./dt.ts";
export type {
    CoordinatorStore,
    Participant,
    ParticipantPrepareResponse,
    PreparePlan,
    RecoveryVote,
    Vote,
} from "./dt_protocol.ts";
export {
    chardbPolicy,
    applyPoliciesToWhere,
    applyRowPolicies,
    policyDigest,
    type PolicyDefinition,
    type PolicyDigestEntry,
    type PolicyOp,
} from "./policy.ts";
export { forOrg, forUser, globalScope } from "./cdb-tenant.ts";
export type { BoundCdbTable } from "./cdb-tenant.ts";
export type {
    CdbTableConfig,
    CdbTableMeta,
    ColumnSpec,
    RoleName,
    RoleValue,
    TenantKind,
    Verb,
    VerbValue,
} from "./cdb-table-types.ts";
export { getCdbMeta, isCdbTable, collectCdbTables, CDB_TABLE_SYMBOL } from "./cdb-table-registry.ts";
export { resolveCdbMeta } from "./cdb-table.ts";
export { compileCdbPolicies, TENANT_EPOCH_TABLES, PRINCIPAL_EPOCH_TABLES } from "./cdb-policy.ts";
export { applyColumnMask, assertColumnsWritable } from "./cdb-cls.ts";
export { wrapDb } from "./cdb-db-proxy.ts";
export {
    executeAtomicMutation,
    type AtomicMutationDb,
    type AtomicMutationHandler,
    type AtomicMutationRequest,
    type AtomicMutationResult,
    type ExecuteAtomicMutationInput,
} from "./atomic-mutation.ts";
export { buildAccessControl, type BuiltAccessControl } from "./cdb-access.ts";
export { createAccessControl, role } from "better-auth/plugins/access";
export type { AccessControl, Role, Statements, Subset } from "better-auth/plugins/access";
export {
    defineChardb,
    mountChardb,
    type ChardbEnv,
    type DefineChardbInput,
    type MountChardbOptions,
} from "./entrypoint.ts";
export { chardb, type ChardbApp, type ChardbFactoryInput } from "./chardb.ts";
export { Cdb } from "./do/cdb.ts";
export type {
    CatalogMutationRpc,
    CatalogOrganizationAuthorityRpc,
    CatalogRoutingRpc,
    CdbErrorWire,
    CdbMutationFailure,
    CdbMutationRequest,
    CdbMutationResponse,
    CdbMutationRpc,
    CdbMutationSuccess,
    CdbRegisteredQueryRequest,
    CdbRegisteredQueryRpc,
    CdbSubscriptionRequest,
    CdbSubscriptionRpc,
    LiveSubscriptionId,
    MutationRouteRequest,
    MutationRouteResolver,
    MutationRouteResponse,
    TrustedMutationAuth,
    TrustedMutationDispatchRequest,
} from "./rpc.ts";
export {
    defineAuth,
    synthesizeAuthSchema,
    type ChardbAuth,
    type KnownAuthTables,
    type SynthesizedAuthSchema,
    type SynthesizedAuthTable,
} from "../auth/synthesize.ts";
export {
    chardbAuthAdapter,
    type ChardbAuthAdapterEnv,
    type ChardbAuthAdapterOptions,
} from "../auth/chardb_adapter.ts";
export { bindAuthRuntime, getAuthRuntime, placementFor, tableFor, type AuthPartitionRule } from "../auth/runtime.ts";
export {
    emptyManifest,
    manifestFromExports,
    resolveMutation,
    resolveQuery,
    routeQuery,
    type ChardbManifest,
    type CronDescriptor,
    type LedgerDescriptor,
    type MutationDescriptor,
    type QueryDescriptor,
    type QueryRouteResponse,
} from "./manifest.ts";
export {
    cosineSimilarity,
    inlineVector,
    vector,
    type VectorColumnHandle,
    type VectorConfig,
} from "../vector.ts";
export {
    Catalog,
    type OrganizationAuthority,
    type OrganizationAuthorityRequest,
} from "./do/catalog.ts";
export { Gateway } from "./do/gateway.ts";
export { BlobMeta } from "./do/blobmeta.ts";
export { Resharder } from "./do/resharder.ts";
export { GsiShard } from "./do/gsishard.ts";
export {
    DISTINCT_UNION_CAP,
    mergeDistinct,
    mergePartialAggregates,
    mergeTopK,
    type AggregateOp,
    type AggregatePartial,
    type AggregateResult,
    type Comparator,
    type DistinctMergeResult,
} from "./merge.ts";
