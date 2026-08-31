import { Database } from "bun:sqlite";
import { SPLIT_LOG_DDL, initializeSplitLogAccounting } from "../src/oplog/schema.ts";
import { CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL } from "../src/server/do/cdb-background-delivery-ownership-sql.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../src/server/do/cdb-routing-fence-store.ts";
import {
    CDB_VECTOR_MAX_OUTBOX_ROWS,
    CdbVectorOutboxStore,
    initializeCdbVectorOutboxStore,
} from "../src/server/do/cdb-vector-outbox-store.ts";
import { vshardOf } from "../src/vshard.ts";

export const VECTOR_SCHEDULER_BENCHMARK_SCHEMA = "chardb.vector-scheduler-benchmark.v2";

const VALUES = new Uint8Array(new Float32Array([0.25]).buffer);
const RESOURCE_ID = `vr1_${"a".repeat(64)}`;

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

function organizationWithDifferentPlacement(organizationId) {
    const excluded = Number(vshardOf([organizationId]));
    for (let suffix = 0; suffix < 10_000; suffix++) {
        const candidate = `scheduler-owned-${suffix}`;
        if (Number(vshardOf([candidate])) !== excluded) return candidate;
    }
    throw new Error("could not find a distinct benchmark placement");
}

function vectorId(index) {
    return `scheduler-vector-${String(index).padStart(5, "0")}`;
}

function initialize(db) {
    db.exec(SPLIT_LOG_DDL);
    db.exec(CDB_ROUTING_FENCE_STORE_DDL);
    const sql = syncSql(db);
    initializeSplitLogAccounting(sql);
    initializeCdbVectorOutboxStore(sql);
    return { sql, store: new CdbVectorOutboxStore(sql) };
}

function seed(db, rows, fencedOrganization, ownedOrganization) {
    const head = db.prepare(
        `INSERT INTO _chardb_vectors
           (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions, version,
            delivered_version, values_enc, metadata_json, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, ?, '{}', 'pending', 0)`
    );
    const outbox = db.prepare(
        `INSERT INTO _chardb_vector_outbox
           (vector_id, target_version, operation, attempts, next_attempt_at)
         VALUES (?, 1, 'upsert', 0, ?)`
    );
    db.transaction(() => {
        for (let index = 0; index < rows; index++) {
            const organizationId = index === rows - 1 ? ownedOrganization : fencedOrganization;
            const id = vectorId(index);
            head.run(
                id,
                index + 1,
                organizationId,
                Number(vshardOf([organizationId])),
                RESOURCE_ID,
                `row-${String(index).padStart(5, "0")}`,
                VALUES
            );
            outbox.run(id, index);
        }
        db.run(
            `UPDATE _chardb_vector_head_sequence
             SET last_seq = MAX(last_seq, (SELECT COALESCE(MAX(created_seq), 0) FROM _chardb_vectors))
             WHERE singleton = 1`
        );
    })();
}

function percentile(samples, quantile) {
    const sorted = [...samples].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function measure(samples, invoke) {
    invoke();
    const elapsed = [];
    for (let index = 0; index < samples; index++) {
        const started = performance.now();
        invoke();
        elapsed.push(performance.now() - started);
    }
    return Object.freeze({
        medianMs: percentile(elapsed, 0.5),
        p95Ms: percentile(elapsed, 0.95),
        maxMs: Math.max(...elapsed),
    });
}

function plans(db, placement) {
    const ownership = CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL;
    const due = db
        .query(
            `EXPLAIN QUERY PLAN
             SELECT MIN(CASE
               WHEN outbox.leased_until IS NOT NULL AND outbox.leased_until > outbox.next_attempt_at
                 THEN outbox.leased_until
               ELSE outbox.next_attempt_at
             END) AS due_at
             FROM _chardb_vector_outbox AS outbox
             INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
             WHERE ${ownership}`
        )
        .all()
        .map(row => String(row.detail));
    const placementAtOrAfter = db
        .query(
            `EXPLAIN QUERY PLAN
             SELECT MIN(delivery_head.placement_vshard) AS placement_vshard
             FROM _chardb_vector_outbox AS outbox
             INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
             WHERE ${ownership}
               AND delivery_head.placement_vshard >= ?
               AND (CASE
                      WHEN outbox.leased_until IS NOT NULL
                       AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                      ELSE outbox.next_attempt_at
                    END) <= ?`
        )
        .all(placement, CDB_VECTOR_MAX_OUTBOX_ROWS)
        .map(row => String(row.detail));
    const placementWrap = db
        .query(
            `EXPLAIN QUERY PLAN
             SELECT MIN(delivery_head.placement_vshard) AS placement_vshard
             FROM _chardb_vector_outbox AS outbox
             INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
             WHERE ${ownership}
               AND (CASE
                      WHEN outbox.leased_until IS NOT NULL
                       AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                      ELSE outbox.next_attempt_at
                    END) <= ?`
        )
        .all(CDB_VECTOR_MAX_OUTBOX_ROWS)
        .map(row => String(row.detail));
    const claim = db
        .query(
            `EXPLAIN QUERY PLAN
             SELECT outbox.*, delivery_head.* FROM _chardb_vector_outbox AS outbox
               INDEXED BY _chardb_vector_outbox_effective_due
             INNER JOIN _chardb_vectors AS delivery_head ON delivery_head.vector_id = outbox.vector_id
             WHERE ${ownership}
               AND delivery_head.placement_vshard = ?
               AND (CASE
                      WHEN outbox.leased_until IS NOT NULL
                       AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                      ELSE outbox.next_attempt_at
                    END) <= ?
             ORDER BY (CASE
                         WHEN outbox.leased_until IS NOT NULL
                          AND outbox.leased_until > outbox.next_attempt_at THEN outbox.leased_until
                         ELSE outbox.next_attempt_at
                       END), outbox.vector_id LIMIT 1`
        )
        .all(placement, CDB_VECTOR_MAX_OUTBOX_ROWS)
        .map(row => String(row.detail));
    return Object.freeze({
        due: Object.freeze(due),
        placementAtOrAfter: Object.freeze(placementAtOrAfter),
        placementWrap: Object.freeze(placementWrap),
        claim: Object.freeze(claim),
    });
}

function uses(plan, indexName) {
    return plan.some(detail => detail.includes(indexName));
}

export function produceVectorSchedulerBenchmark(options = {}) {
    const rows = options.rows ?? CDB_VECTOR_MAX_OUTBOX_ROWS;
    const samples = options.samples ?? 31;
    if (!Number.isSafeInteger(rows) || rows < 2 || rows > CDB_VECTOR_MAX_OUTBOX_ROWS) {
        throw new Error(`rows must be between 2 and ${CDB_VECTOR_MAX_OUTBOX_ROWS}`);
    }
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1_000) {
        throw new Error("samples must be between 1 and 1000");
    }

    const db = new Database(":memory:");
    try {
        const { store } = initialize(db);
        const fencedOrganization = "scheduler-fenced";
        const ownedOrganization = organizationWithDifferentPlacement(fencedOrganization);
        const fencedPlacement = Number(vshardOf([fencedOrganization]));
        const ownedPlacement = Number(vshardOf([ownedOrganization]));
        seed(db, rows, fencedOrganization, ownedOrganization);

        db.run("UPDATE _chardb_vector_outbox SET next_attempt_at = 0 WHERE vector_id = ?", [vectorId(rows - 1)]);
        db.run("UPDATE _chardb_vector_scheduler SET next_vshard = ?", [fencedPlacement]);
        const hotClaim = store.claimNext({
            nowMs: 0,
            leaseMs: 1,
            settlementMs: 1,
            claimToken: "scheduler-fair-hot-0001",
        });
        const reconstructedStore = new CdbVectorOutboxStore(store.sql);
        const coldClaim = reconstructedStore.claimNext({
            nowMs: 0,
            leaseMs: 1,
            settlementMs: 1,
            claimToken: "scheduler-fair-cold-001",
        });
        if (!hotClaim || hotClaim.vectorId !== vectorId(0) || hotClaim.placementVshard !== fencedPlacement) {
            throw new Error("fair scheduler did not start at the requested hot vshard");
        }
        if (!coldClaim || coldClaim.vectorId !== vectorId(rows - 1) || coldClaim.placementVshard !== ownedPlacement) {
            throw new Error("hot vshard starved the other due vshard");
        }
        db.transaction(() => {
            db.run("DELETE FROM _chardb_vector_attempts WHERE vector_id IN (?, ?)", [
                hotClaim.vectorId,
                coldClaim.vectorId,
            ]);
            db.run(
                `UPDATE _chardb_vector_outbox
                 SET attempts = 0, leased_until = NULL, lease_token = NULL, next_attempt_at = CASE
                   WHEN vector_id = ? THEN 0 ELSE ? END
                 WHERE vector_id IN (?, ?)`,
                [hotClaim.vectorId, rows - 1, hotClaim.vectorId, coldClaim.vectorId]
            );
            db.run("UPDATE _chardb_vector_scheduler SET next_vshard = 0");
        })();

        const ownedFirstNextDueAt = measure(samples, () => {
            if (store.nextDueAt() !== 0) throw new Error("unfenced scheduler lost its earliest deadline");
        });
        let ownedFirstClaimSequence = 0;
        const ownedFirstClaimNext = measure(samples, () => {
            const claim = store.claimNext({
                nowMs: ownedFirstClaimSequence,
                leaseMs: 1,
                settlementMs: 1,
                claimToken: `scheduler-owned-${String(ownedFirstClaimSequence).padStart(16, "0")}`,
            });
            if (!claim || claim.vectorId !== vectorId(0) || claim.placementVshard !== fencedPlacement) {
                throw new Error("unfenced scheduler did not claim its earliest row");
            }
            store.failClaim({
                vectorId: claim.vectorId,
                targetVersion: claim.targetVersion,
                operation: claim.operation,
                phase: claim.phase,
                claimToken: claim.claimToken,
                nextAttemptAt: 0,
                error: "benchmark release",
            });
            ownedFirstClaimSequence++;
        });
        db.run(
            `INSERT INTO _chardb_routing_fences
               (migration_id, range_lo, range_hi, source_generation, destination_generation,
                status, prepared_at, activated_at)
             VALUES ('scheduler-fence', ?, ?, 1, 2, 'active', 0, 0)`,
            [fencedPlacement, fencedPlacement]
        );

        const queryPlans = plans(db, ownedPlacement);
        const nextDueAt = measure(samples, () => {
            if (store.nextDueAt() !== rows - 1) throw new Error("scheduler skipped the only owned deadline");
        });
        let claimSequence = 0;
        const claimNext = measure(samples, () => {
            const nowMs = rows + claimSequence;
            const claim = store.claimNext({
                nowMs,
                leaseMs: 1,
                settlementMs: 1,
                claimToken: `scheduler-claim-${String(claimSequence).padStart(16, "0")}`,
            });
            if (!claim || claim.vectorId !== vectorId(rows - 1) || claim.placementVshard !== ownedPlacement) {
                throw new Error("scheduler did not claim the only owned row");
            }
            store.failClaim({
                vectorId: claim.vectorId,
                targetVersion: claim.targetVersion,
                operation: claim.operation,
                phase: claim.phase,
                claimToken: claim.claimToken,
                nextAttemptAt: nowMs,
                error: "benchmark release",
            });
            claimSequence++;
        });

        db.run("UPDATE _chardb_routing_fences SET range_hi = ? WHERE migration_id = 'scheduler-fence'", [
            Math.max(fencedPlacement, ownedPlacement),
        ]);
        db.run("UPDATE _chardb_routing_fences SET range_lo = ? WHERE migration_id = 'scheduler-fence'", [
            Math.min(fencedPlacement, ownedPlacement),
        ]);
        const allFencedNextDueAt = measure(samples, () => {
            if (store.nextDueAt() !== null) throw new Error("all-fenced scheduler returned a deadline");
        });
        const allFencedClaimNext = measure(samples, () => {
            if (
                store.claimNext({
                    nowMs: rows + samples + 1,
                    leaseMs: 1,
                    settlementMs: 1,
                    claimToken: "scheduler-null-claim-0001",
                }) !== null
            ) {
                throw new Error("all-fenced scheduler returned a claim");
            }
        });

        const noTempSort = !queryPlans.claim.some(detail => detail.includes("TEMP B-TREE"));
        return Object.freeze({
            schema: VECTOR_SCHEDULER_BENCHMARK_SCHEMA,
            environment: Object.freeze({ bun: Bun.version, sqlite: db.query("SELECT sqlite_version() AS v").get().v }),
            profile: Object.freeze({ rows, samples, outboxRowLimit: CDB_VECTOR_MAX_OUTBOX_ROWS }),
            placements: Object.freeze({ fenced: fencedPlacement, owned: ownedPlacement }),
            timings: Object.freeze({
                ownedFirstNextDueAt,
                ownedFirstClaimNext,
                nextDueAt,
                claimNext,
                allFencedNextDueAt,
                allFencedClaimNext,
            }),
            plans: queryPlans,
            proof: Object.freeze({
                exercisedExactOutboxLimit: rows === CDB_VECTOR_MAX_OUTBOX_ROWS,
                hotVshardTurnsBeforeCold: 1,
                cursorSurvivedStoreReconstruction: true,
                claimUsesEffectiveDueIndex: uses(queryPlans.claim, "_chardb_vector_outbox_effective_due"),
                dueUsesEffectiveDueIndex: uses(queryPlans.due, "_chardb_vector_outbox_effective_due"),
                placementSeekUsesScheduleIndex: uses(
                    queryPlans.placementAtOrAfter,
                    "_chardb_vectors_delivery_schedule"
                ),
                placementWrapUsesEffectiveDueIndex: uses(
                    queryPlans.placementWrap,
                    "_chardb_vector_outbox_effective_due"
                ),
                claimAvoidsTempSort: noTempSort,
                routingFenceUsesRangeIndex:
                    uses(queryPlans.claim, "_chardb_routing_fences_range") &&
                    uses(queryPlans.due, "_chardb_routing_fences_range"),
                destinationChecksUseAdmissionIndex:
                    uses(queryPlans.claim, "_chardb_split_destination_admission") &&
                    uses(queryPlans.due, "_chardb_split_destination_admission"),
            }),
        });
    } finally {
        db.close();
    }
}

if (import.meta.main) {
    process.stdout.write(`${JSON.stringify(produceVectorSchedulerBenchmark(), null, 2)}\n`);
}
