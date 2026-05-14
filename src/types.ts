/** Strongly-typed identifiers used across SDK/server/wire surfaces. */

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Per-subscription monotonically-increasing cursor delivered on every poke. */
export type Cookie = Brand<string, "Cookie">;
export const Cookie = (s: string): Cookie => s as Cookie;

/** Client-allocated mutation id; the dedup key inside `_chardb_op_log`. */
export type MutId = Brand<string, "MutId">;
export const MutId = (s: string): MutId => s as MutId;

/** Authenticated principal id (typically `user.id`). */
export type PrincipalId = Brand<string, "PrincipalId">;
export const PrincipalId = (s: string): PrincipalId => s as PrincipalId;

/** Tenant id (typically `organization.id`); falsy for unauth/global. */
export type TenantId = Brand<string, "TenantId">;
export const TenantId = (s: string): TenantId => s as TenantId;

/** WebSocket client id — assigned by SDK on connect; stable across reconnect. */
export type ClientId = Brand<string, "ClientId">;
export const ClientId = (s: string): ClientId => s as ClientId;

/** Subscription id, scoped per WS connection. */
export type SubId = Brand<number, "SubId">;
export const SubId = (n: number): SubId => n as SubId;

/** Stable wire identifier for a `defineXxx` named export, assigned by the bundler. */
export type ChardbRef = Brand<string, "ChardbRef">;
/**
 * Mint a `ChardbRef`. Format: `<kind>#<exportName>` or
 * `<modulePath>#<exportName>` (the bundler emits the latter; dev-mode
 * `autoRef` produces the former). Throws on empty or non-string inputs so
 * the wire boundary doesn't accept arbitrary user data into a typed brand.
 */
export const ChardbRef = (s: string): ChardbRef => {
    if (typeof s !== "string" || s.length === 0 || !s.includes("#")) {
        throw new TypeError(`invalid ChardbRef: ${JSON.stringify(s)}`);
    }
    return s as ChardbRef;
};

/** vshard id ∈ [0, VSHARD_COUNT). */
export type Vshard = Brand<number, "Vshard">;
export const Vshard = (n: number): Vshard => n as Vshard;

/** Stable identifier for a physical Cdb shard DO. */
export type ShardId = Brand<string, "ShardId">;
export const ShardId = (s: string): ShardId => s as ShardId;

export type RawJson = string | number | boolean | null | RawJson[] | { [key: string]: RawJson };

/** Non-cryptographic correlation id used in error envelopes + Server-Timing. */
export type CorrelationId = Brand<string, "CorrelationId">;
export const CorrelationId = (s: string): CorrelationId => s as CorrelationId;
