/**
 * `SQLiteAsyncDialect` subclass that stashes a `CdbIntent` on every produced
 * `SQL` value via a non-enumerable symbol. Our session reads it back when
 * shipping the wire request.
 *
 * This is the only place we touch Drizzle internals; the surface is
 * `defineChardbConfig({ schema })` (writes the `dbCredentials.proxy`) and
 * `chardb/drizzle/migrate` (runtime migrations).
 */

import type { SQL } from "drizzle-orm/sql";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { CdbIntent, WireInterval } from "../wire.ts";

export const CDB_INTENT = Symbol.for("chardb.intent");

export interface IntentBearing<T = SQL> {
    readonly value: T;
    readonly [CDB_INTENT]: CdbIntent;
}

export function getIntent(sql: object): CdbIntent | undefined {
    return (sql as unknown as { [CDB_INTENT]?: CdbIntent })[CDB_INTENT];
}

export function attachIntent<T extends object>(target: T, intent: CdbIntent): T {
    Object.defineProperty(target, CDB_INTENT, {
        value: intent,
        enumerable: false,
        configurable: true,
    });
    return target;
}

/**
 * Walk a Drizzle `where: SQL` to extract partition-key predicates and
 * read intervals. Supported pattern table:
 *
 *   eq(t.k, v)                       distkey:yes,  intervals: point [v, v]
 *   inArray(t.k, [v1, v2])           distkey:yes,  intervals: union of points
 *   between(t.k, lo, hi)             distkey:yes,  intervals: [lo, hi]
 *   gt/lt/gte/lte                    distkey:partial, intervals: range
 *   and(eq(t.k, v), …)               distkey:yes,  intersection
 *   or(eq(t.k, v1), eq(t.k, v2))     distkey:yes,  union
 *   or(eq(t.k, v), eq(other.x, …))   distkey:NO,   full-table fallback
 *   subquery / raw sql              distkey:NO,   full-table fallback
 *
 * The actual walker is wired against `where.queryChunks`; the API surface is
 * intentionally stable across implementation revisions, since the chunk
 * shape lives in Drizzle's `SQL` class
 * (https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sql/sql.ts)
 * and the condition builders in `expressions/conditions.ts` of the same repo.
 */
export interface IntentExtractor {
    forSelect(args: ExtractArgs): CdbIntent;
    forInsert(args: ExtractArgs): CdbIntent;
    forUpdate(args: ExtractArgs): CdbIntent;
    forDelete(args: ExtractArgs): CdbIntent;
}

export interface ExtractArgs {
    readonly tables: readonly string[];
    readonly where?: SQL | undefined;
    readonly partitionKeyHint?:
        | { readonly table: string; readonly column: string; readonly values: readonly unknown[] }
        | undefined;
}

/** Conservative no-op extractor: tables only; no partition key, no intervals. */
export const PASSTHROUGH_EXTRACTOR: IntentExtractor = {
    forSelect: ({ tables }) => ({
        kind: "select",
        tables: [...tables],
        joinShape: "cross-partition",
    }),
    forInsert: ({ tables }) => ({
        kind: "insert",
        tables: [...tables],
        joinShape: "cross-partition",
    }),
    forUpdate: ({ tables }) => ({
        kind: "update",
        tables: [...tables],
        joinShape: "cross-partition",
    }),
    forDelete: ({ tables }) => ({
        kind: "delete",
        tables: [...tables],
        joinShape: "cross-partition",
    }),
};

/** Builder that the AsyncSQLiteDialect subclass uses on every produced SQL. */
export class CdbDialect extends SQLiteAsyncDialect {
    constructor(private readonly extractor: IntentExtractor = PASSTHROUGH_EXTRACTOR) {
        super();
    }

    buildIntent(args: ExtractArgs & { kind: CdbIntent["kind"] }): CdbIntent {
        switch (args.kind) {
            case "select":
                return this.extractor.forSelect(args);
            case "insert":
                return this.extractor.forInsert(args);
            case "update":
                return this.extractor.forUpdate(args);
            case "delete":
                return this.extractor.forDelete(args);
            case "execute":
                return { kind: "execute", tables: [...args.tables] };
        }
    }
}

export type { WireInterval };
