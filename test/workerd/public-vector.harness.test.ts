import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { gatewayBucketName } from "../../src/server/gateway-bucket.ts";
import { type ChardbRef, ClientId, MutId, SubId } from "../../src/types.ts";
import { type Down, PROTOCOL_V, type Up, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "public-vector.entry.ts");
const WORKER_NAME = "public-vector-workerd-proof";
const KID = "public-vector-proof-key";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const USER_A = "workerd-user";
const USER_B = "workerd-user-b";
const ORGANIZATION_A = "workerd-org";
const ORGANIZATION_B = "workerd-org-b";

interface SeedResult {
    readonly shardA: string;
    readonly shardB: string;
    readonly putRef: ChardbRef;
    readonly replaceRef: ChardbRef;
    readonly deleteRef: ChardbRef;
    readonly searchRef: ChardbRef;
}

interface OpenedSocket {
    readonly socket: WebSocket;
    readonly closed: Promise<CloseEvent>;
}

interface DownWaiter {
    readonly resolve: (message: Down) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
}

const inboxes = new WeakMap<WebSocket, { readonly queued: Down[]; readonly waiters: DownWaiter[] }>();
let temporaryPath = "";
let workerSource = "";
let mf: Miniflare | undefined;
let workerdUrl: URL | undefined;
let seed: SeedResult | undefined;
let signToken: ((subject: string) => Promise<string>) | undefined;

function trace(label: string): void {
    if (process.env.CDB_PUBLIC_VECTOR_TRACE === "1") process.stderr.write(`[public-vector] ${label}\n`);
}

async function buildWorker(): Promise<string> {
    const bundle = path.join(temporaryPath, "public-vector.worker.mjs");
    const child = Bun.spawn(
        [
            "bun",
            "build",
            ENTRY,
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            bundle,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
    let source = await Bun.file(bundle).text();
    source = source.replace(
        "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
        'await Promise.reject(new Error("Node file migrations are unavailable in workerd"))'
    );
    source = source.replace(
        "await import(nodeSqlite)",
        'await Promise.reject(new Error("Node sqlite is unavailable in workerd"))'
    );
    if (/\bimport\s*\([^"'`]/.test(source)) {
        throw new Error("public vector fixture bundle contains an unsupported dynamic import");
    }
    return source;
}

function createRuntime(): Miniflare {
    return new Miniflare({
        name: WORKER_NAME,
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_GATEWAY: { className: "Gateway", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
            CDB_PROOF_VECTORS: { className: "VectorIndexProbe", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
}

async function startRuntime(): Promise<void> {
    const instance = createRuntime();
    try {
        workerdUrl = await instance.ready;
        mf = instance;
    } catch (error) {
        await disposeMiniflareBounded(instance, { label: "failed public vector startup" });
        throw error;
    }
}

async function reconstructActors(clientId: string, shardId: string): Promise<void> {
    if (!mf) throw new Error("public vector runtime is unavailable");
    await mf.unsafeEvictDurableObject(WORKER_NAME, "Gateway", { name: gatewayBucketName(clientId) });
    await mf.unsafeEvictDurableObject(WORKER_NAME, "Cdb", { name: shardId });
    await mf.unsafeEvictDurableObject(WORKER_NAME, "Catalog", { name: "global" });
    await mf.unsafeEvictDurableObject(WORKER_NAME, "VectorIndexProbe", { name: "public-vector-index" });
}

function inbox(socket: WebSocket): { readonly queued: Down[]; readonly waiters: DownWaiter[] } {
    const current = inboxes.get(socket);
    if (current) return current;
    const created = { queued: [] as Down[], waiters: [] as DownWaiter[] };
    inboxes.set(socket, created);
    socket.addEventListener("message", event => {
        const message = decodeWire(String(event.data)) as Down;
        const waiter = created.waiters.shift();
        if (!waiter) {
            created.queued.push(message);
            return;
        }
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
    });
    socket.addEventListener(
        "close",
        event => {
            for (const waiter of created.waiters.splice(0)) {
                clearTimeout(waiter.timeout);
                waiter.reject(new Error(`Gateway closed before replying (${event.code}: ${event.reason})`));
            }
        },
        { once: true }
    );
    return created;
}

function nextDown(socket: WebSocket, timeoutMs = 5_000): Promise<Down> {
    const messages = inbox(socket);
    const queued = messages.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
        const waiter: DownWaiter = {
            resolve,
            reject,
            timeout: setTimeout(() => {
                const index = messages.waiters.indexOf(waiter);
                if (index >= 0) messages.waiters.splice(index, 1);
                reject(new Error("timed out waiting for Gateway message"));
            }, timeoutMs),
        };
        messages.waiters.push(waiter);
    });
}

async function nextMatching<T extends Down>(
    socket: WebSocket,
    predicate: (message: Down) => message is T,
    label: string,
    timeoutMs = 5_000
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const skipped: Down[] = [];
    try {
        while (Date.now() < deadline) {
            const message = await nextDown(socket, Math.max(1, deadline - Date.now()));
            if (predicate(message)) return message;
            skipped.push(message);
        }
        throw new Error(`timed out waiting for ${label}`);
    } finally {
        if (skipped.length > 0) inbox(socket).queued.unshift(...skipped);
    }
}

function nextSnapshot(socket: WebSocket, subId: number): Promise<Extract<Down, { t: "snapshot" }>> {
    return nextMatching(
        socket,
        (message): message is Extract<Down, { t: "snapshot" }> => message.t === "snapshot" && message.subId === subId,
        `snapshot ${subId}`
    );
}

function nextMutation(socket: WebSocket, mutId: string): Promise<Extract<Down, { t: "poke" }>> {
    return nextMatching(
        socket,
        (message): message is Extract<Down, { t: "poke" }> =>
            message.t === "poke" && message.mutResults?.some(result => result.mutId === mutId) === true,
        `mutation ${mutId}`
    );
}

async function openSocket(clientId: string, subject: string): Promise<OpenedSocket> {
    if (!workerdUrl || !signToken) throw new Error("public vector runtime is unavailable");
    const url = new URL("/ws", workerdUrl);
    url.searchParams.set("clientId", clientId);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out opening public vector socket")), 3_000);
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
                reject(new Error("public vector socket failed to open"));
            },
            { once: true }
        );
    });
    const welcome = nextDown(socket);
    socket.send(
        encodeWire({
            t: "hello",
            protocolV: PROTOCOL_V,
            clientId: ClientId(clientId),
            jwt: await signToken(subject),
        })
    );
    expect(await welcome).toMatchObject({ t: "welcome" });
    return { socket, closed };
}

async function fixtureFetch<T>(pathname: string, search: Record<string, string> = {}): Promise<T> {
    if (!mf) throw new Error("public vector Miniflare is unavailable");
    const url = new URL(pathname, "http://example.com");
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
    const response = await mf.dispatchFetch(url);
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

async function gatewayDrain(clientId: string): Promise<void> {
    await fixtureFetch("/gateway-drain", { clientId });
}

async function waitForRegistration(clientId: string, subId: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    let lastState: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
        const result = await fixtureFetch<{ readonly state: Record<string, unknown> | null }>("/gateway-registration", {
            clientId,
            subId: String(subId),
        });
        lastState = result.state;
        if (typeof result.state?.retry_error === "string") {
            throw new Error(`public vector registration ${subId} failed: ${result.state.retry_error}`);
        }
        if (
            result.state?.lifecycle === "active" &&
            result.state.cdb_state === "active" &&
            result.state.current_head === 1
        ) {
            return;
        }
        await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for public vector registration ${subId}: ${JSON.stringify(lastState)}`);
}

async function cdbDrain(shardId: string): Promise<void> {
    await fixtureFetch("/cdb-drain", { shardId });
}

async function forceCdbDue(shardId: string): Promise<void> {
    await fixtureFetch("/cdb-force-due", { shardId });
}

function acknowledge(socket: WebSocket, snapshot: Extract<Down, { t: "snapshot" }>): void {
    socket.send(encodeWire({ t: "ack", cookie: snapshot.cookie }));
}

async function subscribe(
    opened: OpenedSocket,
    clientId: string,
    subId: number,
    organizationId: string,
    values: number[]
): Promise<Extract<Down, { t: "snapshot" }>> {
    if (!seed) throw new Error("public vector refs are unavailable");
    const response = nextDown(opened.socket, 10_000);
    opened.socket.send(
        encodeWire({
            t: "sub",
            subId: SubId(subId),
            ref: seed.searchRef,
            args: { organizationId, values, limit: 10 },
        })
    );
    await waitForRegistration(clientId, subId);
    await gatewayDrain(clientId);
    let message: Down;
    try {
        message = await response;
    } catch (error) {
        const registration = await fixtureFetch<{ readonly state: Record<string, unknown> | null }>(
            "/gateway-registration",
            { clientId, subId: String(subId) }
        );
        throw new Error(
            `public vector subscription ${subId} produced no snapshot: ${JSON.stringify(registration.state)}`,
            { cause: error }
        );
    }
    if (message.t !== "snapshot" || message.subId !== subId) {
        throw new Error(`public vector subscription ${subId} failed: ${JSON.stringify(message)}`);
    }
    return message;
}

async function mutate(
    opened: OpenedSocket,
    mutId: string,
    ref: ChardbRef,
    args: Record<string, unknown>
): Promise<Extract<Down, { t: "poke" }>> {
    const response = nextMutation(opened.socket, mutId);
    opened.socket.send(encodeWire({ t: "mut", mutId: MutId(mutId), ref, args } as Up));
    return response;
}

async function settleAcceptedVector(shardId: string, clientId: string): Promise<void> {
    let processedTotal = 0;
    for (let turn = 0; turn < 4; turn++) {
        const processed = await fixtureFetch<{ readonly processed: number }>("/vector-process");
        processedTotal += processed.processed;
        await forceCdbDue(shardId);
        await cdbDrain(shardId);
        await cdbDrain(shardId);
        const state = await fixtureFetch<{ readonly pending: readonly unknown[] }>("/vector-state");
        if (state.pending.length === 0) {
            await gatewayDrain(clientId);
            expect(processedTotal).toBeGreaterThan(0);
            return;
        }
    }
    throw new Error("public vector settlement did not drain the fake index within four turns");
}

beforeAll(async () => {
    trace("beforeAll:start");
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-public-vector-"));
    workerSource = await buildWorker();
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
    signToken = async subject => {
        const now = Math.floor(Date.now() / 1_000);
        return new SignJWT({ proof: "public-vector-workerd" })
            .setProtectedHeader({ alg: "ES256", kid: KID })
            .setSubject(subject)
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);
    };
    await startRuntime();
    if (!mf) throw new Error("public vector Miniflare did not start");
    const response = await mf.dispatchFetch("http://example.com/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kid: KID, jwk: publicJwk }),
    });
    if (!response.ok) throw new Error(`public vector seed failed: ${response.status} ${await response.text()}`);
    seed = (await response.json()) as SeedResult;
    trace("beforeAll:seeded");
});

afterAll(async () => {
    const disposed = await disposeMiniflareBounded(mf, { label: "public vector final teardown", timeoutMs: 5_000 });
    mf = undefined;
    if (disposed.status !== "disposed" && disposed.status !== "absent") {
        throw new Error(`public vector teardown failed: ${disposed.status}`);
    }
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("public vector DX in native workerd", () => {
    test("writes, searches, live refetches, reconstructs actors, isolates organizations, and rejects revoked membership", async () => {
        if (!seed) throw new Error("public vector fixture is not initialized");
        expect(seed.shardA).toBe(seed.shardB);
        const shardId = seed.shardA;
        const clientA = "public-vector-a";
        let openedA = await openSocket(clientA, USER_A);
        trace("socket-a:open");

        const initial = await subscribe(openedA, clientA, 1, ORGANIZATION_A, [1, 0, 0]);
        trace("sub-1:initial");
        expect(initial.rows).toEqual([]);
        acknowledge(openedA.socket, initial);

        const put = await mutate(openedA, "vector-put-a", seed.putRef, {
            organizationId: ORGANIZATION_A,
            id: "message-a",
            body: "alpha",
            values: [1, 0, 0],
        });
        expect(put).toMatchObject({ t: "poke", mutResults: [{ mutId: "vector-put-a", ok: true }] });

        const pending = nextSnapshot(openedA.socket, 1);
        await gatewayDrain(clientA);
        const pendingSnapshot = await pending;
        expect(pendingSnapshot.rows).toEqual([]);
        acknowledge(openedA.socket, pendingSnapshot);
        const beforeProcessing = await fixtureFetch<{
            readonly documents: readonly unknown[];
            readonly pending: readonly unknown[];
        }>("/vector-state");
        expect(beforeProcessing.documents).toEqual([]);
        expect(beforeProcessing.pending).toEqual([]);

        await cdbDrain(shardId);
        const acceptedPending = await fixtureFetch<{
            readonly documents: readonly unknown[];
            readonly pending: readonly unknown[];
        }>("/vector-state");
        expect(acceptedPending.documents).toEqual([]);
        expect(acceptedPending.pending).toHaveLength(1);
        const ready = nextSnapshot(openedA.socket, 1);
        await settleAcceptedVector(shardId, clientA);
        const readySnapshot = await ready;
        trace("vector-a:ready");
        expect(readySnapshot.rows).toEqual([{ rowPk: "message-a", score: 1 }]);
        expect(Object.keys((readySnapshot.rows as Array<Record<string, unknown>>)[0] ?? {}).sort()).toEqual([
            "rowPk",
            "score",
        ]);
        acknowledge(openedA.socket, readySnapshot);
        const cdbReady = await fixtureFetch<{
            readonly heads: readonly {
                readonly version: number;
                readonly delivered_version: number;
                readonly state: string;
            }[];
            readonly liveVectorResources: number;
        }>("/cdb-state", { shardId });
        expect(cdbReady.heads).toEqual([expect.objectContaining({ version: 1, delivered_version: 1, state: "ready" })]);
        expect(cdbReady.liveVectorResources).toBe(1);

        openedA.socket.close();
        await openedA.closed;
        trace("reconstruction:begin");
        await reconstructActors(clientA, shardId);
        trace("reconstruction:complete");
        openedA = await openSocket(clientA, USER_A);
        trace("socket-a:reopen");
        const afterRestart = await subscribe(openedA, clientA, 2, ORGANIZATION_A, [1, 0, 0]);
        expect(afterRestart.rows).toEqual([{ rowPk: "message-a", score: 1 }]);
        acknowledge(openedA.socket, afterRestart);

        const replaced = await mutate(openedA, "vector-replace-a", seed.replaceRef, {
            organizationId: ORGANIZATION_A,
            id: "message-a",
            body: "beta",
            values: [0, 1, 0],
        });
        expect(replaced).toMatchObject({ t: "poke", mutResults: [{ mutId: "vector-replace-a", ok: true }] });
        const hiddenStale = nextSnapshot(openedA.socket, 2);
        await gatewayDrain(clientA);
        const hiddenStaleSnapshot = await hiddenStale;
        expect(hiddenStaleSnapshot.rows).toEqual([]);
        acknowledge(openedA.socket, hiddenStaleSnapshot);

        await cdbDrain(shardId);
        const acceptedReplacement = await fixtureFetch<{
            readonly documents: readonly unknown[];
            readonly pending: readonly unknown[];
        }>("/vector-state");
        expect(acceptedReplacement.documents).toHaveLength(1);
        expect(acceptedReplacement.pending).toHaveLength(1);
        const replacementReady = nextSnapshot(openedA.socket, 2);
        await settleAcceptedVector(shardId, clientA);
        const replacementReadySnapshot = await replacementReady;
        trace("vector-a:replaced");
        expect(replacementReadySnapshot.rows).toEqual([{ rowPk: "message-a", score: 0 }]);
        acknowledge(openedA.socket, replacementReadySnapshot);

        const clientB = "public-vector-b";
        const openedB = await openSocket(clientB, USER_B);
        const isolated = await subscribe(openedB, clientB, 3, ORGANIZATION_B, [0, 1, 0]);
        trace("org-b:isolated");
        expect(isolated.rows).toEqual([]);
        acknowledge(openedB.socket, isolated);

        const forbidden = nextDown(openedA.socket);
        openedA.socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(4),
                ref: seed.searchRef,
                args: { organizationId: ORGANIZATION_B, values: [0, 1, 0], limit: 10 },
            })
        );
        expect(await forbidden).toMatchObject({ t: "error", subId: 4, code: "CDB_FORBIDDEN", retryable: false });

        const deleted = await mutate(openedA, "vector-delete-a", seed.deleteRef, {
            organizationId: ORGANIZATION_A,
            id: "message-a",
        });
        expect(deleted).toMatchObject({ t: "poke", mutResults: [{ mutId: "vector-delete-a", ok: true }] });
        const deletedSnapshot = nextSnapshot(openedA.socket, 2);
        await gatewayDrain(clientA);
        const hiddenDeleted = await deletedSnapshot;
        expect(hiddenDeleted.rows).toEqual([]);
        acknowledge(openedA.socket, hiddenDeleted);
        await cdbDrain(shardId);
        const acceptedDelete = await fixtureFetch<{
            readonly documents: readonly unknown[];
            readonly pending: readonly unknown[];
        }>("/vector-state");
        expect(acceptedDelete.documents).toHaveLength(1);
        expect(acceptedDelete.pending).toHaveLength(1);

        const activeRevoked = nextMatching(
            openedA.socket,
            (message): message is Extract<Down, { t: "error" }> => message.t === "error" && message.subId === 2,
            "active vector subscription revocation"
        );
        if (!mf) throw new Error("public vector Miniflare stopped unexpectedly");
        const revoke = await mf.dispatchFetch("http://example.com/membership-delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId: ORGANIZATION_A, userId: USER_A }),
        });
        expect(revoke.ok).toBe(true);
        await settleAcceptedVector(shardId, clientA);
        trace("vector-a:deleted");
        expect(await activeRevoked).toMatchObject({ t: "error", subId: 2, code: "CDB_FORBIDDEN", retryable: false });
        const remoteAfterDelete = await fixtureFetch<{ readonly documents: readonly unknown[] }>("/vector-state");
        expect(remoteAfterDelete.documents).toEqual([]);

        const revoked = nextMatching(
            openedA.socket,
            (message): message is Extract<Down, { t: "error" }> => message.t === "error" && message.subId === 5,
            "revoked vector subscription"
        );
        openedA.socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(5),
                ref: seed.searchRef,
                args: { organizationId: ORGANIZATION_A, values: [1, 0, 0], limit: 10 },
            })
        );
        expect(await revoked).toMatchObject({ t: "error", subId: 5, code: "CDB_FORBIDDEN", retryable: false });
        trace("membership:revoked");

        openedA.socket.close();
        openedB.socket.close();
        await Promise.all([openedA.closed, openedB.closed]);
    }, 45_000);
});
