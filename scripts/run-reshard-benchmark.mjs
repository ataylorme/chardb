import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    RESHARD_BENCHMARK_PROFILE,
    RESHARD_BENCHMARK_WORKLOAD_ID,
    RESHARD_BENCHMARK_WORKLOAD_VERSION,
    assertReshardBenchmarkSample,
    createReshardBenchmarkReport,
    summarizeReshardBenchmarkSamples,
} from "./reshard-benchmark-report.mjs";

const DEFAULT_TIMEOUT_MS = 180_000;

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function value(argv, flag) {
    const positions = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (positions.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (positions.length === 0) return undefined;
    const result = argv[positions[0] + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

export function parseReshardBenchmarkArgs(argv) {
    const allowed = new Set(["--producer", "--candidate", "--output-dir", "--timeout-ms", "--help", "-h"]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!allowed.has(argument)) throw new Error(`unknown reshard benchmark argument ${JSON.stringify(argument)}`);
        if (argument !== "--help" && argument !== "-h") index += 1;
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const timeoutText = value(argv, "--timeout-ms");
    const timeoutMs = timeoutText === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutText);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
        throw new Error("--timeout-ms must be an integer from 1000 through 900000");
    }
    const producer = value(argv, "--producer");
    const candidate = value(argv, "--candidate");
    const outputDir = value(argv, "--output-dir");
    if (!help) {
        if (!producer) throw new Error("--producer is required");
        if (!candidate) throw new Error("--candidate is required");
        if (!outputDir) throw new Error("--output-dir is required");
    }
    return {
        help,
        producer: producer && path.resolve(producer),
        candidate: candidate && path.resolve(candidate),
        outputDir: outputDir && path.resolve(outputDir),
        timeoutMs,
    };
}

export function reshardBenchmarkRunPlan() {
    return [
        { sequence: -1, excluded: true, filename: "warmup.json" },
        ...Array.from({ length: RESHARD_BENCHMARK_PROFILE.logicalRuns }, (_, sequence) => ({
            sequence,
            excluded: false,
            filename: `sample-${sequence}.json`,
        })),
    ];
}

export function reshardBenchmarkProducerArgs(producer, run, candidate, candidateSha256) {
    return [
        producer,
        "--profile",
        RESHARD_BENCHMARK_PROFILE.name,
        "--sequence",
        String(run.sequence),
        "--excluded",
        String(run.excluded),
        "--candidate",
        candidate,
        "--candidate-sha256",
        candidateSha256,
    ];
}

async function defaultSpawnProducer(input) {
    const child = Bun.spawn(
        [
            process.execPath,
            ...reshardBenchmarkProducerArgs(input.producer, input.run, input.candidate, input.candidateSha256),
        ],
        {
            cwd: input.cwd,
            env: { ...process.env, CDB_RESHARD_BENCHMARK_OUTPUT: "json" },
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    let timer;
    const timedOut = new Promise(resolve => {
        timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
    });
    const outcome = await Promise.race([child.exited, timedOut]);
    if (outcome === "timeout") {
        child.kill("SIGTERM");
        await child.exited;
        throw new Error(`reshard benchmark producer timed out for sequence ${input.run.sequence}`);
    }
    clearTimeout(timer);
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (outcome !== 0) {
        throw new Error(`reshard benchmark producer failed for sequence ${input.run.sequence}: ${stderr.trim()}`);
    }
    try {
        return JSON.parse(stdout);
    } catch (error) {
        throw new Error(`reshard benchmark producer returned invalid JSON for sequence ${input.run.sequence}`, {
            cause: error,
        });
    }
}

function machineIdentity() {
    const cpus = os.cpus();
    return {
        platform: os.platform(),
        architecture: os.arch(),
        osRelease: os.release(),
        cpuModel: cpus[0]?.model ?? "unknown",
        logicalCpuCount: cpus.length,
        memoryBytes: os.totalmem(),
    };
}

async function runtimeVersion() {
    return Bun.version;
}

async function writeJsonAtomic(file, value) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
}

export async function runReshardBenchmark(options) {
    const spawnProducer = options.spawnProducer ?? defaultSpawnProducer;
    await Promise.all([access(options.producer), access(options.candidate)]);
    await mkdir(options.outputDir);
    const rawDir = path.join(options.outputDir, "raw-v1");
    await mkdir(rawDir);
    const candidateBytes = await readFile(options.candidate);
    const candidate = { sha256: sha256(candidateBytes), bytes: candidateBytes.byteLength };
    const startedAt = new Date().toISOString();
    const admitted = [];
    let target;
    for (const run of reshardBenchmarkRunPlan()) {
        const sample = await spawnProducer({
            producer: options.producer,
            cwd: options.cwd ?? path.dirname(options.producer),
            run,
            candidate: options.candidate,
            candidateSha256: candidate.sha256,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        assertReshardBenchmarkSample(sample, {
            sequence: run.sequence,
            candidateSha256: candidate.sha256,
            ...(target === undefined ? {} : { target }),
        });
        target ??= structuredClone(sample.target);
        const file = path.join(rawDir, run.filename);
        await writeJsonAtomic(file, sample);
        admitted.push(sample);
    }
    const [warmup, ...samples] = admitted;
    const report = createReshardBenchmarkReport({
        ok: true,
        candidate,
        workload: {
            id: RESHARD_BENCHMARK_WORKLOAD_ID,
            version: RESHARD_BENCHMARK_WORKLOAD_VERSION,
            profile: RESHARD_BENCHMARK_PROFILE,
        },
        target,
        runner: {
            runtime: { name: "bun", version: await runtimeVersion() },
            machine: machineIdentity(),
            processIsolation: "fresh-process-per-run",
        },
        execution: { startedAt, completedAt: new Date().toISOString(), processId: process.pid },
        warmup,
        samples,
        aggregate: summarizeReshardBenchmarkSamples(samples),
    });
    const reportPath = path.join(options.outputDir, "report.json");
    await writeJsonAtomic(reportPath, report);
    const evidenceFiles = ["report.json", ...reshardBenchmarkRunPlan().map(run => `raw-v1/${run.filename}`)];
    const manifest = [];
    for (const relative of evidenceFiles) {
        manifest.push(`${sha256(await readFile(path.join(options.outputDir, relative)))}  ${relative}`);
    }
    await writeFile(path.join(options.outputDir, "evidence.sha256"), `${manifest.join("\n")}\n`, "utf8");
    return report;
}

function usage() {
    return [
        "Usage: bun scripts/run-reshard-benchmark.mjs [options]",
        "",
        "  --producer <path>    native Wrangler/Miniflare sample producer",
        "  --candidate <path>   self-contained worker.js produced by Wrangler dry-run",
        "  --output-dir <path>  new evidence directory; it must not already exist",
        "  --timeout-ms <ms>    per-process timeout, default 180000",
        "",
        "The runner re-hashes and executes the exact candidate with Wrangler --no-bundle in one warmup and five fresh processes.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseReshardBenchmarkArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else console.log(JSON.stringify(await runReshardBenchmark(options)));
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
    }
}
