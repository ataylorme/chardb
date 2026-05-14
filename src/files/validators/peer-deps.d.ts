// Ambient declarations for optional peer dependencies. Each `drizzle-*`
// adapter ships the same `(table, refine?) => Schema` shape; we declare
// just enough surface for type-safe delegation. Runtime resolution still
// requires the user to install the matching peer dep.

declare module "drizzle-typebox" {
    import type { Table } from "drizzle-orm";
    type RefineMap = Record<string, TypeboxSchema>;
    export interface TypeboxSchema {
        readonly type?: string;
        readonly [key: string]: unknown;
    }
    export function createInsertSchema<T extends Table>(table: T, refine?: RefineMap): TypeboxSchema;
    export function createSelectSchema<T extends Table>(table: T, refine?: RefineMap): TypeboxSchema;
    export function createUpdateSchema<T extends Table>(table: T, refine?: RefineMap): TypeboxSchema;
}

declare module "drizzle-valibot" {
    import type { Table } from "drizzle-orm";
    export interface ValibotSchema {
        readonly kind?: string;
        readonly [key: string]: unknown;
    }
    type RefineMap = Record<string, ValibotSchema>;
    export function createInsertSchema<T extends Table>(table: T, refine?: RefineMap): ValibotSchema;
    export function createSelectSchema<T extends Table>(table: T, refine?: RefineMap): ValibotSchema;
    export function createUpdateSchema<T extends Table>(table: T, refine?: RefineMap): ValibotSchema;
}

declare module "drizzle-arktype" {
    import type { Table } from "drizzle-orm";
    export interface ArktypeSchema {
        readonly infer?: unknown;
        readonly [key: string]: unknown;
    }
    type RefineMap = Record<string, ArktypeSchema | string>;
    export function createInsertSchema<T extends Table>(table: T, refine?: RefineMap): ArktypeSchema;
    export function createSelectSchema<T extends Table>(table: T, refine?: RefineMap): ArktypeSchema;
}

declare module "@sinclair/typebox" {
    export interface TSchema {
        readonly [key: string]: unknown;
    }
    export interface TString extends TSchema {
        readonly type: "string";
    }
    export const Type: {
        String(options?: { minLength?: number }): TString;
        Any(): TSchema;
    };
}

declare module "valibot" {
    export interface BaseSchema {
        readonly kind?: string;
        readonly [key: string]: unknown;
    }
    export function string(): BaseSchema;
    export function any(): BaseSchema;
    export function pipe<S extends BaseSchema>(schema: S, ...checks: BaseSchema[]): S;
    export function minLength(n: number): BaseSchema;
}

declare module "arktype" {
    export interface ArkType<T = unknown> {
        readonly infer?: T;
        readonly [key: string]: unknown;
    }
    export function type(def: string): ArkType;
}
