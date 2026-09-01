import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
    type CdbVectorMutationContext,
    bindCdbVectorMutationContext,
    cdbVectorLogicalId,
} from "../../src/server/do/cdb-vector-mutation.ts";
import { resolveOrganizationVectorResourceDescriptor } from "../../src/server/resource-descriptors.ts";
import { snapshotCdbResultByteLimit } from "../../src/server/result_limits.ts";
import type { RawJson } from "../../src/types.ts";
import {
    isChardbVectorSearchBuilder,
    normalizeChardbVectorSearchBuilder,
    searchVector,
    vector,
} from "../../src/vector.ts";
import { forOrg, forUser } from "../helpers/cdb-table.ts";

const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const user = sqliteTable("user", { id: text("id").primaryKey() });

function schema() {
    const { cdbTable } = forOrg();
    const messages = cdbTable("public_vector_messages", {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        body: text("body").notNull(),
        embedding: vector("embedding", { dim: 3, binding: "CDB_MESSAGES", metric: "cosine" }),
    });
    return { messages };
}

describe("public organization vector API", () => {
    test("binds only the frozen set and delete facade to a mutation context", () => {
        const { messages } = schema();
        const handle = Object.freeze({ id: "vec_test" });
        const calls: unknown[] = [];
        const controller = {
            upsert: (input: unknown) => {
                calls.push(["set", input]);
                return handle;
            },
            delete: (input: unknown) => {
                calls.push(["delete", input]);
            },
        } as CdbVectorMutationContext;
        const bound = bindCdbVectorMutationContext(
            { db: "db", auth: { userId: "user-1", claims: {} } } as never,
            controller
        );

        expect(bound.vector.set(messages.embedding, "row-1", [1, 0, 0])).toBe(handle);
        expect(bound.vector.delete(messages.embedding, "row-1")).toBeUndefined();
        expect(calls).toEqual([
            ["set", { column: messages.embedding, rowPk: "row-1", values: [1, 0, 0] }],
            ["delete", { column: messages.embedding, rowPk: "row-1" }],
        ]);
        expect(Object.keys(bound.vector).sort()).toEqual(["delete", "set"]);
        expect(Object.isFrozen(bound.vector)).toBe(true);
        expect("upsert" in bound.vector).toBe(false);
    });

    test("canonicalizes boolean row keys to their SQLite representation", () => {
        const resourceId = `vr1_${"a".repeat(64)}`;
        expect(cdbVectorLogicalId(resourceId, "org-1", true)).toBe(cdbVectorLogicalId(resourceId, "org-1", "1"));
        expect(cdbVectorLogicalId(resourceId, "org-1", false)).toBe(cdbVectorLogicalId(resourceId, "org-1", "0"));
        expect(cdbVectorLogicalId(resourceId, "org-1", true)).not.toBe(cdbVectorLogicalId(resourceId, "org-1", false));
    });

    test("returns a JSON-safe logical handle from ordinary reads of vector-bearing rows", () => {
        const { messages } = schema();
        const sqlite = new Database(":memory:");
        try {
            sqlite.run(
                `CREATE TABLE public_vector_messages (
                   id TEXT PRIMARY KEY,
                   organization_id TEXT NOT NULL,
                   body TEXT NOT NULL,
                   embedding TEXT
                 )`
            );
            sqlite.run("INSERT INTO public_vector_messages VALUES (?, ?, ?, ?)", [
                "message-1",
                "org-1",
                "hello",
                "vec1_test",
            ]);
            const row = drizzle(sqlite, { schema: { messages } }).select().from(messages).get();
            if (!row) throw new Error("expected the inserted vector row");
            expect(row).toEqual({
                id: "message-1",
                organizationId: "org-1",
                body: "hello",
                embedding: { id: "vec1_test" },
            });
            const result = [row] as unknown as RawJson;
            expect(snapshotCdbResultByteLimit(result, "query result", "return less data")).toEqual([
                {
                    id: "message-1",
                    organizationId: "org-1",
                    body: "hello",
                    embedding: { id: "vec1_test" },
                },
            ]);
        } finally {
            sqlite.close();
        }
    });

    test("builds one opaque normalized search plan with exact column identity", () => {
        const { messages } = schema();
        const builder = searchVector(messages.embedding, {
            organizationId: "org-1",
            values: [0.1, -0.5, 1],
        });

        expect(isChardbVectorSearchBuilder(builder)).toBe(true);
        expect(normalizeChardbVectorSearchBuilder(builder)).toEqual({
            column: messages.embedding,
            organizationId: "org-1",
            values: [new Float32Array([0.1])[0] as number, -0.5, 1],
            limit: 10,
        });
        expect(Object.isFrozen(builder)).toBe(true);
        expect(isChardbVectorSearchBuilder({ ...builder })).toBe(false);
        expect(() => normalizeChardbVectorSearchBuilder({ ...builder })).toThrow(/not a searchVector builder/);
    });

    test("rejects search inputs outside their exact public bounds", () => {
        const { messages } = schema();
        const valid = { organizationId: "org-1", values: [1, 0, 0] } as const;

        for (const limit of [0, 101, 1.5, Number.NaN]) {
            expect(() => searchVector(messages.embedding, { ...valid, limit })).toThrow(/integer from 1 through 100/);
        }
        expect(() => searchVector(messages.embedding, { ...valid, organizationId: "" })).toThrow(/1 through 256/);
        expect(() => searchVector(messages.embedding, { ...valid, organizationId: "x".repeat(257) })).toThrow(
            /1 through 256/
        );
        expect(() => searchVector(messages.embedding, { ...valid, values: [1, 0] })).toThrow(/exactly 3/);
        expect(() => searchVector(messages.embedding, { ...valid, values: [1, Number.NaN, 0] })).toThrow(/finite/);
        expect(() => searchVector(messages.embedding, { ...valid, values: [1, Number.MAX_VALUE, 0] })).toThrow(
            /float32/
        );
        expect(() => searchVector(messages.body as never, valid)).toThrow(/must be a vector column/);
        expect(() => searchVector(null as never, valid)).toThrow(/must be a vector column/);
    });

    test("resolves only an exact nullable organization vector column", () => {
        const { messages } = schema();
        expect(resolveOrganizationVectorResourceDescriptor(messages.embedding)).toEqual({
            kind: "vector",
            version: 1,
            table: "public_vector_messages",
            column: "embedding",
            primaryKey: "id",
            organizationColumn: "organization_id",
            binding: "CDB_MESSAGES",
            dimensions: 3,
            metric: "cosine",
        });
        expect(() => resolveOrganizationVectorResourceDescriptor(messages.body)).toThrow(/is not a vector column/);

        const { cdbTable } = forUser();
        const preferences = cdbTable("public_user_vectors", {
            id: text("id").primaryKey(),
            userId: text("user_id")
                .notNull()
                .references(() => user.id),
            embedding: vector("embedding", { dim: 3, binding: "CDB_USERS", metric: "cosine" }),
        });
        expect(() => resolveOrganizationVectorResourceDescriptor(preferences.embedding)).toThrow(
            /require organization tenancy/
        );
    });
});
