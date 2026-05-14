/**
 * Test worker entry for the workerd Catalog harness — re-exports
 * `Catalog` and proxies its RPCs over plain HTTP. Mirrors
 * `worker.entry.ts` (Cdb harness) but binds the Catalog DO instead.
 */
import { Catalog } from "../../src/server/do/catalog.ts";

export { Catalog };

interface Env {
    CATALOG: DurableObjectNamespace;
}

type Op = "openBarrier" | "ackBarrier" | "openBarriers" | "cutover" | "route" | "splitRange";

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);
        const id = env.CATALOG.idFromName("global");
        const stub = env.CATALOG.get(id);
        const op = url.pathname.slice(1) as Op;
        const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown> | null) : null;
        const stubAny = stub as unknown as Record<Op, (arg?: unknown) => Promise<unknown>>;
        if (typeof stubAny[op] !== "function") {
            return new Response(`unknown op: ${op}`, { status: 404 });
        }
        try {
            // openBarrier takes a positional `now` arg, unlike the others.
            const result =
                op === "openBarrier"
                    ? await stubAny.openBarrier((body ?? { now: Date.now() }).now as number)
                    : await stubAny[op](body);
            return Response.json(result ?? { ok: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return Response.json({ error: message }, { status: 500 });
        }
    },
};
