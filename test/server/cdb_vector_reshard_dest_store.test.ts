import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { CDB_RESHARD_IDENTITY_STORE_DDL } from "../../src/server/do/cdb-reshard-identity-store.ts";
import { CDB_ROUTING_FENCE_STORE_DDL } from "../../src/server/do/cdb-routing-fence-store.ts";
import { CdbVectorOutboxStore, initializeCdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import {
    CdbVectorReshardDestStore,
    initializeCdbVectorReshardDestStore,
} from "../../src/server/do/cdb-vector-reshard-dest-store.ts";
import {
    CdbVectorReshardProvenanceStore,
    cdbVectorReshardSnapshotRecordFingerprint,
    initializeCdbVectorReshardProvenance,
} from "../../src/server/do/cdb-vector-reshard-provenance.ts";
import {
    CDB_VECTOR_RESHARD_PAGE_SCHEMA,
    CDB_VECTOR_RESHARD_PARITY_START_CURSOR,
    type CdbVectorReshardCursor,
    CdbVectorReshardSnapshotReader,
    decodeCdbVectorReshardPage,
    encodeCdbVectorReshardPage,
} from "../../src/server/do/cdb-vector-reshard-records.ts";
import { sha256Hex, stableJson } from "../../src/util/canonical.ts";

interface SqlStats {
    attemptCountQueries: number;
}

function syncSql(db: Database, stats?: SqlStats): SyncSql {
    return {
        exec(query, ...params) {
            db.run(query, params as never[]);
        },
        one<T>(query: string, ...params: never[]): T | null {
            if (query.includes("COUNT(*) AS count FROM _chardb_vector_attempts WHERE vector_id")) {
                if (stats) stats.attemptCountQueries++;
            }
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

const IDENTITY = Object.freeze({ migId: "vector_dest_1", rangeLo: 0, rangeHi: 16_383 });

function bind(sql: SyncSql, role: "source" | "dest", identity = IDENTITY): void {
    sql.exec(
        `INSERT INTO _chardb_split_identity
           (mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json, created_at)
         VALUES (?, ?, ?, ?, 0, 1, ?, '[]', 0)`,
        identity.migId,
        identity.rangeLo,
        identity.rangeHi,
        role,
        "a".repeat(64)
    );
}

function database(role: "source" | "dest") {
    const db = new Database(":memory:");
    const stats: SqlStats = { attemptCountQueries: 0 };
    const sql = syncSql(db, stats);
    db.exec(CDB_RESHARD_IDENTITY_STORE_DDL);
    db.exec(SPLIT_LOG_DDL);
    db.exec(CDB_ROUTING_FENCE_STORE_DDL);
    initializeCdbVectorOutboxStore(sql);
    bind(sql, role);
    if (role === "dest") initializeCdbVectorReshardDestStore(sql);
    return {
        db,
        sql,
        vectors: new CdbVectorOutboxStore(sql),
        reader: new CdbVectorReshardSnapshotReader(sql, role),
        dest: role === "dest" ? new CdbVectorReshardDestStore(sql) : null,
        provenance: role === "dest" ? new CdbVectorReshardProvenanceStore(sql) : null,
        transaction: <T>(callback: () => T): T => db.transaction(callback)(),
        stats,
    };
}

function stage(
    source: ReturnType<typeof database>,
    vectorId: string,
    nowMs: number,
    organizationId = `org-${vectorId}`
): void {
    source.vectors.stageUpsert({
        vectorId,
        organizationId,
        resourceId: "resource-destination",
        rowPk: `row-${vectorId}`,
        dimensions: 3,
        values: [Math.PI, -0, 1 / 3],
        metadata: { vectorId, nested: { exact: true } },
        nowMs,
    });
    source.sql.exec(
        `INSERT INTO _chardb_vector_attempts
           (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed,
            response_ambiguous, delete_confirmed, delete_claim_token)
         VALUES (?, 1, ?, ?, 1, 1, 0, ?)`,
        vectorId,
        nowMs,
        nowMs + 50,
        `claim-token-${vectorId}`.padEnd(16, "x")
    );
}

function applyAll(source: ReturnType<typeof database>, destination: ReturnType<typeof database>) {
    if (!destination.dest) throw new Error("destination fixture is missing its store");
    let cursor = source.reader.begin(IDENTITY);
    destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));
    const results = [];
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = source.reader.read(IDENTITY, cursor);
        const encodedPage = encodeCdbVectorReshardPage(page);
        const result = destination.transaction(() =>
            destination.dest?.apply(IDENTITY, {
                pageNumber,
                cursor,
                encodedPage,
                throughLsn: pageNumber + 1,
            })
        );
        if (!result) throw new Error("destination apply returned no result");
        results.push({ request: { pageNumber, cursor, encodedPage, throughLsn: pageNumber + 1 }, result });
        if (page.done) return results;
        cursor = page.next;
    }
    throw new Error("vector destination fixture did not reach its terminal page");
}

describe("Cdb vector reshard destination store", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("applies heads before children and reaches exact source/destination parity", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-a", 10);
        stage(source, "vec-b", 20);

        const applied = applyAll(source, destination);
        expect(applied.map(page => decodeCdbVectorReshardPage(page.request.encodedPage).records[0]?.kind)).toEqual([
            "head",
            "outbox",
            "attempt",
        ]);
        expect(applied.reduce((sum, page) => sum + page.result.applied, 0)).toBe(6);
        expect(applied.reduce((sum, page) => sum + page.result.inserted, 0)).toBe(6);

        let cursor: CdbVectorReshardCursor = CDB_VECTOR_RESHARD_PARITY_START_CURSOR;
        for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
            const sourcePage = source.reader.read(IDENTITY, cursor);
            const destinationPage = destination.dest?.readParityPage(IDENTITY, cursor);
            expect(stableJson(destinationPage)).toBe(stableJson(sourcePage));
            if (sourcePage.done) break;
            cursor = sourcePage.next;
        }
        expect(destination.sql.one("SELECT * FROM _chardb_vector_capacity WHERE singleton = 1")).toMatchObject({
            head_count: 2,
            outbox_rows: 2,
            attempt_rows: 2,
        });
    });

    test("moves failed-unproven outbox state without rearming destination scheduling", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        source.vectors.stageUpsert({
            vectorId: "vec-terminal-move",
            organizationId: "org-terminal-move",
            resourceId: "resource-destination",
            rowPk: "row-terminal-move",
            dimensions: 2,
            values: [1, 2],
            metadata: {},
            nowMs: 0,
        });
        const upsert = source.vectors.claimNext({
            nowMs: 0,
            leaseMs: 50,
            settlementMs: 100,
            claimToken: "terminal-move-upsert-01",
        });
        if (!upsert || upsert.operation !== "upsert") throw new Error("expected moved terminal upsert");
        source.vectors.failClaim({
            vectorId: upsert.vectorId,
            targetVersion: upsert.targetVersion,
            operation: "upsert",
            phase: "submit",
            claimToken: upsert.claimToken,
            nextAttemptAt: 1,
            error: "response lost",
        });
        source.vectors.stageDelete({ vectorId: upsert.vectorId, organizationId: "org-terminal-move", nowMs: 1 });
        const deletion = source.vectors.claimNext({
            nowMs: 100,
            leaseMs: 50,
            settlementMs: 100,
            claimToken: "terminal-move-delete-01",
        });
        if (!deletion || deletion.operation !== "delete") throw new Error("expected moved terminal delete");
        source.vectors.terminallyFailUnprovenDelete(deletion, 101);

        applyAll(source, destination);

        expect(destination.vectors.readDeliveryStatus(upsert.vectorId)).toEqual({
            state: "failed_unproven",
            lastError: "terminal: external vector absence could not be proven",
        });
        expect(destination.vectors.nextDueAt()).toBeNull();
        expect(destination.vectors.read(upsert.vectorId)).toMatchObject({ state: "deleting" });
    });

    test("applies exact 500/501 row boundaries without mixing record kinds", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        for (let index = 0; index < 501; index++) {
            source.vectors.stageUpsert({
                vectorId: `vec-boundary-${index.toString().padStart(3, "0")}`,
                organizationId: "org-boundary",
                resourceId: "resource-boundary",
                rowPk: `row-${index}`,
                dimensions: 1,
                values: [index],
                metadata: {},
                nowMs: index,
            });
        }
        let cursor = source.reader.begin(IDENTITY);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));
        const shape: Array<[string, number]> = [];
        for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
            const page = source.reader.read(IDENTITY, cursor);
            shape.push([page.records[0]?.kind ?? "done", page.records.length]);
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber,
                    cursor,
                    encodedPage: encodeCdbVectorReshardPage(page),
                    throughLsn: pageNumber,
                })
            );
            if (page.done) break;
            cursor = page.next;
        }
        expect(shape).toEqual([
            ["head", 500],
            ["head", 1],
            ["outbox", 500],
            ["outbox", 1],
            ["done", 0],
        ]);
        expect(destination.provenance?.counts(IDENTITY)).toEqual({ records: 1_002, receipts: 0 });
    });

    test("uses SQLite BINARY key order for mixed case and punctuation", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        for (const [index, vectorId] of ["a", "Z", "A_", "A-"].entries()) {
            stage(source, vectorId, index + 1, "org-binary-order");
        }

        const cursor = source.reader.begin(IDENTITY);
        const heads = source.reader.read(IDENTITY, cursor);
        expect(heads.records.map(record => record.vectorId)).toEqual(["A-", "A_", "Z", "a"]);
        expect(() => applyAll(source, destination)).not.toThrow();
    });

    test("matches honest tail-before-snapshot fingerprints for every physical record kind", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-tail-first", 10);
        stage(destination, "vec-tail-first", 10);
        const cursor = source.reader.begin(IDENTITY);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));
        let sourceCursor = cursor;
        const pages = [];
        for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
            const page = source.reader.read(IDENTITY, sourceCursor);
            const record = page.records[0];
            if (!record) throw new Error("tail-first fixture lost a vector record");
            destination.transaction(() =>
                destination.provenance?.recordTail(IDENTITY, {
                    kind: record.kind,
                    vectorId: record.vectorId,
                    physicalVersion: record.kind === "attempt" ? record.physicalVersion : 0,
                    placementVshard: record.placementVshard,
                    lsn: pageNumber + 1,
                    present: true,
                    inserted: true,
                    imageFingerprint: cdbVectorReshardSnapshotRecordFingerprint(record),
                })
            );
            pages.push({
                pageNumber,
                cursor: sourceCursor,
                encodedPage: encodeCdbVectorReshardPage(page),
                throughLsn: 10,
            });
            sourceCursor = page.next;
        }
        for (const request of pages) {
            expect(destination.transaction(() => destination.dest?.apply(IDENTITY, request))).toMatchObject({
                applied: 1,
                inserted: 0,
                skipped: 0,
            });
        }
        expect(destination.provenance?.counts(IDENTITY)).toEqual({ records: 3, receipts: 0 });
    });

    test("rolls back a page when covered tail provenance has a different physical image", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-tail-mismatch", 1);
        stage(destination, "vec-tail-mismatch", 1);
        const cursor = source.reader.begin(IDENTITY);
        const page = source.reader.read(IDENTITY, cursor);
        const head = page.records[0];
        if (!head || head.kind !== "head") throw new Error("tail mismatch fixture has no head");
        destination.transaction(() => {
            destination.dest?.begin(IDENTITY, cursor.throughHeadSeq);
            destination.provenance?.recordTail(IDENTITY, {
                kind: "head",
                vectorId: head.vectorId,
                physicalVersion: 0,
                placementVshard: head.placementVshard,
                lsn: 1,
                present: true,
                inserted: true,
                imageFingerprint: "f".repeat(64),
            });
        });
        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 0,
                    cursor,
                    encodedPage: encodeCdbVectorReshardPage(page),
                    throughLsn: 1,
                })
            )
        ).toThrow("snapshot image differs from tail provenance");
        expect(
            destination.sql.one<{ next_page_number: number }>(
                "SELECT next_page_number FROM _chardb_vector_reshard_dest_sessions WHERE mig_id = ?",
                IDENTITY.migId
            )
        ).toEqual({ next_page_number: 0 });
    });

    test("rejects a child page before its head page and rolls the transaction back", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-child-first", 1);
        const cursor = source.reader.begin(IDENTITY);
        const heads = source.reader.read(IDENTITY, cursor);
        const outboxes = source.reader.read(IDENTITY, heads.next);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));

        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 0,
                    cursor,
                    encodedPage: encodeCdbVectorReshardPage(outboxes),
                    throughLsn: 1,
                })
            )
        ).toThrow("page record kind does not match its input cursor");
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vector_outbox")).toEqual({
            count: 0,
        });
        expect(
            destination.sql.one<{ next_page_number: number }>(
                "SELECT next_page_number FROM _chardb_vector_reshard_dest_sessions WHERE mig_id = ?",
                IDENTITY.migId
            )
        ).toEqual({ next_page_number: 0 });
    });

    test("rejects forged kind jumps and an empty initial terminal page", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-forged-kind", 1);
        const cursor = source.reader.begin(IDENTITY);
        const headPage = source.reader.read(IDENTITY, cursor);
        const outboxPage = source.reader.read(IDENTITY, headPage.next);
        const attemptPage = source.reader.read(IDENTITY, outboxPage.next);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));

        const done = { ...cursor, kind: "done" as const };
        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 0,
                    cursor,
                    encodedPage: encodeCdbVectorReshardPage({
                        schema: CDB_VECTOR_RESHARD_PAGE_SCHEMA,
                        records: [],
                        next: done,
                        done: true,
                    }),
                    throughLsn: 1,
                })
            )
        ).toThrow("empty page does not advance exactly one record kind");
        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 0,
                    cursor,
                    encodedPage: encodeCdbVectorReshardPage({ ...attemptPage, next: done, done: true }),
                    throughLsn: 1,
                })
            )
        ).toThrow("page record kind does not match its input cursor");
    });

    test("accepts the honest empty outbox transition before retained attempts", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-no-outbox", 1);
        source.sql.exec("DELETE FROM _chardb_vector_outbox WHERE vector_id = 'vec-no-outbox'");
        const applied = applyAll(source, destination);
        expect(
            applied.map(entry => {
                const page = decodeCdbVectorReshardPage(entry.request.encodedPage);
                return [entry.request.cursor.kind, page.records[0]?.kind ?? "empty", page.next.kind];
            })
        ).toEqual([
            ["head", "head", "outbox"],
            ["outbox", "empty", "attempt"],
            ["attempt", "attempt", "done"],
        ]);
    });

    test("applies the legal 4096-attempt boundary with one count seed per page", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-attempt-cap", 1);
        source.sql.exec("UPDATE _chardb_vectors SET version = 4096 WHERE vector_id = 'vec-attempt-cap'");
        source.sql.exec("UPDATE _chardb_vector_outbox SET target_version = 4096 WHERE vector_id = 'vec-attempt-cap'");
        source.sql.exec("DELETE FROM _chardb_vector_attempts WHERE vector_id = 'vec-attempt-cap'");
        source.transaction(() => {
            for (let version = 1; version <= 4_096; version++) {
                source.sql.exec(
                    `INSERT INTO _chardb_vector_attempts
                       (vector_id, physical_version, first_sent_at, settle_after, visibility_confirmed,
                        response_ambiguous, delete_confirmed, delete_claim_token)
                     VALUES ('vec-attempt-cap', ?, ?, ?, 0, 0, 0, NULL)`,
                    version,
                    version,
                    version
                );
            }
        });

        const started = performance.now();
        const applied = applyAll(source, destination);
        const elapsedMs = performance.now() - started;
        expect(applied.reduce((sum, page) => sum + page.result.applied, 0)).toBe(4_098);
        expect(destination.stats.attemptCountQueries).toBe(9);
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vector_attempts")).toEqual(
            {
                count: 4_096,
            }
        );
        expect(elapsedMs).toBeLessThan(30_000);
    });

    test("accepts a later child image while its migration-owned snapshot head is older", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-cross-kind-skew", 1);
        const cursor = source.reader.begin(IDENTITY);
        const headPage = source.reader.read(IDENTITY, cursor);
        destination.transaction(() => {
            destination.dest?.begin(IDENTITY, cursor.throughHeadSeq);
            destination.dest?.apply(IDENTITY, {
                pageNumber: 0,
                cursor,
                encodedPage: encodeCdbVectorReshardPage(headPage),
                throughLsn: 1,
            });
        });
        source.sql.exec(
            "UPDATE _chardb_vectors SET version = 3, state = 'pending', updated_at = 3 WHERE vector_id = 'vec-cross-kind-skew'"
        );
        source.sql.exec(
            "UPDATE _chardb_vector_outbox SET target_version = 3, next_attempt_at = 3 WHERE vector_id = 'vec-cross-kind-skew'"
        );
        const outboxPage = source.reader.read(IDENTITY, headPage.next);
        expect(outboxPage.records[0]).toMatchObject({ kind: "outbox", headVersion: 3, targetVersion: 3 });
        expect(
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 1,
                    cursor: headPage.next,
                    encodedPage: encodeCdbVectorReshardPage(outboxPage),
                    throughLsn: 3,
                })
            )
        ).toMatchObject({ applied: 1, inserted: 1 });
        expect(destination.sql.one<{ version: number }>("SELECT version FROM _chardb_vectors")).toEqual({ version: 1 });
        expect(
            destination.sql.one<{ target_version: number }>("SELECT target_version FROM _chardb_vector_outbox")
        ).toEqual({ target_version: 3 });
    });

    test("aborts migration-owned rows child-first and restores exact local counters", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-abort", 1);
        applyAll(source, destination);

        const kinds: string[] = [];
        for (let page = 0; page < 10; page++) {
            const result = destination.transaction(() => destination.dest?.abort(IDENTITY, 1));
            if (!result) throw new Error("destination abort returned no result");
            kinds.push(result.next.kind);
            if (result.done) break;
        }
        expect(kinds).toEqual(["attempt", "outbox", "outbox", "head", "head", "done", "done", "done"]);
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vector_attempts")).toEqual(
            {
                count: 0,
            }
        );
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vector_outbox")).toEqual({
            count: 0,
        });
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vectors")).toEqual({
            count: 0,
        });
        expect(destination.sql.one("SELECT * FROM _chardb_vector_capacity WHERE singleton = 1")).toMatchObject({
            head_count: 0,
            stored_bytes: 0,
            outbox_rows: 0,
            attempt_rows: 0,
        });
        expect(destination.transaction(() => destination.dest?.abort(IDENTITY))).toMatchObject({
            done: true,
            deleted: 0,
        });
    });

    test("abort rolls back a page when an owned physical image drifted", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-abort-drift", 1);
        applyAll(source, destination);
        destination.transaction(() => destination.dest?.abort(IDENTITY, 500));
        destination.transaction(() => destination.dest?.abort(IDENTITY, 500));
        destination.sql.exec(
            "UPDATE _chardb_vectors SET metadata_json = '{\"drift\":true}' WHERE vector_id = 'vec-abort-drift'"
        );
        expect(() => destination.transaction(() => destination.dest?.abort(IDENTITY, 500))).toThrow(
            "changed after migration apply"
        );
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vectors")).toEqual({
            count: 1,
        });
        expect(destination.provenance?.counts(IDENTITY)).toEqual({ records: 1, receipts: 0 });
    });

    test("prunes acknowledged tail receipts in bounded pages and admits later history", () => {
        const destination = database("dest");
        databases.push(destination.db);
        destination.transaction(() => destination.dest?.begin(IDENTITY, 0));
        destination.transaction(() => {
            for (let lsn = 1; lsn <= 1_201; lsn++) {
                destination.provenance?.recordReceipt(IDENTITY, {
                    lsn,
                    tableName: "_chardb_vectors",
                    fingerprint: lsn.toString(16).padStart(64, "0"),
                });
            }
        });
        expect(destination.provenance?.counts(IDENTITY)).toEqual({ records: 0, receipts: 1_201 });
        expect(destination.transaction(() => destination.provenance?.pruneReceipts(IDENTITY, 1_000, 500))).toEqual({
            pruned: 500,
        });
        expect(destination.transaction(() => destination.provenance?.pruneReceipts(IDENTITY, 1_000, 500))).toEqual({
            pruned: 500,
        });
        expect(destination.transaction(() => destination.provenance?.pruneReceipts(IDENTITY, 1_000, 500))).toEqual({
            pruned: 0,
        });
        destination.transaction(() =>
            destination.provenance?.recordReceipt(IDENTITY, {
                lsn: 1_202,
                tableName: "_chardb_vectors",
                fingerprint: "f".repeat(64),
            })
        );
        expect(destination.provenance?.counts(IDENTITY)).toEqual({ records: 0, receipts: 202 });
        expect(
            destination.provenance?.hasReceipt(IDENTITY, {
                lsn: 1_001,
                tableName: "_chardb_vectors",
                fingerprint: (1_001).toString(16).padStart(64, "0"),
            })
        ).toBe(true);
    });

    test("compacts tombstones only behind both the snapshot-key and acknowledged-tail frontiers", () => {
        const destination = database("dest");
        databases.push(destination.db);
        destination.transaction(() => destination.dest?.begin(IDENTITY, 0));
        destination.transaction(() => {
            for (const [vectorId, placementVshard, lsn] of [
                ["a", 1, 10],
                ["b", 2, 20],
                ["c", 3, 30],
            ] as const) {
                destination.provenance?.recordTail(IDENTITY, {
                    kind: "head",
                    vectorId,
                    physicalVersion: 0,
                    placementVshard,
                    lsn,
                    present: false,
                    inserted: true,
                    imageFingerprint: null,
                });
            }
        });
        const throughB: CdbVectorReshardCursor = {
            kind: "head",
            throughHeadSeq: 0,
            afterPlacement: 2,
            afterVectorId: "b",
            afterPhysicalVersion: 0,
        };
        expect(
            destination.transaction(() =>
                destination.provenance?.compactTombstones(IDENTITY, {
                    snapshotCursor: throughB,
                    acknowledgedThroughLsn: 15,
                })
            )
        ).toEqual({ compacted: 1 });
        expect(destination.provenance?.counts(IDENTITY)).toEqual({ records: 2, receipts: 0 });
        expect(
            destination.transaction(() =>
                destination.provenance?.compactTombstones(IDENTITY, {
                    snapshotCursor: throughB,
                    acknowledgedThroughLsn: 25,
                })
            )
        ).toEqual({ compacted: 1 });
        expect(
            destination.provenance?.read(IDENTITY, { kind: "head", vectorId: "c", physicalVersion: 0 })
        ).not.toBeNull();
        expect(
            destination.transaction(() =>
                destination.provenance?.compactTombstones(IDENTITY, {
                    snapshotCursor: { ...throughB, kind: "done", afterPlacement: -1, afterVectorId: "" },
                    acknowledgedThroughLsn: 100,
                })
            )
        ).toEqual({ compacted: 1 });
        expect(destination.provenance?.counts(IDENTITY)).toEqual({ records: 0, receipts: 0 });
    });

    test("authenticates omitted preexisting rows with exact page intervals and watermarks", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        const cursor = source.reader.begin(IDENTITY);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));
        applyAllFromCursor(source, destination, cursor, 7);
        for (const [kind, physicalVersion] of [
            ["head", 0],
            ["outbox", 0],
            ["attempt", 1],
        ] as const) {
            expect(
                destination.provenance?.coversSnapshotAbsence(IDENTITY, {
                    kind,
                    vectorId: "missing-before-scan",
                    physicalVersion,
                    placementVshard: 42,
                    lsn: 7,
                })
            ).toBe(true);
            expect(
                destination.provenance?.coversSnapshotAbsence(IDENTITY, {
                    kind,
                    vectorId: "missing-before-scan",
                    physicalVersion,
                    placementVshard: 42,
                    lsn: 8,
                })
            ).toBe(false);
        }
    });

    test("replays an exact parity page after cold reconstruction and rejects changed retries", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-parity-replay", 1);
        applyAll(source, destination);
        const cursor = CDB_VECTOR_RESHARD_PARITY_START_CURSOR;
        const page = source.reader.read(IDENTITY, cursor);
        const request = {
            pageNumber: 0,
            cursor,
            encodedSourcePage: encodeCdbVectorReshardPage(page),
            throughLsn: 10,
        };
        const first = destination.transaction(() => destination.dest?.verifyParityPage(IDENTITY, request));
        if (!first) throw new Error("first parity result is missing");
        const reconstructed = new CdbVectorReshardDestStore(destination.sql);
        expect(destination.transaction(() => reconstructed.verifyParityPage(IDENTITY, request))).toEqual(first);
        expect(() =>
            destination.transaction(() => reconstructed.verifyParityPage(IDENTITY, { ...request, throughLsn: 11 }))
        ).toThrow("duplicate parity page changed its identity");
        const decoded = decodeCdbVectorReshardPage(request.encodedSourcePage);
        const head = decoded.records[0];
        if (!head || head.kind !== "head") throw new Error("parity replay fixture has no head");
        const changed = encodeCdbVectorReshardPage({
            ...decoded,
            records: [{ ...head, metadataJson: '{"changed":true}' }],
        });
        expect(() =>
            destination.transaction(() =>
                reconstructed.verifyParityPage(IDENTITY, { ...request, encodedSourcePage: changed })
            )
        ).toThrow("duplicate parity page changed its identity");
    });

    test("replays one page after reconstruction and rejects conflicts or stale predecessors", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-replay", 1);
        const cursor = source.reader.begin(IDENTITY);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));
        const headPage = source.reader.read(IDENTITY, cursor);
        const first = {
            pageNumber: 0,
            cursor,
            encodedPage: encodeCdbVectorReshardPage(headPage),
            throughLsn: 1,
        };
        const firstResult = destination.transaction(() => destination.dest?.apply(IDENTITY, first));
        if (!firstResult) throw new Error("destination fixture returned no first-page result");
        const reconstructed = new CdbVectorReshardDestStore(destination.sql);

        expect(destination.transaction(() => reconstructed.apply(IDENTITY, first))).toEqual({
            ...firstResult,
            replayed: true,
        });
        const decoded = decodeCdbVectorReshardPage(first.encodedPage);
        const head = decoded.records[0];
        if (!head || head.kind !== "head") throw new Error("first page is not a head page");
        const changed = encodeCdbVectorReshardPage({
            ...decoded,
            records: [{ ...head, metadataJson: '{"changed":true}' }],
        });
        expect(() =>
            destination.transaction(() => reconstructed.apply(IDENTITY, { ...first, encodedPage: changed }))
        ).toThrow("duplicate page changed its encoded body");
        expect(() =>
            destination.transaction(() => reconstructed.apply(IDENTITY, { ...first, throughLsn: 99 }))
        ).toThrow("duplicate page changed its tail watermark");
        expect(() =>
            destination.transaction(() =>
                reconstructed.apply(IDENTITY, {
                    ...first,
                    cursor: { ...first.cursor, afterPlacement: 0, afterVectorId: "vec-before" },
                })
            )
        ).toThrow("duplicate page changed its input cursor");

        const outboxPage = source.reader.read(IDENTITY, headPage.next);
        destination.transaction(() =>
            reconstructed.apply(IDENTITY, {
                pageNumber: 1,
                cursor: headPage.next,
                encodedPage: encodeCdbVectorReshardPage(outboxPage),
                throughLsn: 2,
            })
        );
        expect(() => destination.transaction(() => reconstructed.apply(IDENTITY, first))).toThrow(
            "page number is not the next expected page"
        );
    });

    test("requires the exact page number, cursor, nonregressing watermark, and destination identity", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-order", 1);
        const cursor = source.reader.begin(IDENTITY);
        const page = source.reader.read(IDENTITY, cursor);
        const encodedPage = encodeCdbVectorReshardPage(page);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));

        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, { pageNumber: 1, cursor, encodedPage, throughLsn: 1 })
            )
        ).toThrow("page number is not the next expected page");
        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 0,
                    cursor: { ...cursor, kind: "outbox" },
                    encodedPage,
                    throughLsn: 1,
                })
            )
        ).toThrow("page cursor is not the next expected cursor");
        destination.transaction(() =>
            destination.dest?.apply(IDENTITY, { pageNumber: 0, cursor, encodedPage, throughLsn: 10 })
        );
        const next = source.reader.read(IDENTITY, page.next);
        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 1,
                    cursor: page.next,
                    encodedPage: encodeCdbVectorReshardPage(next),
                    throughLsn: 9,
                })
            )
        ).toThrow("snapshot tail watermark regressed");
        expect(() =>
            destination.dest?.readParityPage({ ...IDENTITY, rangeHi: 100 }, CDB_VECTOR_RESHARD_PARITY_START_CURSOR)
        ).toThrow("does not match its bound dest identity");
    });

    test("a newer tail tombstone blocks stale head and child resurrection", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-deleted", 1);
        const cursor = source.reader.begin(IDENTITY);
        destination.transaction(() => {
            destination.dest?.begin(IDENTITY, cursor.throughHeadSeq);
            destination.provenance?.recordTail(IDENTITY, {
                kind: "head",
                vectorId: "vec-deleted",
                physicalVersion: 0,
                placementVshard: 0,
                lsn: 50,
                present: false,
                inserted: true,
                imageFingerprint: null,
            });
        });

        const pages = applyAllFromCursor(source, destination, cursor, 10);
        expect(pages.reduce((sum, result) => sum + result.skipped, 0)).toBe(3);
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vectors")).toEqual({
            count: 0,
        });
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vector_outbox")).toEqual({
            count: 0,
        });
        expect(destination.sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_vector_attempts")).toEqual(
            {
                count: 0,
            }
        );
    });

    test("rejects changed same-lsn tail provenance and corrupt durable cursors", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-corrupt", 1);
        const cursor = source.reader.begin(IDENTITY);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));
        const head = source.reader.read(IDENTITY, cursor).records[0];
        if (!head) throw new Error("head fixture is absent");
        const fingerprint = cdbVectorReshardSnapshotRecordFingerprint(head);
        destination.transaction(() =>
            destination.provenance?.recordTail(IDENTITY, {
                kind: "head",
                vectorId: head.vectorId,
                physicalVersion: 0,
                placementVshard: head.placementVshard,
                lsn: 1,
                present: true,
                inserted: true,
                imageFingerprint: fingerprint,
            })
        );
        expect(() =>
            destination.transaction(() =>
                destination.provenance?.recordTail(IDENTITY, {
                    kind: "head",
                    vectorId: head.vectorId,
                    physicalVersion: 0,
                    placementVshard: head.placementVshard,
                    lsn: 1,
                    present: false,
                    inserted: true,
                    imageFingerprint: null,
                })
            )
        ).toThrow("tail provenance retry changed its record image");

        destination.sql.exec(
            "UPDATE _chardb_vector_reshard_dest_sessions SET expected_cursor_json = ? WHERE mig_id = ?",
            '{"kind":"head","unknown":true}',
            IDENTITY.migId
        );
        expect(() => new CdbVectorReshardDestStore(destination.sql).begin(IDENTITY, cursor.throughHeadSeq)).toThrow(
            "page cursor has an unknown field"
        );
    });

    test("requires canonical page bytes and cleanup releases the only replay body", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        const cursor = source.reader.begin(IDENTITY);
        const terminal = source.reader.read(IDENTITY, cursor);
        const encodedPage = encodeCdbVectorReshardPage(terminal);
        destination.transaction(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq));
        expect(() =>
            destination.transaction(() =>
                destination.dest?.apply(IDENTITY, {
                    pageNumber: 0,
                    cursor,
                    encodedPage: `${encodedPage}\n`,
                    throughLsn: 0,
                })
            )
        ).toThrow("page encoding is not canonical");
        applyAllFromCursor(source, destination, cursor, 0);
        expect(() => destination.transaction(() => destination.dest?.cleanup(IDENTITY))).toThrow(
            "destination movement is not finalized"
        );
        verifyAllParity(source, destination, 0);
        expect(() => destination.transaction(() => destination.dest?.finalize(IDENTITY, 1))).toThrow(
            "no matching terminal parity receipt"
        );
        expect(destination.transaction(() => destination.dest?.finalize(IDENTITY, 0))).toEqual({ finalized: true });
        expect(destination.transaction(() => destination.dest?.cleanup(IDENTITY))).toEqual({ cleaned: true });
        expect(destination.transaction(() => destination.dest?.cleanup(IDENTITY))).toEqual({ cleaned: false });
        expect(
            destination.sql.one<{ last_page_enc: string | null; cleaned: number }>(
                "SELECT last_page_enc, cleaned FROM _chardb_vector_reshard_dest_sessions WHERE mig_id = ?",
                IDENTITY.migId
            )
        ).toEqual({ last_page_enc: null, cleaned: 1 });
        expect(
            destination.sql.one<{ outcome: string; record_count: number; receipt_count: number }>(
                `SELECT outcome, record_count, receipt_count
                 FROM _chardb_vector_reshard_provenance_identity WHERE mig_id = ?`,
                IDENTITY.migId
            )
        ).toEqual({ outcome: "cleaned", record_count: 0, receipt_count: 0 });
        expect(() => destination.dest?.begin(IDENTITY, cursor.throughHeadSeq)).toThrow("session was cleaned");
    });

    test("reconstruction validates every cached identity, result, successor, and terminal field", () => {
        const source = database("source");
        const destination = database("dest");
        databases.push(source.db, destination.db);
        stage(source, "vec-stored-corruption", 1);
        const cursor = source.reader.begin(IDENTITY);
        const page = source.reader.read(IDENTITY, cursor);
        const encodedPage = encodeCdbVectorReshardPage(page);
        destination.transaction(() => {
            destination.dest?.begin(IDENTITY, cursor.throughHeadSeq);
            destination.dest?.apply(IDENTITY, { pageNumber: 0, cursor, encodedPage, throughLsn: 7 });
        });
        const reconstruct = () => new CdbVectorReshardDestStore(destination.sql).begin(IDENTITY, cursor.throughHeadSeq);
        const update = (sql: string, ...params: unknown[]) =>
            destination.sql.exec(`${sql} WHERE mig_id = ?`, ...(params as never[]), IDENTITY.migId);

        update("UPDATE _chardb_vector_reshard_dest_sessions SET last_page_digest = ?", "b".repeat(64));
        expect(reconstruct).toThrow("cached destination page identity is invalid");
        update("UPDATE _chardb_vector_reshard_dest_sessions SET last_page_digest = ?", sha256Hex(encodedPage));

        update("UPDATE _chardb_vector_reshard_dest_sessions SET last_applied = 2");
        expect(reconstruct).toThrow("result counters do not match");
        update("UPDATE _chardb_vector_reshard_dest_sessions SET last_applied = 1");

        update("UPDATE _chardb_vector_reshard_dest_sessions SET expected_cursor_json = ?", JSON.stringify(cursor));
        expect(reconstruct).toThrow("successor does not match");
        update("UPDATE _chardb_vector_reshard_dest_sessions SET expected_cursor_json = ?", JSON.stringify(page.next));

        update("UPDATE _chardb_vector_reshard_dest_sessions SET terminal = 1");
        expect(reconstruct).toThrow("successor does not match");
        update("UPDATE _chardb_vector_reshard_dest_sessions SET terminal = 0");

        const noncanonical = `${encodedPage}\n`;
        update(
            "UPDATE _chardb_vector_reshard_dest_sessions SET last_page_enc = ?, last_page_digest = ?",
            noncanonical,
            sha256Hex(noncanonical)
        );
        expect(reconstruct).toThrow("cached page encoding is not canonical");
        update(
            "UPDATE _chardb_vector_reshard_dest_sessions SET last_page_enc = ?, last_page_digest = ?",
            encodedPage,
            sha256Hex(encodedPage)
        );

        update(
            "UPDATE _chardb_vector_reshard_dest_sessions SET last_input_cursor_json = ?",
            JSON.stringify(cursor, null, 1)
        );
        expect(reconstruct).toThrow("cached input cursor is not canonical");
    });

    test("rebuilds empty legacy transfer tables but rejects active incompatible movements", () => {
        const empty = new Database(":memory:");
        databases.push(empty);
        const emptySql = syncSql(empty);
        empty.exec(`
          CREATE TABLE _chardb_vector_reshard_provenance_identity (
            mig_id TEXT PRIMARY KEY, range_lo INTEGER, range_hi INTEGER, outcome TEXT,
            record_count INTEGER, receipt_count INTEGER
          );
          CREATE TABLE _chardb_split_vector_applied (
            mig_id TEXT, record_kind TEXT, vector_id TEXT, physical_version INTEGER,
            snapshot_through_lsn INTEGER, latest_tail_lsn INTEGER, present INTEGER,
            inserted INTEGER, image_fingerprint TEXT
          );
          CREATE TABLE _chardb_vector_reshard_dest_sessions (mig_id TEXT PRIMARY KEY);
        `);
        initializeCdbVectorReshardDestStore(emptySql);
        expect(
            empty
                .query("PRAGMA table_info('_chardb_vector_reshard_provenance_identity')")
                .all()
                .map(row => (row as { name: string }).name)
        ).toContain("interval_count");
        expect(
            empty
                .query("PRAGMA table_info('_chardb_vector_reshard_dest_sessions')")
                .all()
                .map(row => (row as { name: string }).name)
        ).toContain("parity_last_page_digest");

        const active = new Database(":memory:");
        databases.push(active);
        const activeSql = syncSql(active);
        active.exec(`
          CREATE TABLE _chardb_vector_reshard_provenance_identity (
            mig_id TEXT PRIMARY KEY, range_lo INTEGER, range_hi INTEGER, outcome TEXT,
            record_count INTEGER, receipt_count INTEGER
          );
          CREATE TABLE _chardb_split_vector_applied (
            mig_id TEXT, record_kind TEXT, vector_id TEXT, physical_version INTEGER,
            snapshot_through_lsn INTEGER, latest_tail_lsn INTEGER, present INTEGER,
            inserted INTEGER, image_fingerprint TEXT
          );
          INSERT INTO _chardb_vector_reshard_provenance_identity
            VALUES ('active-old', 0, 16383, 'active', 0, 0);
        `);
        expect(() => initializeCdbVectorReshardProvenance(activeSql)).toThrow(
            "schema is incompatible with an active movement"
        );

        const activeDest = new Database(":memory:");
        databases.push(activeDest);
        const activeDestSql = syncSql(activeDest);
        initializeCdbVectorReshardProvenance(activeDestSql);
        activeDest.exec(`
          CREATE TABLE _chardb_vector_reshard_dest_sessions (mig_id TEXT PRIMARY KEY);
          INSERT INTO _chardb_vector_reshard_dest_sessions VALUES ('active-old-dest');
        `);
        expect(() => initializeCdbVectorReshardDestStore(activeDestSql)).toThrow(
            "destination session schema is incompatible with an active movement"
        );
    });
});

function applyAllFromCursor(
    source: ReturnType<typeof database>,
    destination: ReturnType<typeof database>,
    initial: CdbVectorReshardCursor,
    throughLsn: number
) {
    if (!destination.dest) throw new Error("destination fixture is missing its store");
    let cursor = initial;
    const results = [];
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = source.reader.read(IDENTITY, cursor);
        const result = destination.transaction(() =>
            destination.dest?.apply(IDENTITY, {
                pageNumber,
                cursor,
                encodedPage: encodeCdbVectorReshardPage(page),
                throughLsn,
            })
        );
        if (!result) throw new Error("destination apply returned no result");
        results.push(result);
        if (page.done) return results;
        cursor = page.next;
    }
    throw new Error("vector destination fixture did not finish");
}

function verifyAllParity(
    source: ReturnType<typeof database>,
    destination: ReturnType<typeof database>,
    throughLsn: number
): void {
    if (!destination.dest) throw new Error("destination fixture is missing its store");
    let cursor: CdbVectorReshardCursor = CDB_VECTOR_RESHARD_PARITY_START_CURSOR;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = source.reader.read(IDENTITY, cursor);
        const result = destination.transaction(() =>
            destination.dest?.verifyParityPage(IDENTITY, {
                pageNumber,
                cursor,
                encodedSourcePage: encodeCdbVectorReshardPage(page),
                throughLsn,
            })
        );
        if (!result) throw new Error("destination parity returned no result");
        if (result.done) return;
        cursor = result.next;
    }
    throw new Error("vector destination parity did not finish");
}
