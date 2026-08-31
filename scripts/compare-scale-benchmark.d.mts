export interface ScaleComparisonOptions {
    readonly help: boolean;
    readonly baselinePath?: string;
    readonly candidatePath?: string;
    readonly outputPath?: string;
    readonly maxRegressionPercent?: number;
}

export interface ScaleComparison {
    readonly schema: "chardb.scale.comparison.v1";
    readonly suite: string;
    readonly summary: {
        readonly comparisons: number;
        readonly regressions: number;
        readonly passed: boolean;
    };
    readonly comparisons: readonly Record<string, unknown>[];
}

export function parseComparisonArgs(argv: readonly string[]): ScaleComparisonOptions;
export function compareScaleReports(
    baselineReport: Record<string, unknown>,
    candidateReport: Record<string, unknown>,
    maxRegressionPercent: number
): ScaleComparison;
export function compareScaleReportFiles(options: {
    readonly baselinePath: string;
    readonly candidatePath: string;
    readonly outputPath?: string;
    readonly maxRegressionPercent: number;
}): Promise<ScaleComparison>;
