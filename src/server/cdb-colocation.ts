/**
 * Bridge cdbTable's tenancy / partitioning declarations to the existing
 * `Partial<PolicyInput>` shape `deriveColocation` consumes.
 *
 * Mapping:
 *   - tenantKind === "org"  + tenantBy = "<col>"  → no override needed;
 *     the colocation algorithm finds the FK to `organization` on its
 *     own. We emit an explicit override only when the user supplied a
 *     `partitionBy:` value that diverges from the auto-discovered tenant
 *     column.
 *   - tenantKind === "user" + tenantBy = "<col>"  → override `colocate`
 *     via that column. The default `distributionRoots: ["organization",
 *     "user"]` would otherwise pick `organization` first when both FKs
 *     are present, which is wrong for user-tenanted tables.
 *   - tenantKind === "none" + partitionBy: "replicated" → override
 *     `replicated`.
 *   - tenantKind === "none" + partitionBy: <col[]>  → override
 *     `colocate` via those columns.
 */

import type { PolicyInput } from "../colocation/types.ts";
import { collectCdbTables } from "./cdb-table-registry.ts";
import { resolveCdbMeta } from "./cdb-table.ts";

export function buildColocationOverrides(schema: Record<string, unknown>): Pick<PolicyInput, "overrides"> {
    const overrides: PolicyInput["overrides"] = {};
    for (const { meta, table } of collectCdbTables(schema)) {
        const resolved = resolveCdbMeta(table);
        const partition = meta.partitionBy;
        if (partition.kind === "replicated") {
            (overrides as Record<string, PolicyInput["overrides"][string]>)[meta.name] = { kind: "replicated" };
            continue;
        }
        // User explicitly set `partitionBy:` — emit override. Composite
        // partition columns flow through as a `readonly string[]` per
        // the extended `ColocationOverride.via` shape.
        if (partition.kind === "colocate" && partition.via.length > 0) {
            (overrides as Record<string, PolicyInput["overrides"][string]>)[meta.name] = {
                kind: "colocate",
                via: partition.via.length === 1 ? (partition.via[0] as string) : partition.via,
            };
            continue;
        }
        // User-tenanted tables need an explicit override so the algorithm
        // doesn't default to organization-rooting.
        if (resolved.tenantKind === "user" && resolved.tenantBy) {
            (overrides as Record<string, PolicyInput["overrides"][string]>)[meta.name] = {
                kind: "colocate",
                via: resolved.tenantBy,
            };
        }
        // Org-tenanted tables fall through — colocation finds organization
        // FK on its own (default distributionRoots starts with organization).
    }
    return { overrides };
}
