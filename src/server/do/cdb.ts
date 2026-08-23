/**
 * `Cdb` shard DO.
 *
 * Owns one slice of vshards on its SQLite database. All single-partition
 * mutations land here; the op-log wrapper provides at-most-once semantics
 * dedup ledger atomically with each base mutation.
 *
 * This class is a thin runtime over the pure helpers in `chardb/oplog` and
 * `chardb/intervals`. The real exec happens on workerd
 * (https://developers.cloudflare.com/durable-objects/api/sql-storage/);
 * locally the class compiles but is exercised by integration tests under
 * wrangler/miniflare.
 */

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { renderSqliteTableDdl } from "../../auth/ddl.ts";
import { CdbError, isCdbError, isCdbErrorCode } from "../../errors.ts";
import { type IntervalKey, IntervalMap, type IntervalSet } from "../../intervals.ts";
import { intervalSetFromWire } from "../../intervals_wire.ts";
import { SHARD_BOOTSTRAP_DDL } from "../../oplog/schema.ts";
import { type JsonText, type SyncSql, parseJsonColumn } from "../../oplog/wrapper.ts";
import { type RangeFilter, filterRowsInRange, inRange } from "../../reshard/range.ts";
import { type TableSpec, renderRowApply, renderTableTriggers } from "../../reshard/triggers.ts";
import { ChardbRef, ClientId, PrincipalId, type RawJson, SubId, TenantId } from "../../types.ts";
import { stableHashHex } from "../../util/canonical.ts";
import { rawJsonResult } from "../../util/raw_json.ts";
import { executeAtomicMutation } from "../atomic-mutation.ts";
import { wrapQueryDb } from "../cdb-db-proxy.ts";
import { collectCdbTables } from "../cdb-table-registry.ts";
import { resolveCdbMeta } from "../cdb-table.ts";
import { type ChardbManifest, emptyManifest, resolveMutation, resolveQuery, routeValidatedQuery } from "../manifest.ts";
import type {
    CdbMutationRequest,
    CdbMutationResponse,
    CdbQueryRequest,
    CdbQueryResponse,
    CdbRegisteredQueryRequest,
    CdbSubscriptionRequest,
    GatewayInvalidationAck,
    GatewayInvalidationRequest,
    GatewayInvalidationResponse,
    GatewayInvalidationRpc,
    LiveSubscriptionId,
} from "../rpc.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

export type {
    CdbMutationFailure,
    CdbMutationRequest,
    CdbMutationResponse,
    CdbMutationSuccess,
} from "../rpc.ts";

export interface CdbEnv {
    readonly CDB_GATEWAY?: DurableObjectNamespace;
    readonly CDB_R2?: unknown;
    readonly CDB_VECTORIZE?: unknown;
}

export type SubscribeArgs = CdbSubscriptionRequest;

const CDB_LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_live_subscriptions (
  gateway_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  payload_hash TEXT,
  principal_id TEXT,
  organization_id TEXT,
  ref TEXT,
  args_json TEXT,
  query_hash TEXT,
  tables_json TEXT,
  intervals_json TEXT,
  PRIMARY KEY (gateway_id, registration_id),
  CHECK (
    (
      state = 'retired'
      AND payload_hash IS NULL
      AND principal_id IS NULL
      AND organization_id IS NULL
      AND ref IS NULL
      AND args_json IS NULL
      AND query_hash IS NULL
      AND tables_json IS NULL
      AND intervals_json IS NULL
    )
    OR (
      state = 'active'
      AND payload_hash IS NOT NULL
      AND principal_id IS NOT NULL
      AND organization_id IS NOT NULL
      AND ref IS NOT NULL
      AND args_json IS NOT NULL
      AND query_hash IS NOT NULL
      AND tables_json IS NOT NULL
      AND intervals_json IS NOT NULL
    )
  )
);
CREATE TABLE IF NOT EXISTS _chardb_change_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  change_seq INTEGER NOT NULL CHECK (change_seq >= 0)
);
INSERT OR IGNORE INTO _chardb_change_clock (singleton, change_seq) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS _chardb_live_subscription_tables (
  gateway_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  PRIMARY KEY (gateway_id, registration_id, table_name),
  FOREIGN KEY (gateway_id, registration_id)
    REFERENCES _chardb_live_subscriptions (gateway_id, registration_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS _chardb_live_subscription_tables_by_table
  ON _chardb_live_subscription_tables (table_name, gateway_id, registration_id);
CREATE TABLE IF NOT EXISTS _chardb_invalidation_outbox (
  gateway_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0),
  last_error TEXT,
  dead_lettered_at INTEGER,
  PRIMARY KEY (gateway_id, registration_id),
  FOREIGN KEY (gateway_id, registration_id)
    REFERENCES _chardb_live_subscriptions (gateway_id, registration_id)
    ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS _chardb_domain_schema (
  table_name TEXT PRIMARY KEY,
  signature TEXT NOT NULL
);
` as const;

interface StoredSubscriptionRow {
    readonly [column: string]: string | number | null;
    readonly gateway_id: string;
    readonly registration_id: string;
    readonly connection_id: string;
    readonly client_id: string;
    readonly sub_id: number;
    readonly state: "active" | "retired";
    readonly payload_hash: string | null;
    readonly principal_id: string | null;
    readonly organization_id: string | null;
    readonly ref: string | null;
    readonly args_json: string | null;
    readonly query_hash: string | null;
    readonly tables_json: string | null;
    readonly intervals_json: string | null;
}

interface PreparedInterval {
    readonly table: string;
    readonly indexName: string;
    readonly set: IntervalSet;
}

interface StoredInvalidationRow {
    readonly [column: string]: string | number | null;
    readonly gateway_id: string;
    readonly registration_id: string;
    readonly connection_id: string;
    readonly client_id: string;
    readonly sub_id: number;
    readonly change_seq: number;
    readonly attempts: number;
    readonly next_attempt_at: number;
    readonly last_error: string | null;
    readonly dead_lettered_at: number | null;
}

const INVALIDATION_BATCH_SIZE = 64;
const INVALIDATION_MAX_ATTEMPTS = 8;
const INVALIDATION_BASE_RETRY_MS = 1_000;
const INVALIDATION_MAX_RETRY_MS = 60_000;

function subscriptionKey(subscription: LiveSubscriptionId): string {
    return JSON.stringify([subscription.gatewayId, subscription.registrationId]);
}

function subscriptionPayloadHash(args: CdbSubscriptionRequest): string {
    return stableHashHex({
        connectionId: args.subscription.connectionId,
        clientId: args.subscription.clientId,
        subId: args.subscription.subId,
        principalId: args.principalId,
        organizationId: args.organizationId,
        ref: args.ref,
        args: args.args,
        queryHash: args.queryHash,
        tables: args.tables,
        intervals: args.intervals,
    });
}

function subscriptionInvariant(message: string): CdbError {
    return new CdbError({ code: "CDB_INVARIANT", message });
}

function ensureInvalidationOutboxColumns(sql: SyncSql): void {
    const columns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_invalidation_outbox)").map(column => column.name)
    );
    const additions = [
        ["attempts", "attempts INTEGER NOT NULL DEFAULT 0"],
        ["next_attempt_at", "next_attempt_at INTEGER NOT NULL DEFAULT 0"],
        ["last_error", "last_error TEXT"],
        ["dead_lettered_at", "dead_lettered_at INTEGER"],
    ] as const;
    for (const [name, definition] of additions) {
        if (!columns.has(name)) sql.exec(`ALTER TABLE _chardb_invalidation_outbox ADD COLUMN ${definition}`);
    }
}

function ensureLiveSubscriptionAuthorityColumns(sql: SyncSql): void {
    const columns = new Set(
        sql.all<{ name: string }>("PRAGMA table_info(_chardb_live_subscriptions)").map(column => column.name)
    );
    if (!columns.has("organization_id")) {
        sql.exec("ALTER TABLE _chardb_live_subscriptions ADD COLUMN organization_id TEXT");
    }
    if (!columns.has("query_hash")) {
        sql.exec("ALTER TABLE _chardb_live_subscriptions ADD COLUMN query_hash TEXT");
    }
}

function retireLegacyLiveSubscriptions(sql: SyncSql): void {
    sql.exec(
        `UPDATE _chardb_live_subscriptions
         SET state = 'retired',
             payload_hash = NULL,
             principal_id = NULL,
             organization_id = NULL,
             ref = NULL,
             args_json = NULL,
             query_hash = NULL,
             tables_json = NULL,
             intervals_json = NULL
         WHERE state = 'active' AND (organization_id IS NULL OR query_hash IS NULL)`
    );
    sql.exec(
        `DELETE FROM _chardb_live_subscription_tables
         WHERE EXISTS (
           SELECT 1 FROM _chardb_live_subscriptions AS subscriptions
           WHERE subscriptions.gateway_id = _chardb_live_subscription_tables.gateway_id
             AND subscriptions.registration_id = _chardb_live_subscription_tables.registration_id
             AND subscriptions.state = 'retired'
         )`
    );
    sql.exec(
        `DELETE FROM _chardb_invalidation_outbox
         WHERE EXISTS (
           SELECT 1 FROM _chardb_live_subscriptions AS subscriptions
           WHERE subscriptions.gateway_id = _chardb_invalidation_outbox.gateway_id
             AND subscriptions.registration_id = _chardb_invalidation_outbox.registration_id
             AND subscriptions.state = 'retired'
         )`
    );
}

function currentChangeSeq(sql: SyncSql): number {
    const row = sql.one<{ change_seq: number }>("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1");
    if (!row || !Number.isSafeInteger(row.change_seq) || row.change_seq < 0) {
        throw subscriptionInvariant("Cdb change clock is missing or invalid");
    }
    return row.change_seq;
}

function storedSubscriptionTables(sql: SyncSql, subscription: LiveSubscriptionId): readonly string[] {
    return sql
        .all<{ table_name: string }>(
            `SELECT table_name
             FROM _chardb_live_subscription_tables
             WHERE gateway_id = ? AND registration_id = ?
             ORDER BY table_name`,
            subscription.gatewayId,
            subscription.registrationId
        )
        .map(row => row.table_name);
}

function assertSubscriptionTables(
    sql: SyncSql,
    subscription: LiveSubscriptionId,
    expectedTables: readonly string[]
): void {
    const storedTables = storedSubscriptionTables(sql, subscription);
    if (
        storedTables.length !== expectedTables.length ||
        storedTables.some((tableName, index) => tableName !== expectedTables[index])
    ) {
        throw subscriptionInvariant("active live subscription table mappings do not match its persisted payload");
    }
}

function parseStoredSubscription(row: StoredSubscriptionRow): CdbSubscriptionRequest {
    if (
        row.state !== "active" ||
        row.payload_hash === null ||
        row.principal_id === null ||
        row.organization_id === null ||
        row.ref === null ||
        row.args_json === null ||
        row.query_hash === null ||
        row.tables_json === null ||
        row.intervals_json === null
    ) {
        throw subscriptionInvariant("active live subscription is missing its persisted payload");
    }

    let args: RawJson;
    let tables: unknown;
    let intervals: unknown;
    try {
        args = rawJsonResult(JSON.parse(row.args_json), "persisted live subscription arguments");
        tables = JSON.parse(row.tables_json);
        intervals = JSON.parse(row.intervals_json);
    } catch (error) {
        throw subscriptionInvariant(
            `active live subscription payload is corrupt: ${error instanceof Error ? error.message : "invalid JSON"}`
        );
    }
    if (!Array.isArray(tables) || tables.some(table => typeof table !== "string")) {
        throw subscriptionInvariant("active live subscription tables payload is corrupt");
    }
    if (!Array.isArray(intervals)) {
        throw subscriptionInvariant("active live subscription intervals payload is corrupt");
    }

    const request: CdbSubscriptionRequest = {
        subscription: {
            gatewayId: row.gateway_id,
            registrationId: row.registration_id,
            connectionId: row.connection_id,
            clientId: ClientId(row.client_id),
            subId: SubId(row.sub_id),
        },
        principalId: PrincipalId(row.principal_id),
        organizationId: TenantId(row.organization_id),
        ref: ChardbRef(row.ref),
        args,
        queryHash: row.query_hash,
        tables,
        intervals: intervals as CdbSubscriptionRequest["intervals"],
    };
    if (row.payload_hash !== subscriptionPayloadHash(request)) {
        throw subscriptionInvariant("active live subscription payload hash does not match its persisted payload");
    }
    return request;
}

function enqueueInvalidations(sql: SyncSql, touchedTables: readonly string[]): number {
    sql.exec("UPDATE _chardb_change_clock SET change_seq = change_seq + 1 WHERE singleton = 1");
    if (sql.changes() !== 1) throw subscriptionInvariant("Cdb change clock update did not affect one row");
    const changeSeq = currentChangeSeq(sql);
    const registrations = new Map<string, { gatewayId: string; registrationId: string }>();
    for (const tableName of touchedTables) {
        const rows = sql.all<{ gateway_id: string; registration_id: string }>(
            `SELECT mappings.gateway_id, mappings.registration_id
             FROM _chardb_live_subscription_tables AS mappings
             INNER JOIN _chardb_live_subscriptions AS subscriptions
               ON subscriptions.gateway_id = mappings.gateway_id
              AND subscriptions.registration_id = mappings.registration_id
             WHERE mappings.table_name = ? AND subscriptions.state = 'active'`,
            tableName
        );
        for (const row of rows) {
            registrations.set(JSON.stringify([row.gateway_id, row.registration_id]), {
                gatewayId: row.gateway_id,
                registrationId: row.registration_id,
            });
        }
    }
    for (const registration of registrations.values()) {
        sql.exec(
            `INSERT INTO _chardb_invalidation_outbox (gateway_id, registration_id, change_seq)
             VALUES (?, ?, ?)
             ON CONFLICT(gateway_id, registration_id) DO UPDATE SET
               change_seq = MAX(change_seq, excluded.change_seq),
               attempts = CASE WHEN excluded.change_seq > change_seq THEN 0 ELSE attempts END,
               next_attempt_at = CASE WHEN excluded.change_seq > change_seq THEN 0 ELSE next_attempt_at END,
               last_error = CASE WHEN excluded.change_seq > change_seq THEN NULL ELSE last_error END,
               dead_lettered_at = CASE WHEN excluded.change_seq > change_seq THEN NULL ELSE dead_lettered_at END`,
            registration.gatewayId,
            registration.registrationId,
            changeSeq
        );
    }
    return changeSeq;
}

function sameSubscriptionIdentity(row: StoredSubscriptionRow, subscription: LiveSubscriptionId): boolean {
    return (
        row.gateway_id === subscription.gatewayId &&
        row.registration_id === subscription.registrationId &&
        row.connection_id === subscription.connectionId &&
        row.client_id === subscription.clientId &&
        row.sub_id === subscription.subId
    );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateInvalidationResponse(
    value: unknown,
    gatewayId: string,
    requested: ReadonlyMap<string, number>
): readonly GatewayInvalidationAck[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw subscriptionInvariant("Gateway invalidation response must be an object");
    }
    const response = value as Record<string, unknown>;
    if (!hasExactKeys(response, ["gatewayId", "acknowledgements"])) {
        throw subscriptionInvariant("Gateway invalidation response has an unexpected shape");
    }
    if (response.gatewayId !== gatewayId || !Array.isArray(response.acknowledgements)) {
        throw subscriptionInvariant("Gateway invalidation response does not match the requested Gateway");
    }
    const seen = new Set<string>();
    const acknowledgements: GatewayInvalidationAck[] = [];
    for (const value of response.acknowledgements) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw subscriptionInvariant("Gateway invalidation acknowledgement must be an object");
        }
        const acknowledgement = value as Record<string, unknown>;
        if (!hasExactKeys(acknowledgement, ["registrationId", "changeSeq", "status"])) {
            throw subscriptionInvariant("Gateway invalidation acknowledgement has an unexpected shape");
        }
        if (
            typeof acknowledgement.registrationId !== "string" ||
            !Number.isSafeInteger(acknowledgement.changeSeq) ||
            (acknowledgement.status !== "accepted" && acknowledgement.status !== "stale") ||
            requested.get(acknowledgement.registrationId) !== acknowledgement.changeSeq ||
            seen.has(acknowledgement.registrationId)
        ) {
            throw subscriptionInvariant("Gateway invalidation acknowledgement does not match the request");
        }
        seen.add(acknowledgement.registrationId);
        acknowledgements.push({
            registrationId: acknowledgement.registrationId,
            changeSeq: acknowledgement.changeSeq as number,
            status: acknowledgement.status,
        });
    }
    return acknowledgements;
}

function invalidationErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 512);
}

function domainSchemaMismatch(tableName: string): CdbError {
    return new CdbError({
        code: "CDB_PARTITION_CONTRACT_CHANGED",
        message: `domain table "${tableName}" is unsigned or does not match the configured schema`,
        hint: "add and run an explicit shard schema migration before deploying this schema",
    });
}

const QUERY_DB_READ_PROPERTIES = new Set<PropertyKey>(["select"]);

function readOnlyQueryDb<TDb extends object>(db: TDb): TDb {
    return new Proxy(db, {
        get(target, property, receiver) {
            if (!QUERY_DB_READ_PROPERTIES.has(property)) {
                throw new CdbError({
                    code: "CDB_UNSUPPORTED_FEATURE",
                    message: `query database property "${String(property)}" is unavailable in read-only handlers`,
                });
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

export interface CdbRuntimeConfig<TSchema extends Record<string, unknown>> {
    readonly schema: () => TSchema;
    readonly manifest: () => ChardbManifest;
}

/**
 * Cdb shard. Bound as `class_name = "Cdb"` in wrangler.jsonc.
 */
export class Cdb extends DurableObject<CdbEnv> {
    private readonly intervalMap = new IntervalMap<string>();
    private readonly subscriptions = new Map<string, LiveSubscriptionId>();
    private bootstrapped = false;

    constructor(state: DurableObjectState, env: CdbEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    protected mutationSchema(): Record<string, unknown> {
        return {};
    }

    protected mutationManifest(): ChardbManifest {
        return emptyManifest();
    }

    private async bootstrap(): Promise<void> {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        for (const stmt of `${SHARD_BOOTSTRAP_DDL}\n${CDB_LOCAL_DDL}`
            .split(";")
            .map(s => s.trim())
            .filter(Boolean)) {
            sql.exec(stmt);
        }
        ensureLiveSubscriptionAuthorityColumns(sql);
        ensureInvalidationOutboxColumns(sql);
        sql.exec("PRAGMA foreign_keys = ON");
        this.ctx.storage.transactionSync(() => retireLegacyLiveSubscriptions(adaptSqlStorage(this.ctx.storage.sql)));
        this.ensureDomainTables();
        const cursor = this.ctx.storage.sql.exec<StoredSubscriptionRow>(
            `SELECT gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                    principal_id, organization_id, ref, args_json, query_hash, tables_json, intervals_json
             FROM _chardb_live_subscriptions
             WHERE state = 'active'
             ORDER BY gateway_id, registration_id`
        );
        for (const row of cursor) {
            const request = parseStoredSubscription(row);
            assertSubscriptionTables(sql, request.subscription, [...new Set(request.tables)].sort());
            this.installSubscription(request.subscription, this.prepareIntervals(request));
        }
        this.bootstrapped = true;
    }

    private ensureDomainTables(): void {
        const tables = [...collectCdbTables(this.mutationSchema())].sort((a, b) =>
            a.meta.name.localeCompare(b.meta.name)
        );
        const domainTableNames = new Set(tables.map(entry => entry.meta.name));
        const rendered = tables.map(({ table }) => {
            const meta = resolveCdbMeta(table);
            const authorityColumns = new Set([meta.tenantBy, meta.selfBy].filter(column => column !== undefined));
            return renderSqliteTableDdl(table, {
                errorCode: "CDB_PARTITION_CONTRACT_CHANGED",
                label: "domain DDL",
                hint: "add and run an explicit shard schema migration before deploying this schema",
                includeForeignKey: reference => {
                    if (domainTableNames.has(reference.foreignTableName)) return true;
                    if (reference.columns.some(column => authorityColumns.has(column))) return false;
                    throw new CdbError({
                        code: "CDB_NONLOCAL_FK",
                        message: `domain table "${meta.name}" references non-cdbTable "${reference.foreignTableName}"`,
                        hint: "make the referenced domain table a cdbTable or use a tenant/self authority column",
                    });
                },
            });
        });
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const ddl of rendered) {
                const existing = sql.one<{ sql: string }>(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                    ddl.tableName
                );
                const recorded = sql.one<{ signature: string }>(
                    "SELECT signature FROM _chardb_domain_schema WHERE table_name = ?",
                    ddl.tableName
                );
                if (existing) {
                    if (recorded?.signature !== ddl.signature || existing.sql !== ddl.createTable) {
                        throw domainSchemaMismatch(ddl.tableName);
                    }
                    for (let index = 0; index < ddl.indexNames.length; index++) {
                        const indexName = ddl.indexNames[index];
                        const expectedSql = ddl.indexes[index];
                        if (!indexName || !expectedSql) throw domainSchemaMismatch(ddl.tableName);
                        const present = sql.one<{ sql: string }>(
                            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = ?",
                            indexName,
                            ddl.tableName
                        );
                        if (present?.sql !== expectedSql) throw domainSchemaMismatch(ddl.tableName);
                    }
                    continue;
                }
                if (recorded) throw domainSchemaMismatch(ddl.tableName);
                sql.exec(ddl.createTable);
                for (const statement of ddl.indexes) sql.exec(statement);
                sql.exec(
                    "INSERT INTO _chardb_domain_schema (table_name, signature) VALUES (?, ?)",
                    ddl.tableName,
                    ddl.signature
                );
            }
        });
    }

    private prepareIntervals(args: CdbSubscriptionRequest): PreparedInterval[] {
        return args.intervals.map(block => ({
            table: block.table,
            indexName: block.indexName,
            set: intervalSetFromWire(block.intervals),
        }));
    }

    private installSubscription(subscription: LiveSubscriptionId, intervals: readonly PreparedInterval[]): void {
        const key = subscriptionKey(subscription);
        this.intervalMap.unregister(key);
        for (const interval of intervals) {
            this.intervalMap.register(key, interval.table, interval.indexName, interval.set);
        }
        this.subscriptions.set(key, subscription);
    }

    protected invalidationNowMs(): number {
        return Date.now();
    }

    protected invalidationRetryDelayMs(attempts: number): number {
        return Math.min(INVALIDATION_MAX_RETRY_MS, INVALIDATION_BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1));
    }

    private dueInvalidations(nowMs: number): readonly StoredInvalidationRow[] {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return sql.all<StoredInvalidationRow>(
            `SELECT outbox.gateway_id, outbox.registration_id, subscriptions.connection_id,
                    subscriptions.client_id, subscriptions.sub_id, outbox.change_seq, outbox.attempts,
                    outbox.next_attempt_at, outbox.last_error, outbox.dead_lettered_at
             FROM _chardb_invalidation_outbox AS outbox
             INNER JOIN _chardb_live_subscriptions AS subscriptions
               ON subscriptions.gateway_id = outbox.gateway_id
              AND subscriptions.registration_id = outbox.registration_id
             WHERE outbox.next_attempt_at <= ?
             ORDER BY outbox.next_attempt_at, outbox.gateway_id, outbox.registration_id
             LIMIT ?`,
            nowMs,
            INVALIDATION_BATCH_SIZE
        );
    }

    private recordInvalidationFailure(rows: readonly StoredInvalidationRow[], nowMs: number, error: unknown): void {
        const message = invalidationErrorMessage(error);
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const row of rows) {
                const attempts = row.attempts + 1;
                const deadLetteredAt = row.dead_lettered_at ?? (attempts >= INVALIDATION_MAX_ATTEMPTS ? nowMs : null);
                const nextAttemptAt = nowMs + this.invalidationRetryDelayMs(attempts);
                sql.exec(
                    `UPDATE _chardb_invalidation_outbox
                     SET attempts = ?, next_attempt_at = ?, last_error = ?, dead_lettered_at = ?
                     WHERE gateway_id = ? AND registration_id = ? AND change_seq = ?`,
                    attempts,
                    nextAttemptAt,
                    message,
                    deadLetteredAt,
                    row.gateway_id,
                    row.registration_id,
                    row.change_seq
                );
            }
        });
    }

    private acknowledgeInvalidations(
        gatewayId: string,
        rows: readonly StoredInvalidationRow[],
        acknowledgements: readonly GatewayInvalidationAck[],
        nowMs: number
    ): void {
        const acknowledged = new Set(acknowledgements.map(ack => JSON.stringify([ack.registrationId, ack.changeSeq])));
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const acknowledgement of acknowledgements) {
                sql.exec(
                    `DELETE FROM _chardb_invalidation_outbox
                     WHERE gateway_id = ? AND registration_id = ? AND change_seq = ?`,
                    gatewayId,
                    acknowledgement.registrationId,
                    acknowledgement.changeSeq
                );
            }
        });
        const omitted = rows.filter(row => !acknowledged.has(JSON.stringify([row.registration_id, row.change_seq])));
        if (omitted.length > 0) {
            this.recordInvalidationFailure(omitted, nowMs, "Gateway omitted an invalidation acknowledgement");
        }
    }

    private async drainInvalidations(nowMs: number): Promise<void> {
        const rows = this.dueInvalidations(nowMs);
        const groups = new Map<string, StoredInvalidationRow[]>();
        for (const row of rows) {
            const group = groups.get(row.gateway_id) ?? [];
            group.push(row);
            groups.set(row.gateway_id, group);
        }
        for (const [gatewayId, group] of groups) {
            try {
                if (!this.env.CDB_GATEWAY) throw new Error("CDB_GATEWAY binding is unavailable");
                const id = this.env.CDB_GATEWAY.idFromString(gatewayId);
                const gateway = this.env.CDB_GATEWAY.get(id) as unknown as GatewayInvalidationRpc;
                const request: GatewayInvalidationRequest = {
                    sourceCdbId: this.ctx.id.toString(),
                    gatewayId,
                    invalidations: group.map(row => ({
                        subscription: {
                            gatewayId: row.gateway_id,
                            registrationId: row.registration_id,
                            connectionId: row.connection_id,
                            clientId: ClientId(row.client_id),
                            subId: SubId(row.sub_id),
                        },
                        changeSeq: row.change_seq,
                    })),
                };
                const rawResponse: GatewayInvalidationResponse = await gateway.invalidateSubscriptions(request);
                const requested = new Map(group.map(row => [row.registration_id, row.change_seq] as const));
                const acknowledgements = validateInvalidationResponse(rawResponse, gatewayId, requested);
                this.acknowledgeInvalidations(gatewayId, group, acknowledgements, nowMs);
            } catch (error) {
                this.recordInvalidationFailure(group, nowMs, error);
            }
        }
    }

    private nextInvalidationAlarmAt(): number | null {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ next_attempt_at: number | null }>(
            `SELECT MIN(next_attempt_at) AS next_attempt_at
             FROM _chardb_invalidation_outbox`
        );
        return row?.next_attempt_at ?? null;
    }

    private async maintainInvalidationDelivery(): Promise<void> {
        const nowMs = this.invalidationNowMs();
        try {
            await this.drainInvalidations(nowMs);
        } catch (deliveryError) {
            try {
                await this.ctx.storage.setAlarm(nowMs + INVALIDATION_BASE_RETRY_MS);
                return;
            } catch (alarmError) {
                throw new CdbError({
                    code: "CDB_SHARD_UNAVAILABLE",
                    message: "invalidation delivery and alarm scheduling failed after mutation commit",
                    cause: { deliveryError, alarmError },
                });
            }
        }
        const nextAttemptAt = this.nextInvalidationAlarmAt();
        if (nextAttemptAt === null) return;
        try {
            await this.ctx.storage.setAlarm(Math.max(nowMs + 1, nextAttemptAt));
        } catch (error) {
            throw new CdbError({
                code: "CDB_SHARD_UNAVAILABLE",
                message: "invalidation alarm scheduling failed after mutation commit",
                cause: error,
            });
        }
    }

    /**
     * Register a live-query subscription on this shard. Caller is the Gateway DO.
     */
    async subscribe(args: SubscribeArgs): Promise<{ subscription: LiveSubscriptionId; changeSeq: number }> {
        const intervals = this.prepareIntervals(args);
        const payloadHash = subscriptionPayloadHash(args);
        const tableNames = [...new Set(args.tables)].sort();
        let changeSeq: number | undefined;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const existing = sql.one<StoredSubscriptionRow>(
                `SELECT gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                        principal_id, organization_id, ref, args_json, query_hash, tables_json, intervals_json
                 FROM _chardb_live_subscriptions
                 WHERE gateway_id = ? AND registration_id = ?`,
                args.subscription.gatewayId,
                args.subscription.registrationId
            );
            if (existing) {
                if (!sameSubscriptionIdentity(existing, args.subscription)) {
                    throw subscriptionInvariant("live subscription registration identity changed across an RPC replay");
                }
                if (existing.state === "retired") {
                    throw subscriptionInvariant("retired live subscription registration cannot be reactivated");
                }
                if (existing.payload_hash !== payloadHash) {
                    throw subscriptionInvariant("live subscription registration payload changed across an RPC replay");
                }
                assertSubscriptionTables(sql, args.subscription, tableNames);
            } else {
                sql.exec(
                    `INSERT INTO _chardb_live_subscriptions
                     (gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                      principal_id, organization_id, ref, args_json, query_hash, tables_json, intervals_json)
                     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args.subscription.gatewayId,
                    args.subscription.registrationId,
                    args.subscription.connectionId,
                    args.subscription.clientId,
                    args.subscription.subId,
                    payloadHash,
                    args.principalId,
                    args.organizationId,
                    args.ref,
                    JSON.stringify(args.args),
                    args.queryHash,
                    JSON.stringify(args.tables),
                    JSON.stringify(args.intervals)
                );
                for (const tableName of tableNames) {
                    sql.exec(
                        `INSERT INTO _chardb_live_subscription_tables
                         (gateway_id, registration_id, table_name)
                         VALUES (?, ?, ?)`,
                        args.subscription.gatewayId,
                        args.subscription.registrationId,
                        tableName
                    );
                }
            }
            changeSeq = currentChangeSeq(sql);
        });
        if (changeSeq === undefined) throw subscriptionInvariant("subscription completed without a change clock");
        this.installSubscription(args.subscription, intervals);
        return { subscription: args.subscription, changeSeq };
    }

    async unsubscribe(subscription: LiveSubscriptionId): Promise<void> {
        const key = subscriptionKey(subscription);
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const existing = sql.one<StoredSubscriptionRow>(
                `SELECT gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                        principal_id, organization_id, ref, args_json, query_hash, tables_json, intervals_json
                 FROM _chardb_live_subscriptions
                 WHERE gateway_id = ? AND registration_id = ?`,
                subscription.gatewayId,
                subscription.registrationId
            );
            if (existing && !sameSubscriptionIdentity(existing, subscription)) {
                throw subscriptionInvariant("live subscription unregister identity does not match its registration");
            }
            sql.exec(
                `INSERT INTO _chardb_live_subscriptions
                 (gateway_id, registration_id, connection_id, client_id, sub_id, state)
                 VALUES (?, ?, ?, ?, ?, 'retired')
                 ON CONFLICT(gateway_id, registration_id) DO UPDATE SET
                   state = 'retired',
                   payload_hash = NULL,
                   principal_id = NULL,
                   organization_id = NULL,
                   ref = NULL,
                   args_json = NULL,
                   query_hash = NULL,
                   tables_json = NULL,
                   intervals_json = NULL`,
                subscription.gatewayId,
                subscription.registrationId,
                subscription.connectionId,
                subscription.clientId,
                subscription.subId
            );
            sql.exec(
                `DELETE FROM _chardb_live_subscription_tables
                 WHERE gateway_id = ? AND registration_id = ?`,
                subscription.gatewayId,
                subscription.registrationId
            );
            sql.exec(
                `DELETE FROM _chardb_invalidation_outbox
                 WHERE gateway_id = ? AND registration_id = ?`,
                subscription.gatewayId,
                subscription.registrationId
            );
        });
        this.intervalMap.unregister(key);
        this.subscriptions.delete(key);
    }

    /** Resolve and run a registered mutation entirely inside this shard isolate. */
    async mutate(request: CdbMutationRequest): Promise<CdbMutationResponse> {
        let response: CdbMutationResponse;
        try {
            const descriptor = resolveMutation(this.mutationManifest(), request.ref as ChardbRef);
            try {
                await this.ctx.storage.setAlarm(this.invalidationNowMs() + 1);
            } catch (error) {
                throw new CdbError({
                    code: "CDB_SHARD_UNAVAILABLE",
                    message: "could not arm invalidation recovery before mutation commit",
                    cause: error,
                });
            }
            const result = executeAtomicMutation({
                storage: this.ctx.storage,
                schema: this.mutationSchema(),
                request,
                // This is an internal post-validation RPC. The configured
                // Gateway validates raw wire args and forwards this exact value.
                handler: (ctx, args) => descriptor.invokeValidated(ctx, args),
                cookie: `${this.ctx.id.toString()}:${Date.now()}:${crypto.randomUUID()}`,
                onWriteSet: ({ touchedTables, sql }) => {
                    enqueueInvalidations(sql, touchedTables);
                },
            });
            response = { ok: true, ...result };
        } catch (error) {
            return { ok: false, error: cdbRuntimeError(error).toJSON() };
        }
        try {
            await this.maintainInvalidationDelivery();
        } catch {
            // The pre-armed alarm owns recovery. The mutation is committed and
            // its result must remain stable across an op-log replay.
        }
        return response;
    }

    override async alarm(): Promise<void> {
        await this.maintainInvalidationDelivery();
    }

    /** Execute a registered shard-local query without exposing it through Gateway yet. */
    async query(request: CdbQueryRequest): Promise<CdbQueryResponse> {
        try {
            const descriptor = resolveQuery(this.mutationManifest(), request.ref);
            const database = wrapQueryDb(drizzle(this.ctx.storage, { schema: this.mutationSchema() }), request.auth);
            const result = await descriptor.invokeValidated(
                { db: readOnlyQueryDb(database), auth: request.auth },
                request.args
            );
            return { ok: true, result: rawJsonResult(result, "query result") };
        } catch (error) {
            return { ok: false, error: cdbRuntimeError(error).toJSON() };
        }
    }

    /** Execute the query persisted for one active live registration. */
    async queryRegistered(request: CdbRegisteredQueryRequest): Promise<CdbQueryResponse> {
        try {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const row = sql.one<StoredSubscriptionRow>(
                `SELECT gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                        principal_id, organization_id, ref, args_json, query_hash, tables_json, intervals_json
                 FROM _chardb_live_subscriptions
                 WHERE gateway_id = ? AND registration_id = ?`,
                request.subscription.gatewayId,
                request.subscription.registrationId
            );
            if (!row) throw subscriptionInvariant("registered query subscription does not exist");
            if (!sameSubscriptionIdentity(row, request.subscription)) {
                throw subscriptionInvariant("registered query identity does not match its subscription");
            }
            if (row.state !== "active") throw subscriptionInvariant("registered query subscription is retired");
            if (row.principal_id !== request.auth.userId) {
                throw subscriptionInvariant("registered query principal does not match fresh authorization");
            }
            if (row.organization_id !== request.auth.tenantId) {
                throw subscriptionInvariant("registered query organization does not match fresh authorization");
            }

            const subscription = parseStoredSubscription(row);
            assertSubscriptionTables(sql, subscription.subscription, [...new Set(subscription.tables)].sort());
            this.prepareIntervals(subscription);

            const routed = routeValidatedQuery(this.mutationManifest(), {
                ref: subscription.ref,
                args: subscription.args,
            });
            if (routed.authority !== "organization") {
                throw subscriptionInvariant("registered query no longer has organization authority");
            }
            if (routed.partitionKey !== subscription.organizationId) {
                throw subscriptionInvariant("registered query organization partition changed after registration");
            }
            if (routed.queryHash !== subscription.queryHash) {
                throw subscriptionInvariant("registered query intent changed after registration");
            }

            const descriptor = resolveQuery(this.mutationManifest(), subscription.ref);
            const database = wrapQueryDb(drizzle(this.ctx.storage, { schema: this.mutationSchema() }), request.auth);
            const result = rawJsonResult(
                await descriptor.invokeValidated(
                    { db: readOnlyQueryDb(database), auth: request.auth },
                    subscription.args
                ),
                "registered query result"
            );
            if (!Array.isArray(result)) {
                throw subscriptionInvariant("registered query result must be an array");
            }
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: cdbRuntimeError(error).toJSON() };
        }
    }

    /**
     * Project a committed row through every registered index and return the
     * affected subscription identities. Used by the Gateway to coalesce pokes.
     */
    matchSubsForRow(table: string, indexedKeys: { indexName: string; key: IntervalKey }[]): LiveSubscriptionId[] {
        const hits = new Set<string>();
        for (const { indexName, key } of indexedKeys) {
            for (const sub of this.intervalMap.match(table, indexName, key)) hits.add(sub);
        }
        const subscriptions: LiveSubscriptionId[] = [];
        for (const key of hits) {
            const subscription = this.subscriptions.get(key);
            if (subscription) subscriptions.push(subscription);
        }
        return subscriptions;
    }

    /**
     * Snapshot the current op-log row id. The Catalog records this as the
     * shard's bookmark for an open barrier, giving every barrier a per-shard
     * coordinate that PITR restore can replay forward to.
     */
    /**
     * Source-side begin: records the migration in `_chardb_split_state` and
     * installs `AFTER INSERT/UPDATE/DELETE` triggers on each migrating table
     * that project changes into `_chardb_split_log`. The destination later
     * replays those rows in LSN order, filtering by `vshardOf(partition_key)`
     * so peer migrations on the same source don't cross-pollute. Triggers are
     * `IF NOT EXISTS`, so re-entry after a crash is idempotent.
     */
    async beginReshardSource(args: {
        migId: string;
        rangeLo: number;
        rangeHi: number;
        tables: readonly TableSpec[];
    }): Promise<{ enabled: boolean; triggersInstalled: number }> {
        let triggers = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `INSERT INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
         VALUES (?, ?, ?, 'source', 1, ?)
         ON CONFLICT(mig_id) DO UPDATE SET capture = 1, updated_at = excluded.updated_at`,
                args.migId,
                args.rangeLo,
                args.rangeHi,
                Date.now()
            );
            for (const t of args.tables) {
                const ts = renderTableTriggers(args.migId, t);
                for (const stmt of ts.install) {
                    sql.exec(stmt);
                    triggers++;
                }
            }
        });
        return { enabled: true, triggersInstalled: triggers };
    }

    /** Destination-shard counterpart; tracks the migration so duplicate applies are rejected. */
    async beginReshardDest(args: {
        migId: string;
        rangeLo: number;
        rangeHi: number;
    }): Promise<{ ready: boolean }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT OR IGNORE INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
       VALUES (?, ?, ?, 'dest', 0, ?)`,
            args.migId,
            args.rangeLo,
            args.rangeHi,
            Date.now()
        );
        return { ready: true };
    }

    /** Returns the tail-capture watermark — the latest `_chardb_split_log.lsn` Source has produced. */
    async tailWatermark(migId: string): Promise<{ lsn: number }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ max_lsn: number | null }>(
            "SELECT MAX(lsn) AS max_lsn FROM _chardb_split_log WHERE mig_id = ?",
            migId
        );
        return { lsn: row?.max_lsn ?? 0 };
    }

    /**
     * Read one paginated bulk-copy batch from this (source) shard. The batch
     * contains rows whose partition column hashes into `[lo, hi]`; the caller
     * pages by `afterRowid` until `done=true`. Rows are returned as plain
     * column maps so the destination can reuse `renderRowApply`.
     */
    async bulkCopyBatch(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        afterRowid: number;
        limit: number;
    }): Promise<{ rows: readonly Record<string, RawJson>[]; lastRowid: number; done: boolean }> {
        const ident = quoteIdent(args.table.name);
        const cols = args.table.columns.map(quoteIdent).join(", ");
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const raw = sql.all<Record<string, RawJson> & { rowid: number }>(
            `SELECT rowid, ${cols} FROM ${ident} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            args.afterRowid,
            args.limit
        );
        const rows = filterRowsInRange(raw, args.table.partitionColumn, args.range);
        const lastRowid = raw.at(-1)?.rowid ?? args.afterRowid;
        const done = raw.length < args.limit;
        return { rows, lastRowid, done };
    }

    /**
     * Apply a bulk-copy batch on this (destination) shard. Each row is filtered
     * by `vshardOf(partition_key) ∈ range` defensively so a misrouted batch
     * cannot corrupt non-migrating data, then upserted via `INSERT OR REPLACE`.
     * The whole batch runs in a single `transactionSync` to keep destination
     * state consistent against retries.
     */
    async applyBulkBatch(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        rows: readonly Record<string, RawJson>[];
    }): Promise<{ applied: number; skipped: number }> {
        const accepted = filterRowsInRange(args.rows, args.table.partitionColumn, args.range);
        const skipped = args.rows.length - accepted.length;
        let applied = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const r of accepted) {
                const { sql: stmt, params } = renderRowApply(args.table, r);
                sql.exec(stmt, ...(params as readonly (string | number | bigint | Uint8Array | null)[]));
                applied++;
            }
        });
        return { applied, skipped };
    }

    /**
     * Drain the source's `_chardb_split_log` for a migration. The returned rows
     * are ordered by `lsn` and bounded by `limit`; the destination applies them
     * via `applyTailBatch`. The split log is preserved on the source until
     * `finishReshardSource` so a crash mid-replay can resume.
     */
    async readTailBatch(args: {
        migId: string;
        afterLsn: number;
        limit: number;
    }): Promise<{
        entries: readonly TailEntry[];
        lastLsn: number;
        done: boolean;
    }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const entries = sql.all<TailEntry>(
            "SELECT lsn, op, table_name, pk, after, before FROM _chardb_split_log WHERE mig_id = ? AND lsn > ? ORDER BY lsn LIMIT ?",
            args.migId,
            args.afterLsn,
            args.limit
        );
        const lastLsn = entries.at(-1)?.lsn ?? args.afterLsn;
        const done = entries.length < args.limit;
        return { entries, lastLsn, done };
    }

    /**
     * Apply a tail batch on the destination. `ins`/`upd` decode `after` (a
     * trigger-emitted JSON object) and upsert; `del` deletes by partition
     * column = `pk`. Range-filtered defensively as in `applyBulkBatch`.
     */
    async applyTailBatch(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        entries: readonly TailEntry[];
    }): Promise<{ applied: number; lastLsn: number }> {
        let applied = 0;
        let lastLsn = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const e of args.entries) {
                lastLsn = e.lsn;
                const pk = parseScalarPk(e.pk);
                if (!isPkInRange(pk, args.range)) continue;
                if (e.op === "del") {
                    sql.exec(
                        `DELETE FROM ${quoteIdent(args.table.name)} WHERE ${quoteIdent(args.table.partitionColumn)} = ?`,
                        pk
                    );
                } else {
                    const row = parseJsonColumn("after", e.after);
                    if (!row) continue;
                    const { sql: stmt, params } = renderRowApply(args.table, row);
                    sql.exec(stmt, ...(params as readonly (string | number | bigint | Uint8Array | null)[]));
                }
                applied++;
            }
            sql.exec(
                "UPDATE _chardb_split_state SET applied_lsn = MAX(applied_lsn, ?), updated_at = ? WHERE mig_id = ?",
                lastLsn,
                Date.now(),
                args.migId
            );
        });
        return { applied, lastLsn };
    }

    /**
     * Post-cutover, delete the migrated rows from the source and tear down
     * the per-table triggers + the split-state record. Idempotent: a
     * re-entry deletes nothing because the destination already owns the
     * migrated keys via the new range table.
     */
    async dropMigratedRange(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        batchSize: number;
    }): Promise<{ deleted: number; done: boolean }> {
        const ident = quoteIdent(args.table.name);
        const pkCol = quoteIdent(args.table.partitionColumn);
        let deleted = 0;
        let done = true;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const rows = sql.all<{ rowid: number; pk: RawJson }>(
                `SELECT rowid, ${pkCol} AS pk FROM ${ident} ORDER BY rowid LIMIT ?`,
                args.batchSize
            );
            const candidates: number[] = [];
            for (const r of rows) {
                if (isPkInRange(r.pk, args.range)) candidates.push(r.rowid);
            }
            for (const rid of candidates) {
                sql.exec(`DELETE FROM ${ident} WHERE rowid = ?`, rid);
                deleted++;
            }
            done = rows.length < args.batchSize;
        });
        return { deleted, done };
    }

    /**
     * Tear down the per-migration triggers and mark the split-state row as
     * drained. After this call the source is clean of all migration artifacts.
     */
    async finishReshardSource(args: { migId: string; tables: readonly TableSpec[] }): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const t of args.tables) {
                const ts = renderTableTriggers(args.migId, t);
                for (const stmt of ts.uninstall) sql.exec(stmt);
            }
            sql.exec(
                "UPDATE _chardb_split_state SET capture = 0, drained = 1, updated_at = ? WHERE mig_id = ?",
                Date.now(),
                args.migId
            );
            sql.exec("DELETE FROM _chardb_split_log WHERE mig_id = ?", args.migId);
        });
    }

    async barrierBookmark(): Promise<number> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ max_id: number | null }>("SELECT MAX(rowid) AS max_id FROM _chardb_op_log");
        return row?.max_id ?? 0;
    }
}

/** Bind one application schema and handler manifest into a shard-local DO class. */
export function configureCdbRuntime<TSchema extends Record<string, unknown>>(
    config: CdbRuntimeConfig<TSchema>
): typeof Cdb {
    return class ConfiguredCdb extends Cdb {
        protected override mutationSchema(): TSchema {
            return config.schema();
        }

        protected override mutationManifest(): ChardbManifest {
            return config.manifest();
        }
    };
}

function cdbRuntimeError(error: unknown): CdbError {
    if (isCdbError(error)) return error;
    if (error instanceof Error) {
        const match = /^(CDB_[A-Z_]+)(?::\s*)?/.exec(error.message);
        if (match?.[1] && isCdbErrorCode(match[1])) {
            return new CdbError({ code: match[1], message: error.message });
        }
        return new CdbError({ code: "CDB_INVARIANT", message: error.message });
    }
    return new CdbError({ code: "CDB_INVARIANT", message: "mutation failed with a non-Error value" });
}

export type { IntervalSet, IntervalKey };
export { SubId };

export interface TailEntry {
    lsn: number;
    op: "ins" | "upd" | "del";
    table_name: string;
    pk: string;
    /** `json_object(...)` of the post-image; `null` for `del` ops. */
    after: JsonText | null;
    /** `json_object(...)` of the pre-image (currently only set for `del`). */
    before: JsonText | null;
}

const ALLOWED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function quoteIdent(raw: string): string {
    if (!ALLOWED_IDENT.test(raw)) throw new Error(`reshard: refusing identifier: ${raw}`);
    return `"${raw}"`;
}

function parseScalarPk(s: string): string | number {
    const n = Number(s);
    if (s !== "" && Number.isFinite(n) && String(n) === s) return n;
    return s;
}

function isPkInRange(value: unknown, range: RangeFilter): boolean {
    return inRange(value, range);
}
