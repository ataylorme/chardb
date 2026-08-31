import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILE_BENCHMARK_PROFILE } from "../scripts/file-benchmark-report.mjs";
import {
    FILE_BENCHMARK_DEFAULTS,
    alternatingTargetOrder,
    deterministicFilePayload,
    parseFileBenchmarkArgs,
    runFileBenchmarkUploadHook,
    validateFileBenchmarkEvidence,
} from "../scripts/run-file-benchmark.mjs";

const originalAdminToken = process.env.CHARDB_FILE_BENCH_ADMIN_TOKEN;
const originalRunId = process.env.CHARDB_FILE_BENCH_RUN_ID;

function pairSkeleton(): Record<string, unknown> {
    const passed = {
        nativeBetterAuth: true,
        organizationIsolation: true,
        exactBytes: true,
        exactDigest: true,
        cleanupComplete: true,
    };
    return {
        schema: "chardb.file-benchmark.pair.v1",
        ok: true,
        candidate: { sha256: "a".repeat(64), bytes: 1 },
        profile: FILE_BENCHMARK_PROFILE,
        execution: { startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:01:00.000Z" },
        executionOrder: Array.from({ length: FILE_BENCHMARK_PROFILE.logicalRuns }, (_, run) =>
            FILE_BENCHMARK_PROFILE.payloads.map((payload, payloadIndex) => ({
                run,
                payload: payload.name,
                targets: alternatingTargetOrder(run + payloadIndex),
            }))
        ).flat(),
        reports: {
            local: { path: "local.json", sha256: "b".repeat(64) },
            cloudflare: { path: "cloudflare.json", sha256: "c".repeat(64) },
            comparison: { path: "comparison.json", sha256: "d".repeat(64) },
        },
        runs: Array.from({ length: FILE_BENCHMARK_PROFILE.logicalRuns }, (_, sequence) => ({
            sequence,
            local: { ...passed },
            cloudflare: { ...passed },
        })),
    };
}

function setCredentials(): void {
    process.env.CHARDB_FILE_BENCH_ADMIN_TOKEN = "admin-token-for-tests";
    process.env.CHARDB_FILE_BENCH_RUN_ID = "run-id-for-tests";
}

function requiredArgs(): string[] {
    return [
        "--tarball",
        "/private/tmp/candidate.tgz",
        "--output",
        "/private/tmp/file-benchmark-output",
        "--local-url",
        "http://127.0.0.1:8787",
        "--cloudflare-url",
        "https://file-proof.example.workers.dev",
        "--local-bucket",
        "local-proof-files",
        "--cloudflare-bucket",
        "remote-proof-files",
        "--cloudflare-deployment-version",
        "9b6bf8d3-79e2-4eaf-b03f-35e05ad756a8",
        "--wrangler-version",
        "4.100.0",
    ];
}

afterEach(() => {
    if (originalAdminToken === undefined) Reflect.deleteProperty(process.env, "CHARDB_FILE_BENCH_ADMIN_TOKEN");
    else process.env.CHARDB_FILE_BENCH_ADMIN_TOKEN = originalAdminToken;
    if (originalRunId === undefined) Reflect.deleteProperty(process.env, "CHARDB_FILE_BENCH_RUN_ID");
    else process.env.CHARDB_FILE_BENCH_RUN_ID = originalRunId;
});

describe("paired file benchmark runner", () => {
    test("binds the exact local and deployed identities with production-sized defaults", () => {
        setCredentials();
        const parsed = parseFileBenchmarkArgs(requiredArgs());
        expect(parsed).toMatchObject({
            help: false,
            localUrl: new URL("http://127.0.0.1:8787"),
            cloudflareUrl: new URL("https://file-proof.example.workers.dev"),
            localBucket: "local-proof-files",
            cloudflareBucket: "remote-proof-files",
            cloudflareDeploymentVersion: "9b6bf8d3-79e2-4eaf-b03f-35e05ad756a8",
            wranglerVersion: "4.100.0",
        });
        expect(FILE_BENCHMARK_DEFAULTS.largeBytes).toBeLessThanOrEqual(25 * 1_024 * 1_024);
    });

    test("keeps the standard workload immutable", () => {
        setCredentials();
        expect(() => parseFileBenchmarkArgs([...requiredArgs(), "--runs", "7"])).toThrow("unknown");
        expect(() => parseFileBenchmarkArgs([...requiredArgs(), "--wrangler-version", "4.101.0"])).toThrow("only once");
        expect(FILE_BENCHMARK_PROFILE).toEqual({
            name: "standard-v1",
            logicalRuns: 5,
            payloads: [
                {
                    name: "small",
                    payloadBytes: 64 * 1_024,
                    warmupObjectsPerRun: 1,
                    operationsPerRun: {
                        upload: { count: 32, concurrency: 4 },
                        attach: { count: 32, concurrency: 4 },
                        download: { count: 64, concurrency: 8 },
                    },
                },
                {
                    name: "large",
                    payloadBytes: 5 * 1_024 * 1_024,
                    warmupObjectsPerRun: 1,
                    operationsPerRun: {
                        upload: { count: 4, concurrency: 1 },
                        attach: { count: 4, concurrency: 1 },
                        download: { count: 8, concurrency: 2 },
                    },
                },
            ],
        });
    });

    test("requires loopback locally, HTTPS remotely, and private credentials in the environment", () => {
        setCredentials();
        const remoteLocal = requiredArgs();
        remoteLocal[remoteLocal.indexOf("--local-url") + 1] = "https://example.com";
        expect(() => parseFileBenchmarkArgs(remoteLocal)).toThrow("HTTP loopback");
        const insecureCloudflare = requiredArgs();
        insecureCloudflare[insecureCloudflare.indexOf("--cloudflare-url") + 1] = "http://workers.example";
        expect(() => parseFileBenchmarkArgs(insecureCloudflare)).toThrow("must use HTTPS");
        Reflect.deleteProperty(process.env, "CHARDB_FILE_BENCH_ADMIN_TOKEN");
        expect(() => parseFileBenchmarkArgs(requiredArgs())).toThrow("CHARDB_FILE_BENCH_ADMIN_TOKEN");
    });

    test("alternates the target that runs first for every bounded batch", () => {
        expect(alternatingTargetOrder(0)).toEqual(["local", "cloudflare"]);
        expect(alternatingTargetOrder(1)).toEqual(["cloudflare", "local"]);
        expect(alternatingTargetOrder(2)).toEqual(["local", "cloudflare"]);
        expect(() => alternatingTargetOrder(-1)).toThrow("non-negative");
    });

    test("builds reproducible payloads without sharing one size's bytes with another", () => {
        const first = deterministicFilePayload(128, "candidate-a");
        const retry = deterministicFilePayload(128, "candidate-a");
        const other = deterministicFilePayload(256, "candidate-a");
        expect(first).toEqual(retry);
        expect(first).not.toEqual(other.subarray(0, first.length));
        expect(() => deterministicFilePayload(0, "candidate-a")).toThrow("payload size");
        expect(() => deterministicFilePayload(1, "")).toThrow("seed");
    });

    test("awaits the ownership hook for every identified target upload", async () => {
        const observed: string[] = [];
        let release: (() => void) | undefined;
        const blocked = runFileBenchmarkUploadHook(
            async (targetKind, upload) => {
                observed.push(`${targetKind}:${upload.organizationId}:${upload.fileId}`);
                await new Promise<void>(resolve => {
                    release = resolve;
                });
            },
            "cloudflare",
            { organizationId: "org-1", fileId: "file-1" }
        );
        await Promise.resolve();
        expect(observed).toEqual(["cloudflare:org-1:file-1"]);
        release?.();
        await blocked;
        await expect(
            runFileBenchmarkUploadHook(undefined, "local", { organizationId: "org-2", fileId: "file-2" })
        ).resolves.toBeUndefined();
        await expect(
            runFileBenchmarkUploadHook(undefined, "invalid" as "local", {
                organizationId: "org-2",
                fileId: "file-2",
            })
        ).rejects.toThrow("target kind");
    });

    test("rejects unknown pair fields and canonical path, digest, order, and run drift", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "chardb-file-benchmark-evidence-"));
        try {
            const cases: Array<[Record<string, unknown>, string]> = [
                [{ ...pairSkeleton(), unknown: true }, "unknown or missing fields"],
                [
                    {
                        ...pairSkeleton(),
                        reports: {
                            ...(pairSkeleton().reports as Record<string, unknown>),
                            local: { path: "../local.json", sha256: "b".repeat(64) },
                        },
                    },
                    "local path drifted",
                ],
                [
                    {
                        ...pairSkeleton(),
                        reports: {
                            ...(pairSkeleton().reports as Record<string, unknown>),
                            local: { path: "local.json", sha256: "BAD" },
                        },
                    },
                    "local SHA-256",
                ],
            ];
            const orderDrift = pairSkeleton();
            (orderDrift.executionOrder as Array<Record<string, unknown>>)[0] = {
                ...(orderDrift.executionOrder as Array<Record<string, unknown>>)[0],
                targets: ["cloudflare", "local"],
            };
            cases.push([orderDrift, "execution order drifted"]);
            const runDrift = pairSkeleton();
            (runDrift.runs as Array<Record<string, unknown>>)[0] = {
                ...(runDrift.runs as Array<Record<string, unknown>>)[0],
                unknown: true,
            };
            cases.push([runDrift, "run evidence 0"]);
            for (const [pair, message] of cases) {
                await writeFile(path.join(directory, "paired.json"), `${JSON.stringify(pair)}\n`);
                await expect(validateFileBenchmarkEvidence(directory)).rejects.toThrow(message);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
