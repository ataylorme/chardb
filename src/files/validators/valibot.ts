/**
 * Valibot adapter for chardb tables.
 *
 * Delegates to `drizzle-valibot`; replaces `file()` columns with a non-empty
 * string id schema since the wire form of a file is its server-allocated ULID.
 */

import type { Column, Table } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { type ValibotSchema, createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-valibot";
import { type BaseSchema, minLength, pipe, string } from "valibot";
import { isChardbFileColumn } from "../index.ts";

export function chardbValibotFileSchema(): BaseSchema {
    return pipe(string(), minLength(1));
}

function buildFileRefines(table: Table): Record<string, ValibotSchema> {
    const out: Record<string, ValibotSchema> = {};
    for (const [key, col] of Object.entries(getTableColumns(table))) {
        if (isChardbFileColumn(col)) out[key] = chardbValibotFileSchema() as ValibotSchema;
    }
    return out;
}

export function chardbValibotFromColumn(column: Column): ValibotSchema {
    if (isChardbFileColumn(column)) return chardbValibotFileSchema() as ValibotSchema;
    const entry = Object.entries(getTableColumns(column.table)).find(([, c]) => c === column);
    if (!entry) throw new Error(`column ${column.name} is not bound to its parent table`);
    const schema = createSelectSchema(column.table) as ValibotSchema & {
        entries?: Record<string, ValibotSchema>;
    };
    const entries = schema.entries ?? {};
    const value = entries[entry[0]];
    if (!value) throw new Error(`drizzle-valibot did not emit an entry for ${entry[0]}`);
    return value;
}

export function createInsertSchemaForValibot<T extends Table>(table: T): ValibotSchema {
    return createInsertSchema(table, buildFileRefines(table));
}

export function createSelectSchemaForValibot<T extends Table>(table: T): ValibotSchema {
    return createSelectSchema(table, buildFileRefines(table));
}

export function createUpdateSchemaForValibot<T extends Table>(table: T): ValibotSchema {
    return createUpdateSchema(table, buildFileRefines(table));
}

/** @deprecated kept for the legacy opaque `file()` adapter contract. */
export interface ValibotLike {
    any(): unknown;
}
/** @deprecated prefer `createInsertSchemaForValibot`. */
export function chardbValibotFile(v: ValibotLike): { dataType: "custom"; schema: unknown } {
    return { dataType: "custom", schema: v.any() };
}
export const chardbValibotFileArray = chardbValibotFile;
