/**
 * Tests for the pure observability surface on `WorkerEntrypoint`.
 *
 * These cover the contract every chardb response promises:
 *   - inbound `cf-chardb-correlation-id` is echoed; absent header mints
 *     a fresh UUIDv7 (sortable, RFC 9562 v7),
 *   - `Server-Timing` carries `cdb;dur=<int>;desc="chardb total"` per the
 *     W3C Server-Timing header grammar,
 *   - `Cf-Chardb-Server-Version` is set to the configured tag.
 *
 * The helpers are extracted from the entrypoint so we don't need workerd
 * for the unit-test path; the harness in `test/workerd/` already exercises
 * the integrated `fetch` boundary.
 */
import { describe, expect, test } from "bun:test";
import type { ChardbManifest, CronDescriptor } from "../../src/server/manifest.ts";
import { emptyManifest } from "../../src/server/manifest.ts";
import { selectMatchingCrons } from "../../src/server/observability_helpers.ts";
import { ChardbRef } from "../../src/types.ts";

function manifestWithCrons(crons: readonly CronDescriptor[]): ChardbManifest {
    return { ...emptyManifest(), crons };
}

function cron(ref: string, cronExpr: string, invoke: () => void | Promise<void> = () => {}): CronDescriptor {
    return { ref: ChardbRef(ref), cronExpr, invoke };
}

describe("selectMatchingCrons", () => {
    test("empty cron expr returns nothing (the runtime fired without a cron string)", () => {
        expect(selectMatchingCrons(manifestWithCrons([cron("c#a", "*/5 * * * *")]), undefined)).toEqual([]);
        expect(selectMatchingCrons(manifestWithCrons([cron("c#a", "*/5 * * * *")]), "")).toEqual([]);
    });

    test("dispatches every cron whose expression equals event.cron, ignoring others", () => {
        const a = cron("c#a", "*/5 * * * *");
        const b = cron("c#b", "*/5 * * * *");
        const c = cron("c#c", "0 * * * *");
        const matched = selectMatchingCrons(manifestWithCrons([a, b, c]), "*/5 * * * *");
        expect(matched.map(m => m.ref)).toEqual([a.ref, b.ref]);
    });

    test("equality is exact-string — wrangler-normalised expressions only match themselves", () => {
        const matched = selectMatchingCrons(manifestWithCrons([cron("c#a", "*/5 * * * *")]), "* * * * *");
        expect(matched).toEqual([]);
    });
});

import { decorateResponse, extractCorrelationId } from "../../src/server/observability_helpers.ts";

describe("extractCorrelationId", () => {
    test("echoes an inbound correlation id verbatim", () => {
        const r = new Request("https://example.com/q", {
            headers: { "cf-chardb-correlation-id": "co-existing-1" },
        });
        expect(extractCorrelationId(r)).toBe("co-existing-1");
    });

    test("mints a UUIDv7 (sortable, RFC 9562) when no header is present", () => {
        const r = new Request("https://example.com/q");
        const id = extractCorrelationId(r);
        // UUIDv7 layout: <unix-ms>-<rand>; first hex segment is timestamp ms.
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    test("two requests at distinct ms produce monotonic-ish ids", async () => {
        const a = extractCorrelationId(new Request("https://example.com/q"));
        await new Promise(r => setTimeout(r, 2));
        const b = extractCorrelationId(new Request("https://example.com/q"));
        // First 8 hex chars are unix-ms; b shouldn't be smaller than a.
        expect(b.slice(0, 8) >= a.slice(0, 8)).toBe(true);
    });
});

describe("decorateResponse", () => {
    test("attaches Server-Timing, server version, and correlation id", () => {
        const inner = new Response("hi", { status: 201, headers: { "content-type": "text/plain" } });
        const decorated = decorateResponse(inner, 1_000, "co-1", "0.1.0", 1_042);
        expect(decorated.status).toBe(201);
        expect(decorated.headers.get("content-type")).toBe("text/plain");
        expect(decorated.headers.get("Server-Timing")).toBe('cdb;dur=42;desc="chardb total"');
        expect(decorated.headers.get("Cf-Chardb-Server-Version")).toBe("0.1.0");
        expect(decorated.headers.get("cf-chardb-correlation-id")).toBe("co-1");
    });

    test("clamps negative deltas to 0 (defends against clock skew between start and now)", () => {
        const inner = new Response(null, { status: 204 });
        const decorated = decorateResponse(inner, 2_000, "co-2", "0.1.0", 1_500);
        expect(decorated.headers.get("Server-Timing")).toBe('cdb;dur=0;desc="chardb total"');
    });

    test("preserves the body, status, and statusText", async () => {
        const inner = new Response("payload", { status: 418, statusText: "I'm a teapot" });
        const decorated = decorateResponse(inner, 0, "co-3", "0.1.0", 5);
        expect(decorated.status).toBe(418);
        expect(decorated.statusText).toBe("I'm a teapot");
        expect(await decorated.text()).toBe("payload");
    });

    test("does not duplicate Server-Timing if the inner response already set one (we replace, not append)", () => {
        const inner = new Response(null, { headers: { "Server-Timing": "user;dur=10" } });
        const decorated = decorateResponse(inner, 0, "co-4", "0.1.0", 7);
        // Today the entrypoint replaces; locking the behavior so a future
        // change that wants to merge user timings has to be deliberate.
        expect(decorated.headers.get("Server-Timing")).toBe('cdb;dur=7;desc="chardb total"');
    });

    test("preserves the Cloudflare WebSocket upgrade extension", () => {
        const webSocket = {} as WebSocket;
        const inner = new Response(null);
        Object.defineProperty(inner, "webSocket", { value: webSocket });

        const decorated = decorateResponse(inner, 0, "co-ws", "0.1.0", 1);

        expect((decorated as Response & { readonly webSocket?: WebSocket }).webSocket).toBe(webSocket);
    });
});
