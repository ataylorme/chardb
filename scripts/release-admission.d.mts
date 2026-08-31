export declare const RELEASE_ADMISSION_SCHEMA: "chardb.release-admission.v1";
export declare const RELEASE_ADMISSION_PROFILE: "preview-v1";
export declare const RELEASE_EVIDENCE_KINDS: readonly [
    "preview",
    "cloudflare-files",
    "cloudflare-file-reshard",
    "cloudflare-vectors",
    "os-ci",
];
export declare const RELEASE_OPTIONAL_EVIDENCE_KINDS: readonly [];

export declare function releaseAdmissionUsage(): string;

export interface ReleaseAdmissionInput {
    readonly profile: typeof RELEASE_ADMISSION_PROFILE;
    readonly evidence: Readonly<Record<(typeof RELEASE_EVIDENCE_KINDS)[number], string>> &
        Readonly<Partial<Record<(typeof RELEASE_OPTIONAL_EVIDENCE_KINDS)[number], string>>>;
    readonly output?: string;
}

export interface ReleaseAdmissionResult {
    readonly schema: typeof RELEASE_ADMISSION_SCHEMA;
    readonly profile: typeof RELEASE_ADMISSION_PROFILE;
    readonly ok: true;
    readonly candidate: {
        readonly name: "@chardb/core";
        readonly version: string;
        readonly algorithm: "sha256";
        readonly digest: string;
        readonly bytes: number;
    };
    readonly evidence: readonly {
        readonly kind: (typeof RELEASE_EVIDENCE_KINDS)[number] | (typeof RELEASE_OPTIONAL_EVIDENCE_KINDS)[number];
        readonly directory: string;
        readonly report: { readonly path: string; readonly sha256: string };
        readonly checksums: readonly { readonly path: string; readonly sha256: string }[];
    }[];
}

export declare function admitReleaseEvidence(input: ReleaseAdmissionInput): Promise<ReleaseAdmissionResult>;

export declare function parseReleaseAdmissionArgs(
    argv: readonly string[],
    cwd?: string
): ReleaseAdmissionInput & { readonly output?: string };

export declare function runReleaseAdmissionCli(
    argv: readonly string[],
    io?: {
        readonly stdout: { write(value: string): unknown };
        readonly stderr: { write(value: string): unknown };
    },
    cwd?: string
): Promise<0 | 1>;
