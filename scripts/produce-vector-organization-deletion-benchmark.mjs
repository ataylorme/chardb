import { Database } from "bun:sqlite";
import { SPLIT_LOG_DDL } from "../src/oplog/schema.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../src/server/do/cdb-routing-fence-store.ts";
import {
    CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE,
    CDB_VECTOR_ORGANIZATION_PURGE_STATUS_SQL,
    CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT,
    CdbVectorOrganizationDeletionStore,
    initializeCdbVectorOrganizationDeletionStore,
} from "../src/server/do/cdb-vector-organization-deletion-store.ts";
import {
    CDB_VECTOR_MAX_ATTEMPT_ROWS,
    CDB_VECTOR_MAX_ATTEMPT_VERSIONS,
    CDB_VECTOR_MAX_DELETE_IDS,
    CDB_VECTOR_MAX_HEADS,
    CDB_VECTOR_UNCERTAIN_DELETE_RETRY_MS,
    initializeCdbVectorOutboxStore,
} from "../src/server/do/cdb-vector-outbox-store.ts";
import { vshardOf } from "../src/vshard.ts";
import {
    VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE,
    VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA,
    assertVectorOrganizationDeletionBenchmarkReport,
    deriveVectorOrganizationDeletionCapacityModel,
} from "./vector-organization-deletion-benchmark-report.mjs";

if (
    CDB_VECTOR_MAX_HEADS !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.productionLimits.heads ||
    CDB_VECTOR_MAX_ATTEMPT_ROWS !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.productionLimits.attemptRows ||
    CDB_VECTOR_MAX_ATTEMPT_VERSIONS !==
        VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.productionLimits.attemptVersionsPerHead ||
    CDB_VECTOR_MAX_DELETE_IDS !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.productionLimits.deleteIdsPerClaim ||
    CDB_VECTOR_UNCERTAIN_DELETE_RETRY_MS !==
        VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.productionLimits.uncertainDeleteRetryMs ||
    CDB_VECTOR_ORGANIZATION_UNPROVEN_TURN_LIMIT !==
        VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.productionLimits.unprovenTurnLimit
) {
    throw new Error("vector organization deletion benchmark production limits drifted");
}

const ORGANIZATION_ID = "vector-deletion-benchmark-org";
const RESOURCE_ID = "vector-deletion-benchmark-resource";
const INITIAL_VERSION = VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.initialVersion;
const VALUES = new Uint8Array(new Float32Array([0.25]).buffer);

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

function vectorId(index) {
    return `delete-benchmark-${String(index).padStart(6, "0")}`;
}

function seed(db, heads) {
    const placement = Number(vshardOf([ORGANIZATION_ID]));
    const insertHead = db.prepare(
        `INSERT INTO _chardb_vectors
           (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions,
            version, delivered_version, values_enc, metadata_json, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '{}', ?, 0)`
    );
    const insertOutbox = db.prepare(
        `INSERT INTO _chardb_vector_outbox
           (vector_id, target_version, operation, phase, attempts, next_attempt_at)
         VALUES (?, ?, 'upsert', 'submit', 0, 0)`
    );
    const insertAttempt = db.prepare(
        `INSERT INTO _chardb_vector_attempts
           (vector_id, physical_version, first_sent_at, settle_after,
            visibility_confirmed, response_ambiguous, delete_confirmed)
         VALUES (?, ?, 0, 1, ?, ?, 0)`
    );
    db.transaction(() => {
        for (let index = 0; index < heads; index++) {
            const pending = index % 2 === 0;
            const id = vectorId(index);
            insertHead.run(
                id,
                index + 1,
                ORGANIZATION_ID,
                placement,
                RESOURCE_ID,
                `row-${String(index).padStart(6, "0")}`,
                INITIAL_VERSION,
                pending ? INITIAL_VERSION - 1 : INITIAL_VERSION,
                VALUES,
                pending ? "pending" : "ready"
            );
            if (pending) insertOutbox.run(id, INITIAL_VERSION);
            insertAttempt.run(id, (index % INITIAL_VERSION) + 1, index % 3 === 0 ? 1 : 0, index % 3 === 1 ? 1 : 0);
        }
    })();
}

function count(db, query, ...params) {
    return Number(db.query(query).get(...params).count);
}

function queryPlan(db) {
    const details = db
        .query(
            `EXPLAIN QUERY PLAN SELECT vector_id FROM _chardb_vectors
               INDEXED BY _chardb_vectors_active_by_organization_sequence
             WHERE organization_id = ? AND state IN ('pending', 'ready')
             ORDER BY created_seq LIMIT ?`
        )
        .all(ORGANIZATION_ID, CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE + 1)
        .map(row => String(row.detail));
    const statusDetails = db
        .query(`EXPLAIN QUERY PLAN ${CDB_VECTOR_ORGANIZATION_PURGE_STATUS_SQL}`)
        .all(ORGANIZATION_ID, ORGANIZATION_ID, ORGANIZATION_ID, ORGANIZATION_ID)
        .map(row => String(row.detail));
    return Object.freeze({
        usesActiveHeadIndex: details.some(detail => detail.includes("_chardb_vectors_active_by_organization_sequence")),
        usesTempSort: details.some(detail => detail.includes("TEMP B-TREE")),
        statusUsesOrganizationIndex:
            statusDetails.filter(detail => detail.includes("_chardb_vectors_by_organization")).length >= 3,
        statusUsesDeletingIndex: statusDetails.some(detail =>
            detail.includes("_chardb_vectors_deleting_by_organization")
        ),
        statusFullScans: Object.freeze(
            statusDetails.filter(detail => /\bSCAN (?:head|_chardb_vectors)\b/.test(detail))
        ),
    });
}

function runScenario(heads) {
    const db = new Database(":memory:");
    try {
        db.exec(SPLIT_LOG_DDL);
        db.exec(CDB_ROUTING_FENCE_STORE_DDL);
        const sql = syncSql(db);
        initializeCdbVectorOutboxStore(sql);
        initializeCdbVectorOrganizationDeletionStore(sql);
        seed(db, heads);
        const plan = queryPlan(db);
        const initial = Object.freeze({
            pendingHeads: count(db, "SELECT COUNT(*) AS count FROM _chardb_vectors WHERE state = 'pending'"),
            readyHeads: count(db, "SELECT COUNT(*) AS count FROM _chardb_vectors WHERE state = 'ready'"),
            upsertOutboxRows: count(
                db,
                "SELECT COUNT(*) AS count FROM _chardb_vector_outbox WHERE operation = 'upsert'"
            ),
            attemptRows: count(db, "SELECT COUNT(*) AS count FROM _chardb_vector_attempts"),
            confirmedAttempts: count(
                db,
                "SELECT COUNT(*) AS count FROM _chardb_vector_attempts WHERE visibility_confirmed = 1"
            ),
            ambiguousAttempts: count(
                db,
                "SELECT COUNT(*) AS count FROM _chardb_vector_attempts WHERE response_ambiguous = 1"
            ),
            unsettledAttempts: count(
                db,
                `SELECT COUNT(*) AS count FROM _chardb_vector_attempts
                 WHERE visibility_confirmed = 0 AND response_ambiguous = 0`
            ),
        });
        const store = new CdbVectorOrganizationDeletionStore(sql, callback => db.transaction(callback)());

        const fenceStarted = performance.now();
        store.fenceOrganization({ organizationId: ORGANIZATION_ID, nowMs: 1 });
        const fenceMs = performance.now() - fenceStarted;

        const records = [];
        const stageCallMs = [];
        for (let call = 0; call < 10; call++) {
            const started = performance.now();
            const page = store.stageNextPage({ organizationId: ORGANIZATION_ID, nowMs: call + 2 });
            stageCallMs.push(performance.now() - started);
            records.push(
                Object.freeze({
                    staged: page.staged,
                    done: page.done,
                    responseObserved: call !== VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.responseLossAfterCall - 1,
                })
            );
            if (call > 0 && page.done) break;
            if (call === 9) throw new Error(`vector organization deletion did not complete for ${heads} heads`);
        }

        const aggregate = db
            .query(
                `SELECT COUNT(*) AS head_count,
                        COALESCE(SUM(COALESCE(length(values_enc), 0) + length(metadata_json)), 0) AS stored_bytes
                 FROM _chardb_vectors`
            )
            .get();
        const capacity = db.query("SELECT * FROM _chardb_vector_capacity WHERE singleton = 1").get();
        const versions = db.query("SELECT MIN(version) AS minimum, MAX(version) AS maximum FROM _chardb_vectors").get();
        const observed = Object.freeze({
            tombstones: count(db, "SELECT COUNT(*) AS count FROM _chardb_deleted_organizations"),
            deletingHeads: count(db, "SELECT COUNT(*) AS count FROM _chardb_vectors WHERE state = 'deleting'"),
            deleteOutboxRows: count(
                db,
                "SELECT COUNT(*) AS count FROM _chardb_vector_outbox WHERE operation = 'delete'"
            ),
            attemptRows: count(db, "SELECT COUNT(*) AS count FROM _chardb_vector_attempts"),
            confirmedAttempts: count(
                db,
                "SELECT COUNT(*) AS count FROM _chardb_vector_attempts WHERE visibility_confirmed = 1"
            ),
            ambiguousAttempts: count(
                db,
                "SELECT COUNT(*) AS count FROM _chardb_vector_attempts WHERE response_ambiguous = 1"
            ),
            unsettledAttempts: count(
                db,
                `SELECT COUNT(*) AS count FROM _chardb_vector_attempts
                 WHERE visibility_confirmed = 0 AND response_ambiguous = 0`
            ),
            minimumVersion: Number(versions.minimum),
            maximumVersion: Number(versions.maximum),
            capacity: Object.freeze({
                headCount: Number(capacity.head_count),
                outboxRows: Number(capacity.outbox_rows),
                attemptRows: Number(capacity.attempt_rows),
                storedBytes: Number(capacity.stored_bytes),
            }),
        });
        const stagedTotal = records.reduce((sum, record) => sum + record.staged, 0);
        const pageBound = CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE;
        return Object.freeze({
            heads,
            initial,
            calls: Object.freeze({
                total: records.length,
                nonempty: records.filter(record => record.staged > 0).length,
                records: Object.freeze(records),
            }),
            timing: Object.freeze({
                fenceMs,
                stagingTotalMs: stageCallMs.reduce((sum, elapsed) => sum + elapsed, 0),
                stageCallMs: Object.freeze(stageCallMs),
            }),
            observed,
            queryPlan: plan,
            proof: Object.freeze({
                boundedPages:
                    records.every(record => record.staged <= pageBound) &&
                    records.length <= Math.max(2, Math.ceil(heads / pageBound)),
                responseLossCommitted:
                    records[0]?.staged === Math.min(heads, pageBound) && records[0]?.responseObserved === false,
                retryContinuedFromCommittedProgress: records.length > 1 && records[1].responseObserved === true,
                exactHeadCount: observed.deletingHeads === heads && stagedTotal === heads,
                exactDeleteOutboxCount: observed.deleteOutboxRows === heads,
                attemptsPreserved:
                    observed.attemptRows === initial.attemptRows &&
                    observed.confirmedAttempts === initial.confirmedAttempts &&
                    observed.ambiguousAttempts === initial.ambiguousAttempts &&
                    observed.unsettledAttempts === initial.unsettledAttempts,
                versionsAdvancedOnce:
                    observed.minimumVersion === INITIAL_VERSION + 1 && observed.maximumVersion === INITIAL_VERSION + 1,
                capacityCountersExact:
                    observed.capacity.headCount === Number(aggregate.head_count) &&
                    observed.capacity.storedBytes === Number(aggregate.stored_bytes) &&
                    observed.capacity.outboxRows === observed.deleteOutboxRows &&
                    observed.capacity.attemptRows === observed.attemptRows,
            }),
        });
    } finally {
        db.close();
    }
}

export function produceVectorOrganizationDeletionBenchmark() {
    const versionDb = new Database(":memory:");
    const sqlite = String(versionDb.query("SELECT sqlite_version() AS version").get().version);
    versionDb.close();
    return assertVectorOrganizationDeletionBenchmarkReport({
        schema: VECTOR_ORGANIZATION_DELETION_BENCHMARK_SCHEMA,
        environment: { bun: Bun.version, sqlite, storage: "in-memory SQLite" },
        profile: VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE,
        scenarios: VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE.headCounts.map(runScenario),
        capacityModel: deriveVectorOrganizationDeletionCapacityModel(VECTOR_ORGANIZATION_DELETION_BENCHMARK_PROFILE),
        scope: {
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
        },
    });
}

if (import.meta.main) {
    try {
        process.stdout.write(`${JSON.stringify(produceVectorOrganizationDeletionBenchmark(), null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    }
}
