import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    FILE_RESHARD_BENCHMARK_PHASES,
    FILE_RESHARD_BENCHMARK_PROFILES,
} from "../scripts/file-reshard-benchmark-report.mjs";
import {
    FILE_RESHARD_DEPLOYMENT_BINDINGS,
    FILE_RESHARD_DEPLOYMENT_CORRECTNESS,
    FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA,
    FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA,
    FILE_RESHARD_LOCAL_BINDINGS,
} from "../scripts/file-reshard-deployment-proof.mjs";
import {
    fileReshardDeploymentRunKey,
    inspectDisposableDeployment,
    parseFileReshardDeploymentProofArgs,
    requestFileReshardDeploymentSample,
    runFileReshardDeploymentProof,
    wranglerDeploymentInspectionCommands,
    wranglerDisposableCleanupCommands,
    wranglerDisposableDeploymentCommands,
} from "../scripts/run-file-reshard-deployment-proof.mjs";

const NAME = "chardb-file-reshard-proof-unit";
const RUN_ID = "deployment_proof_run_1234";
const DIGEST = "a".repeat(64);
const CONFIGURATION_DIGEST = "c".repeat(64);
const temporary: string[] = [];

afterEach(async () => {
    await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function argumentsForProof() {
    return [
        "--package",
        "candidate.tgz",
        "--preparation",
        "preparation.json",
        "--output",
        "evidence",
        "--wrangler",
        "node_modules/.bin/wrangler",
        "--local-url",
        "http://127.0.0.1:8787",
        "--deployed-url",
        "https://proof.example.workers.dev",
        "--local-token-file",
        "local.token",
        "--deployed-token-file",
        "deployed.token",
        "--cloudflare-api-token-file",
        "cloudflare.token",
        "--cloudflare-account-id",
        "account_identifier_1234",
        "--worker",
        NAME,
        "--bucket",
        NAME,
        "--vectorize-index",
        NAME,
        "--deployment-version",
        "version-1",
        "--configuration-sha256",
        CONFIGURATION_DIGEST,
        "--run-id",
        RUN_ID,
        "--profile",
        "small",
        "--confirm-disposable-target",
    ];
}

function sample(kind: "local" | "deployed", sequence: number, runKey: string, candidateSha256 = DIGEST) {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES.small;
    if (!profile) throw new Error("small profile is missing");
    const identity = "b".repeat(64);
    return {
        schema: FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA,
        sequence,
        excluded: sequence === -1,
        candidateSha256,
        runKey,
        workload: { id: "file-vector-aware-range-move", version: 3, profile },
        target: {
            kind,
            runtime: kind === "local" ? "miniflare/workerd" : "cloudflare-workers",
            deploymentVersion: kind === "local" ? "local-dev" : "version-1",
            configurationSha256: CONFIGURATION_DIGEST,
            bindings: [...(kind === "local" ? FILE_RESHARD_LOCAL_BINDINGS : FILE_RESHARD_DEPLOYMENT_BINDINGS)],
            sourceShard: "cdb-source",
            destinationShard: "cdb-destination",
            r2Bucket: NAME,
            vectorizeIndex: NAME,
        },
        execution: {
            startedAt: "2026-08-29T00:00:00.000Z",
            completedAt: "2026-08-29T00:00:01.000Z",
            requestAttempts: 2,
        },
        dataset: { organizations: 3, files: 16, metadataRows: 16, vectors: 16, objectBytes: 128 },
        timing: {
            totalMs: 10,
            phasesMs: Object.fromEntries(FILE_RESHARD_BENCHMARK_PHASES.map(phase => [phase, 1])),
        },
        movement: {
            runTurns: 8,
            routeEpochBefore: 2,
            routeEpochAfter: 3,
            r2: {
                objectsBefore: 16,
                objectsAfter: 16,
                bytesBefore: 128,
                bytesAfter: 128,
                identityDigestBefore: identity,
                identityDigestAfter: identity,
                operationTrace: {
                    available: kind === "local",
                    method: kind === "local" ? "cdb-r2-proxy" : "unavailable-native-binding",
                    putsDuringMove: kind === "local" ? 0 : null,
                    deletesDuringMove: kind === "local" ? 0 : null,
                },
            },
            vectors: {
                headsBefore: 16,
                headsAfter: 16,
                readyHeadsBefore: 16,
                readyHeadsAfter: 16,
                outboxBefore: 16,
                outboxAfter: 16,
                attemptsBefore: 16,
                attemptsAfter: 16,
                headDigestBefore: identity,
                headDigestAfter: identity,
                outboxDigestBefore: DIGEST,
                outboxDigestAfter: DIGEST,
                attemptDigestBefore: CONFIGURATION_DIGEST,
                attemptDigestAfter: CONFIGURATION_DIGEST,
                physicalIdsBefore: Array.from({ length: 16 }, (_, index) => `physical-${index}`),
                physicalIdsAfter: Array.from({ length: 16 }, (_, index) => `physical-${index}`),
                physicalIdentityDigestBefore: "d".repeat(64),
                physicalIdentityDigestAfter: "d".repeat(64),
                providerRecordsBefore: 16,
                providerRecordsAfter: 16,
                providerMutationTrace: {
                    available: kind === "local",
                    method: kind === "local" ? "durable-object-vector-probe" : "stable-physical-identity",
                    upsertsDuringMove: kind === "local" ? 0 : null,
                    deletesDuringMove: kind === "local" ? 0 : null,
                },
                search: { rowPk: "row-0", score: 1 },
            },
        },
        responseLoss: {
            operation: "apply_snapshot",
            firstStatus: 503,
            committed: true,
            sameRunKey: true,
            retrySucceeded: true,
        },
        alarm: {
            invoked: true,
            durable: true,
            ownerShard: "cdb-destination",
            deletedMetadataRows: 1,
            remainingMetadataRows: 15,
            retainedObjects: 16,
        },
        correctness: Object.fromEntries(FILE_RESHARD_DEPLOYMENT_CORRECTNESS.map(name => [name, true])),
    };
}

describe("file reshard deployment proof runner", () => {
    test("uses one semantic run key on both isolated targets", () => {
        expect(fileReshardDeploymentRunKey(RUN_ID, -1)).toBe(`${RUN_ID}_warmup`);
        expect(fileReshardDeploymentRunKey(RUN_ID, 0)).toBe(`${RUN_ID}_0`);
        expect(() => fileReshardDeploymentRunKey(RUN_ID, -2)).toThrow("sequence is invalid");
    });

    test("requires explicit disposable targets, account identity, and HTTPS deployment", async () => {
        expect(parseFileReshardDeploymentProofArgs(argumentsForProof())).toMatchObject({
            confirmed: true,
            profileName: "small",
            localUrl: "http://127.0.0.1:8787",
            deployedUrl: "https://proof.example.workers.dev",
            worker: NAME,
            bucket: NAME,
            vectorizeIndex: NAME,
            configurationSha256: CONFIGURATION_DIGEST,
        });
        const storedOauth = argumentsForProof();
        const tokenFlag = storedOauth.indexOf("--cloudflare-api-token-file");
        storedOauth.splice(tokenFlag, 2);
        expect(parseFileReshardDeploymentProofArgs(storedOauth)).toMatchObject({
            confirmed: true,
            cloudflareApiTokenFile: undefined,
            cloudflareAccountId: "account_identifier_1234",
        });
        expect(() =>
            parseFileReshardDeploymentProofArgs(
                argumentsForProof().filter(argument => argument !== "--confirm-disposable-target")
            )
        ).toThrow("--confirm-disposable-target is required");
        const insecure = argumentsForProof();
        insecure[insecure.indexOf("https://proof.example.workers.dev")] = "http://proof.example.workers.dev";
        expect(() => parseFileReshardDeploymentProofArgs(insecure)).toThrow("invalid protocol");
        const reused = argumentsForProof();
        reused[reused.lastIndexOf(NAME)] = "production-files";
        expect(() => parseFileReshardDeploymentProofArgs(reused)).toThrow(
            "identical disposable Worker, bucket, and Vectorize index name"
        );
        const invalidConfiguration = argumentsForProof();
        invalidConfiguration[invalidConfiguration.indexOf(CONFIGURATION_DIGEST)] = "C".repeat(64);
        expect(() => parseFileReshardDeploymentProofArgs(invalidConfiguration)).toThrow(
            "--configuration-sha256 is invalid"
        );
        await expect(
            runFileReshardDeploymentProof({
                worker: NAME,
                bucket: NAME,
                localUrl: "http://127.0.0.1:8787",
                deployedUrl: "https://proof.example.workers.dev",
            })
        ).rejects.toThrow("confirmation is required");
    });

    test("constructs exact Wrangler inspection, deployment, and cleanup commands", () => {
        expect(wranglerDeploymentInspectionCommands(NAME, NAME, NAME)).toEqual([
            ["versions", "list", "--name", NAME, "--json"],
            ["deployments", "status", "--name", NAME, "--json"],
            ["r2", "bucket", "info", NAME, "--json"],
            ["vectorize", "get", NAME, "--json"],
        ]);
        expect(
            wranglerDisposableDeploymentCommands({
                worker: NAME,
                bucket: NAME,
                index: NAME,
                config: "/proof/wrangler.toml",
                secretsFile: "/private/proof.env",
                tag: "proof-v1",
            })
        ).toEqual([
            ["r2", "bucket", "create", NAME],
            [
                "vectorize",
                "create",
                NAME,
                "--dimensions",
                "32",
                "--metric",
                "cosine",
                "--description",
                "CharDB disposable cross-resource movement proof",
                "--json",
            ],
            ["vectorize", "create-metadata-index", NAME, "--propertyName", "cdb_resource", "--type", "string"],
            [
                "deploy",
                "--config",
                "/proof/wrangler.toml",
                "--name",
                NAME,
                "--strict",
                "--secrets-file",
                "/private/proof.env",
                "--tag",
                "proof-v1",
                "--message",
                "CharDB disposable file reshard proof",
            ],
        ]);
        expect(wranglerDisposableCleanupCommands(NAME, NAME, NAME)).toEqual([
            ["delete", NAME, "--force"],
            ["r2", "bucket", "delete", NAME],
            ["vectorize", "delete", NAME, "--force"],
        ]);
        expect(() => wranglerDisposableCleanupCommands("production", "production", "production")).toThrow("disposable");
    });

    test("pins the inspected Worker version with token-file or stored-OAuth authentication", async () => {
        const calls: {
            command: string;
            args: readonly string[];
            token: string | undefined;
            accountId: string | undefined;
        }[] = [];
        const runCommand = async (
            command: string,
            args: readonly string[],
            options: { env: Record<string, string | undefined> }
        ) => {
            calls.push({
                command,
                args,
                token: options.env.CLOUDFLARE_API_TOKEN,
                accountId: options.env.CLOUDFLARE_ACCOUNT_ID,
            });
            if (args[0] === "versions") return { stdout: '[{"id":"version-1"}]', stderr: "", exitCode: 0 };
            if (args[0] === "deployments") {
                return {
                    stdout: '{"versions":[{"version_id":"version-1","percentage":100}]}',
                    stderr: "",
                    exitCode: 0,
                };
            }
            return { stdout: JSON.stringify({ name: NAME }), stderr: "", exitCode: 0 };
        };
        const tokenResult = await inspectDisposableDeployment({
            wrangler: "/proof/wrangler",
            app: "/proof/app",
            worker: NAME,
            bucket: NAME,
            index: NAME,
            version: "version-1",
            apiToken: "cloudflare_api_token_1234",
            accountId: "account_identifier_1234",
            runCommand,
        });
        const oauthResult = await inspectDisposableDeployment({
            wrangler: "/proof/wrangler",
            app: "/proof/app",
            worker: NAME,
            bucket: NAME,
            index: NAME,
            version: "version-1",
            accountId: "account_identifier_1234",
            runCommand,
        });
        expect(tokenResult).toEqual({ version: "version-1", percentage: 100, bucket: NAME, index: NAME });
        expect(oauthResult).toEqual(tokenResult);
        expect(calls).toHaveLength(8);
        expect(calls.every(call => !call.args.includes("cloudflare_api_token_1234"))).toBe(true);
        expect(calls.slice(0, 4).every(call => call.token === "cloudflare_api_token_1234")).toBe(true);
        expect(calls.slice(4).every(call => call.token === undefined)).toBe(true);
        expect(calls.every(call => call.accountId === "account_identifier_1234")).toBe(true);
    });

    test("runs through stored OAuth without reading or passing a Cloudflare credential", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "file-reshard-deployment-oauth-"));
        temporary.push(root);
        const candidate = path.join(root, "candidate.tgz");
        const localTokenFile = path.join(root, "local.token");
        const deployedTokenFile = path.join(root, "deployed.token");
        await Promise.all([
            writeFile(candidate, "packed candidate"),
            writeFile(localTokenFile, "local_proof_token_1234\n"),
            writeFile(deployedTokenFile, "deployed_proof_token_1234\n"),
        ]);
        let inspection: Record<string, unknown> | undefined;
        await expect(
            runFileReshardDeploymentProof({
                package: candidate,
                preparation: path.join(root, "preparation.json"),
                output: path.join(root, "evidence"),
                wrangler: "/proof/wrangler",
                localUrl: "http://127.0.0.1:8787",
                deployedUrl: "https://proof.example.workers.dev",
                localTokenFile,
                deployedTokenFile,
                cloudflareAccountId: "account_identifier_1234",
                worker: NAME,
                bucket: NAME,
                vectorizeIndex: NAME,
                deploymentVersion: "version-1",
                configurationSha256: CONFIGURATION_DIGEST,
                runId: RUN_ID,
                profileName: "small",
                confirmed: true,
                validatePreparation: async () => ({
                    app: root,
                    candidate: {
                        algorithm: "sha256",
                        digest: createHash("sha256").update("packed candidate").digest("hex"),
                        bytes: "packed candidate".length,
                    },
                    receipt: {
                        target: { worker: NAME, bucket: NAME, vectorizeIndex: NAME },
                        runId: RUN_ID,
                        configurationSha256: CONFIGURATION_DIGEST,
                    },
                }),
                inspectDeployment: async (input: Record<string, unknown>) => {
                    inspection = input;
                    throw new Error("inspection reached stored OAuth");
                },
            })
        ).rejects.toThrow("inspection reached stored OAuth");
        expect(inspection).not.toHaveProperty("apiToken");
        expect(inspection).toMatchObject({ accountId: "account_identifier_1234" });
    });

    test("replays one committed 503 with the exact request body and run key", async () => {
        const requests: { url: string; init: RequestInit }[] = [];
        const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
            if (!init) throw new Error("missing request options");
            requests.push({ url: String(url), init });
            const request = JSON.parse(String(init.body));
            if (requests.length === 1) {
                return Response.json(
                    {
                        schema: FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA,
                        runKey: request.runKey,
                        operation: "apply_snapshot",
                        committed: true,
                        retryable: true,
                    },
                    { status: 503 }
                );
            }
            return Response.json(sample("local", 0, request.runKey));
        };
        const result = await requestFileReshardDeploymentSample({
            runId: RUN_ID,
            kind: "local",
            sequence: 0,
            origin: "http://127.0.0.1:8787",
            token: "local_proof_token_1234",
            candidateSha256: DIGEST,
            profileName: "small",
            fetchImpl,
        });
        expect(result.runKey).toBe(`${RUN_ID}_0`);
        expect(requests).toHaveLength(2);
        expect(requests[0]?.init.body).toBe(requests[1]?.init.body);
        expect(new Headers(requests[0]?.init.headers).get("x-chardb-proof-inject")).toBe(
            "commit-then-response-loss-once"
        );
        expect(new Headers(requests[1]?.init.headers).has("x-chardb-proof-inject")).toBe(false);
        expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer local_proof_token_1234");
    });

    test("reports a bounded status and code when the fault boundary is not reached", async () => {
        await expect(
            requestFileReshardDeploymentSample({
                runId: RUN_ID,
                kind: "local",
                sequence: 0,
                origin: "http://127.0.0.1:8787",
                token: "local_proof_token_1234",
                candidateSha256: DIGEST,
                profileName: "small",
                fetchImpl: async () =>
                    Response.json(
                        {
                            code: "CDB_VECTOR_SHAPE",
                            checkpoint: "vector-settlement",
                            error: "must-not-appear secret-value",
                        },
                        { status: 500 }
                    ),
            })
        ).rejects.toThrow(
            "local proof did not lose the committed response exactly once " +
                "(status 500, code CDB_VECTOR_SHAPE, checkpoint vector-settlement)"
        );
    });

    test("does not echo an untrusted response code in fault-boundary diagnostics", async () => {
        const secret = "secret-value-must-not-leak";
        let failure: unknown;
        try {
            await requestFileReshardDeploymentSample({
                runId: RUN_ID,
                kind: "local",
                sequence: 0,
                origin: "http://127.0.0.1:8787",
                token: "local_proof_token_1234",
                candidateSha256: DIGEST,
                profileName: "small",
                fetchImpl: async () => Response.json({ code: secret, error: secret }, { status: 500 }),
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            "local proof did not lose the committed response exactly once " +
                "(status 500, code unclassified, checkpoint unclassified)"
        );
        expect((failure as Error).message).not.toContain(secret);
    });

    test("preserves only a bounded code and checkpoint when the committed retry fails", async () => {
        let attempt = 0;
        const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body));
            attempt++;
            if (attempt === 1) {
                return Response.json(
                    {
                        schema: FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA,
                        runKey: request.runKey,
                        operation: "apply_snapshot",
                        committed: true,
                        retryable: true,
                    },
                    { status: 503 }
                );
            }
            return Response.json(
                {
                    code: "PROOF_RUN_FAILED",
                    checkpoint: "file-alarm",
                    error: "must-not-appear secret-value",
                },
                { status: 500 }
            );
        };
        await expect(
            requestFileReshardDeploymentSample({
                runId: RUN_ID,
                kind: "local",
                sequence: 2,
                origin: "http://127.0.0.1:8787",
                token: "local_proof_token_1234",
                candidateSha256: DIGEST,
                profileName: "small",
                fetchImpl,
            })
        ).rejects.toThrow("local proof retry failed with 500 (code PROOF_RUN_FAILED, checkpoint file-alarm)");
    });

    test("does not echo untrusted committed-retry diagnostics", async () => {
        const secret = "secret-value-must-not-leak";
        let attempt = 0;
        let failure: unknown;
        try {
            await requestFileReshardDeploymentSample({
                runId: RUN_ID,
                kind: "local",
                sequence: 2,
                origin: "http://127.0.0.1:8787",
                token: "local_proof_token_1234",
                candidateSha256: DIGEST,
                profileName: "small",
                fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
                    const request = JSON.parse(String(init?.body));
                    attempt++;
                    return attempt === 1
                        ? Response.json(
                              {
                                  schema: FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA,
                                  runKey: request.runKey,
                                  operation: "apply_snapshot",
                                  committed: true,
                                  retryable: true,
                              },
                              { status: 503 }
                          )
                        : Response.json({ code: secret, checkpoint: secret, error: secret }, { status: 500 });
                },
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            "local proof retry failed with 500 (code unclassified, checkpoint unclassified)"
        );
        expect((failure as Error).message).not.toContain(secret);
    });

    test("writes paired local and deployed evidence with an alternating schedule", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "file-reshard-deployment-proof-"));
        temporary.push(root);
        const candidate = path.join(root, "candidate.tgz");
        const localTokenFile = path.join(root, "local.token");
        const deployedTokenFile = path.join(root, "deployed.token");
        const cloudflareApiTokenFile = path.join(root, "cloudflare.token");
        const output = path.join(root, "evidence");
        const candidateBytes = "packed candidate";
        const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
        await Promise.all([
            writeFile(candidate, candidateBytes),
            writeFile(localTokenFile, "local_proof_token_1234\n"),
            writeFile(deployedTokenFile, "deployed_proof_token_1234\n"),
            writeFile(cloudflareApiTokenFile, "cloudflare_api_token_1234\n"),
        ]);
        const firstAttempts: string[] = [];
        const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
            const parsed = new URL(String(url));
            const kind = parsed.hostname === "127.0.0.1" ? "local" : "deployed";
            if (parsed.pathname.endsWith("/capabilities")) {
                return Response.json({
                    schema: "chardb.file-vector-reshard-proof-capabilities.v3",
                    releaseSha256: candidateSha256,
                    runId: RUN_ID,
                    target: sample(kind, 0, "unused_run_key_1234", candidateSha256).target,
                    protocol: "bounded-operator-v1",
                    features: {
                        alarms: true,
                        commitThenResponseLoss: true,
                        directR2OperationTrace: kind === "local",
                        fileAwareReshard: true,
                        freshDisposableData: true,
                        providerVectorMutationTrace: kind === "local",
                        publicVectorSearch: true,
                        retainedFileRecovery: true,
                        vectorAwareReshard: true,
                    },
                });
            }
            if (!init) throw new Error("missing proof request options");
            const request = JSON.parse(String(init.body));
            const headers = new Headers(init.headers);
            if (headers.has("x-chardb-proof-inject")) {
                firstAttempts.push(`${kind}:${request.sequence}`);
                return Response.json(
                    {
                        schema: FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA,
                        runKey: request.runKey,
                        operation: "apply_snapshot",
                        committed: true,
                        retryable: true,
                    },
                    { status: 503 }
                );
            }
            return Response.json(sample(kind, request.sequence, request.runKey, candidateSha256));
        };
        let inspection: Record<string, unknown> | undefined;
        const result = await runFileReshardDeploymentProof({
            package: candidate,
            preparation: path.join(root, "preparation.json"),
            output,
            wrangler: "/proof/wrangler",
            localUrl: "http://127.0.0.1:8787",
            deployedUrl: "https://proof.example.workers.dev",
            localTokenFile,
            deployedTokenFile,
            cloudflareApiTokenFile,
            cloudflareAccountId: "account_identifier_1234",
            worker: NAME,
            bucket: NAME,
            vectorizeIndex: NAME,
            deploymentVersion: "version-1",
            configurationSha256: CONFIGURATION_DIGEST,
            runId: RUN_ID,
            profileName: "small",
            confirmed: true,
            validatePreparation: async () => ({
                app: root,
                candidate: { algorithm: "sha256", digest: candidateSha256, bytes: candidateBytes.length },
                receipt: {
                    target: { worker: NAME, bucket: NAME, vectorizeIndex: NAME },
                    runId: RUN_ID,
                    configurationSha256: CONFIGURATION_DIGEST,
                },
            }),
            inspectDeployment: async (input: Record<string, unknown>) => {
                inspection = input;
                return { version: "version-1", percentage: 100, bucket: NAME, index: NAME };
            },
            fetchImpl,
        });
        expect(inspection).toMatchObject({
            apiToken: "cloudflare_api_token_1234",
            accountId: "account_identifier_1234",
        });
        expect(result.comparison).toMatchObject({ descriptiveOnly: true });
        expect(firstAttempts).toEqual([
            "local:-1",
            "deployed:-1",
            "deployed:0",
            "local:0",
            "local:1",
            "deployed:1",
            "deployed:2",
            "local:2",
        ]);
        expect(JSON.parse(await readFile(path.join(output, "paired.json"), "utf8"))).toEqual(result);
        const manifest = await readFile(path.join(output, "evidence.sha256"), "utf8");
        expect(JSON.parse(await readFile(path.join(output, "preparation.json"), "utf8"))).toEqual({
            target: { worker: NAME, bucket: NAME, vectorizeIndex: NAME },
            runId: RUN_ID,
            configurationSha256: CONFIGURATION_DIGEST,
        });
        expect(JSON.parse(await readFile(path.join(output, "deployment-inspection.json"), "utf8"))).toEqual({
            version: "version-1",
            percentage: 100,
            bucket: NAME,
            index: NAME,
        });
        expect(JSON.parse(await readFile(path.join(output, "capabilities-local.json"), "utf8"))).toMatchObject({
            target: { kind: "local", configurationSha256: CONFIGURATION_DIGEST },
        });
        expect(JSON.parse(await readFile(path.join(output, "capabilities-deployed.json"), "utf8"))).toMatchObject({
            target: { kind: "deployed", configurationSha256: CONFIGURATION_DIGEST },
        });
        expect(manifest.trim().split("\n")).toHaveLength(13);
        expect(manifest).toContain("  preparation.json\n");
        expect(manifest).not.toContain("proof_token");
        expect(JSON.stringify(result)).not.toContain("cloudflare_api_token_1234");
    });
});
