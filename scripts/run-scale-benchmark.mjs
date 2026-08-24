import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./test-correctness.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT_DIRECTORY = path.join(ROOT, ".chardb", "benchmarks", "latest");
const EXPECTED_SCENARIOS = ["sdk-two-tenant-mutation-fanout", "sdk-selective-subscription-refresh"];
const MAX_SAMPLES = 20;
const WORKFLOW_JOB_BUDGET_MS = 120 * 60_000;
const WORKFLOW_SETUP_RESERVE_MS = 10 * 60_000;
const SAMPLE_PROCESS_OVERHEAD_MS = 60_000;

const PROFILE_FIELDS = {
    clientsPerTenant: { env: "CHARDB_WORKERD_CLIENTS_PER_TENANT", minimum: 1, maximum: 8 },
    mutationsPerTenant: { env: "CHARDB_WORKERD_MUTATIONS_PER_TENANT", minimum: 1, maximum: 1_024 },
    mutationBatch: { env: "CHARDB_WORKERD_MUTATION_BATCH", minimum: 1, maximum: 32 },
    subscriptions: { env: "CHARDB_WORKERD_SUBSCRIPTIONS", minimum: 1, maximum: 64 },
    refreshRounds: { env: "CHARDB_WORKERD_REFRESH_ROUNDS", minimum: 1, maximum: 64 },
    waitMs: { env: "CHARDB_WORKERD_WAIT_MS", minimum: 1_000, maximum: 60_000 },
    testTimeoutMs: { env: "CHARDB_WORKERD_TEST_TIMEOUT_MS", minimum: 5_000, maximum: 300_000 },
};

function frozenProfile(values, defaultSamples) {
    return Object.freeze({ values: Object.freeze(values), defaultSamples });
}

export const SCALE_PROFILES = Object.freeze({
    "ci-smoke": frozenProfile(
        {
            clientsPerTenant: 1,
            mutationsPerTenant: 4,
            mutationBatch: 16,
            subscriptions: 4,
            refreshRounds: 2,
            waitMs: 5_000,
            testTimeoutMs: 30_000,
        },
        1
    ),
    "client-max-accepted": frozenProfile(
        {
            clientsPerTenant: 1,
            mutationsPerTenant: 32,
            mutationBatch: 32,
            subscriptions: 64,
            refreshRounds: 2,
            waitMs: 60_000,
            testTimeoutMs: 300_000,
        },
        3
    ),
    throughput: frozenProfile(
        {
            clientsPerTenant: 8,
            mutationsPerTenant: 1_024,
            mutationBatch: 32,
            subscriptions: 32,
            refreshRounds: 8,
            waitMs: 60_000,
            testTimeoutMs: 300_000,
        },
        5
    ),
});

export function validateProfile(name, profile) {
    if (typeof name !== "string" || name.length === 0) throw new Error("Scale profile name must be nonempty");
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
        throw new Error(`Scale profile ${name} must be an object`);
    }
    const keys = Object.keys(profile).sort();
    const expectedKeys = Object.keys(PROFILE_FIELDS).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`Scale profile ${name} must define exactly ${expectedKeys.join(", ")}`);
    }
    for (const [field, bounds] of Object.entries(PROFILE_FIELDS)) {
        const value = profile[field];
        if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
            throw new Error(
                `Scale profile ${name}.${field} must be an integer from ${bounds.minimum} through ${bounds.maximum}`
            );
        }
    }
    return profile;
}

for (const [name, profile] of Object.entries(SCALE_PROFILES)) {
    validateProfile(name, profile.values);
    if (
        !Number.isSafeInteger(profile.defaultSamples) ||
        profile.defaultSamples < 1 ||
        profile.defaultSamples > MAX_SAMPLES
    ) {
        throw new Error(`Scale profile ${name}.defaultSamples must be an integer from 1 through ${MAX_SAMPLES}`);
    }
}

function parseBoundedInteger(name, raw, minimum, maximum) {
    if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    return value;
}

export function validateRunBudget(profile, samples) {
    const validatedProfile = validateProfile("benchmark", profile);
    const validatedSamples = parseBoundedInteger("samples", String(samples), 1, MAX_SAMPLES);
    const sampleMaximumMs = validatedProfile.testTimeoutMs * EXPECTED_SCENARIOS.length + SAMPLE_PROCESS_OVERHEAD_MS;
    const runMaximumMs = sampleMaximumMs * validatedSamples;
    const availableMs = WORKFLOW_JOB_BUDGET_MS - WORKFLOW_SETUP_RESERVE_MS;
    if (!Number.isSafeInteger(runMaximumMs) || runMaximumMs > availableMs) {
        throw new Error(
            `Scale run worst-case ${runMaximumMs} ms exceeds the ${availableMs} ms benchmark allowance inside the 120-minute workflow budget`
        );
    }
    return {
        workflowJobMs: WORKFLOW_JOB_BUDGET_MS,
        setupReserveMs: WORKFLOW_SETUP_RESERVE_MS,
        availableMs,
        sampleMaximumMs,
        runMaximumMs,
    };
}

export function parseScaleArgs(argv) {
    let profileName = "ci-smoke";
    let samples;
    let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
    let help = false;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument !== "--profile" && argument !== "--samples" && argument !== "--output-dir") {
            throw new Error(`Unknown scale benchmark argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
        if (argument === "--profile") profileName = value;
        else if (argument === "--samples") samples = parseBoundedInteger("--samples", value, 1, MAX_SAMPLES);
        else outputDirectory = path.resolve(value);
    }
    const profile = SCALE_PROFILES[profileName];
    if (profile === undefined) {
        throw new Error(
            `Unknown scale profile ${JSON.stringify(profileName)}; choose ${Object.keys(SCALE_PROFILES).join(", ")}`
        );
    }
    const resolvedSamples = samples ?? profile.defaultSamples;
    validateRunBudget(profile.values, resolvedSamples);
    return {
        help,
        profileName,
        profile: profile.values,
        samples: resolvedSamples,
        outputDirectory,
    };
}

function profileEnvironment(profile, baseEnvironment) {
    const environment = { ...baseEnvironment };
    for (const [field, bounds] of Object.entries(PROFILE_FIELDS)) environment[bounds.env] = String(profile[field]);
    return environment;
}

function metricRecordFromLine(line) {
    const objectStart = line.indexOf("{");
    if (objectStart === -1) return undefined;
    let value;
    try {
        value = JSON.parse(line.slice(objectStart));
    } catch {
        return undefined;
    }
    if (value?.type !== "chardb-workerd-benchmark") return undefined;
    if (typeof value.scenario !== "string" || !EXPECTED_SCENARIOS.includes(value.scenario)) {
        throw new Error(`Unknown workerd benchmark scenario ${JSON.stringify(value.scenario)}`);
    }
    for (const [key, metric] of Object.entries(value)) {
        if (key === "type" || key === "scenario") continue;
        if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
            throw new Error(`Benchmark metric ${value.scenario}.${key} must be a finite non-negative number`);
        }
    }
    return value;
}

export function parseHarnessMetrics(output) {
    const metrics = output
        .split(/\r?\n/)
        .map(metricRecordFromLine)
        .filter(value => value !== undefined);
    if (metrics.length !== EXPECTED_SCENARIOS.length) {
        throw new Error(`Expected ${EXPECTED_SCENARIOS.length} benchmark records, received ${metrics.length}`);
    }
    const scenarios = metrics.map(metric => metric.scenario);
    for (const scenario of EXPECTED_SCENARIOS) {
        if (scenarios.filter(candidate => candidate === scenario).length !== 1) {
            throw new Error(`Expected exactly one ${scenario} benchmark record`);
        }
    }
    return metrics;
}

function round(value) {
    return Number(value.toFixed(4));
}

function nearestRank(values, percentile) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

export function summarizeSamples(records) {
    return EXPECTED_SCENARIOS.map(scenario => {
        const scenarioRecords = records.filter(record => record.scenario === scenario);
        const metricNames = Object.keys(scenarioRecords[0]?.metrics ?? {})
            .filter(name => name.endsWith("Ms") || name.endsWith("PerSecond"))
            .sort();
        const metrics = {};
        for (const name of metricNames) {
            const values = scenarioRecords.map(record => record.metrics[name]);
            metrics[name] = {
                minimum: Math.min(...values),
                p50: nearestRank(values, 0.5),
                p95: nearestRank(values, 0.95),
                maximum: Math.max(...values),
                mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
            };
        }
        return { scenario, sampleCount: scenarioRecords.length, metrics };
    });
}

export function collectRunMetadata(environment, startedAt, randomUUID) {
    const git = (args, fallback, allowEmpty = false) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
        if (result.exitCode !== 0) return fallback;
        const value = result.stdout.toString().trim();
        return value.length === 0 && !allowEmpty ? fallback : value;
    };
    const gitSha = environment.GITHUB_SHA ?? git(["rev-parse", "HEAD"], "unknown");
    const gitRef = environment.GITHUB_REF ?? git(["symbolic-ref", "--quiet", "--short", "HEAD"], "unknown");
    const gitStatus = git(["status", "--porcelain", "--untracked-files=normal"], "unknown", true);
    const cpus = os.cpus();
    return {
        id: environment.GITHUB_RUN_ID
            ? `github-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT ?? "1"}`
            : randomUUID(),
        startedAt,
        gitSha,
        gitRef,
        gitDirty: gitStatus === "unknown" ? "unknown" : gitStatus.length > 0,
        runtime: {
            bunVersion: Bun.version,
            platform: process.platform,
            osRelease: os.release(),
            architecture: process.arch,
            cpuModel: cpus[0]?.model ?? "unknown",
            logicalCpuCount: cpus.length,
            ci: environment.CI === "true",
            runnerName: environment.RUNNER_NAME ?? "unknown",
        },
    };
}

async function defaultHarnessRun({ environment, logPath, outerTimeoutMs }) {
    const stderrPath = `${logPath.slice(0, -4)}.stderr.log`;
    let failure;
    try {
        await run("gateway-live scaled SDK scenarios", ["bun", "run", "test:scale"], outerTimeoutMs, {
            cwd: ROOT,
            env: environment,
            stdout: Bun.file(logPath),
            stderr: Bun.file(stderrPath),
        });
    } catch (error) {
        failure = error;
    }
    const output = await readFile(logPath, "utf8").catch(() => "");
    const errorOutput = await readFile(stderrPath, "utf8").catch(() => "");
    if (output.length > 0) process.stdout.write(output);
    if (errorOutput.length > 0) process.stderr.write(errorOutput);
    if (failure !== undefined) throw failure;
    return output;
}

async function prepareOutputDirectory(outputDirectory) {
    try {
        const entries = await readdir(outputDirectory);
        if (entries.length > 0) {
            throw new Error(`Scale output directory must be empty: ${outputDirectory}`);
        }
    } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            await mkdir(outputDirectory, { recursive: true });
            return;
        }
        throw error;
    }
}

async function writeJsonAtomic(file, value) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
}

function failureRecord(error) {
    if (!(error instanceof Error)) return { name: "Error", message: String(error) };
    const record = { name: error.name, message: error.message };
    for (const field of ["exitCode", "signalCode", "timedOut"]) {
        if (field in error) record[field] = error[field];
    }
    return record;
}

export async function runScaleBenchmark(options, dependencies = {}) {
    const profile = validateProfile(options.profileName, options.profile);
    const samples = parseBoundedInteger("samples", String(options.samples), 1, MAX_SAMPLES);
    const budget = validateRunBudget(profile, samples);
    const outputDirectory = path.resolve(options.outputDirectory);
    const environment = profileEnvironment(profile, dependencies.environment ?? process.env);
    const now = dependencies.now ?? (() => new Date().toISOString());
    const runMetadata =
        dependencies.runMetadata ??
        collectRunMetadata(environment, now(), dependencies.randomUUID ?? (() => crypto.randomUUID()));
    const runHarness = dependencies.runHarness ?? defaultHarnessRun;
    const profileMetadata = { name: options.profileName, values: { ...profile } };
    const records = [];
    await prepareOutputDirectory(outputDirectory);
    const runPath = path.join(outputDirectory, "run.json");
    const runState = {
        schema: "chardb.scale.run.v1",
        suite: "gateway-live-scaled-sdk",
        status: "running",
        run: runMetadata,
        profile: profileMetadata,
        samples,
        completedSamples: 0,
        records: 0,
        budget,
        finishedAt: null,
        failure: null,
    };
    await writeJsonAtomic(runPath, runState);

    try {
        for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex++) {
            const logPath = path.join(outputDirectory, `sample-${String(sampleIndex).padStart(3, "0")}.log`);
            const output = await runHarness({
                environment,
                logPath,
                outerTimeoutMs: budget.sampleMaximumMs,
                sampleIndex,
            });
            for (const metric of parseHarnessMetrics(output)) {
                const { type: _type, scenario, ...values } = metric;
                records.push({
                    schema: "chardb.scale.sample.v1",
                    suite: "gateway-live-scaled-sdk",
                    run: runMetadata,
                    profile: profileMetadata,
                    sample: { index: sampleIndex, count: samples },
                    scenario,
                    correctness: "passed",
                    metrics: values,
                });
            }
            runState.completedSamples = sampleIndex;
            runState.records = records.length;
            await writeJsonAtomic(runPath, runState);
        }
    } catch (error) {
        runState.status = "failed";
        runState.finishedAt = now();
        runState.failure = failureRecord(error);
        await writeJsonAtomic(runPath, runState);
        throw error;
    }

    const ndjsonPath = path.join(outputDirectory, "samples.ndjson");
    const reportPath = path.join(outputDirectory, "report.json");
    const report = {
        schema: "chardb.scale.report.v1",
        suite: "gateway-live-scaled-sdk",
        run: runMetadata,
        profile: profileMetadata,
        samples,
        records: records.length,
        summaries: summarizeSamples(records),
    };
    await writeFile(ndjsonPath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    runState.status = "completed";
    runState.finishedAt = now();
    await writeJsonAtomic(runPath, runState);
    console.info(
        JSON.stringify({
            type: "chardb-scale-run-report",
            profile: options.profileName,
            samples,
            ndjsonPath,
            reportPath,
        })
    );
    return { records, report, runPath, ndjsonPath, reportPath };
}

function usage() {
    return [
        "Usage: bun scripts/run-scale-benchmark.mjs [options]",
        "",
        `  --profile <name>     ${Object.keys(SCALE_PROFILES).join(" | ")} (default: ci-smoke)`,
        `  --samples <count>    1-${MAX_SAMPLES} (default: selected profile)`,
        "  --output-dir <path>  artifact directory (default: .chardb/benchmarks/latest)",
        "  --help               show this help",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseScaleArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else await runScaleBenchmark(options);
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
