import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { TableSpec } from "../../src/reshard/triggers.ts";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { CdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import { decodeCdbVectorReshardPage } from "../../src/server/do/cdb-vector-reshard-records.ts";
import { Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import { defineMigrations } from "../../src/server/schema-migrations.ts";
import { renderVectorReshardTriggers } from "../../src/server/vector-reshard-triggers.ts";
import { stableJson } from "../../src/util/canonical.ts";
import { vector } from "../../src/vector.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

function construct(CdbClass: typeof Cdb, db: Database): { readonly cdb: Cdb; readonly ready: Promise<unknown> } {
    let ready: Promise<unknown> = Promise.resolve();
    const state = {
        id: { toString: () => "vector-source-shard" },
        storage: {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            setAlarm: async (): Promise<void> => {},
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    return { cdb: new CdbClass(state, {}), ready };
}

const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const { cdbTable } = forOrg();
const messages = cdbTable(
    "vector_source_messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        embedding: vector("embedding", { dim: 3, binding: "CDB_MESSAGES", metric: "cosine" }),
    },
    { roles: { member: { read: "*" } } }
);
const JOURNAL = defineMigrations([]);
const TABLES: readonly TableSpec[] = Object.freeze([
    Object.freeze({
        name: "vector_source_messages",
        partitionColumn: "organization_id",
        columns: Object.freeze(["id", "organization_id", "embedding"]),
    }),
]);
const IDENTITY = Object.freeze({
    migId: "vector-source-move",
    rangeLo: 0,
    rangeHi: 16_383,
    schemaVersion: 0,
    schemaEpoch: 1,
    schemaDigest: JOURNAL.digest,
    tables: TABLES,
});
const ConfiguredCdb = configureCdbRuntime({
    schema: () => ({ messages }),
    manifest: () => manifestFromExports({}),
});

function bindSource(db: Database): void {
    db.run(
        `INSERT INTO _chardb_split_identity
           (mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json, created_at)
         VALUES (?, ?, ?, 'source', ?, ?, ?, ?, 0)`,
        [
            IDENTITY.migId,
            IDENTITY.rangeLo,
            IDENTITY.rangeHi,
            IDENTITY.schemaVersion,
            IDENTITY.schemaEpoch,
            IDENTITY.schemaDigest,
            stableJson(TABLES),
        ]
    );
    db.run(
        `INSERT INTO _chardb_split_state
           (mig_id, range_lo, range_hi, role, capture, bulk_done, applied_lsn, acked_lsn, drained, updated_at)
         VALUES (?, ?, ?, 'source', 1, 0, 0, 0, 0, 0)`,
        [IDENTITY.migId, IDENTITY.rangeLo, IDENTITY.rangeHi]
    );
}

function stage(db: Database, vectorId: string): void {
    new CdbVectorOutboxStore(adaptSqlStorage(sqlStorage(db) as never)).stageUpsert({
        vectorId,
        organizationId: `org-${vectorId}`,
        resourceId: "resource-vector-source",
        rowPk: `row-${vectorId}`,
        dimensions: 3,
        values: [1, 2, 3],
        metadata: { vectorId },
        nowMs: 1,
    });
}

async function setup() {
    const db = new Database(":memory:");
    const target = construct(ConfiguredCdb, db);
    await target.ready;
    bindSource(db);
    return { db, cdb: target.cdb };
}

describe("Cdb vector reshard source lifecycle", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("bootstraps sessions only for vector schemas and reports absence explicitly", async () => {
        const vectorDb = new Database(":memory:");
        databases.push(vectorDb);
        const vectorTarget = construct(ConfiguredCdb, vectorDb);
        await vectorTarget.ready;
        expect(
            vectorDb
                .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get("_chardb_vector_snapshot_sessions")
        ).toEqual({ name: "_chardb_vector_snapshot_sessions" });

        const plainDb = new Database(":memory:");
        databases.push(plainDb);
        const plainTarget = construct(Cdb, plainDb);
        await plainTarget.ready;
        expect(
            plainDb
                .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get("_chardb_vector_snapshot_sessions")
        ).toBeNull();
        expect(plainTarget.cdb.beginReshardVectorSource({} as never)).toEqual({
            enabled: false,
            triggersInstalled: 0,
            snapshot: null,
        });
        expect(plainTarget.cdb.inspectReshardVectorSnapshot({} as never)).toEqual({ enabled: false, snapshot: null });
        expect(plainTarget.cdb.readReshardVectorSnapshot({} as never)).toEqual({ enabled: false, page: null });
        expect(plainTarget.cdb.stopReshardVectorSource({} as never)).toEqual({
            enabled: false,
            stopped: false,
            triggersUninstalled: 0,
        });
        expect(plainTarget.cdb.abortReshardVectors({} as never)).toEqual({
            enabled: false,
            cleaned: false,
            done: true,
            triggersUninstalled: 0,
        });
        expect(plainTarget.cdb.finishReshardVectors({} as never)).toEqual({
            enabled: false,
            cleaned: false,
            done: true,
            triggersUninstalled: 0,
        });
    });

    test("re-enters capture and replays the cached page and watermark after cold reconstruction", async () => {
        const target = await setup();
        databases.push(target.db);
        stage(target.db, "vec-replay");

        const begun = target.cdb.beginReshardVectorSource(IDENTITY);
        expect(begun).toMatchObject({ enabled: true, triggersInstalled: 9 });
        if (!begun.enabled) throw new Error("vector source fixture is disabled");
        const first = target.cdb.readReshardVectorSnapshot({ ...IDENTITY, ...begun.snapshot.next });
        if (!first.enabled) throw new Error("vector source fixture is disabled");
        target.db.run(
            `INSERT INTO _chardb_split_log
               (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (-1, ?, 'upd', '_chardb_vectors', 'vec-replay', '{}', '{}', 2)`,
            [IDENTITY.migId]
        );

        const cold = construct(ConfiguredCdb, target.db);
        await cold.ready;
        const reentered = cold.cdb.beginReshardVectorSource(IDENTITY);
        expect(reentered).toMatchObject({ enabled: true, triggersInstalled: 9 });
        const replay = cold.cdb.readReshardVectorSnapshot({ ...IDENTITY, ...begun.snapshot.next });
        expect(replay).toEqual(first);
        if (!replay.enabled) throw new Error("vector source fixture is disabled");
        expect(replay.page.throughLsn).toBe(0);
        expect(
            decodeCdbVectorReshardPage(replay.page.encodedPage).records.some(row => row.vectorId === "vec-replay")
        ).toBeTrue();
        expect(cold.cdb.inspectReshardVectorSnapshot(IDENTITY)).toMatchObject({
            enabled: true,
            snapshot: { cached: begun.snapshot.next },
        });
        expect(
            target.db
                .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name GLOB ?")
                .get("_chardb_vectorcapt_*")
        ).toEqual({ count: 9 });
    });

    test("stops only after snapshot and generic tail convergence, then cleans up idempotently", async () => {
        const target = await setup();
        databases.push(target.db);
        stage(target.db, "vec-stop");
        const begun = target.cdb.beginReshardVectorSource(IDENTITY);
        if (!begun.enabled) throw new Error("vector source fixture is disabled");
        let request = begun.snapshot.next;
        let done = false;
        for (let pageNumber = 0; pageNumber < 4 && !done; pageNumber++) {
            const page = target.cdb.readReshardVectorSnapshot({ ...IDENTITY, ...request });
            if (!page.enabled) throw new Error("vector source fixture is disabled");
            done = decodeCdbVectorReshardPage(page.page.encodedPage).done;
            if (!done) {
                const inspected = target.cdb.inspectReshardVectorSnapshot(IDENTITY);
                if (!inspected.enabled) throw new Error("vector source fixture is disabled");
                request = inspected.snapshot.next;
            }
        }
        expect(done).toBeTrue();

        expect(() => target.cdb.stopReshardVectorSource(IDENTITY)).toThrow(/not in its frozen vector source phase/);
        target.db.run(
            `INSERT INTO _chardb_split_log
               (source_tx_id, mig_id, op, table_name, pk, before, after, ts)
             VALUES (-1, ?, 'upd', '_chardb_vectors', 'vec-stop', '{}', '{}', 2)`,
            [IDENTITY.migId]
        );
        target.db.run("UPDATE _chardb_split_state SET capture = 0, drain_started = 1 WHERE mig_id = ?", [
            IDENTITY.migId,
        ]);
        expect(() => target.cdb.stopReshardVectorSource(IDENTITY)).toThrow(/tail must converge/);
        target.db.run("UPDATE _chardb_split_state SET acked_lsn = 1 WHERE mig_id = ?", [IDENTITY.migId]);

        expect(target.cdb.stopReshardVectorSource(IDENTITY)).toEqual({
            enabled: true,
            stopped: true,
            triggersUninstalled: 9,
        });
        expect(target.cdb.stopReshardVectorSource(IDENTITY)).toEqual({
            enabled: true,
            stopped: false,
            triggersUninstalled: 0,
        });
        expect(target.db.query("SELECT capture, drain_started, drained FROM _chardb_split_state").get()).toEqual({
            capture: 0,
            drain_started: 1,
            drained: 0,
        });
        expect(() => target.cdb.finishReshardVectors(IDENTITY)).toThrow(/not in its drained vector source phase/);
        target.db.run("UPDATE _chardb_split_state SET drained = 1 WHERE mig_id = ?", [IDENTITY.migId]);
        expect(target.cdb.finishReshardVectors(IDENTITY)).toEqual({
            enabled: true,
            cleaned: true,
            done: true,
            triggersUninstalled: 0,
        });
        expect(target.cdb.finishReshardVectors(IDENTITY)).toEqual({
            enabled: true,
            cleaned: false,
            done: true,
            triggersUninstalled: 0,
        });
        expect(target.cdb.abortReshardVectors(IDENTITY)).toEqual({
            enabled: true,
            cleaned: false,
            done: true,
            triggersUninstalled: 0,
        });
        expect(
            target.db
                .query("SELECT cached_page_enc, cached_through_lsn, cleaned FROM _chardb_vector_snapshot_sessions")
                .get()
        ).toEqual({ cached_page_enc: null, cached_through_lsn: null, cleaned: 1 });
    });

    test("aborts an incomplete source session without changing its drained routing state", async () => {
        const target = await setup();
        databases.push(target.db);
        stage(target.db, "vec-abort");
        const begun = target.cdb.beginReshardVectorSource(IDENTITY);
        if (!begun.enabled) throw new Error("vector source fixture is disabled");
        const page = target.cdb.readReshardVectorSnapshot({ ...IDENTITY, ...begun.snapshot.next });
        if (!page.enabled) throw new Error("vector source fixture is disabled");
        expect(decodeCdbVectorReshardPage(page.page.encodedPage).done).toBeFalse();
        target.db.run("UPDATE _chardb_split_state SET capture = 0, drained = 1 WHERE mig_id = ?", [IDENTITY.migId]);

        expect(target.cdb.abortReshardVectors(IDENTITY)).toEqual({
            enabled: true,
            cleaned: true,
            done: true,
            triggersUninstalled: 9,
        });
        expect(target.cdb.abortReshardVectors(IDENTITY)).toEqual({
            enabled: true,
            cleaned: false,
            done: true,
            triggersUninstalled: 0,
        });
        expect(target.db.query("SELECT capture, drain_started, drained FROM _chardb_split_state").get()).toEqual({
            capture: 0,
            drain_started: 0,
            drained: 1,
        });
    });

    test("fails closed on wrong schema, identity, source state, and vector foreign keys", async () => {
        const target = await setup();
        databases.push(target.db);
        expect(() => target.cdb.beginReshardVectorSource({ ...IDENTITY, schemaEpoch: 2 })).toThrow(
            /schema identity does not match/
        );
        expect(() => target.cdb.beginReshardVectorSource({ ...IDENTITY, rangeHi: 1 })).toThrow(
            /bound vector source identity/
        );
        expect(() =>
            target.cdb.beginReshardVectorSource({
                ...IDENTITY,
                tables: [
                    {
                        name: "vector_source_messages",
                        partitionColumn: "organization_id",
                        columns: ["id", "organization_id"],
                    },
                ],
            })
        ).toThrow(/bound vector source identity/);
        target.db.run("UPDATE _chardb_split_state SET role = 'dest' WHERE mig_id = ?", [IDENTITY.migId]);
        expect(() => target.cdb.beginReshardVectorSource(IDENTITY)).toThrow(/capturing vector source phase/);
        target.db.run("UPDATE _chardb_split_state SET role = 'source' WHERE mig_id = ?", [IDENTITY.migId]);

        target.db.exec("PRAGMA foreign_keys = OFF");
        expect(() => target.cdb.beginReshardVectorSource(IDENTITY)).toThrow(/vector capture requires foreign keys/);
        expect(
            target.db
                .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name GLOB ?")
                .get("_chardb_vectorcapt_*")
        ).toEqual({ count: 0 });
        expect(target.db.query("SELECT COUNT(*) AS count FROM _chardb_vector_snapshot_sessions").get()).toEqual({
            count: 0,
        });
        target.db.exec("PRAGMA foreign_keys = ON");

        target.db.exec("DROP TABLE _chardb_vector_outbox");
        target.db.exec(
            `CREATE TABLE _chardb_vector_outbox (
               vector_id TEXT PRIMARY KEY REFERENCES _chardb_vectors(vector_id) ON DELETE RESTRICT
             )`
        );
        expect(() => target.cdb.beginReshardVectorSource(IDENTITY)).toThrow(
            /vector outbox capture foreign key differs/
        );
        expect(renderVectorReshardTriggers(IDENTITY.migId).names).toHaveLength(9);
    });
});
