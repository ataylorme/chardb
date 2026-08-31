import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    GENERATED_PROJECT_INVARIANTS,
    assertMatchingGeneratedProjectReport,
    buildGeneratedProjectReport,
    parseGeneratedProjectArgs,
} from "../scripts/generated-project-report.mjs";

const fingerprint = { algorithm: "sha256", digest: "abc123", bytes: 42 };
const reactFingerprint = { algorithm: "sha256", digest: "react123", bytes: 24 };

function reportInput() {
    return {
        run: { id: "run-1" },
        packageEvidence: { name: "@chardb/core", version: "0.1.0", tarball: fingerprint },
        reactPackageEvidence: { name: "@chardb/react", version: "0.1.0", tarball: reactFingerprint },
        platform: { name: "linux-x64" },
        runtime: { bun: "1.2.22", wrangler: "4.125.0" },
        migrations: {
            initial: { id: "generated-initial-schema", targetVersion: 1, activatedShards: ["ShardDO_0"] },
            upgrade: {
                id: "generated-upgrade-v2",
                fromVersion: 1,
                targetVersion: 2,
                activatedShards: ["ShardDO_0"],
            },
        },
        invariants: Object.fromEntries(GENERATED_PROJECT_INVARIANTS.map(name => [name, true])),
    };
}

describe("generated-project evidence", () => {
    test("parses one tarball and an optional report path", () => {
        expect(parseGeneratedProjectArgs(["package.tgz", "--react", "react.tgz"])).toEqual({
            tarball: "package.tgz",
            reactTarball: "react.tgz",
            reportPath: undefined,
        });
        expect(parseGeneratedProjectArgs(["package.tgz", "--react", "react.tgz", "--report", "proof.json"])).toEqual({
            tarball: "package.tgz",
            reactTarball: "react.tgz",
            reportPath: "proof.json",
        });
        expect(() => parseGeneratedProjectArgs([])).toThrow("usage");
        expect(() => parseGeneratedProjectArgs(["a.tgz", "b.tgz", "--react", "react.tgz"])).toThrow("one tarball");
        expect(() => parseGeneratedProjectArgs(["a.tgz", "--unknown"])).toThrow("unknown");
    });

    test("requires the exact invariant set and interrupted shard", () => {
        const report = buildGeneratedProjectReport(reportInput());
        expect(assertMatchingGeneratedProjectReport(report, fingerprint, reactFingerprint)).toEqual(report);
        expect(report.invariants.exactReactPackageInstalled).toBe(true);
        expect(report.invariants.nativeBetterAuthOrganizationProvisioning).toBe(true);
        expect(report.invariants.initialMigrationGeneratedByPackedCli).toBe(true);
        expect(report.invariants.versionTwoMigrationGeneratedByPackedCli).toBe(true);
        expect(report.invariants.versionThreeMigrationGeneratedByPackedCli).toBe(true);
        expect(report.invariants.versionFourMigrationGeneratedByPackedCli).toBe(true);
        expect(report.invariants.immutableVersionOneJsonSnapshot).toBe(true);
        expect(report.invariants.versionTwoDigestChainValidated).toBe(true);
        expect(report.invariants.versionTwoAdditiveSqlGenerated).toBe(true);
        expect(report.invariants.fullMigrationDigestChainValidated).toBe(true);
        expect(report.invariants.immutablePriorMigrationHistoryPreserved).toBe(true);
        expect(report.invariants.cloudflareVitestPassed).toBe(true);

        expect(() =>
            buildGeneratedProjectReport({
                ...reportInput(),
                invariants: { ...reportInput().invariants, authenticatedTrafficClosedAfterUpgradeRestart: false },
            })
        ).toThrow("required invariant");
        expect(() =>
            buildGeneratedProjectReport({
                ...reportInput(),
                migrations: {
                    ...reportInput().migrations,
                    upgrade: { ...reportInput().migrations.upgrade, activatedShards: [] },
                },
            })
        ).toThrow("interrupted upgrade migration");
    });

    test("rejects evidence for a different tarball", () => {
        const report = buildGeneratedProjectReport(reportInput());
        expect(() =>
            assertMatchingGeneratedProjectReport(
                report,
                { ...fingerprint, bytes: fingerprint.bytes + 1 },
                reactFingerprint
            )
        ).toThrow("does not identify");
        expect(() =>
            assertMatchingGeneratedProjectReport(report, fingerprint, { ...reactFingerprint, bytes: 25 })
        ).toThrow("React tarball");
    });

    test("keeps scaffold coverage while managing both generated dev process trees", async () => {
        const source = await readFile(join(import.meta.dir, "..", "scripts", "smoke-generated-project.mjs"), "utf8");

        expect(source).toContain("proveInitBoundaries(");
        expect(source).toContain('"--core-package"');
        expect(source).toContain("`file:${tarballPath}`");
        expect(source).toContain('"--react-package"');
        expect(source).toContain("`file:${reactTarballPath}`");
        expect(source.match(/"doctor", "wrangler"/g)).toHaveLength(3);
        expect(source).toContain("VERSION_THREE_MIGRATION_NAME");
        expect(source).toContain("VERSION_FOUR_MIGRATION_NAME");
        expect(source).toContain('run("npm", ["run", "test"], cwd, extraEnvironment)');

        expect(source).toContain('spawnManagedProcess([process.execPath, "run", "dev"]');
        expect(source).toContain("const [workerPort, webPort, inspectorPort] = await reserveLocalPorts(3);");
        expect(source).toContain('injectGeneratedDevInspectorPort(await readFile(devPath, "utf8"), inspectorPort)');
        expect(source).toContain("const [port, inspectorPort] = await reserveLocalPorts(2);");
        expect(source).toContain('"--inspector-port",\n            String(inspectorPort)');
        expect(source).toContain('label: "Wrangler dev"');
        expect(source).toContain('label: "generated dev output drain"');
        expect(source).toContain('label: "Wrangler startup output drain"');
        expect(source).toContain('label: "Wrangler output drain"');
        expect(source).not.toContain("function processGroupExists");
        expect(source).not.toContain("async function terminate(");
    });
});
