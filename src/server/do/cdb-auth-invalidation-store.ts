import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { enqueueAuthScopeInvalidations } from "./cdb-live-store.ts";

export const CDB_AUTH_INVALIDATION_SCOPE_LIMIT = 8_193;
const SCOPE_ID_MAX_BYTES = 256;
const SCOPE_ID = /^[^\0]+$/;

const DDL = `
CREATE TABLE IF NOT EXISTS _chardb_auth_invalidation_epochs (
  scope         TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'principal')),
  scope_id      TEXT NOT NULL,
  epoch         INTEGER NOT NULL CHECK (epoch > 0),
  change_seq    INTEGER NOT NULL CHECK (change_seq >= 0),
  registrations INTEGER NOT NULL CHECK (registrations >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope, scope_id)
);
` as const;

export interface CdbAuthInvalidationRequest {
    readonly scope: "global" | "tenant" | "principal";
    readonly scopeId: string;
    readonly epoch: number;
    readonly recoveryGeneration: number;
}

export interface CdbAuthInvalidationResult extends CdbAuthInvalidationRequest {
    readonly accepted: true;
    readonly registrations: number;
    readonly changeSeq: number;
}

interface StoredEpoch {
    readonly epoch: number;
    readonly change_seq: number;
    readonly registrations: number;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `Cdb auth invalidation: ${message}` });
}

function validate(request: CdbAuthInvalidationRequest): void {
    if (request.scope !== "global" && request.scope !== "tenant" && request.scope !== "principal") {
        invalid("scope is invalid");
    }
    if (
        typeof request.scopeId !== "string" ||
        !SCOPE_ID.test(request.scopeId) ||
        new TextEncoder().encode(request.scopeId).byteLength > SCOPE_ID_MAX_BYTES ||
        (request.scope === "global" && request.scopeId !== "global")
    ) {
        invalid("scope id is invalid");
    }
    if (!Number.isSafeInteger(request.epoch) || request.epoch < 1) invalid("epoch is invalid");
    if (!Number.isSafeInteger(request.recoveryGeneration) || request.recoveryGeneration < 0) {
        invalid("recovery generation is invalid");
    }
}

export function initializeCdbAuthInvalidationStore(sql: SyncSql): void {
    for (const statement of DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
}

/** Idempotent auth-epoch projection into the existing live invalidation outbox. */
export class CdbAuthInvalidationStore {
    constructor(readonly sql: SyncSql) {}

    apply(request: CdbAuthInvalidationRequest, nowMs: number): CdbAuthInvalidationResult {
        validate(request);
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid("timestamp is invalid");
        const existing = this.read(request.scope, request.scopeId);
        if (existing && existing.epoch >= request.epoch) {
            return Object.freeze({
                scope: request.scope,
                scopeId: request.scopeId,
                epoch: existing.epoch,
                recoveryGeneration: request.recoveryGeneration,
                accepted: true,
                registrations: existing.registrations,
                changeSeq: existing.change_seq,
            });
        }

        this.pruneInactiveScopes();
        if (!existing) {
            const count = this.sql.one<{ count: number }>(
                "SELECT COUNT(*) AS count FROM _chardb_auth_invalidation_epochs"
            )?.count;
            if (!Number.isSafeInteger(count) || (count as number) < 0) {
                throw new CdbError({ code: "CDB_INVARIANT", message: "Cdb auth invalidation scope count is invalid" });
            }
            if ((count as number) >= CDB_AUTH_INVALIDATION_SCOPE_LIMIT) {
                throw new CdbError({
                    code: "CDB_RATE_LIMITED",
                    message: `Cdb auth invalidation history reached its ${CDB_AUTH_INVALIDATION_SCOPE_LIMIT}-scope limit`,
                    retryAfterMs: 1_000,
                });
            }
        }

        const invalidation = enqueueAuthScopeInvalidations(this.sql, request.scope, request.scopeId);
        this.sql.exec(
            `INSERT INTO _chardb_auth_invalidation_epochs
              (scope, scope_id, epoch, change_seq, registrations, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope, scope_id) DO UPDATE SET
               epoch = excluded.epoch,
               change_seq = excluded.change_seq,
               registrations = excluded.registrations,
               updated_at = excluded.updated_at
             WHERE excluded.epoch > epoch`,
            request.scope,
            request.scopeId,
            request.epoch,
            invalidation.changeSeq,
            invalidation.registrations,
            nowMs
        );
        return Object.freeze({
            scope: request.scope,
            scopeId: request.scopeId,
            epoch: request.epoch,
            recoveryGeneration: request.recoveryGeneration,
            accepted: true,
            ...invalidation,
        });
    }

    private read(scope: CdbAuthInvalidationRequest["scope"], scopeId: string): StoredEpoch | null {
        return this.sql.one<StoredEpoch>(
            `SELECT epoch, change_seq, registrations FROM _chardb_auth_invalidation_epochs
             WHERE scope = ? AND scope_id = ?`,
            scope,
            scopeId
        );
    }

    private pruneInactiveScopes(): void {
        this.sql.exec(
            `DELETE FROM _chardb_auth_invalidation_epochs AS epochs
             WHERE scope = 'tenant' AND NOT EXISTS (
               SELECT 1 FROM _chardb_live_subscriptions AS subscriptions
               WHERE subscriptions.state = 'active' AND subscriptions.organization_id = epochs.scope_id
             )`
        );
        this.sql.exec(
            `DELETE FROM _chardb_auth_invalidation_epochs AS epochs
             WHERE scope = 'principal' AND NOT EXISTS (
               SELECT 1 FROM _chardb_live_subscriptions AS subscriptions
               WHERE subscriptions.state = 'active' AND subscriptions.principal_id = epochs.scope_id
             )`
        );
    }
}
