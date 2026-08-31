import type { BetterAuthOptions } from "better-auth";
import {
    type SqliteColumnDdlDescriptor,
    type SqliteIndexDdlDescriptor,
    type SqliteTableConstraintDdlDescriptor,
    type SqliteTableDdlDescriptor,
    canonicalizeSqliteTableDdlDescriptor,
    describeSqliteTableDdl,
    renderSqliteTableDdlDescriptor,
} from "../auth/ddl.ts";
import { synthesizeAuthSchema, synthesizedAuthTableNames } from "../auth/synthesize.ts";
import { CdbError } from "../errors.ts";
import { stableHashHex, stableJson } from "../util/canonical.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import { resolveCdbMeta } from "./cdb-table.ts";
import { renderFileAttachmentTriggers } from "./file-triggers.ts";
import {
    type ChardbResourceDescriptor,
    collectSchemaResourceDescriptors,
    isChardbFileResourceDescriptor,
    isChardbVectorResourceDescriptor,
    normalizeChardbResourceDescriptors,
} from "./resource-descriptors.ts";
import type { ChardbMigrationInput } from "./schema-migrations.ts";
import { renderVectorMutationTriggers } from "./vector-triggers.ts";

const SNAPSHOT_FORMAT = "chardb.schema-snapshot.v1" as const;
const MIGRATION_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_VERSION = 1_024;
const MAX_TABLES_PER_PLANE = 1_024;
const MAX_TABLE_ITEMS = 4_096;
const MAX_SQL_BYTES = 1 * 1_024 * 1_024;
const MAX_SNAPSHOT_BYTES = 16 * 1_024 * 1_024;

export interface ChardbSchemaSnapshotContent {
    readonly format: typeof SNAPSHOT_FORMAT;
    readonly version: number;
    readonly name: string;
    readonly previousDigest: string | null;
    readonly cdbTables: readonly SqliteTableDdlDescriptor[];
    readonly catalogTables: readonly SqliteTableDdlDescriptor[];
    readonly resources: readonly ChardbResourceDescriptor[];
}

export interface ChardbSchemaSnapshotInput extends ChardbSchemaSnapshotContent {
    readonly digest: string;
}

export interface ChardbSchemaSnapshot extends ChardbSchemaSnapshotInput {
    /** Complete-install migration for an initial snapshot. Later snapshots require a separately reviewed diff. */
    readonly initialMigration: ChardbMigrationInput | null;
}

export interface InspectInitialSchemaSnapshotInput {
    readonly name: string;
    readonly domainSchema: Readonly<Record<string, unknown>>;
    readonly authOptions: BetterAuthOptions;
}

export interface InspectSchemaSnapshotInput extends InspectInitialSchemaSnapshotInput {
    readonly version: number;
    readonly previousDigest: string | null;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `schema snapshot: ${message}` });
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function ownRecord(
    value: unknown,
    expectedKeys: readonly string[],
    subject: string
): Readonly<Record<string, PropertyDescriptor>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${subject} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${subject} must be plain data`);
    if (Reflect.ownKeys(value).some(key => typeof key === "symbol"))
        invalid(`${subject} must not contain symbol fields`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Object.keys(descriptors).sort();
    const sortedExpected = [...expectedKeys].sort();
    if (actualKeys.length !== sortedExpected.length || actualKeys.some((key, index) => key !== sortedExpected[index])) {
        invalid(`${subject} must contain only ${sortedExpected.join(", ")}`);
    }
    for (const key of actualKeys) {
        if (!("value" in (descriptors[key] as PropertyDescriptor)))
            invalid(`${subject} fields must be data properties`);
    }
    return descriptors;
}

function ownArray(value: unknown, subject: string): readonly unknown[] {
    if (!Array.isArray(value)) invalid(`${subject} must be an array`);
    if (Reflect.ownKeys(value).some(key => typeof key === "symbol"))
        invalid(`${subject} must not contain symbol fields`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
        invalid(`${subject} must not contain extra properties`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) invalid(`${subject} must be dense data`);
        result.push(descriptor.value);
    }
    return result;
}

function boundedName(value: unknown, subject: string): string {
    const containsControl =
        typeof value === "string" &&
        Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 31 || code === 127;
        });
    if (typeof value !== "string" || value.length === 0 || value.length > 128 || containsControl) {
        invalid(`${subject} must be a nonempty SQLite name of at most 128 characters`);
    }
    return value;
}

function boundedSql(value: unknown, subject: string): string {
    if (typeof value !== "string" || value.trim().length === 0) invalid(`${subject} must be nonempty SQL`);
    if (utf8Bytes(value) > MAX_SQL_BYTES) invalid(`${subject} exceeds ${MAX_SQL_BYTES} UTF-8 bytes`);
    return value;
}

function ownColumn(value: unknown, subject: string): SqliteColumnDdlDescriptor {
    const fields = ownRecord(value, ["name", "sql"], subject);
    return Object.freeze({
        name: boundedName(fields.name?.value, `${subject} name`),
        sql: boundedSql(fields.sql?.value, `${subject} SQL`),
    });
}

const CONSTRAINT_ORDER: Readonly<Record<SqliteTableConstraintDdlDescriptor["kind"], number>> = {
    "primary-key": 0,
    unique: 1,
    "foreign-key": 2,
    check: 3,
};

function ownConstraint(value: unknown, subject: string): SqliteTableConstraintDdlDescriptor {
    const fields = ownRecord(value, ["kind", "name", "sql"], subject);
    const kind = fields.kind?.value;
    if (typeof kind !== "string" || !Object.hasOwn(CONSTRAINT_ORDER, kind)) invalid(`${subject} kind is unsupported`);
    const name = fields.name?.value;
    if (name !== null) boundedName(name, `${subject} name`);
    return Object.freeze({
        kind: kind as SqliteTableConstraintDdlDescriptor["kind"],
        name: name as string | null,
        sql: boundedSql(fields.sql?.value, `${subject} SQL`),
    });
}

function ownIndex(value: unknown, subject: string): SqliteIndexDdlDescriptor {
    const fields = ownRecord(value, ["name", "sql", "unique"], subject);
    if (typeof fields.unique?.value !== "boolean") invalid(`${subject} unique must be boolean`);
    return Object.freeze({
        name: boundedName(fields.name?.value, `${subject} name`),
        unique: fields.unique.value,
        sql: boundedSql(fields.sql?.value, `${subject} SQL`),
    });
}

function requireStrictOrder<T>(values: readonly T[], compare: (left: T, right: T) => number, subject: string): void {
    for (let index = 1; index < values.length; index++) {
        if (compare(values[index - 1] as T, values[index] as T) >= 0) {
            invalid(`${subject} must be unique and in canonical order`);
        }
    }
}

function requireUnique<T>(values: readonly T[], keyOf: (value: T) => string, subject: string): void {
    const keys = new Set<string>();
    for (const value of values) {
        const key = keyOf(value);
        if (keys.has(key)) invalid(`${subject} must be unique`);
        keys.add(key);
    }
}

function ownTable(value: unknown, subject: string): SqliteTableDdlDescriptor {
    const fields = ownRecord(value, ["columns", "constraints", "indexes", "tableName"], subject);
    const tableName = boundedName(fields.tableName?.value, `${subject} tableName`);
    const columns = ownArray(fields.columns?.value, `${subject} columns`).map((column, index) =>
        ownColumn(column, `${subject} column ${index + 1}`)
    );
    const constraints = ownArray(fields.constraints?.value, `${subject} constraints`).map((constraint, index) =>
        ownConstraint(constraint, `${subject} constraint ${index + 1}`)
    );
    const indexes = ownArray(fields.indexes?.value, `${subject} indexes`).map((index, position) =>
        ownIndex(index, `${subject} index ${position + 1}`)
    );
    if (columns.length === 0) invalid(`${subject} must contain at least one column`);
    if (columns.length + constraints.length + indexes.length > MAX_TABLE_ITEMS) {
        invalid(`${subject} contains more than ${MAX_TABLE_ITEMS} columns, constraints, and indexes`);
    }
    // Column and definition order is part of the exact CREATE TABLE program.
    // Preserve it while still refusing duplicate structural identities.
    requireUnique(columns, column => column.name, `${subject} columns`);
    requireUnique(
        constraints,
        constraint => `${constraint.kind}\0${constraint.name ?? ""}\0${constraint.sql}`,
        `${subject} constraints`
    );
    requireUnique(indexes, index => index.name, `${subject} indexes`);
    const canonical = canonicalizeSqliteTableDdlDescriptor({ tableName, columns, constraints, indexes });
    if (stableJson(indexes) !== stableJson(canonical.indexes)) {
        invalid(`${subject} indexes must be in canonical order`);
    }
    return Object.freeze({
        tableName,
        columns: Object.freeze(columns),
        constraints: Object.freeze(constraints),
        indexes: Object.freeze(indexes),
    });
}

function ownTables(value: unknown, subject: string): readonly SqliteTableDdlDescriptor[] {
    const values = ownArray(value, subject);
    if (values.length > MAX_TABLES_PER_PLANE) {
        invalid(`${subject} contains more than ${MAX_TABLES_PER_PLANE} tables`);
    }
    const tables = values.map((table, index) => ownTable(table, `${subject} table ${index + 1}`));
    requireStrictOrder(
        tables,
        (left, right) => (left.tableName < right.tableName ? -1 : left.tableName > right.tableName ? 1 : 0),
        subject
    );
    return Object.freeze(tables);
}

function validateContent(value: unknown): ChardbSchemaSnapshotContent {
    const fields = ownRecord(
        value,
        ["catalogTables", "cdbTables", "format", "name", "previousDigest", "resources", "version"],
        "content"
    );
    if (fields.format?.value !== SNAPSHOT_FORMAT) invalid(`format must be ${SNAPSHOT_FORMAT}`);
    const version = fields.version?.value;
    if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > MAX_VERSION) {
        invalid(`version must be an integer from 1 through ${MAX_VERSION}`);
    }
    const name = fields.name?.value;
    if (typeof name !== "string" || !MIGRATION_NAME.test(name)) invalid("name is invalid");
    const previousDigest = fields.previousDigest?.value;
    if (version === 1 ? previousDigest !== null : typeof previousDigest !== "string" || !DIGEST.test(previousDigest)) {
        invalid(version === 1 ? "version 1 previousDigest must be null" : "previousDigest must be a SHA-256 digest");
    }
    const cdbTables = ownTables(fields.cdbTables?.value, "Cdb tables");
    const catalogTables = ownTables(fields.catalogTables?.value, "Catalog tables");
    if (cdbTables.length + catalogTables.length === 0) invalid("must contain at least one Cdb or Catalog table");
    const rawResources = ownArray(fields.resources?.value, "resources");
    const resources = normalizeChardbResourceDescriptors(rawResources);
    if (stableJson(rawResources) !== stableJson(resources)) invalid("resources must be in canonical order");
    const cdbByName = new Map(cdbTables.map(table => [table.tableName, table]));
    for (const resource of resources) {
        const table = cdbByName.get(resource.table);
        if (!table) invalid(`resource ${resource.table}.${resource.column} references a missing Cdb table`);
        const columns = new Set(table.columns.map(column => column.name));
        for (const column of [resource.column, resource.primaryKey, resource.organizationColumn]) {
            if (!columns.has(column)) {
                invalid(`resource ${resource.table}.${resource.column} references missing column ${column}`);
            }
        }
    }
    const content = Object.freeze({
        format: SNAPSHOT_FORMAT,
        version: version as number,
        name,
        previousDigest: previousDigest as string | null,
        cdbTables,
        catalogTables,
        resources,
    });
    if (utf8Bytes(stableJson(content)) > MAX_SNAPSHOT_BYTES) {
        invalid(`exceeds ${MAX_SNAPSHOT_BYTES} canonical UTF-8 bytes`);
    }
    return content;
}

/** Internal authoring helper used by the generator before it emits an immutable digest. */
export function schemaSnapshotDigest(input: ChardbSchemaSnapshotContent): string {
    return stableHashHex(validateContent(input));
}

/** Internal CLI inspector. Convert current Drizzle and Better Auth definitions into canonical static data. */
export function inspectSchemaSnapshot(input: InspectSchemaSnapshotInput): ChardbSchemaSnapshotInput {
    const domain = [...collectCdbTables(input.domainSchema as Record<string, unknown>)];
    const domainNames = new Set(domain.map(entry => entry.meta.name));
    const authSchema = synthesizeAuthSchema(input.authOptions as never) as unknown as Record<string, unknown>;
    const authNames = synthesizedAuthTableNames(authSchema);
    const cdbTables = domain
        .map(({ table }) => {
            const meta = resolveCdbMeta(table);
            const authorityColumns = new Set([meta.tenantBy, meta.selfBy].filter(value => value !== undefined));
            return canonicalizeSqliteTableDdlDescriptor(
                describeSqliteTableDdl(table, {
                    errorCode: "CDB_PARTITION_CONTRACT_CHANGED",
                    label: "domain migration snapshot",
                    hint: "use SQLite-compatible cdbTable definitions",
                    includeForeignKey: reference => {
                        if (domainNames.has(reference.foreignTableName)) return true;
                        if (
                            authNames.has(reference.foreignTableName) ||
                            reference.columns.some(column => authorityColumns.has(column))
                        )
                            return false;
                        throw new CdbError({
                            code: "CDB_NONLOCAL_FK",
                            message: `domain migration snapshot references non-cdbTable "${reference.foreignTableName}"`,
                        });
                    },
                })
            );
        })
        .sort((left, right) => (left.tableName < right.tableName ? -1 : left.tableName > right.tableName ? 1 : 0));
    const catalogTables = Object.values(authSchema)
        .map(table => canonicalizeSqliteTableDdlDescriptor(describeSqliteTableDdl(table as never)))
        .sort((left, right) => (left.tableName < right.tableName ? -1 : left.tableName > right.tableName ? 1 : 0));
    const resources = collectSchemaResourceDescriptors(input.domainSchema);
    const content: ChardbSchemaSnapshotContent = {
        format: SNAPSHOT_FORMAT,
        version: input.version,
        name: input.name,
        previousDigest: input.previousDigest,
        cdbTables,
        catalogTables,
        resources,
    };
    return Object.freeze({ ...validateContent(content), digest: schemaSnapshotDigest(content) });
}

/** Inspect the first immutable schema snapshot. */
export function inspectInitialSchemaSnapshot(input: InspectInitialSchemaSnapshotInput): ChardbSchemaSnapshotInput {
    return inspectSchemaSnapshot({ ...input, version: 1, previousDigest: null });
}

/** Validate an initial immutable snapshot and derive its complete-install migration. */
export function defineSchemaSnapshot(
    input: ChardbSchemaSnapshotInput & { readonly version: 1; readonly previousDigest: null }
): ChardbSchemaSnapshot & { readonly initialMigration: ChardbMigrationInput };
/** Validate a later immutable snapshot. Delta SQL must come from the separate schema-diff layer. */
export function defineSchemaSnapshot(input: ChardbSchemaSnapshotInput): ChardbSchemaSnapshot;
export function defineSchemaSnapshot(input: ChardbSchemaSnapshotInput): ChardbSchemaSnapshot {
    const fields = ownRecord(
        input,
        ["catalogTables", "cdbTables", "digest", "format", "name", "previousDigest", "resources", "version"],
        "input"
    );
    const digest = fields.digest?.value;
    if (typeof digest !== "string" || !DIGEST.test(digest)) invalid("digest must be a SHA-256 digest");
    const content = validateContent({
        format: fields.format?.value,
        version: fields.version?.value,
        name: fields.name?.value,
        previousDigest: fields.previousDigest?.value,
        cdbTables: fields.cdbTables?.value,
        catalogTables: fields.catalogTables?.value,
        resources: fields.resources?.value,
    });
    const expectedDigest = stableHashHex(content);
    if (digest !== expectedDigest) invalid("digest does not match canonical snapshot content");

    const initialMigration: ChardbMigrationInput | null =
        content.version === 1
            ? (() => {
                  const statements = content.cdbTables.flatMap(table => {
                      const ddl = renderSqliteTableDdlDescriptor(table);
                      return [ddl.createTable, ...ddl.indexes];
                  });
                  statements.push(
                      ...content.resources.filter(isChardbFileResourceDescriptor).flatMap(renderFileAttachmentTriggers),
                      ...content.resources
                          .filter(isChardbVectorResourceDescriptor)
                          .flatMap(renderVectorMutationTriggers)
                  );
                  const catalogStatements = content.catalogTables.flatMap(table => {
                      const ddl = renderSqliteTableDdlDescriptor(table);
                      return [ddl.createTable, ...ddl.indexes];
                  });
                  return Object.freeze({
                      version: 1,
                      name: content.name,
                      statements: Object.freeze(statements),
                      catalogStatements: Object.freeze(catalogStatements),
                      ...(content.resources.length > 0 ? { resources: content.resources } : {}),
                  });
              })()
            : null;
    return Object.freeze({ ...content, digest, initialMigration });
}
