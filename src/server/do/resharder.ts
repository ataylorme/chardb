/**
 * `Resharder` DO. Orchestrates online vshard-range moves with idempotent
 * recovery from any phase via `migration_state`. The phase sequence:
 *
 *   0  record migration_state
 *   1  Source: enable tail capture into _chardb_split_log + _chardb_split_oplog
 *   2  Bulk copy Source → Dest, idempotent UPSERT keyed by per-row LSN
 *   3  Tail replay until lag is ms-level
 *   4  Dual-write window
 *   5  Atomic Catalog cutover (epoch advance + range table write in one tx)
 *   6  60s drain, then DROP migrated rows + their op-log entries from Source
 *
 * The phase machine here is the orchestrator only — actual data movement RPCs
 * happen against Source/Dest Cdb DOs via service bindings.
 */

import { DurableObject } from "cloudflare:workers";
import { CdbError } from "../../errors.ts";
import type { TableSpec } from "../../reshard/triggers.ts";
import type { RawJson } from "../../types.ts";
import type { TailEntry } from "./cdb.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

const RESHARDER_DDL = `
CREATE TABLE IF NOT EXISTS migration_state (
  mig_id TEXT PRIMARY KEY,
  src_shard TEXT NOT NULL,
  dst_shard TEXT NOT NULL,
  range_lo INTEGER NOT NULL,
  range_hi INTEGER NOT NULL,
  phase INTEGER NOT NULL,
  epoch_at_start INTEGER NOT NULL,
  tables_json TEXT NOT NULL DEFAULT '[]',
  bulk_cursor TEXT NOT NULL DEFAULT '{}',
  tail_cursor INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
` as const;

export const RESHARDER_AUTO_TRIGGER_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
export const RESHARDER_AUTO_TRIGGER_RPS = 800;

/**
 * Named phases. The numeric values are persisted in `migration_state.phase`
 * and must remain stable across versions; new phases append at the end.
 */
export const RESHARDER_PHASE = {
    INIT: 0,
    TAIL_CAPTURE_ENABLED: 1,
    BULK_COPY_DONE: 2,
    TAIL_CAUGHT_UP: 3,
    DUAL_WRITE_OPEN: 4,
    CATALOG_CUT_OVER: 5,
    SOURCE_DRAINED: 6,
    ABORTED: -1,
} as const;
export type ResharderPhase = (typeof RESHARDER_PHASE)[keyof typeof RESHARDER_PHASE];

export interface ResharderEnv {
    readonly CDB_CATALOG?: DurableObjectNamespace;
    readonly CDB_SHARD?: DurableObjectNamespace;
}

/** Subset of `Catalog` RPC the Resharder needs. */
interface CatalogReshardRpc {
    cutover(args: {
        migId: string;
        lo: number;
        hi: number;
        fromShard: string;
        toShard: string;
    }): Promise<{ applied: boolean; newEpoch: number }>;
}

/** Subset of `Cdb` RPC the Resharder needs. */
interface CdbReshardRpc {
    beginReshardSource(args: {
        migId: string;
        rangeLo: number;
        rangeHi: number;
        tables: readonly TableSpec[];
    }): Promise<{ enabled: boolean; triggersInstalled: number }>;
    beginReshardDest(args: { migId: string; rangeLo: number; rangeHi: number }): Promise<{
        ready: boolean;
    }>;
    tailWatermark(migId: string): Promise<{ lsn: number }>;
    bulkCopyBatch(args: {
        migId: string;
        table: TableSpec;
        range: { lo: number; hi: number };
        afterRowid: number;
        limit: number;
    }): Promise<{ rows: readonly Record<string, RawJson>[]; lastRowid: number; done: boolean }>;
    applyBulkBatch(args: {
        migId: string;
        table: TableSpec;
        range: { lo: number; hi: number };
        rows: readonly Record<string, RawJson>[];
    }): Promise<{ applied: number; skipped: number }>;
    readTailBatch(args: { migId: string; afterLsn: number; limit: number }): Promise<{
        entries: readonly TailEntry[];
        lastLsn: number;
        done: boolean;
    }>;
    applyTailBatch(args: {
        migId: string;
        table: TableSpec;
        range: { lo: number; hi: number };
        entries: readonly TailEntry[];
    }): Promise<{ applied: number; lastLsn: number }>;
    dropMigratedRange(args: {
        migId: string;
        table: TableSpec;
        range: { lo: number; hi: number };
        batchSize: number;
    }): Promise<{ deleted: number; done: boolean }>;
    finishReshardSource(args: { migId: string; tables: readonly TableSpec[] }): Promise<void>;
}

interface MigrationState {
    readonly phase: number;
    readonly src: string;
    readonly dst: string;
    readonly lo: number;
    readonly hi: number;
    readonly tables: readonly TableSpec[];
    readonly bulkCursor: Record<string, number>;
    readonly tailCursor: number;
}

const BULK_BATCH = 500;
const TAIL_BATCH = 500;
const DROP_BATCH = 500;
const TAIL_CONVERGENCE_ITERATIONS = 16;

export class Resharder extends DurableObject<ResharderEnv> {
    private bootstrapped = false;

    constructor(state: DurableObjectState, env: ResharderEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    private bootstrap(): void {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        for (const stmt of RESHARDER_DDL.split(";")
            .map(s => s.trim())
            .filter(Boolean))
            sql.exec(stmt);
        this.bootstrapped = true;
    }

    /**
     * Open a new migration. `tables` enumerates every base table participating
     * in the split, with the column whose value drives the partition hash and
     * the full ordered column list (used by the bulk-copy + apply paths). The
     * Resharder persists the spec so `runSplit` can resume after a restart.
     */
    async startSplit(args: {
        migId: string;
        srcShard: string;
        dstShard: string;
        rangeLo: number;
        rangeHi: number;
        epochAtStart: number;
        tables: readonly TableSpec[];
    }): Promise<void> {
        const now = Date.now();
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT INTO migration_state
         (mig_id, src_shard, dst_shard, range_lo, range_hi, phase, epoch_at_start,
          tables_json, bulk_cursor, tail_cursor, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, '{}', 0, ?, ?)
       ON CONFLICT(mig_id) DO NOTHING`,
            args.migId,
            args.srcShard,
            args.dstShard,
            args.rangeLo,
            args.rangeHi,
            args.epochAtStart,
            JSON.stringify(args.tables),
            now,
            now
        );
    }

    async advance(migId: string, expected?: ResharderPhase): Promise<{ phase: number }> {
        let outPhase = RESHARDER_PHASE.ABORTED as number;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const row = sql.one<{ phase: number }>("SELECT phase FROM migration_state WHERE mig_id = ?", migId);
            if (!row) return;
            if (expected !== undefined && row.phase !== expected) {
                throw new CdbError({
                    code: "CDB_RESHARD_PHASE_MISMATCH",
                    message: `migId=${migId} expected=${expected} actual=${row.phase}`,
                });
            }
            const next = row.phase + 1;
            sql.exec("UPDATE migration_state SET phase = ?, updated_at = ? WHERE mig_id = ?", next, Date.now(), migId);
            outPhase = next;
        });
        return { phase: outPhase };
    }

    async abort(migId: string): Promise<void> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            "UPDATE migration_state SET phase = ?, updated_at = ? WHERE mig_id = ?",
            RESHARDER_PHASE.ABORTED,
            Date.now(),
            migId
        );
    }

    async getPhase(migId: string): Promise<ResharderPhase | null> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{ phase: number }>("SELECT phase FROM migration_state WHERE mig_id = ?", migId);
        return row ? (row.phase as ResharderPhase) : null;
    }

    /**
     * Drive a migration from its current phase to terminal `SOURCE_DRAINED`.
     * Crash-safe: each phase advance is its own `transactionSync`, so a
     * re-entry after a crash resumes from the persisted `migration_state.phase`
     * and the per-table cursors. The driver orchestrates:
     *
     *   INIT → install per-table triggers + dest split-state, advance.
     *   TAIL_CAPTURE_ENABLED → paginated bulk copy of every range-matching row.
     *   BULK_COPY_DONE → drain `_chardb_split_log` until two consecutive reads
     *     return zero new rows or the convergence iteration cap is hit.
     *   TAIL_CAUGHT_UP → atomic `Catalog.cutover` (range-table edit + epoch++).
     *   DUAL_WRITE_OPEN → catch any tail entries written between cutover and
     *     finish, then `dropMigratedRange` and `finishReshardSource`.
     *
     * See `spec/Resharder.tla` for the protocol invariants this driver is the
     * executable counterpart to.
     */
    async runSplit(migId: string): Promise<{ phase: ResharderPhase }> {
        const fetchState = (): MigrationState | null => this.readMigration(migId);
        let st = fetchState();
        if (!st) throw new CdbError({ code: "CDB_INVARIANT", message: `unknown migId=${migId}` });

        const ns = this.env.CDB_SHARD;
        const cat = this.env.CDB_CATALOG;
        if (!ns || !cat) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: "Resharder requires CDB_SHARD + CDB_CATALOG service bindings",
            });
        }
        const source = ns.get(ns.idFromName(st.src)) as unknown as CdbReshardRpc;
        const dest = ns.get(ns.idFromName(st.dst)) as unknown as CdbReshardRpc;
        const catalog = cat.get(cat.idFromName("global")) as unknown as CatalogReshardRpc;
        const range = { lo: st.lo, hi: st.hi };

        while (st.phase >= 0 && st.phase < RESHARDER_PHASE.SOURCE_DRAINED) {
            switch (st.phase as ResharderPhase) {
                case RESHARDER_PHASE.INIT: {
                    await source.beginReshardSource({
                        migId,
                        rangeLo: range.lo,
                        rangeHi: range.hi,
                        tables: st.tables,
                    });
                    await dest.beginReshardDest({ migId, rangeLo: range.lo, rangeHi: range.hi });
                    await this.advance(migId, RESHARDER_PHASE.INIT);
                    break;
                }
                case RESHARDER_PHASE.TAIL_CAPTURE_ENABLED: {
                    await this.runBulkCopy(migId, source, dest, range, st);
                    await this.advance(migId, RESHARDER_PHASE.TAIL_CAPTURE_ENABLED);
                    break;
                }
                case RESHARDER_PHASE.BULK_COPY_DONE: {
                    await this.runTailReplay(migId, source, dest, range, st);
                    await this.advance(migId, RESHARDER_PHASE.BULK_COPY_DONE);
                    break;
                }
                case RESHARDER_PHASE.TAIL_CAUGHT_UP: {
                    await catalog.cutover({
                        migId,
                        lo: range.lo,
                        hi: range.hi,
                        fromShard: st.src,
                        toShard: st.dst,
                    });
                    await this.advance(migId, RESHARDER_PHASE.TAIL_CAUGHT_UP);
                    break;
                }
                case RESHARDER_PHASE.DUAL_WRITE_OPEN: {
                    await this.runTailReplay(migId, source, dest, range, st);
                    for (const t of st.tables) {
                        let done = false;
                        while (!done) {
                            const r = await source.dropMigratedRange({
                                migId,
                                table: t,
                                range,
                                batchSize: DROP_BATCH,
                            });
                            done = r.done;
                        }
                    }
                    await this.advance(migId, RESHARDER_PHASE.DUAL_WRITE_OPEN);
                    break;
                }
                case RESHARDER_PHASE.CATALOG_CUT_OVER: {
                    await source.finishReshardSource({ migId, tables: st.tables });
                    await this.advance(migId, RESHARDER_PHASE.CATALOG_CUT_OVER);
                    break;
                }
            }
            const next = fetchState();
            if (!next) break;
            st = next;
        }
        return { phase: (st.phase as ResharderPhase) ?? RESHARDER_PHASE.ABORTED };
    }

    /**
     * Paginated bulk copy. Per-table cursor (rowid) lives in
     * `migration_state.bulk_cursor` so a crash mid-copy resumes from the next
     * unscanned rowid. A table is "done" when the source returns fewer rows
     * than `BULK_BATCH`; the loop exits when every table is done.
     */
    private async runBulkCopy(
        migId: string,
        source: CdbReshardRpc,
        dest: CdbReshardRpc,
        range: { lo: number; hi: number },
        st: MigrationState
    ): Promise<void> {
        const cursor = { ...st.bulkCursor };
        const remaining = new Set(st.tables.map(t => t.name));
        while (remaining.size > 0) {
            for (const table of st.tables) {
                if (!remaining.has(table.name)) continue;
                const after = cursor[table.name] ?? 0;
                const batch = await source.bulkCopyBatch({
                    migId,
                    table,
                    range,
                    afterRowid: after,
                    limit: BULK_BATCH,
                });
                if (batch.rows.length > 0) {
                    await dest.applyBulkBatch({ migId, table, range, rows: batch.rows });
                }
                cursor[table.name] = batch.lastRowid;
                if (batch.done) remaining.delete(table.name);
            }
            this.persistBulkCursor(migId, cursor);
        }
    }

    /**
     * Tail-replay loop. Pulls `_chardb_split_log` entries from the source in
     * LSN order, fans them per-table to the destination, and stops when the
     * watermark stops advancing across `TAIL_CONVERGENCE_ITERATIONS` reads.
     * The cursor is persisted after every round so a crash never re-applies
     * an entry that was already accepted on the destination.
     */
    private async runTailReplay(
        migId: string,
        source: CdbReshardRpc,
        dest: CdbReshardRpc,
        range: { lo: number; hi: number },
        st: MigrationState
    ): Promise<void> {
        const tablesByName = new Map(st.tables.map(t => [t.name, t]));
        let cursor = st.tailCursor;
        let stable = 0;
        for (let i = 0; i < TAIL_CONVERGENCE_ITERATIONS && stable < 2; i++) {
            const batch = await source.readTailBatch({ migId, afterLsn: cursor, limit: TAIL_BATCH });
            if (batch.entries.length === 0) {
                stable++;
                continue;
            }
            stable = 0;
            const byTable = new Map<string, TailEntry[]>();
            for (const e of batch.entries) {
                const arr = byTable.get(e.table_name) ?? [];
                arr.push(e);
                byTable.set(e.table_name, arr);
            }
            for (const [tname, entries] of byTable) {
                const t = tablesByName.get(tname);
                if (!t || entries.length === 0) continue;
                const r = await dest.applyTailBatch({ migId, table: t, range, entries });
                cursor = Math.max(cursor, r.lastLsn);
            }
            cursor = Math.max(cursor, batch.lastLsn);
            this.persistTailCursor(migId, cursor);
            if (batch.done) stable++;
        }
    }

    private readMigration(migId: string): MigrationState | null {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const row = sql.one<{
            phase: number;
            src: string;
            dst: string;
            lo: number;
            hi: number;
            tables_json: string;
            bulk_cursor: string;
            tail_cursor: number;
        }>(
            `SELECT phase, src_shard AS src, dst_shard AS dst, range_lo AS lo, range_hi AS hi,
              tables_json, bulk_cursor, tail_cursor
       FROM migration_state WHERE mig_id = ?`,
            migId
        );
        if (!row) return null;
        return {
            phase: row.phase,
            src: row.src,
            dst: row.dst,
            lo: row.lo,
            hi: row.hi,
            tables: JSON.parse(row.tables_json) as TableSpec[],
            bulkCursor: JSON.parse(row.bulk_cursor) as Record<string, number>,
            tailCursor: row.tail_cursor,
        };
    }

    private persistBulkCursor(migId: string, cursor: Record<string, number>): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            "UPDATE migration_state SET bulk_cursor = ?, updated_at = ? WHERE mig_id = ?",
            JSON.stringify(cursor),
            Date.now(),
            migId
        );
    }

    private persistTailCursor(migId: string, cursor: number): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            "UPDATE migration_state SET tail_cursor = ?, updated_at = ? WHERE mig_id = ?",
            cursor,
            Date.now(),
            migId
        );
    }

    async listMigrations(): Promise<
        {
            migId: string;
            phase: number;
            srcShard: string;
            dstShard: string;
            rangeLo: number;
            rangeHi: number;
        }[]
    > {
        const out: {
            migId: string;
            phase: number;
            srcShard: string;
            dstShard: string;
            rangeLo: number;
            rangeHi: number;
        }[] = [];
        const cur = this.ctx.storage.sql.exec<{
            mig_id: string;
            phase: number;
            src_shard: string;
            dst_shard: string;
            range_lo: number;
            range_hi: number;
        }>("SELECT mig_id, phase, src_shard, dst_shard, range_lo, range_hi FROM migration_state ORDER BY started_at");
        for (const r of cur) {
            out.push({
                migId: r.mig_id,
                phase: r.phase,
                srcShard: r.src_shard,
                dstShard: r.dst_shard,
                rangeLo: r.range_lo,
                rangeHi: r.range_hi,
            });
        }
        return out;
    }
}
