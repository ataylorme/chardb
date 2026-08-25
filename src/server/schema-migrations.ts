import type { BetterAuthOptions } from "better-auth";
import { renderSqliteTableDdl } from "../auth/ddl.ts";
import { synthesizeAuthSchema } from "../auth/synthesize.ts";
import { CdbError } from "../errors.ts";
import { stableHashHex } from "../util/canonical.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import { resolveCdbMeta } from "./cdb-table.ts";

const MIGRATION_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MAX_MIGRATIONS = 1_024;
const MAX_MIGRATION_STATEMENTS = 4_096;
const MAX_MIGRATION_STATEMENT_BYTES = 1 * 1_024 * 1_024;
const MAX_MIGRATION_JOURNAL_BYTES = 16 * 1_024 * 1_024;

export interface ChardbMigrationInput {
    readonly version: number;
    readonly name: string;
    /** SQL applied independently to every Cdb shard. */
    readonly statements: readonly string[];
    /** SQL applied once to Catalog-owned auth tables. */
    readonly catalogStatements?: readonly string[];
}

export interface ChardbMigration {
    readonly version: number;
    readonly name: string;
    readonly statements: readonly string[];
    readonly catalogStatements: readonly string[];
    readonly digest: string;
}

export interface ChardbMigrationJournal {
    readonly format: "chardb.migrations.v1";
    readonly version: number;
    readonly digest: string;
    readonly migrations: readonly ChardbMigration[];
}

export interface ChardbBaselineInput {
    readonly version: number;
    readonly name: string;
    readonly domainSchema: Readonly<Record<string, unknown>>;
    readonly authOptions: BetterAuthOptions;
}

function invalidJournal(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `migration journal: ${message}` });
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function ownArray<T>(value: readonly T[], subject: string): readonly T[] {
    if (!Array.isArray(value)) invalidJournal(`${subject} must be an array`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
        invalidJournal(`${subject} must not contain extra properties`);
    }
    const out: T[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) invalidJournal(`${subject} must be dense data`);
        out.push(descriptor.value as T);
    }
    return out;
}

/** Render a complete version-zero install step from the configured domain and auth schemas. */
export function defineSchemaBaseline(input: ChardbBaselineInput): ChardbMigrationInput {
    const domain = [...collectCdbTables(input.domainSchema as Record<string, unknown>)].sort((left, right) =>
        left.meta.name.localeCompare(right.meta.name)
    );
    const domainNames = new Set(domain.map(entry => entry.meta.name));
    const statements = domain.flatMap(({ table }) => {
        const meta = resolveCdbMeta(table);
        const authorityColumns = new Set([meta.tenantBy, meta.selfBy].filter(value => value !== undefined));
        const ddl = renderSqliteTableDdl(table, {
            errorCode: "CDB_PARTITION_CONTRACT_CHANGED",
            label: "domain migration baseline",
            hint: "use SQLite-compatible cdbTable definitions",
            includeForeignKey: reference => {
                if (domainNames.has(reference.foreignTableName)) return true;
                if (reference.columns.some(column => authorityColumns.has(column))) return false;
                throw new CdbError({
                    code: "CDB_NONLOCAL_FK",
                    message: `domain migration baseline references non-cdbTable "${reference.foreignTableName}"`,
                });
            },
        });
        return [ddl.createTable, ...ddl.indexes];
    });
    const authSchema = synthesizeAuthSchema(input.authOptions as never) as unknown as Record<string, unknown>;
    const catalogStatements = Object.values(authSchema).flatMap(table => {
        const ddl = renderSqliteTableDdl(table as never);
        return [ddl.createTable, ...ddl.indexes];
    });
    return {
        version: input.version,
        name: input.name,
        statements,
        catalogStatements,
    };
}

/** Build one immutable, content-addressed migration journal for packaging with a Worker. */
export function defineMigrations(input: readonly ChardbMigrationInput[]): ChardbMigrationJournal {
    const entries = ownArray(input, "migrations");
    if (entries.length > MAX_MIGRATIONS) {
        invalidJournal(`contains more than ${MAX_MIGRATIONS} migrations`);
    }
    let journalBytes = 0;
    let statementCount = 0;
    const migrations = entries.map((raw, index): ChardbMigration => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            invalidJournal(`migration ${index + 1} must be an object`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(raw);
        const keys = Object.keys(descriptors).sort();
        if (
            JSON.stringify(keys) !== JSON.stringify(["name", "statements", "version"]) &&
            JSON.stringify(keys) !== JSON.stringify(["catalogStatements", "name", "statements", "version"])
        ) {
            invalidJournal(`migration ${index + 1} must contain only name, statements, catalogStatements, and version`);
        }
        for (const key of keys) {
            if (!("value" in (descriptors[key] as PropertyDescriptor))) {
                invalidJournal(`migration ${index + 1} fields must be data properties`);
            }
        }
        const version = descriptors.version?.value as unknown;
        const name = descriptors.name?.value as unknown;
        const rawStatements = descriptors.statements?.value as unknown;
        const rawCatalogStatements = descriptors.catalogStatements?.value as unknown;
        if (version !== index + 1) invalidJournal(`versions must be contiguous from 1; expected ${index + 1}`);
        if (typeof name !== "string" || !MIGRATION_NAME.test(name)) {
            invalidJournal(`migration ${version} has an invalid name`);
        }
        const ownStatements = (rawValue: unknown, subject: string): readonly string[] =>
            ownArray(rawValue as readonly unknown[], subject).map((statement, statementIndex) => {
                statementCount++;
                if (statementCount > MAX_MIGRATION_STATEMENTS) {
                    invalidJournal(`contains more than ${MAX_MIGRATION_STATEMENTS} SQL statements`);
                }
                if (typeof statement !== "string" || statement.trim().length === 0) {
                    invalidJournal(`${subject} ${statementIndex + 1} must be nonempty SQL`);
                }
                const bytes = utf8Bytes(statement);
                if (bytes > MAX_MIGRATION_STATEMENT_BYTES) {
                    invalidJournal(
                        `${subject} ${statementIndex + 1} exceeds ${MAX_MIGRATION_STATEMENT_BYTES} UTF-8 bytes`
                    );
                }
                journalBytes += bytes;
                if (journalBytes > MAX_MIGRATION_JOURNAL_BYTES) {
                    invalidJournal(`SQL exceeds ${MAX_MIGRATION_JOURNAL_BYTES} total UTF-8 bytes`);
                }
                return statement;
            });
        const statements = ownStatements(rawStatements, `migration ${version} Cdb statement`);
        const catalogStatements =
            rawCatalogStatements === undefined
                ? []
                : ownStatements(rawCatalogStatements, `migration ${version} Catalog statement`);
        if (statements.length + catalogStatements.length === 0) {
            invalidJournal(`migration ${version} must contain Cdb or Catalog SQL`);
        }
        const ownedStatements = Object.freeze([...statements]);
        const ownedCatalogStatements = Object.freeze([...catalogStatements]);
        return Object.freeze({
            version,
            name,
            statements: ownedStatements,
            catalogStatements: ownedCatalogStatements,
            digest: stableHashHex([version, name, ownedStatements, ownedCatalogStatements]),
        });
    });
    const version = migrations.length;
    const ownedMigrations = Object.freeze([...migrations]);
    return Object.freeze({
        format: "chardb.migrations.v1",
        version,
        digest: stableHashHex(ownedMigrations.map(migration => [migration.version, migration.name, migration.digest])),
        migrations: ownedMigrations,
    });
}

/** Return the exact contiguous suffix needed to move one stored version to the packaged version. */
export function pendingMigrations(journal: ChardbMigrationJournal, activeVersion: number): readonly ChardbMigration[] {
    if (!Number.isSafeInteger(activeVersion) || activeVersion < 0 || activeVersion > journal.version) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: `stored schema version ${String(activeVersion)} is incompatible with packaged version ${journal.version}`,
        });
    }
    return journal.migrations.slice(activeVersion);
}

/** Content digest for the exact journal prefix active on a Catalog or Cdb. */
export function migrationDigestAt(journal: ChardbMigrationJournal, version: number): string {
    if (!Number.isSafeInteger(version) || version < 0 || version > journal.version) {
        throw new CdbError({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            message: `schema version ${String(version)} is incompatible with packaged version ${journal.version}`,
        });
    }
    return stableHashHex(
        journal.migrations.slice(0, version).map(migration => [migration.version, migration.name, migration.digest])
    );
}
