import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertFileReshardDeploymentTeardown } from "../scripts/file-reshard-deployment-proof.mjs";
import {
    FILE_RESHARD_PROOF_ORCHESTRATOR_SCHEMA,
    FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA,
    assertFileReshardProofOwnership,
    cleanupFileReshardProofResources,
    cleanupFileReshardProofWorkloads,
    orchestrateFileReshardCloudflareProof,
    parseFileReshardProofOrchestratorArgs,
    provisionFileReshardProofResources,
    renderFileReshardLocalWrangler,
} from "../scripts/file-reshard-proof-orchestrator.mjs";
import {
    buildBrowserEvidence,
    buildFileReshardPair,
    buildFileReshardPreparation,
} from "./fixtures/release-evidence-builders.ts";

const temporary: string[] = [];

afterEach(async () => {
    await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function digest(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function requestUrl(value: RequestInfo | URL): URL {
    if (value instanceof URL) return value;
    return new URL(typeof value === "string" ? value : value.url);
}

async function workspace() {
    const root = await mkdtemp(path.join(tmpdir(), "chardb-reshard-orchestrator-"));
    temporary.push(root);
    const tarball = path.join(root, "candidate.tgz");
    const bytes = Buffer.from("one exact packed candidate");
    await writeFile(tarball, bytes);
    return {
        root,
        tarball,
        output: path.join(root, "evidence"),
        privateDir: path.join(root, "private"),
        candidate: { algorithm: "sha256" as const, digest: digest(bytes), bytes: bytes.byteLength },
    };
}

function options(input: Awaited<ReturnType<typeof workspace>>) {
    return {
        tarball: input.tarball,
        output: input.output,
        privateDir: input.privateDir,
        workersDevSubdomain: "proof-account",
        accountId: "a".repeat(32),
        cloudflareApiTokenFile: undefined,
        confirmed: true,
    };
}

async function dependencies(input: Awaited<ReturnType<typeof workspace>>, events: string[]) {
    const preparation = buildFileReshardPreparation(input.candidate);
    const app = path.join(input.privateDir, "app");
    const preparationPath = path.join(input.privateDir, "file-reshard-preparation.json");
    const browser = buildBrowserEvidence(input.candidate);
    const pair = buildFileReshardPair(input.candidate, preparation);
    return {
        prepare: async () => {
            events.push("prepare");
            await mkdir(app, { recursive: true });
            await writeFile(preparationPath, "{}\n");
            return { preparation: preparationPath, evidence: preparation };
        },
        validatePreparation: async () => ({
            app,
            candidate: input.candidate,
            receipt: preparation,
            evidence: preparation,
        }),
        runBrowserProof: async ({ reportPath }: { reportPath: string }) => {
            events.push("browser");
            await writeFile(reportPath, `${JSON.stringify(browser, null, 2)}\n`);
            return browser;
        },
        startLocal: async () => {
            events.push("local:start");
            return {
                origin: "http://127.0.0.1:18787",
                stop: async () => {
                    events.push("local:stop");
                },
            };
        },
        provision: async () => {
            events.push("provision");
            return { deploymentVersion: "version-1" };
        },
        runProof: async ({ output }: { output: string }) => {
            events.push("proof");
            await mkdir(output);
            await writeFile(path.join(output, "paired.json"), `${JSON.stringify(pair, null, 2)}\n`);
            await writeFile(path.join(output, "preparation.json"), `${JSON.stringify(preparation, null, 2)}\n`);
            await writeFile(
                path.join(output, "evidence.sha256"),
                `${digest(await readFile(path.join(output, "paired.json")))}  paired.json\n${digest(
                    await readFile(path.join(output, "preparation.json"))
                )}  preparation.json\n`
            );
            return pair;
        },
        cleanupWorkloads: async (_input?: { runKeys?: readonly string[] }) => {
            events.push("workloads:cleanup");
            return { done: true, remaining: 0 };
        },
        cleanupRemote: async () => {
            events.push("remote:cleanup");
            return {
                workerDeleted: true,
                bucketDeleted: true,
                vectorizeIndexDeleted: true,
                workerAbsentVerified: true,
                bucketAbsentVerified: true,
                vectorizeIndexAbsentVerified: true,
            };
        },
    };
}

describe("automatic file/vector reshard proof orchestration", () => {
    test("parses one-tarball execution and keeps public evidence outside the private tree", () => {
        const parsed = parseFileReshardProofOrchestratorArgs([
            "--tarball",
            "candidate.tgz",
            "--output",
            "evidence",
            "--private-dir",
            "private",
            "--workers-dev-subdomain",
            "proof-account",
            "--account-id",
            "A".repeat(32),
            "--confirm-disposable-resources",
        ]);
        expect(parsed).toMatchObject({
            accountId: "a".repeat(32),
            confirmed: true,
        });
        expect(() =>
            parseFileReshardProofOrchestratorArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "private/evidence",
                "--private-dir",
                "private",
                "--workers-dev-subdomain",
                "proof-account",
                "--account-id",
                "a".repeat(32),
                "--confirm-disposable-resources",
            ])
        ).toThrow("separate trees");
    });

    test("renders the native local target with exact Workerd, R2, and vector-probe bindings", () => {
        const target = "chardb-file-reshard-proof-aaaaaaaaaa-0123456789abcdef";
        const source = renderFileReshardLocalWrangler({
            target,
            candidateSha256: "a".repeat(64),
            configurationSha256: "b".repeat(64),
            runId: "local_orchestrator_run_1234",
        });
        const config = Bun.TOML.parse(source) as Record<string, unknown> & { vectorize?: unknown };
        expect(config).toMatchObject({
            name: target,
            main: "src/worker.ts",
            migrations: [
                {
                    tag: "init",
                    new_sqlite_classes: ["Cdb", "Catalog", "Gateway", "Resharder", "VectorIndexProbe"],
                },
            ],
            durable_objects: {
                bindings: [
                    { name: "CDB_CATALOG", class_name: "Catalog" },
                    { name: "CDB_SHARD", class_name: "Cdb" },
                    { name: "CDB_GATEWAY", class_name: "Gateway" },
                    { name: "CDB_RESHARD", class_name: "Resharder" },
                    { name: "CDB_VECTOR_PROBE", class_name: "VectorIndexProbe" },
                ],
            },
            r2_buckets: [{ binding: "CDB_FILES", bucket_name: target }],
            vars: {
                CDB_PROOF_TARGET_KIND: "local",
                CDB_PROOF_RUNTIME: "wrangler-miniflare-workerd",
                CDB_PROOF_CONFIGURATION_SHA256: "b".repeat(64),
                CDB_RELEASE_SHA256: "a".repeat(64),
                CDB_PROOF_RUN_ID: "local_orchestrator_run_1234",
            },
        });
        expect(config.vectorize).toBeUndefined();
    });

    test("runs every phase, scans evidence, and writes admission-ready supplemental manifests", async () => {
        const input = await workspace();
        const events: string[] = [];
        const result = await orchestrateFileReshardCloudflareProof(options(input), await dependencies(input, events));
        expect(result).toMatchObject({ schema: FILE_RESHARD_PROOF_ORCHESTRATOR_SCHEMA, ok: true });
        expect(events).toEqual([
            "prepare",
            "browser",
            "local:start",
            "provision",
            "proof",
            "workloads:cleanup",
            "local:stop",
            "remote:cleanup",
        ]);
        const teardown = assertFileReshardDeploymentTeardown(
            JSON.parse(await readFile(path.join(input.output, "teardown.json"), "utf8")),
            { candidateSha256: input.candidate.digest }
        );
        expect(teardown).toMatchObject({
            ok: true,
            localStateStopped: true,
            workerAbsentVerified: true,
            bucketAbsentVerified: true,
            vectorizeIndexAbsentVerified: true,
            idempotentReplay: { done: true, remaining: 0 },
        });
        expect(JSON.parse(await readFile(path.join(input.output, "orchestration.json"), "utf8"))).toMatchObject({
            ok: true,
            secretScanPassed: true,
        });
        expect((await readFile(path.join(input.output, "supplemental.sha256"), "utf8")).split("\n")).toEqual([
            expect.stringMatching(/^[a-f0-9]{64} {2}browser-proof\.json$/),
            expect.stringMatching(/^[a-f0-9]{64} {2}orchestration\.json$/),
            expect.stringMatching(/^[a-f0-9]{64} {2}teardown\.json$/),
            "",
        ]);
        expect(await readFile(path.join(input.output, "teardown.sha256"), "utf8")).toMatch(
            /^[a-f0-9]{64} {2}teardown\.json\n$/
        );
    });

    test("cannot claim success after a failed phase and still stops local state and verifies remote absence", async () => {
        const input = await workspace();
        const events: string[] = [];
        const injected = await dependencies(input, events);
        injected.provision = async () => {
            events.push("provision");
            throw new Error("provision failed after mutation intent");
        };
        await expect(orchestrateFileReshardCloudflareProof(options(input), injected)).rejects.toThrow(
            "provision failed after mutation intent"
        );
        expect(events).toEqual(["prepare", "browser", "local:start", "provision", "local:stop", "remote:cleanup"]);
        const orchestration = JSON.parse(await readFile(path.join(input.output, "orchestration.json"), "utf8"));
        expect(orchestration).toMatchObject({
            ok: false,
            phases: {
                localStopped: true,
                remoteCleanup: true,
            },
        });
        await expect(readFile(path.join(input.output, "teardown.json"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    test("cleans every planned run before bucket deletion when the paired runner fails after uploads", async () => {
        const input = await workspace();
        const events: string[] = [];
        const injected = await dependencies(input, events);
        const preparation = buildFileReshardPreparation(input.candidate);
        let recoveredRunKeys: readonly string[] = [];
        injected.runProof = async () => {
            events.push("proof");
            throw new Error("paired runner failed after uploads");
        };
        injected.cleanupWorkloads = async cleanup => {
            events.push("workloads:cleanup");
            recoveredRunKeys = cleanup?.runKeys ?? [];
            return { done: true, remaining: 0 };
        };
        await expect(orchestrateFileReshardCloudflareProof(options(input), injected)).rejects.toThrow(
            "paired runner failed after uploads"
        );
        expect(recoveredRunKeys).toEqual([
            `${preparation.runId}_warmup`,
            `${preparation.runId}_0`,
            `${preparation.runId}_1`,
            `${preparation.runId}_2`,
        ]);
        expect(events).toEqual([
            "prepare",
            "browser",
            "local:start",
            "provision",
            "proof",
            "workloads:cleanup",
            "local:stop",
            "remote:cleanup",
        ]);
        expect(JSON.parse(await readFile(path.join(input.output, "orchestration.json"), "utf8"))).toMatchObject({
            ok: false,
            phases: {
                pair: false,
                workloadCleanup: true,
                remoteCleanup: true,
            },
        });
        await expect(readFile(path.join(input.output, "teardown.json"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    test("records every target cleanup failure before deleting remote resources", async () => {
        const input = await workspace();
        const events: string[] = [];
        const injected = await dependencies(input, events);
        injected.runProof = async () => {
            events.push("proof");
            throw new Error("paired runner failed after uploads");
        };
        injected.cleanupWorkloads = async () => {
            events.push("workloads:cleanup");
            throw new AggregateError(
                [new Error("local cleanup failed"), new Error("deployed cleanup failed")],
                "file reshard workload cleanup failed for local, deployed"
            );
        };

        const error = await orchestrateFileReshardCloudflareProof(options(input), injected).catch(cause => cause);

        expect(error.message).toContain(
            "paired runner failed after uploads; file reshard workload cleanup failed for local, deployed; local cleanup failed; deployed cleanup failed"
        );
        expect(events).toEqual([
            "prepare",
            "browser",
            "local:start",
            "provision",
            "proof",
            "workloads:cleanup",
            "local:stop",
            "remote:cleanup",
        ]);
        const orchestration = JSON.parse(await readFile(path.join(input.output, "orchestration.json"), "utf8"));
        expect(orchestration.error).toContain(
            "paired runner failed after uploads; file reshard workload cleanup failed for local, deployed; local cleanup failed; deployed cleanup failed"
        );
    });

    test("uses the existing Wrangler command plan and records mutation intent before each create", async () => {
        const input = await workspace();
        await mkdir(input.privateDir);
        const ownershipPath = path.join(input.privateDir, "ownership.json");
        const name = `chardb-file-reshard-proof-${input.candidate.digest.slice(0, 10)}-0123456789abcdef`;
        await writeFile(
            ownershipPath,
            `${JSON.stringify({
                schema: FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA,
                candidateSha256: input.candidate.digest,
                nonce: "0123456789abcdef",
                runId: "orchestration_run_1234",
                worker: name,
                bucket: name,
                vectorizeIndex: name,
                workerAbsentConfirmed: false,
                bucketAbsentConfirmed: false,
                vectorizeIndexAbsentConfirmed: false,
                bucketCreateIntent: false,
                bucketCreated: false,
                vectorizeIndexCreateIntent: false,
                vectorizeIndexCreated: false,
                metadataIndexCreateIntent: false,
                metadataIndexCreated: false,
                workerCreateIntent: false,
                workerCreated: false,
            })}\n`
        );
        const calls: string[][] = [];
        const runCommand = async (_command: string, args: string[]) => {
            calls.push(args);
            if (args[0] === "versions") {
                return {
                    exitCode: 0,
                    stdout: calls.length === 1 ? "[]" : '[{"id":"version-1","number":1}]',
                    stderr: "",
                };
            }
            if (args[0] === "r2" && args[1] === "bucket" && args[2] === "list") {
                return { exitCode: 0, stdout: "[]", stderr: "" };
            }
            if (args[0] === "vectorize" && args[1] === "list") {
                return { exitCode: 0, stdout: "[]", stderr: "" };
            }
            if (args[0] === "vectorize" && args[1] === "get" && calls.length === 4) {
                return { exitCode: 1, stdout: "", stderr: "not found" };
            }
            if (args[0] === "vectorize" && args[1] === "list-metadata-index") {
                return {
                    exitCode: 0,
                    stdout: '[{"propertyName":"cdb_resource","type":"string"}]',
                    stderr: "",
                };
            }
            if (args[0] === "vectorize" && args[1] === "get") {
                return {
                    exitCode: 0,
                    stdout: JSON.stringify({ name, config: { dimensions: 32, metric: "cosine" } }),
                    stderr: "",
                };
            }
            return { exitCode: 0, stdout: "{}", stderr: "" };
        };
        const provisioned = await provisionFileReshardProofResources(
            {
                options: { accountId: "a".repeat(32) },
                apiToken: undefined,
                prepared: { app: input.root },
                wrangler: "/proof/wrangler",
                ownershipPath,
                expectedOwnership: {
                    candidateSha256: input.candidate.digest,
                    nonce: "0123456789abcdef",
                    runId: "orchestration_run_1234",
                    worker: name,
                    bucket: name,
                    vectorizeIndex: name,
                },
                secrets: [],
                secretsFile: path.join(input.privateDir, "secrets.env"),
            },
            { runCommand, now: Date.now, sleep: async () => undefined, pollTimeoutMs: 1_000 }
        );
        expect(provisioned.deploymentVersion).toBe("version-1");
        expect(calls.some(args => args[0] === "r2" && args[1] === "bucket" && args[2] === "create")).toBe(true);
        expect(calls.some(args => args[0] === "vectorize" && args[1] === "create")).toBe(true);
        expect(calls.some(args => args[0] === "deploy" && args.includes("--secrets-file"))).toBe(true);
        expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toMatchObject({
            bucketCreateIntent: true,
            bucketCreated: true,
            vectorizeIndexCreateIntent: true,
            vectorizeIndexCreated: true,
            metadataIndexCreateIntent: true,
            metadataIndexCreated: true,
            workerCreateIntent: true,
            workerCreated: true,
        });
    });

    test("always uses the owned cleanup plan and waits for three independent absence views", async () => {
        const input = await workspace();
        await mkdir(input.privateDir);
        const ownershipPath = path.join(input.privateDir, "ownership.json");
        const name = `chardb-file-reshard-proof-${input.candidate.digest.slice(0, 10)}-0123456789abcdef`;
        await writeFile(
            ownershipPath,
            `${JSON.stringify({
                schema: FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA,
                candidateSha256: input.candidate.digest,
                nonce: "0123456789abcdef",
                runId: "orchestration_run_1234",
                worker: name,
                bucket: name,
                vectorizeIndex: name,
                workerAbsentConfirmed: true,
                bucketAbsentConfirmed: true,
                vectorizeIndexAbsentConfirmed: true,
                bucketCreateIntent: true,
                bucketCreated: true,
                vectorizeIndexCreateIntent: true,
                vectorizeIndexCreated: true,
                metadataIndexCreateIntent: true,
                metadataIndexCreated: true,
                workerCreateIntent: true,
                workerCreated: true,
            })}\n`
        );
        const deletes: string[] = [];
        let workerReads = 0;
        let bucketReads = 0;
        let indexReads = 0;
        const runCommand = async (_command: string, args: string[]) => {
            if (args[0] === "delete") {
                deletes.push("worker");
                return { exitCode: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "r2" && args[2] === "delete") {
                deletes.push("bucket");
                return { exitCode: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "vectorize" && args[1] === "delete") {
                deletes.push("index");
                return { exitCode: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "versions") {
                workerReads++;
                return { exitCode: 0, stdout: workerReads === 1 ? '[{"id":"version-1"}]' : "[]", stderr: "" };
            }
            if (args[0] === "r2") {
                bucketReads++;
                return { exitCode: 0, stdout: bucketReads === 1 ? JSON.stringify([{ name }]) : "[]", stderr: "" };
            }
            if (args[0] === "vectorize" && args[1] === "get") {
                indexReads++;
                return indexReads === 1
                    ? {
                          exitCode: 0,
                          stdout: JSON.stringify({ name, config: { dimensions: 32, metric: "cosine" } }),
                          stderr: "",
                      }
                    : { exitCode: 1, stdout: "", stderr: "not found" };
            }
            return { exitCode: 0, stdout: indexReads === 1 ? JSON.stringify([{ name }]) : "[]", stderr: "" };
        };
        const cleaned = await cleanupFileReshardProofResources(
            {
                options: { accountId: "a".repeat(32) },
                apiToken: undefined,
                prepared: { app: input.root },
                wrangler: "/proof/wrangler",
                ownershipPath,
                expectedOwnership: {
                    candidateSha256: input.candidate.digest,
                    nonce: "0123456789abcdef",
                    runId: "orchestration_run_1234",
                    worker: name,
                    bucket: name,
                    vectorizeIndex: name,
                },
                secrets: [],
            },
            { runCommand, now: Date.now, sleep: async () => undefined, pollTimeoutMs: 1_000 }
        );
        expect(deletes).toEqual(["worker", "bucket", "index"]);
        expect(cleaned).toEqual({
            workerDeleted: true,
            bucketDeleted: true,
            vectorizeIndexDeleted: true,
            workerAbsentVerified: true,
            bucketAbsentVerified: true,
            vectorizeIndexAbsentVerified: true,
        });
        expect(workerReads).toBe(2);
        expect(bucketReads).toBe(2);
        expect(indexReads).toBe(2);
    });

    test("deletes only resources with a recorded creation intent", async () => {
        const input = await workspace();
        await mkdir(input.privateDir);
        const ownershipPath = path.join(input.privateDir, "ownership.json");
        const nonce = "0123456789abcdef";
        const name = `chardb-file-reshard-proof-${input.candidate.digest.slice(0, 10)}-${nonce}`;
        const expectedOwnership = {
            candidateSha256: input.candidate.digest,
            nonce,
            runId: "orchestration_run_1234",
            worker: name,
            bucket: name,
            vectorizeIndex: name,
        };
        await writeFile(
            ownershipPath,
            `${JSON.stringify({
                schema: FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA,
                ...expectedOwnership,
                workerAbsentConfirmed: true,
                bucketAbsentConfirmed: true,
                vectorizeIndexAbsentConfirmed: true,
                bucketCreateIntent: true,
                bucketCreated: false,
                vectorizeIndexCreateIntent: false,
                vectorizeIndexCreated: false,
                metadataIndexCreateIntent: false,
                metadataIndexCreated: false,
                workerCreateIntent: false,
                workerCreated: false,
            })}\n`
        );
        const deletes: string[] = [];
        const runCommand = async (_command: string, args: string[]) => {
            if (args[0] === "delete") deletes.push("worker");
            if (args[0] === "r2" && args[2] === "delete") deletes.push("bucket");
            if (args[0] === "vectorize" && args[1] === "delete") deletes.push("index");
            if (args[0] === "versions") return { exitCode: 0, stdout: "[]", stderr: "" };
            if (args[0] === "r2" && args[1] === "bucket" && args[2] === "list") {
                return { exitCode: 0, stdout: "[]", stderr: "" };
            }
            if (args[0] === "vectorize" && args[1] === "get") {
                return { exitCode: 1, stdout: "", stderr: "not found" };
            }
            return { exitCode: 0, stdout: "[]", stderr: "" };
        };

        await cleanupFileReshardProofResources(
            {
                options: { accountId: "a".repeat(32) },
                apiToken: undefined,
                prepared: { app: input.root },
                wrangler: "/proof/wrangler",
                ownershipPath,
                expectedOwnership,
                secrets: [],
            },
            { runCommand, now: Date.now, sleep: async () => undefined, pollTimeoutMs: 1_000 }
        );

        expect(deletes).toEqual(["bucket"]);
    });

    test("waits for both cleanup targets and preserves failures in target order", async () => {
        let resolveDeployed: ((response: Response) => void) | undefined;
        const firstDeployed = new Promise<Response>(resolve => {
            resolveDeployed = resolve;
        });
        let deployedCalls = 0;
        let settled = false;
        const outcome = cleanupFileReshardProofWorkloads(
            {
                runKeys: ["proof_run_0"],
                localOrigin: "http://127.0.0.1:8787",
                deployedOrigin: "https://proof.example.workers.dev",
                token: "test-token",
                runId: "orchestration_run_1234",
            },
            {
                fetch: async (request: RequestInfo | URL) => {
                    if (requestUrl(request).protocol === "http:") return new Response("{}", { status: 400 });
                    deployedCalls++;
                    if (deployedCalls === 1) return firstDeployed;
                    return Response.json({ done: true, remaining: 0 });
                },
            }
        ).then(
            value => value,
            error => error
        );
        void outcome.finally(() => {
            settled = true;
        });

        await Bun.sleep(0);
        expect(settled).toBeFalse();
        resolveDeployed?.(Response.json({ done: true, remaining: 0 }));
        const error = await outcome;

        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toBe("file reshard workload cleanup failed for local");
        expect(error.errors.map((cause: Error) => cause.message)).toEqual(["local workload cleanup failed with 400"]);
        expect(deployedCalls).toBe(2);
    });

    test("bounds transient cleanup retries by one target deadline", async () => {
        let clock = 0;
        const calls = { local: 0, deployed: 0 };
        const error = await cleanupFileReshardProofWorkloads(
            {
                runKeys: ["proof_run_0"],
                localOrigin: "http://127.0.0.1:8787",
                deployedOrigin: "https://proof.example.workers.dev",
                token: "test-token",
                runId: "orchestration_run_1234",
            },
            {
                fetch: async (request: RequestInfo | URL) => {
                    const kind = requestUrl(request).protocol === "http:" ? "local" : "deployed";
                    calls[kind]++;
                    return new Response("{}", { status: 503 });
                },
                now: () => clock,
                sleep: async (milliseconds: number) => {
                    clock += milliseconds;
                },
                cleanupTimeoutMs: 20,
                cleanupIntervalMs: 10,
                requestTimeoutMs: 5,
            }
        ).catch(cause => cause);

        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toBe("file reshard workload cleanup failed for local, deployed");
        expect(error.errors).toHaveLength(2);
        expect(calls.local).toBeGreaterThan(0);
        expect(calls.deployed).toBeGreaterThan(0);
        expect(calls.local).toBeLessThanOrEqual(4);
        expect(calls.deployed).toBeLessThanOrEqual(4);
    });

    test("refuses cleanup when the private ledger is retargeted to another proof run", async () => {
        const input = await workspace();
        const nonce = "0123456789abcdef";
        const name = `chardb-file-reshard-proof-${input.candidate.digest.slice(0, 10)}-${nonce}`;
        const expected = {
            candidateSha256: input.candidate.digest,
            nonce,
            runId: "orchestration_run_1234",
            worker: name,
            bucket: name,
            vectorizeIndex: name,
        };
        const ledger = {
            schema: FILE_RESHARD_PROOF_OWNERSHIP_SCHEMA,
            ...expected,
            workerAbsentConfirmed: true,
            bucketAbsentConfirmed: true,
            vectorizeIndexAbsentConfirmed: true,
            bucketCreateIntent: true,
            bucketCreated: true,
            vectorizeIndexCreateIntent: true,
            vectorizeIndexCreated: true,
            metadataIndexCreateIntent: true,
            metadataIndexCreated: true,
            workerCreateIntent: true,
            workerCreated: true,
        };
        expect(assertFileReshardProofOwnership(ledger, expected)).toBe(ledger);
        expect(() =>
            assertFileReshardProofOwnership(
                {
                    ...ledger,
                    nonce: "fedcba9876543210",
                    worker: `chardb-file-reshard-proof-${input.candidate.digest.slice(0, 10)}-fedcba9876543210`,
                    bucket: `chardb-file-reshard-proof-${input.candidate.digest.slice(0, 10)}-fedcba9876543210`,
                    vectorizeIndex: `chardb-file-reshard-proof-${input.candidate.digest.slice(0, 10)}-fedcba9876543210`,
                },
                expected
            )
        ).toThrow("nonce drifted from the prepared run");
        expect(() => assertFileReshardProofOwnership({ ...ledger, workerCreateIntent: false }, expected)).toThrow(
            "Worker creation state is impossible"
        );
        expect(() => assertFileReshardProofOwnership({ ...ledger, extra: true }, expected)).toThrow(
            "fields must be exactly"
        );
    });
});
