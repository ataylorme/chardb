import { Column, Param, SQL, StringChunk, getTableColumns, getTableName, is } from "drizzle-orm";
import { QueryBuilder, type SQLiteSelectConfig, SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { StaticIntentExtractor, intervalsForColumnPredicate } from "../drizzle/walker.ts";
import { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";
import { stableHashHex } from "../util/canonical.ts";
import type { CdbIntent } from "../wire.ts";
import { resolveCdbMeta } from "./cdb-table.ts";
import type { MutationAuthority } from "./define.ts";

export const CDB_PLANNED_QUERY_MAX_ROWS = 100;
export const CDB_PLANNED_QUERY_MAX_IN_VALUES = 100;
export const CDB_PLANNED_QUERY_MAX_PREDICATES = 128;
export const CDB_PLANNED_QUERY_MAX_PREDICATE_DEPTH = 16;
export const CDB_PLANNED_QUERY_MAX_BOOLEAN_CHILDREN = 16;

export interface RegisteredQueryPlan {
    readonly version: 1;
    readonly authority: MutationAuthority;
    readonly partitionKey: string;
    readonly intent: CdbIntent;
    readonly projection: readonly { readonly key: string; readonly column: string }[];
    readonly orderBy: readonly { readonly column: string; readonly direction: "asc" | "desc" }[];
    readonly limit: number;
    readonly planHash: string;
}

interface PlannedSelectBuilder {
    readonly config: SQLiteSelectConfig;
    toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
}

function unsupported(message: string): never {
    throw new CdbError({ code: "CDB_UNSUPPORTED_FEATURE", message: `planned query: ${message}` });
}

function isPlannedSelectBuilder(value: unknown): value is PlannedSelectBuilder {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { readonly config?: unknown; readonly toSQL?: unknown };
    return typeof candidate.config === "object" && candidate.config !== null && typeof candidate.toSQL === "function";
}

function compactSqlChunks(sql: SQL): readonly unknown[] {
    return sql.queryChunks.filter(chunk => !(is(chunk, StringChunk) && chunk.value.join("") === ""));
}

function assertSafePredicate(value: unknown, table: SQLiteTable): void {
    let nodes = 0;
    const text = (chunk: unknown) => (is(chunk, StringChunk) ? chunk.value.join("") : undefined);
    const column = (chunk: unknown): boolean => {
        if (!is(chunk, Column)) return false;
        if (chunk.table !== table) unsupported("predicate references a different table");
        return true;
    };
    const admitNode = (): void => {
        nodes++;
        if (nodes > CDB_PLANNED_QUERY_MAX_PREDICATES) {
            unsupported(`predicate count exceeds ${CDB_PLANNED_QUERY_MAX_PREDICATES}`);
        }
    };
    const validate = (expression: unknown, depth = 1): void => {
        if (depth > CDB_PLANNED_QUERY_MAX_PREDICATE_DEPTH) {
            unsupported(`predicate depth exceeds ${CDB_PLANNED_QUERY_MAX_PREDICATE_DEPTH}`);
        }
        if (!is(expression, SQL)) unsupported("where() requires a recognized Drizzle predicate");
        const chunks = compactSqlChunks(expression);
        if (chunks.length === 1 && is(chunks[0], SQL)) {
            validate(chunks[0], depth);
            return;
        }
        if (chunks.length === 3 && text(chunks[0]) === "(" && is(chunks[1], SQL) && text(chunks[2]) === ")") {
            const inner = compactSqlChunks(chunks[1]);
            const separator = text(inner[1]);
            if ((separator === " and " || separator === " or ") && inner.length >= 3 && inner.length % 2 === 1) {
                const childCount = (inner.length + 1) / 2;
                if (childCount > CDB_PLANNED_QUERY_MAX_BOOLEAN_CHILDREN) {
                    unsupported(`boolean predicate accepts at most ${CDB_PLANNED_QUERY_MAX_BOOLEAN_CHILDREN} children`);
                }
                admitNode();
                for (let index = 0; index < inner.length; index++) {
                    const item = inner[index];
                    if (index % 2 === 0) validate(item, depth + 1);
                    else if (text(item) !== separator) unsupported("predicate boolean expression is malformed");
                }
                return;
            }
        }
        if (chunks.length === 3 && column(chunks[0])) {
            const operator = text(chunks[1]);
            if ([" = ", " > ", " >= ", " < ", " <= "].includes(operator ?? "") && is(chunks[2], Param)) {
                admitNode();
                return;
            }
            if (
                operator === " in " &&
                Array.isArray(chunks[2]) &&
                chunks[2].length > 0 &&
                chunks[2].every(item => is(item, Param))
            ) {
                if (chunks[2].length > CDB_PLANNED_QUERY_MAX_IN_VALUES) {
                    unsupported(`inArray accepts at most ${CDB_PLANNED_QUERY_MAX_IN_VALUES} values`);
                }
                admitNode();
                return;
            }
        }
        if (
            chunks.length === 5 &&
            column(chunks[0]) &&
            text(chunks[1]) === " between " &&
            is(chunks[2], Param) &&
            text(chunks[3]) === " and " &&
            is(chunks[4], Param)
        ) {
            admitNode();
            return;
        }
        unsupported("raw or unrecognized predicates are unavailable");
    };

    validate(value);
}

function projectionFor(config: SQLiteSelectConfig, table: SQLiteTable) {
    const tableColumns = getTableColumns(table) as Record<string, Column>;
    const fields = Object.entries(config.fields);
    const expected = Object.entries(tableColumns);
    if (fields.length !== expected.length || fields.some(([key, field]) => tableColumns[key] !== field)) {
        unsupported("explicit projections are unavailable in the first planned-query version");
    }
    return fields.map(([key, field]) => ({ key, column: (field as Column).name }));
}

function orderItem(
    value: unknown,
    table: SQLiteTable
): { readonly column: string; readonly direction: "asc" | "desc" } {
    if (is(value, Column)) {
        if (value.table !== table) unsupported("ORDER BY references a different table");
        return { column: value.name, direction: "asc" };
    }
    if (!is(value, SQL)) unsupported("ORDER BY accepts only direct columns");
    const chunks = compactSqlChunks(value);
    if (chunks.length !== 2 || !is(chunks[0], Column) || !is(chunks[1], StringChunk)) {
        unsupported("ORDER BY accepts only asc(column) or desc(column)");
    }
    const column = chunks[0];
    if (column.table !== table) unsupported("ORDER BY references a different table");
    const suffix = chunks[1].value.join("").trim().toLowerCase();
    if (suffix !== "asc" && suffix !== "desc") unsupported("ORDER BY direction is unsupported");
    return { column: column.name, direction: suffix };
}

function primaryKeyColumns(table: SQLiteTable): readonly string[] {
    const config = getTableConfig(table);
    const inline = config.columns.filter(column => column.primary).map(column => column.name);
    const composite = config.primaryKeys.flatMap(key => key.columns.map(column => column.name));
    return [...new Set([...inline, ...composite])];
}

function authorityAndPartitionColumn(table: SQLiteTable): {
    readonly authority: MutationAuthority;
    readonly column: string;
} {
    const meta = resolveCdbMeta(table);
    if (meta.tenantKind === "org") {
        if (!meta.tenantBy)
            throw new CdbError({ code: "CDB_INVARIANT", message: `${meta.name}: missing organization column` });
        return { authority: "organization", column: meta.tenantBy };
    }
    if (meta.tenantKind === "user") {
        if (!meta.tenantBy) throw new CdbError({ code: "CDB_INVARIANT", message: `${meta.name}: missing user column` });
        return { authority: "user", column: meta.tenantBy };
    }
    if (meta.partitionBy.kind !== "colocate" || meta.partitionBy.via.length !== 1 || !meta.partitionBy.via[0]) {
        unsupported(`${meta.name} requires one global partition column`);
    }
    return { authority: "global", column: meta.partitionBy.via[0] };
}

/** Compile one synchronous, sessionless Drizzle select before Catalog authority lookup. */
export function compileRegisteredQueryPlan<TDb, TArgs>(
    query: (db: TDb, args: TArgs) => unknown,
    args: TArgs
): RegisteredQueryPlan {
    const planningDb = new QueryBuilder();
    const built = query(planningDb as TDb, args);
    if (!isPlannedSelectBuilder(built)) {
        if (built && typeof built === "object" && typeof (built as { then?: unknown }).then === "function") {
            unsupported("query callback must return a builder synchronously");
        }
        unsupported("query callback must return a Drizzle select builder");
    }

    const config = built.config;
    if (!is(config.table, SQLiteTable)) unsupported("FROM must reference one concrete SQLite cdbTable");
    const table = config.table as SQLiteTable;
    if (config.withList?.length) unsupported("CTEs are unavailable");
    if (config.joins?.length) unsupported("joins are unavailable");
    if (config.distinct) unsupported("DISTINCT is unavailable");
    if (config.groupBy?.length || config.having) unsupported("grouped queries are unavailable");
    if (config.setOperators.length) unsupported("set operators are unavailable");
    if (config.offset !== undefined) unsupported("offset pagination is unavailable");
    if (
        !Number.isSafeInteger(config.limit) ||
        (config.limit as number) < 1 ||
        (config.limit as number) > CDB_PLANNED_QUERY_MAX_ROWS
    ) {
        unsupported(`limit must be an integer from 1 through ${CDB_PLANNED_QUERY_MAX_ROWS}`);
    }
    if (!config.where) {
        throw new CdbError({
            code: "CDB_CROSS_PARTITION",
            message: "planned query requires an exact placement predicate",
        });
    }
    assertSafePredicate(config.where, table);

    const { authority, column: partitionColumn } = authorityAndPartitionColumn(table);
    const tableName = getTableName(table);
    const baseIntent = new StaticIntentExtractor({ [tableName]: partitionColumn }).forSelect({
        tables: [tableName],
        where: config.where,
    });
    const partitionValues = baseIntent.partitionKey?.values;
    if (
        baseIntent.joinShape !== "colocated" ||
        partitionValues?.length !== 1 ||
        typeof partitionValues[0] !== "string" ||
        partitionValues[0].length === 0
    ) {
        throw new CdbError({
            code: "CDB_CROSS_PARTITION",
            message: "planned query must constrain its placement column to one nonempty string",
        });
    }

    const intervals = Object.values(getTableColumns(table) as Record<string, Column>).flatMap(column => {
        const observed = intervalsForColumnPredicate(config.where as SQL, tableName, column.name);
        return observed === "full" || observed.length === 0
            ? []
            : [{ table: tableName, indexName: column.name, intervals: observed }];
    });
    const intent: CdbIntent = {
        ...baseIntent,
        ...(intervals.length > 0 ? { intervals } : {}),
    };
    const projection = projectionFor(config, table);
    const orderBy = (config.orderBy ?? []).map(item => orderItem(item, table));
    const primaryKeys = primaryKeyColumns(table);
    if (primaryKeys.length === 0) unsupported("table must declare a primary key");
    const suffix = orderBy.slice(-primaryKeys.length).map(item => item.column);
    if (suffix.length !== primaryKeys.length || suffix.some((column, index) => column !== primaryKeys[index])) {
        unsupported(
            `ORDER BY must end with primary key column${primaryKeys.length === 1 ? "" : "s"} ${primaryKeys.join(", ")}`
        );
    }

    const compiled = built.toSQL();
    const hashInput = {
        version: 1,
        authority,
        partitionKey: partitionValues[0],
        intent,
        projection,
        orderBy,
        limit: config.limit as number,
        sql: compiled.sql,
        params: compiled.params as readonly RawJson[],
    } as const;
    let planHash: string;
    try {
        planHash = stableHashHex(hashInput);
    } catch (cause) {
        throw new CdbError({
            code: "CDB_INVALID_ARGS",
            message: "planned query contains non-JSON SQL parameters",
            cause,
        });
    }
    return {
        version: 1,
        authority,
        partitionKey: partitionValues[0],
        intent,
        projection,
        orderBy,
        limit: config.limit as number,
        planHash,
    };
}
