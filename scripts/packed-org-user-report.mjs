import { isDeepStrictEqual } from "node:util";

export const PACKED_ORG_USER_REPORT_SCHEMA = "chardb.packed-org-user.report.v2";
export const PACKED_ORG_USER_CHECKS = Object.freeze([
    "strictConsumerTypecheck",
    "organizationScopeCompiled",
    "organizationUserScopeCompiled",
    "implicitTenantColumnsOmittedFromInserts",
    "serverDeclarationExported",
    "serverRuntimeExported",
    "clientEntryPointExcludedServerScope",
    "workerdRuntimeExecuted",
    "organizationPeerReadAllowed",
    "organizationUserSelfWriteAllowed",
    "organizationUserPeerReadDenied",
    "organizationAdminReadAllowed",
    "crossOrganizationIsolation",
    "unauthorizedOrganizationWriteDenied",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function object(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function exactKeys(value, label, expected) {
    const actual = Object.keys(object(value, label)).sort();
    if (!isDeepStrictEqual(actual, [...expected].sort())) {
        throw new Error(`${label} fields drifted`);
    }
}

function assertFingerprint(value, label) {
    exactKeys(value, label, ["algorithm", "digest", "bytes"]);
    if (
        value.algorithm !== "sha256" ||
        !SHA256.test(value.digest ?? "") ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes <= 0
    ) {
        throw new Error(`${label} must identify one exact tarball`);
    }
}

function assertChecks(value) {
    object(value, "packed org-user checks");
    const actual = Object.keys(value).sort();
    const expected = [...PACKED_ORG_USER_CHECKS].sort();
    if (!isDeepStrictEqual(actual, expected) || expected.some(name => value[name] !== true)) {
        throw new Error("packed org-user evidence is missing a required check");
    }
}

export function parsePackedOrgUserArgs(argv) {
    let tarball;
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
        if (argument.startsWith("-")) {
            throw new Error(`unknown packed org-user smoke argument ${JSON.stringify(argument)}`);
        }
        if (tarball !== undefined) throw new Error("packed org-user smoke accepts one tarball");
        tarball = argument;
    }
    if (tarball === undefined) {
        throw new Error("usage: bun scripts/smoke-packed-org-user.mjs <package.tgz> [--report <path>]");
    }
    return { tarball, reportPath };
}

export function buildPackedOrgUserReport(input) {
    const report = {
        schema: PACKED_ORG_USER_REPORT_SCHEMA,
        suite: "packed-org-user-consumer",
        package: {
            name: input.package.name,
            version: input.package.version,
            tarball: { ...input.package.tarball },
        },
        checks: { ...input.checks },
    };
    return assertMatchingPackedOrgUserReport(report, input.package.tarball);
}

export function assertMatchingPackedOrgUserReport(report, fingerprint) {
    exactKeys(report, "packed org-user evidence", ["schema", "suite", "package", "checks"]);
    if (report.schema !== PACKED_ORG_USER_REPORT_SCHEMA || report.suite !== "packed-org-user-consumer") {
        throw new Error(`packed org-user evidence schema must be ${PACKED_ORG_USER_REPORT_SCHEMA}`);
    }
    exactKeys(report.package, "packed org-user package", ["name", "version", "tarball"]);
    if (report.package.name !== "@chardb/core") {
        throw new Error("packed org-user evidence package name must be @chardb/core");
    }
    if (
        typeof report.package?.version !== "string" ||
        report.package.version.length > 128 ||
        !VERSION.test(report.package.version)
    ) {
        throw new Error("packed org-user evidence package version is invalid");
    }
    assertFingerprint(report.package.tarball, "packed org-user tarball");
    assertFingerprint(fingerprint, "expected packed org-user tarball");
    if (!isDeepStrictEqual(report.package.tarball, fingerprint)) {
        throw new Error("packed org-user evidence does not identify the expected tarball");
    }
    assertChecks(report.checks);
    if (Buffer.byteLength(JSON.stringify(report), "utf8") > 4_096) {
        throw new Error("packed org-user evidence exceeds 4096 bytes");
    }
    return report;
}
