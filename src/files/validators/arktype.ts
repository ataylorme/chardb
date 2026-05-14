/**
 * Arktype adapter for chardb tables.
 *
 * Delegates to `drizzle-arktype`; substitutes `type("string>0")` for `file()`
 * columns since on the wire a file is its server-allocated ULID id.
 */

import { type ArkType, type as arkType } from "arktype";
import { type ArktypeSchema, createInsertSchema, createSelectSchema } from "drizzle-arktype";
import type { Column, Table } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { isChardbFileColumn } from "../index.ts";

export function chardbArktypeFileSchema(): ArkType {
    return arkType("string>0");
}

function buildFileRefines(table: Table): Record<string, ArktypeSchema> {
    const out: Record<string, ArktypeSchema> = {};
    for (const [key, col] of Object.entries(getTableColumns(table))) {
        if (isChardbFileColumn(col)) out[key] = chardbArktypeFileSchema() as ArktypeSchema;
    }
    return out;
}

export function chardbArktypeFromColumn(column: Column): ArktypeSchema {
    if (isChardbFileColumn(column)) return chardbArktypeFileSchema() as ArktypeSchema;
    const entry = Object.entries(getTableColumns(column.table)).find(([, c]) => c === column);
    if (!entry) throw new Error(`column ${column.name} is not bound to its parent table`);
    const schema = createSelectSchema(column.table) as ArktypeSchema & {
        props?: Record<string, ArktypeSchema>;
    };
    const props = schema.props ?? {};
    const value = props[entry[0]];
    if (!value) throw new Error(`drizzle-arktype did not emit a prop for ${entry[0]}`);
    return value;
}

export function createInsertSchemaForArktype<T extends Table>(table: T): ArktypeSchema {
    return createInsertSchema(table, buildFileRefines(table));
}

export function createSelectSchemaForArktype<T extends Table>(table: T): ArktypeSchema {
    return createSelectSchema(table, buildFileRefines(table));
}

/** @deprecated kept for the legacy opaque `file()` adapter contract. */
export type ArktypeFactory = (def: string) => unknown;
/** @deprecated prefer `createInsertSchemaForArktype`. */
export function chardbArktypeFile(type: ArktypeFactory): { dataType: "custom"; schema: unknown } {
    return { dataType: "custom", schema: type("unknown") };
}
export const chardbArktypeFileArray = chardbArktypeFile;
