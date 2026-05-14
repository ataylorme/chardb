/**
 * Plugin partition-key overrides for better-auth tables that lack
 * `references:` declarations (so `getAuthTables(options)` cannot derive them
 * automatically).
 *
 * - apiKey.referenceId  → resolved at chardb config-time from the user's
 *                         `apiKey({ referenceId })` plugin option (defaults to
 *                         `userId`, but can be `organizationId` etc.).
 * - jwks                → replicated reference table (broadcast on DDL).
 * - rateLimit           → replicated reference table.
 * - verification        → user-keyed (verification rows belong to a user).
 */

export const PLUGIN_PARTITION_KEY_OVERRIDES: { readonly [model: string]: PluginPartitionRule } = Object.freeze({
    apiKey: { kind: "configured", configKey: "apiKey.referenceId", default: "userId" },
    jwks: { kind: "replicated" },
    rateLimit: { kind: "replicated" },
    verification: { kind: "fixed", column: "userId" },
});

export type PluginPartitionRule =
    | { readonly kind: "fixed"; readonly column: string }
    | { readonly kind: "configured"; readonly configKey: string; readonly default: string }
    | { readonly kind: "replicated" };

export function resolvePluginPartitionKey(
    model: string,
    authOptions: { readonly [k: string]: unknown }
): { readonly column?: string; readonly replicated?: boolean } {
    const rule = PLUGIN_PARTITION_KEY_OVERRIDES[model];
    if (!rule) return {};
    if (rule.kind === "fixed") return { column: rule.column };
    if (rule.kind === "replicated") return { replicated: true };
    // configured
    const segments = rule.configKey.split(".");
    let cur: unknown = authOptions;
    for (const seg of segments) {
        if (!cur || typeof cur !== "object") {
            cur = undefined;
            break;
        }
        cur = (cur as { [k: string]: unknown })[seg];
    }
    return { column: typeof cur === "string" ? cur : rule.default };
}
