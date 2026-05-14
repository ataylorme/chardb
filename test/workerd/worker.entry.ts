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
import { Cdb } from "../../src/server/do/cdb.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import type { RawJson } from "../../src/types.ts";

export class TestCdb extends Cdb {
    async _exec(args: { sql: string; params?: readonly (string | number | null)[] }): Promise<{
        ok: true;
    }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(args.sql, ...((args.params ?? []) as never[]));
        return { ok: true };
    }
    async _dump(args: { table: string; orderBy?: string }): Promise<{ rows: readonly RawJson[] }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const orderBy = args.orderBy ?? "rowid";
        const rows = sql.all<RawJson>(`SELECT * FROM "${args.table.replace(/"/g, '""')}" ORDER BY "${orderBy}"`);
        return { rows };
    }
}

interface Env {
    CDB: DurableObjectNamespace;
}

type ReshardOp =
    | "_exec"
    | "_dump"
    | "beginReshardSource"
    | "beginReshardDest"
    | "tailWatermark"
    | "bulkCopyBatch"
    | "applyBulkBatch"
    | "readTailBatch"
    | "applyTailBatch"
    | "dropMigratedRange"
    | "finishReshardSource";

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);
        const name = url.searchParams.get("name") ?? "default";
        const id = env.CDB.idFromName(name);
        const stub = env.CDB.get(id);
        const op = url.pathname.slice(1) as ReshardOp;
        const body = req.method === "POST" ? await req.json() : null;
        const stubAny = stub as unknown as Record<ReshardOp, (arg: unknown) => Promise<unknown>>;
        if (typeof stubAny[op] !== "function") {
            return new Response(`unknown op: ${op}`, { status: 404 });
        }
        try {
            const result = await stubAny[op](body);
            return Response.json(result ?? { ok: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return Response.json({ error: message }, { status: 500 });
        }
    },
};
