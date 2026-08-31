import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../../src/server/do/cdb-routing-fence-store.ts";
import {
    CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE,
    CdbVectorOrganizationDeletionStore,
    initializeCdbVectorOrganizationDeletionStore,
    installCdbVectorOrganizationDeletionGuards,
    uninstallCdbVectorOrganizationDeletionGuards,
} from "../../src/server/do/cdb-vector-organization-deletion-store.ts";
import {
    CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
    CDB_VECTOR_MAX_OUTBOX_ROWS,
    CdbVectorOutboxStore,
    initializeCdbVectorOutboxStore,
} from "../../src/server/do/cdb-vector-outbox-store.ts";
import { vshardOf } from "../../src/vshard.ts";

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

interface SeedHeadOptions {
    readonly organizationId?: string;
    readonly state?: "pending" | "ready";
    readonly version?: number;
    readonly outbox?: boolean;
}

describe("Cdb vector organization deletion store", () => {
    let db: Database;
    let sql: SyncSql;
    let store: CdbVectorOrganizationDeletionStore;

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(SPLIT_LOG_DDL);
        db.exec(CDB_ROUTING_FENCE_STORE_DDL);
        sql = syncSql(db);
        initializeCdbVectorOutboxStore(sql);
        initializeCdbVectorOrganizationDeletionStore(sql);
        store = new CdbVectorOrganizationDeletionStore(sql, callback => db.transaction(callback)());
    });

    afterEach(() => db.close());

    function seedHead(createdSeq: number, options: SeedHeadOptions = {}): string {
        const organizationId = options.organizationId ?? "org_delete";
        const state = options.state ?? "ready";
        const version = options.version ?? 1;
        const deliveredVersion = state === "ready" ? version : Math.max(0, version - 1);
        const vectorId = `vec_${organizationId}_${createdSeq}`;
        db.run(
            `INSERT INTO _chardb_vectors
               (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions,
                version, delivered_version, values_enc, metadata_json, state, updated_at)
             VALUES (?, ?, ?, ?, 'embedding', ?, 1, ?, ?, ?, '{}', ?, 1)`,
            [
                vectorId,
                createdSeq,
                organizationId,
                Number(vshardOf([organizationId])),
                `row-${createdSeq}`,
                version,
                deliveredVersion,
                new Uint8Array(4),
                state,
            ]
        );
        if (options.outbox) {
            db.run(
                `INSERT INTO _chardb_vector_outbox
                   (vector_id, target_version, operation, phase, attempts, next_attempt_at)
                 VALUES (?, ?, 'upsert', 'submit', 0, 1)`,
                [vectorId, version]
            );
        }
        return vectorId;
    }

    function insertTombstone(organizationId: string, deletedAt: number): void {
        db.run(
            `INSERT INTO _chardb_deleted_organizations
               (organization_id, deleted_at, placement_vshard) VALUES (?, ?, ?)`,
            [organizationId, deletedAt, Number(vshardOf([organizationId]))]
        );
    }

    function attempt(
        vectorId: string,
        physicalVersion: number,
        flags: { readonly confirmed?: boolean; readonly ambiguous?: boolean } = {}
    ): void {
        db.run(
            `INSERT INTO _chardb_vector_attempts
               (vector_id, physical_version, first_sent_at, settle_after,
                visibility_confirmed, response_ambiguous, delete_confirmed)
             VALUES (?, ?, 1, 2, ?, ?, 0)`,
            [vectorId, physicalVersion, flags.confirmed ? 1 : 0, flags.ambiguous ? 1 : 0]
        );
    }

    test("uses the tombstone as a permanent guard with an explicit destination lifecycle", () => {
        const first = store.fenceOrganization({ organizationId: "org_delete", nowMs: 10 });
        expect(store.fenceOrganization({ organizationId: "org_delete", nowMs: 99 })).toEqual(first);
        expect(first.deletedAt).toBe(10);
        const outbox = new CdbVectorOutboxStore(sql);
        const lateUpsert = () =>
            outbox.stageUpsert({
                vectorId: "late_vector",
                organizationId: "org_delete",
                resourceId: "embedding",
                rowPk: "late-row",
                dimensions: 1,
                values: [1],
                metadata: {},
                nowMs: 100,
            });
        expect(lateUpsert).toThrow(/vector organization was deleted/);

        uninstallCdbVectorOrganizationDeletionGuards(sql);
        expect(lateUpsert()).toMatchObject({ state: "pending", version: 1 });
        installCdbVectorOrganizationDeletionGuards(sql);
        expect(lateUpsert).toThrow(/vector organization was deleted/);
        expect(store.stageNextPage({ organizationId: "org_delete", nowMs: 102 })).toMatchObject({
            staged: 1,
            done: true,
        });
    });

    test("stages pending and ready heads once while retaining every attempted physical version", () => {
        const pending = seedHead(1, { state: "pending", outbox: true });
        attempt(pending, 1, { ambiguous: true });
        const ready = seedHead(2, { state: "ready", version: 2 });
        attempt(ready, 1, { confirmed: true });
        attempt(ready, 2, { ambiguous: true });
        store.fenceOrganization({ organizationId: "org_delete", nowMs: 20 });

        expect(store.stageNextPage({ organizationId: "org_delete", nowMs: 21 })).toEqual({
            organizationId: "org_delete",
            staged: 2,
            done: true,
        });
        expect(db.query("SELECT vector_id, version, state FROM _chardb_vectors ORDER BY created_seq").all()).toEqual([
            { vector_id: pending, version: 2, state: "deleting" },
            { vector_id: ready, version: 3, state: "deleting" },
        ]);
        expect(store.stageNextPage({ organizationId: "org_delete", nowMs: 50 })).toMatchObject({
            staged: 0,
            done: true,
        });
        expect(
            db
                .query(
                    `SELECT vector_id, physical_version, visibility_confirmed, response_ambiguous
                     FROM _chardb_vector_attempts ORDER BY vector_id, physical_version`
                )
                .all()
        ).toEqual([
            { vector_id: pending, physical_version: 1, visibility_confirmed: 0, response_ambiguous: 1 },
            { vector_id: ready, physical_version: 1, visibility_confirmed: 1, response_ambiguous: 0 },
            { vector_id: ready, physical_version: 2, visibility_confirmed: 0, response_ambiguous: 1 },
        ]);
    });

    test("one typed failure stops the whole organization and exposes exact purge status", () => {
        const first = seedHead(1);
        seedHead(2);
        store.acceptOrganization({ organizationId: "org_delete", nowMs: 10 });
        db.run(
            `UPDATE _chardb_vector_outbox
             SET terminal_failure = 1, last_error = ?
             WHERE vector_id = ?`,
            [CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR, first]
        );

        expect(store.nextPendingPage()).toBeNull();
        expect(new CdbVectorOutboxStore(sql).nextDueAt()).toBeNull();
        expect(() => store.stageNextPage({ organizationId: "org_delete", nowMs: 11 })).toThrow(
            "external purge requires manual intervention"
        );
        expect(store.readPurgeStatus("org_delete")).toEqual({
            organizationId: "org_delete",
            state: "failed_unproven",
            remainingHeads: 2,
            outboxRows: 2,
            attemptRows: 0,
            unprovenTurns: 0,
            lastError: CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR,
        });
        const plan = db
            .query(
                `EXPLAIN QUERY PLAN SELECT 1 FROM _chardb_vectors AS failed_head
                   INDEXED BY _chardb_vectors_deleting_by_organization
                 INNER JOIN _chardb_vector_outbox AS failed_outbox
                   ON failed_outbox.vector_id = failed_head.vector_id
                 WHERE failed_head.organization_id = ? AND failed_head.state = 'deleting'
                   AND failed_outbox.terminal_failure = 1 LIMIT 1`
            )
            .all("org_delete") as Array<{ detail: string }>;
        expect(plan.some(row => row.detail.includes("_chardb_vectors_deleting_by_organization"))).toBe(true);
    });

    test("commits the Better Auth deletion fence when a prior live-org delete already needs manual proof", () => {
        const vectorId = seedHead(1);
        new CdbVectorOutboxStore(sql).stageDelete({
            vectorId,
            organizationId: "org_delete",
            nowMs: 2,
        });
        db.run(
            `UPDATE _chardb_vector_outbox
             SET terminal_failure = 1, last_error = ? WHERE vector_id = ?`,
            [CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR, vectorId]
        );

        expect(store.readPurgeStatus("org_delete")).toBeNull();
        expect(store.acceptOrganization({ organizationId: "org_delete", nowMs: 10 })).toEqual({
            organizationId: "org_delete",
            accepted: true,
        });
        expect(store.readPurgeStatus("org_delete")).toMatchObject({
            state: "failed_unproven",
            remainingHeads: 1,
            unprovenTurns: 0,
        });
        expect(() => store.stageNextPage({ organizationId: "org_delete", nowMs: 11 })).toThrow(
            "external purge requires manual intervention"
        );
    });

    test("keeps an active organization's other vectors deliverable after one ordinary delete fails proof", () => {
        const failed = seedHead(1);
        const deliverable = seedHead(2, { state: "pending", outbox: true });
        const outbox = new CdbVectorOutboxStore(sql);
        outbox.stageDelete({ vectorId: failed, organizationId: "org_delete", nowMs: 2 });
        db.run(
            `UPDATE _chardb_vector_outbox
             SET terminal_failure = 1, last_error = ? WHERE vector_id = ?`,
            [CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR, failed]
        );

        expect(store.readPurgeStatus("org_delete")).toBeNull();
        expect(outbox.nextDueAt()).toBe(1);
        expect(
            outbox.claimNext({ nowMs: 1, leaseMs: 30_000, settlementMs: 120_000, claimToken: "live_org_claim_01" })
        ).toMatchObject({ vectorId: deliverable, operation: "upsert" });
    });

    test("records one monotonic organization-wide uncertainty budget through its exact terminal turn", () => {
        store.fenceOrganization({ organizationId: "org_delete", nowMs: 10 });
        db.run("UPDATE _chardb_deleted_organizations SET vector_unproven_turns = 30 WHERE organization_id = ?", [
            "org_delete",
        ]);
        expect(store.recordUnprovenTurn("org_delete")).toEqual({ turns: 31, terminal: false });
        expect(store.recordUnprovenTurn("org_delete")).toEqual({ turns: 32, terminal: true });
        expect(store.recordUnprovenTurn("org_delete")).toEqual({ turns: 32, terminal: true });
        expect(store.readPurgeStatus("org_delete")).toMatchObject({
            state: "complete",
            unprovenTurns: 32,
        });
        expect(store.recordUnprovenTurn("org_live")).toBeNull();
    });

    test("RPC response loss advances bounded pages and never drifts a staged version", () => {
        const organizationId = "org_accept_retry";
        for (let sequence = 1; sequence <= 1_001; sequence++) seedHead(sequence, { organizationId });
        const accepted = store.acceptOrganization({ organizationId, nowMs: 10 });
        expect(accepted).toEqual({ organizationId, accepted: true });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vectors WHERE state = 'deleting'").get()).toEqual({
            count: 500,
        });

        expect(store.acceptOrganization({ organizationId, nowMs: 11 })).toEqual(accepted);
        db.run("DELETE FROM _chardb_vectors WHERE created_seq IN (1, 1000)");
        expect(store.acceptOrganization({ organizationId, nowMs: 12 })).toEqual(accepted);
        expect(store.acceptOrganization({ organizationId, nowMs: 13 })).toEqual(accepted);
        expect(db.query("SELECT MIN(version) AS minimum, MAX(version) AS maximum FROM _chardb_vectors").get()).toEqual({
            minimum: 2,
            maximum: 2,
        });
        expect(store.nextPendingPage()).toBeNull();
    });

    test("discovers a tombstone inserted after initialization and reconstructs an already deleting destination", () => {
        const organizationId = "org_destination";
        const first = seedHead(1, { organizationId });
        const deleting = seedHead(2, { organizationId });
        new CdbVectorOutboxStore(sql).stageDelete({ vectorId: deleting, organizationId, nowMs: 10 });
        insertTombstone(organizationId, 11);
        const placement = Number(vshardOf([organizationId]));
        db.run(
            `INSERT INTO _chardb_split_state
               (mig_id, range_lo, range_hi, role, capture, destination_generation,
                destination_serving, drained, updated_at)
             VALUES ('destination-reconstruction', ?, ?, 'dest', 0, 2, 1, 1, 11)`,
            [placement, placement]
        );

        expect(store.nextPendingPage()).toEqual({ organizationId });
        expect(store.stageNextPage({ organizationId, nowMs: 12 })).toMatchObject({ staged: 1, done: true });
        expect(db.query("SELECT vector_id, version FROM _chardb_vectors ORDER BY created_seq").all()).toEqual([
            { vector_id: first, version: 2 },
            { vector_id: deleting, version: 2 },
        ]);
    });

    test("does not discover active heads on a source-fenced vshard", () => {
        const organizationId = "org_source_fenced";
        seedHead(1, { organizationId });
        insertTombstone(organizationId, 10);
        const placement = Number(vshardOf([organizationId]));
        db.run(
            `INSERT INTO _chardb_routing_fences
               (migration_id, range_lo, range_hi, source_generation, destination_generation,
                status, prepared_at, activated_at)
             VALUES ('delete-source-fence', ?, ?, 1, 2, 'active', 1, 2)`,
            [placement, placement]
        );
        expect(store.nextPendingPage()).toBeNull();
        expect(db.query("SELECT version, state FROM _chardb_vectors").get()).toEqual({ version: 1, state: "ready" });
    });

    test("restarts from head state when a vshard returns to the same Cdb", () => {
        const organizationId = "org_returned";
        for (let sequence = 1; sequence <= 501; sequence++) seedHead(sequence, { organizationId });
        store.acceptOrganization({ organizationId, nowMs: 10 });
        db.run("DELETE FROM _chardb_deleted_organizations WHERE organization_id = ?", [organizationId]);
        db.run("DELETE FROM _chardb_vectors WHERE organization_id = ?", [organizationId]);
        for (let sequence = 1; sequence <= 501; sequence++) seedHead(sequence, { organizationId });
        insertTombstone(organizationId, 20);

        expect(store.nextPendingPage()).toEqual({ organizationId });
        expect(store.stageNextPage({ organizationId, nowMs: 21 })).toMatchObject({ staged: 500, done: false });
        expect(store.stageNextPage({ organizationId, nowMs: 22 })).toMatchObject({ staged: 1, done: true });
        expect(db.query("SELECT MIN(version) AS minimum, MAX(version) AS maximum FROM _chardb_vectors").get()).toEqual({
            minimum: 2,
            maximum: 2,
        });
    });

    test("marks exact 500 done, pages 501, and uses the partial active-head index", () => {
        for (let sequence = 1; sequence <= CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE; sequence++) {
            seedHead(sequence, { organizationId: "org_500" });
        }
        for (let sequence = 1; sequence <= CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE + 1; sequence++) {
            seedHead(sequence + CDB_VECTOR_ORGANIZATION_DELETE_PAGE_SIZE, { organizationId: "org_501" });
        }
        store.fenceOrganization({ organizationId: "org_500", nowMs: 10 });
        store.fenceOrganization({ organizationId: "org_501", nowMs: 10 });
        expect(store.stageNextPage({ organizationId: "org_500", nowMs: 11 })).toMatchObject({
            staged: 500,
            done: true,
        });
        expect(store.stageNextPage({ organizationId: "org_501", nowMs: 11 })).toMatchObject({
            staged: 500,
            done: false,
        });
        expect(store.stageNextPage({ organizationId: "org_501", nowMs: 12 })).toMatchObject({
            staged: 1,
            done: true,
        });
        const plan = db
            .query(
                `EXPLAIN QUERY PLAN SELECT vector_id FROM _chardb_vectors
                 WHERE organization_id = ? AND state IN ('pending', 'ready') ORDER BY created_seq LIMIT 501`
            )
            .all("org_501") as Array<{ detail: string }>;
        expect(plan.some(row => row.detail.includes("_chardb_vectors_active_by_organization_sequence"))).toBe(true);
    });

    test("rolls back acceptance at the outbox cap and preserves an independently committed tombstone", () => {
        seedHead(1);
        seedHead(2);
        db.run("UPDATE _chardb_vector_capacity SET outbox_rows = ?", [CDB_VECTOR_MAX_OUTBOX_ROWS - 1]);
        expect(() => store.acceptOrganization({ organizationId: "org_delete", nowMs: 10 })).toThrow(/outbox exceeds/);
        expect(db.query("SELECT * FROM _chardb_deleted_organizations").get()).toBeNull();

        store.fenceOrganization({ organizationId: "org_delete", nowMs: 10 });
        expect(() => store.stageNextPage({ organizationId: "org_delete", nowMs: 11 })).toThrow(/outbox exceeds/);
        expect(db.query("SELECT created_seq, version, state FROM _chardb_vectors ORDER BY created_seq").all()).toEqual([
            { created_seq: 1, version: 1, state: "ready" },
            { created_seq: 2, version: 1, state: "ready" },
        ]);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_outbox").get()).toEqual({ count: 0 });
        expect(db.query("SELECT deleted_at FROM _chardb_deleted_organizations").get()).toEqual({ deleted_at: 10 });
    });
});
