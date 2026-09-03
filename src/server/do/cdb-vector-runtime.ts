import { CdbError, isCdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { type VectorResourceV1, cdbVectorResourceId } from "../resource-descriptors.ts";
import {
    CDB_VECTOR_ACCEPTED_DELETE_SETTLEMENT_MS,
    CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS,
    type CdbVectorClaim,
    CdbVectorOutboxStore,
} from "./cdb-vector-outbox-store.ts";
import {
    type CdbVectorizeMutationIndex,
    deliverCdbVectorClaim,
    verifyCdbVectorClaim,
} from "./cdb-vectorize-adapter.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

export const CDB_VECTOR_DELIVERY_LEASE_MS = 30_000;
export const CDB_VECTOR_DELIVERY_SETTLEMENT_MS = CDB_VECTOR_ACCEPTED_DELETE_SETTLEMENT_MS;
export const CDB_VECTOR_DELIVERY_BASE_RETRY_MS = 1_000;
export const CDB_VECTOR_DELIVERY_MAX_RETRY_MS = 60_000;
export const CDB_VECTOR_VISIBILITY_POLL_MS = 1_000;

function invariant(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message: `vector delivery: ${message}` });
}

function identifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const encoded = new TextEncoder().encode(raw);
    if (encoded.byteLength <= 1_024) return raw;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let end = 1_024; end >= 1_020; end--) {
        try {
            return decoder.decode(encoded.slice(0, end));
        } catch {
            // Back up to the previous complete UTF-8 code point.
        }
    }
    invariant("could not bound a vector delivery error");
}

export class CdbVectorRuntime {
    constructor(
        readonly input: {
            readonly storage: DurableObjectStorage;
            readonly resources: () => readonly VectorResourceV1[];
            readonly resolveIndex: (binding: string) => CdbVectorizeMutationIndex;
            readonly assertDeliveryAdmission: (claim: CdbVectorClaim, sql: SyncSql, recoveryBookmark?: string) => void;
            readonly organizationDeleted?: (organizationId: string, sql: SyncSql) => boolean;
            readonly recordOrganizationUnprovenDeleteTurn?: (
                organizationId: string,
                sql: SyncSql
            ) => { readonly turns: number; readonly terminal: boolean } | null;
            readonly onDeliverySettled?: (claim: CdbVectorClaim, outcome: "ready" | "deleted", sql: SyncSql) => boolean;
            readonly captureDeliveryTransaction: <T>(sql: SyncSql, placementVshard: number, callback: () => T) => T;
            readonly nowMs: () => number;
            readonly scheduleAlarmNoLaterThan: (deadline: number) => Promise<void>;
            readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
            readonly clearTimeout?: (handle: unknown) => void;
        }
    ) {}

    async maintain(options: { readonly recoveryBookmark?: string } = {}): Promise<void> {
        const nowMs = this.input.nowMs();
        let claim: CdbVectorClaim | null = null;
        let resource: VectorResourceV1 | undefined;
        try {
            this.input.storage.transactionSync(() => {
                const sql = adaptSqlStorage(this.input.storage.sql);
                const store = new CdbVectorOutboxStore(sql);
                const placementVshard = store.nextClaimPlacement(nowMs);
                if (placementVshard === null) return;
                this.input.captureDeliveryTransaction(sql, placementVshard, () => {
                    claim = store.claimNext({
                        nowMs,
                        leaseMs: CDB_VECTOR_DELIVERY_LEASE_MS,
                        settlementMs: CDB_VECTOR_DELIVERY_SETTLEMENT_MS,
                        claimToken: `vc_${crypto.randomUUID()}`,
                        expectedPlacementVshard: placementVshard,
                    });
                    if (!claim) return;
                    resource = this.resolveResource(claim);
                    this.input.assertDeliveryAdmission(claim, sql, options.recoveryBookmark);
                    this.assertDomainHead(sql, claim, resource);
                });
            });
        } catch (error) {
            await this.input.scheduleAlarmNoLaterThan(nowMs + CDB_VECTOR_DELIVERY_BASE_RETRY_MS);
            throw error;
        }
        const claimed = claim as CdbVectorClaim | null;
        const claimedResource = resource as VectorResourceV1 | undefined;
        if (!claimed || !claimedResource) {
            await this.scheduleNext();
            return;
        }

        let externalDeleteProven = false;
        let settlementClaim: CdbVectorClaim = claimed;
        try {
            await this.input.scheduleAlarmNoLaterThan(claimed.leasedUntil);
            this.input.storage.transactionSync(() => {
                this.input.assertDeliveryAdmission(
                    claimed,
                    adaptSqlStorage(this.input.storage.sql),
                    options.recoveryBookmark
                );
            });
            const deleteProofRecorded = claimed.operation === "delete" && claimed.deleteProofRecorded;
            const index = deleteProofRecorded ? null : this.input.resolveIndex(claimedResource.binding);
            const receipt =
                claimed.phase === "submit"
                    ? await this.beforeLeaseDeadline(
                          () =>
                              deliverCdbVectorClaim(index ?? invariant("submitted claim has no vector index"), claimed),
                          claimed.leasedUntil
                      )
                    : null;
            const visible =
                claimed.phase === "verify" && !deleteProofRecorded
                    ? await this.beforeLeaseDeadline(
                          () =>
                              verifyCdbVectorClaim(
                                  index ?? invariant("verification claim has no vector index"),
                                  claimed
                              ),
                          claimed.leasedUntil
                      )
                    : null;
            externalDeleteProven =
                claimed.operation === "delete" &&
                (claimed.deleteProofRecorded ||
                    receipt?.kind === "processed" ||
                    (claimed.phase === "verify" && visible === true));
            const acknowledgedAt = this.input.nowMs();
            if (
                externalDeleteProven &&
                claimed.operation === "delete" &&
                claimed.phase === "verify" &&
                !claimed.deleteProofRecorded &&
                claimed.physicalIds.length > 0
            ) {
                this.input.storage.transactionSync(() => {
                    const sql = adaptSqlStorage(this.input.storage.sql);
                    this.input.captureDeliveryTransaction(sql, claimed.placementVshard, () => {
                        const currentResource = this.resolveResource(claimed);
                        this.input.assertDeliveryAdmission(claimed, sql, options.recoveryBookmark);
                        this.assertDomainHead(sql, claimed, currentResource);
                        new CdbVectorOutboxStore(sql).recordDeleteProof(claimed, acknowledgedAt);
                    });
                });
                settlementClaim = Object.freeze({
                    ...claimed,
                    deleteProofRecorded: true,
                    physicalIds: Object.freeze([]),
                });
            }
            let wakeInvalidations = false;
            this.input.storage.transactionSync(() => {
                const sql = adaptSqlStorage(this.input.storage.sql);
                this.input.captureDeliveryTransaction(sql, settlementClaim.placementVshard, () => {
                    const currentResource = this.resolveResource(settlementClaim);
                    this.input.assertDeliveryAdmission(settlementClaim, sql, options.recoveryBookmark);
                    this.assertDomainHead(sql, settlementClaim, currentResource);
                    const store = new CdbVectorOutboxStore(sql);
                    const unsettledUntil =
                        receipt?.kind !== "accepted" && settlementClaim.operation === "delete" && !externalDeleteProven
                            ? store.deleteClaimUnsettledUntil(settlementClaim, acknowledgedAt)
                            : null;
                    if (receipt?.kind === "accepted") {
                        store.acceptSubmission(
                            settlementClaim,
                            receipt.mutationId,
                            acknowledgedAt,
                            acknowledgedAt + CDB_VECTOR_VISIBILITY_POLL_MS
                        );
                    } else if (unsettledUntil !== null) {
                        store.failClaim({
                            vectorId: settlementClaim.vectorId,
                            targetVersion: settlementClaim.targetVersion,
                            operation: "delete",
                            phase: settlementClaim.phase,
                            claimToken: settlementClaim.claimToken,
                            nextAttemptAt: unsettledUntil,
                            error: "",
                        });
                    } else if (
                        settlementClaim.operation === "delete" &&
                        !externalDeleteProven &&
                        store.deleteClaimHasUncertainAttempts(settlementClaim, acknowledgedAt)
                    ) {
                        this.recordUnprovenDeleteTurn(settlementClaim, sql);
                        store.terminallyFailUnprovenDelete(settlementClaim, acknowledgedAt);
                    } else if (settlementClaim.phase === "verify" && visible === false) {
                        if (
                            settlementClaim.operation === "delete" &&
                            !externalDeleteProven &&
                            this.unprovenDeleteTurnIsTerminal(settlementClaim, sql)
                        ) {
                            store.terminallyFailUnprovenDelete(settlementClaim, acknowledgedAt);
                        } else {
                            store.failClaim({
                                vectorId: settlementClaim.vectorId,
                                targetVersion: settlementClaim.targetVersion,
                                operation: settlementClaim.operation,
                                phase: settlementClaim.phase,
                                claimToken: settlementClaim.claimToken,
                                nextAttemptAt: acknowledgedAt + CDB_VECTOR_VISIBILITY_POLL_MS,
                                error: "",
                            });
                        }
                    } else if (settlementClaim.operation === "upsert") {
                        store.acknowledgeUpsert(settlementClaim, acknowledgedAt);
                        wakeInvalidations = this.input.onDeliverySettled?.(settlementClaim, "ready", sql) === true;
                    } else {
                        const outcome = store.acknowledgeDelete(settlementClaim, acknowledgedAt, externalDeleteProven);
                        if (outcome.deleted) {
                            wakeInvalidations =
                                this.input.onDeliverySettled?.(settlementClaim, "deleted", sql) === true;
                        }
                    }
                });
            });
            if (wakeInvalidations) await this.input.scheduleAlarmNoLaterThan(acknowledgedAt + 1);
        } catch (error) {
            let retryAt = this.retryAt(nowMs, claimed.attempt);
            let settlementError: unknown;
            let terminalized = false;
            try {
                this.input.storage.transactionSync(() => {
                    const sql = adaptSqlStorage(this.input.storage.sql);
                    this.input.captureDeliveryTransaction(sql, claimed.placementVshard, () => {
                        const currentResource = this.resolveResource(claimed);
                        this.input.assertDeliveryAdmission(claimed, sql, options.recoveryBookmark);
                        this.assertDomainHead(sql, claimed, currentResource);
                        const store = new CdbVectorOutboxStore(sql);
                        const unsettledUntil =
                            settlementClaim.operation === "delete" && !externalDeleteProven
                                ? store.deleteClaimUnsettledUntil(settlementClaim, this.input.nowMs())
                                : null;
                        if (unsettledUntil !== null) {
                            retryAt = unsettledUntil;
                            store.failClaim({
                                vectorId: settlementClaim.vectorId,
                                targetVersion: settlementClaim.targetVersion,
                                operation: "delete",
                                phase: settlementClaim.phase,
                                claimToken: settlementClaim.claimToken,
                                nextAttemptAt: unsettledUntil,
                                error: errorText(error),
                            });
                        } else if (
                            settlementClaim.operation === "delete" &&
                            !externalDeleteProven &&
                            this.unprovenDeleteTurnIsTerminal(settlementClaim, sql)
                        ) {
                            store.terminallyFailUnprovenDelete(settlementClaim, this.input.nowMs());
                            terminalized = true;
                        } else {
                            store.failClaim({
                                vectorId: settlementClaim.vectorId,
                                targetVersion: settlementClaim.targetVersion,
                                operation: settlementClaim.operation,
                                phase: settlementClaim.phase,
                                claimToken: settlementClaim.claimToken,
                                nextAttemptAt: retryAt,
                                error: errorText(error),
                            });
                        }
                    });
                });
            } catch (settleError) {
                if (
                    !isCdbError(settleError) ||
                    (settleError.code !== "CDB_STALE_EPOCH" && settleError.code !== "CDB_FORBIDDEN")
                ) {
                    settlementError = settleError;
                }
            }
            if (!terminalized) await this.input.scheduleAlarmNoLaterThan(retryAt);
            if (settlementError !== undefined) throw settlementError;
        }
        await this.scheduleNext();
    }

    private async beforeLeaseDeadline<T>(operation: () => Promise<T>, leasedUntil: number): Promise<T> {
        const remainingMs = leasedUntil - this.input.nowMs();
        if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
            throw new CdbError({
                code: "CDB_SHARD_UNAVAILABLE",
                message: "vector delivery: external request exceeded its claim lease",
            });
        }
        const schedule = this.input.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
        const cancel = this.input.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
        let timeoutHandle: unknown;
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutHandle = schedule(() => {
                reject(
                    new CdbError({
                        code: "CDB_SHARD_UNAVAILABLE",
                        message: "vector delivery: external request exceeded its claim lease",
                    })
                );
            }, remainingMs);
        });
        try {
            return await Promise.race([operation(), timeout]);
        } finally {
            if (timeoutHandle !== undefined) cancel(timeoutHandle);
        }
    }

    private resolveResource(claim: CdbVectorClaim): VectorResourceV1 {
        const resources = this.input.resources().filter(resource => cdbVectorResourceId(resource) === claim.resourceId);
        if (resources.length !== 1) invariant("claim does not match one configured resource descriptor");
        const resource = resources[0] as VectorResourceV1;
        if (resource.dimensions !== claim.dimensions)
            invariant("claim dimensions do not match its resource descriptor");
        return resource;
    }

    private recordUnprovenDeleteTurn(
        claim: CdbVectorClaim,
        sql: SyncSql
    ): { readonly turns: number; readonly terminal: boolean } | null {
        return this.input.recordOrganizationUnprovenDeleteTurn?.(claim.organizationId, sql) ?? null;
    }

    private unprovenDeleteTurnIsTerminal(claim: CdbVectorClaim, sql: SyncSql): boolean {
        const organizationProgress = this.recordUnprovenDeleteTurn(claim, sql);
        if (organizationProgress !== null) return organizationProgress.terminal;
        return claim.phase === "verify" && claim.attempt >= CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS + 1;
    }

    private assertDomainHead(sql: SyncSql, claim: CdbVectorClaim, resource: VectorResourceV1): void {
        const row = sql.one<{ vector_id: string | null }>(
            `SELECT ${identifier(resource.column)} AS vector_id
             FROM ${identifier(resource.table)}
             WHERE ${identifier(resource.primaryKey)} = ?
               AND ${identifier(resource.organizationColumn)} = ?
             LIMIT 1`,
            claim.rowPk,
            claim.organizationId
        );
        if (claim.operation === "upsert" || claim.mode === "cleanup") {
            if (row?.vector_id !== claim.vectorId) invariant("domain row no longer points at the claimed vector head");
        } else if (
            row?.vector_id === claim.vectorId &&
            this.input.organizationDeleted?.(claim.organizationId, sql) !== true
        ) {
            invariant("deleting vector head is still referenced by its domain row");
        }
    }

    private retryAt(nowMs: number, attempt: number): number {
        const delay = Math.min(
            CDB_VECTOR_DELIVERY_MAX_RETRY_MS,
            CDB_VECTOR_DELIVERY_BASE_RETRY_MS * 2 ** Math.min(16, Math.max(0, attempt - 1))
        );
        const retryAt = nowMs + delay;
        if (!Number.isSafeInteger(retryAt)) invariant("retry deadline overflowed");
        return retryAt;
    }

    private async scheduleNext(): Promise<void> {
        const next = new CdbVectorOutboxStore(adaptSqlStorage(this.input.storage.sql)).nextDueAt();
        if (next !== null) await this.input.scheduleAlarmNoLaterThan(Math.max(this.input.nowMs() + 1, next));
    }
}
