import { organization } from "better-auth/plugins/organization";
/**
 * Test worker entry for the workerd reshard harness.
 *
 * Exposes a `TestCdb` Durable Object that extends the production `Cdb`
 * with two test-only RPCs (`_exec` for raw SQL setup and `_dump` for
 * inspection). The fetch handler is a thin JSON proxy so the test driver
 * can reach the DO over plain HTTP and invoke production reshard methods
 * (`beginReshardSource`, `bulkCopyBatch`, `applyBulkBatch`,
 * `readTailBatch`, `applyTailBatch`, `dropMigratedRange`,
 * `finishReshardSource`) without bundling a service binding.
 */
import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { renderSqliteTableDdl } from "../../src/auth/ddl.ts";
import { synthesizeAuthSchema } from "../../src/auth/synthesize.ts";
import { type SplitLogCapacity, type TableSpec, renderTableTriggers } from "../../src/reshard/triggers.ts";
import { createApi } from "../../src/server/define.ts";
import { CdbOpLogRetentionStore } from "../../src/server/do/cdb-oplog-retention-store.ts";
import { type TailTransaction, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import type { CdbMutationRequest } from "../../src/server/rpc.ts";
import { defineMigrations } from "../../src/server/schema-migrations.ts";
import type { RawJson } from "../../src/types.ts";
import { forOrgUser, globalScope } from "../helpers/cdb-table.ts";

const { cdbTable } = globalScope();
const dedupRecords = cdbTable(
    "dedup_records",
    {
        id: text("id").primaryKey(),
        orgId: text("org_id").notNull(),
        value: text("value").notNull(),
    },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const messages = cdbTable(
    "messages",
    { id: text("id").primaryKey(), orgId: text("org_id").notNull(), body: text("body").notNull() },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const messagesIso = cdbTable(
    "messages_iso",
    { id: text("id").primaryKey(), orgId: text("org_id").notNull(), body: text("body").notNull() },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const partitionMoves = cdbTable(
    "partition_moves",
    { id: text("id").primaryKey(), orgId: text("org_id").notNull(), body: text("body").notNull() },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const drainProgress = cdbTable(
    "drain_progress",
    { id: text("id").primaryKey(), orgId: text("org_id").notNull(), body: text("body").notNull() },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const reshardParents = cdbTable(
    "reshard_parents",
    { id: text("id").primaryKey(), orgId: text("org_id").notNull() },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const reshardChildren = cdbTable(
    "reshard_children",
    {
        id: text("id").primaryKey(),
        orgId: text("org_id").notNull(),
        parentId: text("parent_id")
            .notNull()
            .references(() => reshardParents.id),
    },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const compositeMoves = cdbTable(
    "composite_moves",
    {
        id: text("id").primaryKey(),
        revision: text("revision").notNull(),
        orgId: text("org_id").notNull(),
        parentId: text("parent_id")
            .notNull()
            .references(() => reshardParents.id),
        body: text("body").notNull(),
    },
    { partitionBy: "orgId", roles: { member: { create: "*" } } }
);
const auth = synthesizeAuthSchema({ plugins: [organization()] });
const { cdbTable: orgUserTable } = forOrgUser();
const orgUserDocuments = orgUserTable(
    "org_user_documents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        ownerId: text("owner_id")
            .notNull()
            .references(() => auth.user.id),
        reviewerId: text("reviewer_id")
            .notNull()
            .references(() => auth.user.id),
        body: text("body").notNull(),
    },
    { selfBy: "ownerId", roles: { self: { create: "*", read: "*" } } }
);
const api = createApi({
    dedupRecords,
    messages,
    messagesIso,
    partitionMoves,
    drainProgress,
    reshardParents,
    reshardChildren,
    compositeMoves,
    orgUserDocuments,
});
const putDedupRecord = api.mutation({
    ref: "workerd-reshard.ts#putDedupRecord",
    authority: "global",
    partitionKey: "orgId",
    args: z.object({ id: z.string(), orgId: z.string(), value: z.string() }),
    handler: (ctx, args) => {
        ctx.db.insert(dedupRecords).values(args).run();
        return { id: args.id, value: args.value };
    },
});
const ConfiguredTestCdb = configureCdbRuntime({
    schema: () => ({
        dedupRecords,
        messages,
        messagesIso,
        partitionMoves,
        drainProgress,
        reshardParents,
        reshardChildren,
        compositeMoves,
        organization: auth.organization,
        user: auth.user,
        orgUserDocuments,
    }),
    manifest: () => manifestFromExports({ putDedupRecord }),
});

const replicatedSettings = cdbTable(
    "replicated_settings",
    { id: text("id").primaryKey(), value: text("value").notNull() },
    { partitionBy: "replicated" }
);
const ConfiguredReplicatedCdb = configureCdbRuntime({
    schema: () => ({ messages, replicatedSettings }),
    manifest: () => manifestFromExports({}),
});
export class ReplicatedTestCdb extends ConfiguredReplicatedCdb {
    async _exec(args: { sql: string; params?: readonly (string | number | null)[] }): Promise<{ ok: true }> {
        adaptSqlStorage(this.ctx.storage.sql).exec(args.sql, ...((args.params ?? []) as never[]));
        return { ok: true };
    }

    async _dump(args: { table: string; orderBy?: string }): Promise<{ rows: readonly RawJson[] }> {
        const orderBy = args.orderBy ?? "rowid";
        return {
            rows: adaptSqlStorage(this.ctx.storage.sql).all<RawJson>(
                `SELECT * FROM "${args.table.replace(/"/g, '""')}" ORDER BY "${orderBy.replace(/"/g, '""')}"`
            ),
        };
    }
}

const freshRows = cdbTable(
    "fresh_rows",
    { id: text("id").primaryKey(), orgId: text("org_id").notNull(), value: text("value").notNull() },
    { partitionBy: "orgId" }
);
const freshJournal = defineMigrations([
    {
        version: 1,
        name: "fresh_reshard_destination",
        statements: [renderSqliteTableDdl(freshRows).createTable],
    },
]);
const ConfiguredFreshCdb = configureCdbRuntime({
    schema: () => ({ freshRows }),
    manifest: () => manifestFromExports({}),
    migrations: () => freshJournal,
});
export class FreshTestCdb extends ConfiguredFreshCdb {}

export class TestCdb extends ConfiguredTestCdb {
    async _foreignKeys(args: { table: string }): Promise<{ rows: readonly RawJson[] }> {
        const table = args.table.replace(/"/g, '""');
        return {
            rows: adaptSqlStorage(this.ctx.storage.sql).all<RawJson>(`PRAGMA foreign_key_list("${table}")`),
        };
    }

    async _countRows(args: { table: string }): Promise<{ count: number }> {
        const table = args.table.replace(/"/g, '""');
        const count = adaptSqlStorage(this.ctx.storage.sql).one<{ count: number }>(
            `SELECT COUNT(*) AS count FROM "${table}"`
        )?.count;
        if (count === undefined) throw new Error("test row count failed");
        return { count };
    }

    async _exec(args: {
        sql: string;
        params?: readonly (string | number | null)[];
        placementVshard?: number;
    }): Promise<{
        ok: true;
    }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const active = sql.one<{ range_lo: number }>(
            "SELECT range_lo FROM _chardb_split_state WHERE role = 'source' AND capture = 1 LIMIT 1"
        );
        if (!active) {
            sql.exec(args.sql, ...((args.params ?? []) as never[]));
            return { ok: true };
        }
        this.ctx.storage.transactionSync(() => {
            const txSql = adaptSqlStorage(this.ctx.storage.sql);
            txSql.exec(
                `INSERT INTO _chardb_op_log
                 (principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch, touched_keys, byte_size, placement_vshard)
                 VALUES ('test', ?, X'00', X'', 1, 0, '[]', 0, ?)`,
                `captured-${crypto.randomUUID()}`,
                args.placementVshard ?? active.range_lo
            );
            const eventId = txSql.one<{ id: number }>("SELECT last_insert_rowid() AS id")?.id;
            if (!eventId) throw new Error("test capture transaction did not allocate an event id");
            txSql.exec(args.sql, ...((args.params ?? []) as never[]));
            txSql.exec("DELETE FROM _chardb_op_log WHERE event_id = ?", eventId);
        });
        return { ok: true };
    }
    async _dump(args: { table: string; orderBy?: string }): Promise<{ rows: readonly RawJson[] }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const orderBy = args.orderBy ?? "rowid";
        const rows = sql.all<RawJson>(`SELECT * FROM "${args.table.replace(/"/g, '""')}" ORDER BY "${orderBy}"`);
        return { rows };
    }

    async _mutateThenLoseResponse(args: CdbMutationRequest): Promise<never> {
        const result = await this.mutate(args);
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        throw new Error("simulated response loss after mutation commit");
    }

    async _activateReshardDestThenLoseResponse(
        args: Parameters<InstanceType<typeof ConfiguredTestCdb>["activateReshardDestServing"]>[0]
    ): Promise<never> {
        this.activateReshardDestServing(args);
        throw new Error("simulated response loss after destination activation");
    }

    async _ackThenLoseResponse(args: { migId: string; throughLsn: number }): Promise<never> {
        await this.ackTail(args);
        throw new Error("simulated response loss after tail acknowledgement");
    }

    async _ackSplitOpLogThenLoseResponse(args: { migId: string; throughLsn: number }): Promise<never> {
        await this.ackSplitOpLog(args);
        throw new Error("simulated response loss after split-oplog acknowledgement");
    }

    async _stageTailThenLoseResponse(args: {
        migId: string;
        tables: readonly TableSpec[];
        range: { lo: number; hi: number };
        transactions: readonly TailTransaction[];
    }): Promise<never> {
        await this.stageTailBatch(args);
        throw new Error("injected lost staged-tail response");
    }

    async _finishReshardSourceThenLoseResponse(
        args: Parameters<InstanceType<typeof ConfiguredTestCdb>["finishReshardSource"]>[0]
    ): Promise<never> {
        await this.finishReshardSource(args);
        throw new Error("injected lost source-finalize response");
    }

    async _splitOpLogState(args: { migId: string }) {
        return adaptSqlStorage(this.ctx.storage.sql).one(
            `SELECT acked_lsn AS ackedLsn, retained_rows AS retainedRows, retained_bytes AS retainedBytes
             FROM _chardb_split_oplog_accounting WHERE mig_id = ?`,
            args.migId
        );
    }

    async _maintainOpLog(args: { nowMs: number }) {
        return new CdbOpLogRetentionStore(this.ctx.storage).maintain(args.nowMs);
    }

    async _replaceSplitTriggers(args: {
        migId: string;
        tables: readonly TableSpec[];
        capacity: SplitLogCapacity;
    }): Promise<{ ok: true }> {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (const table of args.tables) {
                const triggers = renderTableTriggers(args.migId, table, args.capacity);
                for (const statement of triggers.uninstall) sql.exec(statement);
                for (const statement of triggers.install) sql.exec(statement);
            }
        });
        return { ok: true };
    }

    async _triggerSql(args: { name: string }): Promise<{ sql: string | null }> {
        const row = adaptSqlStorage(this.ctx.storage.sql).one<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
            args.name
        );
        return { sql: row?.sql ?? null };
    }

    async _splitState(args: { migId: string }): Promise<{
        rows: number;
        bytes: number;
        ackedLsn: number;
        drained: number;
    } | null> {
        const row = adaptSqlStorage(this.ctx.storage.sql).one<{
            split_log_rows: number;
            split_log_bytes: number;
            acked_lsn: number;
            drained: number;
        }>(
            "SELECT split_log_rows, split_log_bytes, acked_lsn, drained FROM _chardb_split_state WHERE mig_id = ?",
            args.migId
        );
        return row
            ? { rows: row.split_log_rows, bytes: row.split_log_bytes, ackedLsn: row.acked_lsn, drained: row.drained }
            : null;
    }

    async _foreignKeyCheck(): Promise<{ rows: readonly RawJson[] }> {
        return { rows: adaptSqlStorage(this.ctx.storage.sql).all<RawJson>("PRAGMA foreign_key_check") };
    }
}

interface Env {
    CDB: DurableObjectNamespace;
    FRESH: DurableObjectNamespace;
    REPLICATED: DurableObjectNamespace;
}

type ReshardOp =
    | "_exec"
    | "_countRows"
    | "_dump"
    | "_maintainOpLog"
    | "_replaceSplitTriggers"
    | "_triggerSql"
    | "_splitState"
    | "_foreignKeyCheck"
    | "_foreignKeys"
    | "_activateReshardDestThenLoseResponse"
    | "_ackThenLoseResponse"
    | "_ackSplitOpLogThenLoseResponse"
    | "_stageTailThenLoseResponse"
    | "_finishReshardSourceThenLoseResponse"
    | "_splitOpLogState"
    | "schemaState"
    | "prepareSchemaMigration"
    | "provisionFreshReshardDestination"
    | "prepareReshardDestOwnership"
    | "beginReshardSource"
    | "beginReshardDest"
    | "activateReshardDestServing"
    | "prepareRoutingFence"
    | "activateRoutingFence"
    | "tailWatermark"
    | "reshardTableOrder"
    | "bulkCopyBatch"
    | "applyBulkBatch"
    | "closeReshardBulkDest"
    | "readTailBatch"
    | "ackTail"
    | "applyTailBatch"
    | "stageTailBatch"
    | "readStagedTailBatch"
    | "ackStagedTail"
    | "closeTailStaging"
    | "stopReshardCapture"
    | "readSplitOpLogBatch"
    | "ackSplitOpLog"
    | "applySplitOpLogBatch"
    | "dropMigratedRange"
    | "finishReshardSource"
    | "finishReshardDest"
    | "abortReshardSource"
    | "beginReshardDestAbort"
    | "abortReshardDestBatch"
    | "mutate"
    | "query"
    | "_mutateThenLoseResponse";

const BYTE_TAG = "__chardb_test_bytes";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
    return new Response(
        JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? { [BYTE_TAG]: Array.from(item) } : item)),
        { ...init, headers: { "content-type": "application/json", ...init?.headers } }
    );
}

function parseBody(text: string): unknown {
    return JSON.parse(text, (_key, item) => {
        if (
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            Object.keys(item).length === 1 &&
            Array.isArray((item as Record<string, unknown>)[BYTE_TAG])
        ) {
            return Uint8Array.from((item as Record<string, number[]>)[BYTE_TAG] as number[]);
        }
        return item;
    });
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);
        const name = url.searchParams.get("name") ?? "default";
        if (url.pathname === "/_freshProvisionProof") {
            const fresh = env.FRESH.get(env.FRESH.idFromName(name)) as unknown as {
                prepareReshardDestOwnership(args: {
                    migId: string;
                    rangeLo: number;
                    rangeHi: number;
                    destinationGeneration: number;
                }): Promise<unknown>;
                schemaState(): Promise<{ activeVersion: number; activeEpoch: number; activeDigest: string }>;
                provisionFreshReshardDestination(args: {
                    migrationId: string;
                    targetVersion: number;
                    targetEpoch: number;
                    targetDigest: string;
                }): Promise<unknown>;
            };
            const before = await fresh.schemaState();
            await fresh.prepareReshardDestOwnership({
                migId: "fresh-native-1",
                rangeLo: 10,
                rangeHi: 10,
                destinationGeneration: 2,
            });
            await fresh.provisionFreshReshardDestination({
                migrationId: "reshard-dest:fresh-native-1",
                targetVersion: 1,
                targetEpoch: 7,
                targetDigest: freshJournal.digest,
            });
            const after = await fresh.schemaState();
            return jsonResponse({ before, after });
        }
        const namespace = name.startsWith("replicated:") ? env.REPLICATED : env.CDB;
        const durableName = name.startsWith("replicated:") ? name.slice("replicated:".length) : name;
        const id = namespace.idFromName(durableName);
        const stub = namespace.get(id);
        const op = url.pathname.slice(1) as ReshardOp;
        const body = req.method === "POST" ? parseBody(await req.text()) : null;
        const stubAny = stub as unknown as Record<ReshardOp, (arg: unknown) => Promise<unknown>>;
        if (typeof stubAny[op] !== "function") {
            return new Response(`unknown op: ${op}`, { status: 404 });
        }
        try {
            const result = await stubAny[op](body);
            return jsonResponse(result === undefined ? { ok: true } : result);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse({ error: message }, { status: 500 });
        }
    },
};
