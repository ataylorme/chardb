/**
 * `parseJsonColumn` covers the contract for JSON-affinity columns in
 * chardb-internal tables (`_chardb_split_log.before`/`after`, etc.). The
 * helper lets the SQL-side `T` narrowing stay loose (the underlying
 * primitive is still TEXT) while keeping the use-site decoder typed and
 * loud-on-corruption.
 */
import { describe, expect, test } from "bun:test";
import { parseJsonColumn } from "../../src/oplog/wrapper.ts";

describe("parseJsonColumn", () => {
    test("null/undefined/empty → null (caller distinguishes 'never set' from '{}')", () => {
        expect(parseJsonColumn("after", null)).toBeNull();
        expect(parseJsonColumn("after", undefined)).toBeNull();
        expect(parseJsonColumn("after", "")).toBeNull();
    });

    test("object root parses to a typed Record<string, RawJson>", () => {
        const row = parseJsonColumn("after", '{"id":"r-1","n":42,"flag":true,"nested":{"k":"v"}}');
        expect(row).toEqual({ id: "r-1", n: 42, flag: true, nested: { k: "v" } });
    });

    test("malformed JSON throws a typed TypeError naming the column", () => {
        expect(() => parseJsonColumn("before", "{not:json}")).toThrow(/chardb: failed to parse JSON column before/);
    });

    test("non-object roots are rejected (arrays, scalars)", () => {
        expect(() => parseJsonColumn("after", "[]")).toThrow(/must decode to an object/);
        expect(() => parseJsonColumn("after", '"plain"')).toThrow(/must decode to an object/);
        expect(() => parseJsonColumn("after", "42")).toThrow(/must decode to an object/);
        expect(() => parseJsonColumn("after", "null")).toThrow(/must decode to an object/);
    });

    test("preserves nested arrays inside an object root", () => {
        const row = parseJsonColumn("after", '{"tags":["a","b"],"counts":[1,2,3]}');
        expect(row).toEqual({ tags: ["a", "b"], counts: [1, 2, 3] });
    });
});
