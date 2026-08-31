import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID,
    PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION,
    assertPublicVectorBenchmarkSample,
    createPublicVectorBenchmarkReport,
    publicVectorBenchmarkProfile,
    summarizePublicVectorBenchmarkSamples,
} from "./public-vector-benchmark-report.mjs";

const DEFAULT_TIMEOUT_MS = 180_000;

function option(argv, flag) {
    const positions = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (positions.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (positions.length === 0) return undefined;
    const value = argv[positions[0] + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
}

export function parsePublicVectorBenchmarkArgs(argv) {
    const valueFlags = new Set(["--producer", "--output-dir", "--profile", "--timeout-ms"]);
    const allowed = new Set([...valueFlags, "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument))
            throw new Error(`unknown public vector benchmark argument ${JSON.stringify(argument)}`);
        if (valueFlags.has(argument)) index++;
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const profileName = option(argv, "--profile") ?? "ci";
    publicVectorBenchmarkProfile(profileName);
    const timeoutText = option(argv, "--timeout-ms");
    const timeoutMs = timeoutText === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutText);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
        throw new Error("--timeout-ms must be an integer from 1000 through 1800000");
    }
    const producer = option(argv, "--producer");
    const outputDir = option(argv, "--output-dir");
    if (!help && !producer) throw new Error("--producer is required");
    if (!help && !outputDir) throw new Error("--output-dir is required");
    return {
        help,
        profileName,
        timeoutMs,
        producer: producer && path.resolve(producer),
        outputDir: outputDir && path.resolve(outputDir),
    };
}

export function publicVectorBenchmarkRunPlan(profileName) {
    const profile = publicVectorBenchmarkProfile(profileName);
    return [
        { sequence: -1, excluded: true, filename: "warmup.json" },
        ...Array.from({ length: profile.logicalRuns }, (_, sequence) => ({
            sequence,
            excluded: false,
            filename: `sample-${sequence}.json`,
        })),
    ];
}

export function publicVectorBenchmarkProducerArgs(producer, run, profileName) {
    return [producer, "--profile", profileName, "--sequence", String(run.sequence), "--excluded", String(run.excluded)];
}

async function defaultSpawnProducer(input) {
    const child = Bun.spawn(
        [process.execPath, ...publicVectorBenchmarkProducerArgs(input.producer, input.run, input.profileName)],
        {
            cwd: input.cwd,
            env: { ...process.env, CDB_PUBLIC_VECTOR_BENCHMARK_OUTPUT: "json" },
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
    });
    const outcome = await Promise.race([child.exited, timeout]);
    if (outcome === "timeout") {
        child.kill("SIGTERM");
        await child.exited;
        throw new Error(`public vector benchmark producer timed out for sequence ${input.run.sequence}`);
    }
    clearTimeout(timer);
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (outcome !== 0) throw new Error(`public vector benchmark producer failed: ${stderr.trim()}`);
    try {
        return JSON.parse(stdout);
    } catch (error) {
        throw new Error("public vector benchmark producer returned invalid JSON", { cause: error });
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

async function writeJsonAtomic(file, value) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

export async function runPublicVectorBenchmark(options) {
    const profile = publicVectorBenchmarkProfile(options.profileName ?? "ci");
    const spawnProducer = options.spawnProducer ?? defaultSpawnProducer;
    await access(options.producer);
    await mkdir(options.outputDir);
    const rawDir = path.join(options.outputDir, "raw-v1");
    await mkdir(rawDir);
    const startedAt = new Date().toISOString();
    const admitted = [];
    let targetIdentity;
    for (const run of publicVectorBenchmarkRunPlan(profile.name)) {
        const sample = assertPublicVectorBenchmarkSample(
            await spawnProducer({
                producer: options.producer,
                cwd: options.cwd ?? path.dirname(options.producer),
                run,
                profileName: profile.name,
                timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            }),
            { sequence: run.sequence, profile: profile.name }
        );
        const currentTarget = JSON.stringify(sample.target);
        if (targetIdentity !== undefined && targetIdentity !== currentTarget) {
            throw new Error("public vector benchmark target drifted between runs");
        }
        targetIdentity ??= currentTarget;
        await writeJsonAtomic(path.join(rawDir, run.filename), sample);
        admitted.push(sample);
    }
    const [warmup, ...samples] = admitted;
    const report = createPublicVectorBenchmarkReport({
        ok: true,
        workload: {
            id: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_ID,
            version: PUBLIC_VECTOR_BENCHMARK_WORKLOAD_VERSION,
            profile,
        },
        runner: {
            runtime: { name: "bun", version: Bun.version },
            machine: machineIdentity(),
            processIsolation: "fresh-process-and-runtime-per-run",
        },
        execution: { startedAt, completedAt: new Date().toISOString(), processId: process.pid },
        warmup,
        samples,
        aggregate: summarizePublicVectorBenchmarkSamples(samples, profile.name),
    });
    await writeJsonAtomic(path.join(options.outputDir, "report.json"), report);
    const evidenceFiles = [
        "report.json",
        ...publicVectorBenchmarkRunPlan(profile.name).map(run => `raw-v1/${run.filename}`),
    ];
    const manifest = [];
    for (const relative of evidenceFiles) {
        manifest.push(`${sha256(await readFile(path.join(options.outputDir, relative)))}  ${relative}`);
    }
    await writeFile(path.join(options.outputDir, "evidence.sha256"), `${manifest.join("\n")}\n`, "utf8");
    return report;
}

function usage() {
    return [
        "Usage: bun scripts/run-public-vector-benchmark.mjs [options]",
        "",
        "  --producer <path>      sample producer",
        "  --output-dir <path>    new evidence directory",
        "  --profile <name>       ci (default), standard, or large",
        "  --timeout-ms <ms>      per-process timeout, default 180000",
        "",
        "The runner validates each raw sample and writes a digest manifest. All results are local Miniflare with a fake vector index.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const args = parsePublicVectorBenchmarkArgs(process.argv.slice(2));
        if (args.help) console.log(usage());
        else console.log(JSON.stringify((await runPublicVectorBenchmark(args)).aggregate, null, 2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
