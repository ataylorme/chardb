/** Candidate-only bridge for the disposable Cloudflare Vectorize proof. */

export { vector } from "../vector.ts";
export { cdbVectorLogicalId, deleteCdbVector, stageCdbVector } from "../server/do/cdb-vector-mutation.ts";
export {
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizeResourceFilter,
    parseCdbVectorizePhysicalId,
} from "../server/do/cdb-vectorize-wire.ts";
export { CDB_VECTOR_DELIVERY_SETTLEMENT_MS } from "../server/do/cdb-vector-runtime.ts";
export { CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR } from "../server/do/cdb-vector-outbox-store.ts";
export { dispatchOrganizationVectorSearch } from "../server/vector-search-dispatch.ts";
export {
    cdbVectorResourceId,
    collectSchemaResourceDescriptors,
    isChardbVectorResourceDescriptor,
} from "../server/resource-descriptors.ts";
export type { CdbValidatedVectorMatch, CdbVectorizeMatch } from "../server/do/cdb-vectorize-adapter.ts";
export type {
    CdbVectorizeMutationIndex,
    CdbVectorizeRecord,
    CdbVectorizeSearchIndex,
} from "../server/do/cdb-vectorize-adapter.ts";
export type { OrganizationVectorSearchValidation } from "../server/vector-search-dispatch.ts";
export { vshardOf } from "../vshard.ts";
