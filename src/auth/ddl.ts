import { SQL, getTableName, is } from "drizzle-orm";
import { type AnySQLiteTable, SQLiteSyncDialect, getTableConfig } from "drizzle-orm/sqlite-core";
import { CdbError, type CdbErrorCode } from "../errors.ts";

export interface SqliteTableDdl {
    readonly tableName: string;
    readonly createTable: string;
    readonly indexes: readonly string[];
    readonly indexNames: readonly string[];
    readonly signature: string;
}

export interface SqliteTableDdlOptions {
    readonly errorCode?: CdbErrorCode;
    readonly label?: string;
    readonly hint?: string;
    readonly includeForeignKey?: (reference: SqliteForeignKeyReference) => boolean;
}

export interface SqliteForeignKeyReference {
    readonly columns: readonly string[];
    readonly foreignColumns: readonly string[];
    readonly foreignTableName: string;
}

const dialect = new SQLiteSyncDialect();

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function quoteString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

const AUTH_DDL_OPTIONS: Required<SqliteTableDdlOptions> = {
    errorCode: "CDB_AUTH_PROFILE_INCOMPATIBLE",
    label: "auth DDL",
    hint: "use SQLite-compatible static auth schema metadata",
    includeForeignKey: () => true,
};

function normalizedOptions(options?: SqliteTableDdlOptions): Required<SqliteTableDdlOptions> {
    return { ...AUTH_DDL_OPTIONS, ...options };
}

function unsupported(options: Required<SqliteTableDdlOptions>, message: string): never {
    throw new CdbError({
        code: options.errorCode,
        message: `${options.label} ${message}`,
        hint: options.hint,
    });
}

function renderSqlExpression(expression: SQL, options: Required<SqliteTableDdlOptions>): string {
    const query = dialect.sqlToQuery(expression, "indexes");
    if (query.params.length > 0) {
        return unsupported(options, "cannot render a parameterized SQL expression");
    }
    return query.sql;
}

function renderDefault(value: unknown, options: Required<SqliteTableDdlOptions>): string {
    if (is(value, SQL)) return renderSqlExpression(value, options);
    if (value === null) return "NULL";
    if (typeof value === "string") return quoteString(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return unsupported(options, "cannot render a non-finite numeric default");
        return String(value);
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "boolean") return value ? "1" : "0";
    if (value instanceof Date) return String(value.getTime());
    if (value instanceof Uint8Array) {
        return `X'${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}'`;
    }
    if (typeof value === "object") return quoteString(JSON.stringify(value));
    return unsupported(options, `cannot render default value of type ${typeof value}`);
}

function renderAction(action: string): string {
    return action.toUpperCase();
}

function renderIndexColumn(value: unknown, options: Required<SqliteTableDdlOptions>): string {
    if (is(value, SQL)) return renderSqlExpression(value, options);
    if (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string") {
        return quoteIdentifier(value.name);
    }
    return unsupported(options, "encountered an unsupported SQLite index expression");
}

/** Render deterministic, executable SQLite DDL from a Drizzle table. */
export function renderSqliteTableDdl(table: AnySQLiteTable, inputOptions?: SqliteTableDdlOptions): SqliteTableDdl {
    const options = normalizedOptions(inputOptions);
    const config = getTableConfig(table);
    const definitions: string[] = [];

    for (const column of config.columns) {
        if (column.generated) {
            return unsupported(options, `does not support generated column ${config.name}.${column.name}`);
        }
        const parts = [quoteIdentifier(column.name), column.getSQLType()];
        if (column.primary) parts.push("PRIMARY KEY");
        if ((column as { readonly autoIncrement?: boolean }).autoIncrement) parts.push("AUTOINCREMENT");
        if (column.notNull) parts.push("NOT NULL");
        if (column.isUnique) {
            if (column.uniqueName) parts.push("CONSTRAINT", quoteIdentifier(column.uniqueName));
            parts.push("UNIQUE");
        }
        if (column.default !== undefined) parts.push("DEFAULT", renderDefault(column.default, options));
        definitions.push(parts.join(" "));
    }

    for (const primaryKey of config.primaryKeys) {
        definitions.push(
            `CONSTRAINT ${quoteIdentifier(primaryKey.getName())} PRIMARY KEY (${primaryKey.columns
                .map(column => quoteIdentifier(column.name))
                .join(", ")})`
        );
    }
    for (const constraint of config.uniqueConstraints) {
        const name = constraint.getName();
        const prefix = name ? `CONSTRAINT ${quoteIdentifier(name)} ` : "";
        definitions.push(
            `${prefix}UNIQUE (${constraint.columns.map(column => quoteIdentifier(column.name)).join(", ")})`
        );
    }
    for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        const foreignTableName = getTableName(reference.foreignTable);
        const physicalReference: SqliteForeignKeyReference = {
            columns: reference.columns.map(column => column.name),
            foreignColumns: reference.foreignColumns.map(column => column.name),
            foreignTableName,
        };
        if (!options.includeForeignKey(physicalReference)) continue;
        const clauses = [
            `CONSTRAINT ${quoteIdentifier(foreignKey.getName())}`,
            `FOREIGN KEY (${reference.columns.map(column => quoteIdentifier(column.name)).join(", ")})`,
            `REFERENCES ${quoteIdentifier(foreignTableName)} (${reference.foreignColumns
                .map(column => quoteIdentifier(column.name))
                .join(", ")})`,
        ];
        if (foreignKey.onUpdate) clauses.push(`ON UPDATE ${renderAction(foreignKey.onUpdate)}`);
        if (foreignKey.onDelete) clauses.push(`ON DELETE ${renderAction(foreignKey.onDelete)}`);
        definitions.push(clauses.join(" "));
    }
    for (const check of config.checks) {
        definitions.push(
            `CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${renderSqlExpression(check.value, options)})`
        );
    }

    const createTable = `CREATE TABLE ${quoteIdentifier(config.name)} (${definitions.join(", ")})`;
    const indexNames = config.indexes.map(index => index.config.name);
    const indexes = config.indexes.map(index => {
        const unique = index.config.unique ? "UNIQUE " : "";
        const columns = index.config.columns.map(column => renderIndexColumn(column, options)).join(", ");
        const where = index.config.where ? ` WHERE ${renderSqlExpression(index.config.where, options)}` : "";
        return `CREATE ${unique}INDEX ${quoteIdentifier(index.config.name)} ON ${quoteIdentifier(config.name)} (${columns})${where}`;
    });
    return {
        tableName: config.name,
        createTable,
        indexes,
        indexNames,
        signature: JSON.stringify([createTable, ...indexes]),
    };
}
