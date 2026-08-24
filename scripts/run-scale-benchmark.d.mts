export interface ScaleProfileValues {
    readonly clientsPerTenant: number;
    readonly mutationsPerTenant: number;
    readonly mutationBatch: number;
    readonly subscriptions: number;
    readonly refreshRounds: number;
    readonly waitMs: number;
    readonly testTimeoutMs: number;
}

export interface ScaleOptions {
    readonly help: boolean;
    readonly profileName: string;
    readonly profile: ScaleProfileValues;
    readonly samples: number;
    readonly outputDirectory: string;
}

export const SCALE_PROFILES: Readonly<
    Record<string, { readonly values: ScaleProfileValues; readonly defaultSamples: number }>
>;

export function validateProfile(name: string, profile: ScaleProfileValues): ScaleProfileValues;
export function validateRunBudget(
    profile: ScaleProfileValues,
    samples: number
): {
    readonly workflowJobMs: number;
    readonly setupReserveMs: number;
    readonly availableMs: number;
    readonly sampleMaximumMs: number;
    readonly runMaximumMs: number;
};
export function parseScaleArgs(argv: readonly string[]): ScaleOptions;
export function parseHarnessMetrics(output: string): readonly Record<string, string | number>[];
export function summarizeSamples(records: readonly Record<string, unknown>[]): readonly Record<string, unknown>[];
export function collectRunMetadata(
    environment: Record<string, string | undefined>,
    startedAt: string,
    randomUUID: () => string
): Record<string, unknown>;
export function runScaleBenchmark(
    options: ScaleOptions,
    dependencies?: {
        readonly environment?: Record<string, string | undefined>;
        readonly now?: () => string;
        readonly randomUUID?: () => string;
        readonly runMetadata?: Record<string, unknown>;
        readonly runHarness?: (input: {
            readonly environment: Record<string, string | undefined>;
            readonly logPath: string;
            readonly outerTimeoutMs: number;
            readonly sampleIndex: number;
        }) => Promise<string>;
    }
): Promise<{
    readonly records: readonly Record<string, unknown>[];
    readonly report: Record<string, unknown>;
    readonly runPath: string;
    readonly ndjsonPath: string;
    readonly reportPath: string;
}>;
