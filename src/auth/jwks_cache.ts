/**
 * JWKS resolver backed by the Catalog DO's `catalog_jwks` SWR cache.
 *
 * Better-auth's `jwt()` plugin exposes the JWKS at `/api/auth/jwks`.
 * The Gateway DO can't make outbound HTTP requests to its own Worker
 * cheaply on every connection — so we cache the resolved JWK set in
 * the Catalog DO and refresh it lazily when:
 *
 *   - the requested `kid` is missing from the cache (cold-start path),
 *   - the cached entry is past its `expires_at` (TTL refresh).
 *
 * The cache is shared across every Gateway instance because all of
 * them route through the singleton Catalog DO. Concurrent fetches for
 * the same `kid` are serialized at the Catalog DO's input gate, so
 * we never fan out N parallel JWKS pulls during a thundering-herd
 * boot of N websockets.
 */

import type { JWK } from "jose";
import { CdbError } from "../errors.ts";
import type { JwksResolver } from "./jwt.ts";

/** Default freshness — better-auth's `jwt` plugin rotates keys every ~30d. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CatalogJwksRpc {
    getJwk(kid: string): Promise<{ jwkJson: string; expiresAt: number } | null>;
    putJwk(kid: string, jwkJson: string, ttlMs: number): Promise<void>;
}

interface JwksDocument {
    readonly keys: readonly JWK[];
}

export interface CatalogJwksResolverOptions {
    /**
     * Catalog DO RPC stub. Caller resolves the singleton id
     * (`env.CDB_CATALOG.idFromName("global")`) and hands the stub in.
     */
    readonly catalog: CatalogJwksRpc;
    /**
     * Absolute URL the better-auth `jwt()` plugin serves the JWKS at —
     * normally `${baseURL}/api/auth/jwks`. The resolver fetches this
     * URL on cache miss; the entrypoint Worker can route the request
     * back to itself via the same fetch handler since `/api/auth/*`
     * is mounted by `mountChardb`.
     */
    readonly jwksUrl: string;
    /** Cache entry TTL in milliseconds. Defaults to 1h. */
    readonly ttlMs?: number;
    /**
     * Custom fetcher — useful in tests (no network) or to inject
     * a service-binding-routed fetch when the Worker has its own
     * RPC stub for the Worker that hosts better-auth.
     */
    readonly fetch?: (url: string) => Promise<Response>;
}

export function createCatalogJwksResolver(opts: CatalogJwksResolverOptions): JwksResolver {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis);

    return async (kid: string): Promise<JWK | null> => {
        const cached = await opts.catalog.getJwk(kid);
        if (cached && cached.expiresAt > Date.now()) {
            return JSON.parse(cached.jwkJson) as JWK;
        }
        // Cache miss or stale — fetch + cache. We refresh the entire
        // JWKS in one round-trip (better-auth never lists more than a
        // handful of keys at a time) so a wave of unknown-kid requests
        // converges to a single fetch.
        const fresh = await fetchJwks(fetcher, opts.jwksUrl);
        let found: JWK | null = null;
        for (const key of fresh.keys) {
            if (typeof key.kid !== "string") continue;
            await opts.catalog.putJwk(key.kid, JSON.stringify(key), ttlMs);
            if (key.kid === kid) found = key;
        }
        return found;
    };
}

async function fetchJwks(fetcher: (url: string) => Promise<Response>, url: string): Promise<JwksDocument> {
    const res = await fetcher(url);
    if (!res.ok) {
        throw new CdbError({
            code: "CDB_FORBIDDEN",
            message: `jwks_cache: ${url} returned ${res.status}`,
        });
    }
    const doc = (await res.json()) as JwksDocument;
    if (!doc || !Array.isArray(doc.keys)) {
        throw new CdbError({
            code: "CDB_FORBIDDEN",
            message: "jwks_cache: malformed JWKS document",
        });
    }
    return doc;
}
