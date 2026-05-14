/**
 * `chardb/drizzle` — async SQLite driver + runtime `migrate()` + the
 * `defineChardbConfig` helper that writes `drizzle.config.ts`.
 *
 * Drizzle's standard Proxy driver path is what wires the SDK to the wire
 * (`dbCredentials.proxy: async (sql, params, method) => …`). We lean on it
 * verbatim; the only chardb-specific change is the dialect subclass that
 * stashes `CdbIntent` on every produced `SQL`.
 */

import type { CdbIntent } from "../wire.ts";
import { CdbDialect, type IntentExtractor, PASSTHROUGH_EXTRACTOR, attachIntent, getIntent } from "./dialect.ts";

export {
    attachIntent,
    CdbDialect,
    CDB_INTENT,
    getIntent,
    PASSTHROUGH_EXTRACTOR,
    type IntentExtractor,
    type ExtractArgs,
} from "./dialect.ts";
export {
    type PartitionMap,
    STATIC_EXTRACTOR_FACTORY,
    StaticIntentExtractor,
} from "./walker.ts";

export interface ChardbProxyTransport {
    query<T>(
        sql: string,
        params: readonly unknown[],
        method: "get" | "all" | "run",
        intent?: CdbIntent
    ): Promise<{
        rows: T[];
    }>;
}

/**
 * `defineChardbConfig({ schema })` returns the object that the user spreads
 * into `drizzle.config.ts`. `chardb init` writes a one-line config that
 * forwards `dbCredentials.proxy` to a localhost-dev URL.
 */
export function defineChardbConfig<TSchema>(opts: {
    schema: TSchema;
    out?: string;
    dbUrl?: string;
}): {
    schema: TSchema;
    out: string;
    dialect: "sqlite";
    driver: "durable-sqlite";
} {
    return {
        schema: opts.schema,
        out: opts.out ?? "./drizzle",
        dialect: "sqlite",
        driver: "durable-sqlite",
    };
}

/**
 * Runtime `migrate()` — applies pending migrations to the schema-owning
 * Catalog DO. Customer code calls this from a deploy hook; chardb fans the
 * DDL out to every active shard with epoch-bump fencing.
 */
export async function migrate(opts: {
    applyDdl: (stmt: string) => Promise<void>;
    statements: readonly string[];
}): Promise<void> {
    for (const stmt of opts.statements) {
        if (!stmt.trim()) continue;
        await opts.applyDdl(stmt);
    }
}

void PASSTHROUGH_EXTRACTOR;
void CdbDialect;
void attachIntent;
void getIntent;
