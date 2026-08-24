import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { type ChardbRef, ClientId, Cookie, MutId, SubId } from "../../src/types.ts";
import { type Down, PROTOCOL_V, type Up, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "gateway-snapshot.entry.ts");
const BUNDLE = path.join(process.env.TMPDIR ?? "/tmp", `chardb-gateway-snapshot-${process.pid}.bundle.mjs`);
const WORKER_NAME = "gateway-snapshot-delivery-worker";
const KID = "gateway-snapshot-workerd-key";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const ORGANIZATION = "workerd-org";

interface DirtyRun {
    readonly targetVersion: number;
    readonly runToken: string;
    readonly runVersion: number;
    readonly leaseExpiresAt: number;
    readonly reclaimed: boolean;
}

interface SnapshotState {
    readonly instanceId: string;
    readonly generation: {
        readonly lifecycle: string;
        readonly cdbState: string;
        readonly dirtyVersion: number;
        readonly deliveredVersion: number;
        readonly runToken: string | null;
        readonly runTargetVersion: number | null;
        readonly runVersion: number;
        readonly lastCookie: string | null;
        readonly lastSnapshotCookie: string | null;
        readonly headRegistrationId: string | null;
    } | null;
    readonly outbox: {
        readonly cookie: string;
        readonly targetVersion: number;
        readonly rowsJson: string;
        readonly sendAttempts: number;
        readonly nextAttemptAt: number;
        readonly claimToken: string | null;
        readonly claimVersion: number;
        readonly claimExpiresAt: number | null;
        readonly lastSentAt: number | null;
    } | null;
}

interface GatewayLiveState {
    readonly instanceId: string;
    readonly registrations: readonly {
        readonly registrationId: string;
        readonly clientId: string;
        readonly subId: number;
        readonly lifecycle: string;
        readonly cdbState: string;
        readonly dirtyVersion: number;
        readonly deliveredVersion: number;
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
        readonly registrationId: string;
        readonly clientId: string;
        readonly subId: number;
        readonly state: string;
    }[];
    readonly invalidations: readonly unknown[];
}

interface DeliveryState {
    readonly registrationId: string;
    readonly dirtyVersion: number;
    readonly deliveredVersion: number;
    readonly lastCookie: string | null;
    readonly lastSnapshotCookie: string | null;
    readonly cookie: string | null;
    readonly targetVersion: number | null;
    readonly rowsJson: string | null;
    readonly sendAttempts: number | null;
    readonly claimVersion: number | null;
    readonly claimExpiresAt: number | null;
    readonly lastSentAt: number | null;
}

interface OpenedSocket {
    readonly socket: WebSocket;
    readonly welcome: Down;
    readonly closed: Promise<CloseEvent>;
}

let script = "";
let persistencePath = "";
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

function startMiniflare(): Miniflare {
    return new Miniflare({
        name: WORKER_NAME,
        modules: true,
        script,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_GATEWAY: { className: "Gateway", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
        },
        durableObjectsPersist: persistencePath,
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
}

async function call<T>(operation: string, body?: Record<string, unknown>): Promise<T> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch(`http://example.com/${operation}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${operation} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

async function fixtureFetch<T>(pathname: string, search: Record<string, string> = {}): Promise<T> {
    if (!mf) throw new Error("miniflare not initialized");
    const url = new URL(pathname, "http://example.com");
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
    const response = await mf.dispatchFetch(url);
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

async function restartMiniflare(): Promise<void> {
    await mf?.dispose();
    mf = startMiniflare();
    workerdUrl = await mf.ready;
}

function nextDown(socket: WebSocket): Promise<Down> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for Gateway message")), 5_000);
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

async function signed(subject: string): Promise<string> {
    if (!signToken) throw new Error("signer not initialized");
    return signToken(subject);
}

async function openSocket(clientId: string): Promise<OpenedSocket> {
    if (!workerdUrl) throw new Error("miniflare not initialized");
    const url = new URL("/ws", workerdUrl);
    url.searchParams.set("clientId", clientId);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out opening Gateway WebSocket")), 5_000);
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
            jwt: await signed("workerd-user"),
        })
    );
    return { socket, welcome: await welcome, closed };
}

async function gatewayState(clientId: string): Promise<GatewayLiveState> {
    return fixtureFetch("/live-gateway-state", { clientId });
}

async function deliveryState(clientId: string, subId: number): Promise<DeliveryState | null> {
    return fixtureFetch("/snapshot-delivery-state", { clientId, subId: String(subId) });
}

async function drainGateway(clientId: string): Promise<void> {
    await fixtureFetch("/live-gateway-drain", { clientId });
}

async function drainGatewayAt(clientId: string, nowMs: number): Promise<void> {
    await fixtureFetch("/snapshot-gateway-drain-at", { clientId, nowMs: String(nowMs) });
}

async function stageGateway(clientId: string): Promise<void> {
    await fixtureFetch("/live-gateway-stage", { clientId });
}

async function drainCdb(): Promise<void> {
    await fixtureFetch("/snapshot-cdb-drain", { shardId });
}

async function activeRegistration(clientId: string, subId: number): Promise<GatewayLiveState["registrations"][number]> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const state = await gatewayState(clientId);
        const registration = state.registrations.find(row => row.subId === subId && row.currentHead);
        if (registration?.lifecycle === "active" && registration.cdbState === "active") return registration;
        await Bun.sleep(10);
    }
    throw new Error(`Gateway did not activate registration ${clientId}:${subId}`);
}

async function subscribe(opened: OpenedSocket, clientId: string, subId: number, body: string) {
    if (!queryRef) throw new Error("query ref was not seeded");
    const snapshot = nextDown(opened.socket);
    opened.socket.send(
        encodeWire({
            t: "sub",
            subId: SubId(subId),
            ref: queryRef,
            args: { organizationId: ORGANIZATION, body },
        })
    );
    await activeRegistration(clientId, subId);
    await drainGateway(clientId);
    const message = await snapshot;
    if (message.t !== "snapshot") throw new Error(`expected snapshot, received ${message.t}`);
    return message;
}

function acknowledge(socket: WebSocket, snapshot: Extract<Down, { t: "snapshot" }>): void {
    socket.send(encodeWire({ t: "ack", cookie: snapshot.cookie }));
}

async function mutate(opened: OpenedSocket, mutId: string, id: string, body: string): Promise<void> {
    if (!mutationRef) throw new Error("mutation ref was not seeded");
    const result = nextDown(opened.socket);
    opened.socket.send(
        encodeWire({
            t: "mut",
            mutId: MutId(mutId),
            ref: mutationRef,
            args: { id, organizationId: ORGANIZATION, body, createdAt: id.length },
        })
    );
    await expect(result).resolves.toMatchObject({
        t: "poke",
        mutResults: [{ mutId, ok: true }],
    });
    await drainCdb();
}

beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
    signToken = async subject => {
        const now = Math.floor(Date.now() / 1_000);
        return new SignJWT({ probe: "gateway-snapshot-workerd" })
            .setProtectedHeader({ alg: "ES256", kid: KID })
            .setSubject(subject)
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);
    };
    script = await buildWorker();
    persistencePath = await mkdtemp(path.join(tmpdir(), "chardb-gateway-snapshot-workerd-"));
    mf = startMiniflare();
    workerdUrl = await mf.ready;
    const seeded = await mf.dispatchFetch("http://example.com/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kid: KID, jwk: publicJwk }),
    });
    if (!seeded.ok) throw new Error(`failed to seed snapshot fixture: ${seeded.status} ${await seeded.text()}`);
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
    if (persistencePath) await rm(persistencePath, { recursive: true, force: true });
});

describe("Gateway snapshot delivery durability in real workerd", () => {
    test("staged delivery survives reconstruction and exact acknowledgement advances only its target", async () => {
        expect(await call<boolean>("install", {})).toBe(true);
        expect(await call<boolean>("dirty", { dirtyVersion: 5 })).toBe(true);
        const run = await call<DirtyRun>("claim", {});
        expect(run).toMatchObject({ targetVersion: 5, runVersion: 1, reclaimed: false });

        expect(await call<boolean>("dirty", { dirtyVersion: 9 })).toBe(true);
        expect(await call<boolean>("stage", { run })).toBe(true);
        expect(await call<boolean>("ack", {})).toBe(false);

        const beforeRestart = await call<SnapshotState>("inspect");
        expect(beforeRestart.generation).toMatchObject({
            lifecycle: "active",
            cdbState: "active",
            dirtyVersion: 9,
            deliveredVersion: 2,
            runToken: null,
            runTargetVersion: null,
            runVersion: 2,
            lastCookie: "cookie-baseline",
            lastSnapshotCookie: null,
            headRegistrationId: "registration-workerd-snapshot",
        });
        expect(beforeRestart.outbox).toEqual({
            cookie: "cookie-target-5",
            targetVersion: 5,
            rowsJson: '[{"id":"row-from-target-5"}]',
            sendAttempts: 0,
            nextAttemptAt: 220,
            claimToken: null,
            claimVersion: 0,
            claimExpiresAt: null,
            lastSentAt: null,
        });

        await restartMiniflare();

        const afterRestart = await call<SnapshotState>("inspect");
        expect(afterRestart.instanceId).not.toBe(beforeRestart.instanceId);
        expect(afterRestart.generation).toEqual(beforeRestart.generation);
        expect(afterRestart.outbox).toEqual(beforeRestart.outbox);

        expect(await call<Record<string, unknown> | null>("claim-send", {})).toMatchObject({
            registrationId: "registration-workerd-snapshot",
            cookie: "cookie-target-5",
            targetVersion: 5,
            rows: [{ id: "row-from-target-5" }],
            sendAttempts: 1,
            nextAttemptAt: 320,
        });
        expect(await call<boolean>("ack", { cookie: "cookie-forged" })).toBe(false);
        expect(await call<boolean>("ack", {})).toBe(true);

        const acknowledged = await call<SnapshotState>("inspect");
        expect(acknowledged.generation).toMatchObject({
            dirtyVersion: 9,
            deliveredVersion: 5,
            lastCookie: "cookie-target-5",
            lastSnapshotCookie: "cookie-target-5",
        });
        expect(acknowledged.outbox).toBeNull();
        expect(await call<boolean>("ack", {})).toBe(true);
        expect(await call<SnapshotState>("inspect")).toEqual(acknowledged);

        expect(await call<DirtyRun>("claim", { nowMs: 400 })).toMatchObject({ targetVersion: 9 });
    }, 15_000);

    test("an unacknowledged snapshot redelivers exactly after hibernation and later delivery continues", async () => {
        if (!mf) throw new Error("miniflare not initialized");
        const clientId = "snapshot-preack-01";
        const subId = 17;
        const body = "snapshot-preack-proof";
        const opened = await openSocket(clientId);
        expect(opened.welcome).toMatchObject({ t: "welcome" });

        const initial = await subscribe(opened, clientId, subId, body);
        expect(initial.rows).toEqual([]);
        acknowledge(opened.socket, initial);

        await mutate(opened, "snapshot-before-loss", "snapshot-before-loss-row", body);
        const dirty = await activeRegistration(clientId, subId);
        expect(dirty.dirtyVersion).toBeGreaterThan(dirty.deliveredVersion);
        await stageGateway(clientId);

        const staged = await deliveryState(clientId, subId);
        expect(staged).toMatchObject({
            registrationId: dirty.registrationId,
            dirtyVersion: dirty.dirtyVersion,
            deliveredVersion: dirty.deliveredVersion,
            targetVersion: dirty.dirtyVersion,
            sendAttempts: 0,
            claimVersion: 0,
            claimExpiresAt: null,
            lastSentAt: null,
        });
        expect(staged?.cookie).toBeString();
        expect(staged?.rowsJson).toContain('"id":"snapshot-before-loss-row"');
        if (!staged?.cookie) throw new Error("Gateway did not stage the first replacement");

        const firstDeliveryMessage = nextDown(opened.socket);
        await drainGateway(clientId);
        const firstDelivery = await firstDeliveryMessage;
        expect(firstDelivery).toEqual({
            t: "snapshot",
            subId: SubId(subId),
            cookie: Cookie(staged.cookie),
            rows: [
                {
                    id: "snapshot-before-loss-row",
                    organizationId: ORGANIZATION,
                    authorId: "workerd-user",
                    body,
                    createdAt: 24,
                    viewerId: "workerd-user",
                },
            ],
        });

        const sentOnce = await deliveryState(clientId, subId);
        expect(sentOnce).toMatchObject({
            cookie: staged.cookie,
            targetVersion: staged.targetVersion,
            rowsJson: staged.rowsJson,
            deliveredVersion: staged.deliveredVersion,
            sendAttempts: 1,
            claimVersion: 1,
        });
        expect(sentOnce?.claimExpiresAt).toBeNumber();
        expect(sentOnce?.lastSentAt).toBeNumber();
        if (sentOnce?.claimExpiresAt === null || sentOnce?.claimExpiresAt === undefined) {
            throw new Error("first delivery did not retain a retry lease");
        }

        const gatewayBeforeEviction = await gatewayState(clientId);
        const cdbBeforeEviction = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
        await mf.unsafeEvictDurableObject(WORKER_NAME, "Gateway", {
            name: clientId.slice(0, 12),
            webSockets: "hibernate",
        });
        await mf.unsafeEvictDurableObject(WORKER_NAME, "Cdb", { name: shardId });

        const gatewayAfterEviction = await gatewayState(clientId);
        const cdbAfterEviction = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
        expect(gatewayAfterEviction.instanceId).not.toBe(gatewayBeforeEviction.instanceId);
        expect(gatewayAfterEviction.registrations).toEqual(gatewayBeforeEviction.registrations);
        expect(cdbAfterEviction.instanceId).not.toBe(cdbBeforeEviction.instanceId);
        expect(cdbAfterEviction.subscriptions).toEqual(cdbBeforeEviction.subscriptions);
        expect(cdbAfterEviction.invalidations).toEqual(cdbBeforeEviction.invalidations);
        expect(await deliveryState(clientId, subId)).toEqual(sentOnce);
        expect(
            cdbAfterEviction.subscriptions.find(
                subscription =>
                    subscription.registrationId === staged.registrationId &&
                    subscription.clientId === clientId &&
                    subscription.subId === subId
            )
        ).toMatchObject({ state: "active" });

        const duplicateMessage = nextDown(opened.socket);
        await drainGatewayAt(clientId, sentOnce.claimExpiresAt);
        const duplicate = await duplicateMessage;
        expect(duplicate).toEqual(firstDelivery);

        const sentTwice = await deliveryState(clientId, subId);
        expect(sentTwice).toMatchObject({
            cookie: staged.cookie,
            targetVersion: staged.targetVersion,
            rowsJson: staged.rowsJson,
            deliveredVersion: staged.deliveredVersion,
            sendAttempts: 2,
            claimVersion: 2,
        });

        if (duplicate.t !== "snapshot") throw new Error("expected duplicate snapshot delivery");
        acknowledge(opened.socket, duplicate);
        await mutate(opened, "snapshot-after-ack", "snapshot-after-ack-row", body);

        const acknowledged = await deliveryState(clientId, subId);
        expect(acknowledged).toMatchObject({
            deliveredVersion: staged.targetVersion,
            lastCookie: staged.cookie,
            lastSnapshotCookie: staged.cookie,
            cookie: null,
            targetVersion: null,
            rowsJson: null,
            sendAttempts: null,
            claimVersion: null,
            claimExpiresAt: null,
            lastSentAt: null,
        });
        expect(acknowledged?.dirtyVersion).toBeGreaterThan(acknowledged?.deliveredVersion ?? Number.MAX_SAFE_INTEGER);

        await stageGateway(clientId);
        const laterStaged = await deliveryState(clientId, subId);
        expect(laterStaged?.cookie).toBeString();
        expect(laterStaged?.cookie).not.toBe(staged.cookie);
        expect(laterStaged).toMatchObject({
            deliveredVersion: staged.targetVersion,
            targetVersion: acknowledged?.dirtyVersion,
            sendAttempts: 0,
        });

        const laterDeliveryMessage = nextDown(opened.socket);
        await drainGateway(clientId);
        const laterDelivery = await laterDeliveryMessage;
        expect(laterDelivery).toMatchObject({
            t: "snapshot",
            subId,
            cookie: laterStaged?.cookie,
            rows: [
                expect.objectContaining({ id: "snapshot-after-ack-row", body, viewerId: "workerd-user" }),
                expect.objectContaining({ id: "snapshot-before-loss-row", body, viewerId: "workerd-user" }),
            ],
        });

        opened.socket.close();
        await opened.closed;
        await drainGateway(clientId);
        expect((await gatewayState(clientId)).registrations.every(row => !row.currentHead)).toBe(true);
    }, 15_000);
});
