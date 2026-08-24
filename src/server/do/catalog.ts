/**
 * `Catalog` DO.
 *
 * Single per logical DB. Holds:
 *   - schema + colocation graph + partition contract digest
 *   - (vshard_lo, vshard_hi) → ShardDO range table (split-only, never merge)
 *   - epoch counters: schema_epoch, auth_epoch_global, auth_epoch_tenant, auth_epoch_principal
 *   - JWKS cache (SWR)
 *   - reference tables (replicated)
 *   - barrier records (PITR + tenant snapshot)
 *
 * Epoch bumps are CAS-guarded: every bump runs as `UPDATE … SET epoch=epoch+1`
 * inside `transactionSync`; concurrent admin actions serialize at the DO input
 * gate. Bootstrap blocks new requests until the schema migration has run via
 * `state.blockConcurrencyWhile`
 * (https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile).
 */

import { DurableObject } from "cloudflare:workers";
import { renderSqliteTableDdl } from "../../auth/ddl.ts";
import {
    type CatalogJwkResolution,
    type CatalogJwkResolutionRequest,
    JWKS_CACHE_TTL_MS,
    JWKS_FAILURE_BACKOFF_INITIAL_MS,
    JWKS_FAILURE_BACKOFF_MAX_MS,
    JWKS_MAX_KID_BYTES,
    JWKS_REFRESH_LEASE_MS,
    JWKS_SUCCESS_COOLDOWN_MS,
    fetchValidatedJwks,
    parseCachedJwk,
} from "../../auth/jwks_cache.ts";
import { getAuthRuntime, placementFor, tableFor } from "../../auth/runtime.ts";
import { authCreate, authDelete, authFindMany, authFindOne, authUpdate } from "../../auth/sql.ts";
import { CdbError } from "../../errors.ts";
import type { RawJson } from "../../types.ts";
import { type PrincipalId, ShardId, type TenantId, type Vshard } from "../../types.ts";
import { VSHARD_COUNT, VshardMap, type VshardRange } from "../../vshard.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

const CATALOG_DDL = `
CREATE TABLE IF NOT EXISTS catalog_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_ranges (
  lo INTEGER NOT NULL,
  hi INTEGER NOT NULL,
  shard_id TEXT NOT NULL,
  PRIMARY KEY (lo)
);
CREATE TABLE IF NOT EXISTS catalog_epoch (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
CREATE TABLE IF NOT EXISTS catalog_jwks (
  kid TEXT PRIMARY KEY,
  jwk_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_jwks_v2 (
  jwks_url TEXT NOT NULL,
  kid TEXT NOT NULL,
  jwk_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (jwks_url, kid)
);
CREATE TABLE IF NOT EXISTS catalog_jwks_refresh (
  jwks_url TEXT PRIMARY KEY,
  next_fetch_at INTEGER NOT NULL,
  refreshing_until INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  last_success_at INTEGER
);
CREATE TABLE IF NOT EXISTS catalog_barrier (
  barrier_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  expected_shards TEXT NOT NULL,
  ack_shards TEXT NOT NULL,
  bookmarks TEXT NOT NULL,
  tenant_prefix TEXT
);
CREATE TABLE IF NOT EXISTS catalog_policy_digest (
  digest TEXT PRIMARY KEY,
  set_at INTEGER NOT NULL
);
` as const;

export type CatalogEnv = Record<string, never>;

type AuthEpochScope = "global" | "tenant" | "principal";
type CatalogSql = ReturnType<typeof adaptSqlStorage>;

const JWKS_URL_MAX_BYTES = 2_048;

const JWKS_V2_COLUMNS = [
    ["jwks_url", "TEXT", 1, 1],
    ["kid", "TEXT", 1, 2],
    ["jwk_json", "TEXT", 1, 0],
    ["fetched_at", "INTEGER", 1, 0],
    ["expires_at", "INTEGER", 1, 0],
] as const;

const JWKS_REFRESH_COLUMNS = [
    ["jwks_url", "TEXT", 0, 1],
    ["next_fetch_at", "INTEGER", 1, 0],
    ["refreshing_until", "INTEGER", 1, 0],
    ["failure_count", "INTEGER", 1, 0],
    ["last_success_at", "INTEGER", 0, 0],
] as const;

type JwksRefreshOutcome =
    | { readonly ok: true }
    | { readonly ok: false; readonly message: string; readonly retryAfterMs: number };

function assertInternalTable(
    sql: CatalogSql,
    table: "catalog_jwks_v2" | "catalog_jwks_refresh",
    expected: readonly (readonly [name: string, type: string, notnull: number, pk: number])[]
): void {
    const actual = sql
        .all<{ name: string; type: string; notnull: number; pk: number }>(`PRAGMA table_info('${table}')`)
        .map(row => [row.name, row.type.toUpperCase(), row.notnull, row.pk] as const);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `Catalog internal schema mismatch for ${table}`,
        });
    }
}

function normalizeJwksUrl(rawUrl: string): string | null {
    if (new TextEncoder().encode(rawUrl).byteLength > JWKS_URL_MAX_BYTES) return null;
    try {
        const url = new URL(rawUrl);
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function jwksResolutionUnavailable(message: string, retryAfterMs: number): CatalogJwkResolution {
    return { ok: false, message, retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)) };
}

function addEpochScope(
    scopes: Map<string, { scope: AuthEpochScope; scopeId: string }>,
    scope: AuthEpochScope,
    scopeId: string
) {
    scopes.set(`${scope}\0${scopeId}`, { scope, scopeId });
}

function addRowEpochScopes(
    scopes: Map<string, { scope: AuthEpochScope; scopeId: string }>,
    model: string,
    row: Record<string, RawJson>
): void {
    const rule = placementFor(model);
    if (rule.kind === "replicated") {
        addEpochScope(scopes, "global", "global");
    } else {
        const scopeId = row[rule.column];
        if (typeof scopeId === "string") addEpochScope(scopes, rule.kind, scopeId);
    }

    // Membership-like models affect both halves of auth-dependent state.
    // The placement rule supplies the primary scope; conventional Better
    // Auth fields add the other scope when the row carries one.
    if (typeof row.organizationId === "string") addEpochScope(scopes, "tenant", row.organizationId);
    if (typeof row.userId === "string") addEpochScope(scopes, "principal", row.userId);
}

function bumpAuthEpochInSql(sql: CatalogSql, scope: AuthEpochScope, scopeId: string): number {
    const dbScope = scope === "global" ? "auth_global" : scope === "tenant" ? "auth_tenant" : "auth_principal";
    sql.exec("INSERT OR IGNORE INTO catalog_epoch (scope, scope_id, epoch) VALUES (?, ?, 0)", dbScope, scopeId);
    sql.exec("UPDATE catalog_epoch SET epoch = epoch + 1 WHERE scope = ? AND scope_id = ?", dbScope, scopeId);
    const row = sql.one<{ epoch: number }>(
        "SELECT epoch FROM catalog_epoch WHERE scope = ? AND scope_id = ?",
        dbScope,
        scopeId
    );
    return row?.epoch ?? 1;
}

export interface RouteResult {
    readonly shardId: ShardId;
    readonly schemaEpoch: number;
}

export interface OrganizationAuthorityRequest {
    /** Subject from a successfully signature-verified JWT. */
    readonly principalId: PrincipalId;
    /** Organization selected by the operation, not by JWT role claims. */
    readonly organizationId: TenantId;
}

export interface OrganizationAuthority {
    readonly principalId: PrincipalId;
    readonly organizationId: TenantId;
    /** Canonical comma-separated Better Auth membership role. */
    readonly role: string;
    /** Sorted, deduplicated membership roles. */
    readonly roles: readonly string[];
    readonly authEpochs: {
        readonly global: number;
        readonly tenant: number;
        readonly principal: number;
    };
}

export class Catalog extends DurableObject<CatalogEnv> {
    private bootstrapped = false;
    private authTablesBootstrapped = false;
    private cachedMap: VshardMap | null = null;
    private readonly jwksRefreshes = new Map<string, Promise<JwksRefreshOutcome>>();

    constructor(state: DurableObjectState, env: CatalogEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    private async bootstrap(): Promise<void> {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("PRAGMA foreign_keys = ON");
        for (const stmt of CATALOG_DDL.split(";")
            .map(s => s.trim())
            .filter(Boolean)) {
            sql.exec(stmt);
        }
        assertInternalTable(sql, "catalog_jwks_v2", JWKS_V2_COLUMNS);
        assertInternalTable(sql, "catalog_jwks_refresh", JWKS_REFRESH_COLUMNS);
        sql.exec(
            "INSERT OR IGNORE INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)",
            0,
            VSHARD_COUNT - 1,
            "ShardDO_0"
        );
        sql.exec(
            "INSERT OR IGNORE INTO catalog_epoch (scope, scope_id, epoch) VALUES (?, ?, ?)",
            "schema",
            "global",
            1
        );
        sql.exec(
            "INSERT OR IGNORE INTO catalog_epoch (scope, scope_id, epoch) VALUES (?, ?, ?)",
            "auth_global",
            "global",
            1
        );
        this.ensureAuthTables();
        this.bootstrapped = true;
    }

    /**
     * Materialize every synthesized auth table in the singleton Catalog.
     * Central storage supports Better Auth's normal secondary lookups
     * without cross-shard scans or auth-specific GSI maintenance. The DDL
     * is rendered from the synthesized Drizzle schema so plugin tables and
     * column additions flow through automatically.
     */
    private ensureAuthTables(): void {
        if (this.authTablesBootstrapped) return;
        let runtime: ReturnType<typeof getAuthRuntime>;
        try {
            runtime = getAuthRuntime();
        } catch {
            // Auth runtime not bound — chardb({auth}) wasn't configured.
            // Catalog still needs to function for non-auth deployments.
            return;
        }
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const table of Object.values(runtime.schema)) {
                const ddl = renderSqliteTableDdl(table);
                const metadataKey = `auth_ddl_v1:${ddl.tableName}`;
                const existing = sql.one<{ sql: string }>(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                    ddl.tableName
                );
                const recorded = sql.one<{ v: string }>("SELECT v FROM catalog_meta WHERE k = ?", metadataKey);
                if (existing) {
                    if (recorded?.v !== ddl.signature) {
                        throw new CdbError({
                            code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
                            message: `Catalog auth table "${ddl.tableName}" predates auth DDL v1 or has an incompatible schema`,
                            hint: "recreate pre-release Catalog storage or add an explicit auth schema migration",
                        });
                    }
                    for (const indexName of ddl.indexNames) {
                        const present = sql.one<{ name: string }>(
                            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = ?",
                            indexName,
                            ddl.tableName
                        );
                        if (!present) {
                            throw new CdbError({
                                code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
                                message: `Catalog auth table "${ddl.tableName}" is missing a declared index`,
                                hint: "recreate pre-release Catalog storage or add an explicit auth schema migration",
                            });
                        }
                    }
                    continue;
                }
                sql.exec(ddl.createTable);
                for (const statement of ddl.indexes) sql.exec(statement);
                sql.exec("INSERT OR REPLACE INTO catalog_meta (k, v) VALUES (?, ?)", metadataKey, ddl.signature);
            }
        });
        this.authTablesBootstrapped = true;
    }

    /** Run a Better Auth model write against Catalog-owned storage. */
    async mutateAuth(args: {
        readonly model: string;
        readonly op: "create" | "update" | "delete";
        readonly where?: { readonly [k: string]: RawJson };
        readonly payload?: { readonly [k: string]: RawJson };
    }): Promise<{
        readonly ok: true;
        readonly row?: Record<string, RawJson> | null;
        readonly affected?: number;
    }> {
        await this.bootstrap();
        this.ensureAuthTables();
        const table = tableFor(args.model);
        let row: Record<string, RawJson> | null | undefined;
        let affected = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const scopes = new Map<string, { scope: AuthEpochScope; scopeId: string }>();
            switch (args.op) {
                case "create": {
                    if (!args.payload) throw new Error("auth: create requires payload");
                    row = authCreate(sql, table, args.payload);
                    affected = 1;
                    addRowEpochScopes(scopes, args.model, row);
                    break;
                }
                case "update": {
                    if (!args.where || !args.payload) {
                        throw new Error("auth: update requires where and payload");
                    }
                    const before = authFindMany(sql, table, args.where);
                    const r = authUpdate(sql, table, args.where, args.payload);
                    affected = r.affected;
                    if (affected > 0) {
                        const after = before.map(previous => ({ ...previous, ...args.payload }));
                        row = r.row ?? after[0] ?? null;
                        for (const previous of before) addRowEpochScopes(scopes, args.model, previous);
                        for (const next of after) addRowEpochScopes(scopes, args.model, next);
                    } else {
                        row = r.row;
                    }
                    break;
                }
                case "delete": {
                    if (!args.where) throw new Error("auth: delete requires where");
                    const before = authFindMany(sql, table, args.where);
                    affected = authDelete(sql, table, args.where).affected;
                    if (affected > 0) {
                        for (const previous of before) addRowEpochScopes(scopes, args.model, previous);
                    }
                    break;
                }
            }
            for (const scope of scopes.values()) bumpAuthEpochInSql(sql, scope.scope, scope.scopeId);
        });
        return { ok: true, row: row ?? null, affected };
    }

    /** Read Better Auth rows from Catalog-owned storage. */
    async queryAuth(args: {
        readonly model: string;
        readonly where: { readonly [k: string]: RawJson };
        readonly limit?: number;
    }): Promise<readonly Record<string, RawJson>[]> {
        await this.bootstrap();
        this.ensureAuthTables();
        const table = tableFor(args.model);
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        if (args.limit === 1) {
            const one = authFindOne(sql, table, args.where);
            return one ? [one] : [];
        }
        return authFindMany(sql, table, args.where, args.limit);
    }

    /**
     * Resolve organization authority from Catalog-owned Better Auth rows.
     * JWT tenant and role claims are deliberately absent from this boundary:
     * the caller supplies only its verified subject and requested organization.
     */
    async resolveOrganizationAuthority(args: OrganizationAuthorityRequest): Promise<OrganizationAuthority | null> {
        await this.bootstrap();
        if (!args.principalId || !args.organizationId) return null;

        let runtime: ReturnType<typeof getAuthRuntime>;
        try {
            runtime = getAuthRuntime();
        } catch (error) {
            if (error instanceof CdbError && error.code === "CDB_AUTH_NOT_BOUND") return null;
            throw error;
        }
        const authSchema = runtime.schema as unknown as Record<string, unknown>;
        if (!authSchema.organization || !authSchema.member) return null;

        this.ensureAuthTables();
        const organizationTable = tableFor("organization");
        const memberTable = tableFor("member");
        let authority: OrganizationAuthority | null = null;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const organization = authFindOne(sql, organizationTable, { id: args.organizationId });
            if (!organization) return;
            const membership = authFindOne(sql, memberTable, {
                organizationId: args.organizationId,
                userId: args.principalId,
            });
            const roles = canonicalMembershipRoles(membership?.role);
            if (roles.length === 0) return;
            authority = {
                principalId: args.principalId,
                organizationId: args.organizationId,
                role: roles.join(","),
                roles,
                authEpochs: {
                    global: this.readEpoch("auth_global", "global"),
                    tenant: this.readEpoch("auth_tenant", args.organizationId),
                    principal: this.readEpoch("auth_principal", args.principalId),
                },
            };
        });
        return authority;
    }

    private map(): VshardMap {
        if (this.cachedMap) return this.cachedMap;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const rows: VshardRange[] = [];
        const cursor = this.ctx.storage.sql.exec<{ lo: number; hi: number; shard_id: string }>(
            "SELECT lo, hi, shard_id FROM catalog_ranges ORDER BY lo ASC"
        );
        for (const r of cursor) rows.push({ lo: r.lo, hi: r.hi, shardId: ShardId(r.shard_id) });
        void sql;
        this.cachedMap = new VshardMap(rows);
        return this.cachedMap;
    }

    async route(vshard: number): Promise<RouteResult> {
        return {
            shardId: this.map().routeVshard(vshard as Vshard),
            schemaEpoch: this.readEpoch("schema", "global"),
        };
    }

    /** Return each physical shard that owns at least one current vshard range. */
    async listShardIds(): Promise<readonly ShardId[]> {
        const shardIds: ShardId[] = [];
        const cursor = this.ctx.storage.sql.exec<{ shard_id: string }>(
            "SELECT DISTINCT shard_id FROM catalog_ranges ORDER BY shard_id ASC"
        );
        for (const row of cursor) shardIds.push(ShardId(row.shard_id));
        return shardIds;
    }

    /**
     * Atomic cutover for a vshard range. Combines (a) the range-table edit that
     * reassigns `[lo, hi]` from `fromShard` to `toShard`, (b) a schema-epoch
     * bump that invalidates every cached client route, and (c) an idempotency
     * guard keyed by `migId` so a retry after a crash sees `applied=true` and
     * leaves state unchanged. The whole sequence runs inside a single
     * `transactionSync` so external observers either see the pre-cutover map at
     * `epoch=N` or the post-cutover map at `epoch=N+1`, never a half-applied
     * intermediate. Mirrors the `CatalogCutover` action in `spec/Resharder.tla`.
     */
    async cutover(args: {
        migId: string;
        lo: number;
        hi: number;
        fromShard: string;
        toShard: string;
    }): Promise<{ applied: boolean; newEpoch: number }> {
        let applied = false;
        let newEpoch = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const guard = sql.one<{ v: string }>("SELECT v FROM catalog_meta WHERE k = ?", `cutover:${args.migId}`);
            if (guard) {
                newEpoch = this.readEpoch("schema", "global");
                return;
            }
            const next = this.map().split(args.lo, args.hi, ShardId(args.toShard));
            sql.exec("DELETE FROM catalog_ranges");
            for (const r of next.ranges_()) {
                sql.exec("INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)", r.lo, r.hi, r.shardId);
            }
            sql.exec("UPDATE catalog_epoch SET epoch = epoch + 1 WHERE scope = 'schema' AND scope_id = 'global'");
            sql.exec("INSERT INTO catalog_meta (k, v) VALUES (?, ?)", `cutover:${args.migId}`, args.fromShard);
            this.cachedMap = next;
            applied = true;
            const row = sql.one<{ epoch: number }>(
                "SELECT epoch FROM catalog_epoch WHERE scope = 'schema' AND scope_id = 'global'"
            );
            newEpoch = row?.epoch ?? 0;
        });
        return { applied, newEpoch };
    }

    async splitRange(lo: number, hi: number, toShard: string): Promise<void> {
        const next = this.map().split(lo, hi, ShardId(toShard));
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec("DELETE FROM catalog_ranges");
            for (const r of next.ranges_()) {
                sql.exec("INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)", r.lo, r.hi, r.shardId);
            }
            sql.exec("UPDATE catalog_epoch SET epoch = epoch + 1 WHERE scope = 'schema' AND scope_id = 'global'");
        });
        this.cachedMap = next;
    }

    bumpAuthEpoch(scope: "global" | "tenant" | "principal", scopeId: string): number {
        let next = 1;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            next = bumpAuthEpochInSql(sql, scope, scopeId);
        });
        return next;
    }

    private readEpoch(scope: string, scopeId: string): number {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ epoch: number }>(
            "SELECT epoch FROM catalog_epoch WHERE scope = ? AND scope_id = ?",
            scope,
            scopeId
        );
        return row?.epoch ?? 0;
    }

    authEpoch(args: { tenantId?: TenantId; principalId?: PrincipalId }): {
        global: number;
        tenant: number;
        principal: number;
    } {
        return {
            global: this.readEpoch("auth_global", "global"),
            tenant: args.tenantId ? this.readEpoch("auth_tenant", args.tenantId) : 0,
            principal: args.principalId ? this.readEpoch("auth_principal", args.principalId) : 0,
        };
    }

    async resolveJwk(request: CatalogJwkResolutionRequest): Promise<CatalogJwkResolution> {
        const jwksUrl = normalizeJwksUrl(request.jwksUrl);
        if (jwksUrl === null) {
            return jwksResolutionUnavailable("Catalog JWKS URL is invalid", JWKS_FAILURE_BACKOFF_MAX_MS);
        }
        if (request.kid.length === 0 || new TextEncoder().encode(request.kid).byteLength > JWKS_MAX_KID_BYTES) {
            return { ok: true, jwkJson: null };
        }

        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const scoped = this.readScopedJwk(sql, jwksUrl, request.kid);
        if (scoped && scoped.expiresAt > Date.now()) {
            try {
                parseCachedJwk(scoped.jwkJson);
                return { ok: true, jwkJson: scoped.jwkJson };
            } catch {
                // A corrupt cache row is never trusted. Treat it like an
                // expired row and require a successful remote replacement.
            }
        }

        const refreshState = sql.one<{
            next_fetch_at: number;
            refreshing_until: number;
            failure_count: number;
        }>(
            `SELECT next_fetch_at, refreshing_until, failure_count
             FROM catalog_jwks_refresh WHERE jwks_url = ?`,
            jwksUrl
        );

        const existing = this.jwksRefreshes.get(jwksUrl);
        if (existing) return this.finishJwkResolution(existing, jwksUrl, request.kid);

        const now = Date.now();
        if (refreshState && refreshState.refreshing_until > now) {
            return jwksResolutionUnavailable(
                "Catalog JWKS refresh is already in progress",
                refreshState.refreshing_until - now
            );
        }
        if (refreshState && refreshState.next_fetch_at > now) {
            if (refreshState.failure_count > 0) {
                return jwksResolutionUnavailable(
                    "Catalog JWKS refresh is cooling down after a failure",
                    refreshState.next_fetch_at - now
                );
            }
            if (!scoped) return { ok: true, jwkJson: null };
        }

        this.markJwksRefreshLease(sql, jwksUrl, now + JWKS_REFRESH_LEASE_MS);
        const refresh = this.refreshJwks(jwksUrl);
        this.jwksRefreshes.set(jwksUrl, refresh);
        try {
            return await this.finishJwkResolution(refresh, jwksUrl, request.kid);
        } finally {
            if (this.jwksRefreshes.get(jwksUrl) === refresh) this.jwksRefreshes.delete(jwksUrl);
        }
    }

    private async finishJwkResolution(
        refresh: Promise<JwksRefreshOutcome>,
        jwksUrl: string,
        kid: string
    ): Promise<CatalogJwkResolution> {
        const outcome = await refresh;
        if (!outcome.ok) return outcome;
        const row = this.readScopedJwk(adaptSqlStorage(this.ctx.storage.sql), jwksUrl, kid);
        if (!row || row.expiresAt <= Date.now()) return { ok: true, jwkJson: null };
        try {
            parseCachedJwk(row.jwkJson);
            return { ok: true, jwkJson: row.jwkJson };
        } catch {
            return jwksResolutionUnavailable("Catalog stored an invalid JWK", JWKS_FAILURE_BACKOFF_INITIAL_MS);
        }
    }

    private async refreshJwks(jwksUrl: string): Promise<JwksRefreshOutcome> {
        try {
            const fresh = await fetchValidatedJwks((url, init) => globalThis.fetch(url, init), jwksUrl);
            const now = Date.now();
            this.ctx.storage.transactionSync(() => {
                const sql = adaptSqlStorage(this.ctx.storage.sql);
                sql.exec("DELETE FROM catalog_jwks_v2 WHERE jwks_url = ?", jwksUrl);
                for (const key of fresh.keys) {
                    sql.exec(
                        `INSERT INTO catalog_jwks_v2
                         (jwks_url, kid, jwk_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
                        jwksUrl,
                        key.kid as string,
                        JSON.stringify(key),
                        now,
                        now + JWKS_CACHE_TTL_MS
                    );
                }
                sql.exec(
                    `INSERT INTO catalog_jwks_refresh
                     (jwks_url, next_fetch_at, refreshing_until, failure_count, last_success_at)
                     VALUES (?, ?, 0, 0, ?)
                     ON CONFLICT(jwks_url) DO UPDATE SET
                       next_fetch_at = excluded.next_fetch_at,
                       refreshing_until = 0,
                       failure_count = 0,
                       last_success_at = excluded.last_success_at`,
                    jwksUrl,
                    now + JWKS_SUCCESS_COOLDOWN_MS,
                    now
                );
            });
            return { ok: true };
        } catch (cause) {
            const now = Date.now();
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const previous = sql.one<{ failure_count: number }>(
                "SELECT failure_count FROM catalog_jwks_refresh WHERE jwks_url = ?",
                jwksUrl
            );
            const failureCount = Math.min((previous?.failure_count ?? 0) + 1, 31);
            const retryAfterMs = Math.min(
                JWKS_FAILURE_BACKOFF_MAX_MS,
                JWKS_FAILURE_BACKOFF_INITIAL_MS * 2 ** Math.min(failureCount - 1, 16)
            );
            try {
                sql.exec(
                    `INSERT INTO catalog_jwks_refresh
                     (jwks_url, next_fetch_at, refreshing_until, failure_count, last_success_at)
                     VALUES (?, ?, 0, ?, NULL)
                     ON CONFLICT(jwks_url) DO UPDATE SET
                       next_fetch_at = excluded.next_fetch_at,
                       refreshing_until = 0,
                       failure_count = excluded.failure_count`,
                    jwksUrl,
                    now + retryAfterMs,
                    failureCount
                );
            } catch {
                // The caller still receives a typed fail-closed result. A
                // broken Catalog store cannot promise durable cooldown state.
            }
            const message = cause instanceof Error ? cause.message : "Catalog JWKS refresh failed";
            return jwksResolutionUnavailable(message, retryAfterMs);
        }
    }

    private readScopedJwk(
        sql: CatalogSql,
        jwksUrl: string,
        kid: string
    ): { readonly jwkJson: string; readonly expiresAt: number } | null {
        const row = sql.one<{ jwk_json: string; expires_at: number }>(
            `SELECT jwk_json, expires_at FROM catalog_jwks_v2
             WHERE jwks_url = ? AND kid = ?`,
            jwksUrl,
            kid
        );
        return row ? { jwkJson: row.jwk_json, expiresAt: row.expires_at } : null;
    }

    private markJwksRefreshLease(sql: CatalogSql, jwksUrl: string, refreshingUntil: number): void {
        sql.exec(
            `INSERT INTO catalog_jwks_refresh
             (jwks_url, next_fetch_at, refreshing_until, failure_count, last_success_at)
             VALUES (?, 0, ?, 0, NULL)
             ON CONFLICT(jwks_url) DO UPDATE SET refreshing_until = excluded.refreshing_until`,
            jwksUrl,
            refreshingUntil
        );
    }

    async putJwk(kid: string, jwkJson: string, ttlMs: number): Promise<void> {
        const now = Date.now();
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT INTO catalog_jwks (kid, jwk_json, fetched_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kid) DO UPDATE SET jwk_json = excluded.jwk_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
            kid,
            jwkJson,
            now,
            now + ttlMs
        );
    }

    async getJwk(kid: string): Promise<{ jwkJson: string; expiresAt: number } | null> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ jwk_json: string; expires_at: number }>(
            "SELECT jwk_json, expires_at FROM catalog_jwks WHERE kid = ?",
            kid
        );
        return row ? { jwkJson: row.jwk_json, expiresAt: row.expires_at } : null;
    }

    async recordBarrier(args: {
        barrierId: string;
        ts: number;
        expectedShards: readonly string[];
        tenantPrefix?: string;
    }): Promise<void> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT OR REPLACE INTO catalog_barrier
       (barrier_id, ts, expected_shards, ack_shards, bookmarks, tenant_prefix) VALUES (?, ?, ?, '[]', '{}', ?)`,
            args.barrierId,
            args.ts,
            JSON.stringify(args.expectedShards),
            args.tenantPrefix ?? null
        );
    }

    /**
     * Records a shard ack against an outstanding barrier. The bookmark is the
     * shard's `_chardb_op_log` row id at the moment it observed the barrier;
     * a barrier is "complete" once every expected shard has acked, at which
     * point the (barrierId → bookmarks) map is the durable PITR snapshot
     * coordinate for the cluster.
     */
    async ackBarrier(args: {
        barrierId: string;
        shardId: string;
        bookmark: number;
    }): Promise<{ complete: boolean }> {
        let complete = false;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const row = sql.one<{ expected_shards: string; ack_shards: string; bookmarks: string }>(
                "SELECT expected_shards, ack_shards, bookmarks FROM catalog_barrier WHERE barrier_id = ?",
                args.barrierId
            );
            if (!row) return;
            const expected = JSON.parse(row.expected_shards) as string[];
            const acks = new Set<string>(JSON.parse(row.ack_shards) as string[]);
            const bookmarks = JSON.parse(row.bookmarks) as Record<string, number>;
            acks.add(args.shardId);
            bookmarks[args.shardId] = args.bookmark;
            sql.exec(
                "UPDATE catalog_barrier SET ack_shards = ?, bookmarks = ? WHERE barrier_id = ?",
                JSON.stringify([...acks].sort()),
                JSON.stringify(bookmarks),
                args.barrierId
            );
            complete = expected.every(s => acks.has(s));
        });
        return { complete };
    }

    /**
     * One barrier tick. Called by the parent Worker's cron at the cadence
     * controlled by `policy.pitr.barrierIntervalMs` (default 60s). Returns the
     * created barrier id so the caller can fan out shard-side ack RPCs.
     */
    async openBarrier(now: number): Promise<{ barrierId: string; expectedShards: readonly string[] }> {
        const expectedShards = [
            ...new Set(
                this.map()
                    .ranges_()
                    .map(r => r.shardId as string)
            ),
        ].sort();
        const barrierId = `b-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        await this.recordBarrier({ barrierId, ts: now, expectedShards });
        return { barrierId, expectedShards };
    }

    /**
     * Lists open (incomplete) barriers — useful for the doctor command and the
     * Resharder's "wait for last barrier ack" precondition before cutover.
     */
    async openBarriers(): Promise<readonly { barrierId: string; ts: number; missing: readonly string[] }[]> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const out: { barrierId: string; ts: number; missing: readonly string[] }[] = [];
        const cursor = this.ctx.storage.sql.exec<{
            barrier_id: string;
            ts: number;
            expected_shards: string;
            ack_shards: string;
        }>("SELECT barrier_id, ts, expected_shards, ack_shards FROM catalog_barrier ORDER BY ts ASC");
        for (const r of cursor) {
            const expected = JSON.parse(r.expected_shards) as string[];
            const acks = new Set<string>(JSON.parse(r.ack_shards) as string[]);
            const missing = expected.filter(s => !acks.has(s));
            if (missing.length > 0) out.push({ barrierId: r.barrier_id, ts: r.ts, missing });
        }
        void sql;
        return out;
    }
}

function canonicalMembershipRoles(value: RawJson | undefined): readonly string[] {
    if (typeof value !== "string") return [];
    return [
        ...new Set(
            value
                .split(",")
                .map(role => role.trim())
                .filter(Boolean)
        ),
    ].sort();
}
