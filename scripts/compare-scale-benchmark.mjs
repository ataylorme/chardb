import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const REPORT_SCHEMA = "chardb.scale.report.v1";
const COMPARISON_SCHEMA = "chardb.scale.comparison.v1";
const LATENCY_STATISTICS = ["p50", "p95"];
const THROUGHPUT_STATISTICS = ["p50", "minimum"];

function metricStatistics(metricName) {
    return metricName.endsWith("Ms") ? LATENCY_STATISTICS : THROUGHPUT_STATISTICS;
}

function parsePercentage(name, raw) {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
        throw new Error(`${name} must be a number from 0 through 1000`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1_000) {
        throw new Error(`${name} must be a number from 0 through 1000`);
    }
    return value;
}

export function parseComparisonArgs(argv) {
    let baselinePath;
    let candidatePath;
    let outputPath;
    let maxRegressionPercent;
    let help = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (
            argument !== "--baseline" &&
            argument !== "--candidate" &&
            argument !== "--output" &&
            argument !== "--max-regression-percent"
        ) {
            throw new Error(`Unknown scale comparison argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
        if (argument === "--baseline") baselinePath = path.resolve(value);
        else if (argument === "--candidate") candidatePath = path.resolve(value);
        else if (argument === "--output") outputPath = path.resolve(value);
        else maxRegressionPercent = parsePercentage(argument, value);
    }
    if (!help) {
        if (baselinePath === undefined) throw new Error("--baseline is required");
        if (candidatePath === undefined) throw new Error("--candidate is required");
        if (maxRegressionPercent === undefined) throw new Error("--max-regression-percent is required");
    }
    return { help, baselinePath, candidatePath, outputPath, maxRegressionPercent };
}

function validateReport(label, report) {
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
        throw new Error(`${label} report must be an object`);
    }
    if (report.schema !== REPORT_SCHEMA) {
        throw new Error(`${label} report schema must be ${REPORT_SCHEMA}`);
    }
    if (typeof report.suite !== "string" || report.suite.length === 0) {
        throw new Error(`${label} report suite must be nonempty`);
    }
    if (report.run === null || typeof report.run !== "object" || Array.isArray(report.run)) {
        throw new Error(`${label} report run identity must be an object`);
    }
    if (report.run.runtime === null || typeof report.run.runtime !== "object" || Array.isArray(report.run.runtime)) {
        throw new Error(`${label} report runtime identity must be an object`);
    }
    if (report.workload === null || typeof report.workload !== "object" || Array.isArray(report.workload)) {
        throw new Error(`${label} report workload identity must be an object`);
    }
    if (typeof report.workload.suite !== "string" || report.workload.suite.length === 0) {
        throw new Error(`${label} report workload suite must be nonempty`);
    }
    if (report.workload.id !== report.suite) {
        throw new Error(`${label} report workload id must match its report suite`);
    }
    if (report.profile === null || typeof report.profile !== "object" || Array.isArray(report.profile)) {
        throw new Error(`${label} report profile must be an object`);
    }
    if (!Number.isSafeInteger(report.samples) || report.samples < 1) {
        throw new Error(`${label} report samples must be a positive integer`);
    }
    if (!Number.isSafeInteger(report.records) || report.records < 1) {
        throw new Error(`${label} report records must be a positive integer`);
    }
    if (!Array.isArray(report.summaries) || report.summaries.length === 0) {
        throw new Error(`${label} report summaries must be nonempty`);
    }
    const scenarios = new Map();
    for (const summary of report.summaries) {
        if (summary === null || typeof summary !== "object" || typeof summary.scenario !== "string") {
            throw new Error(`${label} report has an invalid scenario summary`);
        }
        if (scenarios.has(summary.scenario)) {
            throw new Error(`${label} report repeats scenario ${summary.scenario}`);
        }
        if (summary.sampleCount !== report.samples) {
            throw new Error(
                `${label} report scenario ${summary.scenario} sampleCount must equal report samples ${report.samples}`
            );
        }
        if (summary.metrics === null || typeof summary.metrics !== "object" || Array.isArray(summary.metrics)) {
            throw new Error(`${label} report scenario ${summary.scenario} metrics must be an object`);
        }
        const metrics = new Map();
        for (const [metricName, statistics] of Object.entries(summary.metrics)) {
            if (!metricName.endsWith("Ms") && !metricName.endsWith("PerSecond")) {
                throw new Error(`${label} report metric ${summary.scenario}.${metricName} has no comparison direction`);
            }
            if (statistics === null || typeof statistics !== "object" || Array.isArray(statistics)) {
                throw new Error(`${label} report metric ${summary.scenario}.${metricName} must be an object`);
            }
            const values = {};
            for (const statistic of metricStatistics(metricName)) {
                const value = statistics[statistic];
                if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
                    throw new Error(
                        `${label} report metric ${summary.scenario}.${metricName}.${statistic} must be a finite non-negative number`
                    );
                }
                values[statistic] = value;
            }
            metrics.set(metricName, values);
        }
        if (metrics.size === 0) throw new Error(`${label} report scenario ${summary.scenario} has no metrics`);
        scenarios.set(summary.scenario, metrics);
    }
    if (!Array.isArray(report.workload.scenarios)) {
        throw new Error(`${label} report workload scenarios must be an array`);
    }
    const workloadScenarios = [...report.workload.scenarios].sort();
    if (!isDeepStrictEqual(workloadScenarios, sortedKeys(scenarios))) {
        throw new Error(`${label} report workload scenarios must match its scenario summaries`);
    }
    if (!isDeepStrictEqual(report.workload.profile, report.profile)) {
        throw new Error(`${label} report workload profile must match its report profile`);
    }
    const expectedRecords = report.samples * scenarios.size;
    if (report.records !== expectedRecords) {
        throw new Error(`${label} report records must equal samples times scenarios (${expectedRecords})`);
    }
    return { scenarios, runtime: report.run.runtime, workload: report.workload };
}

function sortedKeys(map) {
    return [...map.keys()].sort();
}

function requireSameKeys(label, baseline, candidate) {
    const baselineKeys = sortedKeys(baseline);
    const candidateKeys = sortedKeys(candidate);
    if (!isDeepStrictEqual(baselineKeys, candidateKeys)) {
        throw new Error(
            `${label} differ; baseline has ${baselineKeys.join(", ")}, candidate has ${candidateKeys.join(", ")}`
        );
    }
    return baselineKeys;
}

function rounded(value) {
    return Number(value.toFixed(4));
}

function compareValue(baseline, candidate, lowerIsBetter, maxRegressionPercent) {
    if (baseline === 0) {
        const regressed = lowerIsBetter && candidate > 0;
        return {
            regressionPercent: null,
            passed: !regressed,
            reason: regressed ? "baseline-zero" : "no-regression-from-zero",
        };
    }
    const regressionPercent = lowerIsBetter
        ? ((candidate - baseline) / baseline) * 100
        : ((baseline - candidate) / baseline) * 100;
    return {
        regressionPercent: rounded(regressionPercent),
        passed: regressionPercent <= maxRegressionPercent,
    };
}

function runIdentity(report) {
    return {
        id: report.run?.id ?? "unknown",
        gitSha: report.run?.gitSha ?? "unknown",
        samples: report.samples,
        runtime: report.run?.runtime,
        workload: report.workload,
    };
}

export function compareScaleReports(baselineReport, candidateReport, maxRegressionPercent) {
    if (typeof maxRegressionPercent !== "number" || !Number.isFinite(maxRegressionPercent)) {
        throw new Error("maxRegressionPercent must be a finite number from 0 through 1000");
    }
    if (maxRegressionPercent < 0 || maxRegressionPercent > 1_000) {
        throw new Error("maxRegressionPercent must be a finite number from 0 through 1000");
    }
    const baseline = validateReport("Baseline", baselineReport);
    const candidate = validateReport("Candidate", candidateReport);
    if (baselineReport.suite !== candidateReport.suite) {
        throw new Error(`Report suites differ: ${baselineReport.suite} and ${candidateReport.suite}`);
    }
    if (!isDeepStrictEqual(baselineReport.profile, candidateReport.profile)) {
        throw new Error("Report profiles differ; collect both runs with the same named profile and values");
    }
    if (baselineReport.samples !== candidateReport.samples) {
        throw new Error(
            `Report sample counts differ: baseline has ${baselineReport.samples}, candidate has ${candidateReport.samples}`
        );
    }
    if (!isDeepStrictEqual(baseline.workload, candidate.workload)) {
        throw new Error(
            "Report workload identities differ; collect both runs with the same suite and workload profile"
        );
    }
    if (!isDeepStrictEqual(baseline.runtime, candidate.runtime)) {
        throw new Error("Report runtime identities differ; collect both runs on the same named runner and runtime");
    }

    const comparisons = [];
    for (const scenario of requireSameKeys("Report scenarios", baseline.scenarios, candidate.scenarios)) {
        const baselineMetrics = baseline.scenarios.get(scenario);
        const candidateMetrics = candidate.scenarios.get(scenario);
        for (const metric of requireSameKeys(`Scenario ${scenario} metrics`, baselineMetrics, candidateMetrics)) {
            const lowerIsBetter = metric.endsWith("Ms");
            for (const statistic of metricStatistics(metric)) {
                const baseline = baselineMetrics.get(metric)[statistic];
                const candidate = candidateMetrics.get(metric)[statistic];
                comparisons.push({
                    scenario,
                    metric,
                    statistic,
                    direction: lowerIsBetter ? "lower-is-better" : "higher-is-better",
                    baseline,
                    candidate,
                    ...compareValue(baseline, candidate, lowerIsBetter, maxRegressionPercent),
                });
            }
        }
    }
    const regressions = comparisons.filter(comparison => !comparison.passed);
    return {
        schema: COMPARISON_SCHEMA,
        suite: candidateReport.suite,
        profile: candidateReport.profile,
        threshold: { maxRegressionPercent },
        baseline: runIdentity(baselineReport),
        candidate: runIdentity(candidateReport),
        summary: {
            comparisons: comparisons.length,
            regressions: regressions.length,
            passed: regressions.length === 0,
        },
        comparisons,
    };
}

async function readJson(file) {
    const source = await readFile(file, "utf8");
    try {
        return JSON.parse(source);
    } catch (error) {
        throw new Error(`Could not parse JSON report ${file}`, { cause: error });
    }
}

async function writeJsonAtomic(file, value) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
}

export async function compareScaleReportFiles(options) {
    const [baseline, candidate] = await Promise.all([readJson(options.baselinePath), readJson(options.candidatePath)]);
    const comparison = compareScaleReports(baseline, candidate, options.maxRegressionPercent);
    if (options.outputPath !== undefined) await writeJsonAtomic(options.outputPath, comparison);
    return comparison;
}

function usage() {
    return [
        "Usage: bun scripts/compare-scale-benchmark.mjs [options]",
        "",
        "  --baseline <path>                 baseline report.json",
        "  --candidate <path>                candidate report.json",
        "  --max-regression-percent <value>  allowed p50 and tail regression, 0-1000",
        "  --output <path>                   optional comparison JSON artifact",
        "  --help                            show this help",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseComparisonArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else {
            const comparison = await compareScaleReportFiles(options);
            console.log(JSON.stringify(comparison));
            if (!comparison.summary.passed) process.exitCode = 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
    }
}
