import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { CDB_RESHARD_IDENTITY_STORE_DDL } from "../../src/server/do/cdb-reshard-identity-store.ts";
import { CDB_RESHARD_MAX_BATCH_BYTES } from "../../src/server/do/cdb-reshard-relational.ts";
import { CdbVectorOutboxStore, initializeCdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import {
    type CdbVectorReshardCursor,
    decodeCdbVectorReshardPage,
} from "../../src/server/do/cdb-vector-reshard-records.ts";
import {
    CDB_VECTOR_RESHARD_SNAPSHOT_SESSION_LIMIT,
    CdbVectorReshardSnapshotSessionStore,
    initializeCdbVectorReshardSnapshotSessions,
} from "../../src/server/do/cdb-vector-reshard-snapshot-session.ts";

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

const IDENTITY = Object.freeze({ migId: "vector_snapshot_session_1", rangeLo: 0, rangeHi: 16_383 });

function setup() {
    const db = new Database(":memory:");
    const sql = syncSql(db);
    db.exec(SPLIT_LOG_DDL);
    db.exec(CDB_RESHARD_IDENTITY_STORE_DDL);
    initializeCdbVectorOutboxStore(sql);
    initializeCdbVectorReshardSnapshotSessions(sql);
    sql.exec(
        `INSERT INTO _chardb_split_identity
           (mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json, created_at)
         VALUES (?, ?, ?, 'source', 0, 1, ?, '[]', 0)`,
        IDENTITY.migId,
        IDENTITY.rangeLo,
        IDENTITY.rangeHi,
        "a".repeat(64)
    );
    sql.exec(
        `INSERT INTO _chardb_split_state
           (mig_id, range_lo, range_hi, role, capture, bulk_done, applied_lsn, acked_lsn, drained, updated_at)
         VALUES (?, ?, ?, 'source', 1, 0, 0, 0, 0, 0)`,
        IDENTITY.migId,
        IDENTITY.rangeLo,
        IDENTITY.rangeHi
    );
    const vectors = new CdbVectorOutboxStore(sql);
    const session = new CdbVectorReshardSnapshotSessionStore(sql);
    const transaction = <T>(callback: () => T): T => db.transaction(callback)();
    return { db, sql, vectors, session, transaction };
}

function stage(target: ReturnType<typeof setup>, vectorId: string, nowMs: number): void {
    target.vectors.stageUpsert({
        vectorId,
        organizationId: `org-${vectorId}`,
        resourceId: "resource-session",
        rowPk: `row-${vectorId}`,
        dimensions: 2,
        values: [1, 2],
        metadata: { vectorId },
        nowMs,
    });
}

describe("Cdb vector reshard snapshot session", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("captures one watermark and makes begin idempotent", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-before", 1);

        const first = target.transaction(() => target.session.begin(IDENTITY));
        stage(target, "vec-after", 2);
        const second = target.transaction(() => target.session.begin(IDENTITY));

        expect(second).toEqual(first);
        const response = target.transaction(() => target.session.read(IDENTITY, first.next));
        expect(decodeCdbVectorReshardPage(response.encodedPage).records.map(record => record.vectorId)).toEqual([
            "vec-before",
        ]);
        expect(
            target.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vector_snapshot_sessions")
        ).toEqual({ count: 1 });
    });

    test("replays byte-identical data after response loss even when source rows change", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-replay", 1);
        const state = target.transaction(() => target.session.begin(IDENTITY));
        const first = target.transaction(() => target.session.read(IDENTITY, state.next));
        target.sql.exec(
            `INSERT INTO _chardb_split_log
               (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (-1, ?, 'upd', '_chardb_vectors', 'vec-replay', '{}', '{}', 2)`,
            IDENTITY.migId
        );
        target.sql.exec(
            "UPDATE _chardb_vectors SET metadata_json = ?, updated_at = ? WHERE vector_id = ?",
            '{"changed":true}',
            2,
            "vec-replay"
        );

        const replay = new CdbVectorReshardSnapshotSessionStore(target.sql);
        const retried = target.transaction(() => replay.read(IDENTITY, state.next));
        expect(retried).toEqual(first);
        expect(retried.encodedPage).toBe(first.encodedPage);
        expect(retried.throughLsn).toBe(0);
        expect(decodeCdbVectorReshardPage(retried.encodedPage).records[0]).toMatchObject({
            metadataJson: '{"vectorId":"vec-replay"}',
            updatedAt: 1,
        });
    });

    test("captures each new page tail watermark and replays the prior watermark exactly", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-page-watermark", 1);
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        const head = target.transaction(() => target.session.read(IDENTITY, initial.next));
        expect(head.throughLsn).toBe(0);
        const headPage = decodeCdbVectorReshardPage(head.encodedPage);

        target.sql.exec(
            `INSERT INTO _chardb_split_log
               (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (-2, ?, 'upd', '_chardb_vectors', 'vec-page-watermark', '{}', '{}', 2)`,
            IDENTITY.migId
        );
        const outboxRequest = Object.freeze({ pageNumber: 1, cursor: headPage.next });
        const outbox = target.transaction(() => target.session.read(IDENTITY, outboxRequest));
        expect(outbox.throughLsn).toBe(1);

        target.sql.exec(
            `INSERT INTO _chardb_split_log
               (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (-3, ?, 'upd', '_chardb_vectors', 'vec-page-watermark', '{}', '{}', 3)`,
            IDENTITY.migId
        );
        expect(target.transaction(() => target.session.read(IDENTITY, outboxRequest))).toEqual(outbox);
    });

    test("fails closed if source tail pruning regresses the page watermark", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-watermark-regression", 1);
        target.sql.exec(
            `INSERT INTO _chardb_split_log
               (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (-4, ?, 'upd', '_chardb_vectors', 'vec-watermark-regression', '{}', '{}', 1)`,
            IDENTITY.migId
        );
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        const head = target.transaction(() => target.session.read(IDENTITY, initial.next));
        expect(head.throughLsn).toBe(1);

        target.sql.exec("DELETE FROM _chardb_split_log WHERE mig_id = ?", IDENTITY.migId);
        const successor = decodeCdbVectorReshardPage(head.encodedPage).next;
        expect(() =>
            target.transaction(() => target.session.read(IDENTITY, { pageNumber: 1, cursor: successor }))
        ).toThrow("source tail high watermark regressed between pages");
    });

    test("accepts only the exact numbered successor cursor", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-next", 1);
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        const headResponse = target.transaction(() => target.session.read(IDENTITY, initial.next));
        const headPage = decodeCdbVectorReshardPage(headResponse.encodedPage);
        const successor = Object.freeze({ pageNumber: 1, cursor: headPage.next });

        expect(() =>
            target.transaction(() => target.session.read(IDENTITY, { pageNumber: 2, cursor: headPage.next }))
        ).toThrow("page number is not the next expected page");
        expect(() =>
            target.transaction(() => target.session.read(IDENTITY, { pageNumber: 1, cursor: initial.next.cursor }))
        ).toThrow("page cursor is not the next expected cursor");
        expect(() =>
            target.transaction(() =>
                target.session.read(IDENTITY, {
                    pageNumber: 0,
                    cursor: { ...initial.next.cursor, kind: "outbox" },
                })
            )
        ).toThrow("cached page cursor does not match");

        const outboxResponse = target.transaction(() => target.session.read(IDENTITY, successor));
        const outboxPage = decodeCdbVectorReshardPage(outboxResponse.encodedPage);
        const terminalResponse = target.transaction(() =>
            target.session.read(IDENTITY, { pageNumber: 2, cursor: outboxPage.next })
        );
        expect(decodeCdbVectorReshardPage(terminalResponse.encodedPage).done).toBe(true);
        expect(() => target.transaction(() => target.session.read(IDENTITY, initial.next))).toThrow(
            "snapshot session is already terminal"
        );
    });

    test("rejects done, raised-watermark, skipped-kind, and skipped-key cursor forgeries", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-forgery", 1);
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        const cursor = initial.next.cursor;
        const forged = (replacement: CdbVectorReshardCursor) =>
            target.transaction(() => target.session.read(IDENTITY, { pageNumber: 0, cursor: replacement }));

        expect(() =>
            forged({
                kind: "done",
                throughHeadSeq: cursor.throughHeadSeq,
                afterPlacement: -1,
                afterVectorId: "",
                afterPhysicalVersion: 0,
            })
        ).toThrow("page cursor is not the next expected cursor");
        expect(() => forged({ ...cursor, throughHeadSeq: cursor.throughHeadSeq + 1 })).toThrow(
            "page cursor changed the head watermark"
        );
        expect(() => forged({ ...cursor, kind: "outbox" })).toThrow("page cursor is not the next expected cursor");
        expect(() =>
            forged({
                ...cursor,
                afterPlacement: 0,
                afterVectorId: "vec-forgery",
            })
        ).toThrow("page cursor is not the next expected cursor");
    });

    test("reconstructs the expected cursor and one cached replay", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-reconstruct", 1);
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        const first = target.transaction(() => target.session.read(IDENTITY, initial.next));
        const firstPage = decodeCdbVectorReshardPage(first.encodedPage);

        const reconstructed = new CdbVectorReshardSnapshotSessionStore(target.sql);
        const state = reconstructed.inspect(IDENTITY);
        expect(state.cached).toEqual(initial.next);
        expect(state.next).toEqual({ pageNumber: 1, cursor: firstPage.next });
        expect(
            target.transaction(() => reconstructed.read(IDENTITY, state.cached as NonNullable<typeof state.cached>))
        ).toEqual(first);
    });

    test("keeps the terminal page stable and refuses a forged continuation", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-terminal", 1);
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        const head = decodeCdbVectorReshardPage(
            target.transaction(() => target.session.read(IDENTITY, initial.next)).encodedPage
        );
        const outbox = decodeCdbVectorReshardPage(
            target.transaction(() => target.session.read(IDENTITY, { pageNumber: 1, cursor: head.next })).encodedPage
        );
        const terminalRequest = Object.freeze({ pageNumber: 2, cursor: outbox.next });
        const terminal = target.transaction(() => target.session.read(IDENTITY, terminalRequest));
        const reconstructed = new CdbVectorReshardSnapshotSessionStore(target.sql);

        expect(reconstructed.inspect(IDENTITY).terminal).toBe(true);
        expect(target.transaction(() => reconstructed.read(IDENTITY, terminalRequest))).toEqual(terminal);
        const done = decodeCdbVectorReshardPage(terminal.encodedPage).next;
        expect(() => target.transaction(() => reconstructed.read(IDENTITY, { pageNumber: 3, cursor: done }))).toThrow(
            "snapshot session is already terminal"
        );
    });

    test("retains only one bounded page", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-bound", 1);
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        const head = decodeCdbVectorReshardPage(
            target.transaction(() => target.session.read(IDENTITY, initial.next)).encodedPage
        );
        target.transaction(() => target.session.read(IDENTITY, { pageNumber: 1, cursor: head.next }));

        const stored = target.sql.one<{ count: number; bytes: number; cached_page_number: number }>(
            `SELECT COUNT(*) AS count, length(CAST(cached_page_enc AS BLOB)) AS bytes, cached_page_number
             FROM _chardb_vector_snapshot_sessions WHERE mig_id = ?`,
            IDENTITY.migId
        );
        expect(stored?.count).toBe(1);
        expect(stored?.cached_page_number).toBe(1);
        expect(stored?.bytes).toBeLessThanOrEqual(CDB_RESHARD_MAX_BATCH_BYTES);
    });

    test("cleans the replay body once, keeps a watermark tombstone, and rejects rebegin", () => {
        const target = setup();
        databases.push(target.db);
        stage(target, "vec-cleanup", 1);
        const initial = target.transaction(() => target.session.begin(IDENTITY));
        target.transaction(() => target.session.read(IDENTITY, initial.next));

        expect(target.transaction(() => target.session.cleanup(IDENTITY))).toEqual({ cleaned: true });
        expect(target.transaction(() => target.session.cleanup(IDENTITY))).toEqual({ cleaned: false });
        expect(
            target.sql.one<{ cleaned: number; cached_page_enc: string | null }>(
                "SELECT cleaned, cached_page_enc FROM _chardb_vector_snapshot_sessions WHERE mig_id = ?",
                IDENTITY.migId
            )
        ).toEqual({ cleaned: 1, cached_page_enc: null });
        expect(() => target.transaction(() => target.session.begin(IDENTITY))).toThrow("snapshot session was cleaned");
        expect(() => target.session.cleanup({ ...IDENTITY, rangeHi: 100 })).toThrow("snapshot session");
    });

    test("fails closed when cached page completion or successor disagrees with session state", () => {
        const successorTarget = setup();
        databases.push(successorTarget.db);
        stage(successorTarget, "vec-corrupt-successor", 1);
        const successorInitial = successorTarget.transaction(() => successorTarget.session.begin(IDENTITY));
        successorTarget.transaction(() => successorTarget.session.read(IDENTITY, successorInitial.next));
        successorTarget.sql.exec(
            "UPDATE _chardb_vector_snapshot_sessions SET expected_cursor_json = ? WHERE mig_id = ?",
            JSON.stringify(successorInitial.next.cursor),
            IDENTITY.migId
        );
        expect(() => successorTarget.session.inspect(IDENTITY)).toThrow("cached page successor does not match session");

        const completionTarget = setup();
        databases.push(completionTarget.db);
        stage(completionTarget, "vec-corrupt-completion", 1);
        const completionInitial = completionTarget.transaction(() => completionTarget.session.begin(IDENTITY));
        completionTarget.transaction(() => completionTarget.session.read(IDENTITY, completionInitial.next));
        completionTarget.sql.exec(
            "UPDATE _chardb_vector_snapshot_sessions SET terminal = 1 WHERE mig_id = ?",
            IDENTITY.migId
        );
        expect(() => completionTarget.session.inspect(IDENTITY)).toThrow(
            "cached page completion does not match session"
        );
    });

    test("fails closed when durable cursor or cached page encodings are not canonical", () => {
        const cursorTarget = setup();
        databases.push(cursorTarget.db);
        stage(cursorTarget, "vec-corrupt-cursor-encoding", 1);
        const cursorInitial = cursorTarget.transaction(() => cursorTarget.session.begin(IDENTITY));
        cursorTarget.sql.exec(
            "UPDATE _chardb_vector_snapshot_sessions SET expected_cursor_json = ? WHERE mig_id = ?",
            JSON.stringify(cursorInitial.next.cursor, null, 2),
            IDENTITY.migId
        );
        expect(() => cursorTarget.session.inspect(IDENTITY)).toThrow("expected cursor encoding is not canonical");

        const cachedCursorTarget = setup();
        databases.push(cachedCursorTarget.db);
        stage(cachedCursorTarget, "vec-corrupt-cached-cursor-encoding", 1);
        const cachedCursorInitial = cachedCursorTarget.transaction(() => cachedCursorTarget.session.begin(IDENTITY));
        cachedCursorTarget.transaction(() => cachedCursorTarget.session.read(IDENTITY, cachedCursorInitial.next));
        cachedCursorTarget.sql.exec(
            "UPDATE _chardb_vector_snapshot_sessions SET cached_input_cursor_json = ? WHERE mig_id = ?",
            JSON.stringify(cachedCursorInitial.next.cursor, null, 2),
            IDENTITY.migId
        );
        expect(() => cachedCursorTarget.session.inspect(IDENTITY)).toThrow(
            "cached input cursor encoding is not canonical"
        );

        const pageTarget = setup();
        databases.push(pageTarget.db);
        stage(pageTarget, "vec-corrupt-page-encoding", 1);
        const pageInitial = pageTarget.transaction(() => pageTarget.session.begin(IDENTITY));
        const page = pageTarget.transaction(() => pageTarget.session.read(IDENTITY, pageInitial.next));
        pageTarget.sql.exec(
            "UPDATE _chardb_vector_snapshot_sessions SET cached_page_enc = ? WHERE mig_id = ?",
            JSON.stringify(JSON.parse(page.encodedPage), null, 2),
            IDENTITY.migId
        );
        expect(() => pageTarget.session.inspect(IDENTITY)).toThrow("cached page encoding is not canonical");
    });

    test("rejects page-number overflow and caps retained session tombstones", () => {
        const overflow = setup();
        databases.push(overflow.db);
        stage(overflow, "vec-overflow", 1);
        const initial = overflow.transaction(() => overflow.session.begin(IDENTITY));
        overflow.sql.exec(
            "UPDATE _chardb_vector_snapshot_sessions SET next_page_number = ? WHERE mig_id = ?",
            Number.MAX_SAFE_INTEGER,
            IDENTITY.migId
        );
        expect(() =>
            overflow.transaction(() =>
                overflow.session.read(IDENTITY, { pageNumber: Number.MAX_SAFE_INTEGER, cursor: initial.next.cursor })
            )
        ).toThrow("page number cannot advance");

        const capacity = setup();
        databases.push(capacity.db);
        capacity.sql.exec("DELETE FROM _chardb_vector_snapshot_sessions");
        const cursorJson = JSON.stringify(capacity.session.begin(IDENTITY).next.cursor);
        capacity.sql.exec("DELETE FROM _chardb_vector_snapshot_sessions");
        capacity.sql.exec(
            `WITH RECURSIVE sequence(value) AS (
               SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < ?
             )
             INSERT INTO _chardb_vector_snapshot_sessions
               (mig_id, range_lo, range_hi, through_head_seq, expected_cursor_json, next_page_number,
                cached_page_number, cached_input_cursor_json, cached_page_enc, terminal, cleaned)
             SELECT printf('retained_%05d', value), 0, 16383, 0, ?, 0, NULL, NULL, NULL, 0, 1
             FROM sequence`,
            CDB_VECTOR_RESHARD_SNAPSHOT_SESSION_LIMIT,
            cursorJson
        );
        expect(() => capacity.transaction(() => capacity.session.begin(IDENTITY))).toThrow(
            "snapshot session history reached its durable row limit"
        );
    });
});
