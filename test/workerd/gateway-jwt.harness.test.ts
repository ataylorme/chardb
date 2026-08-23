import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { build as viteBuild } from "vite";
import { ChardbRef, ClientId, Cookie, MutId, SubId } from "../../src/types.ts";
import { chardb as chardbVite } from "../../src/vite/index.ts";
import { type Down, PROTOCOL_V, type Up, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "gateway-jwt.entry.ts");
const BUNDLE = path.join(process.env.TMPDIR ?? "/tmp", `chardb-gateway-jwt-${process.pid}.bundle.mjs`);
const KID = "gateway-workerd-key";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const WRITE_REF = "test/workerd/gateway-jwt.entry.ts#writeOrganizationRow";
const CLOSED_REF = "test/workerd/gateway-jwt.entry.ts#closedOrganizationWrite";
const LIST_REF = "test/workerd/gateway-jwt.entry.ts#listOrganizationRows";

let mf: Miniflare | undefined;
let workerdUrl: URL | undefined;
let signToken: ((claims?: TokenOverrides) => Promise<string>) | undefined;
let mutationRef: ChardbRef | undefined;
let closedMutationRef: ChardbRef | undefined;
let queryRef: ChardbRef | undefined;
let closedQueryRef: ChardbRef | undefined;
let invalidQueryRef: ChardbRef | undefined;

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
        let source = await Bun.file(BUNDLE).text();
        // Bun retains optional Node-only Kysely/sqlite loaders even though this
        // Worker never reaches them. workerd rejects arbitrary dynamic module
        // specifiers while parsing, so make those dead branches fail explicitly.
        source = source.replace(
            "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
            'await Promise.reject(new Error("Node file migrations are unavailable in workerd"))'
        );
        source = source.replace(
            "await import(nodeSqlite)",
            'await Promise.reject(new Error("Node sqlite is unavailable in workerd"))'
        );
        if (/\bimport\s*\([^"'`]/.test(source)) {
            throw new Error("Worker bundle still contains an unsupported dynamic module specifier");
        }
        return source;
    } finally {
        await rm(BUNDLE, { force: true });
    }
}

async function buildBrowserRefs(): Promise<readonly [ChardbRef, ChardbRef, ChardbRef]> {
    const fixture = await mkdtemp(path.join(tmpdir(), "chardb-vite-browser-"));
    const entry = path.join(fixture, "api.ts");
    const serverModule = path.join(HERE, "../../src/server/define.ts");
    try {
        await writeFile(
            entry,
            `
import { api } from "chardb/server";
export const writeOrganizationRow = api.mutation({ ref: "${WRITE_REF}", handler: () => null });
export const closedOrganizationWrite = api.mutation({ ref: "${CLOSED_REF}", handler: () => null });
export const listOrganizationRows = api.query({ ref: "${LIST_REF}", handler: async () => [] });
`
        );
        const built = await viteBuild({
            configFile: false,
            logLevel: "silent",
            plugins: [chardbVite()],
            resolve: { alias: { "chardb/server": serverModule } },
            build: { write: false, lib: { entry, formats: ["es"] } },
        });
        const results = (Array.isArray(built) ? built : [built]) as unknown as readonly {
            readonly output: readonly { readonly type: string; readonly code?: string }[];
        }[];
        const chunk = results.flatMap(result => result.output).find(output => output.type === "chunk");
        if (!chunk?.code) throw new Error("Vite did not emit the browser client chunk");
        const emittedPath = path.join(fixture, "browser-client.mjs");
        await writeFile(emittedPath, chunk.code);
        const emitted = (await import(pathToFileURL(emittedPath).href)) as {
            readonly writeOrganizationRow: { readonly __chardbRef?: unknown };
            readonly closedOrganizationWrite: { readonly __chardbRef?: unknown };
            readonly listOrganizationRows: { readonly __chardbRef?: unknown };
        };
        return [
            ChardbRef(String(emitted.writeOrganizationRow.__chardbRef)),
            ChardbRef(String(emitted.closedOrganizationWrite.__chardbRef)),
            ChardbRef(String(emitted.listOrganizationRows.__chardbRef)),
        ];
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
}

beforeAll(async () => {
    [mutationRef, closedMutationRef, queryRef] = await buildBrowserRefs();
    expect([mutationRef, closedMutationRef, queryRef]).toEqual([
        ChardbRef(WRITE_REF),
        ChardbRef(CLOSED_REF),
        ChardbRef(LIST_REF),
    ]);

    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
    signToken = async (overrides = {}) => {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({ probe: "workerd", tenantId: "workerd-org-b", role: "owner", roles: ["owner"] })
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
            CDB_SHARD: { className: "Cdb", useSQLite: true },
        },
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
    workerdUrl = await mf.ready;
    const seeded = await mf.dispatchFetch("http://example.com/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kid: KID, jwk: publicJwk }),
    });
    if (!seeded.ok) throw new Error(`failed to seed Catalog JWK: ${seeded.status} ${await seeded.text()}`);
    const seedResult = (await seeded.json()) as {
        mutationRef: ChardbRef;
        closedMutationRef: ChardbRef;
        queryRef: ChardbRef;
        closedQueryRef: ChardbRef;
        invalidQueryRef: ChardbRef;
        shardA: string;
        shardB: string;
    };
    ({ closedQueryRef, invalidQueryRef } = seedResult);
    expect(seedResult).toMatchObject({ mutationRef, closedMutationRef, queryRef });
    expect(seedResult.shardA).toBe(seedResult.shardB);
});

afterAll(async () => {
    await mf?.dispose();
});

interface OpenedSocket {
    readonly socket: WebSocket;
    readonly first: Promise<Down>;
    readonly closed: Promise<void>;
}

async function openSocket(
    jwt: string,
    options: { readonly clientId?: string; readonly resumeFromCookie?: string } = {}
): Promise<OpenedSocket> {
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
        clientId: ClientId(options.clientId ?? crypto.randomUUID()),
        ...(options.resumeFromCookie ? { resumeFromCookie: Cookie(options.resumeFromCookie) } : {}),
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

function nextDowns(socket: WebSocket, count: number): Promise<Down[]> {
    return new Promise((resolve, reject) => {
        const messages: Down[] = [];
        const timeout = setTimeout(() => reject(new Error("timed out waiting for Gateway messages")), 3_000);
        const onMessage = (event: MessageEvent) => {
            messages.push(decodeWire(String(event.data)) as Down);
            if (messages.length !== count) return;
            clearTimeout(timeout);
            socket.removeEventListener("message", onMessage);
            resolve(messages);
        };
        socket.addEventListener("message", onMessage);
    });
}

async function expectNoDown(socket: WebSocket): Promise<void> {
    let received = false;
    const onMessage = () => {
        received = true;
    };
    socket.addEventListener("message", onMessage);
    await new Promise(resolve => setTimeout(resolve, 100));
    socket.removeEventListener("message", onMessage);
    expect(received).toBe(false);
}

async function setAuthorityFault(
    fault: "none" | "throw" | "malformed" | "hold" | "hold-throw" | "route-throw" | "route-malformed"
): Promise<void> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch("http://example.com/authority-fault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fault }),
    });
    if (!response.ok) throw new Error(`failed to set authority fault: ${response.status}`);
}

async function authorityControl(pathname: "/authority-waiting" | "/authority-release"): Promise<void> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch(`http://example.com${pathname}`, { method: "POST" });
    if (!response.ok) throw new Error(`authority control failed: ${pathname} ${response.status}`);
}

async function enqueuePatch(clientId: string, rowKey: string): Promise<void> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch("http://example.com/patch-poke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, rowKey }),
    });
    if (!response.ok) throw new Error(`failed to enqueue patch: ${response.status}`);
}

describe("configured Gateway JWT handshake in real workerd", () => {
    test("a seeded Catalog membership permits the declared organization mutation", async () => {
        const clientId = "workerd-authorized-client";
        const { socket, first, closed } = await openSocket(await signed(), { clientId });
        await expect(first).resolves.toMatchObject({ t: "welcome", protocolV: PROTOCOL_V });
        if (!mutationRef) throw new Error("mutation ref was not seeded");

        const mutation = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("workerd-mut"),
            ref: mutationRef,
            args: { id: "workerd-row", organizationId: "workerd-org", body: "written", createdAt: 1 },
        });
        expect(mutation).toMatchObject({
            t: "poke",
            mutResults: [
                {
                    mutId: "workerd-mut",
                    ok: true,
                    result: {
                        id: "workerd-row",
                        userId: "workerd-user",
                        tenantId: "workerd-org",
                        role: "member",
                        roles: ["member"],
                        claims: {},
                    },
                },
            ],
        });
        if (mutation.t !== "poke") throw new Error("expected mutation poke");

        if (!closedMutationRef) throw new Error("closed mutation ref was not seeded");
        const undeclared = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("workerd-closed"),
            ref: closedMutationRef,
            args: { organizationId: "workerd-org" },
        });
        expect(undeclared).toMatchObject({
            t: "poke",
            cookie: mutation.cookie,
            mutResults: [{ mutId: "workerd-closed", ok: false, error: { code: "CDB_AUTH_NOT_BOUND" } }],
        });

        if (!closedQueryRef) throw new Error("closed query ref was not seeded");
        const subscription = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(7),
            ref: closedQueryRef,
            args: { organizationId: "workerd-org" },
        });
        expect(subscription).toMatchObject({
            t: "error",
            code: "CDB_AUTH_NOT_BOUND",
            subId: 7,
        });

        const presence = await sendAndReceive(socket, { t: "presenceSub", key: "org:workerd-org" });
        expect(presence).toMatchObject({
            t: "error",
            code: "CDB_AUTH_NOT_BOUND",
        });
        socket.close();
        await closed;

        const resumed = await openSocket(await signed(), { clientId, resumeFromCookie: mutation.cookie });
        await expect(resumed.first).resolves.toMatchObject({
            t: "welcome",
            resumedFromCookie: mutation.cookie,
        });
        resumed.socket.close();
    });

    test("organization queries return initial and empty snapshots while other tenants stay closed", async () => {
        if (!mutationRef || !queryRef) throw new Error("public refs were not seeded");
        const otherTenant = await openSocket(await signed({ subject: "workerd-user-b" }));
        await otherTenant.first;
        const otherSeeded = await sendAndReceive(otherTenant.socket, {
            t: "mut",
            mutId: MutId("query-seed-b"),
            ref: mutationRef,
            args: {
                id: "query-seed-row-b",
                organizationId: "workerd-org-b",
                body: "query-visible",
                createdAt: 9,
            },
        });
        expect(otherSeeded).toMatchObject({ t: "poke", mutResults: [{ ok: true }] });
        const otherSnapshot = await sendAndReceive(otherTenant.socket, {
            t: "sub",
            subId: SubId(9),
            ref: queryRef,
            args: { organizationId: "workerd-org-b", body: "query-visible" },
        });
        expect(otherSnapshot).toMatchObject({
            t: "snapshot",
            subId: 9,
            rows: [
                {
                    id: "query-seed-row-b",
                    organizationId: "workerd-org-b",
                    body: "query-visible",
                    viewerId: "workerd-user-b",
                },
            ],
        });
        if (otherSnapshot.t !== "snapshot") throw new Error("expected org B snapshot");
        expect(otherSnapshot.rows).toHaveLength(1);
        otherTenant.socket.close();

        const { socket, first } = await openSocket(await signed());
        await first;

        const seeded = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("query-seed"),
            ref: mutationRef,
            args: {
                id: "query-seed-row",
                organizationId: "workerd-org",
                body: "query-visible",
                createdAt: 10,
            },
        });
        expect(seeded).toMatchObject({ t: "poke", mutResults: [{ ok: true }] });

        const snapshot = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(10),
            ref: queryRef,
            args: { organizationId: "workerd-org", body: "query-visible" },
        });
        expect(snapshot).toMatchObject({
            t: "snapshot",
            subId: 10,
            rows: [
                {
                    id: "query-seed-row",
                    organizationId: "workerd-org",
                    body: "query-visible",
                    viewerId: "workerd-user",
                },
            ],
        });
        if (snapshot.t !== "snapshot") throw new Error("expected org A snapshot");
        expect(snapshot.rows).toHaveLength(1);

        const empty = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(11),
            ref: queryRef,
            args: { organizationId: "workerd-org", body: "does-not-exist" },
        });
        expect(empty).toMatchObject({ t: "snapshot", subId: 11, rows: [] });

        const forbidden = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(12),
            ref: queryRef,
            args: { organizationId: "workerd-org-b" },
        });
        expect(forbidden).toMatchObject({ t: "error", subId: 12, code: "CDB_FORBIDDEN" });
        socket.close();
    });

    test("organization queries reject undeclared, scatter, cross-partition, and mismatched intents", async () => {
        if (!closedQueryRef || !invalidQueryRef || !queryRef) throw new Error("query refs were not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;

        const undeclared = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(20),
            ref: closedQueryRef,
            args: { organizationId: "workerd-org" },
        });
        expect(undeclared).toMatchObject({ t: "error", subId: 20, code: "CDB_AUTH_NOT_BOUND" });

        for (const [subId, mode] of [
            [21, "scatter"],
            [22, "cross"],
            [23, "mismatch"],
        ] as const) {
            const rejected = await sendAndReceive(socket, {
                t: "sub",
                subId: SubId(subId),
                ref: invalidQueryRef,
                args: { organizationId: "workerd-org", mode },
            });
            expect(rejected).toMatchObject({ t: "error", subId, code: "CDB_CROSS_PARTITION" });
        }
        for (const [subId, fault] of [
            [24, "route-malformed"],
            [25, "route-throw"],
        ] as const) {
            await setAuthorityFault(fault);
            const rejected = await sendAndReceive(socket, {
                t: "sub",
                subId: SubId(subId),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "does-not-exist" },
            });
            expect(rejected).toMatchObject({ t: "error", subId, code: "CDB_CATALOG_UNAVAILABLE" });
        }
        await setAuthorityFault("none");
        socket.close();
    });

    test("query failures and pending unsubscribe do not produce a snapshot", async () => {
        if (!queryRef) throw new Error("query ref was not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;

        const queryFailure = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(30),
            ref: queryRef,
            args: { organizationId: "workerd-org", body: "__throw" },
        });
        expect(queryFailure).toMatchObject({ t: "error", subId: 30 });

        await setAuthorityFault("hold-throw");
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(32),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "does-not-exist" },
            })
        );
        await authorityControl("/authority-waiting");
        socket.send(encodeWire({ t: "unsub", subId: SubId(32) }));
        await authorityControl("/authority-release");
        await expectNoDown(socket);
        socket.close();
    });

    test("a concurrent duplicate subId is latest-wins without a stale snapshot", async () => {
        if (!mutationRef || !queryRef) throw new Error("public refs were not seeded");
        const clientId = "workerd-query-duplicate";
        const { socket, first } = await openSocket(await signed(), { clientId });
        await first;
        for (const body of ["duplicate-first", "duplicate-second"] as const) {
            const result = await sendAndReceive(socket, {
                t: "mut",
                mutId: MutId(body),
                ref: mutationRef,
                args: {
                    id: `${body}-row`,
                    organizationId: "workerd-org",
                    body,
                    createdAt: body === "duplicate-first" ? 12 : 13,
                },
            });
            expect(result).toMatchObject({ t: "poke", mutResults: [{ ok: true }] });
        }

        await setAuthorityFault("hold-throw");
        const snapshot = nextDown(socket);
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(50),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "duplicate-first" },
            })
        );
        await authorityControl("/authority-waiting");
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(50),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "duplicate-second" },
            })
        );
        await authorityControl("/authority-release");

        await expect(snapshot).resolves.toMatchObject({
            t: "snapshot",
            subId: 50,
            rows: [{ id: "duplicate-second-row", body: "duplicate-second" }],
        });
        await expectNoDown(socket);
        const refresh = await sendAndReceive(socket, {
            t: "updateAuth",
            jwt: await signed({ subject: "workerd-user-2" }),
        });
        expect(refresh).toMatchObject({ t: "mustRefetch", subIds: [50], reason: "authChanged" });
        socket.close();
    });

    test("a failed auth refresh rejects an admitted query before shard execution", async () => {
        if (!queryRef) throw new Error("query ref was not seeded");
        const { socket, first, closed } = await openSocket(await signed());
        await first;
        await setAuthorityFault("hold");
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(60),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "does-not-exist" },
            })
        );
        await authorityControl("/authority-waiting");

        const rejection = nextDown(socket);
        socket.send(encodeWire({ t: "updateAuth", jwt: "invalid.refresh.token" }));
        await expect(rejection).resolves.toMatchObject({ t: "error", code: "CDB_FORBIDDEN" });
        await authorityControl("/authority-release");
        await closed;
    });

    test("closing a socket cancels an admitted initial query", async () => {
        if (!queryRef) throw new Error("query ref was not seeded");
        const clientId = "workerd-query-close";
        const firstSocket = await openSocket(await signed(), { clientId });
        await firstSocket.first;
        await setAuthorityFault("hold");
        firstSocket.socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(70),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "query-visible" },
            })
        );
        await authorityControl("/authority-waiting");
        firstSocket.socket.close();
        await firstSocket.closed;
        await authorityControl("/authority-release");

        const replacement = await openSocket(await signed(), { clientId });
        await replacement.first;
        const snapshot = await sendAndReceive(replacement.socket, {
            t: "sub",
            subId: SubId(70),
            ref: queryRef,
            args: { organizationId: "workerd-org", body: "query-visible" },
        });
        expect(snapshot).toMatchObject({ t: "snapshot", subId: 70 });
        replacement.socket.close();
    });

    test("unsubscribe removes a delivered snapshot from the auth-refresh refetch list", async () => {
        if (!queryRef) throw new Error("query ref was not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;
        const snapshot = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(80),
            ref: queryRef,
            args: { organizationId: "workerd-org", body: "does-not-exist" },
        });
        expect(snapshot).toMatchObject({ t: "snapshot", subId: 80, rows: [] });

        socket.send(encodeWire({ t: "unsub", subId: SubId(80) }));
        const refresh = await sendAndReceive(socket, {
            t: "updateAuth",
            jwt: await signed({ subject: "workerd-user-2" }),
        });
        expect(refresh).toMatchObject({ t: "mustRefetch", subIds: [], reason: "authChanged" });
        socket.close();
    });

    test("a connection caps delivered initial snapshots before the 65th query executes", async () => {
        if (!queryRef) throw new Error("query ref was not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;
        for (let index = 0; index < 64; index++) {
            const snapshot = await sendAndReceive(socket, {
                t: "sub",
                subId: SubId(1000 + index),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "does-not-exist" },
            });
            expect(snapshot).toMatchObject({ t: "snapshot", subId: 1000 + index, rows: [] });
        }

        const limited = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(1064),
            ref: queryRef,
            args: { organizationId: "workerd-org", body: "__throw" },
        });
        expect(limited).toMatchObject({ t: "error", subId: 1064, code: "CDB_RATE_LIMITED" });

        socket.send(encodeWire({ t: "unsub", subId: SubId(1000) }));
        const replacement = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(1064),
            ref: queryRef,
            args: { organizationId: "workerd-org", body: "does-not-exist" },
        });
        expect(replacement).toMatchObject({ t: "snapshot", subId: 1064, rows: [] });
        socket.close();
    });

    test("updateAuth drains a query snapshot before switching subscription identity", async () => {
        if (!mutationRef || !queryRef) throw new Error("public refs were not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;
        const seeded = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("query-refresh-seed"),
            ref: mutationRef,
            args: {
                id: "query-refresh-row",
                organizationId: "workerd-org",
                body: "query-refresh",
                createdAt: 11,
            },
        });
        expect(seeded).toMatchObject({ t: "poke", mutResults: [{ ok: true }] });

        await setAuthorityFault("hold");
        const ordered = nextDowns(socket, 3);
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(40),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "query-refresh" },
            })
        );
        await authorityControl("/authority-waiting");
        socket.send(encodeWire({ t: "updateAuth", jwt: await signed({ subject: "workerd-user-2" }) }));
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(41),
                ref: queryRef,
                args: { organizationId: "workerd-org", body: "query-refresh" },
            })
        );
        await expectNoDown(socket);
        await authorityControl("/authority-release");

        const [before, refresh, after] = await ordered;
        expect(before).toMatchObject({
            t: "snapshot",
            subId: 40,
            rows: [{ id: "query-refresh-row", viewerId: "workerd-user" }],
        });
        expect(refresh).toMatchObject({ t: "mustRefetch", subIds: [40], reason: "authChanged" });
        expect(after).toMatchObject({
            t: "snapshot",
            subId: 41,
            rows: [{ id: "query-refresh-row", viewerId: "workerd-user-2" }],
        });
        socket.close();
    });

    test("concurrent completions keep the last delivered cookie for later failures", async () => {
        if (!mutationRef || !closedMutationRef) throw new Error("mutation refs were not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;
        const responses = nextDowns(socket, 2);
        socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("concurrent-a"),
                ref: mutationRef,
                args: { id: "concurrent-a", organizationId: "workerd-org", body: "a", createdAt: 2 },
            })
        );
        socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("concurrent-b"),
                ref: mutationRef,
                args: { id: "concurrent-b", organizationId: "workerd-org", body: "b", createdAt: 3 },
            })
        );
        const completed = await responses;
        expect(completed.every(message => message.t === "poke")).toBe(true);
        const last = completed.at(-1);
        if (!last || last.t !== "poke") throw new Error("expected final mutation poke");

        const failure = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("after-concurrent"),
            ref: closedMutationRef,
            args: { organizationId: "workerd-org" },
        });
        expect(failure).toMatchObject({
            t: "poke",
            cookie: last.cookie,
            mutResults: [{ ok: false, error: { code: "CDB_AUTH_NOT_BOUND" } }],
        });
        socket.close();
    });

    test("a patch poke advances the cookie used by a later mutation failure", async () => {
        if (!closedMutationRef) throw new Error("closed mutation ref was not seeded");
        const clientId = "workerd-patch-client";
        const { socket, first } = await openSocket(await signed(), { clientId });
        await first;
        const patchResponse = nextDowns(socket, 1);
        await enqueuePatch(clientId, "patch-row");
        const [patch] = await patchResponse;
        expect(patch).toMatchObject({
            t: "poke",
            patches: [{ op: "put", subId: 1, rowKey: "patch-row" }],
        });
        if (!patch || patch.t !== "poke") throw new Error("expected patch poke");

        const failure = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("after-patch"),
            ref: closedMutationRef,
            args: { organizationId: "workerd-org" },
        });
        expect(failure).toMatchObject({
            t: "poke",
            cookie: patch.cookie,
            mutResults: [{ ok: false, error: { code: "CDB_AUTH_NOT_BOUND" } }],
        });
        socket.close();
    });

    test("malformed and throwing Catalog authority settle once as typed failures", async () => {
        if (!mutationRef) throw new Error("mutation ref was not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;
        for (const fault of ["malformed", "throw"] as const) {
            await setAuthorityFault(fault);
            const response = await sendAndReceive(socket, {
                t: "mut",
                mutId: MutId(`fault-${fault}`),
                ref: mutationRef,
                args: { id: `fault-${fault}`, organizationId: "workerd-org", body: fault, createdAt: 4 },
            });
            expect(response).toMatchObject({
                t: "poke",
                mutResults: [{ ok: false, error: { code: "CDB_CATALOG_UNAVAILABLE" } }],
            });
            await expectNoDown(socket);
        }
        await setAuthorityFault("none");
        socket.close();
    });

    test("updateAuth drains admitted mutations, preserves cookies, and gates later mutations", async () => {
        if (!mutationRef || !closedMutationRef) throw new Error("mutation refs were not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;
        await setAuthorityFault("hold");

        const ordered = nextDowns(socket, 3);
        socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("refresh-before"),
                ref: mutationRef,
                args: { id: "refresh-before", organizationId: "workerd-org", body: "before", createdAt: 5 },
            })
        );
        await authorityControl("/authority-waiting");
        socket.send(encodeWire({ t: "updateAuth", jwt: await signed({ subject: "workerd-user-2" }) }));
        socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("refresh-after"),
                ref: mutationRef,
                args: { id: "refresh-after", organizationId: "workerd-org", body: "after", createdAt: 6 },
            })
        );
        await expectNoDown(socket);
        await authorityControl("/authority-release");

        const [before, refresh, after] = await ordered;
        expect(before).toMatchObject({
            t: "poke",
            mutResults: [{ mutId: "refresh-before", ok: true, result: { userId: "workerd-user" } }],
        });
        expect(refresh).toMatchObject({ t: "mustRefetch", reason: "authChanged" });
        expect(after).toMatchObject({
            t: "poke",
            mutResults: [{ mutId: "refresh-after", ok: true, result: { userId: "workerd-user-2" } }],
        });
        if (!before || before.t !== "poke" || !after || after.t !== "poke") {
            throw new Error("expected ordered mutation pokes around refresh");
        }

        const failure = await sendAndReceive(socket, {
            t: "mut",
            mutId: MutId("refresh-cookie-check"),
            ref: closedMutationRef,
            args: { organizationId: "workerd-org" },
        });
        expect(failure).toMatchObject({
            t: "poke",
            cookie: after.cookie,
            mutResults: [{ ok: false, error: { code: "CDB_AUTH_NOT_BOUND" } }],
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

    test("multiple updateAuth messages serialize before a later mutation", async () => {
        if (!mutationRef) throw new Error("mutation ref was not seeded");
        const { socket, first } = await openSocket(await signed());
        await first;
        const ordered = nextDowns(socket, 3);
        socket.send(encodeWire({ t: "updateAuth", jwt: await signed({ subject: "workerd-user-2" }) }));
        socket.send(encodeWire({ t: "updateAuth", jwt: await signed({ subject: "workerd-user" }) }));
        socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("after-two-refreshes"),
                ref: mutationRef,
                args: { id: "after-two-refreshes", organizationId: "workerd-org", body: "final", createdAt: 8 },
            })
        );
        const [firstRefresh, secondRefresh, mutation] = await ordered;
        expect(firstRefresh).toMatchObject({ t: "mustRefetch", reason: "authChanged" });
        expect(secondRefresh).toMatchObject({ t: "mustRefetch", reason: "authChanged" });
        expect(mutation).toMatchObject({
            t: "poke",
            mutResults: [{ ok: true, result: { userId: "workerd-user" } }],
        });
        socket.close();
    });

    test("a mutation queued behind a failed refresh never dispatches", async () => {
        if (!mutationRef) throw new Error("mutation ref was not seeded");
        const { socket, first, closed } = await openSocket(await signed());
        await first;
        socket.send(encodeWire({ t: "updateAuth", jwt: "invalid.refresh.token" }));
        socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("after-failed-refresh"),
                ref: mutationRef,
                args: { id: "after-failed-refresh", organizationId: "workerd-org", body: "no", createdAt: 7 },
            })
        );
        await closed;
        await new Promise(resolve => setTimeout(resolve, 25));

        const retry = await openSocket(await signed());
        const retryWelcome = await retry.first;
        expect(retryWelcome).toMatchObject({ t: "welcome" });
        const retryResponse = await sendAndReceive(retry.socket, {
            t: "mut",
            mutId: MutId("after-failed-refresh-retry"),
            ref: mutationRef,
            args: { id: "after-failed-refresh", organizationId: "workerd-org", body: "yes", createdAt: 7 },
        });
        expect(retryResponse).toMatchObject({ t: "poke", mutResults: [{ ok: true }] });
        retry.socket.close();
    });
});
