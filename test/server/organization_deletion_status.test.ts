import { describe, expect, test } from "bun:test";
import type { RouteResult } from "../../src/server/do/catalog.ts";
import {
    projectVectorOrganizationPurgeStatus,
    readCurrentOwnerVectorPurgeStatus,
} from "../../src/server/organization-deletion-status.ts";

function route(shardId: string, schemaEpoch: number): RouteResult {
    return { shardId: shardId as RouteResult["shardId"], schemaEpoch, recoveryGeneration: 0, domainSchemaEpoch: 7 };
}

function purge(organizationId: string, remainingHeads: number) {
    return {
        organizationId,
        state: remainingHeads === 0 ? ("complete" as const) : ("pending" as const),
        remainingHeads,
        outboxRows: remainingHeads,
        attemptRows: remainingHeads * 2,
        unprovenTurns: 3,
        lastError: null,
    };
}

describe("current-owner organization deletion purge status", () => {
    test("discards a source result when ownership changes and returns the destination result", async () => {
        const routes = [route("source", 1), route("destination", 2), route("destination", 2), route("destination", 2)];
        const calls: { shardId: string; input: unknown }[] = [];
        const result = await readCurrentOwnerVectorPurgeStatus({
            organizationId: "org-1",
            vshard: 12,
            deps: {
                route: async () => routes.shift() as RouteResult,
                cdb: shardId => ({
                    async vectorOrganizationPurgeStatus(input) {
                        calls.push({ shardId, input });
                        return purge("org-1", shardId === "source" ? 9 : 2);
                    },
                }),
            },
        });
        expect(calls).toEqual([
            {
                shardId: "source",
                input: { organizationId: "org-1", schemaEpoch: 1, recoveryGeneration: 0, domainSchemaEpoch: 7 },
            },
            {
                shardId: "destination",
                input: { organizationId: "org-1", schemaEpoch: 2, recoveryGeneration: 0, domainSchemaEpoch: 7 },
            },
        ]);
        expect(result).toMatchObject({ organizationId: "org-1", remainingHeads: 2 });
    });

    test("retries a failed old owner only when Catalog proves ownership changed", async () => {
        const routes = [route("source", 1), route("destination", 2), route("destination", 2), route("destination", 2)];
        const result = await readCurrentOwnerVectorPurgeStatus({
            organizationId: "org-1",
            vshard: 12,
            deps: {
                route: async () => routes.shift() as RouteResult,
                cdb: shardId => ({
                    async vectorOrganizationPurgeStatus() {
                        if (shardId === "source") throw new Error("old owner fenced");
                        return purge("org-1", 1);
                    },
                }),
            },
        });
        expect(result).toMatchObject({ remainingHeads: 1 });
    });

    test("fails closed on a second ownership drift or malformed Cdb status", async () => {
        const routes = [route("source", 1), route("destination", 2), route("destination", 2), route("third", 3)];
        await expect(
            readCurrentOwnerVectorPurgeStatus({
                organizationId: "org-1",
                vshard: 12,
                deps: {
                    route: async () => routes.shift() as RouteResult,
                    cdb: shardId => ({ vectorOrganizationPurgeStatus: async () => purge("org-1", shardId.length) }),
                },
            })
        ).rejects.toMatchObject({ code: "CDB_STALE_EPOCH" });

        const failedRoutes = [route("source", 1), route("destination", 2), route("destination", 2), route("third", 3)];
        await expect(
            readCurrentOwnerVectorPurgeStatus({
                organizationId: "org-1",
                vshard: 12,
                deps: {
                    route: async () => failedRoutes.shift() as RouteResult,
                    cdb: () => ({
                        vectorOrganizationPurgeStatus: async () => {
                            throw new Error("fenced owner");
                        },
                    }),
                },
            })
        ).rejects.toMatchObject({ code: "CDB_STALE_EPOCH" });

        expect(() =>
            projectVectorOrganizationPurgeStatus({ ...purge("org-1", 1), organizationId: "org-2" }, "org-1")
        ).toThrow(/purge status is invalid/);
        expect(() =>
            projectVectorOrganizationPurgeStatus({ ...purge("org-1", 1), shardId: "caller-owned" }, "org-1")
        ).toThrow(/purge status is invalid/);
        expect(() =>
            projectVectorOrganizationPurgeStatus({ ...purge("org-1", 1), state: "complete", lastError: null }, "org-1")
        ).toThrow(/purge status is inconsistent/);
    });

    test("rehydrates an encoded same-owner Cdb failure", async () => {
        await expect(
            readCurrentOwnerVectorPurgeStatus({
                organizationId: "org-1",
                vshard: 12,
                deps: {
                    route: async () => route("source", 1),
                    cdb: () => ({
                        vectorOrganizationPurgeStatus: async () => {
                            throw new Error("CDB_STALE_EPOCH: source is fenced");
                        },
                    }),
                },
            })
        ).rejects.toMatchObject({ code: "CDB_STALE_EPOCH", message: "source is fenced" });
    });
});
