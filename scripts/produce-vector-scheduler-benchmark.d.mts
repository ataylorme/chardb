export declare const VECTOR_SCHEDULER_BENCHMARK_SCHEMA: "chardb.vector-scheduler-benchmark.v2";

export interface VectorSchedulerTiming {
    readonly medianMs: number;
    readonly p95Ms: number;
    readonly maxMs: number;
}

export interface VectorSchedulerBenchmarkReport {
    readonly schema: typeof VECTOR_SCHEDULER_BENCHMARK_SCHEMA;
    readonly environment: {
        readonly bun: string;
        readonly sqlite: string;
    };
    readonly profile: {
        readonly rows: number;
        readonly samples: number;
        readonly outboxRowLimit: number;
    };
    readonly placements: {
        readonly fenced: number;
        readonly owned: number;
    };
    readonly timings: {
        readonly ownedFirstNextDueAt: VectorSchedulerTiming;
        readonly ownedFirstClaimNext: VectorSchedulerTiming;
        readonly nextDueAt: VectorSchedulerTiming;
        readonly claimNext: VectorSchedulerTiming;
        readonly allFencedNextDueAt: VectorSchedulerTiming;
        readonly allFencedClaimNext: VectorSchedulerTiming;
    };
    readonly plans: {
        readonly due: readonly string[];
        readonly placementAtOrAfter: readonly string[];
        readonly placementWrap: readonly string[];
        readonly claim: readonly string[];
    };
    readonly proof: {
        readonly exercisedExactOutboxLimit: boolean;
        readonly hotVshardTurnsBeforeCold: 1;
        readonly cursorSurvivedStoreReconstruction: true;
        readonly claimUsesEffectiveDueIndex: boolean;
        readonly dueUsesEffectiveDueIndex: boolean;
        readonly placementSeekUsesScheduleIndex: boolean;
        readonly placementWrapUsesEffectiveDueIndex: boolean;
        readonly claimAvoidsTempSort: boolean;
        readonly routingFenceUsesRangeIndex: boolean;
        readonly destinationChecksUseAdmissionIndex: boolean;
    };
}

export declare function produceVectorSchedulerBenchmark(options?: {
    readonly rows?: number;
    readonly samples?: number;
}): VectorSchedulerBenchmarkReport;
