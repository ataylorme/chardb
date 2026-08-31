import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
        const report = {
            schema: PACKED_PUBLIC_VECTOR_SCHEMA,
            ok: true,
            package: { tarball: fingerprint },
            capability: PACKED_LOCAL_VECTOR_CAPABILITY,
            proof: validProof(),
        };
        expect(assertPackedLocalVectorCapability(report.capability)).toBe(report.capability);
        expect(assertMatchingPackedPublicVectorReport(report, fingerprint)).toBe(report);
        expect(() =>
            assertMatchingPackedPublicVectorReport(
                { ...report, package: { tarball: { ...fingerprint, bytes: 124 } } },
                fingerprint
            )
        ).toThrow("does not identify the preview tarball");
        expect(() =>
            assertMatchingPackedPublicVectorReport(
                { ...report, package: { tarball: { ...fingerprint, digest: "b".repeat(64) } } },
                fingerprint
            )
        ).toThrow("does not identify the preview tarball");
        expect(() => assertMatchingPackedPublicVectorReport({ ...report, ok: false }, fingerprint)).toThrow(
            "did not pass"
        );
        expect(() =>
            assertMatchingPackedPublicVectorReport(
                { ...report, capability: { ...PACKED_LOCAL_VECTOR_CAPABILITY, realVectorize: true } },
                fingerprint
            )
        ).toThrow("local semantic fake");
    });

    test("keeps browser proof intact while cleanup advances after an earlier teardown failure", async () => {
        const source = await readFile(
            path.join(import.meta.dir, "..", "scripts", "smoke-packed-public-vector.mjs"),
            "utf8"
        );
        const proofAssertion = source.indexOf("assertPackedPublicVectorBrowserProof(proof)");
        const passed = source.indexOf("passed = true", proofAssertion);
        const cleanup = source.indexOf("const cleanupFailures = []", passed);
        const browserClose = source.indexOf('label: "packed public vector Chromium close"', cleanup);
        const serverStop = source.indexOf('label: "packed public vector server stop"', browserClose);
        const scratchCleanup = source.indexOf('label: "packed public vector scratch cleanup"', serverStop);
        const aggregate = source.indexOf('new AggregateError(cleanupFailures, "packed public vector cleanup failed")');

        expect(
            [proofAssertion, passed, cleanup, browserClose, serverStop, scratchCleanup, aggregate].every(
                index => index >= 0
            )
        ).toBe(true);
        expect(proofAssertion).toBeLessThan(passed);
        expect(passed).toBeLessThan(cleanup);
        expect(cleanup).toBeLessThan(browserClose);
        expect(browserClose).toBeLessThan(serverStop);
        expect(serverStop).toBeLessThan(scratchCleanup);
        expect(scratchCleanup).toBeLessThan(aggregate);
        expect(source).toContain('label: "packed public vector smoke"');
        expect(source.match(/cleanupFailures\.push\(error\)/g)).toHaveLength(3);
        expect(source.slice(browserClose, serverStop)).toContain("}\n    }\n    if (server) {");
        expect(source.slice(serverStop, scratchCleanup)).toContain("}\n    }\n    try {\n        if (!passed");
        expect(source).toContain("capability: PACKED_LOCAL_VECTOR_CAPABILITY");
    });
});
