import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { CdbError } from "../errors.ts";
import { type MutationOutcome, canonicalRequest, runWrappedMutation } from "../oplog/wrapper.ts";
import { Cookie, MutId, PrincipalId, type RawJson } from "../types.ts";
import { wrapDb } from "./cdb-db-proxy.ts";
import type { AuthCtx, MutationCtx } from "./define.ts";
import { adaptSqlStorage } from "./do/sql_adapter.ts";

export type AtomicMutationDb<TSchema extends Record<string, unknown>> = DrizzleSqliteDODatabase<TSchema>;

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

export interface ExecuteAtomicMutationInput<TSchema extends Record<string, unknown>, TArgs extends RawJson, TResult> {
    readonly storage: DurableObjectStorage;
    readonly schema: TSchema;
    readonly request: AtomicMutationRequest<TArgs>;
    readonly handler: AtomicMutationHandler<TSchema, TArgs, TResult>;
    readonly cookie: string;
    readonly nowMs?: number;
}

export interface AtomicMutationResult {
    readonly cookie: Cookie;
    readonly ran: boolean;
    readonly result: RawJson;
    /** SQLite `changes()` for the handler's final data-modifying statement. */
    readonly rowsAffected: number;
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

    const cookie = Cookie(input.cookie);
    const sql = adaptSqlStorage(input.storage.sql);
    const rawDb = drizzle(input.storage, { schema: input.schema });
    const db = wrapDb(rawDb, input.request.auth);
    let wrappedResult: ReturnType<typeof runWrappedMutation<TResult>> | undefined;

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
                return {
                    status: "ok",
                    result,
                    rowsAffected: sql.changes(),
                };
            },
        });
    });

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
    };
}

function assertSynchronousHandler(handler: (...args: never[]) => unknown): void {
    if (handler.constructor?.name === "AsyncFunction") throw asyncHandlerError();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

function asyncHandlerError(): CdbError {
    return new CdbError({
        code: "CDB_INTERACTIVE_TXN_UNSUPPORTED",
        message: "mutation handlers must be synchronous; Durable Object SQLite transactions cannot span await",
        hint: "remove async/await from the mutation handler; validate and fetch external data before entering the mutation",
    });
}
