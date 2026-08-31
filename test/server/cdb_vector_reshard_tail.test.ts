import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { CDB_SPLIT_LOG_MAX_ROWS } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { initializeCdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import {
    CDB_VECTOR_RESHARD_PROVENANCE_LIMIT,
    CdbVectorReshardProvenanceStore,
    cdbVectorReshardImageFingerprint,
    cdbVectorReshardPhysicalRowFingerprint,
    cdbVectorReshardSnapshotRecordFingerprint,
} from "../../src/server/do/cdb-vector-reshard-provenance.ts";
import {
    type CdbVectorSystemTailEntry,
    applyCdbVectorTailEntry,
    assertCdbVectorTailReplay,
    initializeCdbVectorReshardTailStore,
} from "../../src/server/do/cdb-vector-reshard-tail.ts";
import { vshardOf } from "../../src/vshard.ts";

function syncSql(db: Database): SyncSql {
    return {
        exec(statement, ...params) {
            db.run(statement, params as never[]);
        },
        one<T>(statement: string, ...params: never[]): T | null {
            return (db.query(statement).get(...params) as T | null) ?? null;
        },
        all<T>(statement: string, ...params: never[]): T[] {
            return db.query(statement).all(...params) as T[];
        },
        changes() {
            return Number((db.query("SELECT changes() AS n").get() as { n: number }).n);
        },
    };
}

function valuesHex(...values: number[]): string {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index++) view.setFloat32(index * 4, values[index] as number, true);
    return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

function hexBase64(value: string): string {
    let binary = "";
    for (let index = 0; index < value.length; index += 2)
        binary += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16));
    return btoa(binary);
}

function hexBytes(value: string): Uint8Array {
    return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
        Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    );
}

function tail(
    lsn: number,
    table_name: string,
    op: CdbVectorSystemTailEntry["op"],
    pk: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null
): CdbVectorSystemTailEntry {
    return {
        lsn,
        table_name,
        op,
        pk,
        before: before === null ? null : (JSON.stringify(before) as never),
        after: after === null ? null : (JSON.stringify(after) as never),
    };
}

let db: Database;

afterEach(() => db?.close());

describe("Cdb vector reshard tail apply", () => {
    function setup() {
        db = new Database(":memory:");
        const sql = syncSql(db);
        initializeCdbVectorOutboxStore(sql);
        initializeCdbVectorReshardTailStore(sql);
        const organizationId = "org-vector-tail";
        const placement = Number(vshardOf([organizationId]));
        const range = { lo: placement, hi: placement };
        const pending = {
            vector_id: "vector-tail",
            created_seq: 1,
            organization_id: organizationId,
            placement_vshard: placement,
            resource_id: "messages.embedding",
            row_pk: "message-1",
            dimensions: 2,
            version: 1,
            delivered_version: 0,
            values_hex: valuesHex(1.25, -2.5),
            metadata_json: '{"z":1,"a":"bytes stay exact"}',
            state: "pending",
            updated_at: 10,
        };
        const deleting = {
            ...pending,
            version: 2,
            values_hex: null,
            state: "deleting",
            updated_at: 20,
        };
        const outboxSubmit = {
            vector_id: pending.vector_id,
            placement_vshard: placement,
            target_version: 2,
            operation: "delete",
            phase: "submit",
            mutation_id: null,
            accepted_at: null,
            verify_ids_json: null,
            attempts: 0,
            next_attempt_at: 20,
            leased_until: null,
            lease_token: null,
            terminal_failure: 0,
            last_error: null,
        };
        const outboxVerify = {
            ...outboxSubmit,
            phase: "verify",
            mutation_id: "mutation-1",
            accepted_at: 30,
            verify_ids_json: JSON.stringify([`v1/${pending.resource_id}/${pending.vector_id}/1`]),
            attempts: 1,
            next_attempt_at: 40,
        };
        const attemptPending = {
            vector_id: pending.vector_id,
            placement_vshard: placement,
            physical_version: 1,
            first_sent_at: 12,
            settle_after: 42,
            visibility_confirmed: 0,
            response_ambiguous: 0,
            delete_confirmed: 0,
            delete_claim_token: null,
        };
        const attemptConfirmed = {
            ...attemptPending,
            visibility_confirmed: 1,
            response_ambiguous: 1,
            delete_confirmed: 1,
            delete_claim_token: "delete-claim-token-0001",
        };
        return {
            sql,
            range,
            pending,
            deleting,
            outboxSubmit,
            outboxVerify,
            attemptPending,
            attemptConfirmed,
        };
    }

    test("applies all nine exact transitions, keeps child-first deletion valid, and preserves bytes", () => {
        const state = setup();
        const entries = [
            tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending),
            tail(2, "_chardb_vectors", "upd", state.pending.vector_id, state.pending, state.deleting),
            tail(3, "_chardb_vector_outbox", "ins", state.pending.vector_id, null, state.outboxSubmit),
            tail(
                4,
                "_chardb_vector_attempts",
                "ins",
                JSON.stringify([state.pending.vector_id, 1]),
                null,
                state.attemptPending
            ),
            tail(
                5,
                "_chardb_vector_attempts",
                "upd",
                JSON.stringify([state.pending.vector_id, 1]),
                state.attemptPending,
                state.attemptConfirmed
            ),
            tail(6, "_chardb_vector_outbox", "upd", state.pending.vector_id, state.outboxSubmit, state.outboxVerify),
            tail(
                7,
                "_chardb_vector_attempts",
                "del",
                JSON.stringify([state.pending.vector_id, 1]),
                state.attemptConfirmed,
                null
            ),
            tail(8, "_chardb_vector_outbox", "del", state.pending.vector_id, state.outboxVerify, null),
            tail(9, "_chardb_vectors", "del", state.pending.vector_id, state.deleting, null),
        ];

        expect(JSON.parse(entries[3]?.after as string)).toMatchObject({ placement_vshard: state.range.lo });

        for (const entry of entries)
            expect(applyCdbVectorTailEntry(state.sql, "move-1", entry, state.range)).toBe(true);

        expect(db.query("SELECT COUNT(*) AS n FROM _chardb_vectors").get()).toEqual({ n: 0 });
        expect(db.query("SELECT COUNT(*) AS n FROM _chardb_vector_outbox").get()).toEqual({ n: 0 });
        expect(db.query("SELECT COUNT(*) AS n FROM _chardb_vector_attempts").get()).toEqual({ n: 0 });
        expect(db.query("SELECT last_seq FROM _chardb_vector_head_sequence").get()).toEqual({ last_seq: 1 });
        expect(
            db.query("SELECT head_count, stored_bytes, outbox_rows, attempt_rows FROM _chardb_vector_capacity").get()
        ).toEqual({
            head_count: 0,
            stored_bytes: 0,
            outbox_rows: 0,
            attempt_rows: 0,
        });
        expect(db.query("SELECT COUNT(*) AS n FROM _chardb_split_vector_tail_applied").get()).toEqual({ n: 9 });

        for (const entry of entries) {
            expect(assertCdbVectorTailReplay(state.sql, "move-1", entry, state.range)).toBe(true);
            expect(applyCdbVectorTailEntry(state.sql, "move-1", entry, state.range)).toBe(true);
        }
    });

    test("stores exact metadata and embedding bytes without JSON or float rewriting", () => {
        const state = setup();
        const insert = tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending);
        applyCdbVectorTailEntry(state.sql, "move-bytes", insert, state.range);

        expect(
            db.query("SELECT lower(hex(values_enc)) AS values_hex, metadata_json FROM _chardb_vectors").get()
        ).toEqual({ values_hex: state.pending.values_hex, metadata_json: state.pending.metadata_json });
    });

    test("rejects response-loss replay when an applied LSN changes any captured byte", () => {
        const state = setup();
        const insert = tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending);
        applyCdbVectorTailEntry(state.sql, "move-retry", insert, state.range);

        const changed = { ...insert, after: JSON.stringify({ ...state.pending, metadata_json: '{"a":1}' }) as never };
        expect(() => assertCdbVectorTailReplay(state.sql, "move-retry", changed, state.range)).toThrow(
            "retried with different bytes"
        );
        expect(() => applyCdbVectorTailEntry(state.sql, "move-retry", changed, state.range)).toThrow(
            "retried with different bytes"
        );
    });

    test("rejects unknown, oversized, noncanonical, and identity-changing images", () => {
        const state = setup();
        const base = tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending);
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-invalid",
                { ...base, after: JSON.stringify({ ...state.pending, unknown: true }) as never },
                state.range
            )
        ).toThrow("fields are not exact");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-invalid",
                { ...base, after: `{"padding":"${"x".repeat(256 * 1_024)}"}` as never },
                state.range
            )
        ).toThrow("exceeds its byte bound");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-invalid",
                {
                    ...base,
                    after: JSON.stringify({
                        ...state.pending,
                        values_hex: state.pending.values_hex.toUpperCase(),
                    }) as never,
                },
                state.range
            )
        ).toThrow("embedding hex is not canonical");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-invalid",
                {
                    ...base,
                    after: JSON.stringify({
                        ...state.pending,
                        placement_vshard: (state.range.lo + 1) % 16_384,
                    }) as never,
                },
                state.range
            )
        ).toThrow("does not match organization identity");
    });

    test("rejects conflicting inserts, pre-images, child ownership, and attempt keys", () => {
        const state = setup();
        applyCdbVectorTailEntry(
            state.sql,
            "move-conflict",
            tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending),
            state.range
        );
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-conflict",
                tail(2, "_chardb_vectors", "ins", state.pending.vector_id, null, {
                    ...state.pending,
                    metadata_json: "{}",
                }),
                state.range
            )
        ).toThrow("collides during insert");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-conflict",
                tail(
                    3,
                    "_chardb_vectors",
                    "upd",
                    state.pending.vector_id,
                    { ...state.pending, updated_at: 11 },
                    state.deleting
                ),
                state.range
            )
        ).toThrow("pre-image changed");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-conflict",
                tail(4, "_chardb_vector_outbox", "ins", "missing", null, {
                    ...state.outboxSubmit,
                    vector_id: "missing",
                }),
                state.range
            )
        ).toThrow("has no vector head");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-conflict",
                tail(5, "_chardb_vector_attempts", "ins", '["vector-tail", 1]', null, state.attemptPending),
                state.range
            )
        ).toThrow("primary key is not canonical");
    });

    test("retains cleaned migration identity and rejects range reuse", () => {
        const state = setup();
        const identity = { migId: "move-clean", rangeLo: state.range.lo, rangeHi: state.range.hi };
        const store = new CdbVectorReshardProvenanceStore(state.sql);
        store.bind(identity);
        store.recordSnapshot(identity, {
            kind: "head",
            vectorId: "vector-clean",
            physicalVersion: 0,
            placementVshard: 0,
            throughLsn: 0,
            inserted: true,
            imageFingerprint: cdbVectorReshardImageFingerprint({ kind: "head", vector_id: "vector-clean" }),
        });
        expect(store.cleanup(identity)).toEqual({ cleaned: true });
        expect(store.cleanup(identity)).toEqual({ cleaned: false });
        expect(() => store.bind(identity)).toThrow("provenance was cleaned");
        expect(() => store.cleanup({ ...identity, rangeHi: (identity.rangeHi + 1) % 16_384 })).toThrow(
            "changed its range"
        );
        expect(
            db
                .query("SELECT outcome, record_count, receipt_count FROM _chardb_vector_reshard_provenance_identity")
                .get()
        ).toEqual({
            outcome: "cleaned",
            record_count: 0,
            receipt_count: 0,
        });
    });

    test("uses durable O(1) admission counters and validates corruption", () => {
        const state = setup();
        const identity = { migId: "move-counts", rangeLo: state.range.lo, rangeHi: state.range.hi };
        const store = new CdbVectorReshardProvenanceStore(state.sql);
        store.bind(identity);
        db.run("UPDATE _chardb_vector_reshard_provenance_identity SET record_count = ? WHERE mig_id = ?", [
            CDB_VECTOR_RESHARD_PROVENANCE_LIMIT,
            identity.migId,
        ]);
        expect(() =>
            store.recordSnapshot(identity, {
                kind: "head",
                vectorId: "at-cap",
                physicalVersion: 0,
                placementVshard: 0,
                throughLsn: 0,
                inserted: false,
                imageFingerprint: cdbVectorReshardImageFingerprint({ kind: "head", vector_id: "at-cap" }),
            })
        ).toThrow("row limit");
        db.run("UPDATE _chardb_vector_reshard_provenance_identity SET record_count = 1 WHERE mig_id = ?", [
            identity.migId,
        ]);
        expect(() => store.counts(identity)).toThrow("counters do not match");
        db.run(
            `UPDATE _chardb_vector_reshard_provenance_identity
             SET record_count = 0, receipt_count = ? WHERE mig_id = ?`,
            [CDB_SPLIT_LOG_MAX_ROWS, identity.migId]
        );
        expect(() =>
            store.recordReceipt(identity, {
                lsn: 1,
                tableName: "_chardb_vectors",
                fingerprint: "a".repeat(64),
            })
        ).toThrow("split-log row limit");
    });

    test("never lets a covered snapshot resurrect or rewrite tail provenance", () => {
        const state = setup();
        const identity = { migId: "move-overlap", rangeLo: state.range.lo, rangeHi: state.range.hi };
        const store = new CdbVectorReshardProvenanceStore(state.sql);
        store.bind(identity);
        const key = { kind: "head" as const, vectorId: "overlap", physicalVersion: 0 };
        store.recordTail(identity, {
            ...key,
            lsn: 5,
            placementVshard: 0,
            present: false,
            inserted: true,
            imageFingerprint: null,
        });
        expect(() =>
            store.recordSnapshot(identity, {
                ...key,
                throughLsn: 5,
                placementVshard: 0,
                inserted: false,
                imageFingerprint: cdbVectorReshardImageFingerprint({ kind: "head", vector_id: "overlap" }),
            })
        ).toThrow("resurrect");

        const present = { kind: "head" as const, vectorId: "present", physicalVersion: 0 };
        store.recordTail(identity, {
            ...present,
            lsn: 6,
            placementVshard: 0,
            present: true,
            inserted: true,
            imageFingerprint: cdbVectorReshardImageFingerprint({ kind: "head", vector_id: "before" }),
        });
        expect(() =>
            store.recordSnapshot(identity, {
                ...present,
                throughLsn: 6,
                placementVshard: 0,
                inserted: false,
                imageFingerprint: cdbVectorReshardImageFingerprint({ kind: "head", vector_id: "after" }),
            })
        ).toThrow("differs from tail provenance");
    });

    test("validates both captured images before accepting snapshot-covered transitions", () => {
        const state = setup();
        const identity = { migId: "move-covered-envelope", rangeLo: state.range.lo, rangeHi: state.range.hi };
        const store = new CdbVectorReshardProvenanceStore(state.sql);
        store.bind(identity);
        store.recordSnapshot(identity, {
            kind: "head",
            vectorId: state.pending.vector_id,
            physicalVersion: 0,
            placementVshard: state.pending.placement_vshard,
            throughLsn: 10,
            inserted: false,
            imageFingerprint: cdbVectorReshardPhysicalRowFingerprint("head", state.pending),
        });

        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                identity.migId,
                tail(
                    1,
                    "_chardb_vectors",
                    "upd",
                    state.pending.vector_id,
                    { ...state.pending, row_pk: "forged-preimage" },
                    state.deleting
                ),
                state.range
            )
        ).toThrow("changed immutable row_pk");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                identity.migId,
                tail(2, "_chardb_vectors", "ins", state.pending.vector_id, state.pending, state.pending),
                state.range
            )
        ).toThrow("insert includes a pre-image");
        expect(db.query("SELECT COUNT(*) AS n FROM _chardb_split_vector_tail_applied").get()).toEqual({ n: 0 });
    });

    test("uses one physical fingerprint for honest head, outbox, and attempt snapshot overlap", () => {
        const state = setup();
        const headRecord = {
            kind: "head" as const,
            vectorId: state.pending.vector_id,
            organizationId: state.pending.organization_id,
            placementVshard: state.pending.placement_vshard,
            resourceId: state.pending.resource_id,
            headVersion: state.pending.version,
            rowPk: state.pending.row_pk,
            dimensions: state.pending.dimensions,
            deliveredVersion: state.pending.delivered_version,
            valuesEncBase64: hexBase64(state.pending.values_hex),
            metadataJson: state.pending.metadata_json,
            state: state.pending.state as "pending",
            updatedAt: state.pending.updated_at,
        };
        const outboxRecord = {
            kind: "outbox" as const,
            vectorId: state.outboxSubmit.vector_id,
            organizationId: state.pending.organization_id,
            placementVshard: state.pending.placement_vshard,
            resourceId: state.pending.resource_id,
            headVersion: state.deleting.version,
            headState: "deleting" as const,
            targetVersion: state.outboxSubmit.target_version,
            operation: state.outboxSubmit.operation as "delete",
            phase: state.outboxSubmit.phase as "submit",
            mutationId: state.outboxSubmit.mutation_id,
            acceptedAt: state.outboxSubmit.accepted_at,
            verifyIdsJson: state.outboxSubmit.verify_ids_json,
            attempts: state.outboxSubmit.attempts,
            nextAttemptAt: state.outboxSubmit.next_attempt_at,
            leasedUntil: state.outboxSubmit.leased_until,
            leaseToken: state.outboxSubmit.lease_token,
            terminalFailure: state.outboxSubmit.terminal_failure as 0,
            lastError: state.outboxSubmit.last_error,
        };
        const attemptRecord = {
            kind: "attempt" as const,
            vectorId: state.attemptPending.vector_id,
            organizationId: state.pending.organization_id,
            placementVshard: state.pending.placement_vshard,
            resourceId: state.pending.resource_id,
            headVersion: state.deleting.version,
            physicalVersion: state.attemptPending.physical_version,
            firstSentAt: state.attemptPending.first_sent_at,
            settleAfter: state.attemptPending.settle_after,
            visibilityConfirmed: state.attemptPending.visibility_confirmed as 0,
            responseAmbiguous: state.attemptPending.response_ambiguous as 0,
            deleteConfirmed: state.attemptPending.delete_confirmed as 0,
            deleteClaimToken: state.attemptPending.delete_claim_token,
        };

        expect(cdbVectorReshardSnapshotRecordFingerprint(headRecord)).toBe(
            cdbVectorReshardPhysicalRowFingerprint("head", state.pending)
        );
        expect(cdbVectorReshardSnapshotRecordFingerprint(outboxRecord)).toBe(
            cdbVectorReshardPhysicalRowFingerprint("outbox", state.outboxSubmit)
        );
        expect(cdbVectorReshardSnapshotRecordFingerprint(attemptRecord)).toBe(
            cdbVectorReshardPhysicalRowFingerprint("attempt", state.attemptPending)
        );
        expect(
            cdbVectorReshardSnapshotRecordFingerprint({ ...headRecord, updatedAt: headRecord.updatedAt + 1 })
        ).not.toBe(cdbVectorReshardPhysicalRowFingerprint("head", state.pending));
    });

    test("allocates destination-local head generations and ignores source sequence during later comparison", () => {
        const state = setup();
        const unrelated = { ...state.pending, vector_id: "unrelated", created_seq: 77, row_pk: "unrelated" };
        applyCdbVectorTailEntry(
            state.sql,
            "move-local-seq",
            tail(1, "_chardb_vectors", "ins", unrelated.vector_id, null, unrelated),
            state.range
        );
        const sourceSequence = { ...state.pending, created_seq: 1 };
        applyCdbVectorTailEntry(
            state.sql,
            "move-local-seq",
            tail(2, "_chardb_vectors", "ins", sourceSequence.vector_id, null, sourceSequence),
            state.range
        );
        expect(db.query("SELECT vector_id, created_seq FROM _chardb_vectors ORDER BY created_seq").all()).toEqual([
            { vector_id: "unrelated", created_seq: 1 },
            { vector_id: state.pending.vector_id, created_seq: 2 },
        ]);

        const ready = {
            ...sourceSequence,
            delivered_version: 1,
            state: "ready",
            updated_at: 30,
        };
        applyCdbVectorTailEntry(
            state.sql,
            "move-local-seq",
            tail(3, "_chardb_vectors", "upd", sourceSequence.vector_id, sourceSequence, ready),
            state.range
        );
        expect(
            db.query("SELECT created_seq, state FROM _chardb_vectors WHERE vector_id = ?").get(sourceSequence.vector_id)
        ).toEqual({
            created_seq: 2,
            state: "ready",
        });
    });

    test("applies a tail update to a snapshot head with a different local generation", () => {
        const state = setup();
        const sourcePending = { ...state.pending, created_seq: 999 };
        db.run(
            `INSERT INTO _chardb_vectors
               (vector_id, created_seq, organization_id, placement_vshard, resource_id, row_pk, dimensions,
                version, delivered_version, values_enc, metadata_json, state, updated_at)
             VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                sourcePending.vector_id,
                sourcePending.organization_id,
                sourcePending.placement_vshard,
                sourcePending.resource_id,
                sourcePending.row_pk,
                sourcePending.dimensions,
                sourcePending.version,
                sourcePending.delivered_version,
                hexBytes(sourcePending.values_hex),
                sourcePending.metadata_json,
                sourcePending.state,
                sourcePending.updated_at,
            ]
        );
        db.run("UPDATE _chardb_vector_head_sequence SET last_seq = 1 WHERE singleton = 1");
        const identity = { migId: "move-snapshot-tail", rangeLo: state.range.lo, rangeHi: state.range.hi };
        const provenance = new CdbVectorReshardProvenanceStore(state.sql);
        provenance.bind(identity);
        provenance.recordSnapshot(identity, {
            kind: "head",
            vectorId: sourcePending.vector_id,
            physicalVersion: 0,
            placementVshard: sourcePending.placement_vshard,
            throughLsn: 0,
            inserted: true,
            imageFingerprint: cdbVectorReshardPhysicalRowFingerprint("head", sourcePending),
        });
        const sourceReady = {
            ...sourcePending,
            delivered_version: 1,
            state: "ready",
            updated_at: 30,
        };
        expect(
            applyCdbVectorTailEntry(
                state.sql,
                identity.migId,
                tail(1, "_chardb_vectors", "upd", sourcePending.vector_id, sourcePending, sourceReady),
                state.range
            )
        ).toBe(true);
        expect(db.query("SELECT created_seq, state FROM _chardb_vectors").get()).toEqual({
            created_seq: 1,
            state: "ready",
        });
    });

    test("accepts missing deletes only behind exact snapshot absence intervals", () => {
        const state = setup();
        const entries = [
            tail(
                1,
                "_chardb_vector_attempts",
                "del",
                JSON.stringify([state.pending.vector_id, 1]),
                state.attemptPending,
                null
            ),
            tail(2, "_chardb_vector_outbox", "del", state.pending.vector_id, state.outboxSubmit, null),
            tail(3, "_chardb_vectors", "del", state.pending.vector_id, state.deleting, null),
        ];
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-uncovered-delete",
                entries[0] as CdbVectorSystemTailEntry,
                state.range
            )
        ).toThrow("has no snapshot absence coverage");

        const identity = { migId: "move-missed-delete", rangeLo: state.range.lo, rangeHi: state.range.hi };
        const provenance = new CdbVectorReshardProvenanceStore(state.sql);
        provenance.bind(identity);
        const atStart = (kind: "head" | "outbox" | "attempt" | "done") => ({
            kind,
            throughHeadSeq: 99,
            afterPlacement: -1,
            afterVectorId: "",
            afterPhysicalVersion: 0,
        });
        for (const [pageNumber, kind, next] of [
            [0, "head", "outbox"],
            [1, "outbox", "attempt"],
            [2, "attempt", "done"],
        ] as const) {
            provenance.recordSnapshotInterval(identity, {
                pageNumber,
                cursor: atStart(kind),
                next: atStart(next),
                throughLsn: 3,
                pageDigest: String(pageNumber + 1).repeat(64),
            });
        }
        for (const entry of entries) {
            expect(applyCdbVectorTailEntry(state.sql, identity.migId, entry, state.range)).toBe(true);
        }
        expect(
            db.query("SELECT COUNT(*) AS n FROM _chardb_split_vector_applied WHERE mig_id = ?").get(identity.migId)
        ).toEqual({ n: 0 });
        expect(
            db.query("SELECT COUNT(*) AS n FROM _chardb_split_vector_tail_applied WHERE mig_id = ?").get(identity.migId)
        ).toEqual({ n: 3 });
    });

    test("rejects impossible head transitions and outbox state drift", () => {
        const state = setup();
        applyCdbVectorTailEntry(
            state.sql,
            "move-matrix",
            tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending),
            state.range
        );
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-matrix",
                tail(2, "_chardb_vectors", "upd", state.pending.vector_id, state.pending, {
                    ...state.pending,
                    delivered_version: 1,
                    metadata_json: "{}",
                    state: "ready",
                    updated_at: 11,
                }),
                state.range
            )
        ).toThrow("not a delivery acknowledgement");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-matrix",
                tail(3, "_chardb_vectors", "upd", state.pending.vector_id, state.pending, {
                    ...state.pending,
                    version: 3,
                    updated_at: 11,
                }),
                state.range
            )
        ).toThrow("not a single staged mutation");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-matrix",
                tail(4, "_chardb_vector_outbox", "ins", state.pending.vector_id, null, {
                    ...state.outboxSubmit,
                    target_version: 1,
                }),
                state.range
            )
        ).toThrow("operation does not match head state");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-matrix",
                tail(5, "_chardb_vector_outbox", "ins", state.pending.vector_id, null, {
                    ...state.outboxSubmit,
                    operation: "upsert",
                }),
                state.range
            )
        ).toThrow("target does not match head version");
    });

    test("applies an outbox update after its head advances in the same source transaction", () => {
        const state = setup();
        const pendingV2 = { ...state.pending, version: 2, updated_at: 20 };
        const outboxV1 = {
            ...state.outboxSubmit,
            target_version: 1,
            operation: "upsert",
            next_attempt_at: 10,
        };
        const outboxV2 = { ...outboxV1, target_version: 2, next_attempt_at: 20 };
        for (const entry of [
            tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending),
            tail(2, "_chardb_vector_outbox", "ins", state.pending.vector_id, null, outboxV1),
            tail(3, "_chardb_vectors", "upd", state.pending.vector_id, state.pending, pendingV2),
        ]) {
            expect(applyCdbVectorTailEntry(state.sql, "move-version", entry, state.range)).toBe(true);
        }
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "move-version",
                tail(
                    4,
                    "_chardb_vector_outbox",
                    "upd",
                    state.pending.vector_id,
                    { ...outboxV1, next_attempt_at: 11 },
                    outboxV2
                ),
                state.range
            )
        ).toThrow("pre-image changed during update");
        expect(
            applyCdbVectorTailEntry(
                state.sql,
                "move-version",
                tail(4, "_chardb_vector_outbox", "upd", state.pending.vector_id, outboxV1, outboxV2),
                state.range
            )
        ).toBe(true);
        expect(db.query("SELECT target_version, operation FROM _chardb_vector_outbox").get()).toEqual({
            target_version: 2,
            operation: "upsert",
        });
    });

    test("never claims exact preexisting vector rows as abort-owned inserts", () => {
        const state = setup();
        applyCdbVectorTailEntry(
            state.sql,
            "seed-owner",
            tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending),
            state.range
        );
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "collision-head",
                tail(1, "_chardb_vectors", "ins", state.pending.vector_id, null, state.pending),
                state.range
            )
        ).toThrow("predates this migration");
        applyCdbVectorTailEntry(
            state.sql,
            "seed-owner",
            tail(2, "_chardb_vectors", "upd", state.pending.vector_id, state.pending, state.deleting),
            state.range
        );
        applyCdbVectorTailEntry(
            state.sql,
            "seed-owner",
            tail(3, "_chardb_vector_outbox", "ins", state.pending.vector_id, null, state.outboxSubmit),
            state.range
        );
        applyCdbVectorTailEntry(
            state.sql,
            "seed-owner",
            tail(
                4,
                "_chardb_vector_attempts",
                "ins",
                JSON.stringify([state.pending.vector_id, 1]),
                null,
                state.attemptPending
            ),
            state.range
        );

        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "collision-outbox",
                tail(1, "_chardb_vector_outbox", "ins", state.pending.vector_id, null, state.outboxSubmit),
                state.range
            )
        ).toThrow("predates this migration");
        expect(() =>
            applyCdbVectorTailEntry(
                state.sql,
                "collision-attempt",
                tail(
                    1,
                    "_chardb_vector_attempts",
                    "ins",
                    JSON.stringify([state.pending.vector_id, 1]),
                    null,
                    state.attemptPending
                ),
                state.range
            )
        ).toThrow("predates this migration");
        expect(
            db
                .query(
                    `SELECT COUNT(*) AS n FROM _chardb_split_vector_applied
                 WHERE mig_id IN ('collision-head', 'collision-outbox', 'collision-attempt')`
                )
                .get()
        ).toEqual({ n: 0 });
        expect(
            db.query("SELECT record_kind, inserted FROM _chardb_split_vector_applied WHERE mig_id = 'seed-owner'").all()
        ).toEqual(
            expect.arrayContaining([
                { record_kind: "head", inserted: 1 },
                { record_kind: "outbox", inserted: 1 },
                { record_kind: "attempt", inserted: 1 },
            ])
        );
    });
});
