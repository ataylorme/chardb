import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { text } from "drizzle-orm/sqlite-core";
import { isCdbError } from "../../src/errors.ts";
import { globalScope } from "../../src/server/cdb-tenant.ts";
import { createApi, defineCron, defineMutation, defineQuery } from "../../src/server/define.ts";
import {
    manifestFromExports,
    resolveMutation,
    resolveQuery,
    routeMutation,
    routeValidatedQuery,
} from "../../src/server/manifest.ts";
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

    test("preserves and routes a runtime-compiled query plan", () => {
        const { cdbTable } = globalScope();
        const rows = cdbTable(
            "manifest_planned_rows",
            { id: text("id").primaryKey(), scope: text("scope").notNull() },
            { partitionBy: "scope", roles: { user: { read: "*" } } }
        );
        const query = createApi({ rows }).query({
            ref: "api/manifest#planned",
            query: (db, args: { scope: string }) =>
                db.select().from(rows).where(eq(rows.scope, args.scope)).orderBy(rows.id).limit(10),
        });
        const manifest = manifestFromExports({ query });
        expect(resolveQuery(manifest, query.__chardbRef).compilePlan).toBeDefined();
        const route = routeValidatedQuery(
            manifest,
            { ref: query.__chardbRef, args: { scope: "shared" } },
            () => "policy"
        );
        expect(route).toMatchObject({ authority: "global", partitionKey: "shared" });
        expect(route.queryHash).toContain("planHash");
    });

    test("preserves and routes global mutation and query placement", () => {
        const mutation = defineMutation({
            ref: "api/settings#save",
            authority: "global",
            partitionKey: (args: { partition: string }) => args.partition,
            handler: () => null,
        });
        const query = defineQuery({
            ref: "api/settings#read",
            authority: "global",
            partitionKey: (args: { partition: string }) => args.partition,
            intent: (args: { partition: string }) => ({
                kind: "select",
                tables: ["settings"],
                partitionKey: { table: "settings", column: "partition", values: [args.partition] },
            }),
            handler: async () => [],
        });
        const manifest = manifestFromExports({ mutation, query });

        const mutationRoute = routeMutation(
            manifest,
            { ref: mutation.__chardbRef, args: { partition: "app" } },
            parts => (parts[0] === "app" ? 7 : 0)
        );
        expect(mutationRoute).toMatchObject({
            ok: true,
            authority: "global",
            partitionKey: "app",
            vshard: 7,
        });
        const queryRoute = routeValidatedQuery(
            manifest,
            { ref: query.__chardbRef, args: { partition: "app" } },
            tables => tables.join(",")
        );
        expect(queryRoute.authority).toBe("global");
        expect(queryRoute.partitionKey).toBe("app");
        expect(queryRoute.policyDigest).toBe("settings");
    });

    test("rejects empty and non-string global partition results", () => {
        const mutation = defineMutation({
            ref: "api/settings#invalidSave",
            authority: "global",
            partitionKey: (args: { partition: string | number }) => args.partition,
            handler: () => null,
        });
        const query = defineQuery({
            ref: "api/settings#invalidRead",
            authority: "global",
            partitionKey: (args: { partition: string | number }) => args.partition,
            intent: () => ({ kind: "select", tables: ["settings"] }),
            handler: async () => [],
        });
        const manifest = manifestFromExports({ mutation, query });

        const emptyMutation = routeMutation(manifest, { ref: mutation.__chardbRef, args: { partition: "" } }, () => 0);
        expect(emptyMutation).toMatchObject({
            ok: false,
            error: { code: "CDB_INVALID_ARGS", message: expect.stringContaining("nonempty string partition key") },
        });
        expect(() =>
            routeValidatedQuery(manifest, { ref: query.__chardbRef, args: { partition: 1 } }, () => "policy")
        ).toThrow("global query api/settings#invalidRead requires a nonempty string partition key");
    });
});
