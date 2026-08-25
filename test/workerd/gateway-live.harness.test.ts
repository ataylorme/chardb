import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { type ChardbClient, createChardbClient } from "../../src/client/index.ts";
import { type ChardbRef, ClientId, MutId, SubId } from "../../src/types.ts";
import { type Down, PROTOCOL_V, type Up, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "gateway-live.entry.ts");
const BUNDLE = path.join(process.env.TMPDIR ?? "/tmp", `chardb-gateway-live-${process.pid}.bundle.mjs`);
const KID = "gateway-live-workerd-key";
const WORKER_NAME = "gateway-live-restart-worker";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const ORGANIZATION_A = "workerd-org";
const ORGANIZATION_B = "workerd-org-b";
const SCALE_CLIENTS_PER_TENANT = boundedIntegerEnv("CHARDB_WORKERD_CLIENTS_PER_TENANT", 1, 1, 8);
const SCALE_MUTATIONS_PER_TENANT = boundedIntegerEnv("CHARDB_WORKERD_MUTATIONS_PER_TENANT", 4, 1, 1_024);
const SCALE_MUTATION_BATCH = boundedIntegerEnv("CHARDB_WORKERD_MUTATION_BATCH", 16, 1, 32);
const SCALE_SUBSCRIPTIONS = boundedIntegerEnv("CHARDB_WORKERD_SUBSCRIPTIONS", 4, 1, 64);
const SCALE_REFRESH_ROUNDS = boundedIntegerEnv("CHARDB_WORKERD_REFRESH_ROUNDS", 2, 1, 64);
const SCALE_WAIT_MS = boundedIntegerEnv("CHARDB_WORKERD_WAIT_MS", 5_000, 1_000, 60_000);
const SCALE_TEST_TIMEOUT_MS = boundedIntegerEnv("CHARDB_WORKERD_TEST_TIMEOUT_MS", 30_000, 5_000, 300_000);

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

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
let publicQueryRef: ChardbRef | undefined;
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

async function openSocket(clientId: string, jwt: string, immediate?: Up): Promise<OpenedSocket> {
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
    if (immediate) socket.send(encodeWire(immediate));
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

async function mutateMembership(action: "delete" | "upsert", role?: string): Promise<{ readonly affected?: number }> {
    if (!mf) throw new Error("Miniflare is not initialized");
    const response = await mf.dispatchFetch("http://example.com/live-membership", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            action,
            organizationId: ORGANIZATION_A,
            userId: "workerd-user",
            ...(role === undefined ? {} : { role }),
        }),
    });
    if (!response.ok) throw new Error(`membership mutation failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as { readonly affected?: number };
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

async function expectNoDown(socket: WebSocket, waitMs = 100): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            socket.removeEventListener("message", onMessage);
        };
        const onMessage = (event: MessageEvent) => {
            cleanup();
            reject(new Error(`received unexpected Gateway message: ${String(event.data)}`));
        };
        const timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, waitMs);
        socket.addEventListener("message", onMessage);
    });
}

async function signed(subject: string): Promise<string> {
    if (!signToken) throw new Error("JWT signer is not initialized");
    return signToken(subject);
}

interface ScaleRow {
    readonly id: string;
    readonly organizationId: string;
    readonly body: string;
    readonly createdAt: number;
    readonly viewerId: string;
}

interface QueryObservation {
    readonly rows: readonly ScaleRow[];
    readonly state: string;
}

interface QueryObserver {
    readonly listener: (rows: ScaleRow[], state?: string) => void;
    readonly latest: () => QueryObservation | null;
    readonly waitFor: (
        predicate: (observation: QueryObservation) => boolean,
        label: string
    ) => Promise<QueryObservation>;
}

function createQueryObserver(): QueryObserver {
    let current: QueryObservation | null = null;
    const waiters = new Set<() => void>();
    return {
        listener(rows, state) {
            current = { rows: rows.map(row => ({ ...row })), state: state ?? "missing" };
            for (const wake of [...waiters]) wake();
        },
        latest: () => current,
        async waitFor(predicate, label) {
            const deadline = Date.now() + SCALE_WAIT_MS;
            while (current === null || !predicate(current)) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new Error(`timed out waiting for ${label}; latest=${JSON.stringify(current)}`);
                }
                await new Promise<void>((resolve, reject) => {
                    const wake = () => {
                        clearTimeout(timeout);
                        waiters.delete(wake);
                        resolve();
                    };
                    const timeout = setTimeout(() => {
                        waiters.delete(wake);
                        reject(new Error(`timed out waiting for ${label}; latest=${JSON.stringify(current)}`));
                    }, remaining);
                    waiters.add(wake);
                });
            }
            return current;
        },
    };
}

function sdkEndpoint(): string {
    if (!workerdUrl) throw new Error("Miniflare is not initialized");
    const url = new URL("/ws", workerdUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

async function createSdkClient(clientId: string, subject: string): Promise<ChardbClient> {
    const jwt = await signed(subject);
    return createChardbClient({
        endpoint: sdkEndpoint(),
        clientId,
        getJwt: async () => jwt,
        crossTab: false,
        mutationTimeoutMs: SCALE_WAIT_MS,
    });
}

async function createSdkClientWithTrackedClose(
    clientId: string,
    subject: string
): Promise<{ readonly client: ChardbClient; readonly socketClosed: Promise<void> }> {
    const NativeWebSocket = globalThis.WebSocket;
    const jwt = await signed(subject);
    let settleCreated: (() => void) | undefined;
    let settleClosed: (() => void) | undefined;
    const socketCreated = new Promise<void>(resolve => {
        settleCreated = resolve;
    });
    const socketClosed = new Promise<void>(resolve => {
        settleClosed = resolve;
    });

    class CloseTrackingWebSocket {
        static readonly CONNECTING = NativeWebSocket.CONNECTING;
        static readonly OPEN = NativeWebSocket.OPEN;
        static readonly CLOSING = NativeWebSocket.CLOSING;
        static readonly CLOSED = NativeWebSocket.CLOSED;
        private readonly inner: WebSocket;

        constructor(url: string | URL) {
            this.inner = new NativeWebSocket(url);
            this.inner.addEventListener("close", () => settleClosed?.(), { once: true });
            settleCreated?.();
        }

        get readyState(): number {
            return this.inner.readyState;
        }

        get onopen(): WebSocket["onopen"] {
            return this.inner.onopen;
        }

        set onopen(listener: WebSocket["onopen"]) {
            this.inner.onopen = listener;
        }

        get onmessage(): WebSocket["onmessage"] {
            return this.inner.onmessage;
        }

        set onmessage(listener: WebSocket["onmessage"]) {
            this.inner.onmessage = listener;
        }

        get onclose(): WebSocket["onclose"] {
            return this.inner.onclose;
        }

        set onclose(listener: WebSocket["onclose"]) {
            this.inner.onclose = listener;
        }

        get onerror(): WebSocket["onerror"] {
            return this.inner.onerror;
        }

        set onerror(listener: WebSocket["onerror"]) {
            this.inner.onerror = listener;
        }

        send(data: Parameters<WebSocket["send"]>[0]): void {
            this.inner.send(data);
        }

        close(code?: number, reason?: string): void {
            this.inner.close(code, reason);
        }
    }

    let client: ChardbClient | undefined;
    let creationTimer: ReturnType<typeof setTimeout> | undefined;
    let created = false;
    try {
        globalThis.WebSocket = CloseTrackingWebSocket as unknown as typeof WebSocket;
        client = createChardbClient({
            endpoint: sdkEndpoint(),
            clientId,
            getJwt: async () => jwt,
            crossTab: false,
            mutationTimeoutMs: SCALE_WAIT_MS,
        });
        await Promise.race([
            socketCreated,
            new Promise<never>((_, reject) => {
                creationTimer = setTimeout(
                    () => reject(new Error(`timed out constructing SDK WebSocket for ${clientId}`)),
                    SCALE_WAIT_MS
                );
            }),
        ]);
        created = true;
        return { client, socketClosed };
    } finally {
        if (creationTimer) clearTimeout(creationTimer);
        globalThis.WebSocket = NativeWebSocket;
        if (!created) {
            client?.close();
            settleClosed?.();
        }
    }
}

async function drainUntilSettled(clientId: string, subIds: readonly number[]): Promise<GatewayLiveState> {
    const deadline = Date.now() + SCALE_WAIT_MS;
    let latest: GatewayLiveState | null = null;
    while (Date.now() < deadline) {
        await drainGateway(clientId);
        const state = await gatewayState(clientId);
        latest = state;
        const settled = subIds.every(subId => {
            const row = state.registrations.find(
                candidate => candidate.clientId === clientId && candidate.subId === subId && candidate.currentHead
            );
            return (
                row?.lifecycle === "active" &&
                row.cdbState === "active" &&
                !row.initialSnapshotPending &&
                row.dirtyVersion === row.deliveredVersion &&
                row.outboxCookie === null &&
                row.outboxTargetVersion === null
            );
        });
        if (settled) return state;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const unresolved = subIds.filter(subId => {
        const row = latest?.registrations.find(
            candidate => candidate.clientId === clientId && candidate.subId === subId && candidate.currentHead
        );
        return (
            row?.lifecycle !== "active" ||
            row.cdbState !== "active" ||
            row.initialSnapshotPending ||
            row.dirtyVersion !== row.deliveredVersion ||
            row.outboxCookie !== null ||
            row.outboxTargetVersion !== null
        );
    });
    throw new Error(`Gateway did not settle ${clientId} subscriptions ${unresolved.join(",")}`);
}

async function cleanupSdkClient(
    clientId: string,
    client: ChardbClient,
    subscriptions: readonly { unsubscribe: () => void }[]
): Promise<void> {
    for (const subscription of subscriptions) {
        try {
            subscription.unsubscribe();
        } catch {
            // close() below remains the terminal cleanup path.
        }
    }
    client.close();
    const deadline = Date.now() + SCALE_WAIT_MS;
    while (Date.now() < deadline) {
        await drainGateway(clientId);
        const state = await gatewayState(clientId);
        if (!state.registrations.some(row => row.clientId === clientId && row.currentHead)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out cleaning SDK client ${clientId}`);
}

async function inBatches<T>(items: readonly T[], batchSize: number, run: (item: T) => Promise<void>): Promise<void> {
    for (let offset = 0; offset < items.length; offset += batchSize) {
        await Promise.all(items.slice(offset, offset + batchSize).map(run));
    }
}

function rate(count: number, durationMs: number): number {
    return durationMs === 0 ? 0 : Number(((count * 1_000) / durationMs).toFixed(2));
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
        readonly publicQueryRef: ChardbRef;
        readonly shardA: string;
        readonly shardB: string;
    };
    mutationRef = seed.mutationRef;
    queryRef = seed.queryRef;
    publicQueryRef = seed.publicQueryRef;
    shardId = seed.shardA;
    expect(seed.shardA).toBe(seed.shardB);
    await fixtureFetch("/live-public-seed", { shardId });
});

afterAll(async () => {
    await mf?.dispose();
});

describe("public durable live queries in real workerd", () => {
    test("publicRead remains JWT-authenticated, membership-bound, and tenant-scoped", async () => {
        if (!publicQueryRef) throw new Error("public query ref was not seeded");
        const clientId = "public-reader-08";
        const opened = await openSocket(clientId, await signed("workerd-user"));
        expect(opened.welcome.t).toBe("welcome");

        const snapshotMessage = nextDown(opened.socket);
        opened.socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(20),
                ref: publicQueryRef,
                args: { organizationId: ORGANIZATION_A },
            })
        );
        await currentRegistration(clientId, 20);
        await drainGateway(clientId);
        const snapshot = await snapshotMessage;
        expect(snapshot).toEqual({
            t: "snapshot",
            subId: SubId(20),
            cookie: expect.any(String),
            rows: [{ id: "public-org-a", organizationId: ORGANIZATION_A, label: "Organization A" }],
        });
        if (snapshot.t !== "snapshot") throw new Error("expected publicRead snapshot");
        acknowledge(opened.socket, snapshot);

        const forbidden = nextDown(opened.socket);
        opened.socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(21),
                ref: publicQueryRef,
                args: { organizationId: ORGANIZATION_B },
            })
        );
        await expect(forbidden).resolves.toMatchObject({
            t: "error",
            subId: 21,
            code: "CDB_FORBIDDEN",
            retryable: false,
        });
        expect((await gatewayState(clientId)).registrations.some(row => row.subId === 21 && row.currentHead)).toBe(
            false
        );

        opened.socket.close();
        await opened.closed;
        await drainGateway(clientId);

        for (const [rejectedClientId, jwt] of [
            ["missing-jwt-09", ""],
            ["invalid-jwt-10", "not-a-jwt"],
        ] as const) {
            const rejected = await openSocket(rejectedClientId, jwt, {
                t: "sub",
                subId: SubId(1),
                ref: publicQueryRef,
                args: { organizationId: ORGANIZATION_A },
            });
            expect(rejected.welcome).toMatchObject({ t: "error", code: "CDB_FORBIDDEN", retryable: false });
            expect(rejected.welcome.t).not.toBe("welcome");
            await rejected.closed;
            expect((await gatewayState(rejectedClientId)).registrations.some(row => row.currentHead)).toBe(false);
        }
    });

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
        await Promise.all([reconnected.closed, a2.closed, b.closed, mutator.closed]);
        await Promise.all([
            drainGateway(clientA1),
            drainGateway(clientA2),
            drainGateway(clientB),
            drainGateway(mutatorId),
        ]);
        expect((await gatewayState(clientA1)).registrations.every(row => !row.currentHead)).toBe(true);
        expect((await gatewayState(clientA2)).registrations.every(row => !row.currentHead)).toBe(true);
        expect((await gatewayState(clientB)).registrations.every(row => !row.currentHead)).toBe(true);
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
        expect(
            cdbAfterEviction.subscriptions.find(
                subscription => subscription.registrationId === cdbRegistration.registrationId
            )
        ).toEqual(cdbRegistration);

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
        await opened.closed;
        await drainGateway(clientId);
        expect((await gatewayState(clientId)).registrations.every(row => !row.currentHead)).toBe(true);
    });

    test("a dirty rerun re-reads membership authority on a long-lived socket", async () => {
        if (!mutationRef) throw new Error("mutation ref was not seeded");
        const writeRef = mutationRef;
        const clientId = "live-revoke-06";
        const writerId = "authority-writer-07";
        const opened = await openSocket(clientId, await signed("workerd-user"));
        const writer = await openSocket(writerId, await signed("workerd-user-2"));
        expect(opened.welcome.t).toBe("welcome");
        expect(writer.welcome.t).toBe("welcome");

        const write = async (mutId: string, id: string): Promise<void> => {
            const result = nextDown(writer.socket);
            writer.socket.send(
                encodeWire({
                    t: "mut",
                    mutId: MutId(mutId),
                    ref: writeRef,
                    args: {
                        id,
                        organizationId: ORGANIZATION_A,
                        body: "authority-proof",
                        createdAt: 44,
                    },
                })
            );
            expect(await result).toMatchObject({
                t: "poke",
                mutResults: [{ mutId, ok: true }],
            });
        };

        await write("live-authority-seed", "live-authority-row-1");
        const initial = await subscribe(opened, clientId, 12, ORGANIZATION_A, "authority-proof");
        expect(initial.rows).toEqual([
            expect.objectContaining({
                id: "live-authority-row-1",
                organizationId: ORGANIZATION_A,
                viewerId: "workerd-user",
            }),
        ]);
        acknowledge(opened.socket, initial);

        expect((await mutateMembership("upsert", "viewer")).affected).toBe(1);
        const beforeDowngrade = await currentRegistration(clientId, 12);
        await write("live-authority-downgrade", "live-authority-row-2");
        const dirtyAfterDowngrade = await currentRegistration(clientId, 12);
        expect(dirtyAfterDowngrade.dirtyVersion).toBeGreaterThan(beforeDowngrade.deliveredVersion);
        const downgradedMessage = nextDown(opened.socket);
        await drainGateway(clientId);
        const downgraded = await downgradedMessage;
        expect(downgraded).toMatchObject({ t: "snapshot", subId: 12, rows: [] });
        if (downgraded.t !== "snapshot") throw new Error("expected role downgrade replacement snapshot");
        acknowledge(opened.socket, downgraded);

        expect((await mutateMembership("upsert", "member")).affected).toBe(1);
        await write("live-authority-restore-role", "live-authority-row-3");
        const restoredMessage = nextDown(opened.socket);
        await drainGateway(clientId);
        const restored = await restoredMessage;
        expect(restored).toMatchObject({
            t: "snapshot",
            subId: 12,
            rows: [
                { id: "live-authority-row-1", organizationId: ORGANIZATION_A, viewerId: "workerd-user" },
                { id: "live-authority-row-2", organizationId: ORGANIZATION_A, viewerId: "workerd-user" },
                { id: "live-authority-row-3", organizationId: ORGANIZATION_A, viewerId: "workerd-user" },
            ],
        });
        if (restored.t !== "snapshot") throw new Error("expected restored-role replacement snapshot");
        acknowledge(opened.socket, restored);

        expect((await mutateMembership("delete")).affected).toBe(1);
        await write("live-authority-revoke", "live-authority-row-4");
        const revokedMessage = nextDown(opened.socket);
        await drainGateway(clientId);
        await expect(revokedMessage).resolves.toMatchObject({
            t: "error",
            subId: 12,
            code: "CDB_FORBIDDEN",
            retryable: false,
        });
        expect((await gatewayState(clientId)).registrations.some(row => row.subId === 12 && row.currentHead)).toBe(
            false
        );

        const noReplacement = expectNoDown(opened.socket);
        await write("live-authority-after-revoke", "live-authority-row-5");
        await drainGateway(clientId);
        await noReplacement;

        expect((await mutateMembership("upsert", "member")).affected).toBe(1);
        const fresh = await subscribe(opened, clientId, 12, ORGANIZATION_A, "authority-proof");
        expect(fresh.rows).toHaveLength(5);
        expect(fresh.rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "live-authority-row-1", viewerId: "workerd-user" }),
                expect.objectContaining({ id: "live-authority-row-5", viewerId: "workerd-user" }),
            ])
        );
        acknowledge(opened.socket, fresh);

        opened.socket.close();
        writer.socket.close();
        await Promise.all([opened.closed, writer.closed]);
        await Promise.all([drainGateway(clientId), drainGateway(writerId)]);
        expect((await gatewayState(clientId)).registrations.every(row => !row.currentHead)).toBe(true);
    });

    test("one configured Gateway enforces the exact 256-registration boundary and readmits after release", async () => {
        if (!mf || !queryRef) throw new Error("live fixture was not initialized");
        const readRef = queryRef;
        const gatewayPrefix = "quota-shared";
        const expectedClientIds = Array.from(
            { length: 4 },
            (_, index) => `${gatewayPrefix}-${index.toString().padStart(2, "0")}`
        );
        const clients: Array<{
            readonly clientId: string;
            readonly client: ChardbClient;
            readonly subscriptions: Array<{ unsubscribe: () => void }>;
        }> = [];
        let rejectedSocket: OpenedSocket | undefined;
        let primaryFailure: unknown;
        const cleanupFailures: unknown[] = [];

        const quotaRows = (state: GatewayLiveState) =>
            state.registrations.filter(row => row.currentHead && row.clientId.startsWith(gatewayPrefix));
        const waitForCounts = async (gatewayCount: number, cdbCount: number): Promise<GatewayLiveState> => {
            const deadline = Date.now() + Math.max(SCALE_WAIT_MS, 15_000);
            let lastGatewayCount = -1;
            let lastCdbCount = -1;
            while (Date.now() < deadline) {
                await drainGateway(expectedClientIds[0] as string);
                const state = await gatewayState(expectedClientIds[0] as string);
                const gatewayRows = quotaRows(state);
                const cdb = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
                const activeCdbRows = cdb.subscriptions.filter(
                    row => row.state === "active" && row.clientId.startsWith(gatewayPrefix)
                );
                lastGatewayCount = gatewayRows.length;
                lastCdbCount = activeCdbRows.length;
                const settled = gatewayRows.every(
                    row =>
                        row.lifecycle === "active" &&
                        row.cdbState === "active" &&
                        !row.initialSnapshotPending &&
                        row.dirtyVersion === row.deliveredVersion &&
                        row.outboxCookie === null &&
                        row.outboxTargetVersion === null
                );
                if (gatewayRows.length === gatewayCount && activeCdbRows.length === cdbCount && settled) {
                    return state;
                }
                await Bun.sleep(10);
            }
            throw new Error(
                `timed out waiting for Gateway/Cdb quota counts ${gatewayCount}/${cdbCount}; last=${lastGatewayCount}/${lastCdbCount}`
            );
        };

        try {
            for (const clientId of expectedClientIds) {
                const client = await createSdkClient(clientId, "workerd-user");
                const subscriptions: Array<{ unsubscribe: () => void }> = [];
                clients.push({ clientId, client, subscriptions });
                for (let index = 0; index < 64; index++) {
                    subscriptions.push(
                        client.subscribe<ScaleRow>(
                            readRef,
                            {
                                organizationId: ORGANIZATION_A,
                                body: `quota-${clientId}-${index.toString().padStart(2, "0")}`,
                            },
                            () => {}
                        )
                    );
                }
            }

            const full = await waitForCounts(256, 256);
            const fullRows = quotaRows(full);
            expect(fullRows).toHaveLength(256);
            expect(new Set(fullRows.map(row => `${row.clientId}:${row.subId}`)).size).toBe(256);
            for (const clientId of expectedClientIds) {
                expect(fullRows.filter(row => row.clientId === clientId)).toHaveLength(64);
            }

            const rejectedClientId = `${gatewayPrefix}-rejected`;
            rejectedSocket = await openSocket(rejectedClientId, await signed("workerd-user"));
            expect(rejectedSocket.welcome).toMatchObject({ t: "welcome" });
            const rejection = nextDown(rejectedSocket.socket, Math.max(SCALE_WAIT_MS, 5_000));
            rejectedSocket.socket.send(
                encodeWire({
                    t: "sub",
                    subId: SubId(1),
                    ref: readRef,
                    args: { organizationId: ORGANIZATION_A, body: "quota-rejected" },
                })
            );
            const rejectionMessage = await rejection;
            expect(rejectionMessage).toMatchObject({
                t: "error",
                subId: 1,
                code: "CDB_RATE_LIMITED",
                retryable: true,
            });
            const afterRejection = await gatewayState(rejectedClientId);
            expect(quotaRows(afterRejection)).toHaveLength(256);
            expect(afterRejection.registrations.some(row => row.clientId === rejectedClientId)).toBe(false);
            expect(
                (await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId })).subscriptions.some(
                    row => row.clientId === rejectedClientId
                )
            ).toBe(false);
            rejectedSocket.socket.close();
            await rejectedSocket.closed;
            rejectedSocket = undefined;

            const releasing = clients[0];
            if (!releasing) throw new Error("missing quota client to release");
            const released = releasing.subscriptions.shift();
            if (!released) throw new Error("missing quota subscription to release");
            released.unsubscribe();
            await waitForCounts(255, 255);

            const replacementClientId = `${gatewayPrefix}-replacement`;
            const replacementClient = await createSdkClient(replacementClientId, "workerd-user");
            const replacementSubscriptions: Array<{ unsubscribe: () => void }> = [];
            clients.push({
                clientId: replacementClientId,
                client: replacementClient,
                subscriptions: replacementSubscriptions,
            });
            replacementSubscriptions.push(
                replacementClient.subscribe<ScaleRow>(
                    readRef,
                    { organizationId: ORGANIZATION_A, body: "quota-replacement" },
                    () => {}
                )
            );
            const refilled = await waitForCounts(256, 256);
            expect(
                quotaRows(refilled).find(row => row.clientId === replacementClientId && row.subId === 1)
            ).toMatchObject({ lifecycle: "active", cdbState: "active", currentHead: true });
        } catch (error) {
            primaryFailure = error;
        } finally {
            if (rejectedSocket) {
                try {
                    rejectedSocket.socket.close();
                    await rejectedSocket.closed;
                } catch (error) {
                    cleanupFailures.push(error);
                }
            }
            for (const entry of clients) {
                try {
                    await cleanupSdkClient(entry.clientId, entry.client, entry.subscriptions);
                } catch (error) {
                    cleanupFailures.push(error);
                }
            }
            try {
                await waitForCounts(0, 0);
            } catch (error) {
                cleanupFailures.push(error);
            }
        }

        if (primaryFailure !== undefined) {
            if (primaryFailure instanceof Error && cleanupFailures.length > 0) {
                Object.defineProperty(primaryFailure, "cause", {
                    configurable: true,
                    value: new AggregateError(cleanupFailures, "quota proof cleanup failed"),
                });
            }
            throw primaryFailure;
        }
        if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "quota proof cleanup failed");
        expect(quotaRows(await waitForCounts(0, 0))).toHaveLength(0);
    }, 30_000);

    test(
        "scaled SDK mutation fanout stays tenant-isolated",
        async () => {
            if (!mutationRef || !queryRef) throw new Error("live fixture refs were not seeded");
            const writeRef = mutationRef;
            const readRef = queryRef;
            const body = "sdk-scale-fanout-v1";
            const tenants = [
                { label: "a", organizationId: ORGANIZATION_A, subject: "workerd-user" },
                { label: "b", organizationId: ORGANIZATION_B, subject: "workerd-user-b" },
            ] as const;
            const clients: Array<{
                readonly clientId: string;
                readonly organizationId: string;
                readonly subject: string;
                readonly client: ChardbClient;
                readonly observer: QueryObserver;
                readonly subscriptions: Array<{ unsubscribe: () => void }>;
            }> = [];
            const startedAt = performance.now();
            try {
                for (const tenant of tenants) {
                    for (let index = 0; index < SCALE_CLIENTS_PER_TENANT; index++) {
                        const clientId = `bench-${tenant.label}-${index.toString().padStart(4, "0")}`;
                        const client = await createSdkClient(clientId, tenant.subject);
                        const observer = createQueryObserver();
                        const subscription = client.subscribe<ScaleRow>(
                            readRef,
                            { organizationId: tenant.organizationId, body },
                            observer.listener
                        );
                        clients.push({
                            clientId,
                            organizationId: tenant.organizationId,
                            subject: tenant.subject,
                            client,
                            observer,
                            subscriptions: [subscription],
                        });
                    }
                }

                await Promise.all(clients.map(entry => drainUntilSettled(entry.clientId, [1])));
                await Promise.all(
                    clients.map(entry =>
                        entry.observer.waitFor(
                            observation => observation.state === "live" && observation.rows.length === 0,
                            `${entry.clientId} initial empty snapshot`
                        )
                    )
                );
                const initialMs = performance.now() - startedAt;

                const expectedIds = new Map<string, string[]>();
                const mutationStartedAt = performance.now();
                await Promise.all(
                    tenants.map(async tenant => {
                        const mutator = clients.find(entry => entry.organizationId === tenant.organizationId);
                        if (!mutator) throw new Error(`missing mutator for ${tenant.organizationId}`);
                        const jobs = Array.from({ length: SCALE_MUTATIONS_PER_TENANT }, (_, index) => ({
                            index,
                            id: `sdk-fanout-${tenant.label}-${index.toString().padStart(5, "0")}`,
                        }));
                        expectedIds.set(
                            tenant.organizationId,
                            jobs.map(job => job.id)
                        );
                        await inBatches(jobs, SCALE_MUTATION_BATCH, async job => {
                            const result = await mutator.client.mutate<{
                                readonly id: string;
                                readonly userId: string;
                                readonly tenantId: string | null;
                            }>(writeRef, {
                                id: job.id,
                                organizationId: tenant.organizationId,
                                body,
                                createdAt: 10_000 + job.index,
                            });
                            expect(result).toMatchObject({
                                id: job.id,
                                userId: tenant.subject,
                                tenantId: tenant.organizationId,
                            });
                        });
                    })
                );
                const mutationMs = performance.now() - mutationStartedAt;

                const convergenceStartedAt = performance.now();
                const settledStates = await Promise.all(clients.map(entry => drainUntilSettled(entry.clientId, [1])));
                const finalObservations = await Promise.all(
                    clients.map(entry =>
                        entry.observer.waitFor(
                            observation =>
                                observation.state === "live" && observation.rows.length === SCALE_MUTATIONS_PER_TENANT,
                            `${entry.clientId} final fanout snapshot`
                        )
                    )
                );
                const convergenceMs = performance.now() - convergenceStartedAt;

                for (let index = 0; index < clients.length; index++) {
                    const entry = clients[index] as (typeof clients)[number];
                    const observation = finalObservations[index] as QueryObservation;
                    const ids = observation.rows.map(row => row.id);
                    const tenantIds = expectedIds.get(entry.organizationId);
                    if (!tenantIds) throw new Error(`missing expected ids for ${entry.organizationId}`);
                    expect(ids).toEqual(tenantIds);
                    expect(new Set(ids).size).toBe(SCALE_MUTATIONS_PER_TENANT);
                    expect(
                        observation.rows.every(
                            row =>
                                row.organizationId === entry.organizationId &&
                                row.body === body &&
                                row.viewerId === entry.subject
                        )
                    ).toBe(true);
                    const registration = settledStates[index]?.registrations.find(
                        row => row.clientId === entry.clientId && row.subId === 1 && row.currentHead
                    );
                    expect(registration).toMatchObject({
                        lifecycle: "active",
                        cdbState: "active",
                        initialSnapshotPending: false,
                        outboxCookie: null,
                        outboxTargetVersion: null,
                    });
                    expect(registration?.dirtyVersion).toBe(registration?.deliveredVersion);
                }
                expect((await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId })).invalidations).toEqual([]);

                const mutationCount = tenants.length * SCALE_MUTATIONS_PER_TENANT;
                const logicalRowDeliveries = clients.length * SCALE_MUTATIONS_PER_TENANT;
                console.info(
                    JSON.stringify({
                        type: "chardb-workerd-benchmark",
                        scenario: "sdk-two-tenant-mutation-fanout",
                        clients: clients.length,
                        mutations: mutationCount,
                        initialMs: Number(initialMs.toFixed(2)),
                        mutationMs: Number(mutationMs.toFixed(2)),
                        mutationsPerSecond: rate(mutationCount, mutationMs),
                        convergenceMs: Number(convergenceMs.toFixed(2)),
                        logicalRowDeliveries,
                        logicalRowDeliveriesPerSecond: rate(logicalRowDeliveries, convergenceMs),
                    })
                );
            } finally {
                await Promise.all(
                    clients.map(entry => cleanupSdkClient(entry.clientId, entry.client, entry.subscriptions))
                );
            }
        },
        SCALE_TEST_TIMEOUT_MS
    );

    test(
        "scaled SDK selective subscription refresh stays exact",
        async () => {
            if (!mf || !mutationRef || !queryRef) throw new Error("live fixture was not initialized");
            const writeRef = mutationRef;
            const readRef = queryRef;
            const clientId = "bench-select-0001";
            const initialClient = await createSdkClientWithTrackedClose(clientId, "workerd-user");
            let client = initialClient.client;
            let subscriptions: Array<{ unsubscribe: () => void }> = [];
            let observers = Array.from({ length: SCALE_SUBSCRIPTIONS }, () => createQueryObserver());
            const bodies = observers.map((_, index) => `sdk-scale-filter-${index.toString().padStart(3, "0")}`);
            let writeMs = 0;
            let refreshMs = 0;
            let recoveryMs = 0;
            const registrationStartedAt = performance.now();
            try {
                for (let index = 0; index < observers.length; index++) {
                    subscriptions.push(
                        client.subscribe<ScaleRow>(
                            readRef,
                            { organizationId: ORGANIZATION_A, body: bodies[index] as string },
                            (observers[index] as QueryObserver).listener
                        )
                    );
                }
                const subIds = observers.map((_, index) => index + 1);
                await drainUntilSettled(clientId, subIds);
                await Promise.all(
                    observers.map((observer, index) =>
                        observer.waitFor(
                            observation => observation.state === "live" && observation.rows.length === 0,
                            `selective subscription ${index} initial snapshot`
                        )
                    )
                );
                const registrationMs = performance.now() - registrationStartedAt;

                const gatewayBeforeReconstruction = await gatewayState(clientId);
                const cdbBeforeReconstruction = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
                const activeBeforeReconstruction = cdbBeforeReconstruction.subscriptions.filter(
                    row => row.clientId === clientId && row.state === "active"
                );
                expect(activeBeforeReconstruction).toHaveLength(SCALE_SUBSCRIPTIONS);
                expect(new Set(activeBeforeReconstruction.map(row => `${row.registrationId}:${row.subId}`)).size).toBe(
                    SCALE_SUBSCRIPTIONS
                );
                const priorRegistrationIds = new Set(activeBeforeReconstruction.map(row => row.registrationId));

                const reconstructionStartedAt = performance.now();
                await mf.unsafeEvictDurableObject(WORKER_NAME, "Cdb", { name: shardId });
                const cdbAfterReconstruction = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
                expect(cdbAfterReconstruction.instanceId).not.toBe(cdbBeforeReconstruction.instanceId);
                expect(
                    cdbAfterReconstruction.subscriptions.filter(
                        row => row.clientId === clientId && row.state === "active"
                    )
                ).toEqual(activeBeforeReconstruction);
                expect(cdbAfterReconstruction.invalidations).toEqual(cdbBeforeReconstruction.invalidations);
                expect(await gatewayState(clientId)).toEqual(gatewayBeforeReconstruction);

                await cleanupSdkClient(clientId, client, subscriptions);
                await initialClient.socketClosed;
                subscriptions = [];
                client = await createSdkClient(clientId, "workerd-user");
                observers = Array.from({ length: SCALE_SUBSCRIPTIONS }, () => createQueryObserver());
                for (let index = 0; index < observers.length; index++) {
                    subscriptions.push(
                        client.subscribe<ScaleRow>(
                            readRef,
                            { organizationId: ORGANIZATION_A, body: bodies[index] as string },
                            (observers[index] as QueryObserver).listener
                        )
                    );
                }
                await drainUntilSettled(clientId, subIds);
                await Promise.all(
                    observers.map((observer, index) =>
                        observer.waitFor(
                            observation => observation.state === "live" && observation.rows.length === 0,
                            `selective subscription ${index} recovery snapshot`
                        )
                    )
                );
                const gatewayAfterRecovery = await gatewayState(clientId);
                const recoveredHeads = gatewayAfterRecovery.registrations.filter(row => row.currentHead);
                const cdbAfterRecovery = await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId });
                const recoveredCdbRegistrations = cdbAfterRecovery.subscriptions.filter(
                    row => row.clientId === clientId && row.state === "active"
                );
                recoveryMs = performance.now() - reconstructionStartedAt;
                expect(recoveredHeads).toHaveLength(SCALE_SUBSCRIPTIONS);
                expect(recoveredHeads.every(row => row.lifecycle === "active" && row.cdbState === "active")).toBe(true);
                expect(recoveredCdbRegistrations).toHaveLength(SCALE_SUBSCRIPTIONS);
                expect(recoveredCdbRegistrations.every(row => !priorRegistrationIds.has(row.registrationId))).toBe(
                    true
                );
                expect(new Set(recoveredCdbRegistrations.map(row => `${row.registrationId}:${row.subId}`)).size).toBe(
                    SCALE_SUBSCRIPTIONS
                );
                expect(recoveredCdbRegistrations.map(row => `${row.registrationId}:${row.subId}`).sort()).toEqual(
                    recoveredHeads.map(row => `${row.registrationId}:${row.subId}`).sort()
                );
                expect(cdbAfterRecovery.invalidations).toEqual([]);

                for (let round = 0; round < SCALE_REFRESH_ROUNDS; round++) {
                    const jobs = bodies.map((body, index) => ({
                        body,
                        index,
                        id: `sdk-select-${index.toString().padStart(3, "0")}-${round.toString().padStart(3, "0")}`,
                    }));
                    const writesStartedAt = performance.now();
                    await inBatches(jobs, SCALE_MUTATION_BATCH, async job => {
                        const result = await client.mutate<{
                            readonly id: string;
                            readonly userId: string;
                            readonly tenantId: string | null;
                        }>(writeRef, {
                            id: job.id,
                            organizationId: ORGANIZATION_A,
                            body: job.body,
                            createdAt: 20_000 + round * SCALE_SUBSCRIPTIONS + job.index,
                        });
                        expect(result).toMatchObject({
                            id: job.id,
                            userId: "workerd-user",
                            tenantId: ORGANIZATION_A,
                        });
                    });
                    writeMs += performance.now() - writesStartedAt;

                    const refreshStartedAt = performance.now();
                    await drainUntilSettled(clientId, subIds);
                    await Promise.all(
                        observers.map((observer, index) =>
                            observer.waitFor(
                                observation => observation.state === "live" && observation.rows.length === round + 1,
                                `selective subscription ${index} round ${round}`
                            )
                        )
                    );
                    refreshMs += performance.now() - refreshStartedAt;

                    for (let index = 0; index < observers.length; index++) {
                        const observation = (observers[index] as QueryObserver).latest();
                        if (!observation) throw new Error(`missing selective observation ${index}`);
                        expect(observation.rows.map(row => row.id)).toEqual(
                            Array.from(
                                { length: round + 1 },
                                (_, priorRound) =>
                                    `sdk-select-${index.toString().padStart(3, "0")}-${priorRound
                                        .toString()
                                        .padStart(3, "0")}`
                            )
                        );
                        expect(
                            observation.rows.every(
                                row =>
                                    row.organizationId === ORGANIZATION_A &&
                                    row.body === bodies[index] &&
                                    row.viewerId === "workerd-user"
                            )
                        ).toBe(true);
                    }
                }
                expect((await fixtureFetch<CdbLiveState>("/live-cdb-state", { shardId })).invalidations).toEqual([]);

                const writes = SCALE_SUBSCRIPTIONS * SCALE_REFRESH_ROUNDS;
                const materializations = SCALE_SUBSCRIPTIONS * SCALE_REFRESH_ROUNDS;
                console.info(
                    JSON.stringify({
                        type: "chardb-workerd-benchmark",
                        scenario: "sdk-selective-subscription-refresh",
                        subscriptions: SCALE_SUBSCRIPTIONS,
                        rounds: SCALE_REFRESH_ROUNDS,
                        writes,
                        registrationMs: Number(registrationMs.toFixed(2)),
                        registrationsPerSecond: rate(SCALE_SUBSCRIPTIONS, registrationMs),
                        recoveryMs: Number(recoveryMs.toFixed(2)),
                        recoveredRegistrations: SCALE_SUBSCRIPTIONS,
                        recoveredRegistrationsPerSecond: rate(SCALE_SUBSCRIPTIONS, recoveryMs),
                        writeMs: Number(writeMs.toFixed(2)),
                        writesPerSecond: rate(writes, writeMs),
                        refreshMs: Number(refreshMs.toFixed(2)),
                        materializations,
                        materializationsPerSecond: rate(materializations, refreshMs),
                    })
                );
            } finally {
                await cleanupSdkClient(clientId, client, subscriptions);
            }
        },
        SCALE_TEST_TIMEOUT_MS
    );
});
