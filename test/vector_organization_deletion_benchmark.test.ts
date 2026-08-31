import { describe, expect, test } from "bun:test";
import { produceVectorOrganizationDeletionBenchmark } from "../scripts/produce-vector-organization-deletion-benchmark.mjs";
import {
    VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE,
    VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA,
    assertVectorOrganizationDeletionBenchmarkReport,
    deriveVectorOrganizationDeletionCapacityModel,
} from "../scripts/vector-organization-deletion-benchmark-report.mjs";

describe("vector organization deletion benchmark", () => {
    test("proves bounded 500/501/1001 staging with mixed durable state and committed response loss", () => {
        const report = produceVectorOrganizationDeletionBenchmark();

        expect(assertVectorOrganizationDeletionBenchmarkReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
        expect(report.schema).toBe(VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA);
        expect(report.scenarios.map(scenario => scenario.calls.records.map(call => call.staged))).toEqual([
            [500, 0],
            [500, 1],
            [500, 500, 1],
        ]);
        for (const scenario of report.scenarios) {
            expect(scenario.calls.records[0]?.responseObserved).toBeFalse();
            expect(scenario.initial.pendingHeads + scenario.initial.readyHeads).toBe(scenario.heads);
            expect(
                scenario.initial.confirmedAttempts +
                    scenario.initial.ambiguousAttempts +
                    scenario.initial.unsettledAttempts
            ).toBe(scenario.heads);
            expect(scenario.observed).toMatchObject({
                tombstones: 1,
                deletingHeads: scenario.heads,
                deleteOutboxRows: scenario.heads,
                attemptRows: scenario.heads,
                minimumVersion: 4,
                maximumVersion: 4,
            });
            expect(Object.values(scenario.proof).every(Boolean)).toBeTrue();
            expect(scenario.timing.stageCallMs).toHaveLength(scenario.calls.total);
        }
        expect(report.scope).toEqual({
            localSQLiteOnly: true,
            includesSeedingInTimings: false,
            includesVectorizeLatency: false,
            includesDeleteDelivery: false,
            includesRpcTransport: false,
            includesNativeWorkerd: false,
            alarmTurnModelOnly: true,
            responseLossInjection: "discarded first committed store result",
            description:
                "One local SQLite timing run per boundary plus an exact alarm-turn model at production row limits. The producer discards the first committed store result; it excludes RPC transport, seeding, native Workerd timing, Vectorize calls, delete delivery latency, and any SLA claim.",
        });
    });

    test("reports the finite production-limit cost and terminal manual-intervention bound", () => {
        const report = produceVectorOrganizationDeletionBenchmark();

        expect(report.profile.productionLimits).toEqual({
            heads: 65_536,
            attemptRows: 262_144,
            attemptVersionsPerHead: 4_096,
            deleteIdsPerClaim: 32,
            deliveryClaimsPerAlarmTurn: 1,
            uncertainDeleteRetryMs: 300_000,
            unprovenTurnLimit: 32,
        });
        expect(report.capacityModel).toEqual({
            staging: {
                nonemptyPages: 132,
                headsStagedByAcceptance: 500,
                postAcceptanceStagingAlarmTurns: 131,
            },
            finiteKnownAttempts: {
                condition: "every attempted physical version is visibility-confirmed and response-unambiguous",
                minimumDeliveryClaims: 65_536,
                maximumDeliveryClaims: 73_725,
                minimumAlarmTurnsAfterAcceptance: 65_536,
                maximumAlarmTurnsAfterAcceptance: 73_725,
                maximumDistribution: {
                    headsAtMaximumExtraClaims: 64,
                    maximumExtraClaimsPerHead: 127,
                    partialHeadExtraClaims: 61,
                    attemptsWithoutAnotherClaim: 31,
                },
            },
            uncertainAttempts: {
                finiteAlarmTurnUpperBound: true,
                maximumAlarmTurnsAfterAcceptance: 147_482,
                terminalState: "failed_unproven",
                unprovenTurnLimit: 32,
                retryIntervalMs: 300_000,
                reason: expect.stringContaining("not proof of external deletion"),
            },
        });
        expect(deriveVectorOrganizationDeletionCapacityModel(VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE)).toEqual(
            report.capacityModel
        );
    });

    test("matches an exhaustive small-capacity claim distribution", () => {
        const profile = {
            ...VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE,
            pageHeads: 2,
            productionLimits: {
                heads: 3,
                attemptRows: 12,
                attemptVersionsPerHead: 6,
                deleteIdsPerClaim: 2,
                deliveryClaimsPerAlarmTurn: 1,
                uncertainDeleteRetryMs: 300_000,
                unprovenTurnLimit: 32,
            },
        };
        const claims: number[] = [];
        for (let first = 0; first <= 6; first++) {
            for (let second = 0; second <= 6; second++) {
                const third = 12 - first - second;
                if (third < 0 || third > 6) continue;
                claims.push(
                    [first, second, third].reduce((sum, attempts) => sum + Math.max(1, Math.ceil(attempts / 2)), 0)
                );
            }
        }

        const model = deriveVectorOrganizationDeletionCapacityModel(profile as never);
        expect(model.finiteKnownAttempts.minimumDeliveryClaims).toBe(Math.min(...claims));
        expect(model.finiteKnownAttempts.maximumDeliveryClaims).toBe(Math.max(...claims));
        expect(model.finiteKnownAttempts).toMatchObject({
            minimumAlarmTurnsAfterAcceptance: 6,
            maximumAlarmTurnsAfterAcceptance: 7,
        });
    });

    test("rejects schema drift, missing boundaries, version drift, false proof, and scope overclaims", () => {
        const report = produceVectorOrganizationDeletionBenchmark();
        const corruptions: Array<(value: typeof report) => unknown> = [
            value => ({ ...value, extra: true }),
            value => ({ ...value, profile: { ...value.profile, headCounts: [500, 501] } }),
            value => ({
                ...value,
                scenarios: value.scenarios.map((scenario, index) =>
                    index === 1 ? { ...scenario, observed: { ...scenario.observed, maximumVersion: 5 } } : scenario
                ),
            }),
            value => ({
                ...value,
                scenarios: value.scenarios.map((scenario, index) =>
                    index === 2 ? { ...scenario, proof: { ...scenario.proof, attemptsPreserved: false } } : scenario
                ),
            }),
            value => ({ ...value, scope: { ...value.scope, includesVectorizeLatency: true } }),
            value => ({
                ...value,
                capacityModel: {
                    ...value.capacityModel,
                    finiteKnownAttempts: {
                        ...value.capacityModel.finiteKnownAttempts,
                        maximumAlarmTurnsAfterAcceptance: 73_724,
                    },
                },
            }),
        ];
        for (const corrupt of corruptions) {
            expect(() => assertVectorOrganizationDeletionBenchmarkReport(corrupt(report))).toThrow();
        }
    });
});
