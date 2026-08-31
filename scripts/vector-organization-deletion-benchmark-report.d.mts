export const VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA: "chardb.vector-organization-deletion-benchmark.v3";

export interface VectorOrganizationDeletionBenchmarkReport {
    readonly schema: typeof VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA;
    readonly environment: { readonly bun: string; readonly sqlite: string; readonly storage: "in-memory SQLite" };
    readonly profile: {
        readonly name: "local-sqlite-organization-deletion-v2";
        readonly headCounts: readonly [500, 501, 1_001];
        readonly pageHeads: 500;
        readonly initialVersion: 3;
        readonly responseLossAfterCall: 1;
        readonly timingRunsPerScenario: 1;
        readonly productionLimits: {
            readonly heads: 65_536;
            readonly attemptRows: 262_144;
            readonly attemptVersionsPerHead: 4_096;
            readonly deleteIdsPerClaim: 32;
            readonly deliveryClaimsPerAlarmTurn: 1;
            readonly uncertainDeleteRetryMs: 300_000;
            readonly unprovenTurnLimit: 32;
        };
    };
    readonly scenarios: readonly {
        readonly heads: number;
        readonly initial: {
            readonly pendingHeads: number;
            readonly readyHeads: number;
            readonly upsertOutboxRows: number;
            readonly attemptRows: number;
            readonly confirmedAttempts: number;
            readonly ambiguousAttempts: number;
            readonly unsettledAttempts: number;
        };
        readonly calls: {
            readonly total: number;
            readonly nonempty: number;
            readonly records: readonly {
                readonly staged: number;
                readonly done: boolean;
                readonly responseObserved: boolean;
            }[];
        };
        readonly timing: {
            readonly fenceMs: number;
            readonly stagingTotalMs: number;
            readonly stageCallMs: readonly number[];
        };
        readonly observed: {
            readonly tombstones: number;
            readonly deletingHeads: number;
            readonly deleteOutboxRows: number;
            readonly attemptRows: number;
            readonly confirmedAttempts: number;
            readonly ambiguousAttempts: number;
            readonly unsettledAttempts: number;
            readonly minimumVersion: number;
            readonly maximumVersion: number;
            readonly capacity: {
                readonly headCount: number;
                readonly outboxRows: number;
                readonly attemptRows: number;
                readonly storedBytes: number;
            };
        };
        readonly queryPlan: {
            readonly usesActiveHeadIndex: true;
            readonly usesTempSort: false;
            readonly statusUsesOrganizationIndex: true;
            readonly statusUsesDeletingIndex: true;
            readonly statusFullScans: readonly [];
        };
        readonly proof: {
            readonly boundedPages: true;
            readonly responseLossCommitted: true;
            readonly retryContinuedFromCommittedProgress: true;
            readonly exactHeadCount: true;
            readonly exactDeleteOutboxCount: true;
            readonly attemptsPreserved: true;
            readonly versionsAdvancedOnce: true;
            readonly capacityCountersExact: true;
        };
    }[];
    readonly capacityModel: {
        readonly staging: {
            readonly nonemptyPages: number;
            readonly headsStagedByAcceptance: number;
            readonly postAcceptanceStagingAlarmTurns: number;
        };
        readonly finiteKnownAttempts: {
            readonly condition: string;
            readonly minimumDeliveryClaims: number;
            readonly maximumDeliveryClaims: number;
            readonly minimumAlarmTurnsAfterAcceptance: number;
            readonly maximumAlarmTurnsAfterAcceptance: number;
            readonly maximumDistribution: {
                readonly headsAtMaximumExtraClaims: number;
                readonly maximumExtraClaimsPerHead: number;
                readonly partialHeadExtraClaims: number;
                readonly attemptsWithoutAnotherClaim: number;
            };
        };
        readonly uncertainAttempts: {
            readonly finiteAlarmTurnUpperBound: true;
            readonly maximumAlarmTurnsAfterAcceptance: number;
            readonly terminalState: "failed_unproven";
            readonly unprovenTurnLimit: number;
            readonly retryIntervalMs: number;
            readonly reason: string;
        };
    };
    readonly scope: {
        readonly localSQLiteOnly: true;
        readonly includesSeedingInTimings: false;
        readonly includesVectorizeLatency: false;
        readonly includesDeleteDelivery: false;
        readonly includesRpcTransport: false;
        readonly includesNativeWorkerd: false;
        readonly alarmTurnModelOnly: true;
        readonly responseLossInjection: "discarded first committed store result";
        readonly description: string;
    };
}

export const VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE: Readonly<
    VectorOrganizationDeletionBenchmarkReport["profile"]
>;

export function assertVectorOrganizationDeletionBenchmarkReport(
    value: unknown
): VectorOrganizationDeletionBenchmarkReport;

export function deriveVectorOrganizationDeletionCapacityModel(
    profile: VectorOrganizationDeletionBenchmarkReport["profile"]
): VectorOrganizationDeletionBenchmarkReport["capacityModel"];
