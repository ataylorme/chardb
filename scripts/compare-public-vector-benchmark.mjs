import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertPublicVectorBenchmarkReport } from "./public-vector-benchmark-report.mjs";

export const PUBLIC_VECTOR_BENCHMARK_COMPARISON_SCHEMA = "chardb.public-vector-benchmark.comparison.v1";

function ratio(candidate, baseline, label) {
    if (baseline === 0) throw new Error(`${label} has a zero baseline denominator`);
    return candidate / baseline;
}

function comparableWorkload(report) {
    return report.workload;
}

export function comparePublicVectorBenchmarkReports(baselineInput, candidateInput, budgets = {}) {
    const baseline = assertPublicVectorBenchmarkReport(baselineInput);
    const candidate = assertPublicVectorBenchmarkReport(candidateInput);
    if (!isDeepStrictEqual(comparableWorkload(baseline), comparableWorkload(candidate))) {
        throw new Error("public vector benchmark reports are not comparable");
    }
    const maxLatencyRatio = budgets.maxLatencyRatio;
    const minThroughputRatio = budgets.minThroughputRatio;
    if (maxLatencyRatio !== undefined && (!Number.isFinite(maxLatencyRatio) || maxLatencyRatio <= 0)) {
        throw new Error("maxLatencyRatio must be a finite positive number");
    }
    if (minThroughputRatio !== undefined && (!Number.isFinite(minThroughputRatio) || minThroughputRatio <= 0)) {
        throw new Error("minThroughputRatio must be a finite positive number");
    }
    const scenarios = baseline.aggregate.scenarios.map((baselineScenario, index) => {
        const candidateScenario = candidate.aggregate.scenarios[index];
        const latency = Object.fromEntries(
            Object.keys(baselineScenario.latencyMs).map(metric => [
                metric,
                Object.fromEntries(
                    ["p50", "p95", "p99"].map(percentile => [
                        percentile,
                        ratio(
                            candidateScenario.latencyMs[metric][percentile],
                            baselineScenario.latencyMs[metric][percentile],
                            `${baselineScenario.name}.${metric}.${percentile}`
                        ),
                    ])
                ),
            ])
        );
        const throughput = Object.fromEntries(
            Object.keys(baselineScenario.throughput).map(metric => [
                metric,
                Object.fromEntries(
                    ["p50", "p95", "p99"].map(percentile => [
                        percentile,
                        ratio(
                            candidateScenario.throughput[metric][percentile],
                            baselineScenario.throughput[metric][percentile],
                            `${baselineScenario.name}.${metric}.${percentile}`
                        ),
                    ])
                ),
            ])
        );
        return { name: baselineScenario.name, latency, throughput };
    });
    const violations = [];
    for (const scenario of scenarios) {
        if (maxLatencyRatio !== undefined) {
            for (const [metric, values] of Object.entries(scenario.latency)) {
                if (values.p95 > maxLatencyRatio) {
                    violations.push({
                        scenario: scenario.name,
                        metric: `${metric}.p95`,
                        observed: values.p95,
                        budget: maxLatencyRatio,
                    });
                }
            }
        }
        if (minThroughputRatio !== undefined) {
            for (const [metric, values] of Object.entries(scenario.throughput)) {
                if (values.p50 < minThroughputRatio) {
                    violations.push({
                        scenario: scenario.name,
                        metric: `${metric}.p50`,
                        observed: values.p50,
                        budget: minThroughputRatio,
                    });
                }
            }
        }
    }
    return {
        schema: PUBLIC_VECTOR_BENCHMARK_COMPARISON_SCHEMA,
        ratioDirection: "candidate/baseline",
        workload: structuredClone(baseline.workload),
        baseline: { target: structuredClone(baseline.warmup.target), execution: structuredClone(baseline.execution) },
        candidate: {
            target: structuredClone(candidate.warmup.target),
            execution: structuredClone(candidate.execution),
        },
        budgets: { maxLatencyRatio: maxLatencyRatio ?? null, minThroughputRatio: minThroughputRatio ?? null },
        scenarios,
        passed: violations.length === 0,
        violations,
    };
}

function value(argv, flag) {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    if (argv.indexOf(flag, index + 1) !== -1) throw new Error(`${flag} may be supplied only once`);
    const result = argv[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
}

export function parsePublicVectorBenchmarkComparisonArgs(argv) {
    const valueFlags = new Set([
        "--baseline",
        "--candidate",
        "--output",
        "--max-latency-ratio",
        "--min-throughput-ratio",
    ]);
    const allowed = new Set([...valueFlags, "--help", "-h"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument))
            throw new Error(`unknown public vector comparison argument ${JSON.stringify(argument)}`);
        if (valueFlags.has(argument)) index++;
    }
    const help = argv.includes("--help") || argv.includes("-h");
    const baseline = value(argv, "--baseline");
    const candidate = value(argv, "--candidate");
    const output = value(argv, "--output");
    if (!help && (!baseline || !candidate || !output)) {
        throw new Error("--baseline, --candidate, and --output are required");
    }
    const parseBudget = flag => {
        const text = value(argv, flag);
        if (text === undefined) return undefined;
        const number = Number(text);
        if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be a finite positive number`);
        return number;
    };
    return {
        help,
        baselinePath: baseline && path.resolve(baseline),
        candidatePath: candidate && path.resolve(candidate),
        outputPath: output && path.resolve(output),
        maxLatencyRatio: parseBudget("--max-latency-ratio"),
        minThroughputRatio: parseBudget("--min-throughput-ratio"),
    };
}

export async function comparePublicVectorBenchmarkFiles(options) {
    const [baseline, candidate] = await Promise.all(
        [options.baselinePath, options.candidatePath].map(async file => JSON.parse(await readFile(file, "utf8")))
    );
    const comparison = comparePublicVectorBenchmarkReports(baseline, candidate, options);
    const temporary = `${options.outputPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    await rename(temporary, options.outputPath);
    return comparison;
}

function usage() {
    return [
        "Usage: bun scripts/compare-public-vector-benchmark.mjs --baseline <report> --candidate <report> --output <path> [budgets]",
        "",
        "  --max-latency-ratio <n>    fail when a scenario p95 latency ratio exceeds n",
        "  --min-throughput-ratio <n> fail when a scenario p50 throughput ratio is below n",
        "",
        "With no budgets, comparison is descriptive and always passes after evidence validation.",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parsePublicVectorBenchmarkComparisonArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else {
            const comparison = await comparePublicVectorBenchmarkFiles(options);
            console.log(JSON.stringify(comparison, null, 2));
            if (!comparison.passed) process.exitCode = 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
