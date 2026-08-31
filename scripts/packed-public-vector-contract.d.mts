export declare const PACKED_PUBLIC_VECTOR_SCHEMA: "chardb.packed-public-vector-browser.v1";
export declare const PACKED_LOCAL_VECTOR_CAPABILITY: Readonly<{
    proof: "local-semantic";
    runtime: "browser";
    provider: "scripted-websocket";
    realVectorize: false;
    providerCalls: false;
    doctorConfigs: readonly ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
    remoteBindingContract: "required";
    prepareFailureDiagnostics: "bounded-redacted-actionable-tail";
}>;
export declare const PUBLIC_VECTOR_QUERY_REF: "src/queries.ts#searchMessages";

export declare function assertPackedPublicVectorBundle(code: string): void;
export declare function assertPackedPublicVectorBrowserProof(proof: unknown): void;
export declare function assertPackedLocalVectorCapability(value: unknown): unknown;
export declare function assertMatchingPackedPublicVectorReport(
    report: unknown,
    fingerprint: { readonly algorithm: string; readonly digest: string; readonly bytes: number },
    reactFingerprint: { readonly algorithm: string; readonly digest: string; readonly bytes: number }
): unknown;
