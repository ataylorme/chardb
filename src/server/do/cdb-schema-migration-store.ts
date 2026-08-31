import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { type ChardbMigrationJournal, migrationDigestAt, pendingMigrations } from "../schema-migrations.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

export const CDB_SCHEMA_MIGRATION_STORE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_schema_state (
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
CREATE TABLE IF NOT EXISTS _chardb_schema_steps (
  migration_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  digest TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  PRIMARY KEY (migration_id, version)
);
` as const;

export interface CdbSchemaState {
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

export interface CdbSchemaMigrationStepHooks {
    readonly beforeStatements?: (sql: SyncSql, version: number) => void;
    readonly afterStatements?: (sql: SyncSql, version: number) => void;
}

interface StoredCdbSchemaState {
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

export interface CdbSchemaBaselineRequest {
    readonly migrationId: string;
    readonly targetVersion: number;
    readonly targetEpoch: number;
    readonly targetDigest: string;
}

export interface CdbFreshSchemaProvisionRequest {
    readonly migrationId: string;
    readonly targetVersion: number;
    readonly targetEpoch: number;
    readonly targetDigest: string;
}

export interface CdbSchemaMigrationPrepareRequest {
    readonly migrationId: string;
    readonly activeVersion: number;
    readonly activeDigest: string;
    readonly targetVersion: number;
    readonly targetEpoch: number;
    readonly targetDigest: string;
}

export interface CdbSchemaMigrationApplyRequest {
    readonly migrationId: string;
    readonly version: number;
}

export interface CdbSchemaMigrationActivateRequest {
    readonly migrationId: string;
}

type RecordDomainSchema = (sql: SyncSql) => void;
type AssertFreshShard = (sql: SyncSql) => void;

export class CdbSchemaMigrationStore {
    constructor(private readonly storage: DurableObjectStorage) {}

    initialize(journal: ChardbMigrationJournal): { readonly ensureDomainTables: boolean } {
        const sql = adaptSqlStorage(this.storage.sql);
        const storedState = this.stateOrNull(sql);
        if (storedState === null) {
            sql.exec(
                `INSERT INTO _chardb_schema_state
                 (singleton, active_version, active_epoch, active_digest, status)
                 VALUES (1, ?, 1, ?, 'active')`,
                0,
                migrationDigestAt(journal, 0)
            );
            return { ensureDomainTables: journal.version === 0 };
        }
        assertPackagedSchemaState(storedState, journal);
        return {
            ensureDomainTables: storedState.status === "active" && storedState.activeVersion === journal.version,
        };
    }

    state(sql = adaptSqlStorage(this.storage.sql)): CdbSchemaState {
        const state = this.stateOrNull(sql);
        if (!state) throw new CdbError({ code: "CDB_INVARIANT", message: "Cdb schema state is missing" });
        return state;
    }

    assertActiveEpoch(
        expectedEpoch: number,
        journal: () => ChardbMigrationJournal,
        sql = adaptSqlStorage(this.storage.sql)
    ): CdbSchemaState {
        if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "domain schema epoch is invalid" });
        }
        const state = this.state(sql);
        if (
            state.status !== "active" ||
            state.activeVersion !== journal().version ||
            state.activeEpoch !== expectedEpoch
        ) {
            throw new CdbError({
                code: "CDB_STALE_EPOCH",
                message: `Cdb domain schema epoch ${state.activeEpoch} does not match request epoch ${expectedEpoch}`,
                hint: "retry after routing against the active schema version",
            });
        }
        return state;
    }

    baseline(
        args: CdbSchemaBaselineRequest,
        journal: ChardbMigrationJournal,
        recordDomainSchema: RecordDomainSchema,
        afterBaseline?: RecordDomainSchema
    ): CdbSchemaState {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.migrationId)) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "schema baseline id is invalid" });
        }
        if (
            args.targetVersion !== journal.version ||
            args.targetVersion < 1 ||
            !Number.isSafeInteger(args.targetEpoch) ||
            args.targetEpoch < 2 ||
            args.targetDigest !== journal.digest
        ) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "schema baseline target is invalid" });
        }
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.state(sql);
            if (
                current.status === "active" &&
                current.lastMigrationId === args.migrationId &&
                current.activeVersion === args.targetVersion &&
                current.activeEpoch === args.targetEpoch &&
                current.activeDigest === args.targetDigest
            ) {
                return;
            }
            if (
                current.status !== "active" ||
                current.activeVersion !== 0 ||
                current.activeDigest !== migrationDigestAt(journal, 0) ||
                args.targetEpoch !== current.activeEpoch + 1
            ) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "Cdb is not eligible for schema baseline" });
            }
            recordDomainSchema(sql);
            afterBaseline?.(sql);
            sql.exec(
                `UPDATE _chardb_schema_state
                 SET active_version = ?, active_epoch = ?, active_digest = ?, last_migration_id = ?
                 WHERE singleton = 1 AND status = 'active' AND active_version = 0 AND active_epoch = ?`,
                args.targetVersion,
                args.targetEpoch,
                args.targetDigest,
                args.migrationId,
                current.activeEpoch
            );
            if (sql.changes() !== 1) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "Cdb changed during schema baseline" });
            }
        });
        return this.state();
    }

    /**
     * Materialize a never-used physical shard at an exact active journal
     * prefix. Unlike `baseline`, this executes every packaged Cdb statement.
     * The caller's freshness check runs in the same transaction, so a shard
     * can never be adopted over existing domain or mutation state.
     */
    provisionFresh(
        args: CdbFreshSchemaProvisionRequest,
        journal: ChardbMigrationJournal,
        assertFreshShard: AssertFreshShard,
        recordDomainSchema: RecordDomainSchema,
        afterReplay?: RecordDomainSchema
    ): CdbSchemaState {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.migrationId)) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "fresh shard provision id is invalid" });
        }
        if (
            !Number.isSafeInteger(args.targetVersion) ||
            args.targetVersion < 0 ||
            args.targetVersion > journal.version ||
            !Number.isSafeInteger(args.targetEpoch) ||
            args.targetEpoch < 1 ||
            (args.targetVersion === 0 && args.targetEpoch !== 1) ||
            (args.targetVersion > 0 && args.targetEpoch < 2) ||
            args.targetDigest !== migrationDigestAt(journal, args.targetVersion)
        ) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "fresh shard provision target is invalid" });
        }
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.state(sql);
            if (
                current.status === "active" &&
                current.lastMigrationId === args.migrationId &&
                current.activeVersion === args.targetVersion &&
                current.activeEpoch === args.targetEpoch &&
                current.activeDigest === args.targetDigest
            ) {
                return;
            }
            if (
                current.status !== "active" ||
                current.activeVersion !== 0 ||
                current.activeEpoch !== 1 ||
                current.activeDigest !== migrationDigestAt(journal, 0) ||
                current.lastMigrationId !== null
            ) {
                throw new CdbError({
                    code: "CDB_STALE_EPOCH",
                    message: "Cdb is not an unprovisioned fresh shard",
                });
            }
            const recordedStep = sql.one<{ present: number }>("SELECT 1 AS present FROM _chardb_schema_steps LIMIT 1");
            if (recordedStep) {
                throw new CdbError({
                    code: "CDB_PARTITION_CONTRACT_CHANGED",
                    message: "fresh shard has recorded schema migration steps",
                });
            }
            assertFreshShard(sql);
            const nowMs = Date.now();
            for (const migration of journal.migrations.slice(0, args.targetVersion)) {
                for (const statement of migration.statements) sql.exec(statement);
                sql.exec(
                    `INSERT INTO _chardb_schema_steps (migration_id, version, digest, applied_at)
                     VALUES (?, ?, ?, ?)`,
                    args.migrationId,
                    migration.version,
                    migration.digest,
                    nowMs
                );
            }
            afterReplay?.(sql);
            recordDomainSchema(sql);
            sql.exec(
                `UPDATE _chardb_schema_state
                 SET active_version = ?, active_epoch = ?, active_digest = ?, last_migration_id = ?
                 WHERE singleton = 1 AND status = 'active' AND active_version = 0 AND active_epoch = 1
                   AND last_migration_id IS NULL`,
                args.targetVersion,
                args.targetEpoch,
                args.targetDigest,
                args.migrationId
            );
            if (sql.changes() !== 1) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "Cdb changed during fresh provisioning" });
            }
        });
        return this.state();
    }

    prepare(args: CdbSchemaMigrationPrepareRequest, journal: ChardbMigrationJournal): CdbSchemaState {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.migrationId)) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "schema migration id is invalid" });
        }
        if (
            !Number.isSafeInteger(args.activeVersion) ||
            args.activeVersion < 0 ||
            !Number.isSafeInteger(args.targetVersion) ||
            args.targetVersion <= args.activeVersion ||
            args.targetVersion !== journal.version ||
            !Number.isSafeInteger(args.targetEpoch) ||
            args.targetEpoch < 1 ||
            args.activeDigest !== migrationDigestAt(journal, args.activeVersion) ||
            args.targetDigest !== migrationDigestAt(journal, args.targetVersion)
        ) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "schema migration target is invalid" });
        }
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.state(sql);
            if (current.status === "migrating") {
                if (
                    current.migrationId === args.migrationId &&
                    current.activeVersion === args.activeVersion &&
                    current.activeDigest === args.activeDigest &&
                    current.targetVersion === args.targetVersion &&
                    current.targetEpoch === args.targetEpoch &&
                    current.targetDigest === args.targetDigest
                ) {
                    return;
                }
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "another schema migration owns this Cdb" });
            }
            if (
                current.lastMigrationId === args.migrationId &&
                current.activeVersion === args.targetVersion &&
                current.activeEpoch === args.targetEpoch &&
                current.activeDigest === args.targetDigest
            ) {
                return;
            }
            if (
                current.activeVersion !== args.activeVersion ||
                current.activeDigest !== args.activeDigest ||
                args.targetEpoch !== current.activeEpoch + 1
            ) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "Cdb schema state changed before prepare" });
            }
            sql.exec(
                `UPDATE _chardb_schema_state
                 SET status = 'migrating', migration_id = ?, target_version = ?, target_epoch = ?, target_digest = ?
                 WHERE singleton = 1 AND status = 'active' AND active_version = ? AND active_digest = ?`,
                args.migrationId,
                args.targetVersion,
                args.targetEpoch,
                args.targetDigest,
                args.activeVersion,
                args.activeDigest
            );
            if (sql.changes() !== 1) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "Cdb schema state changed before prepare" });
            }
        });
        return this.state();
    }

    apply(
        args: CdbSchemaMigrationApplyRequest,
        journal: ChardbMigrationJournal,
        hooks: CdbSchemaMigrationStepHooks = {}
    ): CdbSchemaState {
        if (!Number.isSafeInteger(args.version) || args.version < 1 || args.version > journal.version) {
            throw new CdbError({ code: "CDB_INVALID_ARGS", message: "schema migration version is invalid" });
        }
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.state(sql);
            if (current.status !== "migrating" || current.migrationId !== args.migrationId) {
                if (current.status === "active" && current.lastMigrationId === args.migrationId) return;
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration does not own this Cdb" });
            }
            if (current.targetVersion === null || args.version > current.targetVersion) {
                throw new CdbError({ code: "CDB_INVALID_ARGS", message: "schema migration step exceeds its target" });
            }
            const targetVersion = current.targetVersion;
            const migration = journal.migrations[args.version - 1];
            if (!migration || migration.version !== args.version) {
                throw new CdbError({
                    code: "CDB_PARTITION_CONTRACT_CHANGED",
                    message: "schema migration step is missing",
                });
            }
            const existing = sql.one<{ digest: string }>(
                "SELECT digest FROM _chardb_schema_steps WHERE migration_id = ? AND version = ?",
                args.migrationId,
                args.version
            );
            if (existing) {
                if (existing.digest !== migration.digest) {
                    throw new CdbError({
                        code: "CDB_PARTITION_CONTRACT_CHANGED",
                        message: "applied schema migration digest changed",
                    });
                }
                return;
            }
            const applied = sql.all<{ version: number; digest: string }>(
                "SELECT version, digest FROM _chardb_schema_steps WHERE migration_id = ? ORDER BY version",
                args.migrationId
            );
            const expected = pendingMigrations(journal, current.activeVersion).filter(
                step => step.version <= targetVersion
            );
            for (let index = 0; index < applied.length; index++) {
                const stored = applied[index];
                const packaged = expected[index];
                if (!stored || !packaged || stored.version !== packaged.version || stored.digest !== packaged.digest) {
                    throw new CdbError({
                        code: "CDB_PARTITION_CONTRACT_CHANGED",
                        message: "applied schema migration sequence is corrupt",
                    });
                }
            }
            const next = expected[applied.length];
            if (!next || next.version !== args.version) {
                throw new CdbError({ code: "CDB_INVALID_ARGS", message: "schema migration steps must apply in order" });
            }
            hooks.beforeStatements?.(sql, migration.version);
            for (const statement of migration.statements) sql.exec(statement);
            hooks.afterStatements?.(sql, migration.version);
            sql.exec(
                `INSERT INTO _chardb_schema_steps (migration_id, version, digest, applied_at)
                 VALUES (?, ?, ?, ?)`,
                args.migrationId,
                migration.version,
                migration.digest,
                Date.now()
            );
        });
        return this.state();
    }

    activate(
        args: CdbSchemaMigrationActivateRequest,
        journal: () => ChardbMigrationJournal,
        recordDomainSchema: RecordDomainSchema
    ): CdbSchemaState {
        this.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.storage.sql);
            const current = this.state(sql);
            if (current.status === "active") {
                if (current.lastMigrationId === args.migrationId) return;
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration is not active" });
            }
            if (current.migrationId !== args.migrationId || current.targetVersion === null) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration does not own this Cdb" });
            }
            const targetVersion = current.targetVersion;
            const expected = pendingMigrations(journal(), current.activeVersion).filter(
                step => step.version <= targetVersion
            );
            const applied = sql.all<{ version: number; digest: string }>(
                "SELECT version, digest FROM _chardb_schema_steps WHERE migration_id = ? ORDER BY version",
                args.migrationId
            );
            if (
                applied.length !== expected.length ||
                applied.some(
                    (stored, index) =>
                        stored.version !== expected[index]?.version || stored.digest !== expected[index]?.digest
                )
            ) {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "schema migration steps are incomplete" });
            }
            recordDomainSchema(sql);
            sql.exec(
                `UPDATE _chardb_schema_state
                 SET active_version = target_version, active_epoch = target_epoch, active_digest = target_digest,
                     last_migration_id = migration_id, status = 'active', migration_id = NULL,
                     target_version = NULL, target_epoch = NULL, target_digest = NULL
                 WHERE singleton = 1 AND status = 'migrating' AND migration_id = ?`,
                args.migrationId
            );
            if (sql.changes() !== 1) {
                throw new CdbError({ code: "CDB_INVARIANT", message: "Cdb schema state changed during activation" });
            }
        });
        return this.state();
    }

    private stateOrNull(sql: SyncSql): CdbSchemaState | null {
        const row = sql.one<StoredCdbSchemaState>(
            `SELECT active_version, active_epoch, active_digest, last_migration_id, status, migration_id,
                    target_version, target_epoch, target_digest
             FROM _chardb_schema_state WHERE singleton = 1`
        );
        if (!row) return null;
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
}

function assertPackagedSchemaState(state: CdbSchemaState, journal: ChardbMigrationJournal): void {
    if (
        state.activeVersion > journal.version ||
        state.activeDigest !== migrationDigestAt(journal, state.activeVersion)
    ) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: `Cdb schema version ${state.activeVersion} does not match the packaged migration journal`,
        });
    }
    if (
        state.status === "migrating" &&
        (state.targetVersion === null ||
            state.targetVersion <= state.activeVersion ||
            state.targetVersion > journal.version ||
            state.targetEpoch !== state.activeEpoch + 1 ||
            state.targetDigest !== migrationDigestAt(journal, state.targetVersion))
    ) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: "Cdb pending schema migration does not match the packaged journal",
        });
    }
}
