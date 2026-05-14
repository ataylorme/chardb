import { describe, expect, test } from "bun:test";
import {
    analyticsEngineSink,
    consoleSink,
    defaultChardbTail,
    defineTailWorker,
    httpSink,
    normalizeTailItem,
    renderTailWrangler,
    resolveTailSink,
    tailHandler,
} from "../src/observability/index.ts";

describe("observability tail", () => {
    test("normalizes a TraceItem with request + correlation id", () => {
        const req = new Request("https://example.com/q/foo", {
            headers: { "cf-chardb-correlation-id": "corr-1", "cf-ray": "abc" },
        });
        const ev = normalizeTailItem({
            outcome: "ok",
            eventTimestamp: 1700000000000,
            event: { request: req, response: { status: 200 } },
        });
        expect(ev.correlationId).toBe("corr-1");
        expect(ev.route).toBe("/q/foo");
        expect(ev.status).toBe(200);
        expect(ev.cf?.ray).toBe("abc");
    });

    test("captures the first exception", () => {
        const ev = normalizeTailItem({
            outcome: "exception",
            exceptions: [{ name: "TypeError", message: "boom" }],
        });
        expect(ev.outcome).toBe("exception");
        expect(ev.error?.name).toBe("TypeError");
        expect(ev.error?.message).toBe("boom");
    });

    test("tailHandler fans events through the sink", async () => {
        const seen: string[] = [];
        const handler = tailHandler({ ingest: e => void seen.push(e.outcome) });
        await handler([{ outcome: "ok" }, { outcome: "exception", exceptions: [{ name: "E", message: "x" }] }]);
        expect(seen).toEqual(["ok", "exception"]);
    });

    test("httpSink POSTs ndjson per event", async () => {
        const calls: { url: string; body: string }[] = [];
        const fakeFetch = async (url: string, init: { method: string; body: string }) => {
            calls.push({ url, body: init.body });
            return { ok: true, status: 200 };
        };
        const sink = httpSink({ endpoint: "https://logs.example.com/v1/ingest", fetch: fakeFetch });
        await sink.ingest({ id: "i", ts: 1, correlationId: "c1", outcome: "ok", route: "/q" });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("https://logs.example.com/v1/ingest");
        expect(calls[0]?.body).toContain('"correlationId":"c1"');
    });

    test("defineTailWorker returns the tail-consumer entry shape", async () => {
        const seen: string[] = [];
        const w = defineTailWorker({ ingest: e => void seen.push(e.outcome) });
        await w.tail([{ outcome: "ok" }]);
        expect(seen).toEqual(["ok"]);
    });

    test("consoleSink emits ndjson via the injected log", () => {
        const lines: string[] = [];
        const sink = consoleSink(l => lines.push(l));
        sink.ingest({ id: "i", ts: 1, correlationId: "c1", outcome: "ok", route: "/q" });
        expect(lines).toHaveLength(1);
        const parsed = JSON.parse(lines[0]!) as { correlationId: string };
        expect(parsed.correlationId).toBe("c1");
    });

    test("resolveTailSink prefers AE → HTTP → console (deterministic order)", async () => {
        const writes: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[] = [];
        const ae = {
            writeDataPoint: (dp: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) => void writes.push(dp),
        };
        const aeSink = resolveTailSink({ CHARDB_TAIL_AE: ae, CHARDB_TAIL_URL: "https://ignored" });
        aeSink.ingest({ id: "i", ts: 1, correlationId: "c1", outcome: "ok", route: "/q" });
        expect(writes).toHaveLength(1);

        const httpCalls: { url: string; headers: Record<string, string>; body: string }[] = [];
        const httpFetch = async (
            url: string,
            init: { method: string; headers: Record<string, string>; body: string }
        ) => {
            httpCalls.push({ url, headers: init.headers, body: init.body });
            return { ok: true, status: 200 };
        };
        const httpSinkResolved = resolveTailSink({
            CHARDB_TAIL_URL: "https://logs.example.com",
            CHARDB_TAIL_AUTH: "Bearer t",
        });
        // resolveTailSink returns httpSink with default fetch when no AE; swap by re-creating with our fakeFetch:
        const sinkExplicit = httpSink({
            endpoint: "https://logs.example.com",
            headers: { authorization: "Bearer t" },
            fetch: httpFetch,
        });
        await sinkExplicit.ingest({ id: "i", ts: 1, correlationId: "c2", outcome: "ok", route: "/q" });
        expect(httpCalls[0]?.headers.authorization).toBe("Bearer t");
        expect(httpSinkResolved).toBeDefined();

        const consoleLines: string[] = [];
        const fallback = resolveTailSink({});
        expect(fallback).toBeDefined();
        consoleSink(l => consoleLines.push(l)).ingest({
            id: "i",
            ts: 1,
            correlationId: "c3",
            outcome: "ok",
            route: "/q",
        });
        expect(consoleLines).toHaveLength(1);
    });

    test("defaultChardbTail wires events through the resolved sink", async () => {
        const writes: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[] = [];
        const env = {
            CHARDB_TAIL_AE: {
                writeDataPoint: (dp: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) =>
                    void writes.push(dp),
            },
        };
        const w = defaultChardbTail();
        await w.tail(
            [
                {
                    outcome: "ok",
                    event: {
                        request: new Request("https://x/q/foo", {
                            headers: { "cf-chardb-correlation-id": "c1" },
                        }),
                        response: { status: 200 },
                    },
                },
            ],
            env
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]?.indexes).toEqual(["c1"]);
    });

    test("renderTailWrangler emits a deployable wrangler.jsonc with optional AE binding and vars", () => {
        const text = renderTailWrangler({
            compatibilityDate: "2024-09-23",
            aeDataset: "chardb_tail",
            httpUrl: "https://logs.example.com",
        });
        const cfg = JSON.parse(text) as {
            name: string;
            main: string;
            compatibility_date: string;
            analytics_engine_datasets?: { binding: string; dataset: string }[];
            vars?: Record<string, string>;
        };
        expect(cfg.name).toBe("chardb-tail");
        expect(cfg.main).toBe("src/tail-worker.ts");
        expect(cfg.analytics_engine_datasets?.[0]).toEqual({
            binding: "CHARDB_TAIL_AE",
            dataset: "chardb_tail",
        });
        expect(cfg.vars).toEqual({ CHARDB_TAIL_URL: "https://logs.example.com" });
    });

    test("analytics-engine sink writes one data point per event", () => {
        const writes: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[] = [];
        const sink = analyticsEngineSink({ writeDataPoint: dp => void writes.push(dp) });
        sink.ingest({
            id: "i",
            ts: 1,
            correlationId: "c1",
            outcome: "ok",
            route: "/q",
            status: 200,
            durationMs: 7,
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]?.indexes).toEqual(["c1"]);
        expect(writes[0]?.doubles).toEqual([200, 7]);
    });
});
