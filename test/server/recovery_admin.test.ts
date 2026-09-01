import { describe, expect, test } from "bun:test";
import type { ChardbEnv } from "../../src/server/entrypoint.ts";
import { handleRecoveryAdminRequest } from "../../src/server/recovery-admin.ts";

const TOKEN = "recovery-admin-secret";

interface RecoveryStub {
    adminRecoveryBookmark(args: { atMs?: number }): Promise<{ bookmark: string; atMs: number }>;
    adminArmRecoveryRestore(args: { bookmark: string; armedAt: number }): Promise<{ targetBookmark: string }>;
    adminCancelRecoveryRestore(args: { bookmark: string }): Promise<{ cancelled: boolean }>;
    adminCommitRecoveryRestore(args: { bookmark: string }): Promise<{ scheduled: true }>;
    adminRequeueRecoveryVectors(args: {
        afterCreatedSeq: number;
        limit: number;
        nowMs: number;
    }): Promise<{ processed: number; afterCreatedSeq: number; done: boolean }>;
}

interface TestRecoveryPoint {
    readonly format: string;
    readonly digest: string;
    routingEpoch: number;
    readonly catalog: { readonly bookmark: string };
    readonly shards: readonly { readonly shardId: string; readonly bookmark: string }[];
}

function request(path: string, body: unknown, token = TOKEN): Request {
    return new Request(`https://example.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function shardBookmark(point: TestRecoveryPoint, shardId: string): string {
    const shard = point.shards.find(candidate => candidate.shardId === shardId);
    if (!shard) throw new Error(`missing recovery point shard ${shardId}`);
    return shard.bookmark;
}

function namespace(stubs: ReadonlyMap<string, unknown>): DurableObjectNamespace {
    return {
        idFromName(name: string) {
            return { name };
        },
        get(id: { name: string }) {
            const stub = stubs.get(id.name);
            if (!stub) throw new Error(`missing stub ${id.name}`);
            return stub;
        },
    } as unknown as DurableObjectNamespace;
}

function recoveryStub(name: string, events: string[], failArm = false, armDelayMs = 0): RecoveryStub {
    return {
        async adminRecoveryBookmark(args) {
            events.push(`${name}:bookmark:${args.atMs ?? "now"}`);
            return { bookmark: `00000001-${name.replaceAll("_", "-")}`, atMs: args.atMs ?? 1_000 };
        },
        async adminArmRecoveryRestore(args) {
            events.push(`${name}:arm:${args.bookmark}`);
            if (armDelayMs > 0) await Bun.sleep(armDelayMs);
            if (failArm) throw new Error(`${name} arm failed`);
            return { targetBookmark: args.bookmark };
        },
        async adminCancelRecoveryRestore(args) {
            events.push(`${name}:cancel:${args.bookmark}`);
            return { cancelled: true };
        },
        async adminCommitRecoveryRestore(args) {
            events.push(`${name}:commit:${args.bookmark}`);
            return { scheduled: true };
        },
        async adminRequeueRecoveryVectors(args) {
            events.push(`${name}:reconcile:${args.afterCreatedSeq}:${args.limit}`);
            return { processed: 1, afterCreatedSeq: args.afterCreatedSeq + 1, done: true };
        },
    };
}

function environment(failShard = "", delayedShard = "", routingEpoch = 11): { env: ChardbEnv; events: string[] } {
    const events: string[] = [];
    const catalog = {
        ...recoveryStub("catalog", events),
        async adminRecoveryInventory() {
            events.push("catalog:inventory");
            return {
                schema: {
                    activeVersion: 3,
                    activeEpoch: 7,
                    activeDigest: "a".repeat(64),
                    status: "active" as const,
                },
                routingEpoch,
                shardIds: ["ShardDO_0", "ShardDO_1"],
            };
        },
    };
    const shards = new Map<string, unknown>([
        [
            "ShardDO_0",
            recoveryStub("ShardDO_0", events, failShard === "ShardDO_0", delayedShard === "ShardDO_0" ? 10 : 0),
        ],
        [
            "ShardDO_1",
            recoveryStub("ShardDO_1", events, failShard === "ShardDO_1", delayedShard === "ShardDO_1" ? 10 : 0),
        ],
    ]);
    return {
        events,
        env: {
            CDB_ADMIN_TOKEN: TOKEN,
            CDB_CATALOG: namespace(new Map([["global", catalog]])),
            CDB_SHARD: namespace(shards),
        } as unknown as ChardbEnv,
    };
}

describe("recovery admin", () => {
    test("creates a digested recovery point for Catalog and every sorted shard", async () => {
        const { env, events } = environment();
        const response = await handleRecoveryAdminRequest(request("/_chardb/backups/create", { atMs: 900 }), env);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { readonly ok: boolean; readonly recoveryPoint: TestRecoveryPoint };
        expect(body.ok).toBe(true);
        expect(body.recoveryPoint).toMatchObject({
            format: "chardb-recovery-point/v1",
            atMs: 900,
            schema: { version: 3, epoch: 7, digest: "a".repeat(64) },
            routingEpoch: 11,
            catalog: { bookmark: "00000001-catalog" },
            shards: [
                { shardId: "ShardDO_0", bookmark: "00000001-ShardDO-0" },
                { shardId: "ShardDO_1", bookmark: "00000001-ShardDO-1" },
            ],
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(events[0]).toBe("catalog:inventory");
        expect(events).toContain("catalog:bookmark:900");
        expect(events).toContain("ShardDO_0:bookmark:900");
        expect(events).toContain("ShardDO_1:bookmark:900");
    });

    test("arms Catalog first, commits it last, and rejects a tampered point", async () => {
        const { env, events } = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        events.length = 0;

        const restored = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            env
        );
        expect(restored.status).toBe(202);
        const restoredBody = (await restored.json()) as unknown;
        expect(restoredBody).toEqual({
            ok: true,
            accepted: true,
            recoveryPointDigest: point.digest,
            reconcileAfterMs: 6_000,
        });
        expect(events[0]).toBe("catalog:inventory");
        expect(events[1]).toBe(`catalog:arm:${point.catalog.bookmark}`);
        expect(events.at(-1)).toBe(`catalog:commit:${point.catalog.bookmark}`);
        expect(events).toContain(`ShardDO_0:commit:${shardBookmark(point, "ShardDO_0")}`);
        expect(events).toContain(`ShardDO_1:commit:${shardBookmark(point, "ShardDO_1")}`);

        const tampered = structuredClone(point);
        tampered.routingEpoch++;
        const rejected = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: tampered }),
            env
        );
        expect(rejected.status).toBe(400);
        const rejectedBody = (await rejected.json()) as unknown;
        expect(rejectedBody).toEqual({ ok: false, error: "recovery point digest does not match its contents" });
    });

    test("reconciles every restored shard and requeues authoritative vector heads", async () => {
        const { env, events } = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        events.length = 0;

        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            env
        );
        expect(response.status).toBe(200);
        expect((await response.json()) as unknown).toEqual({
            ok: true,
            reconciled: true,
            recoveryPointDigest: point.digest,
            vectorsRequeued: 2,
        });
        expect(events[0]).toBe("catalog:inventory");
        expect(events).toContain("ShardDO_0:reconcile:0:500");
        expect(events).toContain("ShardDO_1:reconcile:0:500");
    });

    test("rejects topology drift before arming any Durable Object", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const changed = environment("", "", 12);

        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            changed.env
        );
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
            ok: false,
            error: "current topology does not match the recovery point",
            code: "CDB_STALE_EPOCH",
            retryable: true,
        });
        expect(changed.events).toEqual(["catalog:inventory"]);
    });

    test("cancels every completed arm when another shard cannot arm", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const failing = environment("ShardDO_1");
        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            failing.env
        );
        expect(response.status).toBe(500);
        expect((await response.json()) as unknown).toEqual({
            ok: false,
            error: "point-in-time recovery shard arm failed",
            code: "CDB_INVARIANT",
            retryable: false,
        });
        expect(failing.events).toContain(`ShardDO_0:cancel:${shardBookmark(point, "ShardDO_0")}`);
        expect(failing.events).toContain(`catalog:cancel:${point.catalog.bookmark}`);
        expect(failing.events.some(event => event.includes(":commit:"))).toBe(false);
    });

    test("waits for an in-flight arm before cancelling after a neighboring failure", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const failing = environment("ShardDO_1", "ShardDO_0");
        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            failing.env
        );
        expect(response.status).toBe(500);
        expect(failing.events).toContain(`ShardDO_0:cancel:${shardBookmark(point, "ShardDO_0")}`);
        expect(failing.events).toContain(`catalog:cancel:${point.catalog.bookmark}`);
    });

    test("keeps recovery controls private", async () => {
        const { env } = environment();
        const response = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}, "wrong-token"), env);
        expect(response.status).toBe(403);
    });
});
