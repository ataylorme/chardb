import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, lte } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import { CdbError } from "../../src/errors.ts";
import { OP_LOG_DDL } from "../../src/oplog/schema.ts";
import { canonicalRequest, runWrappedMutation } from "../../src/oplog/wrapper.ts";
import {
    CDB_MUTATION_MAX_ROWS_WRITTEN,
    CDB_MUTATION_MAX_WRITE_OPERATIONS,
    executeAtomicMutation,
} from "../../src/server/atomic-mutation.ts";
import { globalScope } from "../../src/server/cdb-tenant.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { CDB_RESULT_MAX_BYTES } from "../../src/server/result_limits.ts";
import { Cookie, MutId, PrincipalId, type RawJson } from "../../src/types.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database, onExec?: (query: string) => void) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            onExec?.(query);
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
        ordinal: integer("ordinal").notNull(),
    },
    { partitionBy: "id", roles: { member: { create: "*", read: "*", update: "*", delete: true } } }
);
const schema = { entries };

describe("atomic mutation limits", () => {
    let db: Database;
    let storage: DurableObjectStorage;
    let handlerRuns: number;
    let hookRuns: number;
    let domainWriteExecutions: number;

    beforeEach(() => {
        db = new Database(":memory:");
        for (const statement of OP_LOG_DDL.split(";")
            .map(value => value.trim())
            .filter(Boolean)) {
            db.run(statement);
        }
        db.run(
            "CREATE TABLE mutation_limit_entries (id TEXT PRIMARY KEY, value TEXT NOT NULL, ordinal INTEGER NOT NULL)"
        );
        domainWriteExecutions = 0;
        storage = {
            sql: sqlStorage(db, query => {
                const normalized = query.replaceAll('"', "").trim().toLowerCase();
                if (
                    normalized.startsWith("insert into mutation_limit_entries") ||
                    normalized.startsWith("update mutation_limit_entries") ||
                    normalized.startsWith("delete from mutation_limit_entries")
                ) {
                    domainWriteExecutions++;
                }
            }),
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
        readonly placement?: { readonly authority: "global"; readonly partitionKey: string };
        throwError?: boolean;
        mutateResultInMicrotask?: boolean;
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
            ...(args.placement ? { placement: args.placement } : {}),
            handler: ({ db: mutationDb }, request) => {
                handlerRuns++;
                mutationDb.insert(entries).values({ id: request.id, value: "written", ordinal: 0 }).run();
                if (args.throwError) throw new Error("handler failure unchanged");
                if (args.mutateResultInMicrotask) {
                    queueMicrotask(() => {
                        (args.result as { value: string }).value = "mutated-after-transaction";
                    });
                }
                return args.result;
            },
            onWriteSet: () => {
                hookRuns++;
            },
        });
    }

    test("threads global placement into the transaction database fence", () => {
        const allowed = execute({
            mutId: "global-placement-exact",
            id: "partition-a",
            result: null,
            placement: { authority: "global", partitionKey: "partition-a" },
        });
        expect(allowed).toMatchObject({ ran: true, touchedTables: ["mutation_limit_entries"] });
        expect(durableCounts()).toEqual({ domain: 1, opLog: 1 });

        let caught: unknown;
        try {
            execute({
                mutId: "global-placement-mismatch",
                id: "partition-b",
                result: null,
                placement: { authority: "global", partitionKey: "partition-a" },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CdbError);
        expect(caught).toMatchObject({ code: "CDB_FORBIDDEN" });
        expect(durableCounts()).toEqual({ domain: 1, opLog: 1 });
    });

    function durableCounts(): { readonly domain: number; readonly opLog: number } {
        const domain = db.query("SELECT COUNT(*) AS count FROM mutation_limit_entries").get() as { count: number };
        const opLog = db.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get() as { count: number };
        return { domain: domain.count, opLog: opLog.count };
    }

    function expectTerminalInvariant(run: () => unknown, message: string): void {
        let captured: unknown;
        try {
            run();
        } catch (error) {
            captured = error;
        }
        expect(captured).toBeInstanceOf(CdbError);
        expect(captured).toMatchObject({ code: "CDB_INVARIANT", retryable: false, message });
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

    test("owns a fresh result before a retained object mutates in a microtask", async () => {
        const retained = { value: "original" };
        const request = {
            mutId: "owned-result",
            id: "owned-result",
            result: retained,
            mutateResultInMicrotask: true,
        };
        const first = execute(request);
        await Promise.resolve();
        expect(retained).toEqual({ value: "mutated-after-transaction" });
        expect(first).toMatchObject({ ran: true, result: { value: "original" } });

        expect(execute(request)).toMatchObject({ ran: false, result: { value: "original" } });
        expect(handlerRuns).toBe(1);
    });

    test("snapshots object and array Proxy results once without property reads", () => {
        for (const [index, target] of [{ kind: "object", nested: { value: 1 } }, ["array", { value: 2 }]].entries()) {
            let ownKeysRuns = 0;
            let getterRuns = 0;
            const result = new Proxy(target, {
                ownKeys(value) {
                    ownKeysRuns += 1;
                    return Reflect.ownKeys(value);
                },
                getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
                get() {
                    getterRuns += 1;
                    throw new Error("mutation result getters must not run");
                },
            }) as unknown as RawJson;
            const expected = index === 0 ? { kind: "object", nested: { value: 1 } } : ["array", { value: 2 }];
            const beforeRuns = handlerRuns;
            const request = { mutId: `proxy-result-${index}`, id: `proxy-result-${index}`, result };

            expect(execute(request)).toMatchObject({ ran: true, result: expected });
            expect(execute(request)).toMatchObject({ ran: false, result: expected });
            expect(ownKeysRuns).toBe(1);
            expect(getterRuns).toBe(0);
            expect(handlerRuns).toBe(beforeRuns + 1);
        }
    });

    test("rejects a cyclic Proxy prototype without hanging", () => {
        let cyclic!: RawJson;
        cyclic = new Proxy(
            {},
            {
                getPrototypeOf: () => cyclic as object,
            }
        ) as RawJson;
        let captured: unknown;
        try {
            execute({ mutId: "cyclic-prototype", id: "cyclic-prototype", result: cyclic });
        } catch (error) {
            captured = error;
        }
        expect(captured).toMatchObject({
            code: "CDB_INVARIANT",
            message: "mutation result is not JSON-compatible",
        });
        expect(durableCounts()).toEqual({ domain: 0, opLog: 0 });
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

    function executeWriteVolume(args: {
        readonly mutId: string;
        readonly handler: Parameters<typeof executeAtomicMutation<typeof schema, RawJson, RawJson>>[0]["handler"];
    }) {
        return executeAtomicMutation({
            storage,
            schema,
            request: {
                principalId: "mutation-limit-user",
                mutId: args.mutId,
                ref: "mutations.ts#writeVolume",
                args: {},
                auth: { userId: "mutation-limit-user", roles: ["member"], claims: {} },
                schemaEpoch: 1,
            },
            cookie: `cookie:${args.mutId}`,
            nowMs: 1_700_000_000_000,
            handler: args.handler,
            onWriteSet: () => {
                hookRuns++;
            },
        });
    }

    test("accepts exactly 256 successful write statements and rejects the next one atomically", () => {
        const atLimit = executeWriteVolume({
            mutId: "operation-boundary",
            handler: ({ db: mutationDb }) => {
                for (let ordinal = 0; ordinal < CDB_MUTATION_MAX_WRITE_OPERATIONS; ordinal++) {
                    mutationDb
                        .insert(entries)
                        .values({ id: `operation-${ordinal}`, value: "written", ordinal })
                        .run();
                }
                return null;
            },
        });
        expect(atLimit).toMatchObject({ ran: true, touchedTables: ["mutation_limit_entries"] });
        expect(durableCounts()).toEqual({ domain: CDB_MUTATION_MAX_WRITE_OPERATIONS, opLog: 1 });
        expect(hookRuns).toBe(1);

        expectTerminalInvariant(
            () =>
                executeWriteVolume({
                    mutId: "operation-over",
                    handler: ({ db: mutationDb }) => {
                        for (let ordinal = 0; ordinal <= CDB_MUTATION_MAX_WRITE_OPERATIONS; ordinal++) {
                            mutationDb
                                .insert(entries)
                                .values({ id: `operation-over-${ordinal}`, value: "written", ordinal })
                                .run();
                        }
                        return null;
                    },
                }),
            `mutation exceeds the ${CDB_MUTATION_MAX_WRITE_OPERATIONS}-operation write limit`
        );
        expect(durableCounts()).toEqual({ domain: CDB_MUTATION_MAX_WRITE_OPERATIONS, opLog: 1 });
        expect(hookRuns).toBe(1);
    });

    test("counts insert batches plus update and delete affected rows at the 4096-row boundary", () => {
        const rows = Array.from({ length: CDB_MUTATION_MAX_ROWS_WRITTEN }, (_, ordinal) => ({
            id: `row-${ordinal}`,
            value: "initial",
            ordinal,
        }));
        const atLimit = executeWriteVolume({
            mutId: "row-boundary",
            handler: ({ db: mutationDb }) => {
                mutationDb.insert(entries).values(rows).run();
                return null;
            },
        });
        expect(atLimit).toMatchObject({ ran: true, rowsAffected: CDB_MUTATION_MAX_ROWS_WRITTEN });
        expect(durableCounts()).toEqual({ domain: CDB_MUTATION_MAX_ROWS_WRITTEN, opLog: 1 });

        expectTerminalInvariant(
            () =>
                executeWriteVolume({
                    mutId: "row-over-update",
                    handler: ({ db: mutationDb }) => {
                        mutationDb.update(entries).set({ value: "updated" }).run();
                        mutationDb
                            .insert(entries)
                            .values({ id: "row-over-update", value: "written", ordinal: CDB_MUTATION_MAX_ROWS_WRITTEN })
                            .run();
                        return null;
                    },
                }),
            `mutation exceeds the ${CDB_MUTATION_MAX_ROWS_WRITTEN}-row write limit`
        );
        expect(db.query("SELECT COUNT(*) AS count FROM mutation_limit_entries WHERE value = 'updated'").get()).toEqual({
            count: 0,
        });
        expect(durableCounts()).toEqual({ domain: CDB_MUTATION_MAX_ROWS_WRITTEN, opLog: 1 });

        expectTerminalInvariant(
            () =>
                executeWriteVolume({
                    mutId: "row-over-delete",
                    handler: ({ db: mutationDb }) => {
                        mutationDb
                            .delete(entries)
                            .where(lte(entries.ordinal, CDB_MUTATION_MAX_ROWS_WRITTEN - 1))
                            .run();
                        mutationDb
                            .insert(entries)
                            .values({ id: "row-over-delete", value: "written", ordinal: CDB_MUTATION_MAX_ROWS_WRITTEN })
                            .run();
                        return null;
                    },
                }),
            `mutation exceeds the ${CDB_MUTATION_MAX_ROWS_WRITTEN}-row write limit`
        );
        expect(durableCounts()).toEqual({ domain: CDB_MUTATION_MAX_ROWS_WRITTEN, opLog: 1 });
    });

    test("blocks every write after a caught limit violation and rolls back only the 256 executed statements", () => {
        let caughtLimitErrors = 0;
        expectTerminalInvariant(
            () =>
                executeWriteVolume({
                    mutId: "caught-limit",
                    handler: ({ db: mutationDb }) => {
                        mutationDb.insert(entries).values({ id: "caught-limit", value: "initial", ordinal: 0 }).run();
                        for (let ordinal = 0; ordinal < CDB_MUTATION_MAX_WRITE_OPERATIONS + 32; ordinal++) {
                            try {
                                mutationDb
                                    .update(entries)
                                    .set({ value: `caught-${ordinal}` })
                                    .where(eq(entries.id, "caught-limit"))
                                    .run();
                            } catch (error) {
                                expect(error).toBeInstanceOf(CdbError);
                                caughtLimitErrors++;
                            }
                        }
                        return null;
                    },
                }),
            `mutation exceeds the ${CDB_MUTATION_MAX_WRITE_OPERATIONS}-operation write limit`
        );
        expect(caughtLimitErrors).toBe(33);
        expect(domainWriteExecutions).toBe(CDB_MUTATION_MAX_WRITE_OPERATIONS);
        expect(db.query("SELECT value FROM mutation_limit_entries WHERE id = 'caught-limit'").get()).toBeNull();
        expect(db.query("SELECT mut_id FROM _chardb_op_log WHERE mut_id = 'caught-limit'").get()).toBeNull();
        expect(hookRuns).toBe(0);
    });

    test("blocks later SQL after a handler catches the post-execution row limit", () => {
        const rows = Array.from({ length: CDB_MUTATION_MAX_ROWS_WRITTEN + 1 }, (_, ordinal) => ({
            id: `caught-row-${ordinal}`,
            value: "initial",
            ordinal,
        }));
        let caughtLimitErrors = 0;
        expectTerminalInvariant(
            () =>
                executeWriteVolume({
                    mutId: "caught-row-limit",
                    handler: ({ db: mutationDb }) => {
                        try {
                            mutationDb.insert(entries).values(rows).run();
                        } catch (error) {
                            expect(error).toBeInstanceOf(CdbError);
                            caughtLimitErrors++;
                        }
                        for (let ordinal = 0; ordinal < 3; ordinal++) {
                            try {
                                mutationDb
                                    .insert(entries)
                                    .values({ id: `blocked-after-row-${ordinal}`, value: "blocked", ordinal })
                                    .run();
                            } catch (error) {
                                expect(error).toBeInstanceOf(CdbError);
                                caughtLimitErrors++;
                            }
                        }
                        return null;
                    },
                }),
            `mutation exceeds the ${CDB_MUTATION_MAX_ROWS_WRITTEN}-row write limit`
        );
        expect(caughtLimitErrors).toBe(4);
        expect(domainWriteExecutions).toBe(1);
        expect(durableCounts()).toEqual({ domain: 0, opLog: 0 });
        expect(hookRuns).toBe(0);
    });

    test("counts trigger fanout at 4096 and poisons later writes after 4097", () => {
        db.run("CREATE TABLE mutation_limit_audit (id TEXT PRIMARY KEY)");
        db.run(`CREATE TRIGGER mutation_limit_audit_each
                AFTER INSERT ON mutation_limit_entries
                BEGIN
                    INSERT INTO mutation_limit_audit (id) VALUES ('audit:' || NEW.id);
                END`);
        db.run(`CREATE TRIGGER mutation_limit_audit_extra
                AFTER INSERT ON mutation_limit_entries
                WHEN NEW.id = 'fanout-over-extra'
                BEGIN
                    INSERT INTO mutation_limit_audit (id) VALUES ('extra:' || NEW.id);
                END`);

        const boundaryRows = Array.from({ length: CDB_MUTATION_MAX_ROWS_WRITTEN / 2 }, (_, ordinal) => ({
            id: `fanout-boundary-${ordinal}`,
            value: "boundary",
            ordinal,
        }));
        expect(
            executeWriteVolume({
                mutId: "fanout-boundary",
                handler: ({ db: mutationDb }) => {
                    mutationDb.insert(entries).values(boundaryRows).run();
                    return null;
                },
            })
        ).toMatchObject({ ran: true, rowsAffected: boundaryRows.length });
        expect(durableCounts()).toEqual({ domain: boundaryRows.length, opLog: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM mutation_limit_audit").get()).toEqual({
            count: boundaryRows.length,
        });

        const overRows = Array.from({ length: CDB_MUTATION_MAX_ROWS_WRITTEN / 2 }, (_, ordinal) => ({
            id: ordinal === 0 ? "fanout-over-extra" : `fanout-over-${ordinal}`,
            value: "over",
            ordinal,
        }));
        domainWriteExecutions = 0;
        let caughtLimitErrors = 0;
        expectTerminalInvariant(
            () =>
                executeWriteVolume({
                    mutId: "fanout-over",
                    handler: ({ db: mutationDb }) => {
                        try {
                            mutationDb.insert(entries).values(overRows).run();
                        } catch (error) {
                            expect(error).toBeInstanceOf(CdbError);
                            caughtLimitErrors++;
                        }
                        for (let ordinal = 0; ordinal < 3; ordinal++) {
                            try {
                                mutationDb
                                    .insert(entries)
                                    .values({ id: `fanout-blocked-${ordinal}`, value: "blocked", ordinal })
                                    .run();
                            } catch (error) {
                                expect(error).toBeInstanceOf(CdbError);
                                caughtLimitErrors++;
                            }
                        }
                        return null;
                    },
                }),
            `mutation exceeds the ${CDB_MUTATION_MAX_ROWS_WRITTEN}-row write limit`
        );
        expect(caughtLimitErrors).toBe(4);
        expect(domainWriteExecutions).toBe(1);
        expect(durableCounts()).toEqual({ domain: boundaryRows.length, opLog: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM mutation_limit_audit").get()).toEqual({
            count: boundaryRows.length,
        });
        expect(hookRuns).toBe(1);
    });

    test("replay bypasses the handler and write-volume accounting", () => {
        const first = executeWriteVolume({
            mutId: "write-volume-replay",
            handler: ({ db: mutationDb }) => {
                mutationDb.insert(entries).values({ id: "write-volume-replay", value: "stored", ordinal: 0 }).run();
                return { stored: true };
            },
        });
        expect(first).toMatchObject({ ran: true, result: { stored: true } });
        expect(hookRuns).toBe(1);

        let replayHandlerRuns = 0;
        const replay = executeWriteVolume({
            mutId: "write-volume-replay",
            handler: () => {
                replayHandlerRuns++;
                throw new Error("replay handler must not run");
            },
        });
        expect(replay).toMatchObject({ ran: false, result: { stored: true }, touchedTables: [] });
        expect(replayHandlerRuns).toBe(0);
        expect(hookRuns).toBe(1);
    });
});
