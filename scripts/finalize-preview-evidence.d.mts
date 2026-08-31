export interface PreviewEvidenceFile {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
}

export interface PreviewEvidenceManifest {
    readonly schema: "chardb.preview-evidence-manifest.v1";
    readonly candidate: { readonly algorithm: "sha256"; readonly digest: string; readonly bytes: number };
    readonly source: { readonly gitSha: string | null; readonly dirty: boolean };
    readonly files: readonly PreviewEvidenceFile[];
}

export declare const PREVIEW_EVIDENCE_MANIFEST_SCHEMA: "chardb.preview-evidence-manifest.v1";
export declare function buildPreviewEvidenceManifest(directory: string): Promise<PreviewEvidenceManifest>;
export declare function writePreviewEvidenceManifest(directory: string): Promise<PreviewEvidenceManifest>;
