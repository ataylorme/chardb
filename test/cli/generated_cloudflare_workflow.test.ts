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
    const input = { workerName: "native-app", filesBucket: "native-app-files", packageName: "@chardb/core" } as const;

    test("setup creates only the configured bucket and distinguishes absence from probe failure", async () => {
        const source = renderCloudflareSetupScript(input);
        const generated = await importGenerated<{
            isMissingBucket(result: { exitCode: number; stdout: string; stderr: string }): boolean;
            isMissingLifecycleRule(result: { exitCode: number; stdout: string; stderr: string }): boolean;
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
            generated.isMissingBucket({
                exitCode: 1,
                stdout: "",
                stderr: "Authentication error",
            })
        ).toBe(false);
        expect(
            generated.isMissingLifecycleRule({
                exitCode: 1,
                stdout: "",
                stderr: "Lifecycle rule with ID 'chardb-recovery-retention' not found in configuration for 'native-app-files'.",
            })
        ).toBe(true);
        expect(generated.isMissingLifecycleRule({ exitCode: 1, stdout: "", stderr: "Authentication error" })).toBe(
            false
        );
        expect(source).toContain(
            '"lifecycle", "add", filesBucket, recoveryLifecycleRule, recoveryPrefix,\n    "--expire-days", recoveryDays, "--force"'
        );
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

    test("deployment requires an explicit HTTPS origin and content-addresses migrations", async () => {
        const source = renderCloudflareDeployScript(input);
        const generated = await importGenerated<{
            validateChardbUrl(raw: string): string;
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
                health: { version: number; digest: string } | null;
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
                health: { version: 2, digest },
                state: pending,
                expected,
            })
        ).toBe("resume");
        expect(() =>
            generated.deploymentDecision({
                bootstrap: false,
                exists: true,
                health: { version: 2, digest },
                state: { ...pending, migrationId: "someone-else" },
                expected,
            })
        ).toThrow("different ID, version, or digest");
        expect(
            generated.deploymentDecision({
                bootstrap: false,
                exists: true,
                health: { version: 1, digest: oldDigest },
                state: { status: "active", activeVersion: 1, activeDigest: oldDigest },
                expected,
            })
        ).toBe("routine-upload");
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
