export declare const CI_CANDIDATE_SCHEMA: "chardb.ci-candidate.v1";
export declare const CI_CANDIDATE_TARBALL: "candidate.tgz";
export declare const CI_CANDIDATE_MANIFEST: "candidate.json";

export interface CiCandidateArtifact {
    readonly root: string;
    readonly tarball: string;
    readonly candidate: {
        readonly algorithm: "sha256";
        readonly digest: string;
        readonly bytes: number;
    };
}

export declare function stageCiCandidate(tarball: string, directory: string): Promise<CiCandidateArtifact>;
export declare function validateCiCandidate(directory: string): Promise<CiCandidateArtifact>;
