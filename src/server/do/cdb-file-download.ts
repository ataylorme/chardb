import { type SQL, and, eq, getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../../errors.ts";
import { collectCdbTables } from "../cdb-table-registry.ts";
import { resolveCdbMeta } from "../cdb-table.ts";
import type { CdbFileDownloadRequest, CdbFileRuntime } from "./cdb-file-runtime.ts";
import type { StoredFile } from "./cdb-file-store.ts";
import { executeCdbQueryHandler } from "./cdb-query-execution.ts";

interface RuntimeColumn {
    readonly name: string;
    readonly dataType: string;
}

interface PointReadBuilder {
    where(predicate: SQL): PointReadBuilder;
    limit(value: number): PointReadBuilder;
    get(): Promise<Record<string, unknown> | undefined>;
}

interface PointReadDb {
    select(): { from(table: SQLiteTable): PointReadBuilder };
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

/** Run one exact attachment lookup through the existing row and column policy executor. */
export function resolveCdbFileDownload(input: {
    readonly storage: DurableObjectStorage;
    readonly schema: Record<string, unknown>;
    readonly files: CdbFileRuntime;
    readonly request: CdbFileDownloadRequest;
}): Promise<StoredFile | null> {
    return input.files.resolveDownload(input.request, async resource => {
        const matches = collectCdbTables(input.schema).filter(
            entry => resolveCdbMeta(entry.table).name === resource.table
        );
        const table = matches.length === 1 ? matches[0]?.table : undefined;
        if (!table) throw new CdbError({ code: "CDB_INVARIANT", message: "file table is unavailable" });
        const columns = Object.entries(getTableColumns(table)) as readonly [string, RuntimeColumn][];
        const primary = columns.find(([, column]) => column.name === resource.primaryKey);
        const organization = columns.find(([, column]) => column.name === resource.organizationColumn);
        const attachment = columns.find(([, column]) => column.name === resource.column);
        if (!primary || !organization || !attachment) {
            throw new CdbError({ code: "CDB_INVARIANT", message: "file locator columns are unavailable" });
        }
        const parsedPrimary = primaryValue(input.request.rowId, primary[1]);
        if (parsedPrimary === undefined) return null;
        return executeCdbQueryHandler({
            storage: input.storage,
            schema: input.schema,
            auth: input.request.auth,
            placement: { authority: "organization", partitionKey: input.request.organizationId },
            subject: "file policy point read",
            invoke: async database => {
                const row = await (database as PointReadDb)
                    .select()
                    .from(table)
                    .where(
                        and(
                            eq(primary[1] as never, parsedPrimary),
                            eq(organization[1] as never, input.request.organizationId)
                        ) as SQL
                    )
                    .limit(1)
                    .get();
                const value = row?.[attachment[0]];
                return typeof value === "string" ? value : null;
            },
        });
    });
}
