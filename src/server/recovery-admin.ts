import { CdbError, isCdbError, rehydrateCdbRpcError } from "../errors.ts";
import { stableJson } from "../util/canonical.ts";
import { adminJsonError, authorizeAdmin, exactAdminObject, readAdminBody } from "./admin-http.ts";
import type { ChardbEnv } from "./entrypoint.ts";
import { httpStatusForCdbError } from "./http-errors.ts";

const RECOVERY_POINT_FORMAT = "chardb-recovery-point/v1";
const RECOVERY_BODY_MAX_BYTES = 2 * 1_024 * 1_024;
const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BOOKMARK = /^[A-Za-z0-9-]{1,512}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RECOVERY_SHARDS = 16_384;

interface RecoveryRpc {
    adminRecoveryBookmark(args: { readonly atMs?: number }): Promise<{
        readonly bookmark: string;
        readonly atMs: number;
    }>;
    adminArmRecoveryRestore(args: {
        readonly bookmark: string;
        readonly armedAt: number;
    }): Promise<{ readonly targetBookmark: string }>;
    adminCancelRecoveryRestore(args: { readonly bookmark: string }): Promise<{ readonly cancelled: boolean }>;
    adminCommitRecoveryRestore(args: { readonly bookmark: string }): Promise<{ readonly scheduled: true }>;
}

interface CatalogRecoveryRpc extends RecoveryRpc {
    adminRecoveryInventory(): Promise<{
        readonly schema: {
            readonly activeVersion: number;
            readonly activeEpoch: number;
            readonly activeDigest: string;
            readonly status: "active" | "migrating";
        };
        readonly routingEpoch: number;
        readonly shardIds: readonly string[];
    }>;
}

interface RecoveryPointPayload {
    readonly format: typeof RECOVERY_POINT_FORMAT;
    readonly createdAt: number;
    readonly atMs: number;
    readonly schema: {
        readonly version: number;
        readonly epoch: number;
        readonly digest: string;
    };
    readonly routingEpoch: number;
    readonly catalog: { readonly bookmark: string };
    readonly shards: readonly { readonly shardId: string; readonly bookmark: string }[];
}

export interface ChardbRecoveryPoint extends RecoveryPointPayload {
    readonly digest: string;
}

export async function handleRecoveryAdminRequest(request: Request, env: ChardbEnv): Promise<Response> {
    const denied = await authorizeAdmin(request, env);
    if (denied) return denied;
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const url = new URL(request.url);
    try {
        const body = await readAdminBody(request, RECOVERY_BODY_MAX_BYTES);
        if (url.pathname === "/_chardb/backups/create") {
            const input = parseCreateRequest(body);
            const recoveryPoint = await createRecoveryPoint(env, input.atMs);
            return Response.json({ ok: true, recoveryPoint }, { headers: { "cache-control": "no-store" } });
        }
        if (url.pathname === "/_chardb/backups/restore") {
            const input = exactAdminObject(body, ["recoveryPoint"]);
            const recoveryPoint = await parseRecoveryPoint(input.recoveryPoint);
            await restoreRecoveryPoint(env, recoveryPoint);
            return Response.json(
                { ok: true, accepted: true, recoveryPointDigest: recoveryPoint.digest },
                { status: 202, headers: { "cache-control": "no-store" } }
            );
        }
        return new Response("not found", { status: 404 });
    } catch (error) {
        if (error instanceof TypeError || error instanceof SyntaxError) return adminJsonError(400, error.message);
        const projected = rehydrateCdbRpcError(error);
        if (isCdbError(projected)) {
            return Response.json(
                {
                    ok: false,
                    error: projected.message,
                    code: projected.code,
                    retryable: projected.retryable,
                },
                {
                    status: httpStatusForCdbError(projected.code),
                    headers: { "cache-control": "no-store" },
                }
            );
        }
        return adminJsonError(500, "internal error");
    }
}

async function createRecoveryPoint(env: ChardbEnv, atMs: number | undefined): Promise<ChardbRecoveryPoint> {
    const catalog = catalogRpc(env);
    const inventory = await catalog.adminRecoveryInventory();
    if (inventory.schema.status !== "active") {
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration blocks a recovery point" });
    }
    const shardIds = [...inventory.shardIds];
    assertShardIds(shardIds);
    const createdAt = Date.now();
    const [catalogPoint, shardPoints] = await Promise.all([
        catalog.adminRecoveryBookmark(atMs === undefined ? {} : { atMs }),
        mapWithConcurrency(shardIds, 4, async shardId => ({
            shardId,
            ...(await shardRpc(env, shardId).adminRecoveryBookmark(atMs === undefined ? {} : { atMs })),
        })),
    ]);
    const pointAt = atMs ?? Math.min(catalogPoint.atMs, ...shardPoints.map(point => point.atMs));
    const payload: RecoveryPointPayload = {
        format: RECOVERY_POINT_FORMAT,
        createdAt,
        atMs: pointAt,
        schema: {
            version: inventory.schema.activeVersion,
            epoch: inventory.schema.activeEpoch,
            digest: inventory.schema.activeDigest,
        },
        routingEpoch: inventory.routingEpoch,
        catalog: { bookmark: catalogPoint.bookmark },
        shards: shardPoints.map(point => ({ shardId: point.shardId, bookmark: point.bookmark })),
    };
    return { ...payload, digest: await recoveryPointDigest(payload) };
}

async function restoreRecoveryPoint(env: ChardbEnv, point: ChardbRecoveryPoint): Promise<void> {
    const catalog = catalogRpc(env);
    await catalog.adminRecoveryInventory();
    const armedAt = Date.now();
    const armedShards: { readonly shardId: string; readonly bookmark: string }[] = [];
    let catalogArmed = false;
    try {
        await catalog.adminArmRecoveryRestore({ bookmark: point.catalog.bookmark, armedAt });
        catalogArmed = true;
        await mapWithConcurrency(point.shards, 4, async shard => {
            await shardRpc(env, shard.shardId).adminArmRecoveryRestore({ bookmark: shard.bookmark, armedAt });
            armedShards.push(shard);
        });
    } catch (error) {
        await Promise.allSettled(
            armedShards.map(shard =>
                shardRpc(env, shard.shardId).adminCancelRecoveryRestore({ bookmark: shard.bookmark })
            )
        );
        if (catalogArmed) {
            await catalog.adminCancelRecoveryRestore({ bookmark: point.catalog.bookmark }).catch(() => undefined);
        }
        throw error;
    }

    await mapWithConcurrency(point.shards, 4, shard =>
        shardRpc(env, shard.shardId).adminCommitRecoveryRestore({ bookmark: shard.bookmark })
    );
    await catalog.adminCommitRecoveryRestore({ bookmark: point.catalog.bookmark });
}

function parseCreateRequest(value: unknown): { readonly atMs?: number } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("backup request body must be an object");
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return {};
    const input = exactAdminObject(value, ["atMs"]);
    if (!Number.isSafeInteger(input.atMs)) throw new TypeError("backup atMs must be an integer timestamp");
    return { atMs: input.atMs as number };
}

async function parseRecoveryPoint(value: unknown): Promise<ChardbRecoveryPoint> {
    const input = exactAdminObject(value, [
        "atMs",
        "catalog",
        "createdAt",
        "digest",
        "format",
        "routingEpoch",
        "schema",
        "shards",
    ]);
    if (input.format !== RECOVERY_POINT_FORMAT) throw new TypeError("recovery point format is unsupported");
    if (!Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.atMs)) {
        throw new TypeError("recovery point timestamps are invalid");
    }
    if (!Number.isSafeInteger(input.routingEpoch) || (input.routingEpoch as number) < 1) {
        throw new TypeError("recovery point routing epoch is invalid");
    }
    const schema = exactAdminObject(input.schema, ["digest", "epoch", "version"]);
    if (
        !Number.isSafeInteger(schema.version) ||
        (schema.version as number) < 0 ||
        !Number.isSafeInteger(schema.epoch) ||
        (schema.epoch as number) < 1 ||
        typeof schema.digest !== "string" ||
        !DIGEST.test(schema.digest)
    ) {
        throw new TypeError("recovery point schema identity is invalid");
    }
    const catalog = exactAdminObject(input.catalog, ["bookmark"]);
    if (typeof catalog.bookmark !== "string" || !BOOKMARK.test(catalog.bookmark)) {
        throw new TypeError("recovery point Catalog bookmark is invalid");
    }
    if (!Array.isArray(input.shards) || input.shards.length < 1 || input.shards.length > MAX_RECOVERY_SHARDS) {
        throw new TypeError("recovery point shard inventory is invalid");
    }
    const shards = input.shards.map(value => {
        const shard = exactAdminObject(value, ["bookmark", "shardId"]);
        if (
            typeof shard.shardId !== "string" ||
            !SHARD_ID.test(shard.shardId) ||
            typeof shard.bookmark !== "string" ||
            !BOOKMARK.test(shard.bookmark)
        ) {
            throw new TypeError("recovery point shard entry is invalid");
        }
        return { shardId: shard.shardId, bookmark: shard.bookmark };
    });
    assertShardIds(shards.map(shard => shard.shardId));
    if (typeof input.digest !== "string" || !DIGEST.test(input.digest)) {
        throw new TypeError("recovery point digest is invalid");
    }
    const payload: RecoveryPointPayload = {
        format: RECOVERY_POINT_FORMAT,
        createdAt: input.createdAt as number,
        atMs: input.atMs as number,
        schema: {
            version: schema.version as number,
            epoch: schema.epoch as number,
            digest: schema.digest,
        },
        routingEpoch: input.routingEpoch as number,
        catalog: { bookmark: catalog.bookmark },
        shards,
    };
    const digest = await recoveryPointDigest(payload);
    if (digest !== input.digest) throw new TypeError("recovery point digest does not match its contents");
    return { ...payload, digest };
}

function assertShardIds(shardIds: readonly string[]): void {
    const sorted = [...shardIds].sort();
    if (
        sorted.length < 1 ||
        sorted.length > MAX_RECOVERY_SHARDS ||
        sorted.some((shardId, index) => !SHARD_ID.test(shardId) || shardId !== shardIds[index]) ||
        sorted.some((shardId, index) => index > 0 && shardId === sorted[index - 1])
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "Catalog returned an invalid recovery shard inventory" });
    }
}

async function recoveryPointDigest(payload: RecoveryPointPayload): Promise<string> {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(payload)));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function catalogRpc(env: ChardbEnv): CatalogRecoveryRpc {
    return env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRecoveryRpc;
}

function shardRpc(env: ChardbEnv, shardId: string): RecoveryRpc {
    return env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as RecoveryRpc;
}

async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    operation: (value: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (cursor < values.length) {
            const index = cursor++;
            results[index] = await operation(values[index] as T);
        }
    });
    await Promise.all(workers);
    return results;
}
