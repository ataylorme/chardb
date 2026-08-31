export const RESHARD_BENCHMARK_SCHEMA = "chardb.reshard-benchmark.report.v1";
export const RESHARD_BENCHMARK_SAMPLE_SCHEMA = "chardb.reshard-benchmark.raw-sample.v1";
export const RESHARD_BENCHMARK_WORKLOAD_ID = "organization-fresh-destination-range-move";
export const RESHARD_BENCHMARK_WORKLOAD_VERSION = 1;

export const RESHARD_BENCHMARK_PROFILE = Object.freeze({
    name: "standard-v1",
    warmupRuns: 1,
    logicalRuns: 5,
    seed: Object.freeze({ organizations: 1, parentRows: 1_024, childRows: 4_096 }),
    capture: Object.freeze({ transactionGroups: 256, entriesPerGroup: 1 }),
    bulk: Object.freeze({ rowLimit: 500, byteLimit: 1_048_576 }),
    tail: Object.freeze({ groupLimit: 500, byteLimit: 1_048_576 }),
    drain: Object.freeze({ rowLimit: 128 }),
    restart: Object.freeze({ phase: "bulk", afterAppliedBatches: 3 }),
    routing: Object.freeze({ staleRouteRetries: 1, liveReason: "shardsChanged" }),
});

export const RESHARD_BENCHMARK_PHASES = Object.freeze([
    "prepare",
    "bulk",
    "capture",
    "restart",
    "replay",
    "fence",
    "cutover",
    "staleRouteRetry",
    "liveRefetch",
    "drain",
    "verify",
]);

const DIGEST = /^[a-f0-9]{64}$/;
const EXPECTED_ROWS = RESHARD_BENCHMARK_PROFILE.seed.parentRows + RESHARD_BENCHMARK_PROFILE.seed.childRows;
const EXACT_SAMPLE_KEYS = [
    "schema",
    "sequence",
    "excluded",
    "candidateSha256",
    "workload",
    "target",
    "execution",
    "timing",
    "movement",
    "correctness",
];

function object(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}

function exactKeys(value, label, keys) {
    object(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
    }
}

function nonempty(value, label) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
    return value;
}

function integer(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
    return value;
}

function finite(value, label, minimum = 0) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
        throw new Error(`${label} must be a finite number >= ${minimum}`);
    }
    return value;
}

function iso(value, label) {
    nonempty(value, label);
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error(`${label} must be a canonical ISO timestamp`);
    }
}

function digest(value, label) {
    if (!DIGEST.test(value ?? "")) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function assertTarget(target, label) {
    exactKeys(target, label, ["kind", "origin", "transport", "configurationSha256", "runtime", "storage"]);
    if (target.kind !== "local" && target.kind !== "cloudflare") throw new Error(`${label}.kind is invalid`);
    const origin = nonempty(target.origin, `${label}.origin`);
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        throw new Error(`${label}.origin must be an HTTP origin`);
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) {
        throw new Error(`${label}.origin must be an HTTP origin`);
    }
    if (target.kind === "local" && target.transport !== "wrangler-miniflare-http") {
        throw new Error(`${label}.transport must use Wrangler and Miniflare locally`);
    }
    if (target.kind === "cloudflare" && target.transport !== "wrangler-cloudflare-http") {
        throw new Error(`${label}.transport must use Wrangler and Cloudflare when deployed`);
    }
    digest(target.configurationSha256, `${label}.configurationSha256`);
    exactKeys(target.runtime, `${label}.runtime`, ["workerd", "wrangler", "miniflare", "compatibilityDate"]);
    nonempty(target.runtime.workerd, `${label}.runtime.workerd`);
    nonempty(target.runtime.wrangler, `${label}.runtime.wrangler`);
    if (target.kind === "local") nonempty(target.runtime.miniflare, `${label}.runtime.miniflare`);
    else if (target.runtime.miniflare !== null)
        throw new Error(`${label}.runtime.miniflare must be null when deployed`);
    nonempty(target.runtime.compatibilityDate, `${label}.runtime.compatibilityDate`);
    exactKeys(target.storage, `${label}.storage`, ["durableObjects", "sqlite"]);
    if (target.storage.durableObjects !== true || target.storage.sqlite !== true) {
        throw new Error(`${label}.storage must prove SQLite Durable Objects`);
    }
}

function assertExecution(execution, label) {
    exactKeys(execution, label, ["startedAt", "completedAt", "processId"]);
    iso(execution.startedAt, `${label}.startedAt`);
    iso(execution.completedAt, `${label}.completedAt`);
    if (Date.parse(execution.completedAt) < Date.parse(execution.startedAt)) {
        throw new Error(`${label}.completedAt precedes startedAt`);
    }
    integer(execution.processId, `${label}.processId`, 1);
}

function assertTiming(timing, label) {
    exactKeys(timing, label, ["totalMs", "phasesMs"]);
    finite(timing.totalMs, `${label}.totalMs`, Number.EPSILON);
    exactKeys(timing.phasesMs, `${label}.phasesMs`, RESHARD_BENCHMARK_PHASES);
    for (const phase of RESHARD_BENCHMARK_PHASES) finite(timing.phasesMs[phase], `${label}.phasesMs.${phase}`);
    const accountedMs = RESHARD_BENCHMARK_PHASES.reduce((sum, phase) => sum + timing.phasesMs[phase], 0);
    if (timing.totalMs < accountedMs) throw new Error(`${label}.totalMs is smaller than its accounted phases`);
}

function assertMovement(movement, label) {
    exactKeys(movement, label, ["bulk", "capture", "replay", "drain"]);
    exactKeys(movement.bulk, `${label}.bulk`, ["rows", "bytes", "readBatches", "applyBatches"]);
    if (movement.bulk.rows !== EXPECTED_ROWS) throw new Error(`${label}.bulk.rows must equal ${EXPECTED_ROWS}`);
    integer(movement.bulk.bytes, `${label}.bulk.bytes`, EXPECTED_ROWS);
    integer(movement.bulk.readBatches, `${label}.bulk.readBatches`, 1);
    integer(movement.bulk.applyBatches, `${label}.bulk.applyBatches`, 1);
    if (movement.bulk.applyBatches > movement.bulk.readBatches) {
        throw new Error(`${label}.bulk.applyBatches exceeds readBatches`);
    }

    exactKeys(movement.capture, `${label}.capture`, ["transactionGroups", "entries", "bytes"]);
    if (movement.capture.transactionGroups !== RESHARD_BENCHMARK_PROFILE.capture.transactionGroups) {
        throw new Error(`${label}.capture.transactionGroups drifted`);
    }
    const expectedEntries =
        RESHARD_BENCHMARK_PROFILE.capture.transactionGroups * RESHARD_BENCHMARK_PROFILE.capture.entriesPerGroup;
    if (movement.capture.entries !== expectedEntries)
        throw new Error(`${label}.capture.entries must equal ${expectedEntries}`);
    integer(movement.capture.bytes, `${label}.capture.bytes`, movement.capture.entries);

    exactKeys(movement.replay, `${label}.replay`, [
        "passes",
        "readBatches",
        "applyBatches",
        "transactionGroups",
        "entries",
        "bytes",
    ]);
    integer(movement.replay.passes, `${label}.replay.passes`, 2);
    integer(movement.replay.readBatches, `${label}.replay.readBatches`, 1);
    integer(movement.replay.applyBatches, `${label}.replay.applyBatches`, 1);
    if (movement.replay.applyBatches > movement.replay.readBatches) {
        throw new Error(`${label}.replay.applyBatches exceeds readBatches`);
    }
    for (const field of ["transactionGroups", "entries", "bytes"]) {
        if (movement.replay[field] !== movement.capture[field]) {
            throw new Error(`${label}.replay.${field} does not match captured work`);
        }
    }

    exactKeys(movement.drain, `${label}.drain`, ["rows", "batches"]);
    if (movement.drain.rows !== EXPECTED_ROWS) throw new Error(`${label}.drain.rows must equal ${EXPECTED_ROWS}`);
    integer(movement.drain.batches, `${label}.drain.batches`, 1);
}

function assertCorrectness(correctness, label) {
    exactKeys(correctness, label, [
        "organizationAuthorized",
        "freshDestination",
        "schemaIdentity",
        "bulkCursorResumed",
        "tailTransactionOrder",
        "tailOrder",
        "fenceActivated",
        "cutoverActivated",
        "sourceDrained",
        "staleRoute",
        "live",
        "restart",
        "digests",
    ]);
    for (const flag of [
        "organizationAuthorized",
        "freshDestination",
        "schemaIdentity",
        "bulkCursorResumed",
        "tailTransactionOrder",
        "fenceActivated",
        "cutoverActivated",
        "sourceDrained",
    ]) {
        if (correctness[flag] !== true) throw new Error(`${label}.${flag} did not pass`);
    }

    const expectedTailBody = `captured body ${RESHARD_BENCHMARK_PROFILE.capture.transactionGroups - 1}`;
    exactKeys(correctness.tailOrder, `${label}.tailOrder`, [
        "sentinelId",
        "expectedFinalBody",
        "sourceBeforeDrain",
        "destinationAfterReplay",
        "destinationAfterRestart",
    ]);
    if (
        correctness.tailOrder.sentinelId !== "child-0000" ||
        correctness.tailOrder.expectedFinalBody !== expectedTailBody ||
        correctness.tailOrder.sourceBeforeDrain !== expectedTailBody ||
        correctness.tailOrder.destinationAfterReplay !== expectedTailBody ||
        correctness.tailOrder.destinationAfterRestart !== expectedTailBody
    ) {
        throw new Error(`${label}.tailOrder did not prove ordered transaction replay`);
    }

    exactKeys(correctness.staleRoute, `${label}.staleRoute`, [
        "typedError",
        "attempts",
        "sameMutationId",
        "committedOnce",
    ]);
    if (
        correctness.staleRoute.typedError !== "CDB_STALE_EPOCH" ||
        correctness.staleRoute.attempts !== RESHARD_BENCHMARK_PROFILE.routing.staleRouteRetries + 1 ||
        correctness.staleRoute.sameMutationId !== true ||
        correctness.staleRoute.committedOnce !== true
    ) {
        throw new Error(`${label}.staleRoute did not prove the exact one-retry contract`);
    }

    exactKeys(correctness.live, `${label}.live`, ["reason", "mustRefetch", "snapshotConverged"]);
    if (
        correctness.live.reason !== RESHARD_BENCHMARK_PROFILE.routing.liveReason ||
        correctness.live.mustRefetch !== true ||
        correctness.live.snapshotConverged !== true
    ) {
        throw new Error(`${label}.live did not prove shardsChanged recovery`);
    }

    exactKeys(correctness.restart, `${label}.restart`, [
        "phase",
        "afterAppliedBatches",
        "coldProcess",
        "cursorPersisted",
        "resumed",
        "noDuplicateRows",
    ]);
    if (
        correctness.restart.phase !== RESHARD_BENCHMARK_PROFILE.restart.phase ||
        correctness.restart.afterAppliedBatches !== RESHARD_BENCHMARK_PROFILE.restart.afterAppliedBatches ||
        correctness.restart.coldProcess !== true ||
        correctness.restart.cursorPersisted !== true ||
        correctness.restart.resumed !== true ||
        correctness.restart.noDuplicateRows !== true
    ) {
        throw new Error(`${label}.restart did not prove the fixed resume point`);
    }

    exactKeys(correctness.digests, `${label}.digests`, [
        "algorithm",
        "canonicalEncoding",
        "sourceBeforeDrain",
        "destinationAfterCutover",
        "destinationAfterRestart",
    ]);
    if (correctness.digests.algorithm !== "sha256" || correctness.digests.canonicalEncoding !== "table-pk-json-v1") {
        throw new Error(`${label}.digests identity is invalid`);
    }
    for (const field of ["sourceBeforeDrain", "destinationAfterCutover", "destinationAfterRestart"]) {
        digest(correctness.digests[field], `${label}.digests.${field}`);
    }
    if (
        correctness.digests.sourceBeforeDrain !== correctness.digests.destinationAfterCutover ||
        correctness.digests.destinationAfterCutover !== correctness.digests.destinationAfterRestart
    ) {
        throw new Error(`${label}.digests do not converge`);
    }
}

export function assertReshardBenchmarkSample(input, expected = {}) {
    const sample = object(input, "reshard benchmark sample");
    exactKeys(sample, "reshard benchmark sample", EXACT_SAMPLE_KEYS);
    if (sample.schema !== RESHARD_BENCHMARK_SAMPLE_SCHEMA)
        throw new Error(`expected ${RESHARD_BENCHMARK_SAMPLE_SCHEMA}`);
    integer(sample.sequence, "sample.sequence", -1);
    if (sample.excluded !== (sample.sequence === -1))
        throw new Error("sample.excluded must identify only the warmup run");
    digest(sample.candidateSha256, "sample.candidateSha256");
    exactKeys(sample.workload, "sample.workload", ["id", "version", "profile"]);
    if (
        sample.workload.id !== RESHARD_BENCHMARK_WORKLOAD_ID ||
        sample.workload.version !== RESHARD_BENCHMARK_WORKLOAD_VERSION ||
        JSON.stringify(sample.workload.profile) !== JSON.stringify(RESHARD_BENCHMARK_PROFILE)
    ) {
        throw new Error("sample workload identity drifted");
    }
    assertTarget(sample.target, "sample.target");
    assertExecution(sample.execution, "sample.execution");
    assertTiming(sample.timing, "sample.timing");
    assertMovement(sample.movement, "sample.movement");
    assertCorrectness(sample.correctness, "sample.correctness");
    if (expected.sequence !== undefined && sample.sequence !== expected.sequence)
        throw new Error("sample sequence drifted");
    if (expected.candidateSha256 !== undefined && sample.candidateSha256 !== expected.candidateSha256) {
        throw new Error("sample candidate drifted");
    }
    if (expected.target !== undefined && JSON.stringify(sample.target) !== JSON.stringify(expected.target)) {
        throw new Error("sample target drifted");
    }
    return sample;
}

function percentile(sorted, quantile) {
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function distribution(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return {
        raw: [...values],
        min: sorted[0],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1),
    };
}

export function summarizeReshardBenchmarkSamples(samples) {
    if (!Array.isArray(samples) || samples.length !== RESHARD_BENCHMARK_PROFILE.logicalRuns) {
        throw new Error(`samples must contain ${RESHARD_BENCHMARK_PROFILE.logicalRuns} measured runs`);
    }
    samples.forEach((sample, sequence) => assertReshardBenchmarkSample(sample, { sequence }));
    const phaseMs = Object.fromEntries(
        RESHARD_BENCHMARK_PHASES.map(phase => [
            phase,
            distribution(samples.map(sample => sample.timing.phasesMs[phase])),
        ])
    );
    const totals = {
        elapsedMs: samples.reduce((sum, sample) => sum + sample.timing.totalMs, 0),
        bulkRows: samples.reduce((sum, sample) => sum + sample.movement.bulk.rows, 0),
        bulkBytes: samples.reduce((sum, sample) => sum + sample.movement.bulk.bytes, 0),
        capturedTransactionGroups: samples.reduce((sum, sample) => sum + sample.movement.capture.transactionGroups, 0),
        replayedEntries: samples.reduce((sum, sample) => sum + sample.movement.replay.entries, 0),
        drainedRows: samples.reduce((sum, sample) => sum + sample.movement.drain.rows, 0),
    };
    const bulkMs = samples.reduce((sum, sample) => sum + sample.timing.phasesMs.bulk, 0);
    const replayMs = samples.reduce((sum, sample) => sum + sample.timing.phasesMs.replay, 0);
    const drainMs = samples.reduce((sum, sample) => sum + sample.timing.phasesMs.drain, 0);
    return {
        timing: { totalMs: distribution(samples.map(sample => sample.timing.totalMs)), phasesMs: phaseMs },
        totals,
        rates: {
            bulkRowsPerSecond: (totals.bulkRows * 1_000) / bulkMs,
            bulkBytesPerSecond: (totals.bulkBytes * 1_000) / bulkMs,
            replayEntriesPerSecond: (totals.replayedEntries * 1_000) / replayMs,
            drainRowsPerSecond: (totals.drainedRows * 1_000) / drainMs,
        },
    };
}

function approximatelyEqual(left, right) {
    return Math.abs(left - right) <= Math.max(1, Math.abs(right)) * 1e-9;
}

function assertAggregate(actual, samples) {
    const expected = summarizeReshardBenchmarkSamples(samples);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    for (const field of ["bulkRowsPerSecond", "bulkBytesPerSecond", "replayEntriesPerSecond", "drainRowsPerSecond"]) {
        if (!approximatelyEqual(actual?.rates?.[field], expected.rates[field]))
            throw new Error(`aggregate.rates.${field} drifted`);
    }
    throw new Error("aggregate does not match admitted raw samples");
}

export function assertReshardBenchmarkReport(input) {
    const report = object(input, "reshard benchmark report");
    exactKeys(report, "reshard benchmark report", [
        "schema",
        "ok",
        "candidate",
        "workload",
        "target",
        "runner",
        "execution",
        "warmup",
        "samples",
        "aggregate",
    ]);
    if (report.schema !== RESHARD_BENCHMARK_SCHEMA) throw new Error(`expected ${RESHARD_BENCHMARK_SCHEMA}`);
    if (report.ok !== true) throw new Error("reshard benchmark report did not complete successfully");
    exactKeys(report.candidate, "candidate", ["sha256", "bytes"]);
    digest(report.candidate.sha256, "candidate.sha256");
    integer(report.candidate.bytes, "candidate.bytes", 1);
    exactKeys(report.workload, "workload", ["id", "version", "profile"]);
    if (
        report.workload.id !== RESHARD_BENCHMARK_WORKLOAD_ID ||
        report.workload.version !== RESHARD_BENCHMARK_WORKLOAD_VERSION ||
        JSON.stringify(report.workload.profile) !== JSON.stringify(RESHARD_BENCHMARK_PROFILE)
    ) {
        throw new Error("report workload identity drifted");
    }
    assertTarget(report.target, "target");
    exactKeys(report.runner, "runner", ["runtime", "machine", "processIsolation"]);
    exactKeys(report.runner.runtime, "runner.runtime", ["name", "version"]);
    nonempty(report.runner.runtime.name, "runner.runtime.name");
    nonempty(report.runner.runtime.version, "runner.runtime.version");
    exactKeys(report.runner.machine, "runner.machine", [
        "platform",
        "architecture",
        "osRelease",
        "cpuModel",
        "logicalCpuCount",
        "memoryBytes",
    ]);
    for (const field of ["platform", "architecture", "osRelease", "cpuModel"])
        nonempty(report.runner.machine[field], `runner.machine.${field}`);
    integer(report.runner.machine.logicalCpuCount, "runner.machine.logicalCpuCount", 1);
    integer(report.runner.machine.memoryBytes, "runner.machine.memoryBytes", 1);
    if (report.runner.processIsolation !== "fresh-process-per-run")
        throw new Error("runner.processIsolation is invalid");
    assertExecution(report.execution, "execution");
    assertReshardBenchmarkSample(report.warmup, {
        sequence: -1,
        candidateSha256: report.candidate.sha256,
        target: report.target,
    });
    if (!Array.isArray(report.samples) || report.samples.length !== RESHARD_BENCHMARK_PROFILE.logicalRuns) {
        throw new Error(`samples must contain ${RESHARD_BENCHMARK_PROFILE.logicalRuns} measured runs`);
    }
    const processIds = new Set([report.warmup.execution.processId]);
    report.samples.forEach((sample, sequence) => {
        assertReshardBenchmarkSample(sample, {
            sequence,
            candidateSha256: report.candidate.sha256,
            target: report.target,
        });
        processIds.add(sample.execution.processId);
    });
    if (processIds.size !== RESHARD_BENCHMARK_PROFILE.logicalRuns + RESHARD_BENCHMARK_PROFILE.warmupRuns) {
        throw new Error("each benchmark run must come from a fresh process");
    }
    assertAggregate(report.aggregate, report.samples);
    return report;
}

export function createReshardBenchmarkReport(input) {
    return assertReshardBenchmarkReport({ ...structuredClone(input), schema: RESHARD_BENCHMARK_SCHEMA });
}
