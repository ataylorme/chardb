export const VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA = "chardb.vector-reshard-snapshot-benchmark.v1";

function object(value, subject) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${subject} must be an object`);
    }
    return value;
}

function finiteNonnegative(value, subject) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${subject} must be a finite nonnegative number`);
    }
}

function exactKeys(value, subject, keys) {
    const actual = Object.keys(object(value, subject)).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${subject} has unexpected keys`);
    }
}

function assertMeasurement(value, subject) {
    exactKeys(value, subject, ["name", "expected", "observed", "exactOnce", "pages", "timings"]);
    const measurement = value;
    if (typeof measurement.name !== "string" || measurement.name.length === 0) {
        throw new Error(`${subject}.name must be a nonempty string`);
    }
    for (const countsName of ["expected", "observed"]) {
        exactKeys(measurement[countsName], `${subject}.${countsName}`, ["head", "outbox", "attempt", "total"]);
        for (const [name, count] of Object.entries(measurement[countsName])) {
            if (!Number.isSafeInteger(count) || count < 0)
                throw new Error(`${subject}.${countsName}.${name} is invalid`);
        }
    }
    exactKeys(measurement.exactOnce, `${subject}.exactOnce`, [
        "expectedTotal",
        "observedTotal",
        "uniqueRecords",
        "duplicateRecords",
        "countsMatch",
    ]);
    for (const name of ["expectedTotal", "observedTotal", "uniqueRecords", "duplicateRecords"]) {
        const count = measurement.exactOnce[name];
        if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${subject}.exactOnce.${name} is invalid`);
    }
    if (typeof measurement.exactOnce.countsMatch !== "boolean") {
        throw new Error(`${subject}.exactOnce.countsMatch must be boolean`);
    }
    exactKeys(measurement.pages, `${subject}.pages`, [
        "readCalls",
        "nonemptyPages",
        "recordPageSizes",
        "encodedPageBytes",
        "peakEncodedPageBytes",
    ]);
    for (const name of ["readCalls", "nonemptyPages", "peakEncodedPageBytes"]) {
        const count = measurement.pages[name];
        if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${subject}.pages.${name} is invalid`);
    }
    for (const name of ["recordPageSizes", "encodedPageBytes"]) {
        if (!Array.isArray(measurement.pages[name])) throw new Error(`${subject}.pages.${name} must be an array`);
        for (const count of measurement.pages[name]) {
            if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${subject}.pages.${name} is invalid`);
        }
    }
    if (
        measurement.pages.readCalls !== measurement.pages.encodedPageBytes.length ||
        measurement.pages.nonemptyPages !== measurement.pages.recordPageSizes.length ||
        measurement.pages.peakEncodedPageBytes !== Math.max(...measurement.pages.encodedPageBytes)
    ) {
        throw new Error(`${subject}.pages summary does not match its raw samples`);
    }
    exactKeys(measurement.timings, `${subject}.timings`, ["seedMs", "totalPageMs", "worstPageMs", "pageMs"]);
    for (const name of ["seedMs", "totalPageMs", "worstPageMs"]) {
        finiteNonnegative(measurement.timings[name], `${subject}.timings.${name}`);
    }
    if (!Array.isArray(measurement.timings.pageMs)) throw new Error(`${subject}.timings.pageMs must be an array`);
    for (const elapsed of measurement.timings.pageMs) finiteNonnegative(elapsed, `${subject}.timings.pageMs`);
    if (
        measurement.timings.pageMs.length !== measurement.pages.readCalls ||
        measurement.timings.worstPageMs !== Math.max(...measurement.timings.pageMs)
    ) {
        throw new Error(`${subject}.timings summary does not match its raw samples`);
    }
}

function assertPlan(value, subject) {
    exactKeys(value, subject, ["details", "usesTempSort"]);
    if (!Array.isArray(value.details) || value.details.some(detail => typeof detail !== "string")) {
        throw new Error(`${subject}.details must contain strings`);
    }
    if (typeof value.usesTempSort !== "boolean") throw new Error(`${subject}.usesTempSort must be boolean`);
    const observed = value.details.some(detail => detail.includes("TEMP B-TREE"));
    if (observed !== value.usesTempSort) throw new Error(`${subject}.usesTempSort does not match its plan`);
}

export function assertVectorReshardSnapshotBenchmarkReport(value) {
    exactKeys(value, "vector reshard snapshot benchmark", [
        "schema",
        "environment",
        "limits",
        "profile",
        "scenarios",
        "queryPlans",
        "scope",
    ]);
    const report = value;
    if (report.schema !== VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA) {
        throw new Error("vector reshard snapshot benchmark schema is invalid");
    }
    exactKeys(report.environment, "environment", ["bun", "sqlite"]);
    if (typeof report.environment.bun !== "string" || typeof report.environment.sqlite !== "string") {
        throw new Error("benchmark environment is invalid");
    }
    exactKeys(report.limits, "limits", [
        "pageRows",
        "pageBytes",
        "maxHeads",
        "maxAttemptVersionsPerHead",
        "maxAttemptRows",
    ]);
    exactKeys(report.profile, "profile", [
        "paginationHeadCounts",
        "bytePressureHeads",
        "attemptVersions",
        "scaleHeads",
        "lateCursorRemaining",
    ]);
    if (JSON.stringify(report.profile.paginationHeadCounts) !== JSON.stringify([500, 501, 1_001])) {
        throw new Error("pagination identity profile is invalid");
    }
    for (const [name, limit] of Object.entries(report.limits)) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`limits.${name} is invalid`);
    }
    for (const name of ["bytePressureHeads", "attemptVersions", "scaleHeads", "lateCursorRemaining"]) {
        if (!Number.isSafeInteger(report.profile[name]) || report.profile[name] < 1) {
            throw new Error(`profile.${name} is invalid`);
        }
    }
    exactKeys(report.scenarios, "scenarios", ["pagination", "bytePressure", "attemptSkew", "scale", "lateCursors"]);
    if (!Array.isArray(report.scenarios.pagination) || report.scenarios.pagination.length !== 3) {
        throw new Error("pagination scenarios are invalid");
    }
    for (const [index, measurement] of report.scenarios.pagination.entries()) {
        assertMeasurement(measurement, `scenarios.pagination[${index}]`);
    }
    assertMeasurement(report.scenarios.bytePressure, "scenarios.bytePressure");
    assertMeasurement(report.scenarios.attemptSkew, "scenarios.attemptSkew");
    assertMeasurement(report.scenarios.scale, "scenarios.scale");
    exactKeys(report.scenarios.lateCursors, "scenarios.lateCursors", ["head", "attempt"]);
    assertMeasurement(report.scenarios.lateCursors.head, "scenarios.lateCursors.head");
    assertMeasurement(report.scenarios.lateCursors.attempt, "scenarios.lateCursors.attempt");
    exactKeys(report.queryPlans, "queryPlans", [
        "headStart",
        "headLate",
        "outboxStart",
        "attemptStart",
        "attemptLate",
        "anyTempSort",
    ]);
    for (const name of ["headStart", "headLate", "outboxStart", "attemptStart", "attemptLate"]) {
        assertPlan(report.queryPlans[name], `queryPlans.${name}`);
    }
    if (typeof report.queryPlans.anyTempSort !== "boolean") throw new Error("queryPlans.anyTempSort must be boolean");
    const observedTempSort = ["headStart", "headLate", "outboxStart", "attemptStart", "attemptLate"].some(
        name => report.queryPlans[name].usesTempSort
    );
    if (observedTempSort !== report.queryPlans.anyTempSort) {
        throw new Error("queryPlans.anyTempSort does not match the recorded plans");
    }
    exactKeys(report.scope, "scope", [
        "localSQLiteOnly",
        "includesSeedingInPageTimings",
        "includesTailCapture",
        "includesDestinationApply",
        "includesCutover",
        "movementComplete",
        "description",
    ]);
    if (
        report.scope.localSQLiteOnly !== true ||
        report.scope.includesSeedingInPageTimings !== false ||
        report.scope.includesTailCapture !== false ||
        report.scope.includesDestinationApply !== false ||
        report.scope.includesCutover !== false ||
        report.scope.movementComplete !== false ||
        typeof report.scope.description !== "string"
    ) {
        throw new Error("benchmark scope overclaims what the producer measures");
    }
    return report;
}
