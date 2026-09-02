import { describe, expect, test } from "bun:test";
import { dispatchOrganizationFileOperation } from "../../src/server/file-auth-dispatch.ts";
import type { ChardbFileResourceDescriptor } from "../../src/server/resource-descriptors.ts";
import type { CatalogOrganizationAuthorityRpc } from "../../src/server/rpc.ts";

const resource: ChardbFileResourceDescriptor = {
    kind: "file",
    version: 1,
    table: "messages",
    column: "attachment",
    primaryKey: "id",
    organizationColumn: "organization_id",
    maxSize: 2_048,
    contentTypes: ["image/png"],
};

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
    recoveryGeneration: 0,
};

const bucket = {} as R2Bucket;

function catalog(resolve: () => unknown): CatalogOrganizationAuthorityRpc {
    return {
        async resolveOrganizationAuthority() {
            return resolve() as never;
        },
    };
}

async function dispatch(overrides: Partial<Parameters<typeof dispatchOrganizationFileOperation<string>>[0]> = {}) {
    let operations = 0;
    const result = await dispatchOrganizationFileOperation({
        session,
        locator: { organizationId: "org-1", table: "messages", column: "attachment" },
        resources: [resource],
        catalog: catalog(() => authority),
        bucket,
        operation: async context => {
            operations++;
            expect(context.auth).toMatchObject({ userId: "user-1", tenantId: "org-1", role: "member" });
            expect(context.resource).toBe(resource);
            expect(context.bucket).toBe(bucket);
            return "dispatched";
        },
        ...overrides,
    });
    return { result, operations };
}

describe("private organization file dispatcher", () => {
    test("uses the Better Auth active organization and fresh Catalog authority", async () => {
        const { result, operations } = await dispatch();
        expect(result).toEqual({ ok: true, value: "dispatched" });
        expect(operations).toBe(1);
    });

    test("never opens R2 for missing session, mismatched organization, or locator", async () => {
        expect((await dispatch({ session: null })).result).toEqual({
            ok: false,
            status: 401,
            code: "UNAUTHENTICATED",
        });
        expect(
            (await dispatch({ locator: { organizationId: "org-2", table: "messages", column: "attachment" } })).result
        ).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
        expect(
            (await dispatch({ locator: { organizationId: "org-1", table: "messages", column: "missing" } })).result
        ).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
        expect((await dispatch({ session: null })).operations).toBe(0);
    });

    test("hides revoked membership and distinguishes Catalog outage", async () => {
        const revoked = await dispatch({ catalog: catalog(() => null) });
        expect(revoked.result).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
        expect(revoked.operations).toBe(0);

        const unavailable = await dispatch({
            catalog: {
                async resolveOrganizationAuthority() {
                    throw new Error("offline");
                },
            },
        });
        expect(unavailable.result).toEqual({
            ok: false,
            status: 503,
            code: "CATALOG_UNAVAILABLE",
        });
        expect(unavailable.operations).toBe(0);
    });

    test("fails explicitly when CDB_FILES is absent", async () => {
        const { result, operations } = await dispatch({ bucket: undefined });
        expect(result).toEqual({ ok: false, status: 500, code: "MISSING_BINDING" });
        expect(operations).toBe(0);
    });

    test("refreshes Catalog authority again after external work", async () => {
        let resolutions = 0;
        await expect(
            dispatchOrganizationFileOperation({
                session,
                locator: { organizationId: "org-1", table: "messages", column: "attachment" },
                resources: [resource],
                catalog: catalog(() => (++resolutions === 1 ? authority : null)),
                bucket,
                operation: async context => context.refreshAuthority(),
            })
        ).rejects.toThrow(expect.objectContaining({ code: "CDB_FORBIDDEN" }));
        expect(resolutions).toBe(2);
    });

    test("resolves placement with authority and rejects a route change during external work", async () => {
        let resolutions = 0;
        await expect(
            dispatchOrganizationFileOperation({
                session,
                locator: { organizationId: "org-1", table: "messages", column: "attachment" },
                resources: [resource],
                catalog: {
                    resolveOrganizationAuthority: async () => authority as never,
                    resolveOrganizationAuthorityRoute: async _request => ({
                        authority: authority as never,
                        route: {
                            shardId: (++resolutions === 1 ? "shard-a" : "shard-b") as never,
                            schemaEpoch: 1,
                            recoveryGeneration: 0,
                            domainSchemaEpoch: 2,
                        },
                    }),
                },
                bucket,
                operation: async context => {
                    expect(String(context.route?.shardId)).toBe("shard-a");
                    return context.refreshAuthority();
                },
            })
        ).rejects.toThrow(expect.objectContaining({ code: "CDB_STALE_EPOCH" }));
        expect(resolutions).toBe(2);
    });
});
