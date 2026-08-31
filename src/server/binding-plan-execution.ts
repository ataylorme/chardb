import {
    type SQL,
    and,
    asc,
    between,
    desc,
    eq,
    getTableColumns,
    gt,
    gte,
    inArray,
    isNotNull,
    isNull,
    lt,
    lte,
    ne,
    or,
} from "drizzle-orm";
import type { ChardbPlanPredicateV1 } from "../binding-plan.ts";
import { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";
import type { ResolvedSelectPlan } from "./binding-plan-server.ts";

type ColumnMap = ReadonlyMap<string, unknown>;

function column(columns: ColumnMap, name: string): unknown {
    const value = columns.get(name);
    if (!value)
        throw new CdbError({ code: "CDB_INVALID_ARGS", message: `DB select plan references unknown column ${name}` });
    return value;
}

function predicateSql(predicate: ChardbPlanPredicateV1, columns: ColumnMap): SQL {
    if (predicate.kind === "compare") {
        const left = column(columns, predicate.column) as never;
        switch (predicate.op) {
            case "eq":
                return eq(left, predicate.value);
            case "ne":
                return ne(left, predicate.value);
            case "gt":
                return gt(left, predicate.value);
            case "gte":
                return gte(left, predicate.value);
            case "lt":
                return lt(left, predicate.value);
            case "lte":
                return lte(left, predicate.value);
        }
    }
    if (predicate.kind === "in") return inArray(column(columns, predicate.column) as never, [...predicate.values]);
    if (predicate.kind === "between") {
        return between(column(columns, predicate.column) as never, predicate.lower, predicate.upper);
    }
    if (predicate.kind === "null") {
        return predicate.op === "isNull"
            ? isNull(column(columns, predicate.column) as never)
            : isNotNull(column(columns, predicate.column) as never);
    }
    const children = predicate.predicates.map(child => predicateSql(child, columns));
    const combined = predicate.kind === "and" ? and(...children) : or(...children);
    if (!combined) throw new CdbError({ code: "CDB_INVALID_ARGS", message: "DB select plan predicate is empty" });
    return combined;
}

function invoke(target: unknown, method: string, args: readonly unknown[] = []): unknown {
    if (!target || typeof target !== "object") {
        throw new CdbError({ code: "CDB_INVARIANT", message: `DB select plan ${method} builder is unavailable` });
    }
    const callable = Reflect.get(target, method);
    if (typeof callable !== "function") {
        throw new CdbError({ code: "CDB_INVARIANT", message: `DB select plan ${method} builder is unavailable` });
    }
    return callable.call(target, ...args);
}

/** Rebuild a validated plan from typed schema columns and execute it through the supplied policy-wrapped DB. */
export async function executeResolvedSelectPlan(db: object, resolved: ResolvedSelectPlan): Promise<RawJson> {
    const columns = new Map(Object.values(getTableColumns(resolved.table)).map(value => [value.name, value] as const));
    let query = invoke(invoke(db, "select"), "from", [resolved.table]);
    if (resolved.plan.where) query = invoke(query, "where", [predicateSql(resolved.plan.where, columns)]);
    if (resolved.plan.orderBy) {
        const order = resolved.plan.orderBy.map(item => {
            const selected = column(columns, item.column) as never;
            return item.direction === "asc" ? asc(selected) : desc(selected);
        });
        query = invoke(query, "orderBy", order);
    }
    const effectiveLimit = resolved.plan.cardinality === "one" ? 1 : (resolved.plan.limit ?? 100);
    query = invoke(query, "limit", [effectiveLimit]);
    if (resolved.plan.cardinality === "one") {
        return ((await invoke(query, "get")) ?? null) as RawJson;
    }
    return (await invoke(query, "all")) as RawJson;
}
