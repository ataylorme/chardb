import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { CdbError } from "../errors.ts";
import { type MutationOutcome, type SyncSql, canonicalRequest, runWrappedMutation } from "../oplog/wrapper.ts";
import { Cookie, MutId, PrincipalId, type RawJson } from "../types.ts";
import { type MutationDbTransactionGuard, wrapMutationDb } from "./cdb-db-proxy.ts";
import type { AuthCtx, MutationCtx } from "./define.ts";
import { adaptSqlStorage } from "./do/sql_adapter.ts";
import { assertCdbResultByteLimit, snapshotCdbResultByteLimit } from "./result_limits.ts";

export type AtomicMutationDb<TSchema extends Record<string, unknown>> = DrizzleSqliteDODatabase<TSchema>;

export const CDB_MUTATION_MAX_WRITE_OPERATIONS = 256;
export const CDB_MUTATION_MAX_ROWS_WRITTEN = 4_096;

export interface AtomicMutationRequest<TArgs extends RawJson> {
    readonly principalId: string;
    readonly mutId: string;
    readonly ref: string;
    readonly args: TArgs;
    readonly auth: AuthCtx;
    readonly schemaEpoch: number;
}

/**
 * A domain mutation runs synchronously inside one SQLite transaction.
 * Argument validation and routing happen before this boundary. The handler
 * and its Drizzle database live in the owning Cdb isolate.
 */
export type AtomicMutationHandler<TSchema extends Record<string, unknown>, TArgs, TResult> = (
    ctx: MutationCtx<AtomicMutationDb<TSchema>>,
    args: TArgs
) => TResult;

interface AtomicMutationWriteSet {
    /** Sorted, de-duplicated registered table names from successful write builders. */
    readonly touchedTables: readonly string[];
    /** The same synchronous SQL connection and transaction as the domain writes and op-log row. */
    readonly sql: SyncSql;
}

type AtomicMutationWriteSetHook = (writeSet: AtomicMutationWriteSet) => void;

export interface ExecuteAtomicMutationInput<TSchema extends Record<string, unknown>, TArgs extends RawJson, TResult> {
    readonly storage: DurableObjectStorage;
    readonly schema: TSchema;
    readonly request: AtomicMutationRequest<TArgs>;
    readonly handler: AtomicMutationHandler<TSchema, TArgs, TResult>;
    readonly cookie: string;
    readonly nowMs?: number;
    readonly onWriteSet?: AtomicMutationWriteSetHook;
}

export interface AtomicMutationResult {
    readonly cookie: Cookie;
    readonly ran: boolean;
    readonly result: RawJson;
    /** SQLite `changes()` for the handler's final data-modifying statement. */
    readonly rowsAffected: number;
    /** Registered cdbTables whose write builders ran in this committed mutation. */
    readonly touchedTables: readonly string[];
}

/**
 * Execute a locally registered mutation handler with the Durable Object SQL
 * database and op-log entry in the same `transactionSync` boundary.
 *
 * RPC callers never supply `handler`; the configured Cdb resolves it from its
 * isolate-local manifest and passes it into this boundary. Keeping the handler
 * parameter here also makes the atomic contract independently testable without
 * pretending a function can cross service-binding RPC.
 */
export function executeAtomicMutation<TSchema extends Record<string, unknown>, TArgs extends RawJson, TResult>(
    input: ExecuteAtomicMutationInput<TSchema, TArgs, TResult>
): AtomicMutationResult {
    assertSynchronousHandler(input.handler);
    if (input.onWriteSet) assertSynchronousWriteSetHook(input.onWriteSet);

    const cookie = Cookie(input.cookie);
    const sql = adaptSqlStorage(input.storage.sql);
    const rawDb = drizzle(input.storage, { schema: input.schema });
    const touchedTables = new Set<string>();
    const writeVolume = mutationWriteVolume(sql, touchedTables);
    const transactionGuard: MutationDbTransactionGuard = { active: true };
    const db = wrapMutationDb(
        rawDb,
        input.request.auth,
        tableName => writeVolume.record(tableName),
        () => writeVolume.beforeWrite(),
        transactionGuard
    );
    let wrappedResult: ReturnType<typeof runWrappedMutation<TResult>> | undefined;
    let committedTouchedTables: readonly string[] = [];

    try {
        input.storage.transactionSync(() => {
            wrappedResult = runWrappedMutation({
                sql,
                principalId: PrincipalId(input.request.principalId),
                mutId: MutId(input.request.mutId),
                canonicalRequest: canonicalRequest(input.request.ref, input.request.args as RawJson),
                schemaEpoch: input.request.schemaEpoch,
                nowMs: input.nowMs ?? Date.now(),
                cookie,
                run: (): MutationOutcome<TResult> => {
                    const result = input.handler({ db, auth: input.request.auth }, input.request.args);
                    if (isThenable(result)) {
                        throw asyncHandlerError();
                    }
                    writeVolume.assertWithinLimits();
                    const jsonResult = snapshotCdbResultByteLimit(
                        result as RawJson,
                        "mutation result",
                        "return less data from the mutation and read larger results with a paginated query"
                    );
                    return {
                        status: "ok",
                        result: jsonResult as TResult,
                        rowsAffected: sql.changes(),
                    };
                },
            });
            if (wrappedResult.envelope.status === "ok") {
                assertCdbResultByteLimit(
                    wrappedResult.envelope.result ?? null,
                    "mutation result",
                    "return less data from the mutation and read larger results with a paginated query"
                );
            }
            if (wrappedResult.ran && wrappedResult.envelope.status === "ok" && touchedTables.size > 0) {
                const sortedTables = Object.freeze([...touchedTables].sort());
                const hookResult = input.onWriteSet?.({ touchedTables: sortedTables, sql });
                if (isThenable(hookResult)) throw asyncWriteSetHookError();
                committedTouchedTables = sortedTables;
            }
        });
    } finally {
        transactionGuard.active = false;
    }

    if (!wrappedResult) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "atomic mutation completed without an outcome" });
    }
    if (wrappedResult.envelope.status !== "ok") {
        throw new CdbError({
            code: wrappedResult.envelope.errorCode ?? "CDB_FORBIDDEN",
            message: wrappedResult.envelope.errorMessage ?? "mutation rejected",
        });
    }
    return {
        cookie: wrappedResult.envelope.cookie,
        ran: wrappedResult.ran,
        result: wrappedResult.envelope.result ?? null,
        rowsAffected: wrappedResult.envelope.rowsAffected,
        touchedTables: committedTouchedTables,
    };
}

interface MutationWriteVolume {
    beforeWrite(): () => void;
    record(tableName: string): void;
    assertWithinLimits(): void;
}

function mutationWriteVolume(sql: SyncSql, touchedTables: Set<string>): MutationWriteVolume {
    let operations = 0;
    let rows = 0n;
    let violation: CdbError | undefined;
    let totalChangesBeforeWrite: bigint | undefined;

    const assertWithinLimits = (): void => {
        if (violation) throw violation;
    };

    const readTotalChanges = (): bigint => {
        let rawTotal: number | bigint;
        try {
            if (!sql.totalChanges) throw new TypeError("SQL adapter does not expose total_changes()");
            rawTotal = sql.totalChanges();
        } catch (cause) {
            violation ??= new CdbError({
                code: "CDB_INVARIANT",
                message: "could not measure mutation write volume",
                cause,
            });
            assertWithinLimits();
            return 0n;
        }
        if (
            (typeof rawTotal === "number" && (!Number.isSafeInteger(rawTotal) || rawTotal < 0)) ||
            (typeof rawTotal === "bigint" && rawTotal < 0n)
        ) {
            violation ??= new CdbError({
                code: "CDB_INVARIANT",
                message: "mutation write volume returned an invalid total-change count",
            });
            assertWithinLimits();
        }
        return BigInt(rawTotal);
    };

    return {
        beforeWrite() {
            assertWithinLimits();
            if (operations >= CDB_MUTATION_MAX_WRITE_OPERATIONS) {
                violation = new CdbError({
                    code: "CDB_INVARIANT",
                    message: `mutation exceeds the ${CDB_MUTATION_MAX_WRITE_OPERATIONS}-operation write limit`,
                    hint: "split the mutation into smaller atomic operations",
                });
                assertWithinLimits();
            }
            if (totalChangesBeforeWrite !== undefined) {
                violation = new CdbError({
                    code: "CDB_INVARIANT",
                    message: "mutation write-volume measurement overlapped another statement",
                });
                assertWithinLimits();
            }
            totalChangesBeforeWrite = readTotalChanges();
            return () => {
                totalChangesBeforeWrite = undefined;
            };
        },
        record(tableName) {
            touchedTables.add(tableName);
            operations++;
            const before = totalChangesBeforeWrite;
            const after = readTotalChanges();
            totalChangesBeforeWrite = undefined;
            if (before === undefined || after < before) {
                violation ??= new CdbError({
                    code: "CDB_INVARIANT",
                    message: "mutation write volume returned an invalid total-change interval",
                });
                assertWithinLimits();
                return;
            }
            rows += after - before;
            if (rows > BigInt(CDB_MUTATION_MAX_ROWS_WRITTEN)) {
                violation ??= new CdbError({
                    code: "CDB_INVARIANT",
                    message: `mutation exceeds the ${CDB_MUTATION_MAX_ROWS_WRITTEN}-row write limit`,
                    hint: "split the mutation into smaller atomic operations",
                });
            }
            assertWithinLimits();
        },
        assertWithinLimits,
    };
}

function assertSynchronousHandler(handler: (...args: never[]) => unknown): void {
    if (handler.constructor?.name === "AsyncFunction") throw asyncHandlerError();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    const seen = new WeakSet<object>();
    let current: object | null = value;
    let depth = 0;
    while (current !== null) {
        if (seen.has(current) || depth >= 100) {
            return false;
        }
        seen.add(current);
        depth += 1;
        const descriptor = Object.getOwnPropertyDescriptor(current, "then");
        if (descriptor) return !("value" in descriptor) || typeof descriptor.value === "function";
        current = Object.getPrototypeOf(current);
    }
    return false;
}

function asyncHandlerError(): CdbError {
    return new CdbError({
        code: "CDB_INTERACTIVE_TXN_UNSUPPORTED",
        message: "mutation handlers must be synchronous; Durable Object SQLite transactions cannot span await",
        hint: "remove async/await from the mutation handler; validate and fetch external data before entering the mutation",
    });
}

function assertSynchronousWriteSetHook(hook: AtomicMutationWriteSetHook): void {
    if (hook.constructor?.name === "AsyncFunction") throw asyncWriteSetHookError();
}

function asyncWriteSetHookError(): CdbError {
    return new CdbError({
        code: "CDB_INTERACTIVE_TXN_UNSUPPORTED",
        message: "atomic write-set hooks must be synchronous; Durable Object SQLite transactions cannot span await",
    });
}
