/**
 * Column-level security helpers.
 *
 * `applyColumnMask(rows, table, auth)` — for read paths. Replaces every
 * value the caller is not allowed to see with `null`. The row count and
 * shape are unchanged; only forbidden cells null out. This is the "403
 * at the field level" layer and is orthogonal to the row-level filter
 * (`applyRowPolicies` / RLS).
 *
 * `assertColumnsWritable(values, table, op, auth)` — for create/update
 * paths. Throws `CDB_FORBIDDEN_COLUMN` when the caller's payload
 * contains a column the matrix does not grant for this verb. Bypasses
 * tenant + selfBy auto-fill columns when the framework — not the caller
 * — set those values (signalled by the `autoFilled` set).
 *
 * Both helpers consult the compiled `ColumnMatrix` carried on the
 * table's `CdbTableMeta`. They are pure with respect to (auth, row,
 * meta) and produce no side effects.
 */

import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import { callerColumns, isColumnAllowed, selfColumns } from "./cdb-policy.ts";
import type { ColVerb } from "./cdb-table-types.ts";
import { resolveCdbMeta } from "./cdb-table.ts";
import type { AuthCtx } from "./define.ts";

/**
 * Project every row through the read-mask: values for columns the caller
 * is not allowed to read are replaced with `null`. Rows themselves are
 * unchanged in count or order; the RLS layer is responsible for that.
 *
 * Self handling: `self` columns are gated row-by-row — a row IS the
 * caller iff `row[selfBy] === ctx.auth.userId`, in which case `self`'s
 * grants apply on top of the caller's role grants.
 */
export function applyColumnMask<TRow extends Record<string, unknown>>(args: {
    readonly rows: readonly TRow[];
    readonly table: SQLiteTable;
    readonly auth: AuthCtx;
}): TRow[] {
    const meta = resolveCdbMeta(args.table);
    const hasConfiguredReadGrant = [...meta.matrix.allowed.values()].some(byVerb => {
        const columns = byVerb.get("read");
        return columns === null || (columns !== undefined && columns.size > 0);
    });
    if (meta.publicRead && (!args.auth.userId || !hasConfiguredReadGrant)) return [...args.rows];
    const callerRoleColumns = callerColumns(meta, args.auth, "read");
    const selfBy = meta.selfBy;
    const selfReadCols = selfColumns(meta, "read");
    const selfHasFullRead = selfReadCols === null;
    const implicitSelf = meta.tenantKind === "user";
    // Fast path: caller's role grants every column AND self can't widen
    // (because self is null = "*" or unset). Skip the per-row projection.
    if (
        callerRoleColumns.size === meta.matrix.allColumns.length &&
        ((!selfBy && !implicitSelf) ||
            selfHasFullRead ||
            (selfReadCols && selfReadCols.size === meta.matrix.allColumns.length))
    ) {
        return [...args.rows];
    }
    return args.rows.map(row => {
        const allowed = new Set(callerRoleColumns);
        if (implicitSelf || (selfBy && row[selfBy] === args.auth.userId)) {
            if (selfHasFullRead) {
                for (const c of meta.matrix.allColumns) allowed.add(c);
            } else if (selfReadCols) {
                for (const c of selfReadCols) allowed.add(c);
            }
        }
        const out: Record<string, unknown> = {};
        for (const col of meta.matrix.allColumns) {
            out[col] = allowed.has(col) ? row[col] : null;
        }
        return out as TRow;
    });
}

/**
 * Reject inserts/updates that touch columns the caller cannot write.
 * `autoFilled` lists columns the framework set on the caller's behalf
 * (tenant + selfBy auto-fill); those are exempt from the per-role check
 * because the caller did not author them.
 */
export function assertColumnsWritable(args: {
    readonly values: Readonly<Record<string, unknown>>;
    readonly table: SQLiteTable;
    readonly auth: AuthCtx;
    readonly verb: Extract<ColVerb, "create" | "update">;
    readonly autoFilled?: ReadonlySet<string>;
}): void {
    const meta = resolveCdbMeta(args.table);
    const allowed = callerColumns(meta, args.auth, args.verb);
    for (const col of Object.keys(args.values)) {
        if (args.autoFilled?.has(col)) continue;
        if (allowed.has(col)) continue;
        // Self check: writes can be authorized by `self` IFF the value
        // being written is provably the caller's user (we can't verify
        // post-write rows, so for create we accept self only when
        // selfBy === auth.userId is in the payload).
        if (meta.selfBy && col === meta.selfBy && args.values[col] === args.auth.userId) continue;
        if (meta.tenantKind === "user" && isColumnAllowed(meta, "self", args.verb, col)) continue;
        if (meta.selfBy && isColumnAllowed(meta, "self", args.verb, col)) {
            const incomingSelf = args.values[meta.selfBy];
            if (incomingSelf === args.auth.userId) continue;
        }
        throw new CdbError({
            code: "CDB_FORBIDDEN_COLUMN",
            message: `${meta.name}: caller is not authorized to ${args.verb} column "${col}"`,
            hint: "check the table's `roles:` block or `columns:` axis for grants on this verb",
        });
    }
}
