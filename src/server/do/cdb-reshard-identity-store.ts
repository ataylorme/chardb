import { getTableColumns } from "drizzle-orm";
import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import type { TableSpec } from "../../reshard/triggers.ts";
import { stableJson } from "../../util/canonical.ts";
import { VSHARD_COUNT } from "../../vshard.ts";
import { collectCdbTables } from "../cdb-table-registry.ts";
import { resolveCdbMeta } from "../cdb-table.ts";
import { type ChardbMigrationJournal, migrationDigestAt } from "../schema-migrations.ts";
import type { CdbSchemaState } from "./cdb-schema-migration-store.ts";

export const CDB_RESHARD_IDENTITY_STORE_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_split_identity (
  mig_id          TEXT PRIMARY KEY,
  range_lo        INTEGER NOT NULL CHECK (range_lo >= 0 AND range_lo < 16384),
  range_hi        INTEGER NOT NULL CHECK (range_hi >= range_lo AND range_hi < 16384),
  role            TEXT NOT NULL CHECK (role IN ('source', 'dest')),
  schema_version  INTEGER NOT NULL CHECK (schema_version >= 0),
  schema_epoch    INTEGER NOT NULL CHECK (schema_epoch > 0),
  schema_digest   TEXT NOT NULL,
  tables_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL CHECK (created_at >= 0)
);
` as const;

export interface CdbReshardSchemaIdentity {
    readonly schemaVersion: number;
    readonly schemaEpoch: number;
    readonly schemaDigest: string;
}

export interface CdbReshardSplitIdentity extends CdbReshardSchemaIdentity {
    readonly migId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
    readonly role: "source" | "dest";
    readonly tables: readonly TableSpec[];
}

interface StoredSplitIdentity {
    readonly mig_id: string;
    readonly range_lo: number;
    readonly range_hi: number;
    readonly role: "source" | "dest";
    readonly schema_version: number;
    readonly schema_epoch: number;
    readonly schema_digest: string;
    readonly tables_json: string;
}

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SCHEMA_DIGEST = /^[a-f0-9]{64}$/;
const SYSTEM_TABLE = /^(?:_|sqlite)/;
export const CDB_SPLIT_IDENTITY_LIMIT = VSHARD_COUNT;

export function assertCdbReshardRangeIdentity(input: {
    readonly migId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}): void {
    if (!MIGRATION_ID.test(input.migId)) invalid("migration id is invalid");
    if (
        !Number.isSafeInteger(input.rangeLo) ||
        !Number.isSafeInteger(input.rangeHi) ||
        input.rangeLo < 0 ||
        input.rangeHi < input.rangeLo ||
        input.rangeHi >= VSHARD_COUNT
    ) {
        invalid("virtual-shard range is invalid");
    }
}

export function assertCdbSplitHistoryCapacity(sql: SyncSql, migId: string): void {
    if (sql.one<{ present: number }>("SELECT 1 AS present FROM _chardb_split_state WHERE mig_id = ?", migId)) return;
    if (
        sql.one<{ present: number }>(
            "SELECT 1 AS present FROM _chardb_split_state ORDER BY mig_id LIMIT 1 OFFSET ?",
            CDB_SPLIT_IDENTITY_LIMIT - 1
        )
    ) {
        throw new CdbError({
            code: "CDB_RATE_LIMITED",
            message: "Cdb split ownership history reached its durable row limit",
        });
    }
}

/** Fill fields omitted by the earliest stored split-identity format. */
export function initializeCdbReshardIdentityStore(sql: SyncSql): void {
    const columns = sql.all<{ name: string }>("PRAGMA table_info(_chardb_split_identity)");
    if (!columns.some(column => column.name === "schema_epoch")) {
        sql.exec("ALTER TABLE _chardb_split_identity ADD COLUMN schema_epoch INTEGER CHECK (schema_epoch > 0)");
    }
}

function mismatch(message: string): never {
    throw new CdbError({ code: "CDB_RESHARD_PHASE_MISMATCH", message });
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `reshard split identity: ${message}` });
}

function packagedTableSpecs(schema: Record<string, unknown>): ReadonlyMap<string, TableSpec> {
    const specs = new Map<string, TableSpec>();
    for (const { table, meta } of collectCdbTables(schema)) {
        if (SYSTEM_TABLE.test(meta.name)) invalid(`registered table ${meta.name} uses a reserved system name`);
        if (specs.has(meta.name)) invalid(`registered table name ${meta.name} is duplicated`);
        if (meta.partitionBy.kind === "replicated") {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: `replicated table ${meta.name} has no online reshard transfer protocol`,
                hint: "remove replicated tables or wait for explicit replicated-state ownership during splits",
            });
        }
        if (meta.partitionBy.kind !== "colocate") {
            invalid(`registered table ${meta.name} has no movable partition column`);
        }
        const resolved = resolveCdbMeta(table);
        const partitionColumns = meta.partitionBy.via.length > 0 ? meta.partitionBy.via : [resolved.tenantBy];
        if (partitionColumns.length !== 1 || typeof partitionColumns[0] !== "string") {
            invalid(`registered table ${meta.name} must use one scalar partition column`);
        }
        const registeredColumns = Object.values(getTableColumns(table)) as readonly {
            readonly name: string;
            readonly getSQLType?: () => string;
        }[];
        const blob = registeredColumns.find(column => /^blob(?:\b|$)/i.test(column.getSQLType?.() ?? ""));
        if (blob) {
            throw new CdbError({
                code: "CDB_UNSUPPORTED_FEATURE",
                message: `table ${meta.name} column ${blob.name} uses BLOB storage, which reshard tail capture cannot encode`,
            });
        }
        const columns = registeredColumns.map(column => column.name);
        if (columns.length === 0 || new Set(columns).size !== columns.length) {
            invalid(`registered table ${meta.name} has an invalid column registry`);
        }
        specs.set(meta.name, {
            name: meta.name,
            partitionColumn: partitionColumns[0],
            columns,
        });
    }
    return specs;
}

/** Derive the complete canonical movable table list from the packaged Worker schema. */
export function packagedReshardTableSpecs(schema: Record<string, unknown>): readonly TableSpec[] {
    const tables = [...packagedTableSpecs(schema).values()].sort((left, right) => left.name.localeCompare(right.name));
    if (tables.length < 1 || tables.length > 256) {
        invalid("tables must contain from 1 through 256 entries");
    }
    return tables;
}

/** Validate caller-supplied specs against the schema bundled into this Cdb isolate. */
export function canonicalRegisteredTableSpecs(
    schema: Record<string, unknown>,
    requested: readonly TableSpec[]
): { readonly tables: readonly TableSpec[]; readonly json: string } {
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 256) {
        invalid("tables must contain from 1 through 256 entries");
    }
    const registered = new Map(packagedReshardTableSpecs(schema).map(table => [table.name, table]));
    const names = new Set<string>();
    const tables = requested.map(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("table spec is malformed");
        if (SYSTEM_TABLE.test(raw.name)) invalid(`table ${raw.name} is reserved for system storage`);
        if (names.has(raw.name)) invalid(`table ${raw.name} is duplicated`);
        names.add(raw.name);
        const expected = registered.get(raw.name);
        if (!expected) invalid(`table ${raw.name} is not a movable registered cdbTable`);
        if (
            raw.partitionColumn !== expected.partitionColumn ||
            !Array.isArray(raw.columns) ||
            raw.columns.length !== expected.columns.length ||
            raw.columns.some((column: string, index: number) => column !== expected.columns[index])
        ) {
            mismatch(`table ${raw.name} does not match the packaged Cdb schema`);
        }
        return expected;
    });
    if (names.size !== registered.size || [...registered.keys()].some(name => !names.has(name))) {
        mismatch("table list must include every movable table in the packaged Cdb schema");
    }
    tables.sort((left, right) => left.name.localeCompare(right.name));
    return { tables, json: stableJson(tables) };
}

function assertActiveSchema(
    requested: CdbReshardSchemaIdentity,
    state: CdbSchemaState,
    journal: ChardbMigrationJournal
): void {
    if (!Number.isSafeInteger(requested.schemaVersion) || requested.schemaVersion < 0) {
        invalid("schema version is invalid");
    }
    if (!Number.isSafeInteger(requested.schemaEpoch) || requested.schemaEpoch < 1) {
        invalid("schema epoch is invalid");
    }
    if (typeof requested.schemaDigest !== "string" || !SCHEMA_DIGEST.test(requested.schemaDigest)) {
        invalid("schema digest is invalid");
    }
    if (
        state.status !== "active" ||
        state.activeVersion !== requested.schemaVersion ||
        state.activeEpoch !== requested.schemaEpoch ||
        requested.schemaVersion > journal.version ||
        migrationDigestAt(journal, requested.schemaVersion) !== requested.schemaDigest ||
        state.activeDigest !== requested.schemaDigest
    ) {
        throw new CdbError({
            code: "CDB_STALE_EPOCH",
            message: "Cdb schema does not match the active Catalog topology schema",
            hint: "finish the exact schema migration on both shards before moving data",
        });
    }
}

/** Stores a permanent split identity tombstone and checks every movement RPC against it. */
export class CdbReshardIdentityStore {
    constructor(private readonly sql: SyncSql) {}

    bind(
        requested: CdbReshardSplitIdentity,
        schema: Record<string, unknown>,
        state: CdbSchemaState,
        journal: ChardbMigrationJournal,
        nowMs: number
    ): CdbReshardSplitIdentity {
        assertCdbReshardRangeIdentity(requested);
        if (requested.role !== "source" && requested.role !== "dest") invalid("role is invalid");
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid("timestamp is invalid");
        assertActiveSchema(requested, state, journal);
        const canonical = canonicalRegisteredTableSpecs(schema, requested.tables);
        const existing = this.read(requested.migId);
        if (existing) {
            this.assertExact(existing, requested, canonical.json);
            return { ...requested, tables: canonical.tables };
        }
        const count = this.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_split_identity")?.count;
        if (count === undefined) throw new CdbError({ code: "CDB_INVARIANT", message: "split identity count failed" });
        if (count >= CDB_SPLIT_IDENTITY_LIMIT) {
            throw new CdbError({
                code: "CDB_RESHARD_PHASE_MISMATCH",
                message: `split identity history reached its ${CDB_SPLIT_IDENTITY_LIMIT}-record limit`,
            });
        }
        this.sql.exec(
            `INSERT INTO _chardb_split_identity
             (mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            requested.migId,
            requested.rangeLo,
            requested.rangeHi,
            requested.role,
            requested.schemaVersion,
            requested.schemaEpoch,
            requested.schemaDigest,
            canonical.json,
            nowMs
        );
        return { ...requested, tables: canonical.tables };
    }

    assertBound(
        requested: CdbReshardSplitIdentity,
        schema: Record<string, unknown>,
        state: CdbSchemaState,
        journal: ChardbMigrationJournal,
        table?: TableSpec
    ): CdbReshardSplitIdentity {
        assertActiveSchema(requested, state, journal);
        const canonical = canonicalRegisteredTableSpecs(schema, requested.tables);
        const stored = this.read(requested.migId);
        if (!stored) mismatch(`migration ${requested.migId} has no bound Cdb identity`);
        this.assertExact(stored, requested, canonical.json);
        if (table) {
            const expected = canonical.tables.find(candidate => candidate.name === table.name);
            if (!expected || stableJson(expected) !== stableJson(table)) {
                mismatch(`table ${table.name} is not part of migration ${requested.migId}`);
            }
        }
        return { ...requested, tables: canonical.tables };
    }

    /** Validate an exact cleanup/finalization request if this Cdb was ever bound. */
    assertCleanupIfBound(
        requested: CdbReshardSplitIdentity,
        schema: Record<string, unknown>,
        state: CdbSchemaState,
        journal: ChardbMigrationJournal
    ): CdbReshardSplitIdentity | null {
        if (!this.read(requested.migId)) return null;
        return this.assertBound(requested, schema, state, journal);
    }

    assertMovement(args: {
        readonly migId: string;
        readonly role: "source" | "dest";
        readonly schema: Record<string, unknown>;
        readonly state: CdbSchemaState;
        readonly journal: ChardbMigrationJournal;
        readonly range?: { readonly lo: number; readonly hi: number };
        readonly table?: TableSpec;
        readonly tables?: readonly TableSpec[];
    }): CdbReshardSplitIdentity {
        const stored = this.read(args.migId);
        if (!stored) mismatch(`migration ${args.migId} has no bound Cdb identity`);
        const parsed = JSON.parse(stored.tables_json) as readonly TableSpec[];
        const identity: CdbReshardSplitIdentity = {
            migId: stored.mig_id,
            rangeLo: stored.range_lo,
            rangeHi: stored.range_hi,
            role: stored.role,
            schemaVersion: stored.schema_version,
            schemaEpoch: stored.schema_epoch,
            schemaDigest: stored.schema_digest,
            tables: parsed,
        };
        assertActiveSchema(identity, args.state, args.journal);
        const canonical = canonicalRegisteredTableSpecs(args.schema, parsed);
        if (stored.role !== args.role) mismatch(`migration ${args.migId} is bound to the ${stored.role} role`);
        if (canonical.json !== stored.tables_json) {
            mismatch(`migration ${args.migId} no longer matches its packaged Cdb table registry`);
        }
        if (args.range && (args.range.lo !== stored.range_lo || args.range.hi !== stored.range_hi)) {
            mismatch(`migration ${args.migId} range does not match its bound Cdb identity`);
        }
        if (args.table) {
            const expected = canonical.tables.find(candidate => candidate.name === args.table?.name);
            if (!expected || stableJson(expected) !== stableJson(args.table)) {
                mismatch(`table ${args.table.name} is not part of migration ${args.migId}`);
            }
        }
        if (args.tables) {
            const requested = canonicalRegisteredTableSpecs(args.schema, args.tables);
            if (requested.json !== stored.tables_json) {
                mismatch(`migration ${args.migId} table list does not match its bound Cdb identity`);
            }
        }
        return { ...identity, tables: canonical.tables };
    }

    private read(migId: string): StoredSplitIdentity | null {
        return this.sql.one<StoredSplitIdentity>(
            `SELECT mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json
             FROM _chardb_split_identity WHERE mig_id = ?`,
            migId
        );
    }

    private assertExact(stored: StoredSplitIdentity, requested: CdbReshardSplitIdentity, tablesJson: string): void {
        if (
            stored.range_lo !== requested.rangeLo ||
            stored.range_hi !== requested.rangeHi ||
            stored.role !== requested.role ||
            stored.schema_version !== requested.schemaVersion ||
            stored.schema_epoch !== requested.schemaEpoch ||
            stored.schema_digest !== requested.schemaDigest ||
            stored.tables_json !== tablesJson
        ) {
            mismatch(`migration ${requested.migId} belongs to a different immutable Cdb split`);
        }
    }
}
