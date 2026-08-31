import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { vshardOf } from "../src/vshard.ts";
import {
    FILE_RESHARD_BENCHMARK_PHASES,
    FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA,
    FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
    FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
    assertFileReshardBenchmarkSample,
    fileReshardBenchmarkProfile,
} from "./file-reshard-benchmark-report.mjs";
import { disposeMiniflareBounded } from "./miniflare-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "test", "workerd", "file-reshard-e2e.entry.ts");
const COMPATIBILITY_DATE = "2026-08-06";
const SOURCE = "ShardDO_0";
const TERMINAL_PHASE = 6;

function value(argv, flag) {
    const indices = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (indices.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (indices.length === 0) return undefined;
    const result = argv[indices[0] + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

export function parseNativeFileReshardProducerArgs(argv) {
    const allowed = new Set(["--profile", "--sequence", "--excluded"]);
    for (let index = 0; index < argv.length; index += 2) {
        if (!allowed.has(argv[index])) throw new Error(`unknown producer argument ${JSON.stringify(argv[index])}`);
        if (argv[index + 1] === undefined) throw new Error(`${argv[index]} requires a value`);
    }
    const profile = fileReshardBenchmarkProfile(value(argv, "--profile"));
    const sequence = Number(value(argv, "--sequence"));
    if (!Number.isSafeInteger(sequence) || sequence < -1 || sequence >= profile.logicalRuns) {
        throw new Error("--sequence is outside the profile run plan");
    }
    const excludedText = value(argv, "--excluded");
    if (excludedText !== "true" && excludedText !== "false") throw new Error("--excluded must be true or false");
    const excluded = excludedText === "true";
    if (excluded !== (sequence === -1)) throw new Error("--excluded does not identify the warmup sequence");
    return { profile, sequence, excluded };
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

async function packageVersion(file) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (typeof manifest.version !== "string" || manifest.version.length === 0)
        throw new Error(`${file} has no version`);
    return manifest.version;
}

async function runtimeIdentity() {
    const wranglerRoot = path.join(ROOT, "node_modules", "wrangler");
    return {
        workerd: await packageVersion(path.join(wranglerRoot, "node_modules", "workerd", "package.json")),
        miniflare: await packageVersion(path.join(wranglerRoot, "node_modules", "miniflare", "package.json")),
        compatibilityDate: COMPATIBILITY_DATE,
    };
}

async function bundleFixture() {
    const bundlePath = await mkdtemp(path.join(tmpdir(), `chardb-file-reshard-bundle-${process.pid}-`));
    try {
        const output = path.join(bundlePath, "worker.mjs");
        const child = Bun.spawn(
            [
                "bun",
                "build",
                ENTRY,
                "--target=browser",
                "--format=esm",
                "--external=cloudflare:workers",
                "--outfile",
                output,
            ],
            { cwd: ROOT, stdout: "ignore", stderr: "pipe" }
        );
        const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        if (exitCode !== 0) throw new Error(`file reshard fixture bundle failed: ${stderr}`);
        const source = (await readFile(output, "utf8"))
            .replace(
                "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
                'await Promise.reject(new Error("file migrations are unavailable in workerd"))'
            )
            .replace(
                "await import(nodeSqlite)",
                'await Promise.reject(new Error("node:sqlite is unavailable in workerd"))'
            );
        if (source.includes("import(")) throw new Error("file reshard benchmark bundle contains a dynamic import");
        return source;
    } finally {
        await rm(bundlePath, { recursive: true, force: true });
    }
}

async function createRuntime(workerSource, persistencePath) {
    const runtime = new Miniflare({
        name: "file-reshard-e2e",
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
        },
        durableObjectsPersist: path.join(persistencePath, "durable-objects"),
        r2Buckets: ["CDB_FILES"],
        r2Persist: path.join(persistencePath, "r2"),
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
    });
    await runtime.ready;
    return runtime;
}

async function call(runtime, operation, body = {}) {
    const response = await runtime.dispatchFetch(`http://example.com/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${operation} returned ${response.status}: ${JSON.stringify(result)}`);
    return result;
}

function placement(organizationId) {
    return Number(vshardOf([organizationId]));
}

function colocatedOrganizations(prefix) {
    let first;
    for (let index = 0; index < 200_000 && first === undefined; index++) first = `${prefix}-${index}`;
    const target = placement(first);
    const organizations = [first];
    for (let index = 200_000; organizations.length < 3 && index < 600_000; index++) {
        const candidate = `${prefix}-${index}`;
        if (placement(candidate) === target) organizations.push(candidate);
    }
    if (organizations.length !== 3) throw new Error("could not find three colocated benchmark organizations");
    return organizations;
}

function fileId(sequence) {
    return `fil_${sequence.toString(16).padStart(64, "0")}`;
}

async function seedExtraFiles(runtime, setup, profile, migId) {
    const keys = setup.seeded.map(item => item.objectKey);
    const organizationId = setup.snapshotOrg;
    for (let start = 3; start < profile.files; start += 16) {
        const batch = [];
        for (let index = start; index < Math.min(profile.files, start + 16); index++) {
            batch.push(
                call(runtime, "seedFile", {
                    shardId: SOURCE,
                    organizationId,
                    rowId: `benchmark-row-${migId}-${index}`,
                    fileId: fileId(index + 1),
                    fileBody: `body-${String(index).padStart(8, "0")}`,
                })
            );
        }
        const seeded = await Promise.all(batch);
        for (const item of seeded) keys.push(item.objectKey);
    }
    return keys;
}

function r2Identity(objects) {
    const normalized = [...objects]
        .map(object => ({
            key: object.key,
            present: object.present,
            size: object.size,
            etag: object.etag,
            uploaded: object.uploaded,
            customMetadata: object.customMetadata,
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
    if (normalized.some(object => object.present !== true)) throw new Error("benchmark R2 object is missing");
    return {
        objects: normalized.length,
        bytes: normalized.reduce((sum, object) => sum + object.size, 0),
        digest: sha256(JSON.stringify(normalized)),
    };
}

async function measured(callback) {
    const started = performance.now();
    const result = await callback();
    return { result, ms: performance.now() - started };
}

function phaseBucket(state) {
    if (state.phase === 0) return "init";
    if (state.phase === 1) return state.state?.files?.copy_done === 1 ? "bulk" : "snapshot";
    if (state.phase === 2) return "converge";
    if (state.phase === 3) return "barrierValidateCutover";
    if (state.phase === 4) return "drain";
    if (state.phase === 5) return "finish";
    throw new Error(`cannot classify benchmark phase ${state.phase}`);
}

async function phaseState(runtime, migId) {
    return call(runtime, "phase", { migId });
}

async function evictMovementObjects(runtime, destination) {
    await runtime.unsafeEvictDurableObject("file-reshard-e2e", "Cdb", { name: SOURCE });
    await runtime.unsafeEvictDurableObject("file-reshard-e2e", "Cdb", { name: destination });
    await runtime.unsafeEvictDurableObject("file-reshard-e2e", "Resharder", { name: "global" });
    await runtime.unsafeEvictDurableObject("file-reshard-e2e", "Catalog", { name: "global" });
}

export async function produceNativeFileReshardBenchmarkSample(options) {
    const startedAt = new Date().toISOString();
    const totalStarted = performance.now();
    const workerSource = await bundleFixture();
    const configurationSha256 = sha256(
        `${workerSource}\n${JSON.stringify({ compatibilityDate: COMPATIBILITY_DATE, sqlite: true, r2: true })}`
    );
    const persistencePath = await mkdtemp(path.join(tmpdir(), `chardb-file-reshard-bench-${process.pid}-`));
    let runtime;
    try {
        runtime = await createRuntime(workerSource, persistencePath);
        const profile = options.profile;
        const suffix = `${profile.name}-${options.sequence + 1}`;
        const organizationIds = colocatedOrganizations(`file-reshard-bench-${suffix}`);
        const migId = `file_reshard_bench_${profile.name}_${options.sequence + 1}`;
        const destination = `ShardDO_file_bench_${profile.name}_${options.sequence + 1}`;
        const phasesMs = Object.fromEntries(FILE_RESHARD_BENCHMARK_PHASES.map(phase => [phase, 0]));
        const observedPhases = [];
        const observePhase = state => {
            if (!Number.isSafeInteger(state.phase) || state.phase < 0 || state.phase > TERMINAL_PHASE) {
                throw new Error(`file reshard benchmark observed invalid phase ${JSON.stringify(state.phase)}`);
            }
            const previous = observedPhases.at(-1);
            if (previous !== undefined && state.phase < previous) {
                throw new Error(`file reshard benchmark phase regressed from ${previous} to ${state.phase}`);
            }
            if (state.phase !== previous) observedPhases.push(state.phase);
            return state;
        };
        const setupMeasured = await measured(async () => {
            const setup = await call(runtime, "setup", { migId, destination, organizationIds });
            const keys = await seedExtraFiles(runtime, setup, profile, migId);
            return { setup, keys };
        });
        phasesMs.setup = setupMeasured.ms;
        const { keys } = setupMeasured.result;
        const beforeObjects = await call(runtime, "r2", { keys });
        const beforeR2 = r2Identity(beforeObjects);
        if (beforeR2.objects !== profile.files) throw new Error("seeded file count does not match benchmark profile");

        let turns = 0;
        let state = observePhase(await phaseState(runtime, migId));
        while (state.phase !== 1) {
            const bucket = phaseBucket(state);
            const turn = await measured(() => call(runtime, "run", { migId }));
            phasesMs[bucket] += turn.ms;
            turns++;
            state = observePhase(await phaseState(runtime, migId));
        }
        const firstSnapshot = await measured(() => call(runtime, "run", { migId }));
        phasesMs.snapshot += firstSnapshot.ms;
        turns++;
        const beforeRestart = observePhase(await phaseState(runtime, migId));
        const dispose = await measured(() => evictMovementObjects(runtime, destination));
        const cold = await measured(() => phaseState(runtime, migId).then(observePhase));
        if (JSON.stringify(cold.result.state?.files) !== JSON.stringify(beforeRestart.state?.files)) {
            throw new Error("file reshard cursor changed across cold restart");
        }
        const resumeState = cold.result;
        const resumeBucket = phaseBucket(resumeState);
        const resume = await measured(() => call(runtime, "run", { migId }));
        phasesMs[resumeBucket] += resume.ms;
        turns++;

        state = observePhase(await phaseState(runtime, migId));
        let unchanged = 0;
        let prior = "";
        while (state.phase !== TERMINAL_PHASE) {
            const signature = JSON.stringify(state);
            unchanged = signature === prior ? unchanged + 1 : 0;
            if (unchanged >= 64) throw new Error("file reshard benchmark made no durable progress for 64 turns");
            prior = signature;
            const bucket = phaseBucket(state);
            const turn = await measured(() => call(runtime, "run", { migId }));
            phasesMs[bucket] += turn.ms;
            turns++;
            if (turns > 4_096) throw new Error("file reshard benchmark exceeded 4096 bounded turns");
            state = observePhase(await phaseState(runtime, migId));
        }

        const verify = await measured(async () => {
            const finalState = await call(runtime, "state", { migId, destination, organizationIds });
            const afterObjects = await call(runtime, "r2", { keys });
            return { finalState, afterR2: r2Identity(afterObjects) };
        });
        phasesMs.verify = verify.ms;
        const { finalState, afterR2 } = verify.result;
        const r2Stable =
            beforeR2.objects === afterR2.objects &&
            beforeR2.bytes === afterR2.bytes &&
            beforeR2.digest === afterR2.digest;
        if (!r2Stable) throw new Error("R2 object identity changed during file reshard");
        if (finalState.source.files.length !== 0 || finalState.destination.files.length !== profile.files) {
            throw new Error("file metadata did not move exactly once");
        }
        const phaseOrder = JSON.stringify(observedPhases) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]);
        if (!phaseOrder) {
            throw new Error(`file reshard benchmark did not observe every ordered phase: ${observedPhases.join(",")}`);
        }
        const movementMs = ["snapshot", "bulk", "converge", "barrierValidateCutover", "drain", "finish"].reduce(
            (sum, phase) => sum + phasesMs[phase],
            0
        );
        const totalMs = performance.now() - totalStarted;
        const sample = {
            schema: FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA,
            sequence: options.sequence,
            excluded: options.excluded,
            workload: {
                id: FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
                version: FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
                profile,
            },
            target: {
                kind: "local",
                transport: "miniflare-workerd-native",
                runtime: await runtimeIdentity(),
                storage: { durableObjects: true, sqlite: true, r2: true },
                configurationSha256,
            },
            execution: { startedAt, completedAt: new Date().toISOString(), processId: process.pid },
            dataset: {
                organizations: organizationIds.length,
                files: profile.files,
                metadataRows: profile.files,
                objectBytes: beforeR2.bytes,
            },
            timing: { totalMs, phasesMs },
            throughput: {
                filesPerSecond: (profile.files * 1_000) / movementMs,
                metadataRowsPerSecond: (profile.files * 1_000) / movementMs,
            },
            movement: {
                runTurns: turns,
                files: profile.files,
                metadataRows: profile.files,
                r2: {
                    objectsBefore: beforeR2.objects,
                    objectsAfter: afterR2.objects,
                    bytesBefore: beforeR2.bytes,
                    bytesAfter: afterR2.bytes,
                    identityDigestBefore: beforeR2.digest,
                    identityDigestAfter: afterR2.digest,
                    // Full head identity includes bytes, etag, upload time, and custom metadata. Equality
                    // therefore proves the movement path issued no observable object rewrite or delete.
                    writesDuringMove: 0,
                    deletesDuringMove: 0,
                },
            },
            restart: {
                phase: "snapshot",
                disposeMs: dispose.ms,
                coldStartMs: cold.ms,
                resumeMs: resume.ms,
                cursorPersisted: true,
                resumed: true,
            },
            correctness: {
                phaseOrder,
                parity: state.phase === TERMINAL_PHASE && observedPhases.includes(3),
                destinationActivated: finalState.destination.fileSplit?.outcome === "finished",
                sourceDrained: finalState.source.files.length === 0,
                r2Stable,
                sharedBucketNoCopy: r2Stable,
            },
        };
        return assertFileReshardBenchmarkSample(sample, { sequence: options.sequence, profile: profile.name });
    } finally {
        await disposeMiniflareBounded(runtime, { label: "file reshard benchmark final teardown" });
        await rm(persistencePath, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    try {
        const options = parseNativeFileReshardProducerArgs(process.argv.slice(2));
        const sample = await produceNativeFileReshardBenchmarkSample(options);
        process.stdout.write(`${JSON.stringify(sample)}\n`);
    } catch (error) {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exitCode = 2;
    }
}
