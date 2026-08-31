import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { CDB_RESHARD_IDENTITY_STORE_DDL } from "../../src/server/do/cdb-reshard-identity-store.ts";
import {
    CDB_RESHARD_MAX_BATCH_BYTES,
    CDB_RESHARD_MAX_ROW_BYTES,
    reshardJsonBytes,
} from "../../src/server/do/cdb-reshard-relational.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../../src/server/do/cdb-routing-fence-store.ts";
import {
    CDB_VECTOR_MAX_DELETE_IDS,
    CDB_VECTOR_MAX_DIMENSIONS,
    CDB_VECTOR_MAX_METADATA_BYTES,
    CdbVectorOutboxStore,
    initializeCdbVectorOutboxStore,
} from "../../src/server/do/cdb-vector-outbox-store.ts";
import {
    CDB_VECTOR_RESHARD_PAGE_SIZE,
    type CdbVectorReshardHeadRecord,
    type CdbVectorReshardOutboxRecord,
    type CdbVectorReshardRecord,
    CdbVectorReshardSnapshotReader,
    decodeCdbVectorReshardPage,
    decodeCdbVectorReshardRecord,
    encodeCdbVectorReshardPage,
    encodeCdbVectorReshardRecord,
} from "../../src/server/do/cdb-vector-reshard-records.ts";

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

const IDENTITY = Object.freeze({ migId: "vector_move_1", rangeLo: 0, rangeHi: 16_383 });

function setup(): {
    readonly db: Database;
    readonly sql: SyncSql;
    readonly vectors: CdbVectorOutboxStore;
    readonly reader: CdbVectorReshardSnapshotReader;
} {
    const db = new Database(":memory:");
    const sql = syncSql(db);
    db.exec(CDB_RESHARD_IDENTITY_STORE_DDL);
    db.exec(SPLIT_LOG_DDL);
    db.exec(CDB_ROUTING_FENCE_STORE_DDL);
    initializeCdbVectorOutboxStore(sql);
    sql.exec(
        `INSERT INTO _chardb_split_identity
           (mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json, created_at)
         VALUES (?, ?, ?, 'source', 0, 1, ?, '[]', 0)`,
        IDENTITY.migId,
        IDENTITY.rangeLo,
        IDENTITY.rangeHi,
        "a".repeat(64)
    );
    return { db, sql, vectors: new CdbVectorOutboxStore(sql), reader: new CdbVectorReshardSnapshotReader(sql) };
}

function readAll(
    target: ReturnType<typeof setup>,
    initialCursor = target.reader.begin(IDENTITY)
): CdbVectorReshardRecord[] {
    const records: CdbVectorReshardRecord[] = [];
    let cursor = initialCursor;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = target.reader.read(IDENTITY, cursor, CDB_VECTOR_RESHARD_PAGE_SIZE);
        records.push(...page.records);
        const wire = encodeCdbVectorReshardPage(page);
        expect(new TextEncoder().encode(wire).byteLength).toBeLessThanOrEqual(CDB_RESHARD_MAX_BATCH_BYTES);
        expect(decodeCdbVectorReshardPage(wire)).toEqual(page);
        if (page.done) return records;
        cursor = page.next;
    }
    throw new Error("vector snapshot did not finish within its test bound");
}

function maximumValues(): number[] {
    return Array.from({ length: CDB_VECTOR_MAX_DIMENSIONS }, (_, index) => index / CDB_VECTOR_MAX_DIMENSIONS);
}

describe("Cdb vector reshard records", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("preserves exact head bytes, metadata text, outbox receipt state, and attempt state", () => {
        const target = setup();
        databases.push(target.db);
        target.vectors.stageUpsert({
            vectorId: "vec-exact",
            organizationId: "org-exact",
            resourceId: "resource-exact",
            rowPk: "row-exact",
            dimensions: 3,
            values: [Math.PI, -0, 1 / 3],
            metadata: { nested: { value: "exact" } },
            nowMs: 100,
        });
        const exactMetadata = '{ "nested" : { "value" : "exact" } }';
        target.sql.exec("UPDATE _chardb_vectors SET metadata_json = ? WHERE vector_id = ?", exactMetadata, "vec-exact");
        target.sql.exec(
            `UPDATE _chardb_vector_outbox
             SET phase = 'verify', mutation_id = ?, accepted_at = ?, attempts = ?, next_attempt_at = ?, last_error = ?
             WHERE vector_id = ?`,
            "receipt-exact",
            110,
            7,
            120,
            "preserved failure",
            "vec-exact"
        );
        target.sql.exec(
            `INSERT INTO _chardb_vector_attempts
               (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed,
                response_ambiguous, delete_confirmed, delete_claim_token)
             VALUES (?, 1, 101, 130, 1, 1, 0, ?)`,
            "vec-exact",
            "claim-token-exact"
        );

        const sourceBytes = target.sql.one<{ values_enc: Uint8Array }>(
            "SELECT values_enc FROM _chardb_vectors WHERE vector_id = ?",
            "vec-exact"
        )?.values_enc;
        if (!sourceBytes) throw new Error("vector fixture lost its stored embedding");
        const records = readAll(target);
        expect(records.map(record => record.kind)).toEqual(["head", "outbox", "attempt"]);
        const head = records[0] as CdbVectorReshardHeadRecord;
        expect([...Uint8Array.from(atob(head.valuesEncBase64 as string), value => value.charCodeAt(0))]).toEqual([
            ...sourceBytes,
        ]);
        expect(head.metadataJson).toBe(exactMetadata);
        expect(records[1]).toMatchObject({
            kind: "outbox",
            phase: "verify",
            mutationId: "receipt-exact",
            acceptedAt: 110,
            attempts: 7,
            nextAttemptAt: 120,
            lastError: "preserved failure",
        });
        expect(records[2]).toMatchObject({
            kind: "attempt",
            physicalVersion: 1,
            firstSentAt: 101,
            settleAfter: 130,
            visibilityConfirmed: 1,
            responseAmbiguous: 1,
            deleteConfirmed: 0,
            deleteClaimToken: "claim-token-exact",
        });
        for (const record of records)
            expect(decodeCdbVectorReshardRecord(encodeCdbVectorReshardRecord(record))).toEqual(record);
    });

    test("preserves failed-unproven delivery state through the strict snapshot codec", () => {
        const target = setup();
        databases.push(target.db);
        target.vectors.stageUpsert({
            vectorId: "vec-terminal",
            organizationId: "org-terminal",
            resourceId: "resource-terminal",
            rowPk: "row-terminal",
            dimensions: 2,
            values: [1, 2],
            metadata: {},
            nowMs: 0,
        });
        const upsert = target.vectors.claimNext({
            nowMs: 0,
            leaseMs: 50,
            settlementMs: 100,
            claimToken: "terminal-upsert-claim-01",
        });
        if (!upsert || upsert.operation !== "upsert") throw new Error("expected terminal fixture upsert");
        target.vectors.failClaim({
            vectorId: upsert.vectorId,
            targetVersion: upsert.targetVersion,
            operation: "upsert",
            phase: "submit",
            claimToken: upsert.claimToken,
            nextAttemptAt: 1,
            error: "response lost",
        });
        target.vectors.stageDelete({ vectorId: upsert.vectorId, organizationId: "org-terminal", nowMs: 1 });
        const deletion = target.vectors.claimNext({
            nowMs: 100,
            leaseMs: 50,
            settlementMs: 100,
            claimToken: "terminal-delete-claim-01",
        });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected terminal fixture delete");
        target.vectors.terminallyFailUnprovenDelete(deletion, 101);

        const outbox = readAll(target).find(
            (record): record is CdbVectorReshardOutboxRecord => record.kind === "outbox"
        );
        if (!outbox) throw new Error("terminal snapshot lost its outbox");
        expect(outbox).toMatchObject({
            terminalFailure: 1,
            leasedUntil: null,
            leaseToken: null,
            lastError: "terminal: external vector absence could not be proven",
        });
        expect(decodeCdbVectorReshardRecord(encodeCdbVectorReshardRecord(outbox))).toEqual(outbox);
    });

    test("uses encoded bytes as a page limit when the 500-row limit would admit too much state", () => {
        const target = setup();
        databases.push(target.db);
        const values = maximumValues();
        const metadata = { body: "m".repeat(CDB_VECTOR_MAX_METADATA_BYTES - 11) };
        for (let index = 0; index < 50; index++) {
            target.vectors.stageUpsert({
                vectorId: `vec-max-${index.toString().padStart(2, "0")}`,
                organizationId: `org-max-${index.toString().padStart(2, "0")}`,
                resourceId: "resource-max",
                rowPk: `row-${index}`,
                dimensions: CDB_VECTOR_MAX_DIMENSIONS,
                values,
                metadata,
                nowMs: index,
            });
        }

        const allHeads = target.sql.all<{ bytes: number }>(
            "SELECT length(values_enc) + length(metadata_json) AS bytes FROM _chardb_vectors"
        );
        expect(allHeads).toHaveLength(50);
        expect(allHeads.reduce((sum, row) => sum + row.bytes, 0)).toBeGreaterThan(CDB_RESHARD_MAX_BATCH_BYTES);

        const first = target.reader.read(IDENTITY, target.reader.begin(IDENTITY));
        expect(first.records.length).toBeGreaterThan(1);
        expect(first.records.length).toBeLessThan(50);
        expect(first.records.length).toBeLessThan(CDB_VECTOR_RESHARD_PAGE_SIZE);
        expect(first.next.kind).toBe("head");
        expect(first.done).toBe(false);
        expect(reshardJsonBytes(first)).toBeLessThanOrEqual(CDB_RESHARD_MAX_BATCH_BYTES);
        expect(new TextEncoder().encode(encodeCdbVectorReshardPage(first)).byteLength).toBeLessThanOrEqual(
            CDB_RESHARD_MAX_BATCH_BYTES
        );

        expect(readAll(target).filter(record => record.kind === "head")).toHaveLength(50);
    });

    test("holds one head watermark across phases so tail-owned inserts cannot orphan an outbox", () => {
        const target = setup();
        databases.push(target.db);
        target.vectors.stageUpsert({
            vectorId: "vec-before-watermark",
            organizationId: "org-before-watermark",
            resourceId: "resource-watermark",
            rowPk: "row-before",
            dimensions: 2,
            values: [1, 2],
            metadata: {},
            nowMs: 1,
        });
        const cursor = target.reader.begin(IDENTITY);
        expect(cursor.throughHeadSeq).toBeGreaterThan(0);

        target.vectors.stageUpsert({
            vectorId: "vec-after-watermark",
            organizationId: "org-after-watermark",
            resourceId: "resource-watermark",
            rowPk: "row-after",
            dimensions: 2,
            values: [3, 4],
            metadata: {},
            nowMs: 2,
        });

        const records = readAll(target, cursor);
        expect(records.map(record => `${record.kind}:${record.vectorId}`)).toEqual([
            "head:vec-before-watermark",
            "outbox:vec-before-watermark",
        ]);
    });

    test("does not leak a replacement that reuses the deleted maximum rowid", () => {
        const target = setup();
        databases.push(target.db);
        target.vectors.stageUpsert({
            vectorId: "vec-old-incarnation",
            organizationId: "org-old-incarnation",
            resourceId: "resource-incarnation",
            rowPk: "row-old",
            dimensions: 2,
            values: [1, 2],
            metadata: {},
            nowMs: 1,
        });
        const oldIdentity = target.sql.one<{ rowid: number; created_seq: number }>(
            "SELECT rowid, created_seq FROM _chardb_vectors WHERE vector_id = ?",
            "vec-old-incarnation"
        );
        if (!oldIdentity) throw new Error("old vector incarnation was not stored");

        const first = target.reader.read(IDENTITY, target.reader.begin(IDENTITY));
        expect(first.records.map(record => `${record.kind}:${record.vectorId}`)).toEqual(["head:vec-old-incarnation"]);
        expect(first.next.kind).toBe("outbox");

        target.sql.exec("DELETE FROM _chardb_vectors WHERE vector_id = ?", "vec-old-incarnation");
        target.vectors.stageUpsert({
            vectorId: "vec-new-incarnation",
            organizationId: "org-new-incarnation",
            resourceId: "resource-incarnation",
            rowPk: "row-new",
            dimensions: 2,
            values: [3, 4],
            metadata: {},
            nowMs: 2,
        });
        target.sql.exec(
            `INSERT INTO _chardb_vector_attempts
               (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed,
                response_ambiguous, delete_confirmed, delete_claim_token)
             VALUES (?, 1, 2, 3, 0, 0, 0, NULL)`,
            "vec-new-incarnation"
        );
        const replacementIdentity = target.sql.one<{ rowid: number; created_seq: number }>(
            "SELECT rowid, created_seq FROM _chardb_vectors WHERE vector_id = ?",
            "vec-new-incarnation"
        );
        expect(replacementIdentity?.rowid).toBe(oldIdentity.rowid);
        expect(replacementIdentity?.created_seq).toBeGreaterThan(first.next.throughHeadSeq);

        expect(readAll(target, first.next)).toEqual([]);
    });

    test("rejects placement, resource, version, cursor, and bound movement drift", () => {
        const target = setup();
        databases.push(target.db);
        target.vectors.stageUpsert({
            vectorId: "vec-drift",
            organizationId: "org-drift",
            resourceId: "resource-drift",
            rowPk: "row-drift",
            dimensions: 2,
            values: [1, 2],
            metadata: {},
            nowMs: 1,
        });
        const head = target.reader.read(IDENTITY, target.reader.begin(IDENTITY))
            .records[0] as CdbVectorReshardHeadRecord;
        expect(() =>
            encodeCdbVectorReshardRecord({ ...head, placementVshard: (head.placementVshard + 1) % 16_384 })
        ).toThrow("placement is invalid");
        expect(() => encodeCdbVectorReshardRecord({ ...head, resourceId: "bad resource" })).toThrow(
            "resource id is invalid"
        );
        expect(() => encodeCdbVectorReshardRecord({ ...head, headVersion: 0 })).toThrow("head version is invalid");
        expect(() =>
            target.reader.read(IDENTITY, {
                kind: "attempt",
                throughHeadSeq: 1,
                afterPlacement: head.placementVshard,
                afterVectorId: head.vectorId,
                afterPhysicalVersion: -1,
            })
        ).toThrow("physical version is invalid");
        expect(() => target.reader.begin({ ...IDENTITY, rangeHi: 100 })).toThrow("bound source identity");
        target.sql.exec("UPDATE _chardb_vectors SET placement_vshard = ? WHERE vector_id = ?", 16_383, head.vectorId);
        expect(() => target.reader.read(IDENTITY, target.reader.begin(IDENTITY))).toThrow("placement is invalid");
    });

    test("rejects unknown record, cursor, and page fields plus oversized raw records", () => {
        const target = setup();
        databases.push(target.db);
        target.vectors.stageUpsert({
            vectorId: "vec-wire",
            organizationId: "org-wire",
            resourceId: "resource-wire",
            rowPk: "row-wire",
            dimensions: 2,
            values: [1, 2],
            metadata: {},
            nowMs: 1,
        });
        const page = target.reader.read(IDENTITY, target.reader.begin(IDENTITY));
        const head = page.records[0] as CdbVectorReshardHeadRecord;

        expect(() => decodeCdbVectorReshardRecord(JSON.stringify({ ...head, ignoredByOlderDecoder: true }))).toThrow(
            "head record has an unknown field"
        );
        expect(() => encodeCdbVectorReshardRecord({ ...head, ignoredByOlderEncoder: true } as never)).toThrow(
            "head record has an unknown field"
        );

        const pageWire = JSON.parse(encodeCdbVectorReshardPage(page)) as Record<string, unknown>;
        expect(() =>
            decodeCdbVectorReshardPage(JSON.stringify({ ...pageWire, schema: "chardb.vector-reshard-page.v1" }))
        ).toThrow("page is malformed");
        expect(() => decodeCdbVectorReshardPage(JSON.stringify({ ...pageWire, ignoredPageField: true }))).toThrow(
            "page has an unknown field"
        );
        expect(() =>
            decodeCdbVectorReshardPage(
                JSON.stringify({
                    ...pageWire,
                    next: { ...(pageWire.next as Record<string, unknown>), ignoredCursorField: true },
                })
            )
        ).toThrow("page cursor has an unknown field");

        expect(() => decodeCdbVectorReshardRecord(" ".repeat(CDB_RESHARD_MAX_ROW_BYTES + 1))).toThrow(
            "record encoding exceeds its byte limit"
        );
    });

    test("applies the live delete verification-id contract to moved outbox state", () => {
        const target = setup();
        databases.push(target.db);
        target.vectors.stageUpsert({
            vectorId: "vec-delete-wire",
            organizationId: "org-delete-wire",
            resourceId: "resource-delete-wire",
            rowPk: "row-delete-wire",
            dimensions: 2,
            values: [1, 2],
            metadata: {},
            nowMs: 1,
        });
        target.sql.exec(
            "UPDATE _chardb_vectors SET delivered_version = version, state = 'ready' WHERE vector_id = ?",
            "vec-delete-wire"
        );
        target.sql.exec("DELETE FROM _chardb_vector_outbox WHERE vector_id = ?", "vec-delete-wire");
        target.vectors.stageDelete({
            vectorId: "vec-delete-wire",
            organizationId: "org-delete-wire",
            nowMs: 2,
        });
        const outbox = readAll(target).find(
            (record): record is CdbVectorReshardOutboxRecord => record.kind === "outbox"
        );
        if (!outbox) throw new Error("expected a delete outbox record");

        const physicalV1 = "v1/resource-delete-wire/vec-delete-wire/1";
        expect(
            decodeCdbVectorReshardRecord(
                encodeCdbVectorReshardRecord({ ...outbox, verifyIdsJson: JSON.stringify([physicalV1]) })
            )
        ).toMatchObject({ verifyIdsJson: JSON.stringify([physicalV1]) });

        const rejectIds = (ids: readonly string[]) =>
            encodeCdbVectorReshardRecord({ ...outbox, verifyIdsJson: JSON.stringify(ids) });
        expect(() => rejectIds(Array.from({ length: CDB_VECTOR_MAX_DELETE_IDS + 1 }, () => physicalV1))).toThrow(
            "verification ids are invalid"
        );
        expect(() => rejectIds([physicalV1, physicalV1])).toThrow("verification ids are invalid");
        expect(() => rejectIds(["v1/another-resource/vec-delete-wire/1"])).toThrow("verification ids are invalid");
        expect(() => rejectIds(["v1/resource-delete-wire/vec-delete-wire/01"])).toThrow("verification ids are invalid");
        expect(() => rejectIds(["v1/resource-delete-wire/vec-delete-wire/0"])).toThrow("verification ids are invalid");
        expect(() => rejectIds(["v1/resource-delete-wire/vec-delete-wire/2"])).toThrow("verification ids are invalid");
    });
});
