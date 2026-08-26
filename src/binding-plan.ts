import { Column, Param, SQL, StringChunk, getTableName, is } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "./errors.ts";

export const CHARDB_SELECT_PLAN_VERSION = 1 as const;
export const CHARDB_SELECT_PLAN_MAX_BYTES = 64 * 1_024;
export const CHARDB_SELECT_PLAN_MAX_PREDICATES = 128;
export const CHARDB_SELECT_PLAN_MAX_DEPTH = 16;
export const CHARDB_SELECT_PLAN_MAX_CHILDREN = 16;
export const CHARDB_SELECT_PLAN_MAX_IN_VALUES = 100;
export const CHARDB_SELECT_PLAN_MAX_ORDER_BY = 4;
export const CHARDB_SELECT_PLAN_MAX_LIMIT = 256;

const CHARDB_TABLE_SYMBOL = Symbol.for("chardb.table");
const TEXT_ENCODER = new TextEncoder();
const MAX_IDENTIFIER_BYTES = 256;

export type ChardbPlanScalar = string | number | boolean | null;

export type ChardbPlanPredicateV1 =
    | {
          readonly kind: "compare";
          readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
          readonly column: string;
          readonly value: ChardbPlanScalar;
      }
    | {
          readonly kind: "in";
          readonly column: string;
          readonly values: readonly ChardbPlanScalar[];
      }
    | {
          readonly kind: "between";
          readonly column: string;
          readonly lower: ChardbPlanScalar;
          readonly upper: ChardbPlanScalar;
      }
    | {
          readonly kind: "null";
          readonly op: "isNull" | "isNotNull";
          readonly column: string;
      }
    | {
          readonly kind: "and" | "or";
          readonly predicates: readonly ChardbPlanPredicateV1[];
      };

export interface ChardbSelectPlanV1 {
    readonly version: typeof CHARDB_SELECT_PLAN_VERSION;
    readonly kind: "select";
    readonly table: string;
    readonly selection: { readonly kind: "all" };
    readonly where?: ChardbPlanPredicateV1 | undefined;
    readonly orderBy?: readonly {
        readonly column: string;
        readonly direction: "asc" | "desc";
    }[];
    readonly limit?: number | undefined;
    readonly cardinality: "many" | "one";
}

export type BindingPlanExecutor = (plan: ChardbSelectPlanV1) => Promise<unknown>;

type SelectRow<TTable extends SQLiteTable> = TTable["$inferSelect"];

export interface ChardbSelectFromBuilder {
    from<TTable extends SQLiteTable>(table: TTable): ChardbSelectQuery<SelectRow<TTable>>;
}

export interface ChardbSelectQuery<TRow> extends PromiseLike<readonly TRow[]> {
    where(predicate: SQL): ChardbSelectQuery<TRow>;
    orderBy(...expressions: readonly (Column | SQL)[]): ChardbSelectQuery<TRow>;
    limit(value: number): ChardbSelectQuery<TRow>;
    all(): Promise<readonly TRow[]>;
    get(): Promise<TRow | undefined>;
}

export type ChardbBindingSelect = () => ChardbSelectFromBuilder;

interface SelectState {
    readonly table: SQLiteTable;
    readonly tableName: string;
    readonly where?: ChardbPlanPredicateV1 | undefined;
    readonly orderBy?: readonly { readonly column: string; readonly direction: "asc" | "desc" }[] | undefined;
    readonly limit?: number | undefined;
}

const COMPARE_OPS = new Map<string, Extract<ChardbPlanPredicateV1, { kind: "compare" }>["op"]>([
    [" = ", "eq"],
    [" <> ", "ne"],
    [" > ", "gt"],
    [" >= ", "gte"],
    [" < ", "lt"],
    [" <= ", "lte"],
]);

function invalid(message: string): CdbError {
    return new CdbError({ code: "CDB_INVALID_ARGS", message: `DB select plan: ${message}` });
}

function unsupported(message: string): CdbError {
    return new CdbError({ code: "CDB_UNSUPPORTED_FEATURE", message: `DB select builder: ${message}` });
}

function boundedIdentifier(value: unknown, subject: string): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        TEXT_ENCODER.encode(value).byteLength > MAX_IDENTIFIER_BYTES ||
        Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 31 || code === 127;
        })
    ) {
        throw invalid(`${subject} is invalid`);
    }
    return value;
}

function scalar(value: unknown, subject: string): ChardbPlanScalar {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    throw unsupported(`${subject} must be a JSON string, finite number, boolean, or null`);
}

function chunkText(value: unknown): string | undefined {
    return is(value, StringChunk) ? value.value.join("") : undefined;
}

function compact(chunks: readonly unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const chunk of chunks) {
        if (chunk === undefined) continue;
        if (is(chunk, StringChunk) && chunk.value.join("") === "") continue;
        out.push(chunk);
    }
    return out;
}

function selectedColumn(value: unknown, table: SQLiteTable): string {
    if (!is(value, Column)) throw unsupported("predicates may reference only typed columns");
    if (value.table !== table) {
        throw unsupported("predicates and ordering may reference only the selected table");
    }
    return boundedIdentifier(value.name, "column name");
}

function parameter(value: unknown, subject: string): ChardbPlanScalar {
    if (!is(value, Param)) throw unsupported(`${subject} must use a bound Drizzle value`);
    return scalar(value.value, subject);
}

interface CompileCounter {
    nodes: number;
}

function compilePredicate(sql: SQL, table: SQLiteTable, depth: number, counter: CompileCounter): ChardbPlanPredicateV1 {
    if (depth > CHARDB_SELECT_PLAN_MAX_DEPTH) {
        throw invalid(`predicate nesting exceeds ${CHARDB_SELECT_PLAN_MAX_DEPTH}`);
    }
    counter.nodes++;
    if (counter.nodes > CHARDB_SELECT_PLAN_MAX_PREDICATES) {
        throw invalid(`predicate count exceeds ${CHARDB_SELECT_PLAN_MAX_PREDICATES}`);
    }

    const chunks = compact(sql.queryChunks);
    if (chunks.length === 1) {
        const only = chunks[0];
        if (is(only, SQL)) return compilePredicate(only, table, depth, counter);
    }

    const boolean = matchBoolean(chunks);
    if (boolean) {
        if (boolean.children.length < 2 || boolean.children.length > CHARDB_SELECT_PLAN_MAX_CHILDREN) {
            throw invalid(`${boolean.kind} predicates require 2 through ${CHARDB_SELECT_PLAN_MAX_CHILDREN} children`);
        }
        return {
            kind: boolean.kind,
            predicates: boolean.children.map(child => compilePredicate(child, table, depth + 1, counter)),
        };
    }

    if (chunks.length === 2) {
        const [column, operator] = chunks;
        const op = chunkText(operator);
        if (op === " is null" || op === " is not null") {
            return {
                kind: "null",
                op: op === " is null" ? "isNull" : "isNotNull",
                column: selectedColumn(column, table),
            };
        }
    }

    if (chunks.length === 3) {
        const [column, operator, value] = chunks;
        const opText = chunkText(operator);
        const op = opText === undefined ? undefined : COMPARE_OPS.get(opText);
        if (op) {
            return {
                kind: "compare",
                op,
                column: selectedColumn(column, table),
                value: parameter(value, `${op} value`),
            };
        }
        if (opText === " in ") {
            selectedColumn(column, table);
            if (!Array.isArray(value)) throw unsupported("inArray must contain bound Drizzle values");
            if (value.length === 0 || value.length > CHARDB_SELECT_PLAN_MAX_IN_VALUES) {
                throw invalid(`inArray requires 1 through ${CHARDB_SELECT_PLAN_MAX_IN_VALUES} values`);
            }
            return {
                kind: "in",
                column: selectedColumn(column, table),
                values: value.map((item, index) => parameter(item, `inArray value ${index}`)),
            };
        }
    }

    if (chunks.length === 5) {
        const [column, betweenText, lower, andText, upper] = chunks;
        if (chunkText(betweenText) === " between " && chunkText(andText) === " and ") {
            return {
                kind: "between",
                column: selectedColumn(column, table),
                lower: parameter(lower, "between lower value"),
                upper: parameter(upper, "between upper value"),
            };
        }
    }

    throw unsupported("predicate is outside the bounded eq/ne/range/inArray/between/null/and/or subset");
}

function matchBoolean(
    chunks: readonly unknown[]
): { readonly kind: "and" | "or"; readonly children: readonly SQL[] } | undefined {
    if (chunks.length !== 3) return undefined;
    const [open, middle, close] = chunks;
    if (chunkText(open) !== "(" || chunkText(close) !== ")" || !is(middle, SQL)) return undefined;
    const inner = compact(middle.queryChunks);
    if (inner.length < 3 || inner.length % 2 === 0) return undefined;
    const separator = chunkText(inner[1]);
    const kind = separator === " and " ? "and" : separator === " or " ? "or" : undefined;
    if (!kind) return undefined;
    const children: SQL[] = [];
    for (let index = 0; index < inner.length; index++) {
        const item = inner[index];
        if (index % 2 === 0) {
            if (!is(item, SQL)) return undefined;
            children.push(item);
        } else if (chunkText(item) !== separator) {
            return undefined;
        }
    }
    return { kind, children };
}

function compileOrder(
    expression: Column | SQL,
    table: SQLiteTable
): {
    readonly column: string;
    readonly direction: "asc" | "desc";
} {
    if (is(expression, Column)) return { column: selectedColumn(expression, table), direction: "asc" };
    if (!is(expression, SQL)) throw unsupported("orderBy accepts only a column, asc(column), or desc(column)");
    const chunks = compact(expression.queryChunks);
    if (chunks.length !== 2) throw unsupported("orderBy accepts only a column, asc(column), or desc(column)");
    const directionText = chunkText(chunks[1]);
    if (directionText !== " asc" && directionText !== " desc") {
        throw unsupported("orderBy accepts only a column, asc(column), or desc(column)");
    }
    return {
        column: selectedColumn(chunks[0], table),
        direction: directionText === " asc" ? "asc" : "desc",
    };
}

function isCdbTable(table: SQLiteTable): boolean {
    return CHARDB_TABLE_SYMBOL in (table as unknown as Record<symbol, unknown>);
}

function exactPlan(state: SelectState, cardinality: "many" | "one"): ChardbSelectPlanV1 {
    const candidate: ChardbSelectPlanV1 = {
        version: CHARDB_SELECT_PLAN_VERSION,
        kind: "select",
        table: state.tableName,
        selection: { kind: "all" },
        ...(state.where ? { where: state.where } : {}),
        ...(state.orderBy ? { orderBy: state.orderBy } : {}),
        ...(state.limit !== undefined ? { limit: state.limit } : {}),
        cardinality,
    };
    return validateChardbSelectPlanV1(candidate);
}

class SelectFromBuilder implements ChardbSelectFromBuilder {
    constructor(private readonly execute: BindingPlanExecutor) {}

    from<TTable extends SQLiteTable>(table: TTable): ChardbSelectQuery<SelectRow<TTable>> {
        if (!table || typeof table !== "object" || !isCdbTable(table)) {
            throw unsupported("from() accepts only a registered cdbTable");
        }
        return selectQueryProxy(
            new SelectQuery<SelectRow<TTable>>(this.execute, {
                table,
                tableName: boundedIdentifier(getTableName(table), "table name"),
            })
        );
    }
}

class SelectQuery<TRow> implements ChardbSelectQuery<TRow> {
    constructor(
        private readonly execute: BindingPlanExecutor,
        private readonly state: SelectState
    ) {}

    where(predicate: SQL): ChardbSelectQuery<TRow> {
        if (this.state.where) throw unsupported("where() may be called only once");
        if (!is(predicate, SQL)) throw unsupported("where() requires a recognized Drizzle predicate");
        const compiled = compilePredicate(predicate, this.state.table, 1, { nodes: 0 });
        return selectQueryProxy(new SelectQuery(this.execute, { ...this.state, where: compiled }));
    }

    orderBy(...expressions: readonly (Column | SQL)[]): ChardbSelectQuery<TRow> {
        if (this.state.orderBy) throw unsupported("orderBy() may be called only once");
        if (expressions.length === 0 || expressions.length > CHARDB_SELECT_PLAN_MAX_ORDER_BY) {
            throw invalid(`orderBy requires 1 through ${CHARDB_SELECT_PLAN_MAX_ORDER_BY} columns`);
        }
        if (expressions.some(expression => typeof expression === "function")) {
            throw unsupported("orderBy callbacks are unavailable");
        }
        const orderBy = expressions.map(expression => compileOrder(expression, this.state.table));
        return selectQueryProxy(new SelectQuery(this.execute, { ...this.state, orderBy }));
    }

    limit(value: number): ChardbSelectQuery<TRow> {
        if (this.state.limit !== undefined) throw unsupported("limit() may be called only once");
        if (!Number.isSafeInteger(value) || value < 1 || value > CHARDB_SELECT_PLAN_MAX_LIMIT) {
            throw invalid(`limit must be an integer from 1 through ${CHARDB_SELECT_PLAN_MAX_LIMIT}`);
        }
        return selectQueryProxy(new SelectQuery(this.execute, { ...this.state, limit: value }));
    }

    async all(): Promise<readonly TRow[]> {
        const result = await this.execute(exactPlan(this.state, "many"));
        if (!Array.isArray(result)) throw invalid("many-result executor returned a non-array");
        return result as readonly TRow[];
    }

    async get(): Promise<TRow | undefined> {
        const result = await this.execute(exactPlan(this.state, "one"));
        if (result === null) return undefined;
        if (!result || typeof result !== "object" || Array.isArray(result)) {
            throw invalid("one-result executor returned neither an object nor null");
        }
        return result as TRow;
    }

    // biome-ignore lint/suspicious/noThenProperty: Drizzle builders are deliberately awaitable.
    then<TResult1 = readonly TRow[], TResult2 = never>(
        onfulfilled?: ((value: readonly TRow[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
        return this.all().then(onfulfilled, onrejected);
    }
}

const QUERY_PROPERTIES = new Set<PropertyKey>(["where", "orderBy", "limit", "all", "get", "then"]);

function selectQueryProxy<TRow>(query: SelectQuery<TRow>): ChardbSelectQuery<TRow> {
    return new Proxy(query, {
        get(target, property, receiver) {
            if (typeof property === "symbol") return Reflect.get(target, property, receiver);
            if (!QUERY_PROPERTIES.has(property)) {
                throw unsupported(`property "${String(property)}" is unavailable`);
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

/**
 * Build the bounded full-row select method used by the native binding client.
 * The injected executor owns authentication and transport. This module only
 * compiles typed Drizzle values into a strict structured plan.
 */
export function createBindingSelect(execute: BindingPlanExecutor): ChardbBindingSelect {
    if (typeof execute !== "function") throw new TypeError("chardb: DB select executor must be a function");
    return (...args: readonly unknown[]) => {
        if (args.length !== 0) throw unsupported("select projections are unavailable in plan version 1");
        return new Proxy(new SelectFromBuilder(execute), {
            get(target, property, receiver) {
                if (typeof property === "symbol") return Reflect.get(target, property, receiver);
                if (property !== "from") {
                    throw unsupported(`property "${String(property)}" is unavailable before from()`);
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    };
}

function objectEntries(value: unknown, subject: string): Map<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${subject} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid(`${subject} must be a plain object`);
    const entries = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw invalid(`${subject} cannot contain symbol keys`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw invalid(`${subject}.${key} must be an enumerable data property`);
        }
        entries.set(key, descriptor.value);
    }
    return entries;
}

function exactKeys(
    entries: ReadonlyMap<string, unknown>,
    subject: string,
    required: readonly string[],
    optional: readonly string[] = []
): void {
    const allowed = new Set([...required, ...optional]);
    for (const key of entries.keys()) if (!allowed.has(key)) throw invalid(`${subject} contains unknown key ${key}`);
    for (const key of required) if (!entries.has(key)) throw invalid(`${subject} is missing ${key}`);
}

function strictArray(value: unknown, subject: string): readonly unknown[] {
    if (!Array.isArray(value)) throw invalid(`${subject} must be an array`);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === "symbol")) throw invalid(`${subject} cannot contain symbol keys`);
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
        throw invalid(`${subject} must be a dense array without extra properties`);
    }
    const out: unknown[] = [];
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw invalid(`${subject}[${index}] must be an enumerable data property`);
        }
        out.push(descriptor.value);
    }
    return out;
}

function decodedScalar(value: unknown, subject: string): ChardbPlanScalar {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    throw invalid(`${subject} must be a JSON scalar`);
}

function decodePredicate(
    value: unknown,
    depth: number,
    counter: CompileCounter,
    subject: string
): ChardbPlanPredicateV1 {
    if (depth > CHARDB_SELECT_PLAN_MAX_DEPTH) {
        throw invalid(`predicate nesting exceeds ${CHARDB_SELECT_PLAN_MAX_DEPTH}`);
    }
    counter.nodes++;
    if (counter.nodes > CHARDB_SELECT_PLAN_MAX_PREDICATES) {
        throw invalid(`predicate count exceeds ${CHARDB_SELECT_PLAN_MAX_PREDICATES}`);
    }
    const entries = objectEntries(value, subject);
    const kind = entries.get("kind");
    if (kind === "compare") {
        exactKeys(entries, subject, ["kind", "op", "column", "value"]);
        const op = entries.get("op");
        if (!(["eq", "ne", "gt", "gte", "lt", "lte"] as readonly unknown[]).includes(op)) {
            throw invalid(`${subject}.op is invalid`);
        }
        return {
            kind,
            op: op as Extract<ChardbPlanPredicateV1, { kind: "compare" }>["op"],
            column: boundedIdentifier(entries.get("column"), `${subject}.column`),
            value: decodedScalar(entries.get("value"), `${subject}.value`),
        };
    }
    if (kind === "in") {
        exactKeys(entries, subject, ["kind", "column", "values"]);
        const values = strictArray(entries.get("values"), `${subject}.values`);
        if (values.length === 0 || values.length > CHARDB_SELECT_PLAN_MAX_IN_VALUES) {
            throw invalid(`${subject}.values requires 1 through ${CHARDB_SELECT_PLAN_MAX_IN_VALUES} entries`);
        }
        return {
            kind,
            column: boundedIdentifier(entries.get("column"), `${subject}.column`),
            values: values.map((entry, index) => decodedScalar(entry, `${subject}.values[${index}]`)),
        };
    }
    if (kind === "between") {
        exactKeys(entries, subject, ["kind", "column", "lower", "upper"]);
        return {
            kind,
            column: boundedIdentifier(entries.get("column"), `${subject}.column`),
            lower: decodedScalar(entries.get("lower"), `${subject}.lower`),
            upper: decodedScalar(entries.get("upper"), `${subject}.upper`),
        };
    }
    if (kind === "null") {
        exactKeys(entries, subject, ["kind", "op", "column"]);
        const op = entries.get("op");
        if (op !== "isNull" && op !== "isNotNull") throw invalid(`${subject}.op is invalid`);
        return {
            kind,
            op,
            column: boundedIdentifier(entries.get("column"), `${subject}.column`),
        };
    }
    if (kind === "and" || kind === "or") {
        exactKeys(entries, subject, ["kind", "predicates"]);
        const predicates = strictArray(entries.get("predicates"), `${subject}.predicates`);
        if (predicates.length < 2 || predicates.length > CHARDB_SELECT_PLAN_MAX_CHILDREN) {
            throw invalid(`${subject}.predicates requires 2 through ${CHARDB_SELECT_PLAN_MAX_CHILDREN} entries`);
        }
        return {
            kind,
            predicates: predicates.map((entry, index) =>
                decodePredicate(entry, depth + 1, counter, `${subject}.predicates[${index}]`)
            ),
        };
    }
    throw invalid(`${subject}.kind is invalid`);
}

/** Strictly validate and own one version-1 select plan. */
export function validateChardbSelectPlanV1(value: unknown): ChardbSelectPlanV1 {
    const entries = objectEntries(value, "plan");
    exactKeys(entries, "plan", ["version", "kind", "table", "selection", "cardinality"], ["where", "orderBy", "limit"]);
    if (entries.get("version") !== CHARDB_SELECT_PLAN_VERSION) throw invalid("version is unsupported");
    if (entries.get("kind") !== "select") throw invalid("kind must be select");
    const selection = objectEntries(entries.get("selection"), "plan.selection");
    exactKeys(selection, "plan.selection", ["kind"]);
    if (selection.get("kind") !== "all") throw invalid("plan.selection.kind must be all");
    const cardinality = entries.get("cardinality");
    if (cardinality !== "many" && cardinality !== "one") throw invalid("cardinality is invalid");
    const where = entries.has("where")
        ? decodePredicate(entries.get("where"), 1, { nodes: 0 }, "plan.where")
        : undefined;
    let orderBy: readonly { readonly column: string; readonly direction: "asc" | "desc" }[] | undefined;
    if (entries.has("orderBy")) {
        const rawOrder = strictArray(entries.get("orderBy"), "plan.orderBy");
        if (rawOrder.length === 0 || rawOrder.length > CHARDB_SELECT_PLAN_MAX_ORDER_BY) {
            throw invalid(`plan.orderBy requires 1 through ${CHARDB_SELECT_PLAN_MAX_ORDER_BY} entries`);
        }
        orderBy = rawOrder.map((entry, index) => {
            const item = objectEntries(entry, `plan.orderBy[${index}]`);
            exactKeys(item, `plan.orderBy[${index}]`, ["column", "direction"]);
            const direction = item.get("direction");
            if (direction !== "asc" && direction !== "desc") {
                throw invalid(`plan.orderBy[${index}].direction is invalid`);
            }
            return {
                column: boundedIdentifier(item.get("column"), `plan.orderBy[${index}].column`),
                direction,
            };
        });
    }
    let limit: number | undefined;
    if (entries.has("limit")) {
        const candidate = entries.get("limit");
        if (
            !Number.isSafeInteger(candidate) ||
            (candidate as number) < 1 ||
            (candidate as number) > CHARDB_SELECT_PLAN_MAX_LIMIT
        ) {
            throw invalid(`limit must be an integer from 1 through ${CHARDB_SELECT_PLAN_MAX_LIMIT}`);
        }
        limit = candidate as number;
    }
    const plan: ChardbSelectPlanV1 = {
        version: CHARDB_SELECT_PLAN_VERSION,
        kind: "select",
        table: boundedIdentifier(entries.get("table"), "plan.table"),
        selection: { kind: "all" },
        ...(where ? { where } : {}),
        ...(orderBy ? { orderBy } : {}),
        ...(limit !== undefined ? { limit } : {}),
        cardinality,
    };
    const bytes = TEXT_ENCODER.encode(JSON.stringify(plan)).byteLength;
    if (bytes > CHARDB_SELECT_PLAN_MAX_BYTES) {
        throw invalid(`serialized size exceeds ${CHARDB_SELECT_PLAN_MAX_BYTES} bytes`);
    }
    return plan;
}
