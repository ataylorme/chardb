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
import {
    type CatalogJwkResolution,
    type CatalogJwkResolutionRequest,
    createCatalogJwksResolver,
    createCatalogOwnedJwksResolver,
} from "../../auth/jwks_cache.ts";
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
import { VSHARD_COUNT, vshardOf } from "../../vshard.ts";
import {
    type CdbIntent,
    type Down,
    type MustRefetchReason,
    PROTOCOL_V,
    type Up,
    type WireMessage,
    checkProtocolV,
    decodeWire,
    encodeWire,
} from "../../wire.ts";
import { cdbPolicyDigest } from "../cdb-policy.ts";
import type { AuthCtx } from "../define.ts";
import {
    type ChardbManifest,
    type QueryRouteResponse,
    emptyManifest,
    routeMutation as resolveMutationRoute,
    routeQuery as resolveQueryRoute,
} from "../manifest.ts";
import { assertCdbMutationArgsByteLimit, snapshotCdbMutationArgs, snapshotCdbQueryArgs } from "../result_limits.ts";
import type {
    CatalogMutationRpc,
    CatalogOrganizationAuthorityRpc,
    CatalogRoutingRpc,
    CdbErrorWire,
    CdbMutationResponse,
    CdbMutationRpc,
    CdbQueryResponse,
    CdbQueryRpc,
    CdbRegisteredQueryRpc,
    CdbSubscriptionRequest,
    CdbSubscriptionResponse,
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
  policy_digest TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  source_cdb_id TEXT NOT NULL,
  schema_epoch INTEGER NOT NULL CHECK (schema_epoch >= 0),
  domain_schema_epoch INTEGER NOT NULL CHECK (domain_schema_epoch > 0),
  auth_global_epoch INTEGER NOT NULL CHECK (auth_global_epoch >= 0),
  auth_tenant_epoch INTEGER NOT NULL CHECK (auth_tenant_epoch >= 0),
  auth_principal_epoch INTEGER NOT NULL CHECK (auth_principal_epoch >= 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('installing', 'active', 'retiring')),
  cdb_state TEXT NOT NULL CHECK (cdb_state IN ('pending', 'active', 'retiring', 'error')),
  dirty_version INTEGER NOT NULL CHECK (dirty_version >= 0),
  delivered_version INTEGER NOT NULL CHECK (delivered_version >= 0 AND delivered_version <= dirty_version),
  initial_snapshot_pending INTEGER NOT NULL DEFAULT 0 CHECK (initial_snapshot_pending IN (0, 1)),
  run_token TEXT,
  run_target_version INTEGER CHECK (run_target_version IS NULL OR (run_target_version >= 0 AND run_target_version <= dirty_version)),
  run_lease_expires_at INTEGER CHECK (run_lease_expires_at IS NULL OR run_lease_expires_at >= 0),
  run_version INTEGER NOT NULL CHECK (run_version >= 0),
  last_cookie TEXT,
  last_snapshot_cookie TEXT,
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
CREATE TABLE IF NOT EXISTS _gw_maintenance_state (
  key TEXT PRIMARY KEY,
  integer_value INTEGER NOT NULL CHECK (integer_value >= 0)
);
CREATE TABLE IF NOT EXISTS _gw_snapshot_outbox (
  registration_id TEXT PRIMARY KEY,
  cookie TEXT NOT NULL UNIQUE,
  target_version INTEGER NOT NULL CHECK (target_version >= 0),
  rows_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  send_attempts INTEGER NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  claim_token TEXT,
  claim_version INTEGER NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
  claim_expires_at INTEGER CHECK (claim_expires_at IS NULL OR claim_expires_at >= 0),
  attachment_base_cookie TEXT,
  last_sent_at INTEGER CHECK (last_sent_at IS NULL OR last_sent_at >= 0),
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (registration_id) REFERENCES _gw_registration_generations(registration_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS _gw_snapshot_outbox_due
  ON _gw_snapshot_outbox (next_attempt_at, registration_id);
CREATE TABLE IF NOT EXISTS _gw_snapshot_replay (
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL CHECK (sub_id >= 0),
  cookie TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  args_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  source_cdb_id TEXT NOT NULL,
  schema_epoch INTEGER NOT NULL CHECK (schema_epoch >= 0),
  domain_schema_epoch INTEGER NOT NULL CHECK (domain_schema_epoch > 0),
  auth_global_epoch INTEGER NOT NULL CHECK (auth_global_epoch >= 0),
  auth_tenant_epoch INTEGER NOT NULL CHECK (auth_tenant_epoch >= 0),
  auth_principal_epoch INTEGER NOT NULL CHECK (auth_principal_epoch >= 0),
  rows_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (principal_id, client_id, sub_id)
);
CREATE INDEX IF NOT EXISTS _gw_snapshot_replay_expiry
  ON _gw_snapshot_replay (expires_at, created_at, principal_id, client_id, sub_id);
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

export const PRESENCE_FANOUT_CAP = 1024 as const;

export const PRESENCE_TTL_DEFAULT_MS = 30_000 as const;
export const MAX_INITIAL_SNAPSHOTS_PER_CONNECTION = 64 as const;
export const MAX_GATEWAY_INVALIDATIONS_PER_REQUEST = 64 as const;
export const GATEWAY_CLEANUP_BATCH_SIZE = 32 as const;
export const GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE = 32 as const;
export const GATEWAY_CLEANUP_BASE_RETRY_MS = 1_000 as const;
export const GATEWAY_CLEANUP_MAX_RETRY_MS = 60_000 as const;
export const GATEWAY_CLEANUP_MAX_RETRY_COUNT = 30 as const;
export const GATEWAY_CLEANUP_MAX_ERROR_LENGTH = 512 as const;
export const GATEWAY_QUERY_BATCH_SIZE = 16 as const;
export const GATEWAY_SEND_BATCH_SIZE = 32 as const;
export const GATEWAY_QUERY_LEASE_MS = 30_000 as const;
export const GATEWAY_SEND_LEASE_MS = 10_000 as const;
export const GATEWAY_SUBSCRIBE_RECOVERY_MS = 30_000 as const;
export const GATEWAY_SNAPSHOT_REPLAY_RETENTION_MS = 30_000 as const;
export const GATEWAY_MAX_SNAPSHOT_REPLAY_ROWS = 256 as const;
export const GATEWAY_MAX_DURABLE_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES = 15 * 1024 * 1024;

const GATEWAY_GENERATION_PAYLOAD_COLUMNS = [
    "registration_id",
    "principal_id",
    "client_id",
    "connection_id",
    "organization_id",
    "ref",
    "args_json",
    "intent_json",
    "policy_digest",
    "query_hash",
    "shard_id",
    "source_cdb_id",
    "lifecycle",
    "cdb_state",
    "run_token",
    "last_cookie",
    "last_snapshot_cookie",
    "retry_error",
] as const;

const GATEWAY_SNAPSHOT_PAYLOAD_COLUMNS = [
    "registration_id",
    "cookie",
    "rows_json",
    "claim_token",
    "attachment_base_cookie",
    "last_error",
] as const;

const GATEWAY_REPLAY_PAYLOAD_COLUMNS = [
    "principal_id",
    "client_id",
    "cookie",
    "organization_id",
    "ref",
    "args_json",
    "policy_digest",
    "query_hash",
    "shard_id",
    "source_cdb_id",
    "rows_json",
] as const;

const GATEWAY_UUID_TOKEN_BYTES = 36;
// Retry text is sliced to 512 UTF-16 code units. Four bytes per unit is a
// conservative UTF-8 bound, including malformed surrogate input.
const GATEWAY_MAX_RETRY_ERROR_BYTES = GATEWAY_CLEANUP_MAX_ERROR_LENGTH * 4;
// A generated snapshot cookie contains a routed client id (at most 256
// UTF-16 code units), a safe integer, separators, and one UUID.
const GATEWAY_MAX_GENERATED_SNAPSHOT_COOKIE_BYTES = 1_080;

function gatewayPayloadByteExpression(sql: SyncSql, table: string, columns: readonly string[]): string {
    const available = new Set(sql.all<{ name: string }>(`PRAGMA table_info('${table}')`).map(column => column.name));
    const expressions = columns
        .filter(column => available.has(column))
        .map(column => `length(CAST(COALESCE(${column}, '') AS BLOB))`);
    return expressions.length === 0 ? "0" : expressions.join(" + ");
}

const GATEWAY_RETIRED_PAYLOAD_ASSIGNMENTS = `
    organization_id = '', ref = '', args_json = 'null', intent_json = 'null',
    policy_digest = '', query_hash = '', shard_id = '',
    last_cookie = NULL, last_snapshot_cookie = NULL`;

export interface GatewayDurablePayloadUsage {
    readonly registrationBytes: number;
    readonly snapshotBytes: number;
    readonly replayBytes: number;
    readonly totalBytes: number;
    readonly registrationReservedBytes: number;
    readonly snapshotReservedBytes: number;
    readonly chargedRegistrationBytes: number;
    readonly chargedTotalBytes: number;
}

/** Derive stored payload usage from SQLite values, never advisory byte_size columns. */
export function gatewayDurablePayloadUsage(sql: SyncSql): GatewayDurablePayloadUsage {
    const generationExpression = gatewayPayloadByteExpression(
        sql,
        "_gw_registration_generations",
        GATEWAY_GENERATION_PAYLOAD_COLUMNS
    );
    const snapshotExpression = gatewayPayloadByteExpression(
        sql,
        "_gw_snapshot_outbox",
        GATEWAY_SNAPSHOT_PAYLOAD_COLUMNS
    );
    const replayExpression = gatewayPayloadByteExpression(sql, "_gw_snapshot_replay", GATEWAY_REPLAY_PAYLOAD_COLUMNS);
    const generationColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info('_gw_registration_generations')").map(column => column.name)
    );
    const snapshotColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info('_gw_snapshot_outbox')").map(column => column.name)
    );
    const storedBytes = (columns: ReadonlySet<string>, column: string, prefix = ""): string =>
        columns.has(column) ? `length(CAST(COALESCE(${prefix}${column}, '') AS BLOB))` : "0";
    const futureSnapshotCookieBytes = `MAX(
        ${GATEWAY_MAX_GENERATED_SNAPSHOT_COOKIE_BYTES},
        length(CAST(COALESCE(o.cookie, '') AS BLOB))
    )`;
    const generationRetryReservationExpression = `MAX(
        0,
        ${GATEWAY_MAX_RETRY_ERROR_BYTES} - ${storedBytes(generationColumns, "retry_error", "g.")}
    )`;
    const currentHeadReservationExpression = [
        [`${GATEWAY_UUID_TOKEN_BYTES}`, storedBytes(generationColumns, "run_token", "g.")],
        [futureSnapshotCookieBytes, storedBytes(generationColumns, "last_cookie", "g.")],
        [futureSnapshotCookieBytes, storedBytes(generationColumns, "last_snapshot_cookie", "g.")],
    ]
        .map(([limit, actual]) => `MAX(0, ${limit} - ${actual})`)
        .join(" + ");
    const snapshotReservationExpression = [
        [GATEWAY_UUID_TOKEN_BYTES, storedBytes(snapshotColumns, "claim_token")],
        [GATEWAY_MAX_RETRY_ERROR_BYTES, storedBytes(snapshotColumns, "last_error")],
    ]
        .map(([limit, actual]) => `MAX(0, ${limit} - ${actual})`)
        .join(" + ");
    const row = sql.one<{
        registration_bytes: number | bigint;
        snapshot_bytes: number | bigint;
        replay_bytes: number | bigint;
        registration_reserved_bytes: number | bigint;
        snapshot_reserved_bytes: number | bigint;
    }>(
        `SELECT
           COALESCE((SELECT SUM(${generationExpression})
                     FROM _gw_registration_generations), 0) AS registration_bytes,
           COALESCE((SELECT SUM(${snapshotExpression})
                     FROM _gw_snapshot_outbox), 0) AS snapshot_bytes,
           COALESCE((SELECT SUM(${replayExpression})
                     FROM _gw_snapshot_replay), 0) AS replay_bytes,
           (COALESCE((SELECT SUM(${generationRetryReservationExpression})
                      FROM _gw_registration_generations g), 0)
            + COALESCE((SELECT SUM(${currentHeadReservationExpression})
                     FROM _gw_registration_generations g
                     INNER JOIN _gw_registration_heads h ON h.registration_id = g.registration_id
                     LEFT JOIN _gw_snapshot_outbox o ON o.registration_id = g.registration_id), 0))
                     AS registration_reserved_bytes,
           COALESCE((SELECT SUM(${snapshotReservationExpression})
                     FROM _gw_snapshot_outbox), 0) AS snapshot_reserved_bytes`
    );
    const registrationBytes = Number(row?.registration_bytes ?? 0);
    const snapshotBytes = Number(row?.snapshot_bytes ?? 0);
    const replayBytes = Number(row?.replay_bytes ?? 0);
    const registrationReservedBytes = Number(row?.registration_reserved_bytes ?? 0);
    const snapshotReservedBytes = Number(row?.snapshot_reserved_bytes ?? 0);
    if (
        !Number.isSafeInteger(registrationBytes) ||
        registrationBytes < 0 ||
        !Number.isSafeInteger(snapshotBytes) ||
        snapshotBytes < 0 ||
        !Number.isSafeInteger(replayBytes) ||
        replayBytes < 0 ||
        !Number.isSafeInteger(registrationReservedBytes) ||
        registrationReservedBytes < 0 ||
        !Number.isSafeInteger(snapshotReservedBytes) ||
        snapshotReservedBytes < 0
    ) {
        throw gatewayInvalidationInvariant("Gateway durable payload usage is invalid");
    }
    const totalBytes = registrationBytes + snapshotBytes + replayBytes;
    const chargedRegistrationBytes = registrationBytes + registrationReservedBytes;
    const chargedTotalBytes = totalBytes + registrationReservedBytes + snapshotReservedBytes;
    if (
        !Number.isSafeInteger(totalBytes) ||
        !Number.isSafeInteger(chargedRegistrationBytes) ||
        !Number.isSafeInteger(chargedTotalBytes)
    ) {
        throw gatewayInvalidationInvariant("Gateway durable payload usage overflowed");
    }
    return {
        registrationBytes,
        snapshotBytes,
        replayBytes,
        totalBytes,
        registrationReservedBytes,
        snapshotReservedBytes,
        chargedRegistrationBytes,
        chargedTotalBytes,
    };
}

function assertGatewayDurablePayloadQuota(sql: SyncSql): void {
    const usage = gatewayDurablePayloadUsage(sql);
    if (
        usage.chargedRegistrationBytes > GATEWAY_MAX_REGISTRATION_PAYLOAD_BYTES ||
        usage.chargedTotalBytes > GATEWAY_MAX_DURABLE_PAYLOAD_BYTES
    ) {
        throw new CdbError({
            code: "CDB_RATE_LIMITED",
            message: "Gateway durable subscription payload quota exceeded",
            retryAfterMs: GATEWAY_CLEANUP_BASE_RETRY_MS,
            hint: "Retire an existing live query or wait for snapshot delivery before retrying.",
        });
    }
}

const GATEWAY_ABANDONED_REGISTRATION_CURSOR_KEY = "abandoned-registration-cursor" as const;
// Match the Gateway-wide unsettled mutation budget so one isolate has a
// single aggregate concurrency scale for client-originated work.
const GATEWAY_MAX_CURRENT_AND_PENDING_REGISTRATIONS = 256;
// Preserve the platform's original 1 MiB WebSocket message ceiling even on
// runtimes that accept larger frames. File payloads belong on the upload path.
const GATEWAY_MAX_INBOUND_WEBSOCKET_BYTES = 1024 * 1024;
const GATEWAY_TEXT_ENCODER = new TextEncoder();

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
    readonly capacityKey: string;
    cancelled: boolean;
    queued: boolean;
    readonly resumeReplayAttempt: boolean;
    task: Promise<void>;
}

interface StoredGatewayInstallRecovery {
    readonly principal_id: string;
    readonly client_id: string;
    readonly sub_id: number;
    readonly registration_id: string;
    readonly connection_id: string;
}

export interface VerifiedGwAttachment {
    readonly kind: "verified";
    readonly connectionId: string;
    readonly authOrigin: string;
    readonly clientId: ClientId;
    readonly lastCookie?: Cookie;
    readonly presenceKeys?: readonly string[];
    readonly snapshotSubIds?: readonly SubId[];
    /** Resumed subscriptions told to discard retained state and awaiting their replacement frame. */
    readonly resumeRefetchPendingSubIds?: readonly SubId[];
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
    readonly schema: () => Record<string, unknown>;
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
    resolveJwk?(request: CatalogJwkResolutionRequest): Promise<CatalogJwkResolution>;
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

function isTerminalRegisteredQueryFailure(code: string): boolean {
    return isCdbErrorCode(code) && !isRetryable(code);
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
            roles: [...roles],
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
    readonly domainSchemaEpoch: number;
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
        domainSchemaEpoch: input.domainSchemaEpoch,
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

export function projectCdbSubscriptionResponse(value: unknown, expected: LiveSubscriptionId): CdbSubscriptionResponse {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Cdb returned a malformed subscribe response");
    }
    const response = value as Record<string, unknown>;
    const subscription = response.subscription;
    if (typeof subscription !== "object" || subscription === null || Array.isArray(subscription)) {
        throw new TypeError("Cdb returned a malformed subscribe response");
    }
    const identity = subscription as Record<string, unknown>;
    if (
        !hasExactKeys(identity, ["gatewayId", "registrationId", "connectionId", "clientId", "subId"]) ||
        identity.gatewayId !== expected.gatewayId ||
        identity.registrationId !== expected.registrationId ||
        identity.connectionId !== expected.connectionId ||
        identity.clientId !== expected.clientId ||
        identity.subId !== expected.subId
    ) {
        throw new TypeError("Cdb returned a mismatched subscribe response");
    }
    if (response.ok === true) {
        if (
            !hasExactKeys(response, ["ok", "subscription", "changeSeq"]) ||
            !Number.isSafeInteger(response.changeSeq) ||
            (response.changeSeq as number) < 0
        ) {
            throw new TypeError("Cdb returned a malformed subscribe success");
        }
        return response as unknown as Extract<CdbSubscriptionResponse, { readonly ok: true }>;
    }
    if (response.ok !== false || !hasExactKeys(response, ["ok", "registrationState", "subscription", "error"])) {
        throw new TypeError("Cdb returned a malformed subscribe response");
    }
    if (response.registrationState !== "absent") {
        throw new TypeError("Cdb returned a malformed subscribe failure state");
    }
    const error = response.error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        throw new TypeError("Cdb returned a malformed subscribe failure");
    }
    const wire = error as Record<string, unknown>;
    if (
        !hasExactKeys(wire, ["code", "retryable", "message", "correlationId", "docs", "retryAfterMs", "hint"]) ||
        !isCdbErrorCode(wire.code) ||
        wire.retryable !== isRetryable(wire.code) ||
        typeof wire.message !== "string" ||
        wire.docs !== docsUrlFor(wire.code) ||
        (wire.correlationId !== undefined && typeof wire.correlationId !== "string") ||
        (wire.retryAfterMs !== undefined &&
            (!Number.isSafeInteger(wire.retryAfterMs) ||
                (wire.retryAfterMs as number) < 0 ||
                (wire.retryAfterMs as number) > 2_147_483_647)) ||
        (wire.hint !== undefined && typeof wire.hint !== "string")
    ) {
        throw new TypeError("Cdb returned a malformed subscribe failure");
    }
    return response as unknown as Extract<CdbSubscriptionResponse, { readonly ok: false }>;
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
    readonly policyDigest: string;
    readonly queryHash: string;
    /** Catalog's logical shard identifier. */
    readonly shardId: string;
    /** Physical Cdb Durable Object identifier that emits invalidations. */
    readonly sourceCdbId: string;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
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
    readonly lastCookie: Cookie | null;
    readonly retryCount: number;
    readonly retryAt: number | null;
    readonly retryError: string | null;
    readonly nowMs: number;
}

interface GatewaySubscriptionActivation extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly changeSeq: number;
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

export interface GatewayDirtyRunClaim extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly nowMs: number;
    readonly leaseExpiresAt: number;
}

export interface GatewayDirtyRun {
    readonly targetVersion: number;
    readonly runToken: string;
    readonly runVersion: number;
    readonly leaseExpiresAt: number;
    readonly reclaimed: boolean;
    readonly organizationId: TenantId;
    readonly shardId: string;
    readonly sourceCdbId: string;
    readonly domainSchemaEpoch: number;
    readonly intentJson: string;
    readonly policyDigest: string;
}

export interface GatewaySnapshotStage extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly runToken: string;
    readonly runVersion: number;
    readonly targetVersion: number;
    readonly cookie: Cookie;
    readonly rows: readonly RawJson[];
    readonly authEpochs: {
        readonly global: number;
        readonly tenant: number;
        readonly principal: number;
    };
    readonly nowMs: number;
}

export interface GatewaySnapshotReplayLookup extends GatewayRegistrationKey {
    readonly cookie: Cookie;
    readonly organizationId: TenantId;
    readonly ref: ChardbRef;
    readonly args: RawJson;
    readonly policyDigest: string;
    readonly queryHash: string;
    readonly shardId: string;
    readonly sourceCdbId: string;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
    readonly authEpochs: {
        readonly global: number;
        readonly tenant: number;
        readonly principal: number;
    };
    readonly nowMs: number;
}

export interface GatewaySnapshotReplay {
    readonly subId: SubId;
    readonly cookie: Cookie;
    readonly rows: readonly RawJson[];
}

export interface GatewaySnapshotSendClaim {
    readonly nowMs: number;
    readonly attemptExpiresAt: number;
}

export interface GatewaySnapshotSendAttempt extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly cookie: Cookie;
    readonly targetVersion: number;
    readonly rows: readonly RawJson[];
    readonly byteSize: number;
    readonly sendAttempts: number;
    readonly nextAttemptAt: number;
    readonly claimToken: string;
    readonly claimVersion: number;
    readonly intentJson: string;
    readonly policyDigest: string;
}

export interface GatewayDirtyRunFailure extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly runToken: string;
    readonly runVersion: number;
    readonly nowMs: number;
    readonly error: unknown;
}

export interface GatewayClaimedRunRetire extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly runToken: string;
    readonly runVersion: number;
    readonly nowMs: number;
}

export interface GatewayClaimedSnapshotRetire extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly cookie: Cookie;
    readonly claimToken: string;
    readonly claimVersion: number;
    readonly nowMs: number;
}

export interface GatewaySnapshotSendFailure {
    readonly registrationId: string;
    readonly cookie: Cookie;
    readonly claimToken: string;
    readonly claimVersion: number;
    readonly nowMs: number;
    readonly error: unknown;
}

export interface GatewaySnapshotAcknowledge extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly cookie: Cookie;
    readonly nowMs: number;
}

export interface GatewaySnapshotAckLookup {
    readonly principalId: PrincipalId;
    readonly clientId: ClientId;
    readonly connectionId: string;
    readonly cookie: Cookie;
}

export interface GatewaySnapshotAckIdentity extends GatewayRegistrationKey {
    readonly registrationId: string;
    readonly connectionId: string;
    readonly cookie: Cookie;
    readonly alreadyAcknowledged: boolean;
    readonly attachmentBaseCookie: Cookie | null;
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

interface StoredGatewayActiveHead {
    readonly generation_rowid: number;
    readonly principal_id: string;
    readonly client_id: string;
    readonly sub_id: number;
    readonly registration_id: string;
    readonly connection_id: string;
}

interface StoredGatewayRunCandidate {
    readonly principal_id: string;
    readonly client_id: string;
    readonly sub_id: number;
    readonly registration_id: string;
    readonly connection_id: string;
}

type ExactGatewaySocket =
    | { readonly status: "ready"; readonly ws: WebSocket; readonly attachment: VerifiedGwAttachment }
    | { readonly status: "refreshing" }
    | { readonly status: "terminal" };

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
    if (previous) retainCurrentGatewaySnapshotReplay(sql, input, input.nowMs, true);
    sql.exec(
        `INSERT INTO _gw_registration_generations
         (registration_id, principal_id, client_id, sub_id, connection_id, organization_id,
          ref, args_json, intent_json, policy_digest, query_hash, shard_id, source_cdb_id, schema_epoch,
          domain_schema_epoch,
          auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
          lifecycle, cdb_state, dirty_version, delivered_version, run_token, run_target_version,
          run_lease_expires_at, run_version,
          last_cookie, retry_count, retry_at, retry_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'installing', 'pending', 0, 0, NULL, NULL, NULL, 0, ?, 0, NULL, NULL, ?, ?)`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.organizationId,
        input.ref,
        stableJson(input.args),
        stableJson(input.intent),
        input.policyDigest,
        input.queryHash,
        input.shardId,
        input.sourceCdbId,
        input.schemaEpoch,
        input.domainSchemaEpoch,
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
             SET ${GATEWAY_RETIRED_PAYLOAD_ASSIGNMENTS},
                 lifecycle = 'retiring',
                 cdb_state = CASE WHEN cdb_state = 'pending' THEN 'pending' ELSE 'retiring' END,
                 run_token = NULL, run_target_version = NULL,
                 run_lease_expires_at = NULL,
                 run_version = run_version + 1, retry_count = 0,
                 retry_at = CASE WHEN cdb_state = 'pending' THEN retry_at ELSE ? END,
                 retry_error = NULL, updated_at = ?
             WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?`,
            input.nowMs,
            input.nowMs,
            previous.registration_id,
            input.principalId,
            input.clientId,
            input.subId
        );
        sql.exec("DELETE FROM _gw_snapshot_outbox WHERE registration_id = ?", previous.registration_id);
        pruneGatewaySnapshotReplays(sql, input.nowMs);
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
    assertGatewayDurablePayloadQuota(sql);
    return { supersededRegistrationId: previous?.registration_id ?? null };
}

function armGatewaySubscriptionRecovery(
    sql: SyncSql,
    input: GatewayRegistrationKey & {
        readonly registrationId: string;
        readonly connectionId: string;
        readonly recoveryAt: number;
        readonly nowMs: number;
    }
): boolean {
    assertGatewayRegistrationIdentity(input);
    assertNonnegativeSafeInteger(input.recoveryAt, "recoveryAt");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    if (input.recoveryAt <= input.nowMs) throw new TypeError("recoveryAt must be later than nowMs");
    sql.exec(
        `UPDATE _gw_registration_generations
         SET retry_at = ?, retry_error = 'subscription install recovery', updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'installing' AND cdb_state = 'pending'
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        input.recoveryAt,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    return sql.changes() === 1;
}

function activateGatewaySubscription(sql: SyncSql, input: GatewaySubscriptionActivation): boolean {
    assertGatewayRegistrationIdentity(input);
    assertNonnegativeSafeInteger(input.changeSeq, "changeSeq");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    sql.exec(
        `UPDATE _gw_registration_generations
         SET lifecycle = 'active', cdb_state = 'active', dirty_version = MAX(dirty_version, ?),
             initial_snapshot_pending = 1,
             retry_count = 0, retry_at = NULL, retry_error = NULL, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'installing' AND cdb_state = 'pending'
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        input.changeSeq,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    return sql.changes() === 1;
}

function deleteNeverRegisteredGatewaySubscription(
    sql: SyncSql,
    input: GatewayRegistrationKey & { readonly registrationId: string; readonly connectionId: string }
): boolean {
    assertGatewayRegistrationIdentity(input);
    const pending = sql.one<{ registration_id: string }>(
        `SELECT registration_id FROM _gw_registration_generations
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND cdb_state = 'pending'`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (!pending) return false;
    sql.exec(
        `DELETE FROM _gw_registration_heads
         WHERE principal_id = ? AND client_id = ? AND sub_id = ? AND registration_id = ?`,
        input.principalId,
        input.clientId,
        input.subId,
        input.registrationId
    );
    sql.exec("DELETE FROM _gw_snapshot_outbox WHERE registration_id = ?", input.registrationId);
    sql.exec(
        `DELETE FROM _gw_registration_generations
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND cdb_state = 'pending'`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    return sql.changes() === 1;
}

function markPendingGatewaySubscriptionAmbiguous(
    sql: SyncSql,
    input: GatewayRegistrationKey & {
        readonly registrationId: string;
        readonly connectionId: string;
        readonly nowMs: number;
    }
): boolean {
    assertGatewayRegistrationIdentity(input);
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const pending = sql.one<{ registration_id: string }>(
        `SELECT registration_id FROM _gw_registration_generations
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND cdb_state = 'pending'`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (!pending) return false;
    sql.exec(
        `DELETE FROM _gw_registration_heads
         WHERE principal_id = ? AND client_id = ? AND sub_id = ? AND registration_id = ?`,
        input.principalId,
        input.clientId,
        input.subId,
        input.registrationId
    );
    sql.exec(
        `UPDATE _gw_registration_generations
         SET ${GATEWAY_RETIRED_PAYLOAD_ASSIGNMENTS},
             lifecycle = 'retiring', cdb_state = 'retiring',
             run_token = NULL, run_target_version = NULL, run_lease_expires_at = NULL,
             run_version = run_version + 1, retry_count = 0, retry_at = ?, retry_error = NULL, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND cdb_state = 'pending'`,
        input.nowMs,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (sql.changes() !== 1) return false;
    sql.exec("DELETE FROM _gw_snapshot_outbox WHERE registration_id = ?", input.registrationId);
    return true;
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
    const retryError = input.retryError === null ? null : gatewayRetryError(input.retryError);
    sql.exec(
        `UPDATE _gw_registration_generations
         SET lifecycle = ?, cdb_state = ?, dirty_version = ?, delivered_version = ?,
             run_token = NULL, run_target_version = NULL, run_lease_expires_at = NULL,
             run_version = run_version + 1, last_cookie = ?,
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
        input.lastCookie,
        input.retryCount,
        input.retryAt,
        retryError,
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
    const advanced = sql.changes() === 1;
    if (advanced) assertGatewayDurablePayloadQuota(sql);
    return advanced;
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
             run_token = NULL, run_target_version = NULL, run_lease_expires_at = NULL,
             run_version = run_version + 1,
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
    const settled = sql.changes() === 1;
    if (settled) assertGatewayDurablePayloadQuota(sql);
    return settled;
}

/**
 * Claim an exact current dirty generation. An expired owner may be replaced,
 * but a staged snapshot blocks another query until its cookie is acknowledged.
 * The caller must wrap the select and update in one transaction.
 */
export function claimDirtyGatewayRegistration(sql: SyncSql, input: GatewayDirtyRunClaim): GatewayDirtyRun | null {
    assertGatewayRegistrationIdentity(input);
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    assertNonnegativeSafeInteger(input.leaseExpiresAt, "leaseExpiresAt");
    if (input.leaseExpiresAt <= input.nowMs) throw new TypeError("leaseExpiresAt must be later than nowMs");
    const current = sql.one<{
        dirty_version: number;
        delivered_version: number;
        run_token: string | null;
        run_version: number;
        organization_id: string;
        shard_id: string;
        source_cdb_id: string;
        domain_schema_epoch: number;
        intent_json: string;
        policy_digest: string;
    }>(
        `SELECT g.dirty_version, g.delivered_version, g.run_token, g.run_version,
                g.organization_id, g.shard_id, g.source_cdb_id, g.domain_schema_epoch,
                g.intent_json, g.policy_digest
         FROM _gw_registration_generations g
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE g.registration_id = ? AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ?
           AND g.connection_id = ? AND g.lifecycle = 'active' AND g.cdb_state = 'active'
           AND g.source_cdb_id IS NOT NULL AND g.source_cdb_id <> ''
           AND (g.initial_snapshot_pending = 1 OR g.dirty_version > g.delivered_version)
           AND (g.retry_at IS NULL OR g.retry_at <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM _gw_snapshot_outbox o WHERE o.registration_id = g.registration_id
           )
           AND (
             (g.run_token IS NULL AND g.run_target_version IS NULL AND g.run_lease_expires_at IS NULL)
             OR
             (g.run_token IS NOT NULL AND g.run_target_version IS NOT NULL
              AND g.run_lease_expires_at IS NOT NULL AND g.run_lease_expires_at <= ?)
           )`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.nowMs,
        input.nowMs
    );
    if (!current) return null;

    const runToken = crypto.randomUUID();
    const runVersion = current.run_version + 1;
    const targetVersion = current.dirty_version;
    sql.exec(
        `UPDATE _gw_registration_generations
         SET run_token = ?, run_target_version = ?, run_lease_expires_at = ?,
             run_version = run_version + 1, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'active' AND cdb_state = 'active'
           AND dirty_version = ? AND delivered_version = ? AND run_version = ?
           AND (retry_at IS NULL OR retry_at <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM _gw_snapshot_outbox o
             WHERE o.registration_id = _gw_registration_generations.registration_id
           )
           AND (
             (run_token IS NULL AND run_target_version IS NULL AND run_lease_expires_at IS NULL)
             OR
             (run_token IS NOT NULL AND run_target_version IS NOT NULL
              AND run_lease_expires_at IS NOT NULL AND run_lease_expires_at <= ?)
           )
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        runToken,
        targetVersion,
        input.leaseExpiresAt,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        current.dirty_version,
        current.delivered_version,
        current.run_version,
        input.nowMs,
        input.nowMs
    );
    if (sql.changes() !== 1) return null;
    return {
        targetVersion,
        runToken,
        runVersion,
        leaseExpiresAt: input.leaseExpiresAt,
        reclaimed: current.run_token !== null,
        organizationId: TenantId(current.organization_id),
        shardId: current.shard_id,
        sourceCdbId: current.source_cdb_id,
        domainSchemaEpoch: current.domain_schema_epoch,
        intentJson: current.intent_json,
        policyDigest: current.policy_digest,
    };
}

/** Stage query rows durably without claiming client delivery. Wrap this helper in one transaction. */
export function stageGatewaySnapshot(sql: SyncSql, input: GatewaySnapshotStage): boolean {
    assertGatewayRegistrationIdentity(input);
    if (input.runToken.length === 0) throw new TypeError("runToken must be nonempty");
    if (input.cookie.length === 0) throw new TypeError("cookie must be nonempty");
    assertNonnegativeSafeInteger(input.runVersion, "runVersion");
    assertNonnegativeSafeInteger(input.targetVersion, "targetVersion");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    for (const [name, value] of [
        ["authEpochs.global", input.authEpochs.global],
        ["authEpochs.tenant", input.authEpochs.tenant],
        ["authEpochs.principal", input.authEpochs.principal],
    ] as const) {
        assertNonnegativeSafeInteger(value, name);
    }
    if (!Array.isArray(input.rows)) throw new TypeError("rows must be a JSON array");
    const rows = rawJsonResult(input.rows, "Gateway snapshot rows");
    if (!Array.isArray(rows)) throw new TypeError("rows must be a JSON array");
    const rowsJson = stableJson(rows);
    const byteSize = new TextEncoder().encode(rowsJson).byteLength;

    sql.exec(
        `UPDATE _gw_registration_generations
         SET run_token = NULL, run_target_version = NULL, run_lease_expires_at = NULL,
             run_version = run_version + 1,
             auth_global_epoch = ?, auth_tenant_epoch = ?, auth_principal_epoch = ?,
             retry_count = 0, retry_at = NULL, retry_error = NULL, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'active' AND cdb_state = 'active'
           AND run_token = ? AND run_target_version = ? AND run_version = ?
           AND NOT EXISTS (
             SELECT 1 FROM _gw_snapshot_outbox o
             WHERE o.registration_id = _gw_registration_generations.registration_id
           )
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        input.authEpochs.global,
        input.authEpochs.tenant,
        input.authEpochs.principal,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.runToken,
        input.targetVersion,
        input.runVersion
    );
    if (sql.changes() !== 1) return false;
    sql.exec(
        `INSERT INTO _gw_snapshot_outbox
         (registration_id, cookie, target_version, rows_json, byte_size,
          send_attempts, next_attempt_at, claim_token, claim_version, claim_expires_at,
          last_sent_at, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, NULL, 0, NULL, NULL, NULL, ?)`,
        input.registrationId,
        input.cookie,
        input.targetVersion,
        rowsJson,
        byteSize,
        input.nowMs,
        input.nowMs
    );
    assertGatewayDurablePayloadQuota(sql);
    return true;
}

/** Claim the oldest due staged snapshot and defer its next send attempt. The caller must use one transaction. */
export function claimDueGatewaySnapshot(
    sql: SyncSql,
    input: GatewaySnapshotSendClaim
): GatewaySnapshotSendAttempt | null {
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    assertNonnegativeSafeInteger(input.attemptExpiresAt, "attemptExpiresAt");
    if (input.attemptExpiresAt <= input.nowMs) {
        throw new TypeError("attemptExpiresAt must be later than nowMs");
    }
    const due = sql.one<{
        registration_id: string;
        principal_id: string;
        client_id: string;
        sub_id: number;
        connection_id: string;
        cookie: string;
        target_version: number;
        rows_json: string;
        byte_size: number;
        send_attempts: number;
        next_attempt_at: number;
        claim_token: string | null;
        claim_version: number;
        intent_json: string;
        policy_digest: string;
    }>(
        `SELECT o.registration_id, g.principal_id, g.client_id, g.sub_id, g.connection_id,
                o.cookie, o.target_version, o.rows_json, o.byte_size, o.send_attempts, o.next_attempt_at,
                o.claim_token, o.claim_version, g.intent_json, g.policy_digest
         FROM _gw_snapshot_outbox o
         INNER JOIN _gw_registration_generations g ON g.registration_id = o.registration_id
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE o.next_attempt_at <= ?
           AND (o.claim_token IS NULL OR o.claim_expires_at IS NULL OR o.claim_expires_at <= ?)
           AND g.lifecycle = 'active' AND g.cdb_state = 'active'
         ORDER BY o.next_attempt_at, o.registration_id
         LIMIT 1`,
        input.nowMs,
        input.nowMs
    );
    if (!due) return null;
    const claimToken = crypto.randomUUID();
    const claimVersion = due.claim_version + 1;
    sql.exec(
        `UPDATE _gw_snapshot_outbox
         SET send_attempts = MIN(send_attempts + 1, ?), next_attempt_at = ?,
             claim_token = ?, claim_version = claim_version + 1, claim_expires_at = ?, last_sent_at = ?
         WHERE registration_id = ? AND cookie = ? AND target_version = ?
           AND send_attempts = ? AND next_attempt_at = ? AND claim_version = ?
           AND ((claim_token IS NULL AND ? IS NULL) OR claim_token = ?)
           AND next_attempt_at <= ?
           AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
        GATEWAY_CLEANUP_MAX_RETRY_COUNT,
        input.attemptExpiresAt,
        claimToken,
        input.attemptExpiresAt,
        input.nowMs,
        due.registration_id,
        due.cookie,
        due.target_version,
        due.send_attempts,
        due.next_attempt_at,
        due.claim_version,
        due.claim_token,
        due.claim_token,
        input.nowMs,
        input.nowMs
    );
    if (sql.changes() !== 1) return null;
    let decoded: unknown;
    try {
        decoded = JSON.parse(due.rows_json);
    } catch (cause) {
        throw gatewayInvalidationInvariant("staged Gateway snapshot rows are not valid JSON", cause);
    }
    const rows = rawJsonResult(decoded, "staged Gateway snapshot rows");
    if (!Array.isArray(rows)) throw gatewayInvalidationInvariant("staged Gateway snapshot rows are not an array");
    return {
        principalId: PrincipalId(due.principal_id),
        clientId: ClientId(due.client_id),
        subId: SubId(due.sub_id),
        registrationId: due.registration_id,
        connectionId: due.connection_id,
        cookie: Cookie(due.cookie),
        targetVersion: due.target_version,
        rows,
        byteSize: due.byte_size,
        sendAttempts: Math.min(due.send_attempts + 1, GATEWAY_CLEANUP_MAX_RETRY_COUNT),
        nextAttemptAt: input.attemptExpiresAt,
        claimToken,
        claimVersion,
        intentJson: due.intent_json,
        policyDigest: due.policy_digest,
    };
}

/** Clear one exact failed query run and retain its dirty target for a bounded retry. */
export function failGatewayDirtyRun(sql: SyncSql, input: GatewayDirtyRunFailure): boolean {
    assertGatewayRegistrationIdentity(input);
    if (input.runToken.length === 0) throw new TypeError("runToken must be nonempty");
    assertNonnegativeSafeInteger(input.runVersion, "runVersion");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const current = sql.one<{ retry_count: number }>(
        `SELECT g.retry_count
         FROM _gw_registration_generations g
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE g.registration_id = ? AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ?
           AND g.connection_id = ? AND g.lifecycle = 'active' AND g.cdb_state = 'active'
           AND g.run_token = ? AND g.run_version = ?`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.runToken,
        input.runVersion
    );
    if (!current) return false;
    const attempts = Math.min(current.retry_count + 1, GATEWAY_CLEANUP_MAX_RETRY_COUNT);
    const retryAt = input.nowMs + gatewayRetryDelayMs(attempts);
    const message = gatewayRetryError(input.error);
    sql.exec(
        `UPDATE _gw_registration_generations
         SET run_token = NULL, run_target_version = NULL, run_lease_expires_at = NULL,
             run_version = run_version + 1, retry_count = ?, retry_at = ?, retry_error = ?, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'active' AND cdb_state = 'active'
           AND run_token = ? AND run_version = ?
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        attempts,
        retryAt,
        message,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.runToken,
        input.runVersion
    );
    return sql.changes() === 1;
}

/** Release one exact failed send claim without changing its immutable payload or cookie. */
export function failGatewaySnapshotSend(sql: SyncSql, input: GatewaySnapshotSendFailure): boolean {
    if (input.registrationId.length === 0) throw new TypeError("registrationId must be nonempty");
    if (input.cookie.length === 0) throw new TypeError("cookie must be nonempty");
    if (input.claimToken.length === 0) throw new TypeError("claimToken must be nonempty");
    assertNonnegativeSafeInteger(input.claimVersion, "claimVersion");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const current = sql.one<{ send_attempts: number }>(
        `SELECT send_attempts FROM _gw_snapshot_outbox
         WHERE registration_id = ? AND cookie = ? AND claim_token = ? AND claim_version = ?`,
        input.registrationId,
        input.cookie,
        input.claimToken,
        input.claimVersion
    );
    if (!current) return false;
    const retryAt = input.nowMs + gatewayRetryDelayMs(Math.max(1, current.send_attempts));
    sql.exec(
        `UPDATE _gw_snapshot_outbox
         SET claim_token = NULL, claim_expires_at = NULL, next_attempt_at = ?, last_error = ?
         WHERE registration_id = ? AND cookie = ? AND claim_token = ? AND claim_version = ?`,
        retryAt,
        gatewayRetryError(input.error),
        input.registrationId,
        input.cookie,
        input.claimToken,
        input.claimVersion
    );
    return sql.changes() === 1;
}

/** Bind one exact send claim to the socket cookie observed immediately before send. */
export function markGatewaySnapshotSendBaseCookie(
    sql: SyncSql,
    input: GatewaySnapshotSendAttempt,
    baseCookie: Cookie | null,
    nowMs: number
): "marked" | "retired" | "stale" {
    assertNonnegativeSafeInteger(nowMs, "nowMs");
    sql.exec(
        `UPDATE _gw_snapshot_outbox
         SET attachment_base_cookie = COALESCE(attachment_base_cookie, ?)
         WHERE registration_id = ? AND cookie = ? AND claim_token = ? AND claim_version = ?
           AND EXISTS (
             SELECT 1
             FROM _gw_registration_generations g
             INNER JOIN _gw_registration_heads h
               ON h.registration_id = g.registration_id
              AND h.principal_id = g.principal_id
              AND h.client_id = g.client_id
              AND h.sub_id = g.sub_id
             WHERE g.registration_id = _gw_snapshot_outbox.registration_id
               AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ? AND g.connection_id = ?
               AND g.lifecycle = 'active' AND g.cdb_state = 'active'
           )`,
        baseCookie,
        input.registrationId,
        input.cookie,
        input.claimToken,
        input.claimVersion,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (sql.changes() !== 1) return "stale";
    if (gatewayDurablePayloadUsage(sql).chargedTotalBytes <= GATEWAY_MAX_DURABLE_PAYLOAD_BYTES) return "marked";
    if (
        !retireClaimedGatewaySnapshot(sql, {
            ...input,
            nowMs,
        })
    ) {
        throw gatewayInvalidationInvariant("over-quota Gateway snapshot claimant could not retire atomically");
    }
    return "retired";
}

/** Resolve a staged cookie only within one verified socket identity. */
export function resolveGatewaySnapshotAck(
    sql: SyncSql,
    input: GatewaySnapshotAckLookup
): GatewaySnapshotAckIdentity | null {
    if (input.connectionId.length === 0) throw new TypeError("connectionId must be nonempty");
    if (input.cookie.length === 0) throw new TypeError("cookie must be nonempty");
    const staged = sql.one<{
        registration_id: string;
        sub_id: number;
        already_acknowledged: number;
        attachment_base_cookie: string | null;
    }>(
        `SELECT g.registration_id, g.sub_id,
                CASE WHEN o.registration_id IS NULL THEN 1 ELSE 0 END AS already_acknowledged,
                o.attachment_base_cookie
         FROM _gw_registration_generations g
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         LEFT JOIN _gw_snapshot_outbox o ON o.registration_id = g.registration_id
         WHERE g.principal_id = ? AND g.client_id = ? AND g.connection_id = ?
           AND g.lifecycle = 'active' AND g.cdb_state = 'active'
           AND (
             (o.cookie = ? AND o.send_attempts > 0 AND o.last_sent_at IS NOT NULL AND o.claim_token IS NOT NULL)
             OR (o.registration_id IS NULL AND g.last_snapshot_cookie = ?)
           )`,
        input.principalId,
        input.clientId,
        input.connectionId,
        input.cookie,
        input.cookie
    );
    if (!staged) return null;
    return {
        principalId: input.principalId,
        clientId: input.clientId,
        subId: SubId(staged.sub_id),
        registrationId: staged.registration_id,
        connectionId: input.connectionId,
        cookie: input.cookie,
        alreadyAcknowledged: staged.already_acknowledged === 1,
        attachmentBaseCookie: staged.attachment_base_cookie === null ? null : Cookie(staged.attachment_base_cookie),
    };
}

/** Advance delivery only to the version owned by one exact staged cookie. The caller must use one transaction. */
export function acknowledgeGatewaySnapshot(sql: SyncSql, input: GatewaySnapshotAcknowledge): boolean {
    assertGatewayRegistrationIdentity(input);
    if (input.cookie.length === 0) throw new TypeError("cookie must be nonempty");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const staged = sql.one<{ target_version: number }>(
        `SELECT o.target_version
         FROM _gw_snapshot_outbox o
         INNER JOIN _gw_registration_generations g ON g.registration_id = o.registration_id
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE o.registration_id = ? AND o.cookie = ?
           AND o.send_attempts > 0 AND o.last_sent_at IS NOT NULL AND o.claim_token IS NOT NULL
           AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ? AND g.connection_id = ?
           AND g.lifecycle = 'active' AND g.cdb_state = 'active'`,
        input.registrationId,
        input.cookie,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    if (!staged) {
        return Boolean(
            sql.one<{ registration_id: string }>(
                `SELECT g.registration_id
                 FROM _gw_registration_generations g
                 INNER JOIN _gw_registration_heads h
                   ON h.registration_id = g.registration_id
                  AND h.principal_id = g.principal_id
                  AND h.client_id = g.client_id
                  AND h.sub_id = g.sub_id
                 WHERE g.registration_id = ? AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ?
                   AND g.connection_id = ? AND g.lifecycle = 'active' AND g.cdb_state = 'active'
                   AND g.last_snapshot_cookie = ?`,
                input.registrationId,
                input.principalId,
                input.clientId,
                input.subId,
                input.connectionId,
                input.cookie
            )
        );
    }
    sql.exec(
        `UPDATE _gw_registration_generations
         SET delivered_version = MAX(delivered_version, ?), initial_snapshot_pending = 0,
             last_cookie = ?, last_snapshot_cookie = ?, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND connection_id = ? AND lifecycle = 'active' AND cdb_state = 'active'
           AND delivered_version <= ? AND dirty_version >= ?
           AND EXISTS (
             SELECT 1 FROM _gw_registration_heads h
             WHERE h.registration_id = _gw_registration_generations.registration_id
               AND h.principal_id = _gw_registration_generations.principal_id
               AND h.client_id = _gw_registration_generations.client_id
               AND h.sub_id = _gw_registration_generations.sub_id
           )`,
        staged.target_version,
        input.cookie,
        input.cookie,
        input.nowMs,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        staged.target_version,
        staged.target_version
    );
    if (sql.changes() !== 1) return false;
    sql.exec(
        "DELETE FROM _gw_snapshot_outbox WHERE registration_id = ? AND cookie = ? AND target_version = ?",
        input.registrationId,
        input.cookie,
        staged.target_version
    );
    if (sql.changes() !== 1) {
        throw gatewayInvalidationInvariant("staged Gateway snapshot disappeared during acknowledgement");
    }
    sql.exec(
        `DELETE FROM _gw_snapshot_replay
         WHERE principal_id = ? AND client_id = ? AND sub_id = ?`,
        input.principalId,
        input.clientId,
        input.subId
    );
    assertGatewayDurablePayloadQuota(sql);
    return true;
}

/** Remove expired or oldest replay rows until both hard retention bounds hold. */
export function pruneGatewaySnapshotReplays(sql: SyncSql, nowMs: number): number {
    assertNonnegativeSafeInteger(nowMs, "nowMs");
    let removed = 0;
    sql.exec("DELETE FROM _gw_snapshot_replay WHERE expires_at <= ?", nowMs);
    removed += sql.changes();
    sql.exec(
        `DELETE FROM _gw_snapshot_replay
         WHERE rowid IN (
           SELECT rowid FROM _gw_snapshot_replay
           ORDER BY created_at DESC, principal_id DESC, client_id DESC, sub_id DESC
           LIMIT -1 OFFSET ?
         )`,
        GATEWAY_MAX_SNAPSHOT_REPLAY_ROWS
    );
    removed += sql.changes();
    while (gatewayDurablePayloadUsage(sql).chargedTotalBytes > GATEWAY_MAX_DURABLE_PAYLOAD_BYTES) {
        sql.exec(
            `DELETE FROM _gw_snapshot_replay
             WHERE rowid = (
               SELECT rowid FROM _gw_snapshot_replay
               ORDER BY created_at, principal_id, client_id, sub_id
               LIMIT 1
             )`
        );
        const changed = sql.changes();
        removed += changed;
        if (changed === 0) break;
    }
    return removed;
}

/**
 * Retain the latest snapshot that was handed to the transport for one logical
 * subscription. The original send timestamp fixes the retention deadline, so
 * repeated reconnects cannot extend it.
 */
export function retainCurrentGatewaySnapshotReplay(
    sql: SyncSql,
    key: GatewayRegistrationKey,
    nowMs: number,
    deferPrune = false
): boolean {
    assertGatewayRegistrationKey(key);
    assertNonnegativeSafeInteger(nowMs, "nowMs");
    sql.exec(
        `INSERT INTO _gw_snapshot_replay
         (principal_id, client_id, sub_id, cookie, organization_id, ref, args_json,
          policy_digest, query_hash, shard_id, source_cdb_id, schema_epoch, domain_schema_epoch,
          auth_global_epoch, auth_tenant_epoch, auth_principal_epoch,
          rows_json, byte_size, created_at, expires_at)
         SELECT g.principal_id, g.client_id, g.sub_id, o.cookie, g.organization_id, g.ref, g.args_json,
                g.policy_digest, g.query_hash, g.shard_id, g.source_cdb_id, g.schema_epoch,
                g.domain_schema_epoch, g.auth_global_epoch, g.auth_tenant_epoch, g.auth_principal_epoch,
                o.rows_json, o.byte_size, o.last_sent_at, o.last_sent_at + ?
         FROM _gw_registration_generations g
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         INNER JOIN _gw_snapshot_outbox o ON o.registration_id = g.registration_id
         WHERE g.principal_id = ? AND g.client_id = ? AND g.sub_id = ?
           AND g.lifecycle = 'active' AND g.cdb_state = 'active'
           AND o.send_attempts > 0 AND o.last_sent_at IS NOT NULL AND o.claim_token IS NOT NULL
           AND o.last_sent_at + ? > ?
         ON CONFLICT (principal_id, client_id, sub_id) DO UPDATE SET
           cookie = excluded.cookie,
           organization_id = excluded.organization_id,
           ref = excluded.ref,
           args_json = excluded.args_json,
           policy_digest = excluded.policy_digest,
           query_hash = excluded.query_hash,
           shard_id = excluded.shard_id,
           source_cdb_id = excluded.source_cdb_id,
           schema_epoch = excluded.schema_epoch,
           domain_schema_epoch = excluded.domain_schema_epoch,
           auth_global_epoch = excluded.auth_global_epoch,
           auth_tenant_epoch = excluded.auth_tenant_epoch,
           auth_principal_epoch = excluded.auth_principal_epoch,
           rows_json = excluded.rows_json,
           byte_size = excluded.byte_size,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at
         WHERE excluded.created_at >= _gw_snapshot_replay.created_at`,
        GATEWAY_SNAPSHOT_REPLAY_RETENTION_MS,
        key.principalId,
        key.clientId,
        key.subId,
        GATEWAY_SNAPSHOT_REPLAY_RETENTION_MS,
        nowMs
    );
    const retained = sql.changes() === 1;
    if (!deferPrune) pruneGatewaySnapshotReplays(sql, nowMs);
    return retained;
}

/** Resolve replay only when the resumed transport and current authority describe the exact old query. */
export function resolveGatewaySnapshotReplay(
    sql: SyncSql,
    input: GatewaySnapshotReplayLookup
): GatewaySnapshotReplay | null {
    assertGatewayRegistrationKey(input);
    if (input.cookie.length === 0) throw new TypeError("cookie must be nonempty");
    assertNonnegativeSafeInteger(input.schemaEpoch, "schemaEpoch");
    assertNonnegativeSafeInteger(input.domainSchemaEpoch, "domainSchemaEpoch");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    pruneGatewaySnapshotReplays(sql, input.nowMs);
    const replay = sql.one<{ rows_json: string }>(
        `SELECT rows_json FROM _gw_snapshot_replay
         WHERE principal_id = ? AND client_id = ? AND sub_id = ? AND cookie = ?
           AND organization_id = ? AND ref = ? AND args_json = ?
           AND policy_digest = ? AND query_hash = ? AND shard_id = ? AND source_cdb_id = ?
           AND schema_epoch = ? AND domain_schema_epoch = ?
           AND auth_global_epoch = ? AND auth_tenant_epoch = ? AND auth_principal_epoch = ?
           AND expires_at > ?`,
        input.principalId,
        input.clientId,
        input.subId,
        input.cookie,
        input.organizationId,
        input.ref,
        stableJson(input.args),
        input.policyDigest,
        input.queryHash,
        input.shardId,
        input.sourceCdbId,
        input.schemaEpoch,
        input.domainSchemaEpoch,
        input.authEpochs.global,
        input.authEpochs.tenant,
        input.authEpochs.principal,
        input.nowMs
    );
    if (!replay) return null;
    try {
        const rows = rawJsonResult(JSON.parse(replay.rows_json), "Gateway replay snapshot rows");
        if (!Array.isArray(rows)) throw new TypeError("Gateway replay snapshot rows must be an array");
        return { subId: input.subId, cookie: input.cookie, rows };
    } catch {
        sql.exec(
            `DELETE FROM _gw_snapshot_replay
             WHERE principal_id = ? AND client_id = ? AND sub_id = ? AND cookie = ?`,
            input.principalId,
            input.clientId,
            input.subId,
            input.cookie
        );
        return null;
    }
}

/** Consume one exact replay cookie after a verified replacement socket acknowledges it. */
export function acknowledgeGatewaySnapshotReplay(
    sql: SyncSql,
    input: Pick<GatewaySnapshotReplayLookup, "principalId" | "clientId" | "cookie" | "nowMs">
): SubId | null {
    assertGatewayRegistrationKey({ principalId: input.principalId, clientId: input.clientId, subId: SubId(0) });
    if (input.cookie.length === 0) throw new TypeError("cookie must be nonempty");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    pruneGatewaySnapshotReplays(sql, input.nowMs);
    const replay = sql.one<{ sub_id: number }>(
        `SELECT sub_id FROM _gw_snapshot_replay
         WHERE principal_id = ? AND client_id = ? AND cookie = ? AND expires_at > ?
         ORDER BY sub_id LIMIT 1`,
        input.principalId,
        input.clientId,
        input.cookie,
        input.nowMs
    );
    if (!replay) return null;
    sql.exec(
        `DELETE FROM _gw_snapshot_replay
         WHERE principal_id = ? AND client_id = ? AND sub_id = ? AND cookie = ?`,
        input.principalId,
        input.clientId,
        replay.sub_id,
        input.cookie
    );
    return sql.changes() === 1 ? SubId(replay.sub_id) : null;
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
         SET ${GATEWAY_RETIRED_PAYLOAD_ASSIGNMENTS},
             lifecycle = 'retiring',
             cdb_state = CASE WHEN cdb_state = 'pending' THEN 'pending' ELSE 'retiring' END,
             run_token = NULL, run_target_version = NULL,
             run_lease_expires_at = NULL,
             run_version = run_version + 1, retry_count = 0,
             retry_at = CASE WHEN cdb_state = 'pending' THEN retry_at ELSE ? END,
             retry_error = NULL, updated_at = ?
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
    sql.exec("DELETE FROM _gw_snapshot_outbox WHERE registration_id = ?", current.registration_id);
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
        retainCurrentGatewaySnapshotReplay(sql, registration, nowMs, true);
        const retired = retireCurrentGatewayRegistration(sql, { ...registration, nowMs });
        if (!retired || retired.registrationId !== registration.registrationId) {
            throw gatewayInvalidationInvariant("current Gateway registration changed during connection retirement");
        }
    }
    pruneGatewaySnapshotReplays(sql, nowMs);
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
         SET ${GATEWAY_RETIRED_PAYLOAD_ASSIGNMENTS},
             lifecycle = 'retiring',
             cdb_state = CASE WHEN cdb_state = 'pending' THEN 'pending' ELSE 'retiring' END,
             run_token = NULL, run_target_version = NULL,
             run_lease_expires_at = NULL,
             run_version = run_version + 1, retry_count = 0,
             retry_at = CASE WHEN cdb_state = 'pending' THEN retry_at ELSE ? END,
             retry_error = NULL, updated_at = ?
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?`,
        nowMs,
        nowMs,
        registrationId,
        key.principalId,
        key.clientId,
        key.subId
    );
    sql.exec("DELETE FROM _gw_snapshot_outbox WHERE registration_id = ?", registrationId);
    return true;
}

/** Retire only while one exact leased run still owns this current generation. */
export function retireClaimedGatewayRegistration(sql: SyncSql, input: GatewayClaimedRunRetire): boolean {
    assertGatewayRegistrationIdentity(input);
    if (input.runToken.length === 0) throw new TypeError("runToken must be nonempty");
    assertNonnegativeSafeInteger(input.runVersion, "runVersion");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const owned = sql.one<{ registration_id: string }>(
        `SELECT g.registration_id
         FROM _gw_registration_generations g
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE g.registration_id = ? AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ?
           AND g.connection_id = ? AND g.lifecycle = 'active' AND g.cdb_state = 'active'
           AND g.run_token = ? AND g.run_version = ?`,
        input.registrationId,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId,
        input.runToken,
        input.runVersion
    );
    return owned ? retireGatewayRegistration(sql, input, input.registrationId, input.nowMs) : false;
}

/** Retire only while one exact staged-send attempt still owns this generation. */
export function retireClaimedGatewaySnapshot(sql: SyncSql, input: GatewayClaimedSnapshotRetire): boolean {
    assertGatewayRegistrationIdentity(input);
    if (input.cookie.length === 0) throw new TypeError("cookie must be nonempty");
    if (input.claimToken.length === 0) throw new TypeError("claimToken must be nonempty");
    assertNonnegativeSafeInteger(input.claimVersion, "claimVersion");
    assertNonnegativeSafeInteger(input.nowMs, "nowMs");
    const owned = sql.one<{ registration_id: string }>(
        `SELECT g.registration_id
         FROM _gw_snapshot_outbox o
         INNER JOIN _gw_registration_generations g ON g.registration_id = o.registration_id
         INNER JOIN _gw_registration_heads h
           ON h.registration_id = g.registration_id
          AND h.principal_id = g.principal_id
          AND h.client_id = g.client_id
          AND h.sub_id = g.sub_id
         WHERE o.registration_id = ? AND o.cookie = ? AND o.claim_token = ? AND o.claim_version = ?
           AND g.principal_id = ? AND g.client_id = ? AND g.sub_id = ? AND g.connection_id = ?
           AND g.lifecycle = 'active' AND g.cdb_state = 'active'`,
        input.registrationId,
        input.cookie,
        input.claimToken,
        input.claimVersion,
        input.principalId,
        input.clientId,
        input.subId,
        input.connectionId
    );
    return owned ? retireGatewayRegistration(sql, input, input.registrationId, input.nowMs) : false;
}

/** Delete one retired cleanup row without touching any logical head. */
export function cleanupGatewayRegistration(sql: SyncSql, key: GatewayRegistrationKey, registrationId: string): boolean {
    sql.exec(
        `DELETE FROM _gw_registration_generations
         WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
           AND lifecycle = 'retiring' AND cdb_state = 'retiring'
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
        ["domainSchemaEpoch", input.domainSchemaEpoch],
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
        ["policyDigest", input.policyDigest],
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

function gatewayRetryDelayMs(attempts: number): number {
    const exponent = Math.max(0, Math.min(attempts - 1, GATEWAY_CLEANUP_MAX_RETRY_COUNT - 1));
    return Math.min(GATEWAY_CLEANUP_MAX_RETRY_MS, GATEWAY_CLEANUP_BASE_RETRY_MS * 2 ** exponent);
}

function gatewayRetryError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, GATEWAY_CLEANUP_MAX_ERROR_LENGTH);
}

export function ensureGatewayRegistrationColumns(sql: SyncSql): void {
    const columns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info('_gw_registration_generations')").map(column => column.name)
    );
    if (!columns.has("source_cdb_id")) {
        // Existing generations predate physical Cdb identity. A null source is
        // intentionally stale until that logical subscription is replaced.
        sql.exec("ALTER TABLE _gw_registration_generations ADD COLUMN source_cdb_id TEXT");
    }
    if (!columns.has("domain_schema_epoch")) {
        // Existing generations predate domain-version fencing. Retire them
        // below so no old registration can execute under an assumed epoch.
        sql.exec(
            "ALTER TABLE _gw_registration_generations ADD COLUMN domain_schema_epoch INTEGER CHECK (domain_schema_epoch IS NULL OR domain_schema_epoch > 0)"
        );
    }
    if (!columns.has("policy_digest")) {
        sql.exec("ALTER TABLE _gw_registration_generations ADD COLUMN policy_digest TEXT");
    }
    if (!columns.has("run_target_version")) {
        sql.exec(
            `ALTER TABLE _gw_registration_generations
             ADD COLUMN run_target_version INTEGER
             CHECK (run_target_version IS NULL OR (run_target_version >= 0 AND run_target_version <= dirty_version))`
        );
    }
    if (!columns.has("run_lease_expires_at")) {
        sql.exec(
            `ALTER TABLE _gw_registration_generations
             ADD COLUMN run_lease_expires_at INTEGER
             CHECK (run_lease_expires_at IS NULL OR run_lease_expires_at >= 0)`
        );
    }
    if (!columns.has("last_snapshot_cookie")) {
        sql.exec("ALTER TABLE _gw_registration_generations ADD COLUMN last_snapshot_cookie TEXT");
    }
    if (!columns.has("initial_snapshot_pending")) {
        sql.exec(
            `ALTER TABLE _gw_registration_generations
             ADD COLUMN initial_snapshot_pending INTEGER NOT NULL DEFAULT 0
             CHECK (initial_snapshot_pending IN (0, 1))`
        );
    }
    const currentColumns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info('_gw_registration_generations')").map(column => column.name)
    );
    const legacyRetiredPayloadAssignments = [
        ["organization_id", "organization_id = ''"],
        ["ref", "ref = ''"],
        ["args_json", "args_json = 'null'"],
        ["intent_json", "intent_json = 'null'"],
        ["policy_digest", "policy_digest = ''"],
        ["query_hash", "query_hash = ''"],
        ["shard_id", "shard_id = ''"],
        ["last_cookie", "last_cookie = NULL"],
        ["last_snapshot_cookie", "last_snapshot_cookie = NULL"],
    ]
        .filter(([column]) => currentColumns.has(column as string))
        .map(([, assignment]) => assignment)
        .join(", ");
    sql.exec(
        `DELETE FROM _gw_registration_heads
         WHERE registration_id IN (
           SELECT registration_id FROM _gw_registration_generations
           WHERE policy_digest IS NULL OR domain_schema_epoch IS NULL
         )`
    );
    sql.exec(
        `DELETE FROM _gw_snapshot_outbox
         WHERE registration_id IN (
           SELECT registration_id FROM _gw_registration_generations
           WHERE policy_digest IS NULL OR domain_schema_epoch IS NULL
         )`
    );
    sql.exec(
        `UPDATE _gw_registration_generations
         SET ${legacyRetiredPayloadAssignments},
             lifecycle = 'retiring', cdb_state = 'retiring', run_token = NULL,
             run_target_version = NULL, run_lease_expires_at = NULL,
             run_version = run_version + 1, retry_count = 0,
             retry_at = updated_at, retry_error = NULL
         WHERE (policy_digest IS NULL OR domain_schema_epoch IS NULL) AND lifecycle != 'retiring'`
    );
    // Legacy retired generations can predate payload compaction. Keep only
    // the exact identity needed for idempotent Cdb unsubscribe and deletion.
    sql.exec(
        `DELETE FROM _gw_snapshot_outbox
         WHERE registration_id IN (
           SELECT registration_id FROM _gw_registration_generations WHERE lifecycle = 'retiring'
         )`
    );
    sql.exec(
        `UPDATE _gw_registration_generations
         SET ${legacyRetiredPayloadAssignments},
             run_token = NULL, run_target_version = NULL, run_lease_expires_at = NULL,
             retry_error = NULL
         WHERE lifecycle = 'retiring'`
    );
    sql.exec(
        `UPDATE _gw_registration_generations
         SET retry_at = updated_at + ?, retry_error = 'subscription install recovery'
         WHERE cdb_state = 'pending' AND retry_at IS NULL`,
        GATEWAY_SUBSCRIBE_RECOVERY_MS
    );
    // Run this after every restart. A crash after ALTER but before repair must
    // not leave a partial run triple that no claimant can recover.
    sql.exec(
        `UPDATE _gw_registration_generations
         SET run_token = NULL, run_target_version = NULL,
             run_lease_expires_at = NULL, run_version = run_version + 1
         WHERE NOT (
           (run_token IS NULL AND run_target_version IS NULL AND run_lease_expires_at IS NULL)
           OR
           (run_token IS NOT NULL AND run_target_version IS NOT NULL AND run_lease_expires_at IS NOT NULL)
         )`
    );
}

function ensureGatewaySnapshotOutboxColumns(sql: SyncSql): void {
    const columns = new Set(sql.all<{ name: string }>("PRAGMA table_info('_gw_snapshot_outbox')").map(row => row.name));
    const additions = [
        ["claim_token", "claim_token TEXT"],
        ["claim_version", "claim_version INTEGER NOT NULL DEFAULT 0"],
        ["claim_expires_at", "claim_expires_at INTEGER"],
        ["attachment_base_cookie", "attachment_base_cookie TEXT"],
    ] as const;
    for (const [name, definition] of additions) {
        if (!columns.has(name)) sql.exec(`ALTER TABLE _gw_snapshot_outbox ADD COLUMN ${definition}`);
    }
    sql.exec(
        `UPDATE _gw_snapshot_outbox
         SET claim_token = NULL, claim_expires_at = NULL, claim_version = claim_version + 1
         WHERE (claim_token IS NULL) <> (claim_expires_at IS NULL)
            OR (claim_token IS NOT NULL AND claim_version = 0)`
    );
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
    const resolver = request.catalog.resolveJwk
        ? createCatalogOwnedJwksResolver(
              { resolveJwk: value => (request.catalog.resolveJwk as NonNullable<CatalogJwksRpc["resolveJwk"]>)(value) },
              jwksUrl
          )
        : createCatalogJwksResolver({ catalog: request.catalog, jwksUrl });
    const claims = await verifyJwt(request.jwt, {
        resolver,
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
    const principalId = request.principalId;
    const mutId = request.mutId;
    const ref = request.ref;
    let rawArgs: RawJson;
    try {
        rawArgs = snapshotCdbMutationArgs(request.args);
    } catch (error) {
        return mutationFailure(
            error instanceof CdbError ? error.code : "CDB_INVARIANT",
            error instanceof Error ? error.message : "mutation argument sizing failed"
        );
    }
    let routed: MutationRouteResponse;
    try {
        routed = deps.routeMutation({ ref, args: rawArgs });
    } catch {
        return mutationFailure("CDB_INVARIANT", "local mutation routing failed");
    }
    if (!routed.ok) return routed;
    const routeAuthority = routed.authority;
    const partitionKey = routed.partitionKey;
    const vshard = routed.vshard;
    let routedArgs: RawJson;
    try {
        routedArgs = snapshotCdbMutationArgs(routed.args);
    } catch (error) {
        return mutationFailure(
            error instanceof CdbError ? error.code : "CDB_INVARIANT",
            error instanceof Error ? error.message : "routed mutation argument sizing failed"
        );
    }
    if (!Number.isSafeInteger(vshard) || vshard < 0 || vshard >= VSHARD_COUNT) {
        return mutationFailure("CDB_INVARIANT", "local mutation routing returned an invalid vshard");
    }
    if (routeAuthority !== "organization") {
        return mutationFailure("CDB_AUTH_NOT_BOUND", "mutation has no declared organization authority");
    }
    if (typeof partitionKey !== "string" || partitionKey.length === 0) {
        return mutationFailure("CDB_INVALID_ARGS", "organization mutation has no organization partition key");
    }

    let authority: Awaited<ReturnType<CatalogOrganizationAuthorityRpc["resolveOrganizationAuthority"]>>;
    try {
        authority = await deps.catalog.resolveOrganizationAuthority({
            principalId,
            organizationId: TenantId(partitionKey),
        });
    } catch {
        return mutationFailure("CDB_CATALOG_UNAVAILABLE", "Catalog organization authority RPC failed");
    }
    const projected = projectOrganizationMutationAuth(authority, {
        principalId,
        organizationId: TenantId(partitionKey),
    });
    if (!projected.ok) return mutationFailure(projected.code, projected.message);
    // This Catalog read is the authorization linearization point. A later
    // revocation blocks the next dispatch but does not cancel this in-flight
    // shard call; Cdb does not revalidate membership epochs yet.

    let location: Awaited<ReturnType<CatalogMutationRpc["route"]>>;
    try {
        location = await deps.catalog.route(vshard);
    } catch {
        return mutationFailure("CDB_CATALOG_UNAVAILABLE", "Catalog routing RPC failed");
    }
    if (
        typeof location.shardId !== "string" ||
        location.shardId.length === 0 ||
        !Number.isSafeInteger(location.schemaEpoch) ||
        location.schemaEpoch < 0 ||
        !Number.isSafeInteger(location.domainSchemaEpoch) ||
        location.domainSchemaEpoch < 1
    ) {
        return mutationFailure("CDB_CATALOG_UNAVAILABLE", "Catalog returned a malformed shard route");
    }

    try {
        const response = await deps.cdb(location.shardId).mutate({
            principalId,
            mutId,
            ref,
            args: routedArgs,
            auth: projected.auth,
            schemaEpoch: location.schemaEpoch,
            domainSchemaEpoch: location.domainSchemaEpoch,
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
    private static readonly MAX_UNSETTLED_MUTATIONS_PER_CONNECTION = 32;
    private static readonly MAX_UNSETTLED_MUTATIONS = 256;

    private bootstrapped = false;
    private alarmScheduler: Promise<void> = Promise.resolve();
    private readonly authOperationClaims = new Map<string, object>();
    private readonly authRefreshBarriers = new Map<string, Promise<boolean>>();
    private readonly activeOperations = new Map<string, Set<Promise<void>>>();
    private readonly pendingSubscriptions = new Map<string, PendingSubscription>();
    private readonly unsettledMutationsByConnection = new Map<string, number>();
    private unsettledMutationCount = 0;

    constructor(state: DurableObjectState, env: GatewayEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    protected runtimeManifest(): ChardbManifest {
        return emptyManifest();
    }

    protected runtimePolicyDigest(tableNames: readonly string[]): string | null {
        void tableNames;
        return null;
    }

    private currentGatewayPolicyDigest(intentJson: string): string | null {
        try {
            const intent = JSON.parse(intentJson) as { readonly tables?: unknown };
            if (!Array.isArray(intent.tables) || !intent.tables.every(table => typeof table === "string")) {
                throw new TypeError("persisted Gateway query intent has invalid tables");
            }
            return this.runtimePolicyDigest(intent.tables);
        } catch {
            return "";
        }
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
        return resolveQueryRoute(this.runtimeManifest(), request, tables => {
            const digest = this.runtimePolicyDigest(tables);
            if (digest === null) {
                throw new CdbError({ code: "CDB_INVARIANT", message: "Gateway query policy schema is unavailable" });
            }
            return digest;
        });
    }

    protected gatewayNowMs(): number {
        return Date.now();
    }

    private serializeGatewayAlarmOperation<T>(operation: () => Promise<T>): Promise<T> {
        const scheduled = this.alarmScheduler.then(operation);
        this.alarmScheduler = scheduled.then(
            () => {},
            () => {}
        );
        return scheduled;
    }

    /** Serialize every Gateway alarm write and preserve any earlier durable deadline. */
    protected scheduleGatewayAlarm(requestedAt: number): Promise<void> {
        assertNonnegativeSafeInteger(requestedAt, "requestedAt");
        return this.serializeGatewayAlarmOperation(async () => {
            const current = await this.ctx.storage.getAlarm();
            if (current === null || requestedAt < current) {
                await this.ctx.storage.setAlarm(requestedAt);
            }
        });
    }

    private dueGatewayRunCandidates(nowMs: number): readonly StoredGatewayRunCandidate[] {
        return adaptSqlStorage(this.ctx.storage.sql).all<StoredGatewayRunCandidate>(
            `SELECT g.principal_id, g.client_id, g.sub_id, g.registration_id, g.connection_id
             FROM _gw_registration_generations g
             INNER JOIN _gw_registration_heads h
               ON h.registration_id = g.registration_id
              AND h.principal_id = g.principal_id
              AND h.client_id = g.client_id
              AND h.sub_id = g.sub_id
             WHERE g.lifecycle = 'active' AND g.cdb_state = 'active'
               AND g.source_cdb_id IS NOT NULL AND g.source_cdb_id <> ''
           AND (g.initial_snapshot_pending = 1 OR g.dirty_version > g.delivered_version)
               AND (g.retry_at IS NULL OR g.retry_at <= ?)
               AND NOT EXISTS (
                 SELECT 1 FROM _gw_snapshot_outbox o WHERE o.registration_id = g.registration_id
               )
               AND (
                 (g.run_token IS NULL AND g.run_target_version IS NULL AND g.run_lease_expires_at IS NULL)
                 OR
                 (g.run_token IS NOT NULL AND g.run_target_version IS NOT NULL
                  AND g.run_lease_expires_at IS NOT NULL AND g.run_lease_expires_at <= ?)
               )
             ORDER BY COALESCE(g.retry_at, 0), g.registration_id
             LIMIT ?`,
            nowMs,
            nowMs,
            GATEWAY_QUERY_BATCH_SIZE
        );
    }

    private dueGatewayInstallRecoveries(nowMs: number): readonly StoredGatewayInstallRecovery[] {
        return adaptSqlStorage(this.ctx.storage.sql).all<StoredGatewayInstallRecovery>(
            `SELECT g.principal_id, g.client_id, g.sub_id, g.registration_id, g.connection_id
             FROM _gw_registration_generations g
             WHERE g.cdb_state = 'pending'
               AND g.lifecycle IN ('installing', 'retiring')
               AND g.retry_at IS NOT NULL AND g.retry_at <= ?
             ORDER BY g.retry_at, g.registration_id
             LIMIT ?`,
            nowMs,
            GATEWAY_QUERY_BATCH_SIZE
        );
    }

    private exactGatewaySocket(
        identity: GatewayRegistrationKey & { readonly connectionId: string },
        nowMs: number
    ): ExactGatewaySocket {
        if (this.authRefreshBarriers.has(identity.connectionId)) return { status: "refreshing" };
        const matching = this.ctx.getWebSockets().filter(ws => {
            const attachment = ws.deserializeAttachment() as GwAttachment | null;
            return attachment?.connectionId === identity.connectionId;
        });
        if (matching.length !== 1) return { status: "terminal" };
        const ws = matching[0];
        if (!ws) return { status: "terminal" };
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        if (
            !isVerifiedAttachment(attachment) ||
            !isCurrentVerifiedAttachment(attachment, Math.floor(nowMs / 1_000)) ||
            attachment.connectionId !== identity.connectionId ||
            attachment.principalId !== identity.principalId ||
            attachment.clientId !== identity.clientId ||
            !attachment.snapshotSubIds?.includes(identity.subId)
        ) {
            return { status: "terminal" };
        }
        return { status: "ready", ws, attachment };
    }

    private trackGatewayTask(connectionId: string, task: Promise<void>): Promise<void> {
        let active = this.activeOperations.get(connectionId);
        if (!active) {
            active = new Set();
            this.activeOperations.set(connectionId, active);
        }
        active.add(task);
        const cleanup = () => {
            active?.delete(task);
            if (active?.size === 0) this.activeOperations.delete(connectionId);
        };
        void task.then(cleanup, cleanup);
        return task;
    }

    private retireGatewayRunnerRegistration(
        identity: GatewayRegistrationKey & { readonly registrationId: string; readonly connectionId: string },
        nowMs: number,
        run?: GatewayDirtyRun
    ): boolean {
        return this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            return run
                ? retireClaimedGatewayRegistration(sql, {
                      ...identity,
                      runToken: run.runToken,
                      runVersion: run.runVersion,
                      nowMs,
                  })
                : retireGatewayRegistration(sql, identity, identity.registrationId, nowMs);
        });
    }

    private settleRetiredGatewaySubscription(
        identity: GatewayRegistrationKey & { readonly connectionId: string },
        settlement:
            | { readonly kind: "error"; readonly code: import("../../errors.ts").CdbErrorCode }
            | { readonly kind: "refetch"; readonly reason: "shardsChanged" }
    ): void {
        const current = this.exactGatewaySocket(identity, this.gatewayNowMs());
        if (current.status !== "ready") return;
        current.ws.serializeAttachment({
            ...current.attachment,
            snapshotSubIds: (current.attachment.snapshotSubIds ?? []).filter(subId => subId !== identity.subId),
        } satisfies VerifiedGwAttachment);
        if (settlement.kind === "refetch") {
            this.send(current.ws, { t: "mustRefetch", subIds: [identity.subId], reason: settlement.reason });
            return;
        }
        this.sendError(current.ws, settlement.code, identity.subId);
    }

    private retireGatewaySnapshotAttempt(attempt: GatewaySnapshotSendAttempt, nowMs: number): boolean {
        return this.ctx.storage.transactionSync(() =>
            retireClaimedGatewaySnapshot(adaptSqlStorage(this.ctx.storage.sql), {
                ...attempt,
                nowMs,
            })
        );
    }

    private async settleGatewayQueryFailure(
        candidate: StoredGatewayRunCandidate,
        run: GatewayDirtyRun,
        nowMs: number,
        error: unknown
    ): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            failGatewayDirtyRun(adaptSqlStorage(this.ctx.storage.sql), {
                principalId: PrincipalId(candidate.principal_id),
                clientId: ClientId(candidate.client_id),
                subId: SubId(candidate.sub_id),
                registrationId: candidate.registration_id,
                connectionId: candidate.connection_id,
                runToken: run.runToken,
                runVersion: run.runVersion,
                nowMs,
                error,
            });
        });
        await this.scheduleGatewayWork(nowMs);
    }

    private async runGatewayQueryCandidate(candidate: StoredGatewayRunCandidate, nowMs: number): Promise<void> {
        const identity = {
            principalId: PrincipalId(candidate.principal_id),
            clientId: ClientId(candidate.client_id),
            subId: SubId(candidate.sub_id),
            registrationId: candidate.registration_id,
            connectionId: candidate.connection_id,
        };
        const initialSocket = this.exactGatewaySocket(identity, nowMs);
        if (initialSocket.status === "refreshing") return;
        if (initialSocket.status === "terminal") {
            if (this.retireGatewayRunnerRegistration(identity, nowMs)) {
                await this.scheduleGatewayWork(nowMs).catch(() => {});
            }
            return;
        }
        await this.scheduleGatewayAlarm(nowMs + GATEWAY_QUERY_LEASE_MS);
        const claimNowMs = this.gatewayNowMs();
        const claimSocket = this.exactGatewaySocket(identity, claimNowMs);
        if (claimSocket.status === "refreshing") return;
        if (claimSocket.status === "terminal") {
            if (this.retireGatewayRunnerRegistration(identity, claimNowMs)) {
                await this.scheduleGatewayWork(claimNowMs).catch(() => {});
            }
            return;
        }
        const run = this.ctx.storage.transactionSync(() =>
            claimDirtyGatewayRegistration(adaptSqlStorage(this.ctx.storage.sql), {
                ...identity,
                nowMs: claimNowMs,
                leaseExpiresAt: claimNowMs + GATEWAY_QUERY_LEASE_MS,
            })
        );
        if (!run) return;

        try {
            const currentPolicyDigest = this.currentGatewayPolicyDigest(run.intentJson);
            if (currentPolicyDigest !== null && currentPolicyDigest !== run.policyDigest) {
                const retiredAt = this.gatewayNowMs();
                const retired = this.retireGatewayRunnerRegistration(identity, retiredAt, run);
                if (retired) {
                    this.settleRetiredGatewaySubscription(identity, { kind: "error", code: "CDB_INVARIANT" });
                    await this.scheduleGatewayWork(retiredAt).catch(() => {});
                }
                return;
            }

            const catalog = this.catalog() as CatalogRoutingRpc & CatalogOrganizationAuthorityRpc;
            const authority = await catalog.resolveOrganizationAuthority({
                principalId: identity.principalId,
                organizationId: run.organizationId,
            });
            const projected = projectOrganizationMutationAuth(authority, {
                principalId: identity.principalId,
                organizationId: run.organizationId,
            });
            if (!projected.ok) {
                if (projected.code === "CDB_FORBIDDEN") {
                    const retiredAt = this.gatewayNowMs();
                    const retired = this.retireGatewayRunnerRegistration(identity, retiredAt, run);
                    if (retired) {
                        this.settleRetiredGatewaySubscription(identity, { kind: "error", code: projected.code });
                        await this.scheduleGatewayWork(retiredAt).catch(() => {});
                    }
                } else {
                    await this.settleGatewayQueryFailure(candidate, run, this.gatewayNowMs(), projected.message);
                }
                return;
            }

            const route = await catalog.route(Number(vshardOf([run.organizationId])));
            if (
                typeof route?.shardId !== "string" ||
                route.shardId.length === 0 ||
                !Number.isSafeInteger(route.domainSchemaEpoch) ||
                route.domainSchemaEpoch < 1
            ) {
                throw new TypeError("Catalog returned a malformed shard route");
            }
            const routedPhysicalId = this.env.CDB_SHARD.idFromName(route.shardId).toString();
            if (routedPhysicalId !== run.sourceCdbId || route.domainSchemaEpoch !== run.domainSchemaEpoch) {
                const retiredAt = this.gatewayNowMs();
                const retired = this.retireGatewayRunnerRegistration(identity, retiredAt, run);
                if (retired) {
                    this.settleRetiredGatewaySubscription(identity, { kind: "refetch", reason: "shardsChanged" });
                    await this.scheduleGatewayWork(retiredAt).catch(() => {});
                }
                return;
            }
            const sourceId = this.env.CDB_SHARD.idFromString(run.sourceCdbId);
            const cdb = this.env.CDB_SHARD.get(sourceId) as unknown as CdbRegisteredQueryRpc;
            const response = projectCdbQueryRows(
                await cdb.queryRegistered({
                    subscription: {
                        gatewayId: this.ctx.id.toString(),
                        registrationId: identity.registrationId,
                        connectionId: identity.connectionId,
                        clientId: identity.clientId,
                        subId: identity.subId,
                    },
                    auth: projected.auth,
                    domainSchemaEpoch: route.domainSchemaEpoch,
                })
            );
            if (!response.ok) {
                if (isTerminalRegisteredQueryFailure(response.error.code)) {
                    const retiredAt = this.gatewayNowMs();
                    const retired = this.retireGatewayRunnerRegistration(identity, retiredAt, run);
                    if (retired) {
                        this.settleRetiredGatewaySubscription(identity, {
                            kind: "error",
                            code: response.error.code,
                        });
                        await this.scheduleGatewayWork(retiredAt).catch(() => {});
                    }
                } else {
                    await this.settleGatewayQueryFailure(candidate, run, this.gatewayNowMs(), response.error.message);
                }
                return;
            }

            const settledAt = this.gatewayNowMs();
            const currentSocket = this.exactGatewaySocket(identity, settledAt);
            if (currentSocket.status === "refreshing") {
                await this.settleGatewayQueryFailure(candidate, run, settledAt, "authentication refresh is in flight");
                return;
            }
            if (currentSocket.status === "terminal") {
                if (this.retireGatewayRunnerRegistration(identity, settledAt, run)) {
                    await this.scheduleGatewayWork(settledAt).catch(() => {});
                }
                return;
            }
            const authEpochs = projected.auth.authEpochs;
            if (!authEpochs) {
                await this.settleGatewayQueryFailure(
                    candidate,
                    run,
                    settledAt,
                    "Catalog authority omitted auth epochs"
                );
                return;
            }
            const cookie = Cookie(`${identity.clientId}:${run.targetVersion}:${crypto.randomUUID()}`);
            const staged = this.ctx.storage.transactionSync(() =>
                stageGatewaySnapshot(adaptSqlStorage(this.ctx.storage.sql), {
                    ...identity,
                    runToken: run.runToken,
                    runVersion: run.runVersion,
                    targetVersion: run.targetVersion,
                    cookie,
                    rows: response.result,
                    authEpochs,
                    nowMs: settledAt,
                })
            );
            if (staged) await this.scheduleGatewayAlarm(settledAt + 1);
        } catch (error) {
            await this.settleGatewayQueryFailure(candidate, run, this.gatewayNowMs(), error);
        }
    }

    private async runGatewaySnapshotSend(attempt: GatewaySnapshotSendAttempt): Promise<void> {
        const sendNowMs = this.gatewayNowMs();
        const currentPolicyDigest = this.currentGatewayPolicyDigest(attempt.intentJson);
        if (currentPolicyDigest !== null && currentPolicyDigest !== attempt.policyDigest) {
            if (this.retireGatewaySnapshotAttempt(attempt, sendNowMs)) {
                this.settleRetiredGatewaySubscription(attempt, { kind: "error", code: "CDB_INVARIANT" });
                await this.scheduleGatewayWork(sendNowMs).catch(() => {});
            }
            return;
        }
        const socket = this.exactGatewaySocket(attempt, sendNowMs);
        if (socket.status === "refreshing") {
            this.ctx.storage.transactionSync(() => {
                failGatewaySnapshotSend(adaptSqlStorage(this.ctx.storage.sql), {
                    registrationId: attempt.registrationId,
                    cookie: attempt.cookie,
                    claimToken: attempt.claimToken,
                    claimVersion: attempt.claimVersion,
                    nowMs: sendNowMs,
                    error: "authentication refresh is in flight",
                });
            });
            await this.scheduleGatewayWork(this.gatewayNowMs());
            return;
        }
        if (socket.status === "terminal") {
            if (this.retireGatewaySnapshotAttempt(attempt, sendNowMs)) {
                await this.scheduleGatewayWork(sendNowMs).catch(() => {});
            }
            return;
        }
        const markResult = this.ctx.storage.transactionSync(() =>
            markGatewaySnapshotSendBaseCookie(
                adaptSqlStorage(this.ctx.storage.sql),
                attempt,
                socket.attachment.lastCookie ?? null,
                sendNowMs
            )
        );
        if (markResult === "stale") return;
        if (markResult === "retired") {
            this.settleRetiredGatewaySubscription(attempt, { kind: "error", code: "CDB_RATE_LIMITED" });
            await this.scheduleGatewayWork(sendNowMs).catch(() => {});
            return;
        }
        try {
            this.send(socket.ws, {
                t: "snapshot",
                subId: attempt.subId,
                cookie: attempt.cookie,
                rows: attempt.rows,
            });
        } catch (error) {
            this.ctx.storage.transactionSync(() => {
                failGatewaySnapshotSend(adaptSqlStorage(this.ctx.storage.sql), {
                    registrationId: attempt.registrationId,
                    cookie: attempt.cookie,
                    claimToken: attempt.claimToken,
                    claimVersion: attempt.claimVersion,
                    nowMs: this.gatewayNowMs(),
                    error,
                });
            });
            await this.scheduleGatewayWork(this.gatewayNowMs());
        }
    }

    private cleanupRetryDelayMs(attempts: number): number {
        return gatewayRetryDelayMs(attempts);
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

    private completeLegacyGatewayCleanup(row: StoredGatewayCleanupRow): void {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `DELETE FROM _gw_registration_generations
                 WHERE registration_id = ? AND principal_id = ? AND client_id = ? AND sub_id = ?
                   AND connection_id = ? AND (source_cdb_id IS NULL OR source_cdb_id = '')
                   AND lifecycle = 'retiring' AND cdb_state = 'retiring'
                   AND NOT EXISTS (
                     SELECT 1 FROM _gw_registration_heads h
                     WHERE h.registration_id = _gw_registration_generations.registration_id
                   )`,
                row.registration_id,
                row.principal_id,
                row.client_id,
                row.sub_id,
                row.connection_id
            );
            if (sql.changes() === 1) return;
            if (
                sql.one<{ registration_id: string }>(
                    "SELECT registration_id FROM _gw_registration_generations WHERE registration_id = ?",
                    row.registration_id
                )
            ) {
                throw gatewayInvalidationInvariant(
                    "legacy retired Gateway generation changed before cleanup could complete"
                );
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
            if (!row.source_cdb_id) {
                // These rows predate physical Cdb registration identity, so no
                // remote subscription can exist. Delete only the exact
                // headless legacy generation.
                this.completeLegacyGatewayCleanup(row);
                return;
            }
            const id = this.env.CDB_SHARD.idFromString(row.source_cdb_id);
            const cdb = this.env.CDB_SHARD.get(id) as unknown as CdbSubscriptionRpc;
            const subscription = {
                gatewayId: this.ctx.id.toString(),
                registrationId: row.registration_id,
                connectionId: row.connection_id,
                clientId: ClientId(row.client_id),
                subId: SubId(row.sub_id),
            };
            const outcome: unknown = await cdb.unsubscribe(subscription);
            if (outcome !== undefined) throw new Error("Cdb returned a malformed unsubscribe outcome");
            const finalized: unknown = await cdb.finalizeUnsubscribe(subscription);
            if (finalized !== undefined) throw new Error("Cdb returned a malformed unsubscribe finalization outcome");
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

    private earliestGatewayInstallRecoveryAt(): number | null {
        return (
            adaptSqlStorage(this.ctx.storage.sql).one<{ retry_at: number | null }>(
                `SELECT MIN(g.retry_at) AS retry_at
                 FROM _gw_registration_generations g
                 WHERE g.cdb_state = 'pending'
                   AND g.lifecycle IN ('installing', 'retiring')
                   AND g.retry_at IS NOT NULL`
            )?.retry_at ?? null
        );
    }

    private earliestGatewayQueryAt(): number | null {
        return (
            adaptSqlStorage(this.ctx.storage.sql).one<{ due_at: number | null }>(
                `SELECT MIN(
                   CASE
                     WHEN g.run_token IS NULL THEN COALESCE(g.retry_at, 0)
                     ELSE g.run_lease_expires_at
                   END
                 ) AS due_at
                 FROM _gw_registration_generations g
                 INNER JOIN _gw_registration_heads h
                   ON h.registration_id = g.registration_id
                  AND h.principal_id = g.principal_id
                  AND h.client_id = g.client_id
                  AND h.sub_id = g.sub_id
                 WHERE g.lifecycle = 'active' AND g.cdb_state = 'active'
                   AND g.source_cdb_id IS NOT NULL AND g.source_cdb_id <> ''
                   AND (g.initial_snapshot_pending = 1 OR g.dirty_version > g.delivered_version)
                   AND NOT EXISTS (
                     SELECT 1 FROM _gw_snapshot_outbox o WHERE o.registration_id = g.registration_id
                   )
                   AND (
                     (g.run_token IS NULL AND g.run_target_version IS NULL AND g.run_lease_expires_at IS NULL)
                     OR
                     (g.run_token IS NOT NULL AND g.run_target_version IS NOT NULL
                      AND g.run_lease_expires_at IS NOT NULL)
                   )`
            )?.due_at ?? null
        );
    }

    private earliestGatewaySnapshotSendAt(): number | null {
        return (
            adaptSqlStorage(this.ctx.storage.sql).one<{ due_at: number | null }>(
                `SELECT MIN(
                   CASE
                     WHEN o.claim_token IS NULL THEN o.next_attempt_at
                     ELSE MAX(o.next_attempt_at, COALESCE(o.claim_expires_at, o.next_attempt_at))
                   END
                 ) AS due_at
                 FROM _gw_snapshot_outbox o
                 INNER JOIN _gw_registration_generations g ON g.registration_id = o.registration_id
                 INNER JOIN _gw_registration_heads h
                   ON h.registration_id = g.registration_id
                  AND h.principal_id = g.principal_id
                  AND h.client_id = g.client_id
                  AND h.sub_id = g.sub_id
                 WHERE g.lifecycle = 'active' AND g.cdb_state = 'active'`
            )?.due_at ?? null
        );
    }

    private earliestGatewaySnapshotReplayExpiryAt(): number | null {
        return (
            adaptSqlStorage(this.ctx.storage.sql).one<{ expires_at: number | null }>(
                "SELECT MIN(expires_at) AS expires_at FROM _gw_snapshot_replay"
            )?.expires_at ?? null
        );
    }

    private async scheduleGatewayWork(nowMs: number): Promise<void> {
        const due = [
            this.earliestGatewayCleanupAt(),
            this.earliestGatewayInstallRecoveryAt(),
            this.earliestGatewayQueryAt(),
            this.earliestGatewaySnapshotSendAt(),
            this.earliestGatewaySnapshotReplayExpiryAt(),
        ].filter((value): value is number => value !== null);
        if (due.length === 0) return;
        await this.scheduleGatewayAlarm(Math.max(nowMs + 1, Math.min(...due)));
    }

    /** Retire the logical head only in the transaction that owns its cleanup alarm. */
    private async retireGatewayStateWithCleanupAlarm(nowMs: number, retire: () => void): Promise<void> {
        const alarmAt = nowMs + 1;
        await this.serializeGatewayAlarmOperation(() =>
            this.ctx.storage.transaction(async transaction => {
                const current = await transaction.getAlarm();
                if (current === null || alarmAt < current) await transaction.setAlarm(alarmAt);
                retire();
            })
        );
    }

    /** Best-effort fallback after a close event could not commit retirement. */
    private async scheduleAbandonedGatewayReconciliation(nowMs: number): Promise<void> {
        const alarmAt = nowMs + 1;
        await this.serializeGatewayAlarmOperation(() =>
            this.ctx.storage.transaction(async transaction => {
                const current = await transaction.getAlarm();
                if (current === null || alarmAt < current) await transaction.setAlarm(alarmAt);
                adaptSqlStorage(this.ctx.storage.sql).exec(
                    `INSERT INTO _gw_maintenance_state (key, integer_value) VALUES (?, 0)
                     ON CONFLICT (key) DO NOTHING`,
                    GATEWAY_ABANDONED_REGISTRATION_CURSOR_KEY
                );
            })
        );
    }

    /**
     * Reconcile one durable page of active heads against exact live socket
     * attachments. The rowid cursor prevents live heads from starving later
     * abandoned heads across bounded alarm passes.
     */
    private reconcileAbandonedGatewayRegistrations(nowMs: number): boolean {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const cursor =
            sql.one<{ integer_value: number }>(
                "SELECT integer_value FROM _gw_maintenance_state WHERE key = ?",
                GATEWAY_ABANDONED_REGISTRATION_CURSOR_KEY
            )?.integer_value ?? 0;
        const rows = sql.all<StoredGatewayActiveHead>(
            `SELECT g.rowid AS generation_rowid, g.principal_id, g.client_id, g.sub_id,
                    g.registration_id, g.connection_id
             FROM _gw_registration_generations g
             INNER JOIN _gw_registration_heads h
               ON h.registration_id = g.registration_id
              AND h.principal_id = g.principal_id
              AND h.client_id = g.client_id
              AND h.sub_id = g.sub_id
             WHERE g.rowid > ? AND g.lifecycle = 'active' AND g.cdb_state = 'active'
             ORDER BY g.rowid
             LIMIT ?`,
            cursor,
            GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE + 1
        );
        const candidates = rows.slice(0, GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE);
        const hasMore = rows.length > GATEWAY_ABANDONED_REGISTRATION_BATCH_SIZE;
        const abandoned = candidates.filter(candidate => {
            const identity = {
                principalId: PrincipalId(candidate.principal_id),
                clientId: ClientId(candidate.client_id),
                subId: SubId(candidate.sub_id),
                registrationId: candidate.registration_id,
                connectionId: candidate.connection_id,
            };
            return this.exactGatewaySocket(identity, nowMs).status === "terminal";
        });
        if (abandoned.length === 0 && !hasMore && cursor === 0) return false;
        this.ctx.storage.transactionSync(() => {
            const transactionSql = adaptSqlStorage(this.ctx.storage.sql);
            for (const candidate of abandoned) {
                retainCurrentGatewaySnapshotReplay(
                    transactionSql,
                    {
                        principalId: PrincipalId(candidate.principal_id),
                        clientId: ClientId(candidate.client_id),
                        subId: SubId(candidate.sub_id),
                    },
                    nowMs,
                    true
                );
                retireGatewayRegistration(
                    transactionSql,
                    {
                        principalId: PrincipalId(candidate.principal_id),
                        clientId: ClientId(candidate.client_id),
                        subId: SubId(candidate.sub_id),
                    },
                    candidate.registration_id,
                    nowMs
                );
            }
            pruneGatewaySnapshotReplays(transactionSql, nowMs);
            const nextCursor = hasMore ? (candidates.at(-1)?.generation_rowid ?? cursor) : 0;
            if (nextCursor !== cursor) {
                transactionSql.exec(
                    `INSERT INTO _gw_maintenance_state (key, integer_value) VALUES (?, ?)
                     ON CONFLICT (key) DO UPDATE SET integer_value = excluded.integer_value`,
                    GATEWAY_ABANDONED_REGISTRATION_CURSOR_KEY,
                    nextCursor
                );
            }
        });
        return hasMore;
    }

    private async drainGatewayWork(): Promise<void> {
        const nowMs = this.gatewayNowMs();
        this.ctx.storage.transactionSync(() =>
            pruneGatewaySnapshotReplays(adaptSqlStorage(this.ctx.storage.sql), nowMs)
        );
        for (const recovery of this.dueGatewayInstallRecoveries(nowMs)) {
            this.ctx.storage.transactionSync(() => {
                markPendingGatewaySubscriptionAmbiguous(adaptSqlStorage(this.ctx.storage.sql), {
                    principalId: PrincipalId(recovery.principal_id),
                    clientId: ClientId(recovery.client_id),
                    subId: SubId(recovery.sub_id),
                    registrationId: recovery.registration_id,
                    connectionId: recovery.connection_id,
                    nowMs,
                });
            });
        }
        const cleanupRows = this.dueGatewayCleanupRows(nowMs);
        await Promise.allSettled(cleanupRows.map(row => this.cleanupGatewayGeneration(row, nowMs)));

        const queryTasks = this.dueGatewayRunCandidates(nowMs).map(candidate =>
            this.trackGatewayTask(candidate.connection_id, this.runGatewayQueryCandidate(candidate, nowMs))
        );
        await Promise.allSettled(queryTasks);

        const sendTasks: Promise<void>[] = [];
        const sendNowMs = this.gatewayNowMs();
        const sendDueAt = this.earliestGatewaySnapshotSendAt();
        if (sendDueAt !== null && sendDueAt <= sendNowMs) {
            await this.scheduleGatewayAlarm(sendNowMs + GATEWAY_SEND_LEASE_MS);
        }
        for (let index = 0; index < GATEWAY_SEND_BATCH_SIZE; index++) {
            const attempt = this.ctx.storage.transactionSync(() =>
                claimDueGatewaySnapshot(adaptSqlStorage(this.ctx.storage.sql), {
                    nowMs: sendNowMs,
                    attemptExpiresAt: sendNowMs + GATEWAY_SEND_LEASE_MS,
                })
            );
            if (!attempt) break;
            sendTasks.push(this.trackGatewayTask(attempt.connectionId, this.runGatewaySnapshotSend(attempt)));
        }
        await Promise.allSettled(sendTasks);
        await this.scheduleGatewayWork(this.gatewayNowMs());
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
        ensureGatewaySnapshotOutboxColumns(sql);
        sql.exec(
            `UPDATE _gw_registration_generations
             SET retry_at = updated_at
             WHERE lifecycle = 'retiring' AND cdb_state = 'retiring' AND retry_at IS NULL`
        );
        await this.scheduleGatewayWork(this.gatewayNowMs());
        this.bootstrapped = true;
    }

    override async alarm(): Promise<void> {
        const reconciliationAt = this.gatewayNowMs();
        if (this.reconcileAbandonedGatewayRegistrations(reconciliationAt)) {
            await this.scheduleGatewayAlarm(reconciliationAt + 1);
        }
        await this.drainGatewayWork();
    }

    /**
     * Accept Cdb invalidations only for the exact generation that still owns
     * its logical head. Dirty versions remain durable for the alarm runner.
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

    override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
        if (typeof raw !== "string") return;
        // UTF-8 is never shorter than the JavaScript code-unit count. Reject
        // obviously large strings before allocating an encoded copy, then
        // measure exact bytes for multibyte input before JSON parsing.
        if (
            raw.length > GATEWAY_MAX_INBOUND_WEBSOCKET_BYTES ||
            GATEWAY_TEXT_ENCODER.encode(raw).byteLength > GATEWAY_MAX_INBOUND_WEBSOCKET_BYTES
        ) {
            ws.close(1009, "message too large");
            return;
        }
        let msg: WireMessage;
        try {
            msg = decodeWire(raw);
        } catch {
            this.sendError(ws, "CDB_UNSUPPORTED_FEATURE");
            return;
        }
        switch ((msg as Up).t) {
            case "hello":
                await this.onHello(ws, msg as Extract<Up, { t: "hello" }>);
                break;
            case "updateAuth":
                await this.onUpdateAuth(ws, msg as Extract<Up, { t: "updateAuth" }>);
                break;
            case "sub":
                await this.onSub(ws, msg as Extract<Up, { t: "sub" }>);
                break;
            case "unsub":
                await this.onUnsub(ws, msg as Extract<Up, { t: "unsub" }>);
                break;
            case "mut":
                await this.onMut(ws, msg as Extract<Up, { t: "mut" }>);
                break;
            case "ack":
                this.onAck(ws, msg as Extract<Up, { t: "ack" }>);
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

    private async cleanupGatewaySocket(ws: WebSocket): Promise<void> {
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        if (attachment) {
            if (attachment.kind !== "rejected") {
                ws.serializeAttachment({
                    kind: "rejected",
                    connectionId: attachment.connectionId,
                    authOrigin: attachment.authOrigin,
                } satisfies RejectedGwAttachment);
            }
            this.authOperationClaims.delete(attachment.connectionId);
            this.authRefreshBarriers.delete(attachment.connectionId);
            this.activeOperations.delete(attachment.connectionId);
            for (const pending of this.pendingSubscriptions.values()) {
                if (pending.connectionId === attachment.connectionId) pending.cancelled = true;
            }
            const nowMs = this.gatewayNowMs();
            try {
                await this.retireGatewayStateWithCleanupAlarm(nowMs, () => {
                    retireCurrentGatewayRegistrationsForConnection(
                        adaptSqlStorage(this.ctx.storage.sql),
                        attachment.connectionId,
                        nowMs
                    );
                });
            } catch (error) {
                await this.scheduleAbandonedGatewayReconciliation(nowMs).catch(() => {});
                throw error;
            }
        }
    }

    override async webSocketClose(ws: WebSocket): Promise<void> {
        await this.cleanupGatewaySocket(ws);
    }

    override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
        await this.cleanupGatewaySocket(ws);
    }

    private async onHello(ws: WebSocket, msg: Extract<Up, { t: "hello" }>): Promise<void> {
        const pending = ws.deserializeAttachment() as GwAttachment | null;
        if (pending?.kind !== "pending" || pending.routedClientId === null || msg.clientId !== pending.routedClientId) {
            this.rejectAuth(ws, "CDB_FORBIDDEN");
            return;
        }
        const claim = this.claimAuthOperation(pending.connectionId);
        if (!claim) {
            this.sendError(ws, "CDB_RATE_LIMITED");
            return;
        }
        try {
            const mismatch = checkProtocolV(msg.protocolV);
            if (mismatch) {
                this.markConnectionRejected(ws, pending.connectionId);
                this.sendThenClose(
                    ws,
                    () => this.send(ws, mismatch),
                    1002,
                    `unsupported chardb protocol ${msg.protocolV}`
                );
                return;
            }
            const attachment = await this.verifyAttachment(
                ws,
                {
                    authOrigin: pending.authOrigin,
                    connectionId: pending.connectionId,
                    clientId: pending.routedClientId,
                    jwt: msg.jwt,
                    ...(msg.resumeFromCookie ? { lastCookie: msg.resumeFromCookie } : {}),
                },
                () => this.authOperationClaims.get(pending.connectionId) === claim
            );
            if (!attachment || this.authOperationClaims.get(pending.connectionId) !== claim) return;
            const current = ws.deserializeAttachment() as GwAttachment | null;
            if (
                current?.kind !== "pending" ||
                current.connectionId !== pending.connectionId ||
                current.authOrigin !== pending.authOrigin ||
                current.routedClientId !== pending.routedClientId
            ) {
                return;
            }
            const baseCookie = Cookie(`${pending.routedClientId}:0`);
            ws.serializeAttachment({
                ...attachment,
                lastCookie: msg.resumeFromCookie ?? baseCookie,
                ...(msg.resumeFromCookie !== undefined ? { resumeRefetchPendingSubIds: [] } : {}),
            } satisfies VerifiedGwAttachment);
            const welcome: Down = {
                t: "welcome",
                protocolV: PROTOCOL_V,
                baseCookie,
                region: "WNAM",
                ...(msg.resumeFromCookie ? { resumedFromCookie: msg.resumeFromCookie } : {}),
            };
            try {
                this.send(ws, welcome);
            } catch (error) {
                this.markConnectionRejected(ws, pending.connectionId);
                this.closePreservingFailure(ws, 1011, "welcome delivery failed", { value: error });
            }
        } finally {
            this.releaseAuthOperation(pending.connectionId, claim);
        }
    }

    private async onUpdateAuth(ws: WebSocket, msg: Extract<Up, { t: "updateAuth" }>): Promise<void> {
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(current)) {
            this.rejectAuth(ws, "CDB_FORBIDDEN");
            return;
        }
        const connectionId = current.connectionId;
        const claim = this.claimAuthOperation(connectionId);
        if (!claim) {
            this.sendError(ws, "CDB_RATE_LIMITED");
            return;
        }
        const isCurrent = (): boolean => this.authOperationClaims.get(connectionId) === claim;
        const barrier = this.performUpdateAuth(ws, connectionId, msg, isCurrent).catch(() => {
            if (isCurrent()) this.rejectAuth(ws, "CDB_CATALOG_UNAVAILABLE");
            return false;
        });
        this.authRefreshBarriers.set(connectionId, barrier);
        try {
            await barrier;
        } finally {
            if (this.authRefreshBarriers.get(connectionId) === barrier) {
                this.authRefreshBarriers.delete(connectionId);
            }
            this.releaseAuthOperation(connectionId, claim);
        }
    }

    private claimAuthOperation(connectionId: string): object | null {
        if (this.authOperationClaims.has(connectionId)) return null;
        const claim = {};
        this.authOperationClaims.set(connectionId, claim);
        return claim;
    }

    private releaseAuthOperation(connectionId: string, claim: object): void {
        if (this.authOperationClaims.get(connectionId) === claim) {
            this.authOperationClaims.delete(connectionId);
        }
    }

    private async performUpdateAuth(
        ws: WebSocket,
        connectionId: string,
        msg: Extract<Up, { t: "updateAuth" }>,
        isCurrent: () => boolean = () => true
    ): Promise<boolean> {
        if (!isCurrent()) return false;
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(current) || current.connectionId !== connectionId) {
            if (isCurrent()) this.rejectAuth(ws, "CDB_FORBIDDEN");
            return false;
        }
        const attachment = await this.verifyAttachment(
            ws,
            {
                authOrigin: current.authOrigin,
                connectionId,
                clientId: current.clientId,
                jwt: msg.jwt,
                ...(current.lastCookie !== undefined ? { lastCookie: current.lastCookie } : {}),
                ...(current.presenceKeys !== undefined ? { presenceKeys: current.presenceKeys } : {}),
            },
            isCurrent
        );
        if (!isCurrent() || !attachment) return false;

        const active = this.activeOperations.get(connectionId);
        if (active && active.size > 0) await Promise.allSettled([...active]);
        if (!isCurrent()) return false;

        const latest = ws.deserializeAttachment() as GwAttachment | null;
        if (
            !isVerifiedAttachment(latest) ||
            latest.connectionId !== connectionId ||
            latest.clientId !== current.clientId
        ) {
            if (isCurrent()) this.rejectAuth(ws, "CDB_FORBIDDEN");
            return false;
        }
        if (!isCurrent()) return false;
        ws.serializeAttachment({
            ...attachment,
            ...(latest.lastCookie !== undefined ? { lastCookie: latest.lastCookie } : {}),
            ...(latest.presenceKeys !== undefined ? { presenceKeys: latest.presenceKeys } : {}),
            ...(latest.snapshotSubIds !== undefined ? { snapshotSubIds: latest.snapshotSubIds } : {}),
            ...(latest.resumeRefetchPendingSubIds !== undefined
                ? { resumeRefetchPendingSubIds: latest.resumeRefetchPendingSubIds }
                : {}),
        } satisfies VerifiedGwAttachment);
        try {
            const retirementAt = this.gatewayNowMs();
            if (!isCurrent()) return false;
            await this.scheduleGatewayAlarm(retirementAt + GATEWAY_SUBSCRIBE_RECOVERY_MS);
            if (!isCurrent()) return false;
            const retired = this.ctx.storage.transactionSync(() =>
                retireCurrentGatewayRegistrationsForConnection(
                    adaptSqlStorage(this.ctx.storage.sql),
                    connectionId,
                    retirementAt
                )
            );
            await this.scheduleGatewayWork(retirementAt).catch(() => {});
            if (!isCurrent()) return false;
            const legacy = await this.invalidateClientSubscriptions(latest.clientId);
            if (!isCurrent()) return false;
            if (legacy.rpcFailed) {
                this.rejectConnection(ws, "CDB_SHARD_UNAVAILABLE", 1011, "subscription invalidation failed");
                return false;
            }
            const refreshed = ws.deserializeAttachment() as GwAttachment | null;
            if (!isVerifiedAttachment(refreshed) || refreshed.connectionId !== connectionId) {
                if (isCurrent()) this.rejectAuth(ws, "CDB_FORBIDDEN");
                return false;
            }
            const subIds = [
                ...new Set([...(refreshed.snapshotSubIds ?? []), ...retired.map(item => item.subId), ...legacy.subIds]),
            ]
                .sort((left, right) => left - right)
                .map(SubId);
            if (!isCurrent()) return false;
            ws.serializeAttachment({ ...refreshed, snapshotSubIds: [] } satisfies VerifiedGwAttachment);
            this.send(ws, { t: "mustRefetch", subIds, reason: "authChanged" });
            return true;
        } catch {
            if (isCurrent()) {
                this.rejectConnection(ws, "CDB_SHARD_UNAVAILABLE", 1011, "subscription invalidation failed");
            }
            return false;
        }
    }

    private async verifyAttachment(
        ws: WebSocket,
        request: Omit<GatewayJwtVerificationRequest, "config" | "catalog">,
        isCurrent: () => boolean = () => true
    ): Promise<VerifiedGwAttachment | null> {
        const config = this.jwtConfig();
        if (!config) {
            if (isCurrent()) this.rejectAuth(ws, "CDB_AUTH_NOT_BOUND");
            return null;
        }
        try {
            return await verifyGatewayJwt({
                ...request,
                config,
                catalog: this.catalog() as unknown as CatalogJwksRpc,
            });
        } catch (error) {
            if (isCurrent()) {
                this.rejectAuth(ws, error instanceof CdbError ? error.code : "CDB_CATALOG_UNAVAILABLE");
            }
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
        if (current?.kind === "rejected") return;
        if (current) this.markConnectionRejected(ws, current.connectionId);
        this.sendThenClose(ws, () => this.sendError(ws, code), closeCode, reason);
    }

    private markConnectionRejected(ws: WebSocket, expectedConnectionId: string): void {
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (!current || current.kind === "rejected" || current.connectionId !== expectedConnectionId) return;
        ws.serializeAttachment({
            kind: "rejected",
            connectionId: current.connectionId,
            authOrigin: current.authOrigin,
        } satisfies RejectedGwAttachment);
    }

    private sendThenClose(ws: WebSocket, send: () => void, closeCode: number, reason: string): void {
        let sendFailure: { readonly value: unknown } | null = null;
        try {
            send();
        } catch (error) {
            sendFailure = { value: error };
        }
        this.closePreservingFailure(ws, closeCode, reason, sendFailure);
    }

    private closePreservingFailure(
        ws: WebSocket,
        closeCode: number,
        reason: string,
        priorFailure: { readonly value: unknown } | null
    ): void {
        try {
            ws.close(closeCode, reason);
        } catch (error) {
            if (priorFailure === null) throw error;
        }
        if (priorFailure !== null) throw priorFailure.value;
    }

    private async onSub(ws: WebSocket, msg: Extract<Up, { t: "sub" }>): Promise<void> {
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(attachment) || !isCurrentVerifiedAttachment(attachment)) {
            this.sendError(ws, "CDB_FORBIDDEN", msg.subId);
            return;
        }
        let ownedMsg: Extract<Up, { t: "sub" }>;
        try {
            ownedMsg = { ...msg, args: snapshotCdbQueryArgs(msg.args) };
        } catch (error) {
            this.sendError(ws, error instanceof CdbError ? error.code : "CDB_INVARIANT", msg.subId);
            return;
        }
        const resumeRefetchPendingSubIds = attachment.resumeRefetchPendingSubIds;
        let resumeReplayAttempt = false;
        if (resumeRefetchPendingSubIds !== undefined) {
            if (!resumeRefetchPendingSubIds.includes(msg.subId)) {
                if (resumeRefetchPendingSubIds.length >= MAX_INITIAL_SNAPSHOTS_PER_CONNECTION) {
                    this.sendError(ws, "CDB_RATE_LIMITED", msg.subId);
                    return;
                }
                ws.serializeAttachment({
                    ...attachment,
                    resumeRefetchPendingSubIds: [...resumeRefetchPendingSubIds, msg.subId]
                        .sort((left, right) => left - right)
                        .map(SubId),
                } satisfies VerifiedGwAttachment);
                resumeReplayAttempt = true;
            } else {
                ws.serializeAttachment({
                    ...attachment,
                    resumeRefetchPendingSubIds: resumeRefetchPendingSubIds.filter(subId => subId !== msg.subId),
                } satisfies VerifiedGwAttachment);
            }
        }
        const operationKey = `${attachment.connectionId}:${msg.subId}`;
        const previous = this.pendingSubscriptions.get(operationKey);
        if (previous?.queued) {
            this.sendError(ws, "CDB_RATE_LIMITED", msg.subId);
            return;
        }
        const capacityKey = stableJson([attachment.principalId, attachment.clientId, msg.subId]);
        const duplicatePending = [...this.pendingSubscriptions.values()].some(
            pending => !pending.cancelled && pending !== previous && pending.capacityKey === capacityKey
        );
        if (duplicatePending) {
            this.sendError(ws, "CDB_RATE_LIMITED", msg.subId);
            return;
        }
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
        if (!this.hasRegistrationCapacity(attachment, msg.subId, capacityKey)) {
            this.sendError(ws, "CDB_RATE_LIMITED", msg.subId);
            return;
        }
        const queued = this.authRefreshBarriers.has(attachment.connectionId) || previous !== undefined;
        if (previous) previous.cancelled = true;
        const pending: PendingSubscription = {
            connectionId: attachment.connectionId,
            subId: msg.subId,
            capacityKey,
            cancelled: false,
            queued,
            resumeReplayAttempt,
            task: Promise.resolve(),
        };
        this.pendingSubscriptions.set(operationKey, pending);
        if (queued) {
            await (previous?.task.catch(() => {}) ?? Promise.resolve());
            let succeeded = true;
            while (true) {
                const barrier = this.authRefreshBarriers.get(attachment.connectionId);
                if (!barrier) break;
                if (!(await barrier)) {
                    succeeded = false;
                    break;
                }
            }
            if (succeeded && !pending.cancelled) {
                pending.queued = false;
                await this.admitSubscription(ws, ownedMsg, pending, operationKey);
            } else if (this.pendingSubscriptions.get(operationKey) === pending) {
                this.pendingSubscriptions.delete(operationKey);
            }
            return;
        }
        await this.admitSubscription(ws, ownedMsg, pending, operationKey);
    }

    private hasRegistrationCapacity(attachment: VerifiedGwAttachment, subId: SubId, capacityKey: string): boolean {
        if (
            [...this.pendingSubscriptions.values()].some(
                pending => !pending.cancelled && pending.capacityKey === capacityKey
            )
        ) {
            return true;
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        if (
            sql.one<{ registration_id: string }>(
                `SELECT registration_id FROM _gw_registration_heads
                 WHERE principal_id = ? AND client_id = ? AND sub_id = ?`,
                attachment.principalId,
                attachment.clientId,
                subId
            )
        ) {
            return true;
        }
        const capacityKeys = new Set(
            sql
                .all<{ principal_id: string; client_id: string; sub_id: number }>(
                    `SELECT principal_id, client_id, sub_id FROM _gw_registration_heads
                     LIMIT ?`,
                    GATEWAY_MAX_CURRENT_AND_PENDING_REGISTRATIONS
                )
                .map(row => stableJson([row.principal_id, row.client_id, row.sub_id]))
        );
        if (capacityKeys.size >= GATEWAY_MAX_CURRENT_AND_PENDING_REGISTRATIONS) return false;
        for (const pending of this.pendingSubscriptions.values()) {
            if (!pending.cancelled) capacityKeys.add(pending.capacityKey);
        }
        return capacityKeys.size < GATEWAY_MAX_CURRENT_AND_PENDING_REGISTRATIONS;
    }

    private async admitSubscription(
        ws: WebSocket,
        msg: Extract<Up, { t: "sub" }>,
        pending: PendingSubscription,
        operationKey: string
    ): Promise<void> {
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
        try {
            await task;
        } catch {
            const current = ws.deserializeAttachment() as GwAttachment | null;
            if (
                !pending.cancelled &&
                this.pendingSubscriptions.get(operationKey) === pending &&
                isVerifiedAttachment(current) &&
                isCurrentVerifiedAttachment(current) &&
                current.connectionId === att.connectionId &&
                current.clientId === att.clientId &&
                current.principalId === att.principalId
            ) {
                this.sendError(ws, "CDB_INVARIANT", msg.subId);
            }
        } finally {
            if (this.pendingSubscriptions.get(operationKey) === pending) {
                this.pendingSubscriptions.delete(operationKey);
            }
            active.delete(task);
            if (active.size === 0) this.activeOperations.delete(att.connectionId);
        }
    }

    private async settleSubscription(
        ws: WebSocket,
        att: VerifiedGwAttachment,
        msg: Extract<Up, { t: "sub" }>,
        pending: PendingSubscription
    ): Promise<void> {
        const routedResult = await this.routeQuery({ ref: msg.ref, args: msg.args });
        if (pending.cancelled) return;
        if (!routedResult.ok) {
            this.sendError(ws, routedResult.error.code, msg.subId);
            return;
        }
        let routed: Extract<QueryRouteResponse, { readonly ok: true }>;
        try {
            routed = { ...routedResult, args: snapshotCdbQueryArgs(routedResult.args) };
        } catch (error) {
            this.sendError(ws, error instanceof CdbError ? error.code : "CDB_INVARIANT", msg.subId);
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
        const authEpochs = projected.auth.authEpochs;
        if (!authEpochs) {
            this.sendError(ws, "CDB_CATALOG_UNAVAILABLE", msg.subId);
            return;
        }

        let shardId: string;
        let schemaEpoch: number;
        let domainSchemaEpoch: number;
        try {
            const route = await catalog.route(vshard);
            if (
                typeof route?.shardId !== "string" ||
                route.shardId.length === 0 ||
                !Number.isSafeInteger(route.schemaEpoch) ||
                route.schemaEpoch < 0 ||
                !Number.isSafeInteger(route.domainSchemaEpoch) ||
                route.domainSchemaEpoch < 1
            ) {
                throw new TypeError("Catalog returned a malformed shard route");
            }
            shardId = route.shardId;
            schemaEpoch = route.schemaEpoch;
            domainSchemaEpoch = route.domainSchemaEpoch;
        } catch {
            if (pending.cancelled) return;
            this.sendError(ws, "CDB_CATALOG_UNAVAILABLE", msg.subId);
            return;
        }
        if (pending.cancelled) return;
        const currentBeforeInstall = ws.deserializeAttachment() as GwAttachment | null;
        const operationKey = `${att.connectionId}:${msg.subId}`;
        if (
            this.pendingSubscriptions.get(operationKey) !== pending ||
            !isVerifiedAttachment(currentBeforeInstall) ||
            !isCurrentVerifiedAttachment(currentBeforeInstall) ||
            currentBeforeInstall.connectionId !== att.connectionId ||
            currentBeforeInstall.clientId !== att.clientId ||
            currentBeforeInstall.principalId !== att.principalId
        ) {
            return;
        }

        const cdbId = this.env.CDB_SHARD.idFromName(shardId);
        const sourceCdbId = cdbId.toString();
        if (sourceCdbId.length === 0) {
            this.sendError(ws, "CDB_SHARD_UNAVAILABLE", msg.subId);
            return;
        }
        let replaySnapshot: GatewaySnapshotReplay | null = null;
        if (pending.resumeReplayAttempt) {
            const replayAt = this.gatewayNowMs();
            replaySnapshot = this.ctx.storage.transactionSync(() => {
                const sql = adaptSqlStorage(this.ctx.storage.sql);
                retainCurrentGatewaySnapshotReplay(
                    sql,
                    { principalId: att.principalId, clientId: att.clientId, subId: msg.subId },
                    replayAt
                );
                return att.lastCookie === undefined
                    ? null
                    : resolveGatewaySnapshotReplay(sql, {
                          principalId: att.principalId,
                          clientId: att.clientId,
                          subId: msg.subId,
                          cookie: att.lastCookie,
                          organizationId: TenantId(organizationId),
                          ref: msg.ref,
                          args: routed.args,
                          policyDigest: routed.policyDigest,
                          queryHash: routed.queryHash,
                          shardId,
                          sourceCdbId,
                          schemaEpoch,
                          domainSchemaEpoch,
                          authEpochs,
                          nowMs: replayAt,
                      });
            });
            if (!replaySnapshot) {
                this.send(ws, { t: "mustRefetch", subIds: [msg.subId], reason: "lagged" });
                return;
            }
            const currentAfterReplayLookup = ws.deserializeAttachment() as GwAttachment | null;
            if (
                !isVerifiedAttachment(currentAfterReplayLookup) ||
                currentAfterReplayLookup.connectionId !== att.connectionId ||
                currentAfterReplayLookup.clientId !== att.clientId ||
                currentAfterReplayLookup.principalId !== att.principalId
            ) {
                return;
            }
            const remainingResumeSubIds = currentAfterReplayLookup.resumeRefetchPendingSubIds?.filter(
                subId => subId !== msg.subId
            );
            ws.serializeAttachment({
                ...currentAfterReplayLookup,
                ...(remainingResumeSubIds !== undefined ? { resumeRefetchPendingSubIds: remainingResumeSubIds } : {}),
            } satisfies VerifiedGwAttachment);
        }
        const registrationId = crypto.randomUUID();
        const installedAt = this.gatewayNowMs();
        const identity = {
            principalId: att.principalId,
            clientId: att.clientId,
            subId: msg.subId,
            registrationId,
            connectionId: att.connectionId,
        } as const;
        const recoveryAt = installedAt + GATEWAY_SUBSCRIBE_RECOVERY_MS;
        try {
            await this.scheduleGatewayAlarm(recoveryAt);
        } catch {
            if (!pending.cancelled) this.sendError(ws, "CDB_SHARD_UNAVAILABLE", msg.subId);
            return;
        }
        const currentBeforeCommit = ws.deserializeAttachment() as GwAttachment | null;
        if (
            pending.cancelled ||
            this.pendingSubscriptions.get(operationKey) !== pending ||
            !isVerifiedAttachment(currentBeforeCommit) ||
            !isCurrentVerifiedAttachment(currentBeforeCommit) ||
            currentBeforeCommit.connectionId !== att.connectionId ||
            currentBeforeCommit.clientId !== att.clientId ||
            currentBeforeCommit.principalId !== att.principalId
        ) {
            return;
        }
        try {
            this.ctx.storage.transactionSync(() => {
                const sql = adaptSqlStorage(this.ctx.storage.sql);
                installGatewayRegistration(sql, {
                    ...identity,
                    organizationId: TenantId(organizationId),
                    ref: msg.ref,
                    args: routed.args,
                    intent: routed.intent,
                    policyDigest: routed.policyDigest,
                    queryHash: routed.queryHash,
                    shardId,
                    sourceCdbId,
                    schemaEpoch,
                    domainSchemaEpoch,
                    authEpochs,
                    ...(att.lastCookie === undefined ? {} : { lastCookie: att.lastCookie }),
                    nowMs: installedAt,
                });
                if (!armGatewaySubscriptionRecovery(sql, { ...identity, recoveryAt, nowMs: installedAt })) {
                    throw gatewayInvalidationInvariant("Gateway subscription install could not arm recovery");
                }
            });
        } catch (error) {
            if (error instanceof CdbError && error.code === "CDB_RATE_LIMITED") {
                this.sendError(ws, error.code, msg.subId);
                return;
            }
            throw error;
        }
        const deleteNeverRegistered = (): boolean =>
            this.ctx.storage.transactionSync(() =>
                deleteNeverRegisteredGatewaySubscription(adaptSqlStorage(this.ctx.storage.sql), identity)
            );
        const settleAmbiguous = async (): Promise<void> => {
            const nowMs = this.gatewayNowMs();
            const changed = this.ctx.storage.transactionSync(() => {
                const sql = adaptSqlStorage(this.ctx.storage.sql);
                return (
                    markPendingGatewaySubscriptionAmbiguous(sql, { ...identity, nowMs }) ||
                    retireGatewayRegistration(sql, identity, registrationId, nowMs)
                );
            });
            if (changed) await this.scheduleGatewayWork(nowMs);
        };
        const isCancelledOrStale = (): boolean => {
            const current = ws.deserializeAttachment() as GwAttachment | null;
            return (
                pending.cancelled ||
                this.pendingSubscriptions.get(operationKey) !== pending ||
                !isVerifiedAttachment(current) ||
                !isCurrentVerifiedAttachment(current) ||
                current.connectionId !== att.connectionId ||
                current.clientId !== att.clientId ||
                current.principalId !== att.principalId
            );
        };

        // The prearmed recovery deadline remains durable if this earlier
        // scheduling attempt fails.
        await this.scheduleGatewayWork(installedAt).catch(() => {});
        if (isCancelledOrStale()) {
            deleteNeverRegistered();
            return;
        }

        const request = cdbSubscriptionRequest({
            gatewayId: this.ctx.id.toString(),
            ...identity,
            organizationId: TenantId(organizationId),
            domainSchemaEpoch,
            ref: msg.ref,
            args: routed.args,
            queryHash: routed.queryHash,
            intent: routed.intent,
        });
        let response: CdbSubscriptionResponse;
        try {
            const cdb = this.env.CDB_SHARD.get(cdbId) as unknown as CdbSubscriptionRpc;
            response = projectCdbSubscriptionResponse(await cdb.subscribe(request), request.subscription);
        } catch {
            await settleAmbiguous();
            if (!isCancelledOrStale()) this.sendError(ws, "CDB_SHARD_UNAVAILABLE", msg.subId);
            return;
        }
        if (!response.ok) {
            const deleted = deleteNeverRegistered();
            if (deleted && !isCancelledOrStale()) this.sendError(ws, response.error.code, msg.subId);
            return;
        }
        if (isCancelledOrStale()) {
            await settleAmbiguous();
            return;
        }
        const activatedAt = this.gatewayNowMs();
        const activated = this.ctx.storage.transactionSync(() =>
            activateGatewaySubscription(adaptSqlStorage(this.ctx.storage.sql), {
                ...identity,
                changeSeq: response.changeSeq,
                nowMs: activatedAt,
            })
        );
        if (!activated || isCancelledOrStale()) {
            await settleAmbiguous();
            return;
        }
        const current = ws.deserializeAttachment() as VerifiedGwAttachment;
        const snapshotSubIds = [...new Set([...(current.snapshotSubIds ?? []), msg.subId])]
            .sort((left, right) => left - right)
            .map(SubId);
        ws.serializeAttachment({ ...current, snapshotSubIds } satisfies VerifiedGwAttachment);
        if (replaySnapshot) {
            try {
                this.send(ws, {
                    t: "snapshot",
                    subId: replaySnapshot.subId,
                    cookie: replaySnapshot.cookie,
                    rows: replaySnapshot.rows,
                });
            } catch (error) {
                this.markConnectionRejected(ws, att.connectionId);
                this.closePreservingFailure(ws, 1011, "snapshot replay delivery failed", { value: error });
            }
        }
        try {
            await this.scheduleGatewayWork(activatedAt);
        } catch {
            if (!isCancelledOrStale()) this.sendError(ws, "CDB_SHARD_UNAVAILABLE", msg.subId);
        }
    }

    private async onUnsub(ws: WebSocket, msg: Extract<Up, { t: "unsub" }>): Promise<void> {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(att) || !isCurrentVerifiedAttachment(att)) return;
        const pending = this.pendingSubscriptions.get(`${att.connectionId}:${msg.subId}`);
        if (pending) pending.cancelled = true;
        const nowMs = this.gatewayNowMs();
        await this.retireGatewayStateWithCleanupAlarm(nowMs, () => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            retireCurrentGatewayRegistration(sql, {
                principalId: att.principalId,
                clientId: att.clientId,
                subId: msg.subId,
                connectionId: att.connectionId,
                nowMs,
            });
            sql.exec(
                `DELETE FROM _gw_snapshot_replay
                 WHERE principal_id = ? AND client_id = ? AND sub_id = ?`,
                att.principalId,
                att.clientId,
                msg.subId
            );
        });
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (
            isVerifiedAttachment(current) &&
            current.connectionId === att.connectionId &&
            current.clientId === att.clientId &&
            current.principalId === att.principalId
        ) {
            const snapshotSubIds = current.snapshotSubIds?.filter(subId => subId !== msg.subId);
            const resumeRefetchPendingSubIds = current.resumeRefetchPendingSubIds?.filter(subId => subId !== msg.subId);
            if (
                snapshotSubIds?.length !== current.snapshotSubIds?.length ||
                resumeRefetchPendingSubIds?.length !== current.resumeRefetchPendingSubIds?.length
            ) {
                ws.serializeAttachment({
                    ...current,
                    ...(snapshotSubIds !== undefined ? { snapshotSubIds } : {}),
                    ...(resumeRefetchPendingSubIds !== undefined ? { resumeRefetchPendingSubIds } : {}),
                } satisfies VerifiedGwAttachment);
            }
        }
    }

    private onAck(ws: WebSocket, msg: Extract<Up, { t: "ack" }>): void {
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        const nowMs = this.gatewayNowMs();
        if (!isVerifiedAttachment(attachment) || !isCurrentVerifiedAttachment(attachment, Math.floor(nowMs / 1_000))) {
            return;
        }
        const settlement = this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const identity = resolveGatewaySnapshotAck(sql, {
                principalId: attachment.principalId,
                clientId: attachment.clientId,
                connectionId: attachment.connectionId,
                cookie: msg.cookie,
            });
            if (identity) {
                return {
                    kind: "current" as const,
                    identity,
                    acknowledged: acknowledgeGatewaySnapshot(sql, { ...identity, nowMs }),
                };
            }
            const replaySubId = acknowledgeGatewaySnapshotReplay(sql, {
                principalId: attachment.principalId,
                clientId: attachment.clientId,
                cookie: msg.cookie,
                nowMs,
            });
            return replaySubId === null ? null : { kind: "replay" as const, subId: replaySubId };
        });
        if (!settlement) return;
        if (settlement.kind === "replay") {
            void this.scheduleGatewayWork(nowMs);
            return;
        }
        if (!settlement.acknowledged) return;
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (
            !isVerifiedAttachment(current) ||
            current.connectionId !== attachment.connectionId ||
            current.principalId !== attachment.principalId ||
            current.clientId !== attachment.clientId
        ) {
            return;
        }
        if (
            !settlement.identity.alreadyAcknowledged &&
            (current.lastCookie ?? null) === settlement.identity.attachmentBaseCookie
        ) {
            ws.serializeAttachment({ ...current, lastCookie: msg.cookie } satisfies VerifiedGwAttachment);
        }
        void this.scheduleGatewayWork(nowMs);
    }

    private async onMut(ws: WebSocket, msg: Extract<Up, { t: "mut" }>): Promise<void> {
        const attachment = ws.deserializeAttachment() as GwAttachment | null;
        if (!isVerifiedAttachment(attachment) || !isCurrentVerifiedAttachment(attachment)) {
            await this.admitMutation(ws, msg);
            return;
        }
        try {
            assertCdbMutationArgsByteLimit(msg.args);
        } catch (error) {
            const failure =
                error instanceof CdbError
                    ? error
                    : new CdbError({ code: "CDB_INVARIANT", message: "mutation argument sizing failed" });
            this.sendMutFailure(ws, msg.mutId, failure.toJSON(), attachment.lastCookie);
            return;
        }
        if (!this.reserveMutation(attachment.connectionId)) {
            const current = ws.deserializeAttachment() as GwAttachment | null;
            this.sendMutFailure(
                ws,
                msg.mutId,
                new CdbError({ code: "CDB_RATE_LIMITED", message: "too many unsettled mutations" }).toJSON(),
                isVerifiedAttachment(current) ? current.lastCookie : attachment.lastCookie
            );
            return;
        }
        try {
            const barrier = this.authRefreshBarriers.get(attachment.connectionId);
            if (barrier) {
                if (await barrier) await this.admitMutation(ws, msg);
                return;
            }
            await this.admitMutation(ws, msg);
        } finally {
            this.releaseMutation(attachment.connectionId);
        }
    }

    private reserveMutation(connectionId: string): boolean {
        const connectionCount = this.unsettledMutationsByConnection.get(connectionId) ?? 0;
        if (
            connectionCount >= Gateway.MAX_UNSETTLED_MUTATIONS_PER_CONNECTION ||
            this.unsettledMutationCount >= Gateway.MAX_UNSETTLED_MUTATIONS
        ) {
            return false;
        }
        this.unsettledMutationsByConnection.set(connectionId, connectionCount + 1);
        this.unsettledMutationCount += 1;
        return true;
    }

    private releaseMutation(connectionId: string): void {
        const connectionCount = this.unsettledMutationsByConnection.get(connectionId);
        if (connectionCount === undefined || connectionCount <= 0 || this.unsettledMutationCount <= 0) {
            throw new CdbError({ code: "CDB_INVARIANT", message: "Gateway mutation admission counter underflow" });
        }
        if (connectionCount === 1) this.unsettledMutationsByConnection.delete(connectionId);
        else this.unsettledMutationsByConnection.set(connectionId, connectionCount - 1);
        this.unsettledMutationCount -= 1;
    }

    private async admitMutation(ws: WebSocket, msg: Extract<Up, { t: "mut" }>): Promise<void> {
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
        try {
            await task;
        } catch {
            // The only uncaught failure here is the final WebSocket send. A
            // second send would violate exactly-once settlement.
        } finally {
            active.delete(task);
            if (active.size === 0) this.activeOperations.delete(att.connectionId);
        }
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
        const current = ws.deserializeAttachment() as GwAttachment | null;
        if (
            !isVerifiedAttachment(current) ||
            current.connectionId !== att.connectionId ||
            current.clientId !== att.clientId ||
            current.principalId !== att.principalId
        ) {
            return;
        }
        if (ack.ok) {
            const cookie = Cookie(ack.cookie);
            ws.serializeAttachment({ ...current, lastCookie: cookie } satisfies VerifiedGwAttachment);
            this.send(ws, {
                t: "poke",
                cookie,
                patches: [],
                mutResults: [{ mutId: msg.mutId, ok: true, result: ack.result, cookie }],
            });
        } else {
            this.sendMutFailure(ws, msg.mutId, ack.error, current.lastCookie);
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
        const catalog = this.catalog();
        const shardIds = await shardsForIntent(catalog, intent);
        const domainSchemaEpoch = (await catalog.route(0)).domainSchemaEpoch;
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
            domainSchemaEpoch,
            ref,
            args,
            queryHash,
            intent,
        });
        await Promise.all(
            shardIds.map(async shardId => {
                const cdb = this.cdb(shardId);
                const response = projectCdbSubscriptionResponse(await cdb.subscribe(request), request.subscription);
                if (!response.ok) {
                    throw new CdbError({
                        code: response.error.code,
                        message: response.error.message,
                        ...(response.error.retryAfterMs === undefined
                            ? {}
                            : { retryAfterMs: response.error.retryAfterMs }),
                        ...(response.error.hint === undefined ? {} : { hint: response.error.hint }),
                    });
                }
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
                const cdb = this.cdb(shardId);
                await cdb.unsubscribe(subscription);
                await cdb.finalizeUnsubscribe(subscription);
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

        protected override runtimePolicyDigest(tableNames: readonly string[]): string {
            return cdbPolicyDigest(config.schema(), tableNames);
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
