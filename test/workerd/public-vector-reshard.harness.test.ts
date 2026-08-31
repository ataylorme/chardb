import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { type ChardbRef, ClientId, MutId, SubId } from "../../src/types.ts";
import { type Down, PROTOCOL_V, type Up, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "vector-reshard-e2e.entry.ts");
const ISSUER = "https://vector-reshard-e2e.invalid";
const AUDIENCE = "vector-reshard-e2e";
const KID = "public-vector-reshard-key";
const ORGANIZATION = "public-vector-reshard-org";
const DESTINATION = "ShardDO_public_vector_destination";
const CLIENT_ID = "public-vector-reshard-client";
const PHASE = {
    TAIL_CAPTURE_ENABLED: 1,
    TAIL_CAUGHT_UP: 3,
    DUAL_WRITE_OPEN: 4,
    SOURCE_DRAINED: 6,
} as const;

interface SetupResult {
    readonly userId: string;
    readonly vshard: number;
    readonly route: { readonly shardId: string };
    readonly putRef: ChardbRef;
    readonly replaceRef: ChardbRef;
    readonly deleteRef: ChardbRef;
    readonly searchRef: ChardbRef;
}

interface FixtureState {
    readonly source: {
        readonly rows: readonly Record<string, unknown>[];
        readonly heads: readonly {
            readonly row_pk: string;
            readonly version: number;
            readonly delivered_version: number;
            readonly state: string;
        }[];
        readonly outbox: readonly unknown[];
        readonly attempts: readonly unknown[];
        readonly vectorTail: readonly unknown[];
        readonly split: null | { readonly drained: number };
    };
    readonly destination: {
        readonly rows: readonly Record<string, unknown>[];
        readonly heads: readonly {
            readonly row_pk: string;
            readonly version: number;
            readonly delivered_version: number;
            readonly state: string;
        }[];
        readonly outbox: readonly unknown[];
        readonly attempts: readonly unknown[];
        readonly split: null | { readonly destination_serving: number };
        readonly vectorSession: null | {
            readonly terminal: number;
            readonly parity_complete: number;
            readonly outcome: string;
            readonly cleaned: number;
        };
    };
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
let setup: SetupResult | undefined;
let signToken: (() => Promise<string>) | undefined;

async function buildWorker(): Promise<string> {
    const bundle = path.join(temporaryPath, "public-vector-reshard.worker.mjs");
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
    const source = (await Bun.file(bundle).text())
        .replace(
            "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
            'await Promise.reject(new Error("file migrations are unavailable in workerd"))'
        )
        .replace(
            "await import(nodeSqlite)",
            'await Promise.reject(new Error("node:sqlite is unavailable in workerd"))'
        );
    if (source.includes("import(")) throw new Error("public vector reshard fixture contains a dynamic import");
    return source;
}

async function startRuntime(): Promise<void> {
    const instance = new Miniflare({
        name: "public-vector-reshard-proof",
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_GATEWAY: { className: "Gateway", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
            VECTOR_INDEX: { className: "VectorIndexProbe", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
    try {
        workerdUrl = await instance.ready;
        mf = instance;
    } catch (error) {
        await disposeMiniflareBounded(instance, { label: "failed public vector reshard startup" });
        throw error;
    }
}

async function call<TResult>(operation: string, body: Record<string, unknown> = {}): Promise<TResult> {
    if (!mf) throw new Error("public vector reshard Miniflare is unavailable");
    const response = await mf.dispatchFetch(`http://example.com/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const result = (await response.json()) as TResult;
    if (!response.ok) throw new Error(`${operation} returned ${response.status}: ${JSON.stringify(result)}`);
    return result;
}

async function driveTo(migId: string, target: number): Promise<void> {
    for (let turn = 0; turn < 512; turn++) {
        const current = await call<{ readonly phase: number | null }>("phase", { migId });
        if (current.phase === target) return;
        if (current.phase === null || current.phase > target) {
            throw new Error(`migration reached ${String(current.phase)} before ${target}`);
        }
        await call("run", { migId });
    }
    throw new Error(`migration did not reach ${target}`);
}

function inbox(socket: WebSocket) {
    const current = inboxes.get(socket);
    if (current) return current;
    const created = { queued: [] as Down[], waiters: [] as DownWaiter[] };
    inboxes.set(socket, created);
    socket.addEventListener("message", event => {
        const message = decodeWire(String(event.data)) as Down;
        const waiter = created.waiters.shift();
        if (!waiter) created.queued.push(message);
        else {
            clearTimeout(waiter.timeout);
            waiter.resolve(message);
        }
    });
    socket.addEventListener("close", event => {
        for (const waiter of created.waiters.splice(0)) {
            clearTimeout(waiter.timeout);
            waiter.reject(new Error(`Gateway closed (${event.code}: ${event.reason})`));
        }
    });
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

function nextSnapshot(socket: WebSocket, subId: number) {
    return nextMatching(
        socket,
        (message): message is Extract<Down, { t: "snapshot" }> => message.t === "snapshot" && message.subId === subId,
        `snapshot ${subId}`,
        10_000
    );
}

async function openSocket(): Promise<OpenedSocket> {
    if (!workerdUrl || !signToken) throw new Error("public vector reshard runtime is unavailable");
    const url = new URL("/ws", workerdUrl);
    url.searchParams.set("clientId", CLIENT_ID);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out opening Gateway")), 3_000);
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
                reject(new Error("Gateway socket failed to open"));
            },
            { once: true }
        );
    });
    const welcome = nextDown(socket);
    socket.send(
        encodeWire({
            t: "hello",
            protocolV: PROTOCOL_V,
            clientId: ClientId(CLIENT_ID),
            jwt: await signToken(),
        })
    );
    expect(await welcome).toMatchObject({ t: "welcome" });
    return { socket, closed };
}

async function waitForRegistration(subId: number): Promise<void> {
    let last: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 300; attempt++) {
        last = await call<Record<string, unknown> | null>("gatewayRegistration", { clientId: CLIENT_ID, subId });
        if (typeof last?.retry_error === "string") {
            throw new Error(`registration ${subId} failed: ${last.retry_error}`);
        }
        if (last?.lifecycle === "active" && last.cdb_state === "active" && last.current_head === 1) return;
        await Bun.sleep(10);
    }
    throw new Error(`registration ${subId} did not activate: ${JSON.stringify(last)}`);
}

async function drainGateway(): Promise<void> {
    await call("runGatewayAlarm", { clientId: CLIENT_ID });
}

async function subscribe(socket: WebSocket, subId: number) {
    if (!setup) throw new Error("public vector refs are unavailable");
    socket.send(
        encodeWire({
            t: "sub",
            subId: SubId(subId),
            ref: setup.searchRef,
            args: { organizationId: ORGANIZATION, values: [1, 0, 0], limit: 10 },
        })
    );
    await waitForRegistration(subId);
    await drainGateway();
    return nextSnapshot(socket, subId);
}

async function mutate(socket: WebSocket, mutId: string, ref: ChardbRef, args: Record<string, unknown>) {
    const result = nextMatching(
        socket,
        (message): message is Extract<Down, { t: "poke" }> =>
            message.t === "poke" && message.mutResults?.some(item => item.mutId === mutId) === true,
        `mutation ${mutId}`,
        10_000
    );
    socket.send(encodeWire({ t: "mut", mutId: MutId(mutId), ref, args } as Up));
    return result;
}

function acknowledge(socket: WebSocket, snapshot: Extract<Down, { t: "snapshot" }>): void {
    socket.send(encodeWire({ t: "ack", cookie: snapshot.cookie }));
}

async function settle(shardId: string): Promise<void> {
    await call("forceVectorDue", { shardId, organizationId: ORGANIZATION });
    await call("runRealAlarm", { shardId });
    await call("forceVectorDue", { shardId, organizationId: ORGANIZATION });
    await call("runRealAlarm", { shardId });
    await drainGateway();
}

async function fixtureState(migId: string): Promise<FixtureState> {
    return call("state", { organizationId: ORGANIZATION, destination: DESTINATION, migId });
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-public-vector-reshard-"));
    workerSource = await buildWorker();
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
    signToken = async () => {
        if (!setup) throw new Error("public vector authority is not initialized");
        const now = Math.floor(Date.now() / 1_000);
        return new SignJWT({ proof: "public-vector-reshard" })
            .setProtectedHeader({ alg: "ES256", kid: KID })
            .setSubject(setup.userId)
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);
    };
    await startRuntime();
    setup = await call<SetupResult>("setupPublicVector", { organizationId: ORGANIZATION, kid: KID, jwk: publicJwk });
});

afterAll(async () => {
    const disposed = await disposeMiniflareBounded(mf, { label: "public vector reshard teardown", timeoutMs: 5_000 });
    mf = undefined;
    if (disposed.status !== "disposed" && disposed.status !== "absent") {
        throw new Error(`public vector reshard teardown failed: ${disposed.status}`);
    }
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("public vector API composes with live resharding in native workerd", () => {
    test("keeps public writes, search, and an active subscription exact across cutover and drain", async () => {
        if (!setup) throw new Error("public vector fixture is not initialized");
        expect(setup.route).toMatchObject({ shardId: "ShardDO_0" });
        const migId = "public-vector-live-move";
        const opened = await openSocket();

        const initial = await subscribe(opened.socket, 1);
        expect(initial.rows).toEqual([]);
        acknowledge(opened.socket, initial);

        const put = await mutate(opened.socket, "put-before-move", setup.putRef, {
            organizationId: ORGANIZATION,
            id: "moving-message",
            body: "on-source",
            values: [1, 0, 0],
        });
        expect(put).toMatchObject({ mutResults: [{ mutId: "put-before-move", ok: true }] });
        const sourcePending = nextSnapshot(opened.socket, 1);
        await drainGateway();
        const pending = await sourcePending;
        expect(pending.rows).toEqual([]);
        acknowledge(opened.socket, pending);

        const sourceReady = nextSnapshot(opened.socket, 1);
        await settle("ShardDO_0");
        const ready = await sourceReady;
        expect(ready.rows).toEqual([{ rowPk: "moving-message", score: 1 }]);
        acknowledge(opened.socket, ready);

        await call("startPublicSplit", { migId, destination: DESTINATION, organizationId: ORGANIZATION });
        await driveTo(migId, PHASE.TAIL_CAPTURE_ENABLED);

        const replace = await mutate(opened.socket, "replace-during-move", setup.replaceRef, {
            organizationId: ORGANIZATION,
            id: "moving-message",
            body: "captured-in-tail",
            values: [0, 1, 0],
        });
        expect(replace).toMatchObject({ mutResults: [{ mutId: "replace-during-move", ok: true }] });
        let state = await fixtureState(migId);
        expect(state.source.vectorTail.length).toBeGreaterThan(0);
        expect(state.source.heads).toEqual([
            expect.objectContaining({ row_pk: "moving-message", version: 2, delivered_version: 1 }),
        ]);

        const replacementPending = nextSnapshot(opened.socket, 1);
        await drainGateway();
        const replacementHidden = await replacementPending;
        expect(replacementHidden.rows).toEqual([]);
        acknowledge(opened.socket, replacementHidden);
        const replacementReady = nextSnapshot(opened.socket, 1);
        await settle("ShardDO_0");
        const replacement = await replacementReady;
        expect(replacement.rows).toEqual([{ rowPk: "moving-message", score: 0 }]);
        acknowledge(opened.socket, replacement);

        await driveTo(migId, PHASE.TAIL_CAUGHT_UP);
        await driveTo(migId, PHASE.DUAL_WRITE_OPEN);
        expect(await call("route", { vshard: setup.vshard })).toMatchObject({ shardId: DESTINATION });

        const refetch = nextMatching(
            opened.socket,
            (message): message is Extract<Down, { t: "mustRefetch" }> =>
                message.t === "mustRefetch" && message.subIds.includes(SubId(1)),
            "source routing-fence refetch",
            10_000
        );
        await call("runRealAlarm", { shardId: "ShardDO_0" });
        await drainGateway();
        expect(await refetch).toEqual({ t: "mustRefetch", subIds: [SubId(1)], reason: "shardsChanged" });

        const destinationSnapshot = await subscribe(opened.socket, 1);
        expect(destinationSnapshot.rows).toEqual([{ rowPk: "moving-message", score: 0 }]);
        acknowledge(opened.socket, destinationSnapshot);

        const stale = await call<{ readonly ok: boolean; readonly error?: { readonly code: string } }>("mutate", {
            shardId: "ShardDO_0",
            organizationId: ORGANIZATION,
            rowId: "moving-message",
            mutId: "stale-source-write",
            body: "must-not-commit",
            values: [1, 1, 1],
        });
        expect(stale).toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });

        await driveTo(migId, PHASE.SOURCE_DRAINED);
        state = await fixtureState(migId);
        expect(state.source.rows).toEqual([]);
        expect(state.source.heads).toEqual([]);
        expect(state.source.outbox).toEqual([]);
        expect(state.source.attempts).toEqual([]);
        expect(state.source.split).toMatchObject({ drained: 1 });
        expect(state.destination.rows).toEqual([
            expect.objectContaining({ id: "moving-message", body: "captured-in-tail" }),
        ]);
        expect(state.destination.heads).toEqual([
            expect.objectContaining({ row_pk: "moving-message", version: 2, delivered_version: 2, state: "ready" }),
        ]);
        expect(state.destination.split).toMatchObject({ destination_serving: 1 });
        expect(state.destination.vectorSession).toMatchObject({
            terminal: 1,
            parity_complete: 1,
            outcome: "cleaned",
            cleaned: 1,
        });

        const deleted = await mutate(opened.socket, "delete-after-cutover", setup.deleteRef, {
            organizationId: ORGANIZATION,
            id: "moving-message",
        });
        expect(deleted).toMatchObject({ mutResults: [{ mutId: "delete-after-cutover", ok: true }] });
        const deleteSnapshot = nextSnapshot(opened.socket, 1);
        await drainGateway();
        const hiddenDelete = await deleteSnapshot;
        expect(hiddenDelete.rows).toEqual([]);
        acknowledge(opened.socket, hiddenDelete);
        await settle(DESTINATION);

        state = await fixtureState(migId);
        expect(state.destination.rows).toEqual([]);
        expect(state.destination.heads).toEqual([]);
        const probe = await call<{ readonly documents: readonly unknown[] }>("vectorCalls");
        expect(probe.documents).toEqual([]);

        opened.socket.close();
        await opened.closed;
    }, 45_000);
});
