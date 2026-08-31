import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    FILE_RESHARD_BENCHMARK_PHASES,
    FILE_RESHARD_BENCHMARK_PROFILES,
    FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA,
    FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
    FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
} from "../scripts/file-reshard-benchmark-report.mjs";
import {
    fileReshardBenchmarkProducerArgs,
    fileReshardBenchmarkRunPlan,
    parseFileReshardBenchmarkArgs,
    runFileReshardBenchmark,
} from "../scripts/run-file-reshard-benchmark.mjs";

const temporary: string[] = [];

afterEach(async () => {
    await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function sample(sequence: number) {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES.small;
    if (!profile) throw new Error("small profile is missing");
    const digest = "a".repeat(64);
    return {
        schema: FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA,
        sequence,
        excluded: sequence === -1,
        workload: {
            id: FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
            version: FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
            profile,
        },
        target: {
            kind: "local",
            transport: "miniflare-workerd-native",
            runtime: { workerd: "1", miniflare: "1", compatibilityDate: "2026-08-28" },
            storage: { durableObjects: true, sqlite: true, r2: true },
            configurationSha256: digest,
        },
        execution: {
            startedAt: "2026-08-28T00:00:00.000Z",
            completedAt: "2026-08-28T00:00:01.000Z",
            processId: 1,
        },
        dataset: { organizations: 3, files: 16, metadataRows: 16, objectBytes: 128 },
        timing: {
            totalMs: 100,
            phasesMs: Object.fromEntries(FILE_RESHARD_BENCHMARK_PHASES.map(phase => [phase, 1])),
        },
        throughput: { filesPerSecond: 160, metadataRowsPerSecond: 160 },
        movement: {
            runTurns: 10,
            files: 16,
            metadataRows: 16,
            r2: {
                objectsBefore: 16,
                objectsAfter: 16,
                bytesBefore: 128,
                bytesAfter: 128,
                identityDigestBefore: digest,
                identityDigestAfter: digest,
                writesDuringMove: 0,
                deletesDuringMove: 0,
            },
        },
        restart: {
            phase: "snapshot",
            disposeMs: 1,
            coldStartMs: 1,
            resumeMs: 1,
            cursorPersisted: true,
            resumed: true,
        },
        correctness: {
            phaseOrder: true,
            parity: true,
            destinationActivated: true,
            sourceDrained: true,
            r2Stable: true,
            sharedBucketNoCopy: true,
        },
    };
}

describe("file reshard benchmark runner", () => {
    test("defaults to the fast profile and makes scale explicit", () => {
        expect(parseFileReshardBenchmarkArgs(["--help"])).toMatchObject({ help: true, profileName: "small" });
        expect(
            parseFileReshardBenchmarkArgs(["--producer", "producer.mjs", "--output-dir", "out", "--profile", "large"])
        ).toMatchObject({ help: false, profileName: "large" });
        expect(fileReshardBenchmarkRunPlan("small")).toEqual([
            { sequence: -1, excluded: true, filename: "warmup.json" },
            { sequence: 0, excluded: false, filename: "sample-0.json" },
            { sequence: 1, excluded: false, filename: "sample-1.json" },
            { sequence: 2, excluded: false, filename: "sample-2.json" },
        ]);
        const warmup = fileReshardBenchmarkRunPlan("small")[0];
        if (!warmup) throw new Error("warmup run is missing");
        expect(fileReshardBenchmarkProducerArgs("producer.mjs", warmup, "small")).toEqual([
            "producer.mjs",
            "--profile",
            "small",
            "--sequence",
            "-1",
            "--excluded",
            "true",
        ]);
        expect(() =>
            parseFileReshardBenchmarkArgs(["--producer", "x", "--output-dir", "y", "--profile", "huge"])
        ).toThrow("unknown file reshard benchmark profile");
    });

    test("writes strict raw samples, report, and hash manifest", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "file-reshard-benchmark-runner-"));
        temporary.push(root);
        const producer = path.join(root, "producer.mjs");
        const outputDir = path.join(root, "evidence");
        await writeFile(producer, "export {};\n");
        const report = await runFileReshardBenchmark({
            producer,
            outputDir,
            profileName: "small",
            spawnProducer: async ({ run }: { run: { sequence: number } }) => sample(run.sequence),
        });
        expect(report.aggregate.totals).toEqual({
            files: 48,
            metadataRows: 48,
            r2WritesDuringMove: 0,
            r2DeletesDuringMove: 0,
        });
        expect(JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"))).toEqual(report);
        const manifest = await readFile(path.join(outputDir, "evidence.sha256"), "utf8");
        expect(manifest.trim().split("\n")).toHaveLength(5);
        expect(manifest).toContain("raw-v1/warmup.json");
        expect(manifest).toContain("raw-v1/sample-2.json");
    });
});
