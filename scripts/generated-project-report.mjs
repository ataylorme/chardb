import { isDeepStrictEqual } from "node:util";

export const GENERATED_PROJECT_REPORT_SCHEMA = "chardb.generated-project.report.v1";

export const GENERATED_PROJECT_INVARIANTS = Object.freeze([
    "generatedByPackedCli",
    "exactReactPackageInstalled",
    "initialMigrationGeneratedByPackedCli",
    "versionTwoMigrationGeneratedByPackedCli",
    "versionThreeMigrationGeneratedByPackedCli",
    "versionFourMigrationGeneratedByPackedCli",
    "wranglerTomlDefault",
    "immutableVersionOneSnapshot",
    "immutableVersionOneJsonSnapshot",
    "versionTwoDigestChainValidated",
    "versionTwoAdditiveSqlGenerated",
    "fullMigrationDigestChainValidated",
    "immutablePriorMigrationHistoryPreserved",
    "exactDependenciesPinned",
    "typecheckPassed",
    "cloudflareVitestPassed",
    "generatedBrowserBuilt",
    "browserServerCodeErased",
    "generatedDevStarted",
    "generatedDevAuthenticatedWebSocket",
    "wranglerDryRunPassed",
    "doctorPassed",
    "versionTwoTypecheckPassed",
    "versionTwoWranglerDryRunPassed",
    "versionFourTypecheckPassed",
    "versionFourWranglerDryRunPassed",
    "initialMigrationInterruptedAfterShardActivation",
    "initialTrafficClosedBeforeRestart",
    "initialWranglerRestartObserved",
    "initialTrafficClosedAfterRestart",
    "sameInitialMigrationIdResumed",
    "authenticationCompleted",
    "nativeBetterAuthOrganizationProvisioning",
    "preUpgradeMutationAndReadCompleted",
    "preUpgradeLiveReplacementObserved",
    "v2WorkerFencedBeforeMigration",
    "upgradeInterruptedAfterShardActivation",
    "authenticatedReadClosedDuringUpgrade",
    "authenticatedMutationClosedDuringUpgrade",
    "upgradeWranglerRestartObserved",
    "authenticatedTrafficClosedAfterUpgradeRestart",
    "sameUpgradeMigrationIdResumed",
    "preUpgradeRowsPreserved",
    "postUpgradeMutationAndLiveReplacementObserved",
    "persistedReadAfterUpgradeRestart",
]);

export function parseGeneratedProjectArgs(argv) {
    let tarball;
    let reactTarball;
    let reportPath;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--report") {
            const value = argv[++index];
            if (!value) throw new Error("--report requires a path");
            if (reportPath !== undefined) throw new Error("--report may be provided only once");
            reportPath = value;
            continue;
        }
        if (argument === "--react") {
            const value = argv[++index];
            if (!value) throw new Error("--react requires a path");
            if (reactTarball !== undefined) throw new Error("--react may be provided only once");
            reactTarball = value;
            continue;
        }
        if (argument.startsWith("-")) {
            throw new Error(`unknown generated-project smoke argument ${JSON.stringify(argument)}`);
        }
        if (tarball !== undefined) throw new Error("generated-project smoke accepts one tarball");
        tarball = argument;
    }
    if (tarball === undefined || reactTarball === undefined) {
        throw new Error(
            "usage: bun scripts/smoke-generated-project.mjs <core.tgz> --react <react.tgz> [--report <path>]"
        );
    }
    return { tarball, reactTarball, reportPath };
}

function assertInvariants(invariants) {
    if (invariants === null || typeof invariants !== "object" || Array.isArray(invariants)) {
        throw new Error("generated-project evidence invariants must be an object");
    }
    const actual = Object.keys(invariants).sort();
    const expected = [...GENERATED_PROJECT_INVARIANTS].sort();
    if (!isDeepStrictEqual(actual, expected) || expected.some(name => invariants[name] !== true)) {
        throw new Error("generated-project evidence is missing a required invariant");
    }
}

function assertMigration(migration, expected) {
    if (
        migration === null ||
        typeof migration !== "object" ||
        Array.isArray(migration) ||
        typeof migration.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(migration.id) ||
        migration.targetVersion !== expected.targetVersion ||
        (expected.fromVersion !== undefined && migration.fromVersion !== expected.fromVersion) ||
        !isDeepStrictEqual(migration.activatedShards, ["ShardDO_0"])
    ) {
        throw new Error(`generated-project evidence has an invalid interrupted ${expected.label} migration`);
    }
}

function assertMigrations(migrations) {
    if (migrations === null || typeof migrations !== "object" || Array.isArray(migrations)) {
        throw new Error("generated-project evidence migrations must be an object");
    }
    if (!isDeepStrictEqual(Object.keys(migrations).sort(), ["initial", "upgrade"])) {
        throw new Error("generated-project evidence must contain initial and upgrade migrations");
    }
    assertMigration(migrations.initial, { label: "initial", targetVersion: 1 });
    assertMigration(migrations.upgrade, { label: "upgrade", fromVersion: 1, targetVersion: 2 });
}

export function buildGeneratedProjectReport(input) {
    assertMigrations(input.migrations);
    assertInvariants(input.invariants);
    return {
        schema: GENERATED_PROJECT_REPORT_SCHEMA,
        suite: "generated-organization-wrangler",
        run: { ...input.run },
        package: {
            name: input.packageEvidence.name,
            version: input.packageEvidence.version,
            tarball: { ...input.packageEvidence.tarball },
        },
        reactPackage: {
            name: input.reactPackageEvidence.name,
            version: input.reactPackageEvidence.version,
            tarball: { ...input.reactPackageEvidence.tarball },
        },
        platform: { ...input.platform },
        runtime: { ...input.runtime },
        migrations: {
            initial: {
                ...input.migrations.initial,
                activatedShards: [...input.migrations.initial.activatedShards],
            },
            upgrade: {
                ...input.migrations.upgrade,
                activatedShards: [...input.migrations.upgrade.activatedShards],
            },
        },
        invariants: { ...input.invariants },
    };
}

export function assertMatchingGeneratedProjectReport(report, fingerprint, reactFingerprint) {
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
        throw new Error("generated-project evidence must be an object");
    }
    if (report.schema !== GENERATED_PROJECT_REPORT_SCHEMA || report.suite !== "generated-organization-wrangler") {
        throw new Error(`generated-project evidence schema must be ${GENERATED_PROJECT_REPORT_SCHEMA}`);
    }
    if (!isDeepStrictEqual(report.package?.tarball, fingerprint)) {
        throw new Error("generated-project evidence does not identify the preview tarball");
    }
    const react = report.reactPackage;
    if (
        react?.name !== "@chardb/react" ||
        typeof react.version !== "string" ||
        react.tarball?.algorithm !== "sha256" ||
        typeof react.tarball.digest !== "string" ||
        !Number.isSafeInteger(react.tarball.bytes) ||
        react.tarball.bytes <= 0 ||
        (reactFingerprint !== undefined && !isDeepStrictEqual(react.tarball, reactFingerprint))
    ) {
        throw new Error("generated-project evidence does not identify the preview React tarball");
    }
    assertMigrations(report.migrations);
    assertInvariants(report.invariants);
    return report;
}
