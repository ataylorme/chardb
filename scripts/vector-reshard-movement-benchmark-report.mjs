export const VECTOR_RESHARD_MOVEMENT_BENCHMARK_SCHEMA = "chardb.vector-reshard-movement-benchmark.v1";

const REQUIRED_INVARIANTS = Object.freeze([
    "snapshotExact",
    "tailConverged",
    "parityExact",
    "coldRestartResumed",
    "destinationGuardsRestored",
    "sourceDrained",
    "destinationServing",
    "staleSourceRejected",
    "abortRestored",
]);

const REPORT_KEYS = Object.freeze([
    "schema",
    "workload",
    "target",
    "timing",
    "pages",
    "turns",
    "losses",
    "restart",
    "externalVectorize",
    "abort",
    "correctness",
    "scope",
]);

function invalid(message) {
    throw new TypeError(`vector movement benchmark: ${message}`);
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

function exactInteger(value, subject, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) invalid(`${subject} is invalid`);
    return value;
}

function exactNumber(value, subject) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(`${subject} is invalid`);
    return value;
}

export function assertVectorReshardMovementBenchmarkReport(value) {
    exactKeys(value, "report", REPORT_KEYS);
    if (value.schema !== VECTOR_RESHARD_MOVEMENT_BENCHMARK_SCHEMA) invalid("schema is invalid");
    const workload = value.workload;
    exactKeys(workload, "workload", [
        "domainRows",
        "heads",
        "outboxRows",
        "attemptRows",
        "snapshotRecords",
        "pageLimit",
    ]);
    for (const field of ["domainRows", "heads", "outboxRows", "attemptRows", "snapshotRecords", "pageLimit"]) {
        exactInteger(workload[field], `workload.${field}`, 1);
    }
    if (
        workload.domainRows !== workload.heads ||
        workload.heads !== workload.outboxRows ||
        workload.outboxRows !== workload.attemptRows ||
        workload.snapshotRecords !== workload.heads + workload.outboxRows + workload.attemptRows ||
        workload.domainRows !== 501 ||
        workload.pageLimit !== 500
    ) {
        invalid("workload does not prove the 500/501 boundary");
    }

    exactKeys(value.target, "target", ["runtime", "driver", "durableObjects", "sqlite"]);
    if (
        value.target.runtime !== "workerd" ||
        value.target.driver !== "miniflare" ||
        value.target.durableObjects !== true ||
        value.target.sqlite !== true
    ) {
        invalid("target is invalid");
    }

    exactKeys(value.timing, "timing", ["bulkMs", "cutoverMs", "drainMs", "totalMs"]);
    for (const phase of ["bulkMs", "cutoverMs", "drainMs", "totalMs"]) {
        exactNumber(value.timing[phase], `timing.${phase}`);
    }
    if (value.timing.totalMs < value.timing.bulkMs + value.timing.cutoverMs + value.timing.drainMs) {
        invalid("timing.totalMs is shorter than its measured phases");
    }

    exactKeys(value.pages, "pages", ["copy", "parity"]);
    const minimumPages =
        Math.ceil(workload.heads / workload.pageLimit) +
        Math.ceil(workload.outboxRows / workload.pageLimit) +
        Math.ceil(workload.attemptRows / workload.pageLimit);
    for (const field of ["copy", "parity"]) {
        if (exactInteger(value.pages[field], `pages.${field}`, 1) < minimumPages) {
            invalid(`pages.${field} does not cover each record lane`);
        }
    }

    exactKeys(value.turns, "turns", ["bulk", "cutover", "drain", "snapshotLoss", "finalizeLoss", "drainLoss"]);
    for (const field of ["bulk", "cutover", "drain", "snapshotLoss", "finalizeLoss", "drainLoss"]) {
        exactInteger(value.turns[field], `turns.${field}`, 1);
    }
    const losses = value.losses;
    if (!Array.isArray(losses) || losses.length !== 3) {
        invalid("committed response-loss coverage is incomplete");
    }
    losses.forEach((loss, index) => exactKeys(loss, `losses[${index}]`, ["operation", "committed", "retried"]));
    if (
        losses.map(loss => loss.operation).join(",") !== "apply_snapshot,finalize_dest,drain_source" ||
        losses.some(loss => loss.committed !== true || loss.retried !== true)
    ) {
        invalid("committed response-loss coverage is incomplete");
    }

    exactKeys(value.restart, "restart", [
        "afterVectorBegin",
        "beforeRelationalBulkComplete",
        "destinationGuardsStayedUninstalled",
    ]);
    if (
        value.restart.afterVectorBegin !== true ||
        value.restart.beforeRelationalBulkComplete !== true ||
        value.restart.destinationGuardsStayedUninstalled !== true
    ) {
        invalid("cold restart proof is incomplete");
    }

    exactKeys(value.externalVectorize, "externalVectorize", ["movementCalls"]);
    if (value.externalVectorize.movementCalls !== 0) invalid("metadata movement called Vectorize");

    exactKeys(value.abort, "abort", ["completed", "turns", "externalVectorizeCalls"]);
    if (
        value.abort.completed !== true ||
        value.abort.externalVectorizeCalls !== 0 ||
        exactInteger(value.abort.turns, "abort.turns", 1) < 1
    ) {
        invalid("abort proof is incomplete");
    }

    exactKeys(value.correctness, "correctness", REQUIRED_INVARIANTS);
    for (const invariant of REQUIRED_INVARIANTS) {
        if (value.correctness[invariant] !== true) invalid(`correctness.${invariant} is not proven`);
    }

    exactKeys(value.scope, "scope", ["movementComplete"]);
    if (value.scope.movementComplete !== true) invalid("scope does not claim complete movement");
    return value;
}

export function createVectorReshardMovementBenchmarkReport(input) {
    const report = {
        schema: VECTOR_RESHARD_MOVEMENT_BENCHMARK_SCHEMA,
        workload: { ...input.workload },
        target: {
            runtime: "workerd",
            driver: "miniflare",
            durableObjects: true,
            sqlite: true,
        },
        timing: { ...input.timing },
        pages: { ...input.pages },
        turns: { ...input.turns },
        losses: input.losses.map(loss => ({ ...loss })),
        restart: { ...input.restart },
        externalVectorize: { ...input.externalVectorize },
        abort: { ...input.abort },
        correctness: { ...input.correctness },
        scope: { movementComplete: true },
    };
    return assertVectorReshardMovementBenchmarkReport(report);
}
