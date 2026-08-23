import { describe, expect, test } from "bun:test";
import { isCdbError } from "../../src/errors.ts";
import { defineCron, defineMutation, defineQuery } from "../../src/server/define.ts";
import { manifestFromExports, resolveMutation } from "../../src/server/manifest.ts";
import type { ChardbRef } from "../../src/types.ts";

const createPost = defineMutation<unknown, { authorId: string; body: string }, { id: string }>(
    (_ctx, args) => ({ id: `post-${args.authorId}` }),
    { singlePartition: true, partitionKey: a => a.authorId }
);

const listPosts = defineQuery<unknown, { authorId: string }, readonly { id: string }[]>(async () => []);

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
        expect(desc.extractPartitionKey?.({ authorId: "u1", body: "hi" })).toBe("u1");
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
});
