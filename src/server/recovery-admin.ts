import { CdbError, isCdbError, rehydrateCdbRpcError } from "../errors.ts";
import { stableJson } from "../util/canonical.ts";
import { adminJsonError, authorizeAdmin, exactAdminObject, readAdminBody } from "./admin-http.ts";
import type {
    RecoveryAdmissionClock,
    RecoveryCoordinatorState,
    RecoveryProviderCounts,
    RecoveryReconcileCounts,
} from "./do/recovery-coordinator.ts";
import { RECOVERY_ACTIVATION_DELAY_MS } from "./do/recovery.ts";
import type { ChardbEnv } from "./entrypoint.ts";
import { httpStatusForCdbError } from "./http-errors.ts";
import {
    type RecoveryContinuationState,
    parseRecoveryContinuation,
    parseRecoveryOperationRequest,
    parseStoredRecoveryContinuationState,
    serializeRecoveryContinuationState,
    signRecoveryContinuation,
} from "./recovery-continuation.ts";

const RECOVERY_POINT_FORMAT = "chardb-recovery-point/v1";
const RECOVERY_BODY_MAX_BYTES = 2 * 1_024 * 1_024;
const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BOOKMARK = /^[A-Za-z0-9-]{1,512}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RECOVERY_SHARDS = 16_384;
const RECOVERY_RECONCILE_DELAY_MS = RECOVERY_ACTIVATION_DELAY_MS + 1_000;
const RECOVERY_VECTOR_PAGE_SIZE = 500;
const MAX_RECOVERY_VECTOR_PAGES = 1_000;
const RECOVERY_FILE_PAGE_SIZE = 8;
const MAX_RECOVERY_FILE_PAGES = 625_000;
const RECOVERY_VECTOR_SCRUB_PAGE_SIZE = 32;
const MAX_RECOVERY_VECTOR_SCRUB_PAGES = 10_000;
const RECOVERY_FILE_PREFIX = "v1/";
const RECOVERY_FILE_SCRUB_PAGE_SIZE = 1_000;
const MAX_RECOVERY_FILE_SCRUB_PAGES = 10_000;
const RECOVERY_TURN_BUDGET = 32;
const MAX_RECOVERY_VECTOR_SETTLE_TURNS = 262_144;
const RECOVERY_VECTOR_QUIESCENCE_DELAY_MS = 1_000;

interface RecoveryRpc {
    adminRecoveryBookmark(args: { readonly atMs?: number }): Promise<{
        readonly bookmark: string;
        readonly atMs: number;
    }>;
    adminArmRecoveryRestore(args: {
        readonly bookmark: string;
        readonly armedAt: number;
        readonly operationId: string;
        readonly generation: number;
    }): Promise<{ readonly targetBookmark: string }>;
    adminReleaseRecovery(args: {
        readonly operationId: string;
        readonly generation: number;
    }): Promise<{ readonly released: true }>;
    adminCommitRecoveryRestore(args: { readonly bookmark: string }): Promise<{ readonly scheduled: true }>;
    adminRecoveryRestoreStatus(args: {
        readonly bookmark: string;
    }): Promise<{ readonly state: "armed" | "absent" }>;
    adminScrubRecoveryVectors(args: {
        readonly bookmark: string;
        readonly afterVectorId: string;
        readonly afterPhysicalVersion: number;
        readonly limit: number;
    }): Promise<{
        readonly processed: number;
        readonly afterVectorId: string;
        readonly afterPhysicalVersion: number;
        readonly done: boolean;
    }>;
    adminRequeueRecoveryVectors(args: {
        readonly afterCreatedSeq: number;
        readonly limit: number;
        readonly nowMs: number;
        readonly bookmark?: string;
    }): Promise<{ readonly processed: number; readonly afterCreatedSeq: number; readonly done: boolean }>;
    adminRetainRecoveryFiles(args: {
        readonly bookmark: string;
        readonly afterFileId: string;
        readonly limit: number;
    }): Promise<{ readonly processed: number; readonly afterFileId: string; readonly done: boolean }>;
    adminRehydrateRecoveryFiles(args: {
        readonly afterFileId: string;
        readonly limit: number;
        readonly bookmark?: string;
    }): Promise<{ readonly processed: number; readonly afterFileId: string; readonly done: boolean }>;
    adminSettleRecoveryVectors(args: {
        readonly bookmark: string;
    }): Promise<{ readonly pending: number; readonly terminal: number }>;
    adminQuiesceRecoveryVectors(args: {
        readonly bookmark: string;
    }): Promise<{ readonly pending: number; readonly terminal: number }>;
}

interface RecoveryCoordinatorRpc {
    adminRecoveryCoordinatorState(args: { readonly operationId: string }): Promise<RecoveryCoordinatorState>;
    adminActiveRecoveryForDigest(args: { readonly digest: string }): Promise<RecoveryCoordinatorState | null>;
    adminBeginRecoveryCommits(args: {
        readonly operationId: string;
        readonly counts: RecoveryProviderCounts;
    }): Promise<RecoveryCoordinatorState>;
    adminClaimRecoveryPreparation(args: {
        readonly operationId: string;
        readonly digest: string;
        readonly continuationJson: string;
    }): Promise<RecoveryCoordinatorState>;
    adminSaveRecoveryPreparation(args: {
        readonly operationId: string;
        readonly continuationJson: string;
    }): Promise<RecoveryCoordinatorState>;
    adminCancelRecoveryPreparation(args: { readonly operationId: string }): Promise<RecoveryAdmissionClock>;
    adminFinishRecoveryShardCommits(args: {
        readonly operationId: string;
        readonly continuationJson: string;
        readonly shardCount: number;
    }): Promise<RecoveryCoordinatorState>;
    adminAdvanceRecoveryShardCommit(args: {
        readonly operationId: string;
        readonly index: number;
        readonly objectId: string;
    }): Promise<RecoveryCoordinatorState>;
    adminSaveRecoveryReconcile(args: {
        readonly operationId: string;
        readonly continuationJson: string;
    }): Promise<RecoveryCoordinatorState>;
    adminBeginRecoveryReleases(args: {
        readonly operationId: string;
        readonly counts: RecoveryReconcileCounts;
    }): Promise<RecoveryCoordinatorState>;
    adminAdvanceRecoveryRelease(args: {
        readonly operationId: string;
        readonly index: number;
    }): Promise<RecoveryCoordinatorState>;
    adminBeginRecoveryCatalogCommit(args: {
        readonly operationId: string;
        readonly shardCount: number;
    }): Promise<RecoveryCoordinatorState>;
    adminCompleteRecovery(args: { readonly operationId: string }): Promise<RecoveryCoordinatorState>;
    adminBeginRecoveryObjectCommit(args: {
        readonly operationId: string;
        readonly objectId: string;
        readonly bookmark: string;
    }): Promise<{ readonly status: "intent" | "scheduled" }>;
    adminFinishRecoveryObjectCommit(args: {
        readonly operationId: string;
        readonly objectId: string;
        readonly bookmark: string;
    }): Promise<{ readonly status: "scheduled" }>;
}

interface CatalogRecoveryRpc extends Omit<RecoveryRpc, "adminArmRecoveryRestore"> {
    adminArmRecoveryRestore(args: {
        readonly bookmark: string;
        readonly armedAt: number;
        readonly operationId: string;
        readonly generation: number;
        readonly schema: RecoveryPointPayload["schema"];
        readonly routingEpoch: number;
        readonly shardIds: readonly string[];
    }): Promise<{ readonly targetBookmark: string }>;
    adminRecoveryInventory(args?: { readonly armedBookmark?: string }): Promise<{
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

interface RecoveryProviderReset {
    readonly files: number;
    readonly filesRetained: number;
    readonly vectors: number;
}

interface RecoveryReconcileResult {
    readonly filesRehydrated: number;
    readonly vectorsRequeued: number;
}

type RestoreTurnResult =
    | { readonly done: true; readonly operationId: string; readonly providerReset: RecoveryProviderReset }
    | {
          readonly done: false;
          readonly operationId: string;
          readonly state: Extract<RecoveryContinuationState, { readonly kind: "restore" }>;
      };

type ReconcileTurnResult =
    | { readonly done: true; readonly operationId: string; readonly result: RecoveryReconcileResult }
    | {
          readonly done: false;
          readonly operationId: string;
          readonly state: Extract<RecoveryContinuationState, { readonly kind: "reconcile" }>;
      };

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
            const input = parseRecoveryOperationRequest(body);
            const recoveryPoint = await parseRecoveryPoint(input.recoveryPoint);
            const prior = await parseRecoveryContinuation(
                env,
                input.operationId,
                recoveryPoint.digest,
                input.continuation,
                "restore"
            );
            const restored = await restoreRecoveryPointTurn(env, recoveryPoint, input.operationId, prior);
            if (!restored.done) {
                return Response.json(
                    {
                        ok: true,
                        operationId: restored.operationId,
                        pending: true,
                        recoveryPointDigest: recoveryPoint.digest,
                        continuation: await signRecoveryContinuation(
                            env,
                            restored.operationId,
                            recoveryPoint.digest,
                            restored.state
                        ),
                        retryAfterMs:
                            restored.state.phase === "commit"
                                ? RECOVERY_RECONCILE_DELAY_MS
                                : restored.state.phase === "quiescence"
                                  ? RECOVERY_VECTOR_QUIESCENCE_DELAY_MS
                                  : 0,
                    },
                    { status: 202, headers: { "cache-control": "no-store" } }
                );
            }
            return Response.json(
                {
                    ok: true,
                    operationId: restored.operationId,
                    accepted: true,
                    recoveryPointDigest: recoveryPoint.digest,
                    reconcileAfterMs: RECOVERY_RECONCILE_DELAY_MS,
                    providerReset: restored.providerReset,
                },
                { status: 202, headers: { "cache-control": "no-store" } }
            );
        }
        if (url.pathname === "/_chardb/backups/reconcile") {
            const input = parseRecoveryOperationRequest(body);
            const recoveryPoint = await parseRecoveryPoint(input.recoveryPoint);
            const prior = await parseRecoveryContinuation(
                env,
                input.operationId,
                recoveryPoint.digest,
                input.continuation,
                "reconcile"
            );
            const reconciled = await reconcileRecoveryPointTurn(env, recoveryPoint, input.operationId, prior);
            if (!reconciled.done) {
                return Response.json(
                    {
                        ok: true,
                        operationId: reconciled.operationId,
                        pending: true,
                        recoveryPointDigest: recoveryPoint.digest,
                        continuation: await signRecoveryContinuation(
                            env,
                            reconciled.operationId,
                            recoveryPoint.digest,
                            reconciled.state
                        ),
                        retryAfterMs: reconciled.state.phase === "settle" ? RECOVERY_RECONCILE_DELAY_MS : 0,
                    },
                    { status: 202, headers: { "cache-control": "no-store" } }
                );
            }
            return Response.json(
                {
                    ok: true,
                    operationId: reconciled.operationId,
                    reconciled: true,
                    recoveryPointDigest: recoveryPoint.digest,
                    ...reconciled.result,
                },
                { headers: { "cache-control": "no-store" } }
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
    const pointAt = atMs ?? createdAt;
    const [catalogPoint, shardPoints] = await Promise.all([
        catalog.adminRecoveryBookmark({ atMs: pointAt }),
        mapWithConcurrency(shardIds, 4, async shardId => ({
            shardId,
            ...(await shardRpc(env, shardId).adminRecoveryBookmark({ atMs: pointAt })),
        })),
    ]);
    assertRecoveryBookmark(catalogPoint, pointAt, "Catalog");
    for (const point of shardPoints) assertRecoveryBookmark(point, pointAt, `shard ${point.shardId}`);
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

function assertRecoveryBookmark(
    point: { readonly bookmark: string; readonly atMs: number },
    atMs: number,
    label: string
) {
    if (!BOOKMARK.test(point.bookmark) || point.atMs !== atMs) {
        throw new CdbError({ code: "CDB_INVARIANT", message: `${label} returned an invalid recovery bookmark` });
    }
}

async function restoreRecoveryPointTurn(
    env: ChardbEnv,
    point: ChardbRecoveryPoint,
    requestedOperationId: string,
    prior: Extract<RecoveryContinuationState, { readonly kind: "restore" }> | undefined
): Promise<RestoreTurnResult> {
    const catalog = catalogRpc(env);
    const coordinator = recoveryCoordinatorRpc(env);
    let coordinated = await recoveryPhase("coordinator read", () =>
        coordinator.adminRecoveryCoordinatorState({ operationId: requestedOperationId })
    );
    let inventory: Awaited<ReturnType<typeof catalog.adminRecoveryInventory>> | undefined;
    if (coordinated.phase === "new") {
        inventory = await recoveryPhase("preflight", () =>
            catalog.adminRecoveryInventory({ armedBookmark: point.catalog.bookmark })
        );
        assertRecoveryTopology(inventory, point);
        coordinated = await recoveryPhase("coordinator claim", () =>
            coordinator.adminClaimRecoveryPreparation({
                operationId: requestedOperationId,
                digest: point.digest,
                continuationJson: serializeRecoveryContinuationState(prior ?? restoreStartState()),
            })
        );
    }
    if (coordinated.phase !== "new" && coordinated.digest !== point.digest) {
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: "recovery operation belongs to another recovery point",
        });
    }
    if (coordinated.phase === "new") {
        throw new CdbError({ code: "CDB_INVARIANT", message: "recovery coordinator did not claim the operation" });
    }
    const operationId = coordinated.operationId;
    const generation = coordinated.generation;
    if (
        coordinated.phase === "reconciling" ||
        coordinated.phase === "releasing" ||
        coordinated.phase === "catalog" ||
        coordinated.phase === "complete"
    ) {
        return {
            done: true,
            operationId: coordinated.operationId,
            providerReset: {
                files: coordinated.files,
                filesRetained: coordinated.filesRetained,
                vectors: coordinated.vectors,
            },
        };
    }
    if (inventory === undefined) {
        inventory = await recoveryPhase("preflight", () =>
            catalog.adminRecoveryInventory({ armedBookmark: point.catalog.bookmark })
        );
        assertRecoveryTopology(inventory, point);
    }
    let state =
        coordinated.phase === "committing"
            ? {
                  ...restoreStartState(),
                  phase: "commit" as const,
                  shardIndex: coordinated.commitIndex,
                  commitPolls: 0,
                  files: coordinated.files,
                  filesRetained: coordinated.filesRetained,
                  vectors: coordinated.vectors,
              }
            : coordinated.phase === "preparing"
              ? parseStoredRecoveryContinuationState(coordinated.continuationJson, "restore")
              : (prior ?? restoreStartState());
    const savePreparation = async () => {
        await recoveryPhase("coordinator preparation cursor", () =>
            coordinator.adminSaveRecoveryPreparation({
                operationId,
                continuationJson: serializeRecoveryContinuationState(state),
            })
        );
    };
    let budget = RECOVERY_TURN_BUDGET;
    let externalPages = 0;
    if (state.phase === "arm") {
        const armedAt = Date.now();
        if (state.shardIndex === 0) {
            try {
                await recoveryPhase("Catalog arm", () =>
                    catalog.adminArmRecoveryRestore({
                        bookmark: point.catalog.bookmark,
                        armedAt,
                        operationId,
                        generation,
                        schema: point.schema,
                        routingEpoch: point.routingEpoch,
                        shardIds: point.shards.map(shard => shard.shardId),
                    })
                );
            } catch (error) {
                if (isCdbError(error) && error.message === "Catalog changed after recovery preflight") {
                    await recoveryPhase("coordinator preparation cancellation", () =>
                        coordinator.adminCancelRecoveryPreparation({ operationId })
                    );
                }
                throw error;
            }
            budget--;
        }
        while (state.shardIndex < point.shards.length && budget > 0) {
            const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
            await recoveryPhase("shard arm", () =>
                shardRpc(env, shard.shardId).adminArmRecoveryRestore({
                    bookmark: shard.bookmark,
                    armedAt,
                    operationId,
                    generation,
                })
            );
            state = { ...state, shardIndex: state.shardIndex + 1 };
            await savePreparation();
            budget--;
        }
        if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
        state = { ...state, phase: "quiescence", shardIndex: 0 };
        await savePreparation();
    }

    if (state.phase === "quiescence") {
        while (state.shardIndex < point.shards.length && budget > 0) {
            const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
            const settlement = await quiesceRecoveryVectors(shardRpc(env, shard.shardId), shard.bookmark);
            const quiescenceTurns = state.quiescenceTurns + 1;
            if (quiescenceTurns > MAX_RECOVERY_VECTOR_SETTLE_TURNS) {
                throw new CdbError({
                    code: "CDB_RATE_LIMITED",
                    message: "vector recovery quiescence exceeded its bound",
                });
            }
            if (settlement.terminal > 0) {
                throw new CdbError({
                    code: "CDB_INVARIANT",
                    message: "vector recovery quiescence reached a terminal provider failure",
                });
            }
            state =
                settlement.pending === 0
                    ? { ...state, shardIndex: state.shardIndex + 1, quiescenceTurns: 0 }
                    : { ...state, quiescenceTurns };
            await savePreparation();
            budget--;
            if (settlement.pending > 0) return { done: false, operationId, state };
        }
        if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
        state = { ...state, phase: "retention", shardIndex: 0 };
        await savePreparation();
    }

    if (state.phase === "retention") {
        while (state.shardIndex < point.shards.length && budget > 0 && externalPages === 0) {
            const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
            const result = await retainRecoveryFilePage(
                shardRpc(env, shard.shardId),
                shard.bookmark,
                state.afterRetainedFileId
            );
            const retentionPages = state.retentionPages + 1;
            if (retentionPages > MAX_RECOVERY_FILE_PAGES) {
                throw new CdbError({ code: "CDB_RATE_LIMITED", message: "file retention exceeded its page bound" });
            }
            const filesRetained = safeRecoveryTotal(state.filesRetained, result.processed, "file retention");
            if (result.processed > 0) externalPages++;
            state = result.done
                ? {
                      ...state,
                      shardIndex: state.shardIndex + 1,
                      afterRetainedFileId: "",
                      filesRetained,
                      retentionPages: 0,
                  }
                : {
                      ...state,
                      afterRetainedFileId: result.afterFileId,
                      filesRetained,
                      retentionPages,
                  };
            await savePreparation();
            budget--;
        }
        if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
        state = { ...state, phase: "vectors", shardIndex: 0 };
        await savePreparation();
    }

    if (state.phase === "vectors") {
        while (state.shardIndex < point.shards.length && budget > 0 && externalPages === 0) {
            const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
            const result = await scrubRecoveryShardVectorPage(
                shardRpc(env, shard.shardId),
                shard.bookmark,
                state.afterVectorId,
                state.afterPhysicalVersion
            );
            const vectorPages = state.vectorPages + 1;
            if (vectorPages > MAX_RECOVERY_VECTOR_SCRUB_PAGES) {
                throw new CdbError({
                    code: "CDB_RATE_LIMITED",
                    message: "vector recovery scrub exceeded its page bound",
                });
            }
            const vectors = safeRecoveryTotal(state.vectors, result.processed, "vector provider scrub");
            if (result.processed > 0) externalPages++;
            state = result.done
                ? {
                      ...state,
                      shardIndex: state.shardIndex + 1,
                      afterVectorId: "",
                      afterPhysicalVersion: 0,
                      vectors,
                      vectorPages: 0,
                  }
                : {
                      ...state,
                      afterVectorId: result.afterVectorId,
                      afterPhysicalVersion: result.afterPhysicalVersion,
                      vectors,
                      vectorPages,
                  };
            await savePreparation();
            budget--;
        }
        if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
        state = { ...state, phase: "files", shardIndex: 0 };
        await savePreparation();
    }

    if (state.phase === "files") {
        let scrubDone = !env.CDB_FILES;
        while (env.CDB_FILES && budget > 0 && externalPages === 0) {
            const result = await scrubRecoveryFilePage(env.CDB_FILES);
            if (result.processed > 0) {
                const filePages = state.filePages + 1;
                if (filePages > MAX_RECOVERY_FILE_SCRUB_PAGES) {
                    throw new CdbError({
                        code: "CDB_RATE_LIMITED",
                        message: "file recovery scrub exceeded its page bound",
                    });
                }
                state = { ...state, filePages };
            }
            state = { ...state, files: safeRecoveryTotal(state.files, result.processed, "file provider scrub") };
            await savePreparation();
            if (result.processed > 0) externalPages++;
            budget--;
            if (result.done) {
                scrubDone = true;
                break;
            }
        }
        if (!scrubDone) return { done: false, operationId, state };
        state = { ...state, phase: "commit", shardIndex: 0 };
        await savePreparation();
    }

    await recoveryPhase("coordinator commit fence", () =>
        coordinator.adminBeginRecoveryCommits({
            operationId,
            counts: { files: state.files, filesRetained: state.filesRetained, vectors: state.vectors },
        })
    );
    while (state.shardIndex < point.shards.length && budget > 0) {
        const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
        const restored = await commitRecoveryObject(
            coordinator,
            operationId,
            `shard:${shard.shardId}`,
            shard.bookmark,
            shardRpc(env, shard.shardId),
            "shard"
        );
        if (!restored) {
            state = { ...state, commitPolls: state.commitPolls + 1 };
            return { done: false, operationId, state };
        }
        await recoveryPhase("coordinator shard commit cursor", () =>
            coordinator.adminAdvanceRecoveryShardCommit({
                operationId,
                index: state.shardIndex,
                objectId: `shard:${shard.shardId}`,
            })
        );
        state = { ...state, shardIndex: state.shardIndex + 1 };
        budget--;
    }
    if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
    await recoveryPhase("coordinator shard completion", () =>
        coordinator.adminFinishRecoveryShardCommits({
            operationId,
            continuationJson: serializeRecoveryContinuationState(reconcileStartState()),
            shardCount: point.shards.length,
        })
    );
    return {
        done: true,
        operationId,
        providerReset: { files: state.files, filesRetained: state.filesRetained, vectors: state.vectors },
    };
}

function restoreStartState(): Extract<RecoveryContinuationState, { readonly kind: "restore" }> {
    return {
        kind: "restore",
        phase: "arm",
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
        vectorPages: 0,
        commitPolls: 0,
    };
}

async function reconcileRecoveryPointTurn(
    env: ChardbEnv,
    point: ChardbRecoveryPoint,
    requestedOperationId: string,
    prior: Extract<RecoveryContinuationState, { readonly kind: "reconcile" }> | undefined
): Promise<ReconcileTurnResult> {
    const catalog = catalogRpc(env);
    const coordinator = recoveryCoordinatorRpc(env);
    let coordinated = await recoveryPhase("reconcile coordinator read", () =>
        coordinator.adminRecoveryCoordinatorState({ operationId: requestedOperationId })
    );
    if (coordinated.phase === "new") {
        const active = await recoveryPhase("active recovery read", () =>
            coordinator.adminActiveRecoveryForDigest({ digest: point.digest })
        );
        if (active) coordinated = active;
    }
    if (coordinated.phase === "new" || coordinated.phase === "preparing" || coordinated.phase === "committing") {
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: "shard point-in-time restore has not completed",
        });
    }
    if (coordinated.digest !== point.digest) {
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: "recovery operation belongs to another recovery point",
        });
    }
    const operationId = coordinated.operationId;
    const generation = coordinated.generation;
    if (coordinated.phase === "catalog" || coordinated.phase === "complete") {
        if (coordinated.phase === "catalog") {
            const restored = await commitRecoveryObject(
                coordinator,
                operationId,
                "catalog",
                point.catalog.bookmark,
                catalog,
                "Catalog"
            );
            if (!restored) {
                const state = {
                    ...(prior ?? reconcileStartState()),
                    phase: "settle" as const,
                    settleTurns: (prior?.settleTurns ?? 0) + 1,
                };
                return { done: false, operationId, state };
            }
            const restoredInventory = await recoveryPhase("restored Catalog proof", () =>
                catalog.adminRecoveryInventory()
            );
            assertRecoveryTopology(restoredInventory, point);
            await recoveryPhase("Catalog release", () => catalog.adminReleaseRecovery({ operationId, generation }));
            await recoveryPhase("coordinator completion", () => coordinator.adminCompleteRecovery({ operationId }));
        }
        return {
            done: true,
            operationId,
            result: {
                filesRehydrated: coordinated.filesRehydrated,
                vectorsRequeued: coordinated.vectorsRequeued,
            },
        };
    }
    if (coordinated.phase === "releasing") {
        return await releaseRecoveryShards(env, point, coordinator, coordinated, prior ?? reconcileStartState());
    }
    if (coordinated.phase !== "reconciling") {
        throw new CdbError({ code: "CDB_INVARIANT", message: "recovery coordinator phase is invalid" });
    }
    const inventory = await recoveryPhase("reconcile preflight", () =>
        catalog.adminRecoveryInventory({ armedBookmark: point.catalog.bookmark })
    );
    assertRecoveryTopology(inventory, point);
    let state = parseStoredRecoveryContinuationState(coordinated.continuationJson, "reconcile");
    const saveReconcile = async () => {
        await recoveryPhase("coordinator reconciliation cursor", () =>
            coordinator.adminSaveRecoveryReconcile({
                operationId,
                continuationJson: serializeRecoveryContinuationState(state),
            })
        );
    };
    let budget = RECOVERY_TURN_BUDGET;
    let externalPages = 0;
    if (state.phase === "files") {
        while (state.shardIndex < point.shards.length && budget > 0 && externalPages === 0) {
            const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
            const result = await rehydrateRecoveryFilePage(shardRpc(env, shard.shardId), state.afterFileId);
            const filePages = state.filePages + 1;
            if (filePages > MAX_RECOVERY_FILE_PAGES) {
                throw new CdbError({ code: "CDB_RATE_LIMITED", message: "file recovery exceeded its page bound" });
            }
            const filesRehydrated = safeRecoveryTotal(state.filesRehydrated, result.processed, "file reconciliation");
            if (result.processed > 0) externalPages++;
            state = result.done
                ? { ...state, shardIndex: state.shardIndex + 1, afterFileId: "", filesRehydrated, filePages: 0 }
                : { ...state, afterFileId: result.afterFileId, filesRehydrated, filePages };
            await saveReconcile();
            budget--;
        }
        if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
        state = { ...state, phase: "vectors", shardIndex: 0 };
        await saveReconcile();
    }
    if (state.phase === "vectors") {
        while (state.shardIndex < point.shards.length && budget > 0) {
            const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
            const result = await requeueRecoveryVectorPage(
                shardRpc(env, shard.shardId),
                state.afterCreatedSeq,
                state.nowMs
            );
            const vectorPages = state.vectorPages + 1;
            if (vectorPages > MAX_RECOVERY_VECTOR_PAGES) {
                throw new CdbError({ code: "CDB_RATE_LIMITED", message: "vector recovery exceeded its page bound" });
            }
            const vectorsRequeued = safeRecoveryTotal(state.vectorsRequeued, result.processed, "vector reconciliation");
            state = result.done
                ? { ...state, shardIndex: state.shardIndex + 1, afterCreatedSeq: 0, vectorsRequeued, vectorPages: 0 }
                : { ...state, afterCreatedSeq: result.afterCreatedSeq, vectorsRequeued, vectorPages };
            await saveReconcile();
            budget--;
        }
        if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
        state = { ...state, phase: "settle", shardIndex: 0 };
        await saveReconcile();
    }
    if (state.shardIndex < point.shards.length) {
        const shard = point.shards[state.shardIndex] as (typeof point.shards)[number];
        const settlement = await settleRecoveryVectors(shardRpc(env, shard.shardId), shard.bookmark);
        const settleTurns = state.settleTurns + 1;
        if (settleTurns > MAX_RECOVERY_VECTOR_SETTLE_TURNS) {
            throw new CdbError({ code: "CDB_RATE_LIMITED", message: "vector recovery settlement exceeded its bound" });
        }
        if (settlement.terminal > 0) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: "vector recovery reached a terminal provider failure",
            });
        }
        state =
            settlement.pending === 0
                ? { ...state, shardIndex: state.shardIndex + 1, settleTurns: 0 }
                : { ...state, settleTurns };
        await saveReconcile();
        if (state.shardIndex < point.shards.length) return { done: false, operationId, state };
    }
    const result = { filesRehydrated: state.filesRehydrated, vectorsRequeued: state.vectorsRequeued };
    coordinated = await recoveryPhase("coordinator shard releases", () =>
        coordinator.adminBeginRecoveryReleases({ operationId, counts: result })
    );
    if (coordinated.phase !== "releasing") {
        throw new CdbError({ code: "CDB_INVARIANT", message: "recovery coordinator did not begin shard release" });
    }
    return await releaseRecoveryShards(env, point, coordinator, coordinated, state);
}

async function releaseRecoveryShards(
    env: ChardbEnv,
    point: ChardbRecoveryPoint,
    coordinator: RecoveryCoordinatorRpc,
    coordinated: Extract<RecoveryCoordinatorState, { readonly phase: "releasing" }>,
    state: Extract<RecoveryContinuationState, { readonly kind: "reconcile" }>
): Promise<ReconcileTurnResult> {
    let index = coordinated.releaseIndex;
    let budget = RECOVERY_TURN_BUDGET;
    while (index < point.shards.length && budget > 0) {
        const shard = point.shards[index] as (typeof point.shards)[number];
        await recoveryPhase("shard release", () =>
            shardRpc(env, shard.shardId).adminReleaseRecovery({
                operationId: coordinated.operationId,
                generation: coordinated.generation,
            })
        );
        await recoveryPhase("coordinator shard release cursor", () =>
            coordinator.adminAdvanceRecoveryRelease({ operationId: coordinated.operationId, index })
        );
        index++;
        budget--;
    }
    if (index < point.shards.length) return { done: false, operationId: coordinated.operationId, state };
    await recoveryPhase("coordinator Catalog fence", () =>
        coordinator.adminBeginRecoveryCatalogCommit({
            operationId: coordinated.operationId,
            shardCount: point.shards.length,
        })
    );
    return { done: false, operationId: coordinated.operationId, state };
}

function reconcileStartState(): Extract<RecoveryContinuationState, { readonly kind: "reconcile" }> {
    return {
        kind: "reconcile",
        phase: "files",
        shardIndex: 0,
        afterFileId: "",
        afterCreatedSeq: 0,
        filesRehydrated: 0,
        filePages: 0,
        vectorsRequeued: 0,
        vectorPages: 0,
        settleTurns: 0,
        nowMs: Date.now(),
    };
}

async function scrubRecoveryShardVectorPage(
    rpc: RecoveryRpc,
    bookmark: string,
    afterVectorId: string,
    afterPhysicalVersion: number
): Promise<Awaited<ReturnType<RecoveryRpc["adminScrubRecoveryVectors"]>>> {
    const result = await recoveryPhase("vector provider scrub", () =>
        rpc.adminScrubRecoveryVectors({
            bookmark,
            afterVectorId,
            afterPhysicalVersion,
            limit: RECOVERY_VECTOR_SCRUB_PAGE_SIZE,
        })
    );
    if (
        !Number.isSafeInteger(result.processed) ||
        result.processed < 0 ||
        result.processed > RECOVERY_VECTOR_SCRUB_PAGE_SIZE ||
        typeof result.afterVectorId !== "string" ||
        new TextEncoder().encode(result.afterVectorId).byteLength > 256 ||
        !Number.isSafeInteger(result.afterPhysicalVersion) ||
        result.afterPhysicalVersion < 0 ||
        typeof result.done !== "boolean" ||
        (!result.done &&
            (result.processed === 0 ||
                result.afterVectorId < afterVectorId ||
                (result.afterVectorId === afterVectorId && result.afterPhysicalVersion <= afterPhysicalVersion)))
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "vector recovery scrub returned an invalid page" });
    }
    return result;
}

async function scrubRecoveryFilePage(
    bucket: R2Bucket
): Promise<{ readonly processed: number; readonly done: boolean }> {
    const listed = await recoveryPhase("file provider scrub list", () =>
        bucket.list({ prefix: RECOVERY_FILE_PREFIX, limit: RECOVERY_FILE_SCRUB_PAGE_SIZE })
    );
    if (
        !Array.isArray(listed.objects) ||
        listed.objects.length > RECOVERY_FILE_SCRUB_PAGE_SIZE ||
        typeof listed.truncated !== "boolean"
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "file recovery scrub returned an invalid page" });
    }
    const keys = listed.objects.map(object => object.key);
    if (
        keys.some(key => typeof key !== "string" || !key.startsWith(RECOVERY_FILE_PREFIX)) ||
        new Set(keys).size !== keys.length
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "file recovery scrub returned an invalid key" });
    }
    if (keys.length === 0) return { processed: 0, done: true };
    await recoveryPhase("file provider scrub delete", () => bucket.delete(keys));
    return { processed: keys.length, done: !listed.truncated };
}

async function rehydrateRecoveryFilePage(
    rpc: RecoveryRpc,
    afterFileId: string,
    bookmark?: string
): Promise<Awaited<ReturnType<RecoveryRpc["adminRehydrateRecoveryFiles"]>>> {
    const result = await recoveryPhase("file reconcile", () =>
        rpc.adminRehydrateRecoveryFiles({
            afterFileId,
            limit: RECOVERY_FILE_PAGE_SIZE,
            ...(bookmark === undefined ? {} : { bookmark }),
        })
    );
    if (
        !Number.isSafeInteger(result.processed) ||
        result.processed < 0 ||
        result.processed > RECOVERY_FILE_PAGE_SIZE ||
        typeof result.afterFileId !== "string" ||
        new TextEncoder().encode(result.afterFileId).byteLength > 256 ||
        typeof result.done !== "boolean" ||
        (!result.done && (result.processed === 0 || result.afterFileId <= afterFileId))
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "file recovery returned an invalid page" });
    }
    return result;
}

async function retainRecoveryFilePage(
    rpc: RecoveryRpc,
    bookmark: string,
    afterFileId: string
): Promise<Awaited<ReturnType<RecoveryRpc["adminRetainRecoveryFiles"]>>> {
    const result = await recoveryPhase("file retention", () =>
        rpc.adminRetainRecoveryFiles({ bookmark, afterFileId, limit: RECOVERY_FILE_PAGE_SIZE })
    );
    if (
        !Number.isSafeInteger(result.processed) ||
        result.processed < 0 ||
        result.processed > RECOVERY_FILE_PAGE_SIZE ||
        typeof result.afterFileId !== "string" ||
        new TextEncoder().encode(result.afterFileId).byteLength > 256 ||
        typeof result.done !== "boolean" ||
        (!result.done && (result.processed === 0 || result.afterFileId <= afterFileId))
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "file retention returned an invalid page" });
    }
    return result;
}

async function requeueRecoveryVectorPage(
    rpc: RecoveryRpc,
    afterCreatedSeq: number,
    nowMs: number,
    bookmark?: string
): Promise<Awaited<ReturnType<RecoveryRpc["adminRequeueRecoveryVectors"]>>> {
    const result = await recoveryPhase("vector reconcile", () =>
        rpc.adminRequeueRecoveryVectors({
            afterCreatedSeq,
            limit: RECOVERY_VECTOR_PAGE_SIZE,
            nowMs,
            ...(bookmark === undefined ? {} : { bookmark }),
        })
    );
    if (
        !Number.isSafeInteger(result.processed) ||
        result.processed < 0 ||
        result.processed > RECOVERY_VECTOR_PAGE_SIZE ||
        !Number.isSafeInteger(result.afterCreatedSeq) ||
        result.afterCreatedSeq < afterCreatedSeq ||
        typeof result.done !== "boolean" ||
        (!result.done && result.afterCreatedSeq <= afterCreatedSeq)
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "vector recovery returned an invalid page" });
    }
    return result;
}

async function settleRecoveryVectors(
    rpc: RecoveryRpc,
    bookmark: string
): Promise<Awaited<ReturnType<RecoveryRpc["adminSettleRecoveryVectors"]>>> {
    const result = await recoveryPhase("vector provider settlement", () =>
        rpc.adminSettleRecoveryVectors({ bookmark })
    );
    if (
        !Number.isSafeInteger(result.pending) ||
        result.pending < 0 ||
        result.pending > 65_536 ||
        !Number.isSafeInteger(result.terminal) ||
        result.terminal < 0 ||
        result.terminal > result.pending
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "vector recovery settlement returned invalid state" });
    }
    return result;
}

async function quiesceRecoveryVectors(
    rpc: RecoveryRpc,
    bookmark: string
): Promise<Awaited<ReturnType<RecoveryRpc["adminQuiesceRecoveryVectors"]>>> {
    const result = await recoveryPhase("vector provider quiescence", () =>
        rpc.adminQuiesceRecoveryVectors({ bookmark })
    );
    if (
        !Number.isSafeInteger(result.pending) ||
        result.pending < 0 ||
        result.pending > 65_536 ||
        !Number.isSafeInteger(result.terminal) ||
        result.terminal < 0 ||
        result.terminal > result.pending
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "vector recovery quiescence returned invalid state" });
    }
    return result;
}

function safeRecoveryTotal(current: number, increment: number, label: string): number {
    const next = current + increment;
    if (!Number.isSafeInteger(next) || next < current) {
        throw new CdbError({ code: "CDB_INVARIANT", message: `${label} count overflowed` });
    }
    return next;
}

function assertRecoveryTopology(
    inventory: Awaited<ReturnType<CatalogRecoveryRpc["adminRecoveryInventory"]>>,
    point: ChardbRecoveryPoint
): void {
    const shardIds = [...inventory.shardIds];
    assertShardIds(shardIds);
    if (
        inventory.schema.status !== "active" ||
        inventory.schema.activeVersion !== point.schema.version ||
        inventory.schema.activeEpoch !== point.schema.epoch ||
        inventory.schema.activeDigest !== point.schema.digest ||
        inventory.routingEpoch !== point.routingEpoch ||
        stableJson(shardIds) !== stableJson(point.shards.map(shard => shard.shardId))
    ) {
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: "current topology does not match the recovery point",
        });
    }
}

async function recoveryPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        const projected = rehydrateCdbRpcError(error);
        if (isCdbError(projected)) throw projected;
        throw new CdbError({
            code: "CDB_SHARD_UNAVAILABLE",
            message: `point-in-time recovery ${phase} failed`,
            cause: error,
        });
    }
}

async function commitRecoveryObject(
    coordinator: RecoveryCoordinatorRpc,
    operationId: string,
    objectId: string,
    bookmark: string,
    target: RecoveryRpc,
    label: string
): Promise<boolean> {
    const intent = await recoveryPhase(`${label} commit intent`, () =>
        coordinator.adminBeginRecoveryObjectCommit({ operationId, objectId, bookmark })
    );
    if (intent.status === "scheduled") return true;

    const status = await recoveryPhase(`${label} commit status`, () => target.adminRecoveryRestoreStatus({ bookmark }));
    if (status.state === "armed") {
        await recoveryPhase(`${label} commit`, () => target.adminCommitRecoveryRestore({ bookmark }));
        const after = await recoveryPhase(`${label} post-commit status`, () =>
            target.adminRecoveryRestoreStatus({ bookmark })
        );
        if (after.state === "armed") return false;
    }
    await recoveryPhase(`${label} commit confirmation`, () =>
        coordinator.adminFinishRecoveryObjectCommit({ operationId, objectId, bookmark })
    );
    return true;
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

function recoveryCoordinatorRpc(env: ChardbEnv): RecoveryCoordinatorRpc {
    if (!env.CDB_RESHARD) {
        throw new CdbError({ code: "CDB_SHARD_UNAVAILABLE", message: "CDB_RESHARD binding is unavailable" });
    }
    return env.CDB_RESHARD.get(env.CDB_RESHARD.idFromName("global")) as unknown as RecoveryCoordinatorRpc;
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
    const settled = await Promise.allSettled(workers);
    const failure = settled.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return results;
}
