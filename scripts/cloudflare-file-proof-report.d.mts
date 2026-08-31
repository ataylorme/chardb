export interface CloudflareFileProofCandidate {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export interface CloudflareFileProofValidation {
    readonly schema: "chardb.cloudflare-r2-proof.validation.v1";
    readonly ok: true;
    readonly candidate: CloudflareFileProofCandidate;
    readonly reportSha256: string;
}

export const CLOUDFLARE_FILE_PROOF_REPORT_SCHEMA: "chardb.cloudflare-r2-proof.report.v1";
export const CLOUDFLARE_FILE_PROOF_VALIDATION_SCHEMA: "chardb.cloudflare-r2-proof.validation.v1";

export function assertCloudflareFileProofReport<T>(report: T, expectedCandidate: CloudflareFileProofCandidate): T;
export function fingerprintCloudflareFileProofCandidate(file: string): Promise<CloudflareFileProofCandidate>;
export function validateCloudflareFileProofEvidence(input: {
    readonly report: string;
    readonly candidate: string;
    readonly checksum?: string;
}): Promise<CloudflareFileProofValidation>;
export function parseCloudflareFileProofReportArgs(argv: readonly string[]): {
    readonly report: string;
    readonly candidate: string;
    readonly checksum: string | undefined;
};
