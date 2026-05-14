/**
 * `chardb/auth` — `withChardb()` and the chardb-specific better-auth helpers.
 *
 * `withChardb()` composes with the user's `withCloudflare()`; verified safe
 * since `withCloudflare` only overrides `database` if `{d1,d1Native,postgres,
 * mysql}` is passed. The chardb adapter survives the wrap and emits
 * `auth_epoch_*` bumps from `create / update / delete` for every model
 * (auto-derived via `getAuthTables(options)` + `pluginPartitionKeyOverrides`).
 */

import {
    type AuthEpochDispatcher,
    type DbAdapterContract,
    type WrapAdapterArgs,
    assertAdapterShape,
    wrapAdapter,
} from "./adapter.ts";
import { PLUGIN_PARTITION_KEY_OVERRIDES, resolvePluginPartitionKey } from "./plugin_partition_keys.ts";
import { assertAuthProfile, checkAuthProfile } from "./profile.ts";
import {
    AUTH_DEFAULT_TABLES,
    AUTH_PLUGIN_TABLES,
    AUTH_RESERVED_NAMES,
    type AuthDefaultTable,
    type AuthOptionsInput,
    type ChardbAuth,
    type InferPluginTables,
    type KnownAuthTables,
    type SynthesizedAuthSchema,
    type SynthesizedAuthTable,
    assertNoReservedTableShadow,
    defineAuth,
    synthesizeAuthSchema,
} from "./synthesize.ts";

export {
    assertAdapterShape,
    assertAuthProfile,
    assertNoReservedTableShadow,
    AUTH_DEFAULT_TABLES,
    AUTH_PLUGIN_TABLES,
    AUTH_RESERVED_NAMES,
    checkAuthProfile,
    defineAuth,
    PLUGIN_PARTITION_KEY_OVERRIDES,
    resolvePluginPartitionKey,
    synthesizeAuthSchema,
    wrapAdapter,
    type AuthDefaultTable,
    type AuthEpochDispatcher,
    type AuthOptionsInput,
    type ChardbAuth,
    type DbAdapterContract,
    type InferPluginTables,
    type KnownAuthTables,
    type SynthesizedAuthSchema,
    type SynthesizedAuthTable,
    type WrapAdapterArgs,
};

export interface WithChardbInput {
    /** A better-auth options object as returned by `betterAuth({...})`. */
    readonly options: { readonly [k: string]: unknown };
    /** Auth-epoch dispatcher; chardb runtime fills this in. */
    readonly dispatcher: AuthEpochDispatcher;
    /** The wrapped adapter the user already configured (e.g. cloudflare adapter). */
    readonly adapter: DbAdapterContract;
}

/**
 * Compose chardb on top of the user's better-auth setup.
 *
 *   const auth = withChardb({
 *     options,
 *     dispatcher,
 *     adapter: withCloudflare({ d1: env.AUTH_DB }, betterAuth(opts)).adapter,
 *   });
 */
export function withChardb(input: WithChardbInput): { adapter: DbAdapterContract } {
    assertAuthProfile(input.options as Parameters<typeof assertAuthProfile>[0]);
    assertAdapterShape(input.adapter);
    const adapter = wrapAdapter({
        inner: input.adapter,
        dispatcher: input.dispatcher,
        authOptions: input.options,
    });
    return { adapter };
}
