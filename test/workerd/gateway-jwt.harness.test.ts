import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { ChardbRef, ClientId, MutId, SubId } from "../../src/types.ts";
import { type Down, PROTOCOL_V, type Up, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "gateway-jwt.entry.ts");
const BUNDLE = path.join(process.env.TMPDIR ?? "/tmp", `chardb-gateway-jwt-${process.pid}.bundle.mjs`);
const KID = "gateway-workerd-key";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";

let mf: Miniflare | undefined;
let workerdUrl: URL | undefined;
let signToken: ((claims?: TokenOverrides) => Promise<string>) | undefined;

interface TokenOverrides {
    readonly subject?: string;
    readonly issuer?: string;
    readonly audience?: string;
    readonly expirationTime?: number;
}

async function buildWorker(): Promise<string> {
    try {
        const proc = Bun.spawn(
            [
                "bun",
                "build",
                ENTRY,
                "--target=browser",
                "--format=esm",
                "--external=cloudflare:workers",
                "--outfile",
                BUNDLE,
            ],
            { stdout: "pipe", stderr: "pipe" }
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            throw new Error(`bundle failed (exit ${exitCode}):\n${await new Response(proc.stderr).text()}`);
        }
        return await Bun.file(BUNDLE).text();
    } finally {
        await rm(BUNDLE, { force: true });
    }
}

beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
    signToken = async (overrides = {}) => {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({ probe: "workerd" })
            .setProtectedHeader({ alg: "ES256", kid: KID })
            .setSubject(overrides.subject ?? "workerd-user")
            .setIssuer(overrides.issuer ?? ISSUER)
            .setAudience(overrides.audience ?? AUDIENCE)
            .setIssuedAt(now)
            .setExpirationTime(overrides.expirationTime ?? now + 300)
            .sign(privateKey);
    };

    mf = new Miniflare({
        modules: true,
        script: await buildWorker(),
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_GATEWAY: { className: "Gateway", useSQLite: true },
        },
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
    workerdUrl = await mf.ready;
    const seeded = await mf.dispatchFetch("http://example.com/seed-jwk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kid: KID, jwk: publicJwk }),
    });
    if (!seeded.ok) throw new Error(`failed to seed Catalog JWK: ${seeded.status} ${await seeded.text()}`);
});

afterAll(async () => {
    await mf?.dispose();
});

interface OpenedSocket {
    readonly socket: WebSocket;
    readonly first: Promise<Down>;
    readonly closed: Promise<void>;
}

async function openSocket(jwt: string): Promise<OpenedSocket> {
    if (!workerdUrl) throw new Error("miniflare not initialized");
    const url = new URL("/ws", workerdUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out opening Gateway WebSocket")), 2_000);
        socket.addEventListener(
            "open",
            () => {
                clearTimeout(timeout);
                resolve();
            },
            { once: true }
        );
        socket.addEventListener(
            "error",
            () => {
                clearTimeout(timeout);
                reject(new Error("Gateway WebSocket failed to open"));
            },
            { once: true }
        );
    });
    const first = nextDown(socket);
    const closed = new Promise<void>(resolve => socket.addEventListener("close", () => resolve(), { once: true }));
    const hello: Up = {
        t: "hello",
        protocolV: PROTOCOL_V,
        clientId: ClientId(crypto.randomUUID()),
        jwt,
    };
    socket.send(encodeWire(hello));
    return { socket, first, closed };
}

function nextDown(socket: WebSocket): Promise<Down> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for Gateway message")), 2_000);
        const onClose = (event: CloseEvent) => {
            clearTimeout(timeout);
            reject(new Error(`Gateway closed before replying (${event.code}: ${event.reason})`));
        };
        socket.addEventListener("close", onClose, { once: true });
        socket.addEventListener(
            "message",
            event => {
                clearTimeout(timeout);
                socket.removeEventListener("close", onClose);
                resolve(decodeWire(String(event.data)) as Down);
            },
            { once: true }
        );
    });
}

async function signed(overrides?: TokenOverrides): Promise<string> {
    if (!signToken) throw new Error("signer not initialized");
    return signToken(overrides);
}

function sendAndReceive(socket: WebSocket, message: Up): Promise<Down> {
    const response = nextDown(socket);
    socket.send(encodeWire(message));
    return response;
}

describe("configured Gateway JWT handshake in real workerd", () => {
    test("a valid signed JWT receives welcome, while protected operations remain fail closed", async () => {
        const { socket, first } = await openSocket(await signed());
        await expect(first).resolves.toMatchObject({ t: "welcome", protocolV: PROTOCOL_V });

        const mutation = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("workerd-mut"),
            ref: ChardbRef("api.ts#write"),
            args: { organizationId: "forged-org" },
        });
        expect(mutation).toMatchObject({
            t: "poke",
            mutResults: [{ mutId: "workerd-mut", ok: false, error: { code: "CDB_AUTH_NOT_BOUND" } }],
        });

        const subscription = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(7),
            ref: ChardbRef("queries.ts#list"),
            args: { organizationId: "forged-org" },
        });
        expect(subscription).toMatchObject({
            t: "error",
            code: "CDB_AUTH_NOT_BOUND",
            subId: 7,
        });

        const presence = await sendAndReceive(socket, { t: "presenceSub", key: "org:forged-org" });
        expect(presence).toMatchObject({
            t: "error",
            code: "CDB_AUTH_NOT_BOUND",
        });
        socket.close();
    });

    test("malformed, tampered, expired, wrong-issuer, and wrong-audience tokens receive a terminal error and no welcome", async () => {
        const now = Math.floor(Date.now() / 1000);
        const valid = await signed();
        const tokens = [
            "not-a-jwt",
            `${valid.slice(0, -2)}xx`,
            await signed({ expirationTime: now - 1 }),
            await signed({ issuer: "https://attacker.example" }),
            await signed({ audience: "other-app" }),
        ];
        for (const token of tokens) {
            const { first, closed } = await openSocket(token);
            const message = await first;
            expect(message).toMatchObject({ t: "error", code: "CDB_FORBIDDEN", retryable: false });
            expect(message.t).not.toBe("welcome");
            await closed;
        }
    });

    test("updateAuth accepts a valid subject switch, invalidates identity state, and closes on a failed refresh", async () => {
        const { socket, first, closed } = await openSocket(await signed());
        await expect(first).resolves.toMatchObject({ t: "welcome" });

        await expect(
            sendAndReceive(socket, { t: "updateAuth", jwt: await signed({ subject: "workerd-user-2" }) })
        ).resolves.toEqual({
            t: "mustRefetch",
            subIds: [],
            reason: "authChanged",
        });

        await expect(sendAndReceive(socket, { t: "updateAuth", jwt: "invalid.refresh.token" })).resolves.toMatchObject({
            t: "error",
            code: "CDB_FORBIDDEN",
            retryable: false,
        });
        await closed;
    });
});
