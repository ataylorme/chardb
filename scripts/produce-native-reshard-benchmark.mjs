import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { ClientId, SubId } from "../src/types.ts";
import { PROTOCOL_V, decodeWire, encodeWire } from "../src/wire.ts";
import { startLocalFileProofRuntime } from "./local-file-proof-runtime.mjs";
import {
    RESHARD_BENCHMARK_PHASES,
    RESHARD_BENCHMARK_PROFILE,
    RESHARD_BENCHMARK_SAMPLE_SCHEMA,
    RESHARD_BENCHMARK_WORKLOAD_ID,
    RESHARD_BENCHMARK_WORKLOAD_VERSION,
    assertReshardBenchmarkSample,
} from "./reshard-benchmark-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "reshard-benchmark");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");
const DEFAULT_PORT = 8793;
const ISSUER = "https://reshard-benchmark.invalid";
const AUDIENCE = "chardb-reshard-benchmark";
const USER_ID = "benchmark-user-0001";
const ORGANIZATION_ID = "benchmark-organization-0001";
const QUERY_REF = "test/fixtures/reshard-benchmark/worker.ts#benchmarkParent";
const MUTATION_ID = "stale-route-exact-retry";
const RESTART_AFTER_APPLIES = RESHARD_BENCHMARK_PROFILE.restart.afterAppliedBatches;

function value(argv, flag) {
    const indices = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (indices.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (indices.length === 0) return undefined;
    const result = argv[indices[0] + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

export function parseNativeReshardProducerArgs(argv) {
    const allowed = new Set(["--profile", "--sequence", "--excluded", "--candidate", "--candidate-sha256"]);
    for (let index = 0; index < argv.length; index += 2) {
        const argument = argv[index];
        if (!allowed.has(argument))
            throw new Error(`unknown native reshard producer argument ${JSON.stringify(argument)}`);
        if (argv[index + 1] === undefined) throw new Error(`${argument} requires a value`);
    }
    const profile = value(argv, "--profile");
    if (profile !== RESHARD_BENCHMARK_PROFILE.name) throw new Error(`unsupported reshard benchmark profile ${profile}`);
    const sequence = Number(value(argv, "--sequence"));
    if (!Number.isSafeInteger(sequence) || sequence < -1 || sequence >= RESHARD_BENCHMARK_PROFILE.logicalRuns) {
        throw new Error("--sequence is outside the fixed run plan");
    }
    const excludedText = value(argv, "--excluded");
    if (excludedText !== "true" && excludedText !== "false") throw new Error("--excluded must be true or false");
    const excluded = excludedText === "true";
    if (excluded !== (sequence === -1)) throw new Error("--excluded does not match the warmup sequence");
    const candidateSha256 = value(argv, "--candidate-sha256");
    if (!/^[a-f0-9]{64}$/.test(candidateSha256 ?? "")) throw new Error("--candidate-sha256 is invalid");
    const candidate = value(argv, "--candidate");
    if (!candidate) throw new Error("--candidate is required");
    return { profile, sequence, excluded, candidate: path.resolve(candidate), candidateSha256 };
}

function check(condition, message) {
    if (!condition) throw Object.assign(new Error(message), { detail: message });
}

async function packageVersion(file) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    check(typeof manifest.version === "string" && manifest.version.length > 0, `${file} has no package version`);
    return manifest.version;
}

async function runtimeIdentity() {
    const wranglerPackage = path.join(ROOT, "node_modules", "wrangler", "package.json");
    const wranglerRoot = path.dirname(wranglerPackage);
    return {
        workerd: await packageVersion(path.join(wranglerRoot, "node_modules", "workerd", "package.json")),
        wrangler: await packageVersion(wranglerPackage),
        miniflare: await packageVersion(path.join(wranglerRoot, "node_modules", "miniflare", "package.json")),
        compatibilityDate: "2026-08-27",
    };
}

async function requestJson(origin, pathname, body) {
    const response = await fetch(new URL(pathname, origin), {
        ...(body === undefined
            ? {}
            : {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
              }),
        signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`${pathname} returned invalid JSON: ${text}`);
    }
    if (!response.ok) {
        const detail = `${pathname} failed (${response.status}): ${JSON.stringify(parsed)}`;
        throw Object.assign(new Error(detail), { detail });
    }
    return parsed;
}

function socketInbox(socket) {
    const queued = [];
    const waiters = [];
    socket.addEventListener("message", event => {
        const message = decodeWire(String(event.data));
        const waiter = waiters.find(candidate => candidate.predicate(message));
        if (!waiter) {
            queued.push(message);
            return;
        }
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
    });
    socket.addEventListener("close", event => {
        const error = new Error(`Gateway closed (${event.code}: ${event.reason})`);
        for (const waiter of waiters.splice(0)) {
            clearTimeout(waiter.timeout);
            waiter.reject(error);
        }
    });
    return predicate => {
        const index = queued.findIndex(predicate);
        if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timeout: undefined };
            waiter.timeout = setTimeout(() => {
                const at = waiters.indexOf(waiter);
                if (at >= 0) waiters.splice(at, 1);
                reject(new Error(`timed out waiting for Gateway message; queued=${JSON.stringify(queued)}`));
            }, 30_000);
            waiters.push(waiter);
        });
    };
}

async function openGateway(origin, jwt, clientId) {
    const url = new URL("/ws", origin);
    url.protocol = "ws:";
    url.searchParams.set("clientId", clientId);
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out opening benchmark Gateway")), 20_000);
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
                reject(new Error("benchmark Gateway failed to open"));
            },
            { once: true }
        );
    });
    const next = socketInbox(socket);
    socket.send(encodeWire({ t: "hello", protocolV: PROTOCOL_V, clientId: ClientId(clientId), jwt }));
    const welcome = await next(message => message.t === "welcome" || message.t === "error");
    check(welcome.t === "welcome", `Gateway rejected benchmark token: ${JSON.stringify(welcome)}`);
    return { socket, next };
}

async function closeSocket(socket) {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
        const timeout = setTimeout(resolve, 2_000);
        socket.addEventListener(
            "close",
            () => {
                clearTimeout(timeout);
                resolve();
            },
            { once: true }
        );
        socket.close();
    });
}

async function measured(fn) {
    const started = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - started };
}

async function driveReshardEndpoint(origin, pathname, targetPhase) {
    let previousState;
    let unchangedTurns = 0;
    for (let turn = 0; turn < 1_024; turn++) {
        const state = await requestJson(origin, pathname, {});
        check(Number.isSafeInteger(state.phase), `${pathname} returned an invalid phase`);
        if (state.phase === targetPhase) return state;
        check(state.phase < targetPhase, `${pathname} overshot phase ${targetPhase}: ${JSON.stringify(state)}`);
        const signature = JSON.stringify({
            phase: state.phase,
            bulkCursor: state.bulkCursor,
            tailCursor: state.tailCursor,
            workTurn: state.workTurn,
            bulkTableIndex: state.bulkTableIndex,
        });
        unchangedTurns = signature === previousState ? unchangedTurns + 1 : 0;
        check(unchangedTurns < 32, `${pathname} made no durable progress for 32 turns: ${signature}`);
        previousState = signature;
    }
    throw new Error(`${pathname} exceeded 1024 bounded Resharder turns`);
}

function numberMetric(metrics, key) {
    const value = metrics[key] ?? 0;
    check(Number.isSafeInteger(value) && value >= 0, `benchmark metric ${key} is invalid`);
    return value;
}

function canonicalRows(message) {
    if (message.t !== "snapshot" || message.subId !== 1 || !Array.isArray(message.rows)) return null;
    return message.rows.map(row => ({ id: row.id, organizationId: row.organizationId, label: row.label }));
}

export async function produceNativeReshardBenchmarkSample(options) {
    const portText = process.env.CDB_RESHARD_BENCHMARK_PORT;
    const port = portText === undefined ? DEFAULT_PORT : Number(portText);
    check(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "CDB_RESHARD_BENCHMARK_PORT is invalid");
    const candidateBytes = await readFile(options.candidate);
    check(
        createHash("sha256").update(candidateBytes).digest("hex") === options.candidateSha256,
        "candidate worker digest does not match --candidate-sha256"
    );
    const configurationBytes = await readFile(path.join(FIXTURE, "wrangler.toml"));
    const configurationSha256 = createHash("sha256").update(configurationBytes).digest("hex");
    const temporary = await mkdtemp(path.join(tmpdir(), `chardb-reshard-${process.pid}-`));
    const persistenceDir = path.join(temporary, "state");
    const secretsFile = path.join(temporary, ".dev.vars");
    const wranglerLog = path.join(temporary, "wrangler.log");
    const candidateDirectory = await mkdtemp(path.join(tmpdir(), `chardb-reshard-candidate-${process.pid}-`));
    const executedCandidate = path.join(candidateDirectory, "candidate-worker.js");
    const executedConfiguration = path.join(candidateDirectory, "wrangler.toml");
    await writeFile(executedCandidate, candidateBytes);
    await writeFile(executedConfiguration, configurationBytes);
    await writeFile(
        secretsFile,
        `BETTER_AUTH_SECRET=benchmark-secret-at-least-thirty-two-bytes\nCDB_ADMIN_TOKEN=benchmark-admin-token\nCDB_PROOF_RUN_ID=reshard-benchmark-${options.sequence + 1}\n`,
        "utf8"
    );
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const kid = `reshard-benchmark-${options.sequence + 1}`;
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({ benchmark: true })
        .setProtectedHeader({ alg: "ES256", kid })
        .setSubject(USER_ID)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(privateKey);
    const runtime = await runtimeIdentity();
    const target = {
        kind: "local",
        origin: `http://127.0.0.1:${port}`,
        transport: "wrangler-miniflare-http",
        configurationSha256,
        runtime,
        storage: { durableObjects: true, sqlite: true },
    };
    const phasesMs = Object.fromEntries(RESHARD_BENCHMARK_PHASES.map(phase => [phase, 0]));
    const startedAt = new Date().toISOString();
    const totalStarted = performance.now();
    let first;
    let second;
    let socket;
    let failure;
    try {
        const start = () =>
            startLocalFileProofRuntime(
                {
                    app: FIXTURE,
                    persistenceDir,
                    secretsFile,
                    wrangler: WRANGLER,
                    releaseSha256: options.candidateSha256,
                    startupTimeoutMs: 60_000,
                    requestTimeoutMs: 5_000,
                    graceMs: 5_000,
                    env: {
                        WRANGLER_LOG_PATH: wranglerLog,
                    },
                },
                {
                    reservePort: async () => port,
                    spawn: (command, spawnOptions) =>
                        Bun.spawn(
                            command.flatMap(argument =>
                                argument === "dev"
                                    ? ["dev", executedCandidate, "--no-bundle", "--config", executedConfiguration]
                                    : [argument]
                            ),
                            spawnOptions
                        ),
                }
            );

        first = await start();
        const firstInstance = first.health.workerInstanceId;
        const prepare = await measured(() => requestJson(first.origin, "/benchmark/prepare", { kid, jwk: publicJwk }));
        phasesMs.prepare = prepare.ms;
        check(prepare.value.organizationId === ORGANIZATION_ID, "deterministic Better Auth organization drifted");
        check(
            prepare.value.seeded?.parents === RESHARD_BENCHMARK_PROFILE.seed.parentRows &&
                prepare.value.seeded?.children === RESHARD_BENCHMARK_PROFILE.seed.childRows,
            "benchmark parent/child seed drifted"
        );
        check(prepare.value.destinationBefore?.activeVersion === 0, "destination was not fresh before resharding");

        const checkpointTimeoutMs = Number(process.env.CDB_RESHARD_BENCHMARK_CHECKPOINT_TIMEOUT_MS ?? 60_000);
        check(Number.isSafeInteger(checkpointTimeoutMs) && checkpointTimeoutMs > 0, "invalid checkpoint timeout");
        const checkpointDeadline = Date.now() + checkpointTimeoutMs;
        let previousBulkState;
        let unchangedBulkTurns = 0;
        let reachedBulkCheckpoint = false;
        for (let turn = 0; turn < 1_000; turn++) {
            const result = await requestJson(first.origin, "/benchmark/bulk", {});
            check(result.phase === 1, `bulk driver left phase 1 before the restart: ${JSON.stringify(result)}`);
            const signature = JSON.stringify({
                phase: result.phase,
                bulkCursor: result.bulkCursor,
                tailCursor: result.tailCursor,
                workTurn: result.workTurn,
                bulkTableIndex: result.bulkTableIndex,
            });
            unchangedBulkTurns = signature === previousBulkState ? unchangedBulkTurns + 1 : 0;
            check(unchangedBulkTurns < 32, `bulk driver made no durable progress for 32 turns: ${signature}`);
            previousBulkState = signature;
            const checkpoint = await requestJson(first.origin, "/benchmark/bulk-checkpoint");
            const applied = Number(checkpoint.appliedBatches ?? 0);
            if (applied === RESTART_AFTER_APPLIES) {
                reachedBulkCheckpoint = true;
                break;
            }
            check(applied < RESTART_AFTER_APPLIES, `bulk checkpoint overshot ${RESTART_AFTER_APPLIES} applies`);
            check(
                Date.now() < checkpointDeadline,
                `timed out waiting for the third committed bulk batch: ${JSON.stringify(checkpoint)}`
            );
        }
        check(reachedBulkCheckpoint, "bulk driver exceeded its bounded turn budget");
        const capture = await measured(() => requestJson(first.origin, "/benchmark/capture", {}));
        phasesMs.capture = capture.ms;
        check(
            capture.value.transactions === RESHARD_BENCHMARK_PROFILE.capture.transactionGroups &&
                capture.value.entries === RESHARD_BENCHMARK_PROFILE.capture.transactionGroups,
            "fixed capture workload drifted"
        );

        const restartStarted = performance.now();
        await first.stop();
        first = undefined;
        second = await start();
        phasesMs.restart = performance.now() - restartStarted;
        const secondInstance = second.health.workerInstanceId;
        check(firstInstance !== secondInstance, "Wrangler restart reused the Worker process instance");
        const persistedState = await requestJson(second.origin, "/benchmark/reshard-state");
        const persistedCursor = persistedState.bulkCursor;
        check(persistedState.phase === 1, "restart checkpoint did not remain in bulk phase");
        check(
            persistedCursor && Object.values(persistedCursor).some(value => Number(value) > 0),
            `bulk cursor was not persisted before restart: ${JSON.stringify(persistedState)}`
        );

        const clientId = `reshard-benchmark-client-${options.sequence + 1}`;
        const connection = await openGateway(second.origin, token, clientId);
        socket = connection.socket;
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(1),
                ref: QUERY_REF,
                args: { organizationId: ORGANIZATION_ID, id: "parent-0000" },
            })
        );
        const initial = await connection.next(message => message.t === "snapshot" || message.t === "error");
        const initialRows = canonicalRows(initial);
        check(
            JSON.stringify(initialRows) ===
                JSON.stringify([{ id: "parent-0000", organizationId: ORGANIZATION_ID, label: "parent label 0" }]),
            `initial live snapshot drifted: ${JSON.stringify(initial)}`
        );
        socket.send(encodeWire({ t: "ack", cookie: initial.cookie }));

        await driveReshardEndpoint(second.origin, "/benchmark/resume", 3);
        const mustRefetchPromise = connection.next(
            message => message.t === "mustRefetch" && message.subIds.includes(1)
        );
        await requestJson(second.origin, "/benchmark/allow-cutover", {});
        const staleStarted = performance.now();
        const stale = await requestJson(second.origin, "/benchmark/stale-retry", { clientId, mutId: MUTATION_ID });
        const staleTotalMs = performance.now() - staleStarted;
        phasesMs.cutover = stale.cutoverMs;
        phasesMs.staleRouteRetry = Math.max(0, staleTotalMs - stale.cutoverMs);
        check(stale.attempts === 2, "Gateway did not perform one exact stale-route retry");
        check(stale.result?.ok === true && stale.result?.ran === true, "Gateway stale-route retry did not commit");

        const liveStarted = performance.now();
        const mustRefetch = await mustRefetchPromise;
        check(mustRefetch.reason === "shardsChanged", "live route change did not use shardsChanged");
        socket.send(
            encodeWire({
                t: "sub",
                subId: SubId(1),
                ref: QUERY_REF,
                args: { organizationId: ORGANIZATION_ID, id: "parent-0000" },
            })
        );
        const convergedSnapshot = await connection.next(message => message.t === "snapshot" || message.t === "error");
        const convergedRows = canonicalRows(convergedSnapshot);
        check(
            JSON.stringify(convergedRows) === JSON.stringify(initialRows),
            "live snapshot did not converge after cutover"
        );
        socket.send(encodeWire({ t: "ack", cookie: convergedSnapshot.cookie }));
        phasesMs.liveRefetch = performance.now() - liveStarted;

        const beforeDrain = await requestJson(second.origin, "/benchmark/digests");
        check(
            beforeDrain.source.rows === 5_120 && beforeDrain.destination.rows === 5_120,
            "pre-drain row counts drifted"
        );
        check(beforeDrain.source.digest === beforeDrain.destination.digest, "source and destination digests diverged");
        const orderedSentinelBody = `captured body ${RESHARD_BENCHMARK_PROFILE.capture.transactionGroups - 1}`;
        check(
            beforeDrain.source.orderedSentinelBody === orderedSentinelBody &&
                beforeDrain.destination.orderedSentinelBody === orderedSentinelBody,
            "tail replay did not preserve the captured transaction order"
        );

        const drain = await measured(() => driveReshardEndpoint(second.origin, "/benchmark/drain", 6));
        phasesMs.drain = drain.ms;
        check(drain.value.phase === 6, "reshard did not reach source-drained phase");
        const verify = await measured(() => requestJson(second.origin, "/benchmark/verify"));
        phasesMs.verify = verify.ms;
        check(verify.value.route?.shardId === "ShardDO_1", "Catalog route did not cut over");
        check(verify.value.source?.rows === 0, "source retained migrated rows");
        check(verify.value.destination?.rows === 5_120, "destination row count drifted");
        check(
            verify.value.destination?.digest === beforeDrain.destination.digest,
            "destination digest changed after drain"
        );
        check(
            verify.value.destination?.orderedSentinelBody === orderedSentinelBody,
            "ordered tail sentinel changed after drain"
        );
        check(
            verify.value.sourceMutationCount === 0 && verify.value.destinationMutationCount === 1,
            "stale-route mutation did not commit exactly once on the destination"
        );
        check(
            verify.value.sourceSchema?.activeVersion === verify.value.destinationSchema?.activeVersion &&
                verify.value.sourceSchema?.activeEpoch === verify.value.destinationSchema?.activeEpoch &&
                verify.value.sourceSchema?.activeDigest === verify.value.destinationSchema?.activeDigest,
            "source and destination schema identities diverged"
        );

        const sourceMetrics = verify.value.sourceMetrics;
        const destinationMetrics = verify.value.destinationMetrics;
        check(
            numberMetric(sourceMetrics, "bulk_rows") === 5_120,
            `bulk movement counted ${String(numberMetric(sourceMetrics, "bulk_rows"))} rows instead of 5120`
        );
        check(numberMetric(sourceMetrics, "fence_micros") > 0, "source routing fence was not exercised");
        phasesMs.bulk =
            (numberMetric(sourceMetrics, "bulk_micros") + numberMetric(destinationMetrics, "bulk_apply_micros")) /
            1_000;
        phasesMs.replay =
            (numberMetric(sourceMetrics, "tail_micros") +
                numberMetric(destinationMetrics, "tail_apply_micros") +
                numberMetric(sourceMetrics, "oplog_micros") +
                numberMetric(destinationMetrics, "oplog_apply_micros")) /
            1_000;
        phasesMs.fence = numberMetric(sourceMetrics, "fence_micros") / 1_000;

        const completedAt = new Date().toISOString();
        const totalMs = performance.now() - totalStarted;
        const sample = {
            schema: RESHARD_BENCHMARK_SAMPLE_SCHEMA,
            sequence: options.sequence,
            excluded: options.excluded,
            candidateSha256: options.candidateSha256,
            workload: {
                id: RESHARD_BENCHMARK_WORKLOAD_ID,
                version: RESHARD_BENCHMARK_WORKLOAD_VERSION,
                profile: RESHARD_BENCHMARK_PROFILE,
            },
            target,
            execution: { startedAt, completedAt, processId: process.pid },
            timing: { totalMs, phasesMs },
            movement: {
                bulk: {
                    rows: numberMetric(sourceMetrics, "bulk_rows"),
                    bytes: numberMetric(sourceMetrics, "bulk_bytes"),
                    readBatches: numberMetric(sourceMetrics, "bulk_read_batches"),
                    applyBatches: numberMetric(destinationMetrics, "bulk_apply_batches"),
                },
                capture: {
                    transactionGroups: capture.value.transactions,
                    entries: capture.value.entries,
                    bytes: capture.value.bytes,
                },
                replay: {
                    passes: numberMetric(sourceMetrics, "tail_read_batches"),
                    readBatches: numberMetric(sourceMetrics, "tail_read_batches"),
                    applyBatches: numberMetric(destinationMetrics, "tail_apply_batches"),
                    transactionGroups: numberMetric(destinationMetrics, "tail_groups"),
                    entries: numberMetric(destinationMetrics, "tail_entries"),
                    bytes: numberMetric(destinationMetrics, "tail_bytes"),
                },
                drain: {
                    rows: numberMetric(sourceMetrics, "drain_rows"),
                    batches: numberMetric(sourceMetrics, "drain_batches"),
                },
            },
            correctness: {
                organizationAuthorized: true,
                freshDestination: true,
                schemaIdentity: true,
                bulkCursorResumed: true,
                tailTransactionOrder: true,
                tailOrder: {
                    sentinelId: "child-0000",
                    expectedFinalBody: orderedSentinelBody,
                    sourceBeforeDrain: beforeDrain.source.orderedSentinelBody,
                    destinationAfterReplay: beforeDrain.destination.orderedSentinelBody,
                    destinationAfterRestart: verify.value.destination.orderedSentinelBody,
                },
                fenceActivated: numberMetric(sourceMetrics, "fence_micros") > 0,
                cutoverActivated: verify.value.route?.schemaEpoch === prepare.value.route.schemaEpoch + 1,
                sourceDrained: verify.value.source?.rows === 0,
                staleRoute: {
                    typedError: "CDB_STALE_EPOCH",
                    attempts: stale.attempts,
                    sameMutationId: true,
                    committedOnce: verify.value.destinationMutationCount === 1,
                },
                live: { reason: mustRefetch.reason, mustRefetch: true, snapshotConverged: true },
                restart: {
                    phase: "bulk",
                    afterAppliedBatches: RESTART_AFTER_APPLIES,
                    coldProcess: firstInstance !== secondInstance,
                    cursorPersisted: true,
                    resumed: numberMetric(destinationMetrics, "bulk_apply_batches") > RESTART_AFTER_APPLIES,
                    noDuplicateRows: verify.value.destination?.rows === 5_120,
                },
                digests: {
                    algorithm: "sha256",
                    canonicalEncoding: "table-pk-json-v1",
                    sourceBeforeDrain: beforeDrain.source.digest,
                    destinationAfterCutover: beforeDrain.destination.digest,
                    destinationAfterRestart: verify.value.destination.digest,
                },
            },
        };
        return assertReshardBenchmarkSample(sample, {
            sequence: options.sequence,
            candidateSha256: options.candidateSha256,
            target,
        });
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        if (socket) await closeSocket(socket).catch(() => {});
        if (first) await first.stop().catch(() => {});
        if (second) await second.stop().catch(() => {});
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        await rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
        void failure;
    }
}

if (import.meta.main) {
    try {
        const options = parseNativeReshardProducerArgs(process.argv.slice(2));
        const sample = await produceNativeReshardBenchmarkSample(options);
        process.stdout.write(`${JSON.stringify(sample)}\n`);
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? (Reflect.get(error, "detail") ?? error.stack ?? error.message) : String(error)}\n`
        );
        process.exitCode = 2;
    }
}
