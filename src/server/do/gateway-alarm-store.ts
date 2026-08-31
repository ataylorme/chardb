import type { SyncSql } from "../../oplog/wrapper.ts";

/** Serializes alarm writes so concurrent Gateway work cannot replace an earlier deadline. */
export class DurableAlarmScheduler {
    private tail: Promise<void> = Promise.resolve();

    constructor(private readonly storage: DurableObjectStorage) {}

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const scheduled = this.tail.then(operation);
        this.tail = scheduled.then(
            () => {},
            () => {}
        );
        return scheduled;
    }

    scheduleEarlier(requestedAt: number): Promise<void> {
        assertNonnegativeSafeInteger(requestedAt, "requestedAt");
        return this.serialize(async () => {
            const current = await this.storage.getAlarm();
            if (current === null || requestedAt < current) await this.storage.setAlarm(requestedAt);
        });
    }

    transactionWithEarlierAlarm<T>(requestedAt: number, mutation: () => T): Promise<T> {
        assertNonnegativeSafeInteger(requestedAt, "requestedAt");
        return this.serialize(() =>
            this.storage.transaction(async transaction => {
                const current = await transaction.getAlarm();
                if (current === null || requestedAt < current) await transaction.setAlarm(requestedAt);
                return mutation();
            })
        );
    }
}

export { DurableAlarmScheduler as GatewayAlarmScheduler };

/** Read the earliest durable Gateway deadline across cleanup, query, send, and replay work. */
export function nextGatewayWorkAt(sql: SyncSql, excludedConnectionIds: readonly string[] = []): number | null {
    const exclusion = gatewayConnectionExclusion(excludedConnectionIds);
    const deadlines = [
        sql.one<{ due_at: number | null }>(
            `SELECT MIN(retry_at) AS due_at
             FROM _gw_registration_generations g
             WHERE lifecycle = 'retiring' AND cdb_state = 'retiring' AND retry_at IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM _gw_registration_heads h WHERE h.registration_id = g.registration_id
               )`
        )?.due_at ?? null,
        sql.one<{ due_at: number | null }>(
            `SELECT MIN(g.retry_at) AS due_at
             FROM _gw_registration_generations g
             WHERE g.cdb_state = 'pending'
               AND g.lifecycle IN ('installing', 'retiring')
               AND g.retry_at IS NOT NULL`
        )?.due_at ?? null,
        sql.one<{ due_at: number | null }>(
            `SELECT MIN(
               CASE
                 WHEN g.run_token IS NULL THEN COALESCE(g.retry_at, 0)
                 ELSE g.run_lease_expires_at
               END
             ) AS due_at
             FROM _gw_registration_generations g
             INNER JOIN _gw_registration_heads h
               ON h.registration_id = g.registration_id
              AND h.principal_id = g.principal_id
              AND h.client_id = g.client_id
              AND h.sub_id = g.sub_id
             WHERE g.lifecycle = 'active' AND g.cdb_state = 'active'
               AND g.source_cdb_id IS NOT NULL AND g.source_cdb_id <> ''
               ${exclusion.filter}
               AND (g.initial_snapshot_pending = 1 OR g.dirty_version > g.delivered_version)
               AND NOT EXISTS (
                 SELECT 1 FROM _gw_snapshot_outbox o WHERE o.registration_id = g.registration_id
               )
               AND (
                 (g.run_token IS NULL AND g.run_target_version IS NULL AND g.run_lease_expires_at IS NULL)
                 OR
                 (g.run_token IS NOT NULL AND g.run_target_version IS NOT NULL
                  AND g.run_lease_expires_at IS NOT NULL)
               )`,
            ...exclusion.bindings
        )?.due_at ?? null,
        nextGatewaySnapshotSendAt(sql, exclusion.bindings),
        sql.one<{ due_at: number | null }>("SELECT MIN(expires_at) AS due_at FROM _gw_snapshot_replay")?.due_at ?? null,
    ].filter((value): value is number => value !== null);
    return deadlines.length === 0 ? null : Math.min(...deadlines);
}

export function nextGatewaySnapshotSendAt(sql: SyncSql, excludedConnectionIds: readonly string[] = []): number | null {
    const exclusion = gatewayConnectionExclusion(excludedConnectionIds);
    return (
        sql.one<{ due_at: number | null }>(
            `SELECT MIN(
               CASE
                 WHEN o.claim_token IS NULL THEN o.next_attempt_at
                 ELSE MAX(o.next_attempt_at, COALESCE(o.claim_expires_at, o.next_attempt_at))
               END
             ) AS due_at
             FROM _gw_snapshot_outbox o
             INNER JOIN _gw_registration_generations g ON g.registration_id = o.registration_id
             INNER JOIN _gw_registration_heads h
               ON h.registration_id = g.registration_id
              AND h.principal_id = g.principal_id
              AND h.client_id = g.client_id
              AND h.sub_id = g.sub_id
             WHERE g.lifecycle = 'active' AND g.cdb_state = 'active'
               ${exclusion.filter}`,
            ...exclusion.bindings
        )?.due_at ?? null
    );
}

function gatewayConnectionExclusion(excludedConnectionIds: readonly string[]): {
    readonly filter: string;
    readonly bindings: readonly string[];
} {
    if (excludedConnectionIds.some(connectionId => connectionId.length === 0)) {
        throw new TypeError("excluded connection IDs must be nonempty");
    }
    const bindings = [...new Set(excludedConnectionIds)];
    return {
        filter: bindings.length === 0 ? "" : `AND g.connection_id NOT IN (${bindings.map(() => "?").join(", ")})`,
        bindings,
    };
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
}
