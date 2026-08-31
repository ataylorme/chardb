import { describe, expect, test } from "bun:test";
import {
    cdbVectorizeOrganizationNamespace,
    cdbVectorizePhysicalId,
    cdbVectorizeResourceFilter,
} from "../../src/server/do/cdb-vectorize-wire.ts";
import { type VectorResourceV1, cdbVectorResourceId } from "../../src/server/resource-descriptors.ts";
import type { CatalogOrganizationAuthorityRouteRpc } from "../../src/server/rpc.ts";
import { dispatchOrganizationVectorSearch } from "../../src/server/vector-search-dispatch.ts";

const VECTOR_ID = `vec1_${"a".repeat(64)}`;

const resource: VectorResourceV1 = Object.freeze({
    kind: "vector",
    version: 1,
    table: "messages",
    column: "embedding",
    primaryKey: "id",
    organizationColumn: "organization_id",
    binding: "CDB_MESSAGES_VECTOR",
    dimensions: 3,
    metric: "cosine",
});

const session = {
    user: { id: "user-1" },
    session: { activeOrganizationId: "org-1" },
};

const authority = {
    principalId: "user-1",
    organizationId: "org-1",
    role: "member",
    roles: ["member"],
    authEpochs: { global: 1, tenant: 2, principal: 3 },
};

const route = {
    shardId: "shard-1" as never,
    schemaEpoch: 4,
    domainSchemaEpoch: 5,
};

function catalog(resolve: () => unknown): CatalogOrganizationAuthorityRouteRpc {
    return {
        async resolveOrganizationAuthorityRoute() {
            return resolve() as never;
        },
    };
}

function request(overrides: Partial<Parameters<typeof dispatchOrganizationVectorSearch>[0]> = {}) {
    return dispatchOrganizationVectorSearch({
        session,
        locator: { organizationId: "org-1", table: "messages", column: "embedding" },
        resources: [resource],
        values: [1, 2, 3],
        limit: 4,
        catalog: catalog(() => ({ authority, route })),
        indexes: {
            CDB_MESSAGES_VECTOR: {
                query: () => ({ matches: [{ id: cdbVectorizePhysicalId(VECTOR_ID, 2), score: 0.75 }], count: 1 }),
            },
        },
        validate: async input => [
            {
                vectorId: VECTOR_ID,
                rowPk: "message-1",
                score: input.matches[0]?.score ?? 0,
                metadata: { source: "sqlite" },
            },
        ],
        ...overrides,
    });
}

describe("private organization vector search dispatcher", () => {
    test("refreshes Catalog after Vectorize and validates only through the current routed Cdb", async () => {
        let resolutions = 0;
        const indexCalls: unknown[] = [];
        const validationCalls: unknown[] = [];
        const result = await request({
            catalog: catalog(() => {
                resolutions++;
                return {
                    authority: {
                        ...authority,
                        authEpochs: { ...authority.authEpochs, tenant: resolutions },
                    },
                    route: { ...route, schemaEpoch: resolutions },
                };
            }),
            indexes: {
                CDB_MESSAGES_VECTOR: {
                    query(values, options) {
                        indexCalls.push({ values, options });
                        return {
                            matches: [{ id: cdbVectorizePhysicalId(VECTOR_ID, 2), score: 0.75 }],
                            count: 1,
                        };
                    },
                },
            },
            validate: async input => {
                validationCalls.push(input);
                return [
                    {
                        vectorId: VECTOR_ID,
                        rowPk: "message-1",
                        score: 0.75,
                        metadata: { source: "sqlite" },
                    },
                ];
            },
        });
        expect(resolutions).toBe(2);
        expect(indexCalls).toEqual([
            {
                values: [1, 2, 3],
                options: {
                    topK: 20,
                    namespace: cdbVectorizeOrganizationNamespace("org-1"),
                    returnValues: false,
                    returnMetadata: "none",
                    filter: { cdb_resource: cdbVectorizeResourceFilter(cdbVectorResourceId(resource)) },
                },
            },
        ]);
        expect(validationCalls).toEqual([
            expect.objectContaining({
                auth: expect.objectContaining({
                    tenantId: "org-1",
                    authEpochs: expect.objectContaining({ tenant: 2 }),
                }),
                route: expect.objectContaining({ schemaEpoch: 2 }),
                resource,
                organizationId: "org-1",
                resourceId: cdbVectorResourceId(resource),
                limit: 4,
            }),
        ]);
        expect(result).toEqual({
            ok: true,
            value: [
                {
                    vectorId: VECTOR_ID,
                    rowPk: "message-1",
                    score: 0.75,
                    metadata: { source: "sqlite" },
                },
            ],
        });
    });

    test("lets membership revocation win after the external query", async () => {
        let resolutions = 0;
        let validations = 0;
        const result = await request({
            catalog: catalog(() => (++resolutions === 1 ? { authority, route } : { authority: null })),
            validate: async () => {
                validations++;
                return [];
            },
        });
        expect(result).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
        expect(resolutions).toBe(2);
        expect(validations).toBe(0);
    });

    test("does not touch Catalog or Vectorize for a mismatched organization or resource", async () => {
        let catalogCalls = 0;
        let indexCalls = 0;
        const guarded = {
            catalog: catalog(() => {
                catalogCalls++;
                return { authority, route };
            }),
            indexes: {
                CDB_MESSAGES_VECTOR: {
                    query: () => {
                        indexCalls++;
                        return { matches: [], count: 0 };
                    },
                },
            },
        };
        await expect(
            request({
                ...guarded,
                locator: { organizationId: "org-2", table: "messages", column: "embedding" },
            })
        ).resolves.toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
        await expect(
            request({ ...guarded, locator: { organizationId: "org-1", table: "messages", column: "missing" } })
        ).resolves.toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
        expect(catalogCalls).toBe(0);
        expect(indexCalls).toBe(0);
    });

    test("rejects inherited and accessor-backed Better Auth session fields without invoking them", async () => {
        let getterCalls = 0;
        const accessorSession = Object.defineProperties(
            {},
            {
                user: {
                    enumerable: true,
                    get() {
                        getterCalls++;
                        return { id: "user-1" };
                    },
                },
                session: { enumerable: true, value: { activeOrganizationId: "org-1" } },
            }
        );
        await expect(request({ session: accessorSession })).resolves.toEqual({
            ok: false,
            status: 401,
            code: "UNAUTHENTICATED",
        });
        await expect(
            request({
                session: Object.create({ user: { id: "user-1" }, session: { activeOrganizationId: "org-1" } }),
            })
        ).resolves.toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
        expect(getterCalls).toBe(0);
    });

    test("fails closed for missing bindings and Catalog outages", async () => {
        await expect(request({ indexes: {} })).resolves.toEqual({
            ok: false,
            status: 500,
            code: "MISSING_BINDING",
        });
        await expect(
            request({
                indexes: Object.create({
                    CDB_MESSAGES_VECTOR: { query: () => ({ matches: [], count: 0 }) },
                }) as never,
            })
        ).resolves.toEqual({ ok: false, status: 500, code: "MISSING_BINDING" });
        await expect(
            request({
                catalog: catalog(() => {
                    throw new Error("offline");
                }),
            })
        ).resolves.toEqual({ ok: false, status: 503, code: "CATALOG_UNAVAILABLE" });
    });

    test("rejects malformed Catalog routes as unavailable before querying Vectorize", async () => {
        let indexCalls = 0;
        let getterCalls = 0;
        const indexes = {
            CDB_MESSAGES_VECTOR: {
                query: () => {
                    indexCalls++;
                    return { matches: [], count: 0 };
                },
            },
        };
        const inherited = Object.assign(Object.create({ route }), { authority });
        const accessorRoute = Object.defineProperty({ authority }, "route", {
            enumerable: true,
            get() {
                getterCalls++;
                return route;
            },
        });
        const accessorShardId = Object.defineProperties(
            {},
            {
                shardId: {
                    enumerable: true,
                    get() {
                        getterCalls++;
                        return "shard-1";
                    },
                },
                schemaEpoch: { enumerable: true, value: 1 },
                domainSchemaEpoch: { enumerable: true, value: 1 },
            }
        );
        const routes: unknown[] = [
            undefined,
            null,
            { shardId: "shard-1", schemaEpoch: 1 },
            { ...route, extra: true },
            { ...route, shardId: "" },
            { ...route, shardId: "x".repeat(129) },
            { ...route, schemaEpoch: -1 },
            { ...route, schemaEpoch: 1.5 },
            { ...route, schemaEpoch: Number.NaN },
            { ...route, domainSchemaEpoch: 0 },
            { ...route, domainSchemaEpoch: Number.POSITIVE_INFINITY },
            accessorShardId,
        ];
        const resolutions = [inherited, accessorRoute, ...routes.map(candidate => ({ authority, route: candidate }))];
        for (const resolution of resolutions) {
            await expect(request({ catalog: catalog(() => resolution), indexes })).resolves.toEqual({
                ok: false,
                status: 503,
                code: "CATALOG_UNAVAILABLE",
            });
        }
        expect(indexCalls).toBe(0);
        expect(getterCalls).toBe(0);
    });

    test("rehydrates deterministic Cdb errors transported across the validator RPC boundary", async () => {
        await expect(
            request({
                validate: async () => {
                    throw new Error("CDB_FORBIDDEN: vector row policy denied access");
                },
            })
        ).rejects.toEqual(
            expect.objectContaining({
                name: "CdbError",
                code: "CDB_FORBIDDEN",
                message: "vector row policy denied access",
            })
        );

        await expect(
            request({
                validate: async () => {
                    throw new Error("unclassified RPC failure");
                },
            })
        ).rejects.toEqual(
            expect.objectContaining({
                code: "CDB_SHARD_UNAVAILABLE",
                message: "vector search candidate validation failed",
            })
        );
    });
});
