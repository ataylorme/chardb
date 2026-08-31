import { Database } from "bun:sqlite";
import { CDB_RESHARD_IDENTITY_STORE_DDL } from "../src/server/do/cdb-reshard-identity-store.ts";
import { CDB_RESHARD_MAX_BATCH_BYTES } from "../src/server/do/cdb-reshard-relational.ts";
import {
    CDB_VECTOR_MAX_ATTEMPT_ROWS,
    CDB_VECTOR_MAX_ATTEMPT_VERSIONS,
    CDB_VECTOR_MAX_DIMENSIONS,
    CDB_VECTOR_MAX_HEADS,
    CDB_VECTOR_MAX_METADATA_BYTES,
    initializeCdbVectorOutboxStore,
} from "../src/server/do/cdb-vector-outbox-store.ts";
import {
    CDB_VECTOR_RESHARD_PAGE_SIZE,
    CdbVectorReshardSnapshotReader,
    encodeCdbVectorReshardPage,
} from "../src/server/do/cdb-vector-reshard-records.ts";
import { vshardOf } from "../src/vshard.ts";
import {
    VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA,
    assertVectorReshardSnapshotBenchmarkReport,
} from "./vector-reshard-snapshot-benchmark-report.mjs";

const IDENTITY = Object.freeze({ migId: "vector_snapshot_benchmark_1", rangeLo: 0, rangeHi: 16_383 });
const ORGANIZATION_ID = "vector-snapshot-benchmark-org";
const PLACEMENT = Number(vshardOf([ORGANIZATION_ID]));
const RESOURCE_ID = "vector-snapshot-benchmark-resource";
const SMALL_VALUES = new Uint8Array(new Float32Array([0.25]).buffer);
const PAGINATION_HEAD_COUNTS = Object.freeze([500, 501, 1_001]);
const BYTE_PRESSURE_HEADS = 50;
const LATE_CURSOR_REMAINING = 5;
const DEFAULT_SCALE_HEADS = 8_192;

function syncSql(db) {
    return {
        exec(query, ...params) {
            db.run(query, params);
        },
        one(query, ...params) {
            return db.query(query).get(...params) ?? null;
        },
        all(query, ...params) {
            return db.query(query).all(...params);
        },
        changes() {
            return Number(db.query("SELECT changes() AS count").get().count);
        },
    };
}

function initialize() {
    const db = new Database(":memory:");
    db.exec(CDB_RESHARD_IDENTITY_STORE_DDL);
    const sql = syncSql(db);
    initializeCdbVectorOutboxStore(sql);
    db.run(
        `INSERT INTO _chardb_split_identity
           (mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json, created_at)
         VALUES (?, ?, ?, 'source', 0, 1, ?, '[]', 0)`,
        [IDENTITY.migId, IDENTITY.rangeLo, IDENTITY.rangeHi, "a".repeat(64)]
    );
    return { db, reader: new CdbVectorReshardSnapshotReader(sql) };
}

function environment() {
    const db = new Database(":memory:");
    try {
        return Object.freeze({
            bun: Bun.version,
            sqlite: String(db.query("SELECT sqlite_version() AS version").get().version),
        });
    } finally {
        db.close();
    }
}

function vectorId(index, prefix = "snapshot-vector") {
    return `${prefix}-${String(index).padStart(6, "0")}`;
}

function seedHeads(db, count, options = {}) {
    const values = options.values ?? SMALL_VALUES;
    const dimensions = options.dimensions ?? 1;
    const metadata = options.metadata ?? "{}";
    const state = options.state ?? "ready";
    const version = options.version ?? 1;
    const deliveredVersion = state === "ready" ? version : 0;
    const prefix = options.prefix ?? "snapshot-vector";
    const statement = db.prepare(
        `INSERT INTO _chardb_vectors
           (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions, version,
            delivered_version, values_enc, metadata_json, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
        for (let index = 0; index < count; index++) {
            statement.run(
                vectorId(index, prefix),
                index + 1,
                ORGANIZATION_ID,
                PLACEMENT,
                RESOURCE_ID,
                `row-${index}`,
                dimensions,
                version,
                deliveredVersion,
                values,
                metadata,
                state,
                index
            );
        }
    })();
}

function seedAttempts(db, count) {
    seedHeads(db, 1, { prefix: "attempt-vector", state: "pending", version: count });
    const statement = db.prepare(
        `INSERT INTO _chardb_vector_attempts
           (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed,
            response_ambiguous, delete_confirmed, delete_claim_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    );
    const id = vectorId(0, "attempt-vector");
    db.transaction(() => {
        for (let version = 1; version <= count; version++) {
            statement.run(id, version, version, version + 1, version % 2, version % 3 === 0 ? 1 : 0, 0);
        }
    })();
}

function recordKey(record) {
    return record.kind === "attempt"
        ? `${record.kind}:${record.vectorId}:${record.physicalVersion}`
        : `${record.kind}:${record.vectorId}`;
}

function countKinds(records) {
    const counts = { head: 0, outbox: 0, attempt: 0, total: records.length };
    for (const record of records) counts[record.kind]++;
    return Object.freeze(counts);
}

function measureSnapshot(reader, cursor, expected, name, seedMs) {
    const records = [];
    const recordPageSizes = [];
    const encodedPageBytes = [];
    const pageMs = [];
    let current = cursor;
    for (let readCall = 0; readCall < 1_000_000; readCall++) {
        const started = performance.now();
        const page = reader.read(IDENTITY, current);
        const encoded = encodeCdbVectorReshardPage(page);
        const elapsed = performance.now() - started;
        pageMs.push(elapsed);
        encodedPageBytes.push(Buffer.byteLength(encoded, "utf8"));
        if (page.records.length > 0) recordPageSizes.push(page.records.length);
        records.push(...page.records);
        if (page.done) break;
        current = page.next;
        if (readCall === 999_999) throw new Error(`${name} did not complete within its read bound`);
    }
    const keys = records.map(recordKey);
    const uniqueRecords = new Set(keys).size;
    const observed = countKinds(records);
    const expectedTotal = expected.head + expected.outbox + expected.attempt;
    const countsMatch =
        observed.head === expected.head &&
        observed.outbox === expected.outbox &&
        observed.attempt === expected.attempt &&
        observed.total === expectedTotal;
    return Object.freeze({
        name,
        expected: Object.freeze({ ...expected, total: expectedTotal }),
        observed,
        exactOnce: Object.freeze({
            expectedTotal,
            observedTotal: records.length,
            uniqueRecords,
            duplicateRecords: records.length - uniqueRecords,
            countsMatch,
        }),
        pages: Object.freeze({
            readCalls: pageMs.length,
            nonemptyPages: recordPageSizes.length,
            recordPageSizes: Object.freeze(recordPageSizes),
            encodedPageBytes: Object.freeze(encodedPageBytes),
            peakEncodedPageBytes: Math.max(...encodedPageBytes),
        }),
        timings: Object.freeze({
            seedMs,
            totalPageMs: pageMs.reduce((sum, elapsed) => sum + elapsed, 0),
            worstPageMs: Math.max(...pageMs),
            pageMs: Object.freeze(pageMs),
        }),
    });
}

function measuredSeed(invoke) {
    const started = performance.now();
    invoke();
    return performance.now() - started;
}

function paginationScenario(heads) {
    const { db, reader } = initialize();
    try {
        const seedMs = measuredSeed(() => seedHeads(db, heads, { prefix: `pagination-${heads}` }));
        return measureSnapshot(
            reader,
            reader.begin(IDENTITY),
            { head: heads, outbox: 0, attempt: 0 },
            `pagination-${heads}`,
            seedMs
        );
    } finally {
        db.close();
    }
}

function bytePressureScenario() {
    const { db, reader } = initialize();
    try {
        const values = new Uint8Array(CDB_VECTOR_MAX_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT);
        const view = new DataView(values.buffer);
        for (let index = 0; index < CDB_VECTOR_MAX_DIMENSIONS; index++) view.setFloat32(index * 4, index / 10, true);
        const metadata = `{"body":"${"m".repeat(CDB_VECTOR_MAX_METADATA_BYTES - 11)}"}`;
        const seedMs = measuredSeed(() =>
            seedHeads(db, BYTE_PRESSURE_HEADS, {
                prefix: "byte-pressure",
                values,
                dimensions: CDB_VECTOR_MAX_DIMENSIONS,
                metadata,
            })
        );
        return measureSnapshot(
            reader,
            reader.begin(IDENTITY),
            { head: BYTE_PRESSURE_HEADS, outbox: 0, attempt: 0 },
            "maximum-row-byte-pressure",
            seedMs
        );
    } finally {
        db.close();
    }
}

function plan(db, query, params) {
    const details = Object.freeze(
        db
            .query(`EXPLAIN QUERY PLAN ${query}`)
            .all(...params)
            .map(row => String(row.detail))
    );
    return Object.freeze({ details, usesTempSort: details.some(detail => detail.includes("TEMP B-TREE")) });
}

function queryPlans(db, throughHeadSeq, scaleHeads) {
    const afterLateHead = vectorId(Math.max(0, scaleHeads - LATE_CURSOR_REMAINING - 1), "scale-vector");
    const attemptId = vectorId(0, "attempt-vector");
    const headSql = `SELECT * FROM _chardb_vectors
        WHERE created_seq <= ? AND placement_vshard BETWEEN ? AND ?
          AND (placement_vshard > ? OR (placement_vshard = ? AND vector_id > ?))
        ORDER BY placement_vshard, vector_id LIMIT ?`;
    const outboxSql = `SELECT head.vector_id, head.organization_id, head.placement_vshard, head.resource_id,
        head.version AS head_version, head.state AS head_state, outbox.*
        FROM _chardb_vector_outbox AS outbox
        INNER JOIN _chardb_vectors AS head ON head.vector_id = outbox.vector_id
        WHERE head.created_seq <= ? AND head.placement_vshard BETWEEN ? AND ?
          AND (head.placement_vshard > ? OR (head.placement_vshard = ? AND head.vector_id > ?))
        ORDER BY head.placement_vshard, head.vector_id LIMIT ?`;
    const attemptSql = `SELECT head.vector_id, head.organization_id, head.placement_vshard, head.resource_id,
        head.version AS head_version, attempt.*
        FROM _chardb_vector_attempts AS attempt
        INNER JOIN _chardb_vectors AS head ON head.vector_id = attempt.vector_id
        WHERE head.created_seq <= ? AND head.placement_vshard BETWEEN ? AND ?
          AND (head.placement_vshard > ? OR
               (head.placement_vshard = ? AND
                (head.vector_id > ? OR (head.vector_id = ? AND attempt.physical_version > ?))))
        ORDER BY head.placement_vshard, head.vector_id, attempt.physical_version LIMIT ?`;
    const headStart = plan(db, headSql, [throughHeadSeq, 0, 16_383, -1, -1, "", CDB_VECTOR_RESHARD_PAGE_SIZE + 1]);
    const headLate = plan(db, headSql, [
        throughHeadSeq,
        0,
        16_383,
        PLACEMENT,
        PLACEMENT,
        afterLateHead,
        CDB_VECTOR_RESHARD_PAGE_SIZE + 1,
    ]);
    const outboxStart = plan(db, outboxSql, [throughHeadSeq, 0, 16_383, -1, -1, "", CDB_VECTOR_RESHARD_PAGE_SIZE + 1]);
    const attemptStart = plan(db, attemptSql, [
        throughHeadSeq,
        0,
        16_383,
        -1,
        -1,
        "",
        "",
        0,
        CDB_VECTOR_RESHARD_PAGE_SIZE + 1,
    ]);
    const attemptLate = plan(db, attemptSql, [
        throughHeadSeq,
        0,
        16_383,
        PLACEMENT,
        PLACEMENT,
        attemptId,
        attemptId,
        CDB_VECTOR_MAX_ATTEMPT_VERSIONS - LATE_CURSOR_REMAINING,
        CDB_VECTOR_RESHARD_PAGE_SIZE + 1,
    ]);
    const named = { headStart, headLate, outboxStart, attemptStart, attemptLate };
    return Object.freeze({ ...named, anyTempSort: Object.values(named).some(value => value.usesTempSort) });
}

function attemptsAndPlansScenario(scaleHeads) {
    const { db, reader } = initialize();
    try {
        const scaleSeedMs = measuredSeed(() => seedHeads(db, scaleHeads, { prefix: "scale-vector" }));
        const scaleStart = reader.begin(IDENTITY);
        const scale = measureSnapshot(
            reader,
            scaleStart,
            { head: scaleHeads, outbox: 0, attempt: 0 },
            `scale-${scaleHeads}`,
            scaleSeedMs
        );
        const headLateCursor = Object.freeze({
            kind: "head",
            throughHeadSeq: scaleStart.throughHeadSeq,
            afterPlacement: PLACEMENT,
            afterVectorId: vectorId(scaleHeads - LATE_CURSOR_REMAINING - 1, "scale-vector"),
            afterPhysicalVersion: 0,
        });
        const lateHead = measureSnapshot(
            reader,
            headLateCursor,
            { head: LATE_CURSOR_REMAINING, outbox: 0, attempt: 0 },
            "late-head-cursor",
            0
        );

        db.run("DELETE FROM _chardb_vectors");
        const attemptSeedMs = measuredSeed(() => seedAttempts(db, CDB_VECTOR_MAX_ATTEMPT_VERSIONS));
        const attemptStart = reader.begin(IDENTITY);
        const attemptSkew = measureSnapshot(
            reader,
            attemptStart,
            { head: 1, outbox: 0, attempt: CDB_VECTOR_MAX_ATTEMPT_VERSIONS },
            "one-head-4096-attempt-skew",
            attemptSeedMs
        );
        const attemptId = vectorId(0, "attempt-vector");
        const lateAttempt = measureSnapshot(
            reader,
            Object.freeze({
                kind: "attempt",
                throughHeadSeq: attemptStart.throughHeadSeq,
                afterPlacement: PLACEMENT,
                afterVectorId: attemptId,
                afterPhysicalVersion: CDB_VECTOR_MAX_ATTEMPT_VERSIONS - LATE_CURSOR_REMAINING,
            }),
            { head: 0, outbox: 0, attempt: LATE_CURSOR_REMAINING },
            "late-attempt-cursor",
            0
        );
        const plans = queryPlans(db, attemptStart.throughHeadSeq, scaleHeads);
        return { scale, attemptSkew, lateHead, lateAttempt, plans };
    } finally {
        db.close();
    }
}

function parseScaleHeads(value) {
    const heads = Number(value);
    if (!Number.isSafeInteger(heads) || heads < LATE_CURSOR_REMAINING + 1 || heads > CDB_VECTOR_MAX_HEADS) {
        throw new Error(`scaleHeads must be between ${LATE_CURSOR_REMAINING + 1} and ${CDB_VECTOR_MAX_HEADS}`);
    }
    return heads;
}

export function parseVectorReshardSnapshotBenchmarkArgs(argv) {
    let scaleHeads = DEFAULT_SCALE_HEADS;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--scale-heads") {
            const value = argv[++index];
            if (value === undefined) throw new Error("--scale-heads requires a value");
            scaleHeads = parseScaleHeads(value);
            continue;
        }
        if (arg.startsWith("--scale-heads=")) {
            scaleHeads = parseScaleHeads(arg.slice("--scale-heads=".length));
            continue;
        }
        throw new Error(`unknown vector snapshot benchmark argument ${JSON.stringify(arg)}`);
    }
    return Object.freeze({ scaleHeads });
}

export function produceVectorReshardSnapshotBenchmark(options = {}) {
    const scaleHeads = parseScaleHeads(options.scaleHeads ?? DEFAULT_SCALE_HEADS);
    const pagination = PAGINATION_HEAD_COUNTS.map(paginationScenario);
    const bytePressure = bytePressureScenario();
    const combined = attemptsAndPlansScenario(scaleHeads);
    const report = Object.freeze({
        schema: VECTOR_RESHARD_SNAPSHOT_BENCHMARK_SCHEMA,
        environment: environment(),
        limits: Object.freeze({
            pageRows: CDB_VECTOR_RESHARD_PAGE_SIZE,
            pageBytes: CDB_RESHARD_MAX_BATCH_BYTES,
            maxHeads: CDB_VECTOR_MAX_HEADS,
            maxAttemptVersionsPerHead: CDB_VECTOR_MAX_ATTEMPT_VERSIONS,
            maxAttemptRows: CDB_VECTOR_MAX_ATTEMPT_ROWS,
        }),
        profile: Object.freeze({
            paginationHeadCounts: PAGINATION_HEAD_COUNTS,
            bytePressureHeads: BYTE_PRESSURE_HEADS,
            attemptVersions: CDB_VECTOR_MAX_ATTEMPT_VERSIONS,
            scaleHeads,
            lateCursorRemaining: LATE_CURSOR_REMAINING,
        }),
        scenarios: Object.freeze({
            pagination: Object.freeze(pagination),
            bytePressure,
            attemptSkew: combined.attemptSkew,
            scale: combined.scale,
            lateCursors: Object.freeze({ head: combined.lateHead, attempt: combined.lateAttempt }),
        }),
        queryPlans: combined.plans,
        scope: Object.freeze({
            localSQLiteOnly: true,
            includesSeedingInPageTimings: false,
            includesTailCapture: false,
            includesDestinationApply: false,
            includesCutover: false,
            movementComplete: false,
            description:
                "In-memory SQLite source snapshot reads and JSON page encoding only. This does not measure capture, transport, destination apply, drain, or cutover.",
        }),
    });
    return assertVectorReshardSnapshotBenchmarkReport(report);
}

if (import.meta.main) {
    const options = parseVectorReshardSnapshotBenchmarkArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(produceVectorReshardSnapshotBenchmark(options), null, 2)}\n`);
}
