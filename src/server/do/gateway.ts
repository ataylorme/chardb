/**
 * `Gateway` DO — Hibernatable WebSockets
 * (https://developers.cloudflare.com/durable-objects/api/hibernatable-websockets-api/),
 * sub registry, presence broadcast.
 *
 * Sharded by `clientId` prefix (12-bit prefix → 4096 Gateway DOs default).
 * Hibernated state is rebuilt from `_gw_subs` and `_gw_presence_subs` on wake;
 * the per-conn 2 KiB `serializeAttachment` payload carries verified subject,
 * expiry, client id, and resume state so a wake-up can recheck authentication
 * without trusting decode-only JWT claims.
 */

import { DurableObject } from "cloudflare:workers";
import { createCatalogJwksResolver } from "../../auth/jwks_cache.ts";
import { verifyJwt } from "../../auth/jwt.ts";
import { CdbError, docsUrlFor, isCdbErrorCode, isRetryable } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import {
    type ChardbRef,
    ClientId,
    Cookie,
    CorrelationId,
    type MutId,
    PrincipalId,
    type RawJson,
    SubId,
    TenantId,
} from "../../types.ts";
import type { Vshard } from "../../types.ts";
import { stableJson } from "../../util/canonical.ts";
import { rawJsonResult } from "../../util/raw_json.ts";
import { vshardOf } from "../../vshard.ts";
import {
    type CdbIntent,
    type Down,
    type MustRefetchReason,
    PROTOCOL_V,
    type RowPatch,
    type Up,
    type WireMessage,
    checkProtocolV,
    decodeWire,
    encodeWire,
} from "../../wire.ts";
import type { AuthCtx } from "../define.ts";
import {
    type ChardbManifest,
    type QueryRouteResponse,
    emptyManifest,
    routeMutation as resolveMutationRoute,
    routeQuery as resolveQueryRoute,
} from "../manifest.ts";
import type {
    CatalogMutationRpc,
    CatalogOrganizationAuthorityRpc,
    CatalogRoutingRpc,
    CdbErrorWire,
    CdbMutationResponse,
    CdbMutationRpc,
    CdbQueryResponse,
    CdbQueryRpc,
    CdbSubscriptionRequest,
    CdbSubscriptionRpc,
    GatewayInvalidationAck,
    GatewayInvalidationRequest,
    GatewayInvalidationResponse,
    LiveSubscriptionId,
    MutationRouteRequest,
    MutationRouteResolver,
    MutationRouteResponse,
    TrustedMutationAuth,
    TrustedMutationDispatchRequest,
} from "../rpc.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

export const GATEWAY_REGISTRATION_DDL = `
CREATE TABLE IF NOT EXISTS _gw_registration_generations (
  registration_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL CHECK (sub_id >= 0),
  connection_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  args_json TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  source_cdb_id TEXT NOT NULL,
  schema_epoch INTEGER NOT NULL CHECK (schema_epoch >= 0),
  auth_global_epoch INTEGER NOT NULL CHECK (auth_global_epoch >= 0),
  auth_tenant_epoch INTEGER NOT NULL CHECK (auth_tenant_epoch >= 0),
  auth_principal_epoch INTEGER NOT NULL CHECK (auth_principal_epoch >= 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('installing', 'active', 'retiring')),
  cdb_state TEXT NOT NULL CHECK (cdb_state IN ('pending', 'active', 'retiring', 'error')),
  dirty_version INTEGER NOT NULL CHECK (dirty_version >= 0),
  delivered_version INTEGER NOT NULL CHECK (delivered_version >= 0 AND delivered_version <= dirty_version),
  run_token TEXT,
  run_target_version INTEGER CHECK (run_target_version IS NULL OR (run_target_version >= 0 AND run_target_version <= dirty_version)),
  run_version INTEGER NOT NULL CHECK (run_version >= 0),
  last_cookie TEXT,
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  retry_at INTEGER CHECK (retry_at IS NULL OR retry_at >= 0),
  retry_error TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
CREATE INDEX IF NOT EXISTS _gw_registration_generations_logical
  ON _gw_registration_generations (principal_id, client_id, sub_id, created_at);
CREATE TABLE IF NOT EXISTS _gw_registration_heads (
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL CHECK (sub_id >= 0),
  registration_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (principal_id, client_id, sub_id),
  UNIQUE (registration_id),
  FOREIGN KEY (registration_id) REFERENCES _gw_registration_generations(registration_id)
);
` as const;

const GW_DDL = `
CREATE TABLE IF NOT EXISTS _gw_subs (
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL,
  ast_hash TEXT NOT NULL,
  shard_ids TEXT NOT NULL,
  intent_blob TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL,
  last_cookie TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, sub_id)
);
CREATE TABLE IF NOT EXISTS _gw_shard_subs (
  shard_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL,
  PRIMARY KEY (shard_id, client_id, sub_id)
);
CREATE TABLE IF NOT EXISTS _gw_presence_subs (
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (client_id, key)
);
${GATEWAY_REGISTRATION_DDL}
` as const;

export const COALESCE_WINDOW_MS = 50 as const;
export const MAX_POKE_INTERVAL_MS = 250 as const;
export const PRESENCE_FANOUT_CAP = 1024 as const;

export const PRESENCE_TTL_DEFAULT_MS = 30_000 as const;
export const MAX_INITIAL_SNAPSHOTS_PER_CONNECTION = 64 as const;
export const MAX_GATEWAY_INVALIDATIONS_PER_REQUEST = 64 as const;
export const GATEWAY_CLEANUP_BATCH_SIZE = 32 as const;
export const GATEWAY_CLEANUP_BASE_RETRY_MS = 1_000 as const;
export const GATEWAY_CLEANUP_MAX_RETRY_MS = 60_000 as const;
export const GATEWAY_CLEANUP_MAX_RETRY_COUNT = 30 as const;
export const GATEWAY_CLEANUP_MAX_ERROR_LENGTH = 512 as const;

interface PendingGwAttachment {
    readonly kind: "pending";
    readonly connectionId: string;
    readonly authOrigin: string;
    readonly routedClientId: ClientId | null;
}

interface RejectedGwAttachment {
    readonly kind: "rejected";
    readonly connectionId: string;
    readonly authOrigin: string;
}

interface PendingSubscription {
    readonly connectionId: string;
    readonly subId: SubId;
    cancelled: boolean;
    task: Promise<void>;
}

export interface VerifiedGwAttachment {
    readonly kind: "verified";
    readonly connectionId: string;
    readonly authOrigin: string;
    readonly clientId: ClientId;
    readonly lastCookie?: Cookie;
    readonly presenceKeys?: readonly string[];
    readonly snapshotSubIds?: readonly SubId[];
    /** Subject from a signature-verified token. */
    readonly principalId: PrincipalId;
    /** Required JWT expiry in epoch seconds. */
    readonly jwtExp: number;
    readonly jwtNbf?: number;
}

type GwAttachment = PendingGwAttachment | RejectedGwAttachment | VerifiedGwAttachment;

export interface GatewayEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

type CdbRpc = CdbSubscriptionRpc & CdbQueryRpc;

export interface TrustedMutationDispatchDeps {
    readonly routeMutation: MutationRouteResolver;
    readonly catalog: CatalogMutationRpc & CatalogOrganizationAuthorityRpc;
    readonly cdb: (shardId: string) => CdbMutationRpc;
}

export interface GatewayRuntimeConfig {
    readonly manifest: () => ChardbManifest;
    readonly auth: GatewayJwtConfig | null;
}

export interface GatewayJwtConfig {
    readonly issuer?: string;
    readonly audience?: string | readonly string[];
    readonly algorithms: readonly string[];
    readonly jwksUrl?: string;
    readonly authBasePath: string;
    readonly jwksPath: string;
    readonly clockToleranceSeconds?: number;
}

/** Parse the Worker-routed client id without trusting the later hello payload. */
export function routedClientIdFromUrl(rawUrl: string): ClientId | null {
    let candidates: string[];
    try {
        candidates = new URL(rawUrl).searchParams.getAll("clientId");
    } catch {
        return null;
    }
    if (candidates.length !== 1) return null;
    const candidate = candidates[0] as string;
    if (
        candidate.length === 0 ||
        candidate.length > 256 ||
        candidate.trim() !== candidate ||
        hasAsciiControlCharacter(candidate)
    ) {
        return null;
    }
    return ClientId(candidate);
}

function hasAsciiControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127) return true;
    }
    return false;
}

interface CatalogJwksRpc extends CatalogMutationRpc {
    getJwk(kid: string): Promise<{ jwkJson: string; expiresAt: number } | null>;
    putJwk(kid: string, jwkJson: string, ttlMs: number): Promise<void>;
}

function mutationFailure(
    code: import("../../errors.ts").CdbErrorCode,
    message: string
): Extract<CdbMutationResponse, { readonly ok: false }> {
    return { ok: false, error: new CdbError({ code, message }).toJSON() };
}

/** Reject stale or malformed shard RPC envelopes before WebSocket settlement. */
export function projectCdbMutationResponse(value: unknown): CdbMutationResponse {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return mutationFailure("CDB_INVARIANT", "Cdb returned a malformed mutation response");
    }
    const response = value as Record<string, unknown>;
    if (response.ok === true) {
        if (
            typeof response.cookie !== "string" ||
            response.cookie.length === 0 ||
            typeof response.ran !== "boolean" ||
            typeof response.rowsAffected !== "number" ||
            !Number.isSafeInteger(response.rowsAffected) ||
            response.rowsAffected < 0
        ) {
            return mutationFailure("CDB_INVARIANT", "Cdb returned a malformed mutation success");
        }
        try {
            const result = rawJsonResult(response.result, "Cdb mutation result");
            return {
                ok: true,
                cookie: response.cookie,
                ran: response.ran,
                result,
                rowsAffected: response.rowsAffected,
            };
        } catch {
            return mutationFailure("CDB_INVARIANT", "Cdb returned a non-JSON mutation result");
        }
    }
    if (response.ok === false) {
        const error = response.error;
        if (typeof error !== "object" || error === null || Array.isArray(error)) {
            return mutationFailure("CDB_INVARIANT", "Cdb returned a malformed mutation failure");
        }
        const wire = error as Record<string, unknown>;
        if (
            !isCdbErrorCode(wire.code) ||
            typeof wire.retryable !== "boolean" ||
            typeof wire.message !== "string" ||
            typeof wire.docs !== "string" ||
            (wire.correlationId !== undefined && typeof wire.correlationId !== "string") ||
            (wire.retryAfterMs !== undefined &&
                (typeof wire.retryAfterMs !== "number" || !Number.isFinite(wire.retryAfterMs))) ||
            (wire.hint !== undefined && typeof wire.hint !== "string")
        ) {
            return mutationFailure("CDB_INVARIANT", "Cdb returned a malformed mutation failure");
        }
        return { ok: false, error: wire as unknown as CdbErrorWire };
    }
    return mutationFailure("CDB_INVARIANT", "Cdb returned a malformed mutation response");
}

type CdbQueryRowsResponse =
    | { readonly ok: true; readonly result: readonly RawJson[] }
    | Extract<CdbQueryResponse, { readonly ok: false }>;

function projectCdbQueryRows(value: unknown): CdbQueryRowsResponse {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return mutationFailure("CDB_INVARIANT", "Cdb returned a malformed query response");
    }
    const response = value as Record<string, unknown>;
    if (response.ok === true) {
        try {
            const result = rawJsonResult(response.result, "Cdb query result");
            if (!Array.isArray(result)) {
                return mutationFailure("CDB_INVARIANT", "organization query result must be an array");
            }
            return { ok: true, result };
        } catch {
            return mutationFailure("CDB_INVARIANT", "Cdb returned a non-JSON query result");
        }
    }
    if (response.ok === false) {
        const projected = projectCdbMutationResponse(response);
        return projected.ok ? mutationFailure("CDB_INVARIANT", "Cdb returned a malformed query failure") : projected;
    }
    return mutationFailure("CDB_INVARIANT", "Cdb returned a malformed query response");
}

type OrganizationAuthProjection =
    | { readonly ok: true; readonly auth: AuthCtx }
    | {
          readonly ok: false;
          readonly code: "CDB_FORBIDDEN" | "CDB_CATALOG_UNAVAILABLE";
          readonly message: string;
      };

/** Validate the Catalog authority envelope before it becomes mutation auth. */
export function projectOrganizationMutationAuth(
    value: unknown,
    expected: { readonly principalId: PrincipalId; readonly organizationId: TenantId }
): OrganizationAuthProjection {
    if (value === null) {
        return { ok: false, code: "CDB_FORBIDDEN", message: "organization membership is missing or revoked" };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, code: "CDB_CATALOG_UNAVAILABLE", message: "Catalog returned malformed authority" };
    }
    const authority = value as Record<string, unknown>;
    const roles = authority.roles;
    const epochs = authority.authEpochs;
    if (
        typeof authority.principalId !== "string" ||
        typeof authority.organizationId !== "string" ||
        typeof authority.role !== "string" ||
        !Array.isArray(roles) ||
        !roles.every(role => typeof role === "string") ||
        typeof epochs !== "object" ||
        epochs === null ||
        Array.isArray(epochs)
    ) {
        return { ok: false, code: "CDB_CATALOG_UNAVAILABLE", message: "Catalog returned malformed authority" };
    }
    const epochRecord = epochs as Record<string, unknown>;
    if (
        ![epochRecord.global, epochRecord.tenant, epochRecord.principal].every(
            epoch => typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0
        )
    ) {
        return { ok: false, code: "CDB_CATALOG_UNAVAILABLE", message: "Catalog returned malformed auth epochs" };
    }
    if (
        authority.principalId !== expected.principalId ||
        authority.organizationId !== expected.organizationId ||
        authority.role.length === 0 ||
        roles.length === 0
    ) {
        return { ok: false, code: "CDB_FORBIDDEN", message: "organization membership is missing or revoked" };
    }
    if (roles.some(role => role.length === 0) || authority.role !== roles.join(",")) {
        return { ok: false, code: "CDB_CATALOG_UNAVAILABLE", message: "Catalog returned inconsistent roles" };
    }
    return {
        ok: true,
        auth: {
            userId: authority.principalId,
            tenantId: authority.organizationId,
            role: authority.role,
            roles,
            authEpochs: {
                global: epochRecord.global as number,
                tenant: epochRecord.tenant as number,
                principal: epochRecord.principal as number,
            },
            claims: {},
        },
    };
}

/** Build a Down.error envelope with the locked metadata for its code. */
export function gatewayErrorEnvelope(
    code: import("../../errors.ts").CdbErrorCode,
    correlationId: CorrelationId,
    subId?: SubId
): Extract<Down, { readonly t: "error" }> {
    return {
        t: "error",
        code,
        retryable: isRetryable(code),
        correlationId,
        docs: docsUrlFor(code),
        ...(subId !== undefined ? { subId } : {}),
    };
}

/** Build a generation-specific subscription identity from Gateway-owned values. */
export function gatewaySubscriptionId(
    gatewayId: string,
    registrationId: string,
    connectionId: string,
    clientId: ClientId,
    subId: SubId
): LiveSubscriptionId {
    return { gatewayId, registrationId, connectionId, clientId, subId };
}

/** Build the serializable Cdb subscription RPC from server-owned routing data. */
export function cdbSubscriptionRequest(input: {
    readonly gatewayId: string;
    readonly registrationId: string;
    readonly connectionId: string;
    readonly clientId: ClientId;
    readonly subId: SubId;
    readonly principalId: PrincipalId;
    readonly organizationId: TenantId;
    readonly ref: ChardbRef;
    readonly args: RawJson;
    readonly queryHash: string;
    readonly intent: CdbIntent;
}): CdbSubscriptionRequest {
    return {
        subscription: gatewaySubscriptionId(
            input.gatewayId,
            input.registrationId,
            input.connectionId,
            input.clientId,
            input.subId
        ),
        principalId: input.principalId,
        organizationId: input.organizationId,
        ref: input.ref,
        args: input.args,
        queryHash: input.queryHash,
        tables: [...input.intent.tables],
        intervals: (input.intent.intervals ?? []).map(bundle => ({
            table: bundle.table,
            indexName: bundle.indexName,
            intervals: bundle.intervals,
        })),
    };
}

interface StoredCdbRegistration {
    readonly registrationId: string;
    readonly connectionId: string;
}

function parseStoredCdbRegistration(encoded: string): StoredCdbRegistration | null {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const registration = (value as Record<string, unknown>).registration;
    if (typeof registration !== "object" || registration === null || Array.isArray(registration)) return null;
    const record = registration as Record<string, unknown>;
    return typeof record.registrationId === "string" && typeof record.connectionId === "string"
        ? { registrationId: record.registrationId, connectionId: record.connectionId }
        : null;
}

type GatewayRegistrationLifecycle = "installing" | "active" | "retiring";
type GatewayRegistrationCdbState = "pending" | "active" | "retiring" | "error";

export interface GatewayRegistrationKey {
    readonly principalId: PrincipalId;
    readonly clientId: ClientId;
    readonly subId: SubId;
}

export interface GatewayRegistrationInstall extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly organizationId: TenantId;
    readonly ref: ChardbRef;
    readonly args: RawJson;
    readonly intent: CdbIntent;
    readonly queryHash: string;
    /** Catalog's logical shard identifier. */
    readonly shardId: string;
    /** Physical Cdb Durable Object identifier that emits invalidations. */
    readonly sourceCdbId: string;
    readonly schemaEpoch: number;
    readonly authEpochs: {
        readonly global: number;
        readonly tenant: number;
        readonly principal: number;
    };
    readonly lastCookie?: Cookie;
    readonly nowMs: number;
}

export interface GatewayRegistrationAdvance extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly expectedRunVersion: number;
    readonly lifecycle: GatewayRegistrationLifecycle;
    readonly cdbState: GatewayRegistrationCdbState;
    readonly dirtyVersion: number;
    readonly deliveredVersion: number;
    readonly runToken: string | null;
    readonly lastCookie: Cookie | null;
    readonly retryCount: number;
    readonly retryAt: number | null;
    readonly retryError: string | null;
    readonly nowMs: number;
}

export interface GatewayInitialQueryBegin extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly changeSeq: number;
    readonly nowMs: number;
}

export interface GatewayInitialQueryRun {
    readonly baseline: number;
    readonly runToken: string;
    readonly runVersion: number;
}

export interface GatewayInitialSnapshotSettle extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly runToken: string;
    readonly lastCookie: Cookie;
    readonly nowMs: number;
}

export interface GatewayCurrentRegistration extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    /** Catalog's logical shard identifier. */
    readonly shardId: string;
    /** Physical Cdb Durable Object identifier used for unsubscribe cleanup. */
    readonly sourceCdbId: string | null;
}

export interface GatewayCurrentRegistrationRetire extends GatewayRegistrationKey {
    readonly connectionId: string;
    readonly nowMs: number;
}

interface StoredGatewayCleanupRow {
    readonly principal_id: string;
    readonly client_id: string;
    readonly sub_id: number;
    readonly registration_id: string;
    readonly connection_id: string;
    readonly source_cdb_id: string | null;
    readonly retry_count: number;
}

/**
 * Install a new durable generation. The caller must wrap this helper in the
 * Gateway storage transaction so the old generation and head move atomically.
 */
export function installGatewayRegistration(
    sql: SyncSql,
    input: GatewayRegistrationInstall
): { readonly supersededRegistrationId: string | null } {
    assertGatewayRegistrationInstall(input);
    const previous = sql.one<{ registration_id: string }>(
        `SELECT registration_id FROM _gw_registration_heads
         WHERE principal_id = ? AND client_id = ? AND sub_id = ?`,
        input.principalId,
        input.clientId,
        input.subId
    );
    sql.exec(
        `INSERT INTO _gw_registration_generations
         (registration_id, principal_id, client_id, sub_id, connection_id, organization_id,
          ref, args_json, intent_json, query_hash, shard_id, source_cdb_id, schema_epoch,
          auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
          lifecycle, cdb_state, dirty_version, delivered_version, run_token, run_target_version, run_version,
          last_cookie, retry_count, retry_at, retry_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'installing', 'pending', 0, 0, NULL, NULL, 0, ?, 0, NULL, NULL, ?, ?)`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.organizationId,
        input.ref,
        stableJson(input.args),
        stableJson(input.intent),
        input.queryHash,
        input.shardId,
        input.sourceCdbId,
        input.schemaEpoch,
        input.authEpochs.global,
        input.authEpochs.tenant,
        input.authEpochs.principal,
        input.lastCookie ?? null,
        input.nowMs,
        input.nowMs
    );
    if (previous) {
        sql.exec(
            `UPDATE _gw_registration_generations
             SET lifecycle = 'retiring', cdb_state = 'retiring', run_token = NULL, run_target_version = NULL,
                 run_version = run_version + 1, retry_count = 0, retry_at = ?, retry_error = NULL, updated_at = ?
             WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?`,
            input.nowMs,
            input.nowMs,
            previous.registration_id,
            input.principalId,
            input.clientId,
            input.subId
        );
    }
    sql.exec(
        `INSERT INTO _gw_registration_heads
         (principal_id, client_id, sub_id, registration_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (principal_id, client_id, sub_id)
         DO UPDATE SET registration_id = excluded.registration_id, updated_at = excluded.updated_at`,
        input.principalId,
        input.clientId,
        input.subId,
        input.registrationId,
        input.nowMs
    );
    return { supersededRegistrationId: previous?.registration_id ?? null };
}

/** Advance state only when this registration still owns its logical head and run version. */
export function advanceGatewayRegistration(sql: SyncSql, input: GatewayRegistrationAdvance): boolean {
    assertNonnegativeSafeInteger(input.expectedRunVersion, "expectedRunVersion");
    assertNonnegativeSafeInteger(input.dirtyVersion, "dirtyVersion");
    assertNonnegativeSafeInteger(input.deliveredVersion, "deliveredVersion");
    assertNonnegativeSafeInteger(input.retryCount, "retryCount");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    if (input.retryAt !== null) assertNonnegativeSafeInteger(input.retryAt, "retryAt");
    if (input.deliveredVersion > input.dirtyVersion) {
        throw new TypeError("deliveredVersion cannot exceed dirtyVersion");
    }
    sql.exec(
        `UPDATE _gw_registration_generations
         SET lifecycle = ?, cdb_state = ?, dirty_version = ?, delivered_version = ?,
             run_token = ?, run_target_version = NULL, run_version = run_version + 1, last_cookie = ?,
             retry_count = ?, retry_at = ?, retry_error = ?, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND run_version = ?
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.principal_id = ? AND h.client_id = ? AND h.sub_id = ?
               AND h.registration_id = _gw_registration_generations.registration_id
           )`,
        input.lifecycle,
        input.cdbState,
        input.dirtyVersion,
        input.deliveredVersion,
        input.runToken,
        input.lastCookie,
        input.retryCount,
        input.retryAt,
        input.retryError,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.expectedRunVersion,
        input.principalId,
        input.clientId,
        input.subId
    );
    return sql.changes() === 1;
}

/**
 * Baseline an initial query after Cdb subscription. The caller must wrap this
 * helper in the Gateway storage transaction.
 */
export function beginInitialGatewayQuery(sql: SyncSql, input: GatewayInitialQueryBegin): GatewayInitialQueryRun | null {
    assertGatewayRegistrationIdentity(input);
    assertNonnegativeSafeInteger(input.changeSeq, "changeSeq");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const current = sql.one<{ dirty_version: number; delivered_version: number; run_version: number }>(
        `SELECT g.dirty_version, g.delivered_version, g.run_version
         FROM _gw_registration_generations g
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE g.registration_id = ? AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ?
           AND g.connection_id = ? AND g.lifecycle = 'installing' AND g.cdb_state = 'pending'`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (!current) return null;

    const baseline = Math.max(current.dirty_version, input.changeSeq);
    const runToken = crypto.randomUUID();
    const runVersion = current.run_version + 1;
    sql.exec(
        `UPDATE _gw_registration_generations
         SET cdb_state = 'active', dirty_version = ?, run_target_version = ?,
             run_token = ?, run_version = run_version + 1, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'installing' AND cdb_state = 'pending'
           AND run_version = ?
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        baseline,
        baseline,
        runToken,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        current.run_version
    );
    if (sql.changes() !== 1) return null;
    const stored = sql.one<{
        dirty_version: number;
        delivered_version: number;
        run_token: string;
        run_target_version: number;
        run_version: number;
    }>(
        `SELECT dirty_version, delivered_version, run_token, run_target_version, run_version
         FROM _gw_registration_generations WHERE registration_id = ?`,
        input.registrationId
    );
    if (
        !stored ||
        stored.dirty_version !== baseline ||
        stored.delivered_version !== current.delivered_version ||
        stored.run_token !== runToken ||
        stored.run_target_version !== baseline ||
        stored.run_version !== runVersion
    ) {
        throw gatewayInvalidationInvariant("initial Gateway query baseline was not stored atomically");
    }
    return { baseline, runToken, runVersion };
}

/**
 * Claim delivery only after the caller sent or durably staged the snapshot.
 * The stored run target, not the latest dirty version, is what this run owns.
 */
export function settleInitialGatewaySnapshot(sql: SyncSql, input: GatewayInitialSnapshotSettle): boolean {
    assertGatewayRegistrationIdentity(input);
    if (input.runToken.length === 0) throw new TypeError("runToken must be nonempty");
    if (input.lastCookie.length === 0) throw new TypeError("lastCookie must be nonempty");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    sql.exec(
        `UPDATE _gw_registration_generations
         SET lifecycle = 'active', delivered_version = MAX(delivered_version, run_target_version),
             run_token = NULL, run_target_version = NULL, run_version = run_version + 1,
             last_cookie = ?, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'installing' AND cdb_state = 'active'
           AND run_token = ? AND run_target_version IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        input.lastCookie,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.runToken
    );
    return sql.changes() === 1;
}

/** Return current, internally consistent generations owned by one socket generation. */
export function listCurrentGatewayRegistrationsForConnection(
    sql: SyncSql,
    connectionId: string
): readonly GatewayCurrentRegistration[] {
    if (connectionId.length === 0) throw new TypeError("connectionId must be nonempty");
    return sql
        .all<{
            principal_id: string;
            client_id: string;
            sub_id: number;
            registration_id: string;
            connection_id: string;
            shard_id: string;
            source_cdb_id: string | null;
        }>(
            `SELECT g.principal_id, g.client_id, g.sub_id, g.registration_id,
                    g.connection_id, g.shard_id, g.source_cdb_id
             FROM _gw_registration_generations g
             INNER JOIN _gw_registration_heads h
               ON h.registration_id = g.registration_id
              AND h.principal_id = g.principal_id
              AND h.client_id = g.client_id
              AND h.sub_id = g.sub_id
             WHERE g.connection_id = ?
             ORDER BY g.principal_id, g.client_id, g.sub_id, g.registration_id`,
            connectionId
        )
        .map(row => ({
            principalId: PrincipalId(row.principal_id),
            clientId: ClientId(row.client_id),
            subId: SubId(row.sub_id),
            registrationId: row.registration_id,
            connectionId: row.connection_id,
            shardId: row.shard_id,
            sourceCdbId: row.source_cdb_id,
        }));
}

/**
 * Retire one exact current generation while retaining its cleanup row. The
 * caller must wrap this multi-statement helper in the Gateway transaction.
 */
export function retireCurrentGatewayRegistration(
    sql: SyncSql,
    input: GatewayCurrentRegistrationRetire
): GatewayCurrentRegistration | null {
    assertGatewayRegistrationKey(input);
    if (input.connectionId.length === 0) throw new TypeError("connectionId must be nonempty");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const current = sql.one<{
        registration_id: string;
        shard_id: string;
        source_cdb_id: string | null;
    }>(
        `SELECT g.registration_id, g.shard_id, g.source_cdb_id
         FROM _gw_registration_generations g
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE g.principal_id = ? AND g.client_id = ? AND g.sub_id = ? AND g.connection_id = ?`,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (!current) return null;
    sql.exec(
        `UPDATE _gw_registration_generations
         SET lifecycle = 'retiring', cdb_state = 'retiring', run_token = NULL, run_target_version = NULL,
             run_version = run_version + 1, retry_count = 0, retry_at = ?, retry_error = NULL, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ?`,
        input.nowMs,
        input.nowMs,
        current.registration_id,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (sql.changes() !== 1) {
        throw gatewayInvalidationInvariant("current Gateway registration disappeared during retirement");
    }
    sql.exec(
        `DELETE FROM _gw_registration_heads
         WHERE principal_id = ? AND client_id = ? AND sub_id = ? AND registration_id = ?`,
        input.principalId,
        input.clientId,
        input.subId,
        current.registration_id
    );
    if (sql.changes() !== 1) {
        throw gatewayInvalidationInvariant("current Gateway registration head disappeared during retirement");
    }
    return {
        principalId: input.principalId,
        clientId: input.clientId,
        subId: input.subId,
        registrationId: current.registration_id,
        connectionId: input.connectionId,
        shardId: current.shard_id,
        sourceCdbId: current.source_cdb_id,
    };
}

/**
 * Retire every internally consistent current generation owned by one socket
 * generation. The caller must wrap this helper in the Gateway transaction.
 */
export function retireCurrentGatewayRegistrationsForConnection(
    sql: SyncSql,
    connectionId: string,
    nowMs: number
): readonly GatewayCurrentRegistration[] {
    assertNonnegativeSafeInteger(nowMs, "nowMs");
    const registrations = listCurrentGatewayRegistrationsForConnection(sql, connectionId);
    for (const registration of registrations) {
        const retired = retireCurrentGatewayRegistration(sql, { ...registration, nowMs });
        if (!retired || retired.registrationId !== registration.registrationId) {
            throw gatewayInvalidationInvariant("current Gateway registration changed during connection retirement");
        }
    }
    return registrations;
}

/**
 * Remove a current logical head while retaining its generation for Cdb cleanup.
 * The caller must wrap the head deletion and generation update in one transaction.
 */
export function retireGatewayRegistration(
    sql: SyncSql,
    key: GatewayRegistrationKey,
    registrationId: string,
    nowMs: number
): boolean {
    assertNonnegativeSafeInteger(nowMs, "nowMs");
    sql.exec(
        `DELETE FROM _gw_registration_heads
         WHERE principal_id = ? AND client_id = ? AND sub_id = ? AND registration_id = ?`,
        key.principalId,
        key.clientId,
        key.subId,
        registrationId
    );
    const removedHead = sql.changes() === 1;
    if (!removedHead) return false;
    sql.exec(
        `UPDATE _gw_registration_generations
         SET lifecycle = 'retiring', cdb_state = 'retiring', run_token = NULL, run_target_version = NULL,
             run_version = run_version + 1, retry_count = 0, retry_at = ?, retry_error = NULL, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?`,
        nowMs,
        nowMs,
        registrationId,
        key.principalId,
        key.clientId,
        key.subId
    );
    return true;
}

/** Delete one retired cleanup row without touching any logical head. */
export function cleanupGatewayRegistration(sql: SyncSql, key: GatewayRegistrationKey, registrationId: string): boolean {
    sql.exec(
        `DELETE FROM _gw_registration_generations
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND lifecycle = 'retiring'
           AND NOT EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
           )`,
        registrationId,
        key.principalId,
        key.clientId,
        key.subId
    );
    return sql.changes() === 1;
}

function assertGatewayRegistrationInstall(input: GatewayRegistrationInstall): void {
    for (const [name, value] of [
        ["subId", input.subId],
        ["schemaEpoch", input.schemaEpoch],
        ["authEpochs.global", input.authEpochs.global],
        ["authEpochs.tenant", input.authEpochs.tenant],
        ["authEpochs.principal", input.authEpochs.principal],
        ["nowMs", input.nowMs],
    ] as const) {
        assertNonnegativeSafeInteger(value, name);
    }
    for (const [name, value] of [
        ["registrationId", input.registrationId],
        ["connectionId", input.connectionId],
        ["organizationId", input.organizationId],
        ["ref", input.ref],
        ["queryHash", input.queryHash],
        ["shardId", input.shardId],
        ["sourceCdbId", input.sourceCdbId],
    ] as const) {
        if (value.length === 0) throw new TypeError(`${name} must be nonempty`);
    }
}

function assertGatewayRegistrationIdentity(input: {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly principalId: PrincipalId;
    readonly clientId: ClientId;
    readonly subId: SubId;
}): void {
    assertGatewayRegistrationKey(input);
    for (const [name, value] of [
        ["registrationId", input.registrationId],
        ["connectionId", input.connectionId],
    ] as const) {
        if (value.length === 0) throw new TypeError(`${name} must be nonempty`);
    }
}

function assertGatewayRegistrationKey(input: GatewayRegistrationKey): void {
    assertNonnegativeSafeInteger(input.subId, "subId");
    for (const [name, value] of [
        ["principalId", input.principalId],
        ["clientId", input.clientId],
    ] as const) {
        if (value.length === 0) throw new TypeError(`${name} must be nonempty`);
    }
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
}

function ensureGatewayRegistrationColumns(sql: SyncSql): void {
    const columns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info('_gw_registration_generations')").map(column => column.name)
    );
    if (!columns.has("source_cdb_id")) {
        // Existing generations predate physical Cdb identity. A null source is
        // intentionally stale until that logical subscription is replaced.
        sql.exec("ALTER TABLE _gw_registration_generations ADD COLUMN source_cdb_id TEXT");
    }
    if (!columns.has("run_target_version")) {
        sql.exec(
            `ALTER TABLE _gw_registration_generations
             ADD COLUMN run_target_version INTEGER
             CHECK (run_target_version IS NULL OR (run_target_version >= 0 AND run_target_version <= dirty_version))`
        );
    }
}

function gatewayInvalidationInvariant(message: string, cause?: unknown): CdbError {
    return new CdbError({ code: "CDB_INVARIANT", message, ...(cause === undefined ? {} : { cause }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedIdentity(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        value.trim() === value &&
        !hasAsciiControlCharacter(value)
    );
}

function validateGatewayInvalidationRequest(value: unknown, expectedGatewayId: string): GatewayInvalidationRequest {
    if (!isRecord(value) || !hasExactKeys(value, ["sourceCdbId", "gatewayId", "invalidations"])) {
        throw gatewayInvalidationInvariant("Gateway invalidation request has an unexpected shape");
    }
    if (
        !isBoundedIdentity(value.sourceCdbId) ||
        !isBoundedIdentity(value.gatewayId) ||
        value.gatewayId !== expectedGatewayId ||
        !Array.isArray(value.invalidations) ||
        value.invalidations.length === 0 ||
        value.invalidations.length > MAX_GATEWAY_INVALIDATIONS_PER_REQUEST
    ) {
        throw gatewayInvalidationInvariant("Gateway invalidation request is malformed or misrouted");
    }

    const seen = new Set<string>();
    for (const item of value.invalidations) {
        if (!isRecord(item) || !hasExactKeys(item, ["subscription", "changeSeq"])) {
            throw gatewayInvalidationInvariant("Gateway invalidation item has an unexpected shape");
        }
        const subscription = item.subscription;
        if (
            !isRecord(subscription) ||
            !hasExactKeys(subscription, ["gatewayId", "registrationId", "connectionId", "clientId", "subId"])
        ) {
            throw gatewayInvalidationInvariant("Gateway invalidation subscription has an unexpected shape");
        }
        if (
            subscription.gatewayId !== expectedGatewayId ||
            !isBoundedIdentity(subscription.registrationId) ||
            !isBoundedIdentity(subscription.connectionId) ||
            !isBoundedIdentity(subscription.clientId) ||
            !Number.isSafeInteger(subscription.subId) ||
            (subscription.subId as number) < 0 ||
            !Number.isSafeInteger(item.changeSeq) ||
            (item.changeSeq as number) <= 0 ||
            seen.has(subscription.registrationId)
        ) {
            throw gatewayInvalidationInvariant("Gateway invalidation identity, sequence, or uniqueness is invalid");
        }
        seen.add(subscription.registrationId);
    }
    return value as unknown as GatewayInvalidationRequest;
}

export interface GatewayJwtVerificationRequest {
    readonly config: GatewayJwtConfig;
    readonly authOrigin: string;
    readonly catalog: CatalogJwksRpc;
    readonly jwt: string;
    readonly connectionId: string;
    readonly clientId: ClientId;
    readonly lastCookie?: Cookie;
    readonly presenceKeys?: readonly string[];
}

/** Verify and project a JWT into the only attachment shape trusted by Gateway handlers. */
export async function verifyGatewayJwt(request: GatewayJwtVerificationRequest): Promise<VerifiedGwAttachment> {
    const issuer = request.config.issuer ?? request.authOrigin;
    const audience = request.config.audience ?? request.authOrigin;
    const jwksUrl =
        request.config.jwksUrl ??
        new URL(
            `${request.config.authBasePath.replace(/\/$/, "")}${request.config.jwksPath}`,
            `${request.authOrigin}/`
        ).toString();
    const claims = await verifyJwt(request.jwt, {
        resolver: createCatalogJwksResolver({ catalog: request.catalog, jwksUrl }),
        issuer,
        audience,
        algorithms: request.config.algorithms,
        ...(request.config.clockToleranceSeconds !== undefined
            ? { clockToleranceSeconds: request.config.clockToleranceSeconds }
            : {}),
    });
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") {
        throw new CdbError({ code: "CDB_FORBIDDEN", message: "verified JWT is missing subject or expiry" });
    }
    return {
        kind: "verified",
        connectionId: request.connectionId,
        authOrigin: request.authOrigin,
        clientId: request.clientId,
        ...(request.lastCookie !== undefined ? { lastCookie: request.lastCookie } : {}),
        ...(request.presenceKeys !== undefined ? { presenceKeys: request.presenceKeys } : {}),
        principalId: PrincipalId(claims.sub),
        jwtExp: claims.exp,
        ...(typeof claims.nbf === "number" ? { jwtNbf: claims.nbf } : {}),
    };
}

function isVerifiedAttachment(attachment: GwAttachment | null): attachment is VerifiedGwAttachment {
    return attachment?.kind === "verified";
}

/** Recheck time validity before every protected operation. */
export function isCurrentVerifiedAttachment(
    attachment: VerifiedGwAttachment,
    nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
    if (attachment.jwtExp <= nowSeconds) return false;
    if (attachment.jwtNbf !== undefined && attachment.jwtNbf > nowSeconds) return false;
    return true;
}

/**
 * Project the verified subject into the mutation dispatcher input. Catalog
 * still decides organization membership and roles for each declared mutation.
 */
export function trustedMutationAuthFromAttachment(attachment: VerifiedGwAttachment): TrustedMutationAuth {
    return { principalId: attachment.principalId };
}

/**
 * Complete mutation dispatch from an already-verified auth boundary. Ref
 * routing stays local to the configured Gateway isolate; Catalog and Cdb are
 * the only RPC hops. Every rejected or thrown boundary settles as structured
 * wire data so no client mutation is stranded.
 */
export async function dispatchTrustedMutation(
    deps: TrustedMutationDispatchDeps,
    request: TrustedMutationDispatchRequest
): Promise<CdbMutationResponse> {
    let routed: MutationRouteResponse;
    try {
        routed = deps.routeMutation({ ref: request.ref, args: request.args });
    } catch {
        return mutationFailure("CDB_INVARIANT", "local mutation routing failed");
    }
    if (!routed.ok) return routed;
    if (routed.authority !== "organization") {
        return mutationFailure("CDB_AUTH_NOT_BOUND", "mutation has no declared organization authority");
    }
    if (!routed.partitionKey) {
        return mutationFailure("CDB_INVALID_ARGS", "organization mutation has no organization partition key");
    }

    let authority: Awaited<ReturnType<CatalogOrganizationAuthorityRpc["resolveOrganizationAuthority"]>>;
    try {
        authority = await deps.catalog.resolveOrganizationAuthority({
            principalId: request.principalId,
            organizationId: TenantId(routed.partitionKey),
        });
    } catch {
        return mutationFailure("CDB_CATALOG_UNAVAILABLE", "Catalog organization authority RPC failed");
    }
    const projected = projectOrganizationMutationAuth(authority, {
        principalId: request.principalId,
        organizationId: TenantId(routed.partitionKey),
    });
    if (!projected.ok) return mutationFailure(projected.code, projected.message);
    // This Catalog read is the authorization linearization point. A later
    // revocation blocks the next dispatch but does not cancel this in-flight
    // shard call; Cdb does not revalidate membership epochs yet.

    let location: Awaited<ReturnType<CatalogMutationRpc["route"]>>;
    try {
        location = await deps.catalog.route(routed.vshard);
    } catch {
        return mutationFailure("CDB_CATALOG_UNAVAILABLE", "Catalog routing RPC failed");
    }

    try {
        const response = await deps.cdb(location.shardId).mutate({
            principalId: request.principalId,
            mutId: request.mutId,
            ref: request.ref,
            args: routed.args,
            auth: projected.auth,
            schemaEpoch: location.schemaEpoch,
        });
        return projectCdbMutationResponse(response);
    } catch {
        return mutationFailure("CDB_SHARD_UNAVAILABLE", "Cdb mutation RPC failed");
    }
}

/** Resolve the physical shards needed for one server-derived query intent. */
export async function shardsForIntent(catalog: CatalogRoutingRpc, intent: CdbIntent): Promise<string[]> {
    const shards = new Set<string>();
    const pk = intent.partitionKey;
    if (pk && pk.values.length > 0 && intent.joinShape !== "cross-partition") {
        for (const value of pk.values) {
            const vshard = vshardOf([toScalar(value)]) as Vshard;
            const route = await catalog.route(vshard);
            shards.add(route.shardId);
        }
        return [...shards];
    }
    if (intent.joinShape === "reference") {
        const route = await catalog.route(0 as Vshard);
        return [route.shardId];
    }
    return [...(await catalog.listShardIds())];
}

export class Gateway extends DurableObject<GatewayEnv> {
    private bootstrapped = false;
    private alarmScheduler: Promise<void> = Promise.resolve();
    private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly pendingPatches = new Map<ClientId, RowPatch[]>();
    private readonly authRefreshBarriers = new Map<string, Promise<boolean>>();
    private readonly activeOperations = new Map<string, Set<Promise<void>>>();
    private readonly pendingSubscriptions = new Map<string, PendingSubscription>();

    constructor(state: DurableObjectState, env: GatewayEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    protected runtimeManifest(): ChardbManifest {
        return emptyManifest();
    }

    protected jwtConfig(): GatewayJwtConfig | null {
        return null;
    }

    /** Resolve the registered mutation inside this Gateway isolate. */
    routeMutation(request: MutationRouteRequest): MutationRouteResponse {
        return resolveMutationRoute(this.runtimeManifest(), request, vshardOf);
    }

    /** Resolve query routing from the server manifest, never client hints. */
    routeQuery(request: { readonly ref: string; readonly args: RawJson }): Promise<QueryRouteResponse> {
        return resolveQueryRoute(this.runtimeManifest(), request);
    }

    protected gatewayNowMs(): number {
        return Date.now();
    }

    /** Serialize every Gateway alarm write and preserve any earlier durable deadline. */
    protected scheduleGatewayAlarm(requestedAt: number): Promise<void> {
        assertNonnegativeSafeInteger(requestedAt, "requestedAt");
        const scheduled = this.alarmScheduler.then(async () => {
            const current = await this.ctx.storage.getAlarm();
            if (current === null || requestedAt < current) {
                await this.ctx.storage.setAlarm(requestedAt);
            }
        });
        this.alarmScheduler = scheduled.catch(() => {});
        return scheduled;
    }

    private cleanupRetryDelayMs(attempts: number): number {
        const exponent = Math.max(0, Math.min(attempts - 1, GATEWAY_CLEANUP_MAX_RETRY_COUNT - 1));
        return Math.min(GATEWAY_CLEANUP_MAX_RETRY_MS, GATEWAY_CLEANUP_BASE_RETRY_MS * 2 ** exponent);
    }

    private dueGatewayCleanupRows(nowMs: number): readonly StoredGatewayCleanupRow[] {
        return adaptSqlStorage(this.ctx.storage.sql).all<StoredGatewayCleanupRow>(
            `SELECT g.principal_id, g.client_id, g.sub_id, g.registration_id,
                    g.connection_id, g.source_cdb_id, g.retry_count
             FROM _gw_registration_generations g
             WHERE g.lifecycle = 'retiring' AND g.cdb_state = 'retiring'
               AND g.retry_at IS NOT NULL AND g.retry_at <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM _gw_registration_heads h WHERE h.registration_id = g.registration_id
               )
             ORDER BY g.retry_at, g.registration_id
             LIMIT ?`,
            nowMs,
            GATEWAY_CLEANUP_BATCH_SIZE
        );
    }

    private completeGatewayCleanup(row: StoredGatewayCleanupRow): void {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `DELETE FROM _gw_registration_generations
                 WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
                   AND connection_id = ? AND source_cdb_id = ?
                   AND lifecycle = 'retiring' AND cdb_state = 'retiring'
                   AND NOT EXISTS (
                     SELECT 1 FROM _gw_registration_heads h
                     WHERE h.registration_id = _gw_registration_generations.registration_id
                   )`,
                row.registration_id,
                row.principal_id,
                row.client_id,
                row.sub_id,
                row.connection_id,
                row.source_cdb_id
            );
            if (sql.changes() === 1) return;
            if (
                sql.one<{ registration_id: string }>(
                    "SELECT registration_id FROM _gw_registration_generations WHERE registration_id = ?",
                    row.registration_id
                )
            ) {
                throw gatewayInvalidationInvariant("retired Gateway generation changed before cleanup could complete");
            }
        });
    }

    private recordGatewayCleanupFailure(row: StoredGatewayCleanupRow, nowMs: number, error: unknown): void {
        const attempts = Math.min(row.retry_count + 1, GATEWAY_CLEANUP_MAX_RETRY_COUNT);
        const message = (error instanceof Error ? error.message : String(error)).slice(
            0,
            GATEWAY_CLEANUP_MAX_ERROR_LENGTH
        );
        const retryAt = nowMs + this.cleanupRetryDelayMs(attempts);
        this.ctx.storage.transactionSync(() => {
            adaptSqlStorage(this.ctx.storage.sql).exec(
                `UPDATE _gw_registration_generations
                 SET retry_count = ?, retry_at = ?, retry_error = ?, updated_at = ?
                 WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
                   AND connection_id = ?
                   AND lifecycle = 'retiring' AND cdb_state = 'retiring'
                   AND NOT EXISTS (
                     SELECT 1 FROM _gw_registration_heads h
                     WHERE h.registration_id = _gw_registration_generations.registration_id
                   )`,
                attempts,
                retryAt,
                message,
                nowMs,
                row.registration_id,
                row.principal_id,
                row.client_id,
                row.sub_id,
                row.connection_id
            );
        });
    }

    private async cleanupGatewayGeneration(row: StoredGatewayCleanupRow, nowMs: number): Promise<void> {
        try {
            if (!row.source_cdb_id) throw new Error("retired Gateway generation has no physical Cdb object ID");
            const id = this.env.CDB_SHARD.idFromString(row.source_cdb_id);
            const cdb = this.env.CDB_SHARD.get(id) as unknown as CdbSubscriptionRpc;
            const outcome: unknown = await cdb.unsubscribe({
                gatewayId: this.ctx.id.toString(),
                registrationId: row.registration_id,
                connectionId: row.connection_id,
                clientId: ClientId(row.client_id),
                subId: SubId(row.sub_id),
            });
            if (outcome !== undefined) throw new Error("Cdb returned a malformed unsubscribe outcome");
            this.completeGatewayCleanup(row);
        } catch (error) {
            this.recordGatewayCleanupFailure(row, nowMs, error);
        }
    }

    private earliestGatewayCleanupAt(): number | null {
        return (
            adaptSqlStorage(this.ctx.storage.sql).one<{ retry_at: number | null }>(
                `SELECT MIN(retry_at) AS retry_at
                 FROM _gw_registration_generations g
                 WHERE lifecycle = 'retiring' AND cdb_state = 'retiring' AND retry_at IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM _gw_registration_heads h WHERE h.registration_id = g.registration_id
                   )`
            )?.retry_at ?? null
        );
    }

    private async scheduleGatewayCleanup(nowMs: number): Promise<void> {
        const retryAt = this.earliestGatewayCleanupAt();
        if (retryAt === null) return;
        await this.scheduleGatewayAlarm(Math.max(nowMs + 1, retryAt));
    }

    private async maintainGatewayCleanup(): Promise<void> {
        const nowMs = this.gatewayNowMs();
        const rows = this.dueGatewayCleanupRows(nowMs);
        await Promise.all(rows.map(row => this.cleanupGatewayGeneration(row, nowMs)));
        await this.scheduleGatewayCleanup(nowMs);
    }

    private async bootstrap(): Promise<void> {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("PRAGMA foreign_keys = ON");
        for (const stmt of GW_DDL.split(";")
            .map(s => s.trim())
            .filter(Boolean))
            sql.exec(stmt);
        ensureGatewayRegistrationColumns(sql);
        sql.exec(
            `UPDATE _gw_registration_generations
             SET retry_at = updated_at
             WHERE lifecycle = 'retiring' AND cdb_state = 'retiring' AND retry_at IS NULL`
        );
        await this.scheduleGatewayCleanup(this.gatewayNowMs());
        this.bootstrapped = true;
    }

    override async alarm(): Promise<void> {
        await this.maintainGatewayCleanup();
    }

    /**
     * Accept Cdb invalidations only for the exact generation that still owns
     * its logical head. Dirty versions remain durable for the later runner.
     */
    async invalidateSubscriptions(request: GatewayInvalidationRequest): Promise<GatewayInvalidationResponse> {
        const gatewayId = this.ctx.id.toString();
        const validated = validateGatewayInvalidationRequest(request, gatewayId);
        const updatedAt = this.gatewayNowMs();
        const acknowledgements = this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            return validated.invalidations.map(({ subscription, changeSeq }): GatewayInvalidationAck => {
                const stored = sql.one<{
                    registration_id: string;
                    connection_id: string;
                    client_id: string;
                    sub_id: number;
                    source_cdb_id: string | null;
                    lifecycle: GatewayRegistrationLifecycle;
                    cdb_state: GatewayRegistrationCdbState;
                    head_registration_id: string | null;
                }>(
                    `SELECT g.registration_id, g.connection_id, g.client_id, g.sub_id,
                            g.source_cdb_id, g.lifecycle, g.cdb_state,
                            h.registration_id AS head_registration_id
                     FROM _gw_registration_generations AS g
                     LEFT JOIN _gw_registration_heads AS h
                       ON h.principal_id = g.principal_id
                      AND h.client_id = g.client_id
                      AND h.sub_id = g.sub_id
                     WHERE g.registration_id = ?`,
                    subscription.registrationId
                );
                if (
                    !stored ||
                    stored.head_registration_id !== stored.registration_id ||
                    stored.lifecycle === "retiring" ||
                    stored.cdb_state === "retiring"
                ) {
                    return {
                        registrationId: subscription.registrationId,
                        changeSeq,
                        status: "stale",
                    };
                }
                if (
                    stored.source_cdb_id !== validated.sourceCdbId ||
                    stored.connection_id !== subscription.connectionId ||
                    stored.client_id !== subscription.clientId ||
                    stored.sub_id !== subscription.subId
                ) {
                    throw gatewayInvalidationInvariant(
                        "current Gateway registration conflicts with its Cdb invalidation identity"
                    );
                }
                sql.exec(
                    `UPDATE _gw_registration_generations
                     SET dirty_version = MAX(dirty_version, ?), updated_at = ?
                     WHERE registration_id = ? AND connection_id = ? AND client_id = ? AND sub_id = ?
                       AND source_cdb_id = ?
                       AND lifecycle <> 'retiring' AND cdb_state <> 'retiring'
                       AND EXISTS (
                         SELECT 1 FROM _gw_registration_heads h
                         WHERE h.registration_id = _gw_registration_generations.registration_id
                           AND h.principal_id = _gw_registration_generations.principal_id
                           AND h.client_id = _gw_registration_generations.client_id
                           AND h.sub_id = _gw_registration_generations.sub_id
                       )`,
                    changeSeq,
                    updatedAt,
                    subscription.registrationId,
                    subscription.connectionId,
                    subscription.clientId,
                    subscription.subId,
                    validated.sourceCdbId
                );
                if (sql.changes() !== 1) {
                    throw gatewayInvalidationInvariant(
                        "current Gateway registration changed while accepting a Cdb invalidation"
                    );
                }
                return {
                    registrationId: subscription.registrationId,
                    changeSeq,
                    status: "accepted",
                };
            });
        });

        if (acknowledgements.some(acknowledgement => acknowledgement.status === "accepted")) {
            try {
                await this.scheduleGatewayAlarm(updatedAt + 1);
            } catch (error) {
                throw new CdbError({
                    code: "CDB_SHARD_UNAVAILABLE",
                    message: "Gateway could not durably schedule invalidation work",
                    cause: error,
                });
            }
        }
        return { gatewayId, acknowledgements };
    }

    /**
     * Upgrade an HTTP request to a hibernated WebSocket. Returns a Response.
     */
    override async fetch(request: Request): Promise<Response> {
        const upgrade = request.headers.get("Upgrade");
        if (upgrade !== "websocket") {
            return new Response("expected websocket", { status: 426 });
        }
        const pair = new WebSocketPair();
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
            kind: "pending",
            connectionId: crypto.randomUUID(),
            authOrigin: new URL(request.url).origin,
            routedClientId: routedClientIdFromUrl(request.url),
        } satisfies PendingGwAttachment);
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
        if (typeof raw !== "string") return;
        let msg: WireMessage;
        try {
            msg = decodeWire(raw);
        } catch {
            this.sendError(ws, "CDB_UNSUPPORTED_FEATURE");
            return;
        }
        switch ((msg as Up).t) {
            case "hello":
                void this.onHello(ws, msg as Extract<Up, { t: "hello" }>);
                break;
            case "updateAuth":
                this.onUpdateAuth(ws, msg as Extract<Up, { t: "updateAuth" }>);
                break;
            case "sub":
                void this.onSub(ws, msg as Extract<Up, { t: "sub" }>);
                break;
            case "unsub":
                this.onUnsub(ws, msg as Extract<Up, { t: "unsub" }>);
                break;
            case "mut":
                this.onMut(ws, msg as Extract<Up, { t: "mut" }>);
                break;
            case "presencePub":
                this.onPresencePub(ws, msg as Extract<Up, { t: "presencePub" }>);
                break;
            case "presenceSub":
                this.onPresenceSub(ws, msg as Extract<Up, { t: "presenceSub" }>);
                break;
            case "ping":
                // Hibernation auto-replies; nothing to do.
                break;
            default:
                this.sendError(ws, "CDB_UNSUPPORTED_FEATURE");
        }
    }

    override webSocketClose(ws: WebSocket): void {
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        if (attachment) {
            this.authRefreshBarriers.delete(attachment.connectionId);
            this.activeOperations.delete(attachment.connectionId);
            for (const pending of this.pendingSubscriptions.values()) {
                if (pending.connectionId === attachment.connectionId) pending.cancelled = true;
            }
        }
        // Public initial-query attempts are in memory only. The isolated
        // registration helpers retain their own `_gw_subs` state.
    }

    private async onHello(ws: WebSocket, msg: Extract<Up, { t: "hello" }>): Promise<void> {
        const pending = ws.deserializeAttachment() as GwAttachment | null;
        if (pending?.kind !== "pending" || pending.routedClientId === null || msg.clientId !== pending.routedClientId) {
            this.rejectAuth(ws, "CDB_FORBIDDEN");
            return;
        }
        const mismatch = checkProtocolV(msg.protocolV);
        if (mismatch) {
            this.send(ws, mismatch);
            ws.close(1002, `unsupported chardb protocol ${msg.protocolV}`);
            return;
        }
        const attachment = await this.verifyAttachment(ws, {
            authOrigin: pending.authOrigin,
            connectionId: pending.connectionId,
            clientId: pending.routedClientId,
            jwt: msg.jwt,
            ...(msg.resumeFromCookie ? { lastCookie: msg.resumeFromCookie } : {}),
        });
        if (!attachment) return;
        const baseCookie = Cookie(`${pending.routedClientId}:0`);
        ws.serializeAttachment({
            ...attachment,
            lastCookie: msg.resumeFromCookie ?? baseCookie,
        } satisfies VerifiedGwAttachment);
        const welcome: Down = {
            t: "welcome",
            protocolV: PROTOCOL_V,
            baseCookie,
            region: "WNAM",
            ...(msg.resumeFromCookie ? { resumedFromCookie: msg.resumeFromCookie } : {}),
        };
        this.send(ws, welcome);
    }

    private onUpdateAuth(ws: WebSocket, msg: Extract<Up, { t: "updateAuth" }>): void {
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(current)) {
            this.rejectAuth(ws, "CDB_FORBIDDEN");
            return;
        }
        const connectionId = current.connectionId;
        const previous = this.authRefreshBarriers.get(connectionId) ?? Promise.resolve(true);
        const barrier = previous
            .then(previousSucceeded => (previousSucceeded ? this.performUpdateAuth(ws, connectionId, msg) : false))
            .catch(() => {
                this.rejectAuth(ws, "CDB_CATALOG_UNAVAILABLE");
                return false;
            });
        this.authRefreshBarriers.set(connectionId, barrier);
        void barrier.then(succeeded => {
            if (succeeded && this.authRefreshBarriers.get(connectionId) === barrier) {
                this.authRefreshBarriers.delete(connectionId);
            }
        });
    }

    private async performUpdateAuth(
        ws: WebSocket,
        connectionId: string,
        msg: Extract<Up, { t: "updateAuth" }>
    ): Promise<boolean> {
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(current) || current.connectionId !== connectionId) {
            this.rejectAuth(ws, "CDB_FORBIDDEN");
            return false;
        }
        const attachment = await this.verifyAttachment(ws, {
            authOrigin: current.authOrigin,
            connectionId,
            clientId: current.clientId,
            jwt: msg.jwt,
            ...(current.lastCookie !== undefined ? { lastCookie: current.lastCookie } : {}),
            ...(current.presenceKeys !== undefined ? { presenceKeys: current.presenceKeys } : {}),
        });
        if (!attachment) return false;

        const active = this.activeOperations.get(connectionId);
        if (active && active.size > 0) await Promise.allSettled([...active]);

        const latest = ws.deserializeAttachment() as GwAttachment | null;
        if (
            !isVerifiedAttachment(latest) ||
            latest.connectionId !== connectionId ||
            latest.clientId !== current.clientId
        ) {
            this.rejectAuth(ws, "CDB_FORBIDDEN");
            return false;
        }
        ws.serializeAttachment({
            ...attachment,
            ...(latest.lastCookie !== undefined ? { lastCookie: latest.lastCookie } : {}),
            ...(latest.presenceKeys !== undefined ? { presenceKeys: latest.presenceKeys } : {}),
            ...(latest.snapshotSubIds !== undefined ? { snapshotSubIds: latest.snapshotSubIds } : {}),
        } satisfies VerifiedGwAttachment);
        this.pendingPatches.delete(latest.clientId);
        try {
            const { subIds: persistedSubIds, rpcFailed } = await this.invalidateClientSubscriptions(latest.clientId);
            if (rpcFailed) {
                this.rejectConnection(ws, "CDB_SHARD_UNAVAILABLE", 1011, "subscription invalidation failed");
                return false;
            }
            const refreshed = ws.deserializeAttachment() as GwAttachment | null;
            if (!isVerifiedAttachment(refreshed) || refreshed.connectionId !== connectionId) {
                this.rejectAuth(ws, "CDB_FORBIDDEN");
                return false;
            }
            const subIds = [...new Set([...(refreshed.snapshotSubIds ?? []), ...persistedSubIds])]
                .sort((left, right) => left - right)
                .map(SubId);
            ws.serializeAttachment({ ...refreshed, snapshotSubIds: [] } satisfies VerifiedGwAttachment);
            this.send(ws, { t: "mustRefetch", subIds, reason: "authChanged" });
            return true;
        } catch {
            this.rejectConnection(ws, "CDB_SHARD_UNAVAILABLE", 1011, "subscription invalidation failed");
            return false;
        }
    }

    private async verifyAttachment(
        ws: WebSocket,
        request: Omit<GatewayJwtVerificationRequest, "config" | "catalog">
    ): Promise<VerifiedGwAttachment | null> {
        const config = this.jwtConfig();
        if (!config) {
            this.rejectAuth(ws, "CDB_AUTH_NOT_BOUND");
            return null;
        }
        try {
            return await verifyGatewayJwt({
                ...request,
                config,
                catalog: this.catalog() as unknown as CatalogJwksRpc,
            });
        } catch (error) {
            this.rejectAuth(ws, error instanceof CdbError ? error.code : "CDB_CATALOG_UNAVAILABLE");
            return null;
        }
    }

    private rejectAuth(ws: WebSocket, code: import("../../errors.ts").CdbErrorCode): void {
        this.rejectConnection(ws, code, 1008, code);
    }

    private rejectConnection(
        ws: WebSocket,
        code: import("../../errors.ts").CdbErrorCode,
        closeCode: number,
        reason: string
    ): void {
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (current) {
            ws.serializeAttachment({
                kind: "rejected",
                connectionId: current.connectionId,
                authOrigin: current.authOrigin,
            } satisfies RejectedGwAttachment);
        }
        this.sendError(ws, code);
        ws.close(closeCode, reason);
    }

    private onSub(ws: WebSocket, msg: Extract<Up, { t: "sub" }>): void {
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(attachment) || !isCurrentVerifiedAttachment(attachment)) {
            this.sendError(ws, "CDB_FORBIDDEN", msg.subId);
            return;
        }
        const operationKey = `${attachment.connectionId}:${msg.subId}`;
        const previous = this.pendingSubscriptions.get(operationKey);
        const deliveredSubIds = new Set(attachment.snapshotSubIds ?? []);
        if (!previous && !deliveredSubIds.has(msg.subId)) {
            const reservedSubIds = new Set(
                [...this.pendingSubscriptions.values()]
                    .filter(
                        pending =>
                            pending.connectionId === attachment.connectionId &&
                            !pending.cancelled &&
                            !deliveredSubIds.has(pending.subId)
                    )
                    .map(pending => pending.subId)
            );
            if (deliveredSubIds.size + reservedSubIds.size >= MAX_INITIAL_SNAPSHOTS_PER_CONNECTION) {
                this.sendError(ws, "CDB_RATE_LIMITED", msg.subId);
                return;
            }
        }
        if (previous) previous.cancelled = true;
        const pending: PendingSubscription = {
            connectionId: attachment.connectionId,
            subId: msg.subId,
            cancelled: false,
            task: Promise.resolve(),
        };
        this.pendingSubscriptions.set(operationKey, pending);
        const barrier = this.authRefreshBarriers.get(attachment.connectionId);
        if (barrier || previous) {
            void (previous?.task.catch(() => {}) ?? Promise.resolve())
                .then(() => barrier ?? true)
                .then(succeeded => {
                    if (succeeded && !pending.cancelled) {
                        this.admitSubscription(ws, msg, pending, operationKey);
                    } else if (this.pendingSubscriptions.get(operationKey) === pending) {
                        this.pendingSubscriptions.delete(operationKey);
                    }
                });
            return;
        }
        this.admitSubscription(ws, msg, pending, operationKey);
    }

    private admitSubscription(
        ws: WebSocket,
        msg: Extract<Up, { t: "sub" }>,
        pending: PendingSubscription,
        operationKey: string
    ): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(att) || !isCurrentVerifiedAttachment(att)) {
            if (!pending.cancelled) this.sendError(ws, "CDB_FORBIDDEN", msg.subId);
            if (this.pendingSubscriptions.get(operationKey) === pending) {
                this.pendingSubscriptions.delete(operationKey);
            }
            return;
        }
        const task = this.settleSubscription(ws, att, msg, pending);
        pending.task = task;
        let active = this.activeOperations.get(att.connectionId);
        if (!active) {
            active = new Set();
            this.activeOperations.set(att.connectionId, active);
        }
        active.add(task);
        void task
            .catch(() => this.sendError(ws, "CDB_INVARIANT", msg.subId))
            .finally(() => {
                if (this.pendingSubscriptions.get(operationKey) === pending) {
                    this.pendingSubscriptions.delete(operationKey);
                }
                active?.delete(task);
                if (active?.size === 0) this.activeOperations.delete(att.connectionId);
            });
    }

    private async settleSubscription(
        ws: WebSocket,
        att: VerifiedGwAttachment,
        msg: Extract<Up, { t: "sub" }>,
        pending: PendingSubscription
    ): Promise<void> {
        const routed = await this.routeQuery({ ref: msg.ref, args: msg.args });
        if (pending.cancelled) return;
        if (!routed.ok) {
            this.sendError(ws, routed.error.code, msg.subId);
            return;
        }
        if (routed.authority !== "organization") {
            this.sendError(ws, "CDB_AUTH_NOT_BOUND", msg.subId);
            return;
        }
        const organizationId = routed.partitionKey;
        const partition = routed.intent.partitionKey;
        if (
            !organizationId ||
            !partition ||
            partition.values.length === 0 ||
            routed.intent.joinShape === "cross-partition" ||
            !partition.values.every(value => typeof value === "string" && value === organizationId)
        ) {
            this.sendError(ws, "CDB_CROSS_PARTITION", msg.subId);
            return;
        }

        const vshards = new Set(partition.values.map(value => Number(vshardOf([value as string]))));
        if (vshards.size !== 1) {
            this.sendError(ws, "CDB_CROSS_PARTITION", msg.subId);
            return;
        }
        const vshard = [...vshards][0];
        if (vshard === undefined) {
            this.sendError(ws, "CDB_CROSS_PARTITION", msg.subId);
            return;
        }

        const catalog = this.catalog() as CatalogRoutingRpc & CatalogOrganizationAuthorityRpc;
        let authority: Awaited<ReturnType<CatalogOrganizationAuthorityRpc["resolveOrganizationAuthority"]>>;
        try {
            authority = await catalog.resolveOrganizationAuthority({
                principalId: att.principalId,
                organizationId: TenantId(organizationId),
            });
        } catch {
            if (pending.cancelled) return;
            this.sendError(ws, "CDB_CATALOG_UNAVAILABLE", msg.subId);
            return;
        }
        if (pending.cancelled) return;
        const projected = projectOrganizationMutationAuth(authority, {
            principalId: att.principalId,
            organizationId: TenantId(organizationId),
        });
        if (!projected.ok) {
            this.sendError(ws, projected.code, msg.subId);
            return;
        }

        let shardId: string;
        try {
            const route = await catalog.route(vshard);
            if (typeof route?.shardId !== "string" || route.shardId.length === 0) {
                throw new TypeError("Catalog returned a malformed shard route");
            }
            shardId = route.shardId;
        } catch {
            if (pending.cancelled) return;
            this.sendError(ws, "CDB_CATALOG_UNAVAILABLE", msg.subId);
            return;
        }
        if (pending.cancelled) return;
        const cdb = this.cdb(shardId);
        let response: CdbQueryRowsResponse;
        try {
            response = projectCdbQueryRows(await cdb.query({ ref: msg.ref, args: routed.args, auth: projected.auth }));
        } catch {
            if (pending.cancelled) return;
            this.sendError(ws, "CDB_SHARD_UNAVAILABLE", msg.subId);
            return;
        }
        if (pending.cancelled) return;
        if (!response.ok) {
            this.sendError(ws, response.error.code, msg.subId);
            return;
        }

        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (
            pending.cancelled ||
            !isVerifiedAttachment(current) ||
            current.connectionId !== att.connectionId ||
            current.principalId !== att.principalId
        ) {
            return;
        }
        const cookie = Cookie(`${att.clientId}:${Date.now()}:${crypto.randomUUID()}`);
        const snapshotSubIds = [...new Set([...(current.snapshotSubIds ?? []), msg.subId])]
            .sort((left, right) => left - right)
            .map(SubId);
        ws.serializeAttachment({ ...current, lastCookie: cookie, snapshotSubIds } satisfies VerifiedGwAttachment);
        this.send(ws, { t: "snapshot", subId: msg.subId, cookie, rows: response.result });
    }

    private onUnsub(ws: WebSocket, msg: Extract<Up, { t: "unsub" }>): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(att)) return;
        const pending = this.pendingSubscriptions.get(`${att.connectionId}:${msg.subId}`);
        if (pending) pending.cancelled = true;
        if (att.snapshotSubIds?.includes(msg.subId)) {
            ws.serializeAttachment({
                ...att,
                snapshotSubIds: att.snapshotSubIds.filter(subId => subId !== msg.subId),
            } satisfies VerifiedGwAttachment);
        }
    }

    private onMut(ws: WebSocket, msg: Extract<Up, { t: "mut" }>): void {
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        const barrier = attachment ? this.authRefreshBarriers.get(attachment.connectionId) : undefined;
        if (barrier) {
            void barrier.then(succeeded => {
                if (succeeded) this.admitMutation(ws, msg);
            });
            return;
        }
        this.admitMutation(ws, msg);
    }

    private admitMutation(ws: WebSocket, msg: Extract<Up, { t: "mut" }>): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(att)) {
            this.sendMutFailure(
                ws,
                msg.mutId,
                new CdbError({ code: "CDB_FORBIDDEN", message: "verified mutation auth is not bound" }).toJSON()
            );
            return;
        }
        if (!isCurrentVerifiedAttachment(att)) {
            this.sendMutFailure(
                ws,
                msg.mutId,
                new CdbError({ code: "CDB_FORBIDDEN", message: "verified mutation auth is expired" }).toJSON(),
                att.lastCookie
            );
            return;
        }
        const trusted = trustedMutationAuthFromAttachment(att);
        const task = this.settleMut(ws, att, msg, trusted);
        let active = this.activeOperations.get(att.connectionId);
        if (!active) {
            active = new Set();
            this.activeOperations.set(att.connectionId, active);
        }
        active.add(task);
        void task
            .catch(() => {
                // The only uncaught failure here is the final WebSocket send.
                // A second send would violate exactly-once settlement.
            })
            .finally(() => {
                active?.delete(task);
                if (active?.size === 0) this.activeOperations.delete(att.connectionId);
            });
    }

    /**
     * Resolve a mutation through the worker manifest, route the resulting vshard
     * via the Catalog, and call `Cdb.mutate` on the owning shard. The handler
     * intentionally does not re-evaluate the user's mutation body; that runs
     * inside the shard DO under `transactionSync`.
     */
    private async routeMut(msg: Extract<Up, { t: "mut" }>, trusted: TrustedMutationAuth): Promise<CdbMutationResponse> {
        let catalog: CatalogMutationRpc & CatalogOrganizationAuthorityRpc;
        try {
            const catalogId = this.env.CDB_CATALOG.idFromName("global");
            catalog = this.env.CDB_CATALOG.get(catalogId) as unknown as CatalogMutationRpc &
                CatalogOrganizationAuthorityRpc;
        } catch {
            return mutationFailure("CDB_CATALOG_UNAVAILABLE", "Catalog binding unavailable");
        }
        return dispatchTrustedMutation(
            {
                routeMutation: request => this.routeMutation(request),
                catalog,
                cdb: shardId => {
                    const shardDoId = this.env.CDB_SHARD.idFromName(shardId);
                    return this.env.CDB_SHARD.get(shardDoId) as unknown as CdbMutationRpc;
                },
            },
            {
                ref: msg.ref,
                mutId: msg.mutId,
                args: msg.args,
                ...trusted,
            }
        );
    }

    /** Settle one accepted mutation exactly once, including unexpected async failures. */
    private async settleMut(
        ws: WebSocket,
        att: VerifiedGwAttachment,
        msg: Extract<Up, { t: "mut" }>,
        trusted: TrustedMutationAuth
    ): Promise<void> {
        let ack: CdbMutationResponse;
        try {
            ack = await this.routeMut(msg, trusted);
        } catch {
            ack = mutationFailure("CDB_INVARIANT", "mutation dispatch failed unexpectedly");
        }
        if (ack.ok) {
            const cookie = Cookie(ack.cookie);
            const current = ws.deserializeAttachment() as GwAttachment | null;
            if (isVerifiedAttachment(current)) {
                ws.serializeAttachment({ ...current, lastCookie: cookie } satisfies VerifiedGwAttachment);
            }
            this.send(ws, {
                t: "poke",
                cookie,
                patches: [],
                mutResults: [{ mutId: msg.mutId, ok: true, result: ack.result, cookie }],
            });
        } else {
            const current = ws.deserializeAttachment() as GwAttachment | null;
            const lastCookie = isVerifiedAttachment(current) ? current.lastCookie : att.lastCookie;
            this.sendMutFailure(ws, msg.mutId, ack.error, lastCookie);
        }
    }

    private onPresencePub(ws: WebSocket, msg: Extract<Up, { t: "presencePub" }>): void {
        const sender = ws.deserializeAttachment() as GwAttachment | null;
        void msg;
        this.sendError(
            ws,
            isVerifiedAttachment(sender) && isCurrentVerifiedAttachment(sender) ? "CDB_AUTH_NOT_BOUND" : "CDB_FORBIDDEN"
        );
    }

    private onPresenceSub(ws: WebSocket, msg: Extract<Up, { t: "presenceSub" }>): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        void msg;
        this.sendError(
            ws,
            isVerifiedAttachment(att) && isCurrentVerifiedAttachment(att) ? "CDB_AUTH_NOT_BOUND" : "CDB_FORBIDDEN"
        );
    }

    /**
     * Routes a sub-request to every shard whose vshard range overlaps the
     * intent's partition-key set, and persists the gateway-side mapping so
     * hibernation rebuilds work without a fresh client handshake.
     *
     * Intent shapes:
     *   - `partitionKey.values` enumerable → route to exactly those vshards
     *   - `joinShape: "reference"` → route to a single canonical replica
     *   - everything else → fan out to every shard in the catalog (scatter)
     */
    private async subscribeAcrossShards(
        clientId: ClientId,
        subId: SubId,
        ref: ChardbRef,
        args: RawJson,
        queryHash: string,
        intent: CdbIntent,
        principalId: PrincipalId,
        organizationId: TenantId,
        connectionId: string,
        registrationId: string
    ): Promise<void> {
        const shardIds = await shardsForIntent(this.catalog(), intent);
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT OR REPLACE INTO _gw_subs
       (client_id, sub_id, ast_hash, shard_ids, intent_blob, auth_epoch, last_cookie, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
            clientId,
            subId,
            queryHash,
            JSON.stringify([...shardIds]),
            JSON.stringify({ ref, args, intent, registration: { registrationId, connectionId } }),
            Date.now()
        );
        for (const shardId of shardIds) {
            sql.exec(
                "INSERT OR IGNORE INTO _gw_shard_subs (shard_id, client_id, sub_id) VALUES (?, ?, ?)",
                shardId,
                clientId,
                subId
            );
        }
        const request = cdbSubscriptionRequest({
            gatewayId: this.ctx.id.toString(),
            registrationId,
            connectionId,
            clientId,
            subId,
            principalId,
            organizationId,
            ref,
            args,
            queryHash,
            intent,
        });
        await Promise.all(
            shardIds.map(async shardId => {
                const cdb = this.cdb(shardId);
                await cdb.subscribe(request);
            })
        );
    }

    private async unsubscribeAcrossShards(clientId: ClientId, subId: SubId): Promise<void> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const shards: string[] = [];
        const cur = this.ctx.storage.sql.exec<{ shard_id: string }>(
            "SELECT shard_id FROM _gw_shard_subs WHERE client_id = ? AND sub_id = ?",
            clientId,
            subId
        );
        for (const r of cur) shards.push(r.shard_id);
        const stored = sql.one<{ intent_blob: string }>(
            "SELECT intent_blob FROM _gw_subs WHERE client_id = ? AND sub_id = ?",
            clientId,
            subId
        );
        const registration = stored ? parseStoredCdbRegistration(stored.intent_blob) : null;
        sql.exec("DELETE FROM _gw_subs WHERE client_id = ? AND sub_id = ?", clientId, subId);
        sql.exec("DELETE FROM _gw_shard_subs WHERE client_id = ? AND sub_id = ?", clientId, subId);
        if (!registration) return;
        await Promise.all(
            shards.map(async shardId => {
                const subscription = gatewaySubscriptionId(
                    this.ctx.id.toString(),
                    registration.registrationId,
                    registration.connectionId,
                    clientId,
                    subId
                );
                await this.cdb(shardId).unsubscribe(subscription);
            })
        );
    }

    private async invalidateClientSubscriptions(
        clientId: ClientId
    ): Promise<{ readonly subIds: readonly SubId[]; readonly rpcFailed: boolean }> {
        const subIds: SubId[] = [];
        const cursor = this.ctx.storage.sql.exec<{ sub_id: number }>(
            "SELECT sub_id FROM _gw_subs WHERE client_id = ? ORDER BY sub_id",
            clientId
        );
        for (const row of cursor) subIds.push(SubId(row.sub_id));
        const results = await Promise.allSettled(subIds.map(subId => this.unsubscribeAcrossShards(clientId, subId)));
        return { subIds, rpcFailed: results.some(result => result.status === "rejected") };
    }

    private catalog(): CatalogRoutingRpc {
        const id = this.env.CDB_CATALOG.idFromName("global");
        return this.env.CDB_CATALOG.get(id) as unknown as CatalogRoutingRpc;
    }

    private cdb(shardId: string): CdbRpc {
        const id = this.env.CDB_SHARD.idFromName(shardId);
        return this.env.CDB_SHARD.get(id) as unknown as CdbRpc;
    }

    /**
     * Coalesce row patches per client; flush every COALESCE_WINDOW_MS.
     * The MAX_POKE_INTERVAL_MS hard ceiling is enforced by the alarm timer so
     * stalled producers cannot starve a subscription of progress.
     */
    enqueuePatch(clientId: ClientId, patch: RowPatch): void {
        let arr = this.pendingPatches.get(clientId);
        if (!arr) {
            arr = [];
            this.pendingPatches.set(clientId, arr);
        }
        arr.push(patch);
        if (this.coalesceTimer === null) {
            this.coalesceTimer = setTimeout(() => this.flushCoalesce(), COALESCE_WINDOW_MS);
        }
    }

    private flushCoalesce(): void {
        this.coalesceTimer = null;
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment() as GwAttachment | null;
            if (!isVerifiedAttachment(att) || !isCurrentVerifiedAttachment(att)) continue;
            const patches = this.pendingPatches.get(att.clientId);
            if (!patches || patches.length === 0) continue;
            const cookie = Cookie(`${att.clientId}:${Date.now()}`);
            ws.serializeAttachment({ ...att, lastCookie: cookie } satisfies VerifiedGwAttachment);
            this.send(ws, { t: "poke", cookie, patches });
            patches.length = 0;
        }
    }

    emitMustRefetch(subIds: readonly SubId[], reason: MustRefetchReason): void {
        for (const ws of this.ctx.getWebSockets()) {
            this.send(ws, { t: "mustRefetch", subIds, reason });
        }
    }

    private send(ws: WebSocket, down: Down): void {
        ws.send(encodeWire(down));
    }

    private sendError(ws: WebSocket, code: import("../../errors.ts").CdbErrorCode, subId?: SubId): void {
        const corr = CorrelationId(crypto.randomUUID());
        this.send(ws, gatewayErrorEnvelope(code, corr, subId));
    }

    private sendMutFailure(ws: WebSocket, mutId: MutId, error: CdbErrorWire, lastCookie?: Cookie): void {
        this.send(ws, {
            t: "poke",
            cookie: lastCookie ?? Cookie(""),
            patches: [],
            mutResults: [
                {
                    mutId,
                    ok: false,
                    error: {
                        code: error.code,
                        retryable: isRetryable(error.code),
                        docs: docsUrlFor(error.code),
                    },
                },
            ],
        });
    }
}

/** Bind the bundler-built manifest into each Gateway isolate. */
export function configureGatewayRuntime(config: GatewayRuntimeConfig): typeof Gateway {
    return class ConfiguredGateway extends Gateway {
        protected override runtimeManifest(): ChardbManifest {
            return config.manifest();
        }

        protected override jwtConfig(): GatewayJwtConfig | null {
            return config.auth;
        }
    };
}

/** Re-export for downstream tests that want to drive subscription routing. */
export type { CdbSubscriptionRequest } from "../rpc.ts";
export type { CdbSubscriptionRpc as GatewayCdbRpc } from "../rpc.ts";

function toScalar(v: RawJson): string | number | bigint | Uint8Array {
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
    if (v === null) return "";
    return JSON.stringify(v);
}
