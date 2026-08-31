export declare const PACKED_ORG_USER_REPORT_SCHEMA: "chardb.packed-org-user.report.v1";
export declare const PACKED_ORG_USER_CHECKS: readonly string[];

export declare function parsePackedOrgUserArgs(argv: readonly string[]): {
    readonly tarball: string;
    readonly reportPath: string | undefined;
};

export interface PackedOrgUserFingerprint {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export interface PackedOrgUserReport {
    readonly schema: typeof PACKED_ORG_USER_REPORT_SCHEMA;
    readonly suite: "packed-org-user-consumer";
    readonly package: {
        readonly name: "@chardb/core";
        readonly version: string;
        readonly tarball: PackedOrgUserFingerprint;
    };
    readonly checks: Readonly<Record<string, true>>;
}

export declare function buildPackedOrgUserReport(input: {
    readonly package: {
        readonly name: "@chardb/core";
        readonly version: string;
        readonly tarball: PackedOrgUserFingerprint;
    };
    readonly checks: Readonly<Record<string, true>>;
}): PackedOrgUserReport;

export declare function assertMatchingPackedOrgUserReport<T extends object>(
    report: T,
    fingerprint: PackedOrgUserFingerprint
): T;
