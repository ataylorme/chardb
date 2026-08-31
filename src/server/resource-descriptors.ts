import { type Column, getTableColumns } from "drizzle-orm";
import { type SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import { getChardbFileColumnConfig, isChardbFileColumn, normalizeFileColumnConfig } from "../files/index.ts";
import { stableHashHex, stableJson } from "../util/canonical.ts";
import { CDB_VECTOR_MAX_DIMENSIONS, getChardbVectorColumnConfig, isChardbVectorColumn } from "../vector.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import { resolveCdbMeta } from "./cdb-table.ts";

export interface ChardbFileResourceDescriptor {
    readonly kind: "file";
    readonly version: 1;
    readonly table: string;
    readonly column: string;
    readonly primaryKey: string;
    readonly organizationColumn: string;
    readonly maxSize: number;
    readonly contentTypes: readonly string[] | "*";
}

export interface VectorResourceV1 {
    readonly kind: "vector";
    readonly version: 1;
    readonly table: string;
    readonly column: string;
    readonly primaryKey: string;
    readonly organizationColumn: string;
    readonly binding: string;
    readonly dimensions: number;
    readonly metric: "cosine" | "euclidean" | "dot-product";
}

export interface CdbVectorResourceIdentity {
    /** Versioned, URL-path-safe identity used in physical Vectorize document ids. */
    readonly resourceId: `vr1_${string}`;
    /** Digest of the exact normalized migration descriptor. */
    readonly resourceDigest: string;
}

export type ChardbResourceDescriptor = ChardbFileResourceDescriptor | VectorResourceV1;

export function isChardbFileResourceDescriptor(
    resource: ChardbResourceDescriptor
): resource is ChardbFileResourceDescriptor {
    return resource.kind === "file";
}

export function isChardbVectorResourceDescriptor(resource: ChardbResourceDescriptor): resource is VectorResourceV1 {
    return resource.kind === "vector";
}

/** Derive vector delivery identity from the complete normalized migration descriptor. */
export function cdbVectorResourceIdentity(resource: VectorResourceV1): CdbVectorResourceIdentity {
    const normalized = normalizeChardbResourceDescriptor(resource);
    if (!isChardbVectorResourceDescriptor(normalized)) invalid("vector identity requires a vector descriptor");
    const resourceDigest = stableHashHex(["chardb.vector-resource.v1", normalized]);
    return Object.freeze({ resourceId: `vr1_${resourceDigest}`, resourceDigest });
}

export function cdbVectorResourceId(resource: VectorResourceV1): `vr1_${string}` {
    return cdbVectorResourceIdentity(resource).resourceId;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `resource descriptor: ${message}` });
}

function exactDataObject(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("must be an object");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(descriptor => !("value" in descriptor))) {
        invalid("fields must be data properties");
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function boundedName(value: unknown, field: string): string {
    const hasControl =
        typeof value === "string" &&
        Array.from(value).some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
    if (typeof value !== "string" || value.length === 0 || value.length > 256 || hasControl) {
        invalid(`${field} is invalid`);
    }
    return value;
}

export function normalizeChardbResourceDescriptor(value: unknown): ChardbResourceDescriptor {
    const input = exactDataObject(value);
    if (input.kind === "vector") {
        const expected = [
            "binding",
            "column",
            "dimensions",
            "kind",
            "metric",
            "organizationColumn",
            "primaryKey",
            "table",
            "version",
        ];
        const actual = Object.keys(input).sort();
        if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
            invalid("vector descriptors contain unexpected fields");
        }
        if (input.version !== 1) invalid("vector kind or version is unsupported");
        const dimensions = input.dimensions;
        if (
            typeof dimensions !== "number" ||
            !Number.isSafeInteger(dimensions) ||
            dimensions < 1 ||
            dimensions > CDB_VECTOR_MAX_DIMENSIONS
        ) {
            invalid(`vector dimensions must be an integer from 1 through ${CDB_VECTOR_MAX_DIMENSIONS}`);
        }
        if (input.metric !== "cosine" && input.metric !== "euclidean" && input.metric !== "dot-product") {
            invalid("vector metric is unsupported");
        }
        const binding = boundedName(input.binding, "binding");
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding)) invalid("binding is invalid");
        return Object.freeze({
            kind: "vector",
            version: 1,
            table: boundedName(input.table, "table"),
            column: boundedName(input.column, "column"),
            primaryKey: boundedName(input.primaryKey, "primaryKey"),
            organizationColumn: boundedName(input.organizationColumn, "organizationColumn"),
            binding,
            dimensions,
            metric: input.metric,
        });
    }
    const expected = [
        "column",
        "contentTypes",
        "kind",
        "maxSize",
        "organizationColumn",
        "primaryKey",
        "table",
        "version",
    ];
    const actual = Object.keys(input).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        invalid("file descriptors contain unexpected fields");
    }
    if (input.kind !== "file" || input.version !== 1) invalid("resource kind or version is unsupported");
    const normalized = normalizeFileColumnConfig({
        maxSize: input.maxSize as number,
        contentTypes: input.contentTypes as readonly string[] | "*",
    });
    return Object.freeze({
        kind: "file",
        version: 1,
        table: boundedName(input.table, "table"),
        column: boundedName(input.column, "column"),
        primaryKey: boundedName(input.primaryKey, "primaryKey"),
        organizationColumn: boundedName(input.organizationColumn, "organizationColumn"),
        maxSize: normalized.maxSize,
        contentTypes: normalized.contentTypes,
    });
}

export function normalizeChardbResourceDescriptors(input: readonly unknown[]): readonly ChardbResourceDescriptor[] {
    const normalized = input.map(normalizeChardbResourceDescriptor).sort((left, right) => {
        const leftKey = `${left.kind}\0${left.table}\0${left.column}`;
        const rightKey = `${right.kind}\0${right.table}\0${right.column}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    for (let index = 1; index < normalized.length; index++) {
        const left = normalized[index - 1] as ChardbResourceDescriptor;
        const right = normalized[index] as ChardbResourceDescriptor;
        if (left.kind === right.kind && left.table === right.table && left.column === right.column) {
            invalid(`duplicate ${right.kind} locator ${right.table}.${right.column}`);
        }
    }
    return Object.freeze(normalized);
}

/** Resolve the normalized native-resource identity active after a migration prefix. */
export function chardbResourceDescriptorsAt(
    migrations: readonly { readonly resources: readonly ChardbResourceDescriptor[] }[],
    version: number = migrations.length
): readonly ChardbResourceDescriptor[] {
    if (!Number.isSafeInteger(version) || version < 0 || version > migrations.length) {
        invalid("migration resource version is invalid");
    }
    const current = new Map<string, ChardbResourceDescriptor>();
    for (const migration of migrations.slice(0, version)) {
        for (const raw of migration.resources) {
            const resource = normalizeChardbResourceDescriptor(raw);
            current.set(`${resource.kind}\0${resource.table}\0${resource.column}`, resource);
        }
    }
    return normalizeChardbResourceDescriptors([...current.values()]);
}

function organizationLocator(
    table: Parameters<typeof getTableConfig>[0],
    tableName: string,
    kind: "file" | "vector"
): { readonly primaryKey: string; readonly organizationColumn: string } {
    const tableConfig = getTableConfig(table);
    const primaryColumns = new Set<string>();
    for (const column of tableConfig.columns) if (column.primary) primaryColumns.add(column.name);
    for (const primaryKey of tableConfig.primaryKeys) {
        for (const column of primaryKey.columns) primaryColumns.add(column.name);
    }
    if (primaryColumns.size !== 1) invalid(`${tableName} requires one scalar primary key for ${kind}s in V1`);
    const primaryKey = [...primaryColumns][0];
    const primaryColumn = tableConfig.columns.find(column => column.name === primaryKey);
    if (
        !primaryColumn ||
        (primaryColumn.dataType !== "string" &&
            primaryColumn.dataType !== "number" &&
            primaryColumn.dataType !== "boolean")
    ) {
        invalid(`${tableName} ${kind} row primary key must be a string, number, or boolean in V1`);
    }
    const organizationColumn = resolveCdbMeta(table).tenantBy;
    if (!primaryKey || !organizationColumn) invalid(`${tableName} ${kind} locator is missing ownership metadata`);
    return { primaryKey, organizationColumn };
}

/** Resolve one exact organization vector column without trusting a string locator. */
export function resolveOrganizationVectorResourceDescriptor(column: Column): VectorResourceV1 {
    if (!column || typeof column !== "object") invalid("vector column is invalid");
    const table = column.table as SQLiteTable;
    const tableColumns = Object.values(getTableColumns(table));
    if (!tableColumns.some(candidate => candidate === column)) {
        invalid("vector column does not belong to its declared table");
    }
    const meta = resolveCdbMeta(table);
    if (meta.tenantKind !== "org") invalid(`${meta.name} vector columns require organization tenancy`);
    if (!isChardbVectorColumn(column)) invalid(`${meta.name}.${column.name} is not a vector column`);
    if (column.notNull) invalid(`${meta.name}.${column.name} vector column must be nullable in V1`);
    const config = getChardbVectorColumnConfig(column);
    if (!config) invalid(`${meta.name}.${column.name} has invalid vector metadata`);
    return normalizeChardbResourceDescriptor({
        kind: "vector",
        version: 1,
        table: meta.name,
        column: column.name,
        ...organizationLocator(table, meta.name, "vector"),
        binding: config.binding,
        dimensions: config.dimensions,
        metric: config.metric,
    }) as VectorResourceV1;
}

/** Discover the private V1 resource contract from the configured domain schema. */
export function collectSchemaResourceDescriptors(
    schema: Readonly<Record<string, unknown>>
): readonly ChardbResourceDescriptor[] {
    const resources: ChardbResourceDescriptor[] = [];
    for (const { table, meta } of collectCdbTables(schema as Record<string, unknown>)) {
        const columns = Object.values(getTableColumns(table));
        const fileColumns = columns.filter(isChardbFileColumn);
        const vectorColumns = columns.filter(isChardbVectorColumn);
        if (fileColumns.length === 0 && vectorColumns.length === 0) continue;

        if (fileColumns.length > 0) {
            if (meta.tenantKind !== "org") invalid(`${meta.name} file columns require organization tenancy`);
            if (fileColumns.length > 1) invalid(`${meta.name} may contain only one file column in V1`);
            const fileColumn = fileColumns[0];
            if (!fileColumn || fileColumn.notNull) invalid(`${meta.name} file column must be nullable in V1`);
            const locator = organizationLocator(table, meta.name, "file");
            const config = getChardbFileColumnConfig(fileColumn);
            if (!config) invalid(`${meta.name}.${fileColumn.name} has invalid file metadata`);
            resources.push({
                kind: "file",
                version: 1,
                table: meta.name,
                column: fileColumn.name,
                ...locator,
                maxSize: config.maxSize,
                contentTypes: config.contentTypes,
            });
        }

        if (vectorColumns.length > 0) {
            for (const vectorColumn of vectorColumns) {
                resources.push(resolveOrganizationVectorResourceDescriptor(vectorColumn));
            }
        }
    }
    return normalizeChardbResourceDescriptors(resources);
}

/** Existing file runtime consumers must never treat another native resource as a file. */
export function collectSchemaFileResourceDescriptors(
    schema: Readonly<Record<string, unknown>>
): readonly ChardbFileResourceDescriptor[] {
    return Object.freeze(collectSchemaResourceDescriptors(schema).filter(isChardbFileResourceDescriptor));
}

/** Refuse to boot when packaged migrations and the configured schema name different native resources. */
export function assertSchemaResourceJournal(
    schema: Readonly<Record<string, unknown>>,
    migrations: readonly { readonly resources: readonly ChardbResourceDescriptor[] }[]
): void {
    const expected = collectSchemaResourceDescriptors(schema);
    const packaged = chardbResourceDescriptorsAt(migrations);
    if (stableJson(expected) === stableJson(packaged)) return;
    throw new CdbError({
        code: "CDB_PARTITION_CONTRACT_CHANGED",
        message: "configured native resources do not match the packaged migration journal",
        hint: "regenerate the schema migration so its normalized resource descriptors match the current schema",
    });
}
