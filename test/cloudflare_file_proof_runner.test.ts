import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    CLOUDFLARE_FILE_PROOF_MINIFLARE_VERSION,
    CLOUDFLARE_FILE_PROOF_WORKERD_VERSION,
    CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION,
    activateMigrationShardWithRetry,
    assertCleanupOwnership,
    assertNoSensitiveEvidence,
    cleanupCommands,
    collectMigrationShardFailureDiagnostics,
    deriveDisposableResourceNames,
    exactObjectCleanupCommands,
    finalizeFileProofEvidence,
    migrationShardFailureMessage,
    parseCloudflareFileProofArgs,
    prepareCloudflareFileProofApp,
    remoteAbsenceConfirmed,
    renderFileProofPackage,
    renderFileProofWrangler,
    resolveWranglerExecutable,
    runFileProofMigrationCommand,
    scrubSensitive,
} from "../scripts/run-cloudflare-file-proof.mjs";

const digest = "a".repeat(64);
const nonce = "0123456789abcdef";
const runId = "proof_run_0123456789abcdef";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chardb-r2-proof-test-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("Cloudflare R2 proof runner", () => {
    test("retries only a bounded transient edge 404 from the migration CLI", async () => {
        let calls = 0;
        let elapsed = 0;
        const waits: number[] = [];
        const result = await runFileProofMigrationCommand(
            { command: "bun", args: ["cli.mjs", "migrate"], options: { label: "migration" } },
            {
                run: async () => {
                    calls++;
                    if (calls < 3) throw new Error("migration endpoint returned 404 with invalid JSON");
                    return { stdout: "ok", stderr: "", exitCode: 0 };
                },
                wait: async milliseconds => {
                    waits.push(milliseconds);
                    elapsed += milliseconds;
                },
                now: () => elapsed,
            }
        );
        expect(result.exitCode).toBe(0);
        expect(calls).toBe(3);
        expect(waits).toEqual([1_000, 2_000]);

        const permanent = new Error("migration endpoint returned 500: internal error");
        await expect(
            runFileProofMigrationCommand(
                { command: "bun", args: [], options: {} },
                { run: async () => Promise.reject(permanent), wait: async () => undefined }
            )
        ).rejects.toBe(permanent);

        const edge404 = new Error("migration endpoint returned 404 with invalid JSON");
        let exhaustedCalls = 0;
        let exhaustedElapsed = 0;
        const exhaustedWaits: number[] = [];
        await expect(
            runFileProofMigrationCommand(
                { command: "bun", args: [], options: {} },
                {
                    run: async () => {
                        exhaustedCalls++;
                        throw edge404;
                    },
                    wait: async milliseconds => {
                        exhaustedWaits.push(milliseconds);
                        exhaustedElapsed += milliseconds;
                    },
                    now: () => exhaustedElapsed,
                }
            )
        ).rejects.toBe(edge404);
        expect(exhaustedCalls).toBe(9);
        expect(exhaustedWaits).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000, 3_000]);
        expect(exhaustedElapsed).toBe(30_000);
    });

    test("requires explicit authority and keeps private state outside evidence", () => {
        expect(
            parseCloudflareFileProofArgs([
                "--tarball",
                "/candidate/chardb.tgz",
                "--output",
                "/evidence",
                "--private-dir",
                "/private/proof",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                "a".repeat(32),
                "--confirm-disposable-resources",
            ])
        ).toEqual({
            help: false,
            tarball: "/candidate/chardb.tgz",
            output: "/evidence",
            privateDir: "/private/proof",
            workersDevSubdomain: "zpg6",
            accountId: "a".repeat(32),
            cloudflareApiTokenFile: undefined,
            confirmed: true,
        });
        expect(() =>
            parseCloudflareFileProofArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "/evidence",
                "--private-dir",
                "/evidence/private",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                "a".repeat(32),
                "--confirm-disposable-resources",
            ])
        ).toThrow("separate trees");
        expect(() =>
            parseCloudflareFileProofArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "/evidence",
                "--private-dir",
                "/private",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                "a".repeat(32),
            ])
        ).toThrow("--confirm-disposable-resources");
        expect(() =>
            parseCloudflareFileProofArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "/evidence",
                "--private-dir",
                "/private",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                "not-an-account",
                "--confirm-disposable-resources",
            ])
        ).toThrow("32 hexadecimal");
    });

    test("derives one bounded Worker and bucket identity from the candidate and nonce", () => {
        expect(deriveDisposableResourceNames(digest, nonce)).toEqual({
            worker: "chardb-r2-proof-aaaaaaaaaa-0123456789abcdef",
            bucket: "chardb-r2-proof-aaaaaaaaaa-0123456789abcdef",
        });
        expect(() => deriveDisposableResourceNames("bad", nonce)).toThrow("SHA-256");
        expect(() => deriveDisposableResourceNames(digest, "bad")).toThrow("nonce");
    });

    test("renders a native R2 binding and an exact public package dependency", () => {
        const names = deriveDisposableResourceNames(digest, nonce);
        const rendered = renderFileProofWrangler(
            ['name = "__WORKER_NAME__"', 'bucket_name = "__BUCKET_NAME__"', 'release = "__RELEASE_SHA256__"'].join(
                "\n"
            ),
            { ...names, releaseSha256: digest, runId }
        );
        expect(rendered).toContain(`name = "${names.worker}"`);
        expect(rendered).toContain(`bucket_name = "${names.bucket}"`);
        const packageJson = renderFileProofPackage("./chardb-proof.tgz") as {
            dependencies: Record<string, string>;
            devDependencies: Record<string, string>;
        };
        expect(packageJson.dependencies["@chardb/core"]).toBe("file:./chardb-proof.tgz");
        expect(packageJson.devDependencies).toMatchObject({
            "@cloudflare/workers-types": "5.20260830.1",
            miniflare: CLOUDFLARE_FILE_PROOF_MINIFLARE_VERSION,
            typescript: "5.9.3",
            workerd: CLOUDFLARE_FILE_PROOF_WORKERD_VERSION,
            wrangler: CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION,
        });
    });

    test("allows destructive cleanup only for an absent-preflight ledger with exact derived names", () => {
        const names = deriveDisposableResourceNames(digest, nonce);
        const ledger = {
            schema: "chardb.cloudflare-r2-proof.ownership.v3",
            candidateSha256: digest,
            accountIdSha256: new Bun.CryptoHasher("sha256").update("a".repeat(32)).digest("hex"),
            nonce,
            runId,
            ...names,
            workerAbsentConfirmed: true,
            bucketAbsentConfirmed: true,
            workerCreateIntent: true,
            workerCreated: true,
            bucketCreateIntent: true,
            bucketCreated: true,
            knownKeys: ["v1/org_a/file_a"],
        };
        expect(assertCleanupOwnership(ledger, digest, "a".repeat(32))).toEqual(names);
        expect(cleanupCommands(ledger, digest, "a".repeat(32))).toEqual([
            ["delete", names.worker, "--force"],
            ["r2", "bucket", "delete", names.bucket],
        ]);
        expect(exactObjectCleanupCommands(ledger, digest, "a".repeat(32))).toEqual([
            ["r2", "object", "delete", `${names.bucket}/v1/org_a/file_a`, "--remote", "--force"],
        ]);
        expect(() => assertCleanupOwnership({ ...ledger, worker: "unrelated-worker" }, digest, "a".repeat(32))).toThrow(
            "not derived"
        );
        expect(() =>
            assertCleanupOwnership({ ...ledger, bucketAbsentConfirmed: false }, digest, "a".repeat(32))
        ).toThrow("bucket creation state is impossible");
        expect(() => assertCleanupOwnership(ledger, "b".repeat(64), "a".repeat(32))).toThrow(
            "candidate digest drifted"
        );
        expect(() => assertCleanupOwnership(ledger, digest, "b".repeat(32))).toThrow("account identity drifted");
        expect(() =>
            assertCleanupOwnership({ ...ledger, knownKeys: ["../../other-bucket"] }, digest, "a".repeat(32))
        ).toThrow("object-key ledger");
        expect(() =>
            assertCleanupOwnership(
                {
                    ...ledger,
                    knownKeys: Array.from({ length: 513 }, (_, index) => `v1/org_a/file_${index}`),
                },
                digest,
                "a".repeat(32)
            )
        ).toThrow("object-key ledger");

        const bucketOnly = {
            ...ledger,
            workerCreateIntent: false,
            workerCreated: false,
        };
        expect(cleanupCommands(bucketOnly, digest, "a".repeat(32))).toEqual([["r2", "bucket", "delete", names.bucket]]);
        const workerOnly = {
            ...ledger,
            bucketCreateIntent: false,
            bucketCreated: false,
            knownKeys: [],
        };
        expect(cleanupCommands(workerOnly, digest, "a".repeat(32))).toEqual([["delete", names.worker, "--force"]]);
        expect(exactObjectCleanupCommands(workerOnly, digest, "a".repeat(32))).toEqual([]);
        expect(() =>
            assertCleanupOwnership(
                { ...ledger, workerCreateIntent: false, workerCreated: true },
                digest,
                "a".repeat(32)
            )
        ).toThrow("Worker creation state is impossible");
        expect(() =>
            assertCleanupOwnership(
                { ...ledger, bucketCreateIntent: true, bucketAbsentConfirmed: false },
                digest,
                "a".repeat(32)
            )
        ).toThrow("bucket creation state is impossible");
        expect(() => assertCleanupOwnership({ ...ledger, unexpected: true }, digest, "a".repeat(32))).toThrow(
            "fields must be exactly"
        );
    });

    test("accepts only positive remote absence evidence", () => {
        expect(remoteAbsenceConfirmed("bucket", { exitCode: 0, stdout: "[]", stderr: "" })).toEqual([]);
        expect(
            remoteAbsenceConfirmed("bucket", {
                exitCode: 0,
                stdout: [
                    "Listing buckets...",
                    "name:           first-bucket",
                    "creation_date:  2026-08-28T00:00:00.000Z",
                    "",
                    "name:           second-bucket",
                    "creation_date:  2026-08-28T00:00:01.000Z",
                ].join("\n"),
                stderr: "",
            })
        ).toEqual([{ name: "first-bucket" }, { name: "second-bucket" }]);
        expect(
            remoteAbsenceConfirmed("bucket", {
                exitCode: 0,
                stdout: "Listing buckets...\n",
                stderr: "",
            })
        ).toEqual([]);
        expect(() =>
            remoteAbsenceConfirmed("bucket", { exitCode: 0, stdout: "unexpected success", stderr: "" })
        ).toThrow("completion marker");
        expect(
            remoteAbsenceConfirmed("worker", {
                exitCode: 1,
                stdout: "",
                stderr: "Worker does not exist [code: 10090]",
            })
        ).toEqual([]);
        expect(() =>
            remoteAbsenceConfirmed("worker", { exitCode: 1, stdout: "", stderr: "authentication failed" })
        ).toThrow("without a recognized absence");
        expect(() => remoteAbsenceConfirmed("bucket", { exitCode: 1, stdout: "", stderr: "timeout" })).toThrow(
            "preflight failed"
        );
    });

    test("prepares an immutable fixture that imports the public file entrypoint", async () => {
        const root = await temporaryDirectory();
        const app = path.join(root, "app");
        const tarball = path.join(root, "candidate.tgz");
        await writeFile(tarball, "exact candidate bytes");
        const names = deriveDisposableResourceNames(digest, nonce);
        const fingerprint = await prepareCloudflareFileProofApp({
            app,
            tarball,
            ...names,
            releaseSha256: digest,
            runId,
        });
        expect(fingerprint.files).toHaveLength(9);
        expect(fingerprint.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(await readFile(path.join(app, "src", "schema.ts"), "utf8")).toContain(
            'import { file } from "@chardb/core/files"'
        );
        const worker = await readFile(path.join(app, "src", "worker.ts"), "utf8");
        expect(worker).toContain("proofConfigured:");
        expect(worker).toContain("{ DB, Catalog, Cdb, Gateway, Resharder }");
        const wrangler = await readFile(path.join(app, "wrangler.toml"), "utf8");
        expect(wrangler).toContain('binding = "CDB_FILES"');
        expect(wrangler).toContain(`bucket_name = "${names.bucket}"`);
        expect(wrangler).toContain('new_sqlite_classes = ["Cdb", "Catalog", "Gateway", "Resharder"]');
        expect(wrangler).toContain('name = "CDB_CATALOG"\nclass_name = "Catalog"');
        expect(wrangler).toContain('name = "CDB_SHARD"\nclass_name = "Cdb"');
        expect(wrangler).toContain('name = "CDB_GATEWAY"\nclass_name = "Gateway"');
        expect(wrangler).toContain('name = "CDB_RESHARD"\nclass_name = "Resharder"');
        expect(wrangler.match(/\[\[durable_objects\.bindings\]\]/g)).toHaveLength(4);
        expect(wrangler).not.toContain("__");
    });

    test("executes Wrangler's declared binary instead of its import entry", async () => {
        const root = path.join(import.meta.dir, "..");
        const executable = await resolveWranglerExecutable(path.join(root, "package.json"));

        expect(path.relative(root, executable)).toBe("node_modules/wrangler/bin/wrangler.js");
        const child = Bun.spawn([executable, "--version"], {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(exitCode).toBe(0);
        expect(`${stdout}\n${stderr}`).toContain(CLOUDFLARE_FILE_PROOF_WRANGLER_VERSION);
    }, 60_000);

    test("captures Catalog shard status and bounded last-error diagnostics after a failed shard POST", async () => {
        let observedPath = "";
        let observedAuthorization = "";
        const diagnostic = await collectMigrationShardFailureDiagnostics(
            {
                origin: "https://proof.example",
                adminToken: "private-admin-token",
                migrationId: "migration-v1",
                shardId: "ShardDO_0",
            },
            async (_origin, pathname, init) => {
                observedPath = pathname;
                observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
                return {
                    response: new Response(null, { status: 200 }),
                    body: {
                        shards: [
                            {
                                shardId: "ShardDO_0",
                                status: "pending",
                                lastError: `CDB_SHARD_UNAVAILABLE: ${"x".repeat(700)}`,
                            },
                        ],
                    },
                };
            }
        );

        expect(observedPath).toBe("/_chardb/migrations/shards?migrationId=migration-v1");
        expect(observedAuthorization).toBe("Bearer private-admin-token");
        expect(diagnostic).toMatchObject({
            phase: "migrate-schema-shard",
            migrationId: "migration-v1",
            shardId: "ShardDO_0",
            inventoryHttpStatus: 200,
            shardStatus: "pending",
            inventoryError: null,
        });
        expect(diagnostic.lastError).toHaveLength(512);
        expect(migrationShardFailureMessage(new Error("migration shard failed with 500"), diagnostic)).toContain(
            '"phase":"migrate-schema-shard"'
        );
    });

    test("preserves an inventory retrieval failure without hiding the original shard phase", async () => {
        const diagnostic = await collectMigrationShardFailureDiagnostics(
            {
                origin: "https://proof.example",
                adminToken: "private-admin-token",
                migrationId: "migration-v1",
                shardId: "ShardDO_0",
            },
            async () => {
                throw new Error("inventory request failed");
            }
        );
        expect(diagnostic).toEqual({
            phase: "migrate-schema-shard",
            migrationId: "migration-v1",
            shardId: "ShardDO_0",
            inventoryHttpStatus: null,
            shardStatus: null,
            lastError: null,
            inventoryError: "inventory request failed",
        });
    });

    test("retries one pending shard with the same body after a deployed 5xx", async () => {
        const shardBodies: string[] = [];
        const sleeps: number[] = [];
        let shardAttempts = 0;
        const result = await activateMigrationShardWithRetry(
            {
                origin: "https://proof.example",
                adminToken: "private-admin-token",
                migrationId: "migration-v1",
                shardId: "ShardDO_0",
            },
            {
                request: async (_origin, pathname, init) => {
                    if (pathname === "/_chardb/migrations/shard") {
                        shardAttempts++;
                        shardBodies.push(String(init?.body));
                        return shardAttempts === 1
                            ? {
                                  response: new Response(null, { status: 503 }),
                                  body: { ok: false, error: "internal error; reference = proof" },
                              }
                            : {
                                  response: new Response(null, { status: 200 }),
                                  body: { shard: { shardId: "ShardDO_0", status: "active", lastError: null } },
                              };
                    }
                    return {
                        response: new Response(null, { status: 200 }),
                        body: {
                            shards: [
                                {
                                    shardId: "ShardDO_0",
                                    status: "pending",
                                    lastError: "internal error; reference = proof",
                                },
                            ],
                        },
                    };
                },
                sleep: async milliseconds => {
                    sleeps.push(milliseconds);
                },
            }
        );
        expect(result.shard).toMatchObject({ shardId: "ShardDO_0", status: "active" });
        expect(shardAttempts).toBe(2);
        expect(new Set(shardBodies).size).toBe(1);
        expect(shardBodies[0]).toBe(JSON.stringify({ migrationId: "migration-v1", shardId: "ShardDO_0" }));
        expect(sleeps).toEqual([250]);
    });

    test("reconciles retryable 408 and 429 responses before replaying", async () => {
        for (const status of [408, 429]) {
            let shardAttempts = 0;
            const result = await activateMigrationShardWithRetry(
                {
                    origin: "https://proof.example",
                    adminToken: "private-admin-token",
                    migrationId: "migration-v1",
                    shardId: "ShardDO_0",
                },
                {
                    request: async (_origin, pathname) => {
                        if (pathname === "/_chardb/migrations/shard") {
                            shardAttempts++;
                            return {
                                response: new Response(null, { status }),
                                body: { ok: false, error: "transient edge response" },
                            };
                        }
                        return {
                            response: new Response(null, { status: 200 }),
                            body: {
                                shards: [{ shardId: "ShardDO_0", status: "active", lastError: null }],
                            },
                        };
                    },
                    sleep: async () => {
                        throw new Error("active reconciliation must not sleep");
                    },
                }
            );
            expect(result.shard).toMatchObject({ shardId: "ShardDO_0", status: "active" });
            expect(shardAttempts).toBe(1);
        }
    });

    test("reconciles a lost active response without replaying the shard", async () => {
        let shardAttempts = 0;
        const result = await activateMigrationShardWithRetry(
            {
                origin: "https://proof.example",
                adminToken: "private-admin-token",
                migrationId: "migration-v1",
                shardId: "ShardDO_0",
            },
            {
                request: async (_origin, pathname) => {
                    if (pathname === "/_chardb/migrations/shard") {
                        shardAttempts++;
                        throw new Error("connection reset after response loss");
                    }
                    return {
                        response: new Response(null, { status: 200 }),
                        body: {
                            shards: [{ shardId: "ShardDO_0", status: "active", lastError: "response was lost" }],
                        },
                    };
                },
                sleep: async () => {
                    throw new Error("active reconciliation must not sleep");
                },
            }
        );
        expect(shardAttempts).toBe(1);
        expect(result).toEqual({
            shard: { shardId: "ShardDO_0", status: "active", lastError: "response was lost" },
        });
    });

    test("does not retry a 4xx shard rejection and preserves Catalog lastError", async () => {
        let shardAttempts = 0;
        await expect(
            activateMigrationShardWithRetry(
                {
                    origin: "https://proof.example",
                    adminToken: "private-admin-token",
                    migrationId: "migration-v1",
                    shardId: "ShardDO_0",
                },
                {
                    request: async (_origin, pathname) => {
                        if (pathname === "/_chardb/migrations/shard") {
                            shardAttempts++;
                            return {
                                response: new Response(null, { status: 409 }),
                                body: { ok: false, error: "migration owner changed" },
                            };
                        }
                        return {
                            response: new Response(null, { status: 200 }),
                            body: {
                                shards: [
                                    {
                                        shardId: "ShardDO_0",
                                        status: "pending",
                                        lastError: "CDB_STALE_EPOCH: owner changed",
                                    },
                                ],
                            },
                        };
                    },
                    sleep: async () => {
                        throw new Error("4xx rejection must not sleep");
                    },
                }
            )
        ).rejects.toThrow("CDB_STALE_EPOCH: owner changed");
        expect(shardAttempts).toBe(1);
    });

    test("bounds a persistent retryable failure at three shard attempts", async () => {
        let shardAttempts = 0;
        let inventoryReads = 0;
        const sleeps: number[] = [];
        await expect(
            activateMigrationShardWithRetry(
                {
                    origin: "https://proof.example",
                    adminToken: "private-admin-token",
                    migrationId: "migration-v1",
                    shardId: "ShardDO_0",
                },
                {
                    request: async (_origin, pathname) => {
                        if (pathname === "/_chardb/migrations/shard") {
                            shardAttempts++;
                            return {
                                response: new Response(null, { status: 503 }),
                                body: { ok: false, error: `transient failure ${shardAttempts}` },
                            };
                        }
                        inventoryReads++;
                        return {
                            response: new Response(null, { status: 200 }),
                            body: {
                                shards: [
                                    {
                                        shardId: "ShardDO_0",
                                        status: "pending",
                                        lastError: `Catalog attempt ${inventoryReads} failed`,
                                    },
                                ],
                            },
                        };
                    },
                    sleep: async milliseconds => {
                        sleeps.push(milliseconds);
                    },
                }
            )
        ).rejects.toThrow("Catalog attempt 3 failed");
        expect(shardAttempts).toBe(3);
        expect(inventoryReads).toBe(3);
        expect(sleeps).toEqual([250, 500]);
    });

    test("scrubs errors and refuses to finalize evidence containing a secret", async () => {
        expect(scrubSensitive("token=secret-token", ["secret-token"])).toBe("token=[redacted]");
        const output = await temporaryDirectory();
        await writeFile(path.join(output, "leak.txt"), "secret-token");
        await expect(assertNoSensitiveEvidence(output, ["secret-token"])).rejects.toThrow("leaked");
    });

    test("writes deterministic hashed evidence without private values", async () => {
        const output = await temporaryDirectory();
        const finalized = await finalizeFileProofEvidence(
            output,
            {
                schema: "chardb.cloudflare-r2-proof.report.v3",
                ok: true,
                lifecycle: { bulkObjects: 34 },
            },
            ["never-write-this-token"],
            { pairSha256: "a".repeat(64) }
        );
        expect(finalized.digest).toMatch(/^[a-f0-9]{64}$/);
        const report = JSON.parse(await readFile(path.join(output, "r2-proof-report.json"), "utf8"));
        expect(report.evidence.secretScanPassed).toBe(true);
        expect(report.evidence.benchmark).toEqual({
            directory: "benchmarks",
            manifestFile: "benchmark-evidence.sha256",
            pairFile: "paired.json",
            pairSha256: "a".repeat(64),
        });
        expect(await readFile(path.join(output, "evidence.sha256"), "utf8")).toBe(
            `${finalized.digest}  r2-proof-report.json\n`
        );
    });
});
