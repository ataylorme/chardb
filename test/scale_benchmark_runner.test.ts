import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BENCHMARK_SUITES,
    PLANNED_QUERY_PROFILES,
    SCALE_PROFILES,
    collectRunMetadata,
    parseHarnessMetrics,
    parseScaleArgs,
    runScaleBenchmark,
    validateProfile,
    validateRunBudget,
} from "../scripts/run-scale-benchmark.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function harnessOutput(sample: number): string {
    return [
        "bun test v1.2.22",
        JSON.stringify({
            type: "chardb-workerd-benchmark",
            scenario: "sdk-two-tenant-mutation-fanout",
            clients: 2,
            mutations: 8,
            initialMs: 10 * sample,
            mutationMs: 20 * sample,
            mutationsPerSecond: 400 / sample,
            midConvergenceMs: 25 * sample,
            churnMs: 26 * sample,
            reconnectedClients: 2,
            reconnectedClientsPerSecond: 70 / sample,
            responseLossMutations: 4,
            responseLossReplayMs: 27 * sample,
            responseLossReplaysPerSecond: 60 / sample,
            exactReplayResults: 4,
            replayDuplicateRows: 0,
            committedRows: 12,
            opLogEntries: 12,
            changeSeqAdvance: 12,
            convergenceMs: 30 * sample,
            deliveryMs: 31 * sample,
            logicalRowDeliveries: 16,
            logicalRowDeliveriesPerSecond: 200 / sample,
        }),
        JSON.stringify({
            type: "chardb-workerd-benchmark",
            scenario: "sdk-selective-subscription-refresh",
            subscriptions: 4,
            rounds: 2,
            writes: 8,
            registrationMs: 40 * sample,
            registrationsPerSecond: 100 / sample,
            recoveryMs: 45 * sample,
            recoveredRegistrations: 4,
            recoveredRegistrationsPerSecond: 90 / sample,
            committedRows: 8,
            opLogEntries: 8,
            changeSeqAdvance: 8,
            writeMs: 50 * sample,
            writesPerSecond: 80 / sample,
            refreshMs: 60 * sample,
            materializations: 8,
            materializationsPerSecond: 60 / sample,
        }),
        "2 pass",
    ].join("\n");
}

function plannedQueryHarnessOutput(sample: number): string {
    return [
        "bun test v1.2.22",
        JSON.stringify({
            type: "chardb-workerd-benchmark",
            scenario: "native-binding-structured-select-pages",
            organizations: 2,
            channels: 8,
            rowsPerChannel: 100,
            seededRows: 1_600,
            queries: 32,
            concurrency: 8,
            pageLimit: 25,
            exactOrderedIsolatedQueries: 32,
            elapsedMs: 20 * sample,
            queriesPerSecond: 1_600 / sample,
            minimumRequestLatencyMs: sample,
            p50RequestLatencyMs: 2 * sample,
            p95RequestLatencyMs: 3 * sample,
            maximumRequestLatencyMs: 4 * sample,
        }),
        JSON.stringify({
            type: "chardb-workerd-benchmark",
            scenario: "planned-query-registered-pages",
            organizations: 2,
            channels: 8,
            rowsPerChannel: 100,
            seededRows: 1_600,
            registrations: 32,
            pageLimit: 25,
            exactOrderedIsolatedSnapshots: 32,
            registrationAndMaterializationMs: 10 * sample,
            registrationsPerSecond: 3_200 / sample,
        }),
        "1 pass",
    ].join("\n");
}

describe("scale benchmark profiles", () => {
    test("profiles are named, deterministic, and inside the harness bounds", () => {
        expect(Object.keys(BENCHMARK_SUITES)).toEqual(["live", "planned-query"]);
        expect(Object.keys(SCALE_PROFILES)).toEqual(["ci-smoke", "client-max-accepted", "throughput"]);
        for (const [name, profile] of Object.entries(SCALE_PROFILES)) {
            expect(validateProfile(name, profile.values)).toBe(profile.values);
        }
        expect(SCALE_PROFILES["client-max-accepted"]?.values).toMatchObject({ mutationBatch: 32, subscriptions: 64 });
        expect(PLANNED_QUERY_PROFILES["ci-smoke"]).toMatchObject({
            defaultSamples: 3,
            values: { channels: 8, registrations: 32, bindingQueries: 32, bindingConcurrency: 8 },
        });
        expect(parseScaleArgs(["--suite", "planned-query"])).toMatchObject({
            suiteName: "planned-query",
            profileName: "ci-smoke",
            samples: 3,
        });
    });

    test("rejects an out-of-bound profile and CLI sample count before execution", () => {
        const profile = SCALE_PROFILES["ci-smoke"];
        if (!profile) throw new Error("missing ci-smoke profile");
        expect(() => validateProfile("hostile", { ...profile.values, subscriptions: 65 })).toThrow(
            "hostile.subscriptions must be an integer from 1 through 64"
        );
        expect(() => parseScaleArgs(["--samples", "21"])).toThrow("--samples must be an integer from 1 through 20");
        expect(() => parseScaleArgs(["--samples", "1; touch injected"])).toThrow(
            "--samples must be an integer from 1 through 20"
        );
        expect(() => parseScaleArgs(["--samples", "9".repeat(1_000)])).toThrow(
            "--samples must be an integer from 1 through 20"
        );
        expect(() => parseScaleArgs(["--profile", "missing"])).toThrow("Unknown scale profile");
        expect(() => parseScaleArgs(["--suite", "missing"])).toThrow("Unknown scale suite");
    });

    test("keeps every accepted sample combination inside the workflow budget", () => {
        const smoke = SCALE_PROFILES["ci-smoke"];
        const boundary = SCALE_PROFILES["client-max-accepted"];
        if (!smoke || !boundary) throw new Error("missing scale profiles");
        expect(validateRunBudget(smoke.values, 20)).toMatchObject({
            workflowJobMs: 7_200_000,
            setupReserveMs: 600_000,
            runMaximumMs: 2_400_000,
        });
        expect(validateRunBudget(boundary.values, 10)).toMatchObject({ runMaximumMs: 6_600_000 });
        expect(() => validateRunBudget(boundary.values, 11)).toThrow("exceeds the 6600000 ms benchmark allowance");
        expect(() => parseScaleArgs(["--profile", "client-max-accepted", "--samples", "11"])).toThrow(
            "exceeds the 6600000 ms benchmark allowance"
        );
    });

    test("collects comparison metadata locally and permits GitHub identity overrides", () => {
        const local = collectRunMetadata({}, "2026-08-24T00:00:00.000Z", () => "local-run");
        expect(local).toMatchObject({
            id: "local-run",
            startedAt: "2026-08-24T00:00:00.000Z",
            gitDirty: expect.any(Boolean),
            runtime: {
                bunVersion: Bun.version,
                platform: process.platform,
                architecture: process.arch,
                osRelease: expect.any(String),
                cpuModel: expect.any(String),
                logicalCpuCount: expect.any(Number),
            },
        });
        expect(local.gitSha).toMatch(/^[0-9a-f]{40}$/);
        expect(local.gitRef).not.toBe("unknown");

        const github = collectRunMetadata(
            { GITHUB_SHA: "github-sha", GITHUB_REF: "refs/pull/1/merge", GITHUB_RUN_ID: "10" },
            "2026-08-24T00:00:00.000Z",
            () => "unused"
        );
        expect(github).toMatchObject({ id: "github-10-1", gitSha: "github-sha", gitRef: "refs/pull/1/merge" });
    });
});

describe("scale benchmark evidence", () => {
    test("requires one valid record for each correctness scenario", () => {
        expect(parseHarnessMetrics(harnessOutput(1))).toHaveLength(2);
        expect(() => parseHarnessMetrics(harnessOutput(1).split("\n").slice(0, -2).join("\n"))).toThrow(
            "Expected 2 benchmark records"
        );
        expect(() => parseHarnessMetrics(`${harnessOutput(1)}\n${harnessOutput(1).split("\n")[1]}`)).toThrow(
            "Expected 2 benchmark records"
        );
    });

    test("binds every planned-query record to its required metrics and profile dimensions", () => {
        const profile = PLANNED_QUERY_PROFILES["ci-smoke"];
        if (!profile) throw new Error("missing planned-query ci-smoke profile");
        const validation = { suiteName: "planned-query", profile: profile.values };
        expect(
            parseHarnessMetrics(plannedQueryHarnessOutput(1), BENCHMARK_SUITES["planned-query"]?.scenarios, validation)
        ).toHaveLength(2);

        const missingMetric = plannedQueryHarnessOutput(1).replace('"organizations":2,', "");
        expect(() =>
            parseHarnessMetrics(missingMetric, BENCHMARK_SUITES["planned-query"]?.scenarios, validation)
        ).toThrow("must define exactly");

        const wrongDimensions = plannedQueryHarnessOutput(1).replace('"channels":8', '"channels":7');
        expect(() =>
            parseHarnessMetrics(wrongDimensions, BENCHMARK_SUITES["planned-query"]?.scenarios, validation)
        ).toThrow("channels must equal profile-derived value 8, received 7");

        const emptyRecords = ["planned-query-registered-pages", "native-binding-structured-select-pages"]
            .map(scenario => JSON.stringify({ type: "chardb-workerd-benchmark", scenario }))
            .join("\n");
        expect(() =>
            parseHarnessMetrics(emptyRecords, BENCHMARK_SUITES["planned-query"]?.scenarios, validation)
        ).toThrow("must define exactly");
    });

    test("writes comparison-ready samples and percentile summaries without thresholds", async () => {
        const outputDirectory = await mkdtemp(path.join(tmpdir(), "chardb-scale-report-"));
        temporaryDirectories.push(outputDirectory);
        const profile = SCALE_PROFILES["ci-smoke"];
        if (!profile) throw new Error("missing ci-smoke profile");
        const invocations: Array<{ environment: Record<string, string | undefined>; sampleIndex: number }> = [];

        const result = await runScaleBenchmark(
            {
                help: false,
                profileName: "ci-smoke",
                profile: profile.values,
                samples: 3,
                outputDirectory,
            },
            {
                environment: { GITHUB_SHA: "0123456789abcdef", GITHUB_REF: "refs/heads/main", CI: "true" },
                runHarness: async input => {
                    invocations.push({ environment: input.environment, sampleIndex: input.sampleIndex });
                    return harnessOutput(input.sampleIndex);
                },
            }
        );

        expect(invocations).toHaveLength(3);
        expect(invocations[0]?.environment).toMatchObject({
            CHARDB_WORKERD_CLIENTS_PER_TENANT: "1",
            CHARDB_WORKERD_MUTATIONS_PER_TENANT: "4",
            CHARDB_WORKERD_MUTATION_BATCH: "16",
            CHARDB_WORKERD_SUBSCRIPTIONS: "4",
            CHARDB_WORKERD_REFRESH_ROUNDS: "2",
            CHARDB_WORKERD_WAIT_MS: "5000",
            CHARDB_WORKERD_TEST_TIMEOUT_MS: "30000",
        });
        expect(result.records).toHaveLength(6);
        expect(
            result.records.every(
                record =>
                    record.schema === "chardb.scale.sample.v1" &&
                    record.correctness === "passed" &&
                    JSON.stringify(record.profile) ===
                        JSON.stringify({ name: "ci-smoke", values: SCALE_PROFILES["ci-smoke"]?.values })
            )
        ).toBe(true);

        const ndjson = (await readFile(result.ndjsonPath, "utf8"))
            .trim()
            .split("\n")
            .map(line => JSON.parse(line));
        expect(ndjson).toHaveLength(6);
        const report = JSON.parse(await readFile(result.reportPath, "utf8"));
        expect(report).toMatchObject({
            schema: "chardb.scale.report.v1",
            samples: 3,
            records: 6,
            profile: { name: "ci-smoke", values: SCALE_PROFILES["ci-smoke"]?.values },
        });
        expect(report.summaries[0]).toMatchObject({
            scenario: "sdk-two-tenant-mutation-fanout",
            sampleCount: 3,
            metrics: { initialMs: { minimum: 10, p50: 20, p95: 30, maximum: 30, mean: 20 } },
        });
        expect(JSON.stringify(report)).not.toContain("threshold");
        expect(JSON.parse(await readFile(result.runPath, "utf8"))).toMatchObject({
            schema: "chardb.scale.run.v1",
            status: "completed",
            samples: 3,
            completedSamples: 3,
            records: 6,
            failure: null,
            run: { gitSha: "0123456789abcdef" },
            profile: { name: "ci-smoke", values: SCALE_PROFILES["ci-smoke"]?.values },
        });
    });

    test("runs repeated planned-query and binding-select samples with one workload identity", async () => {
        const outputDirectory = await mkdtemp(path.join(tmpdir(), "chardb-planned-query-report-"));
        temporaryDirectories.push(outputDirectory);
        const profile = PLANNED_QUERY_PROFILES["ci-smoke"];
        if (!profile) throw new Error("missing planned-query ci-smoke profile");
        const invocations: Array<{ environment: Record<string, string | undefined>; suiteId: string }> = [];

        const result = await runScaleBenchmark(
            {
                help: false,
                suiteName: "planned-query",
                profileName: "ci-smoke",
                profile: profile.values,
                samples: 3,
                outputDirectory,
            },
            {
                environment: { GITHUB_SHA: "planned-query-sha", GITHUB_REF: "refs/heads/main", CI: "true" },
                runHarness: async input => {
                    invocations.push({ environment: input.environment, suiteId: input.suite.id });
                    const output = plannedQueryHarnessOutput(input.sampleIndex);
                    await writeFile(input.logPath, output, "utf8");
                    return output;
                },
            }
        );

        expect(invocations).toHaveLength(3);
        expect(invocations[0]).toMatchObject({
            suiteId: "planned-query-and-native-binding-select-v2",
            environment: {
                CDB_PLANNED_QUERY_BENCH_CHANNELS: "8",
                CDB_PLANNED_QUERY_BENCH_ROWS_PER_CHANNEL: "100",
                CDB_PLANNED_QUERY_BENCH_REGISTRATIONS: "32",
                CDB_PLANNED_QUERY_BENCH_PAGE_LIMIT: "25",
                CDB_PLANNED_QUERY_BENCH_BINDING_QUERIES: "32",
                CDB_PLANNED_QUERY_BENCH_BINDING_CONCURRENCY: "8",
                CDB_PLANNED_QUERY_BENCH_TEST_TIMEOUT_MS: "30000",
            },
        });
        expect(result.records).toHaveLength(6);
        expect(result.report).toMatchObject({
            schema: "chardb.scale.report.v1",
            suite: "planned-query-and-native-binding-select-v2",
            samples: 3,
            records: 6,
            workload: {
                suite: "planned-query",
                id: "planned-query-and-native-binding-select-v2",
                scenarios: ["planned-query-registered-pages", "native-binding-structured-select-pages"],
                profile: { name: "ci-smoke", values: profile.values },
            },
        });
        expect(result.report.summaries).toContainEqual(
            expect.objectContaining({
                scenario: "native-binding-structured-select-pages",
                sampleCount: 3,
                metrics: expect.objectContaining({
                    elapsedMs: { minimum: 20, p50: 40, p95: 60, maximum: 60, mean: 40 },
                    queriesPerSecond: {
                        minimum: 533.3333333333334,
                        p50: 800,
                        p95: 1_600,
                        maximum: 1_600,
                        mean: 977.7778,
                    },
                }),
            })
        );
        expect((await readFile(result.ndjsonPath, "utf8")).trim().split("\n")).toHaveLength(6);
        expect(await readFile(path.join(outputDirectory, "sample-001.log"), "utf8")).toBe(plannedQueryHarnessOutput(1));
    });

    test("writes structured metadata before sample one and retains failure status", async () => {
        const outputDirectory = await mkdtemp(path.join(tmpdir(), "chardb-scale-failure-"));
        temporaryDirectories.push(outputDirectory);
        const profile = SCALE_PROFILES["ci-smoke"];
        if (!profile) throw new Error("missing ci-smoke profile");
        let runningState: Record<string, unknown> | undefined;
        const failure = new Error("synthetic harness failure");

        await expect(
            runScaleBenchmark(
                {
                    help: false,
                    profileName: "ci-smoke",
                    profile: profile.values,
                    samples: 1,
                    outputDirectory,
                },
                {
                    environment: { GITHUB_SHA: "failure-sha", GITHUB_REF: "refs/heads/failure" },
                    now: () => "2026-08-24T00:00:00.000Z",
                    randomUUID: () => "failure-run",
                    runHarness: async () => {
                        runningState = JSON.parse(await readFile(path.join(outputDirectory, "run.json"), "utf8"));
                        throw failure;
                    },
                }
            )
        ).rejects.toBe(failure);

        expect(runningState).toMatchObject({
            status: "running",
            completedSamples: 0,
            run: { id: "failure-run", gitSha: "failure-sha" },
            profile: { name: "ci-smoke", values: profile.values },
        });
        expect(JSON.parse(await readFile(path.join(outputDirectory, "run.json"), "utf8"))).toMatchObject({
            status: "failed",
            completedSamples: 0,
            records: 0,
            failure: { name: "Error", message: "synthetic harness failure" },
        });
        await expect(access(path.join(outputDirectory, "samples.ndjson"))).rejects.toThrow();
    });

    test("refuses a nonempty output directory without deleting foreign files or starting work", async () => {
        const outputDirectory = await mkdtemp(path.join(tmpdir(), "chardb-scale-nonempty-"));
        temporaryDirectories.push(outputDirectory);
        const foreignPath = path.join(outputDirectory, "foreign.txt");
        await writeFile(foreignPath, "keep me", "utf8");
        const profile = SCALE_PROFILES["ci-smoke"];
        if (!profile) throw new Error("missing ci-smoke profile");
        let invoked = false;

        await expect(
            runScaleBenchmark(
                {
                    help: false,
                    profileName: "ci-smoke",
                    profile: profile.values,
                    samples: 1,
                    outputDirectory,
                },
                {
                    runHarness: async () => {
                        invoked = true;
                        return harnessOutput(1);
                    },
                }
            )
        ).rejects.toThrow("Scale output directory must be empty");
        expect(invoked).toBe(false);
        expect(await readFile(foreignPath, "utf8")).toBe("keep me");
    });
});
