// @ts-nocheck The candidate node_modules tree exists only in the prepared disposable proof directory.
// This relative import proves the fixture uses the exact packed candidate rather than repository source.
export {
    cdbVectorizePhysicalId,
    parseCdbVectorizePhysicalId,
} from "../node_modules/@chardb/core/dist/internal/vector-proof.mjs";
export type {
    CdbVectorizeMutationIndex,
    CdbVectorizeRecord,
    CdbVectorizeSearchIndex,
} from "../node_modules/@chardb/core/dist/internal/vector-proof.mjs";
