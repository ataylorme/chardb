import { describe, expect, test } from "bun:test";
import { isCdbError } from "../../src/errors.ts";
import { defineCron, defineMutation, defineQuery } from "../../src/server/define.ts";
import { manifestFromExports, resolveMutation, resolveQuery } from "../../src/server/manifest.ts";
import type { ChardbRef } from "../../src/types.ts";

const createPost = defineMutation<unknown, { authorId: string; body: string }, { id: string }>(
    (_ctx, args) => ({ id: `post-${args.authorId}` }),
    { ref: "api/posts#create", authority: "organization", singlePartition: true, partitionKey: a => a.authorId }
);

const listPosts = defineQuery<unknown, { authorId: string }, readonly { id: string }[]>(async () => []);
const listOrganizationPosts = defineQuery({
    ref: "api/posts#organizationList",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string }) => ({
        kind: "select" as const,
        tables: ["posts"],
        partitionKey: { table: "posts", column: "organization_id", values: [args.organizationId] },
    }),
    handler: async () => [],
});

const nightly = defineCron<unknown, Record<string, never>, void>("0 0 * * *", async () => {});

describe("manifestFromExports", () => {
    test("collects mutations / queries / crons by ref", () => {
        const m = manifestFromExports({ createPost, listPosts, nightly, junk: 42, schema: {} });
        expect(m.mutations.size).toBe(1);
        expect(m.queries.size).toBe(1);
        expect(m.crons).toHaveLength(1);
        const ref = createPost.__chardbRef as ChardbRef;
        const desc = resolveMutation(m, ref);
        expect(desc.singlePartition).toBe(true);
        expect(desc.authority).toBe("organization");
        expect(desc.extractPartitionKey?.({ authorId: "u1", body: "hi" })).toBe("u1");
        expect(desc.invoke({ db: {}, auth: { userId: "u1", claims: {} } }, { authorId: "u1", body: "hi" })).toEqual({
            id: "post-u1",
        });
        expect(m.crons[0]?.cronExpr).toBe("0 0 * * *");
    });

    test("resolveMutation throws CDB_REF_NOT_FOUND for unknown ref", () => {
        const m = manifestFromExports({});
        try {
            resolveMutation(m, "mutation#missing" as ChardbRef);
            throw new Error("expected throw");
        } catch (e) {
            expect(isCdbError(e)).toBe(true);
            if (isCdbError(e)) expect(e.code).toBe("CDB_REF_NOT_FOUND");
        }
    });

    test("rejects distinct functions with the same explicit ref", () => {
        const first = defineMutation({ ref: "api/posts#save", handler: () => null });
        const second = defineMutation({ ref: "api/posts#save", handler: () => null });
        expect(() => manifestFromExports({ first, second })).toThrow("duplicate ref across mutation and mutation");
    });

    test("rejects the same explicit ref across client-addressable kinds", () => {
        const mutation = defineMutation({ ref: "api/posts#shared", handler: () => null });
        const query = defineQuery({ ref: "api/posts#shared", handler: async () => null });
        expect(() => manifestFromExports({ mutation, query })).toThrow("duplicate ref across mutation and query");
    });

    test("preserves organization query authority and partition extraction", () => {
        const manifest = manifestFromExports({ listOrganizationPosts });
        const descriptor = resolveQuery(manifest, listOrganizationPosts.__chardbRef);
        expect(descriptor.authority).toBe("organization");
        expect(descriptor.extractPartitionKey?.({ organizationId: "org-1" })).toBe("org-1");
    });
});
