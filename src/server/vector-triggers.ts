import type { TriggerSet } from "../reshard/triggers.ts";
import { type VectorResourceV1, cdbVectorResourceId } from "./resource-descriptors.ts";

function identifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Require an explicit private vector mutation intent before a domain row can
 * attach, replace, or clear a logical vector id. Deletes require that intent
 * unless the row belongs to an organization with a durable deletion tombstone.
 */
export function renderVectorMutationTriggerSet(resource: VectorResourceV1): TriggerSet {
    const table = identifier(resource.table);
    const column = identifier(resource.column);
    const primaryKey = identifier(resource.primaryKey);
    const organizationColumn = identifier(resource.organizationColumn);
    const canonicalResourceId = cdbVectorResourceId(resource);
    const resourceId = literal(canonicalResourceId);
    const prefix = `_chardb_vector_${canonicalResourceId.slice("vr1_".length, "vr1_".length + 16)}`;
    const pending = (row: "NEW" | "OLD") => `
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM _chardb_vectors
        WHERE vector_id = ${row}.${column}
          AND organization_id = ${row}.${organizationColumn}
          AND resource_id = ${resourceId}
          AND row_pk = CAST(${row}.${primaryKey} AS TEXT)
          AND state = 'pending'
      ) THEN RAISE(ABORT, 'CDB_VECTOR_MUTATION_REQUIRED') END`;
    const deleting = (row: "NEW" | "OLD") => `
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM _chardb_vectors
        WHERE vector_id = ${row}.${column}
          AND organization_id = ${row}.${organizationColumn}
          AND resource_id = ${resourceId}
          AND row_pk = CAST(${row}.${primaryKey} AS TEXT)
          AND state = 'deleting'
      ) THEN RAISE(ABORT, 'CDB_VECTOR_MUTATION_REQUIRED') END`;
    const deletingOrDeletedOrganization = (row: "OLD") => `
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM _chardb_vectors
        WHERE vector_id = ${row}.${column}
          AND organization_id = ${row}.${organizationColumn}
          AND resource_id = ${resourceId}
          AND row_pk = CAST(${row}.${primaryKey} AS TEXT)
          AND state = 'deleting'
      ) AND NOT EXISTS (
        SELECT 1 FROM _chardb_deleted_organizations
        WHERE organization_id = ${row}.${organizationColumn}
      ) THEN RAISE(ABORT, 'CDB_VECTOR_MUTATION_REQUIRED') END`;

    const names = Object.freeze([`${prefix}_bi`, `${prefix}_bun`, `${prefix}_buo`, `${prefix}_bui`, `${prefix}_bd`]);
    const install = Object.freeze([
        `CREATE TRIGGER IF NOT EXISTS ${identifier(names[0] as string)}
         BEFORE INSERT ON ${table}
         WHEN NEW.${column} IS NOT NULL
         BEGIN${pending("NEW")};
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(names[1] as string)}
         BEFORE UPDATE OF ${column} ON ${table}
         WHEN NEW.${column} IS NOT OLD.${column} AND NEW.${column} IS NOT NULL
         BEGIN${pending("NEW")};
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(names[2] as string)}
         BEFORE UPDATE OF ${column} ON ${table}
         WHEN NEW.${column} IS NOT OLD.${column} AND OLD.${column} IS NOT NULL
         BEGIN${deleting("OLD")};
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(names[3] as string)}
         BEFORE UPDATE OF ${primaryKey}, ${organizationColumn} ON ${table}
         WHEN (NEW.${primaryKey} IS NOT OLD.${primaryKey}
               OR NEW.${organizationColumn} IS NOT OLD.${organizationColumn})
              AND (OLD.${column} IS NOT NULL OR NEW.${column} IS NOT NULL)
         BEGIN
           SELECT RAISE(ABORT, 'CDB_VECTOR_IDENTITY_MOVE_UNSUPPORTED');
         END`,
        `CREATE TRIGGER IF NOT EXISTS ${identifier(names[4] as string)}
         BEFORE DELETE ON ${table}
         WHEN OLD.${column} IS NOT NULL
         BEGIN${deletingOrDeletedOrganization("OLD")};
         END`,
    ]);
    return Object.freeze({
        names,
        install,
        uninstall: Object.freeze(names.map(name => `DROP TRIGGER IF EXISTS ${identifier(name)}`)),
    });
}

export function renderVectorMutationTriggers(resource: VectorResourceV1): readonly string[] {
    return renderVectorMutationTriggerSet(resource).install;
}
