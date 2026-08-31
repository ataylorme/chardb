import { describe, expect, test } from "bun:test";
import {
    FILE_RESHARD_BENCHMARK_PHASES,
    FILE_RESHARD_BENCHMARK_PROFILES,
    FILE_RESHARD_BENCHMARK_SAMPLE_SCHEMA,
    FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
    FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
    assertFileReshardBenchmarkSample,
    createFileReshardBenchmarkReport,
    summarizeFileReshardBenchmarkSamples,
} from "../scripts/file-reshard-benchmark-report.mjs";

function sample(sequence: number, profileName: "small" | "medium" | "large" = "small", multiplier = 1) {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES[profileName];
    if (!profile) throw new Error("missing profile");
    const phasesMs = Object.fromEntries(
        FILE_RESHARD_BENCHMARK_PHASES.map((phase, index) => [phase, (index + 1) * multiplier])
    );
    const identity = "b".repeat(64);
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
            configurationSha256: "a".repeat(64),
            runtime: { workerd: "1.20260828.0", miniflare: "4.20260828.0", compatibilityDate: "2026-08-28" },
            storage: { durableObjects: true, sqlite: true, r2: true },
        },
        execution: {
            startedAt: "2026-08-28T00:00:00.000Z",
            completedAt: "2026-08-28T00:00:01.000Z",
            processId: 42,
        },
        dataset: {
            organizations: profile.organizations,
            files: profile.files,
            metadataRows: profile.files,
            objectBytes: profile.files * 8,
        },
        timing: { totalMs: 100 * multiplier, phasesMs },
        throughput: { filesPerSecond: 1_000 / multiplier, metadataRowsPerSecond: 1_000 / multiplier },
        movement: {
            runTurns: 12,
            files: profile.files,
            metadataRows: profile.files,
            r2: {
                objectsBefore: profile.files,
                objectsAfter: profile.files,
                bytesBefore: profile.files * 8,
                bytesAfter: profile.files * 8,
                identityDigestBefore: identity,
                identityDigestAfter: identity,
                writesDuringMove: 0,
                deletesDuringMove: 0,
            },
        },
        restart: {
            phase: "snapshot",
            disposeMs: 2 * multiplier,
            coldStartMs: 3 * multiplier,
            resumeMs: 4 * multiplier,
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

describe("file reshard benchmark evidence", () => {
    test("pins fast CI and opt-in scale profiles", () => {
        expect(FILE_RESHARD_BENCHMARK_PROFILES).toEqual({
            small: { name: "small", organizations: 3, files: 16, logicalRuns: 3, ciDefault: true },
            medium: { name: "medium", organizations: 3, files: 256, logicalRuns: 3, ciDefault: false },
            large: { name: "large", organizations: 3, files: 2_048, logicalRuns: 3, ciDefault: false },
        });
        expect(assertFileReshardBenchmarkSample(sample(-1))).toMatchObject({ sequence: -1, excluded: true });
    });

    test("summarizes phase, restart, and throughput distributions without weakening correctness", () => {
        const samples = [sample(0, "small", 1), sample(1, "small", 2), sample(2, "small", 3)];
        const aggregate = summarizeFileReshardBenchmarkSamples(samples, "small");
        expect(aggregate.timing.phasesMs.snapshot).toMatchObject({ raw: [3, 6, 9], p50: 6, p95: 9 });
        expect(aggregate.timing.restartOverheadMs.raw).toEqual([9, 18, 27]);
        expect(aggregate.rates.filesPerSecond?.raw).toEqual([1_000, 500, 1_000 / 3]);
        expect(aggregate.totals).toEqual({
            files: 48,
            metadataRows: 48,
            r2WritesDuringMove: 0,
            r2DeletesDuringMove: 0,
        });
        expect(
            createFileReshardBenchmarkReport({
                ok: true,
                workload: {
                    id: FILE_RESHARD_BENCHMARK_WORKLOAD_ID,
                    version: FILE_RESHARD_BENCHMARK_WORKLOAD_VERSION,
                    profile: FILE_RESHARD_BENCHMARK_PROFILES.small,
                },
                runner: { runtime: {}, machine: {}, processIsolation: "fresh-miniflare-per-run" },
                execution: {
                    startedAt: "2026-08-28T00:00:00.000Z",
                    completedAt: "2026-08-28T00:01:00.000Z",
                    processId: 42,
                },
                warmup: sample(-1),
                samples,
                aggregate,
            }).aggregate
        ).toEqual(aggregate);
    });

    test("rejects R2 churn, parity loss, and dataset drift", () => {
        for (const mutate of [
            (value: ReturnType<typeof sample>) => {
                value.movement.r2.writesDuringMove = 1;
            },
            (value: ReturnType<typeof sample>) => {
                value.correctness.parity = false;
            },
            (value: ReturnType<typeof sample>) => {
                value.dataset.files--;
            },
            (value: ReturnType<typeof sample>) => {
                value.movement.r2.identityDigestAfter = "c".repeat(64);
            },
        ]) {
            const value = sample(0);
            mutate(value);
            expect(() => assertFileReshardBenchmarkSample(value)).toThrow();
        }
    });
});
