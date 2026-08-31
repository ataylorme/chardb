export const VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA = "chardb.vector-organization-deletion-benchmark.v3";

export const VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE = Object.freeze({
    name: "local-sqlite-organization-deletion-v2",
    headCounts: Object.freeze([500, 501, 1_001]),
    pageHeads: 500,
    initialVersion: 3,
    responseLossAfterCall: 1,
    timingRunsPerScenario: 1,
    productionLimits: Object.freeze({
        heads: 65_536,
        attemptRows: 262_144,
        attemptVersionsPerHead: 4_096,
        deleteIdsPerClaim: 32,
        deliveryClaimsPerAlarmTurn: 1,
        uncertainDeleteRetryMs: 300_000,
        unprovenTurnLimit: 32,
    }),
});

const REPORT_KEYS = Object.freeze(["schema", "environment", "profile", "scenarios", "capacityModel", "scope"]);
const SCENARIO_KEYS = Object.freeze(["heads", "initial", "calls", "timing", "observed", "queryPlan", "proof"]);
const PROOF_KEYS = Object.freeze([
    "boundedPages",
    "responseLossCommitted",
    "retryContinuedFromCommittedProgress",
    "exactHeadCount",
    "exactDeleteOutboxCount",
    "attemptsPreserved",
    "versionsAdvancedOnce",
    "capacityCountersExact",
]);

function invalid(message) {
    throw new TypeError(`vector organization deletion benchmark: ${message}`);
}

function object(value, subject) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${subject} is invalid`);
    return value;
}

function exactKeys(value, subject, expected) {
    const actual = Object.keys(object(value, subject)).sort();
    const keys = [...expected].sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
        invalid(`${subject} has unexpected keys`);
    }
}

function integer(value, subject, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) invalid(`${subject} is invalid`);
    return value;
}

function finite(value, subject) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(`${subject} is invalid`);
    return value;
}

function expectedInitial(heads) {
    return {
        pendingHeads: Math.ceil(heads / 2),
        readyHeads: Math.floor(heads / 2),
        upsertOutboxRows: Math.ceil(heads / 2),
        attemptRows: heads,
        confirmedAttempts: Math.ceil(heads / 3),
        ambiguousAttempts: Math.floor((heads + 1) / 3),
        unsettledAttempts: Math.floor(heads / 3),
    };
}

function expectedCalls(heads, pageHeads) {
    const staged = [];
    let remaining = heads;
    while (remaining > 0) {
        const page = Math.min(pageHeads, remaining);
        staged.push(page);
        remaining -= page;
    }
    if (staged.length === 1) staged.push(0);
    return staged;
}

function finiteClaimCount(attemptsPerHead, deleteIdsPerClaim) {
    return attemptsPerHead.reduce((sum, attempts) => sum + Math.max(1, Math.ceil(attempts / deleteIdsPerClaim)), 0);
}

function maximumFiniteClaimDistribution(input) {
    const attempts = Array.from({ length: input.heads }, () => 0);
    let remaining = input.attemptRows;
    let head = 0;
    const maximumExtraClaimsPerHead = Math.ceil(input.attemptVersionsPerHead / input.deleteIdsPerClaim) - 1;
    while (remaining >= input.deleteIdsPerClaim + 1) {
        if (head >= attempts.length) invalid("production limits cannot place all attempt rows");
        const extraClaims = Math.min(maximumExtraClaimsPerHead, Math.floor((remaining - 1) / input.deleteIdsPerClaim));
        const placed = extraClaims * input.deleteIdsPerClaim + 1;
        attempts[head] = placed;
        remaining -= placed;
        head++;
    }
    if (remaining > 0) attempts[head] = remaining;
    return attempts;
}

function minimumFiniteClaimDistribution(input) {
    const attempts = Array.from({ length: input.heads }, () => 0);
    for (let index = 0; index < input.attemptRows; index++) {
        attempts[index % input.heads]++;
    }
    return attempts;
}

export function deriveVectorOrganizationDeletionCapacityModel(profile) {
    const limits = profile.productionLimits;
    const nonemptyStagingPages = Math.ceil(limits.heads / profile.pageHeads);
    const minimumDistribution = minimumFiniteClaimDistribution(limits);
    const maximumDistribution = maximumFiniteClaimDistribution(limits);
    const minimumDeliveryClaims = finiteClaimCount(minimumDistribution, limits.deleteIdsPerClaim);
    const maximumDeliveryClaims = finiteClaimCount(maximumDistribution, limits.deleteIdsPerClaim);
    const maximumDistributionNonempty = maximumDistribution.filter(attempts => attempts > 0);
    const maximumExtraClaimsPerHead = Math.ceil(limits.attemptVersionsPerHead / limits.deleteIdsPerClaim) - 1;
    const extraClaims = maximumDistributionNonempty.map(attempts =>
        Math.max(0, Math.ceil(attempts / limits.deleteIdsPerClaim) - 1)
    );
    const attemptsWithoutAnotherClaim = maximumDistributionNonempty.reduce((sum, attempts, index) => {
        const extra = extraClaims[index] ?? 0;
        return sum + attempts - (extra === 0 ? 0 : extra * limits.deleteIdsPerClaim + 1);
    }, 0);
    return Object.freeze({
        staging: Object.freeze({
            nonemptyPages: nonemptyStagingPages,
            headsStagedByAcceptance: Math.min(limits.heads, profile.pageHeads),
            postAcceptanceStagingAlarmTurns: Math.max(0, nonemptyStagingPages - 1),
        }),
        finiteKnownAttempts: Object.freeze({
            condition: "every attempted physical version is visibility-confirmed and response-unambiguous",
            minimumDeliveryClaims,
            maximumDeliveryClaims,
            minimumAlarmTurnsAfterAcceptance: Math.max(
                nonemptyStagingPages - 1,
                Math.ceil(minimumDeliveryClaims / limits.deliveryClaimsPerAlarmTurn)
            ),
            maximumAlarmTurnsAfterAcceptance: Math.max(
                nonemptyStagingPages - 1,
                Math.ceil(maximumDeliveryClaims / limits.deliveryClaimsPerAlarmTurn)
            ),
            maximumDistribution: Object.freeze({
                headsAtMaximumExtraClaims: extraClaims.filter(value => value === maximumExtraClaimsPerHead).length,
                maximumExtraClaimsPerHead,
                partialHeadExtraClaims: extraClaims.find(value => value !== maximumExtraClaimsPerHead) ?? 0,
                attemptsWithoutAnotherClaim,
            }),
        }),
        uncertainAttempts: Object.freeze({
            finiteAlarmTurnUpperBound: true,
            maximumAlarmTurnsAfterAcceptance:
                Math.ceil(maximumDeliveryClaims / limits.deliveryClaimsPerAlarmTurn) * 2 + limits.unprovenTurnLimit,
            terminalState: "failed_unproven",
            unprovenTurnLimit: limits.unprovenTurnLimit,
            retryIntervalMs: limits.uncertainDeleteRetryMs,
            reason: "Known delete batches require an accepted submit turn and an exact verification turn. After the organization-wide uncertainty budget is exhausted, delivery stops in failed_unproven for manual intervention; this is a terminal work bound, not proof of external deletion or a latency SLA.",
        }),
    });
}

export function assertVectorOrganizationDeletionBenchmarkReport(value) {
    exactKeys(value, "report", REPORT_KEYS);
    if (value.schema !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA) invalid("schema is invalid");

    exactKeys(value.environment, "environment", ["bun", "sqlite", "storage"]);
    if (typeof value.environment.bun !== "string" || value.environment.bun.length === 0) {
        invalid("environment.bun is invalid");
    }
    if (typeof value.environment.sqlite !== "string" || value.environment.sqlite.length === 0) {
        invalid("environment.sqlite is invalid");
    }
    if (value.environment.storage !== "in-memory SQLite") invalid("environment.storage is invalid");

    exactKeys(value.profile, "profile", [
        "name",
        "headCounts",
        "pageHeads",
        "initialVersion",
        "responseLossAfterCall",
        "timingRunsPerScenario",
        "productionLimits",
    ]);
    if (value.profile.name !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.name) invalid("profile.name is invalid");
    if (
        !Array.isArray(value.profile.headCounts) ||
        value.profile.headCounts.length !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.headCounts.length ||
        value.profile.headCounts.some(
            (heads, index) => heads !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.headCounts[index]
        )
    ) {
        invalid("profile.headCounts must prove the 500/501/1001 boundaries");
    }
    if (
        value.profile.pageHeads !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.pageHeads ||
        value.profile.initialVersion !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.initialVersion ||
        value.profile.responseLossAfterCall !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.responseLossAfterCall ||
        value.profile.timingRunsPerScenario !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.timingRunsPerScenario
    ) {
        invalid("profile constants are invalid");
    }
    exactKeys(value.profile.productionLimits, "profile.productionLimits", [
        "heads",
        "attemptRows",
        "attemptVersionsPerHead",
        "deleteIdsPerClaim",
        "deliveryClaimsPerAlarmTurn",
        "uncertainDeleteRetryMs",
        "unprovenTurnLimit",
    ]);
    for (const [field, expected] of Object.entries(VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.productionLimits)) {
        if (value.profile.productionLimits[field] !== expected) invalid(`profile.productionLimits.${field} is invalid`);
    }

    if (!Array.isArray(value.scenarios) || value.scenarios.length !== value.profile.headCounts.length) {
        invalid("scenarios do not match profile.headCounts");
    }
    value.scenarios.forEach((scenario, index) => {
        exactKeys(scenario, `scenarios[${index}]`, SCENARIO_KEYS);
        const heads = value.profile.headCounts[index];
        if (scenario.heads !== heads) invalid(`scenarios[${index}].heads does not match the profile`);

        const initial = expectedInitial(heads);
        exactKeys(scenario.initial, `scenarios[${index}].initial`, Object.keys(initial));
        for (const [field, expected] of Object.entries(initial)) {
            if (scenario.initial[field] !== expected) invalid(`scenarios[${index}].initial.${field} is not exact`);
        }

        exactKeys(scenario.calls, `scenarios[${index}].calls`, ["total", "nonempty", "records"]);
        const expectedStaged = expectedCalls(heads, value.profile.pageHeads);
        if (scenario.calls.total !== expectedStaged.length) invalid(`scenarios[${index}].calls.total is not bounded`);
        if (scenario.calls.nonempty !== Math.ceil(heads / value.profile.pageHeads)) {
            invalid(`scenarios[${index}].calls.nonempty is not exact`);
        }
        if (!Array.isArray(scenario.calls.records) || scenario.calls.records.length !== expectedStaged.length) {
            invalid(`scenarios[${index}].calls.records is invalid`);
        }
        scenario.calls.records.forEach((call, callIndex) => {
            exactKeys(call, `scenarios[${index}].calls.records[${callIndex}]`, ["staged", "done", "responseObserved"]);
            if (call.staged !== expectedStaged[callIndex]) {
                invalid(`scenarios[${index}].calls.records[${callIndex}].staged is not exact`);
            }
            const expectedDone =
                expectedStaged.slice(0, callIndex + 1).reduce((sum, count) => sum + count, 0) === heads;
            if (call.done !== expectedDone) invalid(`scenarios[${index}].calls.records[${callIndex}].done is invalid`);
            if (call.responseObserved !== (callIndex !== 0)) {
                invalid(`scenarios[${index}].calls.records[${callIndex}].responseObserved is invalid`);
            }
        });

        exactKeys(scenario.timing, `scenarios[${index}].timing`, ["fenceMs", "stagingTotalMs", "stageCallMs"]);
        finite(scenario.timing.fenceMs, `scenarios[${index}].timing.fenceMs`);
        finite(scenario.timing.stagingTotalMs, `scenarios[${index}].timing.stagingTotalMs`);
        if (
            !Array.isArray(scenario.timing.stageCallMs) ||
            scenario.timing.stageCallMs.length !== expectedStaged.length
        ) {
            invalid(`scenarios[${index}].timing.stageCallMs is invalid`);
        }
        let measuredTotal = 0;
        for (const [callIndex, elapsed] of scenario.timing.stageCallMs.entries()) {
            finite(elapsed, `scenarios[${index}].timing.stageCallMs[${callIndex}]`);
            measuredTotal += elapsed;
        }
        if (Math.abs(measuredTotal - scenario.timing.stagingTotalMs) > 0.000_001) {
            invalid(`scenarios[${index}].timing.stagingTotalMs does not equal its calls`);
        }

        exactKeys(scenario.observed, `scenarios[${index}].observed`, [
            "tombstones",
            "deletingHeads",
            "deleteOutboxRows",
            "attemptRows",
            "confirmedAttempts",
            "ambiguousAttempts",
            "unsettledAttempts",
            "minimumVersion",
            "maximumVersion",
            "capacity",
        ]);
        for (const field of ["tombstones", "deletingHeads", "deleteOutboxRows", "attemptRows"]) {
            integer(scenario.observed[field], `scenarios[${index}].observed.${field}`);
        }
        if (
            scenario.observed.tombstones !== 1 ||
            scenario.observed.deletingHeads !== heads ||
            scenario.observed.deleteOutboxRows !== heads ||
            scenario.observed.attemptRows !== heads ||
            scenario.observed.confirmedAttempts !== initial.confirmedAttempts ||
            scenario.observed.ambiguousAttempts !== initial.ambiguousAttempts ||
            scenario.observed.unsettledAttempts !== initial.unsettledAttempts ||
            scenario.observed.minimumVersion !== value.profile.initialVersion + 1 ||
            scenario.observed.maximumVersion !== value.profile.initialVersion + 1
        ) {
            invalid(`scenarios[${index}].observed counts or versions are not exact`);
        }
        exactKeys(scenario.observed.capacity, `scenarios[${index}].observed.capacity`, [
            "headCount",
            "outboxRows",
            "attemptRows",
            "storedBytes",
        ]);
        for (const field of ["headCount", "outboxRows", "attemptRows", "storedBytes"]) {
            integer(scenario.observed.capacity[field], `scenarios[${index}].observed.capacity.${field}`);
        }
        if (
            scenario.observed.capacity.headCount !== heads ||
            scenario.observed.capacity.outboxRows !== heads ||
            scenario.observed.capacity.attemptRows !== heads ||
            scenario.observed.capacity.storedBytes !== heads * 2
        ) {
            invalid(`scenarios[${index}].observed.capacity is not exact`);
        }

        exactKeys(scenario.queryPlan, `scenarios[${index}].queryPlan`, [
            "usesActiveHeadIndex",
            "usesTempSort",
            "statusUsesOrganizationIndex",
            "statusUsesDeletingIndex",
            "statusFullScans",
        ]);
        if (
            scenario.queryPlan.usesActiveHeadIndex !== true ||
            scenario.queryPlan.usesTempSort !== false ||
            scenario.queryPlan.statusUsesOrganizationIndex !== true ||
            scenario.queryPlan.statusUsesDeletingIndex !== true ||
            !Array.isArray(scenario.queryPlan.statusFullScans) ||
            scenario.queryPlan.statusFullScans.length !== 0
        ) {
            invalid(`scenarios[${index}].queryPlan is not bounded by the active-head index`);
        }
        exactKeys(scenario.proof, `scenarios[${index}].proof`, PROOF_KEYS);
        for (const proof of PROOF_KEYS) {
            if (scenario.proof[proof] !== true) invalid(`scenarios[${index}].proof.${proof} did not pass`);
        }
    });

    const expectedCapacity = deriveVectorOrganizationDeletionCapacityModel(value.profile);
    exactKeys(value.capacityModel, "capacityModel", ["staging", "finiteKnownAttempts", "uncertainAttempts"]);
    exactKeys(value.capacityModel.staging, "capacityModel.staging", [
        "nonemptyPages",
        "headsStagedByAcceptance",
        "postAcceptanceStagingAlarmTurns",
    ]);
    exactKeys(value.capacityModel.finiteKnownAttempts, "capacityModel.finiteKnownAttempts", [
        "condition",
        "minimumDeliveryClaims",
        "maximumDeliveryClaims",
        "minimumAlarmTurnsAfterAcceptance",
        "maximumAlarmTurnsAfterAcceptance",
        "maximumDistribution",
    ]);
    exactKeys(value.capacityModel.finiteKnownAttempts.maximumDistribution, "capacityModel maximum distribution", [
        "headsAtMaximumExtraClaims",
        "maximumExtraClaimsPerHead",
        "partialHeadExtraClaims",
        "attemptsWithoutAnotherClaim",
    ]);
    exactKeys(value.capacityModel.uncertainAttempts, "capacityModel.uncertainAttempts", [
        "finiteAlarmTurnUpperBound",
        "maximumAlarmTurnsAfterAcceptance",
        "terminalState",
        "unprovenTurnLimit",
        "retryIntervalMs",
        "reason",
    ]);
    if (JSON.stringify(value.capacityModel) !== JSON.stringify(expectedCapacity)) {
        invalid("capacityModel does not match the production-limit alarm-turn model");
    }

    exactKeys(value.scope, "scope", [
        "localSQLiteOnly",
        "includesSeedingInTimings",
        "includesVectorizeLatency",
        "includesDeleteDelivery",
        "includesRpcTransport",
        "includesNativeWorkerd",
        "alarmTurnModelOnly",
        "responseLossInjection",
        "description",
    ]);
    if (
        value.scope.localSQLiteOnly !== true ||
        value.scope.includesSeedingInTimings !== false ||
        value.scope.includesVectorizeLatency !== false ||
        value.scope.includesDeleteDelivery !== false ||
        value.scope.includesRpcTransport !== false ||
        value.scope.includesNativeWorkerd !== false ||
        value.scope.alarmTurnModelOnly !== true ||
        value.scope.responseLossInjection !== "discarded first committed store result"
    ) {
        invalid("scope overclaims benchmark coverage");
    }
    if (typeof value.scope.description !== "string" || value.scope.description.length === 0) {
        invalid("scope.description is invalid");
    }
    return value;
}
