export const recoveryNamespace = {
    idFromName: () => "global",
    get: () => ({
        adminRecoveryAdmissionClock: async () => ({
            generation: 0,
            activeOperationId: null,
            activeDigest: null,
        }),
    }),
} as unknown as DurableObjectNamespace;

export function withRecoveryEnv<T extends object>(env: T): T & { readonly CDB_RESHARD: DurableObjectNamespace } {
    return { ...env, CDB_RESHARD: recoveryNamespace };
}
