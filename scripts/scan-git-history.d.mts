export interface HistorySecretFinding {
    readonly rule: string;
    readonly objectId: string;
    readonly path: string;
}

export function scanSecretText(text: string): string[];
export function scanGitHistory(): {
    readonly commits: number;
    readonly scannedBlobs: number;
    readonly scannedBytes: number;
    readonly findings: HistorySecretFinding[];
};
