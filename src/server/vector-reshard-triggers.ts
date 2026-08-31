import type { SyncSql } from "../oplog/wrapper.ts";
import type { TriggerSet } from "../reshard/triggers.ts";
import {
    cdbSystemTailMigrationId,
    cdbSystemTailTriggerId,
    renderCdbSystemTailAppend,
} from "./system-reshard-triggers.ts";

type Prefix = "NEW" | "OLD";

const HEAD_SCALARS = [
    "vector_id",
    "created_seq",
    "organization_id",
    "placement_vshard",
    "resource_id",
    "row_pk",
    "dimensions",
    "version",
    "delivered_version",
] as const;
const HEAD_TAIL_SCALARS = ["metadata_json", "state", "updated_at"] as const;
const OUTBOX_SCALARS = [
    "vector_id",
    "target_version",
    "operation",
    "phase",
    "mutation_id",
    "accepted_at",
    "verify_ids_json",
    "attempts",
    "next_attempt_at",
    "leased_until",
    "lease_token",
    "terminal_failure",
    "last_error",
] as const;
const ATTEMPT_SCALARS = [
    "vector_id",
    "physical_version",
    "first_sent_at",
    "settle_after",
    "visibility_confirmed",
    "response_ambiguous",
    "delete_confirmed",
    "delete_claim_token",
] as const;

const PENDING_PLACEMENT =
    "(SELECT placement_vshard FROM _chardb_op_log WHERE byte_size = 0 AND length(payload_enc) = 0 ORDER BY event_id LIMIT 1)";
const EXTERNAL_PLACEMENT = "(SELECT active_vshard FROM _chardb_split_capture_tx WHERE singleton = 1)";

function scalarJson(prefix: Prefix, columns: readonly string[]): string {
    return `json_object(${columns.map(column => `'${column}', ${prefix}."${column}"`).join(", ")})`;
}

function headJson(prefix: Prefix): string {
    const values = [
        ...HEAD_SCALARS.map(column => `'${column}', ${prefix}."${column}"`),
        `'values_hex', CASE WHEN ${prefix}."values_enc" IS NULL THEN NULL ELSE lower(hex(${prefix}."values_enc")) END`,
        ...HEAD_TAIL_SCALARS.map(column => `'${column}', ${prefix}."${column}"`),
    ];
    return `json_object(${values.join(", ")})`;
}

function childPlacement(prefix: Prefix): string {
    return `COALESCE((SELECT placement_vshard FROM _chardb_vectors WHERE vector_id = ${prefix}."vector_id"), ${PENDING_PLACEMENT}, ${EXTERNAL_PLACEMENT})`;
}

function missingChildPlacementAssertion(placement: string): string {
    return [
        `SELECT CASE WHEN (${placement}) IS NULL AND EXISTS (SELECT 1 FROM _chardb_split_state `,
        "WHERE role = 'source' AND capture = 1) ",
        "THEN RAISE(ABORT, 'CDB_INVARIANT: vector child capture placement is unavailable') END; ",
    ].join("");
}

function foreignKeyAssertions(migId: string, placement: string): string {
    const active =
        `EXISTS (SELECT 1 FROM _chardb_split_state WHERE mig_id = '${migId}' AND role = 'source' ` +
        `AND capture = 1 AND (${placement}) BETWEEN range_lo AND range_hi)`;
    return [
        `SELECT CASE WHEN (${active}) AND COALESCE((SELECT foreign_keys FROM pragma_foreign_keys), 0) != 1 `,
        "THEN RAISE(ABORT, 'CDB_INVARIANT: vector capture requires foreign keys') END; ",
        `SELECT CASE WHEN (${active}) AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_list('_chardb_vector_outbox') `,
        `WHERE "table" = '_chardb_vectors' AND "from" = 'vector_id' AND "to" = 'vector_id' `,
        "AND on_delete = 'CASCADE') ",
        "THEN RAISE(ABORT, 'CDB_INVARIANT: vector outbox capture foreign key differs') END; ",
        `SELECT CASE WHEN (${active}) AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_list('_chardb_vector_attempts') `,
        `WHERE "table" = '_chardb_vectors' AND "from" = 'vector_id' AND "to" = 'vector_id' `,
        "AND on_delete = 'CASCADE') ",
        "THEN RAISE(ABORT, 'CDB_INVARIANT: vector attempt capture foreign key differs') END; ",
    ].join("");
}

function appendHead(migId: string, op: "ins" | "upd" | "del", prefix: Prefix): string {
    return renderCdbSystemTailAppend({
        migId,
        kind: "vector",
        table: "_chardb_vectors",
        op,
        pkSql: `${prefix}."vector_id"`,
        placementSql: `${prefix}."placement_vshard"`,
        beforeSql: op === "ins" ? "NULL" : headJson("OLD"),
        afterSql: op === "del" ? "NULL" : headJson("NEW"),
        assertionsSql: foreignKeyAssertions(migId, `${prefix}."placement_vshard"`),
    });
}

function appendChild(input: {
    readonly migId: string;
    readonly table: "_chardb_vector_outbox" | "_chardb_vector_attempts";
    readonly columns: readonly string[];
    readonly op: "ins" | "upd" | "del";
    readonly prefix: Prefix;
}): string {
    const placement = childPlacement(input.prefix);
    const image = (prefix: Prefix) =>
        `json_set(${scalarJson(prefix, input.columns)}, '$.placement_vshard', ${childPlacement(prefix)})`;
    const pk =
        input.table === "_chardb_vector_attempts"
            ? `json_array(${input.prefix}."vector_id", ${input.prefix}."physical_version")`
            : `${input.prefix}."vector_id"`;
    return renderCdbSystemTailAppend({
        migId: input.migId,
        kind: "vector",
        table: input.table,
        op: input.op,
        pkSql: pk,
        placementSql: placement,
        beforeSql: input.op === "ins" ? "NULL" : image("OLD"),
        afterSql: input.op === "del" ? "NULL" : image("NEW"),
        assertionsSql: missingChildPlacementAssertion(placement) + foreignKeyAssertions(input.migId, placement),
    });
}

/** Validate the SQLite guarantees required before vector source triggers are installed. */
export function assertVectorReshardCaptureForeignKeys(sql: SyncSql): void {
    const enabled = sql.one<{ foreign_keys: number | bigint }>("SELECT foreign_keys FROM pragma_foreign_keys");
    if (Number(enabled?.foreign_keys) !== 1) throw new Error("vector capture requires foreign keys");
    for (const table of ["_chardb_vector_outbox", "_chardb_vector_attempts"] as const) {
        const relations = sql.all<{
            readonly id: number | bigint;
            readonly seq: number | bigint;
            readonly table: string;
            readonly from: string;
            readonly to: string;
            readonly on_update: string;
            readonly on_delete: string;
            readonly match: string;
        }>(
            `SELECT id, seq, "table", "from", "to", on_update, on_delete, "match"
             FROM pragma_foreign_key_list(?) ORDER BY id, seq`,
            table
        );
        const relation = relations[0];
        if (
            relations.length !== 1 ||
            !relation ||
            Number(relation.id) !== 0 ||
            Number(relation.seq) !== 0 ||
            relation.table !== "_chardb_vectors" ||
            relation.from !== "vector_id" ||
            relation.to !== "vector_id" ||
            relation.on_update !== "NO ACTION" ||
            relation.on_delete !== "CASCADE" ||
            relation.match !== "NONE"
        ) {
            throw new Error(
                `vector ${table === "_chardb_vector_outbox" ? "outbox" : "attempt"} capture foreign key differs`
            );
        }
    }
}

/** Capture vector heads and their delivery state in the migration's ordered system tail. */
export function renderVectorReshardTriggers(migId: string): TriggerSet {
    const id = cdbSystemTailMigrationId(migId);
    const triggerId = cdbSystemTailTriggerId(migId);
    const names = [
        `_chardb_vectorcapt_${triggerId}_head_ins`,
        `_chardb_vectorcapt_${triggerId}_head_upd`,
        `_chardb_vectorcapt_${triggerId}_head_del`,
        `_chardb_vectorcapt_${triggerId}_outbox_ins`,
        `_chardb_vectorcapt_${triggerId}_outbox_upd`,
        `_chardb_vectorcapt_${triggerId}_outbox_del`,
        `_chardb_vectorcapt_${triggerId}_attempt_ins`,
        `_chardb_vectorcapt_${triggerId}_attempt_upd`,
        `_chardb_vectorcapt_${triggerId}_attempt_del`,
    ] as const;
    const quoted = names.map(name => `"${name}"`);
    const [
        headInsert,
        headUpdate,
        headDelete,
        outboxInsert,
        outboxUpdate,
        outboxDelete,
        attemptInsert,
        attemptUpdate,
        attemptDelete,
    ] = quoted;
    return {
        names,
        install: [
            `CREATE TRIGGER IF NOT EXISTS ${headInsert} AFTER INSERT ON "_chardb_vectors" BEGIN ${appendHead(id, "ins", "NEW")} END`,
            `CREATE TRIGGER IF NOT EXISTS ${headUpdate} AFTER UPDATE ON "_chardb_vectors" BEGIN SELECT CASE WHEN OLD."placement_vshard" IS NOT NEW."placement_vshard" THEN RAISE(ABORT, 'CDB_INVARIANT: vector placement is immutable') END; ${appendHead(id, "upd", "NEW")} END`,
            `CREATE TRIGGER IF NOT EXISTS ${headDelete} AFTER DELETE ON "_chardb_vectors" BEGIN ${appendHead(id, "del", "OLD")} END`,
            `CREATE TRIGGER IF NOT EXISTS ${outboxInsert} AFTER INSERT ON "_chardb_vector_outbox" BEGIN ${appendChild({ migId: id, table: "_chardb_vector_outbox", columns: OUTBOX_SCALARS, op: "ins", prefix: "NEW" })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${outboxUpdate} AFTER UPDATE ON "_chardb_vector_outbox" BEGIN SELECT CASE WHEN OLD."vector_id" IS NOT NEW."vector_id" THEN RAISE(ABORT, 'CDB_INVARIANT: vector outbox identity is immutable') END; ${appendChild({ migId: id, table: "_chardb_vector_outbox", columns: OUTBOX_SCALARS, op: "upd", prefix: "NEW" })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${outboxDelete} AFTER DELETE ON "_chardb_vector_outbox" BEGIN ${appendChild({ migId: id, table: "_chardb_vector_outbox", columns: OUTBOX_SCALARS, op: "del", prefix: "OLD" })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${attemptInsert} AFTER INSERT ON "_chardb_vector_attempts" BEGIN ${appendChild({ migId: id, table: "_chardb_vector_attempts", columns: ATTEMPT_SCALARS, op: "ins", prefix: "NEW" })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${attemptUpdate} AFTER UPDATE ON "_chardb_vector_attempts" BEGIN SELECT CASE WHEN OLD."vector_id" IS NOT NEW."vector_id" OR OLD."physical_version" IS NOT NEW."physical_version" THEN RAISE(ABORT, 'CDB_INVARIANT: vector attempt identity is immutable') END; ${appendChild({ migId: id, table: "_chardb_vector_attempts", columns: ATTEMPT_SCALARS, op: "upd", prefix: "NEW" })} END`,
            `CREATE TRIGGER IF NOT EXISTS ${attemptDelete} AFTER DELETE ON "_chardb_vector_attempts" BEGIN ${appendChild({ migId: id, table: "_chardb_vector_attempts", columns: ATTEMPT_SCALARS, op: "del", prefix: "OLD" })} END`,
        ],
        uninstall: names.map(name => `DROP TRIGGER IF EXISTS "${name}"`),
    };
}
