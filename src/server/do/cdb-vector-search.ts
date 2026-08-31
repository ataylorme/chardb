import { type SQL, and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../../errors.ts";
import type { RawJson } from "../../types.ts";
import { collectCdbTables } from "../cdb-table-registry.ts";
import { resolveCdbMeta } from "../cdb-table.ts";
import type { AuthCtx } from "../define.ts";
import type { RegisteredVectorQueryPlan } from "../registered-query-plan.ts";
import {
    type VectorResourceV1,
    cdbVectorResourceId,
    collectSchemaResourceDescriptors,
    isChardbVectorResourceDescriptor,
} from "../resource-descriptors.ts";
import { assertCdbResultByteLimit } from "../result_limits.ts";
import { executeCdbQueryHandler } from "./cdb-query-execution.ts";
import { CdbVectorOutboxStore } from "./cdb-vector-outbox-store.ts";
import {
    type CdbValidatedVectorMatch,
    type CdbVectorizeMatch,
    type CdbVectorizeSearchIndex,
    queryCdbVectorizeCandidates,
    validateCdbVectorMatches,
} from "./cdb-vectorize-adapter.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

interface RuntimeColumn {
    readonly name: string;
    readonly dataType: string;
}

interface PolicyReadBuilder {
    where(predicate: SQL): PolicyReadBuilder;
    limit(value: number): PolicyReadBuilder;
    all(): Promise<Record<string, unknown>[]>;
}

interface PolicyReadDb {
    select(): { from(table: SQLiteTable): PolicyReadBuilder };
}

export interface CdbVectorSearchResult {
    readonly rowPk: string;
    readonly score: number;
}

function primaryValue(rowId: string, column: RuntimeColumn): string | number | boolean | undefined {
    if (column.dataType === "string") return rowId;
    if (column.dataType === "number") {
        const value = Number(rowId);
        return Number.isFinite(value) && !Object.is(value, -0) && String(value) === rowId ? value : undefined;
    }
    if (column.dataType === "boolean") {
        if (rowId === "1") return true;
        if (rowId === "0") return false;
    }
    return undefined;
}

function primaryRowId(value: unknown, column: RuntimeColumn): string | undefined {
    if (column.dataType === "string") return typeof value === "string" ? value : undefined;
    if (column.dataType === "number") {
        return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) ? String(value) : undefined;
    }
    if (column.dataType === "boolean") {
        if (value === true) return "1";
        if (value === false) return "0";
    }
    return undefined;
}

function logicalVectorId(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : null;
}

function configuredResource(
    schema: Record<string, unknown>,
    requested: VectorResourceV1
): { readonly resource: VectorResourceV1; readonly table: SQLiteTable } {
    const resource = collectSchemaResourceDescriptors(schema)
        .filter(isChardbVectorResourceDescriptor)
        .find(candidate => candidate.table === requested.table && candidate.column === requested.column);
    if (!resource || cdbVectorResourceId(resource) !== cdbVectorResourceId(requested)) {
        throw new CdbError({ code: "CDB_INVALID_COLUMN", message: "vector locator is not configured" });
    }
    const matches = collectCdbTables(schema).filter(entry => resolveCdbMeta(entry.table).name === resource.table);
    const table = matches.length === 1 ? matches[0]?.table : undefined;
    if (!table) throw new CdbError({ code: "CDB_INVARIANT", message: "vector table is unavailable" });
    return { resource, table };
}

/**
 * Validate untrusted Vectorize candidates against current SQLite heads and the
 * same row and column policy executor used by SQL and file reads.
 */
export async function resolveCdbVectorSearchMatches(input: {
    readonly storage: DurableObjectStorage;
    readonly schema: Record<string, unknown>;
    readonly auth: AuthCtx;
    readonly organizationId: string;
    readonly resource: VectorResourceV1;
    readonly matches: readonly CdbVectorizeMatch[];
    readonly limit: number;
    /** Keep enabled when the validated internal match shape crosses RPC. */
    readonly enforceInternalResultByteLimit?: boolean;
}): Promise<readonly CdbValidatedVectorMatch[]> {
    if (input.auth.tenantId !== input.organizationId || !input.auth.userId) {
        throw new CdbError({ code: "CDB_FORBIDDEN", message: "vector organization authority is invalid" });
    }
    const { resource, table } = configuredResource(input.schema, input.resource);
    const resourceId = cdbVectorResourceId(resource);
    const columns = Object.entries(getTableColumns(table)) as readonly [string, RuntimeColumn][];
    const primary = columns.find(([, column]) => column.name === resource.primaryKey);
    const organization = columns.find(([, column]) => column.name === resource.organizationColumn);
    const vector = columns.find(([, column]) => column.name === resource.column);
    if (!primary || !organization || !vector) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "vector locator columns are unavailable" });
    }
    const heads = new CdbVectorOutboxStore(adaptSqlStorage(input.storage.sql));
    const candidates = validateCdbVectorMatches({
        matches: input.matches,
        organizationId: input.organizationId,
        resourceId,
        limit: input.limit,
        readHead: vectorId => {
            const head = heads.read(vectorId);
            return head?.dimensions === resource.dimensions ? head : null;
        },
    });
    const candidateVersions = new Map(
        candidates.map(candidate => [candidate.vectorId, heads.read(candidate.vectorId)?.version] as const)
    );
    const parsedCandidates = candidates.flatMap(candidate => {
        const parsedPrimary = primaryValue(candidate.rowPk, primary[1]);
        return parsedPrimary === undefined ? [] : [{ candidate, parsedPrimary }];
    });
    const visibleRows =
        parsedCandidates.length === 0
            ? []
            : await executeCdbQueryHandler({
                  storage: input.storage,
                  schema: input.schema,
                  auth: input.auth,
                  placement: { authority: "organization", partitionKey: input.organizationId },
                  subject: "vector policy candidate read",
                  invoke: async database => {
                      const rows = await (database as PolicyReadDb)
                          .select()
                          .from(table)
                          .where(
                              and(
                                  inArray(
                                      primary[1] as never,
                                      parsedCandidates.map(candidate => candidate.parsedPrimary) as never
                                  ),
                                  eq(organization[1] as never, input.organizationId)
                              ) as SQL
                          )
                          .limit(parsedCandidates.length)
                          .all();
                      return rows.flatMap(row => {
                          const rowPk = primaryRowId(row[primary[0]], primary[1]);
                          const vectorId = logicalVectorId(row[vector[0]]);
                          return rowPk === undefined || vectorId === null ? [] : [{ rowPk, vectorId }];
                      });
                  },
              });
    const visibleIds = new Map(
        (visibleRows as readonly RawJson[]).flatMap(row => {
            if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
            return typeof row.rowPk === "string" && typeof row.vectorId === "string"
                ? [[row.rowPk, row.vectorId] as const]
                : [];
        })
    );
    const accepted: CdbValidatedVectorMatch[] = [];
    for (const { candidate } of parsedCandidates) {
        const visibleId = visibleIds.get(candidate.rowPk);
        if (visibleId !== candidate.vectorId) continue;
        const current = heads.read(candidate.vectorId);
        if (
            current?.organizationId === input.organizationId &&
            current.resourceId === resourceId &&
            current.rowPk === candidate.rowPk &&
            current.dimensions === resource.dimensions &&
            current.state === "ready" &&
            current.version === current.deliveredVersion &&
            current.version === candidateVersions.get(candidate.vectorId)
        ) {
            accepted.push(candidate);
        }
    }
    if (input.enforceInternalResultByteLimit !== false) {
        assertCdbResultByteLimit(
            accepted as unknown as RawJson,
            "vector search result",
            "request fewer vector matches or reduce authoritative SQLite metadata"
        );
    }
    return Object.freeze(accepted);
}

/** Execute one compiled organization search without exposing Vectorize ids or stored metadata. */
export async function executeRegisteredVectorQueryPlan(input: {
    readonly index: CdbVectorizeSearchIndex;
    readonly storage: DurableObjectStorage;
    readonly schema: Record<string, unknown>;
    readonly auth: AuthCtx;
    readonly plan: RegisteredVectorQueryPlan;
}): Promise<readonly CdbVectorSearchResult[]> {
    const candidates = await queryCdbVectorizeCandidates({
        index: input.index,
        resource: input.plan.resource,
        organizationId: input.plan.partitionKey,
        values: input.plan.values,
        limit: input.plan.limit,
    });
    const matches = await resolveCdbVectorSearchMatches({
        storage: input.storage,
        schema: input.schema,
        auth: input.auth,
        organizationId: input.plan.partitionKey,
        resource: input.plan.resource,
        matches: candidates,
        limit: input.plan.limit,
        enforceInternalResultByteLimit: false,
    });
    const result = Object.freeze(
        matches.map(match =>
            Object.freeze({
                rowPk: match.rowPk,
                score: match.score,
            })
        )
    );
    assertCdbResultByteLimit(
        result as unknown as RawJson,
        "registered vector search result",
        "request fewer vector matches"
    );
    return result;
}
