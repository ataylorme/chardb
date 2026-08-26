import { describe, expect, test } from "bun:test";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type QueryBuilder, integer, text } from "drizzle-orm/sqlite-core";
import { forUser, globalScope } from "../../src/server/cdb-tenant.ts";
import { createApi } from "../../src/server/define.ts";
import { manifestFromExports, routeValidatedQuery } from "../../src/server/manifest.ts";
import { compileRegisteredQueryPlan } from "../../src/server/registered-query-plan.ts";

const { cdbTable } = globalScope();
const plannedRows = cdbTable(
    "planned_rows",
    {
        id: text("id").primaryKey(),
        namespace: text("namespace").notNull(),
        channelId: text("channel_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    { partitionBy: "namespace", roles: { user: { read: "*" } } }
);

const api = createApi({ plannedRows });
const listPlannedRows = api.query({
    ref: "api/planned#list",
    query: (db, args: { namespace: string; channelId: string; limit: number }) =>
        db
            .select()
            .from(plannedRows)
            .where(and(eq(plannedRows.namespace, args.namespace), eq(plannedRows.channelId, args.channelId)))
            .orderBy(desc(plannedRows.createdAt), desc(plannedRows.id))
            .limit(args.limit),
});

const { cdbTable: userTable } = forUser();
const plannedUserRows = userTable(
    "planned_user_rows",
    { id: text("id").primaryKey(), userId: text("user_id").notNull() },
    { tenantBy: "userId", partitionBy: "userId", roles: { user: { read: "*" } } }
);

describe("registered query plan", () => {
    test("derives global placement, intervals, full projection, ordering, and a stable hash", () => {
        const plan = listPlannedRows.__chardbCompilePlan?.({ namespace: "public", channelId: "news", limit: 25 });
        expect(plan).toBeDefined();
        expect(plan?.authority).toBe("global");
        expect(plan?.partitionKey).toBe("public");
        expect(plan?.intent.tables).toEqual(["planned_rows"]);
        expect(plan?.intent.partitionKey).toEqual({
            table: "planned_rows",
            column: "namespace",
            values: ["public"],
        });
        expect(plan?.intent.intervals?.map(interval => interval.indexName)).toEqual(["namespace", "channel_id"]);
        expect(plan?.projection).toEqual([
            { key: "id", column: "id" },
            { key: "namespace", column: "namespace" },
            { key: "channelId", column: "channel_id" },
            { key: "createdAt", column: "created_at" },
        ]);
        expect(plan?.orderBy).toEqual([
            { column: "created_at", direction: "desc" },
            { column: "id", direction: "desc" },
        ]);
        expect(plan?.limit).toBe(25);
        expect(plan?.planHash).toHaveLength(64);
        expect(listPlannedRows.__chardbCompilePlan?.({ namespace: "public", channelId: "news", limit: 25 })).toEqual(
            plan
        );
    });

    test("manifest routing uses the compiled plan and incorporates its hash", () => {
        const manifest = manifestFromExports({ listPlannedRows });
        const first = routeValidatedQuery(
            manifest,
            { ref: listPlannedRows.__chardbRef, args: { namespace: "public", channelId: "news", limit: 25 } },
            tables => `policy:${tables.join(",")}`
        );
        const second = routeValidatedQuery(
            manifest,
            { ref: listPlannedRows.__chardbRef, args: { namespace: "public", channelId: "other", limit: 25 } },
            tables => `policy:${tables.join(",")}`
        );
        expect(first.authority).toBe("global");
        expect(first.partitionKey).toBe("public");
        expect(first.intent.intervals?.map(interval => interval.indexName)).toEqual(["namespace", "channel_id"]);
        expect(first.queryHash).not.toBe(second.queryHash);
    });

    test("derives user authority from table metadata", () => {
        const query = createApi({ plannedUserRows }).query({
            ref: "api/planned#user-list",
            query: (db, args: { userId: string }) =>
                db
                    .select()
                    .from(plannedUserRows)
                    .where(eq(plannedUserRows.userId, args.userId))
                    .orderBy(plannedUserRows.id)
                    .limit(10),
        });
        expect(query.__chardbCompilePlan?.({ userId: "user-1" })).toMatchObject({
            authority: "user",
            partitionKey: "user-1",
        });
    });

    test("rejects promises, projections, raw predicates, multi-partition reads, unstable order, and bad limits", () => {
        expect(() => compileRegisteredQueryPlan(async () => [], { namespace: "public" })).toThrow(
            "return a builder synchronously"
        );
        expect(() =>
            compileRegisteredQueryPlan(
                (db: QueryBuilder, args: { namespace: string }) =>
                    db
                        .select({ id: plannedRows.id })
                        .from(plannedRows)
                        .where(eq(plannedRows.namespace, args.namespace))
                        .orderBy(plannedRows.id)
                        .limit(10),
                { namespace: "public" }
            )
        ).toThrow("explicit projections");
        expect(() =>
            compileRegisteredQueryPlan(
                (db: QueryBuilder, args: { namespace: string }) =>
                    db
                        .select()
                        .from(plannedRows)
                        .where(and(eq(plannedRows.namespace, args.namespace), sql`random()`))
                        .orderBy(plannedRows.id)
                        .limit(10),
                { namespace: "public" }
            )
        ).toThrow("raw or unrecognized predicates");
        expect(() =>
            compileRegisteredQueryPlan(
                (db: QueryBuilder, args: { namespace: string }) =>
                    db
                        .select()
                        .from(plannedRows)
                        .where(
                            and(eq(plannedRows.namespace, args.namespace), sql`${plannedRows.createdAt} + ${1} > ${2}`)
                        )
                        .orderBy(plannedRows.id)
                        .limit(10),
                { namespace: "public" }
            )
        ).toThrow("raw or unrecognized predicates");
        expect(() =>
            compileRegisteredQueryPlan(
                (db: QueryBuilder) =>
                    db
                        .select()
                        .from(plannedRows)
                        .where(inArray(plannedRows.namespace, ["a", "b"]))
                        .orderBy(plannedRows.id)
                        .limit(10),
                {}
            )
        ).toThrow("one nonempty string");
        expect(() =>
            compileRegisteredQueryPlan(
                (db: QueryBuilder) =>
                    db
                        .select()
                        .from(plannedRows)
                        .where(
                            and(
                                eq(plannedRows.namespace, "public"),
                                inArray(
                                    plannedRows.channelId,
                                    Array.from({ length: 101 }, (_, index) => String(index))
                                )
                            )
                        )
                        .orderBy(plannedRows.id)
                        .limit(10),
                {}
            )
        ).toThrow("at most 100 values");
        expect(() =>
            compileRegisteredQueryPlan(
                (db: QueryBuilder) =>
                    db
                        .select()
                        .from(plannedRows)
                        .where(eq(plannedRows.namespace, "public"))
                        .orderBy(plannedRows.createdAt)
                        .limit(10),
                {}
            )
        ).toThrow("must end with primary key");
        expect(() =>
            compileRegisteredQueryPlan(
                (db: QueryBuilder) =>
                    db
                        .select()
                        .from(plannedRows)
                        .where(eq(plannedRows.namespace, "public"))
                        .orderBy(plannedRows.id)
                        .limit(101),
                {}
            )
        ).toThrow("1 through 100");
    });
});
