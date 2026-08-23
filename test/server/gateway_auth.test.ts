import { describe, expect, test } from "bun:test";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { gatewayJwtConfigFromAuthOptions } from "../../src/server/chardb.ts";
import {
    type GatewayJwtConfig,
    isCurrentVerifiedAttachment,
    trustedMutationAuthFromAttachment,
    verifyGatewayJwt,
} from "../../src/server/do/gateway.ts";
import { ClientId, PrincipalId } from "../../src/types.ts";

const ORIGIN = "https://app.example";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-app";
const KID = "key-1";
const CONNECTION_ID = "connection-1";

async function signingFixture() {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    const catalog = {
        async getJwk(kid: string) {
            return kid === KID
                ? {
                      jwkJson: JSON.stringify({ ...jwk, kid: KID, alg: "ES256", use: "sig" }),
                      expiresAt: Date.now() + 60_000,
                  }
                : null;
        },
        async putJwk() {},
        async route() {
            throw new Error("not used");
        },
    };
    const sign = async (
        overrides: {
            subject?: string;
            issuer?: string;
            audience?: string;
            expirationTime?: number;
            notBefore?: number;
        } = {}
    ) => {
        const now = Math.floor(Date.now() / 1000);
        let builder = new SignJWT({ plan: "pro" })
            .setProtectedHeader({ alg: "ES256", kid: KID })
            .setSubject(overrides.subject ?? "user-1")
            .setIssuer(overrides.issuer ?? ISSUER)
            .setAudience(overrides.audience ?? AUDIENCE)
            .setIssuedAt(now)
            .setExpirationTime(overrides.expirationTime ?? now + 300);
        if (overrides.notBefore !== undefined) builder = builder.setNotBefore(overrides.notBefore);
        return builder.sign(privateKey);
    };
    return { catalog, sign };
}

function config(overrides: Partial<GatewayJwtConfig> = {}): GatewayJwtConfig {
    return {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["ES256"],
        jwksUrl: "https://issuer.example/jwks",
        authBasePath: "/api/auth",
        jwksPath: "/jwks",
        clockToleranceSeconds: 0,
        ...overrides,
    };
}

describe("Gateway verified JWT boundary", () => {
    test("attaches only signature-verified identity and expiry", async () => {
        const { catalog, sign } = await signingFixture();
        const attachment = await verifyGatewayJwt({
            config: config(),
            authOrigin: ORIGIN,
            connectionId: CONNECTION_ID,
            catalog,
            jwt: await sign(),
            clientId: ClientId("client-1"),
        });

        expect(attachment).toMatchObject({
            kind: "verified",
            connectionId: CONNECTION_ID,
            authOrigin: ORIGIN,
            clientId: "client-1",
            principalId: "user-1",
        });
        expect(attachment.jwtExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect("tenantId" in attachment).toBe(false);
        expect("role" in attachment).toBe(false);
    });

    test("rejects malformed, tampered, expired, premature, wrong-issuer, wrong-audience, and disallowed-alg tokens", async () => {
        const { catalog, sign } = await signingFixture();
        const now = Math.floor(Date.now() / 1000);
        const valid = await sign();
        const cases = [
            "not-a-jwt",
            `${valid.slice(0, -2)}xx`,
            await sign({ expirationTime: now - 1 }),
            await sign({ notBefore: now + 60 }),
            await sign({ issuer: "https://attacker.example" }),
            await sign({ audience: "other-app" }),
        ];
        for (const token of cases) {
            await expect(
                verifyGatewayJwt({
                    config: config(),
                    authOrigin: ORIGIN,
                    connectionId: CONNECTION_ID,
                    catalog,
                    jwt: token,
                    clientId: ClientId("client-1"),
                })
            ).rejects.toMatchObject({ code: "CDB_FORBIDDEN" });
        }
        await expect(
            verifyGatewayJwt({
                config: config({ algorithms: ["RS256"] }),
                authOrigin: ORIGIN,
                connectionId: CONNECTION_ID,
                catalog,
                jwt: valid,
                clientId: ClientId("client-1"),
            })
        ).rejects.toMatchObject({ code: "CDB_FORBIDDEN" });
    });

    test("rechecks expiry and projects only the verified subject for mutation dispatch", async () => {
        const { catalog, sign } = await signingFixture();
        const attachment = await verifyGatewayJwt({
            config: config(),
            authOrigin: ORIGIN,
            connectionId: CONNECTION_ID,
            catalog,
            jwt: await sign(),
            clientId: ClientId("client-1"),
        });
        expect(isCurrentVerifiedAttachment(attachment, attachment.jwtExp - 1)).toBe(true);
        expect(isCurrentVerifiedAttachment(attachment, attachment.jwtExp)).toBe(false);
        expect(trustedMutationAuthFromAttachment(attachment)).toEqual({ principalId: PrincipalId("user-1") });
    });

    test("a verified refresh can replace the subject; a failed refresh yields no replacement", async () => {
        const { catalog, sign } = await signingFixture();
        const current = await verifyGatewayJwt({
            config: config(),
            authOrigin: ORIGIN,
            connectionId: CONNECTION_ID,
            catalog,
            jwt: await sign(),
            clientId: ClientId("client-1"),
        });
        const refreshed = await verifyGatewayJwt({
            config: config(),
            authOrigin: current.authOrigin,
            connectionId: current.connectionId,
            catalog,
            jwt: await sign({ subject: "user-2" }),
            clientId: current.clientId,
        });
        expect(refreshed.principalId).toBe(PrincipalId("user-2"));
        expect(current.principalId).toBe(PrincipalId("user-1"));

        await expect(
            verifyGatewayJwt({
                config: config(),
                authOrigin: current.authOrigin,
                connectionId: current.connectionId,
                catalog,
                jwt: "invalid.refresh.token",
                clientId: current.clientId,
            })
        ).rejects.toMatchObject({ code: "CDB_FORBIDDEN" });
        expect(current.principalId).toBe(PrincipalId("user-1"));
    });
});

describe("Better Auth JWT configuration", () => {
    test("pins issuer, audience, algorithm, and remote JWKS from the plugin", () => {
        const options: BetterAuthOptions = {
            baseURL: "https://app.example/path",
            plugins: [
                jwt({
                    jwt: { issuer: ISSUER, audience: [AUDIENCE, "chardb-admin"] },
                    jwks: {
                        remoteUrl: "https://issuer.example/.well-known/jwks.json",
                        keyPairConfig: { alg: "ES256" },
                        jwksPath: "/keys",
                    },
                }),
            ],
        };
        expect(gatewayJwtConfigFromAuthOptions(options, "/custom-auth")).toEqual({
            issuer: ISSUER,
            audience: [AUDIENCE, "chardb-admin"],
            algorithms: ["ES256"],
            jwksUrl: "https://issuer.example/.well-known/jwks.json",
            authBasePath: "/custom-auth",
            jwksPath: "/keys",
        });
    });

    test("uses the Better Auth origin and EdDSA defaults, and fails closed without the JWT plugin", () => {
        expect(gatewayJwtConfigFromAuthOptions({ baseURL: "https://app.example/some/path", plugins: [jwt()] })).toEqual(
            {
                issuer: ORIGIN,
                audience: ORIGIN,
                algorithms: ["EdDSA"],
                authBasePath: "/api/auth",
                jwksPath: "/jwks",
            }
        );
        expect(gatewayJwtConfigFromAuthOptions({ plugins: [] })).toBeNull();
    });
});
