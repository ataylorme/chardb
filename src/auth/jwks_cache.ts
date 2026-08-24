/** Catalog-backed JWKS lookup and strict remote-document validation. */

import type { JWK } from "jose";
import { CdbError } from "../errors.ts";
import type { JwksResolver } from "./jwt.ts";

export const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
export const JWKS_REFRESH_LEASE_MS = 10_000;
export const JWKS_MAX_DOCUMENT_BYTES = 256 * 1024;
export const JWKS_MAX_KEYS = 32;
export const JWKS_MAX_KID_BYTES = 256;
export const JWKS_SUCCESS_COOLDOWN_MS = 5_000;
export const JWKS_FAILURE_BACKOFF_INITIAL_MS = 1_000;
export const JWKS_FAILURE_BACKOFF_MAX_MS = 60_000;

interface CatalogJwksRpc {
    getJwk(kid: string): Promise<{ jwkJson: string; expiresAt: number } | null>;
    putJwk(kid: string, jwkJson: string, ttlMs: number): Promise<void>;
}

export type JwksFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface CatalogJwkResolutionRequest {
    readonly kid: string;
    readonly jwksUrl: string;
}

export type CatalogJwkResolution =
    | { readonly ok: true; readonly jwkJson: string | null }
    | { readonly ok: false; readonly message: string; readonly retryAfterMs: number };

export interface CatalogOwnedJwksRpc {
    resolveJwk(request: CatalogJwkResolutionRequest): Promise<CatalogJwkResolution>;
}

export interface CatalogJwksResolverOptions {
    readonly catalog: CatalogJwksRpc;
    readonly jwksUrl: string;
    readonly ttlMs?: number;
    readonly fetch?: JwksFetcher;
}

export interface FetchJwksOptions {
    readonly timeoutMs?: number;
    readonly maxDocumentBytes?: number;
    readonly maxKeys?: number;
    readonly maxKidBytes?: number;
}

export interface ValidatedJwksDocument {
    readonly keys: readonly JWK[];
}

/**
 * Compatibility resolver for direct callers and unit tests. Production
 * Gateway verification uses the Catalog-owned resolver below so refresh
 * coordination and cooldown state are shared across Gateway objects.
 */
export function createCatalogJwksResolver(opts: CatalogJwksResolverOptions): JwksResolver {
    const ttlMs = opts.ttlMs ?? JWKS_CACHE_TTL_MS;
    const fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis);

    return async (kid: string): Promise<JWK | null> => {
        const cached = await opts.catalog.getJwk(kid);
        if (cached && cached.expiresAt > Date.now()) return parseCachedJwk(cached.jwkJson);

        const fresh = await fetchValidatedJwks(fetcher, opts.jwksUrl);
        let found: JWK | null = null;
        for (const key of fresh.keys) {
            await opts.catalog.putJwk(key.kid as string, JSON.stringify(key), ttlMs);
            if (key.kid === kid) found = key;
        }
        return found;
    };
}

/** Resolve through the singleton Catalog without exposing cache state to Gateway. */
export function createCatalogOwnedJwksResolver(catalog: CatalogOwnedJwksRpc, jwksUrl: string): JwksResolver {
    return async (kid: string): Promise<JWK | null> => {
        const result = await catalog.resolveJwk({ kid, jwksUrl });
        if (!result.ok) {
            throw new CdbError({
                code: "CDB_CATALOG_UNAVAILABLE",
                message: result.message,
                retryAfterMs: result.retryAfterMs,
            });
        }
        return result.jwkJson === null ? null : parseCachedJwk(result.jwkJson);
    };
}

export function parseCachedJwk(jwkJson: string): JWK {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jwkJson);
    } catch (cause) {
        throw jwksUnavailable("jwks_cache: cached JWK is invalid JSON", cause);
    }
    return validateJwk(parsed, JWKS_MAX_KID_BYTES, new Set<string>());
}

export async function fetchValidatedJwks(
    fetcher: JwksFetcher,
    url: string,
    options: FetchJwksOptions = {}
): Promise<ValidatedJwksDocument> {
    const timeoutMs = options.timeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
    const maxDocumentBytes = options.maxDocumentBytes ?? JWKS_MAX_DOCUMENT_BYTES;
    const maxKeys = options.maxKeys ?? JWKS_MAX_KEYS;
    const maxKidBytes = options.maxKidBytes ?? JWKS_MAX_KID_BYTES;

    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            abort.abort("JWKS fetch timed out");
            reject(jwksUnavailable(`jwks_cache: ${url} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    try {
        const response = await Promise.race([fetcher(url, { signal: abort.signal }), timedOut]);
        if (!response.ok) throw jwksUnavailable(`jwks_cache: ${url} returned ${response.status}`);
        const text = await Promise.race([readBoundedBody(response, maxDocumentBytes), timedOut]);
        let document: unknown;
        try {
            document = JSON.parse(text);
        } catch (cause) {
            throw jwksUnavailable("jwks_cache: invalid JWKS JSON", cause);
        }
        if (document === null || typeof document !== "object" || Array.isArray(document)) {
            throw jwksUnavailable("jwks_cache: JWKS root must be an object");
        }
        const keys = (document as { readonly keys?: unknown }).keys;
        if (!Array.isArray(keys) || keys.length === 0) {
            throw jwksUnavailable("jwks_cache: JWKS keys must be a nonempty array");
        }
        if (keys.length > maxKeys) {
            throw jwksUnavailable(`jwks_cache: JWKS exceeds the ${maxKeys}-key limit`);
        }

        const kids = new Set<string>();
        return { keys: keys.map(key => validateJwk(key, maxKidBytes, kids)) };
    } catch (cause) {
        if (cause instanceof CdbError) throw cause;
        throw jwksUnavailable(`jwks_cache: ${url} fetch failed`, cause);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

function validateJwk(value: unknown, maxKidBytes: number, kids: Set<string>): JWK {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw jwksUnavailable("jwks_cache: each JWK must be an object");
    }
    const key = value as Record<string, unknown>;
    if (typeof key.kid !== "string" || key.kid.length === 0) {
        throw jwksUnavailable("jwks_cache: each JWK must have a nonempty kid");
    }
    if (new TextEncoder().encode(key.kid).byteLength > maxKidBytes) {
        throw jwksUnavailable(`jwks_cache: JWK kid exceeds ${maxKidBytes} bytes`);
    }
    if (kids.has(key.kid)) throw jwksUnavailable(`jwks_cache: duplicate JWK kid ${key.kid}`);
    kids.add(key.kid);
    if (typeof key.kty !== "string" || key.kty.length === 0) {
        throw jwksUnavailable(`jwks_cache: JWK ${key.kid} is missing kty`);
    }
    if (key.alg !== undefined && (typeof key.alg !== "string" || key.alg.length === 0)) {
        throw jwksUnavailable(`jwks_cache: JWK ${key.kid} has an invalid alg`);
    }
    if (key.use !== undefined && typeof key.use !== "string") {
        throw jwksUnavailable(`jwks_cache: JWK ${key.kid} has an invalid use`);
    }
    if (key.key_ops !== undefined && !isStringArray(key.key_ops)) {
        throw jwksUnavailable(`jwks_cache: JWK ${key.kid} has invalid key_ops`);
    }
    validateKeyMaterial(key);
    return key as JWK;
}

function validateKeyMaterial(key: Record<string, unknown>): void {
    const required =
        key.kty === "EC"
            ? ["crv", "x", "y"]
            : key.kty === "OKP"
              ? ["crv", "x"]
              : key.kty === "RSA"
                ? ["n", "e"]
                : key.kty === "oct"
                  ? ["k"]
                  : null;
    if (required === null) throw jwksUnavailable(`jwks_cache: JWK ${String(key.kid)} has unsupported kty`);
    for (const field of required) {
        if (typeof key[field] !== "string" || key[field].length === 0) {
            throw jwksUnavailable(`jwks_cache: JWK ${String(key.kid)} is missing ${field}`);
        }
    }
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw jwksUnavailable(`jwks_cache: JWKS exceeds ${maxBytes} bytes`);
            }
            chunks.push(value);
        }
    } catch (cause) {
        if (cause instanceof CdbError) throw cause;
        throw jwksUnavailable("jwks_cache: failed to read JWKS response", cause);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
}

function jwksUnavailable(message: string, cause?: unknown): CdbError {
    return new CdbError({
        code: "CDB_CATALOG_UNAVAILABLE",
        message,
        ...(cause === undefined ? {} : { cause }),
    });
}
