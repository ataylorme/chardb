export declare function parsePreviewPrepareArgs(argv: readonly string[]): {
    readonly help: boolean;
    readonly tarball: string | undefined;
    readonly output: string | undefined;
    readonly name: string;
};
export declare function renderPreviewWrangler(source: string, name: string, releaseSha256: string): string;
