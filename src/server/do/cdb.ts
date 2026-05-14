/**
 * `Cdb` shard DO.
 *
 * Owns one slice of vshards on its SQLite database. All single-partition
 * mutations land here; the op-log wrapper provides at-most-once semantics
 * dedup ledger atomically with each base mutation.
 *
 * This class is a thin runtime over the pure helpers in `chardb/oplog` and
 * `chardb/intervals`. The real exec happens on workerd
 * (https://developers.cloudflare.com/durable-objects/api/sql-storage/);
 * locally the class compiles but is exercised by integration tests under
 * wrangler/miniflare.
 */

import { DurableObject } from "cloudflare:workers";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { authCreate, authDelete, authFindMany, authFindOne, authUpdate } from "../../auth/sql.ts";
import { getAuthRuntime, tableFor } from "../../auth/runtime.ts";
import { type IntervalKey, IntervalMap, type IntervalSet } from "../../intervals.ts";
import { intervalSetFromWire } from "../../intervals_wire.ts";
import { SHARD_BOOTSTRAP_DDL } from "../../oplog/schema.ts";
import {
    type JsonText,
    type MutationOutcome,
    canonicalRequest,
    parseJsonColumn,
    runWrappedMutation,
} from "../../oplog/wrapper.ts";
import { type RangeFilter, filterRowsInRange, inRange } from "../../reshard/range.ts";
import { type TableSpec, renderRowApply, renderTableTriggers } from "../../reshard/triggers.ts";
import { Cookie, MutId, type PrincipalId, type RawJson, SubId } from "../../types.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

export interface CdbEnv {
    readonly CDB_R2?: unknown;
    readonly CDB_VECTORIZE?: unknown;
}

export interface SubscribeArgs {
    readonly subId: number;
    readonly principalId: PrincipalId;
    readonly tables: readonly string[];
    readonly intervals: readonly {
        readonly table: string;
        readonly indexName: string;
        readonly intervals: readonly import("../../wire.ts").WireInterval[];
    }[];
}

export interface MutateArgs {
    readonly principalId: PrincipalId;
    readonly mutId: string;
    readonly ref: string;
    readonly args: RawJson;
    readonly schemaEpoch: number;
}

/**
 * Cdb shard. Bound as `class_name = "Cdb"` in wrangler.jsonc.
 */
export class Cdb extends DurableObject<CdbEnv> {
    private readonly intervalMap = new IntervalMap<number>();
    private bootstrapped = false;

    constructor(state: DurableObjectState, env: CdbEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    private async bootstrap(): Promise<void> {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        for (const stmt of SHARD_BOOTSTRAP_DDL.split(";")
            .map(s => s.trim())
            .filter(Boolean)) {
            sql.exec(stmt);
        }
        this.ensureAuthTables();
        this.bootstrapped = true;
    }

    /**
     * Materialize per-shard SQLite tables for every non-replicated auth
     * model. Shard-pinned tables (`user`, `session`, `member`, …) carry
     * only the rows whose partition column hashes into this shard's
     * vshard range; the chardb adapter is responsible for routing each
     * write to the right shard before invoking `mutateAuth`. Replicated
     * models are skipped here — they live on the Catalog DO.
     */
    private ensureAuthTables(): void {
        let runtime;
        try {
            runtime = getAuthRuntime();
        } catch {
            return;
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        for (const [model, rule] of runtime.placement) {
            if (rule.kind === "replicated") continue;
            const table = runtime.schema[model as keyof typeof runtime.schema];
            if (!table) continue;
            const cfg = getTableConfig(table);
            const cols = cfg.columns
                .map(c => {
                    const sqlType = renderColumnTypeForShard(c);
                    const notNull = c.notNull ? " NOT NULL" : "";
                    const pk = c.primary ? " PRIMARY KEY" : "";
                    return `"${c.name}" ${sqlType}${pk}${notNull}`;
                })
                .join(", ");
            sql.exec(`CREATE TABLE IF NOT EXISTS "${cfg.name}" (${cols})`);
        }
    }

    /**
     * Register a live-query subscription on this shard. Caller is the Gateway DO.
     */
    async subscribe(args: SubscribeArgs): Promise<{ subId: number }> {
        for (const block of args.intervals) {
            const set = intervalSetFromWire(block.intervals);
            this.intervalMap.register(args.subId, block.table, block.indexName, set);
        }
        return { subId: args.subId };
    }

    async unsubscribe(subId: number): Promise<void> {
        this.intervalMap.unregister(subId);
    }

    /**
     * Run a mutation under the op-log wrapper inside `transactionSync`.
     * `runner` is the user closure; chardb passes the partition-pinned db handle.
     */
    async mutate<R>(
        args: MutateArgs,
        runner: () => MutationOutcome<R>
    ): Promise<{
        cookie: Cookie;
        ran: boolean;
        result: MutationOutcome<R>;
    }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const cookie = Cookie(`${this.ctx.id.toString()}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
        let outcome!: MutationOutcome<R>;
        this.ctx.storage.transactionSync(() => {
            const r = runWrappedMutation({
                sql,
                principalId: args.principalId,
                mutId: MutId(args.mutId),
                canonicalRequest: canonicalRequest(args.ref, args.args),
                schemaEpoch: args.schemaEpoch,
                nowMs: Date.now(),
                cookie,
                run: () => runner(),
            });
            outcome =
                r.envelope.status === "ok"
                    ? ({
                          status: "ok",
                          result: r.envelope.returning?.[0] ?? null,
                          rowsAffected: r.envelope.rowsAffected,
                          ...(r.envelope.lastInsertRowid !== undefined
                              ? { lastInsertRowid: r.envelope.lastInsertRowid }
                              : {}),
                          ...(r.envelope.returning ? { returning: r.envelope.returning } : {}),
                      } as MutationOutcome<R>)
                    : ({
                          status: "user_error",
                          errorCode: r.envelope.errorCode ?? "CDB_FORBIDDEN",
                          errorMessage: r.envelope.errorMessage ?? "user_error",
                      } as MutationOutcome<R>);
            // The result of `r.ran` flows back via outer closure variable.
            (outcome as { ran?: boolean }).ran = r.ran;
        });
        return { cookie, ran: (outcome as { ran?: boolean }).ran ?? false, result: outcome };
    }

    /**
     * Project a committed row through every registered index and return the
     * affected sub ids. Used by the Gateway to coalesce pokes.
     */
    matchSubsForRow(table: string, indexedKeys: { indexName: string; key: IntervalKey }[]): number[] {
        const hits = new Set<number>();
        for (const { indexName, key } of indexedKeys) {
            for (const sub of this.intervalMap.match(table, indexName, key)) hits.add(sub);
        }
        return [...hits];
    }

    /**
     * Snapshot the current op-log row id. The Catalog records this as the
     * shard's bookmark for an open barrier, giving every barrier a per-shard
     * coordinate that PITR restore can replay forward to.
     */
    /**
     * Source-side begin: records the migration in `_chardb_split_state` and
     * installs `AFTER INSERT/UPDATE/DELETE` triggers on each migrating table
     * that project changes into `_chardb_split_log`. The destination later
     * replays those rows in LSN order, filtering by `vshardOf(partition_key)`
     * so peer migrations on the same source don't cross-pollute. Triggers are
     * `IF NOT EXISTS`, so re-entry after a crash is idempotent.
     */
    async beginReshardSource(args: {
        migId: string;
        rangeLo: number;
        rangeHi: number;
        tables: readonly TableSpec[];
    }): Promise<{ enabled: boolean; triggersInstalled: number }> {
        let triggers = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `INSERT INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
         VALUES (?, ?, ?, 'source', 1, ?)
         ON CONFLICT(mig_id) DO UPDATE SET capture = 1, updated_at = excluded.updated_at`,
                args.migId,
                args.rangeLo,
                args.rangeHi,
                Date.now()
            );
            for (const t of args.tables) {
                const ts = renderTableTriggers(args.migId, t);
                for (const stmt of ts.install) {
                    sql.exec(stmt);
                    triggers++;
                }
            }
        });
        return { enabled: true, triggersInstalled: triggers };
    }

    /** Destination-shard counterpart; tracks the migration so duplicate applies are rejected. */
    async beginReshardDest(args: {
        migId: string;
        rangeLo: number;
        rangeHi: number;
    }): Promise<{ ready: boolean }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT OR IGNORE INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
       VALUES (?, ?, ?, 'dest', 0, ?)`,
            args.migId,
            args.rangeLo,
            args.rangeHi,
            Date.now()
        );
        return { ready: true };
    }

    /** Returns the tail-capture watermark — the latest `_chardb_split_log.lsn` Source has produced. */
    async tailWatermark(migId: string): Promise<{ lsn: number }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ max_lsn: number | null }>(
            "SELECT MAX(lsn) AS max_lsn FROM _chardb_split_log WHERE mig_id = ?",
            migId
        );
        return { lsn: row?.max_lsn ?? 0 };
    }

    /**
     * Read one paginated bulk-copy batch from this (source) shard. The batch
     * contains rows whose partition column hashes into `[lo, hi]`; the caller
     * pages by `afterRowid` until `done=true`. Rows are returned as plain
     * column maps so the destination can reuse `renderRowApply`.
     */
    async bulkCopyBatch(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        afterRowid: number;
        limit: number;
    }): Promise<{ rows: readonly Record<string, RawJson>[]; lastRowid: number; done: boolean }> {
        const ident = quoteIdent(args.table.name);
        const cols = args.table.columns.map(quoteIdent).join(", ");
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const raw = sql.all<Record<string, RawJson> & { rowid: number }>(
            `SELECT rowid, ${cols} FROM ${ident} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            args.afterRowid,
            args.limit
        );
        const rows = filterRowsInRange(raw, args.table.partitionColumn, args.range);
        const lastRowid = raw.length > 0 ? raw[raw.length - 1]!.rowid : args.afterRowid;
        const done = raw.length < args.limit;
        return { rows, lastRowid, done };
    }

    /**
     * Apply a bulk-copy batch on this (destination) shard. Each row is filtered
     * by `vshardOf(partition_key) ∈ range` defensively so a misrouted batch
     * cannot corrupt non-migrating data, then upserted via `INSERT OR REPLACE`.
     * The whole batch runs in a single `transactionSync` to keep destination
     * state consistent against retries.
     */
    async applyBulkBatch(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        rows: readonly Record<string, RawJson>[];
    }): Promise<{ applied: number; skipped: number }> {
        const accepted = filterRowsInRange(args.rows, args.table.partitionColumn, args.range);
        const skipped = args.rows.length - accepted.length;
        let applied = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const r of accepted) {
                const { sql: stmt, params } = renderRowApply(args.table, r);
                sql.exec(stmt, ...(params as readonly (string | number | bigint | Uint8Array | null)[]));
                applied++;
            }
        });
        return { applied, skipped };
    }

    /**
     * Drain the source's `_chardb_split_log` for a migration. The returned rows
     * are ordered by `lsn` and bounded by `limit`; the destination applies them
     * via `applyTailBatch`. The split log is preserved on the source until
     * `finishReshardSource` so a crash mid-replay can resume.
     */
    async readTailBatch(args: {
        migId: string;
        afterLsn: number;
        limit: number;
    }): Promise<{
        entries: readonly TailEntry[];
        lastLsn: number;
        done: boolean;
    }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const entries = sql.all<TailEntry>(
            "SELECT lsn, op, table_name, pk, after, before FROM _chardb_split_log WHERE mig_id = ? AND lsn > ? ORDER BY lsn LIMIT ?",
            args.migId,
            args.afterLsn,
            args.limit
        );
        const lastLsn = entries.length > 0 ? entries[entries.length - 1]!.lsn : args.afterLsn;
        const done = entries.length < args.limit;
        return { entries, lastLsn, done };
    }

    /**
     * Apply a tail batch on the destination. `ins`/`upd` decode `after` (a
     * trigger-emitted JSON object) and upsert; `del` deletes by partition
     * column = `pk`. Range-filtered defensively as in `applyBulkBatch`.
     */
    async applyTailBatch(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        entries: readonly TailEntry[];
    }): Promise<{ applied: number; lastLsn: number }> {
        let applied = 0;
        let lastLsn = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const e of args.entries) {
                lastLsn = e.lsn;
                const pk = parseScalarPk(e.pk);
                if (!isPkInRange(pk, args.range)) continue;
                if (e.op === "del") {
                    sql.exec(
                        `DELETE FROM ${quoteIdent(args.table.name)} WHERE ${quoteIdent(args.table.partitionColumn)} = ?`,
                        pk
                    );
                } else {
                    const row = parseJsonColumn("after", e.after);
                    if (!row) continue;
                    const { sql: stmt, params } = renderRowApply(args.table, row);
                    sql.exec(stmt, ...(params as readonly (string | number | bigint | Uint8Array | null)[]));
                }
                applied++;
            }
            sql.exec(
                "UPDATE _chardb_split_state SET applied_lsn = MAX(applied_lsn, ?), updated_at = ? WHERE mig_id = ?",
                lastLsn,
                Date.now(),
                args.migId
            );
        });
        return { applied, lastLsn };
    }

    /**
     * Post-cutover, delete the migrated rows from the source and tear down
     * the per-table triggers + the split-state record. Idempotent: a
     * re-entry deletes nothing because the destination already owns the
     * migrated keys via the new range table.
     */
    async dropMigratedRange(args: {
        migId: string;
        table: TableSpec;
        range: RangeFilter;
        batchSize: number;
    }): Promise<{ deleted: number; done: boolean }> {
        const ident = quoteIdent(args.table.name);
        const pkCol = quoteIdent(args.table.partitionColumn);
        let deleted = 0;
        let done = true;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const rows = sql.all<{ rowid: number; pk: RawJson }>(
                `SELECT rowid, ${pkCol} AS pk FROM ${ident} ORDER BY rowid LIMIT ?`,
                args.batchSize
            );
            const candidates: number[] = [];
            for (const r of rows) {
                if (isPkInRange(r.pk, args.range)) candidates.push(r.rowid);
            }
            for (const rid of candidates) {
                sql.exec(`DELETE FROM ${ident} WHERE rowid = ?`, rid);
                deleted++;
            }
            done = rows.length < args.batchSize;
        });
        return { deleted, done };
    }

    /**
     * Tear down the per-migration triggers and mark the split-state row as
     * drained. After this call the source is clean of all migration artifacts.
     */
    async finishReshardSource(args: { migId: string; tables: readonly TableSpec[] }): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const t of args.tables) {
                const ts = renderTableTriggers(args.migId, t);
                for (const stmt of ts.uninstall) sql.exec(stmt);
            }
            sql.exec(
                "UPDATE _chardb_split_state SET capture = 0, drained = 1, updated_at = ? WHERE mig_id = ?",
                Date.now(),
                args.migId
            );
            sql.exec("DELETE FROM _chardb_split_log WHERE mig_id = ?", args.migId);
        });
    }

    async barrierBookmark(): Promise<number> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ max_id: number | null }>("SELECT MAX(rowid) AS max_id FROM _chardb_op_log");
        return row?.max_id ?? 0;
    }

    /**
     * Run a chardb-native better-auth adapter write against the synthesized
     * auth schema bound at module init. Wrapped in `transactionSync` so the
     * row write and any side effects (op-log idempotency, in future patches
     * also auth-epoch bumps) commit atomically.
     *
     * `op` switches over the four model-store ops the better-auth
     * `DbAdapterContract` requires: create / update / delete / findOne.
     * The `model` is the better-auth model name (e.g. `"session"`),
     * resolved via `tableFor(model)` against the auth runtime binding.
     */
    async mutateAuth(args: {
        readonly model: string;
        readonly op: "create" | "update" | "delete";
        readonly where?: { readonly [k: string]: RawJson };
        readonly payload?: { readonly [k: string]: RawJson };
    }): Promise<{
        readonly ok: true;
        readonly row?: Record<string, RawJson> | null;
        readonly affected?: number;
    }> {
        await this.bootstrap();
        const table = tableFor(args.model);
        let row: Record<string, RawJson> | null | undefined;
        let affected = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            switch (args.op) {
                case "create":
                    if (!args.payload) throw new Error("auth: create requires payload");
                    row = authCreate(sql, table, args.payload);
                    affected = 1;
                    break;
                case "update": {
                    if (!args.where || !args.payload) {
                        throw new Error("auth: update requires where and payload");
                    }
                    const r = authUpdate(sql, table, args.where, args.payload);
                    row = r.row;
                    affected = r.affected;
                    break;
                }
                case "delete":
                    if (!args.where) throw new Error("auth: delete requires where");
                    affected = authDelete(sql, table, args.where).affected;
                    break;
            }
        });
        return { ok: true, row: row ?? null, affected };
    }

    /**
     * Read auth-table rows. PK / unique-column lookups are routed by the
     * adapter to the partition-owning shard; cross-shard secondary lookups
     * go via the GsiShard DO instead. `limit: 1` short-circuits to a single
     * `LIMIT 1` query.
     */
    async queryAuth(args: {
        readonly model: string;
        readonly where: { readonly [k: string]: RawJson };
        readonly limit?: number;
    }): Promise<readonly Record<string, RawJson>[]> {
        await this.bootstrap();
        const table = tableFor(args.model);
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        if (args.limit === 1) {
            const one = authFindOne(sql, table, args.where);
            return one ? [one] : [];
        }
        return authFindMany(sql, table, args.where, args.limit);
    }
}

export type { IntervalSet, IntervalKey };
export { SubId };

export interface TailEntry {
    lsn: number;
    op: "ins" | "upd" | "del";
    table_name: string;
    pk: string;
    /** `json_object(...)` of the post-image; `null` for `del` ops. */
    after: JsonText | null;
    /** `json_object(...)` of the pre-image (currently only set for `del`). */
    before: JsonText | null;
}

const ALLOWED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function quoteIdent(raw: string): string {
    if (!ALLOWED_IDENT.test(raw)) throw new Error(`reshard: refusing identifier: ${raw}`);
    return `"${raw}"`;
}

function renderColumnTypeForShard(col: { dataType: string }): string {
    switch (col.dataType) {
        case "number":
        case "boolean":
        case "bigint":
        case "date":
            return "INTEGER";
        case "buffer":
            return "BLOB";
        default:
            return "TEXT";
    }
}

function parseScalarPk(s: string): string | number {
    const n = Number(s);
    if (s !== "" && Number.isFinite(n) && String(n) === s) return n;
    return s;
}

function isPkInRange(value: unknown, range: RangeFilter): boolean {
    return inRange(value, range);
}
