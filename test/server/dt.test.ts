import { describe, expect, test } from "bun:test";
import { isCdbError } from "../../src/errors.ts";
import { DT_DDL, crossPartitionMutation } from "../../src/server/dt.ts";

describe("crossPartitionMutation (v1.0 scaffold)", () => {
    test("ddl mentions coordinator + participant tables", () => {
        expect(DT_DDL).toContain("_chardb_dt_state");
        expect(DT_DDL).toContain("_chardb_dt_participant");
    });

    test("invocation raises CDB_DT_NOT_IMPLEMENTED", async () => {
        const fn = crossPartitionMutation<{ x: number }, void>({
            partitions: ["p1", "p2"],
            run: async () => {},
        });
        try {
            await fn({ x: 1 });
            throw new Error("expected throw");
        } catch (e) {
            expect(isCdbError(e)).toBe(true);
            if (isCdbError(e)) expect(e.code).toBe("CDB_DT_NOT_IMPLEMENTED");
        }
    });
});
