/**
 * Logpush job spec for ledger tables.
 *
 * `defineLedger({ logpush: { destination } })` declares intent only; the
 * actual job is provisioned by `chardb deploy` against the Cloudflare Logpush
 * API. This module renders the descriptor and payload schema that the
 * deployer hands to the API call (see
 * https://developers.cloudflare.com/api/operations/logpush-jobs-list-logpush-jobs).
 *
 * The payload schema mirrors the columns of the ledger row plus the
 * `_chardb_prev_hash` / `_chardb_row_hash` chain fields, encoded as a
 * Logpush-friendly NDJSON record. Hash-chain fields appear regardless of
 * whether the underlying table opted out of the chain so downstream
 * verifiers can rely on a single shape.
 */

import type { LedgerOptions, LedgerTable } from "./ledger.ts";

export interface LogpushFieldDescriptor {
    readonly name: string;
    readonly source: "row" | "chardb";
    readonly drizzleColumnKey?: string;
}

export interface LogpushJobSpec {
    readonly tableName: string;
    readonly destination: string;
    readonly dataset: "chardb_ledger";
    readonly outputFormat: "ndjson";
    readonly fields: readonly LogpushFieldDescriptor[];
    readonly hashChain: boolean;
}

const CHARDB_FIELDS: readonly LogpushFieldDescriptor[] = [
    { name: "_chardb_prev_hash", source: "chardb" },
    { name: "_chardb_row_hash", source: "chardb" },
    { name: "_chardb_ts", source: "chardb" },
    { name: "_chardb_op_id", source: "chardb" },
];

const RESERVED = new Set(["__chardbLedger", "__chardbHashChain", "__chardbRef", "__chardbKind"]);

/**
 * Render a `LogpushJobSpec` for a `defineLedger` handle. Returns `null` when
 * the ledger did not request a Logpush destination — `chardb deploy` skips
 * it without making a Logpush API call.
 */
export function renderLedgerLogpush<TName extends string, TColumns>(
    ledger: LedgerTable<TName, TColumns>,
    options: LedgerOptions
): LogpushJobSpec | null {
    if (!options.logpush) return null;
    const fields: LogpushFieldDescriptor[] = [];
    for (const key of Object.keys(ledger as Record<string, unknown>)) {
        if (RESERVED.has(key)) continue;
        fields.push({ name: key, source: "row", drizzleColumnKey: key });
    }
    for (const f of CHARDB_FIELDS) fields.push(f);
    return {
        tableName: ledger.__chardbLedger,
        destination: options.logpush.destination,
        dataset: "chardb_ledger",
        outputFormat: "ndjson",
        fields,
        hashChain: ledger.__chardbHashChain,
    };
}

/**
 * Serialize a row to its NDJSON payload as it would be shipped to Logpush.
 * Columns are projected in the order produced by `renderLedgerLogpush` so the
 * NDJSON schema is stable against accidental column reorderings.
 */
export function renderLedgerPayload(spec: LogpushJobSpec, row: Record<string, unknown>): string {
    const out: Record<string, unknown> = {};
    for (const f of spec.fields) out[f.name] = row[f.drizzleColumnKey ?? f.name] ?? null;
    return JSON.stringify(out);
}

/**
 * Render the body of a `POST /accounts/:id/logpush/jobs` request for a ledger
 * spec. The Cloudflare Logpush API expects a JSON object whose `output_options`
 * field selects the NDJSON projection, and `dataset` plus `destination_conf`
 * fields select where the rows land. See
 * https://developers.cloudflare.com/api/operations/logpush-jobs-create-logpush-job
 * for the full schema. Callers (e.g. `chardb deploy`) wrap this in their HTTP
 * client; the renderer is pure so it stays trivially testable.
 */
export function renderLogpushJobRequest(spec: LogpushJobSpec): {
    readonly name: string;
    readonly dataset: string;
    readonly destination_conf: string;
    readonly enabled: boolean;
    readonly output_options: {
        readonly field_names: readonly string[];
        readonly output_type: "ndjson";
    };
} {
    return {
        name: `chardb_ledger_${spec.tableName}`,
        dataset: spec.dataset,
        destination_conf: spec.destination,
        enabled: true,
        output_options: {
            field_names: spec.fields.map(f => f.name),
            output_type: "ndjson",
        },
    };
}
