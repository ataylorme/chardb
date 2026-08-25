import { describe, expect, test } from "bun:test";
import { type ChardbEnv, handleMigrationAdminRequest } from "../../src/server/entrypoint.ts";

function migrationEnv(catalog: Record<string, unknown>, token = "migration-secret"): ChardbEnv {
    return {
        CDB_ADMIN_TOKEN: token,
        CDB_CATALOG: {
            idFromName: (name: string) => ({ name }),
            get: () => catalog,
        },
    } as unknown as ChardbEnv;
}

function authorized(path: string, init: RequestInit = {}): Request {
    return new Request(`https://worker.example${path}`, {
        ...init,
        headers: { authorization: "Bearer migration-secret", ...init.headers },
    });
}

describe("migration admin endpoint", () => {
    test("keeps an unconfigured endpoint hidden and rejects invalid secrets before Catalog", async () => {
        let calls = 0;
        const catalog = {
            schemaState() {
                calls += 1;
                return {};
            },
        };
        const hidden = migrationEnv(catalog, "") as ChardbEnv;
        expect((await handleMigrationAdminRequest(authorized("/_chardb/migrations/state"), hidden)).status).toBe(404);

        const env = migrationEnv(catalog);
        expect(
            (
                await handleMigrationAdminRequest(
                    new Request("https://worker.example/_chardb/migrations/state", {
                        headers: { authorization: "Bearer wrong" },
                    }),
                    env
                )
            ).status
        ).toBe(403);
        expect(
            (
                await handleMigrationAdminRequest(
                    new Request("https://worker.example/_chardb/migrations/state", {
                        headers: { authorization: `Bearer ${"x".repeat(513)}` },
                    }),
                    env
                )
            ).status
        ).toBe(403);
        expect(calls).toBe(0);
    });

    test("routes the resumable migration sequence to the exact Catalog RPCs", async () => {
        const calls: unknown[] = [];
        const state = {
            activeVersion: 1,
            activeEpoch: 2,
            activeDigest: "digest-1",
            lastMigrationId: null,
            status: "active",
            migrationId: null,
            targetVersion: null,
            targetEpoch: null,
            targetDigest: null,
        } as const;
        const env = migrationEnv({
            schemaState() {
                calls.push("state");
                return state;
            },
            beginSchemaMigration(input: unknown) {
                calls.push(["begin", input]);
                return { ...state, status: "migrating", migrationId: "deploy-2", targetVersion: 2 };
            },
            beginSchemaBaseline(input: unknown) {
                calls.push(["baseline", input]);
                return { ...state, status: "migrating", migrationId: "baseline-1", targetVersion: 1 };
            },
            schemaMigrationShards(input: unknown) {
                calls.push(["shards", input]);
                return [{ shardId: "ShardDO_0", status: "pending", lastError: null, updatedAt: 1 }];
            },
            migrateSchemaShard(input: unknown) {
                calls.push(["shard", input]);
                return { shardId: "ShardDO_0", status: "active", lastError: null, updatedAt: 2 };
            },
            applyCatalogSchemaMigration(input: unknown) {
                calls.push(["catalog", input]);
                return { ...state, status: "migrating", migrationId: "deploy-2", targetVersion: 2 };
            },
            completeSchemaMigration(input: unknown) {
                calls.push(["complete", input]);
                return { ...state, activeVersion: 2, activeEpoch: 3 };
            },
        });

        const stateResponse = await handleMigrationAdminRequest(authorized("/_chardb/migrations/state"), env);
        expect(stateResponse.status).toBe(200);
        expect(await stateResponse.json()).toMatchObject({ ok: true, state: { activeVersion: 1 } });

        const begin = await handleMigrationAdminRequest(
            authorized("/_chardb/migrations/begin", {
                method: "POST",
                body: JSON.stringify({ migrationId: "deploy-2", targetVersion: 2 }),
            }),
            env
        );
        expect(begin.status).toBe(200);
        const baseline = await handleMigrationAdminRequest(
            authorized("/_chardb/migrations/baseline", {
                method: "POST",
                body: JSON.stringify({ migrationId: "baseline-1", targetVersion: 1 }),
            }),
            env
        );
        expect(baseline.status).toBe(200);
        const shards = await handleMigrationAdminRequest(
            authorized("/_chardb/migrations/shards?migrationId=deploy-2"),
            env
        );
        expect(shards.status).toBe(200);
        const shard = await handleMigrationAdminRequest(
            authorized("/_chardb/migrations/shard", {
                method: "POST",
                body: JSON.stringify({ migrationId: "deploy-2", shardId: "ShardDO_0" }),
            }),
            env
        );
        expect(shard.status).toBe(200);
        const catalog = await handleMigrationAdminRequest(
            authorized("/_chardb/migrations/catalog", {
                method: "POST",
                body: JSON.stringify({ migrationId: "deploy-2", version: 2 }),
            }),
            env
        );
        expect(catalog.status).toBe(200);
        const complete = await handleMigrationAdminRequest(
            authorized("/_chardb/migrations/complete", {
                method: "POST",
                body: JSON.stringify({ migrationId: "deploy-2" }),
            }),
            env
        );
        expect(complete.status).toBe(200);
        expect(calls).toEqual([
            "state",
            ["begin", { migrationId: "deploy-2", targetVersion: 2 }],
            ["baseline", { migrationId: "baseline-1", targetVersion: 1 }],
            ["shards", { migrationId: "deploy-2" }],
            ["shard", { migrationId: "deploy-2", shardId: "ShardDO_0" }],
            ["catalog", { migrationId: "deploy-2", version: 2 }],
            ["complete", { migrationId: "deploy-2" }],
        ]);
    });

    test("rejects malformed, oversized, and extra-field bodies before Catalog", async () => {
        let calls = 0;
        const env = migrationEnv({
            beginSchemaMigration() {
                calls += 1;
            },
        });
        for (const body of [
            "{",
            JSON.stringify({ migrationId: "m2", targetVersion: 2, unexpected: true }),
            JSON.stringify({ migrationId: "m2", targetVersion: "2" }),
            JSON.stringify({ migrationId: "m2", targetVersion: 2, padding: "x".repeat(4_096) }),
        ]) {
            const response = await handleMigrationAdminRequest(
                authorized("/_chardb/migrations/begin", { method: "POST", body }),
                env
            );
            expect(response.status).toBe(400);
        }
        expect(calls).toBe(0);
    });
});
