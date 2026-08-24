import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { type ChardbRef, ClientId, MutId, SubId } from "../../src/types.ts";
import { type Down, PROTOCOL_V, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "gateway-live.entry.ts");
const BUNDLE = path.join(process.env.TMPDIR ?? "/tmp", `chardb-gateway-live-${process.pid}.bundle.mjs`);
const KID = "gateway-live-workerd-key";
const WORKER_NAME = "gateway-live-restart-worker";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const ORGANIZATION_A = "workerd-org";
const ORGANIZATION_B = "workerd-org-b";

interface GatewayLiveState {
    readonly instanceId: string;
    readonly registrations: readonly {
        readonly registrationId: string;
        readonly connectionId: string;
        readonly clientId: string;
        readonly subId: number;
        readonly organizationId: string;
        readonly lifecycle: string;
        readonly cdbState: string;
        readonly dirtyVersion: number;
        readonly deliveredVersion: number;
        readonly initialSnapshotPending: boolean;
        readonly lastCookie: string | null;
        readonly lastSnapshotCookie: string | null;
        readonly currentHead: boolean;
        readonly outboxCookie: string | null;
        readonly outboxTargetVersion: number | null;
    }[];
}

interface CdbLiveState {
    readonly instanceId: string;
    readonly subscriptions: readonly {
        readonly gatewayId: string;
        readonly registrationId: string;
        readonly clientId: string;
        readonly subId: number;
        readonly state: string;
        readonly organizationId: string | null;
    }[];
    readonly invalidations: readonly {
        readonly gatewayId: string;
        readonly registrationId: string;
        readonly changeSeq: number;
    }[];
}

interface OpenedSocket {
    readonly socket: WebSocket;
    readonly welcome: Down;
    readonly closed: Promise<CloseEvent>;
}

let mf: Miniflare | undefined;
let workerdUrl: URL | undefined;
let mutationRef: ChardbRef | undefined;
let queryRef: ChardbRef | undefined;
let shardId = "";
let signToken: ((subject: string) => Promise<string>) | undefined;

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

async function openSocket(clientId: string, jwt: string): Promise<OpenedSocket> {
    if (!workerdUrl) throw new Error("Miniflare is not initialized");
    const url = new URL("/ws", workerdUrl);
    url.searchParams.set("clientId", clientId);
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
    const welcome = nextDown(socket);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(
        encodeWire({
            t: "hello",
            protocolV: PROTOCOL_V,
            clientId: ClientId(clientId),
            jwt,
        })
    );
    return { socket, welcome: await welcome, closed };
}

function nextDown(socket: WebSocket, timeoutMs = 3_000): Promise<Down> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for Gateway message")), timeoutMs);
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

async function fixtureFetch<T>(pathname: string, search: Record<string, string>): Promise<T> {
    if (!mf) throw new Error("Miniflare is not initialized");
    const url = new URL(pathname, "http://example.com");
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
    const response = await mf.dispatchFetch(url);
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

async function gatewayState(clientId: string): Promise<GatewayLiveState> {
    return fixtureFetch("/live-gateway-state", { clientId });
}

async function drainGateway(clientId: string): Promise<void> {
    await fixtureFetch("/live-gateway-drain", { clientId });
}

async function stageGateway(clientId: string): Promise<void> {
    await fixtureFetch("/live-gateway-stage", { clientId });
}

async function matchedCdbSubscriptions(): Promise<CdbLiveState["subscriptions"]> {
    return fixtureFetch("/live-cdb-match", { shardId });
}

async function currentRegistration(
    clientId: string,
    subId: number
): Promise<GatewayLiveState["registrations"][number]> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        const state = await gatewayState(clientId);
        const registration = state.registrations.find(row => row.subId === subId && row.currentHead);
        if (registration?.lifecycle === "active" && registration.cdbState === "active") return registration;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for active registration ${clientId}:${subId}`);
}

async function subscribe(
    opened: OpenedSocket,
    clientId: string,
    subId: number,
    organizationId: string,
    body = "live-proof"
): Promise<Extract<Down, { t: "snapshot" }>> {
    if (!queryRef) throw new Error("query ref was not seeded");
    const snapshot = nextDown(opened.socket);
    opened.socket.send(
        encodeWire({
            t: "sub",
            subId: SubId(subId),
            ref: queryRef,
            args: { organizationId, body },
        })
    );
    await currentRegistration(clientId, subId);
    await drainGateway(clientId);
    const message = await snapshot;
    if (message.t !== "snapshot") throw new Error(`expected snapshot, received ${message.t}`);
    return message;
}

function acknowledge(socket: WebSocket, snapshot: Extract<Down, { t: "snapshot" }>): void {
    socket.send(encodeWire({ t: "ack", cookie: snapshot.cookie }));
}

async function signed(subject: string): Promise<string> {
    if (!signToken) throw new Error("JWT signer is not initialized");
    return signToken(subject);
}

beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
    signToken = async subject => {
        const now = Math.floor(Date.now() / 1_000);
        return new SignJWT({ probe: "gateway-live-workerd" })
            .setProtectedHeader({ alg: "ES256", kid: KID })
            .setSubject(subject)
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);
    };

    mf = new Miniflare({
        name: WORKER_NAME,
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
    if (!seeded.ok) throw new Error(`failed to seed live fixture: ${seeded.status} ${await seeded.text()}`);
    const seed = (await seeded.json()) as {
        readonly mutationRef: ChardbRef;
        readonly queryRef: ChardbRef;
        readonly shardA: string;
        readonly shardB: string;
    };
    mutationRef = seed.mutationRef;
    queryRef = seed.queryRef;
    shardId = seed.shardA;
    expect(seed.shardA).toBe(seed.shardB);
});

afterAll(async () => {
    await mf?.dispose();
});

describe("public durable live queries in real workerd", () => {
    test("two clients receive a committed replacement while another organization stays isolated", async () => {
        if (!mutationRef) throw new Error("mutation ref was not seeded");
        const clientA1 = "live-a-one-001";
        const clientA2 = "live-a-two-002";
        const clientB = "live-b-one-003";
        const mutatorId = "live-mutator-04";
        const [a1, a2, b, mutator] = await Promise.all([
            openSocket(clientA1, await signed("workerd-user")),
            openSocket(clientA2, await signed("workerd-user-2")),
            openSocket(clientB, await signed("workerd-user-b")),
            openSocket(mutatorId, await signed("workerd-user")),
        ]);
        expect([a1.welcome, a2.welcome, b.welcome, mutator.welcome].every(message => message.t === "welcome")).toBe(
            true
        );

        const [initialA1, initialA2, initialB] = await Promise.all([
            subscribe(a1, clientA1, 1, ORGANIZATION_A),
            subscribe(a2, clientA2, 1, ORGANIZATION_A),
            subscribe(b, clientB, 1, ORGANIZATION_B),
        ]);
        expect(initialA1.rows).toEqual([]);
        expect(initialA2.rows).toEqual([]);
        expect(initialB.rows).toEqual([]);
        acknowledge(a1.socket, initialA1);
        acknowledge(a2.socket, initialA2);
        acknowledge(b.socket, initialB);

        const beforeA1 = await currentRegistration(clientA1, 1);
        const beforeA2 = await currentRegistration(clientA2, 1);
        const beforeB = await currentRegistration(clientB, 1);
        expect([beforeA1, beforeA2, beforeB].every(row => !row.initialSnapshotPending)).toBe(true);
        expect(beforeA1.deliveredVersion).toBe(beforeA1.dirtyVersion);
        expect(beforeA2.deliveredVersion).toBe(beforeA2.dirtyVersion);
        expect(beforeB.deliveredVersion).toBe(beforeB.dirtyVersion);

        const mutationResult = nextDown(mutator.socket);
        mutator.socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("live-proof-write"),
                ref: mutationRef,
                args: {
                    id: "live-proof-row",
                    organizationId: ORGANIZATION_A,
                    body: "live-proof",
                    createdAt: 42,
                },
            })
        );
        await expect(mutationResult).resolves.toMatchObject({
            t: "poke",
            mutResults: [{ mutId: "live-proof-write", ok: true }],
        });

        const dirtyA1 = await currentRegistration(clientA1, 1);
        const dirtyA2 = await currentRegistration(clientA2, 1);
        const dirtyB = await currentRegistration(clientB, 1);
        expect(dirtyA1.dirtyVersion).toBeGreaterThan(dirtyA1.deliveredVersion);
        expect(dirtyA2.dirtyVersion).toBeGreaterThan(dirtyA2.deliveredVersion);
        expect(dirtyB.dirtyVersion).toBeGreaterThan(dirtyB.deliveredVersion);

        const replacementA1 = nextDown(a1.socket);
        const replacementA2 = nextDown(a2.socket);
        const replacementB = nextDown(b.socket);
        await Promise.all([drainGateway(clientA1), drainGateway(clientA2), drainGateway(clientB)]);
        const [snapshotA1, snapshotA2, snapshotB] = await Promise.all([replacementA1, replacementA2, replacementB]);
        expect(snapshotA1).toMatchObject({
            t: "snapshot",
            subId: 1,
            rows: [{ id: "live-proof-row", organizationId: ORGANIZATION_A, viewerId: "workerd-user" }],
        });
        expect(snapshotA2).toMatchObject({
            t: "snapshot",
            subId: 1,
            rows: [{ id: "live-proof-row", organizationId: ORGANIZATION_A, viewerId: "workerd-user-2" }],
        });
        expect(snapshotB).toMatchObject({ t: "snapshot", subId: 1, rows: [] });
        if (snapshotA1.t !== "snapshot" || snapshotA2.t !== "snapshot" || snapshotB.t !== "snapshot") {
            throw new Error("expected replacement snapshots");
        }
        expect(snapshotA1.cookie).not.toBe(initialA1.cookie);
        expect(snapshotA2.cookie).not.toBe(initialA2.cookie);
        acknowledge(a1.socket, snapshotA1);
        acknowledge(a2.socket, snapshotA2);
        acknowledge(b.socket, snapshotB);

        const deliveredA1 = await currentRegistration(clientA1, 1);
        const deliveredA2 = await currentRegistration(clientA2, 1);
        const isolatedB = await currentRegistration(clientB, 1);
        expect(deliveredA1).toMatchObject({
            deliveredVersion: dirtyA1.dirtyVersion,
            lastCookie: snapshotA1.cookie,
            lastSnapshotCookie: snapshotA1.cookie,
            outboxCookie: null,
            outboxTargetVersion: null,
        });
        expect(deliveredA2).toMatchObject({
            deliveredVersion: dirtyA2.dirtyVersion,
            lastCookie: snapshotA2.cookie,
            lastSnapshotCookie: snapshotA2.cookie,
            outboxCookie: null,
            outboxTargetVersion: null,
        });
        expect(isolatedB).toMatchObject({
            dirtyVersion: dirtyB.dirtyVersion,
            deliveredVersion: dirtyB.dirtyVersion,
            lastSnapshotCookie: snapshotB.cookie,
        });

        const cdb = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
        expect(cdb.invalidations).toEqual([]);
        expect(
            cdb.subscriptions
                .filter(subscription => subscription.state === "active")
                .map(subscription => ({
                    clientId: subscription.clientId,
                    organizationId: subscription.organizationId,
                }))
        ).toEqual(
            expect.arrayContaining([
                { clientId: clientA1, organizationId: ORGANIZATION_A },
                { clientId: clientA2, organizationId: ORGANIZATION_A },
                { clientId: clientB, organizationId: ORGANIZATION_B },
            ])
        );

        a1.socket.close();
        await a1.closed;
        const reconnected = await openSocket(clientA1, await signed("workerd-user"));
        const reconnectSnapshot = await subscribe(reconnected, clientA1, 1, ORGANIZATION_A);
        expect(reconnectSnapshot.rows).toEqual([
            expect.objectContaining({ id: "live-proof-row", organizationId: ORGANIZATION_A }),
        ]);
        acknowledge(reconnected.socket, reconnectSnapshot);

        reconnected.socket.close();
        a2.socket.close();
        b.socket.close();
        mutator.socket.close();
    });

    test("Gateway and Cdb reconstruction preserves a staged replacement", async () => {
        if (!mf || !mutationRef) throw new Error("live fixture was not initialized");
        const clientId = "live-restart-05";
        const opened = await openSocket(clientId, await signed("workerd-user"));
        expect(opened.welcome.t).toBe("welcome");

        const initial = await subscribe(opened, clientId, 9, ORGANIZATION_A, "restart-proof");
        expect(initial.rows).toEqual([]);
        acknowledge(opened.socket, initial);

        const beforeMutation = await currentRegistration(clientId, 9);
        const mutationResult = nextDown(opened.socket);
        opened.socket.send(
            encodeWire({
                t: "mut",
                mutId: MutId("live-restart-write"),
                ref: mutationRef,
                args: {
                    id: "live-restart-row",
                    organizationId: ORGANIZATION_A,
                    body: "restart-proof",
                    createdAt: 43,
                },
            })
        );
        await expect(mutationResult).resolves.toMatchObject({
            t: "poke",
            mutResults: [{ mutId: "live-restart-write", ok: true }],
        });

        const dirty = await currentRegistration(clientId, 9);
        expect(dirty.dirtyVersion).toBeGreaterThan(beforeMutation.deliveredVersion);
        await stageGateway(clientId);

        const beforeEviction = await gatewayState(clientId);
        const staged = beforeEviction.registrations.find(row => row.subId === 9 && row.currentHead);
        expect(staged).toMatchObject({
            registrationId: dirty.registrationId,
            lifecycle: "active",
            cdbState: "active",
            dirtyVersion: dirty.dirtyVersion,
            deliveredVersion: beforeMutation.deliveredVersion,
            outboxTargetVersion: dirty.dirtyVersion,
        });
        expect(staged?.outboxCookie).toBeString();
        if (!staged?.outboxCookie) throw new Error("Gateway did not stage the replacement snapshot");
        const stagedCookie = staged.outboxCookie;

        const cdbBeforeEviction = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
        const cdbRegistration = cdbBeforeEviction.subscriptions.find(
            subscription => subscription.registrationId === dirty.registrationId
        );
        expect(cdbRegistration).toMatchObject({
            clientId,
            subId: 9,
            state: "active",
            organizationId: ORGANIZATION_A,
        });
        if (!cdbRegistration) throw new Error("Cdb did not retain the live subscription");

        await mf.unsafeEvictDurableObject(WORKER_NAME, "Gateway", {
            name: clientId.slice(0, 12),
            webSockets: "hibernate",
        });
        await mf.unsafeEvictDurableObject(WORKER_NAME, "Cdb", { name: shardId });

        const afterEviction = await gatewayState(clientId);
        const cdbAfterEviction = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
        expect(afterEviction.instanceId).not.toBe(beforeEviction.instanceId);
        expect(afterEviction.registrations).toEqual(beforeEviction.registrations);
        expect(cdbAfterEviction.instanceId).not.toBe(cdbBeforeEviction.instanceId);
        expect(cdbAfterEviction.subscriptions).toEqual(cdbBeforeEviction.subscriptions);
        expect(cdbAfterEviction.invalidations).toEqual(cdbBeforeEviction.invalidations);
        expect(await matchedCdbSubscriptions()).toContainEqual(cdbRegistration);

        const replacementMessage = nextDown(opened.socket);
        await drainGateway(clientId);
        const replacement = await replacementMessage;
        expect(replacement).toMatchObject({
            t: "snapshot",
            subId: 9,
            rows: [
                {
                    id: "live-restart-row",
                    organizationId: ORGANIZATION_A,
                    body: "restart-proof",
                    viewerId: "workerd-user",
                },
            ],
        });
        if (replacement.t !== "snapshot") throw new Error("expected reconstructed snapshot delivery");
        expect(String(replacement.cookie)).toBe(stagedCookie);
        acknowledge(opened.socket, replacement);

        const delivered = await currentRegistration(clientId, 9);
        expect(delivered).toMatchObject({
            dirtyVersion: dirty.dirtyVersion,
            deliveredVersion: dirty.dirtyVersion,
            lastCookie: replacement.cookie,
            lastSnapshotCookie: replacement.cookie,
            outboxCookie: null,
            outboxTargetVersion: null,
        });
        opened.socket.close();
    });
});
