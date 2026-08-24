import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";
import { Catalog } from "../../src/server/do/catalog.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

async function catalogFixture(db: Database): Promise<Catalog> {
    let bootstrap = Promise.resolve();
    const state = {
        storage: {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            bootstrap = callback().then(() => undefined);
        },
    } as unknown as DurableObjectState;
    const catalog = new Catalog(state, {});
    await bootstrap;
    return catalog;
}

async function publicJwk(kid: string) {
    const { publicKey } = await generateKeyPair("ES256");
    return { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("Catalog-owned JWKS refresh", () => {
    test("fails bootstrap when an internal refresh table has an incompatible shape", async () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE catalog_jwks_refresh (jwks_url TEXT PRIMARY KEY)");
            await expect(catalogFixture(db)).rejects.toMatchObject({ code: "CDB_INVARIANT" });
        } finally {
            db.close();
        }
    });

    test("singleflights different kids and retires absent keys in one replacement", async () => {
        const db = new Database(":memory:");
        try {
            const catalog = await catalogFixture(db);
            const first = await publicJwk("key-1");
            const second = await publicJwk("key-2");
            let releaseFetch: (() => void) | undefined;
            const fetchHeld = new Promise<void>(resolve => {
                releaseFetch = resolve;
            });
            let fetches = 0;
            let keys = [first, second];
            globalThis.fetch = (async () => {
                fetches++;
                await fetchHeld;
                return Response.json({ keys });
            }) as unknown as typeof fetch;

            const firstResolution = catalog.resolveJwk({ kid: "key-1", jwksUrl: "https://issuer.example/jwks" });
            const secondResolution = catalog.resolveJwk({ kid: "key-2", jwksUrl: "https://issuer.example/jwks" });
            releaseFetch?.();
            await expect(firstResolution).resolves.toMatchObject({ ok: true });
            await expect(secondResolution).resolves.toMatchObject({ ok: true });
            expect(fetches).toBe(1);

            keys = [second];
            db.query("UPDATE catalog_jwks_v2 SET expires_at = 0 WHERE jwks_url = ? AND kid = ?").run(
                "https://issuer.example/jwks",
                "key-1"
            );
            await expect(catalog.resolveJwk({ kid: "key-1", jwksUrl: "https://issuer.example/jwks" })).resolves.toEqual(
                { ok: true, jwkJson: null }
            );
            expect(fetches).toBe(2);
            expect(db.query("SELECT kid FROM catalog_jwks_v2 ORDER BY kid").all() as Array<{ kid: string }>).toEqual([
                { kid: "key-2" },
            ]);
        } finally {
            db.close();
        }
    });

    test("keeps the same kid isolated across two JWKS URLs", async () => {
        const db = new Database(":memory:");
        try {
            const catalog = await catalogFixture(db);
            const issuerA = await publicJwk("shared-kid");
            const issuerB = await publicJwk("shared-kid");
            globalThis.fetch = (async input =>
                Response.json({ keys: [String(input).includes("issuer-a") ? issuerA : issuerB] })) as typeof fetch;

            await catalog.resolveJwk({ kid: "shared-kid", jwksUrl: "https://issuer-a.example/jwks" });
            await catalog.resolveJwk({ kid: "shared-kid", jwksUrl: "https://issuer-b.example/jwks" });
            const beforeLegacyWrite = db
                .query("SELECT jwks_url, jwk_json, expires_at FROM catalog_jwks_v2 ORDER BY jwks_url")
                .all() as Array<{ jwks_url: string; jwk_json: string; expires_at: number }>;
            expect(beforeLegacyWrite).toHaveLength(2);
            expect(beforeLegacyWrite[0]?.jwk_json).not.toBe(beforeLegacyWrite[1]?.jwk_json);

            await catalog.putJwk("shared-kid", JSON.stringify(issuerA), -1);
            const afterLegacyWrite = db
                .query("SELECT jwks_url, jwk_json, expires_at FROM catalog_jwks_v2 ORDER BY jwks_url")
                .all() as Array<{ jwks_url: string; jwk_json: string; expires_at: number }>;
            expect(afterLegacyWrite).toEqual(beforeLegacyWrite);
        } finally {
            db.close();
        }
    });

    test("never resolves a fresh legacy key for a different URL on first lookup", async () => {
        const db = new Database(":memory:");
        try {
            const catalog = await catalogFixture(db);
            const legacy = await publicJwk("shared-kid");
            const issuerB = await publicJwk("issuer-b-only");
            await catalog.putJwk("shared-kid", JSON.stringify(legacy), 60_000);
            let fetches = 0;
            globalThis.fetch = (async () => {
                fetches++;
                return Response.json({ keys: [issuerB] });
            }) as unknown as typeof fetch;

            await expect(
                catalog.resolveJwk({ kid: "shared-kid", jwksUrl: "https://issuer-b.example/jwks" })
            ).resolves.toEqual({ ok: true, jwkJson: null });
            expect(fetches).toBe(1);
            expect(
                db
                    .query("SELECT kid FROM catalog_jwks_v2 WHERE jwks_url = ? ORDER BY kid")
                    .all("https://issuer-b.example/jwks")
            ).toEqual([{ kid: "issuer-b-only" }]);
        } finally {
            db.close();
        }
    });

    test("persists failure cooldown and never returns an expired key", async () => {
        const db = new Database(":memory:");
        try {
            const catalog = await catalogFixture(db);
            const key = await publicJwk("key-1");
            let fetches = 0;
            globalThis.fetch = (async () => {
                fetches++;
                return Response.json({ keys: [key] });
            }) as unknown as typeof fetch;
            await expect(
                catalog.resolveJwk({ kid: "key-1", jwksUrl: "https://issuer.example/jwks" })
            ).resolves.toMatchObject({ ok: true });
            db.query("UPDATE catalog_jwks_v2 SET expires_at = 0 WHERE jwks_url = ? AND kid = ?").run(
                "https://issuer.example/jwks",
                "key-1"
            );

            globalThis.fetch = (async () => {
                fetches++;
                throw new Error("offline");
            }) as unknown as typeof fetch;
            await expect(
                catalog.resolveJwk({ kid: "key-1", jwksUrl: "https://issuer.example/jwks" })
            ).resolves.toMatchObject({ ok: false, retryAfterMs: 1_000 });
            expect(fetches).toBe(2);

            const reconstructed = await catalogFixture(db);
            await expect(
                reconstructed.resolveJwk({ kid: "key-1", jwksUrl: "https://issuer.example/jwks" })
            ).resolves.toMatchObject({ ok: false });
            expect(fetches).toBe(2);
        } finally {
            db.close();
        }
    });

    test("reconstruction honors an active refresh lease and takes over after expiry", async () => {
        const db = new Database(":memory:");
        try {
            await catalogFixture(db);
            const jwksUrl = "https://issuer.example/jwks";
            db.query(
                `INSERT INTO catalog_jwks_refresh
                 (jwks_url, next_fetch_at, refreshing_until, failure_count, last_success_at)
                 VALUES (?, 0, ?, 0, NULL)`
            ).run(jwksUrl, Date.now() + 10_000);
            const key = await publicJwk("key-1");
            let fetches = 0;
            globalThis.fetch = (async () => {
                fetches++;
                return Response.json({ keys: [key] });
            }) as unknown as typeof fetch;

            const reconstructed = await catalogFixture(db);
            await expect(reconstructed.resolveJwk({ kid: "key-1", jwksUrl })).resolves.toMatchObject({ ok: false });
            expect(fetches).toBe(0);

            db.query("UPDATE catalog_jwks_refresh SET refreshing_until = 0 WHERE jwks_url = ?").run(jwksUrl);
            await expect(reconstructed.resolveJwk({ kid: "key-1", jwksUrl })).resolves.toMatchObject({ ok: true });
            expect(fetches).toBe(1);
        } finally {
            db.close();
        }
    });
});
