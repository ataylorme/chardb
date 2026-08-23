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

export class Catalog extends DurableObject<CatalogEnv> {
    private bootstrapped = false;
    private authTablesBootstrapped = false;
    private cachedMap: VshardMap | null = null;

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
