import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { blob, integer, text } from "drizzle-orm/sqlite-core";
import {
    CDB_RESHARD_IDENTITY_STORE_DDL,
    CDB_SPLIT_IDENTITY_LIMIT,
    CdbReshardIdentityStore,
    assertCdbReshardRangeIdentity,
    assertCdbSplitHistoryCapacity,
    canonicalRegisteredTableSpecs,
} from "../../src/server/do/cdb-reshard-identity-store.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { defineMigrations } from "../../src/server/schema-migrations.ts";
import { stableJson } from "../../src/util/canonical.ts";
import { globalScope } from "../helpers/cdb-table.ts";

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

const { cdbTable } = globalScope();
const messages = cdbTable(
    "messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id").notNull(),
        body: text("body").notNull(),
    },
    { partitionBy: "organizationId" }
);
const counters = cdbTable(
    "counters",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id").notNull(),
        value: integer("value").notNull(),
    },
    { partitionBy: "organizationId" }
);
const settings = cdbTable(
    "settings",
    { id: text("id").primaryKey(), value: text("value").notNull() },
    { partitionBy: "replicated" }
);
const binaryRows = cdbTable(
    "binary_rows",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id").notNull(),
        payload: blob("payload").notNull(),
    },
    { partitionBy: "organizationId" }
);
const schema = { messages, counters };
const journal = defineMigrations([]);
const activeState = {
    activeVersion: 0,
    activeEpoch: 1,
    activeDigest: journal.digest,
    lastMigrationId: null,
    status: "active" as const,
    migrationId: null,
    targetVersion: null,
    targetEpoch: null,
    targetDigest: null,
};
const messageSpec = {
    name: "messages",
    partitionColumn: "organization_id",
    columns: ["id", "organization_id", "body"],
} as const;
const counterSpec = {
    name: "counters",
    partitionColumn: "organization_id",
    columns: ["id", "organization_id", "value"],
} as const;

describe("Cdb reshard identity store", () => {
    let db: Database;

    afterEach(() => db?.close());

    function store(): CdbReshardIdentityStore {
        db = new Database(":memory:");
        db.exec(CDB_RESHARD_IDENTITY_STORE_DDL);
        return new CdbReshardIdentityStore(adaptSqlStorage(sqlStorage(db) as never));
    }

    test("canonicalizes only exact movable registered table specs", () => {
        expect(canonicalRegisteredTableSpecs(schema, [messageSpec, counterSpec])).toEqual({
            tables: [counterSpec, messageSpec],
            json: stableJson([counterSpec, messageSpec]),
        });
        for (const bad of [
            [{ ...messageSpec, name: "_chardb_op_log" }],
            [{ ...messageSpec, name: "unregistered" }],
            [{ ...messageSpec, partitionColumn: "id" }],
            [{ ...messageSpec, columns: ["id", "body", "organization_id"] }],
            [
                {
                    name: "settings",
                    partitionColumn: "id",
                    columns: ["id", "value"],
                },
            ],
        ]) {
            expect(() => canonicalRegisteredTableSpecs(schema, bad)).toThrow();
        }
        expect(() =>
            canonicalRegisteredTableSpecs({ binaryRows }, [
                {
                    name: "binary_rows",
                    partitionColumn: "organization_id",
                    columns: ["id", "organization_id", "payload"],
                },
            ])
        ).toThrow("uses BLOB storage");
        expect(() =>
            canonicalRegisteredTableSpecs({ messages, counters, settings }, [messageSpec, counterSpec])
        ).toThrow("replicated table settings has no online reshard transfer protocol");
    });

    test("validates the earliest ownership identity and rejects the exact history limit", () => {
        for (const invalid of [
            { migId: "bad id", rangeLo: 0, rangeHi: 0 },
            { migId: "valid", rangeLo: -1, rangeHi: 0 },
            { migId: "valid", rangeLo: 2, rangeHi: 1 },
            { migId: "valid", rangeLo: 0, rangeHi: 16_384 },
        ]) {
            expect(() => assertCdbReshardRangeIdentity(invalid)).toThrow("reshard split identity");
        }

        db = new Database(":memory:");
        db.exec("CREATE TABLE _chardb_split_state (mig_id TEXT PRIMARY KEY)");
        db.exec(
            `WITH RECURSIVE seq(n) AS (
               VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ${CDB_SPLIT_IDENTITY_LIMIT}
             ) INSERT INTO _chardb_split_state SELECT printf('split-%05d', n) FROM seq`
        );
        const sql = adaptSqlStorage(sqlStorage(db) as never);
        expect(() => assertCdbSplitHistoryCapacity(sql, "new-split")).toThrow("durable row limit");
        expect(() => assertCdbSplitHistoryCapacity(sql, "split-00000")).not.toThrow();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_split_state").get()).toEqual({
            count: CDB_SPLIT_IDENTITY_LIMIT,
        });
    });

    test("binds role, range, schema, and canonical table list permanently", () => {
        const identities = store();
        const identity = {
            migId: "split_1",
            recoveryGeneration: 0,
            rangeLo: 100,
            rangeHi: 199,
            role: "source" as const,
            schemaVersion: 0,
            schemaEpoch: 1,
            schemaDigest: journal.digest,
            tables: [messageSpec, counterSpec],
        };
        expect(identities.bind(identity, schema, activeState, journal, 10).tables).toEqual([counterSpec, messageSpec]);
        expect(identities.bind(identity, schema, activeState, journal, 11).tables).toEqual([counterSpec, messageSpec]);

        for (const drift of [
            { ...identity, role: "dest" as const },
            { ...identity, rangeHi: 200 },
        ]) {
            expect(() => identities.bind(drift, schema, activeState, journal, 12)).toThrow(
                "different immutable Cdb split"
            );
        }
        expect(() => identities.bind({ ...identity, tables: [messageSpec] }, schema, activeState, journal, 12)).toThrow(
            "table list must include every movable table"
        );
        expect(() =>
            identities.bind({ ...identity, schemaDigest: "a".repeat(64) }, schema, activeState, journal, 12)
        ).toThrow("does not match the active Catalog topology schema");
    });

    test("checks current active schema and every movement table against the tombstone", () => {
        const identities = store();
        const identity = {
            migId: "split_2",
            recoveryGeneration: 0,
            rangeLo: 20,
            rangeHi: 30,
            role: "dest" as const,
            schemaVersion: 0,
            schemaEpoch: 1,
            schemaDigest: journal.digest,
            tables: [counterSpec, messageSpec],
        };
        identities.bind(identity, schema, activeState, journal, 20);
        expect(
            identities.assertMovement({
                migId: identity.migId,
                role: "dest",
                schema,
                state: activeState,
                journal,
                range: { lo: 20, hi: 30 },
                table: messageSpec,
            })
        ).toMatchObject(identity);
        expect(() =>
            identities.assertMovement({
                migId: identity.migId,
                role: "dest",
                schema,
                state: { ...activeState, status: "migrating" },
                journal,
            })
        ).toThrow("does not match the active Catalog topology schema");
        expect(() =>
            identities.assertMovement({
                migId: identity.migId,
                role: "dest",
                schema,
                state: activeState,
                journal,
                table: { ...messageSpec, columns: ["id", "organization_id"] },
            })
        ).toThrow();
    });
});
