export declare const CI_CANDIDATE_SCHEMA: "chardb.ci-candidate.v2";
export declare const CI_CANDIDATE_TARBALL: "core.tgz";
export declare const CI_CANDIDATE_REACT_TARBALL: "react.tgz";
export declare const CI_CANDIDATE_MANIFEST: "candidate.json";

export interface CiCandidateArtifact {
    readonly root: string;
    readonly coreTarball: string;
    readonly reactTarball: string;
    readonly packages: {
        readonly core: {
            readonly name: "@chardb/core";
            readonly file: string;
            readonly candidate: CandidateFingerprint;
        };
        readonly react: {
            readonly name: "@chardb/react";
            readonly file: string;
            readonly candidate: CandidateFingerprint;
        };
    };
}
export interface CandidateFingerprint {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export declare function stageCiCandidate(
    coreTarball: string,
    reactTarball: string,
    directory: string
): Promise<CiCandidateArtifact>;
export declare function validateCiCandidate(directory: string): Promise<CiCandidateArtifact>;
