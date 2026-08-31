import { describe, expect, test } from "bun:test";
import { snapshotMutationArguments } from "../src/client/serialized-json.ts";
import { snapshotCdbMutationArgs } from "../src/server/result_limits.ts";
import type { RawJson } from "../src/types.ts";

function outcome(snapshot: (value: RawJson) => RawJson, value: unknown) {
    try {
        return { ok: true as const, value: snapshot(value as RawJson) };
    } catch (error) {
        return {
            ok: false as const,
            code:
                typeof error === "object" && error !== null && "code" in error
                    ? String((error as { readonly code: unknown }).code)
                    : null,
        };
    }
}

function expectParity(value: unknown): void {
    const client = outcome(snapshotMutationArguments, value);
    const server = outcome(snapshotCdbMutationArgs, value);
    expect(client.ok).toBe(server.ok);
    if (client.ok && server.ok) expect(client.value).toEqual(server.value);
    else expect([client.code, server.code]).toEqual(["CDB_INVALID_ARGS", "CDB_INVALID_ARGS"]);
}

function nestedArrays(depth: number): RawJson {
    let value: RawJson = null;
    for (let index = 0; index < depth; index++) value = [value];
    return value;
}

describe("client/server argument envelope parity", () => {
    test("agrees on representative JSON and UTF-8 edge cases", () => {
        for (const value of [
            null,
            true,
            false,
            0,
            1.25,
            "ascii",
            'quote " slash \\ controls \b\t\n\f\r',
            "é漢😀",
            "\ud800",
            "\udc00",
            { z: [null, { a: "😀", b: "\ud800" }], empty: {} },
        ]) {
            expectParity(value);
        }
    });

    test("agrees at and beyond byte, member, and depth boundaries", () => {
        for (const value of [
            "x".repeat(512 * 1_024 - 2),
            "x".repeat(512 * 1_024 - 1),
            Array.from({ length: 4_096 }, () => null),
            Array.from({ length: 4_097 }, () => null),
            nestedArrays(99),
            nestedArrays(100),
        ]) {
            expectParity(value);
        }
    });

    test("agrees on hostile non-JSON object shapes", () => {
        const sparse = new Array(2);
        sparse[1] = "present";
        const symbolProperty = { ok: true } as Record<PropertyKey, unknown>;
        symbolProperty[Symbol("hidden")] = true;
        const accessor = {};
        Object.defineProperty(accessor, "value", { enumerable: true, get: () => "read" });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        for (const value of [
            undefined,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            -0,
            sparse,
            symbolProperty,
            accessor,
            new Date(),
            cyclic,
        ]) {
            expectParity(value);
        }
    });
});
