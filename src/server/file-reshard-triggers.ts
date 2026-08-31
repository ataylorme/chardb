import type { SyncSql } from "../oplog/wrapper.ts";
import type { TriggerSet } from "../reshard/triggers.ts";
import { vshardOf } from "../vshard.ts";
import {
    CDB_EXTERNAL_RESHARD_CAPTURE_DDL,
    beginExternalReshardCapture,
    endExternalReshardCapture,
    initializeExternalReshardCapture,
} from "./external-reshard-capture.ts";
import {
    cdbLegacySystemTailTriggerId,
    cdbSystemTailMigrationId,
    cdbSystemTailTriggerId,
    renderCdbSystemTailAppend,
} from "./system-reshard-triggers.ts";

/** @deprecated Use CDB_EXTERNAL_RESHARD_CAPTURE_DDL. */
export const CDB_FILE_CAPTURE_TRANSACTION_DDL = CDB_EXTERNAL_RESHARD_CAPTURE_DDL;

const FILE_COLUMNS = [
    "file_id",
    "organization_id",
    "table_name",
    "column_name",
    "object_key",
    "content_type",
    "size",
    "sha256",
    "status",
    "row_id",
    "created_at",
    "updated_at",
    "placement_vshard",
] as const;
const TOMBSTONE_COLUMNS = ["organization_id", "deleted_at", "placement_vshard", "vector_unproven_turns"] as const;

function json(prefix: "NEW" | "OLD", columns: readonly string[]): string {
    return `json_object(${columns.map(column => `'${column}', ${prefix}."${column}"`).join(", ")})`;
}

export function initializeFileCaptureTransactions(sql: SyncSql): void {
    initializeExternalReshardCapture(sql);
}

/** Start one file metadata transaction. Call inside the owning SQLite transaction. */
export function beginExternalFileCapture(sql: SyncSql, organizationId: string): number {
    if (
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        new TextEncoder().encode(organizationId).byteLength > 256
    ) {
        throw new Error("file capture organization id is invalid");
    }
    return beginExternalReshardCapture(sql, Number(vshardOf([organizationId])));
}

export function endExternalFileCapture(sql: SyncSql, transactionId: number): void {
    endExternalReshardCapture(sql, transactionId);
}

function appendSql(input: {
    readonly migId: string;
    readonly table: "_chardb_files" | "_chardb_deleted_organizations";
    readonly op: "ins" | "upd" | "del";
    readonly prefix: "NEW" | "OLD";
    readonly pkColumn: "file_id" | "organization_id";
    readonly columns: readonly string[];
}): string {
    const placement = `${input.prefix}."placement_vshard"`;
    const pk = `${input.prefix}."${input.pkColumn}"`;
    const before = input.op === "ins" ? "NULL" : json("OLD", input.columns);
    const after = input.op === "del" ? "NULL" : json("NEW", input.columns);
    return renderCdbSystemTailAppend({
        migId: input.migId,
        kind: "file",
        table: input.table,
        op: input.op,
        pkSql: pk,
        placementSql: placement,
        beforeSql: before,
        afterSql: after,
    });
}

/** Capture file and deletion ownership in the same ordered tail as application rows. */
export function renderFileReshardTriggers(migId: string): TriggerSet {
    const id = cdbSystemTailMigrationId(migId);
    const triggerId = cdbSystemTailTriggerId(migId);
    const names = [
        `_chardb_filecapt_${triggerId}_ins`,
        `_chardb_filecapt_${triggerId}_upd`,
        `_chardb_filecapt_${triggerId}_del`,
        `_chardb_filecapt_${triggerId}_org_ins`,
        `_chardb_filecapt_${triggerId}_org_upd`,
    ];
    const legacyTriggerId = cdbLegacySystemTailTriggerId(migId);
    const legacyNames = [
        `_chardb_filecapt_${legacyTriggerId}_ins`,
        `_chardb_filecapt_${legacyTriggerId}_upd`,
        `_chardb_filecapt_${legacyTriggerId}_del`,
        `_chardb_filecapt_${legacyTriggerId}_org_ins`,
        `_chardb_filecapt_${legacyTriggerId}_org_upd`,
    ];
    const [insert, update, remove, tombstone, tombstoneUpdate] = names.map(name => `"${name}"`);
    return {
        names,
        install: [
            `CREATE TRIGGER IF NOT EXISTS ${insert} AFTER INSERT ON "_chardb_files" BEGIN ${appendSql({ migId: id, table: "_chardb_files", op: "ins", prefix: "NEW", pkColumn: "file_id", columns: FILE_COLUMNS })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${update} AFTER UPDATE ON "_chardb_files" BEGIN SELECT CASE WHEN OLD.placement_vshard IS NOT NEW.placement_vshard THEN RAISE(ABORT, 'CDB_INVARIANT: file placement is immutable') END; ${appendSql({ migId: id, table: "_chardb_files", op: "upd", prefix: "NEW", pkColumn: "file_id", columns: FILE_COLUMNS })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${remove} AFTER DELETE ON "_chardb_files" BEGIN ${appendSql({ migId: id, table: "_chardb_files", op: "del", prefix: "OLD", pkColumn: "file_id", columns: FILE_COLUMNS })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${tombstone} AFTER INSERT ON "_chardb_deleted_organizations" BEGIN ${appendSql({ migId: id, table: "_chardb_deleted_organizations", op: "ins", prefix: "NEW", pkColumn: "organization_id", columns: TOMBSTONE_COLUMNS })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${tombstoneUpdate} AFTER UPDATE OF "vector_unproven_turns" ON "_chardb_deleted_organizations" BEGIN ${appendSql({ migId: id, table: "_chardb_deleted_organizations", op: "upd", prefix: "NEW", pkColumn: "organization_id", columns: TOMBSTONE_COLUMNS })} END`,
        ],
        uninstall: [...new Set([...names, ...legacyNames])].map(name => `DROP TRIGGER IF EXISTS "${name}"`),
    };
}
