import { describe, expect, test } from "bun:test";
import { resolvePluginPartitionKey } from "../../src/auth/plugin_partition_keys.ts";
import { assertAuthProfile, checkAuthProfile } from "../../src/auth/profile.ts";
import { isCdbError } from "../../src/errors.ts";

describe("chardb-supported better-auth profile", () => {
    test("compliant options produce zero violations", () => {
        expect(
            checkAuthProfile({
                storeSessionInDatabase: true,
                storeInDatabase: true,
                rateLimit: { storage: "database" },
            })
        ).toEqual([]);
    });

    test("non-compliant options enumerate every violation", () => {
        const v = checkAuthProfile({
            storeSessionInDatabase: false,
            storeInDatabase: undefined,
            rateLimit: { storage: "memory" },
        });
        expect(v.length).toBe(3);
        expect(v.map(f => f.field).sort()).toEqual(["rateLimitStorage", "storeInDatabase", "storeSessionInDatabase"]);
    });

    test("assertAuthProfile throws CDB_AUTH_PROFILE_INCOMPATIBLE", () => {
        try {
            assertAuthProfile({
                storeSessionInDatabase: false,
                storeInDatabase: false,
                rateLimit: { storage: "memory" },
            });
            throw new Error("should have thrown");
        } catch (e) {
            if (!isCdbError(e)) throw e;
            expect(e.code).toBe("CDB_AUTH_PROFILE_INCOMPATIBLE");
        }
    });
});

describe("plugin partition-key overrides", () => {
    test("apiKey resolves from configured option", () => {
        expect(resolvePluginPartitionKey("apiKey", { apiKey: { referenceId: "organizationId" } })).toEqual({
            column: "organizationId",
        });
    });

    test("apiKey defaults to userId when unset", () => {
        expect(resolvePluginPartitionKey("apiKey", {})).toEqual({ column: "userId" });
    });

    test("jwks and rateLimit are replicated", () => {
        expect(resolvePluginPartitionKey("jwks", {})).toEqual({ replicated: true });
        expect(resolvePluginPartitionKey("rateLimit", {})).toEqual({ replicated: true });
    });

    test("verification is fixed to userId", () => {
        expect(resolvePluginPartitionKey("verification", {})).toEqual({ column: "userId" });
    });

    test("unknown model returns empty rule", () => {
        expect(resolvePluginPartitionKey("unknown", {})).toEqual({});
    });
});
