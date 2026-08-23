/**
 * `GsiShard` DO. One fleet per `defineGsi(...)` declaration.
 *
 * Hash-partitioned on the GSI columns. Per-shard wrapper appends
 * `(rowId, basePartitionKey, indexedValues, op)` to a Cloudflare Queue on
 * every base-table write; a Queue consumer fans out to GsiShard DOs.
 */

import { DurableObject } from "cloudflare:workers";
import { adaptSqlStorage } from "./sql_adapter.ts";

const GSI_DDL = `
CREATE TABLE IF NOT EXISTS _gsi_entry (
  index_value   TEXT NOT NULL,
  row_id        TEXT NOT NULL,
  base_pk       TEXT NOT NULL,
  applied_at    INTEGER NOT NULL,
  PRIMARY KEY (index_value, row_id)
);
CREATE INDEX IF NOT EXISTS idx_gsi_value ON _gsi_entry (index_value);
` as const;

export type GsiShardEnv = Record<string, never>;

export class GsiShard extends DurableObject<GsiShardEnv> {
    private bootstrapped = false;

    constructor(state: DurableObjectState, env: GsiShardEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    private bootstrap(): void {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        for (const stmt of GSI_DDL.split(";")
            .map(s => s.trim())
            .filter(Boolean))
            sql.exec(stmt);
        this.bootstrapped = true;
    }

    async apply(events: { rowId: string; basePk: string; indexValue: string; op: "put" | "del" }[]): Promise<void> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
            for (const e of events) {
                if (e.op === "put") {
                    sql.exec(
                        `INSERT INTO _gsi_entry (index_value, row_id, base_pk, applied_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(index_value, row_id) DO UPDATE SET base_pk = excluded.base_pk, applied_at = excluded.applied_at`,
                        e.indexValue,
                        e.rowId,
                        e.basePk,
                        now
                    );
                } else {
                    sql.exec("DELETE FROM _gsi_entry WHERE index_value = ? AND row_id = ?", e.indexValue, e.rowId);
                }
            }
        });
    }

    async lookup(indexValue: string): Promise<{ rowId: string; basePk: string }[]> {
        const out: { rowId: string; basePk: string }[] = [];
        const cur = this.ctx.storage.sql.exec<{ row_id: string; base_pk: string }>(
            "SELECT row_id, base_pk FROM _gsi_entry WHERE index_value = ?",
            indexValue
        );
        for (const r of cur) out.push({ rowId: r.row_id, basePk: r.base_pk });
        return out;
    }
}
