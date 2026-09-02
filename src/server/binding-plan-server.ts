import { type Column, getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { type ChardbPlanPredicateV1, type ChardbSelectPlanV1, validateChardbSelectPlanV1 } from "../binding-plan.ts";
import { CdbError } from "../errors.ts";
import { isChardbFileColumn } from "../files/index.ts";
import type { PrincipalId } from "../types.ts";
import { vshardOf } from "../vshard.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import { resolveCdbMeta } from "./cdb-table.ts";
import type { MutationAuthority } from "./define.ts";
import { projectCdbQueryResponse, resolvePartitionAuthRoute } from "./do/gateway-auth-dispatch.ts";
import type {
    CatalogMutationRpc,
    CatalogOrganizationAuthorityRouteRpc,
    CatalogOrganizationAuthorityRpc,
    CatalogUserAuthorityRpc,
    CdbBindingPlanRpc,
    CdbQueryResponse,
} from "./rpc.ts";

export const CDB_BINDING_PLAN_SERVER_MAX_LIMIT = 100;

export interface SelectPlanProfile {
    /** Maximum row limit accepted by this server-owned query path. */
    readonly maxLimit: number;
}

export const BINDING_SELECT_PLAN_PROFILE: SelectPlanProfile = Object.freeze({
    maxLimit: CDB_BINDING_PLAN_SERVER_MAX_LIMIT,
});

export interface ResolvedSelectPlan {
    readonly plan: ChardbSelectPlanV1;
    readonly table: SQLiteTable;
    readonly authority: MutationAuthority;
    readonly partitionKey: string;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `DB select plan: ${message}` });
}

function unsupported(message: string): never {
    throw new CdbError({ code: "CDB_UNSUPPORTED_FEATURE", message: `DB select plan: ${message}` });
}

function placementValues(predicate: ChardbPlanPredicateV1, column: string): ReadonlySet<string> | undefined {
    if (predicate.kind === "compare") {
        return predicate.column === column && predicate.op === "eq" && typeof predicate.value === "string"
            ? new Set([predicate.value])
            : undefined;
    }
    if (predicate.kind === "in") {
        if (predicate.column !== column || !predicate.values.every(value => typeof value === "string"))
            return undefined;
        return new Set(predicate.values as readonly string[]);
    }
    if (predicate.kind === "between" || predicate.kind === "null") return undefined;
    const children = predicate.predicates.map(child => placementValues(child, column));
    if (predicate.kind === "or") {
        if (children.some(child => child === undefined)) return undefined;
        return new Set(children.flatMap(child => [...(child as ReadonlySet<string>)]));
    }
    const constrained = children.filter((child): child is ReadonlySet<string> => child !== undefined);
    if (constrained.length === 0) return undefined;
    let intersection = new Set(constrained[0]);
    for (const child of constrained.slice(1)) {
        intersection = new Set([...intersection].filter(value => child.has(value)));
    }
    return intersection;
}

function placementForTable(table: SQLiteTable): {
    readonly authority: MutationAuthority;
    readonly column: string;
} {
    const meta = resolveCdbMeta(table);
    if (meta.tenantKind === "org") {
        if (!meta.tenantBy) invalid(`${meta.name} has no organization placement column`);
        return { authority: "organization", column: meta.tenantBy };
    }
    if (meta.tenantKind === "user") {
        if (!meta.tenantBy) invalid(`${meta.name} has no user placement column`);
        return { authority: "user", column: meta.tenantBy };
    }
    if (meta.partitionBy.kind !== "colocate" || meta.partitionBy.via.length !== 1 || !meta.partitionBy.via[0]) {
        unsupported(`${meta.name} requires one colocated global partition column`);
    }
    return { authority: "global", column: meta.partitionBy.via[0] };
}

function predicateColumns(predicate: ChardbPlanPredicateV1, output: Set<string>): void {
    if ("predicates" in predicate) {
        for (const child of predicate.predicates) predicateColumns(child, output);
        return;
    }
    output.add(predicate.column);
}

interface RuntimePlanColumn {
    readonly columnType: string;
    readonly dataType: string;
    readonly name: string;
}

function assertFullRowJsonColumns(columns: ReadonlyMap<string, RuntimePlanColumn>): void {
    for (const selected of columns.values()) {
        if (isChardbFileColumn(selected as unknown as Column)) continue;
        if (
            selected.dataType === "string" ||
            selected.dataType === "number" ||
            selected.dataType === "boolean" ||
            (selected.dataType === "json" &&
                (selected.columnType === "SQLiteTextJson" || selected.columnType === "SQLiteBlobJson"))
        ) {
            continue;
        }
        unsupported(
            `full-row output cannot encode ${selected.columnType || selected.dataType} column ${selected.name} as JSON`
        );
    }
}

function assertPredicateScalar(column: RuntimePlanColumn, value: unknown, subject: string): void {
    if (value === null) invalid(`${subject} must use isNull or isNotNull for null`);
    if (
        (column.dataType === "string" && typeof value === "string") ||
        (column.dataType === "number" && typeof value === "number") ||
        (column.dataType === "boolean" && typeof value === "boolean")
    ) {
        return;
    }
    if (column.dataType === "string" || column.dataType === "number" || column.dataType === "boolean") {
        invalid(`${subject} must be a ${column.dataType}`);
    }
    invalid(`${subject} targets unsupported ${column.dataType} column ${column.name}`);
}

function validatePredicateScalarTypes(
    predicate: ChardbPlanPredicateV1,
    columns: ReadonlyMap<string, RuntimePlanColumn>
): void {
    if ("predicates" in predicate) {
        for (const child of predicate.predicates) validatePredicateScalarTypes(child, columns);
        return;
    }
    const selected = columns.get(predicate.column);
    if (!selected) invalid(`unknown column ${predicate.column}`);
    if (predicate.kind === "null") return;
    if (predicate.kind === "compare") {
        assertPredicateScalar(selected, predicate.value, `${predicate.column} compare value`);
        return;
    }
    if (predicate.kind === "in") {
        for (const [index, value] of predicate.values.entries()) {
            assertPredicateScalar(selected, value, `${predicate.column} in value ${index}`);
        }
        return;
    }
    assertPredicateScalar(selected, predicate.lower, `${predicate.column} between lower value`);
    assertPredicateScalar(selected, predicate.upper, `${predicate.column} between upper value`);
}

/** Revalidate and bind an untrusted structured plan to the packaged runtime schema. */
export function resolveSelectPlan(
    schema: Record<string, unknown>,
    value: unknown,
    profile: SelectPlanProfile
): ResolvedSelectPlan {
    const plan = validateChardbSelectPlanV1(value);
    if (!Number.isSafeInteger(profile.maxLimit) || profile.maxLimit < 1) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "select plan profile has an invalid maximum limit" });
    }
    if (plan.limit !== undefined && plan.limit > profile.maxLimit) {
        invalid(`limit exceeds the server maximum of ${profile.maxLimit}`);
    }
    const matches = collectCdbTables(schema).filter(entry => resolveCdbMeta(entry.table).name === plan.table);
    if (matches.length !== 1)
        invalid(matches.length === 0 ? `unknown table ${plan.table}` : `table ${plan.table} is ambiguous`);
    const table = matches[0]?.table;
    if (!table) invalid(`unknown table ${plan.table}`);

    const columns = new Map(
        Object.values(getTableColumns(table)).map(column => [column.name, column as RuntimePlanColumn] as const)
    );
    const referencedColumns = new Set<string>(plan.orderBy?.map(item => item.column) ?? []);
    if (plan.where) predicateColumns(plan.where, referencedColumns);
    const unknownColumns = [...referencedColumns].filter(column => !columns.has(column));
    if (unknownColumns.length > 0) invalid(`unknown column ${unknownColumns.sort()[0]}`);
    if (plan.where) validatePredicateScalarTypes(plan.where, columns);
    assertFullRowJsonColumns(columns);

    const placement = placementForTable(table);
    if (!plan.where) {
        throw new CdbError({ code: "CDB_CROSS_PARTITION", message: "DB select plan has no exact placement predicate" });
    }
    const values = placementValues(plan.where, placement.column);
    if (values?.size !== 1) {
        throw new CdbError({
            code: "CDB_CROSS_PARTITION",
            message: "DB select plan must imply one exact string placement",
        });
    }
    const partitionKey = [...values][0];
    if (!partitionKey) invalid("placement must be a nonempty string");
    return { plan, table, authority: placement.authority, partitionKey };
}

function failure(code: ConstructorParameters<typeof CdbError>[0]["code"], message: string): CdbQueryResponse {
    return { ok: false, error: new CdbError({ code, message }).toJSON() };
}

export interface BindingPlanDispatchDeps {
    readonly schema: Record<string, unknown>;
    readonly catalog: CatalogMutationRpc &
        CatalogOrganizationAuthorityRpc &
        Partial<CatalogOrganizationAuthorityRouteRpc & CatalogUserAuthorityRpc>;
    readonly cdb: (shardId: string) => CdbBindingPlanRpc;
}

/** Resolve current authority and physical placement for one already verified binding principal. */
export async function dispatchTrustedBindingPlan(
    deps: BindingPlanDispatchDeps,
    principalId: PrincipalId,
    value: unknown
): Promise<CdbQueryResponse> {
    let resolved: ResolvedSelectPlan;
    try {
        resolved = resolveSelectPlan(deps.schema, value, BINDING_SELECT_PLAN_PROFILE);
    } catch (error) {
        if (error instanceof CdbError) return { ok: false, error: error.toJSON() };
        return failure("CDB_INVARIANT", "DB select plan resolution failed");
    }
    if (resolved.authority === "user" && resolved.partitionKey !== principalId) {
        return failure("CDB_FORBIDDEN", "user plan placement does not match the verified subject");
    }

    const vshard = Number(vshardOf([resolved.partitionKey]));
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const projected = await resolvePartitionAuthRoute(
            deps.catalog,
            resolved.authority,
            principalId,
            resolved.partitionKey,
            vshard
        );
        if (!projected.ok) return failure(projected.code, projected.message);
        const location = projected.route;
        let response: CdbQueryResponse;
        try {
            response = projectCdbQueryResponse(
                await deps.cdb(location.shardId).executePlan({
                    plan: resolved.plan,
                    placement: { authority: resolved.authority, partitionKey: resolved.partitionKey },
                    auth: projected.auth,
                    schemaEpoch: location.schemaEpoch,
                    recoveryGeneration: location.recoveryGeneration,
                    domainSchemaEpoch: location.domainSchemaEpoch,
                })
            );
        } catch {
            return failure("CDB_SHARD_UNAVAILABLE", "Cdb select plan RPC failed");
        }
        if (response.ok || response.error.code !== "CDB_STALE_EPOCH" || attempt === 1) return response;
    }
    return failure("CDB_INVARIANT", "select plan stale-route retry completed without a result");
}
