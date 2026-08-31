export declare const BROWSER_REPORT_SCHEMA: "chardb.packed-browser.report.v1";
export declare const MAX_BROWSER_SAMPLES: 100;
export declare const MAX_BROWSER_WARMUP_SAMPLES: 20;

export interface BrowserSamplePlan {
    readonly name: string;
    readonly samples: number;
    readonly warmupSamples: number;
}

export interface BrowserTimingSummary {
    readonly minimum: number;
    readonly p50: number;
    readonly p95: number;
    readonly maximum: number;
    readonly mean: number;
}

export interface FileFingerprint {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly bytes: number;
}

export interface BrowserTimingSample {
    readonly authReadyMs: number;
    readonly initialQueryMs: number;
    readonly mutationAckMs: number;
    readonly liveUpdateMs: number;
}

export interface BrowserRestartTimings {
    readonly wranglerReadyMs: number;
    readonly persistedReadMs: number;
    readonly persistedInitialQueryMs: number;
}

export interface BrowserMeasurement {
    readonly clock: "performance.now";
    readonly unit: "milliseconds";
    readonly warmups: readonly {
        readonly index: number;
        readonly timingsMs: {
            readonly authReady: number;
            readonly initialQuery: number;
            readonly mutationAck: number;
            readonly liveUpdate: number;
        };
    }[];
    readonly samples: BrowserMeasurement["warmups"];
    readonly restart: BrowserRestartTimings;
    readonly summaries: {
        readonly authReadyMs: BrowserTimingSummary;
        readonly initialQueryMs: BrowserTimingSummary;
        readonly mutationAckMs: BrowserTimingSummary;
        readonly liveUpdateMs: BrowserTimingSummary;
    };
}

export declare function parseBrowserSamplePlan(
    profileName: string,
    sampleOverride?: string,
    warmupOverride?: string
): BrowserSamplePlan;
export declare function summarizeBrowserTimings(values: readonly number[]): BrowserTimingSummary;
export declare function buildBrowserMeasurement(
    samples: readonly BrowserTimingSample[],
    warmups: readonly BrowserTimingSample[],
    restart: BrowserRestartTimings
): BrowserMeasurement;
export declare function fingerprintFile(file: string): Promise<FileFingerprint>;
export declare function defaultBrowserReportPath(tarballPath: string): string;
export declare function writeJsonAtomically(file: string, value: unknown): Promise<string>;
