import { CdbError, rehydrateCdbRpcError } from "../errors.ts";
import type { RouteResult } from "./do/catalog.ts";
import type { CdbVectorOrganizationPurgeStatus } from "./do/cdb-vector-organization-deletion-store.ts";

export interface OrganizationDeletionStatusCdbRpc {
    vectorOrganizationPurgeStatus(input: {
        readonly organizationId: string;
        readonly schemaEpoch: number;
        readonly domainSchemaEpoch: number;
        readonly recoveryGeneration: number;
    }): Promise<CdbVectorOrganizationPurgeStatus | null>;
}

export interface CurrentOwnerPurgeStatusDeps {
    readonly route: (vshard: number) => Promise<RouteResult>;
    readonly cdb: (shardId: string) => OrganizationDeletionStatusCdbRpc;
}

const TEXT = new TextEncoder();

function ownData(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}

function sameRoute(left: RouteResult, right: RouteResult): boolean {
    return (
        left.shardId === right.shardId &&
        left.schemaEpoch === right.schemaEpoch &&
        left.recoveryGeneration === right.recoveryGeneration &&
        left.domainSchemaEpoch === right.domainSchemaEpoch
    );
}

function count(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new CdbError({ code: "CDB_INVARIANT", message: `organization deletion ${subject} is invalid` });
    }
    return value as number;
}

export function projectVectorOrganizationPurgeStatus(
    value: unknown,
    organizationId: string
): CdbVectorOrganizationPurgeStatus | null {
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "organization deletion purge status is invalid" });
    }
    const keys = Object.keys(value).sort();
    const expected = [
        "attemptRows",
        "lastError",
        "organizationId",
        "outboxRows",
        "remainingHeads",
        "state",
        "unprovenTurns",
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "organization deletion purge status is invalid" });
    }
    const projectedOrganizationId = ownData(value, "organizationId");
    const state = ownData(value, "state");
    const lastError = ownData(value, "lastError");
    if (
        projectedOrganizationId !== organizationId ||
        (state !== "pending" && state !== "complete" && state !== "failed_unproven") ||
        (lastError !== null && (typeof lastError !== "string" || TEXT.encode(lastError).byteLength > 1_024))
    ) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "organization deletion purge status is invalid" });
    }
    const unprovenTurns = count(ownData(value, "unprovenTurns"), "unproven turn count");
    if (unprovenTurns > 32) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "organization deletion unproven turn count is invalid" });
    }
    const remainingHeads = count(ownData(value, "remainingHeads"), "remaining head count");
    const outboxRows = count(ownData(value, "outboxRows"), "outbox row count");
    const attemptRows = count(ownData(value, "attemptRows"), "attempt row count");
    const stateMatchesCounts =
        (state === "complete" && remainingHeads === 0 && outboxRows === 0 && attemptRows === 0 && lastError === null) ||
        (state === "pending" && remainingHeads > 0 && lastError === null) ||
        (state === "failed_unproven" && remainingHeads > 0 && outboxRows > 0 && lastError !== null);
    if (!stateMatchesCounts || outboxRows > remainingHeads) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "organization deletion purge status is inconsistent" });
    }
    return Object.freeze({
        organizationId,
        state,
        remainingHeads,
        outboxRows,
        attemptRows,
        unprovenTurns,
        lastError,
    });
}

/** Resolve the current physical owner around the Cdb read and retry one cutover race. */
export async function readCurrentOwnerVectorPurgeStatus(input: {
    readonly organizationId: string;
    readonly vshard: number;
    readonly deps: CurrentOwnerPurgeStatusDeps;
}): Promise<CdbVectorOrganizationPurgeStatus | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await input.deps.route(input.vshard);
        let raw: unknown;
        try {
            raw = await input.deps.cdb(before.shardId).vectorOrganizationPurgeStatus({
                organizationId: input.organizationId,
                schemaEpoch: before.schemaEpoch,
                domainSchemaEpoch: before.domainSchemaEpoch,
                recoveryGeneration: before.recoveryGeneration,
            });
        } catch (error) {
            const afterFailure = await input.deps.route(input.vshard);
            if (!sameRoute(before, afterFailure)) {
                if (attempt === 0) continue;
                throw new CdbError({
                    code: "CDB_STALE_EPOCH",
                    message: "organization deletion owner changed while reading purge status",
                });
            }
            throw rehydrateCdbRpcError(error);
        }
        const after = await input.deps.route(input.vshard);
        if (!sameRoute(before, after)) {
            if (attempt === 0) continue;
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: "organization deletion owner changed while reading purge status",
            });
        }
        return projectVectorOrganizationPurgeStatus(raw, input.organizationId);
    }
    throw new CdbError({ code: "CDB_INVARIANT", message: "organization deletion status retry lost its result" });
}
