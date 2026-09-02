import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    renderCloudflareDeployScript,
    renderCloudflareSetupScript,
} from "../../src/cli/generated-cloudflare-workflow.ts";

const temporaryDirectories: string[] = [];

afterAll(async () => {
    await Promise.all(temporaryDirectories.map(path => rm(path, { force: true, recursive: true })));
});

async function importGenerated<T>(source: string, name: string): Promise<T> {
    const directory = await mkdtemp(join(process.cwd(), ".chardb-generated-workflow-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, name);
    await writeFile(path, source, { mode: 0o600 });
    return import(`${pathToFileURL(path).href}?test=${crypto.randomUUID()}`) as Promise<T>;
}

describe("generated Cloudflare workflow", () => {
    const deploymentId = "chardb.app.v1/11111111-1111-4111-8111-111111111111";
    const input = {
        workerName: "native-app",
        filesBucket: "native-app-files",
        packageName: "@chardb/core",
        deploymentId,
    } as const;

    test("setup creates only the configured bucket and distinguishes absence from probe failure", async () => {
        expect(() => renderCloudflareSetupScript({ ...input, deploymentId: "native-app" })).toThrow(
            "chardb.app.v1 UUID"
        );
        const source = renderCloudflareSetupScript(input);
        const generated = await importGenerated<{
            isMissingBucket(result: { exitCode: number; stdout: string; stderr: string }): boolean;
            isMissingObject(result: { exitCode: number; stdout: string; stderr: string }): boolean;
            parseSetupArguments(args: string[]): { adoptExistingBucket: boolean };
            configuredIdentity(raw: string): { workerName: string; filesBucket: string };
            assertGeneratedConfig(raw: string): { workerName: string; filesBucket: string };
        }>(source, "setup-cloudflare.mjs");

        expect(
            generated.isMissingBucket({
                exitCode: 1,
                stdout: "",
                stderr: "The specified bucket does not exist.",
            })
        ).toBe(true);
        expect(
            generated.isMissingObject({
                exitCode: 1,
                stdout: "",
                stderr: "The specified key does not exist.",
            })
        ).toBe(true);
        expect(generated.isMissingObject({ exitCode: 1, stdout: "", stderr: "Authentication error" })).toBe(false);
        expect(generated.parseSetupArguments([])).toEqual({ adoptExistingBucket: false });
        expect(generated.parseSetupArguments(["--adopt-existing-bucket"])).toEqual({ adoptExistingBucket: true });
        expect(() => generated.parseSetupArguments(["--adopt-existing-bucket", "--adopt-existing-bucket"])).toThrow(
            "usage:"
        );
        expect(() => generated.parseSetupArguments(["--force"])).toThrow("usage:");
        expect(
            generated.isMissingBucket({
                exitCode: 1,
                stdout: "",
                stderr: "Authentication error",
            })
        ).toBe(false);
        expect(source).not.toContain("lifecycle");
        expect(source).not.toContain("--expire-days");
        expect(source).not.toContain("_chardb/retained/");
        expect(
            generated.configuredIdentity(`name = "native-app"

[[r2_buckets]]
binding = "CDB_FILES"
bucket_name = "native-app-files"
`)
        ).toEqual({ workerName: input.workerName, filesBucket: input.filesBucket });
        expect(() =>
            generated.assertGeneratedConfig(`name = "native-app"
[[r2_buckets]]
binding = "CDB_FILES"
bucket_name = "stale-files"
`)
        ).toThrow("drifted from the generated deployment contract");
    });

    test("setup owns new buckets, requires explicit adoption, and rolls back failed creation", async () => {
        const generated = await importGenerated<{
            setupFilesBucket(options?: {
                adoptExistingBucket?: boolean;
                run?: (
                    args: string[],
                    options?: { capture?: boolean }
                ) => Promise<{
                    exitCode: number;
                    stdout: string;
                    stderr: string;
                }>;
            }): Promise<void>;
        }>(renderCloudflareSetupScript(input), "setup-execution.mjs");
        const expectedMarker = `${JSON.stringify({
            format: "chardb.r2-ownership.v1",
            deploymentId,
            workerName: input.workerName,
            filesBucket: input.filesBucket,
        })}\n`;

        function scenario(options: { bucketExists: boolean; marker?: string | null; failMarkerPut?: boolean }) {
            let bucketExists = options.bucketExists;
            let marker = options.marker ?? null;
            const operations: string[][] = [];
            const run = async (command: string[]) => {
                const args = command.slice(2);
                operations.push(args);
                if (args[0] === "r2" && args[1] === "bucket" && args[2] === "info") {
                    return bucketExists
                        ? { exitCode: 0, stdout: JSON.stringify({ name: input.filesBucket }), stderr: "" }
                        : { exitCode: 1, stdout: "", stderr: "The specified bucket does not exist." };
                }
                if (args[0] === "r2" && args[1] === "bucket" && args[2] === "create") {
                    bucketExists = true;
                    return { exitCode: 0, stdout: "created", stderr: "" };
                }
                if (args[0] === "r2" && args[1] === "bucket" && args[2] === "delete") {
                    bucketExists = false;
                    return { exitCode: 0, stdout: "deleted", stderr: "" };
                }
                if (args[0] === "r2" && args[1] === "object" && args[2] === "get") {
                    if (marker === null) {
                        return { exitCode: 1, stdout: "", stderr: "The specified key does not exist." };
                    }
                    const fileIndex = args.indexOf("--file");
                    await writeFile(args[fileIndex + 1] ?? "", marker);
                    return { exitCode: 0, stdout: "downloaded", stderr: "" };
                }
                if (args[0] === "r2" && args[1] === "object" && args[2] === "put") {
                    if (options.failMarkerPut) {
                        return { exitCode: 1, stdout: "", stderr: "marker upload failed" };
                    }
                    const fileIndex = args.indexOf("--file");
                    marker = await readFile(args[fileIndex + 1] ?? "", "utf8");
                    return { exitCode: 0, stdout: "uploaded", stderr: "" };
                }
                throw new Error(`unexpected Wrangler command: ${args.join(" ")}`);
            };
            return { run, operations, state: () => ({ bucketExists, marker }) };
        }

        const created = scenario({ bucketExists: false });
        await generated.setupFilesBucket({ run: created.run });
        expect(created.state()).toEqual({ bucketExists: true, marker: expectedMarker });
        expect(created.operations.filter(args => args[2] === "get")).toHaveLength(2);

        const unowned = scenario({ bucketExists: true });
        await expect(generated.setupFilesBucket({ run: unowned.run })).rejects.toThrow("--adopt-existing-bucket");
        expect(unowned.operations.some(args => args[2] === "put")).toBe(false);

        const adopted = scenario({ bucketExists: true });
        await generated.setupFilesBucket({ run: adopted.run, adoptExistingBucket: true });
        expect(adopted.state().marker).toBe(expectedMarker);

        const rerun = scenario({ bucketExists: true, marker: expectedMarker });
        await generated.setupFilesBucket({ run: rerun.run });
        expect(rerun.operations.some(args => args[2] === "put")).toBe(false);

        const mismatched = scenario({ bucketExists: true, marker: '{"owner":"someone-else"}\n' });
        await expect(generated.setupFilesBucket({ run: mismatched.run, adoptExistingBucket: true })).rejects.toThrow(
            "different Chardb ownership marker"
        );
        expect(mismatched.operations.some(args => args[2] === "put")).toBe(false);

        const rollback = scenario({ bucketExists: false, failMarkerPut: true });
        await expect(generated.setupFilesBucket({ run: rollback.run })).rejects.toThrow(
            "could not write the Chardb R2 ownership marker"
        );
        expect(rollback.state()).toEqual({ bucketExists: false, marker: null });
        expect(rollback.operations.at(-1)?.slice(0, 3)).toEqual(["r2", "bucket", "delete"]);
    });

    test("deployment requires an explicit HTTPS origin and content-addresses migrations", async () => {
        const source = renderCloudflareDeployScript(input);
        const generated = await importGenerated<{
            validateChardbUrl(raw: string): string;
            validateHealth(body: unknown): { version: number; digest: string; deploymentId: string };
            migrationIdentity(journal: { version: number; digest: string }): {
                version: number;
                digest: string;
                migrationId: string;
            };
            validateAdminToken(raw: string): string;
        }>(source, "deploy.mjs");
        const digest = "a".repeat(64);

        expect(generated.validateChardbUrl("https://db.example.com/")).toBe("https://db.example.com");
        for (const invalid of [
            "",
            "http://db.example.com",
            "https://user:secret@db.example.com",
            "https://db.example.com/path",
            "https://db.example.com/?environment=prod",
            "https://db.example.com/#prod",
        ]) {
            expect(() => generated.validateChardbUrl(invalid)).toThrow();
        }
        expect(generated.migrationIdentity({ version: 7, digest })).toEqual({
            version: 7,
            digest,
            migrationId: `schema-v7-${digest}`,
        });
        expect(() => generated.migrationIdentity({ version: 7, digest: "not-a-digest" })).toThrow();
        expect(generated.validateAdminToken("t".repeat(32))).toBe("t".repeat(32));
        expect(generated.validateAdminToken("t".repeat(512))).toBe("t".repeat(512));
        expect(() => generated.validateAdminToken("t".repeat(31))).toThrow();
        expect(() => generated.validateAdminToken("t".repeat(513))).toThrow();
        expect(generated.validateHealth({ ok: true, deploymentId, schemaVersion: 7, schemaDigest: digest })).toEqual({
            version: 7,
            digest,
            deploymentId,
        });
        expect(() =>
            generated.validateHealth({
                ok: true,
                deploymentId: "chardb.app.v1/22222222-2222-4222-8222-222222222222",
                schemaVersion: 7,
                schemaDigest: digest,
            })
        ).toThrow("expected Worker");
        expect(source.indexOf("const beforeHealth = exists ? await health(origin) : null;")).toBeLessThan(
            source.indexOf("const beforeState = exists ? await migrationState(origin, adminToken) : null;")
        );
    });

    test("Worker lookup fails closed and bootstrap secrets use a private temporary file", async () => {
        const source = renderCloudflareDeployScript(input);
        const generated = await importGenerated<{
            workerExistsResult(result: { exitCode: number; stdout: string; stderr: string }): boolean;
            createSecretFile(
                secrets: Record<string, unknown>,
                temporaryRoot?: string
            ): Promise<{ directory: string; path: string }>;
        }>(source, "deploy-secrets.mjs");

        expect(generated.workerExistsResult({ exitCode: 0, stdout: '[{"id":"one"}]', stderr: "" })).toBe(true);
        expect(generated.workerExistsResult({ exitCode: 0, stdout: "[]", stderr: "" })).toBe(false);
        expect(
            generated.workerExistsResult({ exitCode: 1, stdout: "", stderr: "Worker not found [code: 10090]" })
        ).toBe(false);
        expect(() =>
            generated.workerExistsResult({ exitCode: 1, stdout: "", stderr: "authentication failed" })
        ).toThrow("could not inspect Worker");

        const secretFile = await generated.createSecretFile({ CDB_ADMIN_TOKEN: "admin", BETTER_AUTH_SECRET: "auth" });
        try {
            expect((await stat(secretFile.path)).mode & 0o777).toBe(0o600);
            expect(JSON.parse(await readFile(secretFile.path, "utf8"))).toEqual({
                CDB_ADMIN_TOKEN: "admin",
                BETTER_AUTH_SECRET: "auth",
            });
            await chmod(secretFile.path, 0o600);
        } finally {
            await rm(secretFile.directory, { force: true, recursive: true });
        }

        const failedRoot = await mkdtemp(join(tmpdir(), "chardb-secret-failure-test-"));
        temporaryDirectories.push(failedRoot);
        await expect(generated.createSecretFile({ cannotSerialize: 1n }, failedRoot)).rejects.toThrow();
        expect(await readdir(failedRoot)).toEqual([]);
    });

    test("routine reruns resume only the exact pending migration", async () => {
        const generated = await importGenerated<{
            deploymentDecision(input: {
                bootstrap: boolean;
                exists: boolean;
                health: { version: number; digest: string; deploymentId: string } | null;
                state: Record<string, unknown> | null;
                expected: { version: number; digest: string; migrationId: string };
            }): string;
        }>(renderCloudflareDeployScript(input), "deploy-decision.mjs");
        const digest = "b".repeat(64);
        const oldDigest = "a".repeat(64);
        const expected = { version: 2, digest, migrationId: `schema-v2-${digest}` };
        const pending = {
            status: "migrating",
            activeVersion: 1,
            activeDigest: oldDigest,
            migrationId: expected.migrationId,
            targetVersion: 2,
            targetDigest: digest,
        };

        expect(
            generated.deploymentDecision({
                bootstrap: false,
                exists: true,
                health: { version: 2, digest, deploymentId },
                state: pending,
                expected,
            })
        ).toBe("resume");
        expect(() =>
            generated.deploymentDecision({
                bootstrap: false,
                exists: true,
                health: { version: 2, digest, deploymentId },
                state: { ...pending, migrationId: "someone-else" },
                expected,
            })
        ).toThrow("different ID, version, or digest");
        expect(
            generated.deploymentDecision({
                bootstrap: false,
                exists: true,
                health: { version: 1, digest: oldDigest, deploymentId },
                state: { status: "active", activeVersion: 1, activeDigest: oldDigest },
                expected,
            })
        ).toBe("routine-upload");
        expect(() =>
            generated.deploymentDecision({
                bootstrap: false,
                exists: true,
                health: {
                    version: 2,
                    digest,
                    deploymentId: "chardb.app.v1/22222222-2222-4222-8222-222222222222",
                },
                state: { status: "active", activeVersion: 2, activeDigest: digest },
                expected,
            })
        ).toThrow("points at a different Worker");
        expect(
            generated.deploymentDecision({
                bootstrap: true,
                exists: false,
                health: null,
                state: null,
                expected,
            })
        ).toBe("bootstrap-upload");
    });
});
