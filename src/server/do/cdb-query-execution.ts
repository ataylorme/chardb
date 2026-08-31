import { drizzle } from "drizzle-orm/durable-sqlite";
import { intervalsForColumnPredicate } from "../../drizzle/walker.ts";
import { CdbError } from "../../errors.ts";
import { wireIntervalsCover } from "../../intervals_wire.ts";
import type { ChardbRef, RawJson } from "../../types.ts";
import type { CdbIntent } from "../../wire.ts";
import { executeResolvedSelectPlan } from "../binding-plan-execution.ts";
import { BINDING_SELECT_PLAN_PROFILE, resolveSelectPlan } from "../binding-plan-server.ts";
import { type QueryReadRangeObservation, wrapQueryDb } from "../cdb-db-proxy.ts";
import type { AuthCtx } from "../define.ts";
import { CDB_QUERY_RESULT_MAX_ROWS, snapshotCdbResultByteLimit } from "../result_limits.ts";
import type { CdbPlacement } from "../rpc.ts";

function snapshotQueryResult(result: unknown, subject: string): RawJson {
    const owned = snapshotCdbResultByteLimit(
        result as RawJson,
        subject,
        "select fewer rows or columns, or paginate the result"
    );
    if (Array.isArray(owned) && owned.length > CDB_QUERY_RESULT_MAX_ROWS) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `${subject} exceeds the ${CDB_QUERY_RESULT_MAX_ROWS}-row limit`,
            hint: "add a query limit or paginate the result",
        });
    }
    return owned;
}

function assertIntentCoversReads(
    ref: ChardbRef,
    declaredTables: readonly string[],
    readTables: ReadonlySet<string>
): void {
    const declared = new Set(declaredTables);
    const omitted = [...readTables].filter(tableName => !declared.has(tableName)).sort();
    if (omitted.length === 0) return;
    throw new CdbError({
        code: "CDB_INVARIANT",
        message: `query ${ref} read undeclared cdbTable${omitted.length === 1 ? "" : "s"}: ${omitted.join(", ")}`,
        hint: "add every table read by the handler to intent.tables",
    });
}

function assertIntentCoversRanges(
    ref: ChardbRef,
    intent: CdbIntent,
    observations: ReadonlyMap<object, QueryReadRangeObservation>
): void {
    if (!intent.intervals) return;
    for (const observation of observations.values()) {
        for (const declared of intent.intervals.filter(bundle => bundle.table === observation.tableName)) {
            const observed = intervalsForColumnPredicate(
                observation.predicate,
                observation.tableName,
                declared.indexName
            );
            if (wireIntervalsCover(declared.intervals, observed)) continue;
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: `query ${ref} read outside declared interval for ${declared.table}.${declared.indexName}`,
                hint: "widen intent.intervals to cover every range the handler and row policy can read",
            });
        }
    }
}

interface QueryExecutionInput {
    readonly storage: DurableObjectStorage;
    readonly schema: Record<string, unknown>;
    readonly auth: AuthCtx;
    readonly placement: CdbPlacement | undefined;
    readonly subject: string;
    readonly ref?: ChardbRef | undefined;
    readonly intent?: CdbIntent | undefined;
    readonly observeReads?: boolean | undefined;
}

async function executeObservedQuery(
    input: QueryExecutionInput,
    execute: (db: object) => Promise<unknown>
): Promise<RawJson> {
    const observe = input.observeReads ?? (input.intent !== undefined && input.ref !== undefined);
    const readTables = new Set<string>();
    const readRanges = new Map<object, QueryReadRangeObservation>();
    const database = wrapQueryDb(
        drizzle(input.storage, { schema: input.schema }),
        input.auth,
        observe ? tableName => readTables.add(tableName) : undefined,
        observe ? observation => readRanges.set(observation.token, observation) : undefined,
        input.placement
    );
    const result = snapshotQueryResult(await execute(database), input.subject);
    if (input.intent && input.ref) {
        assertIntentCoversReads(input.ref, input.intent.tables, readTables);
        assertIntentCoversRanges(input.ref, input.intent, readRanges);
    }
    return result;
}

export interface CdbSelectPlanExecutionInput extends QueryExecutionInput {
    readonly plan: unknown;
    readonly placement: CdbPlacement;
}

/** Revalidate and execute one canonical select through the policy-wrapped shard database. */
export async function executeCdbSelectPlan(input: CdbSelectPlanExecutionInput): Promise<RawJson> {
    const resolved = resolveSelectPlan(input.schema, input.plan, BINDING_SELECT_PLAN_PROFILE);
    if (resolved.authority !== input.placement.authority || resolved.partitionKey !== input.placement.partitionKey) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: "select plan placement changed before execution",
        });
    }
    if (resolved.authority === "organization" && input.auth.tenantId !== resolved.partitionKey) {
        throw new CdbError({ code: "CDB_FORBIDDEN", message: "select plan organization authority is stale" });
    }
    if (resolved.authority === "user" && input.auth.userId !== resolved.partitionKey) {
        throw new CdbError({ code: "CDB_FORBIDDEN", message: "select plan user authority is stale" });
    }
    return executeObservedQuery(input, db => executeResolvedSelectPlan(db, resolved));
}

export interface CdbQueryHandlerExecutionInput extends QueryExecutionInput {
    readonly invoke: (db: object) => Promise<unknown>;
}

/** Execute a registered handler with read-only access and enforce its declared read intent. */
export function executeCdbQueryHandler(input: CdbQueryHandlerExecutionInput): Promise<RawJson> {
    return executeObservedQuery({ ...input, observeReads: true }, input.invoke);
}
