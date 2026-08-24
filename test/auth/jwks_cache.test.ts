import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";
import { createCatalogJwksResolver, fetchValidatedJwks } from "../../src/auth/jwks_cache.ts";

const URL = "https://issuer.example/jwks";

async function validJwk(kid = "key-1") {
    const { publicKey } = await generateKeyPair("ES256");
    return { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
}

function response(body: unknown, init?: ResponseInit): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

describe("strict JWKS document validation", () => {
    test("accepts one bounded public signing key", async () => {
        const jwk = await validJwk();
        await expect(fetchValidatedJwks(async () => response({ keys: [jwk] }), URL)).resolves.toEqual({
            keys: [jwk],
        });
    });

    test("maps upstream throws, non-2xx, and invalid JSON to retryable Catalog failures", async () => {
        const cases = [
            () => fetchValidatedJwks(async () => Promise.reject(new Error("offline")), URL),
            () => fetchValidatedJwks(async () => response("down", { status: 503 }), URL),
            () => fetchValidatedJwks(async () => response("{"), URL),
        ];
        for (const run of cases) {
            await expect(run()).rejects.toMatchObject({ code: "CDB_CATALOG_UNAVAILABLE", retryable: true });
        }
    });

    test("aborts a held fetch when the operation times out", async () => {
        let observedAbort = false;
        const heldFetch = async (_url: string, init?: RequestInit): Promise<Response> =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener(
                    "abort",
                    () => {
                        observedAbort = true;
                        reject(init.signal?.reason);
                    },
                    { once: true }
                );
            });
        await expect(fetchValidatedJwks(heldFetch, URL, { timeoutMs: 1 })).rejects.toMatchObject({
            code: "CDB_CATALOG_UNAVAILABLE",
            retryable: true,
        });
        expect(observedAbort).toBe(true);
    });

    test("rejects empty, malformed, duplicate, excessive, and oversized key sets", async () => {
        const jwk = await validJwk();
        const cases: Array<() => Promise<unknown>> = [
            () => fetchValidatedJwks(async () => response({}), URL),
            () => fetchValidatedJwks(async () => response({ keys: [] }), URL),
            () => fetchValidatedJwks(async () => response({ keys: [null] }), URL),
            () => fetchValidatedJwks(async () => response({ keys: [{ kid: "missing-material", kty: "EC" }] }), URL),
            () => fetchValidatedJwks(async () => response({ keys: [jwk, jwk] }), URL),
            () =>
                fetchValidatedJwks(async () => response({ keys: [jwk, { ...jwk, kid: "key-2" }] }), URL, {
                    maxKeys: 1,
                }),
            () =>
                fetchValidatedJwks(async () => response({ keys: [{ ...jwk, kid: "too-long" }] }), URL, {
                    maxKidBytes: 3,
                }),
            () =>
                fetchValidatedJwks(async () => response({ keys: [jwk], padding: "x".repeat(256) }), URL, {
                    maxDocumentBytes: 64,
                }),
        ];
        for (const run of cases) {
            await expect(run()).rejects.toMatchObject({ code: "CDB_CATALOG_UNAVAILABLE", retryable: true });
        }
    });
});

describe("compatibility Catalog JWKS resolver", () => {
    test("uses a fresh cache entry without fetching", async () => {
        const jwk = await validJwk();
        let fetches = 0;
        const resolver = createCatalogJwksResolver({
            jwksUrl: URL,
            catalog: {
                async getJwk() {
                    return { jwkJson: JSON.stringify(jwk), expiresAt: Date.now() + 60_000 };
                },
                async putJwk() {},
            },
            fetch: async () => {
                fetches++;
                return response({ keys: [jwk] });
            },
        });
        await expect(resolver("key-1")).resolves.toEqual(jwk);
        expect(fetches).toBe(0);
    });

    test("never falls back to an expired key when refresh fails", async () => {
        const jwk = await validJwk();
        const resolver = createCatalogJwksResolver({
            jwksUrl: URL,
            catalog: {
                async getJwk() {
                    return { jwkJson: JSON.stringify(jwk), expiresAt: Date.now() - 1 };
                },
                async putJwk() {},
            },
            fetch: async () => {
                throw new Error("offline");
            },
        });
        await expect(resolver("key-1")).rejects.toMatchObject({
            code: "CDB_CATALOG_UNAVAILABLE",
            retryable: true,
        });
    });

    test("returns null for a missing kid in a valid document and caches every validated key", async () => {
        const first = await validJwk("key-1");
        const second = await validJwk("key-2");
        const writes: string[] = [];
        const resolver = createCatalogJwksResolver({
            jwksUrl: URL,
            catalog: {
                async getJwk() {
                    return null;
                },
                async putJwk(kid) {
                    writes.push(kid);
                },
            },
            fetch: async () => response({ keys: [first, second] }),
        });
        await expect(resolver("missing")).resolves.toBeNull();
        expect(writes).toEqual(["key-1", "key-2"]);
    });
});
