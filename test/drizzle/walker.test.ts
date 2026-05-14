import { describe, expect, test } from "bun:test";
import {
    and,
    between,
    eq,
    gt,
    gte,
    inArray,
    isNotNull,
    isNull,
    lt,
    lte,
    ne,
    not,
    notInArray,
    or,
    sql,
} from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ExtractArgs } from "../../src/drizzle/dialect.ts";
import { StaticIntentExtractor } from "../../src/drizzle/walker.ts";
import type { CdbIntent, WireInterval } from "../../src/wire.ts";

const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    age: integer("age"),
});

const extractor = new StaticIntentExtractor({ users: "org_id" });

function selectIntent(args: Omit<ExtractArgs, "tables"> & { tables?: readonly string[] }): CdbIntent {
    return extractor.forSelect({ tables: args.tables ?? ["users"], where: args.where });
}

describe("StaticIntentExtractor — single atoms", () => {
    test("eq on partition column → colocated, one value, point interval", () => {
        const intent = selectIntent({ where: eq(users.orgId, "o1") });
        expect(intent.joinShape).toBe("colocated");
        expect(intent.partitionKey).toEqual({ table: "users", column: "org_id", values: ["o1"] });
        expect(intent.intervals?.[0]?.intervals).toEqual([
            {
                kind: "range",
                lo: { kind: "value", value: ["o1"], inclusive: true },
                hi: { kind: "value", value: ["o1"], inclusive: true },
            },
        ]);
    });

    test("inArray on partition column → colocated, N values, N point intervals", () => {
        const intent = selectIntent({ where: inArray(users.orgId, ["a", "b", "c"]) });
        expect(intent.joinShape).toBe("colocated");
        expect(intent.partitionKey?.values).toEqual(["a", "b", "c"]);
        expect(intent.intervals?.[0]?.intervals.length).toBe(3);
    });

    test("between on partition column → cross-partition (range), interval captured", () => {
        const intent = selectIntent({ where: between(users.orgId, "a", "z") });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
        const captured = intent.intervals?.[0]?.intervals[0] as Extract<WireInterval, { kind: "range" }>;
        expect(captured.kind).toBe("range");
        expect(captured.lo).toEqual({ kind: "value", value: ["a"], inclusive: true });
        expect(captured.hi).toEqual({ kind: "value", value: ["z"], inclusive: true });
    });

    test("gt on partition column → cross-partition with open lower interval", () => {
        const intent = selectIntent({ where: gt(users.orgId, "m") });
        expect(intent.joinShape).toBe("cross-partition");
        const iv = intent.intervals?.[0]?.intervals[0] as Extract<WireInterval, { kind: "range" }>;
        expect(iv.lo).toEqual({ kind: "value", value: ["m"], inclusive: false });
        expect(iv.hi).toEqual({ kind: "pos_inf" });
    });

    test("lte on partition column → cross-partition with closed upper interval", () => {
        const intent = selectIntent({ where: lte(users.orgId, "m") });
        expect(intent.joinShape).toBe("cross-partition");
        const iv = intent.intervals?.[0]?.intervals[0] as Extract<WireInterval, { kind: "range" }>;
        expect(iv.lo).toEqual({ kind: "neg_inf" });
        expect(iv.hi).toEqual({ kind: "value", value: ["m"], inclusive: true });
    });

    test("eq on a non-partition column → cross-partition fallback", () => {
        const intent = selectIntent({ where: eq(users.age, 30) });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
        expect(intent.intervals).toBeUndefined();
    });

    test("missing where → cross-partition fallback", () => {
        const intent = selectIntent({});
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
    });
});

describe("StaticIntentExtractor — boolean composition", () => {
    test("and(eq(orgId), eq(age)) → colocated, partition key from orgId child", () => {
        const intent = selectIntent({ where: and(eq(users.orgId, "o1"), eq(users.age, 30)) });
        expect(intent.joinShape).toBe("colocated");
        expect(intent.partitionKey?.values).toEqual(["o1"]);
        expect(intent.intervals?.[0]?.intervals).toEqual([
            {
                kind: "range",
                lo: { kind: "value", value: ["o1"], inclusive: true },
                hi: { kind: "value", value: ["o1"], inclusive: true },
            },
        ]);
    });

    test("or(eq(orgId, o1), eq(orgId, o2)) → colocated, two values", () => {
        const intent = selectIntent({ where: or(eq(users.orgId, "o1"), eq(users.orgId, "o2")) });
        expect(intent.joinShape).toBe("colocated");
        expect(intent.partitionKey?.values).toEqual(["o1", "o2"]);
        expect(intent.intervals?.[0]?.intervals.length).toBe(2);
    });

    test("or(eq(orgId), eq(age)) → cross-partition, no partition key (mixed disjunction)", () => {
        const intent = selectIntent({ where: or(eq(users.orgId, "o1"), eq(users.age, 30)) });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
        expect(intent.intervals).toBeUndefined();
    });

    test("and intersects ranges on partition column", () => {
        const intent = selectIntent({ where: and(gt(users.orgId, "a"), lte(users.orgId, "z")) });
        expect(intent.joinShape).toBe("cross-partition");
        const iv = intent.intervals?.[0]?.intervals[0] as Extract<WireInterval, { kind: "range" }>;
        expect(iv.lo).toEqual({ kind: "value", value: ["a"], inclusive: false });
        expect(iv.hi).toEqual({ kind: "value", value: ["z"], inclusive: true });
    });
});

describe("StaticIntentExtractor — fallbacks", () => {
    test("raw sql function → cross-partition fallback", () => {
        const intent = selectIntent({ where: sql`some_func(${users.orgId})` });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
        expect(intent.intervals).toBeUndefined();
    });

    test("table without a registered partition column → cross-partition fallback", () => {
        const intent = extractor.forSelect({ tables: ["other"], where: eq(users.orgId, "o1") });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
    });

    test("lt on partition column → cross-partition with open upper interval", () => {
        const intent = selectIntent({ where: lt(users.orgId, "m") });
        expect(intent.joinShape).toBe("cross-partition");
        const iv = intent.intervals?.[0]?.intervals[0] as Extract<WireInterval, { kind: "range" }>;
        expect(iv.lo).toEqual({ kind: "neg_inf" });
        expect(iv.hi).toEqual({ kind: "value", value: ["m"], inclusive: false });
    });

    test("gte on partition column → cross-partition with closed lower interval", () => {
        const intent = selectIntent({ where: gte(users.orgId, "m") });
        expect(intent.joinShape).toBe("cross-partition");
        const iv = intent.intervals?.[0]?.intervals[0] as Extract<WireInterval, { kind: "range" }>;
        expect(iv.lo).toEqual({ kind: "value", value: ["m"], inclusive: true });
        expect(iv.hi).toEqual({ kind: "pos_inf" });
    });
});

describe("StaticIntentExtractor — unsupported operators fall back to cross-partition (locked behavior)", () => {
    // These operators don't reduce to a routable interval set today. The
    // contract is that the walker emits a safe cross-partition fanout
    // rather than silently colocating on a stale assumption. Locking the
    // behavior so a later walker change can't accidentally widen the
    // routing claim.
    test("ne on partition column → cross-partition fallback", () => {
        const intent = selectIntent({ where: ne(users.orgId, "o1") });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
    });

    test("isNull on partition column → cross-partition fallback", () => {
        const intent = selectIntent({ where: isNull(users.orgId) });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
    });

    test("isNotNull on partition column → cross-partition fallback", () => {
        const intent = selectIntent({ where: isNotNull(users.orgId) });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
    });

    test("notInArray on partition column → cross-partition fallback (negation expands the search space)", () => {
        const intent = selectIntent({ where: notInArray(users.orgId, ["o1", "o2"]) });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
    });

    test("not(and(eq, eq)) → cross-partition fallback (de Morgan would expand to disjunction we don't reduce)", () => {
        const intent = selectIntent({ where: not(and(eq(users.orgId, "o1"), eq(users.age, 5))!) });
        expect(intent.joinShape).toBe("cross-partition");
        expect(intent.partitionKey).toBeUndefined();
    });
});
