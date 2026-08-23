/**
 * Pure helpers for the per-table tail-capture triggers used during a vshard
 * split. Kept separate from the Cdb DO so the SQL generation is unit-testable
 * without workerd.
 *
 * The triggers fire `AFTER INSERT | UPDATE | DELETE` on each migrating table
 * and project the affected row into `_chardb_split_log` as a JSON blob keyed
 * by the table's partition column. The destination shard later replays those
 * rows in LSN order, filtered by `vshardOf(partition_key) ∈ [lo, hi]`.
 *
 * Why JSON? SQLite triggers can build a row's full payload via `json_object`
 * (JSON1 is enabled by default in workerd's SQLite build); the destination
 * decodes that JSON and issues parameterized inserts. This avoids shipping
 * binary BLOBs through trigger bodies.
 *
 * Why a vshard filter at replay time, not in the trigger? SQLite has no
 * built-in `xxhash64`, so we cannot evaluate `vshardOf` inside trigger SQL.
 * The destination receives every change for the migrating table and skips
 * the rows whose partition key falls outside its range — small overhead
 * relative to the bulk-copy phase that dominates migration cost.
 */

export interface TableSpec {
    /** Concrete table name (matches the name in `sqlite_master`). */
    readonly name: string;
    /**
     * Column whose value is the partition key. Composite partition keys are
     * out of scope for the bulk-copy path; declare a stable single column
     * (typically the FK to the distribution root) when authoring schemas
     * intended for online resharding.
     */
    readonly partitionColumn: string;
    /** Names of every column in the table, in declaration order. */
    readonly columns: readonly string[];
}

export interface TriggerSet {
    readonly install: readonly string[];
    readonly uninstall: readonly string[];
}

const ALLOWED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(raw: string): string {
    if (!ALLOWED_IDENT.test(raw)) {
        throw new Error(`reshard: refusing to install trigger for non-identifier name: ${raw}`);
    }
    return `"${raw}"`;
}

function migIdent(migId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(migId)) {
        throw new Error(`reshard: migId must be [A-Za-z0-9_-]+, got: ${migId}`);
    }
    return migId.replaceAll("-", "_");
}

function jsonObjectExpr(prefix: "NEW" | "OLD", columns: readonly string[]): string {
    const parts = columns.map(c => `'${c}', ${prefix}.${quoteIdent(c)}`);
    return `json_object(${parts.join(", ")})`;
}

/**
 * Render the trigger DDL pair (install + uninstall) for a single table within
 * a single migration. Names are deterministic so re-running install is a
 * `CREATE TRIGGER IF NOT EXISTS` no-op and uninstall fully cleans up.
 */
export function renderTableTriggers(migId: string, table: TableSpec): TriggerSet {
    const m = migIdent(migId);
    const t = quoteIdent(table.name);
    const pkCol = quoteIdent(table.partitionColumn);
    const insName = quoteIdent(`_chardb_capt_${m}_${table.name}_ins`);
    const updName = quoteIdent(`_chardb_capt_${m}_${table.name}_upd`);
    const delName = quoteIdent(`_chardb_capt_${m}_${table.name}_del`);
    const newJson = jsonObjectExpr("NEW", table.columns);
    const oldJson = jsonObjectExpr("OLD", table.columns);
    const insertLog = (op: string, prefix: "NEW" | "OLD", payloadExpr: string) =>
        `INSERT INTO _chardb_split_log (mig_id, op, table_name, pk, before, after, ts) VALUES ('${migId}', '${op}', '${table.name}', CAST(${prefix}.${pkCol} AS TEXT), ${op === "ins" ? "NULL" : oldJson}, ${op === "del" ? "NULL" : payloadExpr}, CAST(strftime('%s','now') AS INTEGER) * 1000)`;

    return {
        install: [
            `CREATE TRIGGER IF NOT EXISTS ${insName} AFTER INSERT ON ${t} BEGIN ${insertLog("ins", "NEW", newJson)}; END`,
            `CREATE TRIGGER IF NOT EXISTS ${updName} AFTER UPDATE ON ${t} BEGIN ${insertLog("upd", "NEW", newJson)}; END`,
            `CREATE TRIGGER IF NOT EXISTS ${delName} AFTER DELETE ON ${t} BEGIN ${insertLog("del", "OLD", oldJson)}; END`,
        ],
        uninstall: [
            `DROP TRIGGER IF EXISTS ${insName}`,
            `DROP TRIGGER IF EXISTS ${updName}`,
            `DROP TRIGGER IF EXISTS ${delName}`,
        ],
    };
}

/**
 * Render a parameterized `INSERT OR REPLACE` for a row that the destination
 * receives during bulk copy or tail replay. Returns the SQL plus the bound
 * parameter list in column declaration order so the caller can pass both to
 * `sql.exec(...)`.
 */
export function renderRowApply(
    table: TableSpec,
    row: Readonly<Record<string, unknown>>
): { readonly sql: string; readonly params: readonly unknown[] } {
    const cols = table.columns.map(quoteIdent).join(", ");
    const placeholders = table.columns.map(() => "?").join(", ");
    const params = table.columns.map(c => row[c] ?? null);
    return {
        sql: `INSERT OR REPLACE INTO ${quoteIdent(table.name)} (${cols}) VALUES (${placeholders})`,
        params,
    };
}
