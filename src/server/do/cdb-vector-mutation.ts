import { type Column, getTableColumns } from "drizzle-orm";
import { CdbError } from "../../errors.ts";
import type { SyncSql } from "../../oplog/wrapper.ts";
import { stableHashHex } from "../../util/canonical.ts";
import {
    type VectorColumn,
    type VectorColumnHandle,
    type VectorMutationApi,
    type VectorRowPk,
    type VectorValues,
    isChardbVectorColumn,
} from "../../vector.ts";
import { collectCdbTables } from "../cdb-table-registry.ts";
import type { AuthCtx, MutationCtx } from "../define.ts";
import {
    type VectorResourceV1,
    cdbVectorResourceId,
    resolveOrganizationVectorResourceDescriptor,
} from "../resource-descriptors.ts";
import { enqueueVectorResourceInvalidations } from "./cdb-live-store.ts";
import { CdbVectorOutboxStore } from "./cdb-vector-outbox-store.ts";

const VECTOR_CONTEXT = Symbol("chardb.vector-mutation-context");
const TEXT = new TextEncoder();

export interface CdbVectorMutationInput {
    readonly column: VectorColumn;
    readonly rowPk: VectorRowPk;
    readonly values: VectorValues;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CdbVectorDeleteInput {
    readonly column: VectorColumn;
    readonly rowPk: VectorRowPk;
}

interface InternalMutationCtx {
    readonly [VECTOR_CONTEXT]?: CdbVectorMutationContext;
}

interface StagedIntent {
    readonly operation: "upsert" | "delete";
    readonly resource: VectorResourceV1;
    readonly resourceId: string;
    readonly organizationId: string;
    readonly rowPk: string;
    readonly vectorId: string;
}

function invalid(message: string): never {
    throw new CdbError({ code: "CDB_INVALID_ARGS", message: `vector mutation: ${message}` });
}

function stale(message: string): never {
    throw new CdbError({ code: "CDB_STALE_EPOCH", message: `vector mutation: ${message}` });
}

function identifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function rowPrimaryKey(value: string | number | boolean): string {
    if (
        (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
        (typeof value === "number" && !Number.isSafeInteger(value))
    ) {
        invalid("row primary key must be a string, safe integer, or boolean");
    }
    const projected = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    if (projected.length === 0 || TEXT.encode(projected).byteLength > 256) invalid("row primary key is invalid");
    return projected;
}

/** Candidate-private deterministic identity used by proof tooling before a mutation is sent. */
export function cdbVectorLogicalId(
    resourceId: string,
    organizationId: string,
    rowPk: string | number | boolean
): `vec1_${string}` {
    if (!/^vr1_[a-f0-9]{64}$/.test(resourceId)) invalid("resource id is not canonical");
    if (
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        TEXT.encode(organizationId).byteLength > 256
    ) {
        invalid("organization id is invalid");
    }
    const primaryKey = rowPrimaryKey(rowPk);
    return `vec1_${stableHashHex(["chardb.logical-vector.v1", resourceId, organizationId, primaryKey])}`;
}

function context(ctx: MutationCtx<unknown>): CdbVectorMutationContext {
    const controller = (ctx as MutationCtx<unknown> & InternalMutationCtx)[VECTOR_CONTEXT];
    if (!controller) invalid("helper is available only inside a configured Cdb mutation transaction");
    return controller;
}

/** Private transaction-bound helper. It is intentionally absent from the package entry points. */
export function stageCdbVector(ctx: MutationCtx<unknown>, input: CdbVectorMutationInput): VectorColumnHandle {
    return context(ctx).upsert(input);
}

/** Private transaction-bound helper for clearing or deleting one vector-owned domain row. */
export function deleteCdbVector(ctx: MutationCtx<unknown>, input: CdbVectorDeleteInput): null {
    context(ctx).delete(input);
    return null;
}

export function bindCdbVectorMutationContext<TDb>(
    ctx: MutationCtx<TDb>,
    controller: CdbVectorMutationContext
): MutationCtx<TDb> {
    const extended = Object.create(Object.getPrototypeOf(ctx)) as MutationCtx<TDb> & InternalMutationCtx;
    const vector: VectorMutationApi = Object.freeze({
        set: (column: VectorColumn, rowPk: VectorRowPk, values: VectorValues) =>
            controller.upsert({ column, rowPk, values }),
        delete: (column: VectorColumn, rowPk: VectorRowPk) => controller.delete({ column, rowPk }),
    });
    Object.defineProperties(extended, {
        db: { value: ctx.db, enumerable: true },
        auth: { value: ctx.auth, enumerable: true },
        vector: { value: vector, enumerable: true },
        [VECTOR_CONTEXT]: { value: controller, enumerable: true },
    });
    return extended;
}

export class CdbVectorMutationContext {
    private readonly resources = new Map<Column, VectorResourceV1>();
    private readonly intents = new Map<string, StagedIntent>();

    constructor(
        readonly input: {
            readonly sql: SyncSql;
            readonly schema: Readonly<Record<string, unknown>>;
            readonly auth: AuthCtx;
            readonly placement:
                | { readonly authority: "organization" | "user" | "global"; readonly partitionKey: string }
                | undefined;
            readonly nowMs: number;
            readonly isTransactionActive: () => boolean;
            readonly assertOrganizationActive?: (organizationId: string) => void;
        }
    ) {
        for (const { table } of collectCdbTables(input.schema as Record<string, unknown>)) {
            for (const column of Object.values(getTableColumns(table))) {
                if (!isChardbVectorColumn(column)) continue;
                this.resources.set(column, resolveOrganizationVectorResourceDescriptor(column));
            }
        }
    }

    upsert(input: CdbVectorMutationInput): VectorColumnHandle {
        this.assertActive();
        const owner = this.owner();
        this.input.assertOrganizationActive?.(owner);
        const resource = this.resource(input.column);
        const primaryKey = rowPrimaryKey(input.rowPk);
        const resourceId = cdbVectorResourceId(resource);
        const vectorId = cdbVectorLogicalId(resourceId, owner, primaryKey);
        const values =
            input.values instanceof Float32Array
                ? Array.from(input.values)
                : Array.isArray(input.values)
                  ? [...input.values]
                  : invalid("values must be a Float32Array or an array of numbers");
        const store = new CdbVectorOutboxStore(this.input.sql);
        const previous = store.read(vectorId);
        store.stageUpsert({
            vectorId,
            organizationId: owner,
            resourceId,
            rowPk: primaryKey,
            dimensions: resource.dimensions,
            values,
            metadata: input.metadata ?? {},
            nowMs: this.input.nowMs,
        });
        if (previous?.state === "ready") enqueueVectorResourceInvalidations(this.input.sql, resourceId);
        this.intents.set(this.intentKey(resourceId, primaryKey), {
            operation: "upsert",
            resource,
            resourceId,
            organizationId: owner,
            rowPk: primaryKey,
            vectorId,
        });
        return Object.freeze({ id: vectorId });
    }

    delete(input: CdbVectorDeleteInput): void {
        this.assertActive();
        const owner = this.owner();
        this.input.assertOrganizationActive?.(owner);
        const resource = this.resource(input.column);
        const primaryKey = rowPrimaryKey(input.rowPk);
        const resourceId = cdbVectorResourceId(resource);
        const vectorId = cdbVectorLogicalId(resourceId, owner, primaryKey);
        const store = new CdbVectorOutboxStore(this.input.sql);
        const previous = store.read(vectorId);
        const head = store.stageDelete({
            vectorId,
            organizationId: owner,
            nowMs: this.input.nowMs,
        });
        if (!head) invalid("cannot delete a vector head that does not exist");
        if (previous?.state === "ready") enqueueVectorResourceInvalidations(this.input.sql, resourceId);
        this.intents.set(this.intentKey(resourceId, primaryKey), {
            operation: "delete",
            resource,
            resourceId,
            organizationId: owner,
            rowPk: primaryKey,
            vectorId,
        });
    }

    assertDomainHeads(): void {
        this.assertActive();
        for (const intent of this.intents.values()) {
            const row = this.input.sql.one<{ vector_id: string | null }>(
                `SELECT ${identifier(intent.resource.column)} AS vector_id
                 FROM ${identifier(intent.resource.table)}
                 WHERE ${identifier(intent.resource.primaryKey)} = ?
                   AND ${identifier(intent.resource.organizationColumn)} = ?
                 LIMIT 1`,
                intent.rowPk,
                intent.organizationId
            );
            if (intent.operation === "upsert") {
                if (row?.vector_id !== intent.vectorId) stale("domain row did not commit its staged vector head");
            } else if (row?.vector_id === intent.vectorId) {
                stale("domain row still references its deleting vector head");
            }
        }
    }

    private resource(column: Column): VectorResourceV1 {
        const resource = this.resources.get(column);
        if (!resource) invalid("column is not a configured organization vector resource");
        return resource;
    }

    private owner(): string {
        const organizationId = this.input.auth.tenantId;
        if (
            !organizationId ||
            this.input.placement?.authority !== "organization" ||
            this.input.placement.partitionKey !== organizationId
        ) {
            invalid("organization placement does not match verified mutation authority");
        }
        return organizationId;
    }

    private intentKey(resourceId: string, rowPk: string): string {
        return `${resourceId}\0${rowPk}`;
    }

    private assertActive(): void {
        if (!this.input.isTransactionActive()) {
            throw new CdbError({ code: "CDB_INVARIANT", message: "vector mutation escaped its SQLite transaction" });
        }
    }
}
