import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { FileId, file } from "../../src/files/index.ts";
import {
    CDB_SPLIT_LOG_MAX_BYTES,
    CDB_SPLIT_LOG_MAX_ROWS,
    CDB_SPLIT_TX_MAX_BYTES,
    CDB_SPLIT_TX_MAX_ROWS,
    CDB_SPLIT_TX_MAX_ROW_BYTES,
} from "../../src/oplog/schema.ts";
import type { TableSpec } from "../../src/reshard/triggers.ts";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { api } from "../../src/server/define.ts";
import { Resharder as ProductionResharder, RESHARDER_PHASE } from "../../src/server/do/resharder.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import type { ChardbEnv } from "../../src/server/entrypoint.ts";
import { beginExternalFileCapture, endExternalFileCapture } from "../../src/server/file-reshard-triggers.ts";
import { chardb, defineAuth, defineMigrations, defineSchemaBaseline } from "../../src/server/index.ts";
import {
    ORGANIZATION_FILE_DOWNLOAD_PATH,
    ORGANIZATION_FILE_UPLOAD_PATH,
    handleOrganizationFileDownloadRequest,
    handleOrganizationFileUploadRequest,
    organizationFileId,
} from "../../src/server/organization-file-http.ts";
import type { ChardbFileResourceDescriptor } from "../../src/server/resource-descriptors.ts";
import { vshardOf } from "../../src/vshard.ts";

const auth = defineAuth({
    appName: "file-reshard-e2e",
    baseURL: "https://file-reshard-e2e.invalid",
    plugins: [
        organization(),
        jwt({
            jwt: { issuer: "https://file-reshard-e2e.invalid", audience: "file-reshard-e2e" },
            jwks: {
                remoteUrl: "https://file-reshard-e2e.invalid/jwks",
                keyPairConfig: { alg: "ES256" },
            },
        }),
    ],
});
const { cdbTable } = forOrg();
const documents = cdbTable(
    "file_move_documents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        attachment: file("attachment", { maxSize: 64, contentTypes: ["image/png"] }),
    },
    { roles: { member: { create: "*", read: "*", update: ["attachment"], delete: true } } }
);

const migrations = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "file_move_e2e",
        domainSchema: { documents },
        authOptions: auth.options,
    }),
]);

const attachDocument = api.mutation({
    ref: "test/workerd/file-reshard-e2e.entry.ts#attachDocument",
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({ organizationId: z.string(), rowId: z.string(), fileId: z.string() }),
    handler: (ctx, args) => {
        ctx.db
            .insert(documents)
            .values({ id: args.rowId, organizationId: args.organizationId, attachment: FileId(args.fileId) })
            .run();
        return { rowId: args.rowId };
    },
});

const app = chardb({ auth, schema: { documents }, api: { attachDocument }, migrations });

const TABLES = Object.freeze([
    {
        name: "file_move_documents",
        partitionColumn: "organization_id",
        columns: ["id", "organization_id", "attachment"],
    },
]) satisfies readonly TableSpec[];

const SOURCE = "ShardDO_0";
const HASH = "a".repeat(64);
const FILE_RESOURCE = Object.freeze({
    kind: "file",
    version: 1,
    table: "file_move_documents",
    column: "attachment",
    primaryKey: "id",
    organizationColumn: "organization_id",
    maxSize: 64,
    contentTypes: ["image/png"],
}) satisfies ChardbFileResourceDescriptor;

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_RESHARD: DurableObjectNamespace;
    readonly CDB_FILES: R2Bucket;
}

interface Route {
    readonly shardId: string;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
}

interface SplitSetup {
    readonly migId: string;
    readonly destination: string;
    readonly organizationIds: readonly [string, string, string];
}

interface SplitIdentity {
    readonly migId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
    readonly schemaVersion: number;
    readonly schemaEpoch: number;
    readonly schemaDigest: string;
    readonly tables: readonly TableSpec[];
}

interface CdbRpc {
    schemaState(): Promise<{ activeVersion: number; activeEpoch: number; activeDigest: string }>;
    fixtureSeedFile(input: {
        organizationId: string;
        rowId: string;
        fileId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        body: string;
    }): Promise<Record<string, unknown>>;
    fixtureSeedPendingFile(input: {
        organizationId: string;
        fileId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        body: string;
    }): Promise<Record<string, unknown>>;
    fixtureState(input: { organizationIds: readonly string[]; migId: string }): Promise<Record<string, unknown>>;
    fixtureCorruptFile(input: {
        organizationId: string;
        fileId: string;
        mode: "omitted" | "mutated" | "extra";
    }): Promise<void>;
    fixtureClearFileRange(input: { vshard: number; migId: string }): Promise<void>;
    fixtureAttachFile(input: {
        organizationId: string;
        rowId: string;
        fileId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
    }): Promise<void>;
    reserveFile(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    markFileReady(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    resolveFileDownload(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    readReshardFileSnapshot(
        input: SplitIdentity & { afterPlacement: number; afterFileId: string; limit: number }
    ): Promise<{
        rows: readonly Record<string, unknown>[];
        afterPlacement: number;
        afterId: string;
        done: boolean;
        throughLsn: number;
    }>;
    applyReshardFileSnapshot(
        input: SplitIdentity & { rows: readonly Record<string, unknown>[]; throughLsn: number }
    ): Promise<unknown>;
    readReshardFileTombstones(
        input: SplitIdentity & { afterPlacement: number; afterOrganizationId: string; limit: number }
    ): Promise<{
        rows: readonly Record<string, unknown>[];
        afterPlacement: number;
        afterId: string;
        done: boolean;
        throughLsn: number;
    }>;
    applyReshardFileTombstones(
        input: SplitIdentity & { rows: readonly Record<string, unknown>[]; throughLsn: number }
    ): Promise<unknown>;
    fixtureArmResponseLoss(input: { migId: string; operation: FileResponseLossOperation }): Promise<void>;
    fixtureResponseLossState(input: { migId: string }): Promise<readonly FileResponseLossState[]>;
    fixtureArmAlarmFault(input: { fault: FileAlarmFault }): Promise<void>;
    fixtureAlarmFaultState(): Promise<readonly FileAlarmFaultState[]>;
    fixtureResetSplitCapacity(input: { migId: string }): Promise<void>;
    fixtureSetSplitCapacity(input: { migId: string; rows: number; bytes: number }): Promise<void>;
    fixtureCaptureMetadata(input: {
        migId: string;
        organizationId: string;
        count: number;
        startIndex: number;
        paddingBytes: number;
        transactions: "single" | "separate";
    }): Promise<SplitCapacityState>;
    fixtureSplitCapacityState(input: { migId: string }): Promise<SplitCapacityState>;
    readTailBatch(input: { migId: string; afterLsn: number; limit: number }): Promise<{
        transactions: readonly {
            sourceTxId: number;
            firstLsn: number;
            lastLsn: number;
            entries: readonly Record<string, unknown>[];
        }[];
        lastLsn: number;
        done: boolean;
    }>;
    fixtureRunAlarm(): Promise<void>;
}

interface SplitCapacityState {
    readonly splitLogRows: number;
    readonly splitLogBytes: number;
    readonly captureTxRows: number;
    readonly captureTxBytes: number;
    readonly storedLogRows: number;
    readonly storedTransactions: number;
    readonly metadataRows: number;
}

type FileResponseLossOperation =
    | "apply_snapshot"
    | "apply_tombstones"
    | "prepare_attachments"
    | "before_activate_dest"
    | "activate_dest"
    | "drain_source"
    | "abort_source"
    | "abort_dest"
    | "finish_source"
    | "finish_dest";

const FILE_RESPONSE_LOSS_OPERATIONS = new Set<FileResponseLossOperation>([
    "apply_snapshot",
    "apply_tombstones",
    "prepare_attachments",
    "before_activate_dest",
    "activate_dest",
    "drain_source",
    "abort_source",
    "abort_dest",
    "finish_source",
    "finish_dest",
]);

interface FileResponseLossState {
    readonly operation: FileResponseLossOperation;
    readonly fired: number;
    readonly calls: number;
}

type FileAlarmFault = "before_metadata" | "before_r2" | "after_r2";

const FILE_ALARM_FAULTS = new Set<FileAlarmFault>(["before_metadata", "before_r2", "after_r2"]);

interface FileAlarmFaultState {
    readonly fault: FileAlarmFault;
    readonly fired: number;
    readonly calls: number;
}

interface CatalogRpc {
    schemaState(): Promise<{ activeVersion: number }>;
    beginSchemaMigration(args: { migrationId: string; targetVersion: number }): Promise<unknown>;
    migrateSchemaShard(args: { migrationId: string; shardId: string }): Promise<unknown>;
    applyCatalogSchemaMigration(args: { migrationId: string; version: number }): Promise<unknown>;
    completeSchemaMigration(args: { migrationId: string }): Promise<unknown>;
    mutateAuth(args: Record<string, unknown>): Promise<unknown>;
    route(vshard: number): Promise<Route>;
    fixtureRunAlarm(): Promise<void>;
    fixtureDeletion(input: { organizationId: string }): Promise<Record<string, unknown>>;
    fixtureRecordR2Operation(input: {
        operation: "put" | "delete";
        keys: readonly string[];
    }): Promise<void>;
    fixtureR2Operations(): Promise<{
        putCalls: number;
        deleteCalls: number;
        operations: readonly { sequence: number; operation: "put" | "delete"; keys: readonly string[] }[];
    }>;
}

interface ResharderRpc {
    startSplit(args: {
        migId: string;
        srcShard: string;
        dstShard: string;
        rangeLo: number;
        rangeHi: number;
        epochAtStart: number;
        tables: readonly TableSpec[];
    }): Promise<void>;
    runSplit(migId: string): Promise<{ phase: number }>;
    getPhase(migId: string): Promise<number | null>;
    abort(migId: string): Promise<void>;
    fixtureState(migId: string): Promise<Record<string, unknown>>;
}

function vshard(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function fileAuth(organizationId: string) {
    return {
        userId: "file-e2e-user",
        tenantId: organizationId,
        role: "member",
        roles: ["member"],
        authEpochs: { global: 1, tenant: 1, principal: 1 },
        claims: {},
    };
}

function catalog(env: Env): CatalogRpc {
    return env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;
}

function cdb(env: Env, shardId: string): CdbRpc {
    return env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as CdbRpc;
}

function resharder(env: Env): ResharderRpc {
    return env.CDB_RESHARD.get(env.CDB_RESHARD.idFromName("global")) as unknown as ResharderRpc;
}

function errorMessage(error: unknown): string {
    if (error && typeof error === "object" && "code" in error) {
        return `${String(error.code)}: ${error instanceof Error ? error.message : String(error)}`;
    }
    return error instanceof Error ? error.message : String(error);
}

function ensureFileAlarmFaultTable(storage: DurableObjectStorage): void {
    adaptSqlStorage(storage.sql).exec(`CREATE TABLE IF NOT EXISTS fixture_file_alarm_fault (
      fault TEXT PRIMARY KEY CHECK (fault IN ('before_metadata', 'before_r2', 'after_r2')),
      fired INTEGER NOT NULL CHECK (fired IN (0, 1)),
      calls INTEGER NOT NULL CHECK (calls >= 0)
    )`);
}

function maybeInterruptFileAlarm(storage: DurableObjectStorage, fault: FileAlarmFault): void {
    let interrupt = false;
    storage.transactionSync(() => {
        ensureFileAlarmFaultTable(storage);
        const sql = adaptSqlStorage(storage.sql);
        const armed = sql.one<{ fired: number }>("SELECT fired FROM fixture_file_alarm_fault WHERE fault = ?", fault);
        if (!armed) return;
        interrupt = armed.fired === 0;
        sql.exec(
            `UPDATE fixture_file_alarm_fault
             SET fired = CASE WHEN fired = 0 THEN 1 ELSE fired END, calls = calls + 1
             WHERE fault = ?`,
            fault
        );
    });
    if (interrupt) throw new Error(`fixture alarm interrupted at ${fault}`);
}

function instrumentR2Bucket(env: Env, storage: DurableObjectStorage): R2Bucket {
    const bucket = env.CDB_FILES;
    const probe = catalog(env);
    return new Proxy(bucket, {
        get(target, property) {
            if (property === "put") {
                return async (key: string, ...args: unknown[]) => {
                    await probe.fixtureRecordR2Operation({ operation: "put", keys: [key] });
                    return Reflect.apply(target.put, target, [key, ...args]);
                };
            }
            if (property === "delete") {
                return async (input: string | string[]) => {
                    const keys = typeof input === "string" ? [input] : [...input];
                    maybeInterruptFileAlarm(storage, "before_r2");
                    await probe.fixtureRecordR2Operation({ operation: "delete", keys });
                    const result = await Reflect.apply(target.delete, target, [input]);
                    maybeInterruptFileAlarm(storage, "after_r2");
                    return result;
                };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

export class Catalog extends app.Catalog {
    fixtureRunAlarm(): Promise<void> {
        return super.alarm();
    }

    fixtureDeletion(input: { organizationId: string }): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            deletion: sql.one(
                `SELECT organization_id, vshard, status, completed_at
                 FROM catalog_organization_deletions WHERE organization_id = ?`,
                input.organizationId
            ),
            shards: sql.all(
                `SELECT shard_id, status, attempts FROM catalog_organization_deletion_shards
                 WHERE organization_id = ? ORDER BY shard_id`,
                input.organizationId
            ),
        };
    }

    fixtureRecordR2Operation(input: { operation: "put" | "delete"; keys: readonly string[] }): void {
        if (
            (input.operation !== "put" && input.operation !== "delete") ||
            !Array.isArray(input.keys) ||
            input.keys.length < 1 ||
            input.keys.length > 1_000 ||
            input.keys.some(key => typeof key !== "string" || key.length === 0 || key.length > 1_024)
        ) {
            throw new Error("fixture R2 operation is invalid");
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(`CREATE TABLE IF NOT EXISTS fixture_r2_operations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
          keys_json TEXT NOT NULL
        )`);
        sql.exec(
            "INSERT INTO fixture_r2_operations (operation, keys_json) VALUES (?, ?)",
            input.operation,
            JSON.stringify(input.keys)
        );
    }

    fixtureR2Operations(): {
        putCalls: number;
        deleteCalls: number;
        operations: readonly { sequence: number; operation: "put" | "delete"; keys: readonly string[] }[];
    } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(`CREATE TABLE IF NOT EXISTS fixture_r2_operations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
          keys_json TEXT NOT NULL
        )`);
        const operations = sql
            .all<{ sequence: number; operation: "put" | "delete"; keys_json: string }>(
                "SELECT sequence, operation, keys_json FROM fixture_r2_operations ORDER BY sequence"
            )
            .map(row => ({ sequence: row.sequence, operation: row.operation, keys: JSON.parse(row.keys_json) }));
        return {
            putCalls: operations.filter(operation => operation.operation === "put").length,
            deleteCalls: operations.filter(operation => operation.operation === "delete").length,
            operations,
        };
    }
}

export class Cdb extends app.Cdb {
    constructor(state: DurableObjectState, env: Env) {
        const instrumented = Object.create(env) as Env;
        Object.defineProperty(instrumented, "CDB_FILES", {
            value: instrumentR2Bucket(env, state.storage),
            enumerable: true,
            configurable: false,
            writable: false,
        });
        super(state, instrumented);
    }

    override async alarm(): Promise<void> {}

    async fixtureRunAlarm(): Promise<void> {
        await this.ctx.storage.deleteAlarm();
        maybeInterruptFileAlarm(this.ctx.storage, "before_metadata");
        await super.alarm();
    }

    fixtureArmAlarmFault(input: { fault: FileAlarmFault }): void {
        if (!FILE_ALARM_FAULTS.has(input.fault)) throw new Error("fixture alarm fault is invalid");
        ensureFileAlarmFaultTable(this.ctx.storage);
        adaptSqlStorage(this.ctx.storage.sql).exec(
            `INSERT INTO fixture_file_alarm_fault (fault, fired, calls) VALUES (?, 0, 0)
             ON CONFLICT (fault) DO UPDATE SET fired = 0, calls = 0`,
            input.fault
        );
    }

    fixtureAlarmFaultState(): readonly FileAlarmFaultState[] {
        ensureFileAlarmFaultTable(this.ctx.storage);
        return adaptSqlStorage(this.ctx.storage.sql).all<FileAlarmFaultState>(
            "SELECT fault, fired, calls FROM fixture_file_alarm_fault ORDER BY fault"
        );
    }

    fixtureResetSplitCapacity(input: { migId: string }): void {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `UPDATE _chardb_split_state SET capture = 0
                 WHERE mig_id = ? AND role = 'source' AND capture = 1`,
                input.migId
            );
            if (sql.changes() !== 1) throw new Error("fixture split source is not capturing");
            sql.exec("DELETE FROM _chardb_files WHERE content_type LIKE 'application/x-chardb-capacity%'");
            sql.exec("DELETE FROM _chardb_split_log WHERE mig_id = ?", input.migId);
            sql.exec(
                `UPDATE _chardb_split_state
                 SET capture = 1, acked_lsn = 0, split_log_rows = 0, split_log_bytes = 0,
                     capture_tx_id = NULL, capture_tx_rows = 0, capture_tx_bytes = 0
                 WHERE mig_id = ? AND role = 'source' AND capture = 0`,
                input.migId
            );
            if (sql.changes() !== 1) throw new Error("fixture split source reset failed");
            sql.exec(
                `UPDATE _chardb_split_capture_tx SET active_id = NULL, active_vshard = NULL
                 WHERE singleton = 1`
            );
        });
    }

    fixtureSetSplitCapacity(input: { migId: string; rows: number; bytes: number }): void {
        if (
            !Number.isSafeInteger(input.rows) ||
            input.rows < 0 ||
            input.rows > CDB_SPLIT_LOG_MAX_ROWS ||
            !Number.isSafeInteger(input.bytes) ||
            input.bytes < 0 ||
            input.bytes > CDB_SPLIT_LOG_MAX_BYTES
        ) {
            throw new Error("fixture split capacity is invalid");
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `UPDATE _chardb_split_state
             SET split_log_rows = ?, split_log_bytes = ?, capture_tx_id = NULL,
                 capture_tx_rows = 0, capture_tx_bytes = 0
             WHERE mig_id = ? AND role = 'source' AND capture = 1`,
            input.rows,
            input.bytes,
            input.migId
        );
        if (sql.changes() !== 1) throw new Error("fixture split source is not capturing");
    }

    fixtureCaptureMetadata(input: {
        migId: string;
        organizationId: string;
        count: number;
        startIndex: number;
        paddingBytes: number;
        transactions: "single" | "separate";
    }): SplitCapacityState {
        if (
            !/^[A-Za-z0-9_-]{1,128}$/.test(input.migId) ||
            typeof input.organizationId !== "string" ||
            input.organizationId.length === 0 ||
            !Number.isSafeInteger(input.count) ||
            input.count < 1 ||
            input.count > CDB_SPLIT_TX_MAX_ROWS + 1 ||
            !Number.isSafeInteger(input.startIndex) ||
            input.startIndex < 1 ||
            input.startIndex + input.count > 1_000_000 ||
            !Number.isSafeInteger(input.paddingBytes) ||
            input.paddingBytes < 0 ||
            input.paddingBytes > CDB_SPLIT_TX_MAX_ROW_BYTES ||
            (input.transactions !== "single" && input.transactions !== "separate")
        ) {
            throw new Error("fixture metadata capture request is invalid");
        }
        const contentType = `application/x-chardb-capacity-${"x".repeat(input.paddingBytes)}`;
        const insert = (index: number): void => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const fileId = `fil_${index.toString(16).padStart(64, "0")}`;
            sql.exec(
                `INSERT INTO _chardb_files
                   (file_id, organization_id, table_name, column_name, object_key, content_type,
                    size, sha256, status, row_id, created_at, updated_at, placement_vshard)
                 VALUES (?, ?, 'file_move_documents', 'attachment', ?, ?, 1, NULL, 'pending', NULL, 1, 1, ?)`,
                fileId,
                input.organizationId,
                `v1/${input.organizationId}/${fileId}`,
                contentType,
                vshard(input.organizationId)
            );
        };
        const capture = (start: number, count: number): void => {
            this.ctx.storage.transactionSync(() => {
                const sql = adaptSqlStorage(this.ctx.storage.sql);
                const transactionId = beginExternalFileCapture(sql, input.organizationId);
                for (let offset = 0; offset < count; offset++) insert(start + offset);
                endExternalFileCapture(sql, transactionId);
            });
        };
        if (input.transactions === "single") {
            capture(input.startIndex, input.count);
        } else {
            for (let offset = 0; offset < input.count; offset++) capture(input.startIndex + offset, 1);
        }
        return this.fixtureSplitCapacityState({ migId: input.migId });
    }

    fixtureSplitCapacityState(input: { migId: string }): SplitCapacityState {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const state = sql.one<{
            split_log_rows: number;
            split_log_bytes: number;
            capture_tx_rows: number;
            capture_tx_bytes: number;
        }>(
            `SELECT split_log_rows, split_log_bytes, capture_tx_rows, capture_tx_bytes
             FROM _chardb_split_state WHERE mig_id = ? AND role = 'source'`,
            input.migId
        );
        if (!state) throw new Error("fixture split source state is missing");
        const log = sql.one<{ rows: number; transactions: number }>(
            `SELECT COUNT(*) AS rows, COUNT(DISTINCT source_tx_id) AS transactions
             FROM _chardb_split_log WHERE mig_id = ?`,
            input.migId
        );
        const metadata = sql.one<{ rows: number }>(
            "SELECT COUNT(*) AS rows FROM _chardb_files WHERE content_type LIKE 'application/x-chardb-capacity%'"
        );
        return {
            splitLogRows: state.split_log_rows,
            splitLogBytes: state.split_log_bytes,
            captureTxRows: state.capture_tx_rows,
            captureTxBytes: state.capture_tx_bytes,
            storedLogRows: log?.rows ?? 0,
            storedTransactions: log?.transactions ?? 0,
            metadataRows: metadata?.rows ?? 0,
        };
    }

    fixtureArmResponseLoss(input: { migId: string; operation: FileResponseLossOperation }): void {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.migId) || !FILE_RESPONSE_LOSS_OPERATIONS.has(input.operation)) {
            throw new Error("fixture response-loss request is invalid");
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ensureResponseLossTable(sql);
        sql.exec(
            `INSERT INTO fixture_file_response_loss (mig_id, operation, fired, calls)
             VALUES (?, ?, 0, 0)`,
            input.migId,
            input.operation
        );
    }

    fixtureResponseLossState(input: { migId: string }): readonly FileResponseLossState[] {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ensureResponseLossTable(sql);
        return sql.all<FileResponseLossState>(
            `SELECT operation, fired, calls FROM fixture_file_response_loss
             WHERE mig_id = ? ORDER BY operation`,
            input.migId
        );
    }

    override applyReshardFileSnapshot(
        args: Parameters<InstanceType<typeof app.Cdb>["applyReshardFileSnapshot"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["applyReshardFileSnapshot"]> {
        const result = super.applyReshardFileSnapshot(args);
        this.maybeLoseFileResponse(args.migId, "apply_snapshot");
        return result;
    }

    override applyReshardFileTombstonesV2(
        args: Parameters<InstanceType<typeof app.Cdb>["applyReshardFileTombstonesV2"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["applyReshardFileTombstonesV2"]> {
        const result = super.applyReshardFileTombstonesV2(args);
        this.maybeLoseFileResponse(args.migId, "apply_tombstones");
        return result;
    }

    override prepareReshardFileDestAttachments(
        args: Parameters<InstanceType<typeof app.Cdb>["prepareReshardFileDestAttachments"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["prepareReshardFileDestAttachments"]> {
        const result = super.prepareReshardFileDestAttachments(args);
        this.maybeLoseFileResponse(args.migId, "prepare_attachments");
        return result;
    }

    override activateReshardFileDest(
        args: Parameters<InstanceType<typeof app.Cdb>["activateReshardFileDest"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["activateReshardFileDest"]> {
        this.maybeLoseFileResponse(args.migId, "before_activate_dest");
        const result = super.activateReshardFileDest(args);
        this.maybeLoseFileResponse(args.migId, "activate_dest");
        return result;
    }

    override drainReshardFiles(
        args: Parameters<InstanceType<typeof app.Cdb>["drainReshardFiles"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["drainReshardFiles"]> {
        const result = super.drainReshardFiles(args);
        this.maybeLoseFileResponse(args.migId, "drain_source");
        return result;
    }

    override abortReshardFiles(
        args: Parameters<InstanceType<typeof app.Cdb>["abortReshardFiles"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["abortReshardFiles"]> {
        const result = super.abortReshardFiles(args);
        this.maybeLoseFileResponse(args.migId, args.role === "source" ? "abort_source" : "abort_dest");
        return result;
    }

    override finishReshardFiles(
        args: Parameters<InstanceType<typeof app.Cdb>["finishReshardFiles"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["finishReshardFiles"]> {
        const result = super.finishReshardFiles(args);
        this.maybeLoseFileResponse(args.migId, args.role === "source" ? "finish_source" : "finish_dest");
        return result;
    }

    private ensureResponseLossTable(sql: ReturnType<typeof adaptSqlStorage>): void {
        sql.exec(`CREATE TABLE IF NOT EXISTS fixture_file_response_loss (
          mig_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          fired INTEGER NOT NULL CHECK (fired IN (0, 1)),
          calls INTEGER NOT NULL CHECK (calls >= 0),
          PRIMARY KEY (mig_id, operation)
        )`);
    }

    private maybeLoseFileResponse(migId: string, operation: FileResponseLossOperation): void {
        let lose = false;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            this.ensureResponseLossTable(sql);
            const armed = sql.one<{ fired: number }>(
                "SELECT fired FROM fixture_file_response_loss WHERE mig_id = ? AND operation = ?",
                migId,
                operation
            );
            if (!armed) return;
            lose = armed.fired === 0;
            sql.exec(
                `UPDATE fixture_file_response_loss
                 SET fired = CASE WHEN fired = 0 THEN 1 ELSE fired END, calls = calls + 1
                 WHERE mig_id = ? AND operation = ?`,
                migId,
                operation
            );
        });
        if (lose) throw new Error(`fixture response lost after ${operation} commit`);
    }

    async fixtureSeedFile(input: {
        organizationId: string;
        rowId: string;
        fileId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        body: string;
    }): Promise<Record<string, unknown>> {
        const nowMs = Date.now();
        const fileId = FileId(input.fileId);
        const reserved = await this.reserveFile({
            fileId,
            organizationId: input.organizationId,
            table: "file_move_documents",
            column: "attachment",
            contentType: "image/png",
            size: new TextEncoder().encode(input.body).byteLength,
            nowMs,
            schemaEpoch: input.schemaEpoch,
            domainSchemaEpoch: input.domainSchemaEpoch,
            auth: fileAuth(input.organizationId),
        });
        if (!this.env.CDB_FILES) throw new Error("CDB_FILES binding is missing");
        await this.env.CDB_FILES.put(reserved.objectKey, input.body, {
            customMetadata: { fixture: input.fileId },
        });
        const ready = this.markFileReady({
            fileId,
            organizationId: input.organizationId,
            sha256: HASH,
            size: reserved.size,
            nowMs: nowMs + 1,
            schemaEpoch: input.schemaEpoch,
            domainSchemaEpoch: input.domainSchemaEpoch,
            auth: fileAuth(input.organizationId),
        });
        await this.fixtureAttachFile({
            organizationId: input.organizationId,
            rowId: input.rowId,
            fileId: input.fileId,
            schemaEpoch: input.schemaEpoch,
            domainSchemaEpoch: input.domainSchemaEpoch,
        });
        return { ...ready, rowId: input.rowId };
    }

    async fixtureSeedPendingFile(input: {
        organizationId: string;
        fileId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        body: string;
    }): Promise<Record<string, unknown>> {
        const fileId = FileId(input.fileId);
        const reserved = await this.reserveFile({
            fileId,
            organizationId: input.organizationId,
            table: "file_move_documents",
            column: "attachment",
            contentType: "image/png",
            size: new TextEncoder().encode(input.body).byteLength,
            nowMs: 1,
            schemaEpoch: input.schemaEpoch,
            domainSchemaEpoch: input.domainSchemaEpoch,
            auth: fileAuth(input.organizationId),
        });
        if (!this.env.CDB_FILES) throw new Error("CDB_FILES binding is missing");
        await this.env.CDB_FILES.put(reserved.objectKey, input.body, {
            customMetadata: { fixture: input.fileId, state: "pending" },
        });
        return { ...reserved };
    }

    async fixtureAttachFile(input: {
        organizationId: string;
        rowId: string;
        fileId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
    }): Promise<void> {
        const attached = await this.mutate({
            principalId: "file-e2e-user",
            mutId: `attach-${input.fileId}`,
            ref: attachDocument.__chardbRef,
            args: { organizationId: input.organizationId, rowId: input.rowId, fileId: input.fileId },
            placement: { authority: "organization", partitionKey: input.organizationId },
            auth: fileAuth(input.organizationId),
            schemaEpoch: input.schemaEpoch,
            domainSchemaEpoch: input.domainSchemaEpoch,
        });
        if (!attached.ok) throw new Error(`${attached.error.code}: ${attached.error.message}`);
    }

    fixtureState(input: { organizationIds: readonly string[]; migId: string }): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const placeholders = input.organizationIds.map(() => "?").join(", ");
        return {
            rows: sql.all(
                `SELECT id, organization_id, attachment FROM file_move_documents
                 WHERE organization_id IN (${placeholders}) ORDER BY organization_id, id`,
                ...input.organizationIds
            ),
            files: sql.all(
                `SELECT file_id, organization_id, object_key, content_type, size, sha256, status, row_id,
                        placement_vshard
                 FROM _chardb_files WHERE organization_id IN (${placeholders}) ORDER BY organization_id, file_id`,
                ...input.organizationIds
            ),
            tombstones: sql.all(
                `SELECT organization_id, deleted_at, placement_vshard FROM _chardb_deleted_organizations
                 WHERE organization_id IN (${placeholders}) ORDER BY organization_id`,
                ...input.organizationIds
            ),
            split: sql.one(
                `SELECT mig_id, role, capture, drained, destination_serving, abort_started
                 FROM _chardb_split_state WHERE mig_id = ?`,
                input.migId
            ),
            fileSplit: sql.one(
                `SELECT mig_id, role, outcome, maintenance_enabled, attachments_enabled, source_fenced
                 FROM _chardb_split_file_cursor WHERE mig_id = ?`,
                input.migId
            ),
            splitLog: sql.all(
                `SELECT lsn, source_tx_id, op, table_name, pk FROM _chardb_split_log
                 WHERE mig_id = ? AND table_name IN ('_chardb_files', '_chardb_deleted_organizations') ORDER BY lsn`,
                input.migId
            ),
        };
    }

    fixtureCorruptFile(input: {
        organizationId: string;
        fileId: string;
        mode: "omitted" | "mutated" | "extra";
    }): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        if (input.mode === "omitted") {
            sql.exec(
                "DELETE FROM _chardb_files WHERE file_id = ? AND organization_id = ?",
                input.fileId,
                input.organizationId
            );
            return;
        }
        if (input.mode === "mutated") {
            sql.exec(
                "UPDATE _chardb_files SET content_type = 'image/jpeg' WHERE file_id = ? AND organization_id = ?",
                input.fileId,
                input.organizationId
            );
            return;
        }
        const extraId = `fil_${"f".repeat(64)}`;
        sql.exec(
            `INSERT INTO _chardb_files
               (file_id, organization_id, table_name, column_name, object_key, content_type, size, sha256,
                status, row_id, created_at, updated_at, placement_vshard)
             VALUES (?, ?, 'file_move_documents', 'attachment', ?, 'image/png', 1, ?, 'ready', NULL, 1, 1, ?)`,
            extraId,
            input.organizationId,
            `v1/${input.organizationId}/${extraId}`,
            HASH,
            vshard(input.organizationId)
        );
    }

    fixtureClearFileRange(input: { vshard: number; migId: string }): void {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec("DELETE FROM _chardb_files WHERE placement_vshard = ?", input.vshard);
            sql.exec("DELETE FROM _chardb_deleted_organizations WHERE placement_vshard = ?", input.vshard);
            sql.exec("DELETE FROM _chardb_split_file_applied WHERE mig_id = ?", input.migId);
        });
    }
}

export class Resharder extends ProductionResharder {
    fixtureState(migId: string): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            migration: sql.one(
                `SELECT mig_id, src_shard, dst_shard, range_lo, range_hi, phase, epoch_at_start,
                        bulk_cursor, tail_cursor
                 FROM migration_state WHERE mig_id = ?`,
                migId
            ),
            files: sql.one("SELECT * FROM migration_file_cursor WHERE mig_id = ?", migId),
        };
    }
}

export const DB = app.DB;

async function activateSchema(env: Env): Promise<void> {
    const cat = catalog(env);
    if ((await cat.schemaState()).activeVersion !== 0) return;
    const migrationId = "file-move-schema-v1";
    await cat.beginSchemaMigration({ migrationId, targetVersion: 1 });
    await cat.migrateSchemaShard({ migrationId, shardId: SOURCE });
    await cat.applyCatalogSchemaMigration({ migrationId, version: 1 });
    await cat.completeSchemaMigration({ migrationId });
}

async function createOrganization(cat: CatalogRpc, organizationId: string): Promise<void> {
    await cat.mutateAuth({
        model: "organization",
        op: "create",
        payload: {
            id: organizationId,
            name: organizationId,
            slug: organizationId,
            createdAt: Date.now(),
        },
    });
}

async function createHttpPrincipal(cat: CatalogRpc, organizationId: string, principalId: string): Promise<void> {
    const nowMs = Date.now();
    await cat.mutateAuth({
        model: "user",
        op: "create",
        payload: {
            id: principalId,
            name: principalId,
            email: `${principalId}@file-reshard.invalid`,
            emailVerified: true,
            createdAt: nowMs,
            updatedAt: nowMs,
        },
    });
    await cat.mutateAuth({
        model: "member",
        op: "create",
        payload: {
            id: `member-${principalId}`,
            organizationId,
            userId: principalId,
            role: "member",
            createdAt: nowMs,
        },
    });
}

async function driveMigrationTo(env: Env, migId: string, expectedPhase: number, limit = 128): Promise<void> {
    const driver = resharder(env);
    for (let turn = 0; turn < limit; turn++) {
        const current = await driver.getPhase(migId);
        if (current === expectedPhase) return;
        if (current === null || current > expectedPhase) {
            throw new Error(`migration ${migId} reached phase ${String(current)} before ${expectedPhase}`);
        }
        await driver.runSplit(migId);
    }
    throw new Error(`migration ${migId} did not reach phase ${expectedPhase} in ${limit} turns`);
}

async function setup(env: Env, input: SplitSetup): Promise<Record<string, unknown>> {
    await activateSchema(env);
    const [snapshotOrg, preDeleteOrg, postDeleteOrg] = input.organizationIds;
    const placement = vshard(snapshotOrg);
    if (input.organizationIds.some(id => vshard(id) !== placement))
        throw new Error("fixture organizations must colocate");
    const cat = catalog(env);
    const route = await cat.route(placement);
    if (route.shardId !== SOURCE) throw new Error(`fixture range is owned by ${route.shardId}, not ${SOURCE}`);
    for (const organizationId of input.organizationIds) await createOrganization(cat, organizationId);
    const source = cdb(env, SOURCE);
    const seeded = [];
    for (const [index, organizationId] of input.organizationIds.entries()) {
        const fileHex = `${placement.toString(16)}${String(index + 1)}`.padEnd(64, String(index + 1)).slice(0, 64);
        seeded.push(
            await source.fixtureSeedFile({
                organizationId,
                rowId: `row-${input.migId}-${index}`,
                fileId: `fil_${fileHex}`,
                schemaEpoch: route.schemaEpoch,
                domainSchemaEpoch: route.domainSchemaEpoch,
                body: `body-${index}`,
            })
        );
    }
    await resharder(env).startSplit({
        migId: input.migId,
        srcShard: SOURCE,
        dstShard: input.destination,
        rangeLo: placement,
        rangeHi: placement,
        epochAtStart: route.schemaEpoch,
        tables: TABLES,
    });
    return { route, placement, seeded, snapshotOrg, preDeleteOrg, postDeleteOrg };
}

async function splitIdentity(env: Env, input: SplitSetup): Promise<SplitIdentity> {
    const state = await cdb(env, SOURCE).schemaState();
    const placement = vshard(input.organizationIds[0]);
    return {
        migId: input.migId,
        rangeLo: placement,
        rangeHi: placement,
        schemaVersion: state.activeVersion,
        schemaEpoch: state.activeEpoch,
        schemaDigest: state.activeDigest,
        tables: TABLES,
    };
}

async function restoreFileParity(env: Env, input: SplitSetup): Promise<void> {
    const source = cdb(env, SOURCE);
    const destination = cdb(env, input.destination);
    const identity = await splitIdentity(env, input);
    await destination.fixtureClearFileRange({ vshard: identity.rangeLo, migId: identity.migId });
    let afterPlacement = -1;
    let afterId = "";
    for (;;) {
        const page = await source.readReshardFileSnapshot({
            ...identity,
            afterPlacement,
            afterFileId: afterId,
            limit: 500,
        });
        if (page.rows.length > 0) {
            await destination.applyReshardFileSnapshot({
                ...identity,
                rows: page.rows,
                throughLsn: page.throughLsn,
            });
        }
        if (page.done) break;
        afterPlacement = page.afterPlacement;
        afterId = page.afterId;
    }
    afterPlacement = -1;
    afterId = "";
    for (;;) {
        const page = await source.readReshardFileTombstones({
            ...identity,
            afterPlacement,
            afterOrganizationId: afterId,
            limit: 500,
        });
        if (page.rows.length > 0) {
            await destination.applyReshardFileTombstones({
                ...identity,
                rows: page.rows,
                throughLsn: page.throughLsn,
            });
        }
        if (page.done) break;
        afterPlacement = page.afterPlacement;
        afterId = page.afterId;
    }
}

async function fileGate(
    env: Env,
    input: {
        shardId: string;
        organizationId: string;
        operation: "reserve" | "download";
        fileId?: string;
        rowId?: string;
    }
): Promise<unknown> {
    const route = await catalog(env).route(vshard(input.organizationId));
    const target = cdb(env, input.shardId);
    if (input.operation === "reserve") {
        return target.reserveFile({
            fileId: FileId(input.fileId ?? `fil_${"e".repeat(64)}`),
            organizationId: input.organizationId,
            table: "file_move_documents",
            column: "attachment",
            contentType: "image/png",
            size: 1,
            nowMs: Date.now(),
            schemaEpoch: route.schemaEpoch,
            domainSchemaEpoch: route.domainSchemaEpoch,
            auth: fileAuth(input.organizationId),
        });
    }
    return target.resolveFileDownload({
        organizationId: input.organizationId,
        table: "file_move_documents",
        column: "attachment",
        rowId: input.rowId,
        schemaEpoch: route.schemaEpoch,
        domainSchemaEpoch: route.domainSchemaEpoch,
        auth: fileAuth(input.organizationId),
    });
}

async function httpUploadAcrossCutover(
    env: Env,
    input: {
        readonly migId: string;
        readonly destination: string;
        readonly secondDestination: string;
        readonly organizationId: string;
        readonly rowId: string;
        readonly idempotencyKey: string;
        readonly fileBody: string;
    }
): Promise<Record<string, unknown>> {
    if ((await resharder(env).getPhase(input.migId)) !== RESHARDER_PHASE.TAIL_CAUGHT_UP) {
        throw new Error("HTTP upload race must start at the final pre-cutover phase");
    }
    const principalId = `http-${input.migId}`;
    await createHttpPrincipal(catalog(env), input.organizationId, principalId);
    const locator = {
        organizationId: input.organizationId,
        table: FILE_RESOURCE.table,
        column: FILE_RESOURCE.column,
    };
    const expectedFileId = await organizationFileId({
        principalId,
        locator,
        idempotencyKey: input.idempotencyKey,
    });
    const sourceRoute = await catalog(env).route(vshard(input.organizationId));
    if (sourceRoute.shardId !== SOURCE) throw new Error("HTTP upload race source route already moved");
    const sessionAuth = {
        api: {
            getSession: () => ({
                user: { id: principalId },
                session: { activeOrganizationId: input.organizationId },
            }),
        },
    };
    let putCalls = 0;
    let staleSourceReadyError = "";
    let objectAfterFirstPut: readonly Record<string, unknown>[] = [];
    const raceBucket = new Proxy(env.CDB_FILES, {
        get(target, property) {
            if (property === "put") {
                return async (key: string, ...args: unknown[]) => {
                    putCalls++;
                    const written = await Reflect.apply(target.put, target, [key, ...args]);
                    if (putCalls === 1) {
                        objectAfterFirstPut = await r2State(env, [key]);
                        await driveMigrationTo(env, input.migId, RESHARDER_PHASE.DUAL_WRITE_OPEN);
                        const sha256 = objectAfterFirstPut[0]?.customMetadata;
                        const digest =
                            sha256 && typeof sha256 === "object" && "chardbSha256" in sha256
                                ? String(sha256.chardbSha256)
                                : "";
                        try {
                            await cdb(env, SOURCE).markFileReady({
                                fileId: expectedFileId,
                                organizationId: input.organizationId,
                                sha256: digest,
                                size: new TextEncoder().encode(input.fileBody).byteLength,
                                nowMs: Date.now(),
                                schemaEpoch: sourceRoute.schemaEpoch,
                                domainSchemaEpoch: sourceRoute.domainSchemaEpoch,
                                auth: fileAuth(input.organizationId),
                            });
                            throw new Error("stale source markFileReady unexpectedly succeeded");
                        } catch (error) {
                            staleSourceReadyError = errorMessage(error);
                            if (!staleSourceReadyError.includes("CDB_STALE_EPOCH")) throw error;
                        }
                    }
                    return written;
                };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const httpEnv = Object.assign(Object.create(env), { CDB_FILES: raceBucket }) as ChardbEnv;
    const uploadRequest = new Request(
        `https://file-reshard-e2e.invalid${ORGANIZATION_FILE_UPLOAD_PATH}?organizationId=${encodeURIComponent(input.organizationId)}&table=${FILE_RESOURCE.table}&column=${FILE_RESOURCE.column}`,
        {
            method: "PUT",
            headers: {
                "content-type": "image/png",
                "idempotency-key": input.idempotencyKey,
            },
            body: input.fileBody,
        }
    );
    const upload = await handleOrganizationFileUploadRequest({
        request: uploadRequest,
        env: httpEnv,
        auth: sessionAuth,
        resources: [FILE_RESOURCE],
    });
    const uploadBody = (await upload.json()) as { readonly file?: { readonly fileId?: unknown } };
    if (upload.status !== 200 || uploadBody.file?.fileId !== expectedFileId) {
        throw new Error(`packaged upload failed: ${upload.status} ${JSON.stringify(uploadBody)}`);
    }
    const destinationRoute = await catalog(env).route(vshard(input.organizationId));
    if (destinationRoute.shardId !== input.destination) throw new Error("HTTP upload race did not cut over");
    await cdb(env, input.destination).fixtureAttachFile({
        organizationId: input.organizationId,
        rowId: input.rowId,
        fileId: expectedFileId,
        schemaEpoch: destinationRoute.schemaEpoch,
        domainSchemaEpoch: destinationRoute.domainSchemaEpoch,
    });
    const download = await handleOrganizationFileDownloadRequest({
        request: new Request(
            `https://file-reshard-e2e.invalid${ORGANIZATION_FILE_DOWNLOAD_PATH}?organizationId=${encodeURIComponent(input.organizationId)}&table=${FILE_RESOURCE.table}&column=${FILE_RESOURCE.column}&rowId=${encodeURIComponent(input.rowId)}`
        ),
        env: httpEnv,
        auth: sessionAuth,
        resources: [FILE_RESOURCE],
    });
    const downloadedBody = await download.text();
    let secondMoveError = "";
    try {
        await resharder(env).startSplit({
            migId: `${input.migId}_concurrent`,
            srcShard: input.destination,
            dstShard: input.secondDestination,
            rangeLo: vshard(input.organizationId),
            rangeHi: vshard(input.organizationId),
            epochAtStart: destinationRoute.schemaEpoch,
            tables: TABLES,
        });
        throw new Error("concurrent second movement unexpectedly started");
    } catch (error) {
        secondMoveError = errorMessage(error);
        if (!secondMoveError.includes("already active")) throw error;
    }
    return {
        expectedFileId,
        uploadStatus: upload.status,
        uploadBody,
        putCalls,
        objectAfterFirstPut,
        staleSourceReadyError,
        route: destinationRoute,
        downloadStatus: download.status,
        downloadBody: downloadedBody,
        downloadContentType: download.headers.get("content-type"),
        secondMoveError,
    };
}

async function r2State(env: Env, keys: readonly string[]): Promise<readonly Record<string, unknown>[]> {
    return Promise.all(
        keys.map(async key => {
            const object = await env.CDB_FILES.get(key);
            const body = object ? await object.arrayBuffer() : null;
            const sha256 = body
                ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
                      .map(value => value.toString(16).padStart(2, "0"))
                      .join("")
                : null;
            return {
                key,
                present: object !== null,
                size: object?.size ?? null,
                etag: object?.etag ?? null,
                sha256,
                uploaded: object?.uploaded.toISOString() ?? null,
                customMetadata: object?.customMetadata ?? null,
            };
        })
    );
}

async function r2Prefix(env: Env, prefix: string): Promise<readonly Record<string, unknown>[]> {
    const listed = await env.CDB_FILES.list({ prefix, limit: 1_000 });
    if (listed.truncated) throw new Error("fixture R2 prefix exceeded its bounded proof page");
    return Promise.all(
        [...listed.objects]
            .sort((left, right) => left.key.localeCompare(right.key))
            .map(object => r2State(env, [object.key]).then(rows => rows[0] as Record<string, unknown>))
    );
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const operation = new URL(request.url).pathname.slice(1);
        const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
        try {
            const setupInput = body as unknown as SplitSetup;
            if (operation === "setup") return Response.json(await setup(env, setupInput));
            if (operation === "run") return Response.json(await resharder(env).runSplit(String(body.migId)));
            if (operation === "phase") {
                return Response.json({
                    phase: await resharder(env).getPhase(String(body.migId)),
                    state: await resharder(env).fixtureState(String(body.migId)),
                });
            }
            if (operation === "route") return Response.json(await catalog(env).route(Number(body.vshard)));
            if (operation === "state") {
                const organizationIds = body.organizationIds as string[];
                return Response.json({
                    source: await cdb(env, SOURCE).fixtureState({ organizationIds, migId: String(body.migId) }),
                    destination: await cdb(env, String(body.destination)).fixtureState({
                        organizationIds,
                        migId: String(body.migId),
                    }),
                    resharder: await resharder(env).fixtureState(String(body.migId)),
                });
            }
            if (operation === "seedFile") {
                const organizationId = String(body.organizationId);
                const route = await catalog(env).route(vshard(organizationId));
                return Response.json(
                    await cdb(env, String(body.shardId)).fixtureSeedFile({
                        organizationId,
                        rowId: String(body.rowId),
                        fileId: String(body.fileId),
                        schemaEpoch: route.schemaEpoch,
                        domainSchemaEpoch: route.domainSchemaEpoch,
                        body: String(body.fileBody),
                    })
                );
            }
            if (operation === "seedPendingFile") {
                const organizationId = String(body.organizationId);
                const route = await catalog(env).route(vshard(organizationId));
                return Response.json(
                    await cdb(env, String(body.shardId)).fixtureSeedPendingFile({
                        organizationId,
                        fileId: String(body.fileId),
                        schemaEpoch: route.schemaEpoch,
                        domainSchemaEpoch: route.domainSchemaEpoch,
                        body: String(body.fileBody),
                    })
                );
            }
            if (operation === "httpUploadRace") {
                return Response.json(
                    await httpUploadAcrossCutover(env, {
                        migId: String(body.migId),
                        destination: String(body.destination),
                        secondDestination: String(body.secondDestination),
                        organizationId: String(body.organizationId),
                        rowId: String(body.rowId),
                        idempotencyKey: String(body.idempotencyKey),
                        fileBody: String(body.fileBody),
                    })
                );
            }
            if (operation === "gate") return Response.json(await fileGate(env, body as never));
            if (operation === "delete") {
                const organizationId = String(body.organizationId);
                await catalog(env).mutateAuth({
                    model: "organization",
                    op: "delete",
                    where: { id: organizationId },
                    limitOne: true,
                });
                await catalog(env).fixtureRunAlarm();
                const deletion = await catalog(env).fixtureDeletion({ organizationId });
                const shard = (deletion.shards as readonly { readonly shard_id?: unknown }[] | undefined)?.[0];
                if (typeof shard?.shard_id !== "string") throw new Error("fixture deletion shard is missing");
                await cdb(env, shard.shard_id).fixtureRunAlarm();
                return Response.json(await catalog(env).fixtureDeletion({ organizationId }));
            }
            if (operation === "fileAlarm") {
                await cdb(env, String(body.shardId)).fixtureRunAlarm();
                return Response.json({ ok: true });
            }
            if (operation === "armAlarmFault") {
                await cdb(env, String(body.shardId)).fixtureArmAlarmFault({
                    fault: String(body.fault) as FileAlarmFault,
                });
                return Response.json({ ok: true });
            }
            if (operation === "alarmFaultState") {
                return Response.json(await cdb(env, String(body.shardId)).fixtureAlarmFaultState());
            }
            if (operation === "armResponseLoss") {
                await cdb(env, String(body.shardId)).fixtureArmResponseLoss({
                    migId: String(body.migId),
                    operation: String(body.fault) as FileResponseLossOperation,
                });
                return Response.json({ ok: true });
            }
            if (operation === "responseLossState") {
                return Response.json(
                    await cdb(env, String(body.shardId)).fixtureResponseLossState({ migId: String(body.migId) })
                );
            }
            if (operation === "capacityReset") {
                await cdb(env, SOURCE).fixtureResetSplitCapacity({ migId: String(body.migId) });
                return Response.json({ ok: true });
            }
            if (operation === "capacitySet") {
                await cdb(env, SOURCE).fixtureSetSplitCapacity({
                    migId: String(body.migId),
                    rows: Number(body.rows),
                    bytes: Number(body.bytes),
                });
                return Response.json({ ok: true });
            }
            if (operation === "capacityCapture") {
                return Response.json(
                    await cdb(env, SOURCE).fixtureCaptureMetadata({
                        migId: String(body.migId),
                        organizationId: String(body.organizationId),
                        count: Number(body.count),
                        startIndex: Number(body.startIndex),
                        paddingBytes: Number(body.paddingBytes),
                        transactions: body.transactions as "single" | "separate",
                    })
                );
            }
            if (operation === "capacityState") {
                return Response.json(await cdb(env, SOURCE).fixtureSplitCapacityState({ migId: String(body.migId) }));
            }
            if (operation === "capacityTailPage") {
                return Response.json(
                    await cdb(env, SOURCE).readTailBatch({
                        migId: String(body.migId),
                        afterLsn: Number(body.afterLsn),
                        limit: Number(body.limit),
                    })
                );
            }
            if (operation === "capacityFilePage") {
                const identity = await splitIdentity(env, setupInput);
                return Response.json(
                    await cdb(env, SOURCE).readReshardFileSnapshot({
                        ...identity,
                        afterPlacement: Number(body.afterPlacement),
                        afterFileId: String(body.afterFileId),
                        limit: Number(body.limit),
                    })
                );
            }
            if (operation === "corrupt") {
                await cdb(env, String(body.destination)).fixtureCorruptFile({
                    organizationId: String(body.organizationId),
                    fileId: String(body.fileId),
                    mode: body.mode as "omitted" | "mutated" | "extra",
                });
                return Response.json({ ok: true });
            }
            if (operation === "restore") {
                await restoreFileParity(env, setupInput);
                return Response.json({ ok: true });
            }
            if (operation === "r2") return Response.json(await r2State(env, body.keys as string[]));
            if (operation === "r2Prefix") return Response.json(await r2Prefix(env, String(body.prefix)));
            if (operation === "r2Operations") return Response.json(await catalog(env).fixtureR2Operations());
            if (operation === "abort") {
                await resharder(env).abort(String(body.migId));
                return Response.json({ phase: await resharder(env).getPhase(String(body.migId)) });
            }
            if (operation === "constants") return Response.json({ phases: RESHARDER_PHASE, source: SOURCE });
            return new Response("not found", { status: 404 });
        } catch (error) {
            return Response.json({ error: errorMessage(error) }, { status: 500 });
        }
    },
};
