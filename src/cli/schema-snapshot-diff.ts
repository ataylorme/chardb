import {
    type SqliteColumnDdlDescriptor,
    type SqliteIndexDdlDescriptor,
    type SqliteTableDdlDescriptor,
    renderSqliteTableDdlDescriptor,
} from "../auth/ddl.ts";
import { renderFileAttachmentTriggers } from "../server/file-triggers.ts";
import {
    type ChardbResourceDescriptor,
    isChardbFileResourceDescriptor,
    isChardbVectorResourceDescriptor,
} from "../server/resource-descriptors.ts";
import type { ChardbMigrationInput } from "../server/schema-migrations.ts";
import {
    type ChardbSchemaSnapshot,
    type ChardbSchemaSnapshotInput,
    defineSchemaSnapshot,
} from "../server/schema-snapshot.ts";
import { renderVectorMutationTriggers } from "../server/vector-triggers.ts";
import { stableJson } from "../util/canonical.ts";

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function reject(message: string): never {
    throw new Error(`additive schema diff: ${message}`);
}

function resourceKey(resource: ChardbResourceDescriptor): string {
    return `${resource.kind}\0${resource.table}\0${resource.column}`;
}

function assertSafeAddedColumn(table: string, column: SqliteColumnDdlDescriptor): void {
    // SQLite can add a nullable, unconstrained column without scanning or
    // rebuilding existing rows. More ambitious forms need an explicit data plan.
    if (/\b(?:PRIMARY\s+KEY|UNIQUE|REFERENCES|GENERATED|NOT\s+NULL|DEFAULT|CHECK)\b/i.test(column.sql)) {
        reject(`${table}.${column.name} is not a nullable unconstrained column`);
    }
}

function diffPlane(
    previousTables: readonly SqliteTableDdlDescriptor[],
    nextTables: readonly SqliteTableDdlDescriptor[],
    plane: "Cdb" | "Catalog"
): {
    readonly statements: readonly string[];
    readonly addedColumns: ReadonlySet<string>;
    readonly addedTables: ReadonlySet<string>;
} {
    const previousByName = new Map(previousTables.map(table => [table.tableName, table]));
    const nextByName = new Map(nextTables.map(table => [table.tableName, table]));
    for (const table of previousTables) {
        if (!nextByName.has(table.tableName)) reject(`${plane} table ${table.tableName} was removed`);
    }

    const statements: string[] = [];
    const addedColumns = new Set<string>();
    const addedTables = new Set<string>();
    for (const next of nextTables) {
        const previous = previousByName.get(next.tableName);
        if (!previous) {
            const ddl = renderSqliteTableDdlDescriptor(next);
            statements.push(ddl.createTable, ...ddl.indexes);
            addedTables.add(next.tableName);
            for (const column of next.columns) addedColumns.add(`${next.tableName}\0${column.name}`);
            continue;
        }
        if (stableJson(next.constraints) !== stableJson(previous.constraints)) {
            reject(`${plane} table ${next.tableName} changed table constraints`);
        }
        if (next.columns.length < previous.columns.length) {
            reject(`${plane} table ${next.tableName} removed a column`);
        }
        for (let index = 0; index < previous.columns.length; index++) {
            if (stableJson(next.columns[index]) !== stableJson(previous.columns[index])) {
                reject(`${plane} table ${next.tableName} changed or reordered existing columns`);
            }
        }
        for (const column of next.columns.slice(previous.columns.length)) {
            assertSafeAddedColumn(next.tableName, column);
            statements.push(`ALTER TABLE ${quoteIdentifier(next.tableName)} ADD COLUMN ${column.sql}`);
            addedColumns.add(`${next.tableName}\0${column.name}`);
        }

        const nextIndexes = new Map(next.indexes.map(index => [index.name, index]));
        for (const index of previous.indexes) {
            const current = nextIndexes.get(index.name);
            if (!current) reject(`${plane} table ${next.tableName} removed index ${index.name}`);
            if (stableJson(current) !== stableJson(index)) {
                reject(`${plane} table ${next.tableName} changed index ${index.name}`);
            }
        }
        const previousIndexNames = new Set(previous.indexes.map(index => index.name));
        for (const index of next.indexes.filter(index => !previousIndexNames.has(index.name))) {
            assertSafeAddedIndex(next.tableName, index);
            statements.push(index.sql);
        }
    }
    return Object.freeze({ statements: Object.freeze(statements), addedColumns, addedTables });
}

function assertSafeAddedIndex(table: string, index: SqliteIndexDdlDescriptor): void {
    if (index.unique) reject(`${table}.${index.name} is a new unique index and requires a duplicate-data plan`);
}

/** Derive the small subset of SQLite changes that is safe without a data rewrite. */
export function diffAdditiveSchemaSnapshots(
    previousInput: ChardbSchemaSnapshotInput,
    nextInput: ChardbSchemaSnapshotInput
): ChardbMigrationInput {
    const previous: ChardbSchemaSnapshot = defineSchemaSnapshot(previousInput);
    const next: ChardbSchemaSnapshot = defineSchemaSnapshot(nextInput);
    if (next.version !== previous.version + 1) reject("snapshot versions must be contiguous");
    if (next.previousDigest !== previous.digest) reject("next snapshot does not name the previous digest");

    const cdb = diffPlane(previous.cdbTables, next.cdbTables, "Cdb");
    const catalog = diffPlane(previous.catalogTables, next.catalogTables, "Catalog");
    const previousResources = new Map(previous.resources.map(resource => [resourceKey(resource), resource]));
    const nextResources = new Map(next.resources.map(resource => [resourceKey(resource), resource]));
    for (const resource of previous.resources) {
        const current = nextResources.get(resourceKey(resource));
        if (!current) reject(`resource ${resource.table}.${resource.column} was removed`);
        if (stableJson(current) !== stableJson(resource)) {
            reject(`resource ${resource.table}.${resource.column} changed`);
        }
    }
    const addedResources = next.resources.filter(resource => !previousResources.has(resourceKey(resource)));
    for (const resource of addedResources) {
        if (!cdb.addedTables.has(resource.table) && !cdb.addedColumns.has(`${resource.table}\0${resource.column}`)) {
            reject(`resource ${resource.table}.${resource.column} was added to an existing column`);
        }
    }
    const statements = [
        ...cdb.statements,
        ...addedResources.filter(isChardbFileResourceDescriptor).flatMap(renderFileAttachmentTriggers),
        ...addedResources.filter(isChardbVectorResourceDescriptor).flatMap(renderVectorMutationTriggers),
    ];
    if (statements.length + catalog.statements.length === 0) reject("snapshots contain no additive schema change");
    return Object.freeze({
        version: next.version,
        name: next.name,
        statements: Object.freeze(statements),
        catalogStatements: catalog.statements,
        ...(addedResources.length > 0 ? { resources: Object.freeze(addedResources) } : {}),
    });
}
