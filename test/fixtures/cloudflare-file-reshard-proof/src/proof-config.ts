export const FILE_RESHARD_PROOF_VECTOR = Object.freeze({
    binding: "CDB_PROOF_VECTORS",
    dimensions: 32,
    metric: "cosine",
} as const);

export function proofVectorValues(index: number): readonly number[] {
    return Object.freeze(
        Array.from({ length: FILE_RESHARD_PROOF_VECTOR.dimensions }, (_, dimension) =>
            dimension === 0 ? (index === 0 ? 1 : 0) : dimension === 1 ? (index === 0 ? 0 : 1) : 0
        )
    );
}
