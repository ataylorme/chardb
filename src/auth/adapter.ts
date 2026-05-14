/**
 * better-auth `DBAdapter` wrapper.
 *
 * Wraps the user's underlying adapter (typically the cloudflare adapter from
 * better-auth-cloudflare). Every `create / update / updateMany / delete /
 * deleteMany` call dispatches an `auth_epoch_*` bump based on the model name —
 * `databaseHooks` alone fires only for BaseModelNames, so we MUST do this at
 * the adapter layer to catch passkey enrollments, org membership changes, etc.
 *
 * Source-of-truth for the model→partition-key map is `getAuthTables(options)`
 * from `@better-auth/core/db`, plus `pluginPartitionKeyOverrides`.
 */

import { CdbError } from "../errors.ts";
import { resolvePluginPartitionKey } from "./plugin_partition_keys.ts";

export interface AuthEpochDispatcher {
    bumpPrincipal(principalId: string): Promise<void>;
    bumpTenant(tenantId: string): Promise<void>;
    bumpGlobal(): Promise<void>;
}

export interface DbAdapterContract {
    create<T>(args: { model: string; data: T }): Promise<T>;
    findOne<T>(args: { model: string; where: unknown }): Promise<T | null>;
    findMany<T>(args: { model: string; where?: unknown; limit?: number; offset?: number }): Promise<T[]>;
    count(args: { model: string; where?: unknown }): Promise<number>;
    update<T>(args: { model: string; where: unknown; update: Partial<T> }): Promise<T | null>;
    updateMany<T>(args: { model: string; where: unknown; update: Partial<T> }): Promise<T[]>;
    delete(args: { model: string; where: unknown }): Promise<void>;
    deleteMany(args: { model: string; where: unknown }): Promise<number>;
    transaction<R>(body: (tx: DbAdapterContract) => Promise<R>): Promise<R>;
    createSchema?(): Promise<void>;
}

const TENANT_KEYED_MODELS = new Set([
    "organization",
    "member",
    "invitation",
    "team",
    "teamMember",
    // `organizationRole` carries dynamic ACL rows for an org; a write here
    // must invalidate every tenant-scoped live query whose `authDependsOn`
    // names this model (see `chardb/server/access`'s `TENANT_EPOCH_TABLES`).
    // Without this entry, a role assignment change would silently fail to
    // re-evaluate dependent subscriptions.
    "organizationRole",
]);
const PRINCIPAL_KEYED_MODELS = new Set([
    "user",
    "session",
    "account",
    "verification",
    "passkey",
    "twoFactor",
    "ssoProvider",
    "apiKey",
]);

/** Map a record to (principalId, tenantId) using the model's partition rule. */
function inferKeys(
    model: string,
    data: Record<string, unknown>,
    authOptions: { readonly [k: string]: unknown }
): { principalId?: string; tenantId?: string } {
    if (TENANT_KEYED_MODELS.has(model)) {
        const tenantId = (data.organizationId as string | undefined) ?? (data.id as string | undefined);
        return tenantId ? { tenantId } : {};
    }
    if (PRINCIPAL_KEYED_MODELS.has(model)) {
        if (model === "user") {
            const id = data.id as string | undefined;
            return id ? { principalId: id } : {};
        }
        const userId = (data.userId as string | undefined) ?? (data.referenceId as string | undefined);
        return userId ? { principalId: userId } : {};
    }
    // Plugin tables — fall back to the override manifest.
    const rule = resolvePluginPartitionKey(model, authOptions);
    if (rule.replicated) return {};
    if (rule.column) {
        const v = data[rule.column];
        return typeof v === "string" ? { principalId: v } : {};
    }
    return {};
}

export interface WrapAdapterArgs {
    readonly inner: DbAdapterContract;
    readonly dispatcher: AuthEpochDispatcher;
    readonly authOptions: { readonly [k: string]: unknown };
}

export function wrapAdapter(args: WrapAdapterArgs): DbAdapterContract {
    const { inner, dispatcher, authOptions } = args;

    async function maybeBump(model: string, data: Record<string, unknown> | null): Promise<void> {
        if (!data) return;
        const { principalId, tenantId } = inferKeys(model, data, authOptions);
        if (tenantId) await dispatcher.bumpTenant(tenantId);
        if (principalId) await dispatcher.bumpPrincipal(principalId);
    }

    const wrapped: DbAdapterContract = {
        async create(a) {
            const r = await inner.create(a);
            await maybeBump(a.model, (r ?? a.data) as Record<string, unknown>);
            return r;
        },
        async findOne(a) {
            return inner.findOne(a);
        },
        async findMany(a) {
            return inner.findMany(a);
        },
        async count(a) {
            return inner.count(a);
        },
        async update(a) {
            const r = await inner.update(a);
            await maybeBump(a.model, (r ?? a.update) as Record<string, unknown>);
            return r;
        },
        async updateMany(a) {
            const rs = await inner.updateMany(a);
            for (const r of rs) await maybeBump(a.model, r as Record<string, unknown>);
            return rs;
        },
        async delete(a) {
            const before = await inner.findOne<Record<string, unknown>>({
                model: a.model,
                where: a.where,
            });
            await inner.delete(a);
            await maybeBump(a.model, before);
        },
        async deleteMany(a) {
            const before = await inner.findMany<Record<string, unknown>>({
                model: a.model,
                where: a.where,
            });
            const n = await inner.deleteMany(a);
            for (const r of before) await maybeBump(a.model, r);
            return n;
        },
        async transaction(body) {
            return inner.transaction(tx => body(wrapAdapter({ inner: tx, dispatcher, authOptions })));
        },
        ...(inner.createSchema ? { createSchema: inner.createSchema.bind(inner) } : {}),
    };

    return wrapped;
}

export function assertAdapterShape(adapter: DbAdapterContract): void {
    const required: (keyof DbAdapterContract)[] = [
        "create",
        "findOne",
        "findMany",
        "count",
        "update",
        "updateMany",
        "delete",
        "deleteMany",
        "transaction",
    ];
    for (const k of required) {
        if (typeof adapter[k] !== "function") {
            throw new CdbError({
                code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
                message: `auth adapter is missing required method "${k}"`,
            });
        }
    }
}
