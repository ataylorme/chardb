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
export {
    createAccessControl,
    defineRoles,
    ownerScope,
    publicRead,
    requirePermission,
    requireRole,
    role,
    tenantScope,
    type AccessControl,
    type Role,
    type Statements,
    type Subset,
} from "./access.ts";
export {
    defineChardb,
    mountChardb,
    type ChardbEnv,
    type DefineChardbInput,
    type MountChardbOptions,
} from "./entrypoint.ts";
export { chardb, type ChardbApp, type ChardbFactoryInput } from "./chardb.ts";
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
    type ChardbManifest,
    type CronDescriptor,
    type LedgerDescriptor,
    type MutationDescriptor,
    type QueryDescriptor,
} from "./manifest.ts";
export {
    cosineSimilarity,
    inlineVector,
    vector,
    type VectorColumnHandle,
    type VectorConfig,
} from "../vector.ts";
export { Cdb } from "./do/cdb.ts";
export { Catalog } from "./do/catalog.ts";
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
