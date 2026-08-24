/**
 * Adapter from Cloudflare DO `SqlStorage` to our `SyncSql` surface.
 *
 * Workerd's `SqlStorage` is synchronous; cursors are iterators over rows.
 * `state.storage.transactionSync(() => …)` is the only safe place to call
 * data-modifying statements when atomicity is required.
 */

import type { SqlParam, SyncSql } from "../../oplog/wrapper.ts";

/**
 * Minimum surface we use from workerd's `SqlStorage`. Typed loosely so we can
 * accept the real binding type without inheriting the full generic dance.
 */
export interface SqlStorageLike {
    exec(
        query: string,
        ...bindings: unknown[]
    ): {
        raw(): IterableIterator<unknown[]>;
        columnNames: string[];
    };
}

/**
 * Wrap a DO `SqlStorage` so the op-log wrapper can talk to it.
 *
 * `changes()` semantics: workerd's `SqlStorage.Cursor.rowsWritten` is a
 * metering counter, NOT semantically `sqlite3_changes()`
 * (https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.h).
 * The supported way to detect an OR-IGNORE outcome is to run a separate
 * `SELECT changes()` inside the same `transactionSync` and read its single
 * integer column. See
 * https://developers.cloudflare.com/durable-objects/api/sql-storage/.
 */
export function adaptSqlStorage(storage: SqlStorageLike | SqlStorage): SyncSql {
    const s = storage as SqlStorageLike;
    return {
        exec(query, ...params) {
            const c = s.exec(query, ...(params as SqlParam[]));
            for (const _ of c.raw()) {
                /* drain */
            }
        },
        one<T = Record<string, import("../../oplog/wrapper.ts").SqlValue>>(
            query: string,
            ...params: SqlParam[]
        ): T | null {
            const c = s.exec(query, ...params);
            const cols = c.columnNames;
            for (const row of c.raw()) {
                const obj: Record<string, unknown> = {};
                for (let i = 0; i < cols.length; i++) obj[cols[i] as string] = row[i];
                return obj as T;
            }
            return null;
        },
        all<T = Record<string, import("../../oplog/wrapper.ts").SqlValue>>(query: string, ...params: SqlParam[]): T[] {
            const c = s.exec(query, ...params);
            const cols = c.columnNames;
            const out: T[] = [];
            for (const row of c.raw()) {
                const obj: Record<string, unknown> = {};
                for (let i = 0; i < cols.length; i++) obj[cols[i] as string] = row[i];
                out.push(obj as T);
            }
            return out;
        },
        changes() {
            const c = s.exec("SELECT changes() AS changes");
            let row: unknown[] | undefined;
            for (const r of c.raw()) {
                row = r;
                break;
            }
            return row ? Number((row[0] as number | bigint) ?? 0) : 0;
        },
        totalChanges() {
            const c = s.exec("SELECT total_changes() AS total_changes");
            let row: unknown[] | undefined;
            for (const r of c.raw()) {
                row = r;
                break;
            }
            return row ? ((row[0] as number | bigint) ?? 0) : 0;
        },
    };
}
