import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { text } from "drizzle-orm/sqlite-core";
import { CdbError } from "../../src/errors.ts";
import { OP_LOG_DDL } from "../../src/oplog/schema.ts";
import { canonicalRequest, runWrappedMutation } from "../../src/oplog/wrapper.ts";
import { executeAtomicMutation } from "../../src/server/atomic-mutation.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { globalScope } from "../../src/server/index.ts";
import { CDB_RESULT_MAX_BYTES } from "../../src/server/result_limits.ts";
import { Cookie, MutId, PrincipalId, type RawJson } from "../../src/types.ts";

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
const entries = cdbTable(
    "mutation_limit_entries",
    {
        id: text("id").primaryKey(),
        value: text("value").notNull(),
    },
    { partitionBy: "id", roles: { member: { create: "*", read: "*" } } }
);
const schema = { entries };

describe("atomic mutation result limits", () => {
    let db: Database;
    let storage: DurableObjectStorage;
    let handlerRuns: number;
    let hookRuns: number;

    beforeEach(() => {
        db = new Database(":memory:");
        for (const statement of OP_LOG_DDL.split(";")
            .map(value => value.trim())
            .filter(Boolean)) {
            db.run(statement);
        }
        db.run("CREATE TABLE mutation_limit_entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
        storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        handlerRuns = 0;
        hookRuns = 0;
    });

    afterEach(() => db.close());

    function execute(args: {
        readonly mutId: string;
        readonly id: string;
        readonly result: RawJson;
        throwError?: boolean;
    }) {
        return executeAtomicMutation({
            storage,
            schema,
            request: {
                principalId: "mutation-limit-user",
                mutId: args.mutId,
                ref: "mutations.ts#limitedResult",
                args: { id: args.id },
                auth: { userId: "mutation-limit-user", roles: ["member"], claims: {} },
                schemaEpoch: 1,
            },
            cookie: `cookie:${args.mutId}`,
            nowMs: 1_700_000_000_000,
            handler: ({ db: mutationDb }, request) => {
                handlerRuns++;
                mutationDb.insert(entries).values({ id: request.id, value: "written" }).run();
                if (args.throwError) throw new Error("handler failure unchanged");
                return args.result;
            },
            onWriteSet: () => {
                hookRuns++;
            },
        });
    }

    function durableCounts(): { readonly domain: number; readonly opLog: number } {
        const domain = db.query("SELECT COUNT(*) AS count FROM mutation_limit_entries").get() as { count: number };
        const opLog = db.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get() as { count: number };
        return { domain: domain.count, opLog: opLog.count };
    }

    test("accepts the exact byte boundary and replays the stored result without rerunning the handler", () => {
        expect(CDB_RESULT_MAX_BYTES).toBe(524_288);
        const result = "a".repeat(CDB_RESULT_MAX_BYTES - 2);
        const request = { mutId: "exact-boundary", id: "exact-boundary", result };

        expect(execute(request)).toMatchObject({ ran: true, result });
        expect(handlerRuns).toBe(1);
        expect(hookRuns).toBe(1);
        expect(durableCounts()).toEqual({ domain: 1, opLog: 1 });

        expect(execute(request)).toMatchObject({ ran: false, result });
        expect(handlerRuns).toBe(1);
        expect(hookRuns).toBe(1);
        expect(durableCounts()).toEqual({ domain: 1, opLog: 1 });
    });

    test("rejects one byte over and rolls back the domain write and provisional op-log row", () => {
        const result = "a".repeat(CDB_RESULT_MAX_BYTES - 1);
        let captured: unknown;
        try {
            execute({ mutId: "one-over", id: "must-roll-back", result });
        } catch (error) {
            captured = error;
        }

        expect(captured).toBeInstanceOf(CdbError);
        expect(captured).toMatchObject({
            code: "CDB_INVARIANT",
            message: "mutation result exceeds the 524288-byte serialized limit",
        });
        expect(handlerRuns).toBe(1);
        expect(hookRuns).toBe(0);
        expect(durableCounts()).toEqual({ domain: 0, opLog: 0 });
    });

    test("counts multibyte, escaped, lone-surrogate, and nested serialization at the exact boundary", () => {
        const charactersAtBoundary = (CDB_RESULT_MAX_BYTES - 2) / 2;
        const multibyte = "é".repeat(charactersAtBoundary);
        const escaped = "\n".repeat(charactersAtBoundary);
        const loneSurrogate = "\ud800".repeat((CDB_RESULT_MAX_BYTES - 2) / 6);
        const nested = { x: "a".repeat(CDB_RESULT_MAX_BYTES - 8) };
        expect(new TextEncoder().encode(JSON.stringify(multibyte)).byteLength).toBe(CDB_RESULT_MAX_BYTES);
        expect(new TextEncoder().encode(JSON.stringify(escaped)).byteLength).toBe(CDB_RESULT_MAX_BYTES);
        expect(new TextEncoder().encode(JSON.stringify(loneSurrogate)).byteLength).toBe(CDB_RESULT_MAX_BYTES);
        expect(new TextEncoder().encode(JSON.stringify(nested)).byteLength).toBe(CDB_RESULT_MAX_BYTES);

        expect(execute({ mutId: "multibyte", id: "multibyte", result: multibyte })).toMatchObject({ ran: true });
        expect(execute({ mutId: "escaped", id: "escaped", result: escaped })).toMatchObject({ ran: true });
        expect(execute({ mutId: "lone-surrogate", id: "lone-surrogate", result: loneSurrogate })).toMatchObject({
            ran: true,
        });
        expect(execute({ mutId: "nested", id: "nested", result: nested })).toMatchObject({ ran: true });
        expect(durableCounts()).toEqual({ domain: 4, opLog: 4 });
        expect(hookRuns).toBe(4);
    });

    test("rejects an oversized legacy replay without running the handler or hook or changing its stored row", () => {
        const mutId = "legacy-oversized";
        const id = "must-not-write";
        const result = "a".repeat(CDB_RESULT_MAX_BYTES - 1);
        storage.transactionSync(() =>
            runWrappedMutation({
                sql: adaptSqlStorage(storage.sql),
                principalId: PrincipalId("mutation-limit-user"),
                mutId: MutId(mutId),
                canonicalRequest: canonicalRequest("mutations.ts#limitedResult", { id }),
                schemaEpoch: 1,
                nowMs: 1_700_000_000_000,
                cookie: Cookie(`cookie:${mutId}`),
                run: () => ({ status: "ok", result, rowsAffected: 0 }),
            })
        );
        const storedBefore = db
            .query(
                `SELECT hex(payload_hash) AS payload_hash, hex(payload_enc) AS payload_enc,
                        committed_at, schema_epoch, touched_keys, byte_size
                 FROM _chardb_op_log WHERE mut_id = ?`
            )
            .get(mutId);

        expect(() => execute({ mutId, id, result: "handler-must-not-run" })).toThrow(
            "mutation result exceeds the 524288-byte serialized limit"
        );
        expect(handlerRuns).toBe(0);
        expect(hookRuns).toBe(0);
        expect(durableCounts()).toEqual({ domain: 0, opLog: 1 });
        expect(
            db
                .query(
                    `SELECT hex(payload_hash) AS payload_hash, hex(payload_enc) AS payload_enc,
                        committed_at, schema_epoch, touched_keys, byte_size
                 FROM _chardb_op_log WHERE mut_id = ?`
                )
                .get(mutId)
        ).toEqual(storedBefore);
    });

    test("preserves handler failures and rolls back their writes", () => {
        expect(() =>
            execute({ mutId: "handler-error", id: "handler-error", result: "unused", throwError: true })
        ).toThrow("handler failure unchanged");
        expect(handlerRuns).toBe(1);
        expect(hookRuns).toBe(0);
        expect(durableCounts()).toEqual({ domain: 0, opLog: 0 });
    });
});
