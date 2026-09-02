import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    CLOUDFLARE_VECTORIZE_PROOF_OWNERSHIP_SCHEMA,
    appendVectorizeOwnedPhysicalIds,
    assertVectorizeCleanupOwnership,
    deriveDisposableVectorizeResourceNames,
    executeCloudflareVectorizeCleanup,
    executeCloudflareVectorizeProvisioning,
    executeCloudflareVectorizeRedeploy,
    parseCloudflareVectorizeProofArgs,
    planCloudflareVectorizeCleanupCommands,
    planCloudflareVectorizeCommands,
    prepareCloudflareVectorizeCleanupPlan,
    prepareCloudflareVectorizeProofPlan,
    withWranglerAuthEnvironment,
} from "../scripts/run-cloudflare-vectorize-proof.mjs";

const temporaryDirectories: string[] = [];
const digest = "a".repeat(64);
const nonce = "0123456789abcdef";
const accountId = "b".repeat(32);

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function whoami(accountIds: readonly string[] = [accountId]) {
    return {
        loggedIn: true,
        authType: "OAuth Token",
        email: "proof@example.com",
        accounts: accountIds.map(id => ({ id })),
        tokenPermissions: ["workers:write"],
    };
}

function physical(label: string): string {
    return `p1_${Buffer.from(hash(label), "hex").toString("base64url")}_1`;
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chardb-vector-plan-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function executionFixture() {
    const root = await temporaryDirectory();
    const output = path.join(root, "evidence");
    const privateDir = path.join(root, "private");
    const tarball = path.join(root, "candidate.tgz");
    const config = path.join(root, "wrangler.toml");
    const secretsFile = path.join(privateDir, "secrets.json");
    await writeFile(tarball, "candidate bytes");
    await writeFile(config, 'name = "fixture"\n');
    const prepared = await prepareCloudflareVectorizeProofPlan({
        tarball,
        output,
        privateDir,
        nonce,
        runId: "vector_proof_0123456789abcdef",
    });
    await writeFile(secretsFile, "{}\n", { mode: 0o600 });
    const candidateSha256 = hash("candidate bytes");
    return {
        root,
        ledgerPath: prepared.ledgerPath,
        input: {
            ledgerPath: prepared.ledgerPath,
            candidateSha256,
            accountId,
            apiToken: "proof-token-0123456789",
            logPath: path.join(privateDir, "wrangler.log"),
            cwd: root,
            config,
            secretsFile,
            wranglerExecutable: "/fixture/wrangler",
            baseEnvironment: { PATH: "/bin", CLOUDFLARE_API_KEY: "must-not-leak" },
            pollTimeoutMs: 100,
            pollIntervalMs: 5,
        },
    };
}

function okJson(value: unknown) {
    return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

const notFound = { exitCode: 1, stdout: "", stderr: "Error: resource not found" };
const vectorizeNotFound = {
    exitCode: 1,
    stdout: "",
    stderr: 'vectorize.index.not_found - Index name "owned-proof-index" [code: 3000]',
};
const vectorizeDeleted = {
    exitCode: 1,
    stdout: "",
    stderr: 'vectorize.index.deleted - Index name "owned-proof-index" was deleted [code: 3005]',
};
const okText = (text: string) => ({ exitCode: 0, stdout: `${text}\n`, stderr: "" });

function ownedLedger() {
    return {
        schema: CLOUDFLARE_VECTORIZE_PROOF_OWNERSHIP_SCHEMA,
        candidateSha256: digest,
        nonce,
        runId: "vector_proof_0123456789abcdef",
        ...deriveDisposableVectorizeResourceNames(digest, nonce),
        workerAbsentConfirmed: true,
        indexAbsentConfirmed: true,
        indexCreateIntent: true,
        indexCreated: true,
        metadataIndexCreateIntent: true,
        metadataIndexCreated: true,
        workerCreateIntent: true,
        workerCreated: true,
        workerDeleted: false,
        indexDeleted: false,
        knownPhysicalIds: [physical("one"), physical("two")],
    };
}

describe("Cloudflare Vectorize proof planning", () => {
    test("parses proof and cleanup modes strictly", () => {
        expect(
            parseCloudflareVectorizeProofArgs([
                "--tarball",
                "/candidate/chardb.tgz",
                "--output",
                "/evidence",
                "--private-dir",
                "/private/vector",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                accountId.toUpperCase(),
                "--confirm-disposable-resources",
            ])
        ).toEqual({
            help: false,
            mode: "proof-plan",
            tarball: "/candidate/chardb.tgz",
            output: "/evidence",
            privateDir: "/private/vector",
            workersDevSubdomain: "zpg6",
            accountId,
            cleanupLedger: undefined,
            confirmed: true,
            execute: false,
            config: undefined,
            cwd: undefined,
            secretsFile: undefined,
            wranglerExecutable: "wrangler",
            profile: undefined,
        });
        expect(
            parseCloudflareVectorizeProofArgs([
                "--cleanup-ledger",
                "/private/ownership.json",
                "--tarball",
                "/candidate/chardb.tgz",
                "--account-id",
                accountId,
                "--confirm-disposable-resources",
            ]).mode
        ).toBe("cleanup-plan");
        expect(() =>
            parseCloudflareVectorizeProofArgs([
                "--tarball",
                "candidate.tgz",
                "--account-id",
                accountId,
                "--confirm-disposable-resources",
            ])
        ).toThrow("--output is required");
        expect(() =>
            parseCloudflareVectorizeProofArgs([
                "--cleanup-ledger",
                "ownership.json",
                "--tarball",
                "candidate.tgz",
                "--account-id",
                accountId,
                "--output",
                "evidence",
                "--confirm-disposable-resources",
            ])
        ).toThrow("does not accept");
        expect(() =>
            parseCloudflareVectorizeProofArgs([
                "--tarball",
                "candidate.tgz",
                "--output",
                "/evidence",
                "--private-dir",
                "/private",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                accountId,
                "--confirm-disposable-resources",
                "--config",
                "/worker/wrangler.toml",
            ])
        ).toThrow("require --execute");
        expect(() => parseCloudflareVectorizeProofArgs(["--unknown"])).toThrow("unknown Vectorize proof argument");
    });

    test("derives one bounded identity and plans commands without executing them", () => {
        const names = deriveDisposableVectorizeResourceNames(digest, nonce);
        expect(names).toEqual({
            worker: `chardb-vx-proof-${"a".repeat(10)}-${nonce}`,
            index: `chardb-vx-proof-${"a".repeat(10)}-${nonce}`,
        });
        expect(new TextEncoder().encode(names.index).byteLength).toBeLessThanOrEqual(64);
        const plan = planCloudflareVectorizeCommands({ candidateSha256: digest, nonce });
        expect(plan.mutatingCommandsExecuted).toBe(false);
        expect(plan.preflight.every(command => command.destructive === false)).toBe(true);
        expect(plan.creation.filter(command => command.destructive)).toHaveLength(3);
        expect(plan.creation[0]?.args).toEqual([
            "vectorize",
            "create",
            names.index,
            "--dimensions",
            "32",
            "--metric",
            "cosine",
            "--description",
            `CharDB disposable proof ${digest.slice(0, 12)}`,
            "--json",
        ]);
        expect(plan.creation.find(command => command.phase === "metadata-index-create")?.args).toContain(
            "cdb_resource"
        );
        expect(plan.creation.find(command => command.phase === "worker-deploy")?.args).toContain(`vx-${nonce}-v1`);
        expect(JSON.stringify(plan)).not.toContain(accountId);
    });

    test("writes a private ownership ledger before any resource is marked created", async () => {
        const root = await temporaryDirectory();
        const output = path.join(root, "evidence");
        const privateDir = path.join(root, "private");
        const tarball = path.join(root, "candidate.tgz");
        await writeFile(tarball, "candidate bytes");
        const prepared = await prepareCloudflareVectorizeProofPlan({
            tarball,
            output,
            privateDir,
            nonce,
            runId: "vector_proof_0123456789abcdef",
        });
        const ledger = JSON.parse(await readFile(prepared.ledgerPath, "utf8"));
        expect(ledger).toMatchObject({
            schema: CLOUDFLARE_VECTORIZE_PROOF_OWNERSHIP_SCHEMA,
            workerAbsentConfirmed: false,
            indexAbsentConfirmed: false,
            indexCreateIntent: false,
            workerCreated: false,
            indexCreated: false,
            metadataIndexCreateIntent: false,
            metadataIndexCreated: false,
            workerCreateIntent: false,
            workerDeleted: false,
            indexDeleted: false,
            knownPhysicalIds: [],
        });
        expect(prepared.publicPlan.mutatingCommandsExecuted).toBe(false);
        expect(JSON.stringify(prepared.publicPlan)).not.toContain(ledger.runId);
        expect((await stat(privateDir)).mode & 0o777).toBe(0o700);
        expect((await stat(prepared.ledgerPath)).mode & 0o777).toBe(0o600);
    });

    test("authorizes cleanup only from an exact absent-preflight ownership ledger", () => {
        const ledger = ownedLedger();
        expect(assertVectorizeCleanupOwnership(ledger, digest)).toMatchObject({
            worker: ledger.worker,
            index: ledger.index,
            knownPhysicalIds: ledger.knownPhysicalIds,
        });
        const commands = planCloudflareVectorizeCleanupCommands(ledger, digest);
        expect(commands.every(command => command.executable === "wrangler")).toBe(true);
        expect(commands.find(command => command.phase === "vector-list-before-cleanup")?.args).toEqual([
            "vectorize",
            "list-vectors",
            ledger.index,
            "--count",
            "1000",
            "--json",
        ]);
        expect(commands.filter(command => command.phase === "exact-vector-delete")).toHaveLength(1);
        expect(commands.some(command => command.args.includes("get-vectors"))).toBe(false);
        expect(commands.find(command => command.phase === "worker-delete")?.args).toEqual([
            "delete",
            ledger.worker,
            "--force",
        ]);
        expect(commands.find(command => command.phase === "index-delete")?.args).toEqual([
            "vectorize",
            "delete",
            ledger.index,
            "--force",
        ]);
        expect(() => assertVectorizeCleanupOwnership({ ...ledger, index: "unrelated" }, digest)).toThrow("not derived");
        expect(() =>
            assertVectorizeCleanupOwnership(
                { ...ledger, indexAbsentConfirmed: false, indexCreated: false, metadataIndexCreated: false },
                digest
            )
        ).toThrow("absent-resource preflight");
        expect(() => assertVectorizeCleanupOwnership(ledger, "f".repeat(64))).toThrow("candidate digest drifted");
    });

    test("cleanup-ledger mode returns a plan and does not execute it", async () => {
        const root = await temporaryDirectory();
        const tarball = path.join(root, "candidate.tgz");
        await writeFile(tarball, "candidate bytes");
        const candidateDigest = hash("candidate bytes");
        const ledger = { ...ownedLedger(), candidateSha256: candidateDigest };
        Object.assign(ledger, deriveDisposableVectorizeResourceNames(candidateDigest, nonce));
        const ledgerPath = path.join(root, "ownership.json");
        await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
        const plan = await prepareCloudflareVectorizeCleanupPlan({ tarball, cleanupLedger: ledgerPath });
        expect(plan.mutatingCommandsExecuted).toBe(false);
        expect((plan.commands as { destructive: boolean }[]).some(command => command.destructive)).toBe(true);
    });

    test("uses only the exact Wrangler token and removes auth values after planning work", async () => {
        let captured: Record<string, string | undefined> | undefined;
        const result = await withWranglerAuthEnvironment(
            {
                PATH: "/bin",
                CLOUDFLARE_API_KEY: "legacy-key",
                CLOUDFLARE_EMAIL: "legacy@example.com",
                CF_API_TOKEN: "conflicting-token",
                WRANGLER_LOG_PATH: "/unsafe/user-profile/wrangler.log",
            },
            { accountId, apiToken: "proof-token-0123456789", logPath: "/private/wrangler.log" },
            environment => {
                captured = environment;
                expect(environment.CLOUDFLARE_API_TOKEN).toBe("proof-token-0123456789");
                expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe(accountId);
                expect(environment.CLOUDFLARE_API_KEY).toBeUndefined();
                expect(environment.CF_API_TOKEN).toBeUndefined();
                expect(environment.WRANGLER_LOG_PATH).toBe("/private/wrangler.log");
                return "planned";
            }
        );
        expect(result).toBe("planned");
        expect(captured?.PATH).toBe("/bin");
        expect(captured?.CLOUDFLARE_API_TOKEN).toBeUndefined();
        expect(captured?.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
        expect(captured?.WRANGLER_LOG_PATH).toBeUndefined();
    });

    test("uses a stored Wrangler profile without exposing token or account environment", async () => {
        let captured: Record<string, string | undefined> | undefined;
        await withWranglerAuthEnvironment(
            {
                PATH: "/bin",
                CLOUDFLARE_API_TOKEN: "ambient-token-must-be-cleared",
                CLOUDFLARE_ACCOUNT_ID: accountId,
                CF_API_TOKEN: "conflicting-token",
                CF_ACCOUNT_ID: accountId,
                XDG_CONFIG_HOME: "/existing/xdg-config",
                XDG_CACHE_HOME: "/existing/xdg-cache",
                XDG_STATE_HOME: "/existing/xdg-state",
            },
            { accountId, profile: "oauth-proof", logPath: "/private/wrangler.log" },
            environment => {
                captured = environment;
                expect(environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
                expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe(accountId);
                expect(environment.CF_API_TOKEN).toBeUndefined();
                expect(environment.CF_ACCOUNT_ID).toBeUndefined();
                expect(environment.WRANGLER_LOG_PATH).toBe("/private/wrangler.log");
                expect(environment.XDG_CONFIG_HOME).toBe("/existing/xdg-config");
                expect(environment.XDG_CACHE_HOME).toBe("/existing/xdg-cache");
                expect(environment.XDG_STATE_HOME).toBe("/existing/xdg-state");
            }
        );
        expect(captured?.CLOUDFLARE_API_TOKEN).toBeUndefined();
        expect(captured?.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
        await expect(
            withWranglerAuthEnvironment(
                {},
                {
                    accountId,
                    apiToken: "proof-token-0123456789",
                    profile: "oauth-proof",
                    logPath: "/private/wrangler.log",
                },
                () => undefined
            )
        ).rejects.toThrow("exactly one");
    });

    test("removes the private Wrangler log after every profile command, including failure", async () => {
        const fixture = await executionFixture();
        const oauthToken = "oauth_profile_token_0123456789abcdef";
        const phases: string[] = [];
        const { apiToken: _apiToken, ...profileInput } = fixture.input;
        const input = {
            ...profileInput,
            profile: "default",
            logPath: path.join(path.dirname(profileInput.logPath), "wrangler-live.log"),
        };
        const result = executeCloudflareVectorizeProvisioning(input, {
            run: async invocation => {
                phases.push(invocation.command.phase);
                await expect(Bun.file(input.logPath).exists()).resolves.toBe(false);
                await writeFile(input.logPath, `OAuth token: ${oauthToken}\n`, { mode: 0o600 });
                if (invocation.command.phase === "profile-auth-preflight") {
                    return okJson({ type: "oauth", token: oauthToken });
                }
                throw new Error("fixed profile account failure");
            },
        });

        await expect(result).rejects.toThrow("fixed profile account failure");
        expect(phases).toEqual(["profile-auth-preflight", "profile-account-preflight"]);
        expect(await Bun.file(input.logPath).exists()).toBe(false);
        for (const file of await readdir(path.join(fixture.root, "evidence"))) {
            expect(await readFile(path.join(fixture.root, "evidence", file), "utf8")).not.toContain(oauthToken);
        }
    });
});

describe("Cloudflare Vectorize proof execution", () => {
    test("provisions only from exact planned commands and records intent before every create", async () => {
        const fixture = await executionFixture();
        let now = 0;
        let indexPolls = 0;
        let metadataIndexPolls = 0;
        let versionPolls = 0;
        let deploymentPolls = 0;
        const phases: string[] = [];
        const result = await executeCloudflareVectorizeProvisioning(fixture.input, {
            now: () => now,
            sleep: async milliseconds => {
                now += milliseconds;
            },
            run: async invocation => {
                phases.push(invocation.command.phase);
                expect(invocation.cwd).toBe(fixture.root);
                expect(invocation.config).toBe(fixture.input.config);
                expect(invocation.executable).toBe("/fixture/wrangler");
                expect(invocation.environment.CLOUDFLARE_API_TOKEN).toBe("proof-token-0123456789");
                expect(invocation.environment.CLOUDFLARE_API_KEY).toBeUndefined();
                expect(invocation.environment.XDG_CONFIG_HOME).toStartWith(path.dirname(fixture.ledgerPath));
                const ledger = JSON.parse(await readFile(fixture.ledgerPath, "utf8"));
                switch (invocation.command.phase) {
                    case "worker-absence":
                        return okJson([]);
                    case "index-list-absence":
                        return okJson([]);
                    case "index-get-absence":
                        return vectorizeNotFound;
                    case "index-create":
                        expect(ledger).toMatchObject({ indexCreateIntent: true, indexCreated: false });
                        return okJson({ mutationId: "index-create-1" });
                    case "index-readiness":
                        indexPolls++;
                        return indexPolls === 1
                            ? vectorizeNotFound
                            : okJson({ name: ledger.index, config: { dimensions: 32, metric: "cosine" } });
                    case "metadata-index-create":
                        expect(ledger).toMatchObject({
                            indexCreated: true,
                            metadataIndexCreateIntent: true,
                            metadataIndexCreated: false,
                        });
                        expect(invocation.command.args).toContain("--propertyName");
                        return okText("created metadata index");
                    case "metadata-index-readiness":
                        metadataIndexPolls++;
                        return metadataIndexPolls === 1
                            ? okJson([])
                            : okJson([{ propertyName: "cdb_resource", indexType: "String" }]);
                    case "worker-deploy":
                        expect(ledger).toMatchObject({ workerCreateIntent: true, workerCreated: false });
                        expect(invocation.command.args).toContain(fixture.input.secretsFile);
                        return okText("deployed Worker");
                    case "worker-version-evidence":
                        versionPolls++;
                        return versionPolls === 1
                            ? okJson([])
                            : okJson([
                                  {
                                      id: "version-0001",
                                      number: 1,
                                      name: ledger.worker,
                                      annotations: { "workers/tag": `vx-${nonce}-v1` },
                                  },
                              ]);
                    case "worker-deployment-evidence":
                        deploymentPolls++;
                        return deploymentPolls === 1
                            ? okJson({
                                  id: "deployment-stale",
                                  versions: [{ version_id: "version-stale", percentage: 100 }],
                              })
                            : okJson({
                                  id: "deployment-0001",
                                  versions: [{ version_id: "version-0001", percentage: 100 }],
                              });
                    default:
                        throw new Error(`unexpected phase ${invocation.command.phase}`);
                }
            },
        });
        expect(result.deployment).toEqual({
            deploymentId: "deployment-0001",
            versionId: "version-0001",
            number: 1,
            percentage: 100,
        });
        expect(result.ledger).toMatchObject({
            workerAbsentConfirmed: true,
            indexAbsentConfirmed: true,
            indexCreated: true,
            metadataIndexCreated: true,
            workerCreated: true,
        });
        expect(indexPolls).toBe(2);
        expect(metadataIndexPolls).toBe(2);
        expect(versionPolls).toBe(2);
        expect(deploymentPolls).toBe(2);
        expect(phases.filter(phase => phase.endsWith("create") || phase === "worker-deploy")).toEqual([
            "index-create",
            "metadata-index-create",
            "worker-deploy",
        ]);
        expect((await stat(fixture.ledgerPath)).mode & 0o777).toBe(0o600);
    });

    test("rejects malformed absence output and pre-existing names before mutation", async () => {
        const malformed = await executionFixture();
        const malformedPhases: string[] = [];
        await expect(
            executeCloudflareVectorizeProvisioning(malformed.input, {
                run: invocation => {
                    malformedPhases.push(invocation.command.phase);
                    return { exitCode: 0, stdout: "{", stderr: "" };
                },
            })
        ).rejects.toThrow("malformed JSON");
        expect(malformedPhases).toEqual(["worker-absence"]);
        expect(JSON.parse(await readFile(malformed.ledgerPath, "utf8"))).toMatchObject({
            workerAbsentConfirmed: false,
            indexCreateIntent: false,
        });

        const drift = await executionFixture();
        const names = deriveDisposableVectorizeResourceNames(drift.input.candidateSha256, nonce);
        const driftPhases: string[] = [];
        await expect(
            executeCloudflareVectorizeProvisioning(drift.input, {
                run: invocation => {
                    driftPhases.push(invocation.command.phase);
                    if (invocation.command.phase === "worker-absence") return okJson([]);
                    if (invocation.command.phase === "index-list-absence") return okJson([{ name: names.index }]);
                    throw new Error("mutation must not run");
                },
            })
        ).rejects.toThrow("already exists");
        expect(driftPhases).toEqual(["worker-absence", "index-list-absence"]);

        const descriptorDrift = await executionFixture();
        const descriptorPhases: string[] = [];
        await expect(
            executeCloudflareVectorizeProvisioning(descriptorDrift.input, {
                run: async invocation => {
                    descriptorPhases.push(invocation.command.phase);
                    const ledger = JSON.parse(await readFile(descriptorDrift.ledgerPath, "utf8"));
                    switch (invocation.command.phase) {
                        case "worker-absence":
                        case "index-list-absence":
                            return okJson([]);
                        case "index-get-absence":
                            return notFound;
                        case "index-create":
                            return okJson({ mutationId: "accepted" });
                        case "index-readiness":
                            return okJson({ name: ledger.index, config: { dimensions: 4, metric: "cosine" } });
                        default:
                            throw new Error("metadata and Worker mutations must not run after descriptor drift");
                    }
                },
            })
        ).rejects.toThrow("descriptor drifted");
        expect(descriptorPhases).not.toContain("metadata-index-create");
        expect(descriptorPhases).not.toContain("worker-deploy");

        const sibling = await executionFixture();
        const siblingName = `${deriveDisposableVectorizeResourceNames(sibling.input.candidateSha256, nonce).index}-backup`;
        const siblingPhases: string[] = [];
        await expect(
            executeCloudflareVectorizeProvisioning(sibling.input, {
                run: invocation => {
                    siblingPhases.push(invocation.command.phase);
                    if (invocation.command.phase === "worker-absence") return okJson([]);
                    if (invocation.command.phase === "index-list-absence") return okJson([{ name: siblingName }]);
                    if (invocation.command.phase === "index-get-absence") return notFound;
                    if (invocation.command.phase === "index-create") {
                        return { exitCode: 1, stdout: "", stderr: "deliberate stop" };
                    }
                    throw new Error("unexpected command");
                },
            })
        ).rejects.toThrow("index-create failed");
        expect(siblingPhases).toEqual(["worker-absence", "index-list-absence", "index-get-absence", "index-create"]);
    });

    test("rejects malformed or conflicting metadata-index readiness without deploying the Worker", async () => {
        const cases = [
            {
                label: "malformed envelope",
                value: { metadataIndexes: "not-an-array" },
                message: "must contain a metadata-index array",
            },
            {
                label: "conflicting indexes",
                value: [
                    { propertyName: "cdb_resource", indexType: "string" },
                    { propertyName: "other", indexType: "string" },
                ],
                message: "contains conflicting metadata indexes",
            },
            {
                label: "conflicting aliases",
                value: { metadataIndexes: [{ propertyName: "cdb_resource", property_name: "other", type: "string" }] },
                message: "contains a conflicting metadata index",
            },
            {
                label: "wrong canonical type",
                value: [{ propertyName: "cdb_resource", indexType: "Number" }],
                message: "lacks the exact cdb_resource string metadata index",
            },
        ] as const;
        for (const item of cases) {
            const fixture = await executionFixture();
            const phases: string[] = [];
            await expect(
                executeCloudflareVectorizeProvisioning(fixture.input, {
                    run: async invocation => {
                        phases.push(invocation.command.phase);
                        const ledger = JSON.parse(await readFile(fixture.ledgerPath, "utf8"));
                        switch (invocation.command.phase) {
                            case "worker-absence":
                            case "index-list-absence":
                                return okJson([]);
                            case "index-get-absence":
                                return vectorizeNotFound;
                            case "index-create":
                                return okJson({ mutationId: "index-create-1" });
                            case "index-readiness":
                                return okJson({
                                    name: ledger.index,
                                    config: { dimensions: 32, metric: "cosine" },
                                });
                            case "metadata-index-create":
                                return okText("created metadata index");
                            case "metadata-index-readiness":
                                return okJson(item.value);
                            default:
                                throw new Error(`unexpected phase for ${item.label}: ${invocation.command.phase}`);
                        }
                    },
                })
            ).rejects.toThrow(item.message);
            expect(phases).not.toContain("worker-deploy");
        }
    });

    test("reconciles a lost index-create receipt and resumes cleanup without guessing ownership", async () => {
        const fixture = await executionFixture();
        await expect(
            executeCloudflareVectorizeProvisioning(fixture.input, {
                run: invocation => {
                    if (invocation.command.phase === "worker-absence") return okJson([]);
                    if (invocation.command.phase === "index-list-absence") return okJson([]);
                    if (invocation.command.phase === "index-get-absence") return notFound;
                    if (invocation.command.phase === "index-create") {
                        return { exitCode: 1, stdout: "", stderr: "connection lost after request" };
                    }
                    throw new Error("unexpected command after failed create");
                },
            })
        ).rejects.toThrow("index-create failed");
        expect(JSON.parse(await readFile(fixture.ledgerPath, "utf8"))).toMatchObject({
            indexCreateIntent: true,
            indexCreated: false,
        });

        const cleanupPhases: string[] = [];
        const result = await executeCloudflareVectorizeCleanup(fixture.input, {
            run: invocation => {
                cleanupPhases.push(invocation.command.phase);
                switch (invocation.command.phase) {
                    case "index-create-reconcile":
                        return okJson({
                            name: deriveDisposableVectorizeResourceNames(fixture.input.candidateSha256, nonce).index,
                            config: { dimensions: 32, metric: "cosine" },
                        });
                    case "vector-list-before-cleanup":
                    case "exact-vector-absence-verify":
                        return okJson({ vectors: [], count: 0, totalCount: 0, isTruncated: false });
                    case "worker-absence-verify":
                        return okJson([]);
                    case "index-delete":
                        return okText("deleted index");
                    case "index-delete-reconcile":
                        return okJson({
                            name: deriveDisposableVectorizeResourceNames(fixture.input.candidateSha256, nonce).index,
                            config: { dimensions: 32, metric: "cosine" },
                        });
                    case "index-absence-verify":
                        return notFound;
                    case "index-list-absence-verify":
                        return okJson([]);
                    default:
                        throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                }
            },
        });
        expect(cleanupPhases).not.toContain("worker-delete");
        expect(result.ledger).toMatchObject({ indexCreated: true, indexDeleted: true, workerCreated: false });
    });

    test("paginates owned vectors, rejects an unknown ID, and leaves resources untouched", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            knownPhysicalIds: [physical("one")],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const phases: string[] = [];
        await expect(
            executeCloudflareVectorizeCleanup(fixture.input, {
                run: invocation => {
                    phases.push(invocation.command.phase);
                    if (invocation.command.phase === "vector-list-before-cleanup") {
                        return okJson({
                            vectors: [{ id: physical("unknown") }],
                            count: 1,
                            totalCount: 1,
                            isTruncated: false,
                        });
                    }
                    throw new Error("destructive command must not run");
                },
            })
        ).rejects.toThrow("unknown vector ID");
        expect(phases).toEqual(["vector-list-before-cleanup"]);
        expect(JSON.parse(await readFile(fixture.ledgerPath, "utf8"))).toMatchObject({
            workerDeleted: false,
            indexDeleted: false,
        });
    });

    test("deletes only ledger IDs, verifies fresh absence, and resumes past a deleted Worker", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const known = [physical("one"), physical("two")];
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            workerDeleted: true,
            knownPhysicalIds: known,
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        let listPage = 0;
        let absencePolls = 0;
        let workerAbsencePolls = 0;
        let indexAbsencePolls = 0;
        let indexListPolls = 0;
        let now = 0;
        const phases: string[] = [];
        const result = await executeCloudflareVectorizeCleanup(fixture.input, {
            now: () => now,
            sleep: async milliseconds => {
                now += milliseconds;
            },
            run: invocation => {
                phases.push(invocation.command.phase);
                switch (invocation.command.phase) {
                    case "vector-list-before-cleanup":
                        listPage++;
                        if (listPage === 1) {
                            expect(invocation.command.args).not.toContain("--cursor");
                            return okJson({
                                vectors: [{ id: known[0] }],
                                count: 1,
                                totalCount: 2,
                                isTruncated: true,
                                nextCursor: "page-2",
                            });
                        }
                        expect(invocation.command.args).toContain("page-2");
                        return okJson({
                            vectors: [{ id: known[1] }],
                            count: 1,
                            totalCount: 2,
                            isTruncated: false,
                        });
                    case "exact-vector-delete":
                        expect(invocation.command.args.slice(-2)).toEqual(known);
                        return okText("deleted vectors");
                    case "exact-vector-absence-verify":
                        absencePolls++;
                        expect(invocation.command.args).not.toContain("--cursor");
                        return absencePolls === 1
                            ? okJson({
                                  vectors: [{ id: known[0] }],
                                  count: 1,
                                  totalCount: 1,
                                  isTruncated: false,
                              })
                            : okJson({ vectors: [], count: 0, totalCount: 0, isTruncated: false });
                    case "worker-absence-verify":
                        workerAbsencePolls++;
                        return workerAbsencePolls === 1
                            ? okJson([{ id: "version-0001", number: 1, name: ledger.worker }])
                            : okJson([]);
                    case "index-delete":
                        return okText("deleted index");
                    case "index-delete-reconcile":
                        return okJson({
                            name: deriveDisposableVectorizeResourceNames(candidateSha256, nonce).index,
                            config: { dimensions: 32, metric: "cosine" },
                        });
                    case "index-absence-verify":
                        indexAbsencePolls++;
                        return indexAbsencePolls === 1
                            ? okJson({ name: ledger.index, config: { dimensions: 32, metric: "cosine" } })
                            : vectorizeDeleted;
                    case "index-list-absence-verify":
                        indexListPolls++;
                        return indexListPolls === 1 ? okJson([{ name: ledger.index }]) : okJson([]);
                    default:
                        throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                }
            },
        });
        expect(phases).not.toContain("worker-delete");
        expect(phases).not.toContain("exact-vector-get-absence-verify");
        expect(absencePolls).toBe(2);
        expect(workerAbsencePolls).toBe(2);
        expect(indexAbsencePolls).toBe(3);
        expect(indexListPolls).toBe(2);
        expect(result).toMatchObject({ workerAbsent: true, indexAbsent: true });
        expect(result.ledger).toMatchObject({ workerDeleted: true, indexDeleted: true });
    });

    test("uses the remote settlement window only for exact vector deletion", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const known = physical("eventually-absent");
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            workerDeleted: true,
            knownPhysicalIds: [known],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        let now = 0;
        let vectorAbsencePolls = 0;
        const result = await executeCloudflareVectorizeCleanup(
            { ...fixture.input, pollTimeoutMs: 5, pollIntervalMs: 5, settlementTimeoutMs: 15 },
            {
                now: () => now,
                sleep: async milliseconds => {
                    now += milliseconds;
                },
                run: invocation => {
                    switch (invocation.command.phase) {
                        case "vector-list-before-cleanup":
                            return okJson({
                                vectors: [{ id: known }],
                                count: 1,
                                totalCount: 1,
                                isTruncated: false,
                            });
                        case "exact-vector-delete":
                            return okText("deleted vectors");
                        case "exact-vector-absence-verify":
                            vectorAbsencePolls++;
                            return vectorAbsencePolls < 3
                                ? okJson({
                                      vectors: [{ id: known }],
                                      count: 1,
                                      totalCount: 1,
                                      isTruncated: false,
                                  })
                                : okJson({ vectors: [], count: 0, totalCount: 0, isTruncated: false });
                        case "worker-absence-verify":
                            return okJson([]);
                        case "index-delete-reconcile":
                            return okJson({ name: ledger.index, config: { dimensions: 32, metric: "cosine" } });
                        case "index-delete":
                            return okText("deleted index");
                        case "index-absence-verify":
                            return notFound;
                        case "index-list-absence-verify":
                            return okJson([]);
                        default:
                            throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                    }
                },
            }
        );
        expect(vectorAbsencePolls).toBe(3);
        expect(now).toBe(10);
        expect(result).toMatchObject({ finalVectorCount: 0, workerAbsent: true, indexAbsent: true });
    });

    test("retries a nonzero post-delete vector listing without stranding the owned index", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const known = physical("transient-list-failure");
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            workerDeleted: true,
            knownPhysicalIds: [known],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        let now = 0;
        let absencePolls = 0;
        const phases: string[] = [];
        const result = await executeCloudflareVectorizeCleanup(fixture.input, {
            now: () => now,
            sleep: async milliseconds => {
                now += milliseconds;
            },
            run: invocation => {
                phases.push(invocation.command.phase);
                switch (invocation.command.phase) {
                    case "vector-list-before-cleanup":
                        return okJson({
                            vectors: [{ id: known }],
                            count: 1,
                            totalCount: 1,
                            isTruncated: false,
                        });
                    case "exact-vector-delete":
                        return okText("deleted vectors");
                    case "exact-vector-absence-verify":
                        absencePolls++;
                        return absencePolls === 1
                            ? { exitCode: 1, stdout: "", stderr: "temporary Vectorize service failure" }
                            : okJson({ vectors: [], count: 0, totalCount: 0, isTruncated: false });
                    case "worker-absence-verify":
                        return okJson([]);
                    case "index-delete-reconcile":
                        return okJson({ name: ledger.index, config: { dimensions: 32, metric: "cosine" } });
                    case "index-delete":
                        return okText("deleted index");
                    case "index-absence-verify":
                        return notFound;
                    case "index-list-absence-verify":
                        return okJson([]);
                    default:
                        throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                }
            },
        });
        expect(absencePolls).toBe(2);
        expect(phases).toContain("index-delete");
        expect(now).toBe(fixture.input.pollIntervalMs);
        expect(result).toMatchObject({ finalVectorCount: 0, workerAbsent: true, indexAbsent: true });
    });

    test("still rejects an unknown vector after a transient post-delete listing failure", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const known = physical("known-before-transient");
        const unknown = physical("unknown-after-transient");
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            workerDeleted: true,
            knownPhysicalIds: [known],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        let absencePolls = 0;
        const phases: string[] = [];
        await expect(
            executeCloudflareVectorizeCleanup(fixture.input, {
                run: invocation => {
                    phases.push(invocation.command.phase);
                    switch (invocation.command.phase) {
                        case "vector-list-before-cleanup":
                            return okJson({
                                vectors: [{ id: known }],
                                count: 1,
                                totalCount: 1,
                                isTruncated: false,
                            });
                        case "exact-vector-delete":
                            return okText("deleted vectors");
                        case "exact-vector-absence-verify":
                            absencePolls++;
                            return absencePolls === 1
                                ? { exitCode: 1, stdout: "", stderr: "temporary Vectorize service failure" }
                                : okJson({
                                      vectors: [{ id: unknown }],
                                      count: 1,
                                      totalCount: 1,
                                      isTruncated: false,
                                  });
                        case "worker-absence-verify":
                            return okJson([]);
                        default:
                            throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                    }
                },
            })
        ).rejects.toThrow(`Vectorize cleanup discovered unknown vector ID ${unknown}`);
        expect(absencePolls).toBe(2);
        expect(phases).not.toContain("index-delete");
        expect(JSON.parse(await readFile(fixture.ledgerPath, "utf8"))).toMatchObject({ indexDeleted: false });
    });

    test("deletes an owned replacement that becomes visible after the first cleanup snapshot", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const first = physical("delayed-replacement");
        const replacement = first.replace(/_1$/u, "_2");
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            knownPhysicalIds: [first, replacement],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        let now = 0;
        let absencePolls = 0;
        const phases: string[] = [];
        const deleted: string[][] = [];
        const result = await executeCloudflareVectorizeCleanup(fixture.input, {
            now: () => now,
            sleep: async milliseconds => {
                now += milliseconds;
            },
            run: invocation => {
                phases.push(invocation.command.phase);
                switch (invocation.command.phase) {
                    case "vector-list-before-cleanup":
                        return okJson({
                            vectors: [{ id: first }],
                            count: 1,
                            totalCount: 1,
                            isTruncated: false,
                        });
                    case "worker-delete-reconcile":
                        return okJson([{ id: "version-0001", number: 1, name: ledger.worker }]);
                    case "worker-delete":
                        return okText("deleted Worker");
                    case "worker-absence-verify":
                        return okJson([]);
                    case "exact-vector-delete":
                        deleted.push(
                            invocation.command.args.filter(argument => argument === first || argument === replacement)
                        );
                        return okText("deleted vectors");
                    case "exact-vector-absence-verify":
                        absencePolls++;
                        if (absencePolls === 1) {
                            return okJson({
                                vectors: [{ id: first }],
                                count: 1,
                                totalCount: 1,
                                isTruncated: false,
                            });
                        }
                        if (absencePolls === 2) {
                            return okJson({
                                vectors: [{ id: replacement }],
                                count: 1,
                                totalCount: 1,
                                isTruncated: false,
                            });
                        }
                        return okJson({ vectors: [], count: 0, totalCount: 0, isTruncated: false });
                    case "index-delete-reconcile":
                        return okJson({ name: ledger.index, config: { dimensions: 32, metric: "cosine" } });
                    case "index-delete":
                        return okText("deleted index");
                    case "index-absence-verify":
                        return notFound;
                    case "index-list-absence-verify":
                        return okJson([]);
                    default:
                        throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                }
            },
        });
        expect(deleted).toEqual([[first], [replacement]]);
        expect(phases.indexOf("worker-absence-verify")).toBeLessThan(phases.indexOf("exact-vector-delete"));
        expect(result.discoveredPhysicalIds).toEqual([first, replacement].sort());
        expect(result).toMatchObject({ finalVectorCount: 0, workerAbsent: true, indexAbsent: true });
    });

    test("does not extend Worker absence readiness to the remote vector settlement window", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            workerDeleted: true,
            indexDeleted: true,
            knownPhysicalIds: [],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        let now = 0;
        let workerAbsencePolls = 0;
        await expect(
            executeCloudflareVectorizeCleanup(
                { ...fixture.input, pollTimeoutMs: 5, pollIntervalMs: 5, settlementTimeoutMs: 20 },
                {
                    now: () => now,
                    sleep: async milliseconds => {
                        now += milliseconds;
                    },
                    run: invocation => {
                        if (invocation.command.phase !== "worker-absence-verify") {
                            throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                        }
                        workerAbsencePolls++;
                        return okJson([{ id: "version-0001", number: 1, name: ledger.worker }]);
                    },
                }
            )
        ).rejects.toThrow("Worker deletion readiness timed out");
        expect(workerAbsencePolls).toBe(2);
        expect(now).toBe(5);
    });

    test("reconciles lost delete receipts without issuing a second destructive command", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            knownPhysicalIds: [],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const phases: string[] = [];
        const result = await executeCloudflareVectorizeCleanup(fixture.input, {
            run: invocation => {
                phases.push(invocation.command.phase);
                switch (invocation.command.phase) {
                    case "vector-list-before-cleanup":
                    case "exact-vector-absence-verify":
                        return okJson({ vectors: [], count: 0, totalCount: 0, isTruncated: false });
                    case "worker-delete-reconcile":
                    case "worker-absence-verify":
                        return okJson([]);
                    case "index-delete-reconcile":
                    case "index-absence-verify":
                        return notFound;
                    case "index-list-absence-verify":
                        return okJson([{ name: `${ledger.index}-backup` }]);
                    default:
                        throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                }
            },
        });
        expect(phases).not.toContain("worker-delete");
        expect(phases).not.toContain("index-delete");
        expect(result.ledger).toMatchObject({ workerDeleted: true, indexDeleted: true });
    });

    test("accepts an exact deleted-index 410 only when the full index list also proves absence", async () => {
        const run = async (remaining: readonly { readonly name: string }[]) => {
            const fixture = await executionFixture();
            const candidateSha256 = fixture.input.candidateSha256;
            const ledger = {
                ...ownedLedger(),
                candidateSha256,
                ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
                workerDeleted: true,
                indexDeleted: true,
                knownPhysicalIds: [],
            };
            await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
            const phases: string[] = [];
            const promise = executeCloudflareVectorizeCleanup(fixture.input, {
                run: invocation => {
                    phases.push(invocation.command.phase);
                    switch (invocation.command.phase) {
                        case "worker-absence-verify":
                            return okJson([]);
                        case "index-absence-verify":
                            return vectorizeDeleted;
                        case "index-list-absence-verify":
                            return okJson(remaining);
                        default:
                            throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                    }
                },
            });
            return { promise, phases, ledger };
        };

        const absent = await run([]);
        await expect(absent.promise).resolves.toMatchObject({ workerAbsent: true, indexAbsent: true });
        expect(absent.phases).toEqual(["worker-absence-verify", "index-absence-verify", "index-list-absence-verify"]);

        const listed = await run([
            { name: deriveDisposableVectorizeResourceNames(hash("candidate bytes"), nonce).index },
        ]);
        await expect(listed.promise).rejects.toThrow("Vectorize index deletion readiness timed out");
        expect(listed.phases).toContain("index-list-absence-verify");
    });

    test("resumes after one vector-delete batch landed and another failed", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const known = [physical("already-deleted"), physical("still-present")] as const;
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            workerDeleted: true,
            knownPhysicalIds: known,
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const result = await executeCloudflareVectorizeCleanup(fixture.input, {
            run: invocation => {
                switch (invocation.command.phase) {
                    case "vector-list-before-cleanup":
                        return okJson({
                            vectors: [{ id: known[1] }],
                            count: 1,
                            totalCount: 1,
                            isTruncated: false,
                        });
                    case "exact-vector-delete":
                        expect(invocation.command.args).toContain(known[1]);
                        expect(invocation.command.args).not.toContain(known[0]);
                        return okText("deleted vectors");
                    case "exact-vector-absence-verify":
                        return okJson({ vectors: [], count: 0, totalCount: 0, isTruncated: false });
                    case "worker-absence-verify":
                        return okJson([]);
                    case "index-delete-reconcile":
                        return okJson({
                            name: ledger.index,
                            config: { dimensions: 32, metric: "cosine" },
                        });
                    case "index-delete":
                        return okText("deleted index");
                    case "index-absence-verify":
                        return notFound;
                    case "index-list-absence-verify":
                        return okJson([]);
                    default:
                        throw new Error(`unexpected cleanup phase ${invocation.command.phase}`);
                }
            },
        });
        expect(result.ledger).toMatchObject({ workerDeleted: true, indexDeleted: true });
    });
});

describe("Cloudflare Vectorize redeploy and owned ID ledger", () => {
    test("redeploys through a stored profile to a distinct immutable version without changing ownership", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const before = await readFile(fixture.ledgerPath, "utf8");
        const initialVersionId = "version-0001";
        const { apiToken: _token, ...executionBase } = fixture.input;
        const profileInput = {
            ...executionBase,
            profile: "oauth-proof",
            initialVersionId,
        };
        const phases: string[] = [];
        let versionPolls = 0;
        let deploymentPolls = 0;
        const result = await executeCloudflareVectorizeRedeploy(profileInput, {
            run: invocation => {
                phases.push(invocation.command.phase);
                expect(invocation.cwd).toBe(fixture.root);
                expect(invocation.config).toBe(fixture.input.config);
                switch (invocation.command.phase) {
                    case "profile-auth-preflight":
                        expect(invocation.command.destructive).toBe(false);
                        expect(invocation.command.args.slice(-2)).toEqual(["--profile", "oauth-proof"]);
                        expect(invocation.environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
                        expect(invocation.environment.CLOUDFLARE_ACCOUNT_ID).toBe(accountId);
                        return okJson({ type: "oauth", token: "oauth-profile-token-0123456789" });
                    case "profile-account-preflight":
                        expect(invocation.command.args).toEqual(["whoami", "--json"]);
                        expect(invocation.environment.CLOUDFLARE_API_TOKEN).toBe("oauth-profile-token-0123456789");
                        expect(invocation.environment.CLOUDFLARE_ACCOUNT_ID).toBe(accountId);
                        return okJson(whoami());
                    case "worker-redeploy":
                        expect(invocation.command.args.slice(-2)).toEqual(["--profile", "oauth-proof"]);
                        expect(invocation.environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
                        expect(invocation.environment.CLOUDFLARE_ACCOUNT_ID).toBe(accountId);
                        expect(invocation.command.args).toContain(`vx-${nonce}-v2`);
                        expect(invocation.command.args).not.toContain(`vx-${nonce}-v1`);
                        expect(invocation.command.args).toContain(fixture.input.secretsFile);
                        return okText("deployed Worker");
                    case "worker-version-evidence":
                        expect(invocation.command.args.slice(-2)).toEqual(["--profile", "oauth-proof"]);
                        versionPolls++;
                        return versionPolls < 3
                            ? okJson([
                                  {
                                      id: initialVersionId,
                                      number: 1,
                                      name: ledger.worker,
                                      annotations: { "workers/tag": `vx-${nonce}-v1` },
                                  },
                              ])
                            : okJson([
                                  {
                                      id: initialVersionId,
                                      number: 1,
                                      name: ledger.worker,
                                      annotations: { "workers/tag": `vx-${nonce}-v1` },
                                  },
                                  {
                                      id: "version-0002",
                                      number: 2,
                                      name: ledger.worker,
                                      annotations: { "workers/tag": `vx-${nonce}-v2` },
                                  },
                              ]);
                    case "worker-deployment-evidence":
                        expect(invocation.command.args.slice(-2)).toEqual(["--profile", "oauth-proof"]);
                        deploymentPolls++;
                        return deploymentPolls === 1
                            ? okJson({
                                  id: "deployment-0001",
                                  versions: [{ version_id: initialVersionId, percentage: 100 }],
                              })
                            : okJson({
                                  id: "deployment-0002",
                                  versions: [{ version_id: "version-0002", percentage: 100 }],
                              });
                    default:
                        throw new Error(`unexpected redeploy phase ${invocation.command.phase}`);
                }
            },
        });
        expect(phases).toEqual([
            "profile-auth-preflight",
            "profile-account-preflight",
            "worker-version-evidence",
            "worker-redeploy",
            "worker-version-evidence",
            "worker-version-evidence",
            "worker-deployment-evidence",
            "worker-deployment-evidence",
        ]);
        expect(versionPolls).toBe(3);
        expect(deploymentPolls).toBe(2);
        expect(result).toEqual({
            deployment: {
                deploymentId: "deployment-0002",
                versionId: "version-0002",
                number: 2,
                percentage: 100,
            },
            accountVerification: {
                method: "profile-oauth-token-whoami",
                profile: "oauth-proof",
                accountIdSha256: hash(accountId),
                matched: true,
            },
            reconciliation: {
                initialVersionId,
                redeployVersionId: "version-0002",
                redeployTag: `vx-${nonce}-v2`,
                deployExitCode: 0,
                acceptedAfterNonzeroExit: false,
            },
        });
        expect("durableObjectEvictionClaimed" in result).toBe(false);
        expect(await readFile(fixture.ledgerPath, "utf8")).toBe(before);
    });

    test("reconciles one accepted redeploy after Wrangler exits nonzero without replaying it", async () => {
        const fixture = await executionFixture();
        const ledger = {
            ...ownedLedger(),
            candidateSha256: fixture.input.candidateSha256,
            ...deriveDisposableVectorizeResourceNames(fixture.input.candidateSha256, nonce),
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const initialVersionId = "version-0001";
        let redeployCalls = 0;
        let versionReads = 0;
        const result = await executeCloudflareVectorizeRedeploy(
            { ...fixture.input, initialVersionId },
            {
                run: invocation => {
                    if (invocation.command.phase === "worker-version-evidence") {
                        versionReads++;
                        return okJson(
                            versionReads === 1
                                ? [
                                      {
                                          id: initialVersionId,
                                          number: 1,
                                          name: ledger.worker,
                                          annotations: { "workers/tag": `vx-${nonce}-v1` },
                                      },
                                  ]
                                : [
                                      {
                                          id: initialVersionId,
                                          number: 1,
                                          name: ledger.worker,
                                          annotations: { "workers/tag": `vx-${nonce}-v1` },
                                      },
                                      {
                                          id: "version-0002",
                                          number: 2,
                                          name: ledger.worker,
                                          annotations: { "workers/tag": `vx-${nonce}-v2` },
                                      },
                                  ]
                        );
                    }
                    if (invocation.command.phase === "worker-redeploy") {
                        redeployCalls++;
                        return { exitCode: 1, stdout: "", stderr: "connection lost after request" };
                    }
                    if (invocation.command.phase === "worker-deployment-evidence") {
                        return okJson({
                            id: "deployment-0002",
                            versions: [{ version_id: "version-0002", percentage: 100 }],
                        });
                    }
                    throw new Error(`unexpected reconciliation phase ${invocation.command.phase}`);
                },
            }
        );

        expect(redeployCalls).toBe(1);
        expect(result).toMatchObject({
            deployment: {
                deploymentId: "deployment-0002",
                versionId: "version-0002",
                number: 2,
                percentage: 100,
            },
            reconciliation: {
                initialVersionId,
                redeployVersionId: "version-0002",
                redeployTag: `vx-${nonce}-v2`,
                deployExitCode: 1,
                acceptedAfterNonzeroExit: true,
            },
        });
        expect(JSON.stringify(result)).not.toContain("connection lost after request");
    });

    test("fails closed on missing, duplicate, unrelated, or stale redeploy reconciliation", async () => {
        const initialVersionId = "version-0001";
        const initial = (worker: string) => ({
            id: initialVersionId,
            number: 1,
            name: worker,
            annotations: { "workers/tag": `vx-${nonce}-v1` },
        });
        const cases = [
            {
                label: "missing v2",
                postVersions: (worker: string) => [initial(worker)],
                deployment: { id: "deployment-0001", versions: [{ version_id: initialVersionId, percentage: 100 }] },
            },
            {
                label: "duplicate v2",
                postVersions: (worker: string) => [
                    initial(worker),
                    {
                        id: "version-0002",
                        number: 2,
                        name: worker,
                        annotations: { "workers/tag": `vx-${nonce}-v2` },
                    },
                    {
                        id: "version-0003",
                        number: 3,
                        name: worker,
                        annotations: { "workers/tag": `vx-${nonce}-v2` },
                    },
                ],
                deployment: { id: "deployment-0003", versions: [{ version_id: "version-0003", percentage: 100 }] },
            },
            {
                label: "unrelated newer",
                postVersions: (worker: string) => [
                    initial(worker),
                    {
                        id: "version-0002",
                        number: 2,
                        name: worker,
                        annotations: undefined,
                    },
                ],
                deployment: { id: "deployment-0002", versions: [{ version_id: "version-0002", percentage: 100 }] },
            },
            {
                label: "mixed deployment",
                postVersions: (worker: string) => [
                    initial(worker),
                    {
                        id: "version-0002",
                        number: 2,
                        name: worker,
                        annotations: { "workers/tag": `vx-${nonce}-v2` },
                    },
                ],
                deployment: {
                    id: "deployment-mixed",
                    versions: [
                        { version_id: initialVersionId, percentage: 50 },
                        { version_id: "version-0002", percentage: 50 },
                    ],
                },
            },
        ];

        for (const item of cases) {
            const fixture = await executionFixture();
            const ledger = {
                ...ownedLedger(),
                candidateSha256: fixture.input.candidateSha256,
                ...deriveDisposableVectorizeResourceNames(fixture.input.candidateSha256, nonce),
            };
            await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
            let clock = 0;
            let redeployCalls = 0;
            let versionReads = 0;
            let deploymentReads = 0;
            const error = await executeCloudflareVectorizeRedeploy(
                { ...fixture.input, initialVersionId, pollTimeoutMs: 2, pollIntervalMs: 1 },
                {
                    now: () => clock,
                    sleep: async milliseconds => {
                        clock += milliseconds;
                    },
                    run: invocation => {
                        if (invocation.command.phase === "worker-version-evidence") {
                            versionReads++;
                            return okJson(
                                versionReads === 1 ? [initial(ledger.worker)] : item.postVersions(ledger.worker)
                            );
                        }
                        if (invocation.command.phase === "worker-redeploy") {
                            redeployCalls++;
                            return { exitCode: 1, stdout: "", stderr: `private ${item.label}` };
                        }
                        if (invocation.command.phase === "worker-deployment-evidence") {
                            deploymentReads++;
                            return okJson(item.deployment);
                        }
                        throw new Error(`unexpected reconciliation phase ${invocation.command.phase}`);
                    },
                }
            ).catch(cause => cause);

            expect(String(error)).toContain("worker-redeploy failed with exit code 1");
            expect(String(error)).not.toContain(`private ${item.label}`);
            expect(redeployCalls).toBe(1);
            expect(versionReads).toBeGreaterThanOrEqual(2);
            if (item.label === "mixed deployment") expect(deploymentReads).toBeGreaterThan(0);
        }
    });

    test("rejects redeploy baseline tag drift before invoking Wrangler deploy", async () => {
        const fixture = await executionFixture();
        const ledger = {
            ...ownedLedger(),
            candidateSha256: fixture.input.candidateSha256,
            ...deriveDisposableVectorizeResourceNames(fixture.input.candidateSha256, nonce),
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        let redeployCalls = 0;
        await expect(
            executeCloudflareVectorizeRedeploy(
                { ...fixture.input, initialVersionId: "version-0001" },
                {
                    run: invocation => {
                        if (invocation.command.phase === "worker-version-evidence") {
                            return okJson([
                                {
                                    id: "version-0001",
                                    number: 1,
                                    name: ledger.worker,
                                    annotations: { "workers/tag": `vx-${nonce}-v2` },
                                },
                            ]);
                        }
                        if (invocation.command.phase === "worker-redeploy") redeployCalls++;
                        throw new Error("mutation must not run after baseline drift");
                    },
                }
            )
        ).rejects.toThrow("baseline immutable version drifted");
        expect(redeployCalls).toBe(0);
    });

    test("rejects a stored profile whose verified accounts do not include the requested account before mutation", async () => {
        const fixture = await executionFixture();
        const ledger = {
            ...ownedLedger(),
            candidateSha256: fixture.input.candidateSha256,
            ...deriveDisposableVectorizeResourceNames(fixture.input.candidateSha256, nonce),
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const { apiToken: _token, ...executionBase } = fixture.input;
        const phases: string[] = [];
        await expect(
            executeCloudflareVectorizeRedeploy(
                { ...executionBase, profile: "oauth-proof", initialVersionId: "version-0001" },
                {
                    run: invocation => {
                        phases.push(invocation.command.phase);
                        if (invocation.command.phase === "profile-auth-preflight") {
                            return okJson({ type: "oauth", token: "oauth-profile-token-0123456789" });
                        }
                        if (invocation.command.phase === "profile-account-preflight") {
                            expect(invocation.command.args).toEqual(["whoami", "--json"]);
                            return okJson(whoami(["c".repeat(32)]));
                        }
                        throw new Error("mutation must not run after account mismatch");
                    },
                }
            )
        ).rejects.toThrow("does not contain the requested Cloudflare account");
        expect(phases).toEqual(["profile-auth-preflight", "profile-account-preflight"]);
    });

    test("rejects malformed stored-profile auth and account evidence before mutation", async () => {
        const fixture = await executionFixture();
        const ledger = {
            ...ownedLedger(),
            candidateSha256: fixture.input.candidateSha256,
            ...deriveDisposableVectorizeResourceNames(fixture.input.candidateSha256, nonce),
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const { apiToken: _token, ...executionBase } = fixture.input;
        const input = { ...executionBase, profile: "oauth-proof", initialVersionId: "version-0001" };
        await expect(
            executeCloudflareVectorizeRedeploy(input, {
                run: invocation => {
                    expect(invocation.command.phase).toBe("profile-auth-preflight");
                    return okJson({ type: "oauth" });
                },
            })
        ).rejects.toThrow("malformed OAuth credentials");

        const phases: string[] = [];
        await expect(
            executeCloudflareVectorizeRedeploy(input, {
                run: invocation => {
                    phases.push(invocation.command.phase);
                    if (invocation.command.phase === "profile-auth-preflight") {
                        return okJson({ type: "oauth", token: "oauth-profile-token-0123456789" });
                    }
                    if (invocation.command.phase === "profile-account-preflight") {
                        return okJson({ loggedIn: true, accounts: "malformed" });
                    }
                    throw new Error("mutation must not run after malformed account evidence");
                },
            })
        ).rejects.toThrow("malformed account evidence");
        expect(phases).toEqual(["profile-auth-preflight", "profile-account-preflight"]);
    });

    test("rejects immutable version reuse and candidate drift", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const initialVersionId = "version-0001";
        let versionReads = 0;
        await expect(
            executeCloudflareVectorizeRedeploy(
                { ...fixture.input, initialVersionId },
                {
                    run: invocation => {
                        if (invocation.command.phase === "worker-redeploy") return okText("deployed Worker");
                        if (invocation.command.phase === "worker-version-evidence") {
                            versionReads++;
                            return okJson([
                                {
                                    id: initialVersionId,
                                    number: 1,
                                    name: ledger.worker,
                                    annotations: { "workers/tag": `vx-${nonce}-v1` },
                                },
                            ]);
                        }
                        throw new Error("deployment evidence must not run for a reused version");
                    },
                }
            )
        ).rejects.toThrow("Worker redeploy immutable reconciliation failed");
        expect(versionReads).toBeGreaterThan(1);
        let ran = false;
        await expect(
            executeCloudflareVectorizeRedeploy(
                { ...fixture.input, candidateSha256: "f".repeat(64), initialVersionId },
                {
                    run: () => {
                        ran = true;
                        return okText("must not run");
                    },
                }
            )
        ).rejects.toThrow("candidate digest drifted");
        expect(ran).toBe(false);
    });

    test("atomically unions replayed physical IDs and rejects drift or an unowned index", async () => {
        const fixture = await executionFixture();
        const candidateSha256 = fixture.input.candidateSha256;
        const ledger = {
            ...ownedLedger(),
            candidateSha256,
            ...deriveDisposableVectorizeResourceNames(candidateSha256, nonce),
            knownPhysicalIds: [],
        };
        await writeFile(fixture.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        const first = physical("first");
        const second = physical("second");
        await Promise.all([
            appendVectorizeOwnedPhysicalIds(fixture.ledgerPath, candidateSha256, [first]),
            appendVectorizeOwnedPhysicalIds(fixture.ledgerPath, candidateSha256, [second]),
        ]);
        const replay = await appendVectorizeOwnedPhysicalIds(fixture.ledgerPath, candidateSha256, [first, second]);
        expect(replay.knownPhysicalIds).toEqual([first, second]);
        expect(JSON.parse(await readFile(fixture.ledgerPath, "utf8")).knownPhysicalIds).toEqual([first, second]);
        expect((await stat(fixture.ledgerPath)).mode & 0o777).toBe(0o600);
        await expect(
            appendVectorizeOwnedPhysicalIds(fixture.ledgerPath, candidateSha256, ["p1_unknown_1"])
        ).rejects.toThrow("physical-id ledger is invalid");
        await expect(appendVectorizeOwnedPhysicalIds(fixture.ledgerPath, "f".repeat(64), [first])).rejects.toThrow(
            "candidate digest drifted"
        );
        await writeFile(
            fixture.ledgerPath,
            `${JSON.stringify({
                ...replay,
                indexCreated: false,
                metadataIndexCreated: false,
                indexDeleted: false,
            })}\n`,
            { mode: 0o600 }
        );
        await expect(appendVectorizeOwnedPhysicalIds(fixture.ledgerPath, candidateSha256, [first])).rejects.toThrow(
            "live owned index"
        );
        await writeFile(fixture.ledgerPath, `${JSON.stringify({ ...replay, indexDeleted: true })}\n`, { mode: 0o600 });
        await expect(appendVectorizeOwnedPhysicalIds(fixture.ledgerPath, candidateSha256, [first])).rejects.toThrow(
            "live owned index"
        );
    });
});
