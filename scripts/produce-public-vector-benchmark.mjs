import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { ClientId, MutId, SubId } from "../src/types.ts";
import { PROTOCOL_V, decodeWire, encodeWire } from "../src/wire.ts";
import { disposeMiniflareBounded } from "./miniflare-lifecycle.mjs";
import {
    PUBLIC_VECTOR_BENCHMARK_SAMPLE_SCHEMA,
    PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID,
    PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION,
    assertPublicVectorBenchmarkSample,
    publicVectorBenchmarkProfile,
} from "./public-vector-benchmark-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "test", "workerd", "public-vector-benchmark.entry.ts");
const COMPATIBILITY_DATE = "2026-08-06";
const KID = "public-vector-benchmark-key";
const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const SUBJECT = "workerd-user";
const MAX_INFLIGHT_MUTATIONS = 64;

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function option(argv, flag) {
    const positions = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (positions.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (positions.length === 0) return undefined;
    const value = argv[positions[0] + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
}

export function parsePublicVectorBenchmarkProducerArgs(argv) {
    const valueFlags = new Set(["--profile", "--sequence", "--excluded"]);
    const allowed = new Set([...valueFlags, "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument))
            throw new Error(`unknown public vector producer argument ${JSON.stringify(argument)}`);
        if (valueFlags.has(argument)) index++;
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const profileName = option(argv, "--profile") ?? "ci";
    publicVectorBenchmarkProfile(profileName);
    const sequence = Number(option(argv, "--sequence") ?? "0");
    if (!Number.isSafeInteger(sequence) || sequence < -1) throw new Error("--sequence must be an integer >= -1");
    const excludedText = option(argv, "--excluded") ?? String(sequence === -1);
    if (excludedText !== "true" && excludedText !== "false") throw new Error("--excluded must be true or false");
    const excluded = excludedText === "true";
    if (excluded !== (sequence === -1)) throw new Error("--excluded must identify sequence -1");
    return {
        help,
        profileName,
        sequence,
        excluded,
        compatibilityDate: COMPATIBILITY_DATE,
    };
}

async function packageVersion(file) {
    const value = JSON.parse(await readFile(file, "utf8"));
    return typeof value.version === "string" && value.version.length > 0 ? value.version : "unknown";
}

async function buildWorker(directory) {
    const bundle = path.join(directory, "public-vector-benchmark.worker.mjs");
    const child = Bun.spawn(
        [
            process.execPath,
            "build",
            ENTRY,
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            bundle,
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" }
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`public vector benchmark bundle failed: ${stderr}`);
    let source = await readFile(bundle, "utf8");
    source = source.replace(
        "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
        'await Promise.reject(new Error("Node file migrations are unavailable in workerd"))'
    );
    source = source.replace(
        "await import(nodeSqlite)",
        'await Promise.reject(new Error("Node sqlite is unavailable in workerd"))'
    );
    if (/\bimport\s*\([^"'`]/.test(source)) throw new Error("public vector benchmark bundle has a dynamic import");
    return { source, sha256: sha256(source) };
}

function createInbox(socket) {
    const queued = [];
    const waiters = [];
    socket.addEventListener("message", event => {
        const message = decodeWire(String(event.data));
        const waiter = waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timeout);
            waiter.resolve(message);
        } else queued.push(message);
    });
    socket.addEventListener(
        "close",
        event => {
            for (const waiter of waiters.splice(0)) {
                clearTimeout(waiter.timeout);
                waiter.reject(new Error(`Gateway closed (${event.code}: ${event.reason})`));
            }
        },
        { once: true }
    );
    return {
        next(timeoutMs = 10_000, label = "Gateway message") {
            const message = queued.shift();
            if (message) return Promise.resolve(message);
            return new Promise((resolve, reject) => {
                const waiter = {
                    resolve,
                    reject,
                    timeout: setTimeout(() => {
                        const index = waiters.indexOf(waiter);
                        if (index >= 0) waiters.splice(index, 1);
                        reject(new Error(`timed out waiting for ${label}`));
                    }, timeoutMs),
                };
                waiters.push(waiter);
            });
        },
    };
}

async function openSocket(origin, clientId, token) {
    const url = new URL("/ws", origin);
    url.searchParams.set("clientId", clientId);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out opening public vector benchmark socket")), 5_000);
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
                reject(new Error("public vector benchmark socket failed to open"));
            },
            { once: true }
        );
    });
    const inbox = createInbox(socket);
    socket.send(encodeWire({ t: "hello", protocolV: PROTOCOL_V, clientId: ClientId(clientId), jwt: token }));
    const welcome = await inbox.next(10_000, "Gateway welcome");
    check(welcome.t === "welcome", `Gateway hello failed: ${JSON.stringify(welcome)}`);
    return { socket, inbox, closed };
}

function acknowledge(socket, snapshot) {
    socket.send(encodeWire({ t: "ack", cookie: snapshot.cookie }));
}

function assertNoProtocolError(message) {
    if (message.t === "error") throw new Error(`Gateway error ${message.code}: ${message.message}`);
}

async function collectSnapshots(
    opened,
    subIds,
    predicate,
    observedAt,
    timeoutMs = 20_000,
    label = "snapshots",
    onProgress = async () => {}
) {
    const remaining = new Set(subIds);
    const rowsBySub = new Map();
    const latencyBySub = new Map();
    const observed = [];
    const deadline = Date.now() + timeoutMs;
    while (remaining.size > 0) {
        let message;
        try {
            message = await opened.inbox.next(Math.max(1, deadline - Date.now()), label);
        } catch (error) {
            throw new Error(
                `${error instanceof Error ? error.message : String(error)}; observed ${JSON.stringify(observed)}`
            );
        }
        assertNoProtocolError(message);
        if (message.t !== "snapshot" || !remaining.has(Number(message.subId))) continue;
        acknowledge(opened.socket, message);
        observed.push({ subId: Number(message.subId), rows: Array.isArray(message.rows) ? message.rows.length : null });
        if (!predicate(message)) {
            await onProgress(message);
            continue;
        }
        remaining.delete(Number(message.subId));
        rowsBySub.set(Number(message.subId), message.rows);
        latencyBySub.set(Number(message.subId), performance.now() - observedAt);
    }
    return { rowsBySub, latencyBySub, observed };
}

async function collectMutations(opened, mutations, pendingSubIds, label) {
    const remaining = new Map(mutations.map(mutation => [mutation.mutId, mutation]));
    const pending = new Set(pendingSubIds);
    const latencies = [];
    while (remaining.size > 0) {
        const message = await opened.inbox.next(20_000, label);
        assertNoProtocolError(message);
        if (message.t === "snapshot") {
            acknowledge(opened.socket, message);
            if (Array.isArray(message.rows) && message.rows.length === 0) pending.delete(Number(message.subId));
            continue;
        }
        if (message.t !== "poke" || !message.mutResults) continue;
        for (const result of message.mutResults) {
            const mutation = remaining.get(String(result.mutId));
            if (!mutation) continue;
            check(result.ok === true, `mutation ${result.mutId} failed: ${JSON.stringify(result)}`);
            latencies.push(performance.now() - mutation.startedAt);
            remaining.delete(String(result.mutId));
        }
    }
    return { latencies, pending };
}

async function produceScenario(input) {
    const { opened, request, refs, seeded, scenario, scenarioIndex } = input;
    const organizationBySub = new Map();
    const subIds = [];
    for (let index = 0; index < seeded.organizations.length; index++) {
        const subId = scenarioIndex * 1_000 + index + 1;
        const organization = seeded.organizations[index];
        subIds.push(subId);
        organizationBySub.set(subId, organization);
        opened.socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(subId),
                ref: refs.searchRef,
                args: {
                    organizationId: organization.organizationId,
                    values: [1, 0, 0],
                    limit: scenario.vectorsPerOrganization,
                },
            })
        );
    }
    for (const subId of subIds) {
        const deadline = Date.now() + 10_000;
        let lastState = null;
        while (Date.now() < deadline) {
            const registration = await request("/gateway-registration", {
                search: { clientId: input.clientId, subId: String(subId) },
            });
            lastState = registration.state;
            if (typeof lastState?.retry_error === "string") {
                throw new Error(`scenario ${scenario.name} registration ${subId} failed: ${lastState.retry_error}`);
            }
            if (lastState?.lifecycle === "active" && lastState.cdb_state === "active" && lastState.current_head === 1) {
                break;
            }
            await Bun.sleep(10);
        }
        if (!(lastState?.lifecycle === "active" && lastState.cdb_state === "active" && lastState.current_head === 1)) {
            throw new Error(
                `timed out waiting for scenario ${scenario.name} registration ${subId}: ${JSON.stringify(lastState)}`
            );
        }
    }
    await request("/gateway-drain", { search: { clientId: input.clientId } });
    await collectSnapshots(
        opened,
        subIds,
        message => Array.isArray(message.rows) && message.rows.length === 0,
        performance.now(),
        20_000,
        `scenario ${scenario.name} initial snapshots`
    );

    const totalStarted = performance.now();
    const mutationStarted = performance.now();
    const mutationLatencies = [];
    let mutationCommits = 0;
    const pendingSubIds = new Set(subIds);
    const mutations = [];
    for (let organizationIndex = 0; organizationIndex < seeded.organizations.length; organizationIndex++) {
        const organization = seeded.organizations[organizationIndex];
        for (let vectorIndex = 0; vectorIndex < scenario.vectorsPerOrganization; vectorIndex++) {
            mutations.push({
                organization,
                organizationIndex,
                vectorIndex,
                id: `row-${scenarioIndex}-${organizationIndex}-${vectorIndex}`,
                mutId: `m-${scenarioIndex}-${organizationIndex}-${vectorIndex}`,
            });
        }
    }
    for (let offset = 0; offset < mutations.length; offset += MAX_INFLIGHT_MUTATIONS) {
        const chunk = mutations.slice(offset, offset + MAX_INFLIGHT_MUTATIONS).map(mutation => ({
            ...mutation,
            startedAt: performance.now(),
        }));
        for (const mutation of chunk) {
            opened.socket.send(
                encodeWire({
                    t: "mut",
                    mutId: MutId(mutation.mutId),
                    ref: refs.putRef,
                    args: {
                        organizationId: mutation.organization.organizationId,
                        id: mutation.id,
                        body: `benchmark ${mutation.id}`,
                        values: [1, 0, 0],
                    },
                })
            );
        }
        const collected = await collectMutations(
            opened,
            chunk,
            pendingSubIds,
            `scenario ${scenario.name} mutation acks`
        );
        mutationLatencies.push(...collected.latencies);
        for (const subId of [...pendingSubIds]) if (!collected.pending.has(subId)) pendingSubIds.delete(subId);
        mutationCommits += chunk.length;
    }
    const mutationPhaseMs = performance.now() - mutationStarted;
    if (pendingSubIds.size > 0) {
        await request("/gateway-drain", { search: { clientId: input.clientId } });
        await collectSnapshots(
            opened,
            [...pendingSubIds],
            message => Array.isArray(message.rows) && message.rows.length === 0,
            performance.now(),
            20_000,
            `scenario ${scenario.name} pending snapshots`
        );
    }

    // This phase drives every delivery turn through authenticated benchmark controls. It measures
    // controlled convergence, not autonomous Durable Object alarm scheduling or user-visible latency.
    const deliveryStarted = performance.now();
    const shardIds = [...new Set(seeded.organizations.map(organization => organization.shardId))];
    let deliveryTurns = 0;
    let readyHeads = 0;
    let lastStates = [];
    let lastVectorState = null;
    const expectedIds = new Set(mutations.map(mutation => mutation.id));
    const maximumTurns = Math.ceil(mutations.length / Math.max(1, shardIds.length * 32)) * 4 + 32;
    while (deliveryTurns < maximumTurns) {
        deliveryTurns++;
        await Promise.all(shardIds.map(shardId => request("/cdb-drain", { search: { shardId } })));
        for (;;) {
            const processed = await request("/vector-process");
            if (processed.processed < 100) break;
        }
        await Promise.all(shardIds.map(shardId => request("/cdb-force-due", { search: { shardId } })));
        await Promise.all(shardIds.map(shardId => request("/cdb-drain", { search: { shardId } })));
        await Promise.all(shardIds.map(shardId => request("/cdb-drain", { search: { shardId } })));
        lastStates = await Promise.all(shardIds.map(shardId => request("/cdb-state", { search: { shardId } })));
        lastVectorState = await request("/vector-state");
        readyHeads = lastStates
            .flatMap(state => state.heads)
            .filter(
                head =>
                    expectedIds.has(head.row_pk) && head.state === "ready" && head.version === head.delivered_version
            ).length;
        if (readyHeads === mutations.length) break;
    }
    check(
        readyHeads === mutations.length,
        `delivery stopped at ${readyHeads}/${mutations.length} ready heads: ${JSON.stringify({ states: lastStates, vector: lastVectorState })}`
    );
    await Promise.all(shardIds.map(shardId => request("/cdb-drain", { search: { shardId } })));
    await Promise.all(shardIds.map(shardId => request("/cdb-drain", { search: { shardId } })));
    const controllerDrivenDeliveryMs = performance.now() - deliveryStarted;

    const refetchStarted = performance.now();
    await request("/gateway-drain", { search: { clientId: input.clientId } });
    await request("/gateway-drain", { search: { clientId: input.clientId } });
    const snapshots = await collectSnapshots(
        opened,
        subIds,
        message => Array.isArray(message.rows) && message.rows.length === scenario.vectorsPerOrganization,
        refetchStarted,
        30_000,
        `scenario ${scenario.name} final live refetches`,
        async () => {
            await request("/gateway-drain", { search: { clientId: input.clientId } });
        }
    );
    const refetchPhaseMs = performance.now() - refetchStarted;
    let returnedRows = 0;
    let duplicateRows = 0;
    let leakedRows = 0;
    let isolatedOrganizations = 0;
    let monotonicRefetches = 0;
    for (const subId of subIds) {
        const organization = organizationBySub.get(subId);
        const rows = snapshots.rowsBySub.get(subId);
        check(organization && Array.isArray(rows), `subscription ${subId} has no final snapshot`);
        const organizationIndex = seeded.organizations.indexOf(organization);
        const expectedForOrganization = new Set(
            Array.from(
                { length: scenario.vectorsPerOrganization },
                (_, vectorIndex) => `row-${scenarioIndex}-${organizationIndex}-${vectorIndex}`
            )
        );
        const observed = new Set();
        for (const row of rows) {
            check(
                row &&
                    typeof row === "object" &&
                    JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["rowPk", "score"]),
                "registered vector search returned unexpected fields"
            );
            returnedRows++;
            if (observed.has(row.rowPk)) duplicateRows++;
            observed.add(row.rowPk);
            if (!expectedForOrganization.has(row.rowPk)) leakedRows++;
        }
        if (
            observed.size === expectedForOrganization.size &&
            [...observed].every(id => expectedForOrganization.has(id))
        ) {
            isolatedOrganizations++;
        }
        const counts = snapshots.observed
            .filter(observation => observation.subId === subId)
            .map(observation => observation.rows)
            .filter(count => count > 0);
        const monotonic =
            counts.length > 0 &&
            counts.at(-1) === scenario.vectorsPerOrganization &&
            counts.every((count, countIndex) => countIndex === 0 || count > counts[countIndex - 1]);
        const requiredSingleProgress =
            scenario.name !== "single" ||
            scenario.vectorsPerOrganization !== 2 ||
            JSON.stringify(counts) === JSON.stringify([1, 2]);
        if (monotonic && requiredSingleProgress) {
            monotonicRefetches++;
        }
    }
    const totalMs = performance.now() - totalStarted;
    return {
        name: scenario.name,
        dataset: {
            organizations: scenario.organizations,
            shards: scenario.shards,
            vectorsPerOrganization: scenario.vectorsPerOrganization,
            vectors: mutations.length,
        },
        timing: {
            totalMs,
            mutationPhaseMs,
            mutationAckMs: mutationLatencies,
            controllerDrivenDeliveryMs,
            refetchPhaseMs,
            liveRefetchMs: subIds.map(subId => snapshots.latencyBySub.get(subId)),
            liveRefetchRowCounts: subIds.map(subId =>
                snapshots.observed
                    .filter(observation => observation.subId === subId)
                    .map(observation => observation.rows)
                    .filter(count => count > 0)
            ),
        },
        throughput: {
            vectorsPerSecond: (mutations.length * 1_000) / totalMs,
            organizationsPerSecond: (scenario.organizations * 1_000) / totalMs,
        },
        correctness: {
            mutationCommits,
            readyHeads,
            returnedRows,
            liveRefetches: snapshots.rowsBySub.size,
            isolatedOrganizations,
            observedShards: shardIds.length,
            monotonicRefetches,
            duplicateRows,
            leakedRows,
            deliveryTurns,
            registeredMutation: true,
            registeredSearch: true,
            liveProtocol: true,
        },
    };
}

async function createRuntime(options, temporaryPath, adminToken) {
    const bundle = await buildWorker(temporaryPath);
    const configuration = {
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: ["nodejs_compat"],
        bindings: ["CDB_BENCHMARK_ADMIN_TOKEN"],
        durableObjects: ["CDB_CATALOG", "CDB_GATEWAY", "CDB_SHARD", "CDB_PROOF_VECTORS"],
        sqlite: true,
    };
    const instance = new Miniflare({
        name: "public-vector-benchmark",
        modules: true,
        script: bundle.source,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_GATEWAY: { className: "Gateway", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_PROOF_VECTORS: { className: "VectorIndexProbe", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: ["nodejs_compat"],
        bindings: { CDB_BENCHMARK_ADMIN_TOKEN: adminToken },
    });
    const origin = await instance.ready;
    const nodeModules = path.join(ROOT, "node_modules");
    return {
        origin,
        instance,
        target: {
            kind: "local",
            transport: "miniflare-workerd-websocket",
            vectorBackend: "durable-object-fake",
            realVectorize: false,
            configurationSha256: sha256(JSON.stringify(configuration)),
            artifactSha256: bundle.sha256,
            runtime: {
                bun: Bun.version,
                workerd: await packageVersion(path.join(nodeModules, "workerd", "package.json")),
                miniflare: await packageVersion(path.join(nodeModules, "miniflare", "package.json")),
                wrangler: null,
                compatibilityDate: options.compatibilityDate,
            },
            storage: { durableObjects: true, sqlite: true },
        },
    };
}

export async function producePublicVectorBenchmarkSample(options) {
    const profile = publicVectorBenchmarkProfile(options.profileName);
    const temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-public-vector-benchmark-"));
    let runtime;
    let opened;
    let report;
    let disposalStatus = "absent";
    const startedAt = new Date().toISOString();
    try {
        const adminToken = randomBytes(32).toString("base64url");
        runtime = await createRuntime(options, temporaryPath, adminToken);
        const request = async (pathname, requestOptions = {}) => {
            const url = new URL(pathname, runtime.origin);
            for (const [key, value] of Object.entries(requestOptions.search ?? {})) url.searchParams.set(key, value);
            const init =
                requestOptions.body === undefined
                    ? { headers: { authorization: `Bearer ${adminToken}` } }
                    : {
                          method: "POST",
                          headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
                          body: JSON.stringify(requestOptions.body),
                      };
            const response = await runtime.instance.dispatchFetch(url, init);
            const text = await response.text();
            if (!response.ok) throw new Error(`${pathname} failed (${response.status}): ${text}`);
            try {
                return text ? JSON.parse(text) : null;
            } catch {
                throw new Error(`${pathname} returned invalid JSON`);
            }
        };
        const { privateKey, publicKey } = await generateKeyPair("ES256");
        const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
        const refs = await request("/seed", { body: { kid: KID, jwk: publicJwk } });
        for (const key of ["putRef", "searchRef"]) check(typeof refs[key] === "string", `/seed omitted ${key}`);
        const run = `${options.sequence === -1 ? "warmup" : `sample-${options.sequence}`}-${sha256(runtime.target.artifactSha256).slice(0, 8)}`;
        const seeded = await request("/benchmark-seed", {
            body: {
                run,
                scenarios: profile.scenarios.map(scenario => ({
                    name: scenario.name,
                    organizations: scenario.organizations,
                    shards: scenario.shards,
                })),
            },
        });
        check(
            Array.isArray(seeded.scenarios) && seeded.scenarios.length === profile.scenarios.length,
            "benchmark seed drifted"
        );
        const now = Math.floor(Date.now() / 1_000);
        const token = await new SignJWT({ proof: "public-vector-benchmark" })
            .setProtectedHeader({ alg: "ES256", kid: KID })
            .setSubject(SUBJECT)
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setIssuedAt(now)
            .setExpirationTime(now + 1_800)
            .sign(privateKey);
        const clientId = `public-vector-benchmark-${options.sequence === -1 ? "warmup" : options.sequence}`;
        opened = await openSocket(runtime.origin, clientId, token);
        const scenarios = [];
        for (let index = 0; index < profile.scenarios.length; index++) {
            scenarios.push(
                await produceScenario({
                    opened,
                    request,
                    refs,
                    seeded: seeded.scenarios[index],
                    scenario: profile.scenarios[index],
                    scenarioIndex: index,
                    clientId,
                })
            );
        }
        report = assertPublicVectorBenchmarkSample({
            schema: PUBLIC_VECTOR_BENCHMARK_SAMPLE_SCHEMA,
            sequence: options.sequence,
            excluded: options.excluded,
            workload: {
                id: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID,
                version: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION,
                profile,
            },
            target: runtime.target,
            execution: { startedAt, completedAt: new Date().toISOString(), processId: process.pid },
            scenarios,
        });
    } finally {
        if (opened) {
            opened.socket.close();
            await Promise.race([opened.closed, Bun.sleep(1_000)]);
        }
        const disposed = await disposeMiniflareBounded(runtime?.instance, {
            label: "public vector benchmark teardown",
            timeoutMs: 5_000,
        });
        disposalStatus = disposed.status;
        await rm(temporaryPath, { recursive: true, force: true });
    }
    if (disposalStatus !== "disposed" && disposalStatus !== "absent") {
        throw new Error(`public vector benchmark teardown failed: ${disposalStatus}`);
    }
    if (!report) throw new Error("public vector benchmark produced no report");
    return report;
}

function usage() {
    return [
        "Usage: bun scripts/produce-public-vector-benchmark.mjs [options]",
        "",
        "  --profile <ci|standard|large> --sequence <n> --excluded <true|false>",
        "",
        "This producer records local Miniflare/Workerd with a persistent fake vector index. It cannot emit deployed evidence.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parsePublicVectorBenchmarkProducerArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else process.stdout.write(`${JSON.stringify(await producePublicVectorBenchmarkSample(options))}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    }
}
