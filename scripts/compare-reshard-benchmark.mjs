import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RESHARD_BENCHMARK_PHASES, assertReshardBenchmarkReport } from "./reshard-benchmark-report.mjs";

export const RESHARD_BENCHMARK_COMPARISON_SCHEMA = "chardb.reshard-benchmark.comparison.v1";

function comparableIdentity(report) {
    return {
        candidate: report.candidate,
        workload: report.workload,
        samples: [report.warmup, ...report.samples].map(sample => ({
            sequence: sample.sequence,
            excluded: sample.excluded,
            movement: sample.movement,
            digest: sample.correctness.digests.sourceBeforeDrain,
        })),
    };
}

function ratio(candidate, baseline, label) {
    if (baseline === 0) throw new Error(`${label} has a zero baseline denominator`);
    return candidate / baseline;
}

export function compareReshardBenchmarkReports(localInput, candidateInput) {
    const local = assertReshardBenchmarkReport(localInput);
    const candidate = assertReshardBenchmarkReport(candidateInput);
    if (local.target.kind !== "local") throw new Error("comparison baseline must be local");
    if (!isDeepStrictEqual(comparableIdentity(local), comparableIdentity(candidate))) {
        throw new Error("reshard benchmark reports are not comparable");
    }
    return {
        schema: RESHARD_BENCHMARK_COMPARISON_SCHEMA,
        ratioDirection: `${candidate.target.kind}/local`,
        candidate: structuredClone(local.candidate),
        workload: structuredClone(local.workload),
        baseline: { target: structuredClone(local.target), execution: structuredClone(local.execution) },
        measured: { target: structuredClone(candidate.target), execution: structuredClone(candidate.execution) },
        ratios: {
            totalLatency: {
                p50: ratio(
                    candidate.aggregate.timing.totalMs.p50,
                    local.aggregate.timing.totalMs.p50,
                    "totalLatency.p50"
                ),
                p95: ratio(
                    candidate.aggregate.timing.totalMs.p95,
                    local.aggregate.timing.totalMs.p95,
                    "totalLatency.p95"
                ),
            },
            phases: Object.fromEntries(
                RESHARD_BENCHMARK_PHASES.map(phase => [
                    phase,
                    {
                        p50: ratio(
                            candidate.aggregate.timing.phasesMs[phase].p50,
                            local.aggregate.timing.phasesMs[phase].p50,
                            `${phase}.p50`
                        ),
                        p95: ratio(
                            candidate.aggregate.timing.phasesMs[phase].p95,
                            local.aggregate.timing.phasesMs[phase].p95,
                            `${phase}.p95`
                        ),
                    },
                ])
            ),
            rates: Object.fromEntries(
                Object.keys(local.aggregate.rates).map(metric => [
                    metric,
                    ratio(candidate.aggregate.rates[metric], local.aggregate.rates[metric], `rates.${metric}`),
                ])
            ),
        },
    };
}

export function parseReshardBenchmarkComparisonArgs(argv) {
    const parsed = { help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            parsed.help = true;
            continue;
        }
        if (!["--local", "--candidate", "--output"].includes(argument)) {
            throw new Error(`unknown reshard benchmark comparison argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (!value) throw new Error(`${argument} requires a value`);
        const key = { "--local": "localPath", "--candidate": "candidatePath", "--output": "outputPath" }[argument];
        if (parsed[key] !== undefined) throw new Error(`${argument} may be supplied only once`);
        parsed[key] = path.resolve(value);
    }
    if (!parsed.help) {
        for (const [flag, key] of [
            ["--local", "localPath"],
            ["--candidate", "candidatePath"],
            ["--output", "outputPath"],
        ]) {
            if (parsed[key] === undefined) throw new Error(`${flag} is required`);
        }
    }
    return parsed;
}

export async function compareReshardBenchmarkReportFiles(options) {
    const [local, candidate] = await Promise.all(
        [options.localPath, options.candidatePath].map(async file => JSON.parse(await readFile(file, "utf8")))
    );
    const comparison = compareReshardBenchmarkReports(local, candidate);
    const temporary = `${options.outputPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    await rename(temporary, options.outputPath);
    return comparison;
}

function usage() {
    return [
        "Usage: bun scripts/compare-reshard-benchmark.mjs --local <report> --candidate <report> --output <path>",
        "",
        "Ratios are descriptive. This command applies no release threshold.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseReshardBenchmarkComparisonArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else console.log(JSON.stringify(await compareReshardBenchmarkReportFiles(options)));
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
    }
}
