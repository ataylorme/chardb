/**
 * `defineLedger` — opt-in event-sourced tables.
 *
 * Reads and inserts use standard Drizzle; `db.update` / `db.delete` are
 * compile-time errors via the branded return type, and the runtime layer
 * refuses them at the wrapper.
 *
 * The Merkle hash chain is default-on: every row carries `_chardb_prev_hash`
 * and `_chardb_row_hash`, with
 * `_chardb_row_hash = sha256(prev_hash || canonical_row_bytes)`. Reads verify
 * the chain on the fly; `chardb ledger root <table>` exposes the latest root
 * for off-platform attestation.
 *
 * `logpush.destination` accepts any of the destinations Cloudflare Logpush
 * supports — see
 * https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/.
 */

import type { Brand } from "../types.ts";
import { attachRef } from "./refs.ts";

export interface LedgerOptions {
    readonly encryptedColumns?: readonly string[];
    readonly hashChain?: boolean;
    readonly logpush?: { readonly destination: string };
}

/** Branded so direct update/delete on the table object is impossible at type-level. */
export type LedgerTable<TName extends string, TColumns> = TColumns & {
    readonly __chardbLedger: TName;
    readonly __chardbHashChain: boolean;
    readonly __chardbRef: Brand<string, "ChardbRef">;
    readonly __chardbKind: "ledger";
};

/**
 * Define an append-only ledger. Returns a Drizzle-compatible table object
 * adorned with chardb metadata; type system guards against mutations.
 *
 * NB: this skeleton uses the column map directly to keep the foundation
 * layer free of a hard dependency on Drizzle's table builder; the
 * `chardb/drizzle` package adapts it to `sqliteTable` at build time.
 */
export function defineLedger<TName extends string, TColumns extends Record<string, unknown>>(
    name: TName,
    columns: TColumns,
    options: LedgerOptions = {}
): LedgerTable<TName, TColumns> {
    const handle = { ...columns, __chardbLedger: name, __chardbHashChain: options.hashChain ?? true };
    return attachRef(handle, "ledger", `ledger#${name}`) as unknown as LedgerTable<TName, TColumns>;
}
