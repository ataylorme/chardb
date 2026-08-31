import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../../src/server/do/cdb-routing-fence-store.ts";
import {
    CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
    CDB_VECTOR_MAX_ATTEMPT_VERSIONS,
    CDB_VECTOR_MAX_DELETE_IDS,
    CDB_VECTOR_MAX_DELETE_ID_BYTES,
    CDB_VECTOR_MAX_DIMENSIONS,
    CDB_VECTOR_MAX_ERROR_BYTES,
    CDB_VECTOR_MAX_METADATA_BYTES,
    type CdbVectorDeleteClaim,
    CdbVectorOutboxStore,
    type CdbVectorUpsertClaim,
    cdbVectorPhysicalId,
    initializeCdbVectorOutboxStore,
} from "../../src/server/do/cdb-vector-outbox-store.ts";
import { VSHARD_COUNT, vshardOf } from "../../src/vshard.ts";

function syncSql(db: Database): SyncSql {
    return {
        exec(query, ...params) {
            db.run(query, params as never[]);
        },
        one<T>(query: string, ...params: never[]): T | null {
            return (db.query(query).get(...params) as T | null) ?? null;
        },
        all<T>(query: string, ...params: never[]): T[] {
            return db.query(query).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS count").get() as { count: number }).count);
        },
    };
}

const UPSERT_INPUT = Object.freeze({
    vectorId: "vec_alpha",
    organizationId: "org_alpha",
    resourceId: "messages_embedding",
    rowPk: "message-1",
    dimensions: 3,
    values: [0.25, -0.5, 1] as const,
    metadata: { channel: "general", nested: { rank: 2 }, labels: ["one", "two"] },
    nowMs: 100,
});

const TOKEN_A = "claim-token-0001";
const TOKEN_B = "claim-token-0002";
const TOKEN_C = "claim-token-0003";
const TOKEN_D = "claim-token-0004";

function organizationsByPlacement(): readonly [string, string] {
    const organizations = Array.from({ length: 32 }, (_, index) => `org_fair_${index}`).sort(
        (left, right) => Number(vshardOf([left])) - Number(vshardOf([right]))
    );
    const low = organizations[0];
    const high = organizations.at(-1);
    if (!low || !high) throw new Error("fairness fixture could not find organizations");
    return [low, high];
}

function organizationAtPlacement(placement: number): string {
    for (let index = 0; index < 200_000; index++) {
        const organizationId = `org_placement_${placement}_${index}`;
        if (Number(vshardOf([organizationId])) === placement) return organizationId;
    }
    throw new Error(`fixture could not find an organization at vshard ${placement}`);
}

describe("Cdb vector head and outbox store", () => {
    let db: Database;
    let sql: SyncSql;
    let store: CdbVectorOutboxStore;

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(SPLIT_LOG_DDL);
        db.exec(CDB_ROUTING_FENCE_STORE_DDL);
        sql = syncSql(db);
        initializeCdbVectorOutboxStore(sql);
        store = new CdbVectorOutboxStore(sql);
    });

    afterEach(() => db.close());

    function claimUpsert(nowMs = 100, token = TOKEN_A, settlementMs = 100): CdbVectorUpsertClaim {
        const claim = store.claimNext({ nowMs, leaseMs: 50, settlementMs, claimToken: token });
        if (!claim || claim.operation !== "upsert") throw new Error("expected an upsert claim");
        return claim;
    }

    test("derives placement, stores bounded float32 values, and emits a versioned physical id", () => {
        const head = store.stageUpsert(UPSERT_INPUT);
        expect(head).toEqual({
            vectorId: "vec_alpha",
            organizationId: "org_alpha",
            placementVshard: Number(vshardOf(["org_alpha"])),
            resourceId: "messages_embedding",
            rowPk: "message-1",
            dimensions: 3,
            version: 1,
            deliveredVersion: 0,
            values: [0.25, -0.5, 1],
            metadata: { channel: "general", labels: ["one", "two"], nested: { rank: 2 } },
            state: "pending",
            updatedAt: 100,
        });
        expect(cdbVectorPhysicalId(head.resourceId, head.vectorId, head.version)).toBe(
            "v1/messages_embedding/vec_alpha/1"
        );
        expect(
            db.query("SELECT target_version, operation, attempts, leased_until FROM _chardb_vector_outbox").get()
        ).toEqual({ target_version: 1, operation: "upsert", attempts: 0, leased_until: null });
        expect(
            (db.query("SELECT length(values_enc) AS bytes FROM _chardb_vectors").get() as { bytes: number }).bytes
        ).toBe(12);
    });

    test("indexes the effective alarm deadline and does not hide an earlier unleased row", () => {
        store.stageUpsert(UPSERT_INPUT);
        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_beta",
            organizationId: "org_beta",
            rowPk: "message-2",
            nowMs: 200,
        });
        const first = claimUpsert(100, TOKEN_A);
        expect(store.nextDueAt()).toBe(150);
        store.failClaim({
            vectorId: first.vectorId,
            targetVersion: first.targetVersion,
            operation: first.operation,
            phase: first.phase,
            claimToken: first.claimToken,
            nextAttemptAt: 300,
            error: "retry",
        });
        expect(store.nextDueAt()).toBe(200);
        const plan = db
            .query(
                `EXPLAIN QUERY PLAN
                 SELECT MIN(CASE
                   WHEN leased_until IS NOT NULL AND leased_until > next_attempt_at THEN leased_until
                   ELSE next_attempt_at
                 END) AS due_at
                 FROM _chardb_vector_outbox`
            )
            .all() as Array<{ detail: string }>;
        expect(plan.some(row => row.detail.includes("_chardb_vector_outbox_effective_due"))).toBe(true);
    });

    test("filters a fenced earlier row before claim selection", () => {
        const fenced = store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_fenced",
            organizationId: "org_fenced",
            rowPk: "fenced",
            nowMs: 100,
        });
        const owned = store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_owned",
            organizationId: "org_owned",
            rowPk: "owned",
            nowMs: 200,
        });
        db.run(
            `INSERT INTO _chardb_routing_fences
               (migration_id, range_lo, range_hi, source_generation, destination_generation,
                status, prepared_at, activated_at)
             VALUES ('vector-fence', ?, ?, 1, 2, 'active', 1, 2)`,
            [fenced.placementVshard, fenced.placementVshard]
        );

        expect(store.nextDueAt()).toBe(200);
        expect(store.claimNext({ nowMs: 200, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toMatchObject({
            vectorId: owned.vectorId,
            organizationId: owned.organizationId,
        });
        expect(
            db
                .query("SELECT attempts, leased_until, lease_token FROM _chardb_vector_outbox WHERE vector_id = ?")
                .get(fenced.vectorId)
        ).toEqual({ attempts: 0, leased_until: null, lease_token: null });
    });

    test("returns no alarm deadline or claim when only fenced rows remain", () => {
        const fenced = store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_only_fenced",
            organizationId: "org_only_fenced",
            rowPk: "only-fenced",
            nowMs: 100,
        });
        db.run(
            `INSERT INTO _chardb_routing_fences
               (migration_id, range_lo, range_hi, source_generation, destination_generation,
                status, prepared_at, activated_at)
             VALUES ('vector-only-fence', ?, ?, 1, 2, 'active', 1, 2)`,
            [fenced.placementVshard, fenced.placementVshard]
        );

        expect(store.nextDueAt()).toBeNull();
        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toBeNull();
        expect(db.query("SELECT next_vshard FROM _chardb_vector_scheduler").get()).toEqual({ next_vshard: 0 });
    });

    test("admits destination work only after the latest serving owner is drained", () => {
        const destination = store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_destination",
            organizationId: "org_destination",
            rowPk: "destination",
            nowMs: 100,
        });
        db.run(
            `INSERT INTO _chardb_split_state
               (mig_id, range_lo, range_hi, role, capture, destination_generation,
                destination_serving, updated_at)
             VALUES ('vector-destination', ?, ?, 'dest', 0, 2, 0, 1)`,
            [destination.placementVshard, destination.placementVshard]
        );

        expect(store.nextDueAt()).toBeNull();
        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toBeNull();
        expect(db.query("SELECT next_vshard FROM _chardb_vector_scheduler").get()).toEqual({ next_vshard: 0 });

        db.run("UPDATE _chardb_split_state SET destination_serving = 1 WHERE mig_id = 'vector-destination'");
        store = new CdbVectorOutboxStore(sql);
        expect(store.nextDueAt()).toBeNull();
        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toBeNull();
        expect(db.query("SELECT attempts, leased_until, lease_token FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 0,
            leased_until: null,
            lease_token: null,
        });

        db.run("UPDATE _chardb_split_state SET drained = 1 WHERE mig_id = 'vector-destination'");
        expect(store.nextDueAt()).toBe(100);
        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C })).toMatchObject({
            vectorId: destination.vectorId,
            organizationId: destination.organizationId,
        });
    });

    test("fails closed when delivered version contradicts the lifecycle state", () => {
        store.stageUpsert(UPSERT_INPUT);
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE _chardb_vectors SET delivered_version = version WHERE vector_id = 'vec_alpha'");
        expect(() => store.read("vec_alpha")).toThrow(/delivered version does not match/);
        db.run("UPDATE _chardb_vectors SET state = 'ready', delivered_version = 0 WHERE vector_id = 'vec_alpha'");
        expect(() => store.read("vec_alpha")).toThrow(/delivered version does not match/);
    });

    test("scopes tenant-local row keys by organization and keeps dimensions immutable", () => {
        store.stageUpsert(UPSERT_INPUT);
        expect(
            store.stageUpsert({
                ...UPSERT_INPUT,
                vectorId: "vec_beta",
                organizationId: "org_beta",
            })
        ).toMatchObject({ vectorId: "vec_beta", organizationId: "org_beta", rowPk: "message-1" });
        expect(() => store.stageUpsert({ ...UPSERT_INPUT, vectorId: "vec_collision" })).toThrow(
            /resource row already belongs/
        );
        expect(() => store.stageUpsert({ ...UPSERT_INPUT, dimensions: 2, values: [1, 2], nowMs: 101 })).toThrow(
            /dimensions cannot change/
        );
        db.run("UPDATE _chardb_vectors SET dimensions = 2 WHERE vector_id = 'vec_alpha'");
        expect(() => store.read("vec_alpha")).toThrow(/length does not match dimensions/);
    });

    test("rejects invalid dimensions, non-finite float32 values, and oversized or active metadata", () => {
        for (const [dimensions, values] of [
            [0, []],
            [2, [1]],
            [CDB_VECTOR_MAX_DIMENSIONS + 1, Array(CDB_VECTOR_MAX_DIMENSIONS + 1).fill(0)],
            [1, [Number.NaN]],
            [1, [Number.POSITIVE_INFINITY]],
            [1, [Number.MAX_VALUE]],
        ] as const) {
            expect(() => store.stageUpsert({ ...UPSERT_INPUT, dimensions, values })).toThrow();
        }
        expect(() =>
            store.stageUpsert({
                ...UPSERT_INPUT,
                metadata: { body: "x".repeat(CDB_VECTOR_MAX_METADATA_BYTES + 1) },
            })
        ).toThrow(/metadata exceeds/);
        expect(() => store.stageUpsert({ ...UPSERT_INPUT, metadata: { value: Number.NaN } })).toThrow(/finite/);
        const accessor = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(accessor, "value", { get: () => "not data", enumerable: true });
        expect(() => store.stageUpsert({ ...UPSERT_INPUT, metadata: accessor })).toThrow(/keys and fields/);
        expect(() => store.stageUpsert({ ...UPSERT_INPUT, metadata: new Date() as never })).toThrow(/plain data/);
        expect(() =>
            store.stageUpsert({
                ...UPSERT_INPUT,
                vectorId: "v".repeat(128),
                resourceId: "r".repeat(128),
            })
        ).toThrow(/physical vector id exceeds/);
    });

    test("pre-arms attempted-version settlement and reclaims only after lease expiry", () => {
        store.stageUpsert(UPSERT_INPUT);
        const first = claimUpsert(100, TOKEN_A, 100);
        expect(first).toMatchObject({
            targetVersion: 1,
            physicalId: "v1/messages_embedding/vec_alpha/1",
            leasedUntil: 150,
            attempt: 1,
        });
        expect(store.claimNext({ nowMs: 149, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toBeNull();
        expect(db.query("SELECT first_sent_at, settle_after FROM _chardb_vector_attempts").get()).toEqual({
            first_sent_at: 100,
            settle_after: 200,
        });

        expect(() => store.acknowledgeUpsert(first, 150)).toThrow(/no longer owns/);
        const retry = claimUpsert(150, TOKEN_B, 200);
        expect(retry).toMatchObject({ physicalId: first.physicalId, attempt: 2, leasedUntil: 200 });
        expect(db.query("SELECT first_sent_at, settle_after FROM _chardb_vector_attempts").get()).toEqual({
            first_sent_at: 100,
            settle_after: 350,
        });
        expect(() => store.acknowledgeUpsert(first, 151)).toThrow(/no longer owns/);
        expect(store.acknowledgeUpsert(retry, 199)).toMatchObject({ state: "ready", deliveredVersion: 1 });
        expect(db.query("SELECT * FROM _chardb_vector_outbox").get()).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_attempts").get()).toEqual({ count: 1 });
    });

    test("failure release preserves the attempted version and fences the old claimant", () => {
        store.stageUpsert(UPSERT_INPUT);
        const first = claimUpsert();
        store.failClaim({
            vectorId: first.vectorId,
            targetVersion: first.targetVersion,
            operation: first.operation,
            phase: first.phase,
            claimToken: first.claimToken,
            nextAttemptAt: 180,
            error: "remote timeout",
        });
        expect(store.claimNext({ nowMs: 179, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toBeNull();
        const retry = claimUpsert(180, TOKEN_B);
        expect(retry.physicalId).toBe(first.physicalId);
        expect(retry.attempt).toBe(2);
        expect(() => store.acknowledgeUpsert(first, 181)).toThrow(/no longer owns/);
        expect(() =>
            store.failClaim({
                vectorId: retry.vectorId,
                targetVersion: retry.targetVersion,
                operation: retry.operation,
                phase: retry.phase,
                claimToken: retry.claimToken,
                nextAttemptAt: 200,
                error: "x".repeat(CDB_VECTOR_MAX_ERROR_BYTES + 1),
            })
        ).toThrow(/error exceeds/);
    });

    test("does not confuse provider error text with the typed terminal state", () => {
        store.stageUpsert(UPSERT_INPUT);
        const claim = claimUpsert(100, TOKEN_A, 100);
        store.failClaim({
            vectorId: claim.vectorId,
            targetVersion: claim.targetVersion,
            operation: "upsert",
            phase: "submit",
            claimToken: claim.claimToken,
            nextAttemptAt: 101,
            error: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        expect(store.readDeliveryStatus(claim.vectorId)).toEqual({
            state: "active",
            lastError: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        expect(store.nextDueAt()).toBe(101);
    });

    test("a newer SQLite head invalidates an older claim and gets a distinct physical id", () => {
        store.stageUpsert(UPSERT_INPUT);
        const first = claimUpsert();
        expect(store.stageUpsert({ ...UPSERT_INPUT, values: [1, 2, 3], nowMs: 110 })).toMatchObject({
            version: 2,
            state: "pending",
        });
        expect(() => store.acknowledgeUpsert(first, 111)).toThrow(/no longer owns/);
        const second = claimUpsert(110, TOKEN_B);
        expect(second.physicalId).toBe("v1/messages_embedding/vec_alpha/2");
        expect(second.physicalId).not.toBe(first.physicalId);
    });

    test("cleans a superseded physical version after settlement and survives cleanup response loss", () => {
        store.stageUpsert(UPSERT_INPUT);
        const first = claimUpsert(100, TOKEN_A, 100);
        store.acknowledgeUpsert(first, 105);
        store.stageUpsert({ ...UPSERT_INPUT, values: [1, 2, 3], nowMs: 110 });
        const second = claimUpsert(110, TOKEN_B, 100);
        expect(store.acknowledgeUpsert(second, 120)).toMatchObject({
            version: 2,
            deliveredVersion: 2,
            state: "ready",
        });
        expect(db.query("SELECT operation, target_version FROM _chardb_vector_outbox").get()).toEqual({
            operation: "delete",
            target_version: 2,
        });

        expect(store.claimNext({ nowMs: 199, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C })).toBeNull();
        expect(db.query("SELECT next_attempt_at FROM _chardb_vector_outbox").get()).toEqual({
            next_attempt_at: 200,
        });
        const firstCleanup = store.claimNext({
            nowMs: 200,
            leaseMs: 50,
            settlementMs: 100,
            claimToken: TOKEN_C,
        });
        if (!firstCleanup || firstCleanup.operation !== "delete") throw new Error("expected superseded cleanup");
        expect(firstCleanup).toMatchObject({
            mode: "cleanup",
            physicalIds: [first.physicalId],
            targetVersion: 2,
        });
        expect(store.claimNext({ nowMs: 249, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toBeNull();
        const retry = store.claimNext({ nowMs: 250, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A });
        if (!retry || retry.operation !== "delete") throw new Error("expected reclaimed superseded cleanup");
        expect(retry).toMatchObject({ mode: "cleanup", physicalIds: [first.physicalId], attempt: 2 });
        expect(() => store.acknowledgeDelete(firstCleanup, 251)).toThrow(/no longer owns/);
        expect(() => store.acknowledgeDelete({ ...retry, physicalIds: [second.physicalId] }, 251)).toThrow(
            /cannot delete the current physical version/
        );
        expect(store.acknowledgeDelete(retry, 251)).toEqual({ deleted: false });
        expect(store.read("vec_alpha")).toMatchObject({ version: 2, deliveredVersion: 2, state: "ready" });
        expect(
            db.query("SELECT physical_version FROM _chardb_vector_attempts ORDER BY physical_version").all()
        ).toEqual([{ physical_version: 2 }]);
        expect(db.query("SELECT * FROM _chardb_vector_outbox").get()).toBeNull();
    });

    test("a logical delete absorbs a response-lost superseded cleanup without forgetting either version", () => {
        store.stageUpsert(UPSERT_INPUT);
        const first = claimUpsert(100, TOKEN_A, 100);
        store.acknowledgeUpsert(first, 105);
        store.stageUpsert({ ...UPSERT_INPUT, values: [1, 2, 3], nowMs: 110 });
        const second = claimUpsert(110, TOKEN_B, 100);
        store.acknowledgeUpsert(second, 120);
        const cleanup = store.claimNext({ nowMs: 200, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C });
        if (!cleanup || cleanup.operation !== "delete") throw new Error("expected superseded cleanup");
        expect(cleanup).toMatchObject({ mode: "cleanup", physicalIds: [first.physicalId] });

        store.stageDelete({ vectorId: "vec_alpha", organizationId: "org_alpha", nowMs: 201 });
        expect(() => store.acknowledgeDelete(cleanup, 202)).toThrow(/no longer owns/);
        expect(store.claimNext({ nowMs: 209, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toBeNull();
        expect(store.nextDueAt()).toBe(210);
        const finalPage = store.claimNext({ nowMs: 210, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!finalPage || finalPage.operation !== "delete") throw new Error("expected final logical delete page");
        expect(finalPage).toMatchObject({ mode: "delete", physicalIds: [first.physicalId, second.physicalId] });
        expect(store.acknowledgeDelete(finalPage, 211)).toEqual({ deleted: true });
        expect(store.read("vec_alpha")).toBeNull();
    });

    test("delete waits for every attempted version's settlement deadline and survives response loss", () => {
        store.stageUpsert(UPSERT_INPUT);
        const upsert = claimUpsert(100, TOKEN_A, 100);
        store.acknowledgeUpsert(upsert, 120);
        expect(store.stageDelete({ vectorId: upsert.vectorId, organizationId: "org_alpha", nowMs: 130 })).toMatchObject(
            {
                version: 2,
                state: "deleting",
                values: null,
            }
        );
        expect(store.claimNext({ nowMs: 199, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toBeNull();
        expect(db.query("SELECT next_attempt_at FROM _chardb_vector_outbox").get()).toEqual({ next_attempt_at: 200 });
        const firstDelete = store.claimNext({ nowMs: 200, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!firstDelete || firstDelete.operation !== "delete") throw new Error("expected delete claim");
        expect(firstDelete.physicalIds).toEqual(["v1/messages_embedding/vec_alpha/1"]);
        expect(store.claimNext({ nowMs: 249, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C })).toBeNull();
        const retry = store.claimNext({ nowMs: 250, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C });
        if (!retry || retry.operation !== "delete") throw new Error("expected reclaimed delete claim");
        expect(retry.physicalIds).toEqual(firstDelete.physicalIds);
        expect(() => store.acknowledgeDelete(firstDelete, 251)).toThrow(/no longer owns/);
        expect(store.acknowledgeDelete(retry, 251)).toEqual({ deleted: true });
        expect(store.read(upsert.vectorId)).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_attempts").get()).toEqual({ count: 0 });
    });

    test("a timed-out upsert stays tracked after delete and its late acknowledgement cannot revive the head", () => {
        store.stageUpsert(UPSERT_INPUT);
        const upsert = claimUpsert(100, TOKEN_A, 200);
        store.stageDelete({ vectorId: upsert.vectorId, organizationId: "org_alpha", nowMs: 110 });
        expect(() => store.acknowledgeUpsert(upsert, 120)).toThrow(/no longer owns/);
        expect(store.claimNext({ nowMs: 299, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toBeNull();
        const deletion = store.claimNext({ nowMs: 300, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected delete after settlement");
        expect(deletion.physicalIds).toEqual([upsert.physicalId]);
        expect(store.read(upsert.vectorId)).toMatchObject({ state: "deleting" });
    });

    test("dead-letters an unprovable delete durably and removes it from the alarm schedule", () => {
        store.stageUpsert(UPSERT_INPUT);
        const upsert = claimUpsert(100, TOKEN_A, 100);
        store.failClaim({
            vectorId: upsert.vectorId,
            targetVersion: upsert.targetVersion,
            operation: "upsert",
            phase: "submit",
            claimToken: upsert.claimToken,
            nextAttemptAt: 101,
            error: "response lost",
        });
        store.stageDelete({ vectorId: upsert.vectorId, organizationId: "org_alpha", nowMs: 110 });
        expect(store.claimNext({ nowMs: 199, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toBeNull();
        const deletion = store.claimNext({ nowMs: 200, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected uncertain delete claim");
        expect(store.deleteClaimHasUncertainAttempts(deletion, 201)).toBe(true);

        store.terminallyFailUnprovenDelete(deletion, 201);

        expect(
            db.query("SELECT leased_until, lease_token, terminal_failure, last_error FROM _chardb_vector_outbox").get()
        ).toEqual({
            leased_until: null,
            lease_token: null,
            terminal_failure: 1,
            last_error: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        expect(new CdbVectorOutboxStore(sql).readDeliveryStatus(upsert.vectorId)).toEqual({
            state: "failed_unproven",
            lastError: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        expect(new CdbVectorOutboxStore(sql).nextDueAt()).toBeNull();
        expect(
            new CdbVectorOutboxStore(sql).claimNext({
                nowMs: Number.MAX_SAFE_INTEGER - 100,
                leaseMs: 50,
                settlementMs: 50,
                claimToken: TOKEN_C,
            })
        ).toBeNull();
        expect(store.read(upsert.vectorId)).toMatchObject({ state: "deleting", deliveredVersion: 0 });
    });

    test("retains exact cleanup for an accepted version superseded before visibility", () => {
        store.stageUpsert(UPSERT_INPUT);
        const first = claimUpsert(100, TOKEN_A, 100);
        store.acceptSubmission(first, "accepted-first", 101, 102);
        store.stageUpsert({ ...UPSERT_INPUT, values: [1, 0, 0], nowMs: 103 });
        const second = claimUpsert(103, TOKEN_B, 100);
        store.acknowledgeUpsert(second, 104);
        store.stageDelete({ vectorId: first.vectorId, organizationId: "org_alpha", nowMs: 105 });

        const deletion = store.claimNext({ nowMs: 203, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected exact cleanup claim");
        expect(deletion.physicalIds).toEqual([first.physicalId, second.physicalId]);
        expect(store.acknowledgeDelete(deletion, 204)).toEqual({ deleted: false });
        expect(store.read(first.vectorId)).toMatchObject({ state: "deleting" });
        expect(
            db
                .query(
                    `SELECT physical_version, visibility_confirmed, response_ambiguous, delete_confirmed
                     FROM _chardb_vector_attempts ORDER BY physical_version`
                )
                .all()
        ).toEqual([
            { physical_version: 1, visibility_confirmed: 0, response_ambiguous: 0, delete_confirmed: 0 },
            { physical_version: 2, visibility_confirmed: 1, response_ambiguous: 0, delete_confirmed: 1 },
        ]);
        expect(store.claimNext({ nowMs: 300_203, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_D })).toBeNull();
        const repeated = store.claimNext({
            nowMs: 300_204,
            leaseMs: 50,
            settlementMs: 100,
            claimToken: TOKEN_D,
        });
        if (!repeated || repeated.operation !== "delete") throw new Error("expected periodic exact cleanup claim");
        expect(repeated.physicalIds).toEqual([first.physicalId]);
    });

    test("pages deletion attempts at the exact id and byte bounds", () => {
        store.stageUpsert(UPSERT_INPUT);
        store.stageDelete({ vectorId: "vec_alpha", organizationId: "org_alpha", nowMs: 101 });
        db.run("UPDATE _chardb_vectors SET version = 34 WHERE vector_id = 'vec_alpha'");
        db.run("UPDATE _chardb_vector_outbox SET target_version = 34 WHERE vector_id = 'vec_alpha'");
        for (let version = 1; version <= CDB_VECTOR_MAX_DELETE_IDS + 1; version++) {
            db.run(
                `INSERT INTO _chardb_vector_attempts
                 (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed, delete_confirmed)
                 VALUES ('vec_alpha', ?, 1, 2, 1, 0)`,
                [version]
            );
        }
        const first = store.claimNext({ nowMs: 102, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A });
        if (!first || first.operation !== "delete") throw new Error("expected first delete page");
        expect(first.physicalIds).toHaveLength(CDB_VECTOR_MAX_DELETE_IDS);
        expect(store.acknowledgeDelete(first, 103)).toEqual({ deleted: false });
        const second = store.claimNext({ nowMs: 103, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!second || second.operation !== "delete") throw new Error("expected second delete page");
        expect(second.physicalIds).toEqual([`v1/messages_embedding/vec_alpha/${CDB_VECTOR_MAX_DELETE_IDS + 1}`]);
        expect(store.acknowledgeDelete(second, 104)).toEqual({ deleted: true });
    });

    test("does not freeze a partial delete page before every attempted version can settle", () => {
        const first = store.stageUpsert(UPSERT_INPUT);
        const firstClaim = claimUpsert(100, TOKEN_A, 100);
        store.acknowledgeUpsert(firstClaim, 101);
        store.stageUpsert({ ...UPSERT_INPUT, values: [1, 0, 0], nowMs: 102 });
        const secondClaim = claimUpsert(102, TOKEN_B, 200);
        store.acknowledgeUpsert(secondClaim, 103);
        store.stageDelete({ vectorId: first.vectorId, organizationId: first.organizationId, nowMs: 104 });

        expect(store.claimNext({ nowMs: 200, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C })).toBeNull();
        expect(store.nextDueAt()).toBe(302);
        expect(db.query("SELECT attempts, verify_ids_json FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 0,
            verify_ids_json: null,
        });

        const deletion = store.claimNext({ nowMs: 302, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected complete delete page");
        expect(deletion.physicalIds).toEqual([firstClaim.physicalId, secondClaim.physicalId]);
    });

    test("pages superseded cleanup without deleting or forgetting the current physical version", () => {
        store.stageUpsert(UPSERT_INPUT);
        db.run(
            "UPDATE _chardb_vectors SET version = 34, delivered_version = 34, state = 'ready' WHERE vector_id = 'vec_alpha'"
        );
        db.run(
            "UPDATE _chardb_vector_outbox SET target_version = 34, operation = 'delete' WHERE vector_id = 'vec_alpha'"
        );
        for (let version = 1; version <= CDB_VECTOR_MAX_DELETE_IDS + 2; version++) {
            db.run(
                `INSERT INTO _chardb_vector_attempts
                 (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed, delete_confirmed)
                 VALUES ('vec_alpha', ?, 1, 2, 1, 0)`,
                [version]
            );
        }
        const first = store.claimNext({ nowMs: 102, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A });
        if (!first || first.operation !== "delete") throw new Error("expected first cleanup page");
        expect(first.mode).toBe("cleanup");
        expect(first.physicalIds).toHaveLength(CDB_VECTOR_MAX_DELETE_IDS);
        expect(store.acknowledgeDelete(first, 103)).toEqual({ deleted: false });

        const second = store.claimNext({ nowMs: 103, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!second || second.operation !== "delete") throw new Error("expected second cleanup page");
        expect(second).toMatchObject({
            mode: "cleanup",
            physicalIds: [`v1/messages_embedding/vec_alpha/${CDB_VECTOR_MAX_DELETE_IDS + 1}`],
        });
        expect(store.acknowledgeDelete(second, 104)).toEqual({ deleted: false });
        expect(store.read("vec_alpha")).toMatchObject({ version: 34, deliveredVersion: 34, state: "ready" });
        expect(db.query("SELECT physical_version FROM _chardb_vector_attempts").all()).toEqual([
            { physical_version: 34 },
        ]);
    });

    test("shortens a delete page before its encoded physical IDs cross the byte limit", () => {
        const vectorId = "v".repeat(128);
        const resourceId = "r".repeat(121);
        store.stageUpsert({ ...UPSERT_INPUT, vectorId, resourceId });
        store.stageDelete({ vectorId, organizationId: "org_alpha", nowMs: 101 });
        db.run("UPDATE _chardb_vectors SET version = 34 WHERE vector_id = ?", [vectorId]);
        db.run("UPDATE _chardb_vector_outbox SET target_version = 34 WHERE vector_id = ?", [vectorId]);
        for (let version = 1; version <= CDB_VECTOR_MAX_DELETE_IDS + 1; version++) {
            db.run(
                `INSERT INTO _chardb_vector_attempts
                 (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed, delete_confirmed)
                 VALUES (?, ?, 1, 2, 1, 0)`,
                [vectorId, version]
            );
        }
        const claim = store.claimNext({ nowMs: 102, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A });
        if (!claim || claim.operation !== "delete") throw new Error("expected byte-bounded delete page");
        expect(claim.physicalIds.length).toBeGreaterThan(0);
        expect(claim.physicalIds.length).toBeLessThan(CDB_VECTOR_MAX_DELETE_IDS);
        expect(new TextEncoder().encode(JSON.stringify(claim.physicalIds)).byteLength).toBeLessThanOrEqual(
            CDB_VECTOR_MAX_DELETE_ID_BYTES
        );
    });

    test("drains byte-bounded mixed-proof pages exactly across response loss and reconstruction", () => {
        const vectorId = "v".repeat(128);
        const resourceId = "r".repeat(121);
        store.stageUpsert({ ...UPSERT_INPUT, vectorId, resourceId });
        store.stageDelete({ vectorId, organizationId: "org_alpha", nowMs: 101 });
        db.run("UPDATE _chardb_vectors SET version = 65 WHERE vector_id = ?", [vectorId]);
        db.run("UPDATE _chardb_vector_outbox SET target_version = 65 WHERE vector_id = ?", [vectorId]);

        const expected = new Set<string>();
        for (let version = 1; version <= 64; version++) {
            const confirmed = version % 5 === 0 ? 1 : 0;
            db.run(
                `INSERT INTO _chardb_vector_attempts
                 (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed, delete_confirmed)
                 VALUES (?, ?, 1, ?, 1, ?)`,
                [vectorId, version, confirmed === 1 ? Number.MAX_SAFE_INTEGER : 2, confirmed]
            );
            if (confirmed === 0) expected.add(`v1/${resourceId}/${vectorId}/${version}`);
        }

        const lost = store.claimNext({ nowMs: 102, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A });
        if (!lost || lost.operation !== "delete") throw new Error("expected a response-lost delete page");
        expect(lost.physicalIds.length).toBeGreaterThan(0);
        expect(lost.physicalIds.length).toBeLessThan(CDB_VECTOR_MAX_DELETE_IDS);
        expect(new TextEncoder().encode(JSON.stringify(lost.physicalIds)).byteLength).toBeLessThanOrEqual(
            CDB_VECTOR_MAX_DELETE_ID_BYTES
        );

        store = new CdbVectorOutboxStore(sql);
        const replay = store.claimNext({ nowMs: 152, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!replay || replay.operation !== "delete") throw new Error("expected the reconstructed delete page");
        expect(replay.physicalIds).toEqual(lost.physicalIds);
        expect(() => store.acknowledgeDelete(lost, 153)).toThrow(/no longer owns/);

        const observed = new Set(replay.physicalIds);
        expect(store.acknowledgeDelete(replay, 153)).toEqual({ deleted: false });
        let token = TOKEN_C;
        for (let page = 0; page < 8 && store.read(vectorId); page++) {
            store = new CdbVectorOutboxStore(sql);
            const claim = store.claimNext({ nowMs: 153 + page, leaseMs: 50, settlementMs: 100, claimToken: token });
            if (!claim || claim.operation !== "delete") throw new Error("expected the next mixed-proof delete page");
            expect(new TextEncoder().encode(JSON.stringify(claim.physicalIds)).byteLength).toBeLessThanOrEqual(
                CDB_VECTOR_MAX_DELETE_ID_BYTES
            );
            for (const physicalId of claim.physicalIds) {
                expect(observed.has(physicalId)).toBe(false);
                observed.add(physicalId);
            }
            store.acknowledgeDelete(claim, 154 + page);
            token = token === TOKEN_C ? TOKEN_D : TOKEN_C;
        }

        expect(observed).toEqual(expected);
        expect(store.read(vectorId)).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_attempts").get()).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_outbox").get()).toEqual({ count: 0 });
    });

    test("caps retained attempted versions before taking an outbox lease", () => {
        store.stageUpsert(UPSERT_INPUT);
        for (let version = 2; version <= CDB_VECTOR_MAX_ATTEMPT_VERSIONS + 1; version++) {
            db.run(
                `INSERT INTO _chardb_vector_attempts
                 (vector_id, physical_version, first_sent_at, settle_after, delete_confirmed)
                 VALUES ('vec_alpha', ?, 1, 2, 0)`,
                [version]
            );
        }
        expect(() => store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toThrow(
            /attempt ledger reached/
        );
        expect(db.query("SELECT attempts, leased_until, lease_token FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 0,
            leased_until: null,
            lease_token: null,
        });
        db.run(
            `INSERT INTO _chardb_vector_attempts
             (vector_id, physical_version, first_sent_at, settle_after, delete_confirmed)
             VALUES ('vec_alpha', 1, 1, 2, 0)`
        );
        expect(() => store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toThrow(
            /exceeds its retained-version bound/
        );
    });

    test("deletes a never-attempted head through an exact zero-id claim", () => {
        store.stageUpsert(UPSERT_INPUT);
        store.stageDelete({ vectorId: "vec_alpha", organizationId: "org_alpha", nowMs: 101 });
        const deletion = store.claimNext({ nowMs: 101, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected zero-id delete claim");
        expect(deletion.physicalIds).toEqual([]);
        expect(store.acknowledgeDelete(deletion, 102)).toEqual({ deleted: true });
    });

    test("expires and reclaims a zero-id delete without accepting the late claimant", () => {
        store.stageUpsert(UPSERT_INPUT);
        store.stageDelete({ vectorId: "vec_alpha", organizationId: "org_alpha", nowMs: 101 });
        const expired = store.claimNext({ nowMs: 101, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A });
        if (!expired || expired.operation !== "delete") throw new Error("expected zero-id delete claim");
        expect(expired.physicalIds).toEqual([]);
        store = new CdbVectorOutboxStore(sql);
        expect(() => store.acknowledgeDelete(expired, 151)).toThrow(/no longer owns/);

        const retry = store.claimNext({ nowMs: 151, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!retry || retry.operation !== "delete") throw new Error("expected reclaimed zero-id delete claim");
        expect(retry).toMatchObject({ physicalIds: [], attempt: 2 });
        expect(store.acknowledgeDelete(retry, 152)).toEqual({ deleted: true });
    });

    test("does not let an empty acknowledgement skip a claimed physical delete", () => {
        store.stageUpsert(UPSERT_INPUT);
        const upsert = claimUpsert(100, TOKEN_A, 1);
        store.acknowledgeUpsert(upsert, 101);
        store.stageDelete({ vectorId: "vec_alpha", organizationId: "org_alpha", nowMs: 102 });
        const deletion = store.claimNext({ nowMs: 102, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected physical delete claim");
        expect(deletion.physicalIds).toEqual([upsert.physicalId]);

        expect(store.acknowledgeDelete({ ...deletion, physicalIds: [] }, 103)).toEqual({ deleted: false });
        expect(store.read("vec_alpha")).toMatchObject({ state: "deleting" });
        const retry = store.claimNext({ nowMs: 103, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_C });
        if (!retry || retry.operation !== "delete") throw new Error("expected retried physical delete claim");
        expect(retry.physicalIds).toEqual([upsert.physicalId]);
        expect(store.acknowledgeDelete(retry, 104)).toEqual({ deleted: true });
    });

    test("gives another due vshard a turn before draining a hot vshard", () => {
        const [hot, cold] = organizationsByPlacement();
        for (let index = 0; index < 3; index++) {
            store.stageUpsert({
                ...UPSERT_INPUT,
                vectorId: `vec_hot_${index}`,
                organizationId: hot,
                rowPk: `hot-${index}`,
            });
        }
        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_cold",
            organizationId: cold,
            rowPk: "cold",
        });

        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toMatchObject({
            vectorId: "vec_hot_0",
            organizationId: hot,
        });
        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toMatchObject({
            vectorId: "vec_cold",
            organizationId: cold,
        });
        expect(db.query("SELECT attempts FROM _chardb_vector_outbox WHERE vector_id = 'vec_hot_1'").get()).toEqual({
            attempts: 0,
        });
    });

    test("persists the vshard turn across store reconstruction", () => {
        const [firstOrganization, secondOrganization] = organizationsByPlacement();
        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_before_restart",
            organizationId: firstOrganization,
            rowPk: "before-restart",
        });
        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_after_restart",
            organizationId: secondOrganization,
            rowPk: "after-restart",
        });

        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toMatchObject({
            vectorId: "vec_before_restart",
        });
        const persisted = db.query("SELECT next_vshard FROM _chardb_vector_scheduler").get() as {
            next_vshard: number;
        };
        expect(persisted.next_vshard).toBe(Number(vshardOf([firstOrganization])) + 1);

        store = new CdbVectorOutboxStore(sql);
        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toMatchObject({
            vectorId: "vec_after_restart",
        });
    });

    test("wraps the durable cursor at the exact vshard cap", () => {
        const organizationId = organizationAtPlacement(VSHARD_COUNT - 1);
        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_last_vshard",
            organizationId,
            rowPk: "last-vshard",
        });
        db.run("UPDATE _chardb_vector_scheduler SET next_vshard = ?", [VSHARD_COUNT - 1]);

        expect(store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toMatchObject({
            vectorId: "vec_last_vshard",
            placementVshard: VSHARD_COUNT - 1,
        });
        expect(db.query("SELECT next_vshard FROM _chardb_vector_scheduler").get()).toEqual({ next_vshard: 0 });
        expect(() => db.run("UPDATE _chardb_vector_scheduler SET next_vshard = ?", [VSHARD_COUNT])).toThrow();
    });

    test("adds scheduler state to an existing vector store without rewriting its rows", () => {
        store.stageUpsert(UPSERT_INPUT);
        db.run("DROP TABLE _chardb_vector_scheduler");

        initializeCdbVectorOutboxStore(sql);

        expect(store.read("vec_alpha")).toMatchObject({ vectorId: "vec_alpha", organizationId: "org_alpha" });
        expect(db.query("SELECT singleton, next_vshard FROM _chardb_vector_scheduler").get()).toEqual({
            singleton: 1,
            next_vshard: 0,
        });
    });

    test("backfills immutable insertion generations for a legacy vector store", () => {
        store.stageUpsert(UPSERT_INPUT);
        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_beta",
            organizationId: "org_beta",
            rowPk: "message-2",
            nowMs: 101,
        });
        const legacyRows = db.query("SELECT rowid, vector_id FROM _chardb_vectors ORDER BY rowid").all() as {
            rowid: number;
            vector_id: string;
        }[];

        db.run("DROP TRIGGER _chardb_vectors_created_seq_required");
        db.run("DROP TRIGGER _chardb_vectors_created_seq_immutable");
        db.run("DROP INDEX _chardb_vectors_created_seq");
        db.run("DROP TABLE _chardb_vector_head_sequence");
        db.run("ALTER TABLE _chardb_vectors DROP COLUMN created_seq");

        initializeCdbVectorOutboxStore(sql);

        expect(db.query("SELECT created_seq, vector_id FROM _chardb_vectors ORDER BY rowid").all()).toEqual(
            legacyRows.map(row => ({ created_seq: row.rowid, vector_id: row.vector_id }))
        );
        expect(db.query("SELECT singleton, last_seq FROM _chardb_vector_head_sequence").get()).toEqual({
            singleton: 1,
            last_seq: legacyRows.at(-1)?.rowid,
        });
        expect(() => db.run("UPDATE _chardb_vectors SET created_seq = created_seq + 1")).toThrow(/immutable/);
    });

    test("reconstructs a lagging insertion sequence and advances it only for new heads", () => {
        store.stageUpsert(UPSERT_INPUT);
        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_beta",
            organizationId: "org_beta",
            rowPk: "message-2",
            nowMs: 101,
        });
        const before = db.query("SELECT vector_id, created_seq FROM _chardb_vectors ORDER BY created_seq").all();
        expect(before).toEqual([
            { vector_id: "vec_alpha", created_seq: 1 },
            { vector_id: "vec_beta", created_seq: 2 },
        ]);

        db.run("UPDATE _chardb_vector_head_sequence SET last_seq = 0 WHERE singleton = 1");
        initializeCdbVectorOutboxStore(sql);
        expect(db.query("SELECT last_seq FROM _chardb_vector_head_sequence").get()).toEqual({ last_seq: 2 });

        store.stageUpsert({ ...UPSERT_INPUT, values: [1, 2, 3], nowMs: 102 });
        expect(db.query("SELECT created_seq FROM _chardb_vectors WHERE vector_id = 'vec_alpha'").get()).toEqual({
            created_seq: 1,
        });
        expect(db.query("SELECT last_seq FROM _chardb_vector_head_sequence").get()).toEqual({ last_seq: 2 });

        store.stageUpsert({
            ...UPSERT_INPUT,
            vectorId: "vec_gamma",
            organizationId: "org_gamma",
            rowPk: "message-3",
            nowMs: 103,
        });
        expect(db.query("SELECT created_seq FROM _chardb_vectors WHERE vector_id = 'vec_gamma'").get()).toEqual({
            created_seq: 3,
        });
        expect(db.query("SELECT last_seq FROM _chardb_vector_head_sequence").get()).toEqual({ last_seq: 3 });
    });

    test("fails closed on an invalid stored insertion generation", () => {
        store.stageUpsert(UPSERT_INPUT);
        db.run("DROP TRIGGER _chardb_vectors_created_seq_immutable");
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE _chardb_vectors SET created_seq = 0");

        expect(() => initializeCdbVectorOutboxStore(sql)).toThrow(/insertion generation is invalid/);
    });

    test("fails closed on malformed lifecycle, lease identity, counters, and future delete attempts", () => {
        store.stageUpsert(UPSERT_INPUT);
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE _chardb_vectors SET state = 'corrupt'");
        expect(() => store.read("vec_alpha")).toThrow(/lifecycle state/);

        db.run("UPDATE _chardb_vectors SET state = 'pending', delivered_version = 0");
        db.run("UPDATE _chardb_vector_outbox SET lease_token = ?", [TOKEN_A]);
        expect(() => store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toThrow(
            /lease identity/
        );

        db.run("UPDATE _chardb_vector_outbox SET lease_token = NULL, attempts = ?", [Number.MAX_SAFE_INTEGER]);
        expect(() => store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toThrow(
            /attempt counter overflowed/
        );
        expect(db.query("SELECT leased_until, lease_token FROM _chardb_vector_outbox").get()).toEqual({
            leased_until: null,
            lease_token: null,
        });

        db.run("UPDATE _chardb_vector_outbox SET attempts = 0");
        store.stageDelete({ vectorId: "vec_alpha", organizationId: "org_alpha", nowMs: 101 });
        db.run(
            `INSERT INTO _chardb_vector_attempts
             (vector_id, physical_version, first_sent_at, settle_after, delete_confirmed)
             VALUES ('vec_alpha', 2, 1, 2, 0)`
        );
        expect(() => store.claimNext({ nowMs: 101, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B })).toThrow(
            /exceeds the vector head/
        );
        expect(db.query("SELECT attempts, leased_until, lease_token FROM _chardb_vector_outbox").get()).toEqual({
            attempts: 0,
            leased_until: null,
            lease_token: null,
        });
    });

    test("fails closed on placement drift, outbox generation drift, and forged delete settlement", () => {
        store.stageUpsert(UPSERT_INPUT);
        db.run("UPDATE _chardb_vectors SET placement_vshard = (placement_vshard + 1) % 16384");
        expect(() => store.read("vec_alpha")).toThrow(/placement/);
        expect(() => store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toThrow(
            /placement/
        );

        db.run("DELETE FROM _chardb_vectors");
        store.stageUpsert(UPSERT_INPUT);
        const upsert = claimUpsert();
        store.acknowledgeUpsert(upsert, 101);
        store.stageDelete({ vectorId: "vec_alpha", organizationId: "org_alpha", nowMs: 200 });
        const deletion = store.claimNext({ nowMs: 200, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_B });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected settled delete claim");
        expect(() =>
            store.acknowledgeDelete(
                {
                    ...deletion,
                    resourceId: "forged_resource",
                    physicalIds: ["v1/forged_resource/vec_alpha/1"],
                },
                201
            )
        ).toThrow(/identity does not match/);
        expect(() =>
            store.acknowledgeDelete({ ...deletion, physicalIds: ["v1/messages_embedding/vec_alpha/999"] }, 201)
        ).toThrow(/does not own/);
        expect(store.acknowledgeDelete(deletion, 201)).toEqual({ deleted: true });

        store.stageUpsert({ ...UPSERT_INPUT, nowMs: 300 });
        db.run("UPDATE _chardb_vectors SET metadata_json = '[]'");
        expect(() => store.read("vec_alpha")).toThrow(/metadata is not an object/);
        db.run("UPDATE _chardb_vectors SET metadata_json = '{}', state = 'ready', delivered_version = version");
        db.run("UPDATE _chardb_vector_outbox SET next_attempt_at = 100");
        expect(() => store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toThrow(
            /operation does not match/
        );
        db.run("UPDATE _chardb_vectors SET state = 'pending', delivered_version = 0");
        db.run("UPDATE _chardb_vector_outbox SET operation = 'upsert'");
        db.run("UPDATE _chardb_vector_outbox SET target_version = target_version + 1, next_attempt_at = 100");
        expect(() => store.claimNext({ nowMs: 100, leaseMs: 50, settlementMs: 100, claimToken: TOKEN_A })).toThrow(
            /target does not match/
        );
    });

    test("maintains exact capacity counters and reconciles an interrupted first boot only once", () => {
        store.stageUpsert(UPSERT_INPUT);
        const claim = claimUpsert();
        store.acknowledgeUpsert(claim, 101);
        expect(
            db
                .query(
                    `SELECT reconciled, head_count, stored_bytes, outbox_rows, attempt_rows
                 FROM _chardb_vector_capacity WHERE singleton = 1`
                )
                .get()
        ).toEqual({ reconciled: 1, head_count: 1, stored_bytes: 76, outbox_rows: 0, attempt_rows: 1 });

        db.run(
            `UPDATE _chardb_vector_capacity
             SET reconciled = 0, head_count = 0, stored_bytes = 0, outbox_rows = 0, attempt_rows = 0`
        );
        initializeCdbVectorOutboxStore(sql);
        expect(
            db
                .query(
                    `SELECT reconciled, head_count, stored_bytes, outbox_rows, attempt_rows
                 FROM _chardb_vector_capacity WHERE singleton = 1`
                )
                .get()
        ).toEqual({ reconciled: 1, head_count: 1, stored_bytes: 76, outbox_rows: 0, attempt_rows: 1 });

        let aggregateReconciliations = 0;
        const observed: SyncSql = {
            ...sql,
            exec(query, ...params) {
                if (query.includes("head_count = (SELECT COUNT(*) FROM _chardb_vectors")) {
                    aggregateReconciliations++;
                }
                sql.exec(query, ...params);
            },
        };
        initializeCdbVectorOutboxStore(observed);
        expect(aggregateReconciliations).toBe(0);

        db.run("DELETE FROM _chardb_vectors");
        expect(
            db
                .query(
                    `SELECT head_count, stored_bytes, outbox_rows, attempt_rows
                 FROM _chardb_vector_capacity WHERE singleton = 1`
                )
                .get()
        ).toEqual({ head_count: 0, stored_bytes: 0, outbox_rows: 0, attempt_rows: 0 });

        store.stageUpsert(UPSERT_INPUT);
        db.run("DELETE FROM _chardb_vector_capacity");
        expect(() => db.run("DELETE FROM _chardb_vectors")).toThrow(/capacity accounting is unavailable/);
        initializeCdbVectorOutboxStore(sql);
        expect(db.query("SELECT reconciled, head_count FROM _chardb_vector_capacity").get()).toEqual({
            reconciled: 1,
            head_count: 1,
        });
    });
});
