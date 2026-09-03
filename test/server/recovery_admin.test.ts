import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { RecoveryCoordinatorStore } from "../../src/server/do/recovery-coordinator.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import type { ChardbEnv } from "../../src/server/entrypoint.ts";
import { handleRecoveryAdminRequest } from "../../src/server/recovery-admin.ts";
import { signRecoveryContinuation } from "../../src/server/recovery-continuation.ts";

const TOKEN = "recovery-admin-secret";
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";

interface RecoveryStub {
    adminRecoveryBookmark(args: { atMs?: number }): Promise<{ bookmark: string; atMs: number }>;
    adminArmRecoveryRestore(args: {
        bookmark: string;
        armedAt: number;
        operationId: string;
        generation: number;
    }): Promise<{ targetBookmark: string }>;
    adminReleaseRecovery(args: { operationId: string; generation: number }): Promise<{ released: true }>;
    adminCancelRecoveryRestore(args: { bookmark: string }): Promise<{ cancelled: boolean }>;
    adminCommitRecoveryRestore(args: { bookmark: string }): Promise<{ scheduled: true }>;
    adminRecoveryRestoreStatus(args: { bookmark: string }): Promise<{ state: "armed" | "absent" }>;
    adminScrubRecoveryVectors(args: {
        bookmark: string;
        afterVectorId: string;
        afterPhysicalVersion: number;
        limit: number;
    }): Promise<{ processed: number; afterVectorId: string; afterPhysicalVersion: number; done: boolean }>;
    adminRequeueRecoveryVectors(args: {
        afterCreatedSeq: number;
        limit: number;
        nowMs: number;
    }): Promise<{ processed: number; afterCreatedSeq: number; done: boolean }>;
    adminRetainRecoveryFiles(args: {
        bookmark: string;
        afterFileId: string;
        limit: number;
    }): Promise<{ processed: number; afterFileId: string; done: boolean }>;
    adminRehydrateRecoveryFiles(args: {
        afterFileId: string;
        limit: number;
    }): Promise<{ processed: number; afterFileId: string; done: boolean }>;
    adminSettleRecoveryVectors(args: { bookmark: string }): Promise<{ pending: number; terminal: number }>;
    adminQuiesceRecoveryVectors(args: { bookmark: string }): Promise<{ pending: number; terminal: number }>;
}

interface TestRecoveryPoint {
    readonly format: string;
    readonly digest: string;
    routingEpoch: number;
    readonly catalog: { readonly bookmark: string };
    readonly shards: readonly { readonly shardId: string; readonly bookmark: string }[];
}

function request(path: string, body: unknown, token = TOKEN): Request {
    const payload =
        (path.endsWith("/restore") || path.endsWith("/reconcile")) &&
        typeof body === "object" &&
        body !== null &&
        !("operationId" in body)
            ? { ...body, operationId: OPERATION_ID }
            : body;
    return new Request(`https://example.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
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

function recoveryCoordinator() {
    const db = new Database(":memory:");
    const sql = adaptSqlStorage(sqlStorage(db) as unknown as SqlStorage);
    const transaction = <T>(callback: (store: RecoveryCoordinatorStore) => T): T =>
        db.transaction(() => callback(new RecoveryCoordinatorStore(sql)))();
    return {
        async adminRecoveryAdmissionClock() {
            return new RecoveryCoordinatorStore(sql).admissionClock();
        },
        async adminRecoveryCoordinatorState(args: { operationId: string }) {
            return new RecoveryCoordinatorStore(sql).read(args.operationId);
        },
        async adminActiveRecoveryForDigest(args: { digest: string }) {
            return new RecoveryCoordinatorStore(sql).activeForDigest(args.digest);
        },
        async adminClaimRecoveryPreparation(args: {
            operationId: string;
            digest: string;
            continuationJson: string;
        }) {
            return transaction(store => store.claimPreparation(args.operationId, args.digest, args.continuationJson));
        },
        async adminSaveRecoveryPreparation(args: { operationId: string; continuationJson: string }) {
            return transaction(store => store.savePreparation(args.operationId, args.continuationJson));
        },
        async adminCancelRecoveryPreparation(args: { operationId: string }) {
            return transaction(store => store.cancelPreparation(args.operationId));
        },
        async adminBeginRecoveryCommits(args: {
            operationId: string;
            counts: { files: number; filesRetained: number; vectors: number };
        }) {
            return transaction(store => store.beginCommits(args.operationId, args.counts));
        },
        async adminFinishRecoveryShardCommits(args: {
            operationId: string;
            continuationJson: string;
            shardCount: number;
        }) {
            return transaction(store => store.finishShards(args.operationId, args.continuationJson, args.shardCount));
        },
        async adminAdvanceRecoveryShardCommit(args: { operationId: string; index: number; objectId: string }) {
            return transaction(store => store.advanceShard(args.operationId, args.index, args.objectId));
        },
        async adminSaveRecoveryReconcile(args: { operationId: string; continuationJson: string }) {
            return transaction(store => store.saveReconcile(args.operationId, args.continuationJson));
        },
        async adminBeginRecoveryReleases(args: {
            operationId: string;
            counts: { filesRehydrated: number; vectorsRequeued: number };
        }) {
            return transaction(store => store.beginReleases(args.operationId, args.counts));
        },
        async adminAdvanceRecoveryRelease(args: { operationId: string; index: number }) {
            return transaction(store => store.advanceRelease(args.operationId, args.index));
        },
        async adminBeginRecoveryCatalogCommit(args: { operationId: string; shardCount: number }) {
            return transaction(store => store.beginCatalog(args.operationId, args.shardCount));
        },
        async adminCompleteRecovery(args: { operationId: string }) {
            return transaction(store => store.complete(args.operationId));
        },
        async adminBeginRecoveryObjectCommit(args: { operationId: string; objectId: string; bookmark: string }) {
            return transaction(store => store.beginObject(args.operationId, args.objectId, args.bookmark));
        },
        async adminFinishRecoveryObjectCommit(args: { operationId: string; objectId: string; bookmark: string }) {
            return transaction(store => store.finishObject(args.operationId, args.objectId, args.bookmark));
        },
    };
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

function recoveryStub(
    name: string,
    events: string[],
    failArm = false,
    armDelayMs = 0,
    failScrub = false,
    failCommitOnce = false,
    scrubPages = 0
): RecoveryStub {
    let commitAttempts = 0;
    let scrubAttempts = 0;
    let armFailures = failArm ? 1 : 0;
    let armedBookmark: string | null = null;
    return {
        async adminRecoveryBookmark(args) {
            events.push(`${name}:bookmark:${args.atMs ?? "now"}`);
            return { bookmark: `00000001-${name.replaceAll("_", "-")}`, atMs: args.atMs ?? 1_000 };
        },
        async adminArmRecoveryRestore(args) {
            events.push(`${name}:arm:${args.bookmark}`);
            if (armDelayMs > 0) await Bun.sleep(armDelayMs);
            if (armFailures > 0) {
                armFailures--;
                throw new Error(`${name} arm failed`);
            }
            armedBookmark = args.bookmark;
            return { targetBookmark: args.bookmark };
        },
        async adminReleaseRecovery(args) {
            events.push(`${name}:release:${args.operationId}:${args.generation}`);
            return { released: true };
        },
        async adminCancelRecoveryRestore(args) {
            events.push(`${name}:cancel:${args.bookmark}`);
            armedBookmark = null;
            return { cancelled: true };
        },
        async adminCommitRecoveryRestore(args) {
            events.push(`${name}:commit:${args.bookmark}`);
            commitAttempts++;
            armedBookmark = null;
            if (failCommitOnce && commitAttempts === 1) throw new Error(`${name} commit response lost`);
            return { scheduled: true };
        },
        async adminRecoveryRestoreStatus(args) {
            if (armedBookmark !== null && armedBookmark !== args.bookmark) throw new Error("wrong recovery bookmark");
            return { state: armedBookmark === null ? "absent" : "armed" };
        },
        async adminScrubRecoveryVectors(args) {
            events.push(
                `${name}:scrub:${args.bookmark}:${args.afterVectorId}:${args.afterPhysicalVersion}:${args.limit}`
            );
            if (failScrub) throw new Error(`${name} scrub failed`);
            if (scrubAttempts < scrubPages) {
                scrubAttempts++;
                return {
                    processed: 1,
                    afterVectorId: `vec_${String(scrubAttempts).padStart(4, "0")}`,
                    afterPhysicalVersion: 1,
                    done: false,
                };
            }
            return {
                processed: 0,
                afterVectorId: args.afterVectorId,
                afterPhysicalVersion: args.afterPhysicalVersion,
                done: true,
            };
        },
        async adminRequeueRecoveryVectors(args) {
            events.push(`${name}:reconcile:${args.afterCreatedSeq}:${args.limit}`);
            return { processed: 1, afterCreatedSeq: args.afterCreatedSeq + 1, done: true };
        },
        async adminRetainRecoveryFiles(args) {
            events.push(`${name}:retain:${args.bookmark}:${args.afterFileId}:${args.limit}`);
            return { processed: 0, afterFileId: args.afterFileId, done: true };
        },
        async adminRehydrateRecoveryFiles(args) {
            events.push(`${name}:rehydrate:${args.afterFileId}:${args.limit}`);
            return { processed: 0, afterFileId: args.afterFileId, done: true };
        },
        async adminSettleRecoveryVectors() {
            return { pending: 0, terminal: 0 };
        },
        async adminQuiesceRecoveryVectors() {
            events.push(`${name}:quiesce`);
            return { pending: 0, terminal: 0 };
        },
    };
}

function environment(
    failShard = "",
    delayedShard = "",
    routingEpoch = 11,
    failScrubShard = "",
    failCommitOnceShard = "",
    scrubPagesShard = "",
    scrubPages = 0,
    shardCount = 2
): {
    env: ChardbEnv;
    events: string[];
    stubs: Map<string, unknown>;
    coordinator: ReturnType<typeof recoveryCoordinator>;
} {
    const events: string[] = [];
    const shardIds = Array.from({ length: shardCount }, (_, index) => `ShardDO_${index}`).sort();
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
                shardIds,
            };
        },
    };
    const shards = new Map<string, unknown>(
        shardIds.map(
            shardId =>
                [
                    shardId,
                    recoveryStub(
                        shardId,
                        events,
                        failShard === shardId,
                        delayedShard === shardId ? 10 : 0,
                        failScrubShard === shardId,
                        failCommitOnceShard === shardId,
                        scrubPagesShard === shardId ? scrubPages : 0
                    ),
                ] as const
        )
    );
    shards.set("catalog", catalog);
    const coordinator = recoveryCoordinator();
    return {
        events,
        stubs: shards,
        coordinator,
        env: {
            CDB_ADMIN_TOKEN: TOKEN,
            CDB_CATALOG: namespace(new Map([["global", catalog]])),
            CDB_SHARD: namespace(shards),
            CDB_RESHARD: namespace(new Map([["global", coordinator]])),
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

    test("captures Catalog and every shard at one timestamp when no time is supplied", async () => {
        const { env, events } = environment();
        const response = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), env);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { readonly recoveryPoint: { readonly atMs: number } };
        const bookmarks = events.filter(event => event.includes(":bookmark:"));
        expect(bookmarks).toHaveLength(3);
        expect(new Set(bookmarks.map(event => Number(event.slice(event.lastIndexOf(":") + 1))))).toEqual(
            new Set([body.recoveryPoint.atMs])
        );
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
            operationId: OPERATION_ID,
            recoveryPointDigest: point.digest,
            reconcileAfterMs: 6_000,
            providerReset: { files: 0, filesRetained: 0, vectors: 0 },
        });
        expect(events[0]).toBe("catalog:inventory");
        expect(events[1]).toBe(`catalog:arm:${point.catalog.bookmark}`);
        expect(events).not.toContain(`catalog:commit:${point.catalog.bookmark}`);
        expect(events).toContain(`ShardDO_0:commit:${shardBookmark(point, "ShardDO_0")}`);
        expect(events).toContain(`ShardDO_1:commit:${shardBookmark(point, "ShardDO_1")}`);
        expect(events).toContain(`ShardDO_0:scrub:${shardBookmark(point, "ShardDO_0")}::0:32`);
        expect(events).toContain(`ShardDO_1:scrub:${shardBookmark(point, "ShardDO_1")}::0:32`);
        expect(events.indexOf(`ShardDO_0:retain:${shardBookmark(point, "ShardDO_0")}::8`)).toBeLessThan(
            events.indexOf(`ShardDO_0:scrub:${shardBookmark(point, "ShardDO_0")}::0:32`)
        );

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
        const restored = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            env
        );
        expect(restored.status).toBe(202);
        events.length = 0;

        const pending = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            env
        );
        expect(pending.status).toBe(202);
        const released = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            env
        );
        expect(released.status).toBe(202);
        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            env
        );
        expect(response.status).toBe(200);
        expect((await response.json()) as unknown).toEqual({
            ok: true,
            reconciled: true,
            operationId: OPERATION_ID,
            recoveryPointDigest: point.digest,
            filesRehydrated: 0,
            vectorsRequeued: 2,
        });
        expect(events[0]).toBe("catalog:inventory");
        expect(events).toContain("ShardDO_0:reconcile:0:500");
        expect(events).toContain("ShardDO_1:reconcile:0:500");
        expect(events).toContain("ShardDO_0:rehydrate::8");
        expect(events).toContain("ShardDO_1:rehydrate::8");
        expect(events).toContain(`catalog:commit:${point.catalog.bookmark}`);
    });

    test("keeps Catalog fenced until every vector outbox settles", async () => {
        const setup = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), setup.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        expect(
            (await handleRecoveryAdminRequest(request("/_chardb/backups/restore", { recoveryPoint: point }), setup.env))
                .status
        ).toBe(202);
        let polls = 0;
        (setup.stubs.get("ShardDO_0") as RecoveryStub).adminSettleRecoveryVectors = async () => ({
            pending: polls++ === 0 ? 1 : 0,
            terminal: 0,
        });

        const first = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(first.status).toBe(202);
        expect(setup.events.some(event => event.startsWith("catalog:commit:"))).toBe(false);
        const second = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(second.status).toBe(202);
        expect(setup.events.some(event => event.startsWith("catalog:commit:"))).toBe(false);
        const released = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(released.status).toBe(202);
        const completed = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(completed.status).toBe(200);
        expect(setup.events).toContain(`catalog:commit:${point.catalog.bookmark}`);
    });

    test("keeps Catalog fenced on terminal vector delivery failure", async () => {
        const setup = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), setup.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        await handleRecoveryAdminRequest(request("/_chardb/backups/restore", { recoveryPoint: point }), setup.env);
        (setup.stubs.get("ShardDO_0") as RecoveryStub).adminSettleRecoveryVectors = async () => ({
            pending: 1,
            terminal: 1,
        });
        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(response.status).toBe(500);
        expect((await response.json()) as unknown).toMatchObject({
            code: "CDB_INVARIANT",
            error: "vector recovery reached a terminal provider failure",
        });
        expect(setup.events.some(event => event.startsWith("catalog:commit:"))).toBe(false);
    });

    test("polls a scheduled Catalog restore before proving final inventory", async () => {
        const setup = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), setup.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        await handleRecoveryAdminRequest(request("/_chardb/backups/restore", { recoveryPoint: point }), setup.env);
        const catalog = setup.stubs.get("catalog") as RecoveryStub;
        let statusReads = 0;
        catalog.adminRecoveryRestoreStatus = async () => ({
            state: statusReads++ < 2 ? "armed" : "absent",
        });
        catalog.adminCommitRecoveryRestore = async args => {
            setup.events.push(`catalog:commit:${args.bookmark}`);
            return { scheduled: true };
        };

        const pending = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(pending.status).toBe(202);
        const released = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(released.status).toBe(202);
        const settling = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(settling.status).toBe(202);
        expect(setup.events.filter(event => event === `catalog:commit:${point.catalog.bookmark}`)).toHaveLength(1);
        const before = setup.events.filter(event => event === "catalog:inventory").length;
        const completed = await handleRecoveryAdminRequest(
            request("/_chardb/backups/reconcile", { recoveryPoint: point }),
            setup.env
        );
        expect(completed.status).toBe(200);
        expect(setup.events.filter(event => event === "catalog:inventory").length).toBeGreaterThan(before);
        expect(setup.events.filter(event => event === `catalog:commit:${point.catalog.bookmark}`)).toHaveLength(1);
    });

    test("deletes every managed live R2 object before committing the restore", async () => {
        const setup = environment();
        const objects = new Set(["v1/org-a/file-a", "v1/org-b/file-b", "_chardb/retained/sha256/keep"]);
        const deleted: string[] = [];
        const bucket = {
            async list(options: { prefix?: string; limit?: number }) {
                const keys = [...objects].filter(key => key.startsWith(options.prefix ?? "")).slice(0, options.limit);
                return { objects: keys.map(key => ({ key })), truncated: false };
            },
            async delete(value: string | string[]) {
                for (const key of Array.isArray(value) ? value : [value]) {
                    deleted.push(key);
                    objects.delete(key);
                }
            },
        } as unknown as R2Bucket;
        const env = { ...setup.env, CDB_FILES: bucket };
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;

        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            env
        );
        expect(response.status).toBe(202);
        expect((await response.json()) as unknown).toMatchObject({
            providerReset: { files: 2, filesRetained: 0, vectors: 0 },
        });
        expect(deleted.sort()).toEqual(["v1/org-a/file-a", "v1/org-b/file-b"]);
        expect(objects).toEqual(new Set(["_chardb/retained/sha256/keep"]));
    });

    test("keeps every fence and durable cursor when provider scrub fails", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const failing = environment("", "", 11, "ShardDO_1");

        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            failing.env
        );
        expect(response.status).toBe(503);
        expect(failing.events.some(event => event.includes(":cancel:"))).toBe(false);
        expect(failing.events.some(event => event.includes(":reconcile:"))).toBe(false);
        expect(failing.events.some(event => event.includes(":commit:"))).toBe(false);
    });

    test("replays the same recovery point after a shard commit response is lost", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const retrying = environment("", "", 11, "", "ShardDO_1");

        const first = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            retrying.env
        );
        expect(first.status).toBe(503);
        const second = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            retrying.env
        );
        expect(second.status).toBe(202);
        expect(retrying.events.filter(event => event === `catalog:arm:${point.catalog.bookmark}`)).toHaveLength(1);
        expect(
            retrying.events.filter(event => event === `ShardDO_1:commit:${shardBookmark(point, "ShardDO_1")}`)
        ).toHaveLength(1);
        expect(retrying.events).toContain(`ShardDO_1:commit:${shardBookmark(point, "ShardDO_1")}`);
    });

    test("continues a large provider scrub in signed bounded turns", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const bounded = environment("", "", 11, "", "", "ShardDO_0", 40);

        const first = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            bounded.env
        );
        expect(first.status).toBe(202);
        const pending = (await first.json()) as {
            readonly pending: boolean;
            readonly continuation: Record<string, unknown>;
        };
        expect(pending.pending).toBe(true);
        expect(bounded.events.some(event => event.includes(":commit:"))).toBe(false);

        const tampered = structuredClone(pending.continuation);
        (tampered.state as Record<string, unknown>).vectors = 0;
        const rejected = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point, continuation: tampered }),
            bounded.env
        );
        expect(rejected.status).toBe(400);
        expect((await rejected.json()) as unknown).toEqual({
            ok: false,
            error: "recovery continuation signature is invalid",
        });

        let continuation = pending.continuation;
        let completed: Record<string, unknown> | undefined;
        for (let turn = 0; turn < 45; turn++) {
            const before = bounded.events.filter(event => event.includes(":scrub:")).length;
            const response = await handleRecoveryAdminRequest(
                request("/_chardb/backups/restore", { recoveryPoint: point, continuation }),
                bounded.env
            );
            expect(response.status).toBe(202);
            expect(bounded.events.filter(event => event.includes(":scrub:")).length - before).toBeLessThanOrEqual(2);
            const body = (await response.json()) as Record<string, unknown>;
            if (body.pending !== true) {
                completed = body;
                break;
            }
            continuation = body.continuation as Record<string, unknown>;
        }
        expect(completed).toMatchObject({
            accepted: true,
            providerReset: { files: 0, vectors: 40 },
        });
        expect(bounded.events.at(-1)).toBe(`ShardDO_1:commit:${shardBookmark(point, "ShardDO_1")}`);
    });

    test("resumes the server-owned cursor when the client loses its continuation", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const restarting = environment("", "", 11, "", "", "ShardDO_0", 40);

        const first = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            restarting.env
        );
        expect(first.status).toBe(202);
        const before = restarting.events.length;
        const resumed = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            restarting.env
        );
        expect(resumed.status).toBe(202);
        expect(restarting.events.slice(before)).toContain(
            `ShardDO_0:scrub:${shardBookmark(point, "ShardDO_0")}:vec_0001:1:32`
        );
        expect(restarting.events.filter(event => event.startsWith("catalog:arm:"))).toHaveLength(1);
    });

    test("commits 33 shards across fresh requests without replaying a completed shard", async () => {
        const setup = environment("", "", 11, "", "", "", 0, 33);
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), setup.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        let accepted = false;
        for (let turn = 0; turn < 12; turn++) {
            const response = await handleRecoveryAdminRequest(
                request("/_chardb/backups/restore", { recoveryPoint: point }),
                setup.env
            );
            expect(response.status).toBe(202);
            const body = (await response.json()) as { readonly accepted?: boolean };
            if (body.accepted === true) {
                accepted = true;
                break;
            }
        }
        expect(accepted).toBe(true);
        for (const shard of point.shards) {
            expect(setup.events.filter(event => event === `${shard.shardId}:commit:${shard.bookmark}`)).toHaveLength(1);
        }
    });

    test("returns a positive retry delay while a shard activation is delayed", async () => {
        const setup = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), setup.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const shard = setup.stubs.get("ShardDO_0") as RecoveryStub;
        let statusReads = 0;
        shard.adminRecoveryRestoreStatus = async () => ({ state: statusReads++ < 4 ? "armed" : "absent" });
        shard.adminCommitRecoveryRestore = async args => {
            setup.events.push(`ShardDO_0:commit:${args.bookmark}`);
            return { scheduled: true };
        };

        const first = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            setup.env
        );
        const firstBody = (await first.json()) as {
            readonly continuation: unknown;
            readonly retryAfterMs: number;
        };
        expect(first.status).toBe(202);
        expect(firstBody.retryAfterMs).toBe(6_000);

        const second = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            setup.env
        );
        const secondBody = (await second.json()) as {
            readonly continuation: unknown;
            readonly retryAfterMs: number;
        };
        expect(second.status).toBe(202);
        expect(secondBody.retryAfterMs).toBe(6_000);
        expect(secondBody.continuation).toEqual(firstBody.continuation);
        expect(setup.events.filter(event => event.startsWith("ShardDO_0:commit:"))).toHaveLength(2);
    });

    test("retains current files in bounded turns and reports the exact refreshed count", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const retained = environment();
        let pages = 0;
        const shard = retained.stubs.get("ShardDO_0") as RecoveryStub;
        shard.adminRetainRecoveryFiles = async args => {
            retained.events.push(`ShardDO_0:retain:${args.bookmark}:${args.afterFileId}:${args.limit}`);
            if (pages++ < 10) {
                const afterFileId = `file_${String(pages).padStart(2, "0")}`;
                return { processed: 1, afterFileId, done: false };
            }
            return { processed: 0, afterFileId: args.afterFileId, done: true };
        };

        let continuation: Record<string, unknown> | undefined;
        let completed: Record<string, unknown> | undefined;
        for (let turn = 0; turn < 16; turn++) {
            const response = await handleRecoveryAdminRequest(
                request(
                    "/_chardb/backups/restore",
                    continuation ? { recoveryPoint: point, continuation } : { recoveryPoint: point }
                ),
                retained.env
            );
            expect(response.status).toBe(202);
            const body = (await response.json()) as Record<string, unknown>;
            if (body.pending !== true) {
                completed = body;
                break;
            }
            continuation = body.continuation as Record<string, unknown>;
        }

        expect(completed).toMatchObject({
            accepted: true,
            providerReset: { files: 0, filesRetained: 10, vectors: 0 },
        });
        expect(retained.events.filter(event => event.startsWith("ShardDO_0:retain:"))).toHaveLength(11);
    });

    test("bounds a signed retention continuation whose file scan never ends", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const endless = environment();
        const shard = endless.stubs.get("ShardDO_0") as RecoveryStub;
        shard.adminRetainRecoveryFiles = async args => ({
            processed: 1,
            afterFileId: `${args.afterFileId}x`,
            done: false,
        });
        const continuation = await signRecoveryContinuation(endless.env, OPERATION_ID, point.digest, {
            kind: "restore",
            phase: "retention",
            shardIndex: 0,
            afterRetainedFileId: "file_cursor",
            afterVectorId: "",
            afterPhysicalVersion: 0,
            files: 0,
            filePages: 0,
            filesRetained: 625_000,
            retentionPages: 625_000,
            quiescenceTurns: 0,
            vectors: 0,
            vectorPages: 0,
            commitPolls: 0,
        });

        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point, continuation }),
            endless.env
        );
        expect(response.status).toBe(429);
        expect((await response.json()) as unknown).toMatchObject({
            code: "CDB_RATE_LIMITED",
            error: "file retention exceeded its page bound",
        });
    });

    test("bounds a signed continuation whose provider never reaches a terminal page", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const endless = environment("", "", 11, "", "", "ShardDO_0", 20_000);
        const continuation = await signRecoveryContinuation(endless.env, OPERATION_ID, point.digest, {
            kind: "restore",
            phase: "vectors",
            shardIndex: 0,
            afterRetainedFileId: "",
            afterVectorId: "",
            afterPhysicalVersion: 0,
            files: 0,
            filePages: 0,
            filesRetained: 0,
            retentionPages: 0,
            quiescenceTurns: 0,
            vectors: 0,
            vectorPages: 10_000,
            commitPolls: 0,
        });
        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point, continuation }),
            endless.env
        );
        expect(response.status).toBe(429);
        expect((await response.json()) as unknown).toEqual({
            ok: false,
            error: "vector recovery scrub exceeded its page bound",
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });
        expect(endless.events.some(event => event.includes(":commit:"))).toBe(false);
    });

    test("allows the terminal empty R2 probe after the last bounded deletion page", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const continued = environment();
        const continuation = await signRecoveryContinuation(continued.env, OPERATION_ID, point.digest, {
            kind: "restore",
            phase: "files",
            shardIndex: 0,
            afterRetainedFileId: "",
            afterVectorId: "",
            afterPhysicalVersion: 0,
            files: 10_000_000,
            filePages: 10_000,
            filesRetained: 0,
            retentionPages: 0,
            quiescenceTurns: 0,
            vectors: 0,
            vectorPages: 0,
            commitPolls: 0,
        });
        let lists = 0;
        const env = {
            ...continued.env,
            CDB_FILES: {
                async list() {
                    lists++;
                    return { objects: [], truncated: false };
                },
            } as unknown as R2Bucket,
        };

        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point, continuation }),
            env
        );
        expect(response.status).toBe(202);
        expect((await response.json()) as unknown).toMatchObject({
            accepted: true,
            providerReset: { files: 10_000_000, vectors: 0 },
        });
        expect(lists).toBe(1);
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

    test("cancels an unarmed claim when Catalog changes after preflight", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const setup = environment();
        const catalog = setup.stubs.get("catalog") as RecoveryStub;
        const arm = catalog.adminArmRecoveryRestore.bind(catalog);
        let drift = true;
        catalog.adminArmRecoveryRestore = async args => {
            if (drift) {
                drift = false;
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "Catalog changed after recovery preflight" });
            }
            return arm(args);
        };

        const rejected = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            setup.env
        );
        expect(rejected.status).toBe(409);
        expect(await setup.coordinator.adminRecoveryAdmissionClock()).toEqual({
            generation: 1,
            activeOperationId: null,
            activeDigest: null,
        });

        const retried = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", {
                recoveryPoint: point,
                operationId: "00000000-0000-4000-8000-000000000002",
            }),
            setup.env
        );
        expect(retried.status).toBe(202);
        expect(await setup.coordinator.adminRecoveryAdmissionClock()).toMatchObject({
            generation: 2,
            activeOperationId: "00000000-0000-4000-8000-000000000002",
        });
    });

    test("keeps prior fences and retries the exact failed shard arm", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const failing = environment("ShardDO_1");
        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            failing.env
        );
        expect(response.status).toBe(503);
        expect((await response.json()) as unknown).toEqual({
            ok: false,
            error: "point-in-time recovery shard arm failed",
            code: "CDB_SHARD_UNAVAILABLE",
            retryable: true,
        });
        expect(failing.events.some(event => event.includes(":cancel:"))).toBe(false);
        expect(
            await (failing.stubs.get("catalog") as RecoveryStub).adminRecoveryRestoreStatus({
                bookmark: point.catalog.bookmark,
            })
        ).toEqual({ state: "armed" });
        expect(
            await (failing.stubs.get("ShardDO_0") as RecoveryStub).adminRecoveryRestoreStatus({
                bookmark: shardBookmark(point, "ShardDO_0"),
            })
        ).toEqual({ state: "armed" });
        expect(failing.events.some(event => event.includes(":commit:"))).toBe(false);
        const resumed = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            failing.env
        );
        expect(resumed.status).toBe(202);
        expect(failing.events.filter(event => event.startsWith("catalog:arm:"))).toHaveLength(1);
        expect(failing.events.filter(event => event.startsWith("ShardDO_0:arm:"))).toHaveLength(1);
        expect(failing.events.filter(event => event.startsWith("ShardDO_1:arm:"))).toHaveLength(2);
    });

    test("does not unwind a completed slow arm after a neighboring failure", async () => {
        const healthy = environment();
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), healthy.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;
        const failing = environment("ShardDO_1", "ShardDO_0");
        const response = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            failing.env
        );
        expect(response.status).toBe(503);
        expect(failing.events.some(event => event.includes(":cancel:"))).toBe(false);
        expect(
            await (failing.stubs.get("ShardDO_0") as RecoveryStub).adminRecoveryRestoreStatus({
                bookmark: shardBookmark(point, "ShardDO_0"),
            })
        ).toEqual({ state: "armed" });
        const resumed = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            failing.env
        );
        expect(resumed.status).toBe(202);
    });

    test("keeps recovery controls private", async () => {
        const { env } = environment();
        const response = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}, "wrong-token"), env);
        expect(response.status).toBe(403);
    });

    test("durably quiesces pre-arm vector work before the first provider scrub", async () => {
        const setup = environment();
        const shard = setup.stubs.get("ShardDO_0") as RecoveryStub;
        let turns = 0;
        shard.adminQuiesceRecoveryVectors = async () => {
            turns++;
            const pending = Math.max(0, 3 - turns);
            setup.events.push(`ShardDO_0:quiesce-pending:${pending}`);
            return { pending, terminal: 0 };
        };
        const created = await handleRecoveryAdminRequest(request("/_chardb/backups/create", {}), setup.env);
        const point = ((await created.json()) as { readonly recoveryPoint: TestRecoveryPoint }).recoveryPoint;

        const first = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            setup.env
        );
        expect(first.status).toBe(202);
        expect((await first.json()) as unknown).toMatchObject({ pending: true, retryAfterMs: 1_000 });

        // Lose the response token twice. The coordinator-owned cursor still
        // resumes the same shard and never starts scrub early.
        const second = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            setup.env
        );
        expect(second.status).toBe(202);
        const third = await handleRecoveryAdminRequest(
            request("/_chardb/backups/restore", { recoveryPoint: point }),
            setup.env
        );
        expect(third.status).toBe(202);

        expect(setup.events.filter(event => event.startsWith("ShardDO_0:quiesce-pending:"))).toEqual([
            "ShardDO_0:quiesce-pending:2",
            "ShardDO_0:quiesce-pending:1",
            "ShardDO_0:quiesce-pending:0",
        ]);
        const settledAt = setup.events.indexOf("ShardDO_0:quiesce-pending:0");
        const scrubAt = setup.events.findIndex(event => event.startsWith("ShardDO_0:scrub:"));
        expect(scrubAt).toBeGreaterThan(settledAt);
    });
});
