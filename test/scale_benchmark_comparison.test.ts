import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    compareScaleReportFiles,
    compareScaleReports,
    parseComparisonArgs,
} from "../scripts/compare-scale-benchmark.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function report(id: string, overrides = {}) {
    const metrics = {
        mutationMs: { minimum: 8, p50: 10, p95: 12, maximum: 12, mean: 10 },
        mutationsPerSecond: { minimum: 80, p50: 100, p95: 120, maximum: 120, mean: 100 },
        ...overrides,
    };
    return {
        schema: "chardb.scale.report.v1",
        suite: "gateway-live-scaled-sdk",
        run: {
            id,
            gitSha: `${id}-sha`,
            runtime: {
                bunVersion: "1.2.22",
                platform: "linux",
                osRelease: "6.11",
                architecture: "x64",
                cpuModel: "benchmark-runner",
                logicalCpuCount: 4,
                ci: true,
                runnerName: "chardb-benchmark",
            },
        },
        profile: { name: "ci-smoke", values: { clientsPerTenant: 1 } },
        workload: {
            suite: "live",
            id: "gateway-live-scaled-sdk",
            scenarios: ["sdk-organization-mutation-fanout"],
            profile: { name: "ci-smoke", values: { clientsPerTenant: 1 } },
        },
        samples: 3,
        records: 3,
        summaries: [{ scenario: "sdk-organization-mutation-fanout", sampleCount: 3, metrics }],
    };
}

describe("scale benchmark comparison", () => {
    test("compares p50 and the adverse tail with the correct latency and throughput direction", () => {
        const comparison = compareScaleReports(
            report("baseline"),
            report("candidate", {
                mutationMs: { minimum: 8, p50: 11, p95: 15, maximum: 15, mean: 11 },
                mutationsPerSecond: { minimum: 72, p50: 95, p95: 108, maximum: 108, mean: 95 },
            }),
            15
        );

        expect(comparison).toMatchObject({
            schema: "chardb.scale.comparison.v1",
            baseline: {
                id: "baseline",
                gitSha: "baseline-sha",
                samples: 3,
                runtime: { runnerName: "chardb-benchmark" },
                workload: { id: "gateway-live-scaled-sdk" },
            },
            candidate: {
                id: "candidate",
                gitSha: "candidate-sha",
                samples: 3,
                runtime: { runnerName: "chardb-benchmark" },
                workload: { id: "gateway-live-scaled-sdk" },
            },
            threshold: { maxRegressionPercent: 15 },
            summary: { comparisons: 4, regressions: 1, passed: false },
        });
        expect(comparison.comparisons).toContainEqual(
            expect.objectContaining({
                metric: "mutationMs",
                statistic: "p50",
                direction: "lower-is-better",
                regressionPercent: 10,
                passed: true,
            })
        );
        expect(comparison.comparisons).toContainEqual(
            expect.objectContaining({ metric: "mutationMs", statistic: "p95", regressionPercent: 25, passed: false })
        );
        expect(comparison.comparisons).toContainEqual(
            expect.objectContaining({
                metric: "mutationsPerSecond",
                statistic: "minimum",
                direction: "higher-is-better",
                regressionPercent: 10,
                passed: true,
            })
        );
    });

    test("rejects incomparable profiles and metric sets", () => {
        const throughputProfile = { name: "throughput" };
        expect(() =>
            compareScaleReports(
                report("baseline"),
                {
                    ...report("candidate"),
                    profile: throughputProfile,
                    workload: { ...report("candidate").workload, profile: throughputProfile },
                },
                10
            )
        ).toThrow("Report profiles differ");
        expect(() =>
            compareScaleReports(
                report("baseline"),
                report("candidate", { registrationMs: { minimum: 1, p50: 1, p95: 1, maximum: 1, mean: 1 } }),
                10
            )
        ).toThrow("metrics differ");
        expect(() =>
            compareScaleReports(
                report("baseline"),
                { ...report("candidate"), workload: { ...report("candidate").workload, suite: "planned-query" } },
                10
            )
        ).toThrow("Report workload identities differ");
        expect(() =>
            compareScaleReports(
                report("baseline"),
                {
                    ...report("candidate"),
                    run: {
                        ...report("candidate").run,
                        runtime: { ...report("candidate").run.runtime, runnerName: "different-runner" },
                    },
                },
                10
            )
        ).toThrow("Report runtime identities differ");
    });

    test("rejects inconsistent record accounting and unequal sample plans", () => {
        expect(() => compareScaleReports({ ...report("baseline"), records: 2 }, report("candidate"), 10)).toThrow(
            "records must equal samples times scenarios (3)"
        );
        expect(() =>
            compareScaleReports(
                {
                    ...report("baseline"),
                    summaries: [{ ...report("baseline").summaries[0], sampleCount: 2 }],
                },
                report("candidate"),
                10
            )
        ).toThrow("sampleCount must equal report samples 3");
        expect(() =>
            compareScaleReports(
                {
                    ...report("baseline"),
                    samples: 2,
                    records: 2,
                    summaries: [{ ...report("baseline").summaries[0], sampleCount: 2 }],
                },
                report("candidate"),
                10
            )
        ).toThrow("Report sample counts differ: baseline has 2, candidate has 3");
    });

    test("handles a zero baseline without emitting non-finite JSON", () => {
        const comparison = compareScaleReports(
            report("baseline", {
                mutationMs: { minimum: 0, p50: 0, p95: 0, maximum: 0, mean: 0 },
                mutationsPerSecond: { minimum: 0, p50: 0, p95: 0, maximum: 0, mean: 0 },
            }),
            report("candidate", {
                mutationMs: { minimum: 1, p50: 1, p95: 1, maximum: 1, mean: 1 },
                mutationsPerSecond: { minimum: 1, p50: 1, p95: 1, maximum: 1, mean: 1 },
            }),
            10
        );
        expect(comparison.summary).toMatchObject({ regressions: 2, passed: false });
        expect(JSON.stringify(comparison)).not.toContain("Infinity");
        expect(comparison.comparisons).toContainEqual(
            expect.objectContaining({ metric: "mutationMs", regressionPercent: null, reason: "baseline-zero" })
        );
    });

    test("parses bounded CLI input and requires an explicit regression allowance", () => {
        expect(
            parseComparisonArgs([
                "--baseline",
                "before.json",
                "--candidate",
                "after.json",
                "--max-regression-percent",
                "12.5",
                "--output",
                "comparison.json",
            ])
        ).toMatchObject({ maxRegressionPercent: 12.5 });
        expect(() => parseComparisonArgs(["--baseline", "before.json", "--candidate", "after.json"])).toThrow(
            "--max-regression-percent is required"
        );
        expect(() =>
            parseComparisonArgs([
                "--baseline",
                "before.json",
                "--candidate",
                "after.json",
                "--max-regression-percent",
                "10; exit 0",
            ])
        ).toThrow("must be a number from 0 through 1000");
    });

    test("writes a machine-readable comparison artifact", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-scale-compare-"));
        temporaryDirectories.push(directory);
        const baselinePath = path.join(directory, "baseline.json");
        const candidatePath = path.join(directory, "candidate.json");
        const outputPath = path.join(directory, "comparison.json");
        await Promise.all([
            writeFile(baselinePath, JSON.stringify(report("baseline"))),
            writeFile(candidatePath, JSON.stringify(report("candidate"))),
        ]);

        const comparison = await compareScaleReportFiles({
            baselinePath,
            candidatePath,
            outputPath,
            maxRegressionPercent: 0,
        });
        expect(comparison.summary).toEqual({ comparisons: 4, regressions: 0, passed: true });
        expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(comparison);
    });

    test("exits nonzero after writing the regression decision", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-scale-compare-cli-"));
        temporaryDirectories.push(directory);
        const baselinePath = path.join(directory, "baseline.json");
        const candidatePath = path.join(directory, "candidate.json");
        const outputPath = path.join(directory, "comparison.json");
        await Promise.all([
            writeFile(baselinePath, JSON.stringify(report("baseline"))),
            writeFile(
                candidatePath,
                JSON.stringify(
                    report("candidate", {
                        mutationMs: { minimum: 12, p50: 20, p95: 24, maximum: 24, mean: 20 },
                    })
                )
            ),
        ]);

        const subprocess = Bun.spawn(
            [
                "bun",
                path.resolve(import.meta.dir, "../scripts/compare-scale-benchmark.mjs"),
                "--baseline",
                baselinePath,
                "--candidate",
                candidatePath,
                "--max-regression-percent",
                "10",
                "--output",
                outputPath,
            ],
            { stdout: "pipe", stderr: "pipe" }
        );
        const [exitCode, stdout, stderr] = await Promise.all([
            subprocess.exited,
            new Response(subprocess.stdout).text(),
            new Response(subprocess.stderr).text(),
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toBe("");
        const printed = JSON.parse(stdout);
        expect(printed.summary).toMatchObject({ regressions: 2, passed: false });
        expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(printed);
    });
});
