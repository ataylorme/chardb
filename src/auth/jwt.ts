/**
 * Minimal pure JWT decoding for chardb's `Gateway.hello`.
 *
 * The Gateway needs a stable `principalId` derived from the inbound JWT so
 * subscription routing and op-log dedup can key on the authenticated user.
 * A full RFC 7519 verifier (signature + JWKS) is out of scope for this
 * helper — that lives one layer up alongside the `catalog_jwks` SWR cache
 * and is invoked by the entrypoint before the websocket upgrade.
 *
 * What this module *does* guarantee:
 *
 *   - `decodeJwtClaims` rejects malformed tokens (no two dots, non-object
 *     payload, unparseable base64url).
 *   - `decodeJwtClaims` rejects tokens whose `exp` is at or before `now`.
 *   - Returns a typed claims object — never `unknown`/`any`.
 *
 * Callers MUST treat the returned `principalId` as authentic only after a
 * separate signature verification step succeeds. Until JWKS verification
 * is wired through `Gateway.onHello`, the `Gateway.principalId` derived
 * from this helper is a soft-trust hint used for routing and presence
 * bucket keys; the actual write paths (Gateway mutation dispatch / `crossPartitionMutation`)
 * MUST re-verify before they grant authority.
 *
 * RFC 7519 §4.1 defines the registered claims used here:
 * https://datatracker.ietf.org/doc/html/rfc7519#section-4.1
 */

import { type JWK, importJWK, errors as joseErrors, jwtVerify } from "jose";
import { CdbError } from "../errors.ts";
import { PrincipalId } from "../types.ts";

export interface JwtClaims {
    /** Subject — the principal the token represents. */
    readonly sub?: string;
    /** Issuer. */
    readonly iss?: string;
    /** Audience(s). */
    readonly aud?: string | readonly string[];
    /** Expiry, seconds since the epoch. */
    readonly exp?: number;
    /** Issued-at, seconds since the epoch. */
    readonly iat?: number;
    /** JWT ID (anti-replay). */
    readonly jti?: string;
    /** Custom claims kept opaque — typed `unknown` so callers must narrow. */
    readonly [k: string]: unknown;
}

export interface DecodedJwt {
    readonly kid: string;
    readonly alg: string;
    readonly claims: JwtClaims;
}

/**
 * Pure base64url decoder — accepts the URL-safe alphabet (no `+`/`/`) and
 * tolerates missing trailing padding per RFC 4648 §5.
 */
export function base64UrlDecode(input: string): string {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const fillerNeeded = (4 - (padded.length % 4)) % 4;
    return atob(padded + "=".repeat(fillerNeeded));
}

/**
 * Decode an unverified JWT. Returns the parsed header + claims, or `null`
 * if the token is malformed or expired. Does NOT verify the signature.
 *
 * `nowSeconds` is injectable for deterministic tests; the production path
 * passes `Math.floor(Date.now() / 1000)`.
 */
export function decodeJwtClaims(
    jwt: string | undefined,
    nowSeconds: number = Math.floor(Date.now() / 1000)
): DecodedJwt | null {
    if (!jwt) return null;
    const firstDot = jwt.indexOf(".");
    const lastDot = jwt.lastIndexOf(".");
    if (firstDot < 0 || firstDot === lastDot) return null;
    const headerRaw = jwt.slice(0, firstDot);
    const payloadRaw = jwt.slice(firstDot + 1, lastDot);
    let header: { kid?: unknown; alg?: unknown } | null;
    let claims: { [k: string]: unknown } | null;
    try {
        header = JSON.parse(base64UrlDecode(headerRaw)) as { kid?: unknown; alg?: unknown };
        claims = JSON.parse(base64UrlDecode(payloadRaw)) as { [k: string]: unknown };
    } catch {
        return null;
    }
    if (header === null || typeof header !== "object") return null;
    if (claims === null || typeof claims !== "object") return null;
    const exp = typeof claims.exp === "number" ? claims.exp : undefined;
    if (exp !== undefined && exp <= nowSeconds) return null;
    return {
        kid: typeof header.kid === "string" ? header.kid : "",
        alg: typeof header.alg === "string" ? header.alg : "",
        claims: claims as JwtClaims,
    };
}

/**
 * Project the `sub` claim into a `PrincipalId`. Returns `null` when the
 * token is missing/expired/malformed or when `sub` is absent — callers
 * should fall back to a clientId projection so subscription routing
 * still works for unauthenticated traffic.
 */
export function principalIdFromJwt(jwt: string | undefined, nowSeconds?: number): PrincipalId | null {
    const decoded = decodeJwtClaims(jwt, nowSeconds);
    if (!decoded) return null;
    const sub = decoded.claims.sub;
    if (typeof sub !== "string" || sub.length === 0) return null;
    return PrincipalId(sub);
}

/**
 * Resolver function the Gateway hands `verifyJwt`. Receives the JWT
 * `kid` and returns a JWK to verify against — typically backed by the
 * Catalog DO's `catalog_jwks` SWR cache (see `jwks_cache.ts`). Returning
 * `null` causes verification to fail with `CDB_FORBIDDEN`.
 */
export type JwksResolver = (kid: string) => Promise<JWK | null> | JWK | null;

export interface VerifyJwtOptions {
    readonly resolver: JwksResolver;
    /**
     * Expected `iss` claim. If unset, the issuer field is not checked
     * (useful for tests; the production Gateway always pins it to the
     * better-auth `baseURL` of the deployment).
     */
    readonly issuer?: string;
    /** Expected `aud` claim. Same opt-out semantics as `issuer`. */
    readonly audience?: string;
    /** Allowed clock skew in seconds. Defaults to 30. */
    readonly clockToleranceSeconds?: number;
}

/**
 * Verify a JWT against a JWKS resolver and return its claims.
 *
 * Wraps `jose.jwtVerify` with chardb-shaped error mapping: any
 * verification failure surfaces as `CDB_FORBIDDEN` so callers (the
 * Gateway, the entrypoint) get a single locked error code to react
 * to. Unknown `kid`s yield the same code — the typical recovery is a
 * JWKS refresh + retry.
 */
export async function verifyJwt(jwt: string, opts: VerifyJwtOptions): Promise<JwtClaims> {
    const decoded = decodeJwtClaims(jwt);
    if (!decoded) {
        throw new CdbError({ code: "CDB_FORBIDDEN", message: "verifyJwt: malformed or expired JWT" });
    }
    const jwk = await opts.resolver(decoded.kid);
    if (!jwk) {
        throw new CdbError({
            code: "CDB_FORBIDDEN",
            message: `verifyJwt: no JWK for kid ${decoded.kid || "(unset)"}`,
        });
    }
    try {
        const key = await importJWK(jwk, decoded.alg);
        const { payload } = await jwtVerify(jwt, key, {
            ...(opts.issuer ? { issuer: opts.issuer } : {}),
            ...(opts.audience ? { audience: opts.audience } : {}),
            clockTolerance: opts.clockToleranceSeconds ?? 30,
        });
        return payload as JwtClaims;
    } catch (cause) {
        const message =
            cause instanceof joseErrors.JOSEError ? cause.message : "verifyJwt: signature verification failed";
        throw new CdbError({ code: "CDB_FORBIDDEN", message, cause });
    }
}
