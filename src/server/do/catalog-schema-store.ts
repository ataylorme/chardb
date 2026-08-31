import { CdbError } from "../../errors.ts";
import { VSHARD_COUNT } from "../../vshard.ts";
import { type ChardbMigrationJournal, migrationDigestAt, pendingMigrations } from "../schema-migrations.ts";
import { initializeCatalogBarrierStorage } from "./catalog-barrier-store.ts";
import type { adaptSqlStorage } from "./sql_adapter.ts";

export type CatalogSql = ReturnType<typeof adaptSqlStorage>;

export interface CatalogSchemaState {
    readonly activeVersion: number;
    readonly activeEpoch: number;
    readonly activeDigest: string;
    readonly lastMigrationId: string | null;
    readonly status: "active" | "migrating";
    readonly migrationId: string | null;
    readonly targetVersion: number | null;
    readonly targetEpoch: number | null;
    readonly targetDigest: string | null;
}

export interface CatalogSchemaShardState {
    readonly shardId: string;
    readonly status: "pending" | "active";
    readonly lastError: string | null;
    readonly updatedAt: number;
}

interface StoredCatalogSchemaState {
    readonly active_version: number;
    readonly active_epoch: number;
    readonly active_digest: string;
    readonly last_migration_id: string | null;
    readonly status: "active" | "migrating";
    readonly migration_id: string | null;
    readonly target_version: number | null;
    readonly target_epoch: number | null;
    readonly target_digest: string | null;
}

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
CREATE TABLE IF NOT EXISTS catalog_policy_digest (
  digest TEXT PRIMARY KEY,
  set_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_schema_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_version INTEGER NOT NULL CHECK (active_version >= 0),
  active_epoch INTEGER NOT NULL CHECK (active_epoch > 0),
  active_digest TEXT NOT NULL,
  last_migration_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'migrating')),
  migration_id TEXT,
  target_version INTEGER,
  target_epoch INTEGER,
  target_digest TEXT,
  CHECK (
    (status = 'active' AND migration_id IS NULL AND target_version IS NULL AND target_epoch IS NULL AND target_digest IS NULL)
    OR
    (status = 'migrating' AND migration_id IS NOT NULL AND target_version IS NOT NULL AND target_epoch IS NOT NULL AND target_digest IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS catalog_schema_shards (
  migration_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  last_error TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (migration_id, shard_id)
);
CREATE TABLE IF NOT EXISTS catalog_schema_steps (
  migration_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  digest TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  PRIMARY KEY (migration_id, version)
);
CREATE TABLE IF NOT EXISTS catalog_schema_baselines (
  migration_id TEXT PRIMARY KEY,
  target_version INTEGER NOT NULL CHECK (target_version > 0),
  target_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
` as const;

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

export function initializeCatalogStorage(sql: CatalogSql, journal: ChardbMigrationJournal): CatalogSchemaState {
    sql.exec("PRAGMA foreign_keys = ON");
    for (const statement of CATALOG_DDL.split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        sql.exec(statement);
    }
    initializeCatalogBarrierStorage(sql);
    assertInternalTable(sql, "catalog_jwks_v2", JWKS_V2_COLUMNS);
    assertInternalTable(sql, "catalog_jwks_refresh", JWKS_REFRESH_COLUMNS);
    sql.exec(
        "INSERT OR IGNORE INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)",
        0,
        VSHARD_COUNT - 1,
        "ShardDO_0"
    );
    sql.exec("INSERT OR IGNORE INTO catalog_epoch (scope, scope_id, epoch) VALUES (?, ?, ?)", "schema", "global", 1);
    sql.exec(
        `INSERT OR IGNORE INTO catalog_schema_state
         (singleton, active_version, active_epoch, active_digest, status)
         VALUES (1, ?, 1, ?, 'active')`,
        0,
        migrationDigestAt(journal, 0)
    );
    const schemaState = readCatalogSchemaState(sql);
    if (schemaState.activeVersion > journal.version) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: `Catalog schema version ${schemaState.activeVersion} is newer than packaged version ${journal.version}`,
        });
    }
    if (schemaState.activeDigest !== migrationDigestAt(journal, schemaState.activeVersion)) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: `Catalog schema digest does not match packaged migration version ${schemaState.activeVersion}`,
        });
    }
    if (
        schemaState.status === "migrating" &&
        (schemaState.targetVersion === null ||
            schemaState.targetVersion <= schemaState.activeVersion ||
            schemaState.targetVersion > journal.version ||
            schemaState.targetEpoch !== schemaState.activeEpoch + 1 ||
            schemaState.targetDigest !== migrationDigestAt(journal, schemaState.targetVersion))
    ) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: "Catalog pending schema migration does not match the packaged journal",
        });
    }
    sql.exec(
        "INSERT OR IGNORE INTO catalog_epoch (scope, scope_id, epoch) VALUES (?, ?, ?)",
        "auth_global",
        "global",
        1
    );
    return schemaState;
}

export function readCatalogSchemaState(sql: CatalogSql): CatalogSchemaState {
    const row = sql.one<StoredCatalogSchemaState>(
        `SELECT active_version, active_epoch, active_digest, last_migration_id, status, migration_id,
                target_version, target_epoch, target_digest
         FROM catalog_schema_state WHERE singleton = 1`
    );
    if (!row) throw new CdbError({ code: "CDB_INVARIANT", message: "Catalog schema state is missing" });
    return {
        activeVersion: row.active_version,
        activeEpoch: row.active_epoch,
        activeDigest: row.active_digest,
        lastMigrationId: row.last_migration_id,
        status: row.status,
        migrationId: row.migration_id,
        targetVersion: row.target_version,
        targetEpoch: row.target_epoch,
        targetDigest: row.target_digest,
    };
}

export function beginCatalogSchemaChange(
    sql: CatalogSql,
    journal: ChardbMigrationJournal,
    args: { readonly migrationId: string; readonly targetVersion: number },
    baseline: boolean
): void {
    const current = readCatalogSchemaState(sql);
    if (current.status === "migrating") {
        if (current.migrationId === args.migrationId && current.targetVersion === args.targetVersion) return;
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "another schema migration is in progress" });
    }
    if (current.activeVersion === args.targetVersion && current.lastMigrationId === args.migrationId) return;
    if (args.targetVersion <= current.activeVersion) {
        throw new CdbError({
            code: "CDB_INVALID_ARGS",
            message: "schema migration must advance the active version",
        });
    }
    if (baseline && (current.activeVersion !== 0 || args.targetVersion !== journal.version)) {
        throw new CdbError({
            code: "CDB_INVALID_ARGS",
            message: "schema baseline requires version-zero storage and the complete packaged journal",
        });
    }
    sql.exec(
        `UPDATE catalog_schema_state
         SET status = 'migrating', migration_id = ?, target_version = ?,
             target_epoch = active_epoch + 1, target_digest = ?
         WHERE singleton = 1 AND status = 'active'`,
        args.migrationId,
        args.targetVersion,
        migrationDigestAt(journal, args.targetVersion)
    );
    if (sql.changes() !== 1) throw new CdbError({ code: "CDB_INVARIANT", message: "schema state changed" });
    sql.exec(
        `INSERT INTO catalog_schema_shards (migration_id, shard_id, status, last_error, updated_at)
         SELECT ?, shard_id, 'pending', NULL, ?
         FROM (SELECT DISTINCT shard_id FROM catalog_ranges)
         ORDER BY shard_id`,
        args.migrationId,
        Date.now()
    );
    if (sql.changes() < 1) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "schema migration has no target shards" });
    }
    if (baseline) {
        sql.exec(
            `INSERT INTO catalog_schema_baselines (migration_id, target_version, target_digest, created_at)
             VALUES (?, ?, ?, ?)`,
            args.migrationId,
            args.targetVersion,
            migrationDigestAt(journal, args.targetVersion),
            Date.now()
        );
    }
}

export function readCatalogSchemaMigrationShards(
    sql: CatalogSql,
    args: { readonly migrationId: string }
): readonly CatalogSchemaShardState[] {
    const current = readCatalogSchemaState(sql);
    if (current.status !== "migrating" || current.migrationId !== args.migrationId) {
        if (current.status === "active" && current.lastMigrationId === args.migrationId) return [];
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration does not own Catalog" });
    }
    return sql
        .all<{ shard_id: string; status: "pending" | "active"; last_error: string | null; updated_at: number }>(
            `SELECT shard_id, status, last_error, updated_at
             FROM catalog_schema_shards WHERE migration_id = ? ORDER BY shard_id`,
            args.migrationId
        )
        .map(row => ({
            shardId: row.shard_id,
            status: row.status,
            lastError: row.last_error,
            updatedAt: row.updated_at,
        }));
}

export function catalogSchemaBaselineExists(sql: CatalogSql, migrationId: string): boolean {
    return Boolean(
        sql.one<{ present: number }>(
            "SELECT 1 AS present FROM catalog_schema_baselines WHERE migration_id = ?",
            migrationId
        )
    );
}

export function recordCatalogSchemaShardFailure(
    sql: CatalogSql,
    args: { readonly migrationId: string; readonly shardId: string },
    message: string
): void {
    sql.exec(
        `UPDATE catalog_schema_shards SET last_error = ?, updated_at = ?
         WHERE migration_id = ? AND shard_id = ? AND status = 'pending'`,
        message,
        Date.now(),
        args.migrationId,
        args.shardId
    );
}

export function activateCatalogSchemaShard(
    sql: CatalogSql,
    args: { readonly migrationId: string; readonly shardId: string }
): void {
    const owner = readCatalogSchemaState(sql);
    if (owner.status !== "migrating" || owner.migrationId !== args.migrationId) {
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration ownership changed" });
    }
    sql.exec(
        `UPDATE catalog_schema_shards
         SET status = 'active', last_error = NULL, updated_at = ?
         WHERE migration_id = ? AND shard_id = ? AND status = 'pending'`,
        Date.now(),
        args.migrationId,
        args.shardId
    );
    if (sql.changes() !== 1) {
        const active = sql.one<{ status: string }>(
            "SELECT status FROM catalog_schema_shards WHERE migration_id = ? AND shard_id = ?",
            args.migrationId,
            args.shardId
        );
        if (active?.status !== "active") {
            throw new CdbError({ code: "CDB_INVARIANT", message: "schema migration shard state changed" });
        }
    }
}

export function applyCatalogSchemaMigrationStep(
    sql: CatalogSql,
    journal: ChardbMigrationJournal,
    args: { readonly migrationId: string; readonly version: number }
): void {
    const current = readCatalogSchemaState(sql);
    if (current.status !== "migrating" || current.migrationId !== args.migrationId) {
        if (current.status === "active" && current.lastMigrationId === args.migrationId) return;
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration does not own Catalog" });
    }
    if (current.targetVersion === null || args.version > current.targetVersion) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "Catalog migration step exceeds its target" });
    }
    const migration = journal.migrations[args.version - 1];
    if (!migration || migration.version !== args.version) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: "Catalog schema migration step is missing",
        });
    }
    const existing = sql.one<{ digest: string }>(
        "SELECT digest FROM catalog_schema_steps WHERE migration_id = ? AND version = ?",
        args.migrationId,
        args.version
    );
    if (existing) {
        if (existing.digest !== migration.digest) {
            throw new CdbError({
                code: "CDB_PARTITION_CONTRACT_CHANGED",
                message: "applied Catalog schema migration digest changed",
            });
        }
        return;
    }
    const targetVersion = current.targetVersion;
    const applied = sql.all<{ version: number; digest: string }>(
        "SELECT version, digest FROM catalog_schema_steps WHERE migration_id = ? ORDER BY version",
        args.migrationId
    );
    const expected = pendingMigrations(journal, current.activeVersion).filter(step => step.version <= targetVersion);
    for (let index = 0; index < applied.length; index++) {
        const stored = applied[index];
        const packaged = expected[index];
        if (!stored || !packaged || stored.version !== packaged.version || stored.digest !== packaged.digest) {
            throw new CdbError({
                code: "CDB_PARTITION_CONTRACT_CHANGED",
                message: "applied Catalog schema migration sequence is corrupt",
            });
        }
    }
    const next = expected[applied.length];
    if (!next || next.version !== args.version) {
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: "Catalog migration steps must apply in order" });
    }
    if (!catalogSchemaBaselineExists(sql, args.migrationId)) {
        for (const statement of migration.catalogStatements) sql.exec(statement);
    }
    sql.exec(
        `INSERT INTO catalog_schema_steps (migration_id, version, digest, applied_at)
         VALUES (?, ?, ?, ?)`,
        args.migrationId,
        migration.version,
        migration.digest,
        Date.now()
    );
}

export function completeCatalogSchemaMigration(
    sql: CatalogSql,
    journal: ChardbMigrationJournal,
    args: { readonly migrationId: string },
    recordMigratedAuthSchema: (sql: CatalogSql) => void
): void {
    const current = readCatalogSchemaState(sql);
    if (current.status === "active") {
        if (current.lastMigrationId === args.migrationId) return;
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration is not active" });
    }
    if (current.migrationId !== args.migrationId) {
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration id does not own Catalog" });
    }
    const pending = sql.one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM catalog_schema_shards
         WHERE migration_id = ? AND status != 'active'`,
        args.migrationId
    );
    if (!pending || pending.count !== 0) {
        throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration shards are incomplete" });
    }
    const targetVersion = current.targetVersion;
    if (targetVersion === null) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "Catalog schema migration target is missing" });
    }
    const expected = pendingMigrations(journal, current.activeVersion).filter(step => step.version <= targetVersion);
    const applied = sql.all<{ version: number; digest: string }>(
        "SELECT version, digest FROM catalog_schema_steps WHERE migration_id = ? ORDER BY version",
        args.migrationId
    );
    if (
        applied.length !== expected.length ||
        applied.some(
            (stored, index) => stored.version !== expected[index]?.version || stored.digest !== expected[index]?.digest
        )
    ) {
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: "Catalog schema migration steps are incomplete",
        });
    }
    recordMigratedAuthSchema(sql);
    sql.exec("DELETE FROM catalog_schema_shards WHERE migration_id = ?", args.migrationId);
    sql.exec("DELETE FROM catalog_schema_baselines WHERE migration_id = ?", args.migrationId);
    sql.exec(
        `UPDATE catalog_schema_state
         SET active_version = target_version, active_epoch = target_epoch, active_digest = target_digest,
             last_migration_id = migration_id, status = 'active', migration_id = NULL, target_version = NULL,
             target_epoch = NULL, target_digest = NULL
         WHERE singleton = 1 AND status = 'migrating' AND migration_id = ?`,
        args.migrationId
    );
    if (sql.changes() !== 1) throw new CdbError({ code: "CDB_INVARIANT", message: "schema state changed" });
}
