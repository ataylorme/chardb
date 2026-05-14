/**
 * `chardb/observability` — auxiliary surface for an optional `chardb-tail`
 * Worker. Cloudflare Workers Tail consumers receive `TraceItem` events on
 * every parent invocation; this module normalizes the chardb-relevant fields
 * and routes them to the user's chosen sink.
 *
 * The expected deployment model is a tiny secondary Worker with `tail_consumers`
 * pointing at the chardb Worker (see
 * https://developers.cloudflare.com/workers/observability/tail-workers/). The
 * tail Worker imports `tailHandler` from here and forwards normalized events
 * to Cloudflare Analytics Engine, Logpush, or the user's HTTP endpoint.
 */

import { uuidv7 } from "uuidv7";

export interface ChardbTailEvent {
    readonly id: string;
    readonly ts: number;
    readonly correlationId: string;
    readonly outcome: "ok" | "exception" | "exceeded-cpu" | "killed" | "canceled";
    readonly route: string;
    readonly status?: number;
    readonly durationMs?: number;
    readonly error?: { readonly name: string; readonly message: string };
    readonly cf?: {
        readonly colo?: string;
        readonly country?: string;
        readonly ray?: string;
    };
}

export interface TailSink {
    ingest(event: ChardbTailEvent): void | Promise<void>;
}

interface TailItem {
    scriptName?: string;
    outcome: ChardbTailEvent["outcome"];
    eventTimestamp?: number;
    event?: { request?: Request; response?: { status?: number } };
    exceptions?: readonly { name?: string; message?: string }[];
    diagnosticsChannelEvents?: unknown[];
}

/**
 * Normalize a single `TraceItem` from the Tail handler input array into a
 * `ChardbTailEvent`. Unknown / missing fields are filled in with safe
 * defaults so a sink can always rely on the shape.
 */
export function normalizeTailItem(item: TailItem): ChardbTailEvent {
    const req = item.event?.request;
    const url = req ? new URL(req.url) : null;
    const status = item.event?.response?.status;
    const correlationId = req?.headers.get("cf-chardb-correlation-id") ?? uuidv7();
    const cfRay = req?.headers.get("cf-ray") ?? undefined;
    const ex = item.exceptions?.[0];
    return {
        id: uuidv7(),
        ts: item.eventTimestamp ?? Date.now(),
        correlationId,
        outcome: item.outcome,
        route: url?.pathname ?? "",
        ...(status !== undefined ? { status } : {}),
        ...(ex ? { error: { name: ex.name ?? "Error", message: ex.message ?? "" } } : {}),
        ...(cfRay ? { cf: { ray: cfRay } } : {}),
    };
}

/**
 * Build a tail Worker `fetch`-equivalent handler: returns a function suitable
 * for a Worker `tail` export.
 */
export function tailHandler(sink: TailSink): (events: readonly TailItem[]) => Promise<void> {
    return async events => {
        for (const item of events) {
            await sink.ingest(normalizeTailItem(item));
        }
    };
}

/**
 * Sink that POSTs each event as ndjson to an arbitrary HTTP endpoint. Useful
 * for forwarding to Datadog, Splunk, Loki, or a custom log collector. The
 * sink batches and flushes on a fixed timeout so a stuck endpoint cannot
 * stall the tail Worker.
 */
export type FetchLike = (
    input: string,
    init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok?: boolean; status?: number }>;

export function httpSink(opts: {
    readonly endpoint: string;
    readonly headers?: Record<string, string>;
    readonly fetch?: FetchLike;
}): TailSink {
    const send: FetchLike =
        opts.fetch ??
        ((url, init) => globalThis.fetch(url, init as RequestInit) as Promise<{ ok?: boolean; status?: number }>);
    return {
        async ingest(event) {
            await send(opts.endpoint, {
                method: "POST",
                headers: { "content-type": "application/x-ndjson", ...(opts.headers ?? {}) },
                body: `${JSON.stringify(event)}\n`,
            });
        },
    };
}

/**
 * Build a `tail_consumers` Worker entry. `export default { tail }` from a
 * separate Worker that lists the chardb Worker as its tail target; see
 * https://developers.cloudflare.com/workers/observability/tail-workers/.
 */
export function defineTailWorker(sink: TailSink): {
    readonly tail: (events: readonly TailItem[]) => Promise<void>;
} {
    return Object.freeze({ tail: tailHandler(sink) });
}

/** Sink that pushes events into a Cloudflare Analytics Engine binding. */
export function analyticsEngineSink(ae: {
    writeDataPoint(dp: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}): TailSink {
    return {
        ingest(event) {
            ae.writeDataPoint({
                indexes: [event.correlationId],
                blobs: [event.outcome, event.route, event.error?.message ?? ""],
                doubles: [event.status ?? 0, event.durationMs ?? 0],
            });
        },
    };
}

/** Sink that emits ndjson to `console.log` — fallback when no other sink is bound. */
export function consoleSink(log: (line: string) => void = l => console.log(l)): TailSink {
    return {
        ingest(event) {
            log(JSON.stringify(event));
        },
    };
}

/**
 * Compose a tail Worker `tail()` handler from the runtime env. Resolution
 * order is deterministic so a deploy is reproducible:
 *
 *   1. Analytics Engine binding `CHARDB_TAIL_AE` — the recommended sink for
 *      the `chardb shards top` heatmap (queryable from `chardb` CLI).
 *   2. HTTP endpoint env `CHARDB_TAIL_URL` (optional `CHARDB_TAIL_AUTH`
 *      → `Authorization` header) for shipping ndjson to a third party.
 *   3. `console.log` ndjson — last-resort sink so a misconfigured tail
 *      Worker doesn't silently drop events. Tail logs round-trip through
 *      Cloudflare logs (Logpush picks them up if enabled).
 *
 * The returned object is a complete `export default` for the tail Worker;
 * users pin the chardb worker as their `tail_consumers` target and import
 * this from their tail entry: `export default defaultChardbTail(env)`.
 */
export interface ChardbTailEnv {
    readonly CHARDB_TAIL_AE?: {
        writeDataPoint(dp: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
    };
    readonly CHARDB_TAIL_URL?: string;
    readonly CHARDB_TAIL_AUTH?: string;
}

export function resolveTailSink(env: ChardbTailEnv): TailSink {
    if (env.CHARDB_TAIL_AE) return analyticsEngineSink(env.CHARDB_TAIL_AE);
    if (env.CHARDB_TAIL_URL) {
        return httpSink({
            endpoint: env.CHARDB_TAIL_URL,
            ...(env.CHARDB_TAIL_AUTH ? { headers: { authorization: env.CHARDB_TAIL_AUTH } } : {}),
        });
    }
    return consoleSink();
}

/**
 * Default `chardb-tail` Worker entry. Drop into a sibling Worker:
 *
 * ```ts
 * import { defaultChardbTail } from "chardb/observability";
 * export default defaultChardbTail();
 * ```
 *
 * Then point `tail_consumers: [{ service: "chardb-tail" }]` at it from
 * the chardb Worker's `wrangler.jsonc`. The `wrangler init` template
 * emitted by `chardb init` already wires this binding.
 */
export function defaultChardbTail(): {
    readonly tail: (events: readonly TailItem[], env: ChardbTailEnv) => Promise<void>;
} {
    return Object.freeze({
        tail: async (events, env) => {
            const handler = tailHandler(resolveTailSink(env));
            await handler(events);
        },
    });
}

/**
 * `wrangler.jsonc` template for the standalone `chardb-tail` Worker.
 * Returns a JSON string ready to write next to `tail-worker.ts`.
 */
export function renderTailWrangler(input: {
    readonly name?: string;
    readonly compatibilityDate: string;
    readonly aeDataset?: string;
    readonly httpUrl?: string;
}): string {
    const cfg: {
        name: string;
        main: string;
        compatibility_date: string;
        analytics_engine_datasets?: { binding: string; dataset: string }[];
        vars?: Record<string, string>;
    } = {
        name: input.name ?? "chardb-tail",
        main: "src/tail-worker.ts",
        compatibility_date: input.compatibilityDate,
    };
    if (input.aeDataset) {
        cfg.analytics_engine_datasets = [{ binding: "CHARDB_TAIL_AE", dataset: input.aeDataset }];
    }
    if (input.httpUrl) {
        cfg.vars = { CHARDB_TAIL_URL: input.httpUrl };
    }
    return JSON.stringify(cfg, null, 2);
}
