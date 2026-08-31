import { describe, expect, test } from "bun:test";
import { cdbVectorLogicalId } from "../../src/server/do/cdb-vector-mutation.ts";
import {
    CDB_VECTORIZE_MAX_ID_BYTES,
    CDB_VECTORIZE_MAX_METADATA_STRING_BYTES,
    CDB_VECTORIZE_MAX_NAMESPACE_BYTES,
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizePhysicalIdFromCanonical,
    cdbVectorizeResourceFilter,
    parseCdbVectorizePhysicalId,
} from "../../src/server/do/cdb-vectorize-wire.ts";

const RESOURCE_ID: `vr1_${string}` = `vr1_${"b".repeat(64)}`;
const VECTOR_ID: `vec1_${string}` = `vec1_${"a".repeat(64)}`;

describe("private Vectorize wire identities", () => {
    test("derives canonical pre-send logical and physical identity through production codecs", () => {
        const vectorId = cdbVectorLogicalId(RESOURCE_ID, "org-proof", "document-1");
        expect(vectorId).toMatch(/^vec1_[a-f0-9]{64}$/);
        expect(cdbVectorLogicalId(RESOURCE_ID, "org-proof", "document-1")).toBe(vectorId);
        expect(cdbVectorLogicalId(RESOURCE_ID, "org-proof", "document-2")).not.toBe(vectorId);
        const physicalId = cdbVectorizePhysicalId(vectorId, 2);
        expect(parseCdbVectorizePhysicalId(physicalId)).toEqual({ vectorId, version: 2 });
        expect(() => cdbVectorLogicalId("vr1_bad", "org-proof", "document-1")).toThrow(/canonical/);
        expect(() => cdbVectorLogicalId(RESOURCE_ID, "", "document-1")).toThrow(/organization/);
    });

    test("fits resource filters and opaque organization namespaces inside V2 string limits", () => {
        const resource = cdbVectorizeResourceFilter(RESOURCE_ID);
        const first = cdbVectorizeOrganizationNamespace("organization/with/a/logical/id/that/is/not/sent/remotely");
        const retry = cdbVectorizeOrganizationNamespace("organization/with/a/logical/id/that/is/not/sent/remotely");
        const other = cdbVectorizeOrganizationNamespace("another-organization");

        expect(resource).toMatch(/^r1_[A-Za-z0-9_-]{43}$/);
        expect(first).toMatch(/^o1_[A-Za-z0-9_-]{43}$/);
        expect(first).toBe(retry);
        expect(first).not.toBe(other);
        expect(new TextEncoder().encode(resource).byteLength).toBeLessThanOrEqual(
            CDB_VECTORIZE_MAX_METADATA_STRING_BYTES
        );
        expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(CDB_VECTORIZE_MAX_NAMESPACE_BYTES);
    });

    test("round-trips the production logical vector digest and every safe version bit", () => {
        for (const version of [1, 35, 36, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
            const physical = cdbVectorizePhysicalId(VECTOR_ID, version);
            expect(new TextEncoder().encode(physical).byteLength).toBeLessThanOrEqual(CDB_VECTORIZE_MAX_ID_BYTES);
            expect(parseCdbVectorizePhysicalId(physical)).toEqual({ vectorId: VECTOR_ID, version });
        }
    });

    test("translates the durable canonical id without changing its resource or logical identity", () => {
        const canonical = `v1/${RESOURCE_ID}/${VECTOR_ID}/${Number.MAX_SAFE_INTEGER}`;
        const translated = cdbVectorizePhysicalIdFromCanonical(canonical);
        expect(translated.identity).toEqual({
            resourceId: RESOURCE_ID,
            vectorId: VECTOR_ID,
            version: Number.MAX_SAFE_INTEGER,
        });
        expect(parseCdbVectorizePhysicalId(translated.wireId)).toEqual({
            vectorId: VECTOR_ID,
            version: Number.MAX_SAFE_INTEGER,
        });
    });

    test("rejects non-production, non-canonical, padded, and overflowing identities", () => {
        expect(() => cdbVectorizeResourceFilter("messages_embedding")).toThrow(/production vr1/);
        expect(() => cdbVectorizePhysicalId("vec_alpha", 1)).toThrow(/production vec1/);
        expect(() => cdbVectorizePhysicalId(VECTOR_ID, Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
        expect(() => cdbVectorizePhysicalIdFromCanonical(`v1/${RESOURCE_ID}/${VECTOR_ID}/01`)).toThrow(
            /production identity/
        );
        expect(parseCdbVectorizePhysicalId(`${cdbVectorizePhysicalId(VECTOR_ID, 1)}=`)).toBeNull();
        expect(parseCdbVectorizePhysicalId(cdbVectorizePhysicalId(VECTOR_ID, 1).replace(/_1$/, "_01"))).toBeNull();
        expect(parseCdbVectorizePhysicalId(`p1_${"A".repeat(43)}_2gosa7pa2gw`)).toBeNull();
    });
});
