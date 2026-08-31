import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertFileBenchmarkReport } from "./file-benchmark-report.mjs";

export const FILE_BENCHMARK_COMPARISON_SCHEMA = "chardb.file-benchmark.comparison.v1";

function comparableIdentity(report) {
    return {
        candidate: report.candidate,
        workload: report.workload,
        profile: report.profile,
        runner: report.runner,
        samplePlan: report.runs.map(run => ({
            sequence: run.sequence,
            payloads: run.payloads.map(payload => ({
                name: payload.name,
                payloadSha256: payload.payloadSha256,
                operations: Object.fromEntries(
                    Object.entries(payload.operations).map(([operation, measurement]) => [
                        operation,
                        measurement.samples.map(sample => ({
                            sequence: sample.sequence,
                            objectSequence: sample.objectSequence,
                        })),
                    ])
                ),
            })),
        })),
    };
}

function ratio(cloudflare, local, label) {
    if (local === 0) {
        if (cloudflare === 0) return null;
        throw new Error(`${label} has a zero local denominator`);
    }
    return cloudflare / local;
}

function operationRatios(local, cloudflare, operation) {
    const ratios = {
        latencyP50: ratio(cloudflare.latencyMs.p50, local.latencyMs.p50, `${operation}.latencyP50`),
        latencyP95: ratio(cloudflare.latencyMs.p95, local.latencyMs.p95, `${operation}.latencyP95`),
        operationsPerSecond: ratio(
            cloudflare.operationsPerSecond,
            local.operationsPerSecond,
            `${operation}.operationsPerSecond`
        ),
    };
    if (operation !== "attach") {
        ratios.bytesPerSecond = ratio(cloudflare.bytesPerSecond, local.bytesPerSecond, `${operation}.bytesPerSecond`);
    }
    return ratios;
}

export function compareFileBenchmarkReports(localInput, cloudflareInput) {
    const local = assertFileBenchmarkReport(localInput);
    const cloudflare = assertFileBenchmarkReport(cloudflareInput);
    if (local.target.kind !== "local") throw new Error("comparison baseline must have target.kind=local");
    if (cloudflare.target.kind !== "cloudflare") {
        throw new Error("comparison candidate must have target.kind=cloudflare");
    }
    if (!isDeepStrictEqual(comparableIdentity(local), comparableIdentity(cloudflare))) {
        throw new Error("local and Cloudflare file benchmark reports are not comparable");
    }
    return {
        schema: FILE_BENCHMARK_COMPARISON_SCHEMA,
        ratioDirection: "cloudflare/local",
        measurementBoundary: {
            measures: ["client-observed-latency", "throughput"],
            billingCountersCollected: false,
            costClaimed: false,
        },
        candidate: structuredClone(local.candidate),
        workload: structuredClone(local.workload),
        profile: structuredClone(local.profile),
        runner: structuredClone(local.runner),
        local: {
            target: structuredClone(local.target),
            execution: structuredClone(local.execution),
        },
        cloudflare: {
            target: structuredClone(cloudflare.target),
            execution: structuredClone(cloudflare.execution),
        },
        ratios: local.aggregate.byPayload.map((localPayload, index) => {
            const cloudflarePayload = cloudflare.aggregate.byPayload[index];
            return {
                payloadBytes: localPayload.payloadBytes,
                upload: operationRatios(localPayload.upload, cloudflarePayload.upload, "upload"),
                attach: operationRatios(localPayload.attach, cloudflarePayload.attach, "attach"),
                download: operationRatios(localPayload.download, cloudflarePayload.download, "download"),
            };
        }),
    };
}

export function parseFileBenchmarkComparisonArgs(argv) {
    let localPath;
    let cloudflarePath;
    let outputPath;
    let help = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument !== "--local" && argument !== "--cloudflare" && argument !== "--output") {
            throw new Error(`Unknown file benchmark comparison argument ${JSON.stringify(argument)}`);
        }
        const value = argv[++index];
        if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
        if (argument === "--local") localPath = path.resolve(value);
        else if (argument === "--cloudflare") cloudflarePath = path.resolve(value);
        else outputPath = path.resolve(value);
    }
    if (!help) {
        if (localPath === undefined) throw new Error("--local is required");
        if (cloudflarePath === undefined) throw new Error("--cloudflare is required");
        if (outputPath === undefined) throw new Error("--output is required");
    }
    return { help, localPath, cloudflarePath, outputPath };
}

async function readJson(file) {
    try {
        return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
        throw new Error(`Could not read JSON report ${file}`, { cause: error });
    }
}

async function writeJsonAtomic(file, value) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
}

export async function compareFileBenchmarkReportFiles(options) {
    const [local, cloudflare] = await Promise.all([readJson(options.localPath), readJson(options.cloudflarePath)]);
    const comparison = compareFileBenchmarkReports(local, cloudflare);
    await writeJsonAtomic(options.outputPath, comparison);
    return comparison;
}

function usage() {
    return [
        "Usage: bun scripts/compare-file-benchmark.mjs [options]",
        "",
        "  --local <path>       local Miniflare report JSON",
        "  --cloudflare <path>  deployed Cloudflare report JSON",
        "  --output <path>      comparison JSON artifact",
        "  --help               show this help",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseFileBenchmarkComparisonArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else console.log(JSON.stringify(await compareFileBenchmarkReportFiles(options)));
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
    }
}
