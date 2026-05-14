/**
 * Module-level binding of the synthesized auth schema for use inside
 * Durable Object instances.
 *
 * The chardb-native better-auth adapter (see `src/auth/chardb_adapter.ts`)
 * needs to translate `{model, op, payload}` into Drizzle SQL against the
 * synthesized auth tables. The Cdb shard DO is the place where that SQL
 * actually executes — but DOs receive only `(state, env)` from the
 * Cloudflare runtime, so we can't pass the schema in via constructor
 * arguments.
 *
 * Cloudflare's worker model loads the same module once per Worker
 * instance (the entrypoint Worker AND every spawned DO share the same
 * module graph), so a module-level binding populated by `defineChardb`
 * during initial schema resolution is visible to every DO instance
 * that reads from it. `bindAuthRuntime` is idempotent; later calls
 * with a different schema replace the binding (used by tests that
 * exercise multiple auth profiles in one process).
 *
 * Reads are guarded by `getAuthRuntime`, which throws
 * `CDB_AUTH_NOT_BOUND` if a DO method is invoked before the entrypoint
 * has resolved its schema (only possible in tests; the worker boot
 * sequence always touches `chardbManifest` first).
 */

import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { CdbError } from "../errors.ts";
import { resolvePluginPartitionKey } from "./plugin_partition_keys.ts";
import type { SynthesizedAuthSchema } from "./synthesize.ts";

/**
 * Partition placement for an auth model. Resolved once per
 * `bindAuthRuntime` call from the better-auth options + the
 * `PLUGIN_PARTITION_KEY_OVERRIDES` table.
 *
 *   - `tenant`     — `{column: "organizationId"}` for the model's row.
 *                    Routed via `vshardOf([row.organizationId])`.
 *   - `principal`  — `{column: "userId" | "id"}`. Routed via
 *                    `vshardOf([row.userId])` (or `row.id` for `user`).
 *   - `replicated` — pinned to the Catalog DO (no shard hop). Used for
 *                    `jwks` and `rateLimit`.
 */
export type AuthPartitionRule =
    | { readonly kind: "tenant"; readonly column: string }
    | { readonly kind: "principal"; readonly column: string }
    | { readonly kind: "replicated" };

/** Models that key on `organizationId` for tenant-rooted partitioning. */
const TENANT_MODELS = new Set([
    "organization",
    "member",
    "invitation",
    "team",
    "teamMember",
    "organizationRole",
]);

/** Models that key on `userId` (or `id` for `user`) for principal-rooted partitioning. */
const PRINCIPAL_MODELS = new Set([
    "user",
    "session",
    "account",
    "verification",
    "passkey",
    "twoFactor",
    "ssoProvider",
    "apiKey",
]);

interface BoundAuthRuntime {
    readonly schema: SynthesizedAuthSchema;
    readonly options: { readonly [k: string]: unknown };
    /** Pre-resolved partition rule per model — saves recomputing on every adapter call. */
    readonly placement: ReadonlyMap<string, AuthPartitionRule>;
}

let bound: BoundAuthRuntime | null = null;

export function bindAuthRuntime(args: {
    readonly schema: SynthesizedAuthSchema;
    readonly options: { readonly [k: string]: unknown };
}): void {
    const placement = new Map<string, AuthPartitionRule>();
    for (const model of Object.keys(args.schema)) {
        placement.set(model, resolvePlacement(model, args.options));
    }
    bound = { schema: args.schema, options: args.options, placement };
}

export function getAuthRuntime(): BoundAuthRuntime {
    if (!bound) {
        throw new CdbError({
            code: "CDB_AUTH_NOT_BOUND",
            message: "auth runtime not bound; defineChardb({auth:...}) must run before any auth-table access",
            hint: "ensure your worker.ts calls chardb({auth}) at module init",
        });
    }
    return bound;
}

/** Test-only reset. Production code never unbinds. */
export function resetAuthRuntime(): void {
    bound = null;
}

/**
 * Look up the Drizzle table for a given better-auth model name. Throws
 * `CDB_REF_NOT_FOUND` (intentionally reusing the manifest miss code) if
 * the model isn't in the synthesized schema — that signals a plugin the
 * adapter wasn't told about.
 */
export function tableFor(model: string): AnySQLiteTable {
    const t = getAuthRuntime().schema[model as keyof SynthesizedAuthSchema];
    if (!t) {
        throw new CdbError({
            code: "CDB_REF_NOT_FOUND",
            message: `auth runtime: unknown model "${model}"`,
            hint: "is the contributing plugin in your defineAuth({plugins: [...]}) tuple?",
        });
    }
    return t as AnySQLiteTable;
}

export function placementFor(model: string): AuthPartitionRule {
    const rule = getAuthRuntime().placement.get(model);
    if (!rule) {
        throw new CdbError({
            code: "CDB_REF_NOT_FOUND",
            message: `auth runtime: unknown model "${model}"`,
        });
    }
    return rule;
}

function resolvePlacement(model: string, options: { readonly [k: string]: unknown }): AuthPartitionRule {
    if (TENANT_MODELS.has(model)) {
        // `organization` itself keys on `id` (the org id IS the partition
        // key); every other tenant-rooted model carries `organizationId`.
        if (model === "organization") return { kind: "tenant", column: "id" };
        return { kind: "tenant", column: "organizationId" };
    }
    if (PRINCIPAL_MODELS.has(model)) {
        if (model === "user") return { kind: "principal", column: "id" };
        return { kind: "principal", column: "userId" };
    }
    // Plugin tables — defer to the override manifest.
    const rule = resolvePluginPartitionKey(model, options);
    if (rule.replicated) return { kind: "replicated" };
    if (rule.column) return { kind: "principal", column: rule.column };
    // Fallback: replicated. Better than scatter on a model we don't
    // know about; the user can override via a plugin partition rule.
    return { kind: "replicated" };
}
