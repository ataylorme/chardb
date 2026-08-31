import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    RESHARD_BENCHMARK_COMPARISON_SCHEMA,
    compareReshardBenchmarkReportFiles,
    compareReshardBenchmarkReports,
    parseReshardBenchmarkComparisonArgs,
} from "../scripts/compare-reshard-benchmark.mjs";
import { parseNativeReshardProducerArgs } from "../scripts/produce-native-reshard-benchmark.mjs";
import {
    RESHARD_BENCHMARK_PHASES,
    RESHARD_BENCHMARK_PROFILE,
    RESHARD_BENCHMARK_SAMPLE_SCHEMA,
    RESHARD_BENCHMARK_SCHEMA,
    RESHARD_BENCHMARK_WORKLOAD_ID,
    RESHARD_BENCHMARK_WORKLOAD_VERSION,
    assertReshardBenchmarkReport,
    assertReshardBenchmarkSample,
    createReshardBenchmarkReport,
    summarizeReshardBenchmarkSamples,
} from "../scripts/reshard-benchmark-report.mjs";
import {
    parseReshardBenchmarkArgs,
    reshardBenchmarkProducerArgs,
    reshardBenchmarkRunPlan,
    runReshardBenchmark,
} from "../scripts/run-reshard-benchmark.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function target(kind: "local" | "cloudflare") {
    return {
        kind,
        origin: kind === "local" ? "http://127.0.0.1:8787" : "https://reshard-proof.example.workers.dev",
        transport: kind === "local" ? "wrangler-miniflare-http" : "wrangler-cloudflare-http",
        configurationSha256: "e".repeat(64),
        runtime: {
            workerd: "1.20260828.0",
            wrangler: "4.125.0",
            miniflare: kind === "local" ? "4.20260828.0" : null,
            compatibilityDate: "2026-08-28",
        },
        storage: { durableObjects: true, sqlite: true },
    };
}

function sample(sequence: number, kind: "local" | "cloudflare" = "local", multiplier = 1, processId = 100 + sequence) {
    const phase = Object.fromEntries(
        RESHARD_BENCHMARK_PHASES.map((name, index) => [name, (index + 1) * multiplier])
    ) as Record<(typeof RESHARD_BENCHMARK_PHASES)[number], number>;
    const converged = "c".repeat(64);
    return {
        schema: RESHARD_BENCHMARK_SAMPLE_SCHEMA,
        sequence,
        excluded: sequence === -1,
        candidateSha256: "a".repeat(64),
        workload: {
            id: RESHARD_BENCHMARK_WORKLOAD_ID,
            version: RESHARD_BENCHMARK_WORKLOAD_VERSION,
            profile: RESHARD_BENCHMARK_PROFILE,
        },
        target: target(kind),
        execution: {
            startedAt: `2026-08-28T00:00:${String(sequence + 1).padStart(2, "0")}.000Z`,
            completedAt: `2026-08-28T00:00:${String(sequence + 1).padStart(2, "0")}.500Z`,
            processId,
        },
        timing: { totalMs: 70 * multiplier, phasesMs: phase },
        movement: {
            bulk: { rows: 5_120, bytes: 1_024_000, readBatches: 12, applyBatches: 11 },
            capture: { transactionGroups: 256, entries: 256, bytes: 51_200 },
            replay: {
                passes: 5,
                readBatches: 5,
                applyBatches: 4,
                transactionGroups: 256,
                entries: 256,
                bytes: 51_200,
            },
            drain: { rows: 5_120, batches: 40 },
        },
        correctness: {
            organizationAuthorized: true,
            freshDestination: true,
            schemaIdentity: true,
            bulkCursorResumed: true,
            tailTransactionOrder: true,
            tailOrder: {
                sentinelId: "child-0000",
                expectedFinalBody: "captured body 255",
                sourceBeforeDrain: "captured body 255",
                destinationAfterReplay: "captured body 255",
                destinationAfterRestart: "captured body 255",
            },
            fenceActivated: true,
            cutoverActivated: true,
            sourceDrained: true,
            staleRoute: {
                typedError: "CDB_STALE_EPOCH",
                attempts: 2,
                sameMutationId: true,
                committedOnce: true,
            },
            live: { reason: "shardsChanged", mustRefetch: true, snapshotConverged: true },
            restart: {
                phase: "bulk",
                afterAppliedBatches: 3,
                coldProcess: true,
                cursorPersisted: true,
                resumed: true,
                noDuplicateRows: true,
            },
            digests: {
                algorithm: "sha256",
                canonicalEncoding: "table-pk-json-v1",
                sourceBeforeDrain: converged,
                destinationAfterCutover: converged,
                destinationAfterRestart: converged,
            },
        },
    };
}

function report(kind: "local" | "cloudflare" = "local", multiplier = 1) {
    const samples = Array.from({ length: RESHARD_BENCHMARK_PROFILE.logicalRuns }, (_, sequence) =>
        sample(sequence, kind, multiplier, 200 + sequence)
    );
    return createReshardBenchmarkReport({
        ok: true,
        candidate: { sha256: "a".repeat(64), bytes: 123_456 },
        workload: {
            id: RESHARD_BENCHMARK_WORKLOAD_ID,
            version: RESHARD_BENCHMARK_WORKLOAD_VERSION,
            profile: RESHARD_BENCHMARK_PROFILE,
        },
        target: target(kind),
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
            processIsolation: "fresh-process-per-run",
        },
        execution: {
            startedAt: "2026-08-28T00:00:00.000Z",
            completedAt: "2026-08-28T00:01:00.000Z",
            processId: 999,
        },
        warmup: sample(-1, kind, multiplier, 199),
        samples,
        aggregate: summarizeReshardBenchmarkSamples(samples),
    });
}

describe("reshard benchmark report", () => {
    test("pins a serious fixed workload and versioned raw sample contract", () => {
        expect(RESHARD_BENCHMARK_PROFILE).toEqual({
            name: "standard-v1",
            warmupRuns: 1,
            logicalRuns: 5,
            seed: { organizations: 1, parentRows: 1_024, childRows: 4_096 },
            capture: { transactionGroups: 256, entriesPerGroup: 1 },
            bulk: { rowLimit: 500, byteLimit: 1_048_576 },
            tail: { groupLimit: 500, byteLimit: 1_048_576 },
            drain: { rowLimit: 128 },
            restart: { phase: "bulk", afterAppliedBatches: 3 },
            routing: { staleRouteRetries: 1, liveReason: "shardsChanged" },
        });
        expect(assertReshardBenchmarkSample(sample(-1))).toMatchObject({
            schema: RESHARD_BENCHMARK_SAMPLE_SCHEMA,
            sequence: -1,
            excluded: true,
        });
        expect(report().schema).toBe(RESHARD_BENCHMARK_SCHEMA);
    });

    test("keeps timing distributions separate from correctness and movement counts", () => {
        const value = report();
        expect(value.aggregate.timing.totalMs.raw).toEqual([70, 70, 70, 70, 70]);
        expect(value.aggregate.timing.phasesMs.bulk).toMatchObject({ p50: 2, p95: 2 });
        expect(value.aggregate.totals).toEqual({
            elapsedMs: 350,
            bulkRows: 25_600,
            bulkBytes: 5_120_000,
            capturedTransactionGroups: 1_280,
            replayedEntries: 1_280,
            drainedRows: 25_600,
        });
        expect(value.aggregate.rates).toEqual({
            bulkRowsPerSecond: 2_560_000,
            bulkBytesPerSecond: 512_000_000,
            replayEntriesPerSecond: 51_200,
            drainRowsPerSecond: 512_000,
        });
        expect(value.aggregate).not.toHaveProperty("correctness");
        expect(value.samples[0]?.correctness.digests.sourceBeforeDrain).toBe("c".repeat(64));
    });

    test("rejects every claim that can make a move look correct when it is not", () => {
        const measured = (value: ReturnType<typeof report>) => {
            const first = value.samples[0];
            if (!first) throw new Error("test report has no measured sample");
            return first;
        };
        const cases: [string, (value: ReturnType<typeof report>) => void][] = [
            [
                "freshDestination",
                value => {
                    measured(value).correctness.freshDestination = false;
                },
            ],
            [
                "capture.transactionGroups",
                value => {
                    measured(value).movement.capture.transactionGroups = 255;
                },
            ],
            [
                "replay.entries",
                value => {
                    measured(value).movement.replay.entries = 255;
                },
            ],
            [
                "tailOrder",
                value => {
                    measured(value).correctness.tailOrder.destinationAfterReplay = "captured body 254";
                },
            ],
            [
                "staleRoute",
                value => {
                    measured(value).correctness.staleRoute.attempts = 1;
                },
            ],
            [
                "shardsChanged",
                value => {
                    measured(value).correctness.live.reason = "data";
                },
            ],
            [
                "restart",
                value => {
                    measured(value).correctness.restart.resumed = false;
                },
            ],
            [
                "digests",
                value => {
                    measured(value).correctness.digests.destinationAfterRestart = "d".repeat(64);
                },
            ],
        ];
        for (const [message, mutate] of cases) {
            const value = structuredClone(report());
            mutate(value);
            expect(() => assertReshardBenchmarkReport(value)).toThrow(message);
        }
    });

    test("requires local native transport, SQLite Durable Objects, exact fields, and fresh processes", () => {
        const transport = structuredClone(report());
        transport.target.transport = "memory";
        for (const item of transport.samples) item.target.transport = "memory";
        transport.warmup.target.transport = "memory";
        expect(() => assertReshardBenchmarkReport(transport)).toThrow("Wrangler and Miniflare");

        const storage = structuredClone(report());
        const storedSample = storage.samples[0];
        if (!storedSample) throw new Error("test report has no measured sample");
        storedSample.target.storage.sqlite = false;
        expect(() => assertReshardBenchmarkReport(storage)).toThrow("SQLite Durable Objects");

        const extra = structuredClone(report()) as ReturnType<typeof report> & { note?: string };
        extra.note = "trust me";
        expect(() => assertReshardBenchmarkReport(extra)).toThrow("fields must be exactly");

        const processReuse = structuredClone(report());
        const first = processReuse.samples[0];
        const second = processReuse.samples[1];
        if (!first || !second) throw new Error("test report has too few samples");
        second.execution.processId = first.execution.processId;
        expect(() => assertReshardBenchmarkReport(processReuse)).toThrow("fresh process");
    });
});

describe("reshard benchmark comparison", () => {
    test("reports descriptive deployed-to-local ratios and no hidden pass threshold", () => {
        const comparison = compareReshardBenchmarkReports(report("local"), report("cloudflare", 2));
        expect(comparison.schema).toBe(RESHARD_BENCHMARK_COMPARISON_SCHEMA);
        expect(comparison.ratioDirection).toBe("cloudflare/local");
        expect(comparison.ratios.totalLatency).toEqual({ p50: 2, p95: 2 });
        expect(comparison.ratios.phases.bulk).toEqual({ p50: 2, p95: 2 });
        expect(comparison.ratios.rates.bulkRowsPerSecond).toBe(0.5);
        expect(comparison).not.toHaveProperty("threshold");
        expect(comparison).not.toHaveProperty("passed");
    });

    test("rejects candidate, workload, movement, and correctness-digest drift", () => {
        const candidate = structuredClone(report("cloudflare"));
        candidate.candidate.bytes += 1;
        expect(() => compareReshardBenchmarkReports(report(), candidate)).toThrow("not comparable");

        const movement = structuredClone(report("cloudflare"));
        const movementSample = movement.samples[0];
        if (!movementSample) throw new Error("test report has no measured sample");
        movementSample.movement.bulk.bytes += 1;
        movement.aggregate = summarizeReshardBenchmarkSamples(movement.samples);
        expect(() => compareReshardBenchmarkReports(report(), movement)).toThrow("not comparable");

        const digest = structuredClone(report("cloudflare"));
        const digestSample = digest.samples[0];
        if (!digestSample) throw new Error("test report has no measured sample");
        for (const key of ["sourceBeforeDrain", "destinationAfterCutover", "destinationAfterRestart"] as const) {
            digestSample.correctness.digests[key] = "d".repeat(64);
        }
        expect(() => compareReshardBenchmarkReports(report(), digest)).toThrow("not comparable");
    });

    test("writes an atomic comparison artifact", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-reshard-comparison-"));
        temporaryDirectories.push(directory);
        const localPath = path.join(directory, "local.json");
        const candidatePath = path.join(directory, "candidate.json");
        const outputPath = path.join(directory, "comparison.json");
        await Promise.all([
            writeFile(localPath, JSON.stringify(report("local"))),
            writeFile(candidatePath, JSON.stringify(report("cloudflare", 2))),
        ]);
        await compareReshardBenchmarkReportFiles({ localPath, candidatePath, outputPath });
        expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
            schema: RESHARD_BENCHMARK_COMPARISON_SCHEMA,
        });
    });
});

describe("reshard benchmark runner", () => {
    test("builds one warmup and five measured fresh-process invocations", () => {
        expect(reshardBenchmarkRunPlan()).toEqual([
            { sequence: -1, excluded: true, filename: "warmup.json" },
            { sequence: 0, excluded: false, filename: "sample-0.json" },
            { sequence: 1, excluded: false, filename: "sample-1.json" },
            { sequence: 2, excluded: false, filename: "sample-2.json" },
            { sequence: 3, excluded: false, filename: "sample-3.json" },
            { sequence: 4, excluded: false, filename: "sample-4.json" },
        ]);
        const warmup = reshardBenchmarkRunPlan()[0];
        if (!warmup) throw new Error("benchmark plan has no warmup");
        expect(reshardBenchmarkProducerArgs("/fixture.ts", warmup, "/candidate.js", "a".repeat(64))).toEqual([
            "/fixture.ts",
            "--profile",
            "standard-v1",
            "--sequence",
            "-1",
            "--excluded",
            "true",
            "--candidate",
            "/candidate.js",
            "--candidate-sha256",
            "a".repeat(64),
        ]);
        expect(
            parseNativeReshardProducerArgs(
                reshardBenchmarkProducerArgs("/fixture.ts", warmup, "/candidate.js", "a".repeat(64)).slice(1)
            )
        ).toEqual({
            profile: "standard-v1",
            sequence: -1,
            excluded: true,
            candidate: "/candidate.js",
            candidateSha256: "a".repeat(64),
        });
    });

    test("parses bounded explicit paths and rejects ambiguous arguments", () => {
        const parsed = parseReshardBenchmarkArgs([
            "--producer",
            "fixture.ts",
            "--candidate",
            "candidate.tgz",
            "--output-dir",
            "evidence",
            "--timeout-ms",
            "5000",
        ]);
        expect(parsed.timeoutMs).toBe(5_000);
        expect(parsed.producer).toBe(path.resolve("fixture.ts"));
        expect(() => parseReshardBenchmarkArgs(["--wat"])).toThrow("unknown");
        expect(() => parseReshardBenchmarkArgs(["--producer", "a", "--producer", "b"])).toThrow("only once");
        expect(() => parseReshardBenchmarkArgs(["--help", "--timeout-ms", "999"])).toThrow("1000");
    });

    test("retains all raw samples, a strict report, and a digest manifest", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-reshard-runner-"));
        temporaryDirectories.push(directory);
        const producer = path.join(directory, "producer.ts");
        const candidate = path.join(directory, "candidate.tgz");
        const outputDir = path.join(directory, "evidence");
        await Promise.all([writeFile(producer, "// fixture hookup\n"), writeFile(candidate, "candidate bytes")]);
        const seen: number[] = [];
        const result = await runReshardBenchmark({
            producer,
            candidate,
            outputDir,
            timeoutMs: 5_000,
            spawnProducer: async ({ run }: { run: { sequence: number } }) => {
                seen.push(run.sequence);
                const value = sample(run.sequence, "local", 1, 1_000 + run.sequence);
                value.candidateSha256 = "732d058fadd90c70f22429227ab5d9c74919217099efe737aa46835ce3a60856";
                return value;
            },
        });
        expect(seen).toEqual([-1, 0, 1, 2, 3, 4]);
        expect(result.schema).toBe(RESHARD_BENCHMARK_SCHEMA);
        expect(await readdirSorted(path.join(outputDir, "raw-v1"))).toEqual([
            "sample-0.json",
            "sample-1.json",
            "sample-2.json",
            "sample-3.json",
            "sample-4.json",
            "warmup.json",
        ]);
        expect((await readFile(path.join(outputDir, "evidence.sha256"), "utf8")).trim().split("\n")).toHaveLength(7);
        expect(
            assertReshardBenchmarkReport(JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8")))
        ).toBeTruthy();
    });
});

async function readdirSorted(directory: string) {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(directory)).sort();
}

describe("reshard benchmark comparator CLI", () => {
    test("requires exact paths", () => {
        expect(parseReshardBenchmarkComparisonArgs(["--help"])).toMatchObject({ help: true });
        expect(() => parseReshardBenchmarkComparisonArgs([])).toThrow("--local is required");
        expect(() => parseReshardBenchmarkComparisonArgs(["--wat", "x"])).toThrow("unknown");
    });
});
