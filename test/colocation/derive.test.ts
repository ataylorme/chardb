import { describe, expect, test } from "bun:test";
import { deriveColocation } from "../../src/colocation/derive.ts";
import type { FkEdge, SchemaInput } from "../../src/colocation/types.ts";
import { isCdbError } from "../../src/errors.ts";

const fk = (
    child: string,
    parent: string,
    childCols: string[] = [`${parent}Id`],
    source: "fk-column" | "relations-one" = "fk-column"
): FkEdge => ({
    source,
    child,
    parent,
    childCols,
    parentCols: ["id"],
});

const baseSchema: SchemaInput = {
    tables: ["organization", "user", "messages", "tags"],
    edges: [fk("messages", "organization", ["organizationId"]), fk("user", "organization")],
};

describe("deriveColocation — basic shapes", () => {
    test("default distributionRoots: organization+user are SELF; child colocates by FK column", () => {
        const r = deriveColocation(baseSchema);
        expect(r.assignments["organization"]).toEqual({ kind: "self", partitionKey: "id" });
        // user is also a default root, so it's SELF (not colocated under organization).
        expect(r.assignments["user"]).toEqual({ kind: "self", partitionKey: "id" });
        expect(r.assignments["messages"]).toEqual({
            kind: "colocated",
            root: "organization",
            via: ["organizationId"],
        });
    });

    test("non-root child colocates by single-column FK", () => {
        const schema: SchemaInput = {
            tables: ["organization", "messages"],
            edges: [fk("messages", "organization", ["organizationId"])],
        };
        const r = deriveColocation(schema, { distributionRoots: ["organization"] });
        expect(r.assignments["messages"]).toEqual({
            kind: "colocated",
            root: "organization",
            via: ["organizationId"],
        });
    });

    test("table with no FK and no requireRoot becomes REPLICATED", () => {
        const r = deriveColocation(baseSchema);
        expect(r.assignments["tags"]).toEqual({ kind: "replicated" });
    });

    test("requireRoot=true raises CDB_AMBIGUOUS_COLOCATION on unrooted table", () => {
        expect(() => deriveColocation(baseSchema, { requireRoot: true })).toThrow();
    });
});

describe("policy.distributionRoots", () => {
    test("unknown root raises CDB_POLICY_UNKNOWN_ROOT", () => {
        try {
            deriveColocation(baseSchema, { distributionRoots: ["workspaces"] });
            throw new Error("should have thrown");
        } catch (e) {
            if (!isCdbError(e)) throw e;
            expect(e.code).toBe("CDB_POLICY_UNKNOWN_ROOT");
        }
    });

    test("allowMissingRoots=true bypasses unknown-root check", () => {
        const r = deriveColocation(baseSchema, {
            distributionRoots: ["workspaces", "organization"],
            allowMissingRoots: true,
        });
        expect(r.assignments["organization"]).toBeDefined();
    });
});

describe("strictMultiRoot (P5/P6)", () => {
    const schema: SchemaInput = {
        tables: ["organization", "user", "notification"],
        edges: [fk("notification", "organization"), fk("notification", "user", ["userId"])],
    };

    test("default (non-strict) picks the first matching root in priority order", () => {
        // chardb's `DEFAULT_POLICY.strictMultiRoot = false` is the
        // opinionated SaaS shape — a table that FKs to both `organization`
        // and `user` is colocated with the org without forcing the user to
        // write an explicit `policy.overrides[notification]` entry.
        const r = deriveColocation(schema);
        expect(r.assignments["notification"]).toEqual({
            kind: "colocated",
            root: "organization",
            via: ["organizationId"],
        });
    });

    test("opt-in strict mode raises with both candidates listed", () => {
        try {
            deriveColocation(schema, { strictMultiRoot: true });
            throw new Error("should have thrown");
        } catch (e) {
            if (!isCdbError(e)) throw e;
            expect(e.code).toBe("CDB_AMBIGUOUS_COLOCATION");
            expect(e.message).toContain("multiple distribution roots");
        }
    });

    test("non-strict mode honors priority reversal", () => {
        const r = deriveColocation(schema, {
            strictMultiRoot: false,
            distributionRoots: ["user", "organization"],
        });
        expect(r.assignments["notification"]).toEqual({
            kind: "colocated",
            root: "user",
            via: ["userId"],
        });
    });
});

describe("determinism — P1, P2, P3, P4, P8", () => {
    test("P1 — table iteration permutation invariance", () => {
        const a = deriveColocation(baseSchema);
        const b = deriveColocation({
            ...baseSchema,
            tables: [...baseSchema.tables].reverse(),
        });
        expect(b.digest).toBe(a.digest);
        expect(b.assignments).toEqual(a.assignments);
    });

    test("P2 — disconnected-table addition invariance", () => {
        const a = deriveColocation(baseSchema);
        const augmented: SchemaInput = {
            tables: [...baseSchema.tables, "loose"],
            edges: baseSchema.edges,
        };
        const b = deriveColocation(augmented);
        for (const t of baseSchema.tables) expect(b.assignments[t]).toEqual(a.assignments[t]!);
    });

    test("P3 — parallel/duplicate edges canonicalized", () => {
        const augmented: SchemaInput = {
            tables: baseSchema.tables,
            edges: [
                ...baseSchema.edges,
                fk("messages", "organization", ["organizationId"]), // duplicate
            ],
        };
        const a = deriveColocation(baseSchema);
        const b = deriveColocation(augmented);
        expect(b.digest).toBe(a.digest);
    });

    test("P4 — stable serialization round-trips", () => {
        const r = deriveColocation(baseSchema);
        const s = JSON.stringify(r.assignments);
        expect(JSON.parse(s)).toEqual(r.assignments);
    });

    test("P8 — relations() vs column-FK parity", () => {
        const a = deriveColocation(baseSchema);
        const b = deriveColocation({
            ...baseSchema,
            edges: baseSchema.edges.map(e => ({ ...e, source: "relations-one" as const })),
        });
        expect(b.assignments).toEqual(a.assignments);
    });
});

describe("overrides", () => {
    test("explicit replicated override wins", () => {
        const r = deriveColocation(baseSchema, { overrides: { messages: { kind: "replicated" } } });
        expect(r.assignments["messages"]).toEqual({ kind: "replicated" });
    });

    test("explicit colocate override sets via", () => {
        const r = deriveColocation(baseSchema, {
            overrides: { messages: { kind: "colocate", via: "customCol" } },
        });
        expect(r.assignments["messages"]).toEqual({
            kind: "colocated",
            root: "messages",
            via: ["customCol"],
        });
    });
});

describe("composite FK", () => {
    test("composite vs decomposed FK produces stable output", () => {
        const composite: SchemaInput = {
            tables: ["organization", "user", "members"],
            edges: [
                fk("user", "organization"),
                {
                    source: "fk-column",
                    child: "members",
                    parent: "organization",
                    childCols: ["orgId", "tenant"],
                    parentCols: ["id", "tenant"],
                },
            ],
        };
        const r = deriveColocation(composite);
        expect(r.assignments["members"]).toEqual({
            kind: "colocated",
            root: "organization",
            via: ["orgId", "tenant"],
        });
    });
});
