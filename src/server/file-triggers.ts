import type { TriggerSet } from "../reshard/triggers.ts";
import { stableHashHex } from "../util/canonical.ts";
import type { ChardbFileResourceDescriptor } from "./resource-descriptors.ts";

function identifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Generated trigger program for one private file locator. Attachment,
 * replacement, and deletion therefore share the owning row transaction.
 */
export function renderFileAttachmentTriggerSet(resource: ChardbFileResourceDescriptor): TriggerSet {
    const table = identifier(resource.table);
    const column = identifier(resource.column);
    const primaryKey = identifier(resource.primaryKey);
    const organizationColumn = identifier(resource.organizationColumn);
    const tableValue = literal(resource.table);
    const columnValue = literal(resource.column);
    const prefix = `_chardb_file_${stableHashHex(resource).slice(0, 16)}`;
    const clock = "MAX(updated_at + 1, CAST(unixepoch() AS INTEGER) * 1000)";
    const ready = (row: "NEW" | "OLD") => `
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM _chardb_files
        WHERE file_id = ${row}.${column}
          AND organization_id = ${row}.${organizationColumn}
          AND table_name = ${tableValue}
          AND column_name = ${columnValue}
          AND status = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM _chardb_deleted_organizations
            WHERE organization_id = ${row}.${organizationColumn}
          )
      ) THEN RAISE(ABORT, 'CDB_FILE_INVALID_ATTACHMENT') END`;

    const install = Object.freeze([
        `CREATE TRIGGER IF NOT EXISTS ${identifier(`${prefix}_bi`)}
         BEFORE INSERT ON ${table}
         WHEN NEW.${column} IS NOT NULL
         BEGIN${ready("NEW")};
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(`${prefix}_ai`)}
         AFTER INSERT ON ${table}
         WHEN NEW.${column} IS NOT NULL
         BEGIN
           UPDATE _chardb_files
           SET status = 'attached', row_id = CAST(NEW.${primaryKey} AS TEXT), updated_at = ${clock}
           WHERE file_id = NEW.${column} AND status = 'ready';
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(`${prefix}_bu`)}
         BEFORE UPDATE OF ${column} ON ${table}
         WHEN NEW.${column} IS NOT OLD.${column} AND NEW.${column} IS NOT NULL
         BEGIN${ready("NEW")};
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(`${prefix}_au`)}
         AFTER UPDATE OF ${column} ON ${table}
         WHEN NEW.${column} IS NOT OLD.${column}
         BEGIN
           UPDATE _chardb_files
           SET status = 'deleting', updated_at = ${clock}
           WHERE OLD.${column} IS NOT NULL
             AND file_id = OLD.${column}
             AND organization_id = OLD.${organizationColumn}
             AND table_name = ${tableValue}
             AND column_name = ${columnValue}
             AND row_id = CAST(OLD.${primaryKey} AS TEXT)
             AND status = 'attached';
           UPDATE _chardb_files
           SET status = 'attached', row_id = CAST(NEW.${primaryKey} AS TEXT), updated_at = ${clock}
           WHERE NEW.${column} IS NOT NULL AND file_id = NEW.${column} AND status = 'ready';
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(`${prefix}_ad`)}
         AFTER DELETE ON ${table}
         WHEN OLD.${column} IS NOT NULL
         BEGIN
           UPDATE _chardb_files
           SET status = 'deleting', updated_at = ${clock}
           WHERE file_id = OLD.${column}
             AND organization_id = OLD.${organizationColumn}
             AND table_name = ${tableValue}
             AND column_name = ${columnValue}
             AND row_id = CAST(OLD.${primaryKey} AS TEXT)
             AND status = 'attached';
         END`,
    ]);
    const names = Object.freeze([`${prefix}_bi`, `${prefix}_ai`, `${prefix}_bu`, `${prefix}_au`, `${prefix}_ad`]);
    return Object.freeze({
        names,
        install,
        uninstall: Object.freeze(names.map(name => `DROP TRIGGER IF EXISTS ${identifier(name)}`)),
    });
}

export function renderFileAttachmentTriggers(resource: ChardbFileResourceDescriptor): readonly string[] {
    return renderFileAttachmentTriggerSet(resource).install;
}
