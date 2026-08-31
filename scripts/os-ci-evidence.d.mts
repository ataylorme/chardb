export declare const OS_CI_WINDOWS_REPORT_SCHEMA: "chardb.os-ci-windows.report.v1";
export declare const OS_CI_REPEAT_REPORT_SCHEMA: "chardb.os-ci-repeat.report.v1";
export declare const OS_CI_REPEAT_MINIMUM_ATTEMPTS: 3;
export declare const OS_CI_CHECKSUM_FILE: "SHA256SUMS";
export declare const OS_CI_REPORT_FILES: readonly [
    "generated-linux-report.json",
    "generated-macos-report.json",
    "generated-windows-report.json",
];
export declare const OS_CI_PLATFORM_TUPLES: Readonly<{
    linux: Readonly<{ name: "ubuntu-latest"; operatingSystem: "linux"; architecture: "x64" }>;
    macos: Readonly<{ name: "macos-latest"; operatingSystem: "darwin"; architecture: "arm64" }>;
    windows: Readonly<{ name: "windows-latest"; operatingSystem: "win32"; architecture: "x64" }>;
}>;
export declare const OS_CI_WINDOWS_CHECKS: readonly [
    "packedCandidateInstalled",
    "generatedTypecheckPassed",
    "cloudflareVitestPassed",
    "generatedBuildPassed",
    "wranglerDoctorPassed",
    "workerPortCollisionCleanup",
    "webPortCollisionCleanup",
    "descendantCleanup",
    "portReuse",
    "betterAuthPersistence",
    "organizationDataPersistence",
];

export interface OsCiCandidate {
    readonly name: "@chardb/core";
    readonly version: string;
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export declare function githubActionsRunFromEnvironment(environment?: NodeJS.ProcessEnv):
    | {
          readonly provider: "github-actions";
          readonly repository: string;
          readonly workflow: string;
          readonly runId: string;
          readonly runAttempt: number;
          readonly gitSha: string;
          readonly job: string;
      }
    | undefined;

export declare function buildWindowsOsCiReport(input: Readonly<Record<string, unknown>>): Record<string, unknown>;
export declare function writeOsCiChecksumManifest(directory: string): Promise<string>;
export declare function validateOsCiEvidence(
    directory: string,
    expectedCandidate?: OsCiCandidate
): Promise<Readonly<Record<string, unknown>>>;
export declare function validateOsCiRepeatEvidence(
    directory: string,
    expectedCandidate?: OsCiCandidate
): Promise<Readonly<Record<string, unknown>>>;
export declare function writeOsCiRepeatReport(
    directory: string,
    output: string,
    expectedCandidate?: OsCiCandidate
): Promise<Readonly<Record<string, unknown>>>;
