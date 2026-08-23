import { describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { type TrustedMutationDispatchDeps, dispatchTrustedMutation } from "../../src/server/do/gateway.ts";
import type { CdbMutationRequest, TrustedMutationDispatchRequest } from "../../src/server/rpc.ts";
import { ShardId } from "../../src/types.ts";

const request: TrustedMutationDispatchRequest = {
    mutId: "mut-1",
    ref: "api.ts#createPost",
    args: { organizationId: "org-1", body: "hello" },
    auth: {
        userId: "user-1",
        tenantId: "org-1",
        role: "member",
        roles: ["member"],
        claims: { plan: "pro" },
    },
};

function workingDeps(): TrustedMutationDispatchDeps {
    return {
        routeMutation(input) {
            expect(input).toEqual({ ref: request.ref, args: request.args });
            return { ok: true, vshard: 73 };
        },
        catalog: {
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
                        args: { organizationId: "org-1", body: "hello" },
                        auth: request.auth,
                        schemaEpoch: 9,
                    });
                    return { ok: true, cookie: "cookie-1", ran: true, result: { id: "post-1" }, rowsAffected: 1 };
                },
            };
        },
    };
}

describe("trusted Gateway mutation dispatch", () => {
    test("routes locally, calls Catalog, and derives Cdb principalId from trusted auth.userId", async () => {
        await expect(dispatchTrustedMutation(workingDeps(), request)).resolves.toEqual({
            ok: true,
            cookie: "cookie-1",
            ran: true,
            result: { id: "post-1" },
            rowsAffected: 1,
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
});
