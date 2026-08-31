import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { ChardbRef, ClientId, SubId } from "../../src/types.ts";
import { type Down, PROTOCOL_V, type Up, decodeWire, encodeWire } from "../../src/wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "planned-query.entry.ts");
const BUNDLE = path.join(process.env.TMPDIR ?? "/tmp", `chardb-planned-query-${process.pid}.bundle.mjs`);
const WORKER_NAME = "planned-query-workerd";
const KID = "planned-query-key";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const USER_ID = "planned-query-user";
const OTHER_USER_ID = "planned-query-user-other";
const ORGANIZATION_ID = "planned-query-org";
const OTHER_ORGANIZATION_ID = "planned-query-org-other";
const QUERY_REF = "test/workerd/planned-query.entry.ts#listPlannedQueryRows";

function boundedScale(name: string, fallback: number, minimum: number, maximum: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    return parsed;
}

const BENCH_CHANNELS = boundedScale("CDB_PLANNED_QUERY_BENCH_CHANNELS", 8, 1, 64);
const BENCH_ROWS_PER_CHANNEL = boundedScale("CDB_PLANNED_QUERY_BENCH_ROWS_PER_CHANNEL", 100, 1, 500);
const BENCH_REGISTRATIONS = boundedScale("CDB_PLANNED_QUERY_BENCH_REGISTRATIONS", 32, 1, 128);
const BENCH_PAGE_LIMIT = boundedScale("CDB_PLANNED_QUERY_BENCH_PAGE_LIMIT", 25, 1, 100);
const BENCH_BINDING_QUERIES = boundedScale("CDB_PLANNED_QUERY_BENCH_BINDING_QUERIES", 32, 1, 512);
const BENCH_BINDING_CONCURRENCY = boundedScale("CDB_PLANNED_QUERY_BENCH_BINDING_CONCURRENCY", 8, 1, 32);
const BENCH_TEST_TIMEOUT_MS = boundedScale("CDB_PLANNED_QUERY_BENCH_TEST_TIMEOUT_MS", 30_000, 5_000, 300_000);

let mf: Miniflare | undefined;
let workerdUrl: URL | undefined;
let queryRef: ChardbRef | undefined;
let shardId = "";
let signToken: ((subject?: string) => Promise<string>) | undefined;

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

async function openSocket(clientId: string, subject = USER_ID): Promise<WebSocket> {
    if (!workerdUrl || !signToken) throw new Error("planned query fixture is not initialized");
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
    socket.send(
        encodeWire({
            t: "hello",
            protocolV: PROTOCOL_V,
            clientId: ClientId(clientId),
            jwt: await signToken(subject),
        })
    );
    expect(await welcome).toMatchObject({ t: "welcome" });
    return socket;
}

async function sendAndReceive(socket: WebSocket, message: Up): Promise<Down> {
    const response = nextDown(socket);
    socket.send(encodeWire(message));
    return response;
}

beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
    signToken = async (subject = USER_ID) => {
        const now = Math.floor(Date.now() / 1_000);
        return new SignJWT({ probe: "planned-query-workerd" })
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
        compatibilityDate: "2026-05-10",
        compatibilityFlags: ["nodejs_compat"],
    });
    workerdUrl = await mf.ready;
    const seeded = await mf.dispatchFetch("http://example.com/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kid: KID, jwk: publicJwk }),
    });
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.status} ${await seeded.text()}`);
    const body = (await seeded.json()) as { readonly queryRef: ChardbRef; readonly shardId: string };
    queryRef = body.queryRef;
    shardId = body.shardId;
    expect(queryRef).toBe(ChardbRef(QUERY_REF));
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "planned query fixture final teardown" });
    mf = undefined;
});

describe("planned registered queries in real workerd", () => {
    test("the exported DB binding executes typed plans and rejects cross-partition placement", async () => {
        if (!mf || !signToken) throw new Error("planned query fixture is not initialized");
        const jwt = await signToken();
        const rowsResponse = await mf.dispatchFetch("http://example.com/binding-select", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jwt, organizationId: ORGANIZATION_ID, channelId: "general", limit: 2 }),
        });
        expect(rowsResponse.status).toBe(200);
        expect(await rowsResponse.json()).toEqual([
            { id: "row-01", organizationId: ORGANIZATION_ID, channelId: "general", createdAt: 1 },
            { id: "row-02", organizationId: ORGANIZATION_ID, channelId: "general", createdAt: 2 },
        ]);

        const getResponse = await mf.dispatchFetch("http://example.com/binding-select", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jwt, organizationId: ORGANIZATION_ID, channelId: "general", id: "row-02" }),
        });
        expect(getResponse.status).toBe(200);
        expect(await getResponse.json()).toEqual({
            id: "row-02",
            organizationId: ORGANIZATION_ID,
            channelId: "general",
            createdAt: 2,
        });

        const missingResponse = await mf.dispatchFetch("http://example.com/binding-select", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jwt, organizationId: ORGANIZATION_ID, channelId: "general", id: "missing" }),
        });
        expect(missingResponse.status).toBe(200);
        expect(await missingResponse.json()).toBeNull();

        const forbiddenResponse = await mf.dispatchFetch("http://example.com/binding-select", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jwt, organizationId: OTHER_ORGANIZATION_ID, channelId: "general", limit: 2 }),
        });
        expect(forbiddenResponse.status).toBeGreaterThanOrEqual(400);

        const crossPartitionResponse = await mf.dispatchFetch("http://example.com/binding-cross-partition", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jwt, organizationIds: [ORGANIZATION_ID, OTHER_ORGANIZATION_ID] }),
        });
        expect(crossPartitionResponse.status).toBeGreaterThanOrEqual(400);
    });

    test("an explicit-ref org plan executes and route or Cdb plan drift fails closed", async () => {
        if (!mf || !queryRef) throw new Error("planned query fixture is not initialized");
        const socket = await openSocket("planned-query-client");

        const snapshot = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(1),
            ref: queryRef,
            args: { organizationId: ORGANIZATION_ID, channelId: "general", limit: 2 },
        });
        expect(snapshot).toMatchObject({
            t: "snapshot",
            subId: 1,
            rows: [
                { id: "row-01", organizationId: ORGANIZATION_ID, channelId: "general", createdAt: 1 },
                { id: "row-02", organizationId: ORGANIZATION_ID, channelId: "general", createdAt: 2 },
            ],
        });

        const wrongRoute = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(2),
            ref: queryRef,
            args: { organizationId: OTHER_ORGANIZATION_ID, channelId: "general", limit: 2 },
        });
        expect(wrongRoute).toMatchObject({ t: "error", subId: 2, code: "CDB_FORBIDDEN" });

        const drift = await mf.dispatchFetch("http://example.com/plan-drift", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ shardId, enabled: true }),
        });
        expect(drift.ok).toBe(true);
        const rejectedDrift = await sendAndReceive(socket, {
            t: "sub",
            subId: SubId(3),
            ref: queryRef,
            args: { organizationId: ORGANIZATION_ID, channelId: "general", limit: 2 },
        });
        expect(rejectedDrift).toMatchObject({
            t: "error",
            subId: 3,
            code: "CDB_INVARIANT",
            retryable: false,
        });

        socket.close();
    });

    test(
        "scales exact ordered planned-query pages across isolated channels",
        async () => {
            if (!mf || !queryRef || !signToken) throw new Error("planned query fixture is not initialized");
            const fixture = mf;
            const issueToken = signToken;
            const resetDrift = await fixture.dispatchFetch("http://example.com/plan-drift", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ shardId, enabled: false }),
            });
            expect(resetDrift.ok).toBe(true);
            const otherOrganizationRoute = await fixture.dispatchFetch(
                "http://example.com/authorize-benchmark-other-organization",
                { method: "POST" }
            );
            expect(otherOrganizationRoute.ok).toBe(true);
            expect(await otherOrganizationRoute.json()).toMatchObject({ shardId });
            const seeded = await fixture.dispatchFetch("http://example.com/seed-benchmark", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    shardId,
                    organizationIds: [ORGANIZATION_ID, OTHER_ORGANIZATION_ID],
                    channelCount: BENCH_CHANNELS,
                    rowsPerChannel: BENCH_ROWS_PER_CHANNEL,
                }),
            });
            expect(seeded.ok).toBe(true);
            expect(await seeded.json()).toEqual({
                ok: true,
                rows: 2 * BENCH_CHANNELS * BENCH_ROWS_PER_CHANNEL,
            });

            const sockets = [
                await openSocket("planned-query-benchmark-client-a", USER_ID),
                await openSocket("planned-query-benchmark-client-b", OTHER_USER_ID),
            ];
            const pageSize = Math.min(BENCH_PAGE_LIMIT, BENCH_ROWS_PER_CHANNEL);
            const startedAt = performance.now();
            let exactSnapshots = 0;
            for (let registration = 0; registration < BENCH_REGISTRATIONS; registration++) {
                const organizationIndex = registration % 2;
                const organizationId = organizationIndex === 0 ? ORGANIZATION_ID : OTHER_ORGANIZATION_ID;
                const organizationSuffix = organizationIndex === 0 ? "a" : "b";
                const channel = (Math.floor(registration / 2) % BENCH_CHANNELS) + 1;
                const channelSuffix = String(channel).padStart(2, "0");
                const channelId = `bench-channel-${channelSuffix}`;
                const subId = SubId(100 + registration);
                const response = await sendAndReceive(sockets[organizationIndex] as WebSocket, {
                    t: "sub",
                    subId,
                    ref: queryRef,
                    args: { organizationId, channelId, limit: pageSize },
                });
                expect(response.t).toBe("snapshot");
                if (response.t !== "snapshot") throw new Error(`registration ${registration} did not materialize`);
                expect(response.subId).toBe(subId);
                expect(response.rows).toEqual(
                    Array.from({ length: pageSize }, (_, index) => ({
                        id: `bench-${organizationSuffix}-${channelSuffix}-${String(index + 1).padStart(4, "0")}`,
                        organizationId,
                        channelId,
                        createdAt: index + 1,
                    }))
                );
                (sockets[organizationIndex] as WebSocket).send(encodeWire({ t: "ack", cookie: response.cookie }));
                exactSnapshots++;
            }
            const registrationAndMaterializationMs = performance.now() - startedAt;

            const jwts = [await issueToken(USER_ID), await issueToken(OTHER_USER_ID)];
            const bindingLatenciesMs: number[] = [];
            const bindingStartedAt = performance.now();
            for (let offset = 0; offset < BENCH_BINDING_QUERIES; offset += BENCH_BINDING_CONCURRENCY) {
                const batchSize = Math.min(BENCH_BINDING_CONCURRENCY, BENCH_BINDING_QUERIES - offset);
                await Promise.all(
                    Array.from({ length: batchSize }, async (_, batchIndex) => {
                        const queryIndex = offset + batchIndex;
                        const organizationIndex = queryIndex % 2;
                        const organizationId = organizationIndex === 0 ? ORGANIZATION_ID : OTHER_ORGANIZATION_ID;
                        const organizationSuffix = organizationIndex === 0 ? "a" : "b";
                        const channel = (Math.floor(queryIndex / 2) % BENCH_CHANNELS) + 1;
                        const channelSuffix = String(channel).padStart(2, "0");
                        const channelId = `bench-channel-${channelSuffix}`;
                        const startedAt = performance.now();
                        const response = await fixture.dispatchFetch("http://example.com/binding-select", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                                jwt: jwts[organizationIndex],
                                organizationId,
                                channelId,
                                limit: pageSize,
                            }),
                        });
                        const rows = (await response.json()) as readonly unknown[];
                        bindingLatenciesMs.push(performance.now() - startedAt);
                        expect(response.status).toBe(200);
                        expect(rows).toEqual(
                            Array.from({ length: pageSize }, (_, index) => ({
                                id: `bench-${organizationSuffix}-${channelSuffix}-${String(index + 1).padStart(4, "0")}`,
                                organizationId,
                                channelId,
                                createdAt: index + 1,
                            }))
                        );
                    })
                );
            }
            const bindingElapsedMs = performance.now() - bindingStartedAt;
            const sortedBindingLatenciesMs = bindingLatenciesMs.toSorted((left, right) => left - right);
            const percentile = (fraction: number) => {
                const index = Math.min(
                    sortedBindingLatenciesMs.length - 1,
                    Math.ceil(fraction * sortedBindingLatenciesMs.length) - 1
                );
                return sortedBindingLatenciesMs[index];
            };
            console.info(
                JSON.stringify({
                    type: "chardb-workerd-benchmark",
                    scenario: "native-binding-structured-select-pages",
                    organizations: 2,
                    channels: BENCH_CHANNELS,
                    rowsPerChannel: BENCH_ROWS_PER_CHANNEL,
                    seededRows: 2 * BENCH_CHANNELS * BENCH_ROWS_PER_CHANNEL,
                    queries: BENCH_BINDING_QUERIES,
                    concurrency: BENCH_BINDING_CONCURRENCY,
                    pageLimit: pageSize,
                    exactOrderedIsolatedQueries: BENCH_BINDING_QUERIES,
                    elapsedMs: Number(bindingElapsedMs.toFixed(2)),
                    queriesPerSecond: Number(((BENCH_BINDING_QUERIES * 1_000) / bindingElapsedMs).toFixed(2)),
                    minimumRequestLatencyMs: Number((sortedBindingLatenciesMs[0] ?? 0).toFixed(2)),
                    p50RequestLatencyMs: Number((percentile(0.5) ?? 0).toFixed(2)),
                    p95RequestLatencyMs: Number((percentile(0.95) ?? 0).toFixed(2)),
                    maximumRequestLatencyMs: Number((sortedBindingLatenciesMs.at(-1) ?? 0).toFixed(2)),
                })
            );
            console.info(
                JSON.stringify({
                    type: "chardb-workerd-benchmark",
                    scenario: "planned-query-registered-pages",
                    organizations: 2,
                    channels: BENCH_CHANNELS,
                    rowsPerChannel: BENCH_ROWS_PER_CHANNEL,
                    seededRows: 2 * BENCH_CHANNELS * BENCH_ROWS_PER_CHANNEL,
                    registrations: BENCH_REGISTRATIONS,
                    pageLimit: pageSize,
                    exactOrderedIsolatedSnapshots: exactSnapshots,
                    registrationAndMaterializationMs: Number(registrationAndMaterializationMs.toFixed(2)),
                    registrationsPerSecond: Number(
                        ((BENCH_REGISTRATIONS * 1_000) / registrationAndMaterializationMs).toFixed(2)
                    ),
                })
            );
            for (let registration = 0; registration < BENCH_REGISTRATIONS; registration++) {
                (sockets[registration % 2] as WebSocket).send(
                    encodeWire({ t: "unsub", subId: SubId(100 + registration) })
                );
            }
            for (const socket of sockets) socket.close();
        },
        BENCH_TEST_TIMEOUT_MS
    );
});
