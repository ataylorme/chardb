import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    assertRecoveryAccount,
    parseCloudflareFileProofRecoveryArgs,
    parseRecoverySecrets,
    recoverCloudflareFileProof,
} from "../scripts/recover-cloudflare-file-proof.mjs";
import { deriveDisposableResourceNames } from "../scripts/run-cloudflare-file-proof.mjs";

const accountId = "a".repeat(32);
const candidate = new TextEncoder().encode("exact standalone R2 recovery candidate");
const candidateSha256 = new Bun.CryptoHasher("sha256").update(candidate).digest("hex");
const nonce = "0123456789abcdef";
const runId = "proof_run_0123456789abcdef";
const temporaryDirectories: string[] = [];

async function recoveryFixture(overrides: Record<string, unknown> = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "chardb-r2-recovery-"));
    temporaryDirectories.push(root);
    const privateDir = path.join(root, "private");
    const app = path.join(privateDir, "app");
    await mkdir(app, { recursive: true, mode: 0o700 });
    await chmod(privateDir, 0o700);
    const tarball = path.join(root, "candidate.tgz");
    await writeFile(tarball, candidate);
    await writeFile(path.join(app, "chardb-proof.tgz"), candidate);
    const names = deriveDisposableResourceNames(candidateSha256, nonce);
    const ledger = {
        schema: "chardb.cloudflare-r2-proof.ownership.v3",
        candidateSha256,
        accountIdSha256: new Bun.CryptoHasher("sha256").update(accountId).digest("hex"),
        nonce,
        runId,
        ...names,
        workerAbsentConfirmed: true,
        bucketAbsentConfirmed: true,
        workerCreateIntent: true,
        workerCreated: true,
        bucketCreateIntent: true,
        bucketCreated: true,
        knownKeys: [],
        ...overrides,
    };
    const ledgerPath = path.join(privateDir, "ownership.json");
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await chmod(ledgerPath, 0o600);
    const secretsPath = path.join(privateDir, "secrets.env");
    await writeFile(
        secretsPath,
        `BETTER_AUTH_SECRET=${"b".repeat(32)}\nCDB_ADMIN_TOKEN=${"c".repeat(32)}\nCDB_PROOF_RUN_ID=${runId}\n`,
        { mode: 0o600 }
    );
    await chmod(secretsPath, 0o600);
    return {
        root,
        app,
        tarball,
        ledgerPath,
        names,
        input: {
            tarball,
            ledger: ledgerPath,
            workersDevSubdomain: "example",
            accountId,
            cloudflareApiTokenFile: undefined,
            confirmed: true,
        },
    };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
}

describe("standalone Cloudflare R2 proof recovery", () => {
    test("requires exact cleanup authority, account identity, and retained run secrets", () => {
        expect(
            parseCloudflareFileProofRecoveryArgs([
                "--tarball",
                "/candidate.tgz",
                "--ledger",
                "/private/ownership.json",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                accountId,
                "--confirm-disposable-resources",
            ])
        ).toEqual({
            help: false,
            tarball: "/candidate.tgz",
            ledger: "/private/ownership.json",
            workersDevSubdomain: "zpg6",
            accountId,
            cloudflareApiTokenFile: undefined,
            confirmed: true,
        });
        expect(() =>
            parseCloudflareFileProofRecoveryArgs([
                "--tarball",
                "/candidate.tgz",
                "--ledger",
                "/private/ownership.json",
                "--workers-dev-subdomain",
                "zpg6",
                "--account-id",
                accountId,
            ])
        ).toThrow("--confirm-disposable-resources");
        expect(assertRecoveryAccount({ loggedIn: true, accounts: [{ id: accountId }] }, accountId)).toEqual({
            accountIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            matched: true,
        });
        expect(() => assertRecoveryAccount({ loggedIn: true, accounts: [{ id: "d".repeat(32) }] }, accountId)).toThrow(
            "do not own"
        );
        expect(
            parseRecoverySecrets(
                `BETTER_AUTH_SECRET=${"b".repeat(32)}\nCDB_ADMIN_TOKEN=${"c".repeat(32)}\nCDB_PROOF_RUN_ID=${runId}\n`,
                runId
            )
        ).toMatchObject({ adminToken: "c".repeat(32), runId });
        expect(() =>
            parseRecoverySecrets(
                `BETTER_AUTH_SECRET=${"b".repeat(32)}\nCDB_ADMIN_TOKEN=${"c".repeat(32)}\nCDB_PROOF_RUN_ID=other_run_0123456789\n`,
                runId
            )
        ).toThrow("run ID drifted");
    });

    test("authoritatively discovers and purges uploads missing from the object-key ledger", async () => {
        const fixture = await recoveryFixture({ knownKeys: [] });
        let workerPresent = true;
        let bucketPresent = true;
        let objects = 2;
        const commands: string[][] = [];
        const requests: string[] = [];
        const result = await recoverCloudflareFileProof(fixture.input, {
            runWrangler: async (args: string[]) => {
                commands.push(args);
                if (args[0] === "whoami") {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: accountId }] }),
                        stderr: "",
                    };
                }
                if (args[0] === "versions") {
                    return workerPresent
                        ? { exitCode: 0, stdout: JSON.stringify([{ id: "worker-version" }]), stderr: "" }
                        : { exitCode: 1, stdout: "", stderr: "Worker does not exist [code: 10090]" };
                }
                if (args[0] === "delete") {
                    workerPresent = false;
                    return { exitCode: 0, stdout: "deleted", stderr: "" };
                }
                if (args.slice(0, 3).join(" ") === "r2 bucket list") {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify(bucketPresent ? [{ name: fixture.names.bucket }] : []),
                        stderr: "",
                    };
                }
                if (args.slice(0, 3).join(" ") === "r2 bucket delete") {
                    expect(objects).toBe(0);
                    bucketPresent = false;
                    return { exitCode: 0, stdout: "deleted", stderr: "" };
                }
                throw new Error(`unexpected command ${args.join(" ")}`);
            },
            fetch: async input => {
                const url = new URL(String(input));
                requests.push(url.pathname);
                if (url.pathname === "/health") {
                    return json({ ok: true, releaseSha256: candidateSha256, proofConfigured: true });
                }
                if (url.pathname === "/proof/r2-state") {
                    return json({ count: objects, bytes: objects * 10, digest: "d".repeat(64) });
                }
                if (url.pathname === "/proof/r2-purge") {
                    const deleted = objects;
                    objects = 0;
                    return json({ deleted });
                }
                return json({ error: "not found" }, 404);
            },
            sleep: async () => undefined,
        });

        expect(result).toMatchObject({
            ok: true,
            candidate: { digest: candidateSha256, bytes: candidate.byteLength },
            reconciliation: { workerRecovered: false, discoveredObjects: 2, purgedObjects: 2 },
            absence: { worker: true, bucket: true },
        });
        expect(requests).toEqual(["/health", "/proof/r2-state", "/proof/r2-purge", "/proof/r2-state"]);
        expect(commands.some(command => command[0] === "r2" && command[1] === "object")).toBeFalse();
    });

    test("recreates the exact candidate-bound Worker when only the bucket survived", async () => {
        const fixture = await recoveryFixture();
        let workerPresent = false;
        let bucketPresent = true;
        let objects = 1;
        const commands: string[][] = [];
        const result = await recoverCloudflareFileProof(fixture.input, {
            runWrangler: async (args: string[]) => {
                commands.push(args);
                if (args[0] === "whoami") {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: accountId }] }),
                        stderr: "",
                    };
                }
                if (args[0] === "versions") {
                    return workerPresent
                        ? { exitCode: 0, stdout: JSON.stringify([{ id: "recovered-version" }]), stderr: "" }
                        : { exitCode: 1, stdout: "", stderr: "Worker does not exist [code: 10090]" };
                }
                if (args[0] === "deploy") {
                    expect(args).toContain(fixture.names.worker);
                    workerPresent = true;
                    return { exitCode: 0, stdout: "deployed", stderr: "" };
                }
                if (args[0] === "delete") {
                    workerPresent = false;
                    return { exitCode: 0, stdout: "deleted", stderr: "" };
                }
                if (args.slice(0, 3).join(" ") === "r2 bucket list") {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify(bucketPresent ? [{ name: fixture.names.bucket }] : []),
                        stderr: "",
                    };
                }
                if (args.slice(0, 3).join(" ") === "r2 bucket delete") {
                    expect(objects).toBe(0);
                    bucketPresent = false;
                    return { exitCode: 0, stdout: "deleted", stderr: "" };
                }
                throw new Error(`unexpected command ${args.join(" ")}`);
            },
            fetch: async input => {
                const pathname = new URL(String(input)).pathname;
                if (pathname === "/health") {
                    return json({ ok: true, releaseSha256: candidateSha256, proofConfigured: true });
                }
                if (pathname === "/proof/r2-state") {
                    return json({ count: objects, bytes: objects, digest: "e".repeat(64) });
                }
                if (pathname === "/proof/r2-purge") {
                    const deleted = objects;
                    objects = 0;
                    return json({ deleted });
                }
                return json({ error: "not found" }, 404);
            },
            sleep: async () => undefined,
        });

        expect(result.reconciliation).toEqual({ workerRecovered: true, discoveredObjects: 1, purgedObjects: 1 });
        expect(commands.filter(command => command[0] === "deploy")).toHaveLength(1);
        expect(commands.filter(command => command[0] === "delete")).toHaveLength(1);
    });

    test("is replay-safe after both owned resources are already absent", async () => {
        const fixture = await recoveryFixture();
        const commands: string[][] = [];
        const result = await recoverCloudflareFileProof(fixture.input, {
            runWrangler: async (args: string[]) => {
                commands.push(args);
                if (args[0] === "whoami") {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: accountId }] }),
                        stderr: "",
                    };
                }
                if (args[0] === "versions") {
                    return { exitCode: 1, stdout: "", stderr: "Worker does not exist [code: 10090]" };
                }
                if (args.slice(0, 3).join(" ") === "r2 bucket list") {
                    return { exitCode: 0, stdout: "[]", stderr: "" };
                }
                throw new Error(`unexpected command ${args.join(" ")}`);
            },
            fetch: async () => {
                throw new Error("an absent recovery must not call the Worker");
            },
        });

        expect(result).toMatchObject({
            ok: true,
            reconciliation: { workerRecovered: false, discoveredObjects: 0, purgedObjects: 0 },
            absence: { worker: true, bucket: true },
        });
        expect(commands.map(command => command[0])).toEqual(["whoami", "r2", "versions"]);
    });

    test("fails before remote mutation on candidate or account drift", async () => {
        const fixture = await recoveryFixture();
        const drifted = path.join(fixture.root, "drifted.tgz");
        await writeFile(drifted, "different candidate");
        let commands = 0;
        await expect(
            recoverCloudflareFileProof(
                { ...fixture.input, tarball: drifted },
                {
                    runWrangler: async () => {
                        commands++;
                        return { exitCode: 0, stdout: "{}", stderr: "" };
                    },
                }
            )
        ).rejects.toThrow("candidate digest drifted");
        expect(commands).toBe(0);

        const accountDrift = await recoveryFixture({
            accountIdSha256: new Bun.CryptoHasher("sha256").update("b".repeat(32)).digest("hex"),
        });
        await expect(
            recoverCloudflareFileProof(accountDrift.input, {
                runWrangler: async () => {
                    commands++;
                    return { exitCode: 0, stdout: "{}", stderr: "" };
                },
            })
        ).rejects.toThrow("account identity drifted");
        expect(commands).toBe(0);

        await expect(
            recoverCloudflareFileProof(fixture.input, {
                runWrangler: async args =>
                    args[0] === "whoami"
                        ? {
                              exitCode: 0,
                              stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "f".repeat(32) }] }),
                              stderr: "",
                          }
                        : { exitCode: 0, stdout: "[]", stderr: "" },
            })
        ).rejects.toThrow("do not own");
    });
});
