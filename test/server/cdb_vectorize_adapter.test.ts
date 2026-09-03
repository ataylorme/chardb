import { describe, expect, test } from "bun:test";
import type {
    CdbVectorDeleteClaim,
    CdbVectorHead,
    CdbVectorUpsertClaim,
} from "../../src/server/do/cdb-vector-outbox-store.ts";
import { cdbVectorPhysicalId } from "../../src/server/do/cdb-vector-outbox-store.ts";
import {
    CDB_VECTORIZE_QUERY_TIMEOUT_MS,
    deleteCdbVectorizePhysicalIds,
    deliverCdbVectorClaim,
    queryCdbVectorizeCandidates,
    validateCdbVectorMatches,
    verifyCdbVectorClaim,
    verifyCdbVectorizePhysicalIdsDeleted,
} from "../../src/server/do/cdb-vectorize-adapter.ts";
import {
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizeResourceFilter,
} from "../../src/server/do/cdb-vectorize-wire.ts";
import { cdbVectorResourceId } from "../../src/server/resource-descriptors.ts";

const RESOURCE = Object.freeze({
    kind: "vector" as const,
    version: 1 as const,
    table: "messages",
    column: "embedding",
    primaryKey: "id",
    organizationColumn: "organization_id",
    binding: "CDB_MESSAGES_VECTOR",
    dimensions: 3,
    metric: "cosine" as const,
});

const RESOURCE_ID = cdbVectorResourceId(RESOURCE);
const VECTOR_ID = `vec1_${"a".repeat(64)}`;
const OTHER_VECTOR_ID = `vec1_${"b".repeat(64)}`;
const WIRE_PHYSICAL_1 = cdbVectorizePhysicalId(VECTOR_ID, 1);
const WIRE_PHYSICAL_2 = cdbVectorizePhysicalId(VECTOR_ID, 2);

const HEAD: CdbVectorHead = Object.freeze({
    vectorId: VECTOR_ID,
    organizationId: "org_alpha",
    placementVshard: 1,
    resourceId: RESOURCE_ID,
    rowPk: "message-1",
    dimensions: 3,
    version: 2,
    deliveredVersion: 2,
    values: [1, 2, 3],
    metadata: { private: "from-sqlite" },
    state: "ready",
    updatedAt: 100,
});

const UPSERT: CdbVectorUpsertClaim = Object.freeze({
    operation: "upsert",
    phase: "submit",
    mutationId: null,
    acceptedAt: null,
    vectorId: HEAD.vectorId,
    organizationId: HEAD.organizationId,
    placementVshard: HEAD.placementVshard,
    resourceId: HEAD.resourceId,
    rowPk: HEAD.rowPk,
    dimensions: HEAD.dimensions,
    targetVersion: HEAD.version,
    physicalId: cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 2),
    values: [1, 2, 3],
    metadata: HEAD.metadata,
    claimToken: "claim-token-0001",
    leasedUntil: 200,
    attempt: 1,
});

const DELETE: CdbVectorDeleteClaim = Object.freeze({
    operation: "delete",
    phase: "submit",
    mutationId: null,
    acceptedAt: null,
    deleteProofRecorded: false,
    mode: "delete",
    vectorId: HEAD.vectorId,
    organizationId: HEAD.organizationId,
    placementVshard: HEAD.placementVshard,
    resourceId: HEAD.resourceId,
    rowPk: HEAD.rowPk,
    dimensions: HEAD.dimensions,
    targetVersion: 3,
    physicalIds: [cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 1), cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 2)],
    claimToken: "claim-token-0002",
    leasedUntil: 300,
    attempt: 1,
});

describe("Cdb Vectorize adapter", () => {
    test("queries one descriptor-bound organization namespace without requesting external payloads", async () => {
        const calls: unknown[] = [];
        const matches = await queryCdbVectorizeCandidates({
            index: {
                query(values, options) {
                    calls.push({ values, options });
                    return { matches: [{ id: WIRE_PHYSICAL_2, score: 0.75, metadata: { hostile: true } }], count: 1 };
                },
            },
            resource: RESOURCE,
            organizationId: HEAD.organizationId,
            values: [1, 2, 3],
            limit: 4,
        });
        expect(calls).toEqual([
            {
                values: [1, 2, 3],
                options: {
                    topK: 20,
                    namespace: cdbVectorizeOrganizationNamespace(HEAD.organizationId),
                    returnValues: false,
                    returnMetadata: "none",
                    filter: { cdb_resource: cdbVectorizeResourceFilter(RESOURCE_ID) },
                },
            },
        ]);
        expect(matches).toEqual([{ id: WIRE_PHYSICAL_2, score: 0.75 }]);
        expect(Object.isFrozen(matches)).toBe(true);
        expect(Object.isFrozen(matches[0])).toBe(true);
    });

    test("rejects mismatched dimensions and malformed or oversized Vectorize receipts", async () => {
        const base = {
            resource: RESOURCE,
            organizationId: HEAD.organizationId,
            values: [1, 2, 3],
            limit: 2,
        };
        await expect(
            queryCdbVectorizeCandidates({
                ...base,
                values: [1, 2],
                index: { query: () => ({ matches: [], count: 0 }) },
            })
        ).rejects.toMatchObject({ code: "CDB_VECTORIZE_DIM_MISMATCH" });
        for (const receipt of [
            null,
            { matches: [], count: 1 },
            { matches: [{ id: WIRE_PHYSICAL_2, score: Number.NaN }], count: 1 },
            { matches: Array.from({ length: 19 }, () => UPSERT), count: 19 },
        ]) {
            await expect(
                queryCdbVectorizeCandidates({
                    ...base,
                    index: { query: () => receipt },
                })
            ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        }
        await expect(
            queryCdbVectorizeCandidates({
                ...base,
                values: [1, Number.POSITIVE_INFINITY, 3],
                index: { query: () => ({ matches: [], count: 0 }) },
            })
        ).rejects.toMatchObject({ code: "CDB_INVALID_ARGS" });
        await expect(
            queryCdbVectorizeCandidates({
                ...base,
                index: { query: () => Promise.reject(new Error("offline")) },
            })
        ).rejects.toMatchObject({ code: "CDB_SHARD_UNAVAILABLE", retryable: true });
    });

    test("bounds a stalled query and allows a later retry to recover", async () => {
        let attempts = 0;
        let nextHandle = 0;
        const scheduled = new Map<number, () => void>();
        const cleared: number[] = [];
        const timers = {
            setTimeout(callback: () => void, milliseconds: number): number {
                expect(milliseconds).toBe(CDB_VECTORIZE_QUERY_TIMEOUT_MS);
                const handle = ++nextHandle;
                scheduled.set(handle, callback);
                return handle;
            },
            clearTimeout(handle: unknown): void {
                if (typeof handle !== "number") throw new Error("unexpected timer handle");
                cleared.push(handle);
                scheduled.delete(handle);
            },
        };
        const index = {
            query() {
                attempts += 1;
                if (attempts === 1) return new Promise<never>(() => {});
                return { matches: [{ id: WIRE_PHYSICAL_2, score: 0.75 }], count: 1 };
            },
        };
        const input = {
            index,
            resource: RESOURCE,
            organizationId: HEAD.organizationId,
            values: [1, 2, 3],
            limit: 1,
            timers,
        };

        const stalled = queryCdbVectorizeCandidates(input);
        await Promise.resolve();
        expect(attempts).toBe(1);
        expect([...scheduled.keys()]).toEqual([1]);
        scheduled.get(1)?.();
        await expect(stalled).rejects.toMatchObject({
            code: "CDB_SHARD_UNAVAILABLE",
            retryable: true,
            message: `vectorize adapter: search request timed out after ${CDB_VECTORIZE_QUERY_TIMEOUT_MS}ms`,
        });
        expect(cleared).toEqual([1]);
        expect(scheduled.size).toBe(0);

        await expect(queryCdbVectorizeCandidates(input)).resolves.toEqual([{ id: WIRE_PHYSICAL_2, score: 0.75 }]);
        expect(attempts).toBe(2);
        expect(cleared).toEqual([1, 2]);
        expect(scheduled.size).toBe(0);
    });

    test("normalizes negative zero scores before candidates cross JSON boundaries", async () => {
        const matches = await queryCdbVectorizeCandidates({
            index: { query: () => ({ matches: [{ id: WIRE_PHYSICAL_2, score: -0 }], count: 1 }) },
            resource: RESOURCE,
            organizationId: HEAD.organizationId,
            values: [1, 2, 3],
            limit: 1,
        });

        expect(matches).toEqual([{ id: WIRE_PHYSICAL_2, score: 0 }]);
        expect(Object.is(matches[0]?.score, -0)).toBe(false);
        expect(JSON.stringify(matches)).toBe(`[{"id":"${WIRE_PHYSICAL_2}","score":0}]`);
    });

    test("sends a versioned, organization-namespaced record without leaking application metadata", async () => {
        const calls: unknown[] = [];
        await deliverCdbVectorClaim(
            {
                upsert(records) {
                    calls.push(records);
                    return { mutationId: "mutation-1" };
                },
                deleteByIds() {
                    throw new Error("unexpected delete");
                },
                getByIds: () => [],
            },
            UPSERT
        );
        expect(calls).toEqual([
            [
                {
                    id: WIRE_PHYSICAL_2,
                    values: UPSERT.values,
                    namespace: cdbVectorizeOrganizationNamespace("org_alpha"),
                    metadata: {
                        cdb_resource: cdbVectorizeResourceFilter(RESOURCE_ID),
                    },
                },
            ],
        ]);
    });

    test("supports current async and legacy exact mutation receipts", async () => {
        await expect(
            deliverCdbVectorClaim(
                {
                    upsert: records => ({ ids: records.map(record => record.id), count: records.length }),
                    deleteByIds: ids => ({ ids, count: ids.length }),
                    getByIds: () => [],
                },
                UPSERT
            )
        ).resolves.toEqual({ kind: "processed" });
        await expect(
            deliverCdbVectorClaim(
                {
                    upsert: () => ({ mutationId: "unused" }),
                    deleteByIds: ids => ({ ids, count: ids.length }),
                    getByIds: () => [],
                },
                DELETE
            )
        ).resolves.toEqual({ kind: "processed" });
        await expect(
            deliverCdbVectorClaim(
                {
                    upsert: () => ({ ids: [], count: 0 }),
                    deleteByIds: () => ({ mutationId: "unused" }),
                    getByIds: () => [],
                },
                UPSERT
            )
        ).rejects.toThrow(/invalid receipt/);
        await expect(
            deliverCdbVectorClaim(
                {
                    upsert: () => ({ mutationId: "unused" }),
                    deleteByIds: ids => ({ ids: [ids[0], ids[0]], count: 2 }),
                    getByIds: () => [],
                },
                DELETE
            )
        ).rejects.toThrow(/does not exactly match/);
        await expect(
            deliverCdbVectorClaim(
                {
                    upsert: () => ({ ids: [UPSERT.physicalId, "unexpected"], count: 2 }),
                    deleteByIds: () => ({ mutationId: "unused" }),
                    getByIds: () => [],
                },
                UPSERT
            )
        ).rejects.toThrow(/invalid receipt/);
    });

    test("deletes and proves bounded recovery batches through exact provider ids", async () => {
        const deleted: string[][] = [];
        const index = {
            upsert: () => ({ mutationId: "unused" }),
            deleteByIds(ids: readonly string[]) {
                deleted.push([...ids]);
                return { ids, count: ids.length };
            },
            getByIds: () => [],
        };
        const batch = await deleteCdbVectorizePhysicalIds(index, [cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 2)]);
        expect(batch).toEqual({ receipt: { kind: "processed" }, wireIds: [WIRE_PHYSICAL_2] });
        expect(deleted).toEqual([[WIRE_PHYSICAL_2]]);
        expect(await verifyCdbVectorizePhysicalIdsDeleted(index, batch)).toBe(true);
        await expect(
            deleteCdbVectorizePhysicalIds(index, [
                cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 2),
                cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 2),
            ])
        ).rejects.toMatchObject({ code: "CDB_INVALID_ARGS" });
    });

    test("does not claim an accepted recovery delete before its exact watermark", async () => {
        let watermark = "other-mutation";
        const index = {
            upsert: () => ({ mutationId: "unused" }),
            deleteByIds: () => ({ mutationId: "recovery-delete" }),
            getByIds: () => [],
            describe: () => ({ processedUpToMutation: watermark }),
        };
        const batch = await deleteCdbVectorizePhysicalIds(index, [cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 1)]);
        expect(await verifyCdbVectorizePhysicalIdsDeleted(index, batch)).toBe(false);
        watermark = "recovery-delete";
        expect(await verifyCdbVectorizePhysicalIdsDeleted(index, batch)).toBe(true);
    });

    test("does not call Vectorize for a delete with no attempted physical ids", async () => {
        let calls = 0;
        await deliverCdbVectorClaim(
            {
                upsert: () => {
                    calls++;
                    return { mutationId: "unexpected" };
                },
                deleteByIds: () => {
                    calls++;
                    return { mutationId: "unexpected" };
                },
                getByIds: () => [],
            },
            { ...DELETE, physicalIds: [] }
        );
        expect(calls).toBe(0);
    });

    test("separates V2 acceptance from exact upsert and delete visibility", async () => {
        const accepted = await deliverCdbVectorClaim(
            {
                upsert: () => ({ mutationId: "mutation-2" }),
                deleteByIds: () => ({ mutationId: "unused" }),
                getByIds: () => [],
            },
            UPSERT
        );
        expect(accepted).toEqual({ kind: "accepted", mutationId: "mutation-2" });
        expect(
            await verifyCdbVectorClaim(
                {
                    upsert: () => ({ mutationId: "unused" }),
                    deleteByIds: () => ({ mutationId: "unused" }),
                    getByIds: () => [],
                },
                { ...UPSERT, phase: "verify", mutationId: "mutation-2", acceptedAt: 100 }
            )
        ).toBe(false);
        expect(
            await verifyCdbVectorClaim(
                {
                    upsert: () => ({ mutationId: "unused" }),
                    deleteByIds: () => ({ mutationId: "unused" }),
                    getByIds: () => [
                        {
                            id: WIRE_PHYSICAL_2,
                            namespace: cdbVectorizeOrganizationNamespace(HEAD.organizationId),
                            values: UPSERT.values,
                            metadata: { cdb_resource: cdbVectorizeResourceFilter(RESOURCE_ID) },
                        },
                    ],
                },
                { ...UPSERT, phase: "verify", mutationId: "mutation-2", acceptedAt: 100 }
            )
        ).toBe(true);
        expect(
            await verifyCdbVectorClaim(
                {
                    upsert: () => ({ mutationId: "unused" }),
                    deleteByIds: () => ({ mutationId: "unused" }),
                    getByIds: () => [],
                    describe: () => ({ processedUpToMutation: "delete-2" }),
                },
                { ...DELETE, phase: "verify", mutationId: "delete-2", acceptedAt: 100 }
            )
        ).toBe(true);
    });

    test("treats a different shared-index watermark as indeterminate, never as absence proof", async () => {
        const sharedIndexCalls: string[] = [];
        expect(
            await verifyCdbVectorClaim(
                {
                    upsert: () => ({ mutationId: "unused" }),
                    deleteByIds: () => ({ mutationId: "unused" }),
                    getByIds: () => {
                        sharedIndexCalls.push("get");
                        return [];
                    },
                    describe: () => {
                        sharedIndexCalls.push("describe");
                        return { processedUpToMutation: "opaque-shared-index-mutation" };
                    },
                },
                { ...DELETE, phase: "verify", mutationId: "delete-2", acceptedAt: 100 }
            )
        ).toBe(false);
        expect(sharedIndexCalls).toEqual(["describe"]);
    });

    test("delivers superseded cleanup through the same bounded delete adapter", async () => {
        const calls: unknown[] = [];
        await deliverCdbVectorClaim(
            {
                upsert() {
                    throw new Error("unexpected upsert");
                },
                deleteByIds(ids) {
                    calls.push(ids);
                    return { ids, count: ids.length };
                },
                getByIds: () => [],
            },
            {
                ...DELETE,
                mode: "cleanup",
                targetVersion: 2,
                physicalIds: [cdbVectorPhysicalId(RESOURCE_ID, VECTOR_ID, 1)],
            }
        );
        expect(calls).toEqual([[WIRE_PHYSICAL_1]]);
    });

    test("validates current SQLite heads and ignores stale, cross-tenant, duplicate, and malformed candidates", () => {
        const otherTenant = { ...HEAD, organizationId: "org_other", vectorId: OTHER_VECTOR_ID, rowPk: "message-2" };
        const heads = new Map<string, CdbVectorHead>([
            [HEAD.vectorId, HEAD],
            [otherTenant.vectorId, otherTenant],
        ]);
        const matches = validateCdbVectorMatches({
            organizationId: "org_alpha",
            resourceId: RESOURCE_ID,
            limit: 2,
            readHead: id => heads.get(id) ?? null,
            matches: [
                { id: WIRE_PHYSICAL_1, score: 0.99 },
                { id: cdbVectorizePhysicalId(OTHER_VECTOR_ID, 2), score: 0.98 },
                { id: WIRE_PHYSICAL_2, score: 0.97 },
                { id: WIRE_PHYSICAL_2, score: 0.96 },
                { id: cdbVectorizePhysicalId(VECTOR_ID, 3), score: 0.95 },
                { id: "broken", score: 0.94 },
                { id: "v1/messages_embedding/missing/1", score: Number.NaN },
            ],
        });
        expect(matches).toEqual([
            { vectorId: VECTOR_ID, rowPk: "message-1", score: 0.97, metadata: { private: "from-sqlite" } },
        ]);
    });

    test("fails closed on oversized candidate sets and invalid caller limits", () => {
        const input = {
            organizationId: "org_alpha",
            resourceId: RESOURCE_ID,
            readHead: () => HEAD,
            matches: [],
        };
        expect(() => validateCdbVectorMatches({ ...input, limit: 0 })).toThrow(/search limit/);
        expect(() =>
            validateCdbVectorMatches({
                ...input,
                limit: 1,
                matches: Array.from({ length: 101 }, () => ({ id: WIRE_PHYSICAL_2, score: 1 })),
            })
        ).toThrow(/candidate count/);
    });
});
