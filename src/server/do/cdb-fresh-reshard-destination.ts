import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { CDB_AUTH_INVALIDATION_SCOPE_LIMIT } from "./cdb-auth-invalidation-store.ts";

const INTERNAL_TABLE_LIMIT = 1_024;

function notFresh(subject: string): never {
    throw new CdbError({
        code: "CDB_STALE_EPOCH",
        message: `reshard destination is not fresh: ${subject} exists`,
    });
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function assertExactColumns(sql: SyncSql, tableName: string, expected: readonly string[]): void {
    const columns = sql.all<{ name: string }>(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index])) {
        notFresh(tableName);
    }
}

/**
 * Reject durable evidence by inventory instead of maintaining an allowlist
 * that becomes unsafe whenever another internal table is added.
 */
function assertFreshInternalRows(sql: SyncSql, allowDomainRegistry: boolean): void {
    const tables = sql.all<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND substr(name, 1, 8) = '_chardb_'
         ORDER BY name LIMIT ?`,
        INTERNAL_TABLE_LIMIT + 1
    );
    if (tables.length > INTERNAL_TABLE_LIMIT) notFresh("internal table inventory exceeds its fixed limit");

    for (const { name } of tables) {
        if (name === "_chardb_domain_schema" && allowDomainRegistry) continue;
        if (name === "_chardb_schema_state") {
            const rows = sql.all<Record<string, unknown>>(`SELECT * FROM ${quoteIdentifier(name)} LIMIT 2`);
            if (rows.length > 1) notFresh(name);
            continue;
        }
        if (name === "_chardb_change_clock") {
            const rows = sql.all<{ singleton: number; change_seq: number }>(
                `SELECT singleton, change_seq FROM ${quoteIdentifier(name)} LIMIT 2`
            );
            if (rows.length > 1 || (rows.length === 1 && (rows[0]?.singleton !== 1 || rows[0].change_seq !== 0))) {
                notFresh("change clock");
            }
            continue;
        }
        if (name === "_chardb_recovery_admission") {
            // Every Cdb reconciles the provider recovery clock during boot, so
            // this singleton exists before resharding can inspect a new
            // destination. An open clock is coordination metadata, not proof
            // that the shard has ever served application state.
            assertExactColumns(sql, name, ["singleton", "generation", "operation_id", "state"]);
            const rows = sql.all<{
                singleton: number;
                generation: number | bigint;
                operation_id: string | null;
                state: string;
            }>(`SELECT * FROM ${quoteIdentifier(name)} LIMIT 2`);
            const storedGeneration = rows[0]?.generation;
            const numericGeneration =
                typeof storedGeneration === "bigint" ? Number(storedGeneration) : storedGeneration;
            if (
                rows.length !== 1 ||
                rows[0]?.singleton !== 1 ||
                typeof numericGeneration !== "number" ||
                !Number.isSafeInteger(numericGeneration) ||
                numericGeneration < 0 ||
                rows[0].operation_id !== null ||
                rows[0].state !== "open"
            ) {
                notFresh(name);
            }
            continue;
        }
        if (name === "_chardb_auth_invalidation_epochs") {
            // Catalog may project auth epochs into an active split destination
            // before its schema is provisioned. A zero-impact watermark has no
            // application or live-delivery state and must survive provisioning.
            // Any observed registration, change-clock advance, or excess row
            // proves prior use and keeps the destination closed.
            const unsafe = sql.one<{ present: number }>(
                `SELECT 1 AS present FROM ${quoteIdentifier(name)}
                 WHERE registrations != 0 OR change_seq != 0
                 LIMIT 1`
            );
            const excess = sql.one<{ present: number }>(
                `SELECT 1 AS present FROM ${quoteIdentifier(name)}
                 LIMIT 1 OFFSET ?`,
                CDB_AUTH_INVALIDATION_SCOPE_LIMIT
            );
            if (unsafe || excess) notFresh(name);
            continue;
        }
        if (name === "_chardb_split_capture_tx") {
            const columns = sql.all<{ name: string }>("PRAGMA table_info('_chardb_split_capture_tx')");
            const expected = ["singleton", "next_id", "active_id", "active_vshard"] as const;
            if (
                columns.length !== expected.length ||
                columns.some((column, index) => column.name !== expected[index])
            ) {
                notFresh(name);
            }
            const rows = sql.all<{
                singleton: number;
                next_id: number;
                active_id: number | null;
                active_vshard: number | null;
            }>(`SELECT singleton, next_id, active_id, active_vshard FROM ${quoteIdentifier(name)} LIMIT 2`);
            if (
                rows.length !== 1 ||
                rows[0]?.singleton !== 1 ||
                rows[0].next_id !== 0 ||
                rows[0].active_id !== null ||
                rows[0].active_vshard !== null
            ) {
                notFresh(name);
            }
            continue;
        }
        if (name === "_chardb_vector_capacity") {
            assertExactColumns(sql, name, [
                "singleton",
                "reconciled",
                "head_count",
                "stored_bytes",
                "outbox_rows",
                "attempt_rows",
            ]);
            const rows = sql.all<{
                singleton: number;
                reconciled: number;
                head_count: number;
                stored_bytes: number;
                outbox_rows: number;
                attempt_rows: number;
            }>(`SELECT * FROM ${quoteIdentifier(name)} LIMIT 2`);
            if (
                rows.length !== 1 ||
                rows[0]?.singleton !== 1 ||
                rows[0].reconciled !== 1 ||
                rows[0].head_count !== 0 ||
                rows[0].stored_bytes !== 0 ||
                rows[0].outbox_rows !== 0 ||
                rows[0].attempt_rows !== 0
            ) {
                notFresh(name);
            }
            continue;
        }
        if (name === "_chardb_vector_scheduler") {
            assertExactColumns(sql, name, ["singleton", "next_vshard"]);
            const rows = sql.all<{ singleton: number; next_vshard: number }>(
                `SELECT singleton, next_vshard FROM ${quoteIdentifier(name)} LIMIT 2`
            );
            if (rows.length !== 1 || rows[0]?.singleton !== 1 || rows[0].next_vshard !== 0) {
                notFresh(name);
            }
            continue;
        }
        if (name === "_chardb_vector_head_sequence") {
            assertExactColumns(sql, name, ["singleton", "last_seq"]);
            const rows = sql.all<{ singleton: number; last_seq: number }>(
                `SELECT singleton, last_seq FROM ${quoteIdentifier(name)} LIMIT 2`
            );
            if (rows.length !== 1 || rows[0]?.singleton !== 1 || rows[0].last_seq !== 0) {
                notFresh(name);
            }
            continue;
        }
        if (name === "_chardb_split_state") {
            const present = sql.one<{ present: number }>(`SELECT 1 AS present FROM ${quoteIdentifier(name)} LIMIT 1`);
            if (!present) continue;
            const columns = new Set(
                sql.all<{ name: string }>("PRAGMA table_info('_chardb_split_state')").map(column => column.name)
            );
            const required = [
                "role",
                "destination_generation",
                "destination_serving",
                "capture",
                "bulk_done",
                "applied_lsn",
                "acked_lsn",
                "split_log_rows",
                "split_log_bytes",
                "drain_started",
                "abort_started",
                "staged_lsn",
                "inbox_rows",
                "inbox_bytes",
                "inbox_closed",
                "drained",
            ] as const;
            if (required.some(column => !columns.has(column))) notFresh(name);
            const unsafe = sql.one<{ present: number }>(
                `SELECT 1 AS present FROM ${quoteIdentifier(name)}
                 WHERE role != 'dest' OR destination_generation IS NULL OR destination_serving != 0
                    OR capture != 0 OR bulk_done != 0 OR applied_lsn != 0 OR acked_lsn != 0
                    OR split_log_rows != 0 OR split_log_bytes != 0 OR drain_started != 0
                    OR abort_started != 0 OR staged_lsn != 0 OR inbox_rows != 0 OR inbox_bytes != 0
                    OR inbox_closed != 0 OR drained != 0
                 LIMIT 1`
            );
            const excess = sql.one<{ present: number }>(
                `SELECT 1 AS present FROM ${quoteIdentifier(name)} LIMIT 1 OFFSET 1`
            );
            if (unsafe || excess) notFresh(name);
            continue;
        }
        if (sql.one<{ present: number }>(`SELECT 1 AS present FROM ${quoteIdentifier(name)} LIMIT 1`)) {
            notFresh(name);
        }
    }
}

/** Bounded, transaction-local proof that a destination has never owned application state. */
export function assertFreshReshardDestination(sql: SyncSql): void {
    const physical = sql.one<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND substr(name, 1, 8) != '_chardb_'
           AND substr(name, 1, 4) != '_cf_'
           AND substr(name, 1, 12) != '__miniflare_'
           AND substr(name, 1, 7) != 'sqlite_'
         LIMIT 1`
    );
    if (physical) notFresh(`domain table ${physical.name}`);
    assertFreshInternalRows(sql, false);
}

/** Version zero already has packaged domain DDL, so prove those exact tables have never held state. */
export function assertUnusedVersionZeroReshardDestination(
    sql: SyncSql,
    expected: readonly { readonly tableName: string; readonly signature: string }[]
): void {
    const normalized = [...expected].sort((left, right) => left.tableName.localeCompare(right.tableName));
    if (normalized.length > 256 || normalized.some(item => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.tableName))) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "packaged version-zero domain registry is invalid" });
    }
    const physical = sql.all<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND substr(name, 1, 8) != '_chardb_'
           AND substr(name, 1, 4) != '_cf_'
           AND substr(name, 1, 12) != '__miniflare_'
           AND substr(name, 1, 7) != 'sqlite_'
         ORDER BY name LIMIT 257`
    );
    const recorded = sql.all<{ table_name: string; signature: string }>(
        "SELECT table_name, signature FROM _chardb_domain_schema ORDER BY table_name LIMIT 257"
    );
    if (
        physical.length !== normalized.length ||
        recorded.length !== normalized.length ||
        normalized.some(
            (item, index) =>
                physical[index]?.name !== item.tableName ||
                recorded[index]?.table_name !== item.tableName ||
                recorded[index]?.signature !== item.signature
        )
    ) {
        notFresh("physical domain registry differs from the packaged version-zero schema");
    }
    for (const item of normalized) {
        if (sql.one<{ present: number }>(`SELECT 1 AS present FROM "${item.tableName}" LIMIT 1`)) {
            notFresh(`domain table ${item.tableName}`);
        }
    }
    assertFreshInternalRows(sql, true);
    const clock = sql.one<{ change_seq: number }>("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1");
    if (!clock || clock.change_seq !== 0) notFresh("change clock");
}
