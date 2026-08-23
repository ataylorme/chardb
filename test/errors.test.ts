import { describe, expect, test } from "bun:test";
import { CdbError, docsUrlFor, isCdbError, isRetryable } from "../src/errors.ts";

describe("CdbError", () => {
    test("retryable polarity is part of the locked surface", () => {
        expect(isRetryable("CDB_RATE_LIMITED")).toBe(true);
        expect(isRetryable("CDB_TXN_ABORTED_EVICTION")).toBe(true);
        expect(isRetryable("CDB_STALE_EPOCH")).toBe(true);
        expect(isRetryable("CDB_CROSS_PARTITION")).toBe(false);
        expect(isRetryable("CDB_FORBIDDEN")).toBe(false);
        expect(isRetryable("CDB_MUT_ID_COLLISION")).toBe(false);
        expect(isRetryable("CDB_INVALID_ARGS")).toBe(false);
    });

    test("docs url format is stable", () => {
        expect(docsUrlFor("CDB_CROSS_PARTITION")).toBe("https://chardb.dev/errors/cdb_cross_partition");
    });

    test("toJSON shape matches the wire envelope error contract", () => {
        const err = new CdbError({
            code: "CDB_RATE_LIMITED",
            message: "queue depth exceeded",
            correlationId: "corr-1",
            retryAfterMs: 250,
            hint: "back off then retry",
        });
        const j = err.toJSON();
        expect(j.code).toBe("CDB_RATE_LIMITED");
        expect(j.retryable).toBe(true);
        expect(j.docs).toBe("https://chardb.dev/errors/cdb_rate_limited");
        expect(j.retryAfterMs).toBe(250);
        expect(j.hint).toBe("back off then retry");
        expect(isCdbError(err)).toBe(true);
    });

    test("isCdbError narrows non-CdbError to false", () => {
        expect(isCdbError(new Error("vanilla"))).toBe(false);
        expect(isCdbError("string")).toBe(false);
        expect(isCdbError(null)).toBe(false);
    });
});
