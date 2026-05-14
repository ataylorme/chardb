/**
 * Tests for the pure unverified JWT decoder used by `Gateway.onHello`.
 *
 * Signature verification is layered on later via the `catalog_jwks` SWR
 * cache; this helper's contract is to surface a stable `principalId` (or
 * `null`) without trusting the token.
 */
import { describe, expect, test } from "bun:test";
import { base64UrlDecode, decodeJwtClaims, principalIdFromJwt } from "../../src/auth/jwt.ts";

const NOW = 1_700_000_000;

function b64url(s: string): string {
    return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function token(headerObj: Record<string, unknown>, payloadObj: Record<string, unknown>): string {
    const header = b64url(JSON.stringify(headerObj));
    const payload = b64url(JSON.stringify(payloadObj));
    return `${header}.${payload}.sigplaceholder`;
}

describe("base64UrlDecode", () => {
    test("URL-safe alphabet round-trips through atob", () => {
        expect(base64UrlDecode(b64url("hello"))).toBe("hello");
        expect(base64UrlDecode(b64url("a/b+c"))).toBe("a/b+c");
    });

    test("missing padding is tolerated", () => {
        const raw = btoa("café").replace(/=+$/, "");
        expect(base64UrlDecode(raw)).toBe("café");
    });
});

describe("decodeJwtClaims", () => {
    test("returns null for missing or malformed tokens", () => {
        expect(decodeJwtClaims(undefined, NOW)).toBeNull();
        expect(decodeJwtClaims("", NOW)).toBeNull();
        expect(decodeJwtClaims("not-a-jwt", NOW)).toBeNull();
        expect(decodeJwtClaims("only.one", NOW)).toBeNull();
        expect(decodeJwtClaims("a.b.c.d", NOW)).toBeNull();
    });

    test("decodes header.kid and claim payload", () => {
        const t = token({ alg: "EdDSA", kid: "k-2024" }, { sub: "u-1", iss: "acme", exp: NOW + 60 });
        const decoded = decodeJwtClaims(t, NOW);
        expect(decoded).not.toBeNull();
        expect(decoded?.kid).toBe("k-2024");
        expect(decoded?.alg).toBe("EdDSA");
        expect(decoded?.claims.sub).toBe("u-1");
        expect(decoded?.claims.iss).toBe("acme");
    });

    test("rejects expired tokens", () => {
        const t = token({ alg: "EdDSA", kid: "k1" }, { sub: "u-1", exp: NOW - 1 });
        expect(decodeJwtClaims(t, NOW)).toBeNull();
    });

    test("rejects tokens whose claims root is non-object", () => {
        const header = b64url(JSON.stringify({ alg: "EdDSA", kid: "k1" }));
        const payload = b64url(JSON.stringify("just-a-string"));
        expect(decodeJwtClaims(`${header}.${payload}.s`, NOW)).toBeNull();
    });

    test("missing exp is allowed (caller's responsibility to require it)", () => {
        const t = token({ alg: "EdDSA", kid: "k1" }, { sub: "u-1" });
        expect(decodeJwtClaims(t, NOW)?.claims.sub).toBe("u-1");
    });

    test("malformed base64 is rejected without throwing", () => {
        expect(decodeJwtClaims("!!.!!.sig", NOW)).toBeNull();
    });
});

describe("principalIdFromJwt", () => {
    test("projects sub claim into a PrincipalId brand", () => {
        const t = token({ alg: "EdDSA", kid: "k1" }, { sub: "user_42", exp: NOW + 60 });
        const pid = principalIdFromJwt(t, NOW);
        expect(pid).toBe("user_42" as ReturnType<typeof principalIdFromJwt>);
    });

    test("returns null when sub is missing", () => {
        const t = token({ alg: "EdDSA", kid: "k1" }, { exp: NOW + 60 });
        expect(principalIdFromJwt(t, NOW)).toBeNull();
    });

    test("returns null when sub is non-string", () => {
        const t = token({ alg: "EdDSA", kid: "k1" }, { sub: 42, exp: NOW + 60 });
        expect(principalIdFromJwt(t, NOW)).toBeNull();
    });

    test("returns null for expired tokens", () => {
        const t = token({ alg: "EdDSA", kid: "k1" }, { sub: "u-1", exp: NOW - 1 });
        expect(principalIdFromJwt(t, NOW)).toBeNull();
    });
});
