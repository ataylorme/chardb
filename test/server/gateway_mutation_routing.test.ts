import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CdbError } from "../../src/errors.ts";
import { defineMutation } from "../../src/server/define.ts";
import {
    type TrustedMutationDispatchDeps,
    cdbSubscriptionRequest,
    dispatchTrustedMutation,
    gatewayErrorEnvelope,
    projectCdbMutationResponse,
    projectOrganizationMutationAuth,
} from "../../src/server/do/gateway.ts";
import { manifestFromExports, routeMutation } from "../../src/server/manifest.ts";
import type { CdbMutationRequest, TrustedMutationDispatchRequest } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, CorrelationId, PrincipalId, ShardId, SubId, TenantId } from "../../src/types.ts";
import { vshardOf } from "../../src/vshard.ts";
import { decodeWire, encodeWire } from "../../src/wire.ts";

const request: TrustedMutationDispatchRequest = {
    mutId: "mut-1",
    ref: "api.ts#createPost",
    args: { organizationId: "org-1", body: "hello", role: "owner", claims: { plan: "forged" } },
    principalId: PrincipalId("user-1"),
};

const authority = {
    principalId: PrincipalId("user-1"),
    organizationId: TenantId("org-1"),
    role: "admin,member",
    roles: ["admin", "member"],
    authEpochs: { global: 2, tenant: 3, principal: 4 },
} as const;

function workingDeps(): TrustedMutationDispatchDeps {
    return {
        routeMutation(input) {
            expect(input).toEqual({ ref: request.ref, args: request.args });
            return {
                ok: true,
                vshard: 73,
                authority: "organization",
                partitionKey: "org-1",
                args: input.args,
            };
        },
        catalog: {
            async resolveOrganizationAuthority(input) {
                expect(input).toEqual({ principalId: PrincipalId("user-1"), organizationId: TenantId("org-1") });
                return authority;
            },
            async route(vshard) {
                expect(vshard).toBe(73);
                return { shardId: ShardId("shard-a"), schemaEpoch: 9 };
            },
        },
        cdb(shardId) {
            expect(shardId).toBe("shard-a");
            return {
                mutate(input) {
                    expect(input).toEqual<CdbMutationRequest>({
                        principalId: "user-1",
                        mutId: "mut-1",
                        ref: "api.ts#createPost",
                        args: request.args,
                        auth: {
                            userId: "user-1",
                            tenantId: "org-1",
                            role: "admin,member",
                            roles: ["admin", "member"],
                            authEpochs: { global: 2, tenant: 3, principal: 4 },
                            claims: {},
                        },
                        schemaEpoch: 9,
                    });
                    return { ok: true, cookie: "cookie-1", ran: true, result: { id: "post-1" }, rowsAffected: 1 };
                },
            };
        },
    };
}

describe("trusted Gateway mutation dispatch", () => {
    test("builds the selected Cdb request from query ref, raw args, and server intent", () => {
        expect(
            cdbSubscriptionRequest({
                gatewayId: "gateway-do-7",
                registrationId: "registration-9",
                connectionId: "connection-5",
                clientId: ClientId("client-3"),
                subId: SubId(4),
                principalId: PrincipalId("user-1"),
                ref: ChardbRef("queries.ts#listMessages"),
                args: { organizationId: "org-1", channelId: "channel-1" },
                intent: {
                    kind: "select",
                    tables: ["messages"],
                    intervals: [{ table: "messages", indexName: "by_channel", intervals: [{ kind: "full" }] }],
                },
            })
        ).toEqual({
            subscription: {
                gatewayId: "gateway-do-7",
                registrationId: "registration-9",
                connectionId: "connection-5",
                clientId: ClientId("client-3"),
                subId: SubId(4),
            },
            principalId: PrincipalId("user-1"),
            ref: ChardbRef("queries.ts#listMessages"),
            args: { organizationId: "org-1", channelId: "channel-1" },
            tables: ["messages"],
            intervals: [{ table: "messages", indexName: "by_channel", intervals: [{ kind: "full" }] }],
        });
    });

    test("Gateway error envelopes use locked retryability and pass strict decoding", () => {
        const retryable = gatewayErrorEnvelope("CDB_SHARD_UNAVAILABLE", CorrelationId("corr-1"), SubId(7));
        expect(retryable).toMatchObject({ retryable: true, docs: "https://chardb.dev/errors/cdb_shard_unavailable" });
        expect(decodeWire(encodeWire(retryable))).toEqual(retryable);

        const terminal = gatewayErrorEnvelope("CDB_UNSUPPORTED_FEATURE", CorrelationId("corr-2"));
        expect(terminal).toMatchObject({ retryable: false, docs: "https://chardb.dev/errors/cdb_unsupported_feature" });
        expect(decodeWire(encodeWire(terminal))).toEqual(terminal);
    });

    test("derives organization authority and epochs from Catalog while ignoring spoofed args", async () => {
        await expect(dispatchTrustedMutation(workingDeps(), request)).resolves.toEqual({
            ok: true,
            cookie: "cookie-1",
            ran: true,
            result: { id: "post-1" },
            rowsAffected: 1,
        });
    });

    test("forwards the exact transformed args and makes no RPC for invalid raw args", async () => {
        const mutation = defineMutation({
            ref: "api/normalized#create",
            args: z.object({
                organizationId: z
                    .string()
                    .trim()
                    .transform(value => `org:${value}`),
                body: z.string().min(1).default("default"),
            }),
            authority: "organization",
            partitionKey: "organizationId",
            handler: () => null,
        });
        const manifest = manifestFromExports({ mutation });
        let authorityCalls = 0;
        let routeCalls = 0;
        let cdbCalls = 0;
        const deps: TrustedMutationDispatchDeps = {
            routeMutation: input => routeMutation(manifest, input, vshardOf),
            catalog: {
                async resolveOrganizationAuthority(input) {
                    authorityCalls++;
                    expect(input.organizationId).toBe(TenantId("org:7"));
                    return { ...authority, organizationId: TenantId("org:7") };
                },
                async route() {
                    routeCalls++;
                    return { shardId: ShardId("shard-a"), schemaEpoch: 1 };
                },
            },
            cdb: () => ({
                mutate(input) {
                    cdbCalls++;
                    expect(input.args).toEqual({ organizationId: "org:7", body: "default" });
                    return { ok: true, cookie: "cookie", ran: true, result: null, rowsAffected: 0 };
                },
            }),
        };

        await expect(
            dispatchTrustedMutation(deps, {
                principalId: PrincipalId("user-1"),
                mutId: "transformed",
                ref: mutation.__chardbRef,
                args: { organizationId: " 7 " },
            })
        ).resolves.toMatchObject({ ok: true });
        expect({ authorityCalls, routeCalls, cdbCalls }).toEqual({ authorityCalls: 1, routeCalls: 1, cdbCalls: 1 });

        const invalid = await dispatchTrustedMutation(deps, {
            principalId: PrincipalId("user-1"),
            mutId: "invalid",
            ref: mutation.__chardbRef,
            args: { organizationId: "7", body: "" },
        });
        expect(invalid).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS" } });
        expect({ authorityCalls, routeCalls, cdbCalls }).toEqual({ authorityCalls: 1, routeCalls: 1, cdbCalls: 1 });
    });

    test("preserves a typed local routing rejection", async () => {
        const error = new CdbError({ code: "CDB_INVALID_ARGS", message: "bad partition args" }).toJSON();
        const deps: TrustedMutationDispatchDeps = {
            ...workingDeps(),
            routeMutation: () => ({ ok: false, error }),
        };
        await expect(dispatchTrustedMutation(deps, request)).resolves.toEqual({ ok: false, error });
    });

    test("settles an unexpected local routing exception as an invariant wire error", async () => {
        const deps: TrustedMutationDispatchDeps = {
            ...workingDeps(),
            routeMutation: () => {
                throw new Error("broken manifest");
            },
        };
        const result = await dispatchTrustedMutation(deps, request);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ code: "CDB_INVARIANT", retryable: false });
    });

    test("settles a thrown Catalog RPC as a retryable wire error", async () => {
        const deps = workingDeps();
        deps.catalog.route = async () => {
            throw new Error("catalog unavailable");
        };
        const result = await dispatchTrustedMutation(deps, request);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ code: "CDB_CATALOG_UNAVAILABLE", retryable: true });
    });

    test("rejects missing membership and never calls Cdb", async () => {
        const base = workingDeps();
        let selectedCdb = false;
        const deps: TrustedMutationDispatchDeps = {
            ...base,
            catalog: { ...base.catalog, resolveOrganizationAuthority: async () => null },
            cdb: () => {
                selectedCdb = true;
                throw new Error("Cdb must not be selected");
            },
        };
        const result = await dispatchTrustedMutation(deps, request);
        expect(result).toMatchObject({ ok: false, error: { code: "CDB_FORBIDDEN" } });
        expect(selectedCdb).toBe(false);
    });

    test("rejects revoked membership with no current role", async () => {
        const deps = workingDeps();
        deps.catalog.resolveOrganizationAuthority = async () => ({ ...authority, role: "", roles: [] });
        const result = await dispatchTrustedMutation(deps, request);
        expect(result).toMatchObject({ ok: false, error: { code: "CDB_FORBIDDEN" } });
    });

    test("rejects malformed Catalog authority without throwing", () => {
        const expected = { principalId: PrincipalId("user-1"), organizationId: TenantId("org-1") };
        for (const malformed of [
            [],
            { ...authority, roles: "member" },
            { ...authority, authEpochs: { global: 1, tenant: Number.NaN, principal: 1 } },
        ]) {
            expect(projectOrganizationMutationAuth(malformed, expected)).toMatchObject({
                ok: false,
                code: "CDB_CATALOG_UNAVAILABLE",
            });
        }
    });

    test("authorization linearizes at the Catalog read and later revocation affects the next mutation", async () => {
        const deps = workingDeps();
        let currentMembership: typeof authority | null = authority;
        deps.catalog.resolveOrganizationAuthority = async () => {
            const snapshot = currentMembership;
            currentMembership = null;
            return snapshot;
        };

        await expect(dispatchTrustedMutation(deps, request)).resolves.toMatchObject({ ok: true });
        await expect(dispatchTrustedMutation(deps, { ...request, mutId: "mut-after-revoke" })).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_FORBIDDEN" },
        });
    });

    test("uses the extracted organization path instead of a spoofed sibling selector", async () => {
        const base = workingDeps();
        const deps: TrustedMutationDispatchDeps = {
            ...base,
            routeMutation: () => ({
                ok: true,
                vshard: 74,
                authority: "organization",
                partitionKey: "org-from-path",
                args: { organizationId: "spoofed-org", route: { organizationId: "org-from-path" } },
            }),
            catalog: {
                ...base.catalog,
                async resolveOrganizationAuthority(input) {
                    expect(input.organizationId).toBe(TenantId("org-from-path"));
                    return {
                        ...authority,
                        organizationId: TenantId("org-from-path"),
                    };
                },
                async route(vshard) {
                    expect(vshard).toBe(74);
                    return { shardId: ShardId("shard-a"), schemaEpoch: 9 };
                },
            },
            cdb: () => ({
                mutate(input) {
                    expect(input.auth.tenantId).toBe("org-from-path");
                    return { ok: true, cookie: "cookie-path", ran: true, result: null, rowsAffected: 0 };
                },
            }),
        };
        await expect(
            dispatchTrustedMutation(deps, {
                ...request,
                args: { organizationId: "spoofed-org", route: { organizationId: "org-from-path" } },
            })
        ).resolves.toMatchObject({ ok: true });
    });

    test("rejects Catalog authority selector mismatches", async () => {
        const deps = workingDeps();
        deps.catalog.resolveOrganizationAuthority = async () => ({
            ...authority,
            organizationId: TenantId("other-org"),
        });
        const result = await dispatchTrustedMutation(deps, request);
        expect(result).toMatchObject({ ok: false, error: { code: "CDB_FORBIDDEN" } });
    });

    test("settles a thrown organization authority RPC as Catalog unavailable", async () => {
        const deps = workingDeps();
        deps.catalog.resolveOrganizationAuthority = async () => {
            throw new Error("Catalog unavailable");
        };
        const result = await dispatchTrustedMutation(deps, request);
        expect(result).toMatchObject({ ok: false, error: { code: "CDB_CATALOG_UNAVAILABLE", retryable: true } });
    });

    test("keeps mutations without an authority declaration closed", async () => {
        const base = workingDeps();
        const deps: TrustedMutationDispatchDeps = {
            ...base,
            routeMutation: input => ({
                ok: true,
                vshard: 73,
                authority: null,
                partitionKey: "org-1",
                args: input.args,
            }),
            catalog: {
                ...base.catalog,
                resolveOrganizationAuthority: async () => {
                    throw new Error("Catalog must not resolve membership");
                },
            },
        };
        const result = await dispatchTrustedMutation(deps, request);
        expect(result).toMatchObject({ ok: false, error: { code: "CDB_AUTH_NOT_BOUND" } });
    });

    test("settles a thrown Cdb RPC as a retryable wire error", async () => {
        const deps: TrustedMutationDispatchDeps = {
            ...workingDeps(),
            cdb: () => ({
                mutate() {
                    throw new Error("shard unavailable");
                },
            }),
        };
        const result = await dispatchTrustedMutation(deps, request);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ code: "CDB_SHARD_UNAVAILABLE", retryable: true });
    });

    test("preserves a typed Cdb rejection and its non-retryable polarity", async () => {
        const error = new CdbError({ code: "CDB_MUT_ID_COLLISION", message: "collision" }).toJSON();
        const deps: TrustedMutationDispatchDeps = {
            ...workingDeps(),
            cdb: () => ({ mutate: () => ({ ok: false, error }) }),
        };
        await expect(dispatchTrustedMutation(deps, request)).resolves.toEqual({ ok: false, error });
    });

    test("projects malformed Cdb responses to a terminal invariant failure", async () => {
        for (const malformed of [
            null,
            {},
            { ok: true },
            { ok: false },
            { ok: true, cookie: "", ran: true, result: null, rowsAffected: 0 },
            { ok: true, cookie: "c", ran: true, result: undefined, rowsAffected: 0 },
        ]) {
            expect(projectCdbMutationResponse(malformed)).toMatchObject({
                ok: false,
                error: { code: "CDB_INVARIANT", retryable: false },
            });
        }

        const deps: TrustedMutationDispatchDeps = {
            ...workingDeps(),
            cdb: () => ({ mutate: () => null as never }),
        };
        await expect(dispatchTrustedMutation(deps, request)).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
    });
});
