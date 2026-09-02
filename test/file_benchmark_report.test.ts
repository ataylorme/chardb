import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    FILE_BENCHMARK_COMPARISON_SCHEMA,
    compareFileBenchmarkReportFiles,
    compareFileBenchmarkReports,
    parseFileBenchmarkComparisonArgs,
} from "../scripts/compare-file-benchmark.mjs";
import {
    FILE_BENCHMARK_PROFILE,
    FILE_BENCHMARK_SCHEMA,
    FILE_BENCHMARK_WORKLOAD_ID,
    FILE_BENCHMARK_WORKLOAD_VERSION,
    assertFileBenchmarkReport,
    createFileBenchmarkReport,
    summarizeFileBenchmarkRuns,
} from "../scripts/file-benchmark-report.mjs";

const temporaryDirectories: string[] = [];

type Mutable<Value> = Value extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
      : Value;

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function first<Value>(values: Value[]): Value {
    const value = values[0];
    if (value === undefined) throw new Error("test fixture is unexpectedly empty");
    return value;
}

function correctness() {
    return {
        authenticated: true as const,
        organizationIsolated: true as const,
        operationStatus: true as const,
        exactBytes: true as const,
        exactDigest: true as const,
        cleanupComplete: true as const,
    };
}

function operationSamples(
    count: number,
    uploadCount: number,
    payloadBytes: number,
    operation: "upload" | "attach" | "download",
    multiplier: number
) {
    const latency = { upload: 10, attach: 5, download: 8 }[operation] * multiplier;
    return Array.from({ length: count }, (_, sequence) => ({
        sequence,
        objectSequence: sequence % uploadCount,
        attempts: 1,
        latencyMs: latency,
        bytes: operation === "attach" ? 0 : payloadBytes,
        correctness: correctness(),
    }));
}

function operationMeasurement(
    operation: "upload" | "attach" | "download",
    count: number,
    concurrency: number,
    uploadCount: number,
    payloadBytes: number,
    multiplier: number
) {
    return {
        elapsedMs: ((count * { upload: 10, attach: 5, download: 8 }[operation]) / concurrency) * multiplier,
        samples: operationSamples(count, uploadCount, payloadBytes, operation, multiplier),
    };
}

function logicalRun(sequence: number, multiplier: number) {
    return {
        sequence,
        startedAt: `2026-08-28T00:00:0${sequence}.000Z`,
        completedAt: `2026-08-28T00:00:0${sequence}.500Z`,
        payloads: FILE_BENCHMARK_PROFILE.payloads.map(payloadPlan => {
            const uploadCount = payloadPlan.operationsPerRun.upload.count;
            const measured = (operation: "upload" | "attach" | "download") => {
                const plan = payloadPlan.operationsPerRun[operation];
                return operationMeasurement(
                    operation,
                    plan.count,
                    plan.concurrency,
                    uploadCount,
                    payloadPlan.payloadBytes,
                    multiplier
                );
            };
            return {
                name: payloadPlan.name,
                payloadBytes: payloadPlan.payloadBytes,
                payloadSha256: (payloadPlan.name === "small" ? "b" : "c").repeat(64),
                warmup: {
                    excluded: true as const,
                    operations: {
                        upload: first(operationSamples(1, uploadCount, payloadPlan.payloadBytes, "upload", multiplier)),
                        attach: first(operationSamples(1, uploadCount, payloadPlan.payloadBytes, "attach", multiplier)),
                        download: first(
                            operationSamples(1, uploadCount, payloadPlan.payloadBytes, "download", multiplier)
                        ),
                    },
                },
                operations: { upload: measured("upload"), attach: measured("attach"), download: measured("download") },
            };
        }),
    };
}

function report(kind: "local" | "cloudflare", multiplier = 1) {
    const runs = Array.from({ length: FILE_BENCHMARK_PROFILE.logicalRuns }, (_, index) =>
        logicalRun(index, multiplier)
    );
    return createFileBenchmarkReport({
        ok: true,
        candidate: { sha256: "a".repeat(64), bytes: 254_928 },
        workload: { id: FILE_BENCHMARK_WORKLOAD_ID, version: FILE_BENCHMARK_WORKLOAD_VERSION },
        target: {
            kind,
            origin: kind === "local" ? "http://127.0.0.1:8787" : "https://file-benchmark.example.workers.dev",
            ...(kind === "cloudflare" ? { deploymentVersion: "version-1" } : {}),
            runtime: { name: "workerd", version: "2026.8.0", compatibilityDate: "2026-08-28" },
            r2: {
                provider: kind === "local" ? ("miniflare" as const) : ("cloudflare" as const),
                binding: "CDB_FILES",
                bucket: kind === "local" ? "local-files" : "deployed-files",
            },
        },
        profile: FILE_BENCHMARK_PROFILE,
        execution: { startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:00:10.000Z" },
        runner: {
            runtime: { name: "bun", version: "1.2.22" },
            machine: {
                platform: "darwin",
                architecture: "arm64",
                osRelease: "25.0.0",
                cpuModel: "Apple M4",
                logicalCpuCount: 10,
                memoryBytes: 16 * 1_024 ** 3,
            },
        },
        runs,
        aggregate: summarizeFileBenchmarkRuns(runs),
    });
}

function mutableReport(kind: "local" | "cloudflare", multiplier = 1): Mutable<ReturnType<typeof report>> {
    return structuredClone(report(kind, multiplier)) as Mutable<ReturnType<typeof report>>;
}

describe("file benchmark reports", () => {
    test("fixes the admitted five-run workload and excludes one warmup lifecycle per payload", () => {
        expect(FILE_BENCHMARK_PROFILE).toEqual({
            name: "standard-v1",
            logicalRuns: 5,
            payloads: [
                {
                    name: "small",
                    payloadBytes: 65_536,
                    warmupObjectsPerRun: 1,
                    operationsPerRun: {
                        upload: { count: 32, concurrency: 4 },
                        attach: { count: 32, concurrency: 4 },
                        download: { count: 64, concurrency: 8 },
                    },
                },
                {
                    name: "large",
                    payloadBytes: 5_242_880,
                    warmupObjectsPerRun: 1,
                    operationsPerRun: {
                        upload: { count: 4, concurrency: 1 },
                        attach: { count: 4, concurrency: 1 },
                        download: { count: 8, concurrency: 2 },
                    },
                },
            ],
        });
        const local = report("local");
        expect(local.schema).toBe(FILE_BENCHMARK_SCHEMA);
        expect(local.runs).toHaveLength(5);
        expect(local.runs.every(run => run.payloads.every(payload => payload.warmup.excluded))).toBe(true);
    });

    test("binds every per-run sample and exact aggregate count, byte, latency, and throughput", () => {
        const local = report("local");
        const [small, large] = local.aggregate.byPayload;
        expect(small).toMatchObject({
            payloadBytes: 65_536,
            upload: { operations: 160, attempts: 160, retries: 0, concurrency: 4, totalBytes: 10_485_760 },
            attach: { operations: 160, attempts: 160, retries: 0, concurrency: 4, totalBytes: 0 },
            download: { operations: 320, attempts: 320, retries: 0, concurrency: 8, totalBytes: 20_971_520 },
        });
        expect(small?.upload.rawLatencyMs).toHaveLength(160);
        expect(small?.attach.rawLatencyMs).toHaveLength(160);
        expect(small?.download.rawLatencyMs).toHaveLength(320);
        expect(large).toMatchObject({
            payloadBytes: 5_242_880,
            upload: { operations: 20, attempts: 20, retries: 0, concurrency: 1, totalBytes: 104_857_600 },
            attach: { operations: 20, attempts: 20, retries: 0, concurrency: 1, totalBytes: 0 },
            download: { operations: 40, attempts: 40, retries: 0, concurrency: 2, totalBytes: 209_715_200 },
        });
        expect(large?.upload.rawLatencyMs).toHaveLength(20);
        expect(large?.attach.rawLatencyMs).toHaveLength(20);
        expect(large?.download.rawLatencyMs).toHaveLength(40);
        expect(assertFileBenchmarkReport(local)).toBe(local);
    });

    test("rejects failed samples, included warmups, per-run count drift, and aggregate drift", () => {
        const failedSample = mutableReport("local");
        first(first(first(failedSample.runs).payloads).operations.download.samples).correctness.exactDigest =
            false as true;
        expect(() => assertFileBenchmarkReport(failedSample)).toThrow("exactDigest");

        const includedWarmup = mutableReport("local");
        first(first(includedWarmup.runs).payloads).warmup.excluded = false as true;
        expect(() => assertFileBenchmarkReport(includedWarmup)).toThrow("must be excluded");

        const missingDownload = mutableReport("local");
        first(first(missingDownload.runs).payloads).operations.download.samples.pop();
        expect(() => assertFileBenchmarkReport(missingDownload)).toThrow("must contain 64 samples");

        const aggregateDrift = mutableReport("local");
        first(aggregateDrift.aggregate.byPayload).upload.rawLatencyMs.splice(0, 1, 99);
        expect(() => assertFileBenchmarkReport(aggregateDrift)).toThrow("does not match the admitted runs");

        const invalidPayloadDigest = mutableReport("local");
        first(first(invalidPayloadDigest.runs).payloads).payloadSha256 = "not-a-digest";
        expect(() => assertFileBenchmarkReport(invalidPayloadDigest)).toThrow("payloadSha256");

        const hiddenRetry = mutableReport("local");
        first(first(first(hiddenRetry.runs).payloads).operations.attach.samples).attempts = 2;
        expect(() => assertFileBenchmarkReport(hiddenRetry)).toThrow("bounded operation contract");
    });

    test("reports strict descriptive Cloudflare-to-local ratios without a threshold", () => {
        const comparison = compareFileBenchmarkReports(report("local"), report("cloudflare", 2));
        expect(comparison).toMatchObject({
            schema: FILE_BENCHMARK_COMPARISON_SCHEMA,
            ratioDirection: "cloudflare/local",
            measurementBoundary: {
                measures: ["client-observed-latency", "throughput"],
                billingCountersCollected: false,
                costClaimed: false,
            },
            candidate: { sha256: "a".repeat(64), bytes: 254_928 },
        });
        expect(comparison.ratios[0]).toEqual({
            payloadBytes: 65_536,
            upload: { latencyP50: 2, latencyP95: 2, operationsPerSecond: 0.5, bytesPerSecond: 0.5 },
            attach: { latencyP50: 2, latencyP95: 2, operationsPerSecond: 0.5 },
            download: { latencyP50: 2, latencyP95: 2, operationsPerSecond: 0.5, bytesPerSecond: 0.5 },
        });
        expect(comparison).not.toHaveProperty("threshold");
        expect(comparison).not.toHaveProperty("passed");
    });

    test("rejects different artifacts, profiles, runners, and valid-but-different object plans", () => {
        const artifact = mutableReport("cloudflare");
        artifact.candidate.bytes += 1;
        expect(() => compareFileBenchmarkReports(report("local"), artifact)).toThrow("not comparable");

        const profile = mutableReport("cloudflare");
        first(profile.profile.payloads).operationsPerRun.download.concurrency += 1;
        expect(() => compareFileBenchmarkReports(report("local"), profile)).toThrow("standard-v1");

        const runner = mutableReport("cloudflare");
        runner.runner.machine.cpuModel = "different runner";
        expect(() => compareFileBenchmarkReports(report("local"), runner)).toThrow("not comparable");

        const payload = mutableReport("cloudflare");
        first(first(payload.runs).payloads).payloadSha256 = "d".repeat(64);
        expect(() => compareFileBenchmarkReports(report("local"), payload)).toThrow("not comparable");

        const samplePlan = mutableReport("cloudflare");
        const downloads = first(first(samplePlan.runs).payloads).operations.download.samples;
        for (const download of downloads) download.objectSequence = (download.objectSequence + 1) % 32;
        samplePlan.aggregate = structuredClone(summarizeFileBenchmarkRuns(samplePlan.runs)) as Mutable<
            ReturnType<typeof summarizeFileBenchmarkRuns>
        >;
        expect(() => compareFileBenchmarkReports(report("local"), samplePlan)).toThrow("not comparable");
    });

    test("writes a validated comparison artifact", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-file-benchmark-report-"));
        temporaryDirectories.push(directory);
        const localPath = path.join(directory, "local.json");
        const cloudflarePath = path.join(directory, "cloudflare.json");
        const outputPath = path.join(directory, "comparison.json");
        await Promise.all([
            writeFile(localPath, JSON.stringify(report("local"))),
            writeFile(cloudflarePath, JSON.stringify(report("cloudflare", 2))),
        ]);
        const comparison = await compareFileBenchmarkReportFiles({ localPath, cloudflarePath, outputPath });
        expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(comparison);
        expect(
            parseFileBenchmarkComparisonArgs([
                "--local",
                localPath,
                "--cloudflare",
                cloudflarePath,
                "--output",
                outputPath,
            ])
        ).toEqual({ help: false, localPath, cloudflarePath, outputPath });
    });
});
