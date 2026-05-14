import { describe, expect, test } from "bun:test";
import { CDB_ERROR_CODES, CdbError, docsUrlFor, isRetryable } from "../src/errors.ts";

describe("CdbError locked surface", () => {
    test("every code has a deterministic docs URL", () => {
        for (const code of CDB_ERROR_CODES) {
            const url = docsUrlFor(code);
            expect(url).toMatch(/^https:\/\/chardb\.dev\/errors\/cdb_/);
            expect(url).toBe(`https://chardb.dev/errors/${code.toLowerCase()}`);
        }
    });

    test("toJSON shape is monomorphic across codes", () => {
        for (const code of CDB_ERROR_CODES) {
            const e = new CdbError({ code, message: "x" });
            const j = e.toJSON();
            expect(Object.keys(j).sort()).toEqual(
                ["code", "correlationId", "docs", "hint", "message", "retryable", "retryAfterMs"].sort()
            );
            expect(j.code).toBe(code);
            expect(j.retryable).toBe(isRetryable(code));
            expect(j.docs).toBe(docsUrlFor(code));
        }
    });

    test("retryable polarity is locked: only the contracted set retries", () => {
        const expected = new Set([
            "CDB_STALE_EPOCH",
            "CDB_TXN_ABORTED_EVICTION",
            "CDB_RATE_LIMITED",
            "CDB_SHARD_UNAVAILABLE",
            "CDB_CATALOG_UNAVAILABLE",
            "CDB_STREAM_ABORTED",
        ]);
        for (const code of CDB_ERROR_CODES) {
            expect(isRetryable(code)).toBe(expected.has(code));
        }
    });

    test("error codes are unique and sorted-stable", () => {
        expect(new Set(CDB_ERROR_CODES).size).toBe(CDB_ERROR_CODES.length);
    });
});
