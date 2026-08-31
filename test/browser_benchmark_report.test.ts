import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BROWSER_REPORT_SCHEMA,
    buildBrowserMeasurement,
    defaultBrowserReportPath,
    fingerprintFile,
    parseBrowserSamplePlan,
    summarizeBrowserTimings,
    writeJsonAtomically,
} from "../scripts/browser-benchmark-report.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "chardb-browser-report-"));
    temporaryDirectories.push(directory);
    return directory;
}

describe("packed browser benchmark reports", () => {
    test("keeps the existing smoke sample count and gives benchmark runs a warmup", () => {
        expect(parseBrowserSamplePlan("smoke")).toEqual({ name: "smoke", samples: 3, warmupSamples: 0 });
        expect(parseBrowserSamplePlan("benchmark")).toEqual({ name: "benchmark", samples: 25, warmupSamples: 1 });
        expect(parseBrowserSamplePlan("benchmark", "7", "2")).toEqual({
            name: "benchmark",
            samples: 7,
            warmupSamples: 2,
        });
    });

    test("rejects unknown profiles and unbounded sample input", () => {
        expect(() => parseBrowserSamplePlan("long-haul")).toThrow("unknown CDB_BROWSER_E2E_PROFILE");
        expect(() => parseBrowserSamplePlan("smoke", "0")).toThrow("CDB_BROWSER_E2E_SAMPLES");
        expect(() => parseBrowserSamplePlan("smoke", "101")).toThrow("CDB_BROWSER_E2E_SAMPLES");
        expect(() => parseBrowserSamplePlan("smoke", "1.5")).toThrow("CDB_BROWSER_E2E_SAMPLES");
        expect(() => parseBrowserSamplePlan("smoke", "1", "21")).toThrow("CDB_BROWSER_E2E_WARMUP_SAMPLES");
    });

    test("summarizes a copy and retains the adverse latency tail", () => {
        const timings = [30, 10, 20, 40];
        expect(summarizeBrowserTimings(timings)).toEqual({
            minimum: 10,
            p50: 20,
            p95: 40,
            maximum: 40,
            mean: 25,
        });
        expect(timings).toEqual([30, 10, 20, 40]);
        expect(() => summarizeBrowserTimings([])).toThrow("empty timing sample");
    });

    test("retains every raw sample beside its summary", () => {
        const firstSample = {
            id: "browser-e2e-0",
            authReadyMs: 11,
            initialQueryMs: 21,
            mutationAckMs: 31,
            liveUpdateMs: 41,
        };
        const samples = [firstSample, { authReadyMs: 12, initialQueryMs: 22, mutationAckMs: 32, liveUpdateMs: 42 }];
        const warmups = [{ authReadyMs: 50, initialQueryMs: 60, mutationAckMs: 70, liveUpdateMs: 80 }];
        const measurement = buildBrowserMeasurement(samples, warmups, {
            wranglerReadyMs: 100,
            persistedReadMs: 25,
            persistedInitialQueryMs: 10,
        });

        expect(measurement.samples).toEqual([
            {
                index: 0,
                timingsMs: { authReady: 11, initialQuery: 21, mutationAck: 31, liveUpdate: 41 },
            },
            {
                index: 1,
                timingsMs: { authReady: 12, initialQuery: 22, mutationAck: 32, liveUpdate: 42 },
            },
        ]);
        expect(measurement.warmups).toEqual([
            {
                index: 0,
                timingsMs: { authReady: 50, initialQuery: 60, mutationAck: 70, liveUpdate: 80 },
            },
        ]);
        expect(measurement.summaries.authReadyMs).toEqual({
            minimum: 11,
            p50: 11,
            p95: 12,
            maximum: 12,
            mean: 11.5,
        });
        expect(() =>
            buildBrowserMeasurement([{ ...firstSample, liveUpdateMs: -1 }], [], {
                wranglerReadyMs: 100,
                persistedReadMs: 25,
                persistedInitialQueryMs: 10,
            })
        ).toThrow("invalid liveUpdateMs");
        expect(() =>
            buildBrowserMeasurement(samples, [], {
                wranglerReadyMs: Number.NaN,
                persistedReadMs: 25,
                persistedInitialQueryMs: 10,
            })
        ).toThrow("invalid wranglerReadyMs");
    });

    test("fingerprints the exact tarball bytes", async () => {
        const directory = await temporaryDirectory();
        const tarball = path.join(directory, "chardb.tgz");
        await writeFile(tarball, "packed chardb\n");

        expect(await fingerprintFile(tarball)).toEqual({
            algorithm: "sha256",
            digest: "fb14849b89b40ea73af31fde327ac31f50060ff8b96d1383eb6423f6ab3b3dcc",
            bytes: 14,
        });
        expect(defaultBrowserReportPath(tarball)).toBe(`${tarball}.browser-e2e.json`);
    });

    test("atomically replaces a machine-readable report", async () => {
        const directory = await temporaryDirectory();
        const reportPath = path.join(directory, "nested", "report.json");
        await writeJsonAtomically(reportPath, { schema: "stale" });
        const report = { schema: BROWSER_REPORT_SCHEMA, samples: [{ authReadyMs: 12.5 }] };

        expect(await writeJsonAtomically(reportPath, report)).toBe(reportPath);
        expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(writeJsonAtomically(reportPath, circular)).rejects.toThrow();
        expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
        expect(await readdir(path.dirname(reportPath))).toEqual(["report.json"]);
    });
});
