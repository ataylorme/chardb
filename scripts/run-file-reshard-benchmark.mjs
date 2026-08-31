import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
    FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
    assertFileReshardBenchmarkSample,
    createFileReshardBenchmarkReport,
    fileReshardBenchmarkProfile,
    summarizeFileReshardBenchmarkSamples,
} from "./file-reshard-benchmark-report.mjs";

const DEFAULT_TIMEOUT_MS = 180_000;

function value(argv, flag) {
    const indices = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
    if (indices.length > 1) throw new Error(`${flag} may be supplied only once`);
    if (indices.length === 0) return undefined;
    const result = argv[indices[0] + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

export function parseFileReshardBenchmarkArgs(argv) {
    const valueFlags = new Set(["--producer", "--output-dir", "--profile", "--timeout-ms"]);
    const allowed = new Set([...valueFlags, "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument))
            throw new Error(`unknown file reshard benchmark argument ${JSON.stringify(argument)}`);
        if (valueFlags.has(argument)) index++;
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const profileName = value(argv, "--profile") ?? "small";
    fileReshardBenchmarkProfile(profileName);
    const timeoutText = value(argv, "--timeout-ms");
    const timeoutMs = timeoutText === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutText);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
        throw new Error("--timeout-ms must be an integer from 1000 through 1800000");
    }
    const producer = value(argv, "--producer");
    const outputDir = value(argv, "--output-dir");
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

export function fileReshardBenchmarkRunPlan(profileName) {
    const profile = fileReshardBenchmarkProfile(profileName);
    return [
        { sequence: -1, excluded: true, filename: "warmup.json" },
        ...Array.from({ length: profile.logicalRuns }, (_, sequence) => ({
            sequence,
            excluded: false,
            filename: `sample-${sequence}.json`,
        })),
    ];
}

export function fileReshardBenchmarkProducerArgs(producer, run, profileName) {
    return [producer, "--profile", profileName, "--sequence", String(run.sequence), "--excluded", String(run.excluded)];
}

async function defaultSpawnProducer(input) {
    const child = Bun.spawn(
        [process.execPath, ...fileReshardBenchmarkProducerArgs(input.producer, input.run, input.profileName)],
        {
            cwd: input.cwd,
            env: { ...process.env, CDB_FILE_RESHARD_BENCHMARK_OUTPUT: "json" },
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
        throw new Error(`file reshard benchmark producer timed out for sequence ${input.run.sequence}`);
    }
    clearTimeout(timer);
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (outcome !== 0) throw new Error(`file reshard benchmark producer failed: ${stderr.trim()}`);
    try {
        return JSON.parse(stdout);
    } catch (error) {
        throw new Error("file reshard benchmark producer returned invalid JSON", { cause: error });
    }
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function writeJsonAtomic(file, value) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
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

export async function runFileReshardBenchmark(options) {
    const profile = fileReshardBenchmarkProfile(options.profileName ?? "small");
    const spawnProducer = options.spawnProducer ?? defaultSpawnProducer;
    await access(options.producer);
    await mkdir(options.outputDir);
    const rawDir = path.join(options.outputDir, "raw-v1");
    await mkdir(rawDir);
    const startedAt = new Date().toISOString();
    const admitted = [];
    let targetJson;
    for (const run of fileReshardBenchmarkRunPlan(profile.name)) {
        const sample = assertFileReshardBenchmarkSample(
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
        if (targetJson !== undefined && targetJson !== currentTarget)
            throw new Error("benchmark target drifted between runs");
        targetJson ??= currentTarget;
        await writeJsonAtomic(path.join(rawDir, run.filename), sample);
        admitted.push(sample);
    }
    const [warmup, ...samples] = admitted;
    const report = createFileReshardBenchmarkReport({
        ok: true,
        workload: {
            id: FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
            version: FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
            profile,
        },
        runner: {
            runtime: { name: "bun", version: Bun.version },
            machine: machineIdentity(),
            processIsolation: "fresh-process-and-miniflare-per-run",
        },
        execution: { startedAt, completedAt: new Date().toISOString(), processId: process.pid },
        warmup,
        samples,
        aggregate: summarizeFileReshardBenchmarkSamples(samples, profile.name),
    });
    await writeJsonAtomic(path.join(options.outputDir, "report.json"), report);
    const evidenceFiles = [
        "report.json",
        ...fileReshardBenchmarkRunPlan(profile.name).map(run => `raw-v1/${run.filename}`),
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
        "Usage: bun scripts/run-file-reshard-benchmark.mjs [options]",
        "",
        "  --producer <path>    native Miniflare sample producer",
        "  --output-dir <path>  new evidence directory",
        "  --profile <name>     small (default), medium, or large",
        "  --timeout-ms <ms>    per-process timeout, default 180000",
        "",
        "CI should run the small profile. Medium and large are opt-in scale evidence.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const args = parseFileReshardBenchmarkArgs(process.argv.slice(2));
        if (args.help) console.log(usage());
        else {
            const report = await runFileReshardBenchmark(args);
            console.log(JSON.stringify(report.aggregate, null, 2));
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
