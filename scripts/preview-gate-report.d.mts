export declare const PREVIEW_GATE_SCHEMA: "chardb.preview-gate.report.v1";
export declare const PREVIEW_GATE_BROWSER_SCHEMA: "chardb.packed-browser-proof.report.v1";
export declare const REQUIRED_PREVIEW_STEPS: readonly string[];
export declare function assertPreviewOutputDirectory(directory: string): Promise<void>;

export interface PreviewGateStep {
    readonly name: string;
    readonly command: readonly string[];
    readonly startedAt: string;
    readonly durationMs: number;
    readonly status: "passed" | "failed";
    readonly error?: string;
}

export declare function parsePreviewGateArgs(
    argv: readonly string[],
    cwd?: string
): { readonly help: boolean; readonly outputDirectory: string; readonly platformName: string | undefined };
export declare function assertMatchingBrowserReport<T extends object>(
    browser: T,
    fingerprint: object,
    reactFingerprint?: object
): T;
export declare function assertPassingPreviewGateReport<T extends object>(
    report: T,
    expectedFingerprint?: object,
    expectedReactFingerprint?: object
): T;
export declare function buildPreviewGateReport(input: {
    readonly run: object;
    readonly source: object;
    readonly platform: object;
    readonly packageEvidence?: object;
    readonly reactPackageEvidence?: object;
    readonly steps: readonly PreviewGateStep[];
    readonly generatedProjectEvidence?: object;
    readonly packedChatEvidence?: object | undefined;
    readonly packedPublicVectorEvidence?: object | undefined;
    readonly browserEvidence?: object;
}): object;
