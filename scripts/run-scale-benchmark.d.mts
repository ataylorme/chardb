export interface ScaleProfileValues {
    readonly clientsPerTenant: number;
    readonly mutationsPerTenant: number;
    readonly mutationBatch: number;
    readonly subscriptions: number;
    readonly refreshRounds: number;
    readonly waitMs: number;
    readonly testTimeoutMs: number;
}

export interface PlannedQueryProfileValues {
    readonly channels: number;
    readonly rowsPerChannel: number;
    readonly registrations: number;
    readonly pageLimit: number;
    readonly bindingQueries: number;
    readonly bindingConcurrency: number;
    readonly testTimeoutMs: number;
}

export type BenchmarkProfileValues = ScaleProfileValues | PlannedQueryProfileValues;

export interface BenchmarkSuite {
    readonly id: string;
    readonly label: string;
    readonly command: readonly string[];
    readonly scenarios: readonly string[];
    readonly runtimeConfig: {
        readonly compatibilityDate: string;
        readonly compatibilityFlags: readonly string[];
    };
    readonly profileFields: Readonly<
        Record<string, { readonly env: string; readonly minimum: number; readonly maximum: number }>
    >;
    readonly profiles: Readonly<
        Record<string, { readonly values: BenchmarkProfileValues; readonly defaultSamples: number }>
    >;
}

export interface ScaleOptions {
    readonly help: boolean;
    readonly suiteName?: string;
    readonly profileName: string;
    readonly profile: BenchmarkProfileValues;
    readonly samples: number;
    readonly outputDirectory: string;
}

export const SCALE_PROFILES: Readonly<
    Record<string, { readonly values: ScaleProfileValues; readonly defaultSamples: number }>
>;
export const PLANNED_QUERY_PROFILES: Readonly<
    Record<string, { readonly values: PlannedQueryProfileValues; readonly defaultSamples: number }>
>;
export const BENCHMARK_SUITES: Readonly<Record<string, BenchmarkSuite>>;

export function validateProfile<T extends BenchmarkProfileValues>(
    name: string,
    profile: T,
    fields?: BenchmarkSuite["profileFields"]
): T;
export function validateRunBudget(
    profile: BenchmarkProfileValues,
    samples: number,
    fields?: BenchmarkSuite["profileFields"],
    scenarioCount?: number
): {
    readonly workflowJobMs: number;
    readonly setupReserveMs: number;
    readonly availableMs: number;
    readonly sampleMaximumMs: number;
    readonly runMaximumMs: number;
};
export function parseScaleArgs(argv: readonly string[]): ScaleOptions;
export function parseHarnessMetrics(
    output: string,
    expectedScenarios?: readonly string[],
    validation?: {
        readonly suiteName: string;
        readonly profile: BenchmarkProfileValues;
    }
): readonly Record<string, string | number>[];
export function summarizeSamples(
    records: readonly Record<string, unknown>[],
    expectedScenarios?: readonly string[]
): readonly Record<string, unknown>[];
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
            readonly suite: BenchmarkSuite;
        }) => Promise<string>;
    }
): Promise<{
    readonly records: readonly Record<string, unknown>[];
    readonly report: Record<string, unknown>;
    readonly runPath: string;
    readonly ndjsonPath: string;
    readonly reportPath: string;
}>;
