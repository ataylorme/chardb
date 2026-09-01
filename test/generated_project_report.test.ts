import { describe, expect, test } from "bun:test";
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
        expect(report.invariants.bunInstallPassed).toBe(true);
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
});
