import { describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import {
    type TrustedQueryDispatchDeps,
    dispatchTrustedQuery,
    projectCdbQueryResponse,
} from "../../src/server/do/gateway.ts";
import type { CdbQueryRequest } from "../../src/server/rpc.ts";
import { ChardbRef, PrincipalId, type RawJson, ShardId, TenantId } from "../../src/types.ts";
import { vshardOf } from "../../src/vshard.ts";

const args = { organizationId: "org-1", limit: 25 } as const;
const request = {
    principalId: PrincipalId("user-1"),
    ref: "queries.ts#listMessages",
    args,
} as const;

const authority = {
    principalId: PrincipalId("user-1"),
    organizationId: TenantId("org-1"),
    role: "admin,member",
    roles: ["admin", "member"],
    authEpochs: { global: 2, tenant: 3, principal: 4 },
} as const;

function workingDeps(): TrustedQueryDispatchDeps {
    return {
        async routeQuery(input) {
            expect(input).toEqual({ ref: request.ref, args });
            return {
                ok: true,
                args: input.args,
                intent: {
                    kind: "select",
                    tables: ["messages"],
                    partitionKey: {
                        table: "messages",
                        column: "organization_id",
                        values: ["org-1"],
                    },
                    joinShape: "colocated",
                },
                policyDigest: "policy-1",
                queryHash: "query-1",
                authority: "organization",
                partitionKey: "org-1",
            };
        },
        catalog: {
            async resolveOrganizationAuthority(input) {
                expect(input).toEqual({ principalId: PrincipalId("user-1"), organizationId: TenantId("org-1") });
                return authority;
            },
            async route(vshard) {
                expect(vshard).toBe(Number(vshardOf(["org-1"])));
                return { shardId: ShardId("shard-a"), schemaEpoch: 9, domainSchemaEpoch: 5 };
            },
        },
        cdb(shardId) {
            expect(shardId).toBe("shard-a");
            return {
                async query(input) {
                    expect(input).toEqual<CdbQueryRequest>({
                        ref: ChardbRef("queries.ts#listMessages"),
                        args,
                        auth: {
                            userId: "user-1",
                            tenantId: "org-1",
                            role: "admin,member",
                            roles: ["admin", "member"],
                            authEpochs: { global: 2, tenant: 3, principal: 4 },
                            claims: {},
                        },
                        domainSchemaEpoch: 5,
                    });
                    return { ok: true, result: [{ id: "message-1" }] };
                },
            };
        },
    };
}

describe("trusted one-shot query dispatch", () => {
    test("derives organization auth and placement before executing Cdb", async () => {
        await expect(dispatchTrustedQuery(workingDeps(), request)).resolves.toEqual({
            ok: true,
            result: [{ id: "message-1" }],
        });
    });

    test("rejects caller-controlled or cross-partition intent before Catalog", async () => {
        let catalogCalls = 0;
        for (const routed of [
            { authority: null, partitionKey: "org-1", values: ["org-1"], joinShape: "colocated" },
            { authority: "organization", partitionKey: "org-1", values: ["org-2"], joinShape: "colocated" },
            { authority: "organization", partitionKey: "org-1", values: ["org-1"], joinShape: "cross-partition" },
        ] as const) {
            const deps: TrustedQueryDispatchDeps = {
                ...workingDeps(),
                routeQuery: async input => ({
                    ok: true,
                    args: input.args,
                    intent: {
                        kind: "select",
                        tables: ["messages"],
                        partitionKey: {
                            table: "messages",
                            column: "organization_id",
                            values: [...routed.values],
                        },
                        joinShape: routed.joinShape,
                    },
                    policyDigest: "policy-1",
                    queryHash: "query-1",
                    authority: routed.authority,
                    partitionKey: routed.partitionKey,
                }),
                catalog: {
                    async resolveOrganizationAuthority() {
                        catalogCalls++;
                        return authority;
                    },
                    async route() {
                        catalogCalls++;
                        return { shardId: ShardId("unused"), schemaEpoch: 1, domainSchemaEpoch: 1 };
                    },
                },
            };
            const result = await dispatchTrustedQuery(deps, request);
            expect(result).toMatchObject({
                ok: false,
                error: { code: routed.authority === null ? "CDB_AUTH_NOT_BOUND" : "CDB_CROSS_PARTITION" },
            });
        }
        expect(catalogCalls).toBe(0);
    });

    test("returns stable failures for missing membership and unavailable boundaries", async () => {
        await expect(
            dispatchTrustedQuery(
                {
                    ...workingDeps(),
                    catalog: {
                        async resolveOrganizationAuthority() {
                            return null;
                        },
                        async route() {
                            throw new Error("must not route");
                        },
                    },
                },
                request
            )
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_FORBIDDEN", retryable: false } });

        await expect(
            dispatchTrustedQuery(
                {
                    ...workingDeps(),
                    catalog: {
                        async resolveOrganizationAuthority() {
                            return authority;
                        },
                        async route() {
                            throw new Error("offline");
                        },
                    },
                },
                request
            )
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_CATALOG_UNAVAILABLE", retryable: true } });

        await expect(
            dispatchTrustedQuery(
                {
                    ...workingDeps(),
                    cdb() {
                        return {
                            async query() {
                                throw new Error("offline");
                            },
                        };
                    },
                },
                request
            )
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_SHARD_UNAVAILABLE", retryable: true } });
    });

    test("owns routed arguments across an async Catalog boundary", async () => {
        const mutable = { organizationId: "org-1", limit: 25 };
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>(resolve => {
            release = resolve;
        });
        const routed = new Promise<void>(resolve => {
            started = resolve;
        });
        let observed: RawJson | undefined;
        const deps: TrustedQueryDispatchDeps = {
            ...workingDeps(),
            routeQuery: async () => ({
                ok: true,
                args: mutable,
                intent: {
                    kind: "select",
                    tables: ["messages"],
                    partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
                    joinShape: "colocated",
                },
                policyDigest: "policy-1",
                queryHash: "query-1",
                authority: "organization",
                partitionKey: "org-1",
            }),
            catalog: {
                async resolveOrganizationAuthority() {
                    return authority;
                },
                async route() {
                    started();
                    await held;
                    return { shardId: ShardId("shard-a"), schemaEpoch: 1, domainSchemaEpoch: 1 };
                },
            },
            cdb: () => ({
                async query(input) {
                    observed = input.args;
                    return { ok: true, result: null };
                },
            }),
        };
        const pending = dispatchTrustedQuery(deps, request);
        await routed;
        mutable.organizationId = "org-forged";
        mutable.limit = 999;
        release();
        await expect(pending).resolves.toEqual({ ok: true, result: null });
        expect(observed).toEqual(args);
    });

    test("validates query RPC envelopes without requiring array results", () => {
        expect(projectCdbQueryResponse({ ok: true, result: { count: 3 } })).toEqual({
            ok: true,
            result: { count: 3 },
        });
        expect(projectCdbQueryResponse({ ok: true, result: new Date() })).toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        expect(
            projectCdbQueryResponse({
                ok: false,
                error: new CdbError({ code: "CDB_FORBIDDEN", message: "no membership" }).toJSON(),
            })
        ).toMatchObject({ ok: false, error: { code: "CDB_FORBIDDEN" } });
    });
});
