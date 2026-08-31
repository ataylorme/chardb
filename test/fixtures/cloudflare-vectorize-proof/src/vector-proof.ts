// @ts-nocheck The candidate node_modules tree exists only in the prepared disposable proof directory.
// The proof runner installs the exact candidate tarball beside this source.
// A filesystem-relative import bypasses package exports without falling back to the repository source tree.
export {
    CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
    CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
    collectSchemaResourceDescriptors,
    cdbVectorLogicalId,
    cdbVectorResourceId,
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizeResourceFilter,
    deleteCdbVector,
    dispatchOrganizationVectorSearch,
    isChardbVectorResourceDescriptor,
    parseCdbVectorizePhysicalId,
    stageCdbVector,
    vector,
    vshardOf,
} from "../node_modules/@chardb/core/dist/internal/vector-proof.mjs";
export type {
    CdbValidatedVectorMatch,
    CdbVectorizeMutationIndex,
    CdbVectorizeRecord,
    CdbVectorizeSearchIndex,
    OrganizationVectorSearchValidation,
} from "../node_modules/@chardb/core/dist/internal/vector-proof.mjs";
