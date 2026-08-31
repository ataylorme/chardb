import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { legacyReshardTriggerMigrationId, reshardTriggerMigrationId } from "../../src/reshard/triggers.ts";
import { initializeCdbFileReshardStore } from "../../src/server/do/cdb-file-reshard-store.ts";
import { initializeFileStore } from "../../src/server/do/cdb-file-store.ts";
import {
    CDB_RESHARD_MAX_BATCH_BYTES,
    CDB_RESHARD_MAX_ROW_BYTES,
    applyReshardRow,
    applyReshardSystemTailEntry,
    applyReshardUpdate,
    assertNoUnexpectedReshardTriggers,
    assertReshardBatchBudget,
    assertReshardDestinationRangeEmpty,
    assertReshardEnvelopeBudget,
    assertReshardRowForeignKeysColocated,
    assertReshardSourceDomainDrained,
    assertReshardSourceTransactionId,
    isKnownReshardTailTable,
    orderReshardTables,
    readReshardForeignKeys,
    renderReshardForeignKeyGuards,
    reshardJsonArrayBytes,
    uninstallOwnedLegacyReshardForeignKeyGuards,
} from "../../src/server/do/cdb-reshard-relational.ts";
import { renderFileAttachmentTriggerSet } from "../../src/server/file-triggers.ts";
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

let db: Database;

afterEach(() => db?.close());

describe("Cdb reshard relational apply", () => {
    test("accepts the exact row byte boundary and rejects row or aggregate overflow", () => {
        const exact = "x".repeat(CDB_RESHARD_MAX_ROW_BYTES - 2);
        expect(assertReshardBatchBudget([exact], "test")).toBe(CDB_RESHARD_MAX_ROW_BYTES);
        expect(() => assertReshardBatchBudget([`${exact}x`], "test")).toThrow("row exceeds");
        const chunk = "x".repeat(Math.floor(CDB_RESHARD_MAX_BATCH_BYTES / 5));
        expect(() => assertReshardBatchBudget([chunk, chunk, chunk, chunk, chunk, chunk], "test")).toThrow(
            "batch exceeds"
        );
    });

    test("accepts positive mutation and negative file-only transaction identities", () => {
        expect(() => assertReshardSourceTransactionId(1)).not.toThrow();
        expect(() => assertReshardSourceTransactionId(-1)).not.toThrow();
        expect(() => assertReshardSourceTransactionId(Number.MIN_SAFE_INTEGER)).not.toThrow();
        for (const invalid of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => assertReshardSourceTransactionId(invalid)).toThrow(/transaction identity is invalid/);
        }
    });

    test("counts transaction wrappers in the aggregate tail wire budget", () => {
        let payloadSize = 1_000;
        let entries: Record<string, unknown>[] = [];
        let transactions: Record<string, unknown>[] = [];
        while (payloadSize < 3_000) {
            entries = Array.from({ length: 500 }, (_, index) => ({
                source_tx_id: index + 1,
                lsn: index + 1,
                op: "ins",
                table_name: "records",
                pk: "org-a",
                before: null,
                after: "x".repeat(payloadSize),
            }));
            transactions = entries.map((entry, index) => ({
                sourceTxId: index + 1,
                firstLsn: index + 1,
                lastLsn: index + 1,
                entries: [entry],
            }));
            if (
                JSON.stringify(entries).length <= CDB_RESHARD_MAX_BATCH_BYTES &&
                JSON.stringify(transactions).length > CDB_RESHARD_MAX_BATCH_BYTES
            ) {
                break;
            }
            payloadSize += 10;
        }

        expect(assertReshardBatchBudget(entries, "tail entries")).toBeLessThanOrEqual(CDB_RESHARD_MAX_BATCH_BYTES);
        expect(() => assertReshardEnvelopeBudget(transactions, "tail transactions")).toThrow("envelope exceeds");
    });

    test("accounts exact JSON-array punctuation at the 500-transaction envelope boundary", () => {
        const itemBytes = Array.from({ length: 500 }, () => 1);
        itemBytes[0] = CDB_RESHARD_MAX_BATCH_BYTES - 2 - 499 - 499;

        expect(reshardJsonArrayBytes(itemBytes)).toBe(CDB_RESHARD_MAX_BATCH_BYTES);
        itemBytes[0] += 1;
        expect(reshardJsonArrayBytes(itemBytes)).toBe(CDB_RESHARD_MAX_BATCH_BYTES + 1);
        expect(() => reshardJsonArrayBytes([Number.NaN])).toThrow("byte size is invalid");
    });

    test("derives parent-before-child order even when the request lists the child first", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE parents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run(
            "CREATE TABLE children (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES parents(id))"
        );
        const parent = { name: "parents", partitionColumn: "org_id", columns: ["id", "org_id"] } as const;
        const child = {
            name: "children",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "parent_id"],
        } as const;

        expect(orderReshardTables(syncSql(db), [child, parent]).map(table => table.name)).toEqual([
            "parents",
            "children",
        ]);
    });

    test("rejects an existing FK edge whose child and parent use different partitions", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE parents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run(
            "CREATE TABLE children (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES parents(id))"
        );
        db.run("INSERT INTO parents VALUES ('parent', 'org-parent')");
        db.run("INSERT INTO children VALUES ('child', 'org-child', 'parent')");
        const parent = { name: "parents", partitionColumn: "org_id", columns: ["id", "org_id"] } as const;
        const child = {
            name: "children",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "parent_id"],
        } as const;
        const sql = syncSql(db);
        const foreignKeys = readReshardForeignKeys(sql, [parent, child]);

        expect(() => assertReshardRowForeignKeysColocated(sql, child, 1, foreignKeys)).toThrow(
            "FK children -> parents crosses partitions"
        );
    });

    test("live FK guards reject cross-partition children and freeze referenced partition keys", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE parents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run(
            "CREATE TABLE children (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES parents(id))"
        );
        db.run("INSERT INTO parents VALUES ('parent', 'org-a')");
        const parent = { name: "parents", partitionColumn: "org_id", columns: ["id", "org_id"] } as const;
        const child = {
            name: "children",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "parent_id"],
        } as const;
        const guards = renderReshardForeignKeyGuards(syncSql(db), "migration-1", [parent, child]);
        for (const statement of guards.install) db.run(statement);

        db.run("INSERT INTO children VALUES ('same', 'org-a', 'parent')");
        expect(() => db.run("INSERT INTO children VALUES ('cross', 'org-b', 'parent')")).toThrow(
            "FK children -> parents crosses partitions"
        );
        expect(() => db.run("UPDATE parents SET org_id = 'org-b' WHERE id = 'parent'")).toThrow(
            "referenced row partition is frozen"
        );
        expect(db.query("SELECT * FROM children ORDER BY id").all()).toEqual([
            { id: "same", org_id: "org-a", parent_id: "parent" },
        ]);

        for (const statement of guards.uninstall) db.run(statement);
        db.run("UPDATE parents SET org_id = 'org-b' WHERE id = 'parent'");
    });

    test("uses case-insensitive injective migration identities for FK guards", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE parents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run(
            "CREATE TABLE children (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES parents(id))"
        );
        const parent = { name: "parents", partitionColumn: "org_id", columns: ["id", "org_id"] } as const;
        const child = {
            name: "children",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "parent_id"],
        } as const;
        const ids = ["move-a", "move_a", "Move", "move"].flatMap(
            migId => renderReshardForeignKeyGuards(syncSql(db), migId, [parent, child]).names
        );

        expect(new Set(ids).size).toBe(ids.length);
    });

    test("removes legacy FK guards only for a unique durable migration owner", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE parents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run(
            "CREATE TABLE children (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES parents(id))"
        );
        db.run(
            "CREATE TABLE _chardb_split_state (mig_id TEXT PRIMARY KEY, role TEXT NOT NULL, drained INTEGER NOT NULL)"
        );
        db.run("INSERT INTO _chardb_split_state VALUES ('move-a', 'source', 0)");
        const parent = { name: "parents", partitionColumn: "org_id", columns: ["id", "org_id"] } as const;
        const child = {
            name: "children",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "parent_id"],
        } as const;
        const current = renderReshardForeignKeyGuards(syncSql(db), "move-a", [parent, child]);
        const encoded = reshardTriggerMigrationId("move-a");
        const legacy = legacyReshardTriggerMigrationId("move-a");
        current.install.forEach((statement, index) => {
            const currentName = current.names[index];
            if (!currentName) throw new Error("expected a complete FK guard identity");
            db.run(statement.replace(currentName, currentName.replace(encoded, legacy)));
        });

        expect(uninstallOwnedLegacyReshardForeignKeyGuards(syncSql(db), "move_a", [parent, child])).toBe(0);
        expect(uninstallOwnedLegacyReshardForeignKeyGuards(syncSql(db), "move-a", [parent, child])).toBe(
            current.names.length
        );
    });

    test("rejects application triggers that would duplicate insert, update, or delete side effects", () => {
        const table = { name: "records", partitionColumn: "org_id", columns: ["id", "org_id", "value"] } as const;
        for (const [suffix, trigger] of [
            ["insert", "AFTER INSERT ON records BEGIN INSERT INTO effects VALUES ('insert'); END"],
            ["update", "AFTER UPDATE ON records BEGIN INSERT INTO effects VALUES ('update'); END"],
            ["delete", "AFTER DELETE ON records BEGIN INSERT INTO effects VALUES ('delete'); END"],
        ] as const) {
            db = new Database(":memory:");
            db.run("CREATE TABLE records (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, value TEXT NOT NULL)");
            db.run("CREATE TABLE effects (value TEXT NOT NULL)");
            db.run(`CREATE TRIGGER application_${suffix} ${trigger}`);
            expect(() => assertNoUnexpectedReshardTriggers(syncSql(db), [table])).toThrow(`application_${suffix}`);
            db.close();
        }
        db = undefined as never;
    });

    test("admits only the exact schema-derived file attachment trigger names", () => {
        db = new Database(":memory:");
        db.run(
            "CREATE TABLE records (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, attachment TEXT, value TEXT NOT NULL)"
        );
        initializeFileStore(syncSql(db));
        const table = {
            name: "records",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "attachment", "value"],
        } as const;
        const attachments = renderFileAttachmentTriggerSet({
            kind: "file",
            version: 1,
            table: "records",
            column: "attachment",
            primaryKey: "id",
            organizationColumn: "org_id",
            maxSize: 1024,
            contentTypes: "*",
        });
        for (const statement of attachments.install) db.run(statement);

        expect(() => assertNoUnexpectedReshardTriggers(syncSql(db), [table], attachments.names)).not.toThrow();
        db.run("CREATE TRIGGER application_insert AFTER INSERT ON records BEGIN SELECT 1; END");
        expect(() => assertNoUnexpectedReshardTriggers(syncSql(db), [table], attachments.names)).toThrow(
            "application_insert"
        );
    });

    test("requires every migrating table on the destination to be physically empty", () => {
        db = new Database(":memory:");
        db.run("CREATE TABLE records (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run("INSERT INTO records VALUES ('existing', 'outside-range')");
        const table = { name: "records", partitionColumn: "org_id", columns: ["id", "org_id"] } as const;

        expect(() => assertReshardDestinationRangeEmpty(syncSql(db), [table], { lo: 0, hi: 0 })).toThrow(
            "destination table records is not empty"
        );
    });

    test("uses completed drop cursors to prove one source range drained while unrelated rows remain", () => {
        db = new Database(":memory:");
        db.run(
            `CREATE TABLE _chardb_split_drop_cursor (
               mig_id TEXT NOT NULL, table_name TEXT NOT NULL, done INTEGER NOT NULL,
               PRIMARY KEY (mig_id, table_name)
             )`
        );
        db.run("CREATE TABLE records (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run("INSERT INTO records VALUES ('unrelated', 'another-range')");
        db.run("INSERT INTO _chardb_split_drop_cursor VALUES ('move-1', 'records', 1)");
        const table = { name: "records", partitionColumn: "org_id", columns: ["id", "org_id"] } as const;

        expect(() => assertReshardSourceDomainDrained(syncSql(db), "move-1", [table])).not.toThrow();
        db.run("UPDATE _chardb_split_drop_cursor SET done = 0");
        expect(() => assertReshardSourceDomainDrained(syncSql(db), "move-1", [table])).toThrow(
            "source domain range is not fully drained"
        );
    });

    test("same primary key in another partition fails without firing REPLACE cascades", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE records (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, value TEXT NOT NULL)");
        db.run(
            "CREATE TABLE dependents (id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE)"
        );
        db.run("INSERT INTO records VALUES ('same-id', 'org-old', 'old')");
        db.run("INSERT INTO dependents VALUES ('child', 'same-id')");
        const table = {
            name: "records",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "value"],
        } as const;

        expect(() => applyReshardRow(syncSql(db), table, { id: "same-id", org_id: "org-new", value: "new" })).toThrow(
            "primary-key collision crosses partitions"
        );
        expect(db.query("SELECT * FROM records").all()).toEqual([{ id: "same-id", org_id: "org-old", value: "old" }]);
        expect(db.query("SELECT * FROM dependents").all()).toEqual([{ id: "child", record_id: "same-id" }]);
    });

    test("an unrelated unique conflict aborts instead of deleting the conflicting row", () => {
        db = new Database(":memory:");
        db.run("CREATE TABLE records (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE)");
        db.run("INSERT INTO records VALUES ('one', 'org-a', 'same@example.com')");
        const table = {
            name: "records",
            partitionColumn: "org_id",
            columns: ["id", "org_id", "email"],
        } as const;

        expect(() =>
            applyReshardRow(syncSql(db), table, { id: "two", org_id: "org-a", email: "same@example.com" })
        ).toThrow();
        expect(db.query("SELECT * FROM records").all()).toEqual([
            { id: "one", org_id: "org-a", email: "same@example.com" },
        ]);
    });

    test("a composite primary-key update removes the exact old tuple and is replay-safe with an immediate FK", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE parents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)");
        db.run(`CREATE TABLE children (
            id TEXT NOT NULL,
            revision TEXT NOT NULL,
            org_id TEXT NOT NULL,
            parent_id TEXT NOT NULL REFERENCES parents(id),
            body TEXT NOT NULL,
            PRIMARY KEY (id, revision)
        )`);
        db.run("INSERT INTO parents VALUES ('parent', 'org-a')");
        db.run("INSERT INTO children VALUES ('child', 'v1', 'org-a', 'parent', 'before')");
        const table = {
            name: "children",
            partitionColumn: "org_id",
            columns: ["id", "revision", "org_id", "parent_id", "body"],
        } as const;
        const before = { id: "child", revision: "v1", org_id: "org-a", parent_id: "parent", body: "before" };
        const after = { id: "child", revision: "v2", org_id: "org-a", parent_id: "parent", body: "after" };

        const apply = () => db.transaction(() => applyReshardUpdate(syncSql(db), table, before, after))();
        apply();
        apply();

        expect(db.query("SELECT * FROM children").all()).toEqual([after]);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    test("applies exact file and tombstone images through the shared ordered tail", () => {
        db = new Database(":memory:");
        const sql = syncSql(db);
        initializeFileStore(sql);
        initializeCdbFileReshardStore(sql);
        const organizationId = "org-file-tail";
        const placement = Number(vshardOf([organizationId]));
        const range = { lo: placement, hi: placement };
        const pending = {
            file_id: "file-tail",
            organization_id: organizationId,
            table_name: "messages",
            column_name: "attachment",
            object_key: `v1/${organizationId}/file-tail`,
            content_type: "image/png",
            size: 4,
            sha256: null,
            status: "pending",
            row_id: null,
            created_at: 1,
            updated_at: 1,
            placement_vshard: placement,
        };
        const ready = { ...pending, sha256: "a".repeat(64), status: "ready", updated_at: 2 };
        const insert = {
            lsn: 1,
            op: "ins" as const,
            table_name: "_chardb_files",
            pk: "file-tail",
            before: null,
            after: JSON.stringify(pending) as never,
        };
        expect(() =>
            applyReshardSystemTailEntry(sql, "migration-1", { ...insert, after: JSON.stringify(ready) as never }, range)
        ).toThrow(/does not begin in pending state/);
        expect(applyReshardSystemTailEntry(sql, "migration-1", insert, range)).toBe(true);
        expect(applyReshardSystemTailEntry(sql, "migration-1", insert, range)).toBe(true);
        expect(
            applyReshardSystemTailEntry(
                sql,
                "migration-1",
                {
                    lsn: 2,
                    op: "upd",
                    table_name: "_chardb_files",
                    pk: "file-tail",
                    before: JSON.stringify(pending) as never,
                    after: JSON.stringify(ready) as never,
                },
                range
            )
        ).toBe(true);
        expect(db.query("SELECT status, sha256 FROM _chardb_files WHERE file_id = 'file-tail'").get()).toEqual({
            status: "ready",
            sha256: "a".repeat(64),
        });
        const tombstone = {
            organization_id: organizationId,
            deleted_at: 3,
            placement_vshard: placement,
        };
        expect(
            applyReshardSystemTailEntry(
                sql,
                "migration-1",
                {
                    lsn: 3,
                    op: "ins",
                    table_name: "_chardb_deleted_organizations",
                    pk: organizationId,
                    before: null,
                    after: JSON.stringify(tombstone) as never,
                },
                range
            )
        ).toBe(true);
        const tombstoneWithBudget = { ...tombstone, vector_unproven_turns: 0 };
        const advancedTombstone = { ...tombstone, vector_unproven_turns: 1 };
        expect(
            applyReshardSystemTailEntry(
                sql,
                "migration-1",
                {
                    lsn: 4,
                    op: "upd",
                    table_name: "_chardb_deleted_organizations",
                    pk: organizationId,
                    before: JSON.stringify(tombstoneWithBudget) as never,
                    after: JSON.stringify(advancedTombstone) as never,
                },
                range
            )
        ).toBe(true);
        expect(db.query("SELECT vector_unproven_turns FROM _chardb_deleted_organizations").get()).toEqual({
            vector_unproven_turns: 1,
        });
        expect(() =>
            applyReshardSystemTailEntry(
                sql,
                "migration-1",
                {
                    lsn: 3,
                    op: "del",
                    table_name: "_chardb_files",
                    pk: "file-tail",
                    before: JSON.stringify(ready) as never,
                    after: null,
                },
                range
            )
        ).toThrow(/does not own deletion state/);
        const deleting = { ...ready, status: "deleting", updated_at: 3 };
        expect(
            applyReshardSystemTailEntry(
                sql,
                "migration-1",
                {
                    lsn: 5,
                    op: "upd",
                    table_name: "_chardb_files",
                    pk: "file-tail",
                    before: JSON.stringify(ready) as never,
                    after: JSON.stringify(deleting) as never,
                },
                range
            )
        ).toBe(true);
        expect(
            applyReshardSystemTailEntry(
                sql,
                "migration-1",
                {
                    lsn: 6,
                    op: "del",
                    table_name: "_chardb_files",
                    pk: "file-tail",
                    before: JSON.stringify(deleting) as never,
                    after: null,
                },
                range
            )
        ).toBe(true);
        expect(db.query("SELECT * FROM _chardb_files").all()).toEqual([]);
    });

    test("accepts the exact post-snapshot state and rejects malformed system tails", () => {
        db = new Database(":memory:");
        const sql = syncSql(db);
        initializeFileStore(sql);
        initializeCdbFileReshardStore(sql);
        const organizationId = "org-file-race";
        const placement = Number(vshardOf([organizationId]));
        const range = { lo: placement, hi: placement };
        const pending = {
            file_id: "file-race",
            organization_id: organizationId,
            table_name: "messages",
            column_name: "attachment",
            object_key: `v1/${organizationId}/file-race`,
            content_type: "image/png",
            size: 4,
            sha256: null,
            status: "pending",
            row_id: null,
            created_at: 1,
            updated_at: 1,
            placement_vshard: placement,
        };
        const ready = { ...pending, sha256: "b".repeat(64), status: "ready", updated_at: 2 };
        applyReshardSystemTailEntry(
            sql,
            "migration-2",
            {
                lsn: 1,
                op: "ins",
                table_name: "_chardb_files",
                pk: "file-race",
                before: null,
                after: JSON.stringify(pending) as never,
            },
            range
        );
        applyReshardSystemTailEntry(
            sql,
            "migration-2",
            {
                lsn: 2,
                op: "upd",
                table_name: "_chardb_files",
                pk: "file-race",
                before: JSON.stringify(pending) as never,
                after: JSON.stringify(ready) as never,
            },
            range
        );
        expect(
            applyReshardSystemTailEntry(
                sql,
                "migration-2",
                {
                    lsn: 2,
                    op: "upd",
                    table_name: "_chardb_files",
                    pk: "file-race",
                    before: JSON.stringify(pending) as never,
                    after: JSON.stringify(ready) as never,
                },
                range
            )
        ).toBe(true);
        expect(() =>
            applyReshardSystemTailEntry(
                sql,
                "migration-2",
                {
                    lsn: 3,
                    op: "upd",
                    table_name: "_chardb_files",
                    pk: "file-race",
                    before: JSON.stringify(ready) as never,
                    after: JSON.stringify({ ...pending, extra: true }) as never,
                },
                range
            )
        ).toThrow(/fields are not exact/);
        expect(() =>
            applyReshardSystemTailEntry(
                sql,
                "migration-2",
                {
                    lsn: 3,
                    op: "upd",
                    table_name: "_chardb_files",
                    pk: "file-race",
                    before: JSON.stringify(ready) as never,
                    after: JSON.stringify({ ...ready, organization_id: "org-drift" }) as never,
                },
                range
            )
        ).toThrow(/invalid virtual-shard placement/);
        expect(() => isKnownReshardTailTable("_chardb_unknown", new Set(["messages"]))).toThrow(/unknown system table/);
        expect(() => isKnownReshardTailTable("unknown", new Set(["messages"]))).toThrow(/unknown table/);
        expect(isKnownReshardTailTable("_chardb_files", new Set(["messages"]))).toBe(true);
        expect(
            applyReshardSystemTailEntry(
                sql,
                "migration-2",
                { lsn: 4, op: "ins", table_name: "messages", pk: "org", before: null, after: null },
                range
            )
        ).toBe(false);
    });

    test("a parent primary-key update uses SQLite ON UPDATE instead of delete semantics", () => {
        db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        db.run("CREATE TABLE parents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, body TEXT NOT NULL)");
        db.run(`CREATE TABLE children (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL REFERENCES parents(id) ON UPDATE CASCADE ON DELETE RESTRICT
        )`);
        db.run("INSERT INTO parents VALUES ('p1', 'org-a', 'before')");
        db.run("INSERT INTO children VALUES ('child', 'p1')");
        const table = { name: "parents", partitionColumn: "org_id", columns: ["id", "org_id", "body"] } as const;

        db.transaction(() =>
            applyReshardUpdate(
                syncSql(db),
                table,
                { id: "p1", org_id: "org-a", body: "before" },
                { id: "p2", org_id: "org-a", body: "after" }
            )
        )();

        expect(db.query("SELECT * FROM parents").all()).toEqual([{ id: "p2", org_id: "org-a", body: "after" }]);
        expect(db.query("SELECT * FROM children").all()).toEqual([{ id: "child", parent_id: "p2" }]);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    test("a changed-key replay never overwrites a different row already at the new tuple", () => {
        db = new Database(":memory:");
        db.run(
            "CREATE TABLE records (id TEXT NOT NULL, revision TEXT NOT NULL, org_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (id, revision))"
        );
        db.run("INSERT INTO records VALUES ('record', 'v2', 'org-a', 'unrelated')");
        const table = {
            name: "records",
            partitionColumn: "org_id",
            columns: ["id", "revision", "org_id", "body"],
        } as const;

        expect(() =>
            db.transaction(() =>
                applyReshardUpdate(
                    syncSql(db),
                    table,
                    { id: "record", revision: "v1", org_id: "org-a", body: "before" },
                    { id: "record", revision: "v2", org_id: "org-a", body: "expected" }
                )
            )()
        ).toThrow("collides with a different row");
        expect(db.query("SELECT * FROM records").all()).toEqual([
            { id: "record", revision: "v2", org_id: "org-a", body: "unrelated" },
        ]);
    });
});
