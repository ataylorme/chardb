import { DurableObject } from "cloudflare:workers";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { renderSqliteTableDdl } from "../../src/auth/ddl.ts";
import { file } from "../../src/files/index.ts";
import type { AuthCtx } from "../../src/server/define.ts";
import {
    CDB_FILE_RESHARD_PAGE_SIZE,
    type CdbFileReshardIdentity,
    CdbFileReshardStore,
    type CdbReshardFileRecord,
    type CdbReshardOrganizationTombstone,
    initializeCdbFileReshardStore,
} from "../../src/server/do/cdb-file-reshard-store.ts";
import { CdbFileRuntime } from "../../src/server/do/cdb-file-runtime.ts";
import { CdbFileStore, backfillFilePlacements, initializeFileStore } from "../../src/server/do/cdb-file-store.ts";
import { configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { Resharder as ProductionResharder, RESHARDER_PHASE } from "../../src/server/do/resharder.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import {
    beginExternalFileCapture,
    endExternalFileCapture,
    renderFileReshardTriggers,
} from "../../src/server/file-reshard-triggers.ts";
import { renderFileAttachmentTriggers } from "../../src/server/file-triggers.ts";
import { emptyManifest } from "../../src/server/manifest.ts";
import { collectSchemaFileResourceDescriptors } from "../../src/server/resource-descriptors.ts";
import { defineMigrations } from "../../src/server/schema-migrations.ts";
import { vshardOf } from "../../src/vshard.ts";
import { forOrg } from "../helpers/cdb-table.ts";

interface Env {
    readonly CDB_FILES: R2Bucket;
    readonly FILE_RESHARD: DurableObjectNamespace;
    readonly LEGACY_FILE_RESHARD: DurableObjectNamespace;
    readonly FILE_RUNTIME_CDB: DurableObjectNamespace;
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_RESHARD: DurableObjectNamespace;
}

const HASH = "a".repeat(64);
const FILE_IDS = {
    pending: `fil_${"1".repeat(64)}`,
    ready: `fil_${"2".repeat(64)}`,
    attached: `fil_${"3".repeat(64)}`,
    deleting: `fil_${"4".repeat(64)}`,
    outside: `fil_${"5".repeat(64)}`,
} as const;

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function organizationAt(vshard: number, prefix: string): string {
    for (let index = 0; index < 200_000; index++) {
        const candidate = `${prefix}-${index}`;
        if (placement(candidate) === vshard) return candidate;
    }
    throw new Error(`could not find an organization at vshard ${vshard}`);
}

function message(error: unknown): string {
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
        const detail = error instanceof Error ? error.message : String(error);
        return `${error.code}: ${detail}`;
    }
    return error instanceof Error ? error.message : String(error);
}

function fileRecord(input: {
    fileId: string;
    organizationId: string;
    status: CdbReshardFileRecord["status"];
    createdAt: number;
}): CdbReshardFileRecord {
    const materialized = input.status !== "pending";
    return {
        fileId: input.fileId,
        organizationId: input.organizationId,
        table: "messages",
        column: "attachment",
        objectKey: `v1/${input.organizationId}/${input.fileId}`,
        contentType: "image/png",
        size: 4,
        sha256: materialized ? HASH : null,
        status: input.status,
        rowId: input.status === "attached" ? "row-attached" : null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt + 1,
        placementVshard: placement(input.organizationId),
    };
}

function insertFile(sql: ReturnType<typeof adaptSqlStorage>, row: CdbReshardFileRecord): void {
    sql.exec(
        `INSERT INTO _chardb_files
           (file_id, organization_id, table_name, column_name, object_key, content_type, size, sha256,
            status, row_id, created_at, updated_at, placement_vshard)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.fileId,
        row.organizationId,
        row.table,
        row.column,
        row.objectKey,
        row.contentType,
        row.size,
        row.sha256,
        row.status,
        row.rowId,
        row.createdAt,
        row.updatedAt,
        row.placementVshard
    );
}

const runtimeOrganization = sqliteTable("organization", { id: text("id").primaryKey() });
const { cdbTable: runtimeOrganizationTable } = forOrg();
const runtimeMessages = runtimeOrganizationTable(
    "runtime_file_messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => runtimeOrganization.id),
        attachment: file("attachment", { maxSize: 32, contentTypes: ["image/png"] }),
    },
    { roles: { member: { read: "*" } } }
);
const RUNTIME_FILE_SCHEMA = { runtimeMessages } as const;
const runtimeFileResource = collectSchemaFileResourceDescriptors(RUNTIME_FILE_SCHEMA)[0];
if (!runtimeFileResource) throw new Error("runtime file resource fixture is missing");
const RUNTIME_FILE_RESOURCE = runtimeFileResource;
const runtimeDdl = renderSqliteTableDdl(runtimeMessages, { includeForeignKey: () => false });
const RUNTIME_FILE_MIGRATIONS = defineMigrations([
    {
        version: 1,
        name: "runtime_file_schema",
        statements: [
            runtimeDdl.createTable,
            ...runtimeDdl.indexes,
            ...renderFileAttachmentTriggers(RUNTIME_FILE_RESOURCE),
        ],
        resources: [RUNTIME_FILE_RESOURCE],
    },
]);
const ConfiguredFileRuntimeCdb = configureCdbRuntime({
    schema: () => RUNTIME_FILE_SCHEMA,
    manifest: emptyManifest,
    migrations: () => RUNTIME_FILE_MIGRATIONS,
});

interface RuntimeFileAuth extends AuthCtx {
    readonly tenantId: string;
}

export class FileRuntimeCdb extends ConfiguredFileRuntimeCdb {
    private bucket(): R2Bucket {
        if (!this.env.CDB_FILES) throw new Error("runtime file bucket is missing");
        return this.env.CDB_FILES;
    }

    async _activateSchema(): Promise<{ activeVersion: number; activeEpoch: number; activeDigest: string }> {
        const current = this.schemaState();
        if (current.activeVersion === RUNTIME_FILE_MIGRATIONS.version) {
            return {
                activeVersion: current.activeVersion,
                activeEpoch: current.activeEpoch,
                activeDigest: current.activeDigest,
            };
        }
        const migrationId = "runtime-file-schema";
        this.prepareSchemaMigration({
            migrationId,
            activeVersion: current.activeVersion,
            activeDigest: current.activeDigest,
            targetVersion: RUNTIME_FILE_MIGRATIONS.version,
            targetEpoch: 2,
            targetDigest: RUNTIME_FILE_MIGRATIONS.digest,
            recoveryGeneration: 0,
        });
        this.applySchemaMigration({ migrationId, version: 1, recoveryGeneration: 0 });
        const active = await this.activateSchemaMigration({ migrationId, recoveryGeneration: 0 });
        return {
            activeVersion: active.activeVersion,
            activeEpoch: active.activeEpoch,
            activeDigest: active.activeDigest,
        };
    }

    _beginSourceCapture(input: { migId: string; organizationId: string }): { vshard: number } {
        const vshard = placement(input.organizationId);
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `INSERT INTO _chardb_split_state
                   (mig_id, range_lo, range_hi, role, capture, updated_at)
                 VALUES (?, ?, ?, 'source', 1, ?)`,
                input.migId,
                vshard,
                vshard,
                Date.now()
            );
            new CdbFileReshardStore(sql).beginSource(
                { migId: input.migId, rangeLo: vshard, rangeHi: vshard },
                Date.now()
            );
            for (const statement of renderFileReshardTriggers(input.migId).install) sql.exec(statement);
        });
        return { vshard };
    }

    _prepareDestination(input: {
        migId: string;
        organizationId: string;
        destinationGeneration: number;
    }): { vshard: number } {
        const vshard = placement(input.organizationId);
        this.prepareReshardDestOwnership({
            recoveryGeneration: 0,
            migId: input.migId,
            rangeLo: vshard,
            rangeHi: vshard,
            destinationGeneration: input.destinationGeneration,
        });
        this.ctx.storage.transactionSync(() => {
            new CdbFileReshardStore(adaptSqlStorage(this.ctx.storage.sql)).beginDest(
                { migId: input.migId, rangeLo: vshard, rangeHi: vshard },
                Date.now()
            );
        });
        return { vshard };
    }

    _activateDestination(input: {
        migId: string;
        organizationId: string;
    }): { activated: true } {
        const vshard = placement(input.organizationId);
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const identity = { migId: input.migId, rangeLo: vshard, rangeHi: vshard };
            const store = new CdbFileReshardStore(sql);
            store.prepareDestAttachments(identity, Date.now());
            store.activateDest(identity, Date.now());
            sql.exec(
                `UPDATE _chardb_split_state SET destination_serving = 1, updated_at = ?
                 WHERE mig_id = ? AND role = 'dest' AND destination_serving = 0`,
                Date.now(),
                input.migId
            );
            if (sql.changes() !== 1) throw new Error("runtime destination activation lost its relational fence");
        });
        return { activated: true };
    }

    _fenceFileSource(input: { migId: string; organizationId: string }): void {
        const vshard = placement(input.organizationId);
        this.ctx.storage.transactionSync(() => {
            new CdbFileReshardStore(adaptSqlStorage(this.ctx.storage.sql)).fenceSource(
                { migId: input.migId, rangeLo: vshard, rangeHi: vshard },
                Date.now()
            );
        });
    }

    _attachRow(input: { organizationId: string; fileId: string; rowId: string }): void {
        adaptSqlStorage(this.ctx.storage.sql).exec(
            "INSERT INTO runtime_file_messages (id, organization_id, attachment) VALUES (?, ?, ?)",
            input.rowId,
            input.organizationId,
            input.fileId
        );
    }

    async _seedPending(input: {
        organizationId: string;
        fileId: string;
        nowMs: number;
    }): Promise<{ objectKey: string }> {
        const stored = this.ctx.storage.transactionSync(() =>
            new CdbFileStore(adaptSqlStorage(this.ctx.storage.sql)).reserve({
                fileId: input.fileId,
                organizationId: input.organizationId,
                table: RUNTIME_FILE_RESOURCE.table,
                column: RUNTIME_FILE_RESOURCE.column,
                contentType: "image/png",
                size: 4,
                nowMs: input.nowMs,
            })
        );
        await this.bucket().put(stored.objectKey, "data");
        return { objectKey: stored.objectKey };
    }

    async _seedMaintenanceStarvation(input: {
        fencedOrganizationId: string;
        ownedOrganizationId: string;
        migId: string;
    }): Promise<{ ownedFileId: string; ownedObjectKey: string }> {
        const fencedVshard = placement(input.fencedOrganizationId);
        if (placement(input.ownedOrganizationId) === fencedVshard) throw new Error("maintenance organizations overlap");
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const files = new CdbFileStore(sql);
            for (let index = 0; index < 33; index++) {
                files.reserve({
                    fileId: `fenced-${String(index).padStart(2, "0")}`,
                    organizationId: input.fencedOrganizationId,
                    table: RUNTIME_FILE_RESOURCE.table,
                    column: RUNTIME_FILE_RESOURCE.column,
                    contentType: "image/png",
                    size: 1,
                    nowMs: index + 1,
                });
            }
            const identity = { migId: input.migId, rangeLo: fencedVshard, rangeHi: fencedVshard };
            new CdbFileReshardStore(sql).beginSource(identity, 100);
            new CdbFileReshardStore(sql).fenceSource(identity, 101);
        });
        const ownedFileId = "owned-maintenance-file";
        const ownedObjectKey = `v1/${input.ownedOrganizationId}/${ownedFileId}`;
        await this._seedPending({
            organizationId: input.ownedOrganizationId,
            fileId: ownedFileId,
            nowMs: 100,
        });
        return { ownedFileId, ownedObjectKey };
    }

    async _resolveDownloadAfterFence(input: {
        migId: string;
        organizationId: string;
        fileId: string;
        rowId: string;
        domainSchemaEpoch: number;
        auth: RuntimeFileAuth;
    }) {
        const runtime = new CdbFileRuntime({
            storage: this.ctx.storage,
            bucket: this.bucket(),
            resources: () => [RUNTIME_FILE_RESOURCE],
            assertActiveEpoch: epoch => {
                if (epoch !== this.schemaState().activeEpoch) throw new Error("stale runtime fixture epoch");
            },
            assertOwnership: organizationId =>
                new CdbFileReshardStore(adaptSqlStorage(this.ctx.storage.sql)).assertOwnership(
                    placement(organizationId)
                ),
            metadataTransaction: (organizationId, callback) =>
                this.ctx.storage.transactionSync(() => {
                    const sql = adaptSqlStorage(this.ctx.storage.sql);
                    new CdbFileReshardStore(sql).assertOwnership(placement(organizationId));
                    const transactionId = beginExternalFileCapture(sql, organizationId);
                    const result = callback(new CdbFileStore(sql));
                    endExternalFileCapture(sql, transactionId);
                    return result;
                }),
        });
        return runtime.resolveDownload(
            {
                organizationId: input.organizationId,
                table: RUNTIME_FILE_RESOURCE.table,
                column: RUNTIME_FILE_RESOURCE.column,
                rowId: input.rowId,
                domainSchemaEpoch: input.domainSchemaEpoch,
                recoveryGeneration: 0,
                auth: input.auth,
            },
            async () => {
                const row = adaptSqlStorage(this.ctx.storage.sql).one<{ attachment: string | null }>(
                    "SELECT attachment FROM runtime_file_messages WHERE id = ? AND organization_id = ?",
                    input.rowId,
                    input.organizationId
                );
                if (row?.attachment !== input.fileId) throw new Error("paused download fixture row changed");
                await Promise.resolve();
                const vshard = placement(input.organizationId);
                this.ctx.storage.transactionSync(() => {
                    new CdbFileReshardStore(adaptSqlStorage(this.ctx.storage.sql)).fenceSource(
                        { migId: input.migId, rangeLo: vshard, rangeHi: vshard },
                        Date.now()
                    );
                });
                return row.attachment;
            }
        );
    }

    _captureLog(input: { migId: string }) {
        return adaptSqlStorage(this.ctx.storage.sql).all<{
            lsn: number;
            source_tx_id: number;
            op: string;
            table_name: string;
            pk: string;
        }>(
            `SELECT lsn, source_tx_id, op, table_name, pk FROM _chardb_split_log
             WHERE mig_id = ? ORDER BY lsn`,
            input.migId
        );
    }

    async _runFileMaintenance(): Promise<{ alarm: number | null }> {
        await super.alarm();
        return { alarm: await this.ctx.storage.getAlarm() };
    }

    async _inspectRuntimeFile(input: { fileId: string; objectKey?: string }) {
        const stored = new CdbFileStore(adaptSqlStorage(this.ctx.storage.sql)).read(input.fileId);
        const object = input.objectKey ? await this.bucket().head(input.objectKey) : null;
        return { stored, objectPresent: object !== null };
    }
}

export class FileReshardProof extends DurableObject<Env> {
    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            const sql = adaptSqlStorage(state.storage.sql);
            initializeFileStore(sql);
            initializeCdbFileReshardStore(sql);
        });
    }

    private store(): CdbFileReshardStore {
        return new CdbFileReshardStore(adaptSqlStorage(this.ctx.storage.sql));
    }

    async seed(input: { readonly suffix?: string } = {}): Promise<Record<string, unknown>> {
        const suffix = input.suffix ?? "main";
        const movedOrganizationId = `org-file-${suffix}`;
        const movedPlacement = placement(movedOrganizationId);
        const tombstoneOrganizationId = organizationAt(movedPlacement, `org-deleted-${suffix}`);
        let outsideOrganizationId = `org-outside-${suffix}`;
        while (placement(outsideOrganizationId) === movedPlacement) outsideOrganizationId += "-next";
        const identity = {
            migId: `mig-file-${suffix}`,
            rangeLo: movedPlacement,
            rangeHi: movedPlacement,
        } satisfies CdbFileReshardIdentity;
        const moved = [
            fileRecord({
                fileId: FILE_IDS.pending,
                organizationId: movedOrganizationId,
                status: "pending",
                createdAt: 100,
            }),
            fileRecord({
                fileId: FILE_IDS.ready,
                organizationId: movedOrganizationId,
                status: "ready",
                createdAt: 200,
            }),
            fileRecord({
                fileId: FILE_IDS.attached,
                organizationId: movedOrganizationId,
                status: "attached",
                createdAt: 300,
            }),
            fileRecord({
                fileId: FILE_IDS.deleting,
                organizationId: movedOrganizationId,
                status: "deleting",
                createdAt: 400,
            }),
        ];
        const outside = fileRecord({
            fileId: FILE_IDS.outside,
            organizationId: outsideOrganizationId,
            status: "ready",
            createdAt: 500,
        });
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const row of [...moved, outside]) insertFile(sql, row);
            sql.exec(
                `INSERT INTO _chardb_deleted_organizations (organization_id, deleted_at, placement_vshard)
                 VALUES (?, ?, ?)`,
                tombstoneOrganizationId,
                600,
                movedPlacement
            );
        });
        const all = [...moved, outside];
        for (const row of all) {
            await this.env.CDB_FILES.put(row.objectKey, row.fileId.slice(0, 4));
        }
        await this.ctx.storage.put("r2-puts", all.length);
        await this.ctx.storage.put("r2-deletes", 0);
        return {
            identity,
            movedOrganizationId,
            outsideOrganizationId,
            tombstoneOrganizationId,
            retainedKeys: all.map(row => row.objectKey),
        };
    }

    beginSource(identity: CdbFileReshardIdentity): void {
        this.store().beginSource(identity, 1_000);
    }

    beginDest(identity: CdbFileReshardIdentity): void {
        this.store().beginDest(identity, 1_000);
    }

    readSnapshot(input: CdbFileReshardIdentity & { afterPlacement: number; afterFileId: string; limit: number }) {
        return this.store().readSnapshot(input);
    }

    applySnapshot(input: {
        readonly identity: CdbFileReshardIdentity;
        readonly rows: readonly CdbReshardFileRecord[];
    }) {
        return this.ctx.storage.transactionSync(() => this.store().applySnapshot(input.identity, input.rows));
    }

    async applySnapshotThenLoseResponse(input: {
        readonly identity: CdbFileReshardIdentity;
        readonly rows: readonly CdbReshardFileRecord[];
    }): Promise<never> {
        this.applySnapshot(input);
        throw new Error("simulated response loss after file snapshot apply");
    }

    readTombstones(
        input: CdbFileReshardIdentity & {
            afterPlacement: number;
            afterOrganizationId: string;
            limit: number;
        }
    ) {
        return this.store().readTombstones(input);
    }

    applyTombstones(input: {
        readonly identity: CdbFileReshardIdentity;
        readonly rows: readonly CdbReshardOrganizationTombstone[];
    }) {
        return this.ctx.storage.transactionSync(() => this.store().applyTombstones(input.identity, input.rows));
    }

    fence(identity: CdbFileReshardIdentity): void {
        this.store().fenceSource(identity, 2_000);
    }

    activate(identity: CdbFileReshardIdentity): { activated: boolean } {
        const before = adaptSqlStorage(this.ctx.storage.sql).one<{ maintenance_enabled: number }>(
            "SELECT maintenance_enabled FROM _chardb_split_file_cursor WHERE mig_id = ?",
            identity.migId
        );
        this.store().prepareDestAttachments(identity, 2_999);
        this.store().activateDest(identity, 3_000);
        return { activated: before?.maintenance_enabled !== 1 };
    }

    async activateThenLoseResponse(identity: CdbFileReshardIdentity): Promise<never> {
        this.activate(identity);
        throw new Error("simulated response loss after file destination activation");
    }

    validate(identity: CdbFileReshardIdentity): { done: true; checked: number } {
        const store = this.store();
        const files = store.validate(
            identity,
            { kind: "file", afterPlacement: -1, afterId: "" },
            CDB_FILE_RESHARD_PAGE_SIZE
        );
        if (files.done || files.cursor.kind !== "organization_tombstone") {
            throw new Error("file validation did not advance to tombstones");
        }
        const tombstones = store.validate(identity, files.cursor, CDB_FILE_RESHARD_PAGE_SIZE);
        if (!tombstones.done) throw new Error("file validation did not finish");
        return { done: true, checked: files.checked + tombstones.checked };
    }

    maintain(): { schedules: readonly number[] } {
        const active = adaptSqlStorage(this.ctx.storage.sql).one<{ maintenance_enabled: number }>(
            "SELECT maintenance_enabled FROM _chardb_split_file_cursor WHERE outcome = 'active' LIMIT 1"
        );
        if (active?.maintenance_enabled === 1)
            throw new Error("fixture maintain must run only while destination is closed");
        return { schedules: [] };
    }

    reserve(input: { organizationId: string; fileId: string }): unknown {
        const vshard = placement(input.organizationId);
        this.store().assertOwnership(vshard);
        return this.ctx.storage.transactionSync(() =>
            new CdbFileStore(adaptSqlStorage(this.ctx.storage.sql)).reserve({
                fileId: input.fileId,
                organizationId: input.organizationId,
                table: "messages",
                column: "attachment",
                contentType: "image/png",
                size: 4,
                nowMs: 700,
            })
        );
    }

    ready(input: { organizationId: string; fileId: string }): unknown {
        this.store().assertOwnership(placement(input.organizationId));
        return this.ctx.storage.transactionSync(() =>
            new CdbFileStore(adaptSqlStorage(this.ctx.storage.sql)).markReady(input.fileId, HASH, 4, 800)
        );
    }

    delete(input: { organizationId: string; fileId: string }): unknown {
        this.store().assertOwnership(placement(input.organizationId));
        return this.ctx.storage.transactionSync(() =>
            new CdbFileStore(adaptSqlStorage(this.ctx.storage.sql)).queueDelete(input.fileId, 900)
        );
    }

    async put(input: { organizationId: string; fileId: string }): Promise<{ key: string }> {
        const key = `v1/${input.organizationId}/${input.fileId}`;
        await this.env.CDB_FILES.put(key, "put!");
        await this.ctx.storage.put("r2-puts", ((await this.ctx.storage.get<number>("r2-puts")) ?? 0) + 1);
        return { key };
    }

    abort(identity: CdbFileReshardIdentity) {
        return this.ctx.storage.transactionSync(() => this.store().abortDest(identity, 4_000));
    }

    async objectOperations(): Promise<{ puts: number; deletes: number }> {
        return {
            puts: (await this.ctx.storage.get<number>("r2-puts")) ?? 0,
            deletes: (await this.ctx.storage.get<number>("r2-deletes")) ?? 0,
        };
    }

    async object(input: { objectKey: string }): Promise<{ present: boolean; size: number | null }> {
        const object = await this.env.CDB_FILES.head(input.objectKey);
        return { present: object !== null, size: object?.size ?? null };
    }

    inspect(): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const cursor = sql.one<{
            range_lo: number;
            range_hi: number;
            maintenance_enabled: number;
        }>("SELECT range_lo, range_hi, maintenance_enabled FROM _chardb_split_file_cursor LIMIT 1");
        const rangeLo = cursor?.range_lo ?? -1;
        const rangeHi = cursor?.range_hi ?? -1;
        return {
            states: sql
                .all<{ status: string }>(
                    "SELECT status FROM _chardb_files WHERE placement_vshard BETWEEN ? AND ? ORDER BY status",
                    rangeLo,
                    rangeHi
                )
                .map(row => row.status),
            outsideOrganizations: sql
                .all<{ organization_id: string }>(
                    "SELECT DISTINCT organization_id FROM _chardb_files WHERE placement_vshard NOT BETWEEN ? AND ? ORDER BY organization_id",
                    rangeLo,
                    rangeHi
                )
                .map(row => row.organization_id),
            tombstonedOrganizations: sql
                .all<{ organization_id: string }>(
                    "SELECT organization_id FROM _chardb_deleted_organizations WHERE placement_vshard BETWEEN ? AND ? ORDER BY organization_id",
                    rangeLo,
                    rangeHi
                )
                .map(row => row.organization_id),
            maintenanceEnabled: cursor?.maintenance_enabled === 1,
        };
    }
}

export class LegacyFileReshardProof extends DurableObject<Env> {
    async legacyActiveRecovery(input: { role: "source" | "dest" }): Promise<Record<string, unknown>> {
        if (input.role !== "source" && input.role !== "dest") throw new Error("legacy recovery role is invalid");
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        initializeFileStore(sql);
        sql.exec(`CREATE TABLE IF NOT EXISTS _chardb_split_file_cursor (
          mig_id TEXT PRIMARY KEY,
          range_lo INTEGER NOT NULL,
          range_hi INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('source', 'dest')),
          outcome TEXT NOT NULL CHECK (outcome IN ('active', 'aborted', 'finished')),
          maintenance_enabled INTEGER NOT NULL CHECK (maintenance_enabled IN (0, 1)),
          attachments_enabled INTEGER NOT NULL CHECK (attachments_enabled IN (0, 1)),
          source_fenced INTEGER NOT NULL CHECK (source_fenced IN (0, 1)),
          updated_at INTEGER NOT NULL
        )`);
        sql.exec(`CREATE TABLE IF NOT EXISTS _chardb_split_file_applied (
          mig_id TEXT NOT NULL,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('file', 'organization_tombstone')),
          record_id TEXT NOT NULL,
          inserted INTEGER NOT NULL CHECK (inserted IN (0, 1)),
          PRIMARY KEY (mig_id, record_kind, record_id)
        )`);
        const organizationId = "org-legacy-active-recovery";
        const fileId = `fil_${"a".repeat(64)}`;
        const row = fileRecord({ fileId, organizationId, status: "ready", createdAt: 100 });
        const identity = {
            migId: "mig-legacy-active-recovery",
            rangeLo: row.placementVshard,
            rangeHi: row.placementVshard,
        };
        insertFile(sql, row);
        sql.exec(
            `INSERT INTO _chardb_split_file_cursor
               (mig_id, range_lo, range_hi, role, outcome, maintenance_enabled, attachments_enabled,
                source_fenced, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, 0, 1)`,
            identity.migId,
            identity.rangeLo,
            identity.rangeHi,
            input.role,
            input.role === "source" ? 1 : 0,
            input.role === "source" ? 1 : 0
        );
        if (input.role === "dest") {
            sql.exec(
                `INSERT INTO _chardb_split_file_applied (mig_id, record_kind, record_id, inserted)
                 VALUES (?, 'file', ?, 1)`,
                identity.migId,
                fileId
            );
        } else {
            await this.env.CDB_FILES.put(row.objectKey, "legacy-active-bytes");
        }

        initializeCdbFileReshardStore(sql);
        const snapshotColumn = sql
            .all<{ name: string }>("PRAGMA table_info('_chardb_split_file_applied')")
            .some(column => column.name === "snapshot_through_lsn");
        const nullProvenanceBefore = Number(
            sql.one<{ count: number | bigint }>(
                "SELECT COUNT(*) AS count FROM _chardb_split_file_applied WHERE snapshot_through_lsn IS NULL"
            )?.count ?? 0
        );
        let replayError: string | null = null;
        const store = new CdbFileReshardStore(sql);
        if (input.role === "dest") {
            try {
                store.applySnapshot(identity, [row], 17);
            } catch (error) {
                replayError = message(error);
            }
            if (!replayError) throw new Error("legacy snapshot retry unexpectedly succeeded");
            store.abortDest(identity, 2);
        } else {
            store.abortSource(identity, 2);
        }
        return {
            snapshotColumn,
            nullProvenanceBefore,
            replayError,
            ...(await this.legacyRecoveryState({ objectKey: row.objectKey })),
        };
    }

    async legacyRecoveryState(input: { objectKey: string }): Promise<Record<string, unknown>> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            outcome: sql.one<{ outcome: string }>(
                "SELECT outcome FROM _chardb_split_file_cursor WHERE mig_id = 'mig-legacy-active-recovery'"
            )?.outcome,
            metadataRows: Number(
                sql.one<{ count: number | bigint }>("SELECT COUNT(*) AS count FROM _chardb_files")?.count ?? 0
            ),
            ledgerRows: Number(
                sql.one<{ count: number | bigint }>("SELECT COUNT(*) AS count FROM _chardb_split_file_applied")
                    ?.count ?? 0
            ),
            objectPresent: (await this.env.CDB_FILES.head(input.objectKey)) !== null,
        };
    }

    async unsupported(input: { scenario: string }): Promise<Record<string, unknown>> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `CREATE TABLE _chardb_files (
               file_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, table_name TEXT NOT NULL,
               column_name TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
               size INTEGER NOT NULL, sha256 TEXT, status TEXT NOT NULL, row_id TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             )`
        );
        sql.exec(
            `CREATE TABLE _chardb_deleted_organizations (
               organization_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
             )`
        );
        const organizationId = `org-${input.scenario}`;
        const fileId = `fil_${"9".repeat(64)}`;
        if (input.scenario !== "old-empty-schema") {
            sql.exec(
                `INSERT INTO _chardb_files
                   (file_id, organization_id, table_name, column_name, object_key, content_type, size, sha256,
                    status, row_id, created_at, updated_at)
                 VALUES (?, ?, 'messages', 'attachment', ?, 'image/png', 4, ?, 'ready', NULL, 1, 2)`,
                fileId,
                organizationId,
                `v1/${organizationId}/${fileId}`,
                HASH
            );
            sql.exec(
                "INSERT INTO _chardb_deleted_organizations (organization_id, deleted_at) VALUES (?, 3)",
                organizationAt(placement(organizationId), `org-old-deleted-${input.scenario}`)
            );
        }
        initializeFileStore(sql);
        const backfill = backfillFilePlacements(sql, 500);
        if (input.scenario === "old-empty-schema" || input.scenario === "old-nonempty-schema") {
            return { accepted: true, rowsBackfilled: backfill.files + backfill.tombstones };
        }
        initializeCdbFileReshardStore(sql);
        const identity = {
            migId: `mig-${input.scenario}`,
            rangeLo: placement(organizationId),
            rangeHi: placement(organizationId),
        };
        if (input.scenario === "malformed-placement") {
            const wrong = (placement(organizationId) + 1) % 16_384;
            sql.exec("UPDATE _chardb_files SET placement_vshard = ?", wrong);
            const malformedIdentity = { ...identity, rangeLo: wrong, rangeHi: wrong };
            new CdbFileReshardStore(sql).beginSource(malformedIdentity, 10);
            new CdbFileReshardStore(sql).readSnapshot({
                ...malformedIdentity,
                afterPlacement: -1,
                afterFileId: "",
                limit: CDB_FILE_RESHARD_PAGE_SIZE,
            });
            return { accepted: false };
        }
        if (input.scenario === "object-key-drift") {
            sql.exec("UPDATE _chardb_files SET object_key = 'v1/drifted/key'");
            new CdbFileReshardStore(sql).beginSource(identity, 10);
            new CdbFileReshardStore(sql).readSnapshot({
                ...identity,
                afterPlacement: -1,
                afterFileId: "",
                limit: CDB_FILE_RESHARD_PAGE_SIZE,
            });
            return { accepted: false };
        }
        if (input.scenario === "destination-collision") {
            const store = new CdbFileReshardStore(sql);
            store.beginDest(identity, 10);
            const original = sql.one<{
                placement_vshard: number;
            }>("SELECT placement_vshard FROM _chardb_files WHERE file_id = ?", fileId);
            if (!original) throw new Error("collision seed is missing");
            const incoming = fileRecord({ fileId, organizationId, status: "ready", createdAt: 99 });
            store.applySnapshot(identity, [incoming]);
            return { accepted: false };
        }
        throw new Error(`unknown unsupported scenario ${input.scenario}`);
    }
}

const LEGACY_RECOVERY_SCHEMA = {
    schemaVersion: 3,
    recoveryGeneration: 0,
    schemaEpoch: 4,
    schemaDigest: "b".repeat(64),
} as const;

export class LegacyRecoveryCatalog extends DurableObject<Env> {
    async beginTopologyOperation(input: Record<string, unknown>): Promise<Record<string, unknown>> {
        const migId = String(input.migId);
        const existing = await this.ctx.storage.get<Record<string, unknown>>(`topology:${migId}`);
        if (!existing) {
            await this.ctx.storage.put(`topology:${migId}`, {
                ...input,
                owner: (await this.ctx.storage.get<string>(`owner:${migId}`)) ?? "source",
                status: "active",
            });
        }
        return { status: "active", ...LEGACY_RECOVERY_SCHEMA };
    }

    async fixtureSetOwner(input: { migId: string; owner: "source" | "destination" }): Promise<void> {
        await this.ctx.storage.put(`owner:${input.migId}`, input.owner);
    }

    async topologyRoutingStatus(input: Record<string, unknown>): Promise<Record<string, unknown>> {
        const migId = String(input.migId);
        const topology = await this.ctx.storage.get<Record<string, unknown>>(`topology:${migId}`);
        if (!topology) throw new Error("legacy recovery topology is missing");
        for (const key of ["sourceShard", "destinationShard", "rangeLo", "rangeHi", "startEpoch"] as const) {
            if (topology[key] !== input[key]) throw new Error("legacy recovery topology identity changed");
        }
        const owner = String(topology.owner) as "source" | "destination";
        await this.record(migId, "routing-status");
        return {
            owner,
            recoveryGeneration: 0,
            schemaEpoch: Number(input.startEpoch) + (owner === "destination" ? 1 : 0),
            operationStatus: topology.status,
        };
    }

    async abortTopologyOperation(input: Record<string, unknown>): Promise<{ status: "aborted" }> {
        const migId = String(input.migId);
        const topology = await this.ctx.storage.get<Record<string, unknown>>(`topology:${migId}`);
        if (!topology || topology.owner !== "source") throw new Error("cut-over topology cannot abort");
        await this.record(migId, "catalog-abort");
        await this.ctx.storage.put(`topology:${migId}`, { ...topology, status: "aborted" });
        return { status: "aborted" };
    }

    async fixtureTimeline(input: { migId: string }): Promise<readonly string[]> {
        return (await this.ctx.storage.get<string[]>(`timeline:${input.migId}`)) ?? [];
    }

    private async record(migId: string, event: string): Promise<void> {
        const key = `timeline:${migId}`;
        await this.ctx.storage.put(key, [...((await this.ctx.storage.get<string[]>(key)) ?? []), event]);
    }
}

export class LegacyRecoveryCdb extends DurableObject<Env> {
    reshardSideStateProtocolCapabilitiesV2(): {
        readonly vectorSnapshot: "v2";
        readonly fileTombstones: "v2";
    } {
        return { vectorSnapshot: "v2", fileTombstones: "v2" };
    }

    async fixtureSetup(input: { migId: string; role: "source" | "dest" }): Promise<void> {
        await this.ctx.storage.put(`role:${input.migId}`, input.role);
    }

    async reshardFileAppliedProvenance(input: { migId: string }): Promise<{ rows: number; legacyRows: number }> {
        await this.record(input.migId, "provenance");
        return { rows: 1, legacyRows: 1 };
    }

    async prepareReshardDestOwnership(input: { migId: string }): Promise<{ prepared: boolean; serving: boolean }> {
        await this.record(input.migId, "prepare-destination");
        return { prepared: true, serving: (await this.ctx.storage.get<boolean>(`serving:${input.migId}`)) === true };
    }

    async activateReshardFileDest(input: { migId: string }): Promise<{ activated: boolean }> {
        await this.record(input.migId, "activate-files");
        return { activated: true };
    }

    async activateReshardDestServing(input: { migId: string }): Promise<{ activated: boolean }> {
        await this.record(input.migId, "activate-destination");
        await this.ctx.storage.put(`serving:${input.migId}`, true);
        return { activated: true };
    }

    async beginReshardSource(): Promise<{ enabled: boolean; triggersInstalled: number }> {
        return { enabled: true, triggersInstalled: 0 };
    }

    async beginReshardFileSource(): Promise<{ enabled: boolean; triggersInstalled: number }> {
        return { enabled: true, triggersInstalled: 0 };
    }

    async readTailBatch(): Promise<never> {
        throw new Error("legacy recovery replayed unknown tail provenance");
    }

    async readSplitOpLogBatch(): Promise<never> {
        throw new Error("legacy recovery replayed unknown oplog provenance");
    }

    async stopReshardCapture(input: { migId: string }): Promise<{ stopped: boolean }> {
        await this.record(input.migId, "stop-capture");
        return { stopped: true };
    }

    async stopReshardFileSource(input: { migId: string }): Promise<{ stopped: boolean; triggersUninstalled: number }> {
        await this.record(input.migId, "stop-files");
        return { stopped: true, triggersUninstalled: 0 };
    }

    async reshardTableOrder(): Promise<{ tableNames: readonly string[] }> {
        return { tableNames: ["messages"] };
    }

    async dropMigratedRange(input: { migId: string }): Promise<{ deleted: number; done: boolean }> {
        await this.record(input.migId, "drop-range");
        return { deleted: 0, done: true };
    }

    async drainReshardFiles(input: { migId: string }): Promise<Record<string, unknown>> {
        await this.record(input.migId, "drain-files");
        return {
            cursor: { kind: "file", afterPlacement: -1, afterId: "" },
            deleted: 0,
            done: true,
        };
    }

    async cancelRoutingFenceBeforeCutover(input: { migrationId: string }): Promise<void> {
        await this.record(input.migrationId, "cancel-fence");
    }

    async abortReshardFiles(input: { migId: string; role: "source" | "dest" }): Promise<Record<string, unknown>> {
        await this.record(input.migId, input.role === "source" ? "abort-source-files" : "abort-dest-files");
        return {
            afterKind: input.role === "source" ? "" : "file",
            afterId: input.role === "source" ? "" : "legacy",
            deleted: input.role === "dest" ? 1 : 0,
            done: true,
        };
    }

    async abortReshardSource(input: { migId: string }): Promise<void> {
        await this.record(input.migId, "abort-source");
    }

    async beginReshardDestAbort(input: { migId: string }): Promise<{ started: boolean }> {
        await this.record(input.migId, "dest-fence");
        return { started: true };
    }

    async abortReshardDestBatch(input: { migId: string }): Promise<{ deleted: number; done: boolean }> {
        await this.record(input.migId, "abort-dest");
        return { deleted: 0, done: true };
    }

    async fixtureTimeline(input: { migId: string }): Promise<readonly string[]> {
        return (await this.ctx.storage.get<string[]>(`timeline:${input.migId}`)) ?? [];
    }

    private async record(migId: string, event: string): Promise<void> {
        const key = `timeline:${migId}`;
        await this.ctx.storage.put(key, [...((await this.ctx.storage.get<string[]>(key)) ?? []), event]);
    }
}

export class LegacyRecoveryResharder extends ProductionResharder {
    async fixtureSeedPhaseThree(input: Parameters<ProductionResharder["startSplit"]>[0]): Promise<{ phase: number }> {
        await this.startSplit(input);
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `UPDATE migration_file_cursor SET enabled = 1, prepare_done = 1, copy_done = 1
             WHERE mig_id = ?`,
            input.migId
        );
        for (const phase of [
            RESHARDER_PHASE.INIT,
            RESHARDER_PHASE.TAIL_CAPTURE_ENABLED,
            RESHARDER_PHASE.BULK_COPY_DONE,
        ]) {
            await this.advance(input.migId, phase);
        }
        return { phase: (await this.getPhase(input.migId)) as number };
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const name = url.searchParams.get("name") ?? "default";
        const recovery = url.searchParams.get("recovery");
        const legacy = name.startsWith("legacy-");
        const runtime = name.startsWith("runtime-");
        const namespace =
            recovery === "catalog"
                ? env.CDB_CATALOG
                : recovery === "cdb"
                  ? env.CDB_SHARD
                  : recovery === "resharder"
                    ? env.CDB_RESHARD
                    : legacy
                      ? env.LEGACY_FILE_RESHARD
                      : runtime
                        ? env.FILE_RUNTIME_CDB
                        : env.FILE_RESHARD;
        const stub = namespace.get(namespace.idFromName(name)) as unknown as Record<
            string,
            (input: unknown) => Promise<unknown>
        >;
        const op = url.pathname.slice(1);
        const body = request.method === "POST" ? await request.json() : {};
        try {
            if (typeof stub[op] !== "function") return new Response(`unknown op ${op}`, { status: 404 });
            return Response.json({ result: await stub[op](body) });
        } catch (error) {
            return Response.json({ error: message(error) }, { status: 500 });
        }
    },
};
