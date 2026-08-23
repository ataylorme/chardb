import { Catalog } from "../../src/server/do/catalog.ts";
import { configureGatewayRuntime } from "../../src/server/do/gateway.ts";
import { emptyManifest } from "../../src/server/manifest.ts";

export { Catalog };

export const Gateway = configureGatewayRuntime({
    manifest: emptyManifest,
    auth: {
        issuer: "https://issuer.example",
        audience: "chardb-workerd",
        algorithms: ["ES256"],
        // The harness seeds Catalog's real SQLite-backed cache before each
        // handshake, so this URL must never be fetched.
        jwksUrl: "https://unreachable.invalid/jwks",
        authBasePath: "/api/auth",
        jwksPath: "/jwks",
        clockToleranceSeconds: 0,
    },
});

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/seed-jwk") {
            const body = (await request.json()) as { readonly kid: string; readonly jwk: JsonWebKey };
            const id = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(id) as unknown as {
                putJwk(kid: string, jwkJson: string, ttlMs: number): Promise<void>;
            };
            await catalog.putJwk(body.kid, JSON.stringify(body.jwk), 60_000);
            return Response.json({ ok: true });
        }
        if (url.pathname === "/ws") {
            const id = env.CDB_GATEWAY.idFromName("gateway-jwt-probe");
            return env.CDB_GATEWAY.get(id).fetch(request);
        }
        return new Response("not found", { status: 404 });
    },
};
