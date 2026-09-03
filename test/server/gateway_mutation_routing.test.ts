import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CdbError } from "../../src/errors.ts";
import { defineMutation } from "../../src/server/define.ts";
import {
    type TrustedMutationDispatchDeps,
    dispatchTrustedMutation,
    projectCdbMutationResponse,
    projectOrganizationMutationAuth,
    projectUserMutationAuth,
} from "../../src/server/do/gateway-auth-dispatch.ts";
import { cdbSubscriptionRequest, gatewayErrorEnvelope } from "../../src/server/do/gateway.ts";
import { manifestFromExports, routeMutation } from "../../src/server/manifest.ts";
import { CDB_JSON_MAX_AGGREGATE_MEMBERS, CDB_MUTATION_ARGS_MAX_DEPTH } from "../../src/server/result_limits.ts";
import type {
    CdbMutationRequest,
    MutationRouteResponse,
    TrustedMutationDispatchRequest,
} from "../../src/server/rpc.ts";
import {
    ChardbRef,
    ClientId,
    CorrelationId,
    PrincipalId,
    type RawJson,
    ShardId,
    SubId,
    TenantId,
} from "../../src/types.ts";
import { VSHARD_COUNT, vshardOf } from "../../src/vshard.ts";
import { decodeWire, encodeWire } from "../../src/wire.ts";

const request: TrustedMutationDispatchRequest = {
    mutId: "mut-1",
    ref: "api.ts#createPost",
    args: { organizationId: "org-1", body: "hello", role: "owner", claims: { plan: "forged" } },
    principalId: PrincipalId("user-1"),
};

const authority = {
    recoveryGeneration: 0,
    principalId: PrincipalId("user-1"),
    organizationId: TenantId("org-1"),
    role: "admin,member",
    roles: ["admin", "member"],
    userRole: "admin,user",
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
                return {
                    shardId: ShardId("shard-a"),
                    schemaEpoch: 9,
                    domainSchemaEpoch: 1,
                    recoveryGeneration: 0,
                };
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
                        placement: { authority: "organization", partitionKey: "org-1" },
                        auth: {
                            userId: "user-1",
                            tenantId: "org-1",
                            role: "admin,member",
                            roles: ["admin", "member"],
                            authEpochs: { global: 2, tenant: 3, principal: 4 },
                            claims: { userRole: "admin,user" },
                        },
                        schemaEpoch: 9,
                        recoveryGeneration: 0,
                        domainSchemaEpoch: 1,
                    });
                    return { ok: true, cookie: "cookie-1", ran: true, result: { id: "post-1" }, rowsAffected: 1 };
                },
            };
        },
    };
}

function nestedArray(depth: number): RawJson {
    let value: RawJson = null;
    for (let level = 0; level < depth; level++) value = [value];
    return value;
}

describe("trusted Gateway mutation dispatch", () => {
    test("refreshes Catalog authority and placement once after a typed stale-route response", async () => {
        const attempts: CdbMutationRequest[] = [];
        let catalogCalls = 0;
        const result = await dispatchTrustedMutation(
            {
                routeMutation: workingDeps().routeMutation,
                catalog: {
                    async resolveOrganizationAuthority() {
                        throw new Error("combined authority-route RPC must be used");
                    },
                    async route() {
                        throw new Error("combined authority-route RPC must be used");
                    },
                    async resolveOrganizationAuthorityRoute() {
                        catalogCalls += 1;
                        return {
                            authority: {
                                ...authority,
                                role: catalogCalls === 1 ? "member" : "admin",
                                roles: [catalogCalls === 1 ? "member" : "admin"],
                            },
                            route: {
                                shardId: ShardId(catalogCalls === 1 ? "source" : "destination"),
                                schemaEpoch: catalogCalls,
                                domainSchemaEpoch: 1,
                                recoveryGeneration: 0,
                            },
                        };
                    },
                },
                cdb: shardId => ({
                    mutate(input) {
                        attempts.push(input);
                        return shardId === "source"
                            ? {
                                  ok: false,
                                  error: new CdbError({
                                      code: "CDB_STALE_EPOCH",
                                      message: "source cut over",
                                  }).toJSON(),
                              }
                            : { ok: true, cookie: "destination-cookie", ran: true, result: "done", rowsAffected: 1 };
                    },
                }),
            },
            request
        );

        expect(result).toMatchObject({ ok: true, cookie: "destination-cookie" });
        expect(catalogCalls).toBe(2);
        expect(attempts).toHaveLength(2);
        expect(attempts.map(attempt => [attempt.mutId, attempt.args, attempt.schemaEpoch, attempt.auth.role])).toEqual([
            [request.mutId, request.args, 1, "member"],
            [request.mutId, request.args, 2, "admin"],
        ]);
    });

    test("stops after two stale attempts and never retries terminal or unavailable Cdb failures", async () => {
        const stale = new CdbError({ code: "CDB_STALE_EPOCH", message: "still stale" }).toJSON();
        let staleCalls = 0;
        const staleResult = await dispatchTrustedMutation(
            {
                ...workingDeps(),
                cdb: () => ({
                    mutate() {
                        staleCalls += 1;
                        return { ok: false, error: stale };
                    },
                }),
            },
            request
        );
        expect(staleResult).toEqual({ ok: false, error: stale });
        expect(staleCalls).toBe(2);

        for (const failure of [
            { kind: "terminal", response: new CdbError({ code: "CDB_FORBIDDEN", message: "denied" }).toJSON() },
            { kind: "unavailable", response: null },
        ] as const) {
            let calls = 0;
            const result = await dispatchTrustedMutation(
                {
                    ...workingDeps(),
                    cdb: () => ({
                        mutate() {
                            calls += 1;
                            if (failure.response === null) throw new Error("offline");
                            return { ok: false, error: failure.response };
                        },
                    }),
                },
                request
            );
            expect(result).toMatchObject({
                ok: false,
                error: { code: failure.kind === "terminal" ? "CDB_FORBIDDEN" : "CDB_SHARD_UNAVAILABLE" },
            });
            expect(calls).toBe(1);
        }
    });

    test("uses one Catalog RPC for organization authority and placement", async () => {
        const base = workingDeps();
        let combinedCalls = 0;
        const result = await dispatchTrustedMutation(
            {
                ...base,
                catalog: {
                    async resolveOrganizationAuthority() {
                        throw new Error("legacy authority RPC must not run");
                    },
                    async route() {
                        throw new Error("legacy route RPC must not run");
                    },
                    async resolveOrganizationAuthorityRoute(input) {
                        combinedCalls += 1;
                        expect(input).toEqual({
                            principalId: PrincipalId("user-1"),
                            organizationId: TenantId("org-1"),
                            vshard: 73,
                        });
                        return {
                            authority,
                            route: {
                                shardId: ShardId("shard-a"),
                                schemaEpoch: 9,
                                domainSchemaEpoch: 1,
                                recoveryGeneration: 0,
                            },
                        };
                    },
                },
            },
            request
        );

        expect(result).toMatchObject({ ok: true });
        expect(combinedCalls).toBe(1);
    });

    test("preserves the retryable migration fence from the combined Catalog boundary", async () => {
        const base = workingDeps();
        let cdbCalls = 0;
        const result = await dispatchTrustedMutation(
            {
                ...base,
                catalog: {
                    async resolveOrganizationAuthority() {
                        throw new Error("legacy authority RPC must not run");
                    },
                    async route() {
                        throw new Error("legacy route RPC must not run");
                    },
                    async resolveOrganizationAuthorityRoute() {
                        throw new CdbError({
                            code: "CDB_STALE_EPOCH",
                            message: "schema migration deploy-7 is in progress",
                        });
                    },
                },
                cdb() {
                    cdbCalls += 1;
                    return base.cdb("shard-a");
                },
            },
            request
        );

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "CDB_STALE_EPOCH",
                retryable: true,
                message: "schema migration deploy-7 is in progress",
            },
        });
        expect(cdbCalls).toBe(0);
    });

    test("builds the selected Cdb request from query ref, raw args, and server intent", () => {
        expect(
            cdbSubscriptionRequest({
                gatewayId: "gateway-do-7",
                registrationId: "registration-9",
                connectionId: "connection-5",
                clientId: ClientId("client-3"),
                subId: SubId(4),
                principalId: PrincipalId("user-1"),
                organizationId: TenantId("org-1"),
                schemaEpoch: 7,
                recoveryGeneration: 0,
                vshard: 19,
                domainSchemaEpoch: 1,
                ref: ChardbRef("queries.ts#listMessages"),
                args: { organizationId: "org-1", channelId: "channel-1" },
                queryHash: "query-hash-1",
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
            organizationId: TenantId("org-1"),
            schemaEpoch: 7,
            recoveryGeneration: 0,
            vshard: 19,
            domainSchemaEpoch: 1,
            ref: ChardbRef("queries.ts#listMessages"),
            args: { organizationId: "org-1", channelId: "channel-1" },
            queryHash: "query-hash-1",
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

    test("binds user mutations to the verified subject and current Catalog user", async () => {
        const userRequest: TrustedMutationDispatchRequest = {
            principalId: PrincipalId("user-1"),
            mutId: "user-mut-1",
            ref: "api/preferences#save",
            args: { userId: "user-1", theme: "dark" },
        };
        const deps: TrustedMutationDispatchDeps = {
            routeMutation: input => ({
                ok: true,
                vshard: Number(vshardOf(["user-1"])),
                authority: "user",
                partitionKey: "user-1",
                args: input.args,
            }),
            catalog: {
                resolveOrganizationAuthority: async () => null,
                resolveUserAuthority: async input => ({
                    principalId: input.principalId,
                    role: "admin,user",
                    roles: ["admin", "user"],
                    authEpochs: { global: 5, tenant: 0, principal: 8 },
                    recoveryGeneration: 0,
                }),
                route: async () => ({
                    shardId: ShardId("user-shard"),
                    schemaEpoch: 2,
                    domainSchemaEpoch: 3,
                    recoveryGeneration: 0,
                }),
            },
            cdb: () => ({
                mutate: async input => {
                    expect(input.auth).toEqual({
                        userId: "user-1",
                        role: "admin,user",
                        roles: ["admin", "user"],
                        authEpochs: { global: 5, tenant: 0, principal: 8 },
                        claims: {},
                    });
                    return { ok: true, cookie: "user-cookie", ran: true, result: null, rowsAffected: 1 };
                },
            }),
        };

        await expect(dispatchTrustedMutation(deps, userRequest)).resolves.toMatchObject({ ok: true, ran: true });
        const forgedDeps: TrustedMutationDispatchDeps = {
            ...deps,
            routeMutation: input => ({
                ok: true,
                vshard: Number(vshardOf(["user-2"])),
                authority: "user",
                partitionKey: "user-2",
                args: input.args,
            }),
        };
        await expect(dispatchTrustedMutation(forgedDeps, userRequest)).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_FORBIDDEN" },
        });
    });

    test("routes a global partition with fresh user authority", async () => {
        const deps: TrustedMutationDispatchDeps = {
            routeMutation: input => ({
                ok: true,
                vshard: Number(vshardOf(["settings-v1"])),
                authority: "global",
                partitionKey: "settings-v1",
                args: input.args,
            }),
            catalog: {
                resolveOrganizationAuthority: async () => null,
                resolveUserAuthority: async input => ({
                    principalId: input.principalId,
                    role: "admin",
                    roles: ["admin"],
                    authEpochs: { global: 9, tenant: 0, principal: 4 },
                    recoveryGeneration: 0,
                }),
                route: async () => ({
                    shardId: ShardId("global-shard"),
                    schemaEpoch: 3,
                    domainSchemaEpoch: 2,
                    recoveryGeneration: 0,
                }),
            },
            cdb: () => ({
                mutate: async input => {
                    expect(input.placement).toEqual({ authority: "global", partitionKey: "settings-v1" });
                    expect(input.auth).toEqual({
                        userId: "user-1",
                        role: "admin",
                        roles: ["admin"],
                        authEpochs: { global: 9, tenant: 0, principal: 4 },
                        claims: {},
                    });
                    return { ok: true, cookie: "global-cookie", ran: true, result: null, rowsAffected: 1 };
                },
            }),
        };

        await expect(
            dispatchTrustedMutation(deps, {
                principalId: PrincipalId("user-1"),
                mutId: "global-mut-1",
                ref: "api/settings#save",
                args: { partition: "settings-v1", value: "on" },
            })
        ).resolves.toMatchObject({ ok: true, ran: true });
    });

    test("validates user authority envelopes before shard dispatch", () => {
        expect(
            projectUserMutationAuth(
                {
                    recoveryGeneration: 0,
                    principalId: PrincipalId("user-1"),
                    role: "user",
                    roles: ["user"],
                    authEpochs: { global: 1, tenant: 0, principal: 2 },
                },
                { principalId: PrincipalId("user-1") }
            )
        ).toMatchObject({ ok: true, auth: { userId: "user-1" } });
        expect(
            projectUserMutationAuth(
                {
                    recoveryGeneration: 0,
                    principalId: PrincipalId("user-2"),
                    role: "user",
                    roles: ["user"],
                    authEpochs: { global: 1, tenant: 0, principal: 2 },
                },
                { principalId: PrincipalId("user-1") }
            )
        ).toMatchObject({ ok: false, code: "CDB_FORBIDDEN" });
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
                    return {
                        shardId: ShardId("shard-a"),
                        schemaEpoch: 1,
                        domainSchemaEpoch: 1,
                        recoveryGeneration: 0,
                    };
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

    test("rejects hostile argument structure before local routing or any RPC", async () => {
        let localRoutes = 0;
        let catalogCalls = 0;
        let cdbCalls = 0;
        const deps: TrustedMutationDispatchDeps = {
            routeMutation: () => {
                localRoutes += 1;
                return { ok: false, error: new CdbError({ code: "CDB_INVALID_ARGS", message: "unused" }).toJSON() };
            },
            catalog: {
                async resolveOrganizationAuthority() {
                    catalogCalls += 1;
                    return authority;
                },
                async route() {
                    catalogCalls += 1;
                    return {
                        shardId: ShardId("unused"),
                        schemaEpoch: 1,
                        domainSchemaEpoch: 1,
                        recoveryGeneration: 0,
                    };
                },
            },
            cdb: () => {
                cdbCalls += 1;
                throw new Error("Cdb must not be selected");
            },
        };

        for (const args of [
            Array.from({ length: CDB_JSON_MAX_AGGREGATE_MEMBERS + 1 }, () => null),
            nestedArray(CDB_MUTATION_ARGS_MAX_DEPTH + 1),
        ] satisfies RawJson[]) {
            await expect(dispatchTrustedMutation(deps, { ...request, args })).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_INVALID_ARGS", retryable: false },
            });
        }
        expect({ localRoutes, catalogCalls, cdbCalls }).toEqual({ localRoutes: 0, catalogCalls: 0, cdbCalls: 0 });
    });

    test("rejects oversized custom-route output before Catalog or Cdb work", async () => {
        let catalogCalls = 0;
        let cdbCalls = 0;
        const deps: TrustedMutationDispatchDeps = {
            routeMutation: () => ({
                ok: true,
                vshard: 73,
                authority: "organization",
                partitionKey: "org-1",
                args: { value: "x".repeat(512 * 1_024) },
            }),
            catalog: {
                async resolveOrganizationAuthority() {
                    catalogCalls += 1;
                    return authority;
                },
                async route() {
                    catalogCalls += 1;
                    return {
                        shardId: ShardId("unused"),
                        schemaEpoch: 1,
                        domainSchemaEpoch: 1,
                        recoveryGeneration: 0,
                    };
                },
            },
            cdb: () => {
                cdbCalls += 1;
                throw new Error("Cdb must not be selected");
            },
        };
        await expect(dispatchTrustedMutation(deps, request)).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVALID_ARGS", retryable: false },
        });
        expect({ catalogCalls, cdbCalls }).toEqual({ catalogCalls: 0, cdbCalls: 0 });
    });

    test("rejects invalid custom-route vshards before external work", async () => {
        let catalogCalls = 0;
        let cdbCalls = 0;
        for (const vshard of [-1, 0.5, VSHARD_COUNT]) {
            const deps: TrustedMutationDispatchDeps = {
                routeMutation: input => ({
                    ok: true,
                    vshard,
                    authority: "organization",
                    partitionKey: "org-1",
                    args: input.args,
                }),
                catalog: {
                    async resolveOrganizationAuthority() {
                        catalogCalls += 1;
                        return authority;
                    },
                    async route() {
                        catalogCalls += 1;
                        return {
                            shardId: ShardId("unused"),
                            schemaEpoch: 1,
                            domainSchemaEpoch: 1,
                            recoveryGeneration: 0,
                        };
                    },
                },
                cdb: () => {
                    cdbCalls += 1;
                    throw new Error("Cdb must not be selected");
                },
            };
            await expect(dispatchTrustedMutation(deps, request)).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_INVARIANT", retryable: false },
            });
        }
        expect({ catalogCalls, cdbCalls }).toEqual({ catalogCalls: 0, cdbCalls: 0 });
    });

    test("keeps the routed result and projected auth stable while Catalog routing is held", async () => {
        let releaseRoute!: () => void;
        let routeStarted!: () => void;
        const started = new Promise<void>(resolve => {
            routeStarted = resolve;
        });
        const held = new Promise<void>(resolve => {
            releaseRoute = resolve;
        });
        const routeArgs = { organizationId: "org-1", body: "original" };
        const routed = {
            ok: true,
            vshard: 73,
            authority: "organization",
            partitionKey: "org-1",
            args: routeArgs,
        } as Extract<MutationRouteResponse, { readonly ok: true }>;
        const mutableRouted = routed as {
            ok: true;
            vshard: number;
            authority: "organization" | null;
            partitionKey: string | null;
            args: RawJson;
        };
        const authorityResponse = {
            ...authority,
            roles: [...authority.roles] as string[],
            authEpochs: {
                global: Number(authority.authEpochs.global),
                tenant: Number(authority.authEpochs.tenant),
                principal: Number(authority.authEpochs.principal),
            },
        };
        let cdbArgs: RawJson | undefined;
        let cdbAuth: CdbMutationRequest["auth"] | undefined;
        const deps: TrustedMutationDispatchDeps = {
            routeMutation: () => routed,
            catalog: {
                async resolveOrganizationAuthority() {
                    return authorityResponse;
                },
                async route(vshard) {
                    expect(vshard).toBe(73);
                    routeStarted();
                    await held;
                    return {
                        shardId: ShardId("shard-a"),
                        schemaEpoch: 9,
                        domainSchemaEpoch: 1,
                        recoveryGeneration: 0,
                    };
                },
            },
            cdb: () => ({
                mutate(input) {
                    cdbArgs = input.args;
                    cdbAuth = input.auth;
                    return { ok: true, cookie: "cookie-owned", ran: true, result: null, rowsAffected: 0 };
                },
            }),
        };
        const pending = dispatchTrustedMutation(deps, request);
        await started;
        routeArgs.organizationId = "org-mutated";
        routeArgs.body = "mutated";
        Object.assign(routeArgs, { oversized: "x".repeat(512 * 1_024) });
        mutableRouted.vshard = 99;
        mutableRouted.authority = null;
        mutableRouted.partitionKey = "org-mutated";
        mutableRouted.args = { organizationId: "org-mutated", body: "replaced" };
        authorityResponse.roles.splice(0, authorityResponse.roles.length, "mutated");
        authorityResponse.authEpochs.global = 99;
        releaseRoute();
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(cdbArgs).toEqual({ organizationId: "org-1", body: "original" });
        expect(cdbAuth).toEqual({
            userId: "user-1",
            tenantId: "org-1",
            role: "admin,member",
            roles: ["admin", "member"],
            authEpochs: { global: 2, tenant: 3, principal: 4 },
            claims: { userRole: "admin,user" },
        });
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
        const { recoveryGeneration: _generation, ...missingGeneration } = authority;
        let getterCalls = 0;
        const accessorGeneration = Object.defineProperty({ ...missingGeneration }, "recoveryGeneration", {
            enumerable: true,
            get() {
                getterCalls++;
                return 0;
            },
        });
        for (const malformed of [
            [],
            missingGeneration,
            { ...authority, recoveryGeneration: -1 },
            { ...authority, recoveryGeneration: 0.5 },
            accessorGeneration,
            { ...authority, roles: "member" },
            { ...authority, userRole: "" },
            { ...authority, userRole: ["admin"] },
            { ...authority, authEpochs: { global: 1, tenant: Number.NaN, principal: 1 } },
        ]) {
            expect(projectOrganizationMutationAuth(malformed, expected)).toMatchObject({
                ok: false,
                code: "CDB_CATALOG_UNAVAILABLE",
            });
        }
        expect(getterCalls).toBe(0);
    });

    test("keeps membership and user roles in separate policy namespaces", () => {
        const expected = { principalId: PrincipalId("user-1"), organizationId: TenantId("org-1") };
        expect(projectOrganizationMutationAuth(authority, expected)).toMatchObject({
            ok: true,
            auth: {
                role: "admin,member",
                roles: ["admin", "member"],
                claims: { userRole: "admin,user" },
            },
        });
        expect(projectOrganizationMutationAuth({ ...authority, userRole: undefined }, expected)).toMatchObject({
            ok: true,
            auth: { role: "admin,member", roles: ["admin", "member"], claims: {} },
        });
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
                    return {
                        shardId: ShardId("shard-a"),
                        schemaEpoch: 9,
                        domainSchemaEpoch: 1,
                        recoveryGeneration: 0,
                    };
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
