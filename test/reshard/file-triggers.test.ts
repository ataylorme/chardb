import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OP_LOG_DDL, SPLIT_LOG_DDL } from "../../src/oplog/schema.ts";
import type { SyncSql } from "../../src/oplog/wrapper.ts";
import { CdbFileStore, initializeFileStore } from "../../src/server/do/cdb-file-store.ts";
import {
    beginExternalFileCapture,
    endExternalFileCapture,
    initializeFileCaptureTransactions,
    renderFileReshardTriggers,
} from "../../src/server/file-reshard-triggers.ts";
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

function execDdl(db: Database, ddl: string): void {
    for (const statement of ddl
        .split(";")
        .map(value => value.trim())
        .filter(Boolean)) {
        db.run(statement);
    }
}

describe("file reshard capture triggers", () => {
    let db: Database;
    let sql: SyncSql;
    let files: CdbFileStore;
    const organizationId = "org-moving";
    const placement = Number(vshardOf([organizationId]));

    beforeEach(() => {
        db = new Database(":memory:");
        sql = syncSql(db);
        execDdl(db, OP_LOG_DDL);
        execDdl(db, SPLIT_LOG_DDL);
        initializeFileStore(sql);
        initializeFileCaptureTransactions(sql);
        files = new CdbFileStore(sql);
        db.run(
            `INSERT INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
             VALUES ('file-move', ?, ?, 'source', 1, 1)`,
            [placement, placement]
        );
        for (const statement of renderFileReshardTriggers("file-move").install) db.run(statement);
    });

    afterEach(() => db.close());

    function reserve(fileId: string, targetOrganization = organizationId): void {
        files.reserve({
            fileId,
            organizationId: targetOrganization,
            table: "messages",
            column: "attachment",
            contentType: "image/png",
            size: 4,
            nowMs: 1,
        });
    }

    test("uses one negative transaction identity for ordered external metadata changes", () => {
        let transactionId = 0;
        db.transaction(() => {
            transactionId = beginExternalFileCapture(sql, organizationId);
            reserve("file-external");
            files.markReady("file-external", "a".repeat(64), 4, 2);
            endExternalFileCapture(sql, transactionId);
        })();
        expect(transactionId).toBe(-1);
        const rows = db
            .query(
                `SELECT source_tx_id, op, table_name, pk, before, after
                 FROM _chardb_split_log ORDER BY lsn`
            )
            .all() as {
            source_tx_id: number;
            op: string;
            table_name: string;
            pk: string;
            before: string | null;
            after: string | null;
        }[];
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.source_tx_id)).toEqual([-1, -1]);
        expect(rows.map(row => row.op)).toEqual(["ins", "upd"]);
        expect(rows.every(row => row.table_name === "_chardb_files" && row.pk === "file-external")).toBe(true);
        expect(JSON.parse(rows[1]?.after ?? "null")).toMatchObject({ status: "ready", placement_vshard: placement });
    });

    test("shares a registered mutation transaction identity and captures organization tombstones", () => {
        db.transaction(() => {
            db.run(
                `INSERT INTO _chardb_op_log
                   (principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch,
                    touched_keys, byte_size, placement_vshard)
                 VALUES ('p', 'm', X'00', X'', 1, 1, '[]', 0, ?)`,
                [placement]
            );
            reserve("file-mutation");
            db.run("UPDATE _chardb_op_log SET payload_enc = X'01', byte_size = 1 WHERE mut_id = 'm'");
        })();
        db.transaction(() => {
            const transactionId = beginExternalFileCapture(sql, organizationId);
            files.fenceOrganizationDeletion(organizationId, 3);
            db.run("UPDATE _chardb_deleted_organizations SET vector_unproven_turns = 1 WHERE organization_id = ?", [
                organizationId,
            ]);
            endExternalFileCapture(sql, transactionId);
        })();
        const rows = db.query("SELECT source_tx_id, table_name, op FROM _chardb_split_log ORDER BY lsn").all() as {
            source_tx_id: number;
            table_name: string;
            op: string;
        }[];
        expect(rows[0]).toMatchObject({ source_tx_id: 1, table_name: "_chardb_files", op: "ins" });
        expect(rows.some(row => row.table_name === "_chardb_deleted_organizations" && row.op === "ins")).toBe(true);
        expect(rows.some(row => row.table_name === "_chardb_deleted_organizations" && row.op === "upd")).toBe(true);
    });

    test("does not charge unrelated organizations to the moving range", () => {
        let outside = "org-outside";
        while (Number(vshardOf([outside])) === placement) outside += "x";
        db.transaction(() => {
            const transactionId = beginExternalFileCapture(sql, outside);
            reserve("file-outside", outside);
            endExternalFileCapture(sql, transactionId);
        })();
        expect(db.query("SELECT * FROM _chardb_split_log").all()).toEqual([]);
        expect(
            db.query("SELECT split_log_rows, split_log_bytes FROM _chardb_split_state WHERE mig_id = 'file-move'").get()
        ).toEqual({ split_log_rows: 0, split_log_bytes: 0 });
    });

    test("fails closed without one identity, on placement mismatch, overlap, and capacity exhaustion", () => {
        expect(() => reserve("file-no-transaction")).toThrow(/exactly one transaction identity/);

        db.transaction(() => {
            const wrongOrganization = "org-wrong";
            const transactionId = beginExternalFileCapture(sql, wrongOrganization);
            expect(() => reserve("file-wrong-placement")).toThrow(/placement differs/);
            endExternalFileCapture(sql, transactionId);
        })();

        db.run(
            `INSERT INTO _chardb_split_state (mig_id, range_lo, range_hi, role, capture, updated_at)
             VALUES ('overlap', ?, ?, 'source', 1, 1)`,
            [placement, placement]
        );
        db.transaction(() => {
            const transactionId = beginExternalFileCapture(sql, organizationId);
            expect(() => reserve("file-overlap")).toThrow(/overlapping active file splits/);
            endExternalFileCapture(sql, transactionId);
        })();
        db.run("DELETE FROM _chardb_split_state WHERE mig_id = 'overlap'");
        db.run("UPDATE _chardb_split_state SET split_log_rows = 65536 WHERE mig_id = 'file-move'");
        db.transaction(() => {
            const transactionId = beginExternalFileCapture(sql, organizationId);
            expect(() => reserve("file-capacity")).toThrow(/source split log capacity reached/);
            endExternalFileCapture(sql, transactionId);
        })();
    });

    test("uses injective trigger names and removes pre-encoding file triggers", () => {
        const hyphen = renderFileReshardTriggers("move-a");
        const underscore = renderFileReshardTriggers("move_a");
        const upper = renderFileReshardTriggers("Move");
        const lower = renderFileReshardTriggers("move");
        expect(new Set(hyphen.names.map(name => name.toLowerCase()))).not.toEqual(
            new Set(underscore.names.map(name => name.toLowerCase()))
        );
        expect(new Set(upper.names.map(name => name.toLowerCase()))).not.toEqual(
            new Set(lower.names.map(name => name.toLowerCase()))
        );
        expect(hyphen.names.every(name => name.includes("_m_"))).toBe(true);
        const collisionNames = [...hyphen.names, ...underscore.names, ...upper.names, ...lower.names];
        for (const triggers of [hyphen, underscore, upper, lower]) {
            for (const statement of triggers.install) db.run(statement);
        }
        const installed = new Set(
            (db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map(
                row => row.name.toLowerCase()
            )
        );
        expect(collisionNames.every(name => installed.has(name.toLowerCase()))).toBe(true);
        expect(new Set(collisionNames.map(name => name.toLowerCase()))).toHaveLength(20);

        for (const [name, table] of [
            ["_chardb_filecapt_move_a_ins", "_chardb_files"],
            ["_chardb_filecapt_move_a_upd", "_chardb_files"],
            ["_chardb_filecapt_move_a_del", "_chardb_files"],
            ["_chardb_filecapt_move_a_org_ins", "_chardb_deleted_organizations"],
            ["_chardb_filecapt_move_a_org_upd", "_chardb_deleted_organizations"],
        ] as const) {
            db.run(`CREATE TRIGGER "${name}" AFTER INSERT ON "${table}" BEGIN SELECT 1; END`);
        }
        for (const statement of hyphen.uninstall) db.run(statement);
        expect(
            db
                .query(
                    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB '_chardb_filecapt_move_a_*'"
                )
                .all()
        ).toEqual([]);
        expect(hyphen.uninstall).toHaveLength(10);
    });
});
