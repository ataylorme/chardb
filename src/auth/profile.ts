/**
 * The chardb-supported better-auth profile (required, enforced by
 * `chardb doctor auth`).
 *
 * The set of tables surveyed comes from `getAuthTables(options)`
 * (https://github.com/better-auth/better-auth/blob/main/packages/core/src/db/get-tables.ts);
 * profile violations raise `CDB_AUTH_PROFILE_INCOMPATIBLE` at deploy time
 * with each field listed alongside its required value.
 */

import { CdbError } from "../errors.ts";

export interface AuthProfileChecks {
    readonly storeSessionInDatabase: true;
    readonly storeInDatabase: true;
    readonly rateLimitStorage: "database";
}

export const REQUIRED_AUTH_PROFILE: AuthProfileChecks = Object.freeze({
    storeSessionInDatabase: true,
    storeInDatabase: true,
    rateLimitStorage: "database",
});

export interface ProfileViolation {
    readonly field: keyof AuthProfileChecks;
    readonly actual: unknown;
    readonly required: unknown;
}

export function checkAuthProfile(opts: {
    readonly storeSessionInDatabase?: unknown;
    readonly storeInDatabase?: unknown;
    readonly rateLimit?: { storage?: unknown };
}): ProfileViolation[] {
    const out: ProfileViolation[] = [];
    if (opts.storeSessionInDatabase !== true) {
        out.push({
            field: "storeSessionInDatabase",
            actual: opts.storeSessionInDatabase,
            required: true,
        });
    }
    if (opts.storeInDatabase !== true) {
        out.push({ field: "storeInDatabase", actual: opts.storeInDatabase, required: true });
    }
    if (opts.rateLimit?.storage !== "database") {
        out.push({
            field: "rateLimitStorage",
            actual: opts.rateLimit?.storage,
            required: "database",
        });
    }
    return out;
}

export function assertAuthProfile(opts: Parameters<typeof checkAuthProfile>[0]): void {
    const v = checkAuthProfile(opts);
    if (v.length === 0) return;
    throw new CdbError({
        code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
        message: `better-auth options violate the chardb-supported profile: ${v
            .map(f => `${f.field}=${JSON.stringify(f.actual)} (required ${JSON.stringify(f.required)})`)
            .join(", ")}`,
        hint: "configure better-auth per https://chardb.dev/auth/profile",
    });
}
