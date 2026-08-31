import { describe, expect, test } from "bun:test";
import { handleOrganizationDeletionAdminRequest } from "../../src/server/organization-deletion-admin.ts";

function namespace(value: object): DurableObjectNamespace {
    return {
        idFromName: (name: string) => ({ name }),
        get: () => value,
    } as unknown as DurableObjectNamespace;
}

function authorized(path: string, init: RequestInit = {}): Request {
    return new Request(`https://worker.example${path}`, {
        ...init,
        headers: { authorization: "Bearer deletion-secret", ...init.headers },
    });
}

describe("private organization deletion status endpoint", () => {
    test("authenticates before Catalog and returns its current-owner projection", async () => {
        let calls = 0;
        const state = {
            organizationId: "org-1",
            authDeleted: true,
            handoffComplete: true,
            handoff: { state: "complete", attempts: 1, completedAt: 20, lastError: null },
            vectorPurge: {
                organizationId: "org-1",
                state: "failed_unproven",
                remainingHeads: 1,
                outboxRows: 1,
                attemptRows: 2,
                unprovenTurns: 32,
                lastError: "terminal: external vector absence could not be proven",
            },
        } as const;
        const catalog = {
            organizationDeletionPurgeStatus(input: unknown) {
                calls++;
                expect(input).toEqual({ organizationId: "org-1" });
                return state;
            },
        };
        const env = { CDB_ADMIN_TOKEN: "deletion-secret", CDB_CATALOG: namespace(catalog) };

        const denied = await handleOrganizationDeletionAdminRequest(
            new Request("https://worker.example/_chardb/organizations/deletion/status?organizationId=org-1"),
            env
        );
        expect(denied.status).toBe(403);
        expect(calls).toBe(0);

        const response = await handleOrganizationDeletionAdminRequest(
            authorized("/_chardb/organizations/deletion/status?organizationId=org-1"),
            env
        );
        expect(response.status).toBe(200);
        expect((await response.json()) as unknown).toEqual({ ok: true, state });
        expect(calls).toBe(1);
    });

    test("accepts only one organizationId and never accepts caller-owned routing", async () => {
        let calls = 0;
        const env = {
            CDB_ADMIN_TOKEN: "deletion-secret",
            CDB_CATALOG: namespace({
                organizationDeletionPurgeStatus() {
                    calls++;
                    return {};
                },
            }),
        };
        for (const path of [
            "/_chardb/organizations/deletion/status",
            "/_chardb/organizations/deletion/status?organizationId=org-1&organizationId=org-2",
            "/_chardb/organizations/deletion/status?organizationId=org-1&shardId=hostile",
        ]) {
            const response = await handleOrganizationDeletionAdminRequest(authorized(path), env);
            expect(response.status).toBe(400);
        }
        expect(calls).toBe(0);
    });

    test("rehydrates Catalog RPC errors before projecting their HTTP status", async () => {
        const env = {
            CDB_ADMIN_TOKEN: "deletion-secret",
            CDB_CATALOG: namespace({
                organizationDeletionPurgeStatus() {
                    throw new Error("CDB_STALE_EPOCH: current owner changed");
                },
            }),
        };
        const response = await handleOrganizationDeletionAdminRequest(
            authorized("/_chardb/organizations/deletion/status?organizationId=org-1"),
            env
        );
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({ ok: false, error: "current owner changed" });
    });
});
