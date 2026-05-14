/**
 * Zod adapter for chardb tables.
 *
 * Delegates column → schema mapping to `drizzle-zod`, then overrides each
 * `file()` column with `z.string().min(1)` because on the wire a file is its
 * server-allocated ULID id, not the runtime `FileHandle` shape.
 */

import type { Column, Table } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { isChardbFileColumn } from "../index.ts";

/** Validator the wire applies to a `file()` column: an opaque, non-empty id string. */
export function chardbZodFileSchema(): z.ZodString {
    return z.string().min(1);
}

/** Validator for a single Drizzle column. File columns collapse to the wire string-id schema. */
export function chardbZodFromColumn(column: Column): z.ZodType {
    if (isChardbFileColumn(column)) return chardbZodFileSchema();
    const cols = getTableColumns(column.table);
    const entry = Object.entries(cols).find(([, c]) => c === column);
    if (!entry) throw new Error(`column ${column.name} is not bound to its parent table`);
    const sel = createSelectSchema(column.table) as unknown as { shape: Record<string, z.ZodType> };
    return sel.shape[entry[0]] as z.ZodType;
}

function buildFileRefines(table: Table): Record<string, z.ZodType> {
    const refines: Record<string, z.ZodType> = {};
    for (const [key, column] of Object.entries(getTableColumns(table))) {
        if (isChardbFileColumn(column)) refines[key] = chardbZodFileSchema();
    }
    return refines;
}

export function createInsertSchemaForZod<T extends Table>(table: T) {
    return createInsertSchema(table, buildFileRefines(table) as never);
}

export function createSelectSchemaForZod<T extends Table>(table: T) {
    return createSelectSchema(table, buildFileRefines(table) as never);
}

/** @deprecated kept for backward compatibility; prefer `createInsertSchemaForZod`. */
export interface ZodLike {
    any(): { _def: unknown; parse: (v: unknown) => unknown };
}

/** @deprecated kept for backward compatibility with the opaque `file()` adapter contract. */
export function chardbZodFile(zLike: ZodLike): {
    dataType: "custom";
    parse: (v: unknown) => unknown;
} {
    const inner = zLike.any();
    return Object.assign(
        { dataType: "custom" as const, parse: (v: unknown) => inner.parse(v) },
        {
            _def: inner._def,
        }
    ) as { dataType: "custom"; parse: (v: unknown) => unknown };
}

export const chardbZodFileArray = chardbZodFile;
