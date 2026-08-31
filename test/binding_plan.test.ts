import { describe, expect, test } from "bun:test";
import {
    and,
    asc,
    between,
    desc,
    eq,
    gt,
    gte,
    inArray,
    isNotNull,
    isNull,
    lt,
    lte,
    ne,
    or,
    placeholder,
    sql,
} from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
    CHARDB_SELECT_PLAN_MAX_BYTES,
    CHARDB_SELECT_PLAN_MAX_CHILDREN,
    CHARDB_SELECT_PLAN_MAX_IN_VALUES,
    CHARDB_SELECT_PLAN_MAX_LIMIT,
    CHARDB_SELECT_PLAN_MAX_ORDER_BY,
    type ChardbSelectPlanV1,
    createBindingSelect,
    validateChardbSelectPlanV1,
} from "../src/binding-plan.ts";
import { globalScope } from "../src/server/cdb-tenant.ts";

const { cdbTable } = globalScope();

const messages = cdbTable(
    "binding_plan_messages",
    {
        id: text("id").primaryKey(),
        channelId: text("channel_id").notNull(),
        body: text("body").notNull(),
        rank: integer("rank").notNull(),
        deletedAt: integer("deleted_at"),
    },
    { partitionBy: "channelId", roles: { member: "*" } }
);

const other = cdbTable(
    "binding_plan_other",
    { id: text("id").primaryKey(), value: text("value") },
    { partitionBy: "id", roles: { member: "*" } }
);

function recorder(result: unknown = []): {
    readonly plans: ChardbSelectPlanV1[];
    readonly select: ReturnType<typeof createBindingSelect>;
} {
    const plans: ChardbSelectPlanV1[] = [];
    return {
        plans,
        select: createBindingSelect(async plan => {
            plans.push(plan);
            return result;
        }),
    };
}

describe("bounded DB select plan compiler", () => {
    test("compiles a full-row typed query without SQL text", async () => {
        const { plans, select } = recorder([{ id: "message-1", channelId: "channel-1", body: "hello", rank: 3 }]);

        const rows: readonly (typeof messages.$inferSelect)[] = await select()
            .from(messages)
            .where(
                and(
                    eq(messages.channelId, "channel-1"),
                    or(gt(messages.rank, 1), isNull(messages.deletedAt))
                ) as ReturnType<typeof eq>
            )
            .orderBy(desc(messages.rank), messages.id)
            .limit(25);

        expect(rows[0]?.id).toBe("message-1");
        expect(plans).toEqual([
            {
                version: 1,
                kind: "select",
                table: "binding_plan_messages",
                selection: { kind: "all" },
                where: {
                    kind: "and",
                    predicates: [
                        { kind: "compare", op: "eq", column: "channel_id", value: "channel-1" },
                        {
                            kind: "or",
                            predicates: [
                                { kind: "compare", op: "gt", column: "rank", value: 1 },
                                { kind: "null", op: "isNull", column: "deleted_at" },
                            ],
                        },
                    ],
                },
                orderBy: [
                    { column: "rank", direction: "desc" },
                    { column: "id", direction: "asc" },
                ],
                limit: 25,
                cardinality: "many",
            },
        ]);
        expect(JSON.stringify(plans[0])).not.toContain("SELECT");
    });

    test("compiles every admitted predicate operator", async () => {
        const { plans, select } = recorder([]);
        await select()
            .from(messages)
            .where(
                and(
                    ne(messages.id, "x"),
                    gte(messages.rank, 1),
                    lt(messages.rank, 9),
                    lte(messages.rank, 8),
                    inArray(messages.channelId, ["a", "b"]),
                    between(messages.rank, 2, 7),
                    isNotNull(messages.body)
                ) as ReturnType<typeof eq>
            )
            .all();

        expect(plans[0]?.where).toEqual({
            kind: "and",
            predicates: [
                { kind: "compare", op: "ne", column: "id", value: "x" },
                { kind: "compare", op: "gte", column: "rank", value: 1 },
                { kind: "compare", op: "lt", column: "rank", value: 9 },
                { kind: "compare", op: "lte", column: "rank", value: 8 },
                { kind: "in", column: "channel_id", values: ["a", "b"] },
                { kind: "between", column: "rank", lower: 2, upper: 7 },
                { kind: "null", op: "isNotNull", column: "body" },
            ],
        });
    });

    test("supports all, get, and PromiseLike execution with inferred rows", async () => {
        const row = { id: "m1", channelId: "c1", body: "hello", rank: 1, deletedAt: null };
        const many = recorder([row]);
        const all: readonly (typeof messages.$inferSelect)[] = await many.select().from(messages).all();
        expect(all).toEqual([row]);
        expect(many.plans[0]?.cardinality).toBe("many");

        const one = recorder(row);
        const found: typeof messages.$inferSelect | undefined = await one.select().from(messages).get();
        expect(found).toEqual(row);
        expect(one.plans[0]?.cardinality).toBe("one");

        const absent = recorder(null);
        await expect(absent.select().from(messages).get()).resolves.toBeUndefined();
    });

    test("rejects projections, plain tables, and unavailable builder shapes", () => {
        const { select } = recorder();
        const plain = sqliteTable("plain", { id: text("id") });

        expect(() => (select as unknown as (projection: unknown) => unknown)({ id: messages.id })).toThrow(
            expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" })
        );
        expect(() => select().from(plain)).toThrow(expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" }));

        const query = select().from(messages) as unknown as Record<string, (...args: unknown[]) => unknown>;
        for (const property of ["leftJoin", "innerJoin", "groupBy", "offset", "distinct", "prepare"]) {
            expect(() => query[property]?.()).toThrow(expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" }));
        }
    });

    test("rejects raw SQL, placeholders, subqueries, callbacks, and foreign-table columns", () => {
        const { select } = recorder();
        const fresh = () => select().from(messages);

        expect(() => fresh().where(sql`${messages.id} = 'forged'`)).toThrow(
            expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" })
        );
        expect(() => fresh().where(eq(messages.id, placeholder("id")))).toThrow(
            expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" })
        );
        expect(() => fresh().where(eq(other.id, "other"))).toThrow(
            expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" })
        );
        expect(() => fresh().orderBy(other.id)).toThrow(expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" }));
        expect(() => (fresh().orderBy as unknown as (value: unknown) => unknown)(() => messages.id)).toThrow(
            expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" })
        );

        const inner = select().from(messages).where(eq(messages.id, "inner"));
        expect(() => fresh().where(sql`exists (${inner as unknown})`)).toThrow(
            expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" })
        );
    });

    test("rejects non-JSON predicate parameters", () => {
        const { select } = recorder();
        for (const value of [new Date(), 1n, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
            expect(() =>
                select()
                    .from(messages)
                    .where(eq(messages.id, value as never))
            ).toThrow(expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" }));
        }
    });

    test("requires explicit null predicates", () => {
        const { select } = recorder();
        for (const predicate of [
            eq(messages.deletedAt, null as never),
            inArray(messages.deletedAt, [null as never]),
            between(messages.deletedAt, null as never, 3),
            between(messages.deletedAt, 1, null as never),
        ]) {
            expect(() => select().from(messages).where(predicate)).toThrow(
                expect.objectContaining({ code: "CDB_UNSUPPORTED_FEATURE" })
            );
        }

        expect(() => select().from(messages).where(isNull(messages.deletedAt))).not.toThrow();

        const base = {
            version: 1,
            kind: "select",
            table: "binding_plan_messages",
            selection: { kind: "all" },
            cardinality: "many",
        };
        for (const where of [
            { kind: "compare", op: "eq", column: "deleted_at", value: null },
            { kind: "in", column: "deleted_at", values: [null] },
            { kind: "between", column: "deleted_at", lower: null, upper: 3 },
            { kind: "between", column: "deleted_at", lower: 1, upper: null },
        ]) {
            expect(() => validateChardbSelectPlanV1({ ...base, where })).toThrow(
                expect.objectContaining({ code: "CDB_INVALID_ARGS" })
            );
        }
    });

    test("locks the local limit, ordering, IN, and boolean-child bounds", () => {
        const { select } = recorder();
        for (const limit of [0, CHARDB_SELECT_PLAN_MAX_LIMIT + 1, 1.5, Number.NaN]) {
            expect(() => select().from(messages).limit(limit)).toThrow(
                expect.objectContaining({ code: "CDB_INVALID_ARGS" })
            );
        }

        expect(() =>
            select()
                .from(messages)
                .orderBy(...Array.from({ length: CHARDB_SELECT_PLAN_MAX_ORDER_BY + 1 }, () => messages.id))
        ).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));

        expect(() =>
            select()
                .from(messages)
                .where(
                    inArray(
                        messages.id,
                        Array.from({ length: CHARDB_SELECT_PLAN_MAX_IN_VALUES + 1 }, (_, index) => String(index))
                    )
                )
        ).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));

        expect(() =>
            select()
                .from(messages)
                .where(
                    and(
                        ...Array.from({ length: CHARDB_SELECT_PLAN_MAX_CHILDREN + 1 }, (_, index) =>
                            eq(messages.id, String(index))
                        )
                    ) as ReturnType<typeof eq>
                )
        ).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));
    });

    test("validates exact keys and owns the accepted plan", () => {
        const source = {
            version: 1,
            kind: "select",
            table: "binding_plan_messages",
            selection: { kind: "all" },
            where: { kind: "compare", op: "eq", column: "channel_id", value: "channel-1" },
            orderBy: [{ column: "rank", direction: "asc" }],
            limit: 25,
            cardinality: "many",
        };
        const owned = validateChardbSelectPlanV1(source);
        source.where.value = "forged";
        const firstOrder = source.orderBy[0];
        if (!firstOrder) throw new Error("expected one order entry");
        firstOrder.column = "forged";
        expect(owned.where).toMatchObject({ value: "channel-1" });
        expect(owned.orderBy?.[0]?.column).toBe("rank");

        for (const hostile of [
            { ...source, extra: true },
            { ...source, selection: { kind: "all", sql: "select secret" } },
            { ...source, where: { ...source.where, table: "other" } },
            { ...source, orderBy: [{ ...source.orderBy[0], nulls: "first" }] },
        ]) {
            expect(() => validateChardbSelectPlanV1(hostile)).toThrow(
                expect.objectContaining({ code: "CDB_INVALID_ARGS" })
            );
        }
    });

    test("does not invoke accessors while validating", () => {
        let reads = 0;
        const plan = {
            version: 1,
            kind: "select",
            table: "binding_plan_messages",
            selection: { kind: "all" },
            cardinality: "many",
        };
        Object.defineProperty(plan, "where", {
            enumerable: true,
            get() {
                reads++;
                return { kind: "compare", op: "eq", column: "id", value: "x" };
            },
        });
        expect(() => validateChardbSelectPlanV1(plan)).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));
        expect(reads).toBe(0);
    });

    test("does not read properties through a proxy while validating", () => {
        let reads = 0;
        const target = {
            version: 1,
            kind: "select",
            table: "binding_plan_messages",
            selection: { kind: "all" },
            where: { kind: "compare", op: "eq", column: "id", value: "x" },
            cardinality: "many",
        } as const;
        const plan = new Proxy(target, {
            get(object, property, receiver) {
                reads++;
                return Reflect.get(object, property, receiver);
            },
        });

        expect(validateChardbSelectPlanV1(plan)).toEqual(target);
        expect(reads).toBe(0);
    });

    test("enforces predicate depth, node count, and serialized bytes", () => {
        let deep: Record<string, unknown> = { kind: "compare", op: "eq", column: "id", value: "x" };
        for (let index = 0; index < 17; index++) {
            deep = { kind: "and", predicates: [deep, { kind: "compare", op: "eq", column: "id", value: "x" }] };
        }
        expect(() =>
            validateChardbSelectPlanV1({
                version: 1,
                kind: "select",
                table: "binding_plan_messages",
                selection: { kind: "all" },
                where: deep,
                cardinality: "many",
            })
        ).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));

        const leaf = () => ({ kind: "compare", op: "eq", column: "id", value: "x" });
        const branches = Array.from({ length: 9 }, () => ({
            kind: "and",
            predicates: Array.from({ length: 16 }, leaf),
        }));
        expect(() =>
            validateChardbSelectPlanV1({
                version: 1,
                kind: "select",
                table: "binding_plan_messages",
                selection: { kind: "all" },
                where: { kind: "or", predicates: branches },
                cardinality: "many",
            })
        ).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));

        let oversizedArrayOwnKeys = 0;
        const oversizedValues = new Proxy(
            Array.from({ length: CHARDB_SELECT_PLAN_MAX_IN_VALUES + 1 }, (_, index) => String(index)),
            {
                ownKeys(target) {
                    oversizedArrayOwnKeys++;
                    return Reflect.ownKeys(target);
                },
            }
        );
        expect(() =>
            validateChardbSelectPlanV1({
                version: 1,
                kind: "select",
                table: "binding_plan_messages",
                selection: { kind: "all" },
                where: { kind: "in", column: "id", values: oversizedValues },
                cardinality: "many",
            })
        ).toThrow(new RegExp(`at most ${CHARDB_SELECT_PLAN_MAX_IN_VALUES} entries`));
        expect(oversizedArrayOwnKeys).toBe(0);

        const aggregateChunk = "é".repeat(Math.floor(CHARDB_SELECT_PLAN_MAX_BYTES / 4) + 1);
        expect(() =>
            validateChardbSelectPlanV1({
                version: 1,
                kind: "select",
                table: "binding_plan_messages",
                selection: { kind: "all" },
                where: {
                    kind: "and",
                    predicates: [
                        { kind: "compare", op: "eq", column: "id", value: aggregateChunk },
                        { kind: "compare", op: "eq", column: "channel_id", value: aggregateChunk },
                    ],
                },
                cardinality: "many",
            })
        ).toThrow(new RegExp(`predicate string values exceed ${CHARDB_SELECT_PLAN_MAX_BYTES} UTF-8 bytes`));

        expect(() =>
            validateChardbSelectPlanV1({
                version: 1,
                kind: "select",
                table: "binding_plan_messages",
                selection: { kind: "all" },
                where: { kind: "compare", op: "eq", column: "body", value: "x".repeat(CHARDB_SELECT_PLAN_MAX_BYTES) },
                cardinality: "many",
            })
        ).toThrow(expect.objectContaining({ code: "CDB_INVALID_ARGS" }));
    });

    test("rejects malformed terminal executor results", async () => {
        await expect(recorder({}).select().from(messages).all()).rejects.toMatchObject({ code: "CDB_INVALID_ARGS" });
        await expect(recorder([]).select().from(messages).get()).rejects.toMatchObject({ code: "CDB_INVALID_ARGS" });
    });
});
