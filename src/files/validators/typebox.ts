/**
 * TypeBox adapter for chardb tables.
 *
 * Delegates to `drizzle-typebox`; substitutes `Type.String({ minLength: 1 })`
 * for `file()` columns since on the wire a file is its server-allocated id.
 */

import { Type } from "@sinclair/typebox";
import type { Column, Table } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { type TypeboxSchema, createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-typebox";
import { isChardbFileColumn } from "../index.ts";

export function chardbTypeboxFileSchema(): TypeboxSchema {
    return Type.String({ minLength: 1 }) as TypeboxSchema;
}

function buildFileRefines(table: Table): Record<string, TypeboxSchema> {
    const out: Record<string, TypeboxSchema> = {};
    for (const [key, col] of Object.entries(getTableColumns(table))) {
        if (isChardbFileColumn(col)) out[key] = chardbTypeboxFileSchema();
    }
    return out;
}

export function chardbTypeboxFromColumn(column: Column): TypeboxSchema {
    if (isChardbFileColumn(column)) return chardbTypeboxFileSchema();
    const entries = Object.entries(getTableColumns(column.table));
    const entry = entries.find(([, c]) => c === column);
    if (!entry) throw new Error(`column ${column.name} is not bound to its parent table`);
    const schema = createSelectSchema(column.table) as TypeboxSchema & {
        properties?: Record<string, TypeboxSchema>;
    };
    const props = schema.properties ?? {};
    const value = props[entry[0]];
    if (!value) throw new Error(`drizzle-typebox did not emit a property for ${entry[0]}`);
    return value;
}

export function createInsertSchemaForTypebox<T extends Table>(table: T): TypeboxSchema {
    return createInsertSchema(table, buildFileRefines(table));
}

export function createSelectSchemaForTypebox<T extends Table>(table: T): TypeboxSchema {
    return createSelectSchema(table, buildFileRefines(table));
}

export function createUpdateSchemaForTypebox<T extends Table>(table: T): TypeboxSchema {
    return createUpdateSchema(table, buildFileRefines(table));
}

/** @deprecated kept for the legacy opaque `file()` adapter contract. */
export interface TypeboxLike {
    Any(): unknown;
}
/** @deprecated prefer `createInsertSchemaForTypebox`. */
export function chardbTypeboxFile(T: TypeboxLike): { dataType: "custom"; schema: unknown } {
    return { dataType: "custom", schema: T.Any() };
}
export const chardbTypeboxFileArray = chardbTypeboxFile;
