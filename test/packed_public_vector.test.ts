import { describe, expect, test } from "bun:test";
import {
    PACKED_LOCAL_VECTOR_CAPABILITY,
    PACKED_PUBLIC_VECTOR_SCHEMA,
    PUBLIC_VECTOR_QUERY_REF,
    assertMatchingPackedPublicVectorReport,
    assertPackedLocalVectorCapability,
    assertPackedPublicVectorBrowserProof,
    assertPackedPublicVectorBundle,
} from "../scripts/packed-public-vector-contract.mjs";

function validProof() {
    const queryArgs = { organizationId: "org-browser-proof", values: [1, 0, 0], limit: 5 };
    return {
        schema: PACKED_PUBLIC_VECTOR_SCHEMA,
        queryRef: PUBLIC_VECTOR_QUERY_REF,
        queryArgs,
        observations: [
            { state: "pending", rows: [] },
            { state: "live", rows: [{ rowPk: "message-a", score: 0.98 }] },
            { state: "refetching", rows: [] },
            { state: "live", rows: [{ rowPk: "message-b", score: 0.91 }] },
        ],
        sent: [
            { t: "hello", protocolV: 3, clientId: "browser-proof", jwt: "proof.jwt.value" },
            { t: "sub", subId: 1, ref: PUBLIC_VECTOR_QUERY_REF, args: queryArgs },
            { t: "ack", cookie: "browser-proof:1" },
            { t: "sub", subId: 1, ref: PUBLIC_VECTOR_QUERY_REF, args: queryArgs },
            { t: "ack", cookie: "browser-proof:2" },
        ],
    };
}

describe("packed public vector browser contract", () => {
    test("accepts the exact public query, result, and refetch sequence", () => {
        expect(() => assertPackedPublicVectorBrowserProof(validProof())).not.toThrow();
    });

    test("rejects internal result metadata and a missing refetch", () => {
        const leaked = validProof();
        leaked.observations[3] = {
            state: "live",
            rows: [{ rowPk: "message-b", score: 0.91, vectorId: "private" } as never],
        };
        expect(() => assertPackedPublicVectorBrowserProof(leaked)).toThrow("vector result leaked non-public fields");

        const missing = validProof();
        missing.observations.splice(2, 1);
        expect(() => assertPackedPublicVectorBrowserProof(missing)).toThrow(
            "useQuery did not expose pending, live, refetching, live"
        );
    });

    test("rejects server-only vector code in the browser bundle", () => {
        expect(() =>
            assertPackedPublicVectorBundle(`const ref = ${JSON.stringify(PUBLIC_VECTOR_QUERY_REF)};`)
        ).not.toThrow();
        expect(() =>
            assertPackedPublicVectorBundle(
                `const ref = ${JSON.stringify(PUBLIC_VECTOR_QUERY_REF)}; const leaked = "cdbVectorLogicalId";`
            )
        ).toThrow("browser bundle leaked server-only vector symbol");
    });

    test("binds local semantic acceptance to the exact packed candidate without claiming provider proof", () => {
        const fingerprint = { algorithm: "sha256", digest: "a".repeat(64), bytes: 123 };
        const reactFingerprint = { algorithm: "sha256", digest: "b".repeat(64), bytes: 87 };
        const report = {
            schema: PACKED_PUBLIC_VECTOR_SCHEMA,
            ok: true,
            package: { tarball: fingerprint },
            reactPackage: { name: "@chardb/react", version: "0.1.0", tarball: reactFingerprint },
            capability: PACKED_LOCAL_VECTOR_CAPABILITY,
            proof: validProof(),
        };
        expect(assertPackedLocalVectorCapability(report.capability)).toBe(report.capability);
        expect(assertMatchingPackedPublicVectorReport(report, fingerprint, reactFingerprint)).toBe(report);
        expect(() =>
            assertMatchingPackedPublicVectorReport(
                { ...report, package: { tarball: { ...fingerprint, bytes: 124 } } },
                fingerprint,
                reactFingerprint
            )
        ).toThrow("does not identify the preview tarball");
        expect(() =>
            assertMatchingPackedPublicVectorReport(
                { ...report, package: { tarball: { ...fingerprint, digest: "b".repeat(64) } } },
                fingerprint,
                reactFingerprint
            )
        ).toThrow("does not identify the preview tarball");
        expect(() =>
            assertMatchingPackedPublicVectorReport({ ...report, ok: false }, fingerprint, reactFingerprint)
        ).toThrow("did not pass");
        expect(() =>
            assertMatchingPackedPublicVectorReport(
                { ...report, capability: { ...PACKED_LOCAL_VECTOR_CAPABILITY, realVectorize: true } },
                fingerprint,
                reactFingerprint
            )
        ).toThrow("local semantic fake");
        expect(() =>
            assertMatchingPackedPublicVectorReport(
                { ...report, reactPackage: { ...report.reactPackage, tarball: { ...reactFingerprint, bytes: 88 } } },
                fingerprint,
                reactFingerprint
            )
        ).toThrow("React tarball");
    });
});
