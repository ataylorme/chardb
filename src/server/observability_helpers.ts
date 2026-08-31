/**
 * Pure observability helpers for the chardb `WorkerEntrypoint`.
 *
 * Lives in its own module (free of `cloudflare:workers` imports) so the
 * contract every chardb response promises — `cf-chardb-correlation-id`,
 * `Server-Timing` per the W3C grammar, `Cf-Chardb-Server-Version` — can
 * be unit-tested without booting workerd.
 */

import { uuidv7 } from "uuidv7";

export const CHARDB_SERVER_VERSION = "0.1.0";

/** Resolve the inbound correlation id, minting a UUIDv7 when absent. */
export function extractCorrelationId(request: Request): string {
    return request.headers.get("cf-chardb-correlation-id") ?? uuidv7();
}

/**
 * Wrap a handler `Response` with the chardb observability headers. The
 * `dt` field is clamped to ≥0 so a clock skew between `startMs` and
 * `nowMs` cannot produce a negative `Server-Timing` duration.
 */
export function decorateResponse(
    response: Response,
    startMs: number,
    correlationId: string,
    serverVersion: string,
    nowMs: number = Date.now()
): Response {
    const dt = Math.max(0, nowMs - startMs);
    const headers = new Headers(response.headers);
    headers.set("Server-Timing", `cdb;dur=${dt};desc="chardb total"`);
    headers.set("Cf-Chardb-Server-Version", serverVersion);
    headers.set("cf-chardb-correlation-id", correlationId);
    const webSocket = (response as Response & { readonly webSocket?: WebSocket }).webSocket;
    const decorated = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
        ...(webSocket === undefined ? {} : { webSocket }),
    } as ResponseInit);
    // Bun's standard Response ignores Cloudflare's WebSocket extension.
    // Keep the pure helper testable without changing workerd behavior.
    if (
        webSocket !== undefined &&
        (decorated as Response & { readonly webSocket?: WebSocket }).webSocket !== webSocket
    ) {
        Object.defineProperty(decorated, "webSocket", { value: webSocket });
    }
    return decorated;
}
