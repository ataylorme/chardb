import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import type { ChardbRef, RawJson } from "../../types.ts";
import { type AtomicMutationDb, executeAtomicMutation } from "../atomic-mutation.ts";
import type { AuthCtx } from "../define.ts";
import type { ChardbManifest } from "../manifest.ts";
import { resolveMutation } from "../manifest.ts";
import {
    CDB_JSON_MAX_AGGREGATE_MEMBERS,
    CDB_MUTATION_ARGS_MAX_BYTES,
    CDB_MUTATION_ARGS_MAX_DEPTH,
    snapshotCdbJsonByteLimit,
    snapshotCdbMutationArgs,
} from "../result_limits.ts";
import type { CdbMutationRequest, CdbMutationSuccess, CdbPlacement } from "../rpc.ts";
import { enqueueInvalidations } from "./cdb-live-store.ts";

export interface CdbMutationExecutionInput {
    readonly storage: DurableObjectStorage;
    readonly cdbId: () => string;
    readonly schema: () => Record<string, unknown>;
    readonly manifest: () => ChardbManifest;
    readonly request: CdbMutationRequest;
    readonly invalidationNowMs: () => number;
    readonly assertActiveSchemaEpoch: (expectedEpoch: number, sql?: SyncSql) => void;
    readonly assertRoutingFence: (schemaEpoch: number, placement: CdbPlacement | undefined, sql: SyncSql) => void;
    readonly captureSplitOutcome?: (input: {
        readonly sql: SyncSql;
        readonly principalId: string;
        readonly mutId: string;
        readonly placement: CdbPlacement | undefined;
    }) => void;
    readonly extendContext?: (
        ctx: import("../define.ts").MutationCtx<AtomicMutationDb<Record<string, unknown>>>,
        sql: SyncSql,
        isTransactionActive: () => boolean,
        placement: CdbPlacement | undefined
    ) => import("../define.ts").MutationCtx<AtomicMutationDb<Record<string, unknown>>>;
}

/**
 * Admit and execute one registered mutation in its owning Cdb isolate.
 *
 * The op-log row, domain writes, and invalidation outbox entries share the
 * same synchronous SQLite transaction in `executeAtomicMutation`.
 */
export async function executeCdbMutation(input: CdbMutationExecutionInput): Promise<CdbMutationSuccess> {
    const snapshot = snapshotMutationRequest(input.request);
    input.assertActiveSchemaEpoch(snapshot.domainSchemaEpoch);

    const descriptor = resolveMutation(input.manifest(), snapshot.ref as ChardbRef);
    const declaredPartition = descriptor.extractPartitionKey?.(snapshot.args);
    const placement = resolveMutationPlacement(snapshot, descriptor.authority, declaredPartition);
    const missingRequiredPlacement = descriptor.authority !== undefined && placement === undefined;
    const request: CdbMutationRequest = placement === undefined ? snapshot : { ...snapshot, placement };
    if (descriptor.authority === undefined && snapshot.placement !== undefined) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: "mutation placement does not match its server manifest route",
        });
    }

    try {
        await input.storage.setAlarm(input.invalidationNowMs() + 1);
    } catch (error) {
        throw new CdbError({
            code: "CDB_SHARD_UNAVAILABLE",
            message: "could not arm invalidation recovery before mutation commit",
            cause: error,
        });
    }

    const result = executeAtomicMutation({
        storage: input.storage,
        schema: input.schema(),
        request,
        ...(request.placement === undefined ? {} : { placement: request.placement }),
        // Gateway already validated the wire arguments. The manifest keeps the
        // handler inside this isolate, so no function crosses the RPC boundary.
        handler: (ctx, args) => descriptor.invokeValidated(ctx, args),
        cookie: `${input.cdbId()}:${Date.now()}:${crypto.randomUUID()}`,
        beforeRun: sql => {
            input.assertActiveSchemaEpoch(request.domainSchemaEpoch, sql);
            input.assertRoutingFence(request.schemaEpoch, request.placement, sql);
            if (missingRequiredPlacement) throw mutationPlacementMismatch();
        },
        onOutcome: ({ sql, ran }) => {
            if (!ran) return;
            input.captureSplitOutcome?.({
                sql,
                principalId: request.principalId,
                mutId: request.mutId,
                placement: request.placement,
            });
        },
        ...(input.extendContext
            ? {
                  extendContext: (ctx, sql, isTransactionActive) =>
                      input.extendContext?.(ctx, sql, isTransactionActive, request.placement) ?? ctx,
              }
            : {}),
        onWriteSet: ({ touchedTables, sql }) => {
            enqueueInvalidations(sql, touchedTables);
        },
    });
    return { ok: true, ...result };
}

function resolveMutationPlacement(
    request: CdbMutationRequest,
    authority: import("../define.ts").MutationAuthority | undefined,
    declaredPartition: string | number | bigint | undefined
): CdbPlacement | undefined {
    if (authority === undefined) return undefined;
    if (declaredPartition === undefined) throw mutationPlacementMismatch();
    const partitionKey = String(declaredPartition);
    const verifiedPartition = authority === "organization" ? request.auth.tenantId : request.auth.userId;
    if (authority !== "global" && (!verifiedPartition || verifiedPartition !== partitionKey)) {
        throw mutationPlacementMismatch();
    }
    if (request.placement !== undefined) {
        if (request.placement.authority !== authority || request.placement.partitionKey !== partitionKey) {
            throw mutationPlacementMismatch();
        }
        return request.placement;
    }
    if (authority === "global") return undefined;
    if (!verifiedPartition || verifiedPartition !== partitionKey) {
        throw mutationPlacementMismatch();
    }
    return { authority, partitionKey };
}

function mutationPlacementMismatch(): CdbError {
    return new CdbError({
        code: "CDB_INVARIANT",
        message: "mutation placement does not match its server manifest route",
    });
}

function snapshotMutationRequest(input: CdbMutationRequest): CdbMutationRequest {
    const principalId = input.principalId;
    const mutId = input.mutId;
    const ref = input.ref;
    const schemaEpoch = input.schemaEpoch;
    const recoveryGeneration = input.recoveryGeneration;
    const domainSchemaEpoch = input.domainSchemaEpoch;
    const placement =
        input.placement === undefined
            ? undefined
            : { authority: input.placement.authority, partitionKey: input.placement.partitionKey };
    const auth = snapshotMutationAuth(input.auth);
    const args = snapshotCdbMutationArgs(input.args);
    return {
        principalId,
        mutId,
        ref,
        args,
        ...(placement === undefined ? {} : { placement }),
        auth,
        schemaEpoch,
        recoveryGeneration,
        domainSchemaEpoch,
    };
}

function snapshotMutationAuth(input: AuthCtx): AuthCtx {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw malformedMutationAuth();
    }
    const field = (key: keyof AuthCtx): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor) return undefined;
        if (!descriptor.enumerable || !("value" in descriptor)) {
            throw malformedMutationAuth();
        }
        return descriptor.value;
    };
    const userId = field("userId");
    const tenantId = field("tenantId");
    const role = field("role");
    const roles = field("roles");
    const authEpochs = field("authEpochs");
    const activeTeamId = field("activeTeamId");
    const claims = field("claims");
    const projected = {
        userId,
        ...(tenantId === undefined ? {} : { tenantId }),
        ...(role === undefined ? {} : { role }),
        ...(roles === undefined ? {} : { roles }),
        ...(authEpochs === undefined ? {} : { authEpochs }),
        ...(activeTeamId === undefined ? {} : { activeTeamId }),
        claims,
    };
    const snapshot = snapshotCdbJsonByteLimit(
        projected as unknown as RawJson,
        CDB_MUTATION_ARGS_MAX_BYTES,
        {
            code: "CDB_INVALID_ARGS",
            subject: "mutation auth payload",
            hint: "reduce mutation auth metadata",
        },
        {
            maxAggregateMembers: CDB_JSON_MAX_AGGREGATE_MEMBERS,
            maxDepth: CDB_MUTATION_ARGS_MAX_DEPTH,
        }
    );
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        throw malformedMutationAuth();
    }
    const auth = snapshot as Record<string, RawJson>;
    if (
        typeof auth.userId !== "string" ||
        (auth.tenantId !== undefined && typeof auth.tenantId !== "string") ||
        (auth.role !== undefined && typeof auth.role !== "string") ||
        (auth.activeTeamId !== undefined && typeof auth.activeTeamId !== "string") ||
        (auth.roles !== undefined &&
            (!Array.isArray(auth.roles) || !auth.roles.every(role => typeof role === "string"))) ||
        typeof auth.claims !== "object" ||
        auth.claims === null ||
        Array.isArray(auth.claims)
    ) {
        throw malformedMutationAuth();
    }
    const epochs = auth.authEpochs;
    if (
        epochs !== undefined &&
        (typeof epochs !== "object" ||
            epochs === null ||
            Array.isArray(epochs) ||
            ![epochs.global, epochs.tenant, epochs.principal].every(
                epoch => typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0
            ))
    ) {
        throw malformedMutationAuth();
    }
    return {
        userId: auth.userId,
        ...(auth.tenantId === undefined ? {} : { tenantId: auth.tenantId }),
        ...(auth.role === undefined ? {} : { role: auth.role }),
        ...(auth.roles === undefined ? {} : { roles: auth.roles as string[] }),
        ...(epochs === undefined
            ? {}
            : {
                  authEpochs: {
                      global: epochs.global as number,
                      tenant: epochs.tenant as number,
                      principal: epochs.principal as number,
                  },
              }),
        ...(auth.activeTeamId === undefined ? {} : { activeTeamId: auth.activeTeamId }),
        claims: auth.claims as Record<string, RawJson>,
    };
}

function malformedMutationAuth(): CdbError {
    return new CdbError({ code: "CDB_INVALID_ARGS", message: "mutation auth payload is malformed" });
}
