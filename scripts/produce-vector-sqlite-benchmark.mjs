import { Database } from "bun:sqlite";
import { SPLIT_LOG_DDL, initializeSplitLogAccounting } from "../src/oplog/schema.ts";
import {
    CDB_LIVE_STORE_DDL,
    enqueueVectorResourceInvalidations,
    initializeLiveStore,
} from "../src/server/do/cdb-live-store.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../src/server/do/cdb-routing-fence-store.ts";
import {
    CDB_VECTOR_OUTBOX_DDL,
    CdbVectorOutboxStore,
    initializeCdbVectorOutboxStore,
} from "../src/server/do/cdb-vector-outbox-store.ts";
import { validateCdbVectorMatches } from "../src/server/do/cdb-vectorize-adapter.ts";
import { cdbVectorizePhysicalId } from "../src/server/do/cdb-vectorize-wire.ts";
import { vshardOf } from "../src/vshard.ts";
import {
    VECTOR_SQLITE_BENCHMARK_PROFILE,
    VECTOR_SQLITE_BENCHMARK_SCHEMA,
    assertVectorSqliteBenchmarkReport,
} from "./vector-sqlite-benchmark-report.mjs";

const ORGANIZATION = "benchmark-org";
const RESOURCE = `vr1_${"c".repeat(64)}`;
const RESOURCE_A = `vr1_${"a".repeat(64)}`;
const RESOURCE_B = `vr1_${"b".repeat(64)}`;
const PLACEMENT = Number(vshardOf([ORGANIZATION]));
const VALUES = new Uint8Array(new Float32Array([0.25, -0.5, 0.75, 1]).buffer);

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

function statements(ddl) {
    return ddl
        .split(";")
        .map(value => value.trim())
        .filter(Boolean);
}

function vectorId(index) {
    return `vec1_${index.toString(16).padStart(64, "0")}`;
}

function rowPk(index) {
    return `row-${String(index).padStart(6, "0")}`;
}

function seedHeads(db, count, state, withOutbox) {
    const head = db.prepare(
        `INSERT INTO _chardb_vectors
           (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions, version,
            delivered_version, values_enc, metadata_json, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 4, 1, ?, ?, '{}', ?, 0)`
    );
    const outbox = db.prepare(
        `INSERT INTO _chardb_vector_outbox
           (vector_id, target_version, operation, attempts, next_attempt_at, leased_until, lease_token, last_error)
         VALUES (?, 1, 'upsert', 0, 0, NULL, NULL, NULL)`
    );
    db.transaction(() => {
        for (let index = 0; index < count; index++) {
            head.run(
                vectorId(index),
                index + 1,
                ORGANIZATION,
                PLACEMENT,
                RESOURCE,
                rowPk(index),
                state === "ready" ? 1 : 0,
                VALUES,
                state
            );
            if (withOutbox) outbox.run(vectorId(index));
        }
        db.run(
            `UPDATE _chardb_vector_head_sequence
             SET last_seq = MAX(last_seq, (SELECT COALESCE(MAX(created_seq), 0) FROM _chardb_vectors))
             WHERE singleton = 1`
        );
    })();
}

function timing(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    const at = quantile => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
    const microseconds = value => Math.round(value * 1_000_000) / 1_000;
    return Object.freeze({ medianUs: microseconds(at(0.5)), p95Us: microseconds(at(0.95)) });
}

function measure(repetitions, invoke, after) {
    const samples = [];
    for (let iteration = 0; iteration < repetitions; iteration++) {
        const started = performance.now();
        const value = invoke(iteration);
        samples.push(performance.now() - started);
        after?.(value, iteration);
    }
    return timing(samples);
}

function withVectorDatabase(heads, state, withOutbox, invoke) {
    const db = new Database(":memory:");
    try {
        db.exec(SPLIT_LOG_DDL);
        db.exec(CDB_ROUTING_FENCE_STORE_DDL);
        const sql = syncSql(db);
        initializeSplitLogAccounting(sql);
        initializeCdbVectorOutboxStore(sql);
        seedHeads(db, heads, state, withOutbox);
        return invoke(db, sql, new CdbVectorOutboxStore(sql));
    } finally {
        db.close();
    }
}

function stageTimings(heads, repetitions) {
    return withVectorDatabase(heads, "ready", false, (db, _sql, store) => {
        const stageInsert = measure(
            repetitions,
            iteration =>
                store.stageUpsert({
                    vectorId: `insert-${String(iteration).padStart(6, "0")}`,
                    organizationId: ORGANIZATION,
                    resourceId: RESOURCE,
                    rowPk: `insert-row-${String(iteration).padStart(6, "0")}`,
                    dimensions: 4,
                    values: [0.25, -0.5, 0.75, 1],
                    metadata: { benchmark: true },
                    nowMs: iteration + 1,
                }),
            head => db.run("DELETE FROM _chardb_vectors WHERE vector_id = ?", [head.vectorId])
        );
        const stageUpdate = measure(repetitions, iteration =>
            store.stageUpsert({
                vectorId: vectorId(0),
                organizationId: ORGANIZATION,
                resourceId: RESOURCE,
                rowPk: rowPk(0),
                dimensions: 4,
                values: [0.25, -0.5, 0.75, 1],
                metadata: { benchmark: true },
                nowMs: iteration + 1,
            })
        );
        const capacity = db.query("SELECT * FROM _chardb_vector_capacity WHERE singleton = 1").get();
        const aggregate = db
            .query(
                `SELECT COUNT(*) AS head_count,
                        COALESCE(SUM(COALESCE(length(values_enc), 0) + length(metadata_json)), 0) AS stored_bytes
                 FROM _chardb_vectors`
            )
            .get();
        return {
            stageInsert,
            stageUpdate,
            capacityCounterExact:
                Number(capacity.head_count) === Number(aggregate.head_count) &&
                Number(capacity.stored_bytes) === Number(aggregate.stored_bytes),
        };
    });
}

function claimTiming(heads, repetitions) {
    return withVectorDatabase(heads, "pending", true, (db, _sql, store) => {
        db.run(
            `UPDATE _chardb_vector_outbox
             SET leased_until = 900000, lease_token = 'benchmark-existing-lease'
             WHERE vector_id <> ?`,
            [vectorId(heads - 1)]
        );
        const measured = measure(
            repetitions,
            iteration =>
                store.claimNext({
                    nowMs: 100_000 + iteration,
                    leaseMs: 1_000,
                    settlementMs: 1,
                    claimToken: `benchmark-claim-${String(iteration).padStart(16, "0")}`,
                }),
            (claim, iteration) => {
                if (!claim) throw new Error("claim benchmark did not find due work");
                store.failClaim({
                    vectorId: claim.vectorId,
                    targetVersion: claim.targetVersion,
                    operation: claim.operation,
                    phase: claim.phase,
                    claimToken: claim.claimToken,
                    nextAttemptAt: 100_001 + iteration,
                    error: "benchmark release",
                });
            }
        );
        const plan = db
            .query(
                `EXPLAIN QUERY PLAN SELECT o.*, v.* FROM _chardb_vector_outbox AS o
                 INNER JOIN _chardb_vectors AS v ON v.vector_id = o.vector_id
                 WHERE (CASE WHEN o.leased_until IS NOT NULL AND o.leased_until > o.next_attempt_at
                             THEN o.leased_until ELSE o.next_attempt_at END) <= ?
                 ORDER BY (CASE WHEN o.leased_until IS NOT NULL AND o.leased_until > o.next_attempt_at
                                THEN o.leased_until ELSE o.next_attempt_at END), o.vector_id LIMIT 1`
            )
            .all(100_000)
            .map(row => String(row.detail));
        return {
            timing: measured,
            usesDueIndexWithoutTempSort:
                plan.some(detail => detail.includes("_chardb_vector_outbox_effective_due")) &&
                !plan.some(detail => detail.includes("TEMP B-TREE")),
        };
    });
}

function readyAckTiming(heads, repetitions) {
    return withVectorDatabase(heads, "ready", false, (db, _sql, store) => {
        const samples = [];
        for (let iteration = 0; iteration < repetitions; iteration++) {
            db.run("UPDATE _chardb_vectors SET delivered_version = 0, state = 'pending' WHERE vector_id = ?", [
                vectorId(0),
            ]);
            db.run(
                `INSERT INTO _chardb_vector_outbox
                   (vector_id, target_version, operation, attempts, next_attempt_at, leased_until, lease_token, last_error)
                 VALUES (?, 1, 'upsert', 0, 0, NULL, NULL, NULL)`,
                [vectorId(0)]
            );
            const claim = store.claimNext({
                nowMs: 200_000 + iteration,
                leaseMs: 1_000,
                settlementMs: 1,
                claimToken: `benchmark-ready-${String(iteration).padStart(16, "0")}`,
            });
            if (!claim || claim.operation !== "upsert")
                throw new Error("ready acknowledgement benchmark lost its claim");
            const started = performance.now();
            store.acknowledgeUpsert(claim, 200_001 + iteration);
            samples.push(performance.now() - started);
        }
        return timing(samples);
    });
}

function candidateTiming(heads, repetitions, candidates) {
    return withVectorDatabase(heads, "ready", false, (_db, _sql, store) => {
        const count = Math.min(heads, candidates);
        const matches = Array.from({ length: count }, (_, index) => ({
            id: cdbVectorizePhysicalId(vectorId(index), 1),
            score: 1 - index / Math.max(1, count),
        }));
        let last = [];
        const measured = measure(repetitions, () => {
            last = validateCdbVectorMatches({
                matches,
                organizationId: ORGANIZATION,
                resourceId: RESOURCE,
                limit: candidates,
                readHead: id => store.read(id),
            });
            return last;
        });
        return { timing: measured, bounded: last.length === count && last.length <= candidates };
    });
}

function initializeLiveDatabase(db) {
    const sql = syncSql(db);
    for (const statement of statements(CDB_LIVE_STORE_DDL)) sql.exec(statement);
    initializeLiveStore(sql);
    return sql;
}

function seedRegistrations(db, count, fanout) {
    const subscription = db.prepare(
        `INSERT INTO _chardb_live_subscriptions
           (gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
            principal_id, organization_id, authority, schema_epoch, recovery_generation, vshard, domain_schema_epoch,
            ref, args_json, policy_digest, query_hash, tables_json, intervals_json)
         VALUES ('gateway', ?, ?, 'client', ?, 'active', 'hash', 'user', ?, 'organization', 1, 0, ?, 1,
                 'query', '{}', 'policy', 'query-hash', '[]', '[]')`
    );
    const dependency = db.prepare("INSERT INTO _chardb_live_subscription_vectors VALUES ('gateway', ?, ?)");
    const outbox = db.prepare(
        "INSERT INTO _chardb_invalidation_outbox (gateway_id, registration_id, change_seq) VALUES ('gateway', ?, 1)"
    );
    db.transaction(() => {
        for (let index = 0; index < count; index++) {
            const registration = `registration-${String(index).padStart(6, "0")}`;
            subscription.run(registration, `connection-${index}`, index, ORGANIZATION, PLACEMENT);
            dependency.run(registration, fanout || index === 0 ? RESOURCE_A : RESOURCE_B);
            outbox.run(registration);
        }
    })();
}

function invalidationTiming(registrations, repetitions, fanout) {
    const db = new Database(":memory:");
    try {
        const sql = initializeLiveDatabase(db);
        seedRegistrations(db, registrations, fanout);
        const measured = measure(repetitions, () => enqueueVectorResourceInvalidations(sql, RESOURCE_A));
        const plan = db
            .query(
                `EXPLAIN QUERY PLAN SELECT mappings.gateway_id, mappings.registration_id
                 FROM _chardb_live_subscription_vectors AS mappings
                 INNER JOIN _chardb_live_subscriptions AS subscriptions
                   ON subscriptions.gateway_id = mappings.gateway_id
                  AND subscriptions.registration_id = mappings.registration_id
                 WHERE mappings.resource_id = ? AND subscriptions.state = 'active'
                 ORDER BY mappings.gateway_id, mappings.registration_id LIMIT 4097`
            )
            .all(RESOURCE_A)
            .map(row => String(row.detail));
        return {
            timing: measured,
            usesResourceIndex: plan.some(detail => detail.includes("_chardb_live_subscription_vectors_by_resource")),
        };
    } finally {
        db.close();
    }
}

function restartTimings(heads, repetitions, coldRepetitions) {
    const warm = withVectorDatabase(heads, "ready", true, (_db, sql) => {
        let aggregateQueries = 0;
        const observed = {
            ...sql,
            one(query, ...params) {
                if (query.includes("SELECT COUNT(*) FROM _chardb_vectors")) aggregateQueries++;
                return sql.one(query, ...params);
            },
            exec(query, ...params) {
                if (query.includes("head_count = (SELECT COUNT(*) FROM _chardb_vectors")) aggregateQueries++;
                sql.exec(query, ...params);
            },
        };
        return {
            timing: measure(repetitions, () => initializeCdbVectorOutboxStore(observed)),
            skippedAggregate: aggregateQueries === 0,
        };
    });
    const coldSamples = [];
    for (let run = 0; run < coldRepetitions; run++) {
        const db = new Database(":memory:");
        try {
            const sql = syncSql(db);
            for (const statement of statements(CDB_VECTOR_OUTBOX_DDL)) {
                if (!statement.startsWith("CREATE TABLE IF NOT EXISTS _chardb_vector_capacity")) sql.exec(statement);
            }
            seedHeads(db, heads, "pending", true);
            const started = performance.now();
            initializeCdbVectorOutboxStore(sql);
            coldSamples.push(performance.now() - started);
        } finally {
            db.close();
        }
    }
    return { warm, cold: timing(coldSamples) };
}

export function produceVectorSqliteBenchmark(options = {}) {
    const profile = Object.freeze({
        ...VECTOR_SQLITE_BENCHMARK_PROFILE,
        ...(options.headCounts ? { headCounts: Object.freeze([...options.headCounts]) } : {}),
        ...(options.registrationCounts ? { registrationCounts: Object.freeze([...options.registrationCounts]) } : {}),
        ...(options.repetitions ? { repetitions: options.repetitions } : {}),
        ...(options.coldReconcileRepetitions ? { coldReconcileRepetitions: options.coldReconcileRepetitions } : {}),
    });
    if (profile.headCounts.length !== profile.registrationCounts.length) {
        throw new Error("headCounts and registrationCounts must have equal lengths");
    }
    const sqlite = new Database(":memory:");
    const sqliteVersion = String(sqlite.query("SELECT sqlite_version() AS version").get().version);
    sqlite.close();
    const results = profile.headCounts.map((heads, index) => {
        const registrations = profile.registrationCounts[index];
        const stage = stageTimings(heads, profile.repetitions);
        const claim = claimTiming(heads, profile.repetitions);
        const candidate = candidateTiming(heads, profile.repetitions, profile.candidates);
        const sparseInvalidation = invalidationTiming(registrations, profile.repetitions, false);
        const fanoutInvalidation = invalidationTiming(registrations, profile.repetitions, true);
        const restart = restartTimings(heads, profile.repetitions, profile.coldReconcileRepetitions);
        return Object.freeze({
            storedHeads: heads,
            registrations,
            timings: Object.freeze({
                stageInsert: stage.stageInsert,
                stageUpdate: stage.stageUpdate,
                claim: claim.timing,
                readyAck: readyAckTiming(heads, profile.repetitions),
                validatedCandidateFiltering: candidate.timing,
                exactInvalidationOneOfN: sparseInvalidation.timing,
                exactInvalidationFanout: fanoutInvalidation.timing,
                warmRestart: restart.warm.timing,
                coldReconcile: restart.cold,
            }),
            proof: Object.freeze({
                capacityCounterExact: stage.capacityCounterExact,
                claimUsesDueIndexWithoutTempSort: claim.usesDueIndexWithoutTempSort,
                invalidationUsesResourceIndex:
                    sparseInvalidation.usesResourceIndex && fanoutInvalidation.usesResourceIndex,
                warmRestartSkippedAggregateReconciliation: restart.warm.skippedAggregate,
                candidateResultsBounded: candidate.bounded,
            }),
        });
    });
    return assertVectorSqliteBenchmarkReport({
        schema: VECTOR_SQLITE_BENCHMARK_SCHEMA,
        profile,
        environment: { bun: Bun.version, sqlite: sqliteVersion, storage: "in-memory SQLite" },
        results,
        scope: {
            includesVectorizeLatency: false,
            includesPolicyPointReads: false,
            description:
                "Deterministic local SQLite state transitions only; Vectorize network and policy-protected row reads are excluded.",
        },
    });
}

if (import.meta.main) {
    try {
        process.stdout.write(`${JSON.stringify(produceVectorSqliteBenchmark(), null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    }
}
