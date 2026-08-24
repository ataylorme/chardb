import { describe, expect, test } from "bun:test";
import {
    CDB_JSON_MAX_AGGREGATE_MEMBERS,
    CDB_QUERY_ARGS_MAX_BYTES,
    CDB_QUERY_ARGS_MAX_DEPTH,
    assertCdbQueryArgsByteLimit,
    snapshotCdbQueryArgs,
} from "../../src/server/result_limits.ts";
import type { RawJson } from "../../src/types.ts";

function nestedJson(depth: number): RawJson {
    let value: RawJson = null;
    for (let level = 0; level < depth; level++) value = { value };
    return value;
}

describe("server query argument limits", () => {
    test("accepts exact byte, member, and depth boundaries and rejects the next value", () => {
        expect(() =>
            assertCdbQueryArgsByteLimit({ value: "é".repeat((CDB_QUERY_ARGS_MAX_BYTES - 12) / 2) })
        ).not.toThrow();
        expect(() =>
            assertCdbQueryArgsByteLimit(Array.from({ length: CDB_JSON_MAX_AGGREGATE_MEMBERS / 2 }, () => [null]))
        ).not.toThrow();
        expect(() => assertCdbQueryArgsByteLimit(nestedJson(CDB_QUERY_ARGS_MAX_DEPTH))).not.toThrow();

        for (const args of [
            { value: "é".repeat((CDB_QUERY_ARGS_MAX_BYTES - 12) / 2 + 1) },
            Array.from({ length: CDB_JSON_MAX_AGGREGATE_MEMBERS / 2 }, (_, index) =>
                index === 0 ? [null, null] : [null]
            ),
            nestedJson(CDB_QUERY_ARGS_MAX_DEPTH + 1),
        ] as RawJson[]) {
            expect(() => assertCdbQueryArgsByteLimit(args)).toThrow(
                expect.objectContaining({ code: "CDB_INVALID_ARGS", retryable: false })
            );
        }
    });

    test("constructs one owned proxy snapshot without property reads or a second enumeration", () => {
        let ownKeysRuns = 0;
        let getRuns = 0;
        const target: Record<string, RawJson> = { safe: "descriptor-value", hiddenLater: "hostile" };
        const args = new Proxy(target, {
            ownKeys() {
                ownKeysRuns++;
                return ownKeysRuns === 1 ? ["safe"] : ["safe", "hiddenLater"];
            },
            getOwnPropertyDescriptor(targetObject, key) {
                return Reflect.getOwnPropertyDescriptor(targetObject, key);
            },
            get() {
                getRuns++;
                return "hostile-get-value";
            },
        });

        expect(snapshotCdbQueryArgs(args)).toEqual({ safe: "descriptor-value" });
        expect(ownKeysRuns).toBe(1);
        expect(getRuns).toBe(0);
    });
});
